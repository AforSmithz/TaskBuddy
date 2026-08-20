"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addCorrectiveTasks,
  addGoalCriterion,
  applyReroute,
  applyTaskModifications,
  commitRollingPlan,
  commitStrategyBundle,
  getValueModel,
  insertMoveChoice,
  createJointScorer,
  type JointScorer,
  confirmDraft,
  createPendingEntry,
  getEntry,
  createErrandTask,
  createGoal,
  createRecurringActivity,
  discardDraft,
  removeGoalCriterion,
  setGoalCriterionMet,
  setGoalKind,
  setSkillNodeAttained,
  setTriageItemDeferred,
  listAllSkillNodes,
  listConfirmedSkillTaskLinks,
  setSkillTaskLinkStatus,
  getJobRun,
  jobQuotaExceeded,
  DAILY_JOB_QUOTA,
  settleJobRun,
  startJobRun,
  listAllTasks,
  logActivityCompletion,
  logWorkSession,
  logCommitment,
  setAutoStrategy,
  setAvailability,
  setOverride,
  setProjectDeadline,
  setValueModel,
  setWindowAvailability,
  skipActivity,
  reorderToday,
  skipActivityForWeek,
  undoPlanRoll,
  undoPlanVersion,
  unskipActivity,
  updateRecurringActivity,
  updateTask,
  type NewActivityInput,
  type ReorderOutcome,
} from "@/lib/store";
import { buildEODSummary, type EODSummary } from "@/lib/generate";
import { skillProgress } from "@/lib/skill";
import {
  generateCorrectiveTasks,
  generateReroute,
  generateTaskModifications,
} from "@/lib/strategist";
import { interpretCheckin, resolveCheckin, proposeFromCheckin } from "@/lib/checkin";
import { SKILL_TASK_PREFIX, type ResolveInput } from "@/lib/portfolio-state";
import { requireUser } from "@/lib/auth";
import {
  decomposeGoalJob,
  extractEntryJob,
  generateFollowUpJob,
  refreshStrategyJob,
  suggestSkillLinksJob,
  type Job,
} from "@/lib/job-handlers";
import { isQueueConfigured, publish } from "@/lib/jobs";
import type { ValueModel } from "@/lib/value-model";
import type { WindowAvailability } from "@/lib/window-availability";
import type {
  CheckinCandidate,
  CheckinReview,
  CheckinScope,
  CompletionConfidence,
  SkillNode,
  SkillTaskLinkStatus,
  DegradedCriterion,
  DraftClassification,
  EntryKind,
  GoalKind,
  JobHandle,
  JobRun,
  ModificationSuggestion,
  OfferedMove,
  PitCall,
  PlanVersion,
  RecoverySuggestion,
  ReroutePart,
  RerouteSuggestion,
  StrategyMove,
  SuggestedTask,
  Task,
  TaskModification,
  TaskStatus,
  WorkSessionLocal,
} from "@/lib/types";
import { MOVE_CHOICE_SCHEMA_VERSION } from "@/lib/types";

// Server Actions - the single mutation layer for TaskBuddy.

export interface FormState {
  error: string | null;
}

/** Sentinel meaning "let TaskBuddy decide" - see entry-form.tsx. */
const AUTO = "__auto__";

/** Read a form field, treating the Auto sentinel and blanks as unset. */
function pick(formData: FormData, name: string): string | null {
  const value = String(formData.get(name) ?? "").trim();
  return value && value !== AUTO ? value : null;
}

function revalidatePaths() {
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath("/entries", "layout");
  revalidatePath("/projects", "layout");
  revalidatePath("/activities");
  // The strategist banner keys off capacity/odds, which activities change.
  revalidatePath("/strategy");
}

/** Runs after every mutation: roll the committed plan forward, then revalidate. Mutations are
 *  exactly the situation-changing events, so this is where the committed row is kept fresh -
 *  read paths only decide what to show and persist nothing. Best-effort: any failure is
 *  swallowed so a roll can't break the mutation that triggered it. Still called revalidateAll
 *  at the call sites for continuity with the old signature. */
async function revalidateAll() {
  try {
    await commitRollingPlan();
  } catch (err) {
    console.error("rolling-plan roll failed (non-fatal):", err);
  }
  revalidatePaths();
}

// --- The queue seam ---------------------------------------------------------
//
// Three actions below used to run a model call while the user waited; worst case measured 43
// seconds. They now publish an event and return, and job_runs is how the browser finds out
// what happened. See aws/README.md for what the queue buys beyond the wait: retries that
// outlive the request, failures that reach a DLQ, and an enforced concurrency cap.

/** Hand one long job to the queue, or run it here when there's no queue.
 *
 *  The inline path is NOT a safety fallback, it's the local dev path and the
 *  deployment-without-the-events-stack path. With no EVENT_BUS_NAME this runs exactly what the
 *  action ran before, in-request. job-handlers.ts holds the body either way so the two can't
 *  drift.
 *
 *  Chosen by whether a bus is CONFIGURED, never by whether a publish succeeded. Those are
 *  different failures - the first is a deployment shape, the second is an outage - and quietly
 *  answering an outage by running the model call in the web request would reintroduce the exact
 *  latency this removed, on the day the infrastructure is least healthy.
 *
 *  A failure on the inline path is RECORDED, not thrown: the caller is a useTransition in a
 *  client component, and a throw surfaces as a generic error boundary with no way back. A
 *  `failed` row renders the real message next to a retry button. */
async function enqueue(
  type: Job["type"],
  subjectId: string | null,
  toJob: (jobId: string) => Job,
  body: () => Promise<Record<string, unknown> | void>,
): Promise<JobHandle> {
  const { run, reused } = await startJobRun(type, subjectId);
  // Something is already in flight for this subject. Every one of these jobs is
  // a billed model call, and the strategy refresh is fired automatically on
  // mount by two separate pages, so joining the existing run matters.
  if (reused) {
    return {
      jobId: run.id,
      status: run.status,
      ranInline: false,
      result: run.result,
      error: run.error,
    };
  }

  // The spend ceiling. Checked here rather than before startJobRun for two reasons: a run that
  // JOINED an in-flight job costs nothing new and must not be refused (the strategy refresh
  // fires automatically on mount of two pages, so refusing it would surface a quota error on
  // every navigation once the limit was hit), and a refusal that is recorded as a `failed` row
  // renders its own reason next to the retry button instead of throwing into an error boundary.
  //
  // The refusal row counts toward the quota itself, which is deliberate: the limit is on
  // ATTEMPTS, so hammering the button while locked out does not get you a shorter lockout.
  if (await jobQuotaExceeded()) {
    const error =
      `That's ${DAILY_JOB_QUOTA} AI jobs in 24 hours, which is the daily limit on this ` +
      `account. It resets as the oldest ones age out.`;
    await settleJobRun(run.id, "failed", { error });
    return { jobId: run.id, status: "failed", ranInline: false, result: null, error };
  }

  // The test is "is there a bus", not "did the publish work". A publish that fails against a
  // bus that exists is an outage, and running a 43-second model call inside the web request is
  // exactly what this removed. Failing here is recoverable - the row records why.
  if (isQueueConfigured()) {
    if (await publish(toJob(run.id))) {
      return {
        jobId: run.id,
        status: "queued",
        ranInline: false,
        result: null,
        error: null,
      };
    }
    const error = "Could not queue that job. Try again in a moment.";
    await settleJobRun(run.id, "failed", { error });
    return { jobId: run.id, status: "failed", ranInline: false, result: null, error };
  }

  await settleJobRun(run.id, "running", {});
  try {
    const result = (await body()) ?? null;
    await settleJobRun(run.id, "succeeded", { result, error: null });
    await revalidateAll();
    return {
      jobId: run.id,
      status: "succeeded",
      ranInline: true,
      result,
      error: null,
    };
  } catch (err) {
    console.error(`job ${type} failed inline:`, err);
    const error = err instanceof Error ? err.message : String(err);
    await settleJobRun(run.id, "failed", { error });
    return { jobId: run.id, status: "failed", ranInline: true, result: null, error };
  }
}

/** Read one job's state - the poll the pending UI runs while it waits.
 *
 *  This is also where the async path gets its revalidation: a worker writes from a Lambda with
 *  no render pass, so nothing it does can invalidate a page on its own. The first poll that
 *  observes a finished job is inside a request that can, so it revalidates there.
 *
 *  Each watcher observes the terminal state once (it stops polling right after), so this is
 *  once per open tab watching the job, not once per tick. Two tabs on Today roll twice - the
 *  same shape the synchronous action had, and not worth adding coordination for. */
export async function pollJobRunAction(jobId: string): Promise<JobRun | null> {
  await requireUser();
  const run = await getJobRun(jobId);
  if (run?.status === "succeeded") await revalidateAll();
  return run;
}

/**
 * Create a draft entry from natural-language input, then redirect to its
 * review page so the user can accept/decline the extracted tasks.
 */
export async function createEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  const user = await requireUser();
  const kind: EntryKind =
    String(formData.get("mode")) === "plan" ? "plan" : "meeting";
  const notes = String(formData.get("notes") ?? "").trim();
  // Category may be left on Auto; when it is, TaskBuddy suggests one during
  // extraction and the user confirms it in the review step.
  const area = pick(formData, "area");
  const minLen = kind === "plan" ? 12 : 40;
  if (notes.length < minLen) {
    return {
      error:
        kind === "plan"
          ? "Please describe your goal in a little more detail."
          : "Please paste at least 40 characters of meeting notes.",
    };
  }

  const parentEntryId = pick(formData, "parentEntryId");
  const newProjectName = String(formData.get("newProjectName") ?? "").trim();
  // "Auto" means let TaskBuddy decide; "" means an explicit "No project";
  // anything else is an existing project's id.
  const rawProjectId = String(formData.get("projectId") ?? "");
  const autoProject = rawProjectId === AUTO;
  const existingProjectId =
    rawProjectId && rawProjectId !== AUTO ? rawProjectId : null;

  let entryId: string;
  try {
    let projectId = existingProjectId;
    if (newProjectName) {
      projectId = await createGoal(newProjectName);
    }
    const opts = {
      kind,
      area: area ?? undefined,
      projectId,
      autoProject: autoProject && !newProjectName,
    };
    // The row first, so the redirect below has somewhere real to land and the user's notes are
    // durable before any model call is attempted. Extraction fills it in from the queue.
    entryId = await createPendingEntry(notes, { ...opts, parentEntryId });
    await enqueue(
      "entry.extract.requested",
      entryId,
      (jobId) => ({
        type: "entry.extract.requested",
        userId: user.id,
        entryId,
        opts,
        jobId,
      }),
      () => extractEntryJob(entryId, opts),
    );
  } catch (err) {
    console.error("createEntry failed:", err);
    return {
      error:
        err instanceof Error
          ? err.message
          : "Something went wrong while processing your input.",
    };
  }

   // redirect() throws internally, so it must run outside the try/catch.
  redirect(`/entries/${entryId}/review`);
}

/** Re-run extraction over a draft that has none, or whose run failed.
 *
 *  Safe to fire more than once: replaceDraftExtraction replaces rather than appends, and the job
 *  refuses to touch an entry that is no longer a draft. The raw input is already on the row, so
 *  nothing needs re-sending. */
export async function retryExtractionAction(entryId: string): Promise<JobHandle> {
  const user = await requireUser();
  const entry = await getEntry(entryId);
  if (!entry) throw new Error("That entry no longer exists.");
  // The filing the create form chose is not recoverable from the row (area lives on tasks that
  // were never written), so a retry re-derives it: the explicit goal if the stub kept one, the
  // extractor's suggestion otherwise. Same rule the first attempt used when nothing was pinned.
  const opts = {
    kind: entry.kind,
    projectId: entry.goal_id,
    autoProject: entry.goal_id === null,
  };
  return enqueue(
    "entry.extract.requested",
    entryId,
    (jobId) => ({
      type: "entry.extract.requested",
      userId: user.id,
      entryId,
      opts,
      jobId,
    }),
    () => extractEntryJob(entryId, opts),
  );
}

/**
 * Confirm a draft: keep the accepted tasks, drop the declined ones, apply the
 * filing the user confirmed in the review step, and go live.
 */
export async function confirmDraftAction(
  entryId: string,
  declinedTaskIds: string[],
  classification: DraftClassification,
): Promise<void> {
  await requireUser();
  await confirmDraft(entryId, declinedTaskIds, classification);
  await revalidateAll();
  redirect(`/entries/${entryId}`);
}

export async function discardDraftAction(entryId: string): Promise<void> {
  await requireUser();
  await discardDraft(entryId);
  await revalidateAll();
  redirect("/create");
}

/** Move a task to a new status. Completing tags the completion with a confidence (manual
 *  checkbox = self_assessed, strategist = inferred, explicit verify = verified) and stamps
 *  completed_at; reopening clears both. */
export async function updateTaskStatusAction(
  taskId: string,
  status: TaskStatus,
  confidence: CompletionConfidence = "self_assessed",
  local?: WorkSessionLocal,
): Promise<void> {
  await requireUser();
  const patch: Partial<Task> =
    status === "done"
      ? { status, completion_confidence: confidence, completed_at: new Date().toISOString() }
      : // Reopening clears all done-provenance, incl. any blocker-resolution note.
        { status, completion_confidence: null, completed_at: null, resolved_by: null };
  await updateTask(taskId, patch);
  // Accrue the local when-signal for a genuine user completion. Inferred (strategist)
  // completions are excluded - there's no client clock to honestly stamp a window with.
  // minutes=0 because the real length lives on tasks.actual_minutes; this row only adds the
  // local window/weekday the UTC completed_at can't give.
  if (status === "done" && confidence !== "inferred" && local) {
    await logWorkSession({ taskId, minutes: 0, kind: "complete", local });
  }
  await revalidateAll();
}

/** Elevate an already-done task's completion to `verified` (keeps `completed_at`). */
export async function verifyTaskAction(taskId: string): Promise<void> {
  await requireUser();
  await updateTask(taskId, { completion_confidence: "verified" });
  await revalidateAll();
}

// --- Definition of done (goal criteria) -------------------------------------

export async function addGoalCriterionAction(
  goalId: string,
  text: string,
): Promise<void> {
  await requireUser();
  if (!text.trim()) return;
  await addGoalCriterion(goalId, text);
  await revalidateAll();
}

export async function setGoalCriterionMetAction(
  id: string,
  met: boolean,
  confidence: CompletionConfidence = "self_assessed",
): Promise<void> {
  await requireUser();
  await setGoalCriterionMet(id, met, met ? confidence : null);
  await revalidateAll();
}

/** Reclassify a goal as a project or a learning goal. */
export async function setGoalKindAction(
  goalId: string,
  kind: GoalKind,
): Promise<void> {
  await requireUser();
  await setGoalKind(goalId, kind);
  await revalidateAll();
}

/** Decompose a learning goal into a skill graph, replacing any prior plan. No-ops for project
 *  goals - their decomposition is the task DAG from extraction. The slowest job in the app at
 *  43 seconds measured, which is what made it the first one worth moving off the request path.
 *  Returns a handle to watch, not a finished plan. */
export async function decomposeGoalAction(goalId: string): Promise<JobHandle> {
  const user = await requireUser();
  return enqueue(
    "goal.decompose.requested",
    goalId,
    (jobId) => ({
      type: "goal.decompose.requested",
      userId: user.id,
      goalId,
      jobId,
    }),
    () => decomposeGoalJob(goalId),
  );
}

/** Propose skill-node <-> task links for a learning goal. Every proposal lands as `suggested`
 *  and does nothing until confirmed - spillover reads only confirmed edges. Pairs already on
 *  record in ANY status are excluded first, so a dismissed link is never re-proposed. */
export async function suggestSkillLinksAction(
  goalId: string,
): Promise<JobHandle> {
  const user = await requireUser();
  return enqueue(
    "goal.skill_links.requested",
    goalId,
    (jobId) => ({
      type: "goal.skill_links.requested",
      userId: user.id,
      goalId,
      jobId,
    }),
    // The count used to be this action's return value. It has nowhere to go now
    // that the action does not wait, so it rides the job row instead and the
    // card reads it from there.
    async () => ({ created: await suggestSkillLinksJob(goalId) }),
  );
}

/** Confirm a proposed link (it starts driving spillover) or dismiss it (never
 *  re-proposed). Reversible: the row survives either way. */
export async function setSkillLinkStatusAction(
  linkId: string,
  status: SkillTaskLinkStatus,
): Promise<void> {
  await requireUser();
  await setSkillTaskLinkStatus(linkId, status);
  await revalidateAll();
}

export async function setSkillAttainedAction(
  id: string,
  attained: boolean,
  confidence: CompletionConfidence = "self_assessed",
): Promise<void> {
  await requireUser();
  await setSkillNodeAttained(id, attained, attained ? confidence : null);
  await revalidateAll();
}

export async function removeGoalCriterionAction(id: string): Promise<void> {
  await requireUser();
  await removeGoalCriterion(id);
  await revalidateAll();
}

export async function updateTaskAreaAction(
  taskId: string,
  area: string,
): Promise<void> {
  await requireUser();
  await updateTask(taskId, { area });
  await revalidateAll();
}

/**
 * Defer a task past the current deadline (or restore it). Deferred tasks stop
 * counting against the forecast; reversible via `deferred: false`.
 */
export async function deferTaskAction(
  taskId: string,
  deferred: boolean,
): Promise<void> {
  await requireUser();
  await updateTask(taskId, { deferred });
  await revalidateAll();
}

/** Apply a pit-wall triage move in one shot: defer a batch of work. The batch may mix real
 *  tasks with skill lanes; setTriageItemDeferred routes each to the right persist. Reversible
 *  from the project's Deferred section, like a single defer. */
export async function applyTriageAction(taskIds: string[]): Promise<void> {
  await requireUser();
  await Promise.all(taskIds.map((id) => setTriageItemDeferred(id, true)));
  await revalidateAll();
}

/** Reverse a triage batch. Backs the pit wall's Undo on an auto-applied deferral, so an
 *  automatic move is never a one-way door. */
export async function undoTriageAction(taskIds: string[]): Promise<void> {
  await requireUser();
  await Promise.all(taskIds.map((id) => setTriageItemDeferred(id, false)));
  await revalidateAll();
}

/**
 * Push a task's due date (e.g. to clear an "overdue" flag). Note this does not
 * affect the completion forecast - only the project deadline + estimates do.
 */
export async function rescheduleTaskAction(
  taskId: string,
  dueDate: string,
): Promise<void> {
  await requireUser();
  await updateTask(taskId, { due_date: dueDate });
  await revalidateAll();
}

/** Clear a task's blocker and return it to the active queue. */
export async function unblockTaskAction(taskId: string): Promise<void> {
  await requireUser();
  await updateTask(taskId, { status: "todo", blocked_by: null });
  await revalidateAll();
}

export async function logActualTimeAction(
  taskId: string,
  minutes: number,
): Promise<void> {
  await requireUser();
  await updateTask(taskId, {
    actual_minutes: Math.max(0, Math.round(minutes)),
  });
  await revalidateAll();
}

// --- Time budget & forecast -------------------------------------------------

export async function setProjectDeadlineAction(
  projectId: string,
  deadline: string | null,
): Promise<void> {
  await requireUser();
  await setProjectDeadline(projectId, deadline || null);
  await revalidateAll();
}

/** Update the weekly availability template. */
export async function setAvailabilityAction(
  rows: { weekday: number; hours: number }[],
): Promise<void> {
  await requireUser();
  await setAvailability(rows);
  await revalidateAll();
}

/** Toggle pit-wall automation. On = auto-defer the obvious low-value doomed work and only
 *  escalate real ties. Revalidates so the pit wall re-renders in the chosen mode. */
export async function setAutoStrategyAction(value: boolean): Promise<void> {
  await requireUser();
  await setAutoStrategy(value);
  revalidatePath("/");
}

/** Save the Value Model. It re-weights the allocator's cost-of-delay and the strategist's move
 *  preference, so revalidate everywhere odds/order surface. Re-normalized server-side. */
export async function updateValueModelAction(model: ValueModel): Promise<void> {
  await requireUser();
  await setValueModel(model);
  await revalidateAll();
}

/** Save the explicit per-window availability. Overrides the derived share the windowed
 *  forecast uses, so revalidate everywhere odds/order surface. All-zero weights unset it. */
export async function updateWindowAvailabilityAction(
  avail: WindowAvailability,
): Promise<void> {
  await requireUser();
  await setWindowAvailability(avail);
  await revalidateAll();
}

/** Override deployable hours for one specific date. */
export async function setOverrideAction(
  date: string,
  hours: number,
): Promise<void> {
  await requireUser();
  await setOverride(date, hours);
  await revalidateAll();
}

/**
 * Log a commitment ("friends 6-9pm") and return the pit calls it triggers -
 * projects whose completion probability dropped, with recovery moves.
 */
export async function logCommitmentAction(
  date: string,
  hours: number,
  label: string | null,
): Promise<{ pitCalls: PitCall[]; error: string | null }> {
  await requireUser();
  try {
    const pitCalls = await logCommitment(date, hours, label);
    await revalidateAll();
    return { pitCalls, error: null };
  } catch (err) {
    console.error("logCommitment failed:", err);
    return {
      pitCalls: [],
      error: err instanceof Error ? err.message : "Failed to log commitment.",
    };
  }
}

/** Ask the strategist for net-new corrective tasks. Read-only - nothing is persisted until the
 *  user accepts. Null when there's no genuine gap or the LLM is unavailable. */
export async function suggestRecoveryTasksAction(
  projectId: string,
): Promise<RecoverySuggestion | null> {
  await requireUser();
  try {
    return await generateCorrectiveTasks(projectId);
  } catch (err) {
    console.error("suggestRecoveryTasks failed:", err);
    return null;
  }
}

/** Persist the corrective tasks the user accepted, then refresh the forecast. */
export async function acceptRecoveryTasksAction(
  projectId: string,
  tasks: SuggestedTask[],
): Promise<void> {
  await requireUser();
  await addCorrectiveTasks(projectId, tasks);
  await revalidateAll();
}

/** Ask the strategist to reshape existing tasks (scope down / split) to fit the budget.
 *  Read-only. Null when no reshape usefully improves the odds. */
export async function suggestModificationsAction(
  projectId: string,
): Promise<ModificationSuggestion | null> {
  await requireUser();
  try {
    return await generateTaskModifications(projectId);
  } catch (err) {
    console.error("suggestModifications failed:", err);
    return null;
  }
}

/** Apply the task reshapes the user accepted, then refresh the forecast. */
export async function applyModificationsAction(
  projectId: string,
  mods: TaskModification[],
): Promise<void> {
  await requireUser();
  await applyTaskModifications(projectId, mods);
  await revalidateAll();
}

/** Ask the strategist for a whole-plan re-route - a different approach to the same deliverable.
 *  Read-only. Null when no genuinely lighter route exists. */
export async function suggestRerouteAction(
  projectId: string,
): Promise<RerouteSuggestion | null> {
  await requireUser();
  try {
    return await generateReroute(projectId);
  } catch (err) {
    console.error("suggestReroute failed:", err);
    return null;
  }
}

/**
 * Switch the project to the accepted alternative plan: defer the current open
 * tasks and add the new approach's tasks, then refresh the forecast.
 */
export async function applyRerouteAction(
  projectId: string,
  replacedTaskIds: string[],
  tasks: ReroutePart[],
  degradedCriteria: DegradedCriterion[] = [],
): Promise<void> {
  await requireUser();
  await applyReroute(projectId, replacedTaskIds, tasks, degradedCriteria);
  await revalidateAll();
}

// --- Strategy bundles: snapshot-on-commit + undo ----------

/** Apply a strategy bundle (one move or a whole tier) as a single snapshotted unit - the one
 *  path every "Apply" button takes. Records a PlanVersion so the change is undoable whole and
 *  returns it so the card can offer an immediate Undo. */
export async function commitStrategyBundleAction(
  moves: StrategyMove[],
  oddsBefore: number,
  oddsAfter: number,
  reason: string,
  /** The moves that were on the table and the user UNCHECKED - the other half of "kept ≻
   *  declined". Passed ONLY by the whole-slate Apply, where declining is a real decision.
   *  Omitted by the per-row Apply (applying one move isn't a rejection of the rest) and by the
   *  check-in review, whose moves are asserted facts, not recovery taste. */
  declined?: StrategyMove[],
): Promise<PlanVersion> {
  await requireUser();
  const version = await commitStrategyBundle(moves, {
    oddsBefore,
    oddsAfter,
    reason,
  });
  if (declined !== undefined) await recordMoveChoice(moves, declined);
  await revalidateAll();
  return version;
}

/** Retain one offered-vs-kept observation for calibration. The φ inputs come off each move's
 *  baked-in `causes`, so this costs no scorer run. Best-effort: a bookkeeping failure must
 *  never surface on a bundle the user already applied successfully. */
async function recordMoveChoice(
  kept: StrategyMove[],
  declined: StrategyMove[],
): Promise<void> {
  // No contrast ⇒ nothing revealed ⇒ don't write a row the calibrator would skip.
  if (kept.length === 0 || declined.length === 0) return;
  try {
    const vm = await getValueModel();
    const offered: OfferedMove[] = [
      ...kept.map((m) => toOfferedMove(m, true)),
      ...declined.map((m) => toOfferedMove(m, false)),
    ];
    await insertMoveChoice({
      id: crypto.randomUUID(),
      capturedAt: new Date().toISOString(),
      recoveryStyle: vm.recoveryStyle,
      offered,
      schemaVersion: MOVE_CHOICE_SCHEMA_VERSION,
    });
  } catch {
    // swallowed: calibration is a nicety, the applied bundle is the contract
  }
}

function toOfferedMove(m: StrategyMove, kept: boolean): OfferedMove {
  return {
    kind: m.kind,
    projectId: m.projectId,
    // Absent on moves the optimizer didn't author ⇒ [] ⇒ a zero cause term, which
    // is exactly how an unknown cause already prices.
    causes: m.causes ?? [],
    kept,
  };
}

// --- NL check-in / reflection loop -------------------------------------

/** The serialized result the capture bar renders: the reviewable proposals + the
 *  client re-solve inputs (so Family-A toggles re-solve live, like the strategy
 *  card) + the base odds + which interpret path ran (for the subtle source hint). */
export interface CheckinRunResult {
  review: CheckinReview;
  resolveInput: ResolveInput;
  baseAllOnTime: number;
  source: "llm" | "heuristic";
  /** Deterministic end-of-day reflection (done / blocked / tomorrow's focus),
   *  shown beside the post-commit outcome summary as reflective context. Derived
   *  server-side; never computed client-side. */
  eod: EODSummary;
}

/** How many candidate entities the interpret prompt sees (the rest still resolve).
 *  Caps the prompt, not the resolution blast radius. */
const CHECKIN_PROMPT_CAP = 60;

/** Derive the check-in candidate set from the already-computed joint scorer - open tasks and
 *  the unattained skill frontier are ALREADY in resolveInput.tasks, so this re-gathers nothing.
 *  Handles are stable within a run (T#/S#/A#). */
function checkinCandidates(scorer: JointScorer): {
  candidates: CheckinCandidate[];
  skillNodes: CheckinCandidate[];
} {
  const candidates: CheckinCandidate[] = [];
  const skillNodes: CheckinCandidate[] = [];
  let t = 0;
  let s = 0;
  for (const task of scorer.resolveInput.tasks) {
    if (task.id.startsWith(SKILL_TASK_PREFIX)) {
      const node: CheckinCandidate = {
        handle: `S${++s}`,
        type: "skill_node",
        id: task.id.slice(SKILL_TASK_PREFIX.length),
        title: task.title,
        goalId: task.projectId,
        goalName: task.projectName,
      };
      candidates.push(node);
      skillNodes.push(node);
    } else {
      candidates.push({
        handle: `T${++t}`,
        type: "task",
        id: task.id,
        title: task.title,
        goalId: task.projectId,
        goalName: task.projectName,
      });
    }
  }
  scorer.activities.forEach((a, i) => {
    candidates.push({
      handle: `A${i + 1}`,
      type: "activity",
      id: a.id,
      title: a.title,
      goalId: "",
      goalName: a.area,
    });
  });
  return { candidates, skillNodes };
}

/** The unlocked frontier across every learning goal. skillProgress reasons about ONE goal's
 *  graph (attainedIds is goal-local), so group first - a flat call would let one goal's
 *  attainments unlock another's nodes. This is what inferred attainment is confined to. */
function unlockedFrontier(allNodes: SkillNode[]): ReadonlySet<string> {
  const byGoal = new Map<string, SkillNode[]>();
  for (const n of allNodes) {
    const list = byGoal.get(n.goal_id);
    if (list) list.push(n);
    else byGoal.set(n.goal_id, [n]);
  }
  const unlocked = new Set<string>();
  for (const nodes of byGoal.values()) {
    for (const id of skillProgress(nodes).unlocked) unlocked.add(id);
  }
  return unlocked;
}

/** Put the scoped goal's own entities first before the cap - the scope is the disambiguation.
 *  Resolution still runs against the FULL set, so this only biases what the model SEES, never
 *  the blast radius. Stable partition, so the un-scoped ordering is intact. */
function rankForScope(
  candidates: CheckinCandidate[],
  scope: CheckinScope | undefined,
): CheckinCandidate[] {
  if (!scope) return candidates;
  const inScope = candidates.filter((c) => c.goalId === scope.goalId);
  const rest = candidates.filter((c) => c.goalId !== scope.goalId);
  return [...inScope, ...rest];
}

/** Run interpret -> resolve -> propose over a free-form check-in. The review/commit half is the
 *  existing bundle machinery. No mutation happens here, it's read-only interpretation.
 *
 *  `scope` binds the check-in to one goal: its entities rank first in the prompt, and an
 *  add_task intent becomes an add_tasks move on that goal instead of a standalone capture. */
export async function runCheckinAction(
  rawReport: string,
  scope?: CheckinScope,
): Promise<CheckinRunResult> {
  await requireUser();
  const report = rawReport.trim();
  const [scorer, tasks, links, allNodes] = await Promise.all([
    createJointScorer(),
    listAllTasks(),
    // Only CONFIRMED edges - a suggested link is inert until the user says yes.
    listConfirmedSkillTaskLinks(),
    listAllSkillNodes(),
  ]);
  const { candidates, skillNodes } = checkinCandidates(scorer);
  const unlockedNodeIds = unlockedFrontier(allNodes);

  const { result, source } = await interpretCheckin(
    report,
    // Cap what the model SEES (scope-ranked), resolve against the full set below.
    rankForScope(candidates, scope).slice(0, CHECKIN_PROMPT_CAP),
  );
  const resolved = resolveCheckin(result, candidates);
  const review = proposeFromCheckin(
    resolved,
    {
      today: scorer.resolveInput.today,
      baseAllOnTime: scorer.baseAllOnTime,
      cumulative: scorer.cumulative,
      scope,
      // 6b - the live structural DAG, so a completed/resolved intent on a blocker
      // promotes to a cascade (chosen by graph role, not the model).
      deps: scorer.resolveInput.deps,
      // Confirmed skill↔task edges + the candidate set, so linked spillover can credit
      // the far side of an edge in either direction.
      links,
      candidates,
      // Inference may only credit the unlocked frontier (both spillover tiers).
      unlockedNodeIds,
    },
    skillNodes,
  );
  review.rawReport = result.rawReport;

  return {
    review,
    resolveInput: scorer.resolveInput,
    baseAllOnTime: scorer.baseAllOnTime,
    source,
    eod: buildEODSummary(tasks),
  };
}

/** Revert one applied bundle whole: restore its snapshot, then refresh. */
export async function undoPlanVersionAction(id: string): Promise<void> {
  await requireUser();
  await undoPlanVersion(id);
  await revalidateAll();
}

/** Undo one automatic roll: restore the arrangement it superseded through reconcile + re-price
 *  (never a row restore), then refresh. The revalidateAll roll fires under the current
 *  fingerprint so it stays put and the restore holds against the stability gate. */
export async function undoPlanRollAction(id: string): Promise<void> {
  await requireUser();
  await undoPlanRoll(id);
  await revalidateAll();
}

/** Honor a drag-to-reorder of today's plan: commit the dragged order as a preference seed and,
 *  when it's odds-neutral, accrue it as a calibration observation. A deliberate drag is always
 *  honored - the returned oddsCost tells the client whether to show the "this costs some odds"
 *  note. */
export async function reorderTodayAction(
  date: string,
  orderedTaskIds: string[],
): Promise<ReorderOutcome> {
  await requireUser();
  const outcome = await reorderToday(date, orderedTaskIds);
  await revalidateAll();
  return outcome;
}

/** Regenerate the portfolio strategy and cache it - the only trigger that runs the synthesis
 *  LLM. Both "Am I on track?" and the stale-banner Refresh call this; the load paths never do.
 *  Passes the previous strategy for time-drift continuity. */
export async function refreshPortfolioStrategyAction(): Promise<JobHandle> {
  const user = await requireUser();
  return enqueue(
    "strategy.refresh.requested",
    // Portfolio-wide: there is no subject, and the null is load-bearing - the
    // partial unique index is declared `nulls not distinct` precisely so this
    // job still gets the one-live-run guard the others get from their goal id.
    null,
    (jobId) => ({ type: "strategy.refresh.requested", userId: user.id, jobId }),
    () => refreshStrategyJob(),
  );
}

/** Draft the follow-up message for an entry. Returns a handle to watch, not the message: the
 *  draft comes back on the job row, because the web function has no Bedrock permission and
 *  could not finish inside its 60s timeout if it did. */
export async function generateFollowUpAction(entryId: string): Promise<JobHandle> {
  const user = await requireUser();
  return enqueue(
    "entry.follow_up.requested",
    entryId,
    (jobId) => ({
      type: "entry.follow_up.requested",
      userId: user.id,
      entryId,
      jobId,
    }),
    () => generateFollowUpJob(entryId),
  );
}

// --- Recurring activities (routines & goals) + errands ----------------------

export async function createActivityAction(
  input: NewActivityInput,
): Promise<void> {
  await requireUser();
  await createRecurringActivity(input);
  await revalidateAll();
}

/** Patch a recurring activity (edit fields). */
export async function updateActivityAction(
  id: string,
  patch: Parameters<typeof updateRecurringActivity>[1],
): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, patch);
  await revalidateAll();
}

/** Toggle whether the strategist may auto-sacrifice this activity. */
export async function setActivityProtectedAction(
  id: string,
  isProtected: boolean,
): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, { protected: isProtected });
  await revalidateAll();
}

export async function archiveActivityAction(id: string): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, { active: false });
  await revalidateAll();
}

export async function logActivityCompletionAction(
  activityId: string,
  minutes?: number,
  local?: WorkSessionLocal,
): Promise<void> {
  await requireUser();
  await logActivityCompletion(activityId, undefined, minutes);
  // S2 slice B: a routine session is a real, discrete work session - accrue it with
  // its local window/weekday + length (the when-signal slice C's energy reads need).
  if (local) {
    await logWorkSession({ activityId, minutes: minutes ?? 0, kind: "complete", local });
  }
  await revalidateAll();
}

export async function skipActivityAction(
  activityId: string,
  date?: string,
): Promise<void> {
  await requireUser();
  await skipActivity(activityId, date);
  await revalidateAll();
}

/** Undo a skip. */
export async function unskipActivityAction(
  activityId: string,
  date?: string,
): Promise<void> {
  await requireUser();
  await unskipActivity(activityId, date);
  await revalidateAll();
}

/** Apply a strategist `skip_activity` move: skip the activity for the rest of
 *  this week, freeing its hours for at-risk deadlines. */
export async function skipActivityForWeekAction(
  activityId: string,
): Promise<void> {
  await requireUser();
  await skipActivityForWeek(activityId);
  await revalidateAll();
}

/** Quick-add a one-off errand (a plain task under the reserved Errands project). */
export async function quickAddErrandAction(
  title: string,
  dueDate?: string | null,
  estimatedMinutes?: number,
): Promise<void> {
  await requireUser();
  if (!title.trim()) return;
  await createErrandTask(title, dueDate ?? null, estimatedMinutes ?? 30);
  await revalidateAll();
}
