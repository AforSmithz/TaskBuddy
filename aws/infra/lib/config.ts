// Every knob the stacks read, in one place, with the reasoning attached.
//
// This file is the AWS counterpart of azure/infra/main.bicepparam. It is
// deliberately plain TypeScript rather than CDK context: the values below carry
// cost and latency arguments that a JSON file cannot hold, and several of them
// sit exactly on a boundary where changing the number changes the bill.

/** Everything lives in one region. See aws/README.md "Why one region". */
export const REGION = "ap-southeast-1";

/** Prefix for every physical resource name. */
export const APP = "taskbuddy";

/**
 * Aurora Serverless v2 floor, in ACU. ZERO IS THE COST CONTROL, NOT A DEFAULT.
 *
 * At 0 the cluster auto-pauses after AUTO_PAUSE_SECONDS of no connections and
 * bills storage only. Setting it to 0.5 - which reads like a harmless
 * "always have a little capacity" - disables auto-pause entirely and takes the
 * cluster from roughly $10/mo to roughly $50/mo with no other change and no
 * warning. This is the AWS equivalent of Azure's `--storage-auto-grow Disabled`
 * trap: an ops-looking flag that is really the price tag.
 */
export const DB_MIN_ACU = 0;

/**
 * Ceiling. Two users cannot use four ACUs; this exists so that a runaway query
 * or a backfill cannot scale into three figures of hourly spend.
 */
export const DB_MAX_ACU = 4;

/**
 * Idle time before the cluster pauses. Range is 300 - 86400.
 *
 * 900 rather than the 300 default. A dashboard render fires ~21 statements and
 * `lib/db/pool.ts` sets idleTimeoutMillis to 10s, so connections drop almost
 * immediately after each page view. At 300 a user reading one screen for six
 * minutes would pay the ~15s resume on their next click. Fifteen minutes covers
 * a normal working session while still pausing overnight, which is where all
 * the saving actually is.
 */
export const DB_AUTO_PAUSE_SECONDS = 900;

/** Postgres major version. Aurora tracks community releases a little behind. */
export const DB_ENGINE_VERSION = "16.13";

export const DB_NAME = "taskbuddy";

/** Role the application connects as. Never the cluster master. */
export const DB_APP_ROLE = "taskbuddy_app";

/**
 * Node runtime for every function. arm64 (Graviton) throughout: ~34% better
 * price-performance and the entire dependency set is architecture-neutral.
 */
export const LAMBDA_ARCH = "arm64";

/**
 * AWS Lambda Web Adapter layer. Published by AWS into every commercial region
 * under account 753240598075.
 *
 * PINNED, AND CHECKED AT DEPLOY TIME by aws/scripts/preflight.sh. The version
 * suffix moves, and a stale pin fails as an opaque "layer not found" during
 * CloudFormation rollback rather than at synth. Re-pin deliberately, never by
 * reaching for :latest, because a layer bump changes the process supervisor
 * that fronts `next start`.
 */
export const LWA_LAYER_ARN =
  "arn:aws:lambda:ap-southeast-1:753240598075:layer:LambdaAdapterLayerArm64:25";

/**
 * Web function timeout. Generous because Server Actions run inside it and
 * CloudFront's origin read timeout is the real user-facing ceiling.
 *
 * NOT the LLM ceiling. Anything that could take 43 seconds belongs on the queue
 * (see events-stack.ts); this timeout is a backstop for a pathological render,
 * not a budget for one.
 */
export const WEB_TIMEOUT_SECONDS = 60;

/**
 * 1769 MB is exactly one full vCPU. Below it Lambda gives a fraction of a core
 * and a Next.js render - which is CPU-bound on React server rendering, not
 * IO-bound - stretches proportionally. Since Lambda bills GB-milliseconds,
 * paying for a whole core that finishes in half the time costs the same or less
 * than half a core that takes twice as long, and the user waits half as long.
 */
export const WEB_MEMORY_MB = 1769;

/** LLM workers are IO-bound on Bedrock; they need almost no CPU. */
export const WORKER_MEMORY_MB = 512;

/**
 * Worker timeout. Above the observed 43s worst case with real headroom, and
 * the number SQS visibility timeout is derived from.
 */
export const WORKER_TIMEOUT_SECONDS = 300;

/**
 * Cap on simultaneous LLM workers. This is a TOKEN BUDGET CONTROL, not a
 * throughput tuning knob: each concurrent worker is another Bedrock request
 * billing against the same account. Two users cannot legitimately need more
 * than a couple of jobs in flight, and the skill-link fan-out is the one path
 * that could otherwise spawn dozens.
 */
export const WORKER_MAX_CONCURRENCY = 2;

/**
 * Bedrock model ids. Inference profile ids, not bare model ids - Claude 4.5+
 * refuses on-demand invocation without one.
 *
 * `global.` rather than `apac.`: the APAC profile catalogue in ap-southeast-1
 * stops at Sonnet 4, while the global profiles carry Haiku 4.5 and Sonnet 4.6.
 * Verified with `aws bedrock list-inference-profiles --region ap-southeast-1`.
 * Global profiles may route the request to any commercial region, which is a
 * data-residency decision and is called out in aws/BEDROCK.md.
 */
export const BEDROCK_PRIMARY_MODEL = "global.anthropic.claude-haiku-4-5-20251001-v1:0";
export const BEDROCK_FALLBACK_MODEL = "global.anthropic.claude-sonnet-4-6";

/** Log retention. 30 days matches the Azure Log Analytics workspace. */
export const LOG_RETENTION_DAYS = 30;

/**
 * Monthly budget in USD. $10, matching azure/observability.sh, and for the same
 * reason: the whole stack should sit near $13-17, so a threshold set at the
 * credit allowance would only speak long after something had gone wrong.
 */
export const MONTHLY_BUDGET_USD = 10;
