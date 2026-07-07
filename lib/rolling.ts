import {
  packOffsets,
  packOffsetsComfort,
  type DayCapacity,
} from "./schedule";
import { ARRANGE_HORIZON_DAYS, type ArrangeOrderOptions } from "./arrange";
import {
  COMMITTED_PLAN_SCHEMA_VERSION,
  type CommittedPlan,
  type EffectiveOrderEntry,
  type PlanRoll,
  type PlanRollKind,
} from "./types";

// Rolling-horizon wrapper (OVERHAUL §5a substrate S3c-1) — the *continuity* layer over
// the S3b arrangement. S3b prices which within-day arrangement is best RIGHT NOW; this
// module decides which already-priced arrangement to keep COMMITTING to as the days roll,
// so the plan you're following doesn't thrash on every reload for a sub-epsilon gain, yet
// still re-plans when the situation genuinely moves. See `design/s3c-rolling-horizon-wrapper.md`.
//
// Everything here is PURE, deterministic, and client-safe (types-only + pure imports, no
// `server-only`, no DB, no LLM, no probability authored — it mirrors `arrange.ts` /
// `buffer.ts` / `grounding.ts`). The Monte-Carlo reprice and the soft-score `J` are injected
// as closures (`repriceAllOnTime` / `scoreJ`) so the odds engine stays in `store.ts` while
// the DECISION logic (the roll cycle §4) lives here, unit-testable with fake pricers.
//
// Two structural guarantees the whole module is built to hold:
//   - No-regret: no committed row (or a reconcile that empties it) ⇒ the output is the fresh
//     candidate verbatim, so S3c can never start worse than today's S3b behaviour.
//   - Feasibility/odds dominate stability, always: a sticky plan is kept only while it stays
//     within ε of the fresh candidate's odds; the moment it isn't it is discarded regardless
//     of how little churn adopting the candidate would cost. Stickiness never costs odds.

// --- Hysteresis knobs (documented constants; EB-calibratable later — S3c-5) --

/** How far the reconciled committed plan's odds may sit below the fresh candidate's before
 *  feasibility/odds override stability and force a roll (§4 step 4). Mirrors S3b's
 *  `ARRANGE_ODDS_EPSILON` — a sticky plan may ride a sliver of slack, never a real drop. */
export const ROLL_ODDS_EPSILON = 0.02;

/** Fixed soft-score improvement the fresh candidate must beat before it's worth disrupting
 *  the committed plan at all (the flat part of the hysteresis). A knob defaulting to a
 *  documented constant like `ArrangeWeights`' `1.0`; one switch-grouping's worth of `J`. */
export const STABILITY_MARGIN = 1.0;

/** How much each unit of near-weighted churn ADDS to the margin the candidate must clear —
 *  disrupting the imminent day costs more than tidying a far one. Standard receding-horizon
 *  hysteresis; a knob (S3c-5 EB-calibrates it against the user's accept/override behaviour). */
export const CHURN_COST = 2.0;

// --- Reconcile the committed order to the current task set (§4 step 2) -------

/**
 * Bring the committed order up to date with the CURRENT task set, defensively: drop ids that
 * went stale (done / deleted / deferred — the S1 "stale ids no-op" precedent) and insert
 * genuinely-new tasks (never committed) at their canonical rank. Kept tasks are refreshed to
 * their CURRENT field values (estimate/difficulty/impact may have changed since commit) while
 * preserving the committed sequence, so the reconciled order both replays the frozen intent
 * AND prices against live data. This is the defense that keeps the frozen zone from ever
 * freezing into a stale or infeasible plan (§4 "defensive freeze").
 *
 * `canonical` is the fresh `buildGlobalPlan(...).order` over the current set — the source of
 * both the live entry values and the canonical rank new tasks slot in by. Pure + deterministic:
 * when the committed id sequence already equals the canonical one (no drops, no new work) the
 * result is `canonical` itself, entry-for-entry — the no-regret anchor for the sticky path.
 */
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

  // New tasks (in canonical, never committed) inserted by canonical rank — placed before the
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

/** Per-task `(day, rank)` under the same bucketing the arranger uses (comfort-capped when a
 *  cap is in force): day = the pack offset, rank = the position within that day's contiguous
 *  run. The two coordinates a churn comparison keys on. */
function bucketPositions(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  opts: ArrangeOrderOptions,
): Map<string, { day: number; rank: number }> {
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
  const out = new Map<string, { day: number; rank: number }>();
  let rank = 0;
  for (let k = 0; k < order.length; k++) {
    if (k > 0 && offsets[k] !== offsets[k - 1]) rank = 0;
    out.set(order[k].taskId, { day: offsets[k], rank });
    rank++;
  }
  return out;
}

/** Near-weight of a change landing on day `d`: a shift on TODAY (d=0) costs a full 1, day-1
 *  half, day-13 ≈ 0.07 — so disrupting the imminent day dominates the metric while tidying a
 *  far day is nearly free. Matches the "freeze today hardest" intent. */
function nearWeight(d: number): number {
  return 1 / (1 + d);
}

/**
 * How much adopting `candidate` would disturb the plan the user is following (`committed`),
 * in `[0, 1]`: over the tasks present in BOTH orders within the near-horizon, the near-weighted
 * fraction whose `(day, rank)` moves. 0 iff every shared task keeps its exact slot; → 1 as the
 * shared tasks are fully displaced, with a today-swap weighing far more than a day-13 swap.
 * Tasks only in one order (new / removed work) are handled by reconciliation (§4 step 2), not
 * counted here — a material set change also moves the fingerprint and generally rolls anyway.
 * Pure + deterministic. `capacities`/`opts` must match what the arranger buckets by so the
 * `(day, rank)` coordinates line up with the priced plan.
 */
export function churn(
  committed: EffectiveOrderEntry[],
  candidate: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  opts: ArrangeOrderOptions = {},
): number {
  const horizon = opts.horizonDays ?? ARRANGE_HORIZON_DAYS;
  const posC = bucketPositions(committed, capacities, opts);
  const posK = bucketPositions(candidate, capacities, opts);

  let weightSum = 0;
  let movedSum = 0;
  for (const [taskId, c] of posC) {
    const k = posK.get(taskId);
    if (!k) continue; // not shared — reconciliation's concern, not churn's
    const day = Math.min(c.day, k.day);
    if (day >= horizon) continue; // beyond the arranged horizon — not disturbed
    const w = nearWeight(day);
    weightSum += w;
    if (c.day !== k.day || c.rank !== k.rank) movedSum += w;
  }
  return weightSum > 0 ? movedSum / weightSum : 0;
}

// --- Stability gate: the churn-scaled hysteresis (§4 step 5) -----------------

/**
 * Should the fresh candidate be adopted over the sticky committed plan, on the soft objective
 * alone? Standard receding-horizon hysteresis: adopt only when the candidate's `J` improvement
 * (`deltaJ = J(committed) − J(candidate)`, positive ⇒ candidate better) clears a fixed margin
 * PLUS a churn-proportional penalty — so a marginal gain that would reshuffle today is refused,
 * while a large gain (or one that costs almost no churn) is taken. Pure. The odds/feasibility
 * override (§4 step 4) is applied by the caller BEFORE this — the gate only runs once the sticky
 * plan is already known odds-competitive, so it never trades odds for stability.
 */
export function stabilityGate(
  deltaJ: number,
  churnValue: number,
  opts: { stabilityMargin?: number; churnCost?: number } = {},
): boolean {
  const margin = opts.stabilityMargin ?? STABILITY_MARGIN;
  const cost = opts.churnCost ?? CHURN_COST;
  return deltaJ >= margin + cost * churnValue;
}

// --- The roll cycle (§4) ----------------------------------------------------

/** Why the roll landed where it did — observability now, the seed of S3c-3's
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
  /** Fresh canonical order over the CURRENT task set (`buildGlobalPlan(...).order`). */
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
  /** Day capacities for churn bucketing — must match what the arranger buckets by. */
  capacities: DayCapacity[];
  /** Arrange options (window profile / comfort cap / thin buffer / horizon / weights) —
   *  the churn bucketing reads the comfort cap + horizon from here. */
  arrangeOpts?: ArrangeOrderOptions;
  /** Odds slack before feasibility overrides stability (default ROLL_ODDS_EPSILON). */
  oddsEpsilon?: number;
  /** Flat hysteresis margin (default STABILITY_MARGIN). */
  stabilityMargin?: number;
  /** Churn penalty weight (default CHURN_COST). */
  churnCost?: number;
  /** Commit timestamp for the persisted plan (injected so the decision is deterministic in
   *  tests). Defaults to now. */
  nowISO?: string;
}

export interface RollDecisionResult {
  /** The order to follow / display — the fresh candidate when rolled, the reconciled
   *  committed order when sticky. */
  order: EffectiveOrderEntry[];
  /** Its P(all land) under the current situation (the candidate's, or the committed reprice). */
  allOnTime: number;
  /** True ⇒ kept the (reconciled) committed plan; false ⇒ adopted the fresh candidate. */
  sticky: boolean;
  reason: RollReason;
  /** The winner as a plan to persist. The WRITE path upserts it iff `shouldPersist`; the
   *  READ path ignores both fields (reads persist nothing — §Decisions #6). */
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

/**
 * Run one roll of the receding horizon (§4). Returns which arrangement to follow now (sticky
 * committed vs. fresh candidate) and — for the write path — the plan to persist and whether a
 * write is warranted. The read path calls this to DECIDE WHAT TO SHOW and ignores the persist
 * fields (§Decisions #6: reads stay pure). Pure given its injected pricers.
 *
 * The ordering of the checks IS the robustness contract: no-regret (1) and staleness (2) bypass
 * everything; feasibility/odds (4) dominate the soft stability gate (5); stickiness is only ever
 * reached once the committed plan is proven odds-competitive under the current situation.
 */
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
  //    every committed task went stale — there is nothing left to stay sticky to.
  const { order: reconciled } = reconcileCommitted(
    ctx.committed.order,
    ctx.canonicalOrder,
  );
  if (reconciled.length === 0) return adopt("reconciled-empty");

  // 3-4. Feasibility/odds dominate: reprice the reconciled committed plan under the current
  //      situation; if it fell more than ε below the candidate's odds, roll regardless of churn.
  const committedOdds = ctx.repriceAllOnTime(reconciled);
  if (committedOdds < ctx.candidate.allOnTime - eps) return adopt("odds-dominated");

  // 5. Stability gate — the committed plan is odds-competitive, so keep it unless the
  //    candidate's soft-score gain clears the churn-scaled hysteresis margin.
  const jCommitted = ctx.scoreJ(reconciled);
  const jCandidate = ctx.scoreJ(ctx.candidate.order);
  const deltaJ = jCommitted - jCandidate; // positive ⇒ candidate better
  const churnValue = churn(
    reconciled,
    ctx.candidate.order,
    ctx.capacities,
    ctx.arrangeOpts ?? {},
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
  // anchor / fingerprint / refreshed order) only when something actually moved — so the fast
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

// --- Roll-history classification (S3c-2 persist-on-roll) ----------------------

/**
 * Which history row (if any) a completed roll should append (design/s3c2-passive-roll-
 * history.md §3). A pure derivation from the decision plus the plan it superseded, so the
 * store's write path stays a thin persist and the classification is unit-testable next to
 * the roll cycle. Returns `null` for the STAY-PUT paths — a decision that persisted nothing,
 * or a sticky freshen (fingerprint / kept-task field refresh) that did NOT advance the
 * frozen-zone day — so the timeline records genuine plan changes, not every reload.
 *
 *   `initial`  — the first-ever commit; no prior arrangement to diff, so `prevJ` is null.
 *   `material` — adopted a fresh candidate over an existing plan (odds- or gate-driven, or
 *                a fully-stale reconcile); `prevJ` is the superseded plan's soft score.
 *   `anchor`   — stayed sticky but the anchor advanced and the near part re-froze.
 *
 * `prior` is the committed plan as it was BEFORE this roll (the `ctx.committed` passed to
 * {@link rollDecision}).
 */
export function planRollKind(
  result: RollDecisionResult,
  prior: CommittedPlan | null,
): { kind: PlanRollKind; prevJ: number | null } | null {
  if (!result.shouldPersist) return null; // nothing moved — no history entry

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

// --- Roll-undo decision (S3c-2 §4) ------------------------------------------

export interface UndoRollContext {
  /** The arrangement the undone roll superseded — the immediately-prior roll's order, or,
   *  when the undone roll was the first-ever commit, a fresh S3b build (there is no earlier
   *  preference). The seed a roll-undo restores. */
  restoredOrder: EffectiveOrderEntry[];
  /** Fresh canonical order over the CURRENT task set (`buildGlobalPlan(...).order`) — the
   *  reconcile basis, so a completed/deleted-since task drops out instead of resurrecting. */
  canonicalOrder: EffectiveOrderEntry[];
  /** Fresh candidate arrangement + its priced odds — what undo yields to if the restored
   *  arrangement is odds-dominated or reconciles to nothing. */
  candidate: { order: EffectiveOrderEntry[]; allOnTime: number };
  /** Reprice an order's P(all deadlined projects land) under the CURRENT situation (injected
   *  so this module authors no odds — mirrors {@link RollContext}). */
  repriceAllOnTime: (order: EffectiveOrderEntry[]) => number;
  /** Score an order's soft `J` under the current arrange options (`arrangementScore`). */
  scoreJ: (order: EffectiveOrderEntry[]) => number;
  /** Odds slack before feasibility overrides the restore (default ROLL_ODDS_EPSILON). */
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

/**
 * Decide what a roll-undo re-commits (design/s3c2-passive-roll-history.md §4). Undo takes the
 * arrangement a roll superseded and restores it, but only as a PREFERENCE SEED fed back through
 * the S3c-1 read path: `reconcileCommitted` against the current task set (dropping
 * completed/deleted tasks — never resurrecting them, the §7 robustness bar — and folding in new
 * work) then re-price. Odds/feasibility dominate exactly as {@link rollDecision}: the restore
 * holds against the SOFT stability gate — deliberately NOT re-running it, because the very gain
 * that caused the roll still holds and would instantly re-adopt the candidate, making undo a
 * no-op — but it CANNOT override the odds gate. A reconciled restore that is more than ε below
 * the fresh candidate's odds (or reconciles to nothing) yields to that candidate. Pure given its
 * injected pricers, so the whole decision is unit-testable with fakes; the store wraps it with
 * the real pricers + the reverted-guard (idempotency) + the re-commit.
 */
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

// --- Roll-cause diagnosis (S3c-3: "why your plan changed") -------------------

/**
 * Why a roll reshaped the plan — the single salient cause a timeline row narrates. A pure
 * derivation from the roll's `kind` plus a diff of its order against the order it superseded
 * (the immediately-prior roll). Deterministic-first; an optional LLM narrator (S3c-3c) would
 * consume this same union later (design/s3c3-roll-cause-diagnosis.md §2/§3).
 */
export type RollCause =
  | { kind: "initial" } // first-ever commit — no prior arrangement to diff
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
 *  whole diagnosis is one pure unit; an LLM variant (§6) would swap only this string layer. */
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

/**
 * Classify WHY a roll reshaped the plan. Pure: reads the roll's `kind` and diffs its arrangement
 * against the one it superseded (`prior` = the immediately-prior roll's order, null for the
 * first-ever commit). Fixed precedence, one salient cause per roll (the `diagnoseCause`
 * discipline) under the coarse `kind` gate:
 *
 *   initial / anchor  → short-circuit (the trigger is known: first commit / date advance).
 *   material          → deadline-in > new-work > completed > reprioritized.
 *
 * The deadline signal is the stored order's own `pulledAhead` + `projectName` (`allocate.ts`):
 * an EXISTING task not pulled ahead before and pulled now was leapfrogged by deadline pressure
 * (`deadline-in`). A BRAND-NEW pulled task is `new-work` — the cause is the addition, not a
 * deadline move — so the two never mis-fire into each other. Authors no odds.
 */
function rollCause(
  roll: Pick<PlanRoll, "kind" | "order">,
  prior: Pick<PlanRoll, "order"> | null,
): RollCause {
  if (roll.kind === "initial") return { kind: "initial" };
  if (roll.kind === "anchor") return { kind: "day-roll" };
  // material — diff against the superseded arrangement. Only the first commit is prior-less
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

  // Same task set, only resequenced — the honest generic. Model / value / capacity triggers
  // that move neither the membership nor the pull-state land here; §6 defers naming them.
  return { kind: "reprioritized" };
}

/**
 * Diagnose why a roll reshaped the plan (design/s3c3-roll-cause-diagnosis.md) — a structural
 * {@link RollCause} plus the plain-language line the timeline shows. Pure and client-safe;
 * authors no odds (it changes no arrangement, only narrates one). `prior` is the arrangement
 * this roll superseded (the immediately-prior roll's order), or null when `roll` was the
 * first-ever commit.
 */
export function diagnoseRoll(
  roll: Pick<PlanRoll, "kind" | "order">,
  prior: Pick<PlanRoll, "order"> | null,
): RollDiagnosis {
  const cause = rollCause(roll, prior);
  return { cause, summary: rollSummary(cause) };
}
