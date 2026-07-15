import { SignJWT, jwtVerify } from "jose";

// The session token, and the cookie it rides in.
//
// This is the ONLY auth module `proxy.ts` is allowed to import. No `pg`, no
// `bcryptjs`, nothing that opens a connection: the proxy runs on every route
// including prefetches, and a database round trip per invocation would eat the
// ~35 usable connections the Burstable tier gives us. The proxy is an optimistic
// cookie check; the ~55 `requireUser()` calls in `lib/actions.ts` are the real
// enforcement boundary.

const ISSUER = "taskbuddy";
const AUDIENCE = "taskbuddy";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days, kept equal to the JWT exp
const ROTATE_AFTER_SECONDS = 60 * 60 * 24; // re-issue once a token is a day old

export interface SessionClaims {
  /** User uuid. */
  sub: string;
  email: string | null;
  name: string | null;
  /** Issued-at, seconds since epoch. */
  iat: number;
}

/** Thrown when SESSION_SECRET is missing or too short. Never caught. */
export class SessionSecretError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionSecretError";
  }
}

// Asserted at module load, deliberately.
//
// An unset SESSION_SECRET encodes to the literal string "undefined" - 9 bytes.
// jose rejects a key that short, `verifySession` would swallow the rejection as
// "bad token", and the result is an app where every request silently redirects
// to /login while `loginAction` 500s with nothing in the logs pointing at the
// cause. Fail-closed but undiagnosable. Far better to refuse to build.
//
// NOTE: the HMAC keys off the base64 *text* of the secret, not the 32 decoded
// bytes. Do not "fix" that later by base64-decoding first - it would invalidate
// every live session at once.
function readSecret(): Uint8Array {
  const raw = process.env.SESSION_SECRET ?? "";
  const encoded = new TextEncoder().encode(raw);
  if (encoded.length < 32) {
    throw new SessionSecretError(
      `SESSION_SECRET must be at least 32 bytes (got ${encoded.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return encoded;
}

// Demo mode has no authentication at all, so it is the one case where a missing
// secret is legitimate rather than a misconfiguration.
const SECRET: Uint8Array | null =
  process.env.TASKBUDDY_DEMO === "1" ? null : readSecret();

function secret(): Uint8Array {
  if (!SECRET) {
    throw new SessionSecretError(
      "No SESSION_SECRET: this process is running in TASKBUDDY_DEMO mode.",
    );
  }
  return SECRET;
}

// `__Host-` is the strongest cookie prefix: browsers only accept it with Secure,
// Path=/ and no Domain, which makes it impossible to set from a subdomain. Dev
// drops the prefix because Safari refuses Secure cookies over http://localhost.
export const SESSION_COOKIE =
  process.env.NODE_ENV === "production" ? "__Host-tb_session" : "tb_session";

export const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // `lax`, not `strict`: strict drops the cookie on the top-level GET that
  // follows an external link, so the user would land on /login every time they
  // arrived from outside the app. Lax still blocks cross-site POST, which is
  // what carries the CSRF risk for Server Actions.
  sameSite: "lax",
  path: "/",
  // `domain` deliberately omitted, so the cookie is host-only and a Vercel
  // preview deployment cannot ride a production session.
  //
  // `maxAge` and not `expires`: immune to client clock skew.
  maxAge: MAX_AGE_SECONDS,
} as const;

/** Mint a signed session token for `user`. */
export async function signSession(user: {
  id: string;
  email: string | null;
  name: string | null;
}): Promise<string> {
  return new SignJWT({ email: user.email, name: user.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
}

/**
 * Verify a token and return its claims, or null if it is missing, expired,
 * tampered with, or signed by something else.
 *
 * `algorithms` is pinned, and that pin is the thing doing the security work: it
 * is what rejects `alg: none` and HS/RS confusion attacks.
 */
export async function verifySession(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload.sub !== "string" || typeof payload.iat !== "number") {
      return null;
    }
    return {
      sub: payload.sub,
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      iat: payload.iat,
    };
  } catch (err) {
    // A misconfigured secret is not a bad token and must not look like one.
    if (err instanceof SessionSecretError) throw err;
    return null;
  }
}

/** True once the token is old enough to be worth re-issuing. */
export function shouldRotate(iat: number): boolean {
  return Date.now() / 1000 - iat > ROTATE_AFTER_SECONDS;
}

/**
 * Clear the session cookie. Use this everywhere; never `store.delete(name)`.
 *
 * Next's `delete()` compiles to `set({ ...options, value: "", expires: new Date(0) })`
 * with **no options passed**, and its cookie serialiser emits `Secure` only when
 * the cookie object says so. Next has no `__Host-` awareness at all. So
 * `delete()` on a `__Host-` cookie emits a Set-Cookie with neither Secure nor
 * Path - which browsers are required to reject. The cookie survives, the
 * stateless JWT is still valid, and the proxy bounces the user straight back in.
 *
 * That failure only appears where `secure: true`, i.e. production. Dev works
 * fine, because dev uses the unprefixed name. Setting an empty value with
 * `Max-Age=0` and the full option set serialises correctly in both.
 */
export function clearSessionCookie(store: {
  set: (name: string, value: string, options: Record<string, unknown>) => void;
}): void {
  store.set(SESSION_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
}
