"use client";

import { useState, useTransition } from "react";
import { ArrowRight, Check, Loader2, Scissors } from "lucide-react";
import type {
  ModificationKind,
  ModificationSuggestion,
  RecoveryPlan,
} from "@/lib/types";
import {
  applyModificationsAction,
  suggestModificationsAction,
} from "@/lib/actions";
import { formatPct } from "@/components/forecast/forecast-meter";
import { useSuggestionJob } from "@/components/forecast/use-suggestion-job";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

const MOD_LABEL: Record<ModificationKind, string> = {
  scope_down: "Scope down",
  split: "Split",
};

/**
 * Reshaping only recovers the *forecast* when the deadline itself is in jeopardy
 * (over budget / at risk). A project flagged only for a blocked or overdue task
 * is on time - its fix is Generate's unblock, not reshaping the plan.
 */
function hasModifySignals(plan: RecoveryPlan): boolean {
  return plan.reasons.some((r) => r.severity === "critical");
}

/**
 * The Modify half of the recovery callout (Step 2): puts the strategist on the
 * queue to reshape existing tasks - scope a task down or split a monolith - so
 * the plan fits the budget. The user accepts explicitly; the preview
 * probability is the deterministic forecast's, never the LLM's.
 */
export function RecoveryModifications({ plan }: { plan: RecoveryPlan }) {
  const { phase, suggestion } = useSuggestionJob<ModificationSuggestion>(
    hasModifySignals(plan),
    () => suggestModificationsAction(plan.projectId),
    (s) => s.modifications.length > 0,
  );
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState(false);
  const [pending, startTransition] = useTransition();

  if (phase === "empty") return null;

  if (phase === "loading") {
    return (
      <div className="mt-3.5 flex items-center gap-2 text-[12px] text-[var(--color-fg-subtle)]">
        <Loader2 className="size-3.5 animate-spin" />
        Reshaping tasks…
      </div>
    );
  }

  if (!suggestion) return null;

  if (applied) {
    return (
      <p className="mt-3.5 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
        <Check className="size-3.5" /> Tasks reshaped — forecast updating.
      </p>
    );
  }

  // The UNCHECKED set - see RecoverySuggestions for why this is inverted.
  const selectedCount = suggestion.modifications.length - deselected.size;
  const toggle = (i: number) =>
    setDeselected((s) => {
      const next = new Set(s);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  function apply() {
    if (!suggestion || selectedCount === 0) return;
    const chosen = suggestion.modifications.filter((_, i) => !deselected.has(i));
    startTransition(async () => {
      await applyModificationsAction(plan.projectId, chosen);
      setApplied(true);
    });
  }

  return (
    <div className="mt-3.5 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
        <Scissors className="size-3.5" /> Reshape existing tasks
      </p>
      <p className="text-[12px] text-[var(--color-fg-muted)]">
        {suggestion.rationale}
      </p>
      {suggestion.modifications.map((m, i) => (
        <label
          key={i}
          className="flex cursor-pointer gap-2 rounded-md bg-[var(--color-surface)] px-2.5 py-1.5"
        >
          <input
            type="checkbox"
            checked={!deselected.has(i)}
            disabled={pending}
            onChange={() => toggle(i)}
            className="mt-0.5 size-3.5 shrink-0 accent-[var(--color-accent)]"
          />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="shrink-0 rounded-sm bg-[var(--color-surface-overlay)] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
                {MOD_LABEL[m.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-muted)] line-through">
                {m.taskTitle}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
                {m.originalEstimate}m
              </span>
            </div>
            {m.replacements.map((r, j) => (
              <div key={j} className="flex items-center gap-2 pl-1">
                <ArrowRight className="size-3 shrink-0 text-[var(--color-fg-subtle)]" />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg)]">
                  {r.title}
                </span>
                <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
                  {r.estimated_minutes}m
                </span>
              </div>
            ))}
          </div>
        </label>
      ))}
      <div className="flex items-center justify-between gap-2 pt-1">
        <span
          className={cn(
            "text-[12px] text-[var(--color-fg-muted)]",
            selectedCount === 0 && "opacity-50",
          )}
        >
          Applying all →{" "}
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
          onClick={apply}
        >
          Apply {selectedCount > 0 ? selectedCount : ""} change
          {selectedCount === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  );
}
