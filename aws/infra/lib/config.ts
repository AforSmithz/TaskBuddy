// Every knob the stacks read. Plain TS rather than CDK context because a few of these
// numbers sit right on a boundary where changing them changes the bill.

export const REGION = "ap-southeast-1";
export const APP = "taskbuddy";

// Aurora Serverless v2 floor, in ACU. 0 is the cost control: the cluster auto-pauses after
// AUTO_PAUSE_SECONDS and bills storage only. Setting it to 0.5 disables auto-pause entirely
// and takes it from ~$10/mo to ~$50/mo with no warning.
export const DB_MIN_ACU = 0;

// Ceiling, so a runaway query or a backfill can't scale into three figures an hour.
export const DB_MAX_ACU = 4;

// Idle time before the cluster pauses (300-86400). 900 rather than the 300 default: a
// dashboard render fires ~21 statements and pool.ts drops idle connections after 10s, so at
// 300 you'd pay the ~15s resume after reading one screen for six minutes. 15 min covers a
// working session and still pauses overnight, which is where the saving is.
export const DB_AUTO_PAUSE_SECONDS = 900;

// PITR window. Needs a Paid account plan. On the Free plan this exact value is rejected at
// CreateDBCluster with "exceeds the maximum available to free tier customers", arriving as a
// rollback minutes into the deploy; the cap there is 1. Lowering it to 1 doesn't help though,
// the next error is that free-plan accounts must pass WithExpressConfiguration, which doesn't
// exist on AWS::RDS::DBCluster - so Aurora can't be created by CDK on a Free plan at all.
// Upgraded the account instead, see aws/CUTOVER.md.
export const DB_BACKUP_RETENTION_DAYS = 7;

// Aurora tracks community releases a little behind.
export const DB_ENGINE_VERSION = "16.13";

export const DB_NAME = "taskbuddy";

// Role the app connects as. Never the cluster master.
export const DB_APP_ROLE = "taskbuddy_app";

// arm64 throughout: ~34% better price-performance and nothing in the dep set cares.
export const LAMBDA_ARCH = "arm64";

// AWS Lambda Web Adapter layer, published by AWS into every commercial region.
// Pinned, and checked at deploy time by aws/scripts/preflight.sh - the version suffix moves
// and a stale pin fails as an opaque "layer not found" during rollback, not at synth. Re-pin
// deliberately; a bump changes the process supervisor fronting `next start`.
export const LWA_LAYER_ARN =
  "arn:aws:lambda:ap-southeast-1:753240598075:layer:LambdaAdapterLayerArm64:25";

// Generous because Server Actions run in here. NOT the LLM ceiling - anything that could take
// 43s belongs on the queue. This is a backstop for a pathological render.
export const WEB_TIMEOUT_SECONDS = 60;

// 1769 MB is exactly one full vCPU. Below it Lambda gives a fraction of a core and a Next
// render (CPU-bound on React SSR, not IO-bound) stretches proportionally. Billing is
// GB-milliseconds, so a whole core finishing in half the time costs the same or less.
export const WEB_MEMORY_MB = 1769;

// Workers are IO-bound on Bedrock, they need almost no CPU.
export const WORKER_MEMORY_MB = 512;

// Above the observed 43s worst case with headroom. Visibility timeout derives from this.
export const WORKER_TIMEOUT_SECONDS = 300;

// Token budget control, not a throughput knob: each concurrent worker is another Bedrock
// request billing against the same account. The skill-link fan-out is the one path that could
// otherwise spawn dozens.
export const WORKER_MAX_CONCURRENCY = 2;

// Deliveries before SQS routes to the DLQ. The worker reads this same number as
// MAX_RECEIVE_COUNT to decide whether a failure is a transient `retrying` or a final `failed`,
// so changing it in one place only makes the UI lie one way or the other. Three, because
// Bedrock throttles clear in seconds while a schema or prompt failure fails identically
// forever, and ten attempts at a 43-second call is expensive in both senses.
export const WORKER_MAX_RECEIVE_COUNT = 3;

// One minute past the function timeout, not the 6x the docs suggest - that rule budgets for a
// whole batch processed serially, and this mapping is batchSize 1 with partial batch failures
// on. Margin matters the other way too: this is also how long a failed job waits before its
// next attempt, and at 1800s the retry would land long after the page gave up. JOB_STALE_MS
// is derived from this × WORKER_MAX_RECEIVE_COUNT.
//
// Must stay ABOVE WORKER_TIMEOUT_SECONDS. Lambda kills the first copy at the function timeout,
// so a shorter window redelivers while that copy is still running and the model gets invoked,
// and billed, twice for one job.
export const WORKER_VISIBILITY_TIMEOUT_SECONDS = WORKER_TIMEOUT_SECONDS + 60;

// Inference profile ids, not bare model ids - Claude 4.5+ refuses on-demand invocation without
// one. `global.` rather than `apac.` because the APAC catalogue in ap-southeast-1 stops at
// Sonnet 4. Global profiles may route to any commercial region, which is a data-residency
// call; see aws/BEDROCK.md.
export const BEDROCK_PRIMARY_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_FALLBACK_MODEL = "global.anthropic.claude-sonnet-4-6";

export const LOG_RETENTION_DAYS = 30;

// The whole stack should sit near $13-17, so a threshold at the credit allowance would only
// fire long after something went wrong.
export const MONTHLY_BUDGET_USD = 10;

// Header CloudFront injects on every origin request - the only thing separating "came through
// the CDN" from "someone found the function URL".
//
// The function URL is public because AuthType AWS_IAM + an OAC doesn't work here: OAC signs
// the body, Lambda rejects unsigned payloads, so the BROWSER would have to send an
// x-amz-content-sha256 over the request body. It can't, and every Server Action is a POST, so
// login and every mutation returned 403 "The request signature we calculated does not match".
// None of the three OAC signing behaviours avoid it. Measured against the live distribution
// 2026-08-19: GETs worked, POSTs didn't.
//
// So the origin is public and this header is the compensating control, the usual pattern for
// Next on Lambda behind CloudFront. Weaker than IAM: anyone with this value can reach the
// origin directly. It isn't what protects user data though - every route still verifies a
// Cognito session. What it prevents is bypassing the edge (security headers, TLS policy, WAF).
export const ORIGIN_SECRET_HEADER = "x-taskbuddy-origin";

// --- CI/CD -----------------------------------------------------------------

// The one repository allowed to mint credentials in this account. It is part of
// an IAM trust policy, not a convenience constant: the `sub` claim GitHub signs
// is `repo:<owner>/<repo>:<context>`, so a typo here doesn't fail loudly, it
// produces a role nothing can assume.
export const GITHUB_OWNER = "AforSmithz";
export const GITHUB_REPO = "TaskBuddy";

// GitHub now issues IMMUTABLE subject claims: the `sub` carries the numeric
// owner and repository ids, not just the names -
//
//   repo:AforSmithz@35168441/TaskBuddy@1339483965:ref:refs/heads/main
//
// so a trust policy written against the plain `repo:owner/name:...` form
// matches nothing. The failure is silent in the worst way: the token validates,
// no statement matches, and STS answers "Not authorized to perform
// sts:AssumeRoleWithWebIdentity", which reads like a missing permission rather
// than a mismatched string. Measured against the live token 2026-08-19.
//
// Re-read these if the repository is ever recreated:
//   gh api /repos/AforSmithz/TaskBuddy/actions/oidc/customization/sub
export const GITHUB_OWNER_ID = "35168441";
export const GITHUB_REPO_ID = "1339483965";

// Only this branch can deploy. A push to any other ref gets a token whose `sub`
// doesn't match the deploy role's condition, so the assume-role call fails
// before any AWS API is touched.
export const GITHUB_DEPLOY_BRANCH = "main";

// The bootstrap qualifier this account was bootstrapped with (the default).
// It is in the ARNs of the four roles `cdk deploy` assumes, which is the only
// thing the GitHub role is allowed to do - see cicd-stack.ts.
export const CDK_QUALIFIER = "hnb659fds";

// CloudFront only reports metrics in us-east-1, so the edge stack lives there
// and the CI role needs the bootstrap roles of both regions.
export const EDGE_REGION = "us-east-1";
