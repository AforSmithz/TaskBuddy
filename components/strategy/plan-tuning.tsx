import { SlidersHorizontal } from "lucide-react";
import type { PlanTuning } from "@/lib/types";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";

// "How your plan is tuned to you" (OVERHAUL S3c-5, design §7 / S5) - a read-only
// surface that shows how the calibration seam has adjusted the plan's SOFT knobs to
// the user's own behaviour: the arrangement dials it learns from drag-to-reorder, the
// plan stickiness it learns from roll-undos, and the recovery taste it learns from the
// moves you keep vs decline. Pure (no "use client") - every value is computed
// server-side and shipped whole; this renders, computing nothing (Hard Rule §2.8 /
// invariant 3). Mirrors `reliable-hours.tsx` (the same S2/S3c "here's what the app
// learned about you" pattern), so it sits beside it on the Strategy page.
//
// Honest under sparse data: both tiers start at their documented default and only move
// off it on real, repeated evidence (the κ=12 shrinkage), so most dials read "default"
// until a habit is clear. The copy says the dials "settle in over time" rather than
// dressing up a barely-moved weight as a strong reading.

/** A weight within this of 1.0 reads as "default" rather than noise as signal. */
const DEFAULT_BAND = 0.02;

/** One arrangement dial's label + what each direction means for the user. */
const DIALS: Record<
  keyof PlanTuning["arrange"]["weights"],
  { name: string; up: string; down: string; needsWindow?: boolean }
> = {
  switch: {
    name: "Grouping similar work",
    up: "tighter — fewer context switches",
    down: "looser — more willing to interleave",
  },
  domain: {
    name: "Keeping a life-area together",
    up: "tighter — finishes one area before the next",
    down: "looser — more willing to mix areas",
  },
  energy: {
    name: "Hard work in your best hours",
    up: "stronger pull into fast windows",
    down: "gentler pull into fast windows",
    needsWindow: true,
  },
  buffer: {
    name: "Protecting tight deadlines",
    up: "stronger fast-window claim for at-risk work",
    down: "gentler fast-window claim for at-risk work",
    needsWindow: true,
  },
};

/** The two 🟠-tier tiebreak nudges. Both scale the SAME sub-epsilon tie, so "more" for one
 *  is only meaningful against the other - the copy says which voice gets the casting vote. */
const STYLE_DIAL = {
  up: "your saved style settles more close calls",
  down: "your saved style settles fewer close calls",
};
const CAUSE_DIAL = {
  up: "the diagnosed cause settles more close calls",
  down: "the diagnosed cause settles fewer close calls",
};

function DialRow({
  name,
  weight,
  meaning,
  inert,
}: {
  name: string;
  weight: number;
  meaning: { up: string; down: string };
  inert: boolean;
}) {
  const delta = weight - 1;
  const atDefault = inert || Math.abs(delta) < DEFAULT_BAND;
  const state = atDefault ? "default" : delta > 0 ? meaning.up : meaning.down;
  const tone = atDefault
    ? "text-[var(--color-fg-subtle)]"
    : "text-[var(--color-accent-fg)]";
  return (
    <div className={cn("flex items-baseline justify-between gap-3", inert && "opacity-50")}>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-[var(--color-fg)]">{name}</p>
        <p className={cn("text-[11px]", tone)}>{state}</p>
      </div>
      <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--color-fg-muted)]">
        {atDefault ? "default" : `×${weight.toFixed(2)}`}
      </span>
    </div>
  );
}

/**
 * The "how your plan is tuned to you" card. The page guards it on there being at least
 * one signal (a drag or a material roll); each section still shows its own still-learning
 * state when only the other tier has evidence.
 */
export function PlanTuningCard({ tuning }: { tuning: PlanTuning }) {
  const { arrange, stability, movePrefs } = tuning;
  // The stickiness stiffness factor: both knobs scale by one factor off the same defaults,
  // so their ratio is the single "how much steadier than default" number (display-only, a
  // formatting transform over two shipped knobs - no knob is derived here).
  const factor = stability.priorMargin > 0 ? stability.stabilityMargin / stability.priorMargin : 1;
  const stiffer = factor > 1 + DEFAULT_BAND;

  return (
    <Card>
      <CardHeader
        title="How your plan is tuned to you"
        icon={<SlidersHorizontal className="size-4" />}
      />
      <div className="divide-y divide-[var(--color-border)]">
        {/* Arrangement dials - learned from drag-to-reorder. */}
        <section className="px-5 py-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              Sequencing
            </h3>
            <span className="text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
              {arrange.samples === 0
                ? "no reorders yet"
                : `${arrange.samples} reorder${arrange.samples > 1 ? "s" : ""} learned`}
            </span>
          </div>
          {arrange.samples === 0 ? (
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              Drag today&apos;s plan into the order you prefer, and TaskBuddy learns how
              you like your day sequenced. Nothing learned yet.
            </p>
          ) : (
            <div className="space-y-2.5">
              {(Object.keys(DIALS) as (keyof typeof DIALS)[]).map((k) => (
                <DialRow
                  key={k}
                  name={DIALS[k].name}
                  weight={arrange.weights[k]}
                  meaning={DIALS[k]}
                  inert={Boolean(DIALS[k].needsWindow) && !arrange.windowLearned}
                />
              ))}
              {!arrange.windowLearned && (
                <p className="pt-1 text-[11px] text-[var(--color-fg-subtle)]">
                  The energy and deadline dials start once your reliable hours are
                  learned. These settle in over time.
                </p>
              )}
            </div>
          )}
        </section>

        {/* Stickiness - learned from roll-undos. */}
        <section className="px-5 py-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              Plan stickiness
            </h3>
            <span className="text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
              {stability.materialRolls === 0
                ? "no reshuffles yet"
                : `${stability.reverts}/${stability.materialRolls} undone`}
            </span>
          </div>
          {stability.materialRolls === 0 ? (
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              TaskBuddy hasn&apos;t needed to reshuffle your plan yet. If it does and you
              undo it, TaskBuddy will hold your plan steadier before reshuffling again.
            </p>
          ) : (
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-[13px] text-[var(--color-fg)]">
                {stiffer
                  ? "Holding your plan steadier before reshuffling"
                  : "Reshuffling at the default readiness"}
              </p>
              <span className="shrink-0 text-[13px] font-semibold tabular-nums text-[var(--color-fg-muted)]">
                {stiffer ? `×${factor.toFixed(2)}` : "default"}
              </span>
            </div>
          )}
        </section>

        {/* Recovery taste - learned from which recommended moves you keep vs decline. */}
        <section className="px-5 py-4">
          <div className="mb-3 flex items-baseline justify-between">
            <h3 className="text-[12px] font-semibold uppercase tracking-wide text-[var(--color-fg-muted)]">
              Recovery taste
            </h3>
            <span className="text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
              {movePrefs.samples === 0
                ? "no decisions yet"
                : `${movePrefs.samples} decision${movePrefs.samples > 1 ? "s" : ""} learned`}
            </span>
          </div>
          {movePrefs.samples === 0 ? (
            <p className="text-[13px] text-[var(--color-fg-muted)]">
              When TaskBuddy recommends several ways to recover and you apply only some of
              them, it learns what should settle the next close call. Nothing learned yet.
            </p>
          ) : (
            <div className="space-y-2.5">
              <DialRow
                name="Your recovery style"
                weight={movePrefs.style}
                meaning={STYLE_DIAL}
                inert={!movePrefs.styleLearnable}
              />
              <DialRow name="Why the goal slipped" weight={movePrefs.cause} meaning={CAUSE_DIAL} inert={false} />
              {!movePrefs.styleLearnable && (
                <p className="pt-1 text-[11px] text-[var(--color-fg-subtle)]">
                  Your recovery style is Balanced, which expresses no preference, so there is
                  nothing for this dial to learn. Pick a style in Settings to teach it.
                </p>
              )}
            </div>
          )}
          <p className="pt-2.5 text-[11px] text-[var(--color-fg-subtle)]">
            These only settle ties the forecast can&apos;t. A move with better odds always
            wins, whatever the dials say.
          </p>
        </section>
      </div>
    </Card>
  );
}
