import "server-only";
import { compare, getRounds, hash as bcryptHash } from "bcryptjs";

// Password hashing. bcryptjs, async API only.
//
// ASYNC ONLY, AND THIS IS NOT A STYLE PREFERENCE. Under Fluid Compute a single
// function instance serves concurrent invocations, so a synchronous cost-12 hash
// blocks the event loop for ~0.7-1.0s - for every co-tenant request, not just
// the one signing in. `hashSync`/`compareSync` are right there in the same
// module and read as the simpler call; they are not.
//
// Not `@node-rs/bcrypt`: ~200-300ms saved on a handful of logins a day does not
// justify a native binary in the deployment.

/** Cost for newly written hashes. */
const COST = 12;

/**
 * A real cost-12 bcrypt hash of 32 discarded random bytes, compared against on
 * the unknown-email path so that a miss costs the same wall-clock as a hit
 * (~290ms here). Without it, response time tells an attacker which emails have
 * accounts. Nothing can match it, because the plaintext was never kept.
 */
export const DUMMY_HASH =
  "$2b$12$cDssB4XHVJKQHXrCwb3kyueYWPSDAtSJGc6Ud7kpDhKt7xtrG6qni";

/**
 * Check a password against a stored hash.
 *
 * The cost is encoded in the modular-crypt prefix, so the two hashes carried
 * over from Supabase - `$2a$10$` and `$2a$06$` - both verify through this one
 * call with no branching. bcryptjs accepts `$2a$`, `$2b$` and `$2y$`; the `$2a$`
 * that Supabase's Go implementation produced is spec-correct.
 */
export async function verify(plain: string, hashed: string): Promise<boolean> {
  return compare(plain, hashed);
}

/** Hash a new password at {@link COST}. */
export async function hash(plain: string): Promise<string> {
  return bcryptHash(plain, COST);
}

/**
 * True when a stored hash is weaker than what we write today, and should be
 * transparently upgraded on the next successful login.
 *
 * One of the two carried-over accounts is at cost 6 - sixteen times weaker than
 * cost 10 and 64x weaker than what we write now. That is the reason this exists.
 */
export function needsRehash(hashed: string): boolean {
  try {
    return getRounds(hashed) < COST;
  } catch {
    // Unparseable prefix: not a hash we recognise, so don't claim it's fine.
    return true;
  }
}
