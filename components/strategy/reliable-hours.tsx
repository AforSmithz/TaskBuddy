import { Clock } from "lucide-react";
import type { EnergyWindow } from "@/lib/velocity";
import { WINDOW_HOURS, WINDOW_LABELS } from "@/lib/velocity";
import { Card, CardHeader } from "@/components/ui/card";
import { cn } from "@/lib/cn";

// "Your reliable hours" (OVERHAUL S2 slice C) - a read-only surface that shows how
// work runs vs. your estimates by time-of-day window, derived from accruing work
// sessions. Pure (no "use client") - server-rendered, no interaction. The
// strategist consumes the same window read to temper its cause diagnosis, so it
// lives on the Strategy page next to that reasoning.
//
// Honest under sparse data: each window's multiplier is the SHRUNK value
// (`exp(μ_s)`, already pulled toward your global norm), never a raw mean, so a thin
// window can't over-state itself; thin windows are visually de-emphasized and the
// whole surface falls back to a "still learning" state until any window has signal.

/** A window needs at least this many sessions to render as a confident bar. */
const MIN_WINDOW_SAMPLES = 3;
/** Bars saturate at ±this deviation so one outlier can't dwarf the rest. */
const BAR_CLAMP = 0.6;
/** Within ±this of estimate reads as "on est." rather than noise as signal. */
const ON_ESTIMATE_BAND = 0.08;

function deviationLabel(multiplier: number): {
  text: string;
  tone: "over" | "under" | "on";
} {
  const pct = Math.round((multiplier - 1) * 100);
  if (Math.abs(multiplier - 1) < ON_ESTIMATE_BAND) return { text: "on est.", tone: "on" };
  if (pct > 0) return { text: `+${pct}%`, tone: "over" };
  return { text: `${pct}%`, tone: "under" }; // pct already carries the minus sign
}

function WindowRow({ w }: { w: EnergyWindow }) {
  const thin = w.sampleSize < MIN_WINDOW_SAMPLES;
  const { text, tone } = deviationLabel(w.multiplier);
  // Diverging bar from a centre line: right = slower than estimate, left = faster.
  const dev = Math.max(-BAR_CLAMP, Math.min(BAR_CLAMP, w.multiplier - 1));
  const widthPct = (Math.abs(dev) / BAR_CLAMP) * 50;
  const slower = dev > 0;
  const fill =
    tone === "over"
      ? "bg-[var(--color-danger)]"
      : tone === "under"
        ? "bg-[var(--color-status-done)]"
        : "bg-[var(--color-fg-muted)]";
  const labelTone =
    tone === "over"
      ? "text-[var(--color-danger)]"
      : tone === "under"
        ? "text-[var(--color-status-done)]"
        : "text-[var(--color-fg-muted)]";

  return (
    <div className={cn("flex items-center gap-3", thin && "opacity-50")}>
      <div className="w-28 shrink-0">
        <p className="text-[13px] font-medium capitalize text-[var(--color-fg)]">
          {WINDOW_LABELS[w.window]}
        </p>
        <p className="text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
          {WINDOW_HOURS[w.window]}
        </p>
      </div>

      <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-overlay)]">
        <div className="absolute left-1/2 top-0 h-full w-px -translate-x-1/2 bg-[var(--color-border-strong)]" />
        <div
          className={cn("absolute top-0 h-full rounded-full", fill)}
          style={
            slower
              ? { left: "50%", width: `${widthPct}%` }
              : { left: `${50 - widthPct}%`, width: `${widthPct}%` }
          }
        />
      </div>

      <div className="w-24 shrink-0 text-right">
        <span className={cn("text-[13px] font-semibold tabular-nums", labelTone)}>
          {text}
        </span>
        <span className="ml-1.5 text-[11px] tabular-nums text-[var(--color-fg-subtle)]">
          {thin ? "low data" : `${w.sampleSize}×`}
        </span>
      </div>
    </div>
  );
}

/**
 * The "your reliable hours" card. Render only when there's at least one session
 * (the page guards `totalSessions > 0`); below any confident window it shows the
 * still-learning state rather than dressing up noise.
 */
export function ReliableHours({ windows }: { windows: EnergyWindow[] }) {
  const hasSignal = windows.some((w) => w.sampleSize >= MIN_WINDOW_SAMPLES);
  // Only windows you've actually worked in - an unobserved window is just the
  // global baseline, so showing it as a flat bar would imply a reading we don't have.
  const observed = windows.filter((w) => w.sampleSize > 0);

  return (
    <Card>
      <CardHeader title="Your reliable hours" icon={<Clock className="size-4" />} />
      {!hasSignal ? (
        <p className="px-5 py-6 text-[13px] text-[var(--color-fg-muted)]">
          Still learning your hours — complete tasks across the day and this will
          show when your work runs to estimate and when it tends to slip.
        </p>
      ) : (
        <div className="space-y-3 px-5 py-4">
          {observed.map((w) => (
            <WindowRow key={w.window} w={w} />
          ))}
          <p className="pt-1 text-[11px] text-[var(--color-fg-subtle)]">
            How long work runs vs. your estimate, by time of day. Bars right of
            centre ran longer; left, faster. Faint rows have little data yet.
          </p>
        </div>
      )}
    </Card>
  );
}
