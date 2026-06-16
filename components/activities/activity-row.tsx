"use client";

import { useTransition } from "react";
import { Archive, Check, Flame, Shield, ShieldOff } from "lucide-react";
import type { RecurringState } from "@/lib/types";
import {
  archiveActivityAction,
  logActivityCompletionAction,
  setActivityProtectedAction,
} from "@/lib/actions";
import { Pill } from "@/components/ui/badge";
import { formatMinutes } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Plain-language cadence summary for an activity. */
function cadenceLabel(state: RecurringState): string {
  const a = state.activity;
  if (a.period === "week") return `${a.target_count}× per week`;
  const weekdaysOnly =
    a.weekdays && a.weekdays.length === 5 && !a.weekdays.includes(0) && !a.weekdays.includes(6);
  return weekdaysOnly ? "Every weekday" : "Daily";
}

/** One manageable activity: cadence, streak/progress, protect toggle, log, archive. */
export function ActivityRow({ state }: { state: RecurringState }) {
  const { activity, status, streak, progress, doneToday } = state;
  const [pending, startTransition] = useTransition();

  const run = (fn: () => Promise<void>) => {
    if (pending) return;
    startTransition(fn);
  };

  return (
    <article className="flex items-center gap-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3.5 py-3">
      <button
        type="button"
        onClick={() =>
          !doneToday &&
          run(() => logActivityCompletionAction(activity.id, activity.estimated_minutes))
        }
        disabled={doneToday || pending}
        aria-label={`Log "${activity.title}" today`}
        title={doneToday ? "Done today" : "Log a session today"}
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
        <p className="truncate text-[14px] font-medium text-[var(--color-fg)]">
          {activity.title}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-fg-muted)]">
          <Pill>{activity.area}</Pill>
          <span>{cadenceLabel(state)}</span>
          <span className="font-mono text-[var(--color-fg-subtle)]">
            {formatMinutes(activity.estimated_minutes)}
          </span>
          {activity.period === "day"
            ? streak > 0 && (
                <span className="flex items-center gap-1 font-medium text-[var(--color-accent-fg)]">
                  <Flame className="size-3" />
                  {streak} day{streak === 1 ? "" : "s"}
                </span>
              )
            : (
                <span className="tabular-nums text-[var(--color-fg-subtle)]">
                  {progress.done}/{progress.target} this week
                </span>
              )}
          {status === "missed" && (
            <span className="font-medium text-[var(--color-accent-fg)]">behind</span>
          )}
          {status === "cold" && (
            <span className="text-[var(--color-fg-subtle)]">gone cold</span>
          )}
        </div>
      </div>

      {/* Protect toggle */}
      <button
        type="button"
        onClick={() =>
          run(() => setActivityProtectedAction(activity.id, !activity.protected))
        }
        disabled={pending}
        title={
          activity.protected
            ? "Protected — the strategist won't sacrifice this. Click to unprotect."
            : "Discretionary — first to be sacrificed. Click to protect."
        }
        aria-label={activity.protected ? "Unprotect activity" : "Protect activity"}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors",
          activity.protected
            ? "border-[var(--color-accent-subtle)] bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]"
            : "border-[var(--color-border)] text-[var(--color-fg-subtle)] hover:text-[var(--color-fg-muted)]",
        )}
      >
        {activity.protected ? (
          <Shield className="size-3.5" />
        ) : (
          <ShieldOff className="size-3.5" />
        )}
      </button>

      {/* Archive */}
      <button
        type="button"
        onClick={() => run(() => archiveActivityAction(activity.id))}
        disabled={pending}
        title="Archive (keeps history)"
        aria-label="Archive activity"
        className="flex size-7 shrink-0 items-center justify-center rounded-md border border-[var(--color-border)] text-[var(--color-fg-subtle)] transition-colors hover:border-[var(--color-danger)] hover:text-[var(--color-danger)]"
      >
        <Archive className="size-3.5" />
      </button>
    </article>
  );
}
