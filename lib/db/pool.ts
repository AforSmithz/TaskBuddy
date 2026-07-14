import "server-only";
// Side effect, and it must run before any Pool is constructed: registers the
// numeric/date/timestamp parsers that keep row values shaped the way the rest of
// the app already believes they are. See ./types.ts for why each one exists.
import "./types";

import { Pool, type PoolClient } from "pg";
import { attachDatabasePool } from "@vercel/functions";

// The connection pool, and the transaction wrapper every query goes through.
//
// SIZING. The database is a Burstable B1ms: 50 connections total, ~35 usable
// once the platform takes its 15. A single dashboard render fires roughly 21
// concurrent statements (`store.ts` gatherForecast, a 13-way Promise.all, inside
// forecastDashboard's 8-way). With `max: 2` those queue inside one instance
// instead of racing to exhaust the server, and Fluid Compute scale-out is what
// adds throughput. PgBouncer is not available on the Burstable tier, so there is
// no server-side pooler to fall back on.
//
// This is a module-scope singleton on purpose. A per-request pool would multiply
// 2 by the number of in-flight requests and blow through 35 immediately.

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let pool: Pool | null = null;

/** True when a real database is configured. Everything else falls back to the in-memory demo store. */
export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

function buildPool(): Pool {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Azure PostgreSQL server " +
        "(see .env.local.example), or leave it unset to run the in-memory demo.",
    );
  }

  // Parsed by hand rather than handed to pg as a `connectionString`.
  //
  // pg's ConnectionParameters does `Object.assign({}, config, parse(connectionString))`,
  // so anything the connection string implies WINS over the explicit config
  // object — including `sslmode`. A stray `?sslmode=require` copied from a psql
  // invocation would therefore quietly override the TLS settings below. Passing
  // discrete fields removes that whole class of surprise.
  const url = new URL(raw);

  // Verify the certificate. The firewall is deliberately open (Vercel has no
  // static egress IPs on this plan), so TLS *verification* — not just TLS — is
  // what stands between the app and an impersonated server. `PGSSL_STRICT=0` is
  // an escape hatch for a broken local trust store; never set it in production.
  const strict = process.env.PGSSL_STRICT !== "0";
  const ca = process.env.PGSSL_CA?.trim();

  const p = new Pool({
    host: url.hostname,
    port: Number(url.port || 5432),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, "") || "postgres",
    ssl: {
      rejectUnauthorized: strict,
      // Azure fronts Flexible Server with a DigiCert Global Root G2 chain, which
      // is in Node's bundled trust store. `PGSSL_CA` exists only for the case
      // where a rotation lands on a root that a given Node build does not carry.
      ...(ca ? { ca } : {}),
      servername: url.hostname,
    },
    max: 2,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // Belt and braces against G-5: the server-side
    // idle_in_transaction_session_timeout is 30s, this is the client half.
    statement_timeout: 15_000,
  });

  // A pooled connection idling across a Fluid Compute suspend would be counted
  // by the server long after the instance stopped using it. This lets the
  // platform drain the pool before suspending.
  attachDatabasePool(p);

  p.on("error", (err) => {
    // An idle client erroring out is not tied to any request, so it would
    // otherwise become an unhandled rejection and take the instance down.
    console.error("pg pool: idle client error", err.message);
  });

  return p;
}

/** The process-wide pool, built on first use. */
export function getPool(): Pool {
  if (!pool) pool = buildPool();
  return pool;
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
 *    concurrent statements a dashboard render fires. Queuing them against
 *    `max: 2` is the correct shape on 35 usable connections.
 *
 * The `finally` release is load-bearing (G-5). A transaction left open pins one
 * of those 35 connections until the server's 30s idle timeout reaps it, and the
 * symptom is a slow, cumulative failure that looks like nothing until the app
 * stops answering.
 */
export async function withUser<T>(
  uid: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (!UUID_RE.test(uid)) {
    // Never reachable from a verified session token, but an invalid uuid here
    // would surface as a confusing 22P02 from deep inside a policy check.
    throw new Error("Invalid user id.");
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("select set_config('app.user_id', $1, true)", [uid]);
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
 * in `03_auth.sql` — with the GUC unset, `app.uid()` is NULL and every ordinary
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
