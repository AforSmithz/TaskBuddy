"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getRequestClient } from "./supabase";
import type { AuthState } from "./types";

// Server Actions backing the login, signup and logout flows.

function readCredentials(formData: FormData) {
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
  };
}

/** Sign an existing user in with email + password. */
export async function loginAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const { email, password } = readCredentials(formData);
  if (!email || !password) {
    return { error: "Enter your email and password." };
  }

  const supabase = await getRequestClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  // redirect() throws internally, so it runs after the try-free happy path.
  redirect("/");
}

/** Register a new account, then sign in (or prompt for email confirmation). */
export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const { name, email, password } = readCredentials(formData);
  if (!name || !email || !password) {
    return { error: "Fill in your name, email and password." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }

  const supabase = await getRequestClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: name } },
  });
  if (error) return { error: error.message };

  // When the project requires email confirmation, no session is issued yet.
  if (!data.session) {
    return {
      error: null,
      notice:
        "Account created. Check your email to confirm it, then sign in.",
    };
  }

  redirect("/");
}

/** Sign the current user out and return to the login screen. */
export async function logoutAction(): Promise<void> {
  const supabase = await getRequestClient();
  await supabase.auth.signOut();
  revalidatePath("/", "layout");
  redirect("/login");
}
