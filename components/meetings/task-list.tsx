"use client";

import { useOptimistic, useState, useTransition } from "react";
import {
  Quote,
  User,
  CalendarDays,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import {
  TASK_STATUSES,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { PriorityBadge } from "@/components/ui/badge";
import { formatDate, formatMinutes, isOverdue } from "@/lib/format";
import { cn } from "@/lib/cn";
import {
  updateTaskStatusAction,
  logActualTimeAction,
} from "@/lib/actions";

// The six 1-5 ratings that feed the deterministic priority score.
// Effort is the only factor subtracted from the score, so it is flagged.
const FACTORS: {
  key: keyof Task;
  label: string;
  penalty?: boolean;
}[] = [
  { key: "urgency_score", label: "Urgency" },
  { key: "impact_score", label: "Impact" },
  { key: "dependency_score", label: "Dependency" },
  { key: "risk_score", label: "Risk" },
  { key: "confidence_score", label: "Confidence" },
  { key: "effort_score", label: "Effort", penalty: true },
];

/** Per-factor 1-5 breakdown behind a task's priority score. */
function FactorBreakdown({ task }: { task: Task }) {
  const factors = FACTORS.map((f) => ({
    ...f,
    value: task[f.key] as number | null,
  })).filter((f) => typeof f.value === "number");

  if (factors.length === 0) return null;

  return (
    <div className="mt-2 grid grid-cols-2 gap-x-5 gap-y-1.5 rounded-sm bg-[var(--color-bg)] px-3 py-2.5 sm:grid-cols-3">
      {factors.map((f) => (
        <div
          key={f.key}
          className="flex items-center justify-between gap-2"
        >
          <span className="text-[11px] text-[var(--color-fg-muted)]">
            {f.label}
            {f.penalty && (
              <span
                className="text-[var(--color-fg-subtle)]"
                title="Effort is subtracted from the priority score"
              >
                {" "}
                (penalty)
              </span>
            )}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="flex gap-0.5">
              {[1, 2, 3, 4, 5].map((n) => (
                <span
                  key={n}
                  className={cn(
                    "size-1 rounded-full",
                    n <= (f.value as number)
                      ? f.penalty
                        ? "bg-[var(--color-fg-subtle)]"
                        : "bg-[var(--color-accent)]"
                      : "bg-[var(--color-border-strong)]",
                  )}
                />
              ))}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
              {f.value}/5
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  const [optimistic, setOptimistic] = useOptimistic(
    tasks,
    (current: Task[], update: { id: string; status: TaskStatus }) =>
      current.map((t) =>
        t.id === update.id ? { ...t, status: update.status } : t,
      ),
  );
  const [, startTransition] = useTransition();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggleBreakdown(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function changeStatus(id: string, status: TaskStatus) {
    startTransition(async () => {
      setOptimistic({ id, status });
      await updateTaskStatusAction(id, status);
    });
  }

  function logTime(id: string, minutes: number) {
    startTransition(() => logActualTimeAction(id, minutes));
  }

  if (optimistic.length === 0) {
    return (
      <p className="px-5 py-8 text-center text-[13px] text-[var(--color-fg-subtle)]">
        No tasks were extracted from this meeting.
      </p>
    );
  }

  return (
    <div className="divide-y divide-[var(--color-border)]">
      {optimistic.map((task) => (
        <div key={task.id} className="px-5 py-3.5">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <PriorityBadge
                  label={task.priority_label}
                  score={task.priority_score}
                />
                {task.is_ai_suggested && (
                  <span className="inline-flex items-center gap-1 rounded-xs bg-[var(--color-accent-subtle)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--color-accent-fg)]">
                    <Sparkles className="size-3" />
                    AI suggested
                  </span>
                )}
              </div>
              <p className="mt-1.5 text-[14px] font-medium text-[var(--color-fg)]">
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
              {task.priority_score != null && (
                <>
                  <button
                    type="button"
                    onClick={() => toggleBreakdown(task.id)}
                    aria-expanded={expanded.has(task.id)}
                    className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-[var(--color-fg-muted)] transition-colors hover:text-[var(--color-fg)]"
                  >
                    <ChevronDown
                      className={cn(
                        "size-3 transition-transform",
                        expanded.has(task.id) && "rotate-180",
                      )}
                    />
                    Score breakdown
                  </button>
                  {expanded.has(task.id) && (
                    <FactorBreakdown task={task} />
                  )}
                </>
              )}
              {task.blocked_by && (
                <p className="mt-1 text-[12px] text-[var(--color-status-blocked-fg)]">
                  Blocked by: {task.blocked_by}
                </p>
              )}

              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--color-fg-muted)]">
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
                <span
                  className={cn(
                    "flex items-center gap-1.5",
                    isOverdue(task.due_date) &&
                      task.status !== "done" &&
                      "text-[var(--color-danger)]",
                  )}
                >
                  <CalendarDays className="size-3.5" />
                  {formatDate(task.due_date)}
                </span>
                <span className="font-mono text-[var(--color-fg-subtle)]">
                  est {formatMinutes(task.estimated_minutes)}
                </span>
                <label className="flex items-center gap-1.5">
                  <span className="font-mono text-[var(--color-fg-subtle)]">
                    actual
                  </span>
                  <input
                    type="number"
                    min={0}
                    defaultValue={task.actual_minutes || ""}
                    placeholder="min"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (v !== task.actual_minutes) logTime(task.id, v);
                    }}
                    className="h-6 w-16 rounded-xs border border-[var(--color-border)] bg-[var(--color-surface)] px-1.5 text-[12px] focus:border-[var(--color-accent)] focus:outline-none"
                  />
                </label>
              </div>
            </div>

            <select
              value={task.status}
              onChange={(e) =>
                changeStatus(task.id, e.target.value as TaskStatus)
              }
              className="h-7 shrink-0 rounded-sm border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[12px] font-medium text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
            >
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
        </div>
      ))}
    </div>
  );
}
