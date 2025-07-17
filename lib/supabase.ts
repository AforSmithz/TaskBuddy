import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";

// Request-scoped Supabase client. It is bound to the current user's session
// cookies and uses the publishable (anon) key, so every query runs *as the
// logged-in user* and Row Level Security scopes the data automatically.
// Never imported into a Client Component — `server-only` makes that a build
// error.

function env(): { url: string; key: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "Missing Supabase env vars. Set NEXT_PUBLIC_SUPABASE_URL and " +
        "NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local (see .env.local.example).",
    );
  }
  return { url, key };
}

/**
 * Build a Supabase client for the current request. Safe to call from Server
 * Components and Server Actions; the proxy keeps the session cookie fresh.
 */
export async function getRequestClient() {
  const { url, key } = env();
  const cookieStore = await cookies();

  return createServerClient(url, key, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where the cookie store is
          // read-only. The proxy refreshes the session cookie on every
          // request, so this can be safely ignored.
        }
      },
    },
  });
}
