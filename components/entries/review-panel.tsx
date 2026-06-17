"use client";

import { useState, useTransition } from "react";
import {
  Check,
  Sparkles,
  Quote,
  User,
  CalendarDays,
  Trash2,
  ListChecks,
  FolderTree,
} from "lucide-react";
import {
  GOAL_KIND_LABELS,
  SEED_AREAS,
  type DraftClassification,
  type Entry,
  type EntryDetail,
  type Goal,
  type GoalKind,
  type Task,
} from "@/lib/types";
import { PriorityBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardBody } from "@/components/ui/card";
import { Select, TextField, FieldLabel } from "@/components/ui/text-field";
import { formatDate, formatMinutes } from "@/lib/format";
import { confirmDraftAction, discardDraftAction } from "@/lib/actions";
import { cn } from "@/lib/cn";

const NEW_AREA = "__new_area__";
const NEW_PROJECT = "__new_project__";

export function ReviewPanel({
  entry,
  projects,
  entries,
}: {
  entry: EntryDetail;
  projects: Goal[];
  entries: Entry[];
}) {
  const tasks = entry.tasks;
  // A task is accepted unless its id is in this set.
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();

  // --- Filing the user confirms before the draft goes live ------------------
  const initialArea = tasks[0]?.area ?? "Work";
  const areaOptions = [...new Set([...SEED_AREAS, initialArea])];
  const [area, setArea] = useState(initialArea);
  const [addingArea, setAddingArea] = useState(false);
  const [customArea, setCustomArea] = useState("");
  const [projectId, setProjectId] = useState(entry.goal_id ?? "");
  const [addingProject, setAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectKind, setNewProjectKind] = useState<GoalKind>("project");
  const [parentEntryId, setParentEntryId] = useState(
    entry.parent_entry_id ?? "",
  );

  const relatedCandidates = entries.filter(
    (m) =>
      m.kind === "meeting" &&
      m.id !== entry.id &&
      (!projectId || m.goal_id === projectId),
  );
  const showRelated = entry.kind === "meeting" && relatedCandidates.length > 0;

  const acceptedCount = tasks.length - declined.size;

  function toggle(id: string) {
    setDeclined((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function setAll(accept: boolean) {
    setDeclined(accept ? new Set() : new Set(tasks.map((t) => t.id)));
  }

  function confirm() {
    const classification: DraftClassification = {
      area: (addingArea ? customArea : area).trim() || "Work",
      projectId: addingProject ? null : projectId || null,
      newProjectName: addingProject ? newProjectName.trim() : "",
      newProjectKind,
      parentEntryId: showRelated ? parentEntryId || null : null,
    };
    startTransition(async () => {
      await confirmDraftAction(entry.id, [...declined], classification);
    });
  }

  function discard() {
    startTransition(async () => {
      await discardDraftAction(entry.id);
    });
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="How this entry is filed"
          icon={<FolderTree className="size-4" />}
        />
        <CardBody className="space-y-4">
          <p className="text-[13px] text-[var(--color-fg-muted)]">
            Confirm the category, project, and any follow-up link before
            saving — these apply to every task in this entry.
          </p>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <FieldLabel htmlFor="review-area">Category</FieldLabel>
              {addingArea ? (
                <TextField
                  id="review-area"
                  autoFocus
                  placeholder="New category name…"
                  value={customArea}
                  onChange={(e) => setCustomArea(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddingArea(false);
                  }}
                />
              ) : (
                <Select
                  id="review-area"
                  value={area}
                  onChange={(e) => {
                    if (e.target.value === NEW_AREA) setAddingArea(true);
                    else setArea(e.target.value);
                  }}
                >
                  {areaOptions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                  <option value={NEW_AREA}>＋ New category…</option>
                </Select>
              )}
            </div>

            <div>
              <FieldLabel htmlFor="review-project">Goal</FieldLabel>
              {addingProject ? (
                <div className="space-y-2">
                  <TextField
                    id="review-project"
                    autoFocus
                    placeholder="New goal name…"
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") setAddingProject(false);
                    }}
                  />
                  <div className="inline-flex items-center gap-1 rounded-[12px] bg-[var(--color-surface-overlay)] p-1">
                    {(["project", "learning"] as GoalKind[]).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setNewProjectKind(k)}
                        className={cn(
                          "rounded-[9px] px-2.5 py-1 text-[12px] font-medium transition-colors",
                          newProjectKind === k
                            ? "bg-[var(--color-surface-raised)] text-[var(--color-fg)] shadow-sm"
                            : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                        )}
                      >
                        {GOAL_KIND_LABELS[k]}
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <Select
                  id="review-project"
                  value={projectId}
                  onChange={(e) => {
                    if (e.target.value === NEW_PROJECT) setAddingProject(true);
                    else setProjectId(e.target.value);
                  }}
                >
                  <option value="">No goal</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={NEW_PROJECT}>＋ New goal…</option>
                </Select>
              )}
            </div>
          </div>

          {showRelated && (
            <div>
              <FieldLabel htmlFor="review-parent">
                Related to an earlier meeting
              </FieldLabel>
              <Select
                id="review-parent"
                value={parentEntryId}
                onChange={(e) => setParentEntryId(e.target.value)}
              >
                <option value="">Not a follow-up</option>
                {relatedCandidates.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Tasks" icon={<ListChecks className="size-4" />} />
        <CardBody className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              <span className="font-semibold text-[var(--color-fg)]">
                {acceptedCount}
              </span>{" "}
              of {tasks.length} task{tasks.length === 1 ? "" : "s"} will be
              saved.
            </p>
            <div className="flex gap-2 text-[12px]">
              <button
                type="button"
                onClick={() => setAll(true)}
                className="font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                Accept all
              </button>
              <span className="text-[var(--color-border-strong)]">·</span>
              <button
                type="button"
                onClick={() => setAll(false)}
                className="font-medium text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]"
              >
                Decline all
              </button>
            </div>
          </div>

          <ul className="divide-y divide-[var(--color-border)] rounded-md border border-[var(--color-border)]">
            {tasks.map((task) => (
              <ReviewTaskRow
                key={task.id}
                task={task}
                accepted={!declined.has(task.id)}
                onToggle={() => toggle(task.id)}
              />
            ))}
            {tasks.length === 0 && (
              <li className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
                No tasks were extracted. Discard and try again with more detail.
              </li>
            )}
          </ul>
        </CardBody>
      </Card>

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={discard}
          disabled={pending}
        >
          <Trash2 className="size-4" />
          Discard
        </Button>
        <Button
          type="button"
          onClick={confirm}
          loading={pending}
          disabled={acceptedCount === 0}
        >
          {!pending && <Check className="size-4" />}
          Confirm &amp; save {acceptedCount} task
          {acceptedCount === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}

function ReviewTaskRow({
  task,
  accepted,
  onToggle,
}: {
  task: Task;
  accepted: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={cn(
        "flex items-start gap-3 px-4 py-3.5 transition-colors",
        !accepted && "bg-[var(--color-surface-raised)]",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        role="checkbox"
        aria-checked={accepted}
        aria-label={
          accepted ? `Decline "${task.title}"` : `Accept "${task.title}"`
        }
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm border transition-colors",
          accepted
            ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
            : "border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-accent)]",
        )}
      >
        <Check className="size-3.5" strokeWidth={3} />
      </button>

      <div className={cn("min-w-0 flex-1", !accepted && "opacity-55")}>
        <div className="flex flex-wrap items-center gap-2">
          <PriorityBadge label={task.priority_label} score={task.priority_score} />
          {task.is_ai_suggested && (
            <span className="inline-flex items-center gap-1 rounded-xs bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-fg)]">
              <Sparkles className="size-3" />
              AI suggested
            </span>
          )}
        </div>
        <p
          className={cn(
            "mt-1.5 text-[14px] font-medium text-[var(--color-fg)]",
            !accepted && "line-through",
          )}
        >
          {task.title}
        </p>
        {task.source_quote && (
          <p className="mt-1 flex items-start gap-1.5 text-[12px] italic text-[var(--color-fg-subtle)]">
            <Quote className="mt-0.5 size-3 shrink-0" />
            <span className="line-clamp-2">{task.source_quote}</span>
          </p>
        )}
        {task.priority_reason && (
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            {task.priority_reason}
          </p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-[var(--color-fg-muted)]">
          {task.owner && (
            <span className="flex items-center gap-1.5">
              <User className="size-3.5" />
              {task.owner}
            </span>
          )}
          {task.category && (
            <span className="text-[var(--color-fg-subtle)]">
              {task.category}
            </span>
          )}
          {task.due_date && (
            <span className="flex items-center gap-1.5">
              <CalendarDays className="size-3.5" />
              {formatDate(task.due_date)}
            </span>
          )}
          <span className="font-mono text-[var(--color-fg-subtle)]">
            est {formatMinutes(task.estimated_minutes)}
          </span>
        </div>
      </div>
    </li>
  );
}
