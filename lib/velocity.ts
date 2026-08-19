// The velocity model - turns the one global estimation bias into a differentiated-but-graceful
// per-segment (meanLog, sigma). This is what makes per-domain multipliers real ("focused
// practice runs 1.4x", "Work runs over") without the overfitting naive hard segmentation would
// cause under sparse history.
//
// Pure and deterministic, types-only imports. It authors no probability - it only sharpens the
// per-task INPUTS the forecast Monte Carlo already consumes. See
// design/s2-context-tags-and-shrinkage.md.
//
// The crux is one blend, in log space (where residuals are ~Normal):
//
//     mu_s = mu0 + B_s*(xbar_s - mu0),   B_s = n_s / (n_s + kappa)
//
// mu0/sigma are the global pooled prior, xbar_s/n_s a segment's own residual mean and count,
// kappa the shrinkage strength. Empirical-Bayes partial pooling, so: n_s = 0 gives B = 0 and
// exactly today's number; n_s = kappa gives B = 0.5 ("own samples needed for half weight");
// n_s -> inf gives the fully differentiated model. With a single segment xbar_s IS the global
// mean, so it can only sharpen, never start worse than the prior.

import type {
  EstimationModel,
  SegmentModel,
  Task,
  TimeWindow,
  WorkSession,
} from "@/lib/types";
import { MIN_ESTIMATION_SAMPLES } from "@/lib/types";

// `TimeWindow` lives in types.ts (the `WorkSession` row uses it too); re-exported
// here so velocity's consumers keep a single import surface for the segment axes.
export type { TimeWindow } from "@/lib/types";

/** One residual observation log(actual / estimated) on a completed unit of work, tagged with
 *  the context we might key a segment by. */
export interface ResidualSample {
  /** `log(actual / estimated)` - exactly `estimationModel`'s per-task ingredient. */
  residualLog: number;
  /** `Task.area` - the pre-execution segment axis the forecast biases by (Slice A). */
  domain: string;
  /** 0=Sun..6=Sat - the local weekday you WORKED (post-execution; Slice C). */
  weekday: number;
  /** Time-of-day bucket you WORKED in (post-execution; Slice C). */
  window: TimeWindow;
}

/** A fitted, shrunk velocity model over one segment axis. forSegment(key) is the per-task
 *  (meanLog, sigma) the forecast samples with; an unknown or empty key returns the global prior
 *  verbatim, so it forecasts identically to today. */
export interface VelocityModel {
  /** The pool - today's global `estimationModel`. The prior every segment shrinks toward. */
  global: EstimationModel;
  /** Shrunk model for a segment key; unknown/empty key ⇒ `=== global`. */
  forSegment(key: string): EstimationModel;
}

/** Shrinkage strength kappa - how many of its own samples a segment needs to earn half its
 *  weight. Deliberately prior-favoring: ~8 own completions for half, ~24 for 75%, so a domain
 *  has to clearly and repeatedly diverge before it overrides the pooled bias. */
export const SHRINKAGE_STRENGTH = 8;

/** Fit a velocity model by shrinking each segment's residual mean toward the global prior.
 *  Segment-key agnostic - `keyOf` picks the axis, so the same core serves every one.
 *
 *  Global trust gate: if the GLOBAL pool is below MIN_ESTIMATION_SAMPLES, estimationModel
 *  already returned the unbiased default and every shrunk segment would only pull back to it, so
 *  skip segmentation entirely. Per-segment sparsity is handled by the shrinkage itself, not a
 *  second hard cutoff. */
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
  // (decision 3 - per-segment variance from sparse data is even noisier than the
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

/** Build domain-keyed residual samples from completed tasks. The gate MUST match
 *  estimationModel exactly (done + estimate > 0 + actual > 0) so the segment residuals are
 *  precisely the pool the global prior averages over - that correspondence is what makes a
 *  single domain reduce to the global number. */
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

export function toSegmentModel(m: EstimationModel): SegmentModel {
  return { meanLog: m.meanLog, sigma: m.sigma };
}

/** Local time-of-day bucket for an hour 0-23: early 05-09, morning 09-12, afternoon 12-17,
 *  evening 17-22, night 22-05. Call with the user's LOCAL hour so the window is in their own
 *  timezone, never re-derived from a UTC instant. */
export function windowOf(localHour: number): TimeWindow {
  if (localHour >= 5 && localHour < 9) return "early";
  if (localHour >= 9 && localHour < 12) return "morning";
  if (localHour >= 12 && localHour < 17) return "afternoon";
  if (localHour >= 17 && localHour < 22) return "evening";
  return "night"; // 22:00 - 04:59
}

/** Every window, in clock order - so a read covers them all even when unobserved. */
export const ALL_WINDOWS: readonly TimeWindow[] = [
  "early",
  "morning",
  "afternoon",
  "evening",
  "night",
] as const;

/** Human labels for the windows - shared by the UI surface + diagnosis messages. */
export const WINDOW_LABELS: Record<TimeWindow, string> = {
  early: "early-morning",
  morning: "morning",
  afternoon: "afternoon",
  evening: "evening",
  night: "late-night",
};

/** Clock ranges for the windows - the UI shows these under each label. */
export const WINDOW_HOURS: Record<TimeWindow, string> = {
  early: "05–09",
  morning: "09–12",
  afternoon: "12–17",
  evening: "17–22",
  night: "22–05",
};

/** One time-of-day window's learned velocity - the read behind "your reliable hours" and the
 *  arrangement layer's hard-work placement. */
export interface EnergyWindow {
  window: TimeWindow;
  /** `exp(meanLog)` - work runs this × your estimate here. >1 = slower, <1 = faster. */
  multiplier: number;
  /** This window's OWN session count - 0 when unobserved (then `multiplier` is the global baseline). */
  sampleSize: number;
}

/** Per-window velocity multipliers: the same shrinkage core keyed by window, exposed as a
 *  stable all-windows read. A window with no sessions reports sampleSize 0 and the global
 *  multiplier so a consumer can de-emphasize it; a thin window is already shrunk toward the
 *  prior, so it never over-states sparse evidence. */
export function energyWindows(
  samples: ResidualSample[],
  prior: EstimationModel,
): EnergyWindow[] {
  const vm = fitVelocityModel(samples, (s) => s.window, prior);
  const counts = new Map<TimeWindow, number>();
  for (const s of samples) counts.set(s.window, (counts.get(s.window) ?? 0) + 1);
  return ALL_WINDOWS.map((w) => ({
    window: w,
    multiplier: Math.exp(vm.forSegment(w).meanLog),
    sampleSize: counts.get(w) ?? 0,
  }));
}

/** Join work_sessions to their tasks to produce window/weekday-tagged residuals - the source
 *  for energyWindows and the placement tempering. Only TASK sessions yield a residual (a routine
 *  session has no estimate), under the same gate as taskResidualSamples so a residual means the
 *  same thing across axes. */
export function workSessionResidualSamples(
  sessions: WorkSession[],
  tasksById: Map<string, Task>,
): ResidualSample[] {
  const out: ResidualSample[] = [];
  for (const s of sessions) {
    if (!s.task_id) continue;
    const t = tasksById.get(s.task_id);
    if (!t || t.estimated_minutes <= 0 || t.actual_minutes <= 0) continue;
    out.push({
      residualLog: Math.log(t.actual_minutes / t.estimated_minutes),
      domain: t.area,
      weekday: s.weekday,
      window: s.time_window,
    });
  }
  return out;
}
