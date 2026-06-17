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
// NOTE — v1 is deliberately NOT the full policy object §1.4 envisions. Still
// hardcoded / not yet user-editable: the cost-of-delay FACTOR weights
// (COD_WEIGHTS in allocate.ts), per-PROJECT importance (only per-area here), and
// hard constraints beyond the existing `protected` flag on recurring activities
// ("never trade sleep" lives there, not here yet). Those are later slices.

export const VALUE_MODEL_VERSION = 1 as const;

/** Importance-weight bounds: an area can matter at most ~3× a neutral one (or 4× a quartered one). */
export const MIN_AREA_WEIGHT = 0.25;
export const MAX_AREA_WEIGHT = 3;
export const NEUTRAL_AREA_WEIGHT = 1;

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

/**
 * Coerce untrusted input (a jsonb row from the DB, or a form payload) into a
 * valid ValueModel — clamps weights, drops non-numeric/non-finite entries, and
 * falls back to the default recovery style. Always returns a usable model.
 */
export function normalizeValueModel(raw: unknown): ValueModel {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_VALUE_MODEL, areaWeights: {} };
  }
  const r = raw as Record<string, unknown>;

  const areaWeights: Record<string, number> = {};
  if (typeof r.areaWeights === "object" && r.areaWeights !== null) {
    for (const [k, v] of Object.entries(r.areaWeights as Record<string, unknown>)) {
      const n = Number(v);
      // Only persist meaningful, non-neutral weights — a neutral area is implicit.
      if (Number.isFinite(n) && n !== NEUTRAL_AREA_WEIGHT) {
        areaWeights[k] = clampWeight(n);
      }
    }
  }

  return {
    version: VALUE_MODEL_VERSION,
    areaWeights,
    recoveryStyle: isRecoveryStyle(r.recoveryStyle)
      ? r.recoveryStyle
      : DEFAULT_VALUE_MODEL.recoveryStyle,
  };
}
