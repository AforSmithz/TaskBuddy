import "server-only";
import {
  azureCredential,
  COGNITIVE_SERVICES_SCOPE,
} from "./azure-credential";
import {
  deploymentNames,
  isLLMConfigured,
  isReasoningDeployment,
  normalizeEndpoint,
} from "./foundry-config";

// Re-exported so callers have one import site for the whole LLM layer.
export { isLLMConfigured } from "./foundry-config";

// Thin wrapper around Microsoft Foundry chat completions, spoken over the
// OpenAI-compatible v1 API surface (`/openai/v1/chat/completions`). All
// LLM-powered features (extraction, decomposition, check-in interpretation,
// the strategists, skill links, follow-up messages) go through callFoundry /
// callFoundryJSON.
//
// Replaces lib/openrouter.ts. Three things genuinely changed, and each one
// silently breaks a request if you get it wrong:
//
//   1. `model` is the DEPLOYMENT NAME, not a catalog id. "gpt-5-mini" here
//      means "the deployment I called gpt-5-mini", not "OpenAI's gpt-5-mini".
//   2. Reasoning models (the gpt-5 family) reject `temperature`, `top_p`, the
//      penalties, and `max_tokens`. They take `max_completion_tokens`,
//      `reasoning_effort` and `verbosity` instead. Non-reasoning deployments
//      are the exact mirror image, so the body is shaped per deployment.
//   3. Structured output is a strict JSON Schema, not a `json_object` hint.
//      When a schema is supplied the response is guaranteed to parse and to
//      match the shape, so the old fence-stripping/regex-salvage is gone.
//
// Requests still run through a deployment fallback chain: the primary is tried
// first, the fallback on any failure. If every deployment fails, callers fall
// back to their own offline heuristic.

// The v1 API is version-less: no `api-version` query parameter. Both the
// *.openai.azure.com and *.services.ai.azure.com hosts serve it.
const V1_PATH = "/openai/v1/chat/completions";

// Reasoning tokens are billed against this ceiling and are invisible in the
// response, so it is a shared budget between thinking and the actual JSON.
// A large extraction emits a big nested object; too low a cap truncates it and
// surfaces as finish_reason "length" with empty content.
const MAX_COMPLETION_TOKENS = 16000;

// Abort a hung request so a stuck primary doesn't stack its latency onto the
// fallback. Reasoning models are slower than the instruct models this app used
// to call, so this is deliberately generous.
const REQUEST_TIMEOUT_MS = 120_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Reasoning budget. Only sent to reasoning deployments. */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** Final-answer length. Distinct from reasoning effort; reasoning-only. */
export type Verbosity = "low" | "medium" | "high";

interface CallOptions {
  /**
   * How hard the model thinks. Defaults to "low" - the setting the OpenRouter
   * wrapper hardcoded for every caller. Raise it per call site for genuine
   * planning work (decomposition, the strategists, check-in interpretation);
   * "minimal" is right for one-shot prose.
   */
  reasoningEffort?: ReasoningEffort;
  /** Length of the visible answer. Reasoning deployments only. */
  verbosity?: Verbosity;
  /**
   * Only sent to NON-reasoning deployments; the gpt-5 family rejects it.
   * Omitted entirely rather than defaulted, so a chat fallback keeps whatever
   * the service default is unless a caller has an opinion.
   */
  temperature?: number;
  /** Force a single deployment for this call, bypassing the fallback chain. */
  deployment?: string;
  /** Per-call output ceiling. Defaults to MAX_COMPLETION_TOKENS. */
  maxCompletionTokens?: number;
  /**
   * Call-site name for the usage log. JSON calls get this free from
   * `schemaName`, which is already distinct per site; only the prose call in
   * lib/generate.ts has to pass it explicitly.
   */
  label?: string;
}

interface JsonCallOptions<T> extends CallOptions {
  /**
   * A strict JSON Schema. When supplied the response is decoder-constrained to
   * match it, which is what lets the system prompts drop their hand-written
   * shape blocks. Must satisfy the strict-mode subset: every property listed in
   * `required`, `additionalProperties: false` on every object, optionality
   * expressed as a ["string","null"] union.
   *
   * `minItems`/`maxItems`, `minimum`/`maximum` and `pattern` are documented as
   * unsupported. Measured against the live deployment they are in fact accepted
   * AND enforced - but by truncating or clamping the decoder, not by telling the
   * model. A `maxItems: 3` on a request for ten items yields three, with the
   * dropped content crammed into the last string. So caps and ranges stay in
   * prose plus a code-side check; see azure/FOUNDRY.md §4.
   */
  schema?: Record<string, unknown>;
  /** Schema name; a-z, A-Z, 0-9, _ and - only. Required when schema is set. */
  schemaName?: string;
  /**
   * Reject a parsed-but-unusable response. A schema guarantees the shape but
   * not the semantics: it cannot express "at least one task", a list cap, or a
   * cross-field invariant. Returning false advances the chain.
   */
  validate?: (parsed: T) => boolean;
}

interface Deployment {
  name: string;
  isReasoning: boolean;
}

interface Config {
  /** Null when authenticating with a federated Entra token instead. */
  apiKey: string | null;
  baseUrl: string;
  deployments: Deployment[];
}

type FailureKind =
  | "http"
  | "rate_limit"
  | "content_filter"
  | "refusal"
  | "truncated"
  | "empty"
  | "invalid_json"
  | "validation";

class FoundryError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
    /** Milliseconds the service asked us to wait, from a 429. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FoundryError";
  }
}

function getConfig(): Config {
  const endpoint = process.env.AZURE_FOUNDRY_ENDPOINT;
  const apiKey = process.env.AZURE_FOUNDRY_API_KEY;
  // isLLMConfigured() accepts EITHER a key or a federated identity, so the key
  // is only required when there is no identity to fall back on. Requiring it
  // unconditionally here would throw before authHeader() ever got the chance to
  // mint a token.
  if (!endpoint || !isLLMConfigured()) {
    throw new Error(
      "Missing AZURE_FOUNDRY_ENDPOINT, and neither AZURE_FOUNDRY_API_KEY nor a " +
        "federated identity (AZURE_TENANT_ID + AZURE_CLIENT_ID) is set. " +
        "See .env.local.example.",
    );
  }
  return {
    apiKey: apiKey ?? null,
    baseUrl: normalizeEndpoint(endpoint),
    deployments: deploymentNames().map((name) => ({
      name,
      isReasoning: isReasoningDeployment(name),
    })),
  };
}

/**
 * The Authorization/api-key header for one Foundry request.
 *
 * PREFERS THE TOKEN. When a federated identity exists it is used even if an API
 * key is also present, because that ordering is what makes the cutover
 * verifiable: deploy with both set, confirm calls still succeed on the token
 * path, and only then delete the key. The reverse ordering would leave the
 * token path untested until the key was already gone.
 *
 * Falls back to the key for local `next dev` and the tsx harnesses, which have
 * no OIDC token to present.
 */
async function authHeader(config: Config): Promise<Record<string, string>> {
  const credential = azureCredential();
  if (credential) {
    try {
      const token = await credential.getToken(COGNITIVE_SERVICES_SCOPE);
      if (token) return { Authorization: `Bearer ${token.token}` };
      throw new Error("credential returned no token");
    } catch (err) {
      // NO SILENT FALLBACK. Without a key there is nothing to fall back to, so
      // the failure surfaces as itself rather than as a confusing 401 from
      // Foundry.
      if (!config.apiKey) throw err;
      // With a key still present this is the verification window: both
      // credentials are configured and the token path is being proven. Falling
      // back keeps the app up, but it MUST be loud - a silent fallback would
      // make the whole verification meaningless, because a deployment whose
      // token path was broken would look identical to one where it worked.
      //
      // This is also the path taken by `next dev` after a `vercel env pull`,
      // which drags AZURE_CLIENT_ID and AZURE_TENANT_ID into .env.local without
      // a usable OIDC token to go with them. Breaking local dev over that would
      // be a bad trade.
      console.warn(
        "foundry.auth: federated token unavailable, falling back to " +
          `AZURE_FOUNDRY_API_KEY — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (config.apiKey) return { "api-key": config.apiKey };
  throw new FoundryError(
    "No Foundry credential available: no federated identity and " +
      "AZURE_FOUNDRY_API_KEY is not set.",
    "http",
  );
}

/** Milliseconds to wait after a 429, from whichever header the service sent. */
function retryAfterFrom(headers: Headers): number | undefined {
  const ms = headers.get("retry-after-ms");
  if (ms) {
    const parsed = Number(ms);
    if (Number.isFinite(parsed)) return parsed;
  }
  const seconds = headers.get("retry-after");
  if (seconds) {
    const parsed = Number(seconds);
    if (Number.isFinite(parsed)) return parsed * 1000;
  }
  return undefined;
}

interface CompletionChoice {
  finish_reason?: string;
  message?: { content?: string | null; refusal?: string | null };
}

/**
 * The `usage` block. Both nested `*_details` objects are the reason this is
 * worth reading rather than ignoring:
 *
 *  - `completion_tokens_details.reasoning_tokens` is the only way to see what
 *    thinking cost. Reasoning tokens bill at the OUTPUT rate and never appear
 *    in the response body, so without this a reasoning-heavy call is
 *    indistinguishable from a verbose one on the invoice.
 *  - `prompt_tokens_details.cached_tokens` bill at roughly a tenth of the
 *    input rate. Expect this to be 0 almost always: Azure evicts a cached
 *    prefix after a few minutes of inactivity, and this app's traffic is far
 *    too sparse to stay inside that window. Logged so that stays a measured
 *    fact rather than an assumption.
 */
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

/**
 * One structured line per completion, on stdout, whatever the outcome.
 *
 * DELIBERATELY LOGGED BEFORE THE ERROR CHECKS in fetchCompletion. A response
 * truncated against max_completion_tokens is the single most expensive failure
 * available here - it burns the entire budget and returns nothing - so it is
 * exactly the call that must not go unrecorded. Logging after the throw would
 * hide the costly cases and keep only the cheap ones.
 *
 * Never throws: a broken log line must not fail a good request.
 */
function logUsage(
  deployment: Deployment,
  options: JsonCallOptions<unknown>,
  usage: Usage | undefined,
  finishReason: string | undefined,
  elapsedMs: number,
): void {
  try {
    const input = usage?.prompt_tokens ?? 0;
    const output = usage?.completion_tokens ?? 0;
    const reasoning = usage?.completion_tokens_details?.reasoning_tokens ?? 0;
    console.log(
      JSON.stringify({
        evt: "foundry.call",
        site: options.label ?? options.schemaName ?? "unlabelled",
        deployment: deployment.name,
        effort: deployment.isReasoning
          ? (options.reasoningEffort ?? "low")
          : null,
        finish: finishReason ?? null,
        ms: elapsedMs,
        in: input,
        cached: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        out: output,
        reasoning,
        // Share of billed output that was invisible thinking. This is the
        // number that tells you whether lowering reasoningEffort at this site
        // would actually save anything.
        reasoning_share: output > 0 ? Number((reasoning / output).toFixed(2)) : 0,
      }),
    );
  } catch {
    // Logging is never allowed to be the thing that breaks a call.
  }
}

/** One HTTP request to a single deployment. Throws FoundryError on any failure. */
async function fetchCompletion(
  deployment: Deployment,
  messages: ChatMessage[],
  options: JsonCallOptions<unknown>,
  config: Config,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const body: Record<string, unknown> = {
      // The deployment name, not the catalog model id.
      model: deployment.name,
      messages,
      max_completion_tokens: options.maxCompletionTokens ?? MAX_COMPLETION_TOKENS,
    };

    if (deployment.isReasoning) {
      // temperature / top_p / penalties / max_tokens are rejected outright by
      // the gpt-5 family, so they are never sent to a reasoning deployment.
      body.reasoning_effort = options.reasoningEffort ?? "low";
      if (options.verbosity) body.verbosity = options.verbosity;
    } else if (options.temperature !== undefined) {
      // Mirror image: a chat deployment rejects reasoning_effort/verbosity.
      body.temperature = options.temperature;
    }

    if (options.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: options.schemaName ?? "response",
          strict: true,
          schema: options.schema,
        },
      };
    }

    const res = await fetch(`${config.baseUrl}${V1_PATH}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...(await authHeader(config)),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      if (res.status === 429) {
        throw new FoundryError(
          `Foundry rate-limited deployment "${deployment.name}".`,
          "rate_limit",
          429,
          retryAfterFrom(res.headers),
        );
      }
      // An input that trips the content filter is a deterministic 400 - there
      // is no point retrying it or advancing the chain.
      if (res.status === 400 && detail.includes("content_filter")) {
        throw new FoundryError(
          `Foundry blocked the prompt (content filter): ${detail.slice(0, 300)}`,
          "content_filter",
          400,
        );
      }
      throw new FoundryError(
        `Foundry request failed (${res.status}): ${detail.slice(0, 500)}`,
        "http",
        res.status,
      );
    }

    const data = (await res.json()) as {
      choices?: CompletionChoice[];
      usage?: Usage;
    };
    const choice = data.choices?.[0];

    // Before the checks below, so the expensive failures are the ones that get
    // recorded rather than the ones that get lost. See logUsage.
    logUsage(
      deployment,
      options,
      data.usage,
      choice?.finish_reason,
      Date.now() - startedAt,
    );

    // Structured outputs can return a refusal with null content. That is a
    // decision, not a flake - retrying it just burns the budget.
    if (choice?.message?.refusal) {
      throw new FoundryError(
        `Deployment "${deployment.name}" refused: ${choice.message.refusal.slice(0, 300)}`,
        "refusal",
      );
    }
    // The failure the old wrapper could not distinguish: a response truncated
    // against max_completion_tokens comes back with empty content, which looked
    // identical to a transient empty response.
    if (choice?.finish_reason === "length") {
      throw new FoundryError(
        `Deployment "${deployment.name}" hit max_completion_tokens before finishing. Reasoning tokens share this budget — raise maxCompletionTokens or lower reasoningEffort.`,
        "truncated",
      );
    }
    if (choice?.finish_reason === "content_filter") {
      throw new FoundryError(
        `Deployment "${deployment.name}" had its output filtered.`,
        "content_filter",
      );
    }

    const content = choice?.message?.content;
    if (!content) {
      throw new FoundryError(
        `Deployment "${deployment.name}" returned an empty response (finish_reason: ${choice?.finish_reason ?? "none"}).`,
        "empty",
      );
    }
    return content;
  } catch (err) {
    if (err instanceof FoundryError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new FoundryError(
        `Deployment "${deployment.name}" timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        "http",
      );
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/** Failures worth trying again on the same deployment. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof FoundryError)) return false;
  if (err.kind === "rate_limit") return true;
  if (err.kind === "truncated") return false;
  if (err.kind === "content_filter" || err.kind === "refusal") return false;
  return err.status !== undefined && err.status >= 500;
}

/** Calls one deployment, retrying once on a rate-limit or server error. */
async function callDeployment(
  deployment: Deployment,
  messages: ChatMessage[],
  options: JsonCallOptions<unknown>,
  config: Config,
): Promise<string> {
  try {
    return await fetchCompletion(deployment, messages, options, config);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    // Honour the service's own backoff when it gave us one; standard-tier
    // deployments 429 under burst and the header is usually accurate.
    const wait =
      err instanceof FoundryError && err.retryAfterMs !== undefined
        ? Math.min(err.retryAfterMs, 10_000)
        : 1000;
    await new Promise((resolve) => setTimeout(resolve, wait));
    return await fetchCompletion(deployment, messages, options, config);
  }
}

/** Tries each deployment in order, advancing to the next on any thrown error. */
async function runChain<T>(
  deployments: Deployment[],
  attempt: (deployment: Deployment) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const deployment of deployments) {
    try {
      return await attempt(deployment);
    } catch (err) {
      lastError = err;
      const kind = err instanceof FoundryError ? err.kind : "unknown";
      console.error(
        `Foundry deployment "${deployment.name}" failed (${kind}), trying next:`,
        err,
      );
    }
  }
  throw lastError ?? new Error("No Foundry deployments configured.");
}

function resolveDeployments(config: Config, override?: string): Deployment[] {
  if (!override) return config.deployments;
  return [{ name: override, isReasoning: isReasoningDeployment(override) }];
}

export async function callFoundry(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<string> {
  const config = getConfig();
  return runChain(resolveDeployments(config, options.deployment), (deployment) =>
    callDeployment(deployment, messages, options, config),
  );
}

/**
 * Calls the deployment chain and parses the response as JSON.
 *
 * Pass `schema` to get strict structured output: the response is then
 * guaranteed to parse and to match the shape, so `validate` only needs to carry
 * the semantics a schema cannot express (non-empty lists, caps, cross-field
 * invariants).
 */
export async function callFoundryJSON<T>(
  messages: ChatMessage[],
  options: JsonCallOptions<T> = {},
): Promise<T> {
  const config = getConfig();
  const deployments = resolveDeployments(config, options.deployment);
  // Parse and validate inside the chain so a deployment that returns
  // semantically-empty JSON advances rather than being accepted.
  return runChain(deployments, async (deployment) => {
    const raw = await callDeployment(
      deployment,
      messages,
      options as JsonCallOptions<unknown>,
      config,
    );
    const parsed = parseJson<T>(raw, Boolean(options.schema));
    if (options.validate && !options.validate(parsed)) {
      throw new FoundryError(
        `Deployment "${deployment.name}" returned JSON that failed validation.`,
        "validation",
      );
    }
    return parsed;
  });
}

/**
 * With a strict schema the content is guaranteed to be bare, parseable JSON, so
 * a parse failure is a real API problem and must surface. Without one we still
 * tolerate a ```json fence.
 *
 * The old greedy `[{...}]` salvage regex is deliberately gone: on a truncated
 * response it extracted a partial object and returned it as a success, which
 * meant half a plan could reach the database looking like a whole one.
 */
function parseJson<T>(raw: string, strict: boolean): T {
  const cleaned = strict
    ? raw
    : raw
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    throw new FoundryError(
      `Could not parse the response as JSON: ${raw.slice(0, 300)}`,
      "invalid_json",
    );
  }
}
