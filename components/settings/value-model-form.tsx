"use client";

import { useState, useTransition } from "react";
import { Check, Info } from "lucide-react";
import { updateValueModelAction } from "@/lib/actions";
import {
  NEUTRAL_AREA_WEIGHT,
  VALUE_MODEL_VERSION,
  type RecoveryStyle,
  type ValueModel,
} from "@/lib/value-model";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Discrete importance presets - friendlier than a raw 0.25 - 3 slider. */
const WEIGHT_OPTIONS: { label: string; value: number }[] = [
  { label: "Background", value: 0.5 },
  { label: "Normal", value: 1 },
  { label: "High", value: 2 },
  { label: "Critical", value: 3 },
];

const RECOVERY_OPTIONS: {
  value: RecoveryStyle;
  label: string;
  blurb: string;
}[] = [
  {
    value: "protect_work",
    label: "Protect the work",
    blurb: "Keep the tasks — move deadlines or lighten scope before dropping anything.",
  },
  {
    value: "protect_dates",
    label: "Protect the dates",
    blurb: "Hold the deadlines — cut or shed lower-value work to hit them.",
  },
  {
    value: "balanced",
    label: "Balanced",
    blurb: "No lean — let the odds alone pick the recovery.",
  },
];

/**
 * Edits the Value Model: a recovery-style lean + a per-area importance weight.
 * Weights default to Normal; only non-neutral ones are persisted. The save action
 * re-normalizes server-side, so the form just sends its current view.
 */
/** A goal the user can weight individually. */
export interface WeightableGoal {
  id: string;
  name: string;
}

/** Sentinel for "no explicit weight - derive this goal's value from its areas". */
const DERIVED = "derived";
type GoalWeight = number | typeof DERIVED;

/** The area presets, plus the "defer to my area weights" default that leads them. */
const GOAL_WEIGHT_OPTIONS: { label: string; value: GoalWeight }[] = [
  { label: "From areas", value: DERIVED },
  ...WEIGHT_OPTIONS,
];

export function ValueModelForm({
  model,
  areas,
  goals,
  weightsActive,
}: {
  model: ValueModel;
  areas: string[];
  /** Open goals, offered a per-goal importance override. */
  goals: WeightableGoal[];
  /**
   * Whether the saved area weights currently reorder the plan (server-computed).
   * When false, they're inert (enough slack that work follows deadlines) and we
   * say so, rather than let the user think a dormant weight is doing something.
   */
  weightsActive: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [style, setStyle] = useState<RecoveryStyle>(model.recoveryStyle);
  const [weights, setWeights] = useState<Record<string, number>>(() =>
    Object.fromEntries(
      areas.map((a) => [a, model.areaWeights[a] ?? NEUTRAL_AREA_WEIGHT]),
    ),
  );
  // `DERIVED` (not a number) when unset, so an explicit "Normal" is distinguishable
  // from "unset" - the former overrides the area-derived value, the latter defers
  // to it. `goalValue()` depends on exactly that distinction.
  const [goalWeights, setGoalWeights] = useState<Record<string, GoalWeight>>(() =>
    Object.fromEntries(goals.map((g) => [g.id, model.projectWeights[g.id] ?? DERIVED])),
  );

  function setWeight(area: string, value: number) {
    setWeights((w) => ({ ...w, [area]: value }));
    setSaved(false);
  }
  function setGoalWeight(goalId: string, value: GoalWeight) {
    setGoalWeights((w) => ({ ...w, [goalId]: value }));
    setSaved(false);
  }
  function pickStyle(next: RecoveryStyle) {
    setStyle(next);
    setSaved(false);
  }

  function save() {
    if (pending) return;
    const areaWeights: Record<string, number> = {};
    for (const [area, value] of Object.entries(weights)) {
      if (value !== NEUTRAL_AREA_WEIGHT) areaWeights[area] = value;
    }
    // An explicit neutral IS persisted here (unlike an area) - see `goalValue`.
    const projectWeights: Record<string, number> = {};
    for (const [goalId, value] of Object.entries(goalWeights)) {
      if (value !== DERIVED) projectWeights[goalId] = value;
    }
    startTransition(async () => {
      await updateValueModelAction({
        version: VALUE_MODEL_VERSION,
        areaWeights,
        recoveryStyle: style,
        projectWeights,
      });
      setSaved(true);
    });
  }

  return (
    <div className="space-y-8">
      {/* Recovery style */}
      <fieldset className="space-y-3">
        <legend className="text-[14px] font-semibold text-[var(--color-fg)]">
          When something slips
        </legend>
        <p className="text-[13px] text-[var(--color-fg-muted)]">
          How the strategist should lean when projects compete for the same hours.
          It only breaks ties — the odds still decide.
        </p>
        <div className="grid gap-2.5 sm:grid-cols-3">
          {RECOVERY_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={style === opt.value}
              onClick={() => pickStyle(opt.value)}
              className={cn(
                "rounded-[14px] border p-3.5 text-left transition-colors",
                style === opt.value
                  ? "border-[var(--color-accent)] bg-[var(--color-accent-subtle)]"
                  : "border-[var(--color-border)] hover:border-[var(--color-fg-subtle)]",
              )}
            >
              <span
                className={cn(
                  "block text-[13.5px] font-semibold",
                  style === opt.value
                    ? "text-[var(--color-accent-fg)]"
                    : "text-[var(--color-fg)]",
                )}
              >
                {opt.label}
              </span>
              <span className="mt-1 block text-[12px] leading-snug text-[var(--color-fg-muted)]">
                {opt.blurb}
              </span>
            </button>
          ))}
        </div>
      </fieldset>

      {/* Area importance */}
      <fieldset className="space-y-3">
        <legend className="text-[14px] font-semibold text-[var(--color-fg)]">
          What matters most
        </legend>
        <p className="text-[13px] text-[var(--color-fg-muted)]">
          Weight a life-area up and its work is scheduled earlier and protected
          harder when the week gets tight.
        </p>
        <div className="space-y-2.5">
          {areas.map((area) => (
            <div
              key={area}
              className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] px-3.5 py-3"
            >
              <span className="text-[13.5px] font-medium text-[var(--color-fg)]">
                {area}
              </span>
              <div className="flex overflow-hidden rounded-[11px] border border-[var(--color-border)]">
                {WEIGHT_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={weights[area] === opt.value}
                    onClick={() => setWeight(area, opt.value)}
                    className={cn(
                      "px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                      weights[area] === opt.value
                        ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]"
                        : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {!weightsActive && (
          <p className="flex items-start gap-2 rounded-[12px] border border-[var(--color-border)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              These weights only reorder your plan when goals compete for the same
              hours — a deadline with more to do than time before it. Right now you
              have enough slack that your work just follows its deadlines, so
              they&apos;re recorded but aren&apos;t changing anything yet.
            </span>
          </p>
        )}
      </fieldset>

      {/* Per-goal importance */}
      {goals.length > 0 && (
        <fieldset className="space-y-3">
          <legend className="text-[14px] font-semibold text-[var(--color-fg)]">
            Individual goals
          </legend>
          <p className="text-[13px] text-[var(--color-fg-muted)]">
            By default a goal is worth as much as the areas its work sits in. Override
            one here and the strategist weights it that way when it has to choose which
            goals a single recovery should serve.
          </p>
          <div className="space-y-2.5">
            {goals.map((goal) => (
              <div
                key={goal.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] px-3.5 py-3"
              >
                <span className="text-[13.5px] font-medium text-[var(--color-fg)]">
                  {goal.name}
                </span>
                <div className="flex overflow-hidden rounded-[11px] border border-[var(--color-border)]">
                  {GOAL_WEIGHT_OPTIONS.map((opt) => (
                    <button
                      key={String(opt.value)}
                      type="button"
                      aria-pressed={goalWeights[goal.id] === opt.value}
                      onClick={() => setGoalWeight(goal.id, opt.value)}
                      className={cn(
                        "px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                        goalWeights[goal.id] === opt.value
                          ? "bg-[var(--color-accent-subtle)] text-[var(--color-accent-fg)]"
                          : "text-[var(--color-fg-muted)] hover:text-[var(--color-fg)]",
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="flex items-start gap-2 rounded-[12px] border border-[var(--color-border)] px-3 py-2.5 text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Unlike area weights, a goal&apos;s importance doesn&apos;t reorder your
              plan. It decides whose problem a shared recovery is solving when one move
              touches several goals at once.
            </span>
          </p>
        </fieldset>
      )}

      <div className="flex items-center gap-3">
        <Button type="button" variant="primary" onClick={save} loading={pending}>
          Save changes
        </Button>
        {saved && !pending && (
          <span className="flex items-center gap-1.5 text-[13px] text-[var(--color-accent-fg)]">
            <Check className="size-4" />
            Saved
          </span>
        )}
      </div>
    </div>
  );
}
