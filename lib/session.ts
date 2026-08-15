import { CognitoJwtVerifier } from "aws-jwt-verify";

// The session: a verified Cognito ID token, and the cookies it rides in.
//
// This is the ONLY auth module `proxy.ts` is allowed to import. No `pg`, no
// database client: the proxy runs on every route including prefetches, and a
// connection per invocation would hold the Aurora cluster awake around the
// clock as well as burning connections.
//
// ===========================================================================
// WHAT REPLACED WHAT
// ===========================================================================
// The old session was a JWT this app signed itself with `jose` and a 32-byte
// SESSION_SECRET. That worked, and it had two properties worth being explicit
// about losing and gaining:
//
//   GONE: SESSION_SECRET. There is no signing key to store, rotate, or leak.
//   Verification is against Cognito's public JWKS, fetched once and cached.
//
//   GAINED: revocation. The old design noted that a token "stays valid until it
//   expires even if the user row is deleted", and that the only break-glass was
//   rotating the secret - which signs out every user at once. Cognito refresh
//   tokens are revocable per user; see globalSignOut in lib/cognito.ts.
//
//   UNCHANGED, AND THE POINT: no database round trip to answer "who is this?".
//   The user id rides in the token as `custom:app_uid`, exactly as it used to
//   ride in `sub`, so `app/(app)/layout.tsx` still renders email and name with
//   no query behind them.

const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days, matching the refresh token

/** The custom attribute carrying `users.id`. */
const APP_UID_CLAIM = "custom:app_uid";

export interface SessionClaims {
  /** The Postgres `users.id` uuid. Every RLS policy resolves through this. */
  sub: string;
  /** The Cognito subject. Needed to refresh; never used for authorisation. */
  cognitoSub: string;
  email: string | null;
  name: string | null;
  /** Expiry, seconds since epoch. */
  exp: number;
}

// `__Host-` is the strongest cookie prefix: browsers only accept it with
// Secure, Path=/ and no Domain, which makes it impossible to set from a
// subdomain. Dev drops the prefix because Safari refuses Secure cookies over
// http://localhost.
const PREFIX = process.env.NODE_ENV === "production" ? "__Host-" : "";

/** The verified identity. Read on every request. */
export const ID_COOKIE = `${PREFIX}tb_id`;
/** The long-lived credential. Only ever sent to Cognito. */
export const REFRESH_COOKIE = `${PREFIX}tb_rt`;

/**
 * Two cookies rather than one blob, and not for tidiness.
 *
 * A Cognito ID token is 1-2 KB and a refresh token is another 1-2 KB. Browsers
 * cap a single cookie at about 4 KB, so a combined cookie would work for a user
 * with a short email and silently fail to be stored for one with a long name -
 * a bug that appears per account and never in testing.
 */
export const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  // `lax`, not `strict`: strict drops the cookie on the top-level GET that
  // follows an external link, so the user would land on /login every time they
  // arrived from outside the app. Lax still blocks cross-site POST, which is
  // what carries the CSRF risk for Server Actions.
  sameSite: "lax",
  path: "/",
  // `domain` deliberately omitted, so the cookie is host-only.
  // `maxAge` and not `expires`: immune to client clock skew.
  maxAge: MAX_AGE_SECONDS,
} as const;

// MODULE SCOPE. The verifier caches the pool's JWKS after its first fetch, so
// every later verification is a local signature check with no network call.
// Building it per request would fetch the key set per request and put an
// outbound HTTP call in front of every page render.
//
// Keyed on the pool + client so a late-binding environment variable cannot be
// cached as a miss - the same reasoning the Azure credential helper used.
let cached:
  | { key: string; verifier: ReturnType<typeof CognitoJwtVerifier.create> }
  | null = null;

function verifier() {
  const userPoolId = process.env.COGNITO_USER_POOL_ID;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!userPoolId || !clientId) return null;

  const key = `${userPoolId}:${clientId}`;
  if (cached?.key === key) return cached.verifier;

  const v = CognitoJwtVerifier.create({
    userPoolId,
    clientId,
    // ID token, NOT access token. The access token carries no email, no name
    // and no custom attributes, so an app that verified it would have to query
    // the database on every request to learn who the user is - losing the one
    // property this design exists to keep.
    tokenUse: "id",
  });
  cached = { key, verifier: v };
  return v;
}

/**
 * Verify an ID token and return its claims, or null if it is missing, expired,
 * tampered with, or issued by a different pool.
 *
 * The library pins the algorithm to the pool's published RS256 keys, which is
 * what rejects `alg: none` and algorithm-confusion attacks. Do not replace this
 * with a manual decode: `jwt.decode` without verification is the single most
 * common way an app like this becomes trivially impersonatable.
 */
export async function verifySession(
  token: string | undefined | null,
): Promise<SessionClaims | null> {
  if (!token) return null;
  const v = verifier();
  if (!v) return null;
  try {
    const payload = await v.verify(token);
    const appUid = payload[APP_UID_CLAIM];
    // A token without the custom attribute is a real user of this pool who was
    // created outside `signupAction` - by hand in the console, say. They have
    // no `users` row, so there is nothing for RLS to scope to and admitting
    // them would produce confusing empty pages rather than an auth error.
    if (typeof appUid !== "string" || !appUid) {
      console.error(
        `Cognito user ${payload.sub} has no ${APP_UID_CLAIM}; refusing the session.`,
      );
      return null;
    }
    return {
      sub: appUid,
      cognitoSub: String(payload.sub),
      email: typeof payload.email === "string" ? payload.email : null,
      name: typeof payload.name === "string" ? payload.name : null,
      exp: typeof payload.exp === "number" ? payload.exp : 0,
    };
  } catch {
    return null;
  }
}

/**
 * True once the ID token is close enough to expiry to be worth refreshing.
 *
 * Two minutes of slack, not zero. A token that passes verification at the start
 * of a render can expire during it, and the refresh happens in the proxy before
 * any of the page's own work runs.
 */
export function shouldRefresh(exp: number): boolean {
  return exp - Date.now() / 1000 < 120;
}

interface CookieWriter {
  set: (name: string, value: string, options: Record<string, unknown>) => void;
}

/** Write both cookies from a fresh Cognito response. */
export function setSessionCookies(
  store: CookieWriter,
  tokens: { idToken: string; refreshToken: string | null },
): void {
  store.set(ID_COOKIE, tokens.idToken, COOKIE_OPTS);
  if (tokens.refreshToken) {
    store.set(REFRESH_COOKIE, tokens.refreshToken, COOKIE_OPTS);
  }
}

/**
 * Clear the session. Use this everywhere; never `store.delete(name)`.
 *
 * Next's `delete()` compiles to `set({ ...options, value: "", expires: new Date(0) })`
 * with **no options passed**, and its cookie serialiser emits `Secure` only when
 * the cookie object says so. Next has no `__Host-` awareness at all. So
 * `delete()` on a `__Host-` cookie emits a Set-Cookie with neither Secure nor
 * Path - which browsers are required to reject. The cookie survives, and the
 * proxy bounces the user straight back in.
 *
 * That failure only appears where `secure: true`, i.e. production. Dev works
 * fine, because dev uses the unprefixed name. Setting an empty value with
 * `Max-Age=0` and the full option set serialises correctly in both.
 */
export function clearSessionCookie(store: CookieWriter): void {
  store.set(ID_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
  store.set(REFRESH_COOKIE, "", { ...COOKIE_OPTS, maxAge: 0 });
}
