import type { StrategyMoveKind } from "./types";

// The Value Model (OVERHAUL §1.4 / §5 step 1) — the first-class, user-editable
// policy the optimizer consults so the strategist optimizes *your* tradeoffs
// instead of a hardcoded objective. Two levers in v1:
//
//   1. AREA WEIGHTS — an importance multiplier per life-area. It scales a task's
//      cost-of-delay (lib/allocate.ts), so a higher-weighted area's work is
//      scheduled earlier and protected harder under contention.
//   2. RECOVERY STYLE — a preference over *which kind* of recovery move to reach
//      for ("keep the work, move dates" vs "protect the dates, cut scope"). It's
//      applied only as a near-tie tiebreaker in the joint optimizer, so the
//      forecast odds still decide — preference never overrides a real gain.
//
//   3. PROJECT WEIGHTS (v2) — an importance multiplier per GOAL, overriding the
//      area-derived read for that one goal. Consumed ONLY by the strategist's
//      cross-project cause aggregation (`goalValue`, below). Deliberately NOT wired
//      into `allocate.ts`'s cost-of-delay: `areaWeights` already scales that, and
//      adding a second multiplier there would change scheduling — the odds path,
//      hence the S1 client-replay parity surface. That's a separate slice.
//
// NOTE — v2 is still NOT the full policy object §1.4 envisions. Still hardcoded /
// not yet user-editable: the cost-of-delay FACTOR weights (COD_WEIGHTS in
// allocate.ts) and hard constraints beyond the existing `protected` flag on
// recurring activities ("never trade sleep" lives there, not here yet).

/** v2 adds `projectWeights`. A v1 row normalizes forward (missing ⇒ `{}` ⇒ neutral). */
export const VALUE_MODEL_VERSION = 2 as const;

/** Importance-weight bounds: an area can matter at most ~3× a neutral one (or 4× a quartered one). */
export const MIN_AREA_WEIGHT = 0.25;
export const MAX_AREA_WEIGHT = 3;
export const NEUTRAL_AREA_WEIGHT = 1;

/** Project weights share the area bounds — same "importance multiplier" units. */
export const MIN_PROJECT_WEIGHT = MIN_AREA_WEIGHT;
export const MAX_PROJECT_WEIGHT = MAX_AREA_WEIGHT;
export const NEUTRAL_PROJECT_WEIGHT = NEUTRAL_AREA_WEIGHT;

/** How the strategist should lean when it has to recover a slipping portfolio. */
export type RecoveryStyle = "protect_work" | "protect_dates" | "balanced";

export const RECOVERY_STYLES: RecoveryStyle[] = [
  "protect_work",
  "protect_dates",
  "balanced",
];

export interface ValueModel {
  version: number;
  /** Per-life-area importance multiplier; a missing area reads as NEUTRAL_AREA_WEIGHT. */
  areaWeights: Record<string, number>;
  /** Which family of recovery moves to prefer when odds are otherwise close. */
  recoveryStyle: RecoveryStyle;
  /**
   * Per-goal importance multiplier, keyed by goal id. An UNSET goal does not read as
   * neutral — it falls back to the area-derived value (see {@link goalValue}), so a
   * user who has weighted their areas gets a sensible goal value for free.
   */
  projectWeights: Record<string, number>;
}

/**
 * The move-kind bias for each recovery style. Positive = reach for this sooner;
 * negative = a last resort. These are TIEBREAKERS (small, bounded) — the joint
 * optimizer only consults them when two candidates are within an odds epsilon, so
 * they shape *taste*, never the math.
 */
export const RECOVERY_STYLE_PREFERENCES: Record<
  RecoveryStyle,
  Partial<Record<StrategyMoveKind, number>>
> = {
  // "Keep the work — move the dates." Extend deadlines / lighten scope before
  // dropping or shedding anything. The calm default.
  protect_work: {
    reschedule_deadline: 1,
    reshape: 0.5,
    reroute: 0.5,
    unblock: 0.5,
    defer: -0.5,
    skip_activity: -0.5,
    triage: -1,
  },
  // "Protect the dates — cut the scope." Hit the deadlines by shedding/deferring
  // lower-value work; don't push dates out.
  protect_dates: {
    triage: 0.5,
    defer: 0.5,
    reshape: 0.5,
    skip_activity: 0.25,
    unblock: 0.5,
    reschedule_deadline: -1,
  },
  // No taste — let the odds alone decide.
  balanced: {},
};

export const DEFAULT_VALUE_MODEL: ValueModel = {
  version: VALUE_MODEL_VERSION,
  areaWeights: {},
  recoveryStyle: "protect_work",
  projectWeights: {},
};

function clampWeight(w: number): number {
  return Math.min(MAX_AREA_WEIGHT, Math.max(MIN_AREA_WEIGHT, w));
}

function isRecoveryStyle(x: unknown): x is RecoveryStyle {
  return x === "protect_work" || x === "protect_dates" || x === "balanced";
}

/** Importance multiplier for `area` — the clamped weight, or neutral when unset. */
export function areaWeight(vm: ValueModel, area: string): number {
  const w = vm.areaWeights[area];
  return typeof w === "number" && Number.isFinite(w)
    ? clampWeight(w)
    : NEUTRAL_AREA_WEIGHT;
}

/** Tiebreak bias for a move kind under the model's recovery style (0 when unlisted). */
export function movePref(vm: ValueModel, kind: StrategyMoveKind): number {
  return RECOVERY_STYLE_PREFERENCES[vm.recoveryStyle]?.[kind] ?? 0;
}

/** One unit of a goal's open work — structurally typed so this module never imports
 *  `allocate.ts` (an `AllocTask` satisfies it; so does a bare `{minutes, importance}`). */
export interface ValuedWork {
  estimatedMinutes: number;
  /** The task's area weight, as stamped by the gather. Absent ⇒ neutral. */
  importance?: number;
}

/**
 * How much this goal is *worth* — the multiplier the strategist weights a goal by
 * when a portfolio-wide move has to aggregate across several of them.
 *
 * Precedence, most-specific first:
 *   1. An explicit `projectWeights[goalId]` the user set. Their word is final.
 *   2. Else the goal's work tells us: the EFFORT-weighted mean of its open tasks'
 *      area importance. A goal that is mostly high-weighted Work is worth more than
 *      one that is mostly neutral Errands, without the user restating it per goal.
 *      Effort-weighted (not a plain mean) so one trivial task in a precious area
 *      can't inflate a goal made mostly of neutral work.
 *   3. Else neutral.
 *
 * NO-REGRET: with no project weights AND no area weights every task's `importance`
 * is 1 (or absent), so every goal returns exactly `NEUTRAL_PROJECT_WEIGHT` and any
 * caller multiplying by this is bit-identical to not having called it.
 */
export function goalValue(
  vm: ValueModel,
  goalId: string,
  work: readonly ValuedWork[] = [],
): number {
  const explicit = vm.projectWeights[goalId];
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return clampWeight(explicit);
  }

  let minutes = 0;
  let acc = 0;
  for (const w of work) {
    // A zero/negative/non-finite estimate carries no effort ⇒ no vote.
    if (!Number.isFinite(w.estimatedMinutes) || w.estimatedMinutes <= 0) continue;
    const imp =
      typeof w.importance === "number" && Number.isFinite(w.importance)
        ? w.importance
        : NEUTRAL_AREA_WEIGHT;
    minutes += w.estimatedMinutes;
    acc += w.estimatedMinutes * imp;
  }
  return minutes > 0 ? clampWeight(acc / minutes) : NEUTRAL_PROJECT_WEIGHT;
}

/**
 * Coerce untrusted input (a jsonb row from the DB, or a form payload) into a
 * valid ValueModel — clamps weights, drops non-numeric/non-finite entries, and
 * falls back to the default recovery style. Always returns a usable model.
 */
export function normalizeValueModel(raw: unknown): ValueModel {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_VALUE_MODEL, areaWeights: {}, projectWeights: {} };
  }
  const r = raw as Record<string, unknown>;

  return {
    version: VALUE_MODEL_VERSION,
    // A neutral AREA is implicit — `areaWeight` returns neutral for a missing key,
    // so storing 1.0 would be redundant.
    areaWeights: normalizeWeightMap(r.areaWeights, { dropNeutral: true }),
    recoveryStyle: isRecoveryStyle(r.recoveryStyle)
      ? r.recoveryStyle
      : DEFAULT_VALUE_MODEL.recoveryStyle,
    // A neutral PROJECT is NOT implicit: an unset goal falls back to its (possibly
    // non-neutral) area-derived value, so "this goal is deliberately neutral" is a
    // real statement that must survive normalization and override the fallback.
    // A v1 row simply has no `projectWeights` ⇒ `{}` ⇒ every goal derives. Forward-
    // migration is a no-op by construction.
    projectWeights: normalizeWeightMap(r.projectWeights, { dropNeutral: false }),
  };
}

/** Coerce an untrusted `{key: weight}` jsonb map: drop non-numeric entries, clamp
 *  the rest into the shared bounds, and (when the key's absence already means
 *  neutral) drop redundant neutral entries. */
function normalizeWeightMap(
  raw: unknown,
  opts: { dropNeutral: boolean },
): Record<string, number> {
  const out: Record<string, number> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (opts.dropNeutral && n === NEUTRAL_AREA_WEIGHT) continue;
    out[k] = clampWeight(n);
  }
  return out;
}
