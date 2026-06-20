import type {
  CauseDiagnosis,
  DivergenceReason,
  EstimationModel,
  Task,
} from "./types";
import { MIN_ESTIMATION_SAMPLES } from "./types";

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
 * Classify *why* a goal diverged. Deterministic-first (§0). The checks run in a
 * fixed precedence so each cause means what it says:
 *
 *   1. one_off_slip — a single big over-run while the rest of the goal's work
 *      sits near its estimates. Checked FIRST (locked decision) so one blow-out
 *      can't masquerade as a chronic pattern, and so the strategist can hold
 *      rather than over-react to an expected missed Friday.
 *   2. chronic_velocity — estimates systematically run over, globally or for this
 *      goal once it has its own sample. The estimates are the problem, not the
 *      arrangement.
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

  // 2) chronic_velocity — a systematic over-run, for this goal or globally. The
  //    per-goal read needs its own sample (≥ MIN_ESTIMATION_SAMPLES); below that
  //    the global model is the only trustworthy signal.
  const goalMean = n >= MIN_ESTIMATION_SAMPLES ? mean(residuals) : null;
  const goalChronic = goalMean !== null && goalMean >= LN_CHRONIC_OVERRUN;
  const globalChronic =
    model.sampleSize >= MIN_ESTIMATION_SAMPLES &&
    model.meanLog >= LN_CHRONIC_OVERRUN;
  if (goalChronic || globalChronic) {
    const logBias = goalChronic ? (goalMean as number) : model.meanLog;
    const pct = Math.round((Math.exp(logBias) - 1) * 100);
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
