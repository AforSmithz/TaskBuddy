"use client";

import { useState, useTransition } from "react";
import {
  AlertTriangle,
  ArrowRight,
  CalendarClock,
  Check,
  ListOrdered,
} from "lucide-react";
import type { RecoveryPlan } from "@/lib/types";
import { deferTaskAction, setProjectDeadlineAction } from "@/lib/actions";
import { band, formatPct } from "@/components/forecast/forecast-meter";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/cn";

function toneText(p: number): string {
  const b = band(p);
  return b === "off"
    ? "text-[var(--color-danger)]"
    : b === "risk"
      ? "text-[var(--color-accent-fg)]"
      : "text-[var(--color-status-done)]";
}

/**
 * Proactive recovery plan for an off-track project. Each move is one-click
 * applicable; the server re-runs the forecast and the callout re-renders (and
 * disappears once the project is back on track). Re-sequence is advisory only.
 */
export function RecoveryCallout({ plan }: { plan: RecoveryPlan }) {
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [appliedTasks, setAppliedTasks] = useState<Set<string>>(new Set());
  const [rescheduled, setRescheduled] = useState(false);

  function applyDefer(taskId: string) {
    setBusy(taskId);
    startTransition(async () => {
      await deferTaskAction(taskId, true);
      setAppliedTasks((s) => new Set(s).add(taskId));
      setBusy(null);
    });
  }

  function applyReschedule(deadline: string) {
    setBusy("reschedule");
    startTransition(async () => {
      await setProjectDeadlineAction(plan.projectId, deadline);
      setRescheduled(true);
      setBusy(null);
    });
  }

  const defer = plan.defer.filter((m) => !appliedTasks.has(m.taskId));
  const sequence = plan.sequence.slice(0, 4);
  // Critical = the deadline itself is in jeopardy; warning = on time but needs
  // attention (a blocked or overdue task). Drives the framing and accent.
  const critical = plan.reasons.some((r) => r.severity === "critical");
  // No automatic move recovers it (warning-only, or genuinely out of reach).
  const noRecovery = plan.defer.length === 0 && !plan.reschedule;

  return (
    <div
      className={cn(
        "rounded-lg border border-[var(--color-border)] border-l-2 bg-[var(--color-surface-raised)] p-4",
        critical ? "border-l-[var(--color-danger)]" : "border-l-[var(--color-accent)]",
      )}
    >
      {/* Why we flagged it */}
      <div className="flex items-start gap-2.5">
        <AlertTriangle
          className={cn(
            "mt-0.5 size-4 shrink-0",
            critical ? "text-[var(--color-danger)]" : "text-[var(--color-accent-fg)]",
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <p className="text-[13px] font-semibold text-[var(--color-fg)]">
              {critical ? "This project is off track" : "This project needs attention"}
            </p>
            <p className="text-[12px] text-[var(--color-fg-muted)]">
              now{" "}
              <span
                className={cn(
                  "font-semibold tabular-nums",
                  toneText(plan.currentProbability),
                )}
              >
                {formatPct(plan.currentProbability)}
              </span>{" "}
              on time
            </p>
          </div>
          <p className="mt-1 text-[12px] text-[var(--color-fg-muted)]">
            {plan.reasons.map((r) => r.detail).join(" · ")}
          </p>
        </div>
      </div>

      {/* Defer moves */}
      {defer.length > 0 && (
        <div className="mt-3.5 space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            Recover by deferring
          </p>
          {defer.map((m) => (
            <div
              key={m.taskId}
              className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5"
            >
              <ArrowRight className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-muted)]">
                {m.title}
              </span>
              <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[var(--color-status-done)]">
                → {formatPct(m.probabilityAfter)}
              </span>
              <Button
                variant="secondary"
                size="sm"
                loading={busy === m.taskId}
                disabled={pending}
                onClick={() => applyDefer(m.taskId)}
              >
                Defer
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Re-date suggestion */}
      {plan.reschedule && !rescheduled && (
        <div className="mt-3.5 space-y-1.5">
          <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {defer.length > 0 ? "Or move the deadline" : "Recover by moving the deadline"}
          </p>
          <div className="flex items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5">
            <CalendarClock className="size-3.5 shrink-0 text-[var(--color-fg-subtle)]" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-muted)]">
              Move to {formatDate(plan.reschedule.deadline)}
            </span>
            <span className="shrink-0 text-[12px] font-semibold tabular-nums text-[var(--color-status-done)]">
              → {formatPct(plan.reschedule.probabilityAfter)}
            </span>
            <Button
              variant="secondary"
              size="sm"
              loading={busy === "reschedule"}
              disabled={pending}
              onClick={() => applyReschedule(plan.reschedule!.deadline)}
            >
              Move
            </Button>
          </div>
        </div>
      )}

      {rescheduled && (
        <p className="mt-3 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
          <Check className="size-3.5" /> Deadline moved — forecast updating.
        </p>
      )}

      {/* No automatic move recovers it — tell the user what's left to do. */}
      {noRecovery && (
        <p className="mt-3.5 text-[12px] text-[var(--color-fg-muted)]">
          {critical
            ? "No single move recovers this automatically — add hours or split the work."
            : "Clear the flagged tasks above to get back on track."}
        </p>
      )}

      {/* Advisory re-sequence */}
      {sequence.length > 0 && (
        <div className="mt-3.5">
          <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            <ListOrdered className="size-3.5" /> Suggested order
          </p>
          <ol className="mt-1.5 space-y-1">
            {sequence.map((s, i) => (
              <li
                key={s.taskId}
                className="flex items-center gap-2 text-[12px] text-[var(--color-fg-muted)]"
              >
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-overlay)] text-[10px] font-semibold tabular-nums text-[var(--color-fg-subtle)]">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
