import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { runAsUser } from "../../../lib/db/context";
import { closePool } from "../../../lib/db/pool";
import {
  decomposeGoalJob,
  refreshStrategyJob,
  suggestSkillLinksJob,
  type Job,
} from "../../../lib/job-handlers";

/**
 * The LLM worker. Runs jobs that are too slow to sit inside a request.
 *
 * ---------------------------------------------------------------------------
 * IT RUNS THE APPLICATION'S OWN CODE
 * ---------------------------------------------------------------------------
 * Everything below `runAsUser` is the same module the Server Actions call -
 * lib/job-handlers.ts - bundled straight out of lib/. There is no worker-side
 * reimplementation of decomposition or strategy generation to drift out of
 * step with the request path. The only thing this file adds is the runtime:
 * who the job is for, and what to do when it fails.
 *
 * ---------------------------------------------------------------------------
 * IDENTITY
 * ---------------------------------------------------------------------------
 * There is no cookie here, so the user comes from the message body and is
 * installed with AsyncLocalStorage. That is not a stylistic choice over a
 * module-scope variable: a Lambda execution environment is REUSED, so a plain
 * `let currentUid` would survive between invocations and the failure mode is
 * the worst one this codebase has - job B running as job A's user, writing one
 * account's data into another's. See lib/db/context.ts.
 */

const MAX_JOB_MS = 240_000;

/** Exported as a test seam; see aws/harness/offline.ts. */
export function parse(record: SQSRecord): Job | null {
  try {
    const body = JSON.parse(record.body) as Record<string, unknown>;
    // Two envelopes arrive on this queue and they are not the same shape.
    // EventBridge wraps the payload in `detail`; EventBridge Scheduler sends
    // the literal `input` from the schedule with no envelope at all. Reading
    // only `detail` would make every scheduled roll a silent no-op.
    const job = (body.detail ?? body) as Job;
    if (typeof job?.type !== "string") return null;
    return job;
  } catch {
    return null;
  }
}

async function run(job: Job): Promise<void> {
  switch (job.type) {
    case "goal.decompose.requested":
      await runAsUser(job.userId, () => decomposeGoalJob(job.goalId));
      return;
    case "goal.skill_links.requested":
      await runAsUser(job.userId, async () => {
        const n = await suggestSkillLinksJob(job.goalId);
        console.info(`proposed ${n} skill links for goal ${job.goalId}`);
      });
      return;
    case "strategy.refresh.requested":
      await runAsUser(job.userId, () => refreshStrategyJob());
      return;
    case "plan.roll.daily":
      // The scheduled reconcile is per-user work with no user on the message,
      // and enumerating accounts from here would need a query that reads across
      // tenants - the one thing RLS is set up to make impossible. Left
      // deliberately unimplemented rather than given a bypass; see aws/SPEC.md.
      console.info("plan.roll.daily received; no-op pending per-user fan-out");
      return;
    default: {
      // Exhaustiveness: adding a Job variant without a case here fails the
      // build rather than silently dropping that job type in production.
      const never: never = job;
      throw new Error(`Unknown job type: ${JSON.stringify(never)}`);
    }
  }
}

export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  // Partial batch failure. Without it a single poison message redelivers the
  // whole batch and every job in it invokes the model again - billed again.
  // Batch size is 1 today, so this is insurance against a future change to the
  // event source mapping rather than something exercised now.
  const failures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    const job = parse(record);
    if (!job) {
      // Unparseable: never retry. Three attempts at a message that will never
      // deserialise just delays it reaching the DLQ where someone can look.
      console.error("dropping unparseable message", record.messageId);
      continue;
    }
    try {
      await Promise.race([
        run(job),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`job ${job.type} exceeded ${MAX_JOB_MS}ms`)),
            MAX_JOB_MS,
          ),
        ),
      ]);
    } catch (err) {
      console.error(`job ${job.type} failed:`, err);
      failures.push({ itemIdentifier: record.messageId });
    }
  }

  // Close before returning, not on a `process.on("beforeExit")` that a frozen
  // environment never reaches. An open connection here would hold Aurora above
  // zero ACU indefinitely - the cost failure the whole scale-to-zero design
  // depends on avoiding, and what the taskbuddy-db-not-pausing alarm watches.
  await closePool();

  return { batchItemFailures: failures };
}
