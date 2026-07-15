"use client";

import { useTransition } from "react";
import { Check, CalendarClock, Lock, Undo2, MoonStar } from "lucide-react";
import {
  TASK_STATUSES,
  STATUS_LABELS,
  type Task,
  type TaskStatus,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  updateTaskStatusAction,
  rescheduleTaskAction,
  deferTaskAction,
  unblockTaskAction,
  logActualTimeAction,
} from "@/lib/actions";
import { localSessionStamp } from "@/lib/work-session";

/**
 * The task detail page's action rail. Every control maps to an existing server
 * action (each revalidates, so the page re-renders with fresh data). Kept thin - 
 * no optimistic state - because a single task page isn't latency-sensitive the
 * way the board or Today list is.
 */
export function TaskActions({ task }: { task: Task }) {
  const [pending, startTransition] = useTransition();
  const run = (fn: () => Promise<void>) => startTransition(() => void fn());

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Status
        </span>
        <select
          value={task.status}
          disabled={pending}
          onChange={(e) =>
            run(() =>
              updateTaskStatusAction(
                task.id,
                e.target.value as TaskStatus,
                undefined,
                localSessionStamp(),
              ),
            )
          }
          className="mt-1 h-8 w-full rounded-sm border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-2 text-[13px] font-medium text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
        >
          {TASK_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Due date
        </span>
        <input
          type="date"
          defaultValue={task.due_date?.slice(0, 10) ?? ""}
          disabled={pending}
          onChange={(e) => {
            if (e.target.value) run(() => rescheduleTaskAction(task.id, e.target.value));
          }}
          className="mt-1 h-8 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </label>

      <label className="block">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Actual time (min)
        </span>
        <input
          type="number"
          min={0}
          defaultValue={task.actual_minutes || ""}
          placeholder="0"
          disabled={pending}
          onBlur={(e) => {
            const v = Number(e.target.value);
            if (v !== task.actual_minutes) run(() => logActualTimeAction(task.id, v));
          }}
          className="mt-1 h-8 w-full rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-[13px] text-[var(--color-fg)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </label>

      <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-3">
        {task.status !== "done" && (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() =>
              run(() =>
                updateTaskStatusAction(task.id, "done", undefined, localSessionStamp()),
              )
            }
          >
            <Check className="size-3.5" />
            Mark done
          </Button>
        )}
        {task.blocked_by && (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending}
            onClick={() => run(() => unblockTaskAction(task.id))}
          >
            <Lock className="size-3.5" />
            Unblock
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => run(() => deferTaskAction(task.id, !task.deferred))}
        >
          {task.deferred ? (
            <>
              <Undo2 className="size-3.5" />
              Restore
            </>
          ) : (
            <>
              <MoonStar className="size-3.5" />
              Defer
            </>
          )}
        </Button>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg-subtle)]">
        <CalendarClock className="size-3" />
        Rescheduling moves the due date only — the forecast tracks the project
        deadline and estimates.
      </p>
    </div>
  );
}
