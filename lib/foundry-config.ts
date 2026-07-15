// Foundry configuration predicates. Deliberately NOT `server-only`, unlike
// lib/foundry.ts which holds the API key and the fetch.
//
// This split exists because `isLLMConfigured()` is the gate for the entire LLM
// layer and is imported from places that must stay loadable outside the Next
// server runtime: lib/checkin.ts and lib/skill-links.ts both keep their pure
// halves importable from a plain-Node tsx harness, and re-exporting the gate
// from a server-only module quietly broke that. Nothing secret lives here - the
// key is only ever tested for presence, never returned.

const DEFAULT_DEPLOYMENT = "gpt-5-mini";
const DEFAULT_FALLBACK_DEPLOYMENT = "gpt-4.1-mini";

/**
 * Deployments whose underlying model is a reasoning model. Matched against the
 * deployment name, which is why the provisioning script names each deployment
 * after its model. Override with AZURE_FOUNDRY_REASONING_DEPLOYMENTS
 * (comma-separated) when a deployment is named something else.
 */
const REASONING_NAME_PATTERN = /^(o[0-9]|gpt-5)/i;

/**
 * True when Foundry is configured. The single gate for the whole LLM layer - 
 * lib/extraction.ts and lib/checkin.ts re-export it, and app/(app)/layout.tsx
 * uses it to decide demo mode. Env is read at call time, never at module scope,
 * so the app boots without any of it set.
 *
 * TWO WAYS TO BE CONFIGURED, and the second one is easy to forget. An API key
 * is one; a federated workload identity is the other. Once the app
 * authenticates to Foundry with an Entra token there is no API key at all, and
 * a gate that only looked for the key would quietly put the whole deployment
 * into demo mode at exactly the moment the migration succeeded. The symptom
 * would be heuristic output with no error anywhere.
 *
 * The identity check is duplicated from lib/azure-credential.ts rather than
 * imported because this module is deliberately not `server-only` - the tsx
 * harnesses import it - and azure-credential.ts is. Neither variable is a
 * secret, so reading them here costs nothing.
 */
export function isLLMConfigured(): boolean {
  if (!process.env.AZURE_FOUNDRY_ENDPOINT) return false;
  return Boolean(
    process.env.AZURE_FOUNDRY_API_KEY ||
      (process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID),
  );
}

export function isReasoningDeployment(name: string): boolean {
  const declared = (process.env.AZURE_FOUNDRY_REASONING_DEPLOYMENTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (declared.length > 0) return declared.includes(name);
  return REASONING_NAME_PATTERN.test(name);
}

/** Primary then fallback deployment names, de-duplicated. */
export function deploymentNames(): string[] {
  const primary = process.env.AZURE_FOUNDRY_DEPLOYMENT || DEFAULT_DEPLOYMENT;
  const fallback =
    process.env.AZURE_FOUNDRY_FALLBACK_DEPLOYMENT || DEFAULT_FALLBACK_DEPLOYMENT;
  return [...new Set([primary, fallback].filter(Boolean))];
}

/**
 * Normalises the configured endpoint to a bare origin. Tolerates a trailing
 * slash and a full path pasted from the portal, both of which are easy to get
 * wrong and produce a 404 that reads like a bad deployment name.
 */
export function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "").replace(/\/openai(\/v1)?$/, "");
}
