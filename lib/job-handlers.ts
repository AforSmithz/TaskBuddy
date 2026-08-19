import "server-only";
import { decomposeLearningGoal } from "./decompose";
import { generatePortfolioStrategy } from "./portfolio-strategist";
import { pairKey, suggestSkillTaskLinks } from "./skill-links";
import {
  getCachedStrategy,
  getGoal,
  insertSuggestedLinks,
  listAllTasks,
  listSkillNodes,
  listSkillTaskLinksForGoal,
  replaceSkillNodes,
  setCachedStrategy,
} from "./store";

// The body of every long-running job, with no runtime attached.
//
// WHY THIS MODULE EXISTS. Each of these was the middle of a Server Action:
// `requireUser()`, then some store reads, then a model call, then a write, then
// `revalidatePath()`. Only the middle is portable - `requireUser` needs a
// cookie and `revalidatePath` needs a render pass, and an SQS worker has
// neither. Extracting the middle means the queue and the request path provably
// execute the SAME code rather than two implementations that drift.
//
// NOTHING HERE IMPORTS `next/cache` OR `next/headers`. That is the constraint
// that keeps the module loadable in a plain Lambda bundle; adding either would
// break the workers at cold start with a module-resolution error rather than at
// review time. The caller supplies the runtime concerns: the action revalidates
// after calling in, the worker does not.
//
// The user is established by the caller too - `lib/db/context.ts` `runAsUser`
// in the worker, the session cookie in Next - so every store call below resolves
// through the same RLS-scoped client either way.

/**
 * Every job the queue understands. The worker's switch is exhaustive over this.
 *
 * `jobId` is the row in `job_runs` this message settles - the only channel a
 * worker has back to the browser, since it has no render pass and no session.
 * It is OPTIONAL on purpose. The web function and the worker are separate
 * Lambdas in separate stacks and `cdk deploy` updates them seconds apart, so a
 * message published by the older web code arrives at the newer worker with no
 * jobId. Requiring one would make those messages unparseable, and an
 * unparseable message is DELETED rather than retried - the user's decompose
 * would silently never happen. Missing means "run the work, skip the
 * bookkeeping", which costs a status row and nothing else.
 *
 * `plan.roll.daily` carries neither: EventBridge Scheduler sends a fixed
 * payload on a timer, with no user and nobody watching a page.
 */
export type Job =
  | { type: "goal.decompose.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "goal.skill_links.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "strategy.refresh.requested"; userId: string; jobId?: string }
  | { type: "plan.roll.daily" };

/** The jobs a user starts and watches - everything except the scheduled roll. */
export type UserJob = Exclude<Job, { type: "plan.roll.daily" }>;

/**
 * Break a learning goal into skill nodes.
 *
 * The measured worst case on the previous provider was 43 seconds, which is
 * what made this the first job worth moving off the request path.
 */
export async function decomposeGoalJob(goalId: string): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal || goal.kind !== "learning") return;
  const skills = await decomposeLearningGoal(goal.name, goal.description);
  await replaceSkillNodes(goalId, skills);
}

/**
 * Propose skill-node to task links for a learning goal.
 *
 * Every proposal lands as `suggested` and does nothing until confirmed -
 * spillover reads only confirmed edges. Pairs already on record in ANY status
 * are excluded before the call, so a dismissed link is never re-proposed.
 *
 * THIS IS THE JOB THE QUEUE ACTUALLY FIXES, not merely relocates.
 * `filterVerified` inside `suggestSkillTaskLinks` judges each pair with an
 * isolated model call and fails CLOSED - a judgement that errors drops the
 * pair. In-process that means a burst of throttles silently deletes good
 * suggestions and reports success. Run from the worker, the same burst is a
 * retry; run through the Distributed Map in aws/infra/lib/events-stack.ts, each
 * pair retries on its own schedule and a pair that still fails is recorded
 * rather than quietly discarded.
 */
export async function suggestSkillLinksJob(goalId: string): Promise<number> {
  const goal = await getGoal(goalId);
  if (!goal || goal.kind !== "learning") return 0;

  const [nodes, tasks, existing] = await Promise.all([
    listSkillNodes(goalId),
    listAllTasks(),
    listSkillTaskLinksForGoal(goalId),
  ]);
  const existingPairs = new Set(
    existing.map((l) => pairKey(l.skill_node_id, l.task_id)),
  );

  const proposed = await suggestSkillTaskLinks(nodes, tasks, existingPairs);
  const created = await insertSuggestedLinks(proposed);
  return created.length;
}

/** Regenerate the cross-goal portfolio strategy. */
export async function refreshStrategyJob(): Promise<void> {
  const prev = await getCachedStrategy();
  const strategy = await generatePortfolioStrategy(prev);
  await setCachedStrategy(strategy);
}
