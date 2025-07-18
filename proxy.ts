import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Proxy (Next.js 16's renamed Middleware). Runs before every page request:
// it refreshes the Supabase session cookie and gates access — signed-out
// visitors are sent to /login, signed-in visitors are kept out of the auth
// pages.

/** Paths reachable without a session. */
const PUBLIC_PATHS = ["/login", "/signup"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  // No Supabase configured → offline demo mode; don't gate anything.
  if (!url || !key) return response;

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // getUser() revalidates the token with Supabase — do not trust getSession().
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { pathname } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  if (user && isPublic(pathname)) {
    return NextResponse.redirect(new URL("/", request.url));
  }

  return response;
}

export const config = {
  // Run on every route except static assets and image optimisation.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|svg|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
