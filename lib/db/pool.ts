import "server-only";
// Side effect, and it must run before any Pool is constructed: registers the
// numeric/date/timestamp parsers that keep row values shaped the way the rest of
// the app already believes they are. See ./types.ts for why each one exists.
import "./types";

import { Pool, type PoolClient } from "pg";
import { Signer } from "@aws-sdk/rds-signer";
import { RDS_CA_BUNDLE } from "./rds-ca";

// The connection pool, and the transaction wrapper every query goes through.
//
// ===========================================================================
// AUTHENTICATION: AN IAM TOKEN, NOT A PASSWORD
// ===========================================================================
// There is no database password in this deployment. `Signer.getAuthToken()`
// returns a 15-minute credential derived from the Lambda execution role, and
// the `taskbuddy_app` role is granted `rds_iam`, which in Postgres makes
// password authentication for that role impossible rather than merely unused.
//
// THIS REVERSES THE AZURE DECISION, AND THE REVERSAL IS THE POINT.
// azure/sql/02_grants.sql argued that the app should keep a password rather
// than use Entra tokens, because `idleTimeoutMillis` is 10s so connections are
// created constantly and each new one would need a live token - "a new failure
// mode on the hottest path in the system". That reasoning was correct for
// Azure and does not transfer. An Entra token is an HTTP round trip to a token
// endpoint. An RDS auth token is an HMAC over a URL, computed locally from
// credentials the runtime already holds, with no network call at all. The
// objection was to the round trip, and there is no round trip.
//
// The SDK caches nothing, deliberately: signing is microseconds, and caching a
// 15-minute credential would only introduce a clock-skew failure.
//
// ===========================================================================
// TLS
// ===========================================================================
// `rejectUnauthorized: true` against the pinned regional RDS root. The security
// group is open on 5432 (Lambda has no static egress IP without a NAT gateway),
// so certificate VERIFICATION - not merely encryption - is what stands between
// the app and an impersonated server. `rds.force_ssl=1` is set cluster-side as
// the other half; see aws/infra/lib/data-stack.ts.
//
// ===========================================================================
// SIZING, AND WHY idleTimeoutMillis IS NOW A COST CONTROL
// ===========================================================================
// `max: 6` is carried over unchanged, and the reasoning still holds: a single
// dashboard render fires roughly 21 concurrent statements (`store.ts`
// gatherForecast, a 13-way Promise.all inside forecastDashboard's 8-way). At
// `max: 2` those serialised into ~11 round-trip batches; six takes it to ~4.
//
// What changed is the ceiling it is measured against. Azure's Burstable B1ms
// gave ~35 usable connections. Aurora Serverless v2 at the 0.5 ACU floor allows
// several hundred, so the connection ceiling is no longer the binding
// constraint - Lambda concurrency is. `max` is PER EXECUTION ENVIRONMENT, and
// Lambda scales environments, so the number that reaches Aurora is
// max x concurrent invocations.
//
// `idleTimeoutMillis: 10_000` has acquired a second job. On Azure it was
// hygiene. Here it is what lets the cluster reach zero ACU: Aurora will not
// auto-pause while any connection is open, so a pool that held connections
// between page views would keep capacity awake around the clock and turn a
// ~$10/mo cluster into a ~$50/mo one. Do not raise it. The
// `taskbuddy-db-not-pausing` alarm watches this exact assumption.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_PORT = 5432;

let pool: Pool | null = null;

/**
 * True when a real database is configured. Everything else falls back to the
 * in-memory demo store.
 *
 * Two shapes count. `PGHOST` is the deployed one - IAM auth, no secret. A full
 * `DATABASE_URL` is the local-development escape hatch, for a Postgres in
 * Docker that has never heard of IAM.
 */
export function isDbConfigured(): boolean {
  return Boolean(process.env.PGHOST || process.env.DATABASE_URL);
}

/** True when connecting with an IAM token rather than a password. */
function usesIamAuth(): boolean {
  return Boolean(process.env.PGHOST) && !process.env.DATABASE_URL;
}

function buildPool(): Pool {
  const strict = process.env.PGSSL_STRICT !== "0";

  // --- Local development: a plain connection string, password auth. --------
  //
  // Parsed by hand rather than handed to pg as `connectionString`, exactly as
  // before: pg does `Object.assign({}, config, parse(connectionString))`, so
  // anything the URL implies WINS over the explicit config - including
  // `sslmode`. A stray `?sslmode=require` copied from a psql invocation would
  // quietly override the TLS settings below.
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

  // MODULE SCOPE. The Signer holds the credential provider chain; rebuilding it
  // per connection would re-resolve the role credentials each time, which
  // genuinely is a network call and would reintroduce the very problem the
  // Azure note warned about.
  const signer = new Signer({ hostname: host, port, username: user, region });

  return instrument(
    new Pool({
      host,
      port,
      user,
      database: process.env.PGDATABASE ?? "taskbuddy",
      // A FUNCTION, not a string. node-postgres calls this per connection, so
      // each connection gets a fresh token rather than every connection sharing
      // one that expires fifteen minutes into the instance's life. Returning a
      // string here is the single most likely way this file breaks: it would
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
  connectionTimeoutMillis: 10_000,
  // Belt and braces against a leaked transaction: the cluster-side
  // idle_in_transaction_session_timeout is 30s, this is the client half.
  statement_timeout: 15_000,
} as const;

function instrument(p: Pool): Pool {
  p.on("error", (err) => {
    // An idle client erroring out is not tied to any request, so it would
    // otherwise become an unhandled rejection and take the instance down.
    //
    // Expect to see this occasionally and harmlessly on Lambda: an execution
    // environment frozen between invocations cannot run the idle timer, so a
    // connection can be reaped server-side while the pool still believes it
    // holds it. The pool discards and reconnects.
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

/**
 * Run `fn` inside a transaction with `app.user_id` set to `uid`, which is what
 * every RLS policy in `01_schema.sql` reads through `app.uid()`.
 *
 * PER STATEMENT, NOT PER REQUEST. This is not a tuning choice:
 *
 *  - `set_config(..., true)` is transaction-local, so the GUC has to live inside
 *    the same transaction as the statement that depends on it. Setting it
 *    session-wide would leak one user's identity onto the next request that
 *    picked up the same pooled connection.
 *  - Pinning one connection for a whole request would serialise the ~21
 *    concurrent statements a dashboard render fires.
 *
 * The `finally` release is load-bearing. A transaction left open pins a
 * connection until the server's 30s idle timeout reaps it - and on Aurora it
 * also stops the cluster ever pausing, so the symptom is a bill rather than an
 * outage.
 */
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
    // BEGIN and the GUC in ONE round trip rather than two.
    //
    // Passing no `values` makes node-postgres use the simple query protocol,
    // which accepts several semicolon-separated statements per message. The
    // extended protocol - anything with parameters - does not, which is why
    // this cannot be written with a $1 placeholder.
    //
    // INTERPOLATING `uid` IS SAFE HERE, AND ONLY HERE, because it has just been
    // matched against UUID_RE above: the only characters that survive that test
    // are hex digits and hyphens, so there is no quote to escape and nothing to
    // inject. Keep the two adjacent.
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

/**
 * Run `fn` on a pooled connection with **no** `app.user_id` set. Only the
 * authentication path may use this, and only via the SECURITY DEFINER functions
 * in `03_auth.sql` - with the GUC unset, `app.uid()` is NULL and every ordinary
 * policy denies, which is exactly the intent.
 */
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
