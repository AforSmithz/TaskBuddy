"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Check,
  User,
  CalendarDays,
  Lock,
  ArrowUpCircle,
  Flame,
  Repeat,
  Target,
  Undo2,
} from "lucide-react";
import {
  TASK_STATUSES,
  STATUS_LABELS,
  type RecurringState,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { PriorityBadge, Pill } from "@/components/ui/badge";
import { formatDate, formatMinutes, isOverdue } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  logActivityCompletionAction,
  skipActivityAction,
  unskipActivityAction,
} from "@/lib/actions";
import { localSessionStamp } from "@/lib/work-session";

const NEW_AREA = "__new_area__";

export function TaskRow({
  task,
  entryTitle,
  areas,
  waitingOn,
  pulledAheadReason,
  onMove,
  onAssignArea,
}: {
  task: Task;
  entryTitle?: string;
  areas: string[];
  /** Titles of prerequisite tasks that aren't done yet, if any. */
  waitingOn?: string[];
  /** Why deadline pressure pulled this task ahead in the global order, if it did. */
  pulledAheadReason?: string;
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
              href={`/tasks/${task.id}`}
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
          {pulledAheadReason && (
            <p className="mt-1 flex items-center gap-1 text-[11px] font-medium text-[var(--color-accent-fg)] opacity-85">
              <ArrowUpCircle className="size-3 shrink-0" />
              <span className="truncate" title={pulledAheadReason}>
                {pulledAheadReason}
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
            className="h-7 w-28 shrink-0 rounded-sm border border-[var(--color-accent)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1"
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
            className="h-7 shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1"
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
          className="h-7 shrink-0 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] focus:border-[var(--color-accent)] focus:outline-none focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] focus-visible:outline-offset-1"
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

/**
 * A recurring routine/goal interleaved into the Today agenda - check it off (logs
 * a completion) or skip it for now. Shows its streak (daily) or weekly progress
 * instead of a status/area control. Self-contained: it routes its actions to the
 * activity, not the task table, and collapses to a "done" state on resolution.
 */
export function RecurringAgendaRow({ state }: { state: RecurringState }) {
  const { activity, status, streak, progress } = state;
  const [pending, startTransition] = useTransition();
  const [localDone, setLocalDone] = useState(false);
  const [localSkipped, setLocalSkipped] = useState(false);

  const doneToday = state.doneToday || localDone;
  const resolved = doneToday || localSkipped;

  function markDone() {
    if (doneToday || pending) return;
    setLocalDone(true);
    startTransition(() =>
      logActivityCompletionAction(
        activity.id,
        activity.estimated_minutes,
        localSessionStamp(),
      ),
    );
  }
  function skip() {
    if (pending) return;
    setLocalSkipped(true);
    startTransition(() => skipActivityAction(activity.id));
  }
  function unskip() {
    if (pending) return;
    setLocalSkipped(false);
    startTransition(() => unskipActivityAction(activity.id));
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
    >
      <article
        className={cn(
          "group flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 transition-colors hover:border-[var(--color-border-strong)] hover:shadow-sm",
          resolved && "opacity-65",
        )}
      >
        <button
          type="button"
          onClick={markDone}
          disabled={doneToday}
          aria-label={`Mark "${activity.title}" done today`}
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full border transition-colors",
            doneToday
              ? "border-[var(--color-status-done)] bg-[var(--color-status-done)] text-white"
              : "border-[var(--color-border-strong)] text-transparent hover:border-[var(--color-status-done)] hover:bg-[var(--color-status-done)] hover:text-white",
          )}
        >
          <Check className="size-3" strokeWidth={3} />
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span title="Recurring routine / goal">
              <Repeat className="size-3 shrink-0 text-[var(--color-accent)]" />
            </span>
            <Link
              href="/activities"
              className={cn(
                "min-w-0 truncate text-[13px] font-medium text-[var(--color-fg)] hover:text-[var(--color-accent)]",
                resolved && "line-through decoration-[var(--color-fg-subtle)]",
              )}
            >
              {activity.title}
            </Link>
            {activity.protected && (
              <span title="Protected — the strategist won't sacrifice this">
                <Target className="size-3 shrink-0 text-[var(--color-fg-subtle)]" />
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
            <Pill>{activity.area}</Pill>
            <span className="font-mono text-[var(--color-fg-subtle)]">
              {formatMinutes(activity.estimated_minutes)}
            </span>
            {activity.period === "day" ? (
              streak > 0 && (
                <span className="flex items-center gap-1 font-medium text-[var(--color-accent-fg)]">
                  <Flame className="size-3" />
                  {streak} day{streak === 1 ? "" : "s"}
                </span>
              )
            ) : (
              <span className="tabular-nums text-[var(--color-fg-subtle)]">
                {progress.done}/{progress.target} this week
              </span>
            )}
            {!resolved && status === "missed" && (
              <span className="font-medium text-[var(--color-accent-fg)]">
                behind
              </span>
            )}
            {!resolved && status === "cold" && (
              <span className="text-[var(--color-fg-subtle)]">gone cold</span>
            )}
          </div>
        </div>

        {localSkipped ? (
          <button
            type="button"
            onClick={unskip}
            className="flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] font-medium text-[var(--color-fg-subtle)] transition-colors hover:text-[var(--color-fg-muted)]"
          >
            <Undo2 className="size-3" />
            Undo
          </button>
        ) : (
          !resolved && (
            <button
              type="button"
              onClick={skip}
              className="shrink-0 rounded-sm px-1.5 py-1 text-[11px] font-medium text-[var(--color-fg-subtle)] opacity-0 transition-opacity hover:text-[var(--color-fg-muted)] group-hover:opacity-100"
            >
              Skip
            </button>
          )
        )}
      </article>
    </motion.div>
  );
}
