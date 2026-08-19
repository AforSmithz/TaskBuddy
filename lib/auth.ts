import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ID_COOKIE, verifySession } from "./session";

// Authentication helpers - the single place the rest of the app asks
// "who is the current user?". `getUser` is memoised per render pass, so repeated
// calls within one request verify the token once.
//
// This reads the verified Cognito ID token and nothing else: no database round
// trip on any request. Email and name ride in the token deliberately, because
// `app/(app)/layout.tsx` renders both on every page and fetching them would put
// a query in front of every render.
//
// `claims.sub` is `custom:app_uid` - the Postgres `users.id`, not the Cognito
// subject. lib/session.ts does that mapping so nothing downstream has to know
// there are two identifiers; every RLS policy keeps resolving through the same
// uuid it always did.
//
// The old note here read: "sessions are stateless, so a token stays valid until
// it expires even if the user row is deleted... the break-glass is rotating
// SESSION_SECRET, which invalidates every session at once." That is no longer
// true, and the improvement is worth naming: an ID token still lives its full
// hour, but the refresh token behind it is revocable per user, so logout and
// account deletion are now real rather than cosmetic. See globalSignOut.

export interface SessionUser {
  id: string;
  email: string | null;
  fullName: string | null;
}

/** The authenticated user for this request, or null when signed out. */
export const getUser = cache(async (): Promise<SessionUser | null> => {
  const store = await cookies();
  const claims = await verifySession(store.get(ID_COOKIE)?.value);
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
