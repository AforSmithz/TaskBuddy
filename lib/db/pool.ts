import "server-only";
// Side effect, and it must run before any Pool is constructed: registers the
// numeric/date/timestamp parsers that keep row values shaped the way the rest of
// the app already believes they are. See ./types.ts for why each one exists.
import "@/lib/db/types";

import { Pool, type PoolClient } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { RDS_CA_BUNDLE } from "@/lib/db/rds-ca";

// The connection pool and the transaction wrapper every query goes through.
//
// No database password here: Signer.getAuthToken() returns a 15-minute credential derived
// from the Lambda execution role, and taskbuddy_app is granted rds_iam, which makes password
// auth for that role impossible rather than just unused. This reverses the Azure decision
// (azure/sql/02_grants.sql kept a password because idleTimeoutMillis is 10s, so every new
// connection would need a live token). That held for Entra, where a token is an HTTP round
// trip; an RDS auth token is an HMAC over a URL computed locally, no network call. The
// objection was to the round trip and there isn't one. Not cached on purpose - signing is
// microseconds, and caching a 15-minute credential just adds a clock-skew failure.
//
// TLS: rejectUnauthorized against the pinned regional RDS root. The security group is open on
// 5432 (no static egress IP without a NAT gateway), so certificate VERIFICATION, not just
// encryption, is what stands between us and an impersonated server. rds.force_ssl=1 is set
// cluster-side as the other half.
//
// max: 6 because one dashboard render fires ~21 concurrent statements; at max 2 those
// serialised into ~11 round-trip batches, six takes it to ~4. Note it's PER EXECUTION
// ENVIRONMENT and Lambda scales those, so what actually reaches Aurora is max × concurrent
// invocations. Aurora allows several hundred, so connections aren't the binding constraint
// any more, Lambda concurrency is.
//
// idleTimeoutMillis 10s is what lets the cluster reach zero ACU - Aurora won't auto-pause
// while any connection is open, so holding connections between page views would keep capacity
// awake around the clock and turn a ~$10/mo cluster into ~$50/mo. Don't raise it. The
// taskbuddy-db-not-pausing alarm watches this exact assumption.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PORT = 5432;

let pool: Pool | null = null;

/** True when a real database is configured; everything else falls back to the in-memory demo
 *  store. PGHOST is the deployed shape (IAM auth, no secret); a full DATABASE_URL is the
 *  local-dev escape hatch for a Postgres in Docker that's never heard of IAM. */
export function isDbConfigured(): boolean {
  return Boolean(process.env.PGHOST || process.env.DATABASE_URL);
}

/** True when connecting with an IAM token rather than a password. */
function usesIamAuth(): boolean {
  return Boolean(process.env.PGHOST) && !process.env.DATABASE_URL;
}

function buildPool(): Pool {
  const strict = process.env.PGSSL_STRICT !== "0";

  // --- Local development: plain connection string, password auth -----------
  //
  // Parsed by hand rather than passed as `connectionString`: pg does
  // Object.assign({}, config, parse(connectionString)), so anything the URL implies WINS over
  // the explicit config - including sslmode. A stray ?sslmode=require copied off a psql
  // invocation would quietly override the TLS settings below.
  const raw = process.env.DATABASE_URL;
  if (raw) {
    const url = new URL(raw);
    return instrument(
      new Pool({
        host: url.hostname,
        port: Number(url.port || DEFAULT_PORT),
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database: url.pathname.replace(/^\//, "") || "postgres",
        // A local Postgres has no RDS certificate to verify against.
        ssl: url.hostname === "localhost" || url.hostname === "127.0.0.1"
          ? false
          : { ca: RDS_CA_BUNDLE, rejectUnauthorized: strict, servername: url.hostname },
        ...POOL_TUNING,
      }),
    );
  }

   // --- Deployed: IAM authentication. --------------------------------------
  const host = process.env.PGHOST;
  if (!host) {
    throw new Error(
      "No database configured. Set PGHOST (deployed, IAM auth) or DATABASE_URL " +
        "(local), or leave both unset to run the in-memory demo.",
    );
  }
  const port = Number(process.env.PGPORT || DEFAULT_PORT);
  const user = process.env.PGUSER ?? "taskbuddy_app";
  const region =
    process.env.AWS_REGION_NAME ?? process.env.AWS_REGION ?? "ap-southeast-1";

    // Module scope. The Signer holds the credential provider chain; rebuilding it per connection
    // would re-resolve the role credentials each time, which genuinely is a network call.
  const signer = new Signer({ hostname: host, port, username: user, region });

  return instrument(
    new Pool({
      host,
      port,
      user,
      database: process.env.PGDATABASE ?? "taskbuddy",
      // A FUNCTION, not a string - pg calls this per connection, so each one gets a fresh
      // token instead of every connection sharing one that expires fifteen minutes into the
      // instance's life. Returning a string is the most likely way this file breaks: it would
      // work perfectly for fifteen minutes after every deploy.
      password: () => signer.getAuthToken(),
      ssl: {
        ca: RDS_CA_BUNDLE,
        rejectUnauthorized: strict,
        servername: host,
      },
      ...POOL_TUNING,
    }),
  );
}

const POOL_TUNING = {
  max: 6,
  // Also the auto-pause enabler. See the header.
  idleTimeoutMillis: 10_000,
  // Not the same knob as the one above. idleTimeoutMillis drops connections fast so the
  // cluster can pause; this is how long we'll WAIT for one - and once the cluster has paused,
  // the next connection has to wake it, which takes Aurora around 15 seconds.
  //
  // At the previous 10s that wait always lost. Seen live 2026-08-19: the first sign-in after
  // an idle period failed twice with "user migration failed: Error: timeout expired" and only
  // worked on the third try, once the cluster was awake. Every cold path had it; the Cognito
  // migration trigger is just where it showed, because a failed login is louder than a slow
  // render.
  //
  // 30s covers the resume and costs nothing - it's a ceiling on waiting, not a duration
  // anything is held for, so it can't keep the cluster awake. Stays inside the 60s function
  // and CloudFront origin timeouts, so an unreachable database still fails as a connection
  // error rather than an unattributed gateway timeout.
  connectionTimeoutMillis: 30_000,
  // Belt and braces against a leaked transaction: the cluster-side
  // idle_in_transaction_session_timeout is 30s, this is the client half.
  statement_timeout: 15_000,
} as const;

function instrument(p: Pool): Pool {
  p.on("error", (err) => {
  // An idle client erroring isn't tied to any request, so it would otherwise be an
  // unhandled rejection and take the instance down. Expect this occasionally and harmlessly
  // on Lambda: a frozen execution environment can't run the idle timer, so a connection can
  // be reaped server-side while the pool still thinks it holds it.
    console.error("pg pool: idle client error", err.message);
  });
  return p;
}

/** The process-wide pool, built on first use. */
export function getPool(): Pool {
  if (!pool) pool = buildPool();
  return pool;
}

/** For the workers: close cleanly so a paused cluster is not held awake. */
export async function closePool(): Promise<void> {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => {});
}

/** Run `fn` in a transaction with app.user_id set to `uid`, which is what every RLS policy
 *  reads through app.uid().
 *
 *  Per statement, not per request. set_config(..., true) is transaction-local, so the GUC has
 *  to live in the same transaction as the statement depending on it - session-wide would leak
 *  one user's identity onto the next request that picked up the same pooled connection. And
 *  pinning a connection for a whole request would serialise the ~21 concurrent statements a
 *  dashboard render fires.
 *
 *  The finally release is load-bearing: an open transaction pins a connection until the 30s
 *  server idle timeout reaps it, and on Aurora it also stops the cluster ever pausing - so the
 *  symptom is a bill, not an outage. */
export async function withUser<T>(
  uid: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(uid)) {
    // Never reachable from a verified token, but an invalid uuid here would
    // surface as a confusing 22P02 from deep inside a policy check. This check
    // is also what makes the interpolation below safe - see there.
    throw new Error("Invalid user id.");
  }

  const client = await getPool().connect();
  try {
  // BEGIN and the GUC in one round trip. Passing no `values` makes pg use the simple query
  // protocol, which accepts several semicolon-separated statements per message; the extended
  // protocol (anything with parameters) doesn't, which is why this can't use a $1 placeholder.
  //
  // Interpolating `uid` is safe here, and only here, because it was just matched against
  // UUID_RE - the only characters that survive are hex digits and hyphens, so there's no
  // quote to escape. Keep the two adjacent.
    await client.query(
      `BEGIN; select set_config('app.user_id', '${uid}', true)`,
    );
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The connection is already broken; releasing it below is what matters.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Run `fn` on a pooled connection with NO app.user_id set. Only the auth path may use this,
 *  and only via the SECURITY DEFINER functions in 03_auth.sql - with the GUC unset app.uid()
 *  is NULL and every ordinary policy denies, which is the intent. */
export async function withoutUser<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

/** Diagnostic for the health endpoint and the harnesses. */
export function describeConnection(): string {
  if (!isDbConfigured()) return "demo (no database)";
  return usesIamAuth()
    ? `iam:${process.env.PGUSER}@${process.env.PGHOST}`
    : "password:DATABASE_URL";
}
