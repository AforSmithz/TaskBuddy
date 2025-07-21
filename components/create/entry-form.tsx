"use client";

import { useActionState, useState } from "react";
import { Loader2, AlertCircle, Wand2, FileText, Target } from "lucide-react";
import { createEntryAction, type FormState } from "@/lib/actions";
import { SEED_AREAS, type EntryKind, type Meeting, type Project } from "@/lib/types";
import { Textarea, TextField, FieldLabel, Select } from "@/components/ui/text-field";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const INITIAL: FormState = { error: null };
const NEW_AREA = "__new_area__";
const NEW_PROJECT = "__new_project__";
/** Defers the choice to TaskBuddy — resolved (or confirmed) in the review step. */
const AUTO = "__auto__";

const PLACEHOLDER: Record<EntryKind, string> = {
  meeting: `Paste your meeting notes, transcript, or chat log here...

Example:
We need to present dashboard insights to stakeholders by Friday.
Abi will clean the customer dataset before Friday's review.
Let's use monthly revenue as the main KPI.
Who will sign off on the final presentation?`,
  plan: `Describe a goal or note in plain language...

Example:
I want to learn the basics of piano this week.
Plan a small launch party for the team next Friday.`,
};

export function EntryForm({
  projects,
  meetings,
}: {
  projects: Project[];
  meetings: Meeting[];
}) {
  const [state, formAction, pending] = useActionState(
    createEntryAction,
    INITIAL,
  );
  const [mode, setMode] = useState<EntryKind>("meeting");
  const [chars, setChars] = useState(0);
  const [addingArea, setAddingArea] = useState(false);
  const [addingProject, setAddingProject] = useState(false);
  const [projectId, setProjectId] = useState(AUTO);

  const minLen = mode === "plan" ? 12 : 40;
  const tooShort = chars > 0 && chars < minLen;
  const projectMeetings = meetings.filter(
    (m) =>
      m.kind === "meeting" &&
      (!projectId || projectId === AUTO || m.project_id === projectId),
  );

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="mode" value={mode} />

      {/* Mode picker */}
      <div>
        <FieldLabel>What are you adding?</FieldLabel>
        <div className="grid grid-cols-2 gap-2">
          <ModeButton
            active={mode === "meeting"}
            icon={<FileText className="size-4" />}
            label="Meeting transcript"
            hint="Notes, transcript or chat log"
            onClick={() => setMode("meeting")}
          />
          <ModeButton
            active={mode === "plan"}
            icon={<Target className="size-4" />}
            label="Goal or note"
            hint="A goal to turn into a plan"
            onClick={() => setMode("plan")}
          />
        </div>
      </div>

      {/* Category + project */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <FieldLabel htmlFor="area">Category</FieldLabel>
          {addingArea ? (
            <TextField
              id="area"
              name="area"
              autoFocus
              required
              placeholder="New category name…"
              onKeyDown={(e) => {
                if (e.key === "Escape") setAddingArea(false);
              }}
            />
          ) : (
            <Select
              id="area"
              name="area"
              defaultValue={AUTO}
              onChange={(e) => {
                if (e.target.value === NEW_AREA) setAddingArea(true);
              }}
            >
              <option value={AUTO}>Auto — let TaskBuddy decide</option>
              {SEED_AREAS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
              <option value={NEW_AREA}>＋ New category…</option>
            </Select>
          )}
        </div>

        <div>
          <FieldLabel htmlFor="project">Project (optional)</FieldLabel>
          {addingProject ? (
            <TextField
              id="project"
              name="newProjectName"
              autoFocus
              placeholder="New project name…"
              onKeyDown={(e) => {
                if (e.key === "Escape") setAddingProject(false);
              }}
            />
          ) : (
            <Select
              id="project"
              name="projectId"
              value={projectId}
              onChange={(e) => {
                if (e.target.value === NEW_PROJECT) {
                  setAddingProject(true);
                } else {
                  setProjectId(e.target.value);
                }
              }}
            >
              <option value={AUTO}>Auto — let TaskBuddy decide</option>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
              <option value={NEW_PROJECT}>＋ New project…</option>
            </Select>
          )}
        </div>
      </div>

      {/* Related meeting — transcript mode only */}
      {mode === "meeting" && projectMeetings.length > 0 && (
        <div>
          <FieldLabel htmlFor="parentMeetingId">
            Related to an earlier meeting (optional)
          </FieldLabel>
          <Select
            id="parentMeetingId"
            name="parentMeetingId"
            defaultValue={AUTO}
          >
            <option value={AUTO}>Auto — let TaskBuddy decide</option>
            <option value="">Not a follow-up</option>
            {projectMeetings.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title}
              </option>
            ))}
          </Select>
        </div>
      )}

      {/* Input */}
      <div>
        <FieldLabel htmlFor="notes">
          {mode === "plan" ? "Your goal or note" : "Meeting content"}
        </FieldLabel>
        <Textarea
          id="notes"
          name="notes"
          required
          disabled={pending}
          placeholder={PLACEHOLDER[mode]}
          onChange={(e) => setChars(e.target.value.length)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <p
          className={cn(
            "mt-1.5 text-right text-[11px]",
            tooShort
              ? "text-[var(--color-danger)]"
              : "text-[var(--color-fg-subtle)]",
          )}
        >
          {tooShort
            ? `At least ${minLen} characters`
            : `${chars.toLocaleString()} characters`}
        </p>
      </div>

      <div className="rounded-sm border-l-2 border-[var(--color-accent)] bg-[var(--color-surface-raised)] px-3.5 py-3 text-[13px] leading-relaxed text-[var(--color-fg-muted)]">
        {mode === "plan"
          ? "TaskBuddy turns your goal into a step-by-step plan. You'll review every suggested task — and how it's filed — before anything is saved."
          : "TaskBuddy extracts a summary, decisions, open questions, and tasks. You'll review every task — and how it's filed — before anything is saved."}
      </div>

      {state.error && (
        <p className="flex items-center gap-2 text-[13px] text-[var(--color-danger)]">
          <AlertCircle className="size-4 shrink-0" />
          {state.error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-[var(--color-fg-subtle)]">
          {pending ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3.5 animate-spin" />
              {mode === "plan"
                ? "Building your plan… this can take a few tries"
                : "Extracting tasks… this can take a few tries"}
            </span>
          ) : (
            <>Tip: press ⌘/Ctrl + Enter to submit</>
          )}
        </span>
        <Button type="submit" loading={pending}>
          {!pending && <Wand2 className="size-4" />}
          {pending
            ? "Working…"
            : mode === "plan"
              ? "Build my plan"
              : "Analyse meeting"}
        </Button>
      </div>
    </form>
  );
}

function ModeButton({
  active,
  icon,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex flex-col gap-1 rounded-md border px-3.5 py-3 text-left transition-colors",
        active
          ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:border-[var(--color-border-strong)]",
      )}
    >
      <span
        className={cn(
          "flex items-center gap-2 text-[14px] font-semibold",
          active
            ? "text-[var(--color-accent-fg)]"
            : "text-[var(--color-fg)]",
        )}
      >
        {icon}
        {label}
      </span>
      <span className="text-[12px] text-[var(--color-fg-muted)]">{hint}</span>
    </button>
  );
}
