import "server-only";
import { ClientAssertionCredential } from "@azure/identity";
import { getVercelOidcToken } from "@vercel/functions/oidc";

// The federated workload identity this app runs as on Vercel.
//
// WHAT THIS REPLACES. Every Azure credential the app used to hold was a
// long-lived secret sitting in a Vercel environment variable: the Foundry API
// key, the database password. `azure/sql/02_grants.sql` argued — correctly at
// the time — that Key Vault could not fix that, because reading a secret from
// Key Vault needs a credential that would itself have to live in a Vercel env
// var. That reasoning holds right up until the root credential stops being a
// secret, which is what this file does.
//
// HOW IT WORKS. Vercel mints a short-lived OIDC JWT for each function
// invocation, signed by Vercel and carrying the subject
// `owner:<team>:project:<project>:environment:<production|preview>`. An Entra
// app registration (`taskbuddy-vercel`) declares a federated credential
// trusting exactly that issuer and subject, so Entra will exchange the JWT for
// an Azure access token. Nothing long-lived is stored anywhere, and there is no
// secret to rotate, leak, or forget to revoke.
//
// AZURE_TENANT_ID and AZURE_CLIENT_ID are NOT secrets. They are public
// directory identifiers; neither grants anything without a signed assertion
// from the trusted issuer. That is the whole point — the Vercel env var surface
// goes from "four secrets" to "two identifiers".

/** Matches the `audiences` on the federated credential. See azure/identity.sh. */
const EXCHANGE_AUDIENCE = "api://AzureADTokenExchange";

/** Foundry inference. The token this buys is accepted as `Authorization: Bearer`. */
export const COGNITIVE_SERVICES_SCOPE =
  "https://cognitiveservices.azure.com/.default";

// MODULE SCOPE, DELIBERATELY. ClientAssertionCredential caches the *Azure*
// access token it gets back (roughly an hour) and only re-runs the assertion
// callback when that token is close to expiry. Building the credential per
// request would throw that cache away and pay a full Vercel exchange plus an
// Entra round trip on every single LLM call.
//
// KEYED ON THE IDENTITY rather than being a bare singleton. In production this
// makes no difference — a serverless instance never changes identity mid-life —
// but a bare singleton also caches the *miss*, which makes the whole path
// untestable in one process and would hide a late-binding env var. Keying it
// costs one string compare and removes both problems.
let cached: { key: string; credential: ClientAssertionCredential } | null = null;

/**
 * The federated credential, or `null` when this process has no workload
 * identity — local `next dev`, and the plain-Node tsx harnesses under
 * `azure/harness/`. Both of those have no OIDC token to present, so callers
 * fall back to key auth rather than failing.
 *
 * Returning `null` instead of throwing is what keeps the offline harness
 * runnable, which this repo's verification discipline depends on.
 */
export function azureCredential(): ClientAssertionCredential | null {
  const tenantId = process.env.AZURE_TENANT_ID;
  const clientId = process.env.AZURE_CLIENT_ID;
  if (!tenantId || !clientId) return null;

  const key = `${tenantId}:${clientId}`;
  if (cached?.key === key) return cached.credential;

  const credential = new ClientAssertionCredential(tenantId, clientId, () =>
    // Called by the SDK on every token refresh, never cached by us. The
    // @vercel/oidc docs are explicit that the OIDC token "is subject to change
    // in production" and must not be held onto — it is the credential's own
    // access-token cache that makes this cheap, not a cache of this value.
    //
    // Passing `audience` makes Vercel *exchange* the platform token for one
    // whose `aud` is api://AzureADTokenExchange. Without it the token carries
    // `https://vercel.com/<team>` instead, and Entra rejects the assertion with
    // an AADSTS700212 audience mismatch.
    getVercelOidcToken({ audience: EXCHANGE_AUDIENCE }),
  );
  cached = { key, credential };
  return credential;
}

/** True when a federated identity is configured. Cheap; no network. */
export function hasFederatedIdentity(): boolean {
  return Boolean(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID);
}
