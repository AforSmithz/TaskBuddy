"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  addCorrectiveTasks,
  addGoalCriterion,
  applyReroute,
  applyTaskModifications,
  confirmDraft,
  createDraft,
  createErrandTask,
  createGoal,
  createRecurringActivity,
  discardDraft,
  removeGoalCriterion,
  setGoalCriterionMet,
  setGoalKind,
  getCachedStrategy,
  getEntry,
  logActivityCompletion,
  logCommitment,
  setAutoStrategy,
  setAvailability,
  setCachedStrategy,
  setOverride,
  setProjectDeadline,
  setValueModel,
  skipActivity,
  skipActivityForWeek,
  unskipActivity,
  updateRecurringActivity,
  updateTask,
  type NewActivityInput,
} from "./store";
import { generateFollowUp } from "./generate";
import {
  generateCorrectiveTasks,
  generateReroute,
  generateTaskModifications,
} from "./strategist";
import { generatePortfolioStrategy } from "./portfolio-strategist";
import { requireUser } from "./auth";
import type { ValueModel } from "./value-model";
import type {
  CompletionConfidence,
  DraftClassification,
  EntryKind,
  GoalKind,
  ModificationSuggestion,
  PitCall,
  PortfolioStrategy,
  RecoverySuggestion,
  ReroutePart,
  RerouteSuggestion,
  SuggestedTask,
  Task,
  TaskModification,
  TaskStatus,
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

function revalidateAll() {
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath("/entries", "layout");
  revalidatePath("/projects", "layout");
  revalidatePath("/activities");
  // The strategist banner keys off capacity/odds, which activities change.
  revalidatePath("/strategy");
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
  revalidateAll();
  redirect(`/entries/${entryId}`);
}

/** Discard a draft entirely (nothing is kept). */
export async function discardDraftAction(entryId: string): Promise<void> {
  await requireUser();
  await discardDraft(entryId);
  revalidateAll();
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
): Promise<void> {
  await requireUser();
  const patch: Partial<Task> =
    status === "done"
      ? { status, completion_confidence: confidence, completed_at: new Date().toISOString() }
      : { status, completion_confidence: null, completed_at: null };
  await updateTask(taskId, patch);
  revalidateAll();
}

/** Elevate an already-done task's completion to `verified` (keeps `completed_at`). */
export async function verifyTaskAction(taskId: string): Promise<void> {
  await requireUser();
  await updateTask(taskId, { completion_confidence: "verified" });
  revalidateAll();
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
  revalidateAll();
}

/** Mark a criterion met (at a confidence) or unmet. */
export async function setGoalCriterionMetAction(
  id: string,
  met: boolean,
  confidence: CompletionConfidence = "self_assessed",
): Promise<void> {
  await requireUser();
  await setGoalCriterionMet(id, met, met ? confidence : null);
  revalidateAll();
}

/** Reclassify a goal as a project or a learning goal. */
export async function setGoalKindAction(
  goalId: string,
  kind: GoalKind,
): Promise<void> {
  await requireUser();
  await setGoalKind(goalId, kind);
  revalidatePath("/");
  revalidatePath("/projects", "layout");
}

/** Remove a criterion from a goal's definition of done. */
export async function removeGoalCriterionAction(id: string): Promise<void> {
  await requireUser();
  await removeGoalCriterion(id);
  revalidateAll();
}

/** Assign a task to a life-area (Today-page tabs). */
export async function updateTaskAreaAction(
  taskId: string,
  area: string,
): Promise<void> {
  await requireUser();
  await updateTask(taskId, { area });
  revalidateAll();
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
  revalidateAll();
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
  revalidateAll();
}

/**
 * Reverse a triage batch: bring the deferred tasks back into scope. Backs the
 * pit wall's "Undo" on an auto-applied deferral, so an automatic move is never a
 * one-way door.
 */
export async function undoTriageAction(taskIds: string[]): Promise<void> {
  await requireUser();
  await Promise.all(taskIds.map((id) => updateTask(id, { deferred: false })));
  revalidateAll();
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
  revalidateAll();
}

/** Clear a task's blocker and return it to the active queue. */
export async function unblockTaskAction(taskId: string): Promise<void> {
  await requireUser();
  await updateTask(taskId, { status: "todo", blocked_by: null });
  revalidateAll();
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
  revalidateAll();
}

// --- Time budget & forecast -------------------------------------------------

/** Set or clear a project's deadline (the forecast's finish line). */
export async function setProjectDeadlineAction(
  projectId: string,
  deadline: string | null,
): Promise<void> {
  await requireUser();
  await setProjectDeadline(projectId, deadline || null);
  revalidatePath("/");
  revalidatePath("/projects", "layout");
}

/** Update the weekly availability template. */
export async function setAvailabilityAction(
  rows: { weekday: number; hours: number }[],
): Promise<void> {
  await requireUser();
  await setAvailability(rows);
  revalidatePath("/");
  revalidatePath("/projects", "layout");
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
  revalidateAll();
}

/** Override deployable hours for one specific date. */
export async function setOverrideAction(
  date: string,
  hours: number,
): Promise<void> {
  await requireUser();
  await setOverride(date, hours);
  revalidatePath("/");
  revalidatePath("/projects", "layout");
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
    revalidatePath("/");
    revalidatePath("/projects", "layout");
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
  revalidateAll();
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
  revalidateAll();
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
): Promise<void> {
  await requireUser();
  await applyReroute(projectId, replacedTaskIds, tasks);
  revalidateAll();
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
  revalidateAll();
}

/** Patch a recurring activity (edit fields). */
export async function updateActivityAction(
  id: string,
  patch: Parameters<typeof updateRecurringActivity>[1],
): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, patch);
  revalidateAll();
}

/** Toggle whether the strategist may auto-sacrifice this activity. */
export async function setActivityProtectedAction(
  id: string,
  isProtected: boolean,
): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, { protected: isProtected });
  revalidateAll();
}

/** Soft-archive a recurring activity (keeps completion history). */
export async function archiveActivityAction(id: string): Promise<void> {
  await requireUser();
  await updateRecurringActivity(id, { active: false });
  revalidateAll();
}

/** Log a completed session for an activity today (minutes default to its estimate). */
export async function logActivityCompletionAction(
  activityId: string,
  minutes?: number,
): Promise<void> {
  await requireUser();
  await logActivityCompletion(activityId, undefined, minutes);
  revalidateAll();
}

/** Skip an activity's current instance today (reversible). */
export async function skipActivityAction(
  activityId: string,
  date?: string,
): Promise<void> {
  await requireUser();
  await skipActivity(activityId, date);
  revalidateAll();
}

/** Undo a skip. */
export async function unskipActivityAction(
  activityId: string,
  date?: string,
): Promise<void> {
  await requireUser();
  await unskipActivity(activityId, date);
  revalidateAll();
}

/** Apply a strategist `skip_activity` move: skip the activity for the rest of
 *  this week, freeing its hours for at-risk deadlines. */
export async function skipActivityForWeekAction(
  activityId: string,
): Promise<void> {
  await requireUser();
  await skipActivityForWeek(activityId);
  revalidateAll();
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
  revalidateAll();
}
