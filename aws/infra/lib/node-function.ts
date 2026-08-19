import * as path from "path";
import { Duration } from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import { RemovalPolicy } from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import type { Construct } from "constructs";
import { LOG_RETENTION_DAYS } from "./config";

/** The repository root, from aws/infra (where cdk.json lives and therefore where the CLI runs).
 *  Every handler imports application code out of lib/, so esbuild has to be told the project is
 *  the whole repo, or NodejsFunction refuses the entry with PathNotUnderRoot. */
const REPO_ROOT = path.resolve(process.cwd(), "..", "..");

export interface NodeFunctionProps {
  readonly functionName: string;
  /** Path to the handler, relative to aws/infra. */
  readonly entry: string;
  readonly description: string;
  readonly timeout: Duration;
  readonly memorySize: number;
  readonly environment?: Record<string, string>;
  /** Packages to leave unbundled. Empty array means "bundle everything". */
  readonly bundlingExternalModules?: string[];
  readonly reservedConcurrentExecutions?: number;
}

/** One place for every default a Lambda in this stack should have, so "which functions have
 *  tracing on?" isn't a question you answer by reading five files.
 *
 *  arm64 throughout - ~34% better price-performance, and nothing in the dep set cares.
 *  AWS_NODEJS_CONNECTION_REUSE_ENABLED is set on every function deliberately: without it the SDK
 *  opens a new TCP+TLS connection per API call, which on a warm Lambda making repeated Bedrock or
 *  Cognito calls is a measurable share of the latency and, since Lambda bills wall-clock, of the
 *  cost. */
export function nodeFunction(
  scope: Construct,
  id: string,
  props: NodeFunctionProps,
): NodejsFunction {
  // An explicit log group, not the deprecated `logRetention` prop. That prop
  // provisions a custom resource with a Lambda of its own just to call
  // PutRetentionPolicy - an extra function, role and log group per function, on
  // an account whose whole budget is $10/mo.
  const logGroup = new logs.LogGroup(scope, `${id}Logs`, {
    logGroupName: `/aws/lambda/${props.functionName}`,
    retention: LOG_RETENTION_DAYS,
    removalPolicy: RemovalPolicy.DESTROY,
  });

  return new NodejsFunction(scope, id, {
    functionName: props.functionName,
    entry: path.resolve(REPO_ROOT, "aws", props.entry.replace(/^\.\.\//, "")),
    projectRoot: REPO_ROOT,
    depsLockFilePath: path.join(REPO_ROOT, "pnpm-lock.yaml"),
    logGroup,
    handler: "handler",
    description: props.description,
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    timeout: props.timeout,
    memorySize: props.memorySize,
    reservedConcurrentExecutions: props.reservedConcurrentExecutions,
    // X-Ray. The spans that matter are the ones this app cannot see today:
    // how long Bedrock took versus how long Aurora took inside one job.
    tracing: lambda.Tracing.ACTIVE,
    environment: {
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: "1",
      NODE_OPTIONS: "--enable-source-maps",
      ...props.environment,
    },
    bundling: {
      format: OutputFormat.ESM,
      target: "node22",
      minify: true,
      sourceMap: true,
      // The v3 SDK is in the managed runtime, but bundling it pins the version rather than
      // inheriting whatever AWS ships that week. Bedrock and Cognito shapes both move, and an
      // unpinned SDK is a silent upgrade on someone else's schedule.
      // pg-native is an optional peer node-postgres requires lazily inside a try/catch. esbuild
      // resolves it statically and fails the build; marking it external leaves the guarded
      // require in place, where pg handles the miss as designed.
      externalModules: props.bundlingExternalModules ?? ["pg-native"],
      esbuildArgs: {
        // Lets a Lambda bundle import anything under lib/. See the shim.
        [`--alias:server-only`]: path.resolve(
          process.cwd(),
          "../lambda/shims/server-only.js",
        ),
      },
      // ESM output plus CommonJS dependencies (pg, bcryptjs) needs the banner,
      // or `require is not defined` at cold start - which surfaces as an
      // Init failure with no stack pointing at the cause.
      banner:
        "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);",
    },
  });
}
