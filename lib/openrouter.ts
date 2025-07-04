import "server-only";

// Thin wrapper around the OpenRouter chat completions API.
// All LLM-powered features (extraction, follow-up messages, EOD summaries)
// go through callOpenRouter / callOpenRouterJSON.

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface CallOptions {
  /** Force a JSON object response. */
  json?: boolean;
  temperature?: number;
  /** Override the model for this call. */
  model?: string;
}

function getConfig() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing OPENROUTER_API_KEY. Set it in .env.local (see .env.local.example).",
    );
  }
  return {
    apiKey,
    model: process.env.OPENROUTER_MODEL || "anthropic/claude-3.7-sonnet",
    siteUrl: process.env.OPENROUTER_SITE_URL || "http://localhost:3000",
    siteName: process.env.OPENROUTER_SITE_NAME || "TaskBuddy",
  };
}

export async function callOpenRouter(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<string> {
  const config = getConfig();

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.siteUrl,
      "X-Title": config.siteName,
    },
    body: JSON.stringify({
      model: options.model || config.model,
      messages,
      temperature: options.temperature ?? 0.2,
      ...(options.json
        ? { response_format: { type: "json_object" } }
        : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `OpenRouter request failed (${res.status}): ${detail.slice(0, 500)}`,
    );
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("OpenRouter returned an empty response.");
  }
  return content;
}

/** Calls the model and parses the response as JSON, tolerating ```json fences. */
export async function callOpenRouterJSON<T>(
  messages: ChatMessage[],
  options: CallOptions = {},
): Promise<T> {
  const raw = await callOpenRouter(messages, { ...options, json: true });
  return parseJson<T>(raw);
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
