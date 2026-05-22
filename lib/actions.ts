"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  confirmDraft,
  createDraft,
  createProject,
  discardDraft,
  getEntry,
  logCommitment,
  setAvailability,
  setOverride,
  setProjectDeadline,
  updateTask,
} from "./store";
import { generateFollowUp } from "./generate";
import { requireUser } from "./auth";
import type {
  DraftClassification,
  EntryKind,
  PitCall,
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
      projectId = await createProject(newProjectName);
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

/** Move a task to a new Kanban status. */
export async function updateTaskStatusAction(
  taskId: string,
  status: TaskStatus,
): Promise<void> {
  await requireUser();
  await updateTask(taskId, { status });
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
