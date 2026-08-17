import "server-only";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type Message,
  type SystemContentBlock,
  type TokenUsage,
} from "@aws-sdk/client-bedrock-runtime";
import {
  SEND_EFFORT,
  bedrockEffort,
  bedrockRegion,
  isLLMConfigured,
  modelChain,
} from "./bedrock-config";

// Re-exported so callers have one import site for the whole LLM layer.
export { isLLMConfigured } from "./bedrock-config";

// Thin wrapper around Amazon Bedrock's Converse API. All LLM-powered features
// (extraction, decomposition, check-in interpretation, the strategists, skill
// links, follow-up messages) go through callBedrock / callBedrockJSON.
//
// Replaces lib/foundry.ts. Four things genuinely changed, and each one silently
// breaks a request if you get it wrong:
//
//   1. SYSTEM PROMPTS ARE NOT MESSAGES. Converse takes them in a separate
//      `system` array. Every call site in this app builds
//      `[{role:"system"}, {role:"user"}]`, so passing that array straight
//      through would send the system prompt as a user turn - the model still
//      answers, plausibly, with the instructions treated as content. There is
//      no error. `splitMessages` below is what stops that.
//   2. `modelId` is an INFERENCE PROFILE id, not a catalog model id. Claude 4.5
//      and newer refuse on-demand invocation with a bare model id.
//   3. Structured output moved from `response_format` to
//      `outputConfig.textFormat`, and `schema` is a JSON *string*, not an
//      object. Passing the object produces a ValidationException that names
//      neither the field nor the reason.
//   4. Reasoning effort is `outputConfig.effort`, a first-class field that
//      lives beside the schema rather than fighting it. This is the one place
//      the port got simpler: on Foundry, reasoning and non-reasoning
//      deployments rejected each other's parameters, so the request body had
//      to be shaped per deployment. Converse takes the same body for every
//      model.
//
// Requests still run through a model fallback chain: the primary is tried
// first, the fallback on any failure. If every model fails, callers fall back
// to their own offline heuristic.

/**
 * Reasoning tokens are billed against this ceiling and are invisible in the
 * response, so it is a shared budget between thinking and the actual JSON.
 * A large extraction emits a big nested object; too low a cap truncates it and
 * surfaces as stopReason "max_tokens" with unusable content.
 */
const MAX_TOKENS = 16000;

/** Abort a hung request so a stuck primary doesn't stack its latency onto the fallback. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Namespace for the EMF metrics emitted per call. Matches the CloudWatch dashboard. */
const METRIC_NAMESPACE = "taskbuddy/llm";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Reasoning budget. Mapped onto Bedrock's `effort` by bedrockEffort(). */
export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/**
 * Final-answer length. Retained so the eleven call sites keep compiling, but
 * Converse has no counterpart and it is not sent. Kept rather than deleted
 * because removing it would touch every caller for no behavioural gain, and
 * because a future `outputConfig` field may well restore it.
 */
export type Verbosity = "low" | "medium" | "high";

interface CallOptions {
  /**
   * How hard the model thinks. Defaults to "low" - the setting the original
   * OpenRouter wrapper hardcoded for every caller. Raise it per call site for
   * genuine planning work (decomposition, the strategists, check-in
   * interpretation); "minimal" is right for one-shot prose.
   */
  reasoningEffort?: ReasoningEffort;
  /** Accepted for source compatibility; not sent. See {@link Verbosity}. */
  verbosity?: Verbosity;
  temperature?: number;
  /** Force a single model for this call, bypassing the fallback chain. */
  model?: string;
  /** Per-call output ceiling. Defaults to MAX_TOKENS. */
  maxCompletionTokens?: number;
  /**
   * Call-site name for the usage metrics. JSON calls get this free from
   * `schemaName`, which is already distinct per site; only the prose call in
   * lib/generate.ts has to pass it explicitly.
   */
  label?: string;
}

interface JsonCallOptions<T> extends CallOptions {
  /**
   * A JSON Schema. When supplied the response is decoder-constrained to match
   * it, which is what lets the system prompts drop their hand-written shape
   * blocks.
   *
   * BEDROCK'S SUPPORTED SUBSET IS NOT THE SAME AS FOUNDRY'S, and the overlap
   * is what this app already writes:
   *   - `additionalProperties: false` is REQUIRED on every object. A schema
   *     without it is rejected outright rather than loosely honoured.
   *   - `minimum`/`maximum`, `minLength`/`maxLength` and `pattern` are not
   *     supported at all. Foundry accepted them and enforced them by clamping
   *     the decoder, which silently mangled output; Bedrock rejects them. The
   *     app already keeps caps in prose plus a code-side check, so nothing
   *     changes - but do not "helpfully" add a `maximum` to a schema.
   *   - `minItems` is supported only for the values 0 and 1.
   *   - Recursive schemas are not supported. None of the ten schemas here are
   *     recursive; verified before the port.
   *
   * Grammars are compiled per schema and cached for 24 hours per account, so
   * the first call after a schema edit is measurably slower. That is expected,
   * not a regression.
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

type FailureKind =
  | "http"
  | "rate_limit"
  | "content_filter"
  | "refusal"
  | "truncated"
  | "empty"
  | "invalid_json"
  | "validation";

class BedrockError extends Error {
  constructor(
    message: string,
    readonly kind: FailureKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "BedrockError";
  }
}

// MODULE SCOPE, DELIBERATELY. The client holds the resolved credential chain
// and a keep-alive HTTPS agent; rebuilding it per call would re-resolve the
// role credentials and pay a fresh TLS handshake on every LLM request.
//
// `adaptive` rather than `standard` retry: it adds client-side rate limiting on
// top of backoff, which is the correct behaviour against a service whose
// throttles are account-wide rather than per-request.
let client: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!client) {
    client = new BedrockRuntimeClient({
      region: bedrockRegion(),
      maxAttempts: 3,
      retryMode: "adaptive",
    });
  }
  return client;
}

/**
 * Split the app's flat message list into Converse's `system` + `messages`.
 *
 * Converse also rejects two consecutive turns with the same role, which the
 * OpenAI-shaped API tolerated. No call site in this app does that today, so
 * rather than silently merging - which would change a prompt without saying so
 * - adjacent same-role turns are joined with a blank line and that is stated
 * here as the one transformation applied.
 *
 * Exported as a test seam. aws/harness/offline.ts asserts the split directly,
 * because getting it wrong produces plausible output rather than an error and
 * would not be caught by anything else.
 */
export function splitMessages(messages: ChatMessage[]): {
  system: SystemContentBlock[];
  turns: Message[];
} {
  const system: SystemContentBlock[] = [];
  const turns: Message[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      system.push({ text: m.content });
      continue;
    }
    const role = m.role === "assistant" ? "assistant" : "user";
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      const block = last.content?.[0] as { text?: string } | undefined;
      if (block?.text !== undefined) {
        block.text = `${block.text}\n\n${m.content}`;
        continue;
      }
    }
    turns.push({ role, content: [{ text: m.content }] as ContentBlock[] });
  }

  // Converse requires at least one turn, and requires the first to be `user`.
  if (turns.length === 0 || turns[0].role !== "user") {
    turns.unshift({ role: "user", content: [{ text: "Proceed." }] });
  }
  return { system, turns };
}

/**
 * One EMF line per completion, whatever the outcome.
 *
 * DELIBERATELY EMITTED BEFORE THE ERROR CHECKS in invokeOnce. A response
 * truncated against maxTokens is the single most expensive failure available
 * here - it burns the entire budget and returns nothing - so it is exactly the
 * call that must not go unrecorded. Logging after the throw would keep only the
 * cheap cases.
 *
 * EMBEDDED METRIC FORMAT rather than the plain JSON line the Foundry wrapper
 * wrote. Same fields, but CloudWatch extracts the numbers into real metrics at
 * ingest, so token spend and latency per call site become chartable and
 * alarmable instead of only greppable - at no custom-metric API cost.
 *
 * ONE THING WAS LOST IN THE PORT AND IT IS WORTH NAMING. Foundry returned
 * `completion_tokens_details.reasoning_tokens`, which let `reasoning_share` say
 * how much of the bill was invisible thinking - the number that told you
 * whether lowering effort at a site would save anything. Bedrock's TokenUsage
 * has no reasoning breakdown, so that diagnostic is gone. `effort` is logged
 * instead, which at least makes the dial visible next to the cost it produces.
 *
 * Never throws: a broken log line must not fail a good request.
 */
function logUsage(
  modelId: string,
  options: JsonCallOptions<unknown>,
  usage: TokenUsage | undefined,
  stopReason: string | undefined,
  elapsedMs: number,
): void {
  try {
    const site = options.label ?? options.schemaName ?? "unlabelled";
    const input = usage?.inputTokens ?? 0;
    const output = usage?.outputTokens ?? 0;
    console.log(
      JSON.stringify({
        _aws: {
          Timestamp: Date.now(),
          CloudWatchMetrics: [
            {
              Namespace: METRIC_NAMESPACE,
              // `site` alone, not [site, model]. Every extra dimension
              // combination is a separately-billed custom metric, and the model
              // is a deployment-wide setting rather than something that varies
              // per call in normal operation.
              Dimensions: [["site"]],
              Metrics: [
                { Name: "InputTokens", Unit: "Count" },
                { Name: "OutputTokens", Unit: "Count" },
                { Name: "Latency", Unit: "Milliseconds" },
              ],
            },
          ],
        },
        evt: "bedrock.call",
        site,
        model: modelId,
        effort: bedrockEffort(options.reasoningEffort),
        stop: stopReason ?? null,
        InputTokens: input,
        OutputTokens: output,
        CachedTokens: usage?.cacheReadInputTokens ?? 0,
        Latency: elapsedMs,
      }),
    );
  } catch {
    // Logging is never allowed to be the thing that breaks a call.
  }
}

/** One Converse request to a single model. Throws BedrockError on any failure. */
async function invokeOnce(
  modelId: string,
  messages: ChatMessage[],
  options: JsonCallOptions<unknown>,
): Promise<string> {
  const { system, turns } = splitMessages(messages);
  const startedAt = Date.now();

  // The SDK's own timeout covers the socket, not the total call. This bounds
  // the whole thing including retries inside the SDK.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);

  try {
    const command = new ConverseCommand({
      modelId,
      system: system.length > 0 ? system : undefined,
      messages: turns,
      inferenceConfig: {
        // ALWAYS SET, NEVER DEFAULTED. An unset maxTokens reserves the model
        // maximum against the account's throughput quota - which is the most
        // common cause of a ThrottlingException on an account making almost no
        // requests.
        maxTokens: options.maxCompletionTokens ?? MAX_TOKENS,
        ...(options.temperature !== undefined
          ? { temperature: options.temperature }
          : {}),
      },
      outputConfig: {
        // Conditional, not unconditional: these models reject `effort`
        // outright. See SEND_EFFORT in bedrock-config.ts.
        ...(SEND_EFFORT
          ? { effort: bedrockEffort(options.reasoningEffort) }
          : {}),
        ...(options.schema
          ? {
              textFormat: {
                type: "json_schema" as const,
                structure: {
                  jsonSchema: {
                    // A STRING. Passing the object is a ValidationException
                    // whose message names neither the field nor the reason.
                    schema: JSON.stringify(options.schema),
                    name: options.schemaName ?? "response",
                  },
                },
              },
            }
          : {}),
      },
    });

    const res: ConverseCommandOutput = await getClient().send(command, {
      abortSignal: abort.signal,
    });

    // Before the checks below, so the expensive failures are the ones recorded
    // rather than the ones lost. See logUsage.
    logUsage(modelId, options, res.usage, res.stopReason, Date.now() - startedAt);

    // Bedrock's StopReason vocabulary is not the OpenAI one, and the mapping is
    // where a port like this quietly loses information. Each branch below is a
    // distinct outcome that the Foundry wrapper either named differently or
    // could not distinguish at all.
    if (
      res.stopReason === "guardrail_intervened" ||
      res.stopReason === "content_filtered"
    ) {
      // Deterministic for a given input. Retrying it or advancing the chain
      // just burns budget to be refused again.
      throw new BedrockError(
        `Model "${modelId}" output was blocked (${res.stopReason}).`,
        "content_filter",
      );
    }
    if (res.stopReason === "max_tokens") {
      throw new BedrockError(
        `Model "${modelId}" hit maxTokens before finishing. Reasoning shares this ` +
          "budget - raise maxCompletionTokens or lower reasoningEffort.",
        "truncated",
      );
    }
    if (res.stopReason === "model_context_window_exceeded") {
      // The INPUT was too large, not the output. Raising maxCompletionTokens
      // makes this worse, not better, so it must not share the branch above.
      throw new BedrockError(
        `Model "${modelId}" was sent more context than it can hold. The prompt ` +
          "needs trimming; raising maxCompletionTokens will not help.",
        "truncated",
      );
    }
    if (
      res.stopReason === "malformed_model_output" ||
      res.stopReason === "malformed_tool_use"
    ) {
      // Constrained decoding failed to produce schema-valid output. Worth one
      // more attempt on the next model, which is what advancing the chain does.
      throw new BedrockError(
        `Model "${modelId}" produced output that did not satisfy the schema.`,
        "invalid_json",
      );
    }

    // Reasoning models emit reasoningContent blocks ahead of the answer, so
    // this cannot be content[0]. Taking the first block would return an empty
    // string on exactly the call sites tuned for medium effort.
    const text = (res.output?.message?.content ?? [])
      .map((b) => (b as { text?: string }).text)
      .filter((t): t is string => typeof t === "string" && t.length > 0)
      .join("");

    if (!text) {
      throw new BedrockError(
        `Model "${modelId}" returned no text (stopReason: ${res.stopReason ?? "none"}).`,
        "empty",
      );
    }
    return text;
  } catch (err) {
    if (err instanceof BedrockError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new BedrockError(
        `Model "${modelId}" timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        "http",
      );
    }
    if (name === "ThrottlingException" || name === "TooManyRequestsException") {
      throw new BedrockError(`Bedrock throttled "${modelId}".`, "rate_limit", 429);
    }
    if (name === "ValidationException") {
      // Almost always the schema. Say so, because the service message does not.
      throw new BedrockError(
        `Bedrock rejected the request for "${modelId}": ${
          err instanceof Error ? err.message : String(err)
        }. If a schema was supplied, check that every object has ` +
          "additionalProperties:false and that no numeric or string constraints are used.",
        "http",
        400,
      );
    }
    throw new BedrockError(
      `Bedrock call to "${modelId}" failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      "http",
    );
  } finally {
    clearTimeout(timer);
  }
}

/** Failures worth trying again on the same model. */
function isRetryable(err: unknown): boolean {
  if (!(err instanceof BedrockError)) return false;
  if (err.kind === "rate_limit") return true;
  if (err.kind === "truncated") return false;
  if (err.kind === "content_filter" || err.kind === "refusal") return false;
  return err.status !== undefined && err.status >= 500;
}

/**
 * Calls one model, retrying once on a throttle or server error.
 *
 * One retry here, on top of the SDK's own adaptive retries, deliberately: the
 * SDK retries the HTTP call, this retries the whole request including the
 * grammar compilation that a cold schema pays for.
 */
async function callModel(
  modelId: string,
  messages: ChatMessage[],
  options: JsonCallOptions<unknown>,
): Promise<string> {
  try {
    return await invokeOnce(modelId, messages, options);
  } catch (err) {
    if (!isRetryable(err)) throw err;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await invokeOnce(modelId, messages, options);
  }
}

/** Tries each model in order, advancing to the next on any thrown error. */
async function runChain<T>(
  models: string[],
  attempt: (modelId: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const modelId of models) {
    try {
      return await attempt(modelId);
    } catch (err) {
      lastError = err;
      const kind = err instanceof BedrockError ? err.kind : "unknown";
      console.error(`Bedrock model "${modelId}" failed (${kind}), trying next:`, err);
    }
  }
  throw lastError ?? new Error("No Bedrock models configured.");
}

function resolveModels(override?: string): string[] {
  if (!isLLMConfigured()) {
    throw new Error(
      "No AWS credentials available for Bedrock. On Lambda this is the " +
        "execution role; locally, run with a profile. Set TASKBUDDY_NO_LLM=1 " +
        "to use the offline heuristic instead.",
    );
  }
  return override ? [override] : modelChain();
}

/** Free-text completion. Used only by lib/generate.ts. */
export async function callBedrock(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<string> {
  return runChain(resolveModels(options.model), (modelId) =>
    callModel(modelId, messages, options),
  );
}

/**
 * Calls the model chain and parses the response as JSON.
 *
 * With a schema supplied the response is decoder-constrained, so `JSON.parse`
 * cannot fail on a well-formed call - the try/catch is for the schema-less
 * path and for a truncation that slipped past the stopReason check. The
 * fence-stripping and regex salvage the OpenRouter wrapper needed are gone and
 * should not come back: if parsing fails here, the schema is wrong.
 */
export async function callBedrockJSON<T>(
  messages: ChatMessage[],
  options: JsonCallOptions<T> = {},
): Promise<T> {
  return runChain(resolveModels(options.model), async (modelId) => {
    const raw = await callModel(modelId, messages, options as JsonCallOptions<unknown>);
    let parsed: T;
    try {
      parsed = JSON.parse(raw) as T;
    } catch {
      throw new BedrockError(
        `Model "${modelId}" returned unparseable JSON: ${raw.slice(0, 300)}`,
        "invalid_json",
      );
    }
    if (options.validate && !options.validate(parsed)) {
      throw new BedrockError(
        `Model "${modelId}" returned JSON that failed the call site's own check.`,
        "validation",
      );
    }
    return parsed;
  });
}
