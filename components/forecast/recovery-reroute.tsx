"use client";

import { useEffect, useState, useTransition } from "react";
import { AlertTriangle, ArrowRight, Check, Loader2, Route } from "lucide-react";
import type { RecoveryPlan, RerouteSuggestion } from "@/lib/types";
import { applyRerouteAction, suggestRerouteAction } from "@/lib/actions";
import { formatPct } from "@/components/forecast/forecast-meter";
import { Button } from "@/components/ui/button";

/**
 * A re-route only recovers the *forecast* when the deadline itself is in
 * jeopardy (over budget / at risk). On-time projects flagged only for a blocked
 * or overdue task don't need a whole new approach. No probability threshold here
 * — the LLM judges whether a genuinely different route exists, and the forecast
 * guardrail in `generateReroute` drops it if it doesn't clearly help.
 */
function hasRerouteSignals(plan: RecoveryPlan): boolean {
  return plan.reasons.some((r) => r.severity === "critical");
}

type Phase = "loading" | "ready" | "empty";

/**
 * The Re-route half of the recovery callout (Step 3): fires the strategist in
 * the background to propose a *whole-plan alternative* — a different approach to
 * the same deliverable — when the current path won't fit. All-or-nothing: the
 * user switches to the new approach or keeps the current plan. The preview
 * probability is the deterministic forecast's, never the LLM's.
 */
export function RecoveryReroute({ plan }: { plan: RecoveryPlan }) {
  const [phase, setPhase] = useState<Phase>(
    hasRerouteSignals(plan) ? "loading" : "empty",
  );
  const [suggestion, setSuggestion] = useState<RerouteSuggestion | null>(null);
  const [switched, setSwitched] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (phase !== "loading") return;
    let active = true;
    suggestRerouteAction(plan.projectId)
      .then((result) => {
        if (!active) return;
        if (result && result.tasks.length > 0) {
          setSuggestion(result);
          setPhase("ready");
        } else {
          setPhase("empty");
        }
      })
      .catch(() => active && setPhase("empty"));
    return () => {
      active = false;
    };
    // projectId identifies the plan; re-running on other field changes is unwanted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan.projectId]);

  if (phase === "empty") return null;

  if (phase === "loading") {
    return (
      <div className="mt-3.5 flex items-center gap-2 text-[12px] text-[var(--color-fg-subtle)]">
        <Loader2 className="size-3.5 animate-spin" />
        Looking for another approach…
      </div>
    );
  }

  if (!suggestion) return null;

  if (switched) {
    return (
      <p className="mt-3.5 flex items-center gap-1.5 text-[12px] text-[var(--color-status-done)]">
        <Check className="size-3.5" /> Switched approach — forecast updating.
      </p>
    );
  }

  function apply() {
    if (!suggestion) return;
    const replacedTaskIds = suggestion.replaces.map((r) => r.taskId);
    const tasks = suggestion.tasks;
    const degraded = suggestion.degradedCriteria;
    startTransition(async () => {
      await applyRerouteAction(plan.projectId, replacedTaskIds, tasks, degraded);
      setSwitched(true);
    });
  }

  return (
    <div className="mt-3.5 space-y-1.5">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
        <Route className="size-3.5" /> Try a different approach
      </p>
      <p className="text-[12px] font-medium text-[var(--color-fg)]">
        {suggestion.approach}
      </p>
      <p className="text-[12px] text-[var(--color-fg-muted)]">
        {suggestion.rationale}
      </p>

      <div className="rounded-md bg-[var(--color-surface)] px-2.5 py-2">
        {/* Current plan — what this replaces. */}
        <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          Replaces the current plan
        </p>
        <ul className="mt-1 space-y-0.5">
          {suggestion.replaces.map((r) => (
            <li key={r.taskId} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg-muted)] line-through">
                {r.title}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
                {r.estimated_minutes}m
              </span>
            </li>
          ))}
        </ul>

        {/* New approach. */}
        <p className="mt-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-fg-subtle)]">
          <ArrowRight className="size-3" /> New plan
        </p>
        <ul className="mt-1 space-y-0.5">
          {suggestion.tasks.map((t, i) => (
            <li key={i} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--color-fg)]">
                {t.title}
              </span>
              <span className="shrink-0 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
                {t.estimated_minutes}m
              </span>
            </li>
          ))}
        </ul>

        {/* The honest cost: definition-of-done this lighter route lowers (§5 gate
            check 2) — recorded as degraded notes on accept, never silently. */}
        {suggestion.degradedCriteria.length > 0 && (
          <>
            <p className="mt-2 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide text-[var(--color-cut-fg)]">
              <AlertTriangle className="size-3" /> Lowers your definition of done
            </p>
            <ul className="mt-1 space-y-0.5">
              {suggestion.degradedCriteria.map((d) => (
                <li key={d.criterionId} className="text-[12px] leading-snug">
                  <span className="text-[var(--color-fg-subtle)] line-through">
                    {d.text}
                  </span>{" "}
                  <span className="text-[var(--color-cut-fg)]">→ {d.note}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <span className="text-[12px] text-[var(--color-fg-muted)]">
          Switching →{" "}
          <span className="font-semibold tabular-nums">
            {formatPct(suggestion.previewProbability)}
          </span>{" "}
          on time
        </span>
        <Button variant="secondary" size="sm" loading={pending} onClick={apply}>
          Switch approach
        </Button>
      </div>
    </div>
  );
}
