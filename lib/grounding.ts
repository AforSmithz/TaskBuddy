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
} from "@/lib/types";
import { MIN_ESTIMATION_SAMPLES } from "@/lib/types";
import {
  SHRINKAGE_STRENGTH,
  WINDOW_LABELS,
  type ResidualSample,
  type VelocityModel,
} from "@/lib/velocity";
import {
  fitCalibratedWeights,
  shrinkScalar,
  type PreferencePair,
} from "@/lib/calibrate";
import {
  DEFAULT_VALUE_MODEL,
  movePref,
  type RecoveryStyle,
  type ValueModel,
} from "@/lib/value-model";
import { goalCompletion } from "@/lib/goal";
import { skillProgress } from "@/lib/skill";

// Cause diagnosis. detectDivergence says THAT a goal is off track (the symptoms); this
// classifies WHY - one-off slip vs chronic velocity vs constraint change vs structural
// overload - because the cause picks which move family to prefer, so the strategist doesn't
// reflexively cut scope over a single blown estimate.
//
// The cause is decided here, deterministically, from residuals and a temporal baseline. The
// LLM may narrate one but never sets one where it changes which odds or moves win. Pure (no
// I/O, no server-only) so both strategists can call it.

/** ln(1.25): a goal "chronically" overruns once it's running ≥25% over (locked). */
const LN_CHRONIC_OVERRUN = Math.log(1.25);
/** A goal residual this many learned-σ above 0 is a blow-out, not normal spread. */
const ONE_OFF_SIGMA = 2;
/** Need at least this many done tasks for "a single outlier" to be meaningful. */
const ONE_OFF_MIN_SAMPLES = 3;
/** The remaining residuals must sit within ~this of 0 (log space ⇒ ~20%) - pace is fine. */
const ONE_OFF_MEDIAN_TOL = 0.18;
/** Odds must fall at least this far below the baseline to read as the world moving. */
const CONSTRAINT_ODDS_DROP = 0.05;

/** The temporal/odds anchor - "the world as the last standing plan saw it". */
export interface CauseBaseline {
  /** When the cached strategy that anchors the baseline was generated (ISO). */
  generatedAt: string;
  /** This goal's contention-aware odds at that time, or null if not in the snapshot. */
  probability: number | null;
}

/** Everything diagnoseCause needs - a pure subset RecoveryContext already satisfies
 *  structurally, so callers just pass the context they already hold. */
export interface CauseInput {
  /** The global learned estimation model (systematic bias + spread). */
  model: EstimationModel;
  completedTasks: Task[];
  openTasks: Task[];
  /** The symptoms already detected (the layer this builds on). */
  reasons: DivergenceReason[];
  /** Current contention-aware completion odds. */
  currentProbability: number;
  /** The temporal/odds baseline, or null when no strategy is cached yet. */
  baseline: CauseBaseline | null;
  /** Global per-window velocity: how much each time-of-day window runs over/under estimate,
   *  across all goals. Absent until session capture accrues, and while absent the placement
   *  tempering can't fire. */
  windowVelocity?: VelocityModel;
  /** This goal's window-tagged residuals. The placement check asks whether the overrun is
   *  just the low-energy windows it was worked in. Absent or sparse means no tempering. */
  windowedResiduals?: ResidualSample[];
}

/** log(actual/estimated) for each genuinely-timed done task - the residual sample. */
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

/** Is this goal's chronic-looking overrun explained by the low-energy WINDOWS it was worked
 *  in rather than bad estimates? Net of each window's global slowdown, does the mean residual
 *  fall back below the chronic threshold? If so, return the window most responsible.
 *
 *  Inert until the loop has learned windows, so before capture accrues it returns null. It can
 *  only ever DEMOTE a chronic_velocity reading, which is the conservative direction. */
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

/** Classify WHY a goal diverged. The checks run in a fixed precedence so each cause means
 *  what it says:
 *
 *    1. one_off_slip     - one big over-run while the rest sits near estimate. Checked FIRST
 *                          so a single blow-out can't masquerade as a chronic pattern.
 *    2. chronic_velocity - estimates systematically run over, globally or for this goal.
 *       2a. timing_placement intercepts that when the overrun is explained by the windows the
 *           work happened in - a placement problem, not an estimation one.
 *    3. constraint_change - neither explains it, but the world moved since the plan was made.
 *    4. scope_structural  - the default: more committed work than time allows. */
export function diagnoseCause(input: CauseInput): CauseDiagnosis {
  const { model, completedTasks, openTasks, currentProbability, baseline } =
    input;
  const residuals = goalResiduals(completedTasks);
  const n = residuals.length;
  const sigma = model.sigma;

  // 1) one_off_slip - exactly one big over-run while the rest cluster near 0.
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

  // 2) chronic_velocity - a systematic over-run, for this goal or globally.
  //
  //    The goal's residual mean is SHRUNK toward the global bias rather than switched to it at
  //    a hard sample cutoff. One blended read replaces the old `goalChronic || globalChronic`
  //    disjunction and is better at both ends: a goal with 4 damning samples is no longer
  //    ignored, and a goal with 10 clean ones is no longer condemned by a chronic global
  //    average it doesn't share.
  //
  //    n = 0 gives B = 0 gives bias = model.meanLog, i.e. exactly the old global test. Below
  //    MIN_ESTIMATION_SAMPLES the global model is the unbiased default, not evidence, so
  //    there's nothing to shrink toward.
  const chronicBias =
    model.sampleSize >= MIN_ESTIMATION_SAMPLES
      ? shrinkScalar(mean(residuals), model.meanLog, n, SHRINKAGE_STRENGTH)
      : null;
  if (chronicBias !== null && chronicBias >= LN_CHRONIC_OVERRUN) {
  // 2a) Before blaming the estimates, check whether this goal's overrun is just the
    //     low-energy windows it was worked in - if the pace is fine net of windows it's a
    //     placement problem, not an estimation one. Called unconditionally: it self-gates to
    //     the goal's own chronic read, so a purely global bias stays chronic_velocity and
    //     can't be demoted by one goal's window history.
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

  // 3) constraint_change - the world moved since the plan was made. Two signals off the
  //    cached-strategy baseline: work that landed after it was generated, or odds that have
  //    since fallen materially. By here we've ruled out "your estimates explain it", so a drop
  //    is exogenous.
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

  // 4) scope_structural - the default: genuine over-commitment for the time.
  return {
    cause: "scope_structural",
    detail:
      "There's more committed work here than the time allows — this needs shedding or reshaping, not just reordering.",
  };
}

// --- Response class: cause -> preferred move family ------------------------
//
// The diagnosed cause picks which FAMILY of moves fits, so the strategist doesn't cut scope
// over a one-off slip or merely re-date a project whose estimates are the real problem. Like
// the value model's style preference these are TIEBREAKERS on the same +-1 scale: the joint
// optimizer only consults them when two candidates' odds are within an epsilon, so the
// forecast always decides first.
//
//   one_off_slip      -> smallest defer / reschedule (don't cut scope)
//   chronic_velocity  -> reshape / move the deadline (the estimates are wrong)
//   timing_placement  -> reschedule into stronger hours (the windows are wrong)
//   constraint_change -> reroute / reschedule / triage (re-plan around the change)
//   scope_structural  -> triage / reroute (shed genuine over-commitment)
//
// `hold` is enumerable but isn't a competitor to the real moves - optimizeJointPlan never
// lets a zero-gain move win the accept gate. It's offered only when the optimizer gives up:
// nothing clears JOINT_MIN_GAIN and a goal is still off track. That state already meant
// "wait"; a hold candidate just says so and records the decision in the version history.

export const CAUSE_MOVE_PREFERENCES: Record<
  DivergenceCause,
  Partial<Record<StrategyMoveKind, number>>
> = {
  // A blip - make the smallest reschedule; never cut scope for it. And when nothing
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
    reschedule_skill: -0.5,
  },
  // The estimates are systematically low - re-shape (re-estimate / scope down) or
  // move the date; re-arranging the same work won't fix a pace problem.
  chronic_velocity: {
    reshape: 1,
    reschedule_deadline: 0.5,
    reroute: -0.25,
  },
  // Not the estimates - the work keeps landing in low-energy windows. Move it to
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
  // The world moved - re-plan around the new constraint rather than blaming pace.
  constraint_change: {
    reroute: 1,
    reschedule_deadline: 0.5,
    triage: 0.5,
  },
  // Genuine over-commitment - shed or replace work; re-dating alone won't fit it.
  scope_structural: {
    triage: 1,
    reroute: 0.5,
    defer: 0.25,
    defer_skill: 0.5,
    reschedule_skill: 0.5,
  },
};

/** Tiebreak bias for a move kind given the diagnosed cause (0 when unknown or unlisted).
 *  Weighted-summed with the value model's style preference in the joint optimizer - both apply
 *  only within the odds epsilon, so the forecast is never overridden. */
export function causeMovePref(
  cause: DivergenceCause | null,
  kind: StrategyMoveKind,
): number {
  if (cause === null) return 0;
  return CAUSE_MOVE_PREFERENCES[cause]?.[kind] ?? 0;
}

/** Cause bias for a move touching SEVERAL goals at once (a portfolio-wide triage has no single
 *  owning goal). Weighted mean of each touched goal's causeMovePref, so the most-weighted goals
 *  dominate - a triage that mostly rescues a scope_structural goal still leans triage even if
 *  one touched goal is a one-off slip. Weights are caller-supplied (risk = 1 - probability for
 *  now). Returns 0 with no positively-weighted entries, matching the unknown-cause default. */
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

// --- The prefFor tiebreak weights ------------------------------------------
//
// optimizeJointPlan breaks a sub-epsilon odds tie with two nudges: the user's recovery STYLE
// and the diagnosed CAUSE's preferred family. They were summed 1:1, which was an unexamined
// assumption about which should win. These are the named knobs for that ratio; both default to
// 1.0 and are learned off the offered-vs-kept history below. They apply only within
// PREF_TIE_EPS, so the forecast always decides first.
//
// The calibrator lives HERE rather than in the strategist that consumes it, because it needs
// this module's preference tables as its feature extractor - same reason calibrateArrangeWeights
// lives in arrange.ts beside its φ.

export const STYLE_PREF_WEIGHT = 1;
export const CAUSE_PREF_WEIGHT = 1;

/** The prior `[style, cause]` the calibrator shrinks toward - today's co-equal sum. */
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

/** φ for one offered move, priced under the style in force when it was offered. The tables are
 *  read live (a table edit re-prices history); only their INPUTS come off the stored row.
 *
 *  The components are NEGATED, and that's the whole adaptation to this consumer:
 *  fitCalibratedWeights fits an argMIN objective while prefFor is an argMAX, so negating both
 *  terms makes "kept ≻ declined" mean the same thing to the perceptron. The deployed weights
 *  stay positive-clamped, so a learned weight can rescale a nudge but never invert it. */
function movePrefFeatures(m: OfferedMove, style: RecoveryStyle): number[] {
  const vm: ValueModel = { ...DEFAULT_VALUE_MODEL, recoveryStyle: style };
  // A single-goal move stores one cause entry, and a one-entry weighted mean IS the
  // direct lookup - so both move shapes price through the same call.
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

/** Learn the style-vs-cause ratio from the user's own accept/decline behaviour. Each applied
 *  bundle contributes ONE revealed preference: the centroid of the kept moves is preferred to
 *  the centroid of the declined ones.
 *
 *  Centroid rather than every kept × declined pair because κ counts observations, and a bundle
 *  with 3 kept and 3 declined moves is one decision, not nine. Feeding the cross product would
 *  let a single click blow through the shrinkage.
 *
 *  No odds-tie gate here, unlike plan_reorders which only records odds-neutral drags. A drag
 *  that worsens the odds is the user overriding the forecast, which is worth excluding;
 *  declining a recommendation never is, and these weights only scale nudges that PREF_TIE_EPS
 *  already confines to genuine ties. A mis-learned weight can't override a real gain.
 *
 *  No rows means no pairs means the prior, i.e. today's co-equal 1.0 / 1.0. Caveat: under the
 *  `balanced` style every movePref is 0, so φ[0] ≡ 0 and `style` never moves - correct (no
 *  style, no ratio to learn), but it means this only sharpens for users who picked a lean. */
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

// --- The grounding gate's "cost to the goal" check -------------------------
//
// A move reports its odds gain ("+30% on time"), but a deadline-buying cut can lift the odds
// while doing nothing for the goal's reason for being - its definition of done, or its skill
// milestones. This computes that cost so it can sit beside the odds gain. Fully derived from
// goalCompletion/skillProgress, so a green number can't hide a goal being quietly abandoned.

/** The cost to the goal beyond the deadline. Null when there's no recorded bar to measure
 *  against, or the bar is already cleared - either way a cut carries no hidden goal cost. */
export function goalCutCost(
  kind: GoalKind,
  criteria: GoalCriterion[],
  skills: SkillNode[],
): GoalCutCost | null {
  if (kind === "learning") {
    if (skills.length === 0) return null;
    const sp = skillProgress(skills);
    // Fully attained - nothing left for a deadline move to skip past.
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
  // Definition of done already fully met - the date is all that's left at stake.
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
