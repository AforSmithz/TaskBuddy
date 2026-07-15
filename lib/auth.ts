import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SESSION_COOKIE, verifySession } from "./session";

// Authentication helpers - the single place the rest of the app asks
// "who is the current user?". `getUser` is memoised per render pass, so repeated
// calls within one request verify the token once.
//
// This reads the signed session cookie and nothing else: no database round trip
// on any request. Email and name ride in the verified token deliberately, because
// `app/(app)/layout.tsx` renders both on every page and fetching them would put
// a query in front of every render.
//
// The trade-off that buys is stated plainly: sessions are stateless, so a token
// stays valid until it expires even if the user row is deleted. With two users
// that is fine, and the break-glass is rotating SESSION_SECRET, which invalidates
// every session at once.

export interface SessionUser {
  id: string;
  email: string | null;
  fullName: string | null;
}

/** The authenticated user for this request, or null when signed out. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const claims = await verifySession(store.get(SESSION_COOKIE)?.value);
  if (!claims) return null;
  return { id: claims.sub, email: claims.email, fullName: claims.name };
});

/** Like {@link getUser} but redirects to /login when there is no session. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** Display name for a user - the name chosen at signup, falling back to email. */
export function displayName(user: SessionUser): string {
  return (user.fullName && user.fullName.trim()) || user.email || "Account";
}
