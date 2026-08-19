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
 * Every RLS policy reads app.uid(), which is the users.id uuid, and 24 tables carry foreign keys
 * to it. Cognito mints its own `sub` and offers no way to choose it, so "just use the Cognito
 * sub as the user id" would mean rewriting every foreign key in the database. Instead
 * custom:app_uid holds the Postgres users.id, and Cognito puts custom attributes into the ID
 * token automatically - so the app reads the user id straight off the verified token, exactly as
 * it read it off the old self-signed JWT, and keeps the property that matters: no database round
 * trip to answer "who is this?".
 *
 * The migration trigger exists because Cognito's user import accepts no password material at all
 * bcrypt hashes can't be loaded into it. The alternative was forcing a password reset, and
 * with no email provider that means a manual SQL reset per user. Instead, on the first sign-in
 * for an unknown email Cognito calls a Lambda, which verifies against the bcrypt hash still in
 * Postgres and hands back the attributes.
 *
 * The trigger only fires for USER_PASSWORD_AUTH / ADMIN_USER_PASSWORD_AUTH because it needs the
 * plaintext password; SRP can't support it. That's why the app client below enables the
 * ADMIN_USER_PASSWORD flow rather than the SRP flow that would otherwise be preferable.
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

    // rds-db:connect, scoped to one database user on one cluster. grantConnect rather than a
    // hand-written PolicyStatement, and not just for brevity: the resource ARN has to name the
    // cluster RESOURCE id (cluster-ABC123...), not the cluster identifier. A policy written
    // against the identifier parses, deploys, and grants exactly nothing - the symptom is a PAM
    // authentication failure for a role whose permissions all look correct.
    props.cluster.grantConnect(migrationFn, DB_APP_ROLE);

    this.userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: APP,

      // No self sign-up. Account creation goes through signupAction, which checks SIGNUP_CODE
      // then calls AdminCreateUser. Leaving the public SignUp API enabled would reintroduce
      // exactly the open account-creation endpoint SIGNUP_CODE exists to close.
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

      // A confidential client: this is server-side Lambda, never a browser, so the secret is
      // safe and adds a second factor to every auth call. Read at cold start with
      // DescribeUserPoolClient rather than stored in an env var, so it exists in one place.
      generateSecret: true,

      authFlows: {
        // Required by the USER_MIGRATION trigger, which needs the plaintext.
        adminUserPassword: true,
        userSrp: false,
        custom: false,
        userPassword: false,
      },

      // Turns "user does not exist" and "wrong password" into the same answer - the Cognito-side
      // equivalent of password.ts's DUMMY_HASH, and its replacement. The timing oracle that
      // motivated the dummy bcrypt is now Cognito's problem, not a cost we pay on every login.
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
