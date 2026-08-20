import "server-only";
import {
  CHECKIN_PROMPT_CAP,
  checkinCandidates,
  interpretCheckin,
  rankForScope,
  resolveCheckin,
} from "@/lib/checkin";
import { decomposeLearningGoal } from "@/lib/decompose";
import { generateFollowUp } from "@/lib/generate";
import { generatePortfolioStrategy } from "@/lib/portfolio-strategist";
import { pairKey, suggestSkillTaskLinks } from "@/lib/skill-links";
import {
  generateCorrectiveTasks,
  generateReroute,
  generateTaskModifications,
} from "@/lib/strategist";
import type {
  CheckinScope,
  ModificationSuggestion,
  RecoverySuggestion,
  ResolvedCheckinIntent,
  RerouteSuggestion,
} from "@/lib/types";
import {
  assembleEntry,
  createJointScorer,
  getCachedStrategy,
  getEntry,
  getGoal,
  replaceDraftExtraction,
  type AssembleOptions,
  insertSuggestedLinks,
  listAllTasks,
  listSkillNodes,
  listSkillTaskLinksForGoal,
  replaceSkillNodes,
  setCachedStrategy,
} from "@/lib/store";

// The body of every long-running job, with no runtime attached.
//
// Each of these was the middle of a Server Action: requireUser(), some store reads, a model
// call, a write, revalidatePath(). Only the middle is portable - requireUser() needs a cookie and
// revalidatePath() needs a render pass, and an SQS worker has neither. Extracting the middle means
// the queue and the request path provably run the SAME code rather than two that drift.
//
// Nothing here imports next/cache or next/headers. That's what keeps the module loadable in a
// plain Lambda bundle; adding either would break the workers at cold start with a
// module-resolution error rather than at review time. The caller supplies the runtime concerns,
// including the user - runAsUser in the worker, the session cookie in Next - so every store call
// resolves through the same RLS-scoped client either way.

/** Every job the queue understands; the worker's switch is exhaustive over this.
 *
 *  `jobId` is the job_runs row this message settles - the only channel a worker has back to the
 *  browser. It's OPTIONAL on purpose: the web function and the worker are separate Lambdas in
 *  separate stacks and cdk deploy updates them seconds apart, so a message published by older
 *  web code arrives at the newer worker with no jobId. Requiring one would make those messages
 *  unparseable, and an unparseable message is DELETED rather than retried - the user's decompose
 *  would silently never happen. Missing means "run the work, skip the bookkeeping".
 *
 *  plan.roll.daily carries neither: Scheduler sends a fixed payload on a timer, with no user and
 *  nobody watching a page. */
export type Job =
  | { type: "goal.decompose.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "goal.skill_links.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "strategy.refresh.requested"; userId: string; jobId?: string }
  | { type: "entry.follow_up.requested"; userId: string; entryId: string; jobId?: string }
  | {
      type: "entry.extract.requested";
      userId: string;
      entryId: string;
      /** The filing the user chose on the create form. Not on the entry row: `area` belongs to
       *  the tasks, which do not exist yet, and `autoProject` is a question rather than a value.
       *  Small, and re-read on every redelivery, which is what keeps a retry identical. */
       opts: Pick<AssembleOptions, "kind" | "area" | "projectId" | "autoProject">;
      jobId?: string;
    }
  | {
      type: "checkin.submitted";
      userId: string;
      report: string;
      /** Present when the check-in was typed on a goal's page rather than the Today bar. */
      scope?: CheckinScope;
      jobId?: string;
    }
  | { type: "strategy.recovery_tasks.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "strategy.modifications.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "strategy.reroute.requested"; userId: string; goalId: string; jobId?: string }
  | { type: "plan.roll.daily" };

/** The jobs a user starts and watches - everything except the scheduled roll. */
export type UserJob = Exclude<Job, { type: "plan.roll.daily" }>;

/** Break a learning goal into skill nodes. Worst case measured at 43 seconds, which is what made
 *  this the first job worth moving off the request path. */
export async function decomposeGoalJob(goalId: string): Promise<void> {
  const goal = await getGoal(goalId);
  if (!goal || goal.kind !== "learning") return;
  const skills = await decomposeLearningGoal(goal.name, goal.description);
  await replaceSkillNodes(goalId, skills);
}

/** Propose skill-node to task links for a learning goal. Every proposal lands as `suggested` and
 *  does nothing until confirmed; pairs already on record in any status are excluded first.
 *
 *  This is the job the queue actually FIXES rather than merely relocates. filterVerified judges
 *  each pair with an isolated model call and fails CLOSED, so in-process a burst of throttles
 *  silently deletes good suggestions and reports success. From the worker the same burst is a
 *  retry, and through the Distributed Map each pair retries on its own schedule and a pair that
 *  still fails is recorded rather than quietly discarded. */
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

/** Draft the follow-up message for one entry.
 *
 *  The odd one out among these jobs: it writes NOTHING. The message is a draft the user copies
 *  or discards, so persisting it would mean a table, a staleness question every time the entry's
 *  tasks change, and a migration - for a string that is worth less than the tasks it summarises.
 *  It rides `job_runs.result` instead, exactly as the link proposer's count does, and a reload
 *  after a settled run is meant to lose it.
 *
 *  Never throws for a model failure: generateFollowUp catches its own and returns the template
 *  version, so a `failed` row here means the ENTRY read failed, which is worth showing. */
export async function generateFollowUpJob(
  entryId: string,
): Promise<{ message: string | null }> {
  const entry = await getEntry(entryId);
  // Deleted between enqueue and delivery. Succeeding with a null message is right: there is
  // nothing to draft and nothing broken, and a `failed` row would offer a retry that can only
  // fail the same way.
  if (!entry) return { message: null };
  return { message: await generateFollowUp(entry) };
}


/** Extract a draft: run the model over the raw input the stub row is already holding, then write
 *  the result over that row.
 *
 *  The entry exists before this runs (createPendingEntry), so the user is looking at its review
 *  page the whole time. That ordering is the reason the raw input is never at risk: this job can
 *  fail, be retried, or be re-run by hand, and the worst case is a draft that still needs
 *  extracting rather than lost notes.
 *
 *  Guarded on `draft`. A redelivery that arrives after the user has already confirmed must not
 *  replace the tasks they accepted - replaceDraftExtraction would happily do exactly that. */
export async function extractEntryJob(
  entryId: string,
  opts: Pick<AssembleOptions, "kind" | "area" | "projectId" | "autoProject">,
): Promise<{ tasks: number } | void> {
  const entry = await getEntry(entryId);
  if (!entry) return;
  if (entry.status !== "draft") return { tasks: entry.tasks.length };

  const assembled = await assembleEntry(entry.raw_input, {
    ...opts,
    entryId,
    status: "draft",
    parentEntryId: entry.parent_entry_id,
    createdAt: entry.created_at,
  });
  await replaceDraftExtraction(entryId, assembled);
  return { tasks: assembled.tasks.length };
}


/** Interpret a free-form check-in and GROUND it: stages A and B, never A alone.
 *
 *  The seam is here and not one stage earlier because a handle (`T3`, `S1`, `A2`) is an INDEX
 *  into the candidate list that produced it. Shipping raw handles to a second request would let
 *  a task completed in the meantime shift every handle after it, and stage B would bind the
 *  user's quote to the neighbouring task - silently, and with a pre-checked box. Resolving in
 *  the same process that built that list turns handles into stable DB ids before anything
 *  crosses, so the worst a stale result can be is a proposal about work that has moved on.
 *
 *  Stage C stays in the request (proposeFromCheckin) because it prices every Family-A move
 *  against the joint forecast, and those odds should be the ones the user is looking at rather
 *  than the ones from whenever the queue got round to this.
 *
 *  Never throws for a model failure: interpretCheckin catches its own and falls back to the
 *  offline parser, so a `failed` row here means the gather itself failed. */
export async function interpretCheckinJob(
  report: string,
  scope?: CheckinScope,
): Promise<{
  resolved: ResolvedCheckinIntent[];
  rawReport: string;
  source: "llm" | "heuristic";
}> {
  const scorer = await createJointScorer();
  const { candidates } = checkinCandidates(scorer);
  const { result, source } = await interpretCheckin(
    report,
    // Cap what the model SEES (scope-ranked); resolution runs against the full set below.
    rankForScope(candidates, scope).slice(0, CHECKIN_PROMPT_CAP),
  );
  return {
    resolved: resolveCheckin(result, candidates),
    rawReport: result.rawReport,
    source,
  };
}

/** Ask the strategist for net-new corrective tasks. Read-only: nothing is persisted, the user
 *  accepts explicitly.
 *
 *  All three strategist jobs wrap their suggestion in an object rather than returning it bare.
 *  `job_runs.result` is nullable and null already means "this job returned nothing", so a bare
 *  null could not be told apart from a row that has not been written yet - and "the strategist
 *  found no genuine gap" is a real, renderable answer, not an absence. */
export async function suggestRecoveryTasksJob(
  goalId: string,
): Promise<{ suggestion: RecoverySuggestion | null }> {
  return { suggestion: await generateCorrectiveTasks(goalId) };
}

/** Ask the strategist to reshape existing tasks (scope down / split) to fit the budget. */
export async function suggestModificationsJob(
  goalId: string,
): Promise<{ suggestion: ModificationSuggestion | null }> {
  return { suggestion: await generateTaskModifications(goalId) };
}

/** Ask the strategist for a whole-plan re-route - a different approach to the same
 *  deliverable. */
export async function suggestRerouteJob(
  goalId: string,
): Promise<{ suggestion: RerouteSuggestion | null }> {
  return { suggestion: await generateReroute(goalId) };
}
