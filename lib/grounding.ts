import type {
  CauseDiagnosis,
  DivergenceCause,
  DivergenceReason,
  EstimationModel,
  GoalCriterion,
  GoalCutCost,
  GoalKind,
  MoveChoice,
  OfferedMove,
  SkillNode,
  StrategyMoveKind,
  Task,
  TimeWindow,
} from "./types";
import { MIN_ESTIMATION_SAMPLES } from "./types";
import {
  SHRINKAGE_STRENGTH,
  WINDOW_LABELS,
  type ResidualSample,
  type VelocityModel,
} from "./velocity";
import {
  fitCalibratedWeights,
  shrinkScalar,
  type PreferencePair,
} from "./calibrate";
import {
  DEFAULT_VALUE_MODEL,
  movePref,
  type RecoveryStyle,
  type ValueModel,
} from "./value-model";
import { goalCompletion } from "./goal";
import { skillProgress } from "./skill";

// Step 5 (§5 / vision §4.1) — cause-diagnosis.
//
// `detectDivergence` says *that* a goal is off track (the symptoms). This module
// is the layer on top: it classifies *why* — one-off slip vs chronic velocity vs
// constraint change vs structural overload — because the cause picks the response
// *class* (which move family to prefer), so the strategist doesn't reflexively
// cut scope for a single blown estimate.
//
// §0 invariant: the cause is decided here, deterministically, from estimation
// residuals and a temporal baseline. The LLM may narrate a cause but never sets
// one where it changes which odds or moves win. This file is pure (no I/O, no
// `server-only`) so both the per-project and portfolio strategists can call it.

/** ln(1.25): a goal "chronically" overruns once it's running ≥25% over (locked). */
const LN_CHRONIC_OVERRUN = Math.log(1.25);
/** A goal residual this many learned-σ above 0 is a blow-out, not normal spread. */
const ONE_OFF_SIGMA = 2;
/** Need at least this many done tasks for "a single outlier" to be meaningful. */
const ONE_OFF_MIN_SAMPLES = 3;
/** The remaining residuals must sit within ~this of 0 (log space ⇒ ~20%) — pace is fine. */
const ONE_OFF_MEDIAN_TOL = 0.18;
/** Odds must fall at least this far below the baseline to read as the world moving. */
const CONSTRAINT_ODDS_DROP = 0.05;

/** The temporal/odds anchor — "the world as the last standing plan saw it". */
export interface CauseBaseline {
  /** When the cached strategy that anchors the baseline was generated (ISO). */
  generatedAt: string;
  /** This goal's contention-aware odds at that time, or null if not in the snapshot. */
  probability: number | null;
}

/**
 * Everything {@link diagnoseCause} needs — a pure subset that `RecoveryContext`
 * (and `buildRecoveryPlan`'s locals) already satisfy structurally, so callers
 * pass the context they already hold.
 */
export interface CauseInput {
  /** The global learned estimation model (systematic bias + spread). */
  model: EstimationModel;
  /** This goal's completed tasks — the per-goal residual sample. */
  completedTasks: Task[];
  /** This goal's open tasks — for "added since the baseline" detection. */
  openTasks: Task[];
  /** The symptoms already detected (the layer this builds on). */
  reasons: DivergenceReason[];
  /** Current contention-aware completion odds. */
  currentProbability: number;
  /** The temporal/odds baseline, or null when no strategy is cached yet. */
  baseline: CauseBaseline | null;
  /**
   * The GLOBAL per-window velocity (OVERHAUL S2 slice C) — how much each time-of-day
   * window runs over/under your estimates, across all goals. Absent until session
   * capture accrues; when absent the placement tempering can't fire and the
   * diagnosis is bit-identical to before S2 (the no-regret anchor).
   */
  windowVelocity?: VelocityModel;
  /**
   * This goal's window-tagged residuals (its completed tasks joined to their work
   * sessions). The placement check asks whether this goal's overrun is just the
   * low-energy windows it worked in. Absent/sparse ⇒ no tempering.
   */
  windowedResiduals?: ResidualSample[];
}

/** log(actual/estimated) for each genuinely-timed done task — the residual sample. */
export function goalResiduals(tasks: Task[]): number[] {
  const out: number[] = [];
  for (const t of tasks) {
    if (t.status === "done" && t.estimated_minutes > 0 && t.actual_minutes > 0) {
      out.push(Math.log(t.actual_minutes / t.estimated_minutes));
    }
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * S2 placement tempering: is this goal's chronic-looking overrun explained by the
 * low-energy WINDOWS it was worked in, rather than bad estimates? Net of each
 * window's global slowdown (`μ_window − μ₀`), does the goal's mean residual fall
 * back below the chronic threshold? If so, returns the window most responsible (+
 * how much slower it runs than your norm) for the message; else null.
 *
 * Inert until the loop has learned the windows: needs real `windowVelocity` and a
 * non-sparse window-tagged sample, so before S2 capture accrues it returns null and
 * the diagnosis is bit-identical to before (the no-regret anchor). It can only ever
 * DEMOTE a chronic_velocity reading — the conservative direction (§0; deterministic).
 */
function placementExplains(
  samples: ResidualSample[],
  windowVelocity: VelocityModel | undefined,
): { window: TimeWindow; slowerPct: number } | null {
  if (!windowVelocity || samples.length < MIN_ESTIMATION_SAMPLES) return null;
  const mu0 = windowVelocity.global.meanLog;
  let raw = 0;
  let adjusted = 0;
  let worst: TimeWindow | null = null;
  let worstEffect = 0;
  for (const s of samples) {
    const effect = windowVelocity.forSegment(s.window).meanLog - mu0;
    raw += s.residualLog;
    adjusted += s.residualLog - effect;
    if (effect > worstEffect) {
      worstEffect = effect;
      worst = s.window;
    }
  }
  const n = samples.length;
  // Chronic raw, but not once the windows are accounted for ⇒ it's placement.
  if (raw / n < LN_CHRONIC_OVERRUN || adjusted / n >= LN_CHRONIC_OVERRUN) return null;
  // adjusted < raw guarantees some positive window effect, so `worst` is set.
  if (worst === null) return null;
  return { window: worst, slowerPct: Math.round((Math.exp(worstEffect) - 1) * 100) };
}

/**
 * Classify *why* a goal diverged. Deterministic-first (§0). The checks run in a
 * fixed precedence so each cause means what it says:
 *
 *   1. one_off_slip — a single big over-run while the rest of the goal's work
 *      sits near its estimates. Checked FIRST (locked decision) so one blow-out
 *      can't masquerade as a chronic pattern, and so the strategist can hold
 *      rather than over-react to an expected missed Friday.
 *   2. chronic_velocity — estimates systematically run over, globally or for this
 *      goal once it has its own sample. The estimates are the problem, not the
 *      arrangement. (2a) timing_placement intercepts the goal's own chronic read
 *      when the overrun is explained by the low-energy windows it was worked in —
 *      a placement problem, not an estimation one (S2; inert until windows learned).
 *   3. constraint_change — neither slip nor pattern explains it, but the world
 *      moved since the plan was made (new work landed, or the odds fell).
 *   4. scope_structural — the default: more committed work than the time allows.
 */
export function diagnoseCause(input: CauseInput): CauseDiagnosis {
  const { model, completedTasks, openTasks, currentProbability, baseline } =
    input;
  const residuals = goalResiduals(completedTasks);
  const n = residuals.length;
  const sigma = model.sigma;

  // 1) one_off_slip — exactly one big over-run while the rest cluster near 0.
  if (n >= ONE_OFF_MIN_SAMPLES) {
    const overruns = residuals.filter((r) => r > ONE_OFF_SIGMA * sigma);
    if (
      overruns.length === 1 &&
      Math.abs(median(residuals)) <= ONE_OFF_MEDIAN_TOL
    ) {
      return {
        cause: "one_off_slip",
        detail:
          "One task blew past its estimate, but the underlying pace is fine — this likely recovers without cutting scope.",
      };
    }
  }

  // 2) chronic_velocity — a systematic over-run, for this goal or globally.
  //
  //    The goal's own residual mean is SHRUNK toward the global bias (empirical
  //    Bayes, κ = SHRINKAGE_STRENGTH) rather than SWITCHED to it at a hard
  //    `n ≥ MIN_ESTIMATION_SAMPLES` cutoff. One blended read replaces the old
  //    `goalChronic || globalChronic` disjunction, and it is strictly better at both
  //    ends: a goal with 4 damning samples is no longer silently ignored, and a goal
  //    with 10 clean ones is no longer condemned by a chronic global average it
  //    doesn't share. This is the per-goal-cause sharpening S2's hierarchical
  //    shrinkage was built to supply (`fitVelocityModel` uses the identical B).
  //
  //    NO-REGRET at the anchor: `n = 0 ⇒ B = 0 ⇒ bias = model.meanLog`, i.e. exactly
  //    the old `globalChronic` test. The global trust gate mirrors `fitVelocityModel`
  //    — below MIN_ESTIMATION_SAMPLES the global model is the unbiased *default*, not
  //    evidence, so there is nothing to shrink toward and nothing to diagnose. (The
  //    goal's sample is a subset of the global pool — `goalResiduals` shares
  //    `estimationModel`'s gate — so this can never mask a goal that used to fire.)
  const chronicBias =
    model.sampleSize >= MIN_ESTIMATION_SAMPLES
      ? shrinkScalar(mean(residuals), model.meanLog, n, SHRINKAGE_STRENGTH)
      : null;
  if (chronicBias !== null && chronicBias >= LN_CHRONIC_OVERRUN) {
    // 2a) timing_placement (S2) — before blaming the estimates, check whether THIS
    //     goal's overrun is just the low-energy windows it was worked in. If net of
    //     the windows the pace is fine, it's a placement problem (reschedule into
    //     better hours), not an estimation one. Called unconditionally: it self-gates
    //     to the goal's own chronic read (it returns null unless the goal's RAW mean
    //     clears the threshold), so a purely global bias is still genuinely
    //     chronic_velocity and can't be demoted by one goal's window history.
    const placement = placementExplains(
      input.windowedResiduals ?? [],
      input.windowVelocity,
    );
    if (placement) {
      return {
        cause: "timing_placement",
        detail: `The overruns here line up with your ${WINDOW_LABELS[placement.window]} sessions (~${placement.slowerPct}% slower than your norm), not your estimates — move this work into stronger hours rather than re-estimating or cutting scope.`,
      };
    }
    const pct = Math.round((Math.exp(chronicBias) - 1) * 100);
    return {
      cause: "chronic_velocity",
      detail: `Estimates here are running ~${pct}% over — a pattern, not a one-off. The estimates need adjusting, not just the plan.`,
    };
  }

  // 3) constraint_change — the world moved since the plan was made. v1 reads two
  //    signals off the cached-strategy baseline: work that landed after it was
  //    generated, or odds that have since fallen materially (the effect of a
  //    pulled-in deadline / cut availability / new blocker). By here we've ruled
  //    out "your own estimates explain it", so a drop is exogenous.
  if (baseline) {
    const baseTime = Date.parse(baseline.generatedAt);
    const addedSince =
      Number.isFinite(baseTime) &&
      openTasks.some(
        (t) => t.created_at && Date.parse(t.created_at) > baseTime,
      );
    const oddsDropped =
      baseline.probability !== null &&
      currentProbability <= baseline.probability - CONSTRAINT_ODDS_DROP;
    if (addedSince || oddsDropped) {
      return {
        cause: "constraint_change",
        detail: addedSince
          ? "New work landed after this plan was made — the situation changed; re-plan around it rather than cutting scope."
          : "The odds have fallen since this plan was made — the situation changed, not your pace; re-plan around the new constraint.",
      };
    }
  }

  // 4) scope_structural — the default: genuine over-commitment for the time.
  return {
    cause: "scope_structural",
    detail:
      "There's more committed work here than the time allows — this needs shedding or reshaping, not just reordering.",
  };
}

// Step 5 slice 4 (§5 / vision §4.1) — response class: cause → preferred move family.
//
// The diagnosed cause picks which *family* of recovery moves fits the situation,
// so the strategist doesn't reflexively cut scope for a one-off slip, or merely
// re-date a project whose estimates are the real problem. Like the value model's
// recovery-style preference, these are TIEBREAKERS (bounded, same ±1 scale): the
// joint optimizer only consults them when two candidates' odds are within an
// epsilon, so the forecast always decides first and the cause only arbitrates a
// genuine tie. The cause picks the family; the odds still decide within it (§0 —
// the cause itself is computed deterministically by `diagnoseCause`).
//
// Mirrors the design table:
//   one_off_slip      → smallest defer / reschedule (don't cut scope)
//   chronic_velocity  → re-estimate (reshape) / move the deadline (the estimates,
//                       not the arrangement, are wrong)
//   timing_placement  → smallest reschedule into stronger hours (S2; the windows,
//                       not the estimates, are wrong — don't reshape or cut scope)
//   constraint_change → reroute / reschedule / triage (re-plan around the change)
//   scope_structural  → triage / reroute (shed genuine over-commitment)
//
// `hold` IS enumerable now (step 5 slice 4 follow-on, limitation #2). It is not a
// competitor to the real moves: `optimizeJointPlan` never lets a zero-gain move win
// the accept gate. It is offered only at the moment the optimizer gives up — when
// nothing left on the table clears `JOINT_MIN_GAIN` and a goal is still off track.
// That state already MEANT "wait"; a `hold` candidate just says so out loud and
// records the decision in the S1 plan-version history, which is the natural home for
// it (a hold is a real decision). Only a cause that positively prefers holding can
// surface one — hence the single entry below.

export const CAUSE_MOVE_PREFERENCES: Record<
  DivergenceCause,
  Partial<Record<StrategyMoveKind, number>>
> = {
  // A blip — make the smallest reschedule; never cut scope for it. And when nothing
  // is worth doing, saying "wait, this recovers" is the RIGHT answer, not a shrug.
  one_off_slip: {
    hold: 1,
    defer: 0.5,
    reschedule_task: 0.5,
    reschedule_deadline: 0.25,
    reshape: -0.5,
    reroute: -1,
    triage: -1,
    defer_skill: -0.5,
  },
  // The estimates are systematically low — re-shape (re-estimate / scope down) or
  // move the date; re-arranging the same work won't fix a pace problem.
  chronic_velocity: {
    reshape: 1,
    reschedule_deadline: 0.5,
    reroute: -0.25,
  },
  // Not the estimates — the work keeps landing in low-energy windows. Move it to
  // stronger hours (smallest reschedule); don't re-estimate or cut scope for it.
  // Mirrors one_off_slip's "don't over-react" shape (the placement is fixable).
  timing_placement: {
    reschedule_task: 0.5,
    defer: 0.5,
    reschedule_deadline: 0.25,
    reshape: -0.5,
    reroute: -0.25,
    triage: -1,
  },
  // The world moved — re-plan around the new constraint rather than blaming pace.
  constraint_change: {
    reroute: 1,
    reschedule_deadline: 0.5,
    triage: 0.5,
  },
  // Genuine over-commitment — shed or replace work; re-dating alone won't fit it.
  scope_structural: {
    triage: 1,
    reroute: 0.5,
    defer: 0.25,
    defer_skill: 0.5,
  },
};

/**
 * Tiebreak bias for a move kind given the diagnosed cause (0 when the cause is
 * unknown or the kind isn't listed). Weighted-summed with the value model's
 * recovery-style `movePref` in the joint optimizer — both apply only within the
 * odds epsilon, so the forecast is never overridden.
 */
export function causeMovePref(
  cause: DivergenceCause | null,
  kind: StrategyMoveKind,
): number {
  if (cause === null) return 0;
  return CAUSE_MOVE_PREFERENCES[cause]?.[kind] ?? 0;
}

/**
 * Cause bias for a move that touches *several* goals at once (a portfolio-wide
 * triage / activity skip has no single owning goal). Returns the weighted mean of
 * each touched goal's `causeMovePref`, so the bias reflects the goals the move
 * actually serves and the most-weighted ones dominate (a triage that mostly
 * rescues a `scope_structural` goal still leans triage even if one touched goal is
 * a `one_off_slip`). Weights are caller-supplied (risk = `1 − currentProbability`
 * in v1, until per-goal *value* lands in the Value Model). Returns 0 when there
 * are no positively-weighted entries, matching the unknown-cause default.
 */
export function aggregateCauseMovePref(
  entries: { cause: DivergenceCause | null; weight: number }[],
  kind: StrategyMoveKind,
): number {
  let weightSum = 0;
  let acc = 0;
  for (const e of entries) {
    const w = Math.max(e.weight, 0);
    if (w <= 0) continue;
    weightSum += w;
    acc += w * causeMovePref(e.cause, kind);
  }
  return weightSum > 0 ? acc / weightSum : 0;
}

// --- The `prefFor` tiebreak weights (step 5 slice 4, limitation #3) ---------
//
// `optimizeJointPlan` breaks a sub-epsilon odds tie with two nudges: the user's
// recovery STYLE (`movePref`) and the diagnosed CAUSE's preferred move family
// (`causeMovePref`). They were summed 1:1 — an unexamined assumption about which
// should win. These are the named knobs for that ratio; both default to 1.0 (the
// historical behaviour) and are LEARNED off the offered-vs-kept history by
// `calibrateMovePrefWeights` below. They apply only within `PREF_TIE_EPS`, so the
// forecast always decides first.
//
// The calibrator lives HERE, not in the strategist that consumes it: it needs this
// module's preference tables as its feature extractor, exactly as
// `calibrateArrangeWeights` lives in `arrange.ts` beside its φ and
// `calibrateHysteresis` in `rolling.ts` beside its rolls. `grounding.ts` also
// carries no `server-only`, so the whole seam stays unit-testable.

export const STYLE_PREF_WEIGHT = 1;
export const CAUSE_PREF_WEIGHT = 1;

/** The prior `[style, cause]` the calibrator shrinks toward — today's co-equal sum. */
export const MOVE_PREF_PRIOR: readonly number[] = [
  STYLE_PREF_WEIGHT,
  CAUSE_PREF_WEIGHT,
];

/** The learned `prefFor` weights. `samples` is the number of *decisions* that revealed
 *  anything (a bundle where the user kept everything, or nothing, reveals no contrast). */
export interface MovePrefWeights {
  style: number;
  cause: number;
  samples: number;
}

/**
 * φ for one offered move, priced under the recovery style in force when it was
 * offered. The preference TABLES are read live (a table edit re-prices history);
 * only their INPUTS — kind, cause, style — come off the stored row.
 *
 * The components are NEGATED, and that is the entire adaptation of the shared seam
 * to this consumer: `fitCalibratedWeights` fits an argMIN objective (the preferred
 * item must score LOWER, since its arrange consumer picks `argmin w·φ`), whereas
 * `prefFor` is an argMAX (the preferred move scores HIGHER). Negating both terms
 * makes "kept ≻ declined" mean the same thing to the perceptron. The deployed
 * weights stay positive-clamped in `[WEIGHT_MIN, WEIGHT_MAX]`, so a learned weight
 * can rescale a nudge but never invert its meaning.
 */
function movePrefFeatures(m: OfferedMove, style: RecoveryStyle): number[] {
  const vm: ValueModel = { ...DEFAULT_VALUE_MODEL, recoveryStyle: style };
  // A single-goal move stores one cause entry, and a one-entry weighted mean IS the
  // direct lookup — so both move shapes price through the same call.
  return [-movePref(vm, m.kind), -aggregateCauseMovePref(m.causes, m.kind)];
}

/** Component-wise mean of a non-empty list of feature vectors. */
function centroid(vectors: number[][]): number[] {
  const out = [0, 0];
  for (const v of vectors) {
    out[0] += v[0];
    out[1] += v[1];
  }
  return [out[0] / vectors.length, out[1] / vectors.length];
}

/**
 * Learn the STYLE-vs-CAUSE ratio from the user's own accept/decline behaviour — the
 * 🟠 tier of the calibration cohort (design/step5 → limitation #3, "calibrate from
 * live data"). Each applied bundle contributes ONE revealed preference: the centroid
 * of the moves the user kept is preferred to the centroid of the moves they declined.
 *
 * Why a centroid and not every `kept × declined` pair: κ counts *observations*, and a
 * bundle with 3 kept and 3 declined moves is ONE decision, not 9 independent ones.
 * Feeding the cross product would let a single click blow through the shrinkage.
 *
 * Why no odds-tie gate (unlike `plan_reorders`, which only records odds-NEUTRAL drags):
 * a drag that worsens the odds is the user overriding the forecast, a different kind of
 * statement worth excluding. Declining a *recommendation* is never that — and these two
 * weights only ever scale nudges that `PREF_TIE_EPS` already confines to genuine odds
 * ties. A mis-learned weight therefore cannot override a real gain; the structural
 * invariant that licenses `prefFor` at all is the same one that makes this safe to
 * learn from every decline.
 *
 * NO-REGRET: no rows (or no row with both a kept and a declined move) ⇒ no pairs ⇒
 * `fitCalibratedWeights` returns the prior ⇒ exactly today's co-equal `1.0 / 1.0`.
 *
 * Scale-invariance caveat (the trap `calibrate.ts` documents): under the `balanced`
 * recovery style every `movePref` is 0, so φ[0] ≡ 0, Δ[0] ≡ 0, and `style` never moves
 * off its prior. That is correct — with no style there is no style-vs-cause ratio to
 * learn — but it means the 🟠 tier only sharpens for users who picked a lean.
 */
export function calibrateMovePrefWeights(
  choices: readonly MoveChoice[],
): MovePrefWeights {
  const pairs: PreferencePair[] = [];
  for (const c of choices) {
    const kept: number[][] = [];
    const declined: number[][] = [];
    for (const m of c.offered) {
      (m.kept ? kept : declined).push(movePrefFeatures(m, c.recoveryStyle));
    }
    // Kept everything, or declined everything ⇒ no contrast ⇒ nothing revealed.
    if (kept.length === 0 || declined.length === 0) continue;
    pairs.push({ user: centroid(kept), solver: centroid(declined) });
  }
  const [style, cause] = fitCalibratedWeights(pairs, MOVE_PREF_PRIOR);
  return { style, cause, samples: pairs.length };
}

// Step 5 (§5 / vision §4.3) — the grounding gate's "cost to the goal" check.
//
// A recovery move reports its odds gain ("+30% on time"). But a deadline-buying
// cut can lift the odds while doing nothing for the goal's *reason for being* —
// its definition of done (project) or its skill milestones (learning). This
// function computes that cost so it can be shown beside the odds gain: the bar
// the move leaves unaddressed. Fully derived from `goalCompletion` /
// `skillProgress` (§0 — never authored), so a green number can't hide a goal
// being quietly abandoned.

/**
 * The honest cost-to-the-goal beyond the deadline. Returns null when there's no
 * recorded bar to measure against (no criteria / no skills), or when the bar is
 * already fully cleared — in those cases a cut carries no hidden goal cost.
 */
export function goalCutCost(
  kind: GoalKind,
  criteria: GoalCriterion[],
  skills: SkillNode[],
): GoalCutCost | null {
  if (kind === "learning") {
    if (skills.length === 0) return null;
    const sp = skillProgress(skills);
    // Fully attained — nothing left for a deadline move to skip past.
    if (sp.skillPct >= 1) return null;
    const pct = Math.round(sp.skillPct * 100);
    const detail =
      sp.checkpointsTotal > 0
        ? `Buying the date doesn't earn the learning — ${sp.checkpointsMet}/${sp.checkpointsTotal} milestones reached (${pct}% skill).`
        : `Buying the date doesn't earn the learning — ${pct}% of the way there.`;
    return {
      kind,
      criteriaUnmet: 0,
      criteriaTotal: 0,
      checkpointsMet: sp.checkpointsMet,
      checkpointsTotal: sp.checkpointsTotal,
      skillPct: sp.skillPct,
      detail,
    };
  }

  if (criteria.length === 0) return null;
  const gc = goalCompletion(criteria);
  const unmet = gc.total - gc.metCount;
  // Definition of done already fully met — the date is all that's left at stake.
  if (unmet === 0) return null;
  const detail = `The date moves, the goal's bar doesn't — ${unmet} of ${gc.total} definition-of-done ${
    unmet === 1 ? "criterion is" : "criteria are"
  } still unmet.`;
  return {
    kind,
    criteriaUnmet: unmet,
    criteriaTotal: gc.total,
    checkpointsMet: 0,
    checkpointsTotal: 0,
    skillPct: 0,
    detail,
  };
}
