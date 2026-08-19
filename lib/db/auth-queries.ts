import "server-only";
import { withUser } from "@/lib/db/pool";

// The authentication path's database access. Deliberately NOT through the shim - the shim refuses
// to execute without a session, which is right for every other query and exactly wrong here,
// since obtaining a session is the point.
//
// Much smaller than it was: findUserForLogin and upgradePasswordHash are gone entirely, because
// credentials aren't the app's business any more. The bcrypt hashes still in users.password_hash
// are read exactly once per legacy account, by the Cognito USER_MIGRATION trigger - a different
// process with a different IAM role. Once both carried-over accounts have signed in,
// 05_drop_password_hash.sql removes the column.

/** Normalise an email the same way everywhere: this is the lookup key. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class EmailTakenError extends Error {
  constructor() {
    super("That email is already registered.");
    this.name = "EmailTakenError";
  }
}

/** Insert a new account.
 *
 *  The id is generated in Node so it can be set as app.user_id BEFORE the INSERT runs, which is
 *  what makes the users_self WITH CHECK pass without another definer function. It's also the
 *  value written to Cognito as custom:app_uid, so the token and the row agree by construction
 *  rather than by a lookup.
 *
 *  No password: password_hash is nullable now and accounts created here never have one. Only the
 *  two rows carried over from Supabase still populate it.
 *
 *  There's no plain UNIQUE(email) constraint - uniqueness is a functional index on lower(email) -
 *  so ON CONFLICT (email) would fail with "no unique or exclusion constraint matching". A
 *  functional unique index still raises 23505, so that's what we catch. */
export async function createUser(user: {
  id: string;
  email: string;
  fullName: string | null;
}): Promise<void> {
  try {
    await withUser(user.id, async (client) => {
      await client.query(
        "insert into users (id, email, full_name) values ($1, $2, $3)",
        [user.id, normalizeEmail(user.email), user.fullName],
      );
    });
  } catch (err) {
    if (
      err &&
      typeof err === "object" &&
      (err as { code?: unknown }).code === "23505"
    ) {
      // RLS hides the conflicting row from us, so we cannot check first and we
      // do not want to - checking first is a race anyway.
      throw new EmailTakenError();
    }
    throw err;
  }
}

/** Stamp the successful sign-in. Runs inside withUser(id) rather than withoutUser: the app role
 *  holds only a column-level UPDATE grant and users_self still applies, so without the GUC this
 *  would match zero rows and report success. */
export async function touchLastLogin(id: string): Promise<void> {
  await withUser(id, async (client) => {
    await client.query("update users set last_login_at = now() where id = $1", [
      id,
    ]);
  });
}
