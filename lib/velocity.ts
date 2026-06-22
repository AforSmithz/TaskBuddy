// The velocity model — substrate S2 (OVERHAUL §5a), the learning-loop layer that
// turns the one global estimation bias into a DIFFERENTIATED-BUT-GRACEFUL per-
// segment `(meanLog, sigma)`. It is what makes vision §5 real (per-domain
// multipliers — "focused practice runs 1.4×", "Work runs over") without the
// overfitting naïve hard segmentation would cause under sparse history.
//
// Pure + deterministic, types-only imports (no DB, no `server-only`) — the
// calibration/solver side of §0's propose/dispose, NEVER the LLM. It authors no
// probability: it only sharpens the per-task *inputs* the `forecast.ts` Monte
// Carlo already consumes. Mirrors `lib/buffer.ts` / `lib/grounding.ts`; unit-
// testable via the compiled-to-`/tmp` node harness. See
// `design/s2-context-tags-and-shrinkage.md`.
//
// The crux is one blend, in log space (where the residuals are ~Normal — the same
// reason `estimationModel` works there):
//
//     μ_s = μ₀ + B_s·(x̄_s − μ₀),   B_s = n_s / (n_s + κ)
//
// where μ₀/σ are the GLOBAL pooled prior (`estimationModel`), x̄_s/n_s are a
// segment's own residual mean + count, and κ is the shrinkage strength. This is
// empirical-Bayes / James–Stein partial pooling. No-regret:
//   • n_s = 0   → B = 0 → μ_s = μ₀   (a segment with no history is EXACTLY today's number)
//   • n_s = κ   → B = 0.5            (κ = "own samples needed to earn half weight")
//   • n_s → ∞   → B → 1 → μ_s = x̄_s (the fully differentiated model the vision promises)
// With a single segment, x̄_s IS the global mean, so every μ_s = μ₀ ⇒ bit-
// identical to today. It can only sharpen, never start worse than the prior.

import type { EstimationModel, SegmentModel, Task, TimeWindow } from "./types";
import { MIN_ESTIMATION_SAMPLES } from "./types";

// `TimeWindow` lives in types.ts (the `WorkSession` row uses it too); re-exported
// here so velocity's consumers keep a single import surface for the segment axes.
export type { TimeWindow } from "./types";

/**
 * One residual observation `log(actual / estimated)` on a completed unit of work,
 * tagged with the context we might key a segment by. Slice A populates
 * `residualLog` + `domain` only; `weekday`/`window` await session-clock capture
 * (Slice B/C) and are never read while we key by `domain`.
 */
export interface ResidualSample {
  /** `log(actual / estimated)` — exactly `estimationModel`'s per-task ingredient. */
  residualLog: number;
  /** `Task.area` — the pre-execution segment axis the forecast biases by (Slice A). */
  domain: string;
  /** 0=Sun..6=Sat — the local weekday you WORKED (post-execution; Slice C). */
  weekday: number;
  /** Time-of-day bucket you WORKED in (post-execution; Slice C). */
  window: TimeWindow;
}

/**
 * A fitted, shrunk velocity model over one segment axis. `forSegment(key)` is the
 * per-task `(meanLog, sigma)` the forecast samples with; an unknown/empty key (a
 * brand-new domain, or any key before the loop has data) returns the global prior
 * verbatim — so it forecasts identically to today.
 */
export interface VelocityModel {
  /** The pool — today's global `estimationModel`. The prior every segment shrinks toward. */
  global: EstimationModel;
  /** Shrunk model for a segment key; unknown/empty key ⇒ `=== global`. */
  forSegment(key: string): EstimationModel;
}

/**
 * Default shrinkage strength κ — "how many of its own samples a segment needs to
 * earn half its weight" (`B_s = n_s/(n_s+κ)`; at `n_s = κ`, `B = 0.5`). Deliberately
 * prior-favoring: ~8 own completions for half weight, ~24 for 75%, so a domain has
 * to CLEARLY and REPEATEDLY diverge before it overrides the pooled bias. The
 * empirical-Bayes estimate `κ̂ = σ²/τ̂²` is the named follow-on (design decision 2),
 * calibrated by S2's own loop once cross-segment data is dense.
 */
export const SHRINKAGE_STRENGTH = 8;

/**
 * Fit a velocity model: shrink each segment's residual mean toward the global
 * prior. Segment-key-AGNOSTIC — `keyOf` picks the axis (`s => s.domain` for Slice
 * A; `s => s.window` / `s => s.weekday` for Slice C), so the same core serves
 * every axis.
 *
 * Global trust gate (no double-counting the threshold): if the GLOBAL pool is
 * below `MIN_ESTIMATION_SAMPLES`, `estimationModel` already returned the unbiased
 * default and every shrunk segment would only pull back to it — so we skip
 * segmentation entirely and hand back the prior for every key. Per-segment
 * sparsity is handled by the shrinkage itself, not a second hard cutoff. As
 * `κ → ∞`, likewise everything → global. Either way: identical to today.
 */
export function fitVelocityModel(
  samples: ResidualSample[],
  keyOf: (s: ResidualSample) => string,
  prior: EstimationModel,
  opts: { strength?: number } = {},
): VelocityModel {
  const kappa = opts.strength ?? SHRINKAGE_STRENGTH;

  if (prior.sampleSize < MIN_ESTIMATION_SAMPLES || !Number.isFinite(kappa)) {
    return { global: prior, forSegment: () => prior };
  }

  // Per-segment running sum + count → mean residual x̄_s.
  const sum = new Map<string, number>();
  const count = new Map<string, number>();
  for (const s of samples) {
    const k = keyOf(s);
    sum.set(k, (sum.get(k) ?? 0) + s.residualLog);
    count.set(k, (count.get(k) ?? 0) + 1);
  }

  // Shrink each segment's mean toward the prior; keep sigma GLOBAL for v1
  // (decision 3 — per-segment variance from sparse data is even noisier than the
  // mean). Cache so `forSegment` is an O(1) lookup.
  const cache = new Map<string, EstimationModel>();
  for (const [k, n] of count) {
    const xbar = sum.get(k)! / n;
    const b = n / (n + kappa);
    const meanLog = prior.meanLog + b * (xbar - prior.meanLog);
    cache.set(k, { meanLog, sigma: prior.sigma, sampleSize: n });
  }

  return {
    global: prior,
    forSegment: (key) => cache.get(key) ?? prior,
  };
}

/**
 * Build domain-keyed residual samples from completed tasks — the Slice A source.
 * The gate MUST match `estimationModel` exactly (`done` + estimate > 0 + actual >
 * 0), so the segment residuals are precisely the pool the global prior averages
 * over: that exact correspondence is what makes a single domain reduce to the
 * global number. `weekday`/`window` are inert here (no session clock yet — Slice
 * B/C); keyed by `domain`, they're never read.
 */
export function taskResidualSamples(tasks: Task[]): ResidualSample[] {
  const out: ResidualSample[] = [];
  for (const t of tasks) {
    if (t.status === "done" && t.estimated_minutes > 0 && t.actual_minutes > 0) {
      out.push({
        residualLog: Math.log(t.actual_minutes / t.estimated_minutes),
        domain: t.area,
        weekday: 0,
        window: "morning",
      });
    }
  }
  return out;
}

/** The forecast-facing slice of a fitted segment model (drops `sampleSize`). */
export function toSegmentModel(m: EstimationModel): SegmentModel {
  return { meanLog: m.meanLog, sigma: m.sigma };
}

/**
 * The local time-of-day bucket for an hour 0–23 (OVERHAUL S2 window axis). Fixed
 * boundaries — early 05–09 · morning 09–12 · afternoon 12–17 · evening 17–22 ·
 * night 22–05. Call with the user's LOCAL hour (`new Date().getHours()` on the
 * client) so the window is in the user's own timezone, never re-derived from a UTC
 * instant. Used by `localSessionStamp` (slice B capture) and the slice-C energy reads.
 */
export function windowOf(localHour: number): TimeWindow {
  if (localHour >= 5 && localHour < 9) return "early";
  if (localHour >= 9 && localHour < 12) return "morning";
  if (localHour >= 12 && localHour < 17) return "afternoon";
  if (localHour >= 17 && localHour < 22) return "evening";
  return "night"; // 22:00–04:59
}
