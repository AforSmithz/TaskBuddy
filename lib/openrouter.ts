import "server-only";

// Thin wrapper around the OpenRouter chat completions API.
// All LLM-powered features (extraction, follow-up messages, EOD summaries)
// go through callOpenRouter / callOpenRouterJSON.
//
// Requests run through a model fallback chain: the primary model is tried
// first, the fallback model on any failure (HTTP error, rate limit, empty or
// unparseable response). If every model fails, callers fall back to the
// offline heuristic extractor.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

// Paid instruct model, tried first. ~$0.0007 per extraction, so a small
// credit balance covers many thousands of calls.
const DEFAULT_MODEL = "qwen/qwen3-235b-a22b-2507";
// Free hybrid-MoE model, used only when the primary fails. Low-effort
// reasoning is enabled below — it improves task scoring/sequencing and costs
// nothing on the free tier.
const DEFAULT_FALLBACK_MODEL = "google/gemma-4-26b-a4b-it:free";

// Generous output ceiling: an extraction emits a large nested JSON object;
// too low a cap truncates the response and breaks JSON parsing.
const MAX_TOKENS = 12000;
// Abort a single hung request so a stuck primary doesn't stack its latency
// onto the fallback.
const REQUEST_TIMEOUT_MS = 90_000;

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CallOptions {
  /** Force a JSON object response. */
  json?: boolean;
  temperature?: number;
  /** Force a single model for this call, bypassing the fallback chain. */
  model?: string;
}

interface JsonCallOptions<T> extends CallOptions {
  /**
   * Reject a parsed-but-unusable response. A model can return syntactically
   * valid JSON that is semantically empty (e.g. missing `tasks`); returning
   * false here makes the chain advance to the next model rather than accept it.
   */
  validate?: (parsed: T) => boolean;
}

interface Config {
  apiKey: string;
  models: string[];
  siteUrl: string;
  siteName: string;
}

class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function getConfig(): Config {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Set it in .env.local (see .env.local.example).",
    );
  }
  const primary = process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
  const fallback =
    process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  return {
    apiKey,
    // De-duplicated so an identical primary/fallback isn't tried twice.
    models: [...new Set([primary, fallback].filter(Boolean))],
    siteUrl: process.env.OPENROUTER_SITE_URL || "http://localhost:3000",
    siteName: process.env.OPENROUTER_SITE_NAME || "TaskBuddy",
  };
}

/** One HTTP request to a single model. Throws OpenRouterError on any failure. */
async function fetchCompletion(
  model: string,
  messages: ChatMessage[],
  options: CallOptions,
  config: Config,
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl,
        "X-Title": config.siteName,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: MAX_TOKENS,
        // Light reasoning improves scoring/sequencing on hybrid models and is
        // ignored by instruct-only models. Reasoning is returned in a separate
        // field, so message.content stays clean JSON.
        reasoning: { effort: "low" },
        ...(options.json
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new OpenRouterError(
        `OpenRouter request failed (${res.status}): ${detail.slice(0, 500)}`,
        res.status,
      );
    }

    // OpenRouter can return HTTP 200 with an error body.
    const data = (await res.json()) as {
      error?: unknown;
      choices?: { message?: { content?: string } }[];
    };
    if (data.error) {
      throw new OpenRouterError(
        `OpenRouter returned an error: ${JSON.stringify(data.error).slice(0, 500)}`,
      );
    }
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new OpenRouterError("OpenRouter returned an empty response.");
    }
    return content;
  } finally {
    clearTimeout(timeout);
  }
}

/** Calls one model, retrying once on a rate-limit or server error. */
async function callModel(
  model: string,
  messages: ChatMessage[],
  options: CallOptions,
  config: Config,
): Promise<string> {
  try {
    return await fetchCompletion(model, messages, options, config);
  } catch (err) {
    const status = err instanceof OpenRouterError ? err.status : undefined;
    const retryable = status === 429 || (status !== undefined && status >= 500);
    if (!retryable) throw err;
    // Brief backoff before one retry; only then does runChain advance models.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return await fetchCompletion(model, messages, options, config);
  }
}

/** Tries each model in order, advancing to the next on any thrown error. */
async function runChain<T>(
  models: string[],
  attempt: (model: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const model of models) {
    try {
      return await attempt(model);
    } catch (err) {
      lastError = err;
      console.error(`OpenRouter model "${model}" failed, trying next:`, err);
    }
  }
  throw lastError ?? new Error("No OpenRouter models configured.");
}

export async function callOpenRouter(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<string> {
  const config = getConfig();
  const models = options.model ? [options.model] : config.models;
  return runChain(models, (model) =>
    callModel(model, messages, options, config),
  );
}

/** Calls the model chain and parses the response as JSON, tolerating ```json fences. */
export async function callOpenRouterJSON<T>(
  messages: ChatMessage[],
  options: JsonCallOptions<T> = {},
): Promise<T> {
  const config = getConfig();
  const models = options.model ? [options.model] : config.models;
  // Parse and validate inside the chain so a model that returns unparseable or
  // semantically-empty JSON advances to the next model rather than being
  // accepted as a successful result.
  return runChain(models, async (model) => {
    const raw = await callModel(
      model,
      messages,
      { ...options, json: true },
      config,
    );
    const parsed = parseJson<T>(raw);
    if (options.validate && !options.validate(parsed)) {
      throw new OpenRouterError(
        `Model "${model}" returned a JSON response that failed validation.`,
      );
    }
    return parsed;
  });
}

function parseJson<T>(raw: string): T {
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Fall back to extracting the first {...} or [...] block.
    const match = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (match) {
      return JSON.parse(match[0]) as T;
    }
    throw new Error(`Could not parse LLM response as JSON: ${raw.slice(0, 300)}`);
  }
}
