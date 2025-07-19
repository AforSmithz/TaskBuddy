"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import {
  confirmDraft,
  createDraft,
  createProject,
  discardDraft,
  getMeeting,
  updateTask,
} from "./store";
import { generateFollowUp } from "./generate";
import { requireUser } from "./auth";
import type { DraftClassification, EntryKind, TaskStatus } from "./types";

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
  revalidatePath("/meetings", "layout");
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

  const parentMeetingId = pick(formData, "parentMeetingId");
  const newProjectName = String(formData.get("newProjectName") ?? "").trim();
  // "Auto" means let TaskBuddy decide; "" means an explicit "No project";
  // anything else is an existing project's id.
  const rawProjectId = String(formData.get("projectId") ?? "");
  const autoProject = rawProjectId === AUTO;
  const existingProjectId =
    rawProjectId && rawProjectId !== AUTO ? rawProjectId : null;

  let meetingId: string;
  try {
    let projectId = existingProjectId;
    if (newProjectName) {
      projectId = await createProject(newProjectName);
    }
    meetingId = await createDraft(notes, {
      kind,
      area: area ?? undefined,
      projectId,
      autoProject: autoProject && !newProjectName,
      parentMeetingId,
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
  redirect(`/meetings/${meetingId}/review`);
}

/**
 * Confirm a draft: keep the accepted tasks, drop the declined ones, apply the
 * filing the user confirmed in the review step, and go live.
 */
export async function confirmDraftAction(
  meetingId: string,
  declinedTaskIds: string[],
  classification: DraftClassification,
): Promise<void> {
  await requireUser();
  await confirmDraft(meetingId, declinedTaskIds, classification);
  revalidateAll();
  redirect(`/meetings/${meetingId}`);
}

/** Discard a draft entirely (nothing is kept). */
export async function discardDraftAction(meetingId: string): Promise<void> {
  await requireUser();
  await discardDraft(meetingId);
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

/** Generate a follow-up message for a meeting's open questions and blockers. */
export async function generateFollowUpAction(
  meetingId: string,
): Promise<{ message: string | null; error: string | null }> {
  await requireUser();
  const meeting = await getMeeting(meetingId);
  if (!meeting) return { message: null, error: "Meeting not found." };
  try {
    const message = await generateFollowUp(meeting);
    return { message, error: null };
  } catch (err) {
    console.error("generateFollowUp failed:", err);
    return {
      message: null,
      error: err instanceof Error ? err.message : "Failed to generate message.",
    };
  }
}
