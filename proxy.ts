import { NextResponse, type NextRequest } from "next/server";
import {
  ID_COOKIE,
  REFRESH_COOKIE,
  clearSessionCookie,
  setSessionCookies,
  shouldRefresh,
  verifySession,
} from "./lib/session";

// Proxy (Next.js 16's renamed Middleware). Runs before every page request: it
// verifies the Cognito ID token and gates access - signed-out visitors are sent
// to /login, signed-in visitors are kept out of the auth pages.
//
// WHAT IT MAY IMPORT, AND WHY THAT RULE CHANGED SHAPE.
//
// The rule used to be "lib/session.ts and nothing else from the auth stack",
// and the reason was `pg` and `bcryptjs`: the proxy fires on every route
// including prefetches, and a database round trip per invocation would exhaust
// the connection pool. That reason is unchanged and stronger now - a held
// connection also stops Aurora auto-pausing, so a pool here would cost money
// around the clock rather than merely connections.
//
// It now also imports `refresh` from lib/cognito.ts, which is a network call.
// That is a deliberate exception with a bounded cost: an ID token lives an hour,
// so this fires at most once per hour per session, not once per request. Nothing
// that touches the database may follow it in.
//
// This is still an optimistic pre-filter. Per Next's own guidance, a proxy
// matcher that excludes a path also skips Server Function calls on that path, so
// the ~55 `requireUser()` calls in `lib/actions.ts` remain the actual
// enforcement boundary. Nothing here is a substitute for those.

/**
 * Header CloudFront injects on every origin request. Must match
 * ORIGIN_SECRET_HEADER in aws/infra/lib/config.ts - the value is set in one
 * place (the web stack sends it to the CDN and to this function's environment
 * from the same variable), but the header NAME is written in both files.
 */
const ORIGIN_SECRET_HEADER = "x-taskbuddy-origin";

/**
 * Length-independent comparison, so the number of matching leading bytes is not
 * readable from response timing. `crypto.timingSafeEqual` is not used because it
 * throws on length mismatch and is not available in every runtime the proxy can
 * be compiled for.
 */
function secretMatches(got: string | null, expected: string): boolean {
  if (got === null) return false;
  let diff = got.length ^ expected.length;
  for (let i = 0; i < got.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i % expected.length);
  }
  return diff === 0;
}

/**
 * Rejects anything that did not come through CloudFront.
 *
 * The Lambda function URL is `authType: NONE` - a public HTTPS endpoint - so
 * this header is what keeps direct hits on the origin out. It is deliberately
 * the FIRST thing in the proxy, ahead of even the demo-mode check: this is a
 * network boundary, and it should not be possible to skip it by setting an
 * application flag.
 *
 * When ORIGIN_SECRET is unset the check is skipped entirely, which is what
 * `pnpm dev` and the offline harness rely on. That is safe in the way the
 * demo-mode comment below describes it is NOT: the deployed stack refuses to
 * synthesise without TASKBUDDY_ORIGIN_SECRET, so "unset" cannot happen in an
 * environment that is actually behind CloudFront - it can only happen on a
 * machine where there is no CloudFront to be behind.
 */
function cameThroughCloudFront(request: NextRequest): boolean {
  const expected = process.env.ORIGIN_SECRET;
  if (!expected) return true;
  return secretMatches(request.headers.get(ORIGIN_SECRET_HEADER), expected);
}

/** Paths reachable without a session. */
const PUBLIC_PATHS = ["/login", "/signup"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Before anything else. See cameThroughCloudFront.
  //
  // 404 rather than 403: a 403 confirms to a scanner that it found the origin
  // and that a header is what is missing. A 404 says only that there is nothing
  // here, which is also what CloudFront's own error page would suggest.
  if (!cameThroughCloudFront(request)) {
    return new NextResponse(null, { status: 404 }) as NextResponse;
  }

  // Offline demo mode has no accounts at all, so there is nothing to gate.
  //
  // This has to be an explicit opt-in. An earlier version inferred it from
  // missing env vars - "nothing configured, don't gate anything" - which meant
  // one absent variable in the deployment would silently make the entire app
  // public. An insecure state must be asked for, never fallen into.
  if (process.env.TASKBUDDY_DEMO === "1") {
    return NextResponse.next({ request });
  }

  let claims = await verifySession(request.cookies.get(ID_COOKIE)?.value);

  // Expired ID token but a live refresh token: renew rather than sign out.
  //
  // Done here, in the proxy, because this is the only place in the request
  // lifecycle that can both read the old cookie and write a new one - a Server
  // Component cannot set cookies, so a refresh attempted later has nowhere to
  // put its result.
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let renewed: { idToken: string; refreshToken: string | null } | null = null;

  if (refreshToken && (!claims || shouldRefresh(claims.exp))) {
    // The Cognito subject is needed to compute SECRET_HASH on the refresh flow.
    // When the ID token is already unverifiable we cannot read it, so an
    // expired-and-unreadable token ends the session rather than guessing.
    const priorSub = claims?.cognitoSub;
    if (priorSub) {
      const { refresh } = await import("./lib/cognito");
      const tokens = await refresh(refreshToken, priorSub);
      if (tokens) {
        renewed = tokens;
        claims = await verifySession(tokens.idToken);
      }
    }
  }

  if (!claims) {
    if (isPublic(pathname)) return NextResponse.next({ request });
    const res = NextResponse.redirect(new URL("/login", request.url));
    // Expired or tampered token: clear it on the way out, so the browser stops
    // re-sending a cookie that can never work again. `clearSessionCookie`, not
    // `res.cookies.delete` - see lib/session.ts for why delete() is broken for
    // `__Host-` cookies.
    clearSessionCookie(res.cookies);
    return res;
  }

  if (isPublic(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  // Rewriting the request cookie as well as the response one, so that the very
  // request that triggered the refresh already sees the new token. Without
  // this, `getUser()` downstream would read the stale cookie off `request` and
  // redirect to /login on the one request in an hour that renewed.
  if (renewed) request.cookies.set(ID_COOKIE, renewed.idToken);

  const response = NextResponse.next({ request });
  if (renewed) setSessionCookies(response.cookies, renewed);
  return response;
}

export const config = {
  // Run on every route except static assets, image optimisation, and the
  // adapter's readiness probe.
  //
  // `/api/health` MUST be excluded. The Lambda Web Adapter polls it before
  // marking the sandbox ready, and a gated probe would answer 307 to /login
  // forever - the adapter would never report ready, and every cold start would
  // 502 with nothing in the application logs.
  matcher: [
    "/((?!api/health|_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
