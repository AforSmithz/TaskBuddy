"use client";

import { useState, useTransition } from "react";
import { Check } from "lucide-react";
import { updateWindowAvailabilityAction } from "@/lib/actions";
import {
  WINDOW_AVAILABILITY_VERSION,
  type WindowAvailability,
} from "@/lib/window-availability";
import { ALL_WINDOWS, WINDOW_LABELS, WINDOW_HOURS, type TimeWindow } from "@/lib/velocity";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

/** Relative weight presets per window — only the ratio matters (normalised to a share). */
const LEVELS: { label: string; value: number }[] = [
  { label: "None", value: 0 },
  { label: "Some", value: 1 },
  { label: "A lot", value: 2 },
];

/**
 * Pins how the day's hours split across the five time-of-day windows, overriding the
 * share TaskBuddy otherwise infers from your logged sessions. Weights are relative
 * (their ratio is the split); all "None" ⇒ unset, the inferred share is used. The save
 * action re-normalizes server-side. Only changes the plan once your pace per window is
 * learned — until then there's nothing to weight.
 */
export function WindowAvailabilityForm({
  availability,
}: {
  availability: WindowAvailability;
}) {
  const [pending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [weights, setWeights] = useState<Record<TimeWindow, number>>(() => {
    const w = {} as Record<TimeWindow, number>;
    for (const win of ALL_WINDOWS) w[win] = availability.weights[win] ?? 0;
    return w;
  });

  function setWeight(win: TimeWindow, value: number) {
    setWeights((w) => ({ ...w, [win]: value }));
    setSaved(false);
  }

  function save() {
    if (pending) return;
    startTransition(async () => {
      await updateWindowAvailabilityAction({
        version: WINDOW_AVAILABILITY_VERSION,
        weights,
      });
      setSaved(true);
    });
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2.5">
        {ALL_WINDOWS.map((win) => (
          <div
            key={win}
            className="flex flex-wrap items-center justify-between gap-3 rounded-[14px] border border-[var(--color-border)] px-3.5 py-3"
          >
            <span className="flex flex-col">
              <span className="text-[13.5px] font-medium text-[var(--color-fg)]">
                {WINDOW_LABELS[win]}
              </span>
              <span className="text-[11.5px] text-[var(--color-fg-subtle)]">
                {WINDOW_HOURS[win]}
              </span>
            </span>
            <div className="flex overflow-hidden rounded-[11px] border border-[var(--color-border)]">
              {LEVELS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={weights[win] === opt.value}
                  onClick={() => setWeight(win, opt.value)}
                  className={cn(
                    "px-3 py-1.5 text-[12.5px] font-medium transition-colors",
                    weights[win] === opt.value
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
