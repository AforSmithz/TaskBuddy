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
  createJointScorer,
  type JointScorer,
  confirmDraft,
  createDraft,
  createErrandTask,
  createGoal,
  createRecurringActivity,
  discardDraft,
  getGoal,
  removeGoalCriterion,
  replaceSkillNodes,
  setGoalCriterionMet,
  setGoalKind,
  setSkillNodeAttained,
  getCachedStrategy,
  getEntry,
  listAllTasks,
  logActivityCompletion,
  logWorkSession,
  logCommitment,
  setAutoStrategy,
  setAvailability,
  setCachedStrategy,
  setOverride,
  setProjectDeadline,
  setValueModel,
  setWindowAvailability,
  skipActivity,
  skipActivityForWeek,
  undoPlanVersion,
  unskipActivity,
  updateRecurringActivity,
  updateTask,
  type NewActivityInput,
} from "./store";
import { buildEODSummary, generateFollowUp, type EODSummary } from "./generate";
import { decomposeLearningGoal } from "./decompose";
import {
  generateCorrectiveTasks,
  generateReroute,
  generateTaskModifications,
} from "./strategist";
import { generatePortfolioStrategy } from "./portfolio-strategist";
import { interpretCheckin, resolveCheckin, proposeFromCheckin } from "./checkin";
import { SKILL_TASK_PREFIX, type ResolveInput } from "./portfolio-state";
import { requireUser } from "./auth";
import type { ValueModel } from "./value-model";
import type { WindowAvailability } from "./window-availability";
import type {
  CheckinCandidate,
  CheckinReview,
  CheckinScope,
  CompletionConfidence,
  DegradedCriterion,
  DraftClassification,
  EntryKind,
  GoalKind,
  ModificationSuggestion,
  PitCall,
  PlanVersion,
  PortfolioStrategy,
  RecoverySuggestion,
  ReroutePart,
  RerouteSuggestion,
  StrategyMove,
  SuggestedTask,
  Task,
  TaskModification,
  TaskStatus,
  WorkSessionLocal,
} from "./types";

// Server Actions — the single mutation layer for TaskBuddy.

export interface FormState {
  error: string | null;
}

/** Sentinel meaning "let TaskBuddy decide" — see entry-form.tsx. */
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

/**
 * Run after every mutation: roll the rolling-horizon committed plan forward (S3c-1) then
 * revalidate the affected paths. Mutations are exactly the situation-changing events (complete /
 * add / defer / reroute / log-time → model update), so this is where the committed row is kept
 * fresh; the read paths only DECIDE what to show and persist nothing (design §Decisions #6). The
 * roll is best-effort — any failure is swallowed so it can never break the mutation that
 * triggered it (the next mutation re-rolls, and the read path shows a correct plan meanwhile).
 * The date-guard lives inside `commitRollingPlan` (an unchanged fingerprint + anchor is a cheap
 * no-op). Named `revalidateAll` at the call sites for continuity with the pre-S3c signature.
 */
async function revalidateAll() {
  try {
    await commitRollingPlan();
  } catch (err) {
    console.error("rolling-plan roll failed (non-fatal):", err);
  }
  revalidatePaths();
}

/**
 * Create a draft entry from natural-language input, then redirect to its
 * review page so the user can accept/decline the extracted tasks.
 */
export async function createEntryAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  await requireUser();
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
    entryId = await createDraft(notes, {
      kind,
      area: area ?? undefined,
      projectId,
      autoProject: autoProject && !newProjectName,
      parentEntryId,
    });
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

/** Discard a draft entirely (nothing is kept). */
export async function discardDraftAction(entryId: string): Promise<void> {
  await requireUser();
  await discardDraft(entryId);
  await revalidateAll();
  redirect("/create");
}

/**
 * Move a task to a new Kanban status. Completing it tags the completion with a
 * confidence (manual checkbox → `self_assessed`; strategist auto-complete →
 * `inferred`; an explicit verify → `verified`) and stamps `completed_at`;
 * reopening it clears both.
 */
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
      : // Reopening clears all done-provenance, incl. any blocker-resolution note (§5.6 6b).
        { status, completion_confidence: null, completed_at: null, resolved_by: null };
  await updateTask(taskId, patch);
  // S2 slice B: accrue the local when-signal for a genuine user completion. Inferred
  // (strategist) completions are excluded — there is no client clock to honestly
  // stamp a local window. minutes=0: the task's real length lives on
  // `tasks.actual_minutes` (slice C joins it); this row adds the local window/weekday
  // the UTC `completed_at` instant can't give.
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

/** Add a criterion to a goal's definition of done. */
export async function addGoalCriterionAction(
  goalId: string,
  text: string,
): Promise<void> {
  await requireUser();
  if (!text.trim()) return;
  await addGoalCriterion(goalId, text);
  await revalidateAll();
}

/** Mark a criterion met (at a confidence) or unmet. */
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

/**
 * Decompose a learning goal into a skill graph (the LLM-proposes decomposer).
 * Replaces any prior plan. No-ops for project goals — their decomposition is the
 * task DAG from extraction.
 */
export async function decomposeGoalAction(goalId: string): Promise<void> {
  await requireUser();
  const goal = await getGoal(goalId);
  if (!goal || goal.kind !== "learning") return;
  const skills = await decomposeLearningGoal(goal.name, goal.description);
  await replaceSkillNodes(goalId, skills);
  await revalidateAll();
}

/** Mark a skill node attained (at a confidence) or not-yet. */
export async function setSkillAttainedAction(
  id: string,
  attained: boolean,
  confidence: CompletionConfidence = "self_assessed",
): Promise<void> {
  await requireUser();
  await setSkillNodeAttained(id, attained, attained ? confidence : null);
  await revalidateAll();
}

/** Remove a criterion from a goal's definition of done. */
export async function removeGoalCriterionAction(id: string): Promise<void> {
  await requireUser();
  await removeGoalCriterion(id);
  await revalidateAll();
}

/** Assign a task to a life-area (Today-page tabs). */
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

/**
 * Apply a pit-wall triage move in one shot: defer a batch of tasks (the
 * lowest-value work auto chose to shed, or a colliding project's open work the
 * user chose to sacrifice). Like a single defer, each is reversible from the
 * project's Deferred section.
 */
export async function applyTriageAction(taskIds: string[]): Promise<void> {
  await requireUser();
  await Promise.all(taskIds.map((id) => updateTask(id, { deferred: true })));
  await revalidateAll();
}

/**
 * Reverse a triage batch: bring the deferred tasks back into scope. Backs the
 * pit wall's "Undo" on an auto-applied deferral, so an automatic move is never a
 * one-way door.
 */
export async function undoTriageAction(taskIds: string[]): Promise<void> {
  await requireUser();
  await Promise.all(taskIds.map((id) => updateTask(id, { deferred: false })));
  await revalidateAll();
}

/**
 * Push a task's due date (e.g. to clear an "overdue" flag). Note this does not
 * affect the completion forecast — only the project deadline + estimates do.
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

/** Record actual time spent on a task (estimated vs actual tracking). */
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

/** Set or clear a project's deadline (the forecast's finish line). */
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

/**
 * Toggle the pit-wall automation mode. On = the strategist auto-defers the
 * obvious low-value doomed work and only escalates genuine ties; off = it surfaces
 * every move for the user to apply. Revalidates so the pit wall re-renders in the
 * chosen mode (and, if turning on mid-conflict, applies the pending triage).
 */
export async function setAutoStrategyAction(value: boolean): Promise<void> {
  await requireUser();
  await setAutoStrategy(value);
  revalidatePath("/");
}

/**
 * Save the Value Model (area importance + recovery style). It re-weights the
 * allocator's cost-of-delay and the strategist's move preference, so revalidate
 * everywhere odds/order surface. The payload is re-normalized server-side.
 */
export async function updateValueModelAction(model: ValueModel): Promise<void> {
  await requireUser();
  await setValueModel(model);
  await revalidateAll();
}

/**
 * Save the explicit per-window availability (S3b Phase 4). It overrides the derived
 * window share the windowed forecast uses, so revalidate everywhere odds/order surface.
 * The payload is re-normalized server-side; all-zero weights ⇒ unset (use the derived share).
 */
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
 * Log a commitment ("friends 6-9pm") and return the pit calls it triggers —
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

/**
 * Ask the LLM strategist for net-new corrective tasks for an off-track project.
 * Read-only (nothing is persisted until the user accepts), so no revalidation.
 * Returns null when there's no genuine gap to fill or the LLM is unavailable.
 */
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

/**
 * Ask the LLM strategist to reshape existing tasks (scope down / split) so an
 * off-track project fits its budget. Read-only — nothing is persisted until the
 * user accepts. Returns null when no reshape usefully improves the odds.
 */
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

/**
 * Ask the LLM strategist for a whole-plan re-route — a different approach to the
 * same deliverable — when the current path won't fit. Read-only; nothing is
 * persisted until the user switches. Returns null when no genuinely lighter route
 * exists or the forecast says it wouldn't meaningfully help.
 */
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

// --- Strategy bundles: snapshot-on-commit + undo (S1 step 3 / §1.3) ----------

/**
 * Apply a strategy bundle (one move or a whole tier) as a single snapshotted unit
 * — the ONE path the card's "Apply" buttons take. Records a `PlanVersion` so the
 * change is undoable whole (vision §1.3/§8.2) and returns it, so the card can offer
 * an immediate Undo. `oddsBefore`/`oddsAfter` are the previewed numbers the user
 * accepted (the client re-solve), surfaced later in the history view.
 */
export async function commitStrategyBundleAction(
  moves: StrategyMove[],
  oddsBefore: number,
  oddsAfter: number,
  reason: string,
): Promise<PlanVersion> {
  await requireUser();
  const version = await commitStrategyBundle(moves, {
    oddsBefore,
    oddsAfter,
    reason,
  });
  await revalidateAll();
  return version;
}

// --- §5.6 NL check-in / reflection loop -------------------------------------

/** The serialized result the capture bar renders: the reviewable proposals + the
 *  client re-solve inputs (so Family-A toggles re-solve live, like the strategy
 *  card) + the base odds + which interpret path ran (for the subtle source hint). */
export interface CheckinRunResult {
  review: CheckinReview;
  resolveInput: ResolveInput;
  baseAllOnTime: number;
  source: "llm" | "heuristic";
  /** Deterministic end-of-day reflection (done / blocked / tomorrow's focus),
   *  shown beside the post-commit outcome summary as reflective context (§5.6
   *  slice 6a "outcome summary"). Derived server-side; never computed client-side. */
  eod: EODSummary;
}

/** How many candidate entities the interpret prompt sees (the rest still resolve).
 *  Caps the prompt, not the resolution blast radius (design §"candidate set"). */
const CHECKIN_PROMPT_CAP = 60;

/** Derive the check-in candidate set from the already-computed joint scorer — the
 *  open real tasks + the unattained skill-node frontier are ALREADY in
 *  `resolveInput.tasks` (skill nodes namespaced with `SKILL_TASK_PREFIX`), so this
 *  re-gathers nothing. Activities come off the scorer. Handles are stable within a
 *  run (T#/S#/A#). Returns the resolve set + the global unattained skill set
 *  (the spillover blast radius). */
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

/** Order the prompt candidate set so the scoped goal's own entities come first
 *  before the cap — the scope is the disambiguation. Resolution still runs against
 *  the FULL set (an off-scope reference still resolves), so this only biases what
 *  the model SEES, never the blast radius. A stable partition (no reordering
 *  within each side) keeps the un-scoped ordering intact. */
function rankForScope(
  candidates: CheckinCandidate[],
  scope: CheckinScope | undefined,
): CheckinCandidate[] {
  if (!scope) return candidates;
  const inScope = candidates.filter((c) => c.goalId === scope.goalId);
  const rest = candidates.filter((c) => c.goalId !== scope.goalId);
  return [...inScope, ...rest];
}

/**
 * Run the interpret → resolve → propose loop over a free-form check-in (§5.6). The
 * review/commit half is the existing S1 machinery — the capture bar commits the
 * accepted Family-A subset via `commitStrategyBundleAction` and runs the Family-B
 * actions individually. No mutation happens here; this is read-only interpretation.
 *
 * `scope` (§5.6 slice 6a) binds the check-in to one goal — its entities rank first
 * in the interpret prompt, and an `add_task` intent becomes a Family-A `add_tasks`
 * move on that goal instead of a standalone capture. Absent for the global bar.
 */
export async function runCheckinAction(
  rawReport: string,
  scope?: CheckinScope,
): Promise<CheckinRunResult> {
  await requireUser();
  const report = rawReport.trim();
  const [scorer, tasks] = await Promise.all([createJointScorer(), listAllTasks()]);
  const { candidates, skillNodes } = checkinCandidates(scorer);

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
      // §5.6 6b — the live structural DAG, so a completed/resolved intent on a blocker
      // promotes to a cascade (chosen by graph role, not the model).
      deps: scorer.resolveInput.deps,
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

/** Revert one applied bundle whole (vision §8.2): restore its snapshot, then refresh. */
export async function undoPlanVersionAction(id: string): Promise<void> {
  await requireUser();
  await undoPlanVersion(id);
  await revalidateAll();
}

/**
 * Regenerate the portfolio strategy and cache it — the ONLY trigger that runs the
 * synthesis LLM (locked decision #4). Both "Am I on track?" and the stale-banner
 * "Refresh" call this; the Today/Strategy load paths never do. Passes the
 * previously cached strategy for time-drift continuity, persists the result, and
 * revalidates both pages that render it.
 */
export async function refreshPortfolioStrategyAction(): Promise<PortfolioStrategy> {
  await requireUser();
  const prev = await getCachedStrategy();
  const strategy = await generatePortfolioStrategy(prev);
  await setCachedStrategy(strategy);
  revalidatePath("/");
  revalidatePath("/strategy");
  return strategy;
}

/** Generate a follow-up message for an entry's open questions and blockers. */
export async function generateFollowUpAction(
  entryId: string,
): Promise<{ message: string | null; error: string | null }> {
  await requireUser();
  const entry = await getEntry(entryId);
  if (!entry) return { message: null, error: "Entry not found." };
  try {
    const message = await generateFollowUp(entry);
    return { message, error: null };
  } catch (err) {
    console.error("generateFollowUp failed:", err);
    return {
      message: null,
      error: err instanceof Error ? err.message : "Failed to generate message.",
    };
  }
}

// --- Recurring activities (routines & goals) + errands ----------------------

/** Create a recurring activity (routine or goal). */
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

/** Soft-archive a recurring activity (keeps completion history). */
export async function archiveActivityAction(id: string): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, { active: false });
  await revalidateAll();
}

/** Log a completed session for an activity today (minutes default to its estimate). */
export async function logActivityCompletionAction(
  activityId: string,
  minutes?: number,
  local?: WorkSessionLocal,
): Promise<void> {
  await requireUser();
  await logActivityCompletion(activityId, undefined, minutes);
  // S2 slice B: a routine session is a real, discrete work session — accrue it with
  // its local window/weekday + length (the when-signal slice C's energy reads need).
  if (local) {
    await logWorkSession({ activityId, minutes: minutes ?? 0, kind: "complete", local });
  }
  await revalidateAll();
}

/** Skip an activity's current instance today (reversible). */
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
