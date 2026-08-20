import "server-only";
import { createHmac } from "node:crypto";

// The signing half of app.uid(). The verifying half is aws/sql/06_session_mac.sql,
// and the two have to agree byte for byte - read that file's header for why this
// exists at all before changing anything here.
//
// The short version: `app.session` used to be a bare uuid that the database
// trusted, so anyone holding a connection as taskbuddy_app could set it to any
// value and read the whole database. RLS was protecting against an application
// bug, not against a stolen connection - which is the case the publicly-routable
// cluster in data-stack.ts actually needs covered. Signing the value is what
// makes it cover it.
//
// The key lives in the Lambda environment (DB_SESSION_KEY, set by web-stack.ts
// and events-stack.ts) and in app.session_key, which the app role cannot read.
// Anyone who can read this process's environment has already won by other means;
// the point is that reaching the DATABASE is no longer enough.

/** Seconds a signature stays valid.
 *
 *  Sized against two things and nothing else. Below: one transaction, which is a
 *  single statement here (lib/db/shim.ts opens one per statement) and is capped
 *  at the 15s statement_timeout anyway. Above: clock skew between the Lambda and
 *  Aurora, both on AWS time, realistically sub-second - the margin is for a bad
 *  day, not a normal one.
 *
 *  Deliberately far shorter than the 15-minute RDS IAM token. A signature that
 *  leaked through a slow-query log (log_min_duration_statement is 1000ms) is
 *  worth one user for five minutes, not one user forever. */
const TTL_SECONDS = 300;

/** 32 bytes as hex, matching `openssl rand -hex 32` and the octet_length >= 32
 *  check on app.session_key. */
const KEY_RE = /^[0-9a-fA-F]{64,}$/;

let cachedKey: Buffer | null = null;
let warnedMissing = false;

/** The signing key, or null when there isn't one.
 *
 *  Throws rather than returning null when the app is DEPLOYED (PGHOST set) and
 *  the key is missing: there is no legitimate deployed configuration without it,
 *  and falling back would restore the forgeable GUC on the one deployment shape
 *  that is reachable from the internet. Local development against a plain
 *  Postgres has no such requirement and gets null. */
export function sessionKey(): Buffer | null {
  if (cachedKey) return cachedKey;

  const raw = process.env.DB_SESSION_KEY;
  if (!raw) {
    if (process.env.PGHOST) {
      throw new Error(
        "DB_SESSION_KEY is not set but PGHOST is. app.uid() will reject every " +
          "session and the app will read as signed-out for everyone. It is set " +
          "by aws/infra/lib/web-stack.ts from TASKBUDDY_SESSION_MAC_KEY; the " +
          "same value must be seeded into app.session_key by " +
          "aws/scripts/apply-sql.sh.",
      );
    }
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn(
        "DB_SESSION_KEY unset: sessions are unsigned. Fine for local Postgres, " +
          "never for a deployment.",
      );
    }
    return null;
  }

  if (!KEY_RE.test(raw)) {
    throw new Error(
      "DB_SESSION_KEY must be at least 64 hex characters (openssl rand -hex 32). " +
        "A non-hex value would be decoded differently on each side and every " +
        "signature would fail with both halves looking correct.",
    );
  }

  cachedKey = Buffer.from(raw, "hex");
  return cachedKey;
}

/** `<uuid>.<expires>.<mac>`, the value app.uid() verifies.
 *
 *  `uid` must already be UUID-validated by the caller - withUser does it, and the
 *  result is interpolated into a simple-protocol query, so the two checks are
 *  load-bearing together. The output of this function is hex and digits only by
 *  construction, which is what keeps the rest of that string safe to interpolate. */
export function signSession(uid: string, key: Buffer): string {
  const expires = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const message = `${uid}.${expires}`;
  const mac = createHmac("sha256", key).update(message).digest("hex");
  return `${message}.${mac}`;
}
