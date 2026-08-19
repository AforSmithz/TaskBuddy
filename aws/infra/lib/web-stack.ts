import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as cognito from "aws-cdk-lib/aws-cognito";
import type * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import {
  APP,
  ORIGIN_SECRET_HEADER,
  DB_APP_ROLE,
  DB_NAME,
  LOG_RETENTION_DAYS,
  LWA_LAYER_ARN,
  WEB_MEMORY_MB,
  WEB_TIMEOUT_SECONDS,
} from "./config";

export interface WebStackProps extends StackProps {
  readonly cluster: rds.DatabaseCluster;
  readonly userPool: cognito.UserPool;
  readonly userPoolClient: cognito.UserPoolClient;
  readonly bus: events.EventBus;
  readonly jobQueue: sqs.Queue;
}

/** Where aws/scripts/build-web.sh assembles the deployable bundle. */
const WEB_BUNDLE = "../.build/web";
const STATIC_BUNDLE = "../.build/static";

/**
 * The synchronous web tier: Next.js on Lambda, fronted by CloudFront.
 *
 * ---------------------------------------------------------------------------
 * WHY THE REAL `next start`, NOT OPENNEXT
 * ---------------------------------------------------------------------------
 * The installed Next 16.2.6 documentation
 * (node_modules/next/dist/docs/01-app/02-guides/deploying-to-platforms.md) is
 * unusually blunt about this: "To run Next.js, your platform needs a Node.js
 * server. That's it. A single `next start` process handles every Next.js
 * feature correctly." The AWS Lambda Web Adapter runs that process unmodified,
 * so Server Actions, `proxy.ts`, `after()` and PPR work by construction rather
 * than by an adapter re-implementing them. OpenNext still targets Next 15.
 *
 * ---------------------------------------------------------------------------
 * WHY A FUNCTION URL AND NOT API GATEWAY
 * ---------------------------------------------------------------------------
 * From the same feature matrix: Server Actions are "POST requests with
 * streaming response" and are marked Streaming: Required. API Gateway HTTP API
 * buffers the response and hard-caps at 30 seconds, which cannot be raised. A
 * Function URL in RESPONSE_STREAM mode streams and inherits the function's own
 * timeout instead. This is a correctness constraint, not a performance
 * preference: buffered Server Actions are a broken app, not a slow one.
 *
 * The URL is `authType: NONE` and is kept private by a secret header that only
 * CloudFront sends, NOT by Origin Access Control. OAC was the original design
 * and had to be abandoned: it signs the request body, Lambda refuses unsigned
 * payloads, and a browser cannot compute the `x-amz-content-sha256` that would
 * satisfy it - so every Server Action POST returned a signature mismatch while
 * GETs sailed through. See ORIGIN_SECRET_HEADER in config.ts for the full
 * measurement and for what this control does and does not buy.
 */
export class WebStack extends Stack {
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    // Supplied at deploy time, like TASKBUDDY_ALERT_EMAIL, and required rather
    // than defaulted. A generated-on-synth value would change on every deploy
    // and a hardcoded one would be in git; an absent one must fail here, because
    // the failure mode otherwise is an origin that accepts anything.
    //
    // It does land in the CloudFormation template and in the function's
    // environment, so it is readable by anyone with CloudFormation or Lambda
    // read access to this account. That is the accepted limit of this control:
    // CloudFront custom headers are template literals, and CloudFront cannot
    // read Secrets Manager.
    const originSecret = process.env.TASKBUDDY_ORIGIN_SECRET;
    if (!originSecret) {
      throw new Error(
        "TASKBUDDY_ORIGIN_SECRET is not set. It is the only thing stopping the " +
          "public function URL from being reachable without CloudFront. " +
          "Generate one with: openssl rand -hex 32",
      );
    }

    const assets = new s3.Bucket(this, "Assets", {
      bucketName: `${APP}-assets-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Named to match the function, unlike an earlier draft of this stack where
    // the group said `-web-app` and the function said `-web`, so CDK silently
    // created a second group and every log line went to the one nobody looked at.
    const webLogs = new logs.LogGroup(this, "WebLogs", {
      logGroupName: `/aws/lambda/${APP}-web`,
      retention: LOG_RETENTION_DAYS,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const web = new lambda.Function(this, "WebFn", {
      functionName: `${APP}-web`,
      description: "Next.js server via the AWS Lambda Web Adapter.",
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      // The adapter's bootstrap execs this script, which starts the standalone
      // server. It is not a Node handler and Lambda never imports it.
      handler: "run.sh",
      code: lambda.Code.fromAsset(WEB_BUNDLE),
      layers: [
        lambda.LayerVersion.fromLayerVersionArn(this, "Lwa", LWA_LAYER_ARN),
      ],
      memorySize: WEB_MEMORY_MB,
      timeout: Duration.seconds(WEB_TIMEOUT_SECONDS),
      tracing: lambda.Tracing.ACTIVE,
      logGroup: webLogs,
      environment: {
        // Hands control to the adapter instead of the Node handler contract.
        AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
        AWS_LWA_INVOKE_MODE: "response_stream",
        AWS_LWA_PORT: "3000",
        PORT: "3000",
        // Without this the adapter starts forwarding before `next start` is
        // listening, and the first request of every cold start 502s.
        AWS_LWA_READINESS_CHECK_PATH: "/api/health",
        AWS_LWA_ENABLE_COMPRESSION: "true",
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",

        NODE_ENV: "production",
        HOSTNAME: "0.0.0.0",

        PGHOST: props.cluster.clusterEndpoint.hostname,
        PGDATABASE: DB_NAME,
        PGUSER: DB_APP_ROLE,

        COGNITO_USER_POOL_ID: props.userPool.userPoolId,
        COGNITO_CLIENT_ID: props.userPoolClient.userPoolClientId,

        EVENT_BUS_NAME: props.bus.eventBusName,
        JOB_QUEUE_URL: props.jobQueue.queueUrl,

        // Checked by proxy.ts on every matched request. Set here and nowhere
        // else, so the value the CDN sends and the value the app expects cannot
        // drift apart.
        ORIGIN_SECRET: originSecret,
      },
    });

    // No password anywhere. The function signs a 15-minute token with its own
    // execution-role credentials; see lib/db/pool.ts.
    // See auth-stack.ts for why this is grantConnect and not a literal ARN.
    props.cluster.grantConnect(web, DB_APP_ROLE);

    // Admin* rather than the public sign-up/sign-in APIs, because
    // `selfSignUpEnabled` is false and the migration trigger requires
    // ADMIN_USER_PASSWORD_AUTH. DescribeUserPoolClient is what lets the client
    // secret stay in Cognito instead of being copied into an env var.
    web.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "cognito-idp:AdminInitiateAuth",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
          "cognito-idp:AdminUserGlobalSignOut",
          "cognito-idp:DescribeUserPoolClient",
        ],
        resources: [props.userPool.userPoolArn],
      }),
    );

    props.bus.grantPutEventsTo(web);
    props.jobQueue.grantSendMessages(web);

    const fnUrl = web.addFunctionUrl({
      // NONE, not AWS_IAM, and ORIGIN_SECRET_HEADER is what replaces it.
      // See config.ts for the measurement that forced this: OAC + AWS_IAM
      // signs the request body, and a browser cannot produce the payload hash
      // Lambda then demands, so every Server Action POST 403s.
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // Security headers at the edge rather than in `next.config.ts`, so they
    // also cover responses Next never sees - S3 asset responses and CloudFront
    // error pages included.
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, "SecHeaders", {
      responseHeadersPolicyName: `${APP}-security-headers`,
      securityHeadersBehavior: {
        strictTransportSecurity: {
          accessControlMaxAge: Duration.days(365),
          includeSubdomains: true,
          override: true,
        },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
      },
    });

    const appOrigin = new origins.FunctionUrlOrigin(fnUrl, {
      // Not `withOriginAccessControl`. OAC would sign these requests, and a
      // signed body is exactly what browsers cannot supply - see config.ts.
      customHeaders: { [ORIGIN_SECRET_HEADER]: originSecret },
      // The origin ceiling that actually bites. CloudFront gives up on the
      // origin after this many seconds regardless of the Lambda timeout, so it
      // is the real budget for a server render - and the reason 43-second LLM
      // work has to live on the queue rather than in a Server Action.
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
    });

    this.distribution = new cloudfront.Distribution(this, "Cdn", {
      comment: `${APP} web`,
      defaultBehavior: {
        origin: appOrigin,
        // Every route is authenticated and user-specific. Caching HTML here
        // would serve one account's dashboard to another.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // Forwards cookies, auth headers and query strings but drops Host,
        // which a Function URL origin requires: the signature is computed over
        // the origin's own host, and forwarding the viewer's breaks it.
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      additionalBehaviors: {
        // Content-hashed filenames, immutable by construction. Serving these
        // from S3 keeps the Lambda out of the path for the majority of requests
        // on a page load, which is most of what keeps this inside the free tier.
        "/_next/static/*": {
          origin: origins.S3BucketOrigin.withOriginAccessControl(assets),
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          responseHeadersPolicy: securityHeaders,
          compress: true,
        },
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      enableLogging: false,
    });

    // Uploaded from the SAME build that produced the Lambda bundle. Next.js
    // content-hashes these filenames per build, so a static upload from one
    // build against a server from another yields 404s on every chunk - a
    // failure that looks like a CloudFront misconfiguration and is not.
    new s3deploy.BucketDeployment(this, "StaticAssets", {
      sources: [s3deploy.Source.asset(STATIC_BUNDLE)],
      destinationBucket: assets,
      destinationKeyPrefix: "_next/static",
      prune: false,
      retainOnDelete: false,
    });

    new CfnOutput(this, "SiteUrl", {
      value: `https://${this.distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "DistributionId", {
      value: this.distribution.distributionId,
    });
    new CfnOutput(this, "AssetsBucket", { value: assets.bucketName });
  }
}
