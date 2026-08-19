"use server";

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { EmailTakenError, createUser, normalizeEmail } from "@/lib/db/auth-queries";
import { AuthFailed, createAccount, globalSignOut, isAuthConfigured, signIn } from "@/lib/cognito";
import { isRateLimited } from "@/lib/rate-limit";
import { clearSessionCookie, setSessionCookies, ID_COOKIE, verifySession } from "@/lib/session";
import { isDbConfigured } from "@/lib/db/pool";
import type { AuthState } from "@/lib/types";

// Server Actions backing login, signup and logout.
//
// Exports and signatures are unchanged from the Azure versions, so auth-form.tsx and the logout
// form keep working untouched. That's the point of this shape: Cognito's hosted UI would have
// replaced these pages with a redirect flow and discarded the app's own login screen for no gain
// that matters at two users. Cognito is the credential store; the interface stays ours.
//
// CSRF is already handled and needs no token here - Next 16 gives Server Actions POST-only
// invocation, an Origin-vs-Host comparison that aborts on mismatch, and SameSite=Lax keeping the
// cookie off cross-site POSTs. Don't add allowedOrigins; that option only WIDENS the accepted set.

function readCredentials(formData: FormData) {
  return {
    name: String(formData.get("name") ?? "").trim(),
    email: String(formData.get("email") ?? "").trim(),
    password: String(formData.get("password") ?? ""),
    code: String(formData.get("code") ?? ""),
  };
}

/** Constant-time string compare that tolerates differing lengths. */
function secretsMatch(a: string, b: string): boolean {
  // timingSafeEqual throws on length mismatch, which would itself leak the
  // length. Digesting first makes both sides exactly 32 bytes.
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
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
  if (!isAuthConfigured()) {
    return { error: "No user pool is configured on this deployment." };
  }

  // Still in front of the call, but guarding a different cost now. On Azure this existed because
  // loginAction ran a deliberate cost-12 bcrypt on every request including misses, burning ~290ms
  // of billable CPU per hit. Cognito's preventUserExistenceErrors provides that
  // indistinguishability itself, so the bcrypt and the CPU sink are gone.
  //
  // What's left worth throttling is AdminInitiateAuth: a billed network round trip per attempt,
  // and Cognito's own throttles are account-wide, so an unthrottled spray against one account
  // would degrade sign-in for the other. Ten a minute is far above any human.
  if (await isRateLimited("login", 10)) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  try {
    const tokens = await signIn(normalizeEmail(email), password);
    setSessionCookies(await cookies(), tokens);
  } catch (err) {
    if (err instanceof AuthFailed) {
      // Never distinguish unknown-email from wrong-password.
      return { error: "Incorrect email or password." };
    }
    console.error("login failed:", err);
    return { error: "Could not sign you in. Please try again." };
  }

   // OUTSIDE every try/catch: redirect() works by throwing, so a catch block
  // above would swallow it and the user would sit on the login page having
  // successfully logged in. This is the single most likely way this file breaks.
  redirect("/");
}

/** Register a new account and sign in. */
export async function signupAction(
  _prev: AuthState,
  formData: FormData,
): Promise<AuthState> {
  const { name, email, password, code } = readCredentials(formData);
  if (!name || !email || !password) {
    return { error: "Fill in your name, email and password." };
  }
  if (password.length < 8) {
    return { error: "Password must be at least 8 characters." };
  }
  if (!isDbConfigured() || !isAuthConfigured()) {
    return { error: "This deployment is not configured for signups." };
  }

  // Ahead of the invite-code check, not after it, so that GUESSING the code is
  // throttled too. `secretsMatch` is constant-time and leaks nothing, but
  // nothing else here makes an attacker pay for attempts.
  if (await isRateLimited("signup", 5)) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  // The user pool has self sign-up disabled, so this code is the only gate on
  // account creation. Without it, `AdminCreateUser` behind an unauthenticated
  // Server Action is an open account-creation endpoint.
  const expected = process.env.SIGNUP_CODE;
  if (!expected) {
    return { error: "Signups are closed on this deployment." };
  }
  if (!code || !secretsMatch(code, expected)) {
    return { error: "That invite code is not valid." };
  }

  // Postgres first, Cognito second, and the order is load-bearing. appUid is a foreign key target
  // for 24 tables, so creating the Cognito user first opens a window where a valid token carries
  // a custom:app_uid no row matches, and every query fails a constraint rather than an auth check.
  // The reverse failure - a users row with no Cognito account - is harmless and self-correcting:
  // nobody can sign in as it, and retrying signup with the same email hits EmailTakenError.
  const appUid = randomUUID();
  try {
    await createUser({ id: appUid, email, fullName: name });
    const tokens = await createAccount({
      email: normalizeEmail(email),
      password,
      fullName: name,
      appUid,
    });
    setSessionCookies(await cookies(), tokens);
  } catch (err) {
    if (err instanceof EmailTakenError) return { error: err.message };
    console.error("signup failed:", err);
    return { error: "Could not create your account. Please try again." };
  }

  // Outside the try/catch, for the same reason as in loginAction.
  redirect("/");
}

/** Sign the current user out and return to the login screen. */
export async function logoutAction(): Promise<void> {
  const store = await cookies();

  // Revoke server-side BEFORE clearing, so a failure to clear the cookie is not
  // also a failure to end the session. This is the half the self-signed JWT
  // could not do: the refresh token is dead the moment this returns, so even a
  // surviving cookie expires within the hour instead of lasting a week.
  const claims = await verifySession(store.get(ID_COOKIE)?.value);
  if (claims?.email) await globalSignOut(claims.email);

   // `clearSessionCookie`, never `store.delete()`. Next's delete() emits a
  // Set-Cookie with neither Secure nor Path, which a browser must reject for a
  // `__Host-` prefixed cookie - so logout would be a silent no-op in production
  // and work fine in dev. See lib/session.ts.
  clearSessionCookie(store);
  revalidatePath("/", "layout");
  redirect("/login");
}
