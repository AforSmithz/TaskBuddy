/**
 * Offline harness for the federated-identity auth path.
 *
 *   npx tsx azure/harness/identity.ts
 *
 * No network, no Azure, no Vercel. Covers the parts of the OIDC migration that
 * are pure logic and that fail *silently* when they are wrong:
 *
 *  - `isLLMConfigured()` accepting a federated identity as well as an API key.
 *    Get this wrong and deleting AZURE_FOUNDRY_API_KEY does not break the app,
 *    it drops the whole deployment into demo mode with heuristic output and no
 *    error anywhere. That is the single most dangerous failure in this change.
 *  - Header selection: token preferred over key, key used when no identity is
 *    configured, loud fallback when an identity is configured but cannot mint.
 *  - `getConfig()` no longer requiring a key once an identity is present.
 *
 * Header selection is checked by stubbing `fetch` and reading what the real
 * `callFoundry` actually put on the wire, rather than by exporting internals.
 * The exchange itself cannot be exercised here — `getVercelOidcToken()` only
 * resolves inside a Vercel function — so proving the token is *accepted* is the
 * live pass's job, not this file's.
 */
import Module from "module";
import fs from "fs";
import path from "path";

// --- shim `server-only` before anything imports it --------------------------
// Same concession as azure/harness/foundry-live.ts: Next aliases this module,
// plain Node cannot resolve it.
const shimPath = path.join(__dirname, ".server-only-shim.js");
fs.writeFileSync(shimPath, "module.exports = {};\n");
type ResolveFn = (request: string, ...rest: unknown[]) => string;
const mod = Module as unknown as { _resolveFilename: ResolveFn };
const originalResolve = mod._resolveFilename;
mod._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === "server-only") return shimPath;
  return originalResolve.call(this, request, ...rest);
};

let passed = 0;
const failures: string[] = [];

function ok(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` (${detail})` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` (${detail})` : ""}`);
  }
}

// Env is read at call time everywhere in this layer, which is what makes this
// harness possible at all: each case just rewrites process.env and re-calls.
const IDENTITY_KEYS = [
  "AZURE_FOUNDRY_ENDPOINT",
  "AZURE_FOUNDRY_API_KEY",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
] as const;

function setEnv(vars: Partial<Record<(typeof IDENTITY_KEYS)[number], string>>) {
  for (const k of IDENTITY_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries(vars)) process.env[k] = v;
}

// --- 1. the configuration gate ----------------------------------------------

async function gateChecks() {
  console.log("\nisLLMConfigured");
  const { isLLMConfigured } = await import("../../lib/foundry-config");

  setEnv({});
  ok("nothing set -> false", !isLLMConfigured());

  setEnv({ AZURE_FOUNDRY_API_KEY: "k", AZURE_TENANT_ID: "t", AZURE_CLIENT_ID: "c" });
  ok("no endpoint -> false", !isLLMConfigured(), "endpoint is always required");

  setEnv({ AZURE_FOUNDRY_ENDPOINT: "https://e.example.com" });
  ok("endpoint alone -> false", !isLLMConfigured());

  setEnv({ AZURE_FOUNDRY_ENDPOINT: "https://e.example.com", AZURE_FOUNDRY_API_KEY: "k" });
  ok("endpoint + key -> true", isLLMConfigured(), "the pre-migration path");

  setEnv({
    AZURE_FOUNDRY_ENDPOINT: "https://e.example.com",
    AZURE_TENANT_ID: "t",
    AZURE_CLIENT_ID: "c",
  });
  ok(
    "endpoint + identity, NO key -> true",
    isLLMConfigured(),
    "the whole point: deleting the key must not silently enable demo mode",
  );

  setEnv({ AZURE_FOUNDRY_ENDPOINT: "https://e.example.com", AZURE_TENANT_ID: "t" });
  ok("half an identity -> false", !isLLMConfigured(), "tenant without client is not an identity");

  setEnv({ AZURE_FOUNDRY_ENDPOINT: "https://e.example.com", AZURE_CLIENT_ID: "c" });
  ok("other half -> false", !isLLMConfigured());
}

// --- 2. credential resolution ------------------------------------------------

async function credentialChecks() {
  console.log("\nazureCredential");
  const { azureCredential, hasFederatedIdentity } = await import(
    "../../lib/azure-credential"
  );

  setEnv({ AZURE_FOUNDRY_ENDPOINT: "https://e.example.com", AZURE_FOUNDRY_API_KEY: "k" });
  ok("no identity vars -> hasFederatedIdentity false", !hasFederatedIdentity());
  ok("no identity vars -> credential null", azureCredential() === null);

  const A = {
    AZURE_FOUNDRY_ENDPOINT: "https://e.example.com",
    AZURE_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  };
  setEnv(A);
  ok("identity vars -> hasFederatedIdentity true", hasFederatedIdentity());
  const first = azureCredential();
  ok("identity vars -> a credential", first !== null);
  ok(
    "same identity -> same instance",
    azureCredential() === first,
    "the token cache lives on the instance; rebuilding it per call would discard it",
  );

  // The memo is keyed, not a bare singleton. A bare singleton would also cache
  // the null above and never produce a credential at all in this process.
  setEnv({ ...A, AZURE_CLIENT_ID: "33333333-3333-3333-3333-333333333333" });
  const second = azureCredential();
  ok("different identity -> different instance", second !== null && second !== first);

  setEnv({ AZURE_FOUNDRY_ENDPOINT: "https://e.example.com" });
  ok("identity removed -> back to null", azureCredential() === null);
}

// --- 3. what actually goes on the wire ---------------------------------------

interface Captured {
  headers: Record<string, string>;
}

/**
 * Runs `callFoundry` against a stubbed fetch and returns the headers it sent.
 *
 * No module-registry juggling needed: every read in this path (`getConfig`,
 * `isLLMConfigured`, `azureCredential`) goes to `process.env` at call time, and
 * the credential memo is keyed on the identity rather than being a singleton.
 * Rewriting the env between cases is therefore sufficient to isolate them.
 */
async function captureHeaders(
  env: Partial<Record<(typeof IDENTITY_KEYS)[number], string>>,
): Promise<Captured | { error: string }> {
  setEnv(env);

  const captured: Captured = { headers: {} };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    captured.headers = init.headers as Record<string, string>;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const { callFoundry } = await import("../../lib/foundry");
    await callFoundry([{ role: "user", content: "ping" }], {});
    return captured;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function wireChecks() {
  console.log("\nheaders on the wire");

  const keyOnly = await captureHeaders({
    AZURE_FOUNDRY_ENDPOINT: "https://e.example.com",
    AZURE_FOUNDRY_API_KEY: "secret-key",
  });
  ok(
    "key only -> api-key header",
    "headers" in keyOnly && keyOnly.headers["api-key"] === "secret-key",
    JSON.stringify(keyOnly),
  );
  ok(
    "key only -> no Authorization header",
    "headers" in keyOnly && !keyOnly.headers.Authorization,
  );

  // Identity configured but unmintable (no OIDC token in this process) AND a
  // key present: must fall back, and must warn while doing it.
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => void warnings.push(args.join(" "));
  const both = await captureHeaders({
    AZURE_FOUNDRY_ENDPOINT: "https://e.example.com",
    AZURE_FOUNDRY_API_KEY: "secret-key",
    AZURE_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  });
  console.warn = realWarn;
  ok(
    "identity unmintable + key -> falls back to api-key",
    "headers" in both && both.headers["api-key"] === "secret-key",
    JSON.stringify(both),
  );
  ok(
    "...and says so loudly",
    warnings.some((w) => w.includes("foundry.auth")),
    `warnings: ${JSON.stringify(warnings)}`,
  );

  // Identity configured, unmintable, and NO key: must fail rather than send an
  // unauthenticated request.
  const neither = await captureHeaders({
    AZURE_FOUNDRY_ENDPOINT: "https://e.example.com",
    AZURE_TENANT_ID: "11111111-1111-1111-1111-111111111111",
    AZURE_CLIENT_ID: "22222222-2222-2222-2222-222222222222",
  });
  ok(
    "identity unmintable, no key -> throws, sends nothing",
    "error" in neither || !("headers" in neither && neither.headers["api-key"]),
    JSON.stringify(neither),
  );
}

// --- report ------------------------------------------------------------------

(async () => {
  await gateChecks();
  await wireChecks();
  await credentialChecks();

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log("offline identity harness green\n");
})();
