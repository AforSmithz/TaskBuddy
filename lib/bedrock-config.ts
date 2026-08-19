// Bedrock configuration predicates. Deliberately NOT `server-only`, unlike
// lib/bedrock.ts which holds the client and the invocation.
//
// This split is carried over from lib/foundry-config.ts and exists for the same
// reason: `isLLMConfigured()` gates the entire LLM layer and is imported from
// places that must stay loadable outside the Next server runtime.
// lib/checkin.ts and lib/skill-links.ts both keep their pure halves importable
// from a plain-Node tsx harness, and re-exporting the gate from a server-only
// module quietly broke that. Nothing secret lives here - and on Bedrock there
// is no secret to live anywhere.

/**
 * Inference profile ids, not bare model ids. Claude 4.5 and newer refuse
 * on-demand invocation with a bare model id and answer with an error naming a
 * profile you have not configured, which reads like a permissions problem.
 */
const DEFAULT_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
const DEFAULT_FALLBACK_MODEL = "global.anthropic.claude-sonnet-4-6";

/**
 * True when the LLM layer is usable. The single gate for the whole layer -
 * lib/extraction.ts and lib/checkin.ts re-export it, and app/(app)/layout.tsx
 * uses it to decide demo mode.
 *
 * THIS IS THE ONE PREDICATE THE MIGRATION SIMPLIFIED RATHER THAN TRANSLATED.
 * On Foundry it had to answer "is there an API key, OR a federated identity?",
 * because getting either wrong dropped the whole deployment into demo mode with
 * heuristic output and no error anywhere. Bedrock has no key and no endpoint:
 * authentication is the execution role, which is either present or the process
 * is not running on AWS at all. So the question collapses to "are we on AWS,
 * and has someone opted out?".
 *
 * `TASKBUDDY_NO_LLM=1` is the explicit opt-out, for running the app locally
 * against the offline heuristic extractor without unsetting credentials.
 */
export function isLLMConfigured(): boolean {
  if (process.env.TASKBUDDY_NO_LLM === "1") return false;
  // Set by the Lambda runtime; also set by `aws configure`-style sessions via
  // AWS_REGION. Either means a credential chain exists to sign with.
  return Boolean(
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
      process.env.AWS_REGION ||
      process.env.AWS_REGION_NAME ||
      process.env.AWS_PROFILE ||
      process.env.AWS_ACCESS_KEY_ID,
  );
}

/** Primary then fallback model, de-duplicated. */
export function modelChain(): string[] {
  const primary = process.env.BEDROCK_MODEL || DEFAULT_MODEL;
  const fallback = process.env.BEDROCK_FALLBACK_MODEL || DEFAULT_FALLBACK_MODEL;
  return [...new Set([primary, fallback].filter(Boolean))];
}

export function bedrockRegion(): string {
  return (
    process.env.BEDROCK_REGION ??
    process.env.AWS_REGION_NAME ??
    process.env.AWS_REGION ??
    "ap-southeast-1"
  );
}

/**
 * The app's four effort levels, mapped onto Bedrock's five.
 *
 * Bedrock's floor is "low"; the app's "minimal" (used only by the one-shot
 * prose call in lib/generate.ts) has no exact counterpart and maps down to it.
 * "xhigh" and "max" are reachable only with extended thinking enabled and are
 * deliberately not exposed - no call site in this app has ever needed more than
 * "medium", and the two highest levels are where reasoning cost stops being
 * rounding error.
 */
/**
 * Whether to send `outputConfig.effort` at all.
 *
 * OFF, because Bedrock rejects it. The design assumed `effort` and
 * `textFormat` compose in one `outputConfig` - and on the API shape they do -
 * but the models this app actually calls refuse the field outright:
 *
 *   ValidationException (400): This model doesn't support the effort field.
 *                              Remove effort and try again.
 *
 * Observed live on 2026-08-19 from the llm-worker, for BOTH
 * `global.anthropic.claude-haiku-4-5-20251001-v1:0` and
 * `global.anthropic.claude-sonnet-4-6`, which is to say for the primary and the
 * fallback - so the chain exhausted itself and every LLM call in the app failed.
 *
 * The failure is quiet in exactly the way that matters: callers degrade to their
 * offline heuristics, the job row still settles `succeeded`, and the dashboard
 * shows its deterministic "Strategy draft" instead of an AI synthesis. Nothing
 * surfaces as broken; the app just silently stops being the thing it is for. The
 * only evidence is the worker's CloudWatch logs.
 *
 * Kept as a flag rather than deleted because `bedrockEffort` still maps the
 * app's four levels correctly and the field is documented on Converse - so this
 * is very likely a per-model gap that a future model version closes. Flip to
 * true and re-run one real call per model to check.
 */
export const SEND_EFFORT = false;

export function bedrockEffort(effort: string | undefined): string {
  switch (effort) {
    case "minimal":
      return "low";
    case "high":
      return "high";
    case "medium":
      return "medium";
    default:
      return "low";
  }
}
