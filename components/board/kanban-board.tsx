"use client";

import { useOptimistic, useState, useTransition } from "react";
import Link from "next/link";
import { motion, MotionConfig } from "motion/react";
import { User, CalendarDays, Sparkles, Lock } from "lucide-react";
import {
  TASK_STATUSES,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { PriorityBadge } from "@/components/ui/badge";
import { formatDate, formatMinutes, isOverdue } from "@/lib/format";
import { cn } from "@/lib/cn";
import { updateTaskStatusAction } from "@/lib/actions";

type Grouped = Record<TaskStatus, Task[]>;

/** ease-out-expo — calm settle, shared with the rest of the app. */
const BOARD_EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const COLUMN_ACCENT: Record<TaskStatus, string> = {
  backlog: "bg-[var(--color-status-backlog)]",
  todo: "bg-[var(--color-status-todo)]",
  in_progress: "bg-[var(--color-status-in-progress)]",
  blocked: "bg-[var(--color-status-blocked)]",
  review: "bg-[var(--color-status-review)]",
  done: "bg-[var(--color-status-done)]",
};

function group(tasks: Task[]): Grouped {
  const out = Object.fromEntries(
    TASK_STATUSES.map((s) => [s, [] as Task[]]),
  ) as Grouped;
  for (const t of tasks) out[t.status].push(t);
  return out;
}

export function KanbanBoard({
  tasks,
  meetingTitles,
}: {
  tasks: Task[];
  meetingTitles: Record<string, string>;
}) {
  const [optimistic, applyOptimistic] = useOptimistic(
    group(tasks),
    (current: Grouped, move: { taskId: string; status: TaskStatus }) => {
      const next: Grouped = { ...current };
      let moved: Task | undefined;
      for (const s of TASK_STATUSES) {
        const idx = next[s].findIndex((t) => t.id === move.taskId);
        if (idx !== -1) {
          moved = { ...next[s][idx], status: move.status };
          next[s] = next[s].filter((t) => t.id !== move.taskId);
          break;
        }
      }
      if (moved) next[move.status] = [...next[move.status], moved];
      return next;
    },
  );
  const [, startTransition] = useTransition();
  const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

  function move(taskId: string, status: TaskStatus, from: TaskStatus) {
    if (status === from) return;
    startTransition(async () => {
      applyOptimistic({ taskId, status });
      await updateTaskStatusAction(taskId, status);
    });
  }

  return (
    <MotionConfig reducedMotion="user">
      <div className="overflow-x-auto pb-4">
        <motion.div
          className="flex gap-4"
          initial="hidden"
          animate="show"
          variants={{
            hidden: {},
            show: { transition: { staggerChildren: 0.06 } },
          }}
        >
          {TASK_STATUSES.map((status) => {
            const items = optimistic[status];
            return (
              <motion.div
                key={status}
                layout
                variants={{
                  hidden: { opacity: 0, y: 14 },
                  show: {
                    opacity: 1,
                    y: 0,
                    transition: { duration: 0.45, ease: BOARD_EASE },
                  },
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(status);
                }}
                onDragLeave={() =>
                  setDragOver((d) => (d === status ? null : d))
                }
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(null);
                  const taskId = e.dataTransfer.getData("text/plain");
                  const from = e.dataTransfer.getData(
                    "text/from",
                  ) as TaskStatus;
                  if (taskId) move(taskId, status, from);
                }}
                className={cn(
                  "flex w-[272px] shrink-0 flex-col overflow-hidden rounded-lg border bg-[var(--color-surface-raised)]",
                  "transition-colors duration-150",
                  dragOver === status
                    ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-subtle)]"
                    : "border-[var(--color-border)]",
                )}
              >
                <div className={cn("h-[3px]", COLUMN_ACCENT[status])} />
              <div className="flex items-center justify-between px-4 py-3">
                <span className="text-[13px] font-semibold text-[var(--color-fg)]">
                  {STATUS_LABELS[status]}
                </span>
                <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--color-surface-overlay)] px-1 text-[11px] font-medium text-[var(--color-fg-muted)]">
                  {items.length}
                </span>
              </div>
                <motion.div
                  layout
                  className="flex min-h-[120px] flex-col gap-1.5 p-2"
                >
                  {items.length === 0 ? (
                    <p className="px-2 py-6 text-center text-[12px] text-[var(--color-fg-subtle)]">
                      Drop tasks here
                    </p>
                  ) : (
                    items.map((task) => (
                      <KanbanCard
                        key={task.id}
                        task={task}
                        meetingTitle={meetingTitles[task.meeting_id]}
                        onMove={move}
                      />
                    ))
                  )}
                </motion.div>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </MotionConfig>
  );
}

function KanbanCard({
  task,
  meetingTitle,
  onMove,
}: {
  task: Task;
  meetingTitle?: string;
  onMove: (id: string, status: TaskStatus, from: TaskStatus) => void;
}) {
  return (
    // motion.div handles the shared-layout glide between columns;
    // the inner <article> keeps native HTML5 drag (motion.* would
    // intercept onDragStart as a framer gesture).
    <motion.div
      layout
      layoutId={task.id}
      transition={{ type: "spring", stiffness: 350, damping: 30 }}
      whileHover={{ y: -2 }}
      whileTap={{ scale: 0.97 }}
    >
      <article
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("text/plain", task.id);
          e.dataTransfer.setData("text/from", task.status);
          e.dataTransfer.effectAllowed = "move";
        }}
        className="group cursor-grab rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3 transition-colors hover:border-[var(--color-border-strong)] hover:shadow-sm active:cursor-grabbing"
      >
      <div className="flex items-start justify-between gap-2">
        <PriorityBadge label={task.priority_label} />
        {task.is_ai_suggested && (
          <Sparkles className="size-3.5 shrink-0 text-[var(--color-accent)]" />
        )}
        {task.status === "blocked" && (
          <Lock className="size-3.5 shrink-0 text-[var(--color-status-blocked)]" />
        )}
      </div>

      <Link
        href={`/meetings/${task.meeting_id}`}
        draggable={false}
        className="mt-2 block text-[13px] font-medium leading-snug text-[var(--color-fg)] hover:text-[var(--color-accent)]"
      >
        {task.title}
      </Link>

      {meetingTitle && (
        <p className="mt-1 truncate text-[11px] text-[var(--color-fg-subtle)]">
          {meetingTitle}
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--color-fg-muted)]">
        {task.owner && (
          <span className="flex items-center gap-1">
            <User className="size-3" />
            {task.owner}
          </span>
        )}
        <span
          className={cn(
            "flex items-center gap-1",
            isOverdue(task.due_date) &&
              task.status !== "done" &&
              "text-[var(--color-danger)]",
          )}
        >
          <CalendarDays className="size-3" />
          {formatDate(task.due_date)}
        </span>
        <span className="font-mono text-[var(--color-fg-subtle)]">
          {formatMinutes(task.estimated_minutes)}
        </span>
      </div>

      <select
        value={task.status}
        onChange={(e) =>
          onMove(task.id, e.target.value as TaskStatus, task.status)
        }
        aria-label={`Change status of ${task.title}`}
        className="mt-2.5 h-7 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[11px] font-medium text-[var(--color-fg-muted)] focus:border-[var(--color-accent)] focus:outline-none"
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
