"use server";

import { createHash, randomUUID, timingSafeEqual } from "crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  EmailTakenError,
  createUser,
  findUserForLogin,
  normalizeEmail,
  touchLastLogin,
  upgradePasswordHash,
} from "./db/auth-queries";
import { DUMMY_HASH, hash, needsRehash, verify } from "./password";
import { isRateLimited } from "./rate-limit";
import {
  COOKIE_OPTS,
  SESSION_COOKIE,
  clearSessionCookie,
  signSession,
} from "./session";
import { isDbConfigured } from "./db/pool";
import type { AuthState } from "./types";

// Server Actions backing the login, signup and logout flows.
//
// Exports and signatures are unchanged from the Supabase versions, so
// `components/auth/auth-form.tsx` (useActionState) and the logout <form> in
// `components/layout/sidebar.tsx` keep working as they are.
//
// CSRF is already handled and needs no token here. Next 16 gives Server Actions
// three layers: POST-only invocation, an Origin-vs-Host comparison that aborts on
// mismatch, and `SameSite=Lax` keeping the cookie off cross-site POSTs. Do not
// add `experimental.serverActions.allowedOrigins` — that option only *widens* the
// accepted origin set.

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

async function issueSession(user: {
  id: string;
  email: string | null;
  name: string | null;
}): Promise<void> {
  const token = await signSession(user);
  (await cookies()).set(SESSION_COOKIE, token, COOKIE_OPTS);
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
  if (!isDbConfigured()) {
    return { error: "No database is configured on this deployment." };
  }

  // BEFORE the database lookup and the bcrypt below, which is the entire point.
  // Every request through here costs a deliberate cost-12 hash (~290ms) whether
  // or not the account exists; this is what stops that being a free CPU sink.
  // Ten attempts a minute is far above any human and far below anything worth
  // paying for. See lib/rate-limit.ts for what this does and does not cover.
  if (await isRateLimited("login", 10)) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  try {
    const user = await findUserForLogin(email);

    // Always run a bcrypt comparison, even when there is no such account.
    // Returning early on a miss would make an unknown email answer in ~1ms and a
    // known one in ~300ms, which is a free account-enumeration oracle.
    const ok = await verify(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) {
      // Never distinguish unknown-email from wrong-password.
      return { error: "Incorrect email or password." };
    }

    await issueSession({
      id: user.id,
      email: user.email,
      name: user.full_name,
    });

    // Housekeeping, deliberately swallowed. A valid login must never fail
    // because a bookkeeping write did.
    try {
      await touchLastLogin(user.id);
      if (needsRehash(user.password_hash)) {
        // One of the carried-over accounts is bcrypt cost 6. This is the only
        // moment the plaintext exists to re-hash it at cost 12.
        await upgradePasswordHash(user.id, await hash(password));
      }
    } catch (err) {
      console.error("login housekeeping failed (ignored):", err);
    }
  } catch (err) {
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
  if (!isDbConfigured()) {
    return { error: "No database is configured on this deployment." };
  }

  // Ahead of the invite-code check, not after it, so that GUESSING the code is
  // throttled too. `secretsMatch` is constant-time and leaks nothing, but
  // nothing else here makes an attacker pay for attempts. Five a minute; real
  // signups on this deployment are rare enough that a stricter limit than
  // login costs nobody anything.
  if (await isRateLimited("signup", 5)) {
    return { error: "Too many attempts. Wait a minute and try again." };
  }

  // There is no email provider and no verification step, so signup is
  // auto-confirm. Without this gate an internet-facing /signup is an open
  // account-creation endpoint pointed at a 1-vCore burstable database.
  const expected = process.env.SIGNUP_CODE;
  if (!expected) {
    return { error: "Signups are closed on this deployment." };
  }
  if (!code || !secretsMatch(code, expected)) {
    return { error: "That invite code is not valid." };
  }

  const id = randomUUID();
  try {
    await createUser({
      id,
      email,
      passwordHash: await hash(password),
      fullName: name,
    });
    await issueSession({ id, email: normalizeEmail(email), name });
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
  // `clearSessionCookie`, never `cookieStore.delete()`. Next's delete() emits a
  // Set-Cookie with neither Secure nor Path, which a browser must reject for a
  // `__Host-`prefixed cookie — so logout would be a silent no-op in production
  // and work fine in dev. See lib/session.ts.
  clearSessionCookie(await cookies());
  revalidatePath("/", "layout");
  redirect("/login");
}
