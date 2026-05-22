"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Check, User, CalendarDays, Lock } from "lucide-react";
import {
  TASK_STATUSES,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { PriorityBadge, Pill } from "@/components/ui/badge";
import { formatDate, formatMinutes, isOverdue } from "@/lib/format";
import { cn } from "@/lib/cn";

const NEW_AREA = "__new_area__";

export function TaskRow({
  task,
  entryTitle,
  areas,
  waitingOn,
  onMove,
  onAssignArea,
}: {
  task: Task;
  entryTitle?: string;
  areas: string[];
  /** Titles of prerequisite tasks that aren't done yet, if any. */
  waitingOn?: string[];
  onMove: (id: string, status: TaskStatus, from: TaskStatus) => void;
  onAssignArea: (id: string, area: string) => void;
}) {
  const overdue = isOverdue(task.due_date) && task.status !== "done";
  const waiting = (waitingOn?.length ?? 0) > 0;
  const [addingArea, setAddingArea] = useState(false);

  const areaOptions = areas.includes(task.area)
    ? areas
    : [task.area, ...areas];

  return (
    <motion.div
      layout
      layoutId={task.id}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
    >
      <article
        className={cn(
          "group flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 transition-colors hover:border-[var(--color-border-strong)] hover:shadow-sm",
          waiting && "opacity-65",
        )}
      >
        <button
          type="button"
          onClick={() => onMove(task.id, "done", task.status)}
          aria-label={`Mark "${task.title}" done`}
          className="flex size-5 shrink-0 items-center justify-center rounded-full border border-[var(--color-border-strong)] text-transparent transition-colors hover:border-[var(--color-status-done)] hover:bg-[var(--color-status-done)] hover:text-white"
        >
          <Check className="size-3" strokeWidth={3} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <PriorityBadge label={task.priority_label} />
            <Link
              href={`/entries/${task.entry_id}`}
              className="min-w-0 truncate text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-accent)]"
            >
              {task.title}
            </Link>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
            <Pill>{task.area}</Pill>
            {entryTitle && (
              <span className="truncate text-[var(--color-fg-subtle)]">
                {entryTitle}
              </span>
            )}
            {task.owner && (
              <span className="flex items-center gap-1">
                <User className="size-3" />
                {task.owner}
              </span>
            )}
            {task.due_date && (
              <span
                className={cn(
                  "flex items-center gap-1",
                  overdue && "text-[var(--color-danger)]",
                )}
              >
                <CalendarDays className="size-3" />
                {formatDate(task.due_date)}
              </span>
            )}
            <span className="font-mono text-[var(--color-fg-subtle)]">
              {formatMinutes(task.estimated_minutes)}
            </span>
          </div>
          {waiting && (
            <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[var(--color-status-blocked-fg)]">
              <Lock className="size-3 shrink-0" />
              <span className="truncate">
                {waitingOn!.length === 1
                  ? `Waiting on “${waitingOn![0]}”`
                  : `Waiting on ${waitingOn!.length} earlier tasks`}
              </span>
            </p>
          )}
        </div>

        {addingArea ? (
          <input
            autoFocus
            type="text"
            placeholder="New area…"
            aria-label="New area name"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const name = e.currentTarget.value.trim();
                if (name) onAssignArea(task.id, name);
                setAddingArea(false);
              } else if (e.key === "Escape") {
                setAddingArea(false);
              }
            }}
            onBlur={() => setAddingArea(false)}
            className="h-7 w-28 shrink-0 rounded-sm border border-[var(--color-accent)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg)] focus:outline-none"
          />
        ) : (
          <select
            value={task.area}
            onChange={(e) => {
              if (e.target.value === NEW_AREA) {
                setAddingArea(true);
              } else {
                onAssignArea(task.id, e.target.value);
              }
            }}
            aria-label={`Change area of ${task.title}`}
            className="h-7 shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] focus:border-[var(--color-accent)] focus:outline-none"
          >
            {areaOptions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
            <option value={NEW_AREA}>＋ New area</option>
          </select>
        )}

        <select
          value={task.status}
          onChange={(e) =>
            onMove(task.id, e.target.value as TaskStatus, task.status)
          }
          aria-label={`Change status of ${task.title}`}
          className="h-7 shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </article>
    </motion.div>
  );
}
