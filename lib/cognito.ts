import "server-only";
import { createHmac } from "crypto";
import {
  AdminCreateUserCommand,
  AdminInitiateAuthCommand,
  AdminSetUserPasswordCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
  DescribeUserPoolClientCommand,
  type AuthenticationResultType,
} from "@aws-sdk/client-cognito-identity-provider";

// The Cognito admin surface. Everything the app does to a user pool goes through here.
//
// Admin APIs rather than the public ones, deliberately on both ends. The pool has
// selfSignUpEnabled false, so the public SignUp API is closed and account creation runs through
// signupAction, which checks SIGNUP_CODE first - leaving public sign-up open would reintroduce
// exactly the unauthenticated account-creation endpoint SIGNUP_CODE exists to shut. And
// ADMIN_USER_PASSWORD_AUTH hands Cognito the plaintext password, which is what the
// USER_MIGRATION trigger needs to verify a legacy bcrypt hash; SRP never exposes the password
// so it can't support migration. Once every legacy account has signed in once this could move
// to SRP.
//
// Both are only safe because this runs in Lambda and never in a browser.

const REGION =
  process.env.AWS_REGION_NAME ?? process.env.AWS_REGION ?? "ap-southeast-1";

/** The custom attribute carrying `users.id`. See aws/infra/lib/auth-stack.ts. */
export const APP_UID_ATTRIBUTE = "custom:app_uid";

let client: CognitoIdentityProviderClient | null = null;
function idp(): CognitoIdentityProviderClient {
  if (!client) {
    client = new CognitoIdentityProviderClient({
      region: REGION,
      maxAttempts: 3,
      retryMode: "adaptive",
    });
  }
  return client;
}

export function userPoolId(): string {
  const id = process.env.COGNITO_USER_POOL_ID;
  if (!id) throw new Error("COGNITO_USER_POOL_ID is not set.");
  return id;
}

export function clientId(): string {
  const id = process.env.COGNITO_CLIENT_ID;
  if (!id) throw new Error("COGNITO_CLIENT_ID is not set.");
  return id;
}

/** True when Cognito is configured. Demo mode has no user pool at all. */
export function isAuthConfigured(): boolean {
  return Boolean(process.env.COGNITO_USER_POOL_ID && process.env.COGNITO_CLIENT_ID);
}

// The client secret is FETCHED, not configured. The obvious design is a Lambda env var, but the
// app client's secret is readable through DescribeUserPoolClient by any principal already
// allowed to call AdminInitiateAuth on that pool - which this function must be able to do
// anyway - so copying it into an env var adds a second place for it to leak without adding a
// single control. Cached at module scope: fetched once per execution environment, never changes.
let cachedSecret: string | null | undefined;

async function clientSecret(): Promise<string | null> {
  if (cachedSecret !== undefined) return cachedSecret;
  const res = await idp().send(
    new DescribeUserPoolClientCommand({
      UserPoolId: userPoolId(),
      ClientId: clientId(),
    }),
  );
  cachedSecret = res.UserPoolClient?.ClientSecret ?? null;
  return cachedSecret;
}

/** SECRET_HASH, required on every auth call for a client that has a secret. HMAC over username
 *  + clientId, NOT over the password. Getting the operand order wrong yields
 *  "NotAuthorizedException: Unable to verify secret hash", which reads exactly like a wrong
 *  password. */
async function secretHash(username: string): Promise<Record<string, string>> {
  const secret = await clientSecret();
  if (!secret) return {};
  const hash = createHmac("sha256", secret)
    .update(username + clientId())
    .digest("base64");
  return { SECRET_HASH: hash };
}

export interface Tokens {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
}

function toTokens(result: AuthenticationResultType | undefined): Tokens {
  if (!result?.IdToken || !result.AccessToken) {
    throw new Error("Cognito returned no tokens.");
  }
  return {
    idToken: result.IdToken,
    accessToken: result.AccessToken,
    refreshToken: result.RefreshToken ?? null,
    expiresIn: result.ExpiresIn ?? 3600,
  };
}

/** Thrown for any authentication failure. Never says which one. */
export class AuthFailed extends Error {
  constructor() {
    super("Incorrect email or password.");
    this.name = "AuthFailed";
  }
}

/** Sign in with email and password. One failure mode, always: the pool sets
 *  preventUserExistenceErrors, so Cognito already answers UserNotFound and NotAuthorized
 *  identically, and this collapses everything else onto the same message. That's what
 *  password.ts's DUMMY_HASH used to buy at the cost of a real ~290ms bcrypt on every miss,
 *  including every unauthenticated request an attacker chose to send. */
export async function signIn(email: string, password: string): Promise<Tokens> {
  try {
    const res = await idp().send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId(),
        ClientId: clientId(),
        AuthFlow: "ADMIN_USER_PASSWORD_AUTH",
        AuthParameters: {
          USERNAME: email,
          PASSWORD: password,
          ...(await secretHash(email)),
        },
      }),
    );
    // A challenge (NEW_PASSWORD_REQUIRED, MFA) means no tokens yet. No flow in
    // this app produces one today; treating it as a failure rather than
    // pretending to succeed is the safe reading.
    if (res.ChallengeName) throw new AuthFailed();
    return toTokens(res.AuthenticationResult);
  } catch (err) {
    if (err instanceof AuthFailed) throw err;
    console.error("cognito signIn failed:", err);
    throw new AuthFailed();
  }
}

/** Exchange a refresh token for a fresh ID token. SECRET_HASH is keyed on the Cognito `sub`,
 *  not the email, on this flow only - the refresh flow has no USERNAME parameter and Cognito
 *  computes the hash against the subject. Passing the email fails for every user. */
export async function refresh(
  refreshToken: string,
  cognitoSub: string,
): Promise<Tokens | null> {
  try {
    const res = await idp().send(
      new AdminInitiateAuthCommand({
        UserPoolId: userPoolId(),
        ClientId: clientId(),
        AuthFlow: "REFRESH_TOKEN_AUTH",
        AuthParameters: {
          REFRESH_TOKEN: refreshToken,
          ...(await secretHash(cognitoSub)),
        },
      }),
    );
    const result = res.AuthenticationResult;
    if (!result?.IdToken) return null;
    return {
      idToken: result.IdToken,
      accessToken: result.AccessToken ?? "",
      // A refresh response does not re-issue the refresh token unless rotation
      // is on; keep the existing one rather than nulling the session.
      refreshToken: result.RefreshToken ?? refreshToken,
      expiresIn: result.ExpiresIn ?? 3600,
    };
  } catch (err) {
    // An expired or revoked refresh token is a normal end-of-session, not an
    // error worth alarming on.
    console.info(
      "cognito refresh declined:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Create a confirmed account, then sign it in. `appUid` is generated by the caller and written
 *  to Postgres FIRST so the users row exists before any token can carry its id; the reverse
 *  order leaves a signed-in user whose foreign key target doesn't exist, and every query fails a
 *  constraint rather than an auth check. MessageAction SUPPRESS because there's no email
 *  provider here - without it Cognito tries to send an invitation and the create fails. */
export async function createAccount(params: {
  email: string;
  password: string;
  fullName: string;
  appUid: string;
}): Promise<Tokens> {
  await idp().send(
    new AdminCreateUserCommand({
      UserPoolId: userPoolId(),
      Username: params.email,
      MessageAction: "SUPPRESS",
      UserAttributes: [
        { Name: "email", Value: params.email },
        // Marked verified because signup is gated by SIGNUP_CODE rather than by
        // an email round trip. Nothing in this app sends mail, so an unverified
        // address would simply never become verified.
        { Name: "email_verified", Value: "true" },
        { Name: "name", Value: params.fullName },
        { Name: APP_UID_ATTRIBUTE, Value: params.appUid },
      ],
    }),
  );

  // AdminCreateUser leaves the account in FORCE_CHANGE_PASSWORD, which would
  // meet the next sign-in with a NEW_PASSWORD_REQUIRED challenge. Permanent:
  // true is what makes the password the user just chose their real one.
  await idp().send(
    new AdminSetUserPasswordCommand({
      UserPoolId: userPoolId(),
      Username: params.email,
      Password: params.password,
      Permanent: true,
    }),
  );

  return signIn(params.email, params.password);
}

/** Revoke every token for a user - the capability the old session didn't have. Sessions used to
 *  be stateless, so a token stayed valid until expiry even if the user row was deleted, and the
 *  only revocation was rotating SESSION_SECRET, which signs everyone out at once. This revokes
 *  one user's refresh tokens server-side, so logout is real rather than cosmetic, and it makes
 *  the cookie-clearing race in proxy.ts benign: even a surviving stale cookie has a dead refresh
 *  token. Best-effort - a failed revoke must not stop the cookie being cleared. */
export async function globalSignOut(email: string): Promise<void> {
  try {
    await idp().send(
      new AdminUserGlobalSignOutCommand({
        UserPoolId: userPoolId(),
        Username: email,
      }),
    );
  } catch (err) {
    console.error("cognito global sign-out failed (ignored):", err);
  }
}
