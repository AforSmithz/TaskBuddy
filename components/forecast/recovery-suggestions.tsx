"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Sparkles } from "lucide-react";
import type { GapKind, RecoveryPlan, RecoverySuggestion } from "@/lib/types";
import {
  acceptRecoveryTasksAction,
  suggestRecoveryTasksAction,
} from "@/lib/actions";
import { formatPct } from "@/components/forecast/forecast-meter";
import { useSuggestionJob } from "@/components/forecast/use-suggestion-job";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const GAP_LABEL: Record<GapKind, string> = {
  rework: "Rework",
  unblock: "Unblock",
  de_risk: "De-risk",
};

/** Only ask the LLM when reality actually created a hole - not for every warning. */
function hasGapSignals(plan: RecoveryPlan): boolean {
  return (
    plan.reasons.some((r) => r.severity === "critical") ||
    plan.blocked.length > 0 ||
    plan.overdue.length > 0
  );
}

/**
 * The LLM half of the recovery callout. The deterministic moves render
 * instantly above this; this fires the strategist on the queue (spinner), then
 * surfaces net-new corrective tasks the user must explicitly accept. The
 * preview probability is the deterministic forecast's, never the LLM's.
 */
export function RecoverySuggestions({ plan }: { plan: RecoveryPlan }) {
  const { phase, suggestion } = useSuggestionJob<RecoverySuggestion>(
    hasGapSignals(plan),
    () => suggestRecoveryTasksAction(plan.projectId),
    (s) => s.tasks.length > 0,
  );
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [accepted, setAccepted] = useState(false);
  const [pending, startTransition] = useTransition();

  if (phase === "empty") return null;

  if (phase === "loading") {
    return (
      <div className="mt-3.5 flex items-center gap-2 text-[12px] text-[var(--color-fg-subtle)]">
        <Loader2 className="size-3.5 animate-spin" />
        Looking for fixes…
      </div>
    );
  }

  if (!suggestion) return null;

  if (accepted) {
    return (
      <p className="mt-3.5 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
        <Check className="size-3.5" /> Tasks added — forecast updating.
      </p>
    );
  }

  // Tracked as the UNCHECKED set so "everything is checked" is the resting state rather than
  // something an effect has to seed once the job lands.
  const selectedCount = suggestion.tasks.length - deselected.size;
  const toggle = (i: number) =>
    setDeselected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  function accept() {
    if (!suggestion || selectedCount === 0) return;
    const chosen = suggestion.tasks.filter((_, i) => !deselected.has(i));
    startTransition(async () => {
      await acceptRecoveryTasksAction(plan.projectId, chosen);
      setAccepted(true);
    });
  }

  return (
    <div className="mt-3.5 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
        <Sparkles className="size-3.5" /> Suggested new tasks
      </p>
      <p className="text-[12px] text-[var(--color-fg-muted)]">
        {suggestion.rationale}
      </p>
      {suggestion.tasks.map((t, i) => (
        <label
          key={i}
          className="flex cursor-pointer items-center gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5"
        >
          <input
            type="checkbox"
            checked={!deselected.has(i)}
            disabled={pending}
            onChange={() => toggle(i)}
            className="size-3.5 shrink-0 accent-[var(--color-accent)]"
          />
          <span className="shrink-0 rounded-sm bg-[var(--color-surface-overlay)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
            {GAP_LABEL[t.gap_kind]}
          </span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-muted)]">
            {t.title}
          </span>
          <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
            {t.estimated_minutes}m
          </span>
        </label>
      ))}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span
          className={cn(
            "text-[12px] text-[var(--color-fg-muted)]",
            selectedCount === 0 && "opacity-50",
          )}
        >
          Adding all →{" "}
          <span className="font-semibold tabular-nums">
            {formatPct(suggestion.previewProbability)}
          </span>{" "}
          on time
        </span>
        <Button
          variant="secondary"
          size="sm"
          loading={pending}
          disabled={selectedCount === 0}
          onClick={accept}
        >
          Add {selectedCount > 0 ? selectedCount : ""} task
          {selectedCount === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
