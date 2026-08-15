import { Signer } from "@aws-sdk/rds-signer";
import { compare } from "bcryptjs";
import { Client } from "pg";
import { RDS_CA_BUNDLE } from "../../../lib/db/rds-ca";

/**
 * Cognito USER_MIGRATION trigger.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * Cognito's user import accepts no password material of any kind - a bcrypt
 * hash cannot be loaded into a user pool by any API. The two accounts carried
 * from Supabase through Azure have hashes at cost 6 and cost 10 sitting in
 * `users.password_hash`, and there is no email provider on this deployment, so
 * "just send everyone a reset link" is not available either.
 *
 * So: the first time an unknown email tries to sign in, Cognito calls this
 * function with the plaintext password. It verifies against the hash still in
 * Postgres and returns the attributes. Cognito creates the user with that
 * password, and every later sign-in goes straight to Cognito without touching
 * this function again. The user never learns anything happened.
 *
 * ---------------------------------------------------------------------------
 * THINGS THAT SILENTLY BREAK THIS
 * ---------------------------------------------------------------------------
 *  - Returning without setting `response.finalUserStatus = "CONFIRMED"` leaves
 *    the account in RESET_REQUIRED, and the sign-in that triggered the
 *    migration fails with a password-reset challenge the app cannot answer.
 *  - Omitting `custom:app_uid` produces a user whose token has no Postgres id.
 *    lib/session.ts refuses such a session on purpose, so the symptom is a
 *    successful login followed by an immediate bounce to /login.
 *  - THROWING on a bad password rather than returning without a userAttributes
 *    block. Cognito treats a thrown error as an infrastructure failure, which
 *    surfaces to the user as a generic error instead of "incorrect password",
 *    and defeats `preventUserExistenceErrors`.
 *
 * This function is the ONLY thing in the system that reads `password_hash`.
 * The application role can still SELECT it here because this Lambda connects as
 * `taskbuddy_app`; aws/sql/04_cognito.sql keeps that column grant alive solely
 * for this path, and 05_drop_password_hash.sql removes both once every legacy
 * account has migrated.
 */

interface MigrationEvent {
  userName: string;
  triggerSource: string;
  request: { password?: string };
  response: {
    userAttributes?: Record<string, string>;
    finalUserStatus?: string;
    messageAction?: string;
    forceAliasCreation?: boolean;
  };
}

interface LegacyUser {
  id: string;
  email: string;
  full_name: string | null;
  password_hash: string | null;
}

async function connect(): Promise<Client> {
  const host = process.env.PGHOST!;
  const port = Number(process.env.PGPORT ?? 5432);
  const user = process.env.PGUSER ?? "taskbuddy_app";
  const region =
    process.env.AWS_REGION_NAME ?? process.env.AWS_REGION ?? "ap-southeast-1";

  // A single Client, not a Pool. This function runs at most twice in the life
  // of the deployment; a pool would hold a connection open across the freeze
  // and keep Aurora from auto-pausing for the sake of two logins.
  const client = new Client({
    host,
    port,
    user,
    database: process.env.PGDATABASE ?? "taskbuddy",
    password: await new Signer({ hostname: host, port, username: user, region }).getAuthToken(),
    ssl: { ca: RDS_CA_BUNDLE, rejectUnauthorized: true, servername: host },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000,
  });
  await client.connect();
  return client;
}

async function lookup(email: string): Promise<LegacyUser | null> {
  const client = await connect();
  try {
    // Through the SECURITY DEFINER function, exactly as the old
    // `findUserForLogin` did. `users_self` is `id = app.uid()` and app.uid() is
    // NULL with no session, so a direct SELECT here returns zero rows every
    // time - which would look identical to "no such user" for every account,
    // forever.
    const res = await client.query<LegacyUser>(
      "select id, email, full_name, password_hash from app.login_lookup($1)",
      [email.trim().toLowerCase()],
    );
    return res.rows[0] ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function handler(event: MigrationEvent): Promise<MigrationEvent> {
  // Only the sign-in trigger is handled. The other source,
  // UserMigration_ForgotPassword, would migrate an account without ever
  // verifying a password - and since there is no email provider, a forgotten
  // password is a manual admin operation anyway.
  if (event.triggerSource !== "UserMigration_Authentication") {
    console.info(`ignoring trigger source ${event.triggerSource}`);
    return event;
  }

  const email = event.userName;
  const password = event.request.password ?? "";
  if (!password) return event;

  try {
    const user = await lookup(email);
    if (!user?.password_hash) {
      console.info("no legacy account for this address");
      return event;
    }

    // bcryptjs accepts $2a$, $2b$ and $2y$, so both carried-over hashes - the
    // cost-6 and the cost-10 that Supabase's Go implementation wrote - verify
    // through this one call with no branching.
    const ok = await compare(password, user.password_hash);
    if (!ok) {
      console.info("legacy password did not match");
      return event;
    }

    event.response.userAttributes = {
      email: user.email,
      email_verified: "true",
      ...(user.full_name ? { name: user.full_name } : {}),
      // The bridge to row-level security. Carrying the EXISTING uuid is what
      // makes this a migration rather than a new account: every goal, task and
      // plan row already points at it.
      "custom:app_uid": user.id,
    };
    // Without this the account lands in RESET_REQUIRED and the very sign-in
    // that triggered the migration fails.
    event.response.finalUserStatus = "CONFIRMED";
    // There is no email provider; a welcome message would fail the migration.
    event.response.messageAction = "SUPPRESS";

    console.info(`migrated legacy account ${user.id}`);
    return event;
  } catch (err) {
    // Deliberately swallowed into a non-migration rather than rethrown. A
    // database blip must present as "incorrect email or password", not as an
    // internal error that tells an attacker this address exists.
    console.error("user migration failed:", err);
    return event;
  }
}
