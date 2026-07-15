import "server-only";
import { withUser, withoutUser } from "./pool";

// The authentication path's database access. Deliberately NOT through the shim.
//
// The shim refuses to execute without a session, which is correct for every
// other query and exactly wrong here: obtaining a session is the point of these
// calls. So they talk to the pool directly, and the two that must read past
// `users_self` go through the SECURITY DEFINER functions in `03_auth.sql`.

export interface LoginRow {
  id: string;
  email: string;
  full_name: string | null;
  password_hash: string;
}

/** Normalise an email the same way everywhere: this is the lookup key. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Fetch the credential row for a sign-in attempt, or null.
 *
 * MUST go through `app.login_lookup`. `users_self` is `id = app.uid()` and
 * `app.uid()` is NULL before a session exists, so a direct SELECT here returns
 * zero rows every single time - the failure looks exactly like "wrong password"
 * for every user in the database, forever.
 */
export async function findUserForLogin(
  email: string,
): Promise<LoginRow | null> {
  return withoutUser(async (client) => {
    const res = await client.query<LoginRow>(
      "select id, email, full_name, password_hash from app.login_lookup($1)",
      [normalizeEmail(email)],
    );
    return res.rows[0] ?? null;
  });
}

/** Raised when the email is already taken. */
export class EmailTakenError extends Error {
  constructor() {
    super("That email is already registered.");
    this.name = "EmailTakenError";
  }
}

/**
 * Insert a new account.
 *
 * The id is generated in Node so it can be set as `app.user_id` *before* the
 * INSERT runs, which is what makes the `users_self` WITH CHECK (`id = app.uid()`)
 * pass without needing another definer function.
 *
 * There is no plain `UNIQUE(email)` constraint - uniqueness is a functional
 * index on `lower(email)` - so `ON CONFLICT (email)` would fail with "no unique
 * or exclusion constraint matching". A functional unique index still raises
 * 23505, so that is what we catch.
 */
export async function createUser(user: {
  id: string;
  email: string;
  passwordHash: string;
  fullName: string | null;
}): Promise<void> {
  try {
    await withUser(user.id, async (client) => {
      await client.query(
        "insert into users (id, email, password_hash, full_name) values ($1, $2, $3, $4)",
        [
          user.id,
          normalizeEmail(user.email),
          user.passwordHash,
          user.fullName,
        ],
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

/**
 * Stamp the successful sign-in.
 *
 * Runs inside `withUser(id)` rather than `withoutUser`: the app role holds only
 * a column-level `UPDATE (last_login_at)` grant, and `users_self` still applies,
 * so without the GUC this would match zero rows and report success.
 */
export async function touchLastLogin(id: string): Promise<void> {
  await withUser(id, async (client) => {
    await client.query("update users set last_login_at = now() where id = $1", [
      id,
    ]);
  });
}

/**
 * Replace a user's password hash. Used for the transparent cost upgrade on
 * login. Goes through the definer function because the app role has no direct
 * UPDATE privilege on `password_hash` - that is the whole point of `03_auth.sql`.
 */
export async function upgradePasswordHash(
  id: string,
  passwordHash: string,
): Promise<void> {
  await withoutUser(async (client) => {
    await client.query("select app.set_password_hash($1, $2)", [
      id,
      passwordHash,
    ]);
  });
}
