import "server-only";
import { cache } from "react";
import { redirect } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { getRequestClient } from "./supabase";

// Authentication helpers — the single place the rest of the app asks
// "who is the current user?". `getUser` is memoised per render pass so
// repeated calls within one request hit Supabase only once.

/** The authenticated user for this request, or null when signed out. */
export const getUser = cache(async (): Promise<User | null> => {
  const supabase = await getRequestClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
});

/** Like {@link getUser} but redirects to /login when there is no session. */
export async function requireUser(): Promise<User> {
  const user = await getUser();
  if (!user) redirect("/login");
  return user;
}

/** Display name for a user — the name chosen at signup, falling back to email. */
export function displayName(user: User): string {
  const name = user.user_metadata?.full_name;
  return (typeof name === "string" && name.trim()) || user.email || "Account";
}
