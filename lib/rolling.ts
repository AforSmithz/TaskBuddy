import {
  packOffsets,
  packOffsetsComfort,
  type DayCapacity,
} from "@/lib/schedule";
import { ARRANGE_HORIZON_DAYS, type ArrangeOrderOptions } from "@/lib/arrange";
import { CALIBRATE_KAPPA, clamp, shrinkScalar } from "@/lib/calibrate";
import {
  COMMITTED_PLAN_SCHEMA_VERSION,
  type CommittedPlan,
  type EffectiveOrderEntry,
  type LocalNow,
  type PlanRoll,
  type PlanRollKind,
} from "@/lib/types";

// Rolling-horizon wrapper - the continuity layer over the arrangement. arrange.ts prices
// which arrangement is best RIGHT NOW; this decides which already-priced arrangement to
// keep committing to as the days roll, so the plan doesn't thrash on every reload for a
// sub-epsilon gain but still re-plans when the situation genuinely moves.
// See design/s3c-rolling-horizon-wrapper.md.
//
// Pure, deterministic and client-safe. The Monte Carlo reprice and the soft score J are
// injected as closures so the odds engine stays in store.ts while the decision logic lives
// here, unit-testable with fake pricers.
//
// Two guarantees the module is built around: no committed row means the output is the fresh
// candidate verbatim (so this can never start worse than the plain arrangement), and
// feasibility/odds always dominate stability - a sticky plan is kept only while it stays
// within eps of the candidate's odds. Stickiness never costs odds.

// --- Hysteresis knobs (documented constants; EB-calibratable later - S3c-5) --

/** How far the reconciled committed plan's odds may sit below the fresh candidate's before
 *  feasibility/odds override stability and force a roll. Mirrors S3b's
 *  `ARRANGE_ODDS_EPSILON` - a sticky plan may ride a sliver of slack, never a real drop. */
export const ROLL_ODDS_EPSILON = 0.02;

/** Fixed soft-score improvement the fresh candidate must beat before it's worth disrupting
 *  the committed plan at all (the flat part of the hysteresis). A knob defaulting to a
 *  documented constant like `ArrangeWeights`' `1.0`; one switch-grouping's worth of `J`. */
export const STABILITY_MARGIN = 1.0;

/** How much each unit of near-weighted churn ADDS to the margin the candidate must clear -
 *  disrupting the imminent day costs more than tidying a far one. Standard receding-horizon
 *  hysteresis; a knob. */
export const CHURN_COST = 2.0;

/** Nominal start of the active day, in minutes since local midnight (08:00). The intra-day
 *  frozen zone measures "how much of today's deployable effort is behind us" from
 *  here; the only new clock knob, documented + defensively bounded, EB-calibratable later
 *  (the S3c-5 lineage). See `design/s3c4-intraday-frozen-zone.md`. */
export const DAY_START_MIN = 8 * 60;

/** How many of today's deployable minutes are already behind us, or null to disable the
 *  intra-day split. The single place the client-captured LocalNow becomes a frozen-zone
 *  offset, so all the defensive fallbacks live here:
 *
 *    no localNow              -> null (no clock, so date-granular)
 *    localNow.date != anchor  -> null (midnight rollover / travel / skew)
 *    cap0 <= 0                -> null (no time today, so no day-0 queue to split)
 *
 *  Otherwise clamp(minutesSinceMidnight - DAY_START_MIN, 0, cap0): before the day starts is
 *  0 (whole day ahead), past the budget is cap0 (everything today is behind). */
export function resolveElapsedToday(
  localNow: LocalNow | undefined,
  anchor: string,
  cap0: number,
): number | null {
  if (!localNow) return null;
  if (localNow.date !== anchor) return null;
  if (cap0 <= 0) return null;
  const raw = localNow.minutesSinceMidnight - DAY_START_MIN;
  return Math.min(cap0, Math.max(0, raw));
}

// --- Reconcile the committed order to the current task set -------

/** Bring the committed order up to date with the current task set: drop stale ids (done,
 *  deleted, deferred) and insert genuinely-new tasks at their canonical rank. Kept tasks are
 *  refreshed to their CURRENT field values while preserving the committed sequence, so the
 *  order replays the frozen intent but prices against live data. This is what keeps the
 *  frozen zone from freezing into a stale or infeasible plan.
 *
 *  `canonical` is the fresh buildGlobalPlan order over the current set. When the committed
 *  sequence already equals it, the result IS canonical, entry for entry. */
export function reconcileCommitted(
  committed: EffectiveOrderEntry[],
  canonical: EffectiveOrderEntry[],
): { order: EffectiveOrderEntry[]; changed: boolean } {
  const currentById = new Map(canonical.map((e) => [e.taskId, e]));
  const committedIds = new Set(committed.map((e) => e.taskId));
  let changed = false;

  // Kept committed tasks, refreshed to current values, in the committed sequence.
  const kept: EffectiveOrderEntry[] = [];
  for (const e of committed) {
    const cur = currentById.get(e.taskId);
    if (cur) kept.push(cur);
    else changed = true; // dropped a stale id (done / deleted / deferred)
  }

  // New tasks (in canonical, never committed) inserted by canonical rank - placed before the
  // first kept task whose canonical rank is higher, so a brand-new task lands where the planner
  // would put it rather than arbitrarily. Processed in ascending canonical rank ⇒ stable.
  const canonRank = new Map(canonical.map((e, i) => [e.taskId, i]));
  const order = [...kept];
  for (const n of canonical) {
    if (committedIds.has(n.taskId)) continue; // already placed (kept)
    changed = true;
    const rankN = canonRank.get(n.taskId)!;
    let pos = order.length;
    for (let i = 0; i < order.length; i++) {
      if (canonRank.get(order[i].taskId)! > rankN) {
        pos = i;
        break;
      }
    }
    order.splice(pos, 0, n);
  }
  return { order, changed };
}

// --- Churn: how much adopting the candidate would disturb the committed plan -

/** Per-task (day, rank, startMin) under the same bucketing the arranger uses. day = pack
 *  offset, rank = position within that day's run, startMin = effort-minutes into the day the
 *  task begins. The coordinates churn keys on; startMin is what the frozen zone splits day-0 by. */
function bucketPositions(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  opts: ArrangeOrderOptions,
): Map<string, { day: number; rank: number; startMin: number }> {
  const durations = order.map((e) => Math.max(0, e.estimatedMinutes));
  const cap = opts.comfortCapMinutes ?? null;
  const offsets =
    cap != null
      ? packOffsetsComfort(
          durations,
          capacities,
          order.map((e, i) => (e.difficulty ?? 0) * durations[i]),
          cap,
        )
      : packOffsets(durations, capacities);
  const out = new Map<string, { day: number; rank: number; startMin: number }>();
  let rank = 0;
  let startMin = 0; // effort-minutes used on the current day before this task
  for (let k = 0; k < order.length; k++) {
    if (k > 0 && offsets[k] !== offsets[k - 1]) {
      rank = 0;
      startMin = 0;
    }
    out.set(order[k].taskId, { day: offsets[k], rank, startMin });
    startMin += durations[k];
    rank++;
  }
  return out;
}

/** Near-weight of a change landing at (day, startMin) - how much disturbing it counts for.
 *  Generalizes the day-index step 1/(1+day) to a continuous 1/(1 + day + f) where f is today's
 *  elapsed fraction: the imminent part of today keeps weight ~1 while the later part relaxes
 *  toward 1/2, so re-planning the evening is cheap but reshuffling the next task is not. f is 0
 *  for every future day and whenever the intra-day split is off. */
function nearWeight(
  day: number,
  startMin: number,
  elapsedToday: number | null,
  cap0: number,
): number {
  let f = 0;
  if (day === 0 && elapsedToday != null && cap0 > 0) {
    f = Math.min(1, Math.max(0, (startMin - elapsedToday) / cap0));
  }
  return 1 / (1 + day + f);
}

/** How much adopting `candidate` would disturb the plan the user is following, in [0,1]: over
 *  the tasks in BOTH orders within the near horizon, the near-weighted fraction whose (day,
 *  rank) moves. 0 iff every shared task keeps its slot; a today-swap weighs far more than a
 *  day-13 swap. Tasks in only one order are handled by reconciliation, not counted here.
 *
 *  `elapsedToday` sharpens the frozen zone within today: the moved-mass numerator discounts a
 *  later-today reshuffle while the imminent prefix stays full-weight, against a stable
 *  date-granular denominator so day>=1 work is untouched.
 *
 *  capacities/opts must match what the arranger buckets by or the coordinates won't line up. */
export function churn(
  committed: EffectiveOrderEntry[],
  candidate: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  opts: ArrangeOrderOptions = {},
  elapsedToday: number | null = null,
): number {
  const horizon = opts.horizonDays ?? ARRANGE_HORIZON_DAYS;
  const posC = bucketPositions(committed, capacities, opts);
  const posK = bucketPositions(candidate, capacities, opts);
  const cap0 = capacities[0]?.capacityMinutes ?? 0;

  let weightSum = 0;
  let movedSum = 0;
  for (const [taskId, c] of posC) {
    const k = posK.get(taskId);
    if (!k) continue; // not shared - reconciliation's concern, not churn's
    // Weigh the task at its NEARER (most imminent) placement across the two orders - the
    // conservative "at least this imminent" reading, generalizing the S3c-1 `min(c.day, k.day)`
    // to also break day-0 ties by the earlier within-day start (the more imminent, higher-weight).
    const nearer =
      c.day < k.day || (c.day === k.day && c.startMin <= k.startMin) ? c : k;
    if (nearer.day >= horizon) continue; // beyond the arranged horizon - not disturbed
    // Denominator is the STABLE date-granular weight (clock-independent, so day>=1 work is
    // weighed the same either way). Numerator uses the intra-day-discounted weight, so a
    // later-today reshuffle disturbs less frozen mass as the day slips while the imminent
    // prefix still costs full weight. Decoupling the two confines the clock's effect to today.
    weightSum += nearWeight(nearer.day, nearer.startMin, null, cap0);
    if (c.day !== k.day || c.rank !== k.rank) {
      movedSum += nearWeight(nearer.day, nearer.startMin, elapsedToday, cap0);
    }
  }
  return weightSum > 0 ? movedSum / weightSum : 0;
}

// --- Stability gate: the churn-scaled hysteresis -----------------

/** Should the candidate be adopted over the sticky plan on the soft objective alone? Standard
 *  receding-horizon hysteresis: adopt only when deltaJ clears a fixed margin plus a
 *  churn-proportional penalty, so a marginal gain that would reshuffle today is refused. The
 *  odds/feasibility override runs in the caller BEFORE this, so the gate only sees plans
 *  already known odds-competitive and never trades odds for stability. */
export function stabilityGate(
  deltaJ: number,
  churnValue: number,
  opts: { stabilityMargin?: number; churnCost?: number } = {},
): boolean {
  const margin = opts.stabilityMargin ?? STABILITY_MARGIN;
  const cost = opts.churnCost ?? CHURN_COST;
  return deltaJ >= margin + cost * churnValue;
}

// --- Hysteresis calibration -------------------------

/** The material-roll revert rate the default hysteresis constants are tuned for: we tolerate
 *  up to ~1 in 5 automatic reshuffles being undone before the plan is judged too eager to roll.
 *  At or below this the calibrator keeps the hand-tuned defaults; above it, it stiffens. */
export const HYSTERESIS_PRIOR_REVERT_RATE = 0.2;

/** How hard excess roll-regret stiffens the hysteresis, per unit of prior-relative excess.
 *  Gentle: at the largest observable excess (a 100% revert rate) the factor reaches
 *  {@link HYSTERESIS_MAX_FACTOR}. */
export const HYSTERESIS_SENSITIVITY = 0.5;

/** Calibration only ADDS stickiness (floor 1.0) - it never lowers the hand-tuned anti-thrash
 *  floor on "they seem fine with churn", the conservative asymmetric choice - and is capped so a
 *  run of undos can't freeze the plan solid. */
export const HYSTERESIS_MIN_FACTOR = 1.0;
export const HYSTERESIS_MAX_FACTOR = 3.0;

/** The calibrated hysteresis knobs, ready to drop into {@link RollContext} / {@link stabilityGate}. */
export interface CalibratedHysteresis {
  stabilityMargin: number;
  churnCost: number;
}

/** Calibrate the hysteresis knobs from the user's roll-undo history. The signal is churn
 *  regret: a `material` roll the user later undid. The revert rate is shrunk toward the prior
 *  and mapped to a single stiffness factor applied to BOTH knobs - one signal identifies one
 *  degree of freedom, so scaling them together beats pretending to separate them.
 *
 *  Only material rolls count: `initial` can't be regretted and `anchor` is a day advance, not
 *  a reshuffle. No material rolls means the prior, so the constants stand byte-for-byte.
 *  Reverts below the prior rate clamp to 1.0, so an accepting user never loosens the
 *  anti-thrash floor; reverts above it stiffen, bounded at HYSTERESIS_MAX_FACTOR. */
export function calibrateHysteresis(
  rolls: readonly Pick<PlanRoll, "kind" | "revertedAt">[],
): CalibratedHysteresis {
  const material = rolls.filter((r) => r.kind === "material");
  const n = material.length;
  const reverted = material.filter((r) => r.revertedAt != null).length;
  const observedRate = n > 0 ? reverted / n : HYSTERESIS_PRIOR_REVERT_RATE;
  const rate = shrinkScalar(observedRate, HYSTERESIS_PRIOR_REVERT_RATE, n, CALIBRATE_KAPPA);
  const excess = (rate - HYSTERESIS_PRIOR_REVERT_RATE) / HYSTERESIS_PRIOR_REVERT_RATE;
  const factor = clamp(
    1 + HYSTERESIS_SENSITIVITY * excess,
    HYSTERESIS_MIN_FACTOR,
    HYSTERESIS_MAX_FACTOR,
  );
  return {
    stabilityMargin: STABILITY_MARGIN * factor,
    churnCost: CHURN_COST * factor,
  };
}

// --- The roll cycle ----------------------------------------------------

/** Why the roll landed where it did - observability now, the seed of S3c-3's
 *  plain-language "why your plan changed" narration later. */
export type RollReason =
  | "no-committed" // first commit / invalidated row ⇒ adopt candidate (no-regret)
  | "reconciled-empty" // every committed task went stale ⇒ nothing to stay sticky to
  | "odds-dominated" // committed fell below the candidate's odds ⇒ feasibility rolls it
  | "gate-adopted" // candidate's soft gain cleared the churn-scaled margin
  | "gate-kept"; // candidate's gain didn't clear it ⇒ stay the course (sticky)

export interface RollContext {
  /** The plan currently being followed, or null (first commit / schema-invalidated). */
  committed: CommittedPlan | null;
  canonicalOrder: EffectiveOrderEntry[];
  /** Fresh candidate arrangement (the `gatedReorder` display order) + its priced odds. */
  candidate: { order: EffectiveOrderEntry[]; allOnTime: number };
  /** `todayISO()` now (the anchor day) + the current situation fingerprint. */
  anchor: string;
  fingerprint: string;
  /** Reprice an order's P(all deadlined projects land) under the CURRENT situation
   *  (server: the joint MC; injected so this module authors no odds). */
  repriceAllOnTime: (order: EffectiveOrderEntry[]) => number;
  /** Score an order's soft `J` under the current arrange options (`arrangementScore`). */
  scoreJ: (order: EffectiveOrderEntry[]) => number;
  /** Day capacities for churn bucketing - must match what the arranger buckets by. */
  capacities: DayCapacity[];
  /** Arrange options (window profile / comfort cap / thin buffer / horizon / weights) -
   *  the churn bucketing reads the comfort cap + horizon from here. */
  arrangeOpts?: ArrangeOrderOptions;
  /** Client-captured local "now". Refines the churn near-weight so the imminent part
   *  of TODAY stays frozen while the later part re-plans as the day slips. Absent (or its date
   *  ≠ `anchor`, or no day-0 capacity) ⇒ date-granular churn, byte-identical to S3c-1. Enters
   *  ONLY the churn weight - never odds, the persisted plan, or the client re-solve. */
  localNow?: LocalNow;
  oddsEpsilon?: number;
  stabilityMargin?: number;
  churnCost?: number;
  /** Commit timestamp for the persisted plan (injected so the decision is deterministic in
   *  tests). Defaults to now. */
  nowISO?: string;
}

export interface RollDecisionResult {
  /** The order to follow / display - the fresh candidate when rolled, the reconciled
   *  committed order when sticky. */
  order: EffectiveOrderEntry[];
  /** Its P(all land) under the current situation (the candidate's, or the committed reprice). */
  allOnTime: number;
  /** True ⇒ kept the (reconciled) committed plan; false ⇒ adopted the fresh candidate. */
  sticky: boolean;
  reason: RollReason;
  /** The winner as a plan to persist. The WRITE path upserts it iff `shouldPersist`; the
   *  READ path ignores both fields - reads persist nothing. */
  toPersist: CommittedPlan;
  /** Whether the winner differs from the stored row enough to warrant a write (no row /
   *  order changed / anchor advanced / fingerprint moved). */
  shouldPersist: boolean;
}

/** Same task-id sequence (ignoring entry field values)? The cheap "did the plan actually
 *  move" check that decides whether a sticky roll needs to re-write the row. */
function sameIds(a: EffectiveOrderEntry[], b: EffectiveOrderEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].taskId !== b[i].taskId) return false;
  return true;
}

/** Run one roll of the receding horizon. Returns which arrangement to follow now and, for the
 *  write path, what to persist. Read paths call this to decide what to SHOW and ignore the
 *  persist fields. Pure given its injected pricers.
 *
 *  The order of the checks IS the contract: no-regret and staleness bypass everything;
 *  feasibility/odds dominate the soft stability gate; stickiness is only reached once the
 *  committed plan is proven odds-competitive. */
export function rollDecision(ctx: RollContext): RollDecisionResult {
  const eps = ctx.oddsEpsilon ?? ROLL_ODDS_EPSILON;
  const nowISO = ctx.nowISO ?? new Date().toISOString();

  const makePlan = (order: EffectiveOrderEntry[], j: number): CommittedPlan => ({
    schemaVersion: COMMITTED_PLAN_SCHEMA_VERSION,
    order,
    anchor: ctx.anchor,
    fingerprint: ctx.fingerprint,
    j,
    committedAt: nowISO,
  });

  const adopt = (reason: RollReason): RollDecisionResult => ({
    order: ctx.candidate.order,
    allOnTime: ctx.candidate.allOnTime,
    sticky: false,
    reason,
    toPersist: makePlan(ctx.candidate.order, ctx.scoreJ(ctx.candidate.order)),
    shouldPersist: true, // adopting always changes the followed plan (or is the first commit)
  });

  // 1. No committed row ⇒ adopt the candidate (first commit / no-regret).
  if (!ctx.committed) return adopt("no-committed");

  // 2. Reconcile the committed order to the current task set. An emptied reconcile means
  //    every committed task went stale - there is nothing left to stay sticky to.
  const { order: reconciled } = reconcileCommitted(
    ctx.committed.order,
    ctx.canonicalOrder,
  );
  if (reconciled.length === 0) return adopt("reconciled-empty");

  // 3-4. Feasibility/odds dominate: reprice the reconciled committed plan under the current
  //      situation; if it fell more than ε below the candidate's odds, roll regardless of churn.
  const committedOdds = ctx.repriceAllOnTime(reconciled);
  if (committedOdds < ctx.candidate.allOnTime - eps) return adopt("odds-dominated");

  // 5. Stability gate - the committed plan is odds-competitive, so keep it unless the
  //    candidate's soft-score gain clears the churn-scaled hysteresis margin.
  const jCommitted = ctx.scoreJ(reconciled);
  const jCandidate = ctx.scoreJ(ctx.candidate.order);
  const deltaJ = jCommitted - jCandidate; // positive ⇒ candidate better
  // S3c-4: resolve the client "now" into today's elapsed effort-minutes (null ⇒ date-granular),
  // so the churn near-weight sharpens the frozen zone to the imminent part of today.
  const cap0 = ctx.capacities[0]?.capacityMinutes ?? 0;
  const elapsedToday = resolveElapsedToday(ctx.localNow, ctx.anchor, cap0);
  const churnValue = churn(
    reconciled,
    ctx.candidate.order,
    ctx.capacities,
    ctx.arrangeOpts ?? {},
    elapsedToday,
  );
  if (
    stabilityGate(deltaJ, churnValue, {
      stabilityMargin: ctx.stabilityMargin,
      churnCost: ctx.churnCost,
    })
  ) {
    return adopt("gate-adopted");
  }

  // Keep the committed plan (sticky), priced at its reprice. Persist a freshened row (updated
  // anchor / fingerprint / refreshed order) only when something actually moved - so the fast
  // path can short-circuit next time, and a quiet reload writes nothing.
  const shouldPersist =
    ctx.committed.anchor !== ctx.anchor ||
    ctx.committed.fingerprint !== ctx.fingerprint ||
    !sameIds(reconciled, ctx.committed.order);
  return {
    order: reconciled,
    allOnTime: committedOdds,
    sticky: true,
    reason: "gate-kept",
    toPersist: makePlan(reconciled, jCommitted),
    shouldPersist,
  };
}

// --- Roll-history classification ----------------------

/** Which history row a completed roll should append, derived purely from the decision plus
 *  the plan it superseded, so the store's write path stays a thin persist. Null for the
 *  stay-put paths - a decision that persisted nothing, or a sticky freshen that didn't advance
 *  the frozen-zone day - so the timeline records real changes, not every reload.
 *
 *    initial  - first-ever commit, no prior arrangement, so prevJ is null
 *    material - adopted a fresh candidate over an existing plan
 *    anchor   - stayed sticky but the anchor advanced and the near part re-froze */
export function planRollKind(
  result: RollDecisionResult,
  prior: CommittedPlan | null,
): { kind: PlanRollKind; prevJ: number | null } | null {
  if (!result.shouldPersist) return null; // nothing moved - no history entry

  if (!result.sticky) {
    // Adopted the fresh candidate. The only prior-less adopt is the first-ever commit;
    // every other adopt (stale reconcile, odds override, gate) supersedes a real plan.
    if (result.reason === "no-committed") return { kind: "initial", prevJ: null };
    return { kind: "material", prevJ: prior?.j ?? null };
  }

  // Sticky: only a frozen-zone DAY advance is timeline-worthy. A same-anchor freshen
  // (the fingerprint moved, or a kept task's fields changed) is stay-put bookkeeping.
  if (prior && prior.anchor !== result.toPersist.anchor) {
    return { kind: "anchor", prevJ: prior.j };
  }
  return null;
}

// --- Roll-undo decision ------------------------------------------

export interface UndoRollContext {
  /** The arrangement the undone roll superseded - the immediately-prior roll's order, or,
   *  when the undone roll was the first-ever commit, a fresh S3b build (there is no earlier
   *  preference). The seed a roll-undo restores. */
  restoredOrder: EffectiveOrderEntry[];
  /** Fresh canonical order over the CURRENT task set (`buildGlobalPlan(...).order`) - the
   *  reconcile basis, so a completed/deleted-since task drops out instead of resurrecting. */
  canonicalOrder: EffectiveOrderEntry[];
  /** Fresh candidate arrangement + its priced odds - what undo yields to if the restored
   *  arrangement is odds-dominated or reconciles to nothing. */
  candidate: { order: EffectiveOrderEntry[]; allOnTime: number };
  /** Reprice an order's P(all deadlined projects land) under the CURRENT situation (injected
   *  so this module authors no odds - mirrors {@link RollContext}). */
  repriceAllOnTime: (order: EffectiveOrderEntry[]) => number;
  /** Score an order's soft `J` under the current arrange options (`arrangementScore`). */
  scoreJ: (order: EffectiveOrderEntry[]) => number;
  oddsEpsilon?: number;
}

export interface UndoRollResult {
  /** The arrangement to re-commit: the reconciled restore when it is odds-competitive, else
   *  the fresh candidate. */
  order: EffectiveOrderEntry[];
  /** Its soft `J` (for the re-committed plan). */
  j: number;
  /** True ⇒ the restore stood; false ⇒ it was odds-dominated (or emptied by staleness) and
   *  undo yielded to the fresh build. */
  restored: boolean;
}

/** Decide what a roll-undo re-commits. Undo takes the arrangement a roll superseded and
 *  restores it, but only as a PREFERENCE SEED fed back through reconcileCommitted (dropping
 *  completed/deleted tasks, never resurrecting them) and re-priced. It deliberately does NOT
 *  re-run the soft stability gate - the gain that caused the roll still holds and would
 *  instantly re-adopt the candidate, making undo a no-op - but it cannot override the odds
 *  gate: a restore more than eps below the candidate's odds yields to it. */
export function undoRollDecision(ctx: UndoRollContext): UndoRollResult {
  const eps = ctx.oddsEpsilon ?? ROLL_ODDS_EPSILON;
  const { order: reconciled } = reconcileCommitted(
    ctx.restoredOrder,
    ctx.canonicalOrder,
  );
  // Odds gate (rollDecision step 4): keep the restore only while it stays within ε of the
  // fresh candidate's odds. An emptied reconcile (every restored task went stale) has no odds
  // to defend and falls straight through to the candidate.
  if (reconciled.length > 0) {
    const restoredOdds = ctx.repriceAllOnTime(reconciled);
    if (restoredOdds >= ctx.candidate.allOnTime - eps) {
      return { order: reconciled, j: ctx.scoreJ(reconciled), restored: true };
    }
  }
  return {
    order: ctx.candidate.order,
    j: ctx.scoreJ(ctx.candidate.order),
    restored: false,
  };
}

// --- Drag-to-reorder honor + accrual -----------------------------

/** A revealed-preference pair `userOrder ≻ appOrder` worth teaching the arranger's weights
 *  (design/s3c5-shared-calibration-brain.md) - the shape persisted as a {@link PlanReorder}
 *  and later fed to `calibrateArrangeWeights` (S4). Only accrued for an odds-NEUTRAL drag. */
export interface ReorderPair {
  /** The order the arranger showed the user (what they dragged away from) - the `φ(a*)` side. */
  appOrder: EffectiveOrderEntry[];
  userOrder: EffectiveOrderEntry[];
}

export interface ReorderContext {
  /** The order the user is currently following / was shown (`rollDecision.order`) - the drag's
   *  "before" and the accrual pair's `appOrder`. */
  followedOrder: EffectiveOrderEntry[];
  /** The followed order's already-priced odds (`rollDecision.allOnTime`) - the neutrality
   *  baseline, so honoring a drag costs no extra Monte-Carlo for the "before". */
  followedOdds: number;
  orderedTaskIds: string[];
  /** Fresh canonical order over the CURRENT task set (`buildGlobalPlan(...).order`) - the
   *  reconcile basis, so a completed/deleted-since task drops instead of resurrecting. */
  canonicalOrder: EffectiveOrderEntry[];
  /** Reprice an order's P(all deadlined projects land) under the CURRENT situation (injected so
   *  this module authors no odds - mirrors {@link RollContext}). */
  repriceAllOnTime: (order: EffectiveOrderEntry[]) => number;
  /** Score an order's soft `J` under the current arrange options (`arrangementScore`). */
  scoreJ: (order: EffectiveOrderEntry[]) => number;
  oddsEpsilon?: number;
}

export interface ReorderResult {
  /** The honored order to commit - the reconciled dragged order (design: a drag is ALWAYS
   *  honored, even one that costs odds; only the accrual and the warning are odds-gated). */
  order: EffectiveOrderEntry[];
  /** Its soft `J` (for the re-committed plan). */
  j: number;
  /** True ⇒ the honored order's odds fell more than ε below the followed order's - the UI shows a
   *  "this costs some odds" note (honor-with-warning), and the drag does NOT feed calibration. */
  oddsCost: boolean;
  /** The revealed-preference pair to accrue, or null when the drag is not odds-neutral, or moved
   *  nothing after reconcile - only a neutral, genuinely-resequencing drag teaches the dials. */
  record: ReorderPair | null;
}

/** Splice the dragged TODAY sequence into the followed cross-project order: the dragged tasks
 *  first in the user's order, then the rest of the plan in place. The arranger packs greedily
 *  in order, so today's tasks are a prefix of `followed`. Missing ids are skipped. */
export function applyTodayReorder(
  followed: EffectiveOrderEntry[],
  orderedTaskIds: string[],
): EffectiveOrderEntry[] {
  const idSet = new Set(orderedTaskIds);
  const byId = new Map(
    followed.filter((e) => idSet.has(e.taskId)).map((e) => [e.taskId, e]),
  );
  const today: EffectiveOrderEntry[] = [];
  for (const id of orderedTaskIds) {
    const e = byId.get(id);
    if (e) today.push(e);
  }
  const rest = followed.filter((e) => !idSet.has(e.taskId));
  return [...today, ...rest];
}

/** Decide what a drag commits and whether it teaches the arrangement weights. The dragged
 *  order is a preference seed fed through the same reconcile as roll-undo, then re-priced and
 *  committed. Unlike an undo it NEVER yields on odds: a deliberate drag is always honored even
 *  if it costs some, and the odds comparison only sets a warning.
 *
 *  An observation is accrued only when the honored order is odds-neutral AND actually
 *  resequenced something, so calibration learns pure soft preference, never an odds tradeoff. */
export function reorderDecision(ctx: ReorderContext): ReorderResult {
  const eps = ctx.oddsEpsilon ?? ROLL_ODDS_EPSILON;
  const seed = applyTodayReorder(ctx.followedOrder, ctx.orderedTaskIds);
  const { order: honored } = reconcileCommitted(seed, ctx.canonicalOrder);
  const honoredOdds = ctx.repriceAllOnTime(honored);
  const j = ctx.scoreJ(honored);
  const oddsCost = honoredOdds < ctx.followedOdds - eps;
  const oddsNeutral = Math.abs(honoredOdds - ctx.followedOdds) <= eps;
  const changed = !sameIds(honored, ctx.followedOrder);
  return {
    order: honored,
    j,
    oddsCost,
    record:
      oddsNeutral && changed
        ? { appOrder: ctx.followedOrder, userOrder: honored }
        : null,
  };
}

// --- Roll-cause diagnosis -------------------

/** Why a roll reshaped the plan - the one salient cause a timeline row narrates. Derived from
 *  the roll's `kind` plus a diff against the order it superseded. */
export type RollCause =
  | { kind: "initial" } // first-ever commit - no prior arrangement to diff
  | { kind: "day-roll" } // the anchor advanced; the sticky near part re-froze
  | { kind: "deadline-in"; project: string; others: number } // existing task newly pulled ahead
  | { kind: "new-work"; project: string | null; count: number } // task(s) added since the prior roll
  | { kind: "completed"; count: number } // task(s) left the plan (finished / cleared)
  | { kind: "reprioritized" }; // same task set, only resequenced

export interface RollDiagnosis {
  cause: RollCause;
  /** The plain-language line the timeline shows. */
  summary: string;
}

/** The deterministic narration for a diagnosed cause. Kept beside {@link diagnoseRoll} so the
 *  whole diagnosis is one pure unit; an LLM variant would swap only this string layer. */
function rollSummary(cause: RollCause): string {
  switch (cause.kind) {
    case "initial":
      return "First plan committed.";
    case "day-roll":
      return "Rolled the plan forward a day.";
    case "deadline-in":
      return cause.others > 0
        ? `Pulled ${cause.project} forward to protect its deadline (and ${cause.others} other${cause.others > 1 ? "s" : ""}).`
        : `Pulled ${cause.project} forward to protect its deadline.`;
    case "new-work":
      return cause.project
        ? `Fit in new work on ${cause.project}.`
        : `Fit in ${cause.count} new task${cause.count > 1 ? "s" : ""}.`;
    case "completed":
      return `Tightened up after you cleared ${cause.count} task${cause.count > 1 ? "s" : ""}.`;
    case "reprioritized":
      return "Reordered your near-term plan.";
  }
}

/** Classify why a roll reshaped the plan. Reads the roll's `kind` and diffs its arrangement
 *  against the one it superseded. Fixed precedence, one cause per roll:
 *
 *    initial / anchor -> short-circuit, the trigger is already known
 *    material         -> deadline-in > new-work > completed > reprioritized
 *
 *  The deadline signal is the stored order's own `pulledAhead`: an EXISTING task not pulled
 *  before and pulled now was leapfrogged by deadline pressure. A brand-new pulled task is
 *  new-work instead - the cause is the addition, not a deadline move - so the two can't
 *  mis-fire into each other. */
function rollCause(
  roll: Pick<PlanRoll, "kind" | "order">,
  prior: Pick<PlanRoll, "order"> | null,
): RollCause {
  if (roll.kind === "initial") return { kind: "initial" };
  if (roll.kind === "anchor") return { kind: "day-roll" };
  // material - diff against the superseded arrangement. Only the first commit is prior-less
  // (and that is `initial`); guard defensively so a missing prior degrades to the generic line.
  if (!prior) return { kind: "reprioritized" };

  const priorIds = new Set(prior.order.map((e) => e.taskId));
  const priorPulled = new Set(
    prior.order.filter((e) => e.pulledAhead).map((e) => e.taskId),
  );

  // deadline-in: an EXISTING task deadline pressure newly leapfrogged ahead. The nearest-lead
  // (lowest-rank) one names the cause; any others are counted.
  const newlyPulled = roll.order
    .filter((e) => e.pulledAhead && priorIds.has(e.taskId) && !priorPulled.has(e.taskId))
    .sort((a, b) => a.rank - b.rank);
  if (newlyPulled.length > 0) {
    return {
      kind: "deadline-in",
      project: newlyPulled[0].projectName,
      others: newlyPulled.length - 1,
    };
  }

  // new-work: tasks present now that were never in the prior arrangement.
  const added = roll.order.filter((e) => !priorIds.has(e.taskId));
  if (added.length > 0) {
    const projects = new Set(added.map((e) => e.projectName));
    return {
      kind: "new-work",
      project: projects.size === 1 ? added[0].projectName : null,
      count: added.length,
    };
  }

  // completed: tasks that left the plan (finished / cleared / deferred).
  const rollIds = new Set(roll.order.map((e) => e.taskId));
  const dropped = prior.order.filter((e) => !rollIds.has(e.taskId));
  if (dropped.length > 0) return { kind: "completed", count: dropped.length };

  // Same task set, only resequenced - the honest generic. Model / value / capacity triggers
  // that move neither the membership nor the pull-state land here; defers naming them.
  return { kind: "reprioritized" };
}

/** Diagnose why a roll reshaped the plan: a structural RollCause plus the plain-language line
 *  the timeline shows. `prior` is the arrangement this roll superseded, or null when `roll` was
 *  the first-ever commit. */
export function diagnoseRoll(
  roll: Pick<PlanRoll, "kind" | "order">,
  prior: Pick<PlanRoll, "order"> | null,
): RollDiagnosis {
  const cause = rollCause(roll, prior);
  return { cause, summary: rollSummary(cause) };
}
