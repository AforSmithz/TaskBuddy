"use client";

import { useOptimistic, useTransition } from "react";
import {
  TASK_STATUSES,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { TaskDetailRow, taskToRowData } from "@/components/entries/task-detail-row";
import {
  updateTaskStatusAction,
  logActualTimeAction,
} from "@/lib/actions";

export function TaskList({ tasks }: { tasks: Task[] }) {
  const [optimistic, setOptimistic] = useOptimistic(
    tasks,
    (current: Task[], update: { id: string; status: TaskStatus }) =>
      current.map((t) =>
        t.id === update.id ? { ...t, status: update.status } : t,
      ),
  );
  const [, startTransition] = useTransition();

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
        No tasks were extracted from this entry.
      </p>
    );
  }

  return (
    <div className="divide-y divide-[var(--color-border)]">
      {optimistic.map((task) => (
        <div key={task.id} className="px-5 py-3.5">
          <TaskDetailRow
            data={taskToRowData(task)}
            href={`/tasks/${task.id}`}
            metaTrailing={
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
            }
            trailing={
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
            }
          />
        </div>
      ))}
    </div>
  );
}
