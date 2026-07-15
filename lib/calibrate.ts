// The calibration seam - substrate S3c-5 (OVERHAUL §5a). The shared, reusable
// empirical-Bayes core that turns fixed soft-knob constants (the churn hysteresis
// `STABILITY_MARGIN`/`CHURN_COST`, the arrangement `ArrangeWeights`) into values
// LEARNED from the user's own behaviour, without ever starting worse than the
// constant.
//
// Pure + deterministic, ZERO imports (numbers in, numbers out) - the calibration
// side of §0's propose/dispose, NEVER the LLM, never the DB. It authors no odds:
// every knob it returns feeds the SOFT layer only (the churn hysteresis and the
// arrangement `J`), which the odds gate already dominates (design §3, invariant 2).
// Mirrors `lib/velocity.ts` (the same shrink-to-prior discipline) and `lib/buffer.ts`
// (pure, unit-testable via the compiled-to-`/tmp` node harness). See
// `design/s3c5-shared-calibration-brain.md`.
//
// The one idea, in two shapes:
//
//     B = n / (n + κ)                    // EB / James - Stein shrinkage weight
//     scalar:  x̂ = x₀ + B·(x̄ − x₀)       (§4a - a rate → a knob: hysteresis)
//     vector:  ŵ = w₀ + B·(w_raw − w₀)    (§4b - preference pairs → weights: arrange)
//
// No-regret is STRUCTURAL: n = 0 ⇒ B = 0 ⇒ x̂ = x₀ and ŵ = w₀ = today's constant,
// bit-for-bit. It can only sharpen off real evidence; it can never start below the
// prior. Sparse/noisy evidence stays near the prior (large κ) - the same safety
// `fitVelocityModel` relies on. Any non-finite input falls back to the prior.

/**
 * The empirical-Bayes shrinkage weight `B = n/(n+κ)` - "how many of its OWN
 * observations a statistic needs to earn half its weight" (at `n = κ`, `B = 0.5`).
 * `n ≤ 0` ⇒ 0 (no evidence ⇒ pure prior). `κ` non-finite ⇒ 0 (disabled ⇒ prior).
 * `κ ≤ 0` ⇒ 1 (no shrinkage ⇒ trust the observation fully). Always in `[0, 1]`.
 */
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

/**
 * Shrink one observed scalar statistic toward its prior: `x₀ + B·(x̄ − x₀)`,
 * `B = shrinkageWeight(n, κ)`. `n = 0` (or a non-finite observation) ⇒ exactly the
 * prior. The §4a primitive; the hysteresis consumer (S1) supplies the observed churn
 * regret rate as `observed`, the rate the current constants are tuned for as `prior`,
 * then maps the shrunk rate to the knob's units.
 */
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

/**
 * Shrink each component of a learned vector toward a prior vector - the §4b tail.
 * Length-mismatched or non-finite inputs fall back to a copy of the prior (no-regret
 * under any malformation). `n` is the shared evidence count (number of preference
 * pairs); every component shrinks by the same `B`, preserving the vector's direction
 * as it pulls toward the prior.
 */
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

/**
 * One revealed preference: the user's dragged order is PREFERRED over the solver's
 * order. Feature vectors `φ = (S, E, B)` = (switch count, energy term, buffer term);
 * the solver picks `argmin w·φ`, so "preferred" means the user's order should score
 * LOWER. `solver` = `φ(a*)` (dispreferred), `user` = `φ(u)` (preferred). Both are
 * captured odds-neutral (design §6), so this is a pure soft-preference contrast.
 */
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

/**
 * Default shrinkage strength κ for the calibration seam - deliberately STRONGER
 * (prior-favouring) than velocity's 8, because a preference/policy signal is noisier
 * than a duration residual: ~12 observations for half weight, ~36 for 75%. So the
 * dials have to CLEARLY and REPEATEDLY be argued against before they move off the
 * hand-tuned constant. Itself EB-refinable later (the mild recursion §9 accepts).
 */
export const CALIBRATE_KAPPA = 12;

/** Perceptron step size - small, so one drag is a gentle nudge, not a lurch. */
export const PERCEPTRON_ETA = 0.1;

/** Contrast margin before a nudge fires (0 = nudge on any strict violation). */
export const PERCEPTRON_MARGIN = 0;

/** Deployed-weight clamp: positive-bounded so a `switch`/`energy`/`buffer` weight can
 *  never flip sign (which would invert the term's meaning) or blow up on noise. */
export const WEIGHT_MIN = 0.25;
export const WEIGHT_MAX = 4;

/**
 * Fit calibrated soft weights from a list of revealed preferences (§4b). Structured
 * perceptron over the pairs, then shrink toward the prior, then clamp:
 *
 *   1. `w_raw ← prior`; for each pair, `Δ = φ(solver) − φ(user)`. We want the user's
 *      order to score no worse, i.e. `w·Δ ≥ 0`. On a violation (`w_raw·Δ < margin`)
 *      nudge `w_raw += η · Δ/‖Δ‖`. The unit-normalised step makes each preference a
 *      bounded, scale-consistent contribution - a big-magnitude feature (the integer
 *      switch count) can't dominate the bounded energy/buffer terms.
 *   2. `w_deployed = shrinkVector(w_raw, prior, n=pairs.length, κ)` - sparse/noisy
 *      evidence stays near the prior.
 *   3. clamp each component to `[lo, hi]`.
 *
 * NO-REGRET: `pairs = []` ⇒ no steps ⇒ `w_raw = prior` ⇒ `B = 0` ⇒ returns the prior
 * (clamped, a no-op when the prior is in range) = today's `ARRANGE_WEIGHTS` exactly.
 * Order-independent in spirit but not in exact value (the perceptron is sequential);
 * that's inherent to online preference learning and swamped by the shrinkage anyway.
 */
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
