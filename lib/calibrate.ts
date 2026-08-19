// The calibration seam - the shared empirical-Bayes core that turns fixed soft-knob constants
// (the churn hysteresis, the arrangement weights) into values LEARNED from the user's own
// behaviour without ever starting worse than the constant.
//
// Pure, deterministic, zero imports. Authors no odds: every knob it returns feeds the SOFT
// layer only, which the odds gate already dominates. Same shrink-to-prior discipline as
// lib/velocity.ts. See design/s3c5-shared-calibration-brain.md.
//
// One idea in two shapes:
//
//     B = n / (n + kappa)                    // EB / James-Stein shrinkage weight
//     scalar:  x = x0 + B*(xbar - x0)        // a rate -> a knob (hysteresis)
//     vector:  w = w0 + B*(w_raw - w0)       // preference pairs -> weights (arrange)
//
// No-regret is structural: n = 0 gives B = 0 gives today's constant, bit-for-bit. Sparse or
// noisy evidence stays near the prior (large kappa). Any non-finite input falls back to it too.

/** The shrinkage weight B = n/(n+k) - how many of its OWN observations a statistic needs to
 *  earn half its weight. n <= 0 gives 0 (pure prior), non-finite k gives 0 (disabled), k <= 0
 *  gives 1 (trust the observation fully). Always in [0,1]. */
export function shrinkageWeight(n: number, kappa: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (!Number.isFinite(kappa)) return 0;
  if (kappa <= 0) return 1;
  return n / (n + kappa);
}

/** Clamp `x` into `[lo, hi]`; a non-finite `x` returns `lo` (the safe floor). */
export function clamp(x: number, lo: number, hi: number): number {
  if (!Number.isFinite(x)) return lo;
  return x < lo ? lo : x > hi ? hi : x;
}

/** Shrink one observed scalar toward its prior. n = 0 or a non-finite observation gives exactly
 *  the prior. The hysteresis consumer supplies the observed churn regret rate as `observed` and
 *  the rate the current constants are tuned for as `prior`, then maps the result to knob units. */
export function shrinkScalar(
  observed: number,
  prior: number,
  n: number,
  kappa: number,
): number {
  if (!Number.isFinite(observed) || !Number.isFinite(prior)) return prior;
  const b = shrinkageWeight(n, kappa);
  return prior + b * (observed - prior);
}

/** Shrink each component of a learned vector toward a prior vector. Length-mismatched or
 *  non-finite inputs fall back to a copy of the prior. `n` is the shared evidence count, and
 *  every component shrinks by the same B, preserving the vector's direction. */
export function shrinkVector(
  learned: readonly number[],
  prior: readonly number[],
  n: number,
  kappa: number,
): number[] {
  if (learned.length !== prior.length) return [...prior];
  const b = shrinkageWeight(n, kappa);
  return prior.map((p, i) => {
    const l = learned[i];
    return Number.isFinite(l) ? p + b * (l - p) : p;
  });
}

/** L2 norm of a vector; 0 for the zero (or any non-finite) vector. */
function norm(v: readonly number[]): number {
  let s = 0;
  for (const x of v) {
    if (!Number.isFinite(x)) return 0;
    s += x * x;
  }
  return Math.sqrt(s);
}

/** Dot product; returns 0 if either operand carries a non-finite component. */
function dot(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return 0;
    s += a[i] * b[i];
  }
  return s;
}

/** One revealed preference: the user's dragged order is preferred over the solver's. φ = (switch
 *  count, energy term, buffer term); the solver picks argmin w·φ, so "preferred" means the
 *  user's order should score LOWER. Both captured odds-neutral, so this is a pure soft contrast. */
export interface PreferencePair {
  /** `φ` of the arrangement the solver proposed (the dispreferred order). */
  solver: readonly number[];
  /** `φ` of the order the user dragged to (the preferred order). */
  user: readonly number[];
}

/** Tunables for `fitCalibratedWeights`. All prior-favouring by default. */
export interface WeightFitOptions {
  /** Perceptron step size (small ⇒ gentle nudges). Default {@link PERCEPTRON_ETA}. */
  eta?: number;
  /** Margin the contrast must violate before nudging. Default {@link PERCEPTRON_MARGIN}. */
  margin?: number;
  /** Shrinkage strength κ toward the prior. Default {@link CALIBRATE_KAPPA}. */
  kappa?: number;
  /** Lower clamp on every deployed weight (keeps the sign/meaning). Default {@link WEIGHT_MIN}. */
  lo?: number;
  /** Upper clamp on every deployed weight (blowup guard). Default {@link WEIGHT_MAX}. */
  hi?: number;
}

/** Shrinkage strength for this seam - deliberately stronger (more prior-favouring) than
 *  velocity's 8, because a preference signal is noisier than a duration residual: ~12
 *  observations for half weight, ~36 for 75%. The dials have to be clearly and repeatedly argued
 *  against before they move off the hand-tuned constant. */
export const CALIBRATE_KAPPA = 12;

/** Perceptron step size - small, so one drag is a gentle nudge, not a lurch. */
export const PERCEPTRON_ETA = 0.1;

/** Contrast margin before a nudge fires (0 = nudge on any strict violation). */
export const PERCEPTRON_MARGIN = 0;

/** Deployed-weight clamp: positive-bounded so a `switch`/`energy`/`buffer` weight can
 *  never flip sign (which would invert the term's meaning) or blow up on noise. */
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 4;

/** Fit calibrated soft weights from revealed preferences. Structured perceptron over the pairs,
 *  then shrink toward the prior, then clamp:
 *
 *    1. w_raw starts at the prior; per pair, delta = φ(solver) - φ(user). We want the user's
 *       order to score no worse, so on a violation nudge w_raw += eta * delta/||delta||. The
 *       unit-normalised step keeps each preference bounded and scale-consistent, so the integer
 *       switch count can't dominate the bounded energy/buffer terms.
 *    2. shrinkVector toward the prior with n = pairs.length.
 *    3. clamp each component.
 *
 *  No pairs means no steps means the prior exactly. Order-independent in spirit but not in exact
 *  value - the perceptron is sequential, which is inherent to online preference learning and
 *  swamped by the shrinkage anyway. */
export function fitCalibratedWeights(
  pairs: readonly PreferencePair[],
  prior: readonly number[],
  opts: WeightFitOptions = {},
): number[] {
  const eta = opts.eta ?? PERCEPTRON_ETA;
  const margin = opts.margin ?? PERCEPTRON_MARGIN;
  const kappa = opts.kappa ?? CALIBRATE_KAPPA;
  const lo = opts.lo ?? WEIGHT_MIN;
  const hi = opts.hi ?? WEIGHT_MAX;

  const raw = [...prior];
  for (const pair of pairs) {
    if (pair.solver.length !== prior.length || pair.user.length !== prior.length) {
      continue; // malformed pair ⇒ skip (no-regret over garbage rows)
    }
    const delta = prior.map((_, i) => pair.solver[i] - pair.user[i]);
    const dn = norm(delta);
    if (dn === 0) continue; // identical orders ⇒ no signal
    if (dot(raw, delta) < margin) {
      for (let i = 0; i < raw.length; i++) raw[i] += (eta * delta[i]) / dn;
    }
  }

  const deployed = shrinkVector(raw, prior, pairs.length, kappa);
  return deployed.map((w) => clamp(w, lo, hi));
}
