import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { runAsUser } from "@/lib/db/context";
import { closePool } from "@/lib/db/pool";
import {
  decomposeGoalJob,
  extractEntryJob,
  generateFollowUpJob,
  refreshStrategyJob,
  suggestSkillLinksJob,
  type Job,
  type UserJob,
} from "@/lib/job-handlers";
import { claimJobRun, settleJobRun } from "@/lib/store";

/**
 * The LLM worker - jobs too slow to sit inside a request.
 *
 * It runs the application's own code: everything below runAsUser is lib/job-handlers.ts,
 * bundled straight out of lib/, so there's no worker-side reimplementation of decomposition or
 * strategy generation to drift out of step with the request path. This file only adds the
 * runtime: who the job is for, what to do when it fails, and how the browser finds out.
 *
 * There's no cookie here, so the user comes from the message body and is installed with
 * AsyncLocalStorage. Not a style choice over a module-scope variable: a Lambda execution
 * environment is REUSED, so a plain `let currentUid` would survive between invocations, and the
 * failure mode is the worst one in this codebase - job B running as job A's user, writing one
 * account's data into another's.
 *
 * A worker has no render pass and no session, so the only channel back to the page is the
 * job_runs row named by jobId. Every status write happens inside runAsUser, because that row is
 * RLS-scoped like everything else and is invisible outside that scope.
 */

const MAX_JOB_MS = 240_000;

/** Deliveries before SQS routes this to the DLQ. Must equal the queue's maxReceiveCount, which
 *  is why both read WORKER_MAX_RECEIVE_COUNT and this only reads the env var it sets. Too low
 *  and a transient throttle is reported as a permanent failure while SQS is still retrying; too
 *  high and a job already in the DLQ sits on the page as "retrying" forever. */
const MAX_ATTEMPTS = Number(process.env.MAX_RECEIVE_COUNT ?? 3);

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
    // A user-scoped job with no user is a producer bug: it can never be run
    // correctly, and retrying it three times only delays someone noticing. A
    // missing `jobId` is NOT treated the same way - see the Job type.
    if (job.type !== "plan.roll.daily" && typeof job.userId !== "string") {
      return null;
    }
    return job;
  } catch {
    return null;
  }
}

/** Which delivery this is, 1-based. record.attributes is typed non-optional by
 *  @types/aws-lambda, but the harness builds records by cast and a real malformed record would
 *  take the whole batch down here rather than at the check it was meant to fail. */
export function attemptOf(record: SQSRecord): number {
  const raw = Number(record.attributes?.ApproximateReceiveCount ?? "1");
  return Number.isFinite(raw) && raw >= 1 ? raw : 1;
}

/** True when SQS won't deliver this message again. `>=`, not `>`: the count is 1 on first
 *  delivery and SQS moves a message to the DLQ on the receive that would exceed maxReceiveCount,
 *  so the third delivery of a 3-attempt queue is the last time we ever see it. */
export function isFinalAttempt(
  attempt: number,
  maxAttempts: number = MAX_ATTEMPTS,
): boolean {
  return attempt >= maxAttempts;
}

/** The body for one user-scoped job, and the result the UI needs from it. */
function bodyFor(job: UserJob): () => Promise<Record<string, unknown> | void> {
  switch (job.type) {
    case "goal.decompose.requested":
      return () => decomposeGoalJob(job.goalId);
    case "goal.skill_links.requested":
      // The count used to be the Server Action's return value; it rides the job
      // row now, because the action no longer waits around to receive it.
      return async () => ({ created: await suggestSkillLinksJob(job.goalId) });
    case "strategy.refresh.requested":
      return () => refreshStrategyJob();
    case "entry.extract.requested":
      // The heaviest of these and the one the user is actively waiting on: the
      // review page they were redirected to is empty until this lands.
      return () => extractEntryJob(job.entryId, job.opts);
    case "entry.follow_up.requested":
      // The draft is the whole point of the job, so it rides the row rather
      // than a write - see generateFollowUpJob.
      return () => generateFollowUpJob(job.entryId);
    default: {
      // Exhaustiveness: adding a Job variant without a case here fails the
      // build rather than silently dropping that job type in production.
      const never: never = job;
      throw new Error(`Unknown job type: ${JSON.stringify(never)}`);
    }
  }
}

/** A timeout that cleans up after itself. The cancel matters in Lambda specifically: an
 *  execution environment is frozen between invocations rather than torn down, so a 240-second
 *  timer left armed by a job that finished in two is still pending when the next one thaws. */
function rejectAfter(
  ms: number,
  type: string,
): { promise: Promise<never>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`job ${type} exceeded ${ms}ms`)), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

/** Record a job's terminal state without letting that write replace the reason it failed. If the
 *  status write throws - Aurora resuming past the connect timeout, the row cascade-deleted with
 *  its user - the DLQ message and the log line would otherwise read "job_runs settle failed" and
 *  the actual Bedrock or schema error would be gone. */
async function settleQuietly(
  jobId: string,
  finalAttempt: boolean,
  cause: unknown,
): Promise<void> {
  try {
    const message = cause instanceof Error ? cause.message : String(cause);
    await settleJobRun(jobId, finalAttempt ? "failed" : "retrying", {
      error: message,
    });
  } catch (writeErr) {
    console.error(`could not record job ${jobId} status:`, writeErr);
  }
}

async function run(job: Job, finalAttempt: boolean): Promise<void> {
  if (job.type === "plan.roll.daily") {
    // The scheduled reconcile is per-user work with no user on the message,
    // and enumerating accounts from here would need a query that reads across
    // tenants - the one thing RLS is set up to make impossible. Left
    // deliberately unimplemented rather than given a bypass; see aws/SPEC.md.
    console.info("plan.roll.daily received; no-op pending per-user fan-out");
    return;
  }

  const { jobId } = job;
  await runAsUser(job.userId, async () => {
  // Claim before running. A worker killed by its function timeout leaves the message
  // undeleted, so the same job comes back - and re-running a body whose writes already
  // committed is destructive, not just wasteful: replaceSkillNodes wipes and rewrites a goal's
  // whole skill graph. An already-terminal row means someone finished this.
    if (jobId && !(await claimJobRun(jobId))) {
      console.info(`job ${jobId} already settled; skipping redelivery`);
      return;
    }
    try {
    // The timeout races INSIDE the ambient-user scope so its rejection is caught by the same
    // block that owns the status write. Outside it, getRequestClient() finds no ambient user,
    // falls through to the cookie path and throws, stranding the row in `running` forever.
      //
      // The loser of this race isn't cancelled - there's no cancellation primitive here. A body
      // that outlives the timeout can still commit its writes, which is why the claim above
      // exists and why `failed` is never proof that nothing was written.
      const timeout = rejectAfter(MAX_JOB_MS, job.type);
      const result =
        (await Promise.race([bodyFor(job)(), timeout.promise]).finally(
          timeout.cancel,
        )) ?? null;
      // `error: null` clears whatever a previous failed attempt wrote, so a job
      // that succeeds on redelivery does not keep rendering the old failure.
      if (jobId) await settleJobRun(jobId, "succeeded", { result, error: null });
    } catch (err) {
      if (jobId) await settleQuietly(jobId, finalAttempt, err);
      // Rethrown unchanged: the handler needs the real error to decide the
      // batch item failed, and the DLQ needs it to be diagnosable.
      throw err;
    }
  });
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
      await run(job, isFinalAttempt(attemptOf(record)));
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
