import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cognito from "aws-cdk-lib/aws-cognito";
import type * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import { APP, DB_APP_ROLE, DB_NAME } from "./config";
import { nodeFunction } from "./node-function";

export interface AuthStackProps extends StackProps {
  readonly cluster: rds.DatabaseCluster;
}

/**
 * Cognito, and the trigger that carries the existing accounts across.
 *
 * ---------------------------------------------------------------------------
 * THE BRIDGE BETWEEN COGNITO AND ROW-LEVEL SECURITY
 * ---------------------------------------------------------------------------
 * Every RLS policy in the schema reads `app.uid()`, which is the `users.id`
 * uuid, and 24 tables carry foreign keys to it. Cognito mints its own `sub` and
 * offers no way to choose it, so "just use the Cognito sub as the user id"
 * would mean rewriting every foreign key in the database.
 *
 * Instead `custom:app_uid` holds the Postgres `users.id`, and Cognito puts
 * custom attributes into the ID token automatically. So the app reads the
 * user id straight off the verified token, exactly as it read it off the old
 * self-signed JWT, and `lib/auth.ts` keeps its most valuable property: no
 * database round trip on any request to answer "who is this?".
 *
 * ---------------------------------------------------------------------------
 * WHY THE MIGRATION TRIGGER EXISTS
 * ---------------------------------------------------------------------------
 * Cognito's user import accepts no password material of any kind - bcrypt
 * hashes cannot be loaded into it. The alternatives were forcing a password
 * reset (there is no email provider on this deployment, so that means a manual
 * SQL reset per user) or this: on the first sign-in for an unknown email,
 * Cognito calls a Lambda, which verifies the password against the bcrypt hash
 * still sitting in Postgres and hands back the attributes. The user signs in
 * with their existing password and never learns anything happened.
 *
 * The trigger only fires for USER_PASSWORD_AUTH / ADMIN_USER_PASSWORD_AUTH,
 * because it needs the plaintext password. SRP cannot support it. That is the
 * reason the app client below enables the ADMIN_USER_PASSWORD flow rather than
 * the SRP flow that would otherwise be preferable.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    const migrationFn = nodeFunction(this, "UserMigrationFn", {
      functionName: `${APP}-user-migration`,
      entry: "../lambda/user-migration/index.ts",
      description:
        "Cognito USER_MIGRATION trigger: verifies a legacy bcrypt hash in Postgres.",
      timeout: Duration.seconds(20),
      memorySize: 512,
      environment: {
        PGHOST: props.cluster.clusterEndpoint.hostname,
        PGDATABASE: DB_NAME,
        PGUSER: DB_APP_ROLE,
        AWS_REGION_NAME: this.region,
      },
      // bcryptjs is pure JS but ships a `require` of its own package.json that
      // esbuild cannot statically resolve when minified.
      bundlingExternalModules: [],
    });

    // rds-db:connect, scoped to one database user on one cluster.
    //
    // `grantConnect` rather than a hand-written PolicyStatement, and not just
    // for brevity: the resource ARN has to name the cluster RESOURCE id
    // (cluster-ABC123...), not the cluster identifier. A policy written against
    // the identifier parses, deploys, and grants exactly nothing - the symptom
    // is a PAM authentication failure for a role whose permissions all look
    // correct. Letting CDK build it removes the chance to get that wrong.
    props.cluster.grantConnect(migrationFn, DB_APP_ROLE);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: APP,

      // No self sign-up. Account creation goes through `signupAction`, which
      // checks SIGNUP_CODE first and then calls AdminCreateUser. Leaving the
      // public SignUp API enabled would reintroduce exactly the open
      // account-creation endpoint SIGNUP_CODE exists to close.
      selfSignUpEnabled: false,

      signInAliases: { email: true },
      signInCaseSensitive: false,
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        // Immutable: it is a foreign key into 24 tables. A mutable one could be
        // repointed by any code path holding admin rights, which would silently
        // hand one account another account's data.
        app_uid: new cognito.StringAttribute({ minLen: 36, maxLen: 36, mutable: false }),
      },

      passwordPolicy: {
        minLength: 8,
        requireLowercase: false,
        requireUppercase: false,
        requireDigits: false,
        requireSymbols: false,
        tempPasswordValidity: Duration.days(1),
      },

      lambdaTriggers: { userMigration: migrationFn },

      accountRecovery: cognito.AccountRecovery.NONE,
      mfa: cognito.Mfa.OPTIONAL,
      mfaSecondFactor: { sms: false, otp: true },
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
    });

    this.userPoolClient = this.userPool.addClient("AppClient", {
      userPoolClientName: `${APP}-server`,

      // A confidential client: the app is server-side Lambda, never a browser,
      // so the secret is safe and adds a second factor to every auth call.
      // Read at cold start with DescribeUserPoolClient rather than stored in an
      // environment variable, so the secret exists in exactly one place.
      generateSecret: true,

      authFlows: {
        // Required by the USER_MIGRATION trigger, which needs the plaintext.
        adminUserPassword: true,
        userSrp: false,
        custom: false,
        userPassword: false,
      },

      // Turns "user does not exist" and "wrong password" into the same answer.
      // This is the Cognito-side equivalent of lib/password.ts DUMMY_HASH, and
      // it replaces it: the timing oracle that motivated the dummy bcrypt is
      // now Cognito's problem, not a cost this app pays on every login.
      preventUserExistenceErrors: true,

      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      // Seven days, matching the MAX_AGE_SECONDS the self-signed session used,
      // so the sign-in lifetime users experience does not change.
      refreshTokenValidity: Duration.days(7),
      enableTokenRevocation: true,
    });

    new CfnOutput(this, "UserPoolId", { value: this.userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", {
      value: this.userPoolClient.userPoolClientId,
    });
  }
}
