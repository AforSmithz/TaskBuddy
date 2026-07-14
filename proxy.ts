import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_OPTS,
  SESSION_COOKIE,
  clearSessionCookie,
  shouldRotate,
  signSession,
  verifySession,
} from "./lib/session";

// Proxy (Next.js 16's renamed Middleware). Runs before every page request: it
// verifies the session cookie and gates access — signed-out visitors are sent to
// /login, signed-in visitors are kept out of the auth pages.
//
// IT IMPORTS lib/session.ts AND NOTHING ELSE FROM THE AUTH STACK. No `pg`, no
// `bcryptjs`. In 16.2.6 the proxy runs on Node.js always (the `runtime` option is
// not configurable here and setting it throws), so those would not be a *build*
// error — they would be a runtime disaster. The proxy fires on every route
// including prefetches, and a database round trip per invocation would burn
// through the ~35 usable connections the Burstable tier allows.
//
// This is an optimistic pre-filter only. Per Next's own guidance, a proxy matcher
// that excludes a path also skips Server Function calls on that path, so the ~55
// `requireUser()` calls in `lib/actions.ts` remain the actual enforcement
// boundary. Nothing here is a substitute for those.

/** Paths reachable without a session. */
const PUBLIC_PATHS = ["/login", "/signup"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;

  // Offline demo mode has no accounts at all, so there is nothing to gate.
  //
  // This has to be an explicit opt-in. The previous version inferred it from
  // missing env vars — "no Supabase configured, don't gate anything" — which
  // meant one absent variable in Vercel would silently make the entire app
  // public. An insecure state must be asked for, never fallen into.
  if (process.env.TASKBUDDY_DEMO === "1") {
    return NextResponse.next({ request });
  }

  const claims = await verifySession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );

  if (!claims) {
    if (isPublic(pathname)) return NextResponse.next({ request });
    const res = NextResponse.redirect(new URL("/login", request.url));
    // Expired or tampered token: clear it on the way out, so the browser stops
    // re-sending a cookie that can never work again. `clearSessionCookie`, not
    // `res.cookies.delete` — see lib/session.ts for why delete() is broken for
    // `__Host-` cookies.
    clearSessionCookie(res.cookies);
    return res;
  }

  if (isPublic(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  const response = NextResponse.next({ request });

  // Sliding expiry, on GET only.
  //
  // Server Actions POST to the route they are invoked from, so the proxy runs on
  // them too. `logoutAction` POSTs to `/`, where the claims are still valid and
  // the path is not public — so an unguarded rotation would attach a fresh
  // 7-day Set-Cookie to the very response that carries the logout clear, with
  // unspecified ordering. That can resurrect the session the user just ended.
  // Restricting to GET also keeps Set-Cookie off prefetch and cacheable traffic.
  if (request.method === "GET" && shouldRotate(claims.iat)) {
    const token = await signSession({
      id: claims.sub,
      email: claims.email,
      name: claims.name,
    });
    response.cookies.set(SESSION_COOKIE, token, COOKIE_OPTS);
  }

  return response;
}

export const config = {
  // Run on every route except static assets and image optimisation.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
