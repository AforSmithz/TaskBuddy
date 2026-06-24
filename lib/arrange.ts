import {
  flowFinishOffsets,
  flowFinishOffsetsComfort,
  packOffsets,
  packOffsetsComfort,
  type DayCapacity,
  type DependencyEdge,
  type WindowCapacity,
} from "./schedule";
import type { EffectiveOrderEntry, EstimationModel } from "./types";
import { globalForecastJoint, type ForecastOptions } from "./forecast";
import { ALL_WINDOWS, type EnergyWindow, type TimeWindow } from "./velocity";

// Local arrangement optimizer (OVERHAUL §5a substrate S3b) — the *arrangement*
// half of the forecast-as-risk-core / solver-as-arrangement split. The Monte-Carlo
// forecast stays the sole owner of feasibility & odds (§0); this module only makes
// the plan you actually *follow* good on the soft objectives the forecast doesn't
// price — context-switching, energy-window placement, daily load. Everything here
// is a pure, deterministic, dispose-side transform over the already-built plan: no
// LLM, no new probability authored anywhere.
//
// The chooser is one **deterministic within-day reorder over the canonical order**
// (`arrangeOrder`): it buckets the order into the days the greedy pack lands it on,
// then re-sequences each near-horizon day to group projects (cut context-switches)
// and slot hard work into learned-fast windows (energy placement). The reorder is
// **odds-*gated*, never odds-authoring**: `gatedReorder` re-prices the arranged order
// with the same Monte Carlo the headline uses and adopts it only while `allOnTime ≥
// canonical − ε`. Because the reorder is deterministic (no RNG) and reads only inputs
// the client already mirrors (order, capacities, deps, window profile, comfort cap),
// the gate decision compresses to ONE boolean the client replays — so the S1 14/14
// client==server parity rides for free (the same discipline comfort-smoothing used).
//
// No-regret: reordering the order array changes the forecast's seed, so an
// odds-*neutral* reorder is not byte-identical. The gate's boolean is therefore set
// true ONLY when there is an odds-relevant signal (windows learned OR comfort active)
// AND the gate passes; with no signal the grouping is display-only and the forecast
// flows the canonical order (byte-identical — the honest no-regret anchor, since the
// day-granular flow is order-invariant within a day so the grouping genuinely costs
// nothing). See `design/s3b-arrangement-optimizer.md`.

/** Per-objective weights for the soft score `J` (lower is better). Knobs defaulting
 *  to `1.0`, calibrated later by S2's loop (step-5 precedent). At these defaults the
 *  switch term (a unit penalty per project change) dominates the energy term (bounded
 *  by `|netMult−1|·difficulty`, typically <0.5), so energy placement operates *within*
 *  a project's cluster (group first, then sequence each cluster by energy); raising
 *  `energy` is the lever that lets it break a cluster for a strong window gain. The
 *  energy + buffer terms share the `(netMult−1)` window coupling, so both vanish without
 *  a learned profile and the score reduces EXACTLY to context-switch clustering. */
export interface ArrangeWeights {
  /** Penalty per project change across a day's within-day sequence (context-switch cost). */
  switch: number;
  /** Weight on the energy term `difficulty·(netMult−1)` — negative (reward) for placing
   *  cognitively-HARD work in a fast window, positive (penalty) for hard work in a slow
   *  one. `difficulty` is the `effort`-derived cognitive load (S2): "do hard work when
   *  you're sharp". When effort correlates with duration this also shrinks effective work
   *  and *raises* the odds (the design's odds-improving placement); when it doesn't, the
   *  reorder is odds-neutral and the gate keeps it honest. Inert (0) when no window
   *  profile is learned. (Duration/importance-weighted placement is a Phase-4 "richer
   *  difficulty" refinement.) */
  energy: number;
  /** Weight on the buffer term `(netMult−1)` for a THIN-buffer (at-risk) project's work —
   *  the same window coupling as energy but difficulty-INDEPENDENT. The S3a critical-chain
   *  lever (`tone==="thin"`, `lib/buffer.ts`): give the work whose safety margin is thinnest
   *  first claim on the day's FAST windows — the hours it is most likely to finish in —
   *  widening its buffer, even when that remaining work is light. Combines additively with
   *  energy, so an at-risk task competes for a fast window as if it carried `buffer` extra
   *  units of difficulty. Inert (0) without a window profile (`netMult≡1`) or when no project
   *  is thin. The thin-buffer SET is decided once on the base plan's odds (it can't be
   *  recomputed from the client's data) and shipped for the S1 re-solve to replay. */
  buffer: number;
}

/** Default weights — `1.0` as knobs, calibrated later by S2's loop. */
export const ARRANGE_WEIGHTS: ArrangeWeights = { switch: 1, energy: 1, buffer: 1 };

/** Shared empty thin-buffer set — the no-buffer-bias default (avoids per-call allocation). */
const NO_THIN_BUFFER: ReadonlySet<string> = new Set();

/** How far out we re-arrange: the committed near-horizon. Beyond it the plan is
 *  re-derived as time advances, so re-sequencing it now is wasted (and out of
 *  scope — §4 "committed horizon"). Out-of-horizon days are returned untouched. */
export const ARRANGE_HORIZON_DAYS = 14;

export interface ArrangeOrderOptions {
  /** Per-window velocity profile — activates the energy term (null/absent ⇒ switch-only). */
  windowProfile?: WindowProfile | null;
  /** Comfort cap (hard min/day) — when set, the day-bucketing mirrors the comfort-capped
   *  pack so the reorder permutes inside the same days the comfort flow lands work on. */
  comfortCapMinutes?: number | null;
  /** Projects whose critical-chain buffer is "thin" (at-risk) under the base plan — the S3a
   *  `w_buffer` lever. Their work is biased into the day's fast windows (the buffer term).
   *  Decided once on the base + shipped for parity; absent/empty ⇒ no buffer bias. */
  thinBufferProjects?: ReadonlySet<string> | null;
  /** Moves confined to this many days from `today` (default ARRANGE_HORIZON_DAYS). */
  horizonDays?: number;
  /** `J` term weights (default ARRANGE_WEIGHTS). */
  weights?: ArrangeWeights;
}

// --- Date helper (UTC-stable, mirroring schedule.ts/forecast.ts) ------------

function dayOffset(today: string, iso: string): number {
  const [ay, am, ad] = today.slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = iso.slice(0, 10).split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86_400_000);
}

// --- Within-day reorder: context-switch grouping + energy-window placement ---
//
// `arrangeOrder` re-sequences the canonical order WITHIN each near-horizon day. It
// buckets the order by the greedy pack offsets (so a bucket = a day's tasks), then
// runs a deterministic, dependency-safe greedy over each bucket that minimises the
// per-pick marginal `J = w_switch·(project changed) + w_energy·difficulty·(netMult−1)`.
// Picking a task advances the day's cumulative minutes, which selects the next task's
// start window (hence its `netMult`) — so within a project's cluster the greedy slots
// cognitively-HARD work into the day's FASTEST windows while continuing that cluster.
// With no window profile the energy term is 0 and it reduces EXACTLY to context-switch
// clustering (continue current project among ready blocks, else lowest-canonical-rank);
// with a single task per day it is the identity. Pure + RNG-free ⇒ the client replays it.

/** True when every same-bucket prerequisite of `taskId` has been emitted. */
function depsReady(
  taskId: string,
  prereqs: Map<string, Set<string>>,
  emitted: Set<string>,
): boolean {
  const reqs = prereqs.get(taskId);
  if (!reqs) return true;
  for (const r of reqs) if (!emitted.has(r)) return false;
  return true;
}

/** The window index (0..4, clock order) a task STARTING at `cumMinutes` into the day
 *  falls in, given the day's per-window capacities. Skips exhausted/empty windows and
 *  clamps an over-capacity cursor to the last window — mirroring the lane walk the
 *  windowed forecast does, so the reorder's window estimate matches what it'll be
 *  priced at. */
function windowIndexAt(cumMinutes: number, caps: number[]): number {
  let acc = 0;
  for (let i = 0; i < caps.length; i++) {
    acc += caps[i];
    if (cumMinutes < acc) return i;
  }
  return caps.length - 1;
}

/** A day's per-window capacities + net multipliers (clock order). With no profile the
 *  caps are all 0 and the multipliers all 1, so the energy term vanishes (switch-only). */
function daySegments(
  dayCapacityMinutes: number,
  profile: WindowProfile | null,
): { caps: number[]; mult: number[] } {
  if (!profile) return { caps: ALL_WINDOWS.map(() => 0), mult: ALL_WINDOWS.map(() => 1) };
  return {
    caps: splitMinutes(dayCapacityMinutes, profile.share),
    mult: ALL_WINDOWS.map((w) => profile.netMultiplier[w] ?? 1),
  };
}

/** Float-comparison slack for the marginal-`J` tiebreak (the canonical rank breaks
 *  near-equal costs, so identical inputs ⇒ identical sequence). */
const COST_EPSILON = 1e-9;

/**
 * Re-sequence one day's tasks to descend `J` (switches + energy misfit), staying
 * dependency-valid. Greedy, deterministic: among the ready tasks (same-day prereqs
 * emitted), take the one with the lowest marginal cost for the current cursor —
 * continuing the project (no switch) and, in a fast window, preferring hard work
 * (the energy reward). Ties break on canonical rank, so the result is reproducible.
 */
function sequenceDay(
  entries: EffectiveOrderEntry[],
  prereqs: Map<string, Set<string>>,
  segs: { caps: number[]; mult: number[] },
  weights: ArrangeWeights,
  thinBuffer: ReadonlySet<string>,
): EffectiveOrderEntry[] {
  const rank = new Map<string, number>();
  entries.forEach((e, i) => rank.set(e.taskId, i)); // canonical index = deterministic tiebreak

  const emitted = new Set<string>();
  const out: EffectiveOrderEntry[] = [];
  let cum = 0;
  let current: string | null | undefined; // last placed task's project

  while (out.length < entries.length) {
    const ready = entries.filter((e) => !emitted.has(e.taskId) && depsReady(e.taskId, prereqs, emitted));
    // A dependency cycle would leave nothing ready (can't happen for a canonical-ordered
    // bucket, which is already a valid topological order) — fall back to all unemitted so
    // we always make progress, mirroring `effectiveOrder`'s cycle guard.
    const pool = ready.length > 0 ? ready : entries.filter((e) => !emitted.has(e.taskId));
    const mult = segs.mult[windowIndexAt(cum, segs.caps)];
    let best = pool[0];
    let bestCost = Infinity;
    for (const e of pool) {
      const sw = current !== undefined && (e.projectId ?? null) !== current ? weights.switch : 0;
      // Energy: reward cognitively-hard work (`difficulty`) in a fast window (`netMult<1`),
      // penalise it in a slow one. The gate prices the resulting (reseeded) order's odds.
      const en = weights.energy * (e.difficulty ?? 0) * (mult - 1);
      // Buffer (S3a lever): a thin-buffer (at-risk) project's work gets the SAME fast-window
      // pull as energy but difficulty-INDEPENDENT — protect the thinnest deadline by giving
      // its work the hours it is most likely to finish in, even when that work is light.
      // Vanishes with no profile (`mult−1=0`) or when the project is not thin.
      const bf = thinBuffer.has(e.projectId) ? weights.buffer * (mult - 1) : 0;
      const cost = sw + en + bf;
      if (
        cost < bestCost - COST_EPSILON ||
        (cost <= bestCost + COST_EPSILON && rank.get(e.taskId)! < rank.get(best.taskId)!)
      ) {
        best = e;
        bestCost = cost;
      }
    }
    out.push(best);
    emitted.add(best.taskId);
    cum += Math.max(0, best.estimatedMinutes);
    current = best.projectId ?? null;
  }
  return out;
}

/**
 * Re-sequence the canonical order WITHIN each near-horizon day to descend `J`
 * (context-switches + energy-window misfit), dependency-safe. Pure + deterministic
 * (no RNG): identical inputs ⇒ identical order, so the S1 client replays it exactly.
 * Out-of-horizon buckets and single-task buckets are returned unchanged. The result
 * is a dependency-valid permutation of `order` (cross-day order is preserved — only
 * tasks the greedy pack lands on the same day are permuted, and same-day prereqs are
 * honoured by the per-bucket constrained greedy).
 */
export function arrangeOrder(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  deps: DependencyEdge[],
  today: string,
  opts: ArrangeOrderOptions = {},
): EffectiveOrderEntry[] {
  if (order.length <= 1) return order;
  const horizon = opts.horizonDays ?? ARRANGE_HORIZON_DAYS;
  const weights = opts.weights ?? ARRANGE_WEIGHTS;
  const profile = opts.windowProfile ?? null;
  const cap = opts.comfortCapMinutes ?? null;
  const thinBuffer = opts.thinBufferProjects ?? NO_THIN_BUFFER;

  // Bucket the order into the days the greedy pack lands it on (comfort-capped when a
  // cap is in force, so the buckets match the days the comfort flow actually uses) —
  // the neighbour structure the within-day reorder permutes inside. Offsets are
  // non-decreasing, so a bucket is a contiguous run of equal offsets.
  const durations = order.map((e) => Math.max(0, e.estimatedMinutes));
  const offsets =
    cap != null
      ? packOffsetsComfort(
          durations,
          capacities,
          order.map((e, i) => (e.difficulty ?? 0) * durations[i]),
          cap,
        )
      : packOffsets(durations, capacities);

  const out: EffectiveOrderEntry[] = [];
  let i = 0;
  let changed = false;
  while (i < order.length) {
    let j = i;
    while (j < order.length && offsets[j] === offsets[i]) j++;
    const bucket = order.slice(i, j);
    const off = offsets[i];
    if (off < horizon && bucket.length > 1) {
      // Same-day prerequisites only — cross-day prereqs are honoured by the bucket
      // ordering itself (an earlier bucket fully precedes a later one).
      const inBucket = new Set(bucket.map((e) => e.taskId));
      const prereqs = new Map<string, Set<string>>();
      for (const edge of deps) {
        if (!inBucket.has(edge.task_id) || !inBucket.has(edge.depends_on_task_id)) continue;
        if (!prereqs.has(edge.task_id)) prereqs.set(edge.task_id, new Set());
        prereqs.get(edge.task_id)!.add(edge.depends_on_task_id);
      }
      const seq = sequenceDay(bucket, prereqs, daySegments(capacities[off]?.capacityMinutes ?? 0, profile), weights, thinBuffer);
      for (let k = 0; k < seq.length; k++) if (seq[k].taskId !== bucket[k].taskId) changed = true;
      out.push(...seq);
    } else {
      out.push(...bucket);
    }
    i = j;
  }
  return changed ? out : order; // same reference when nothing moved (cheap no-op signal)
}

// --- Pillar 1: the window-capacity model (OVERHAUL S3b Phase 2) --------------
//
// To PRICE work by time-of-day we must know how much room each window holds. Today
// capacity is hours-per-DAY; we split each day's minutes across the five S2 windows
// by a SHRUNK observed share and tag each segment with its net-of-global velocity
// multiplier. Both inputs degrade to a no-op: an unobserved share ⇒ the default
// profile, an unlearned window ⇒ multiplier exactly 1, so a flat split flows
// byte-identically to the day-granular forecast (the no-regret anchor proven against
// `flowFinishOffsets`). The realised `WindowCapacity[]` is what `globalForecastJoint`
// flows over; Phase 3's gated search will also place hard work into the fast windows
// this model exposes. Pure, client-safe — the S1 client re-solve rebuilds identical
// segments from identical capacities, so 14/14 parity rides for free.

/** A day's deployable minutes distributed across the five windows + each window's
 *  net velocity multiplier — the static, skip-independent inputs to a windowed
 *  forecast. `windowCapacities(days, profile)` realises it against ANY day series
 *  (base or skip-adjusted), so the server headline and the S1 client re-solve build
 *  identical segments from identical capacities. */
export interface WindowProfile {
  /** Per-window fraction of a day's minutes (sums to 1); shrunk toward DEFAULT_WINDOW_SHARE. */
  share: Record<TimeWindow, number>;
  /** `exp(μ_window − μ₀)` per window: <1 faster, >1 slower, =1 unlearned (net of the global bias). */
  netMultiplier: Record<TimeWindow, number>;
}

/** A-priori distribution of deployable minutes across the day's windows, used until
 *  session history earns the real one. Daytime-skewed (focused work lands mostly in
 *  morning/afternoon/evening). It only BOUNDS how much work may claim a window's
 *  multiplier — never feasibility (placement spends slack under Phase 3's gate) — so a
 *  rough prior is safe; a calibratable knob. Sums to 1. */
export const DEFAULT_WINDOW_SHARE: Record<TimeWindow, number> = {
  early: 0.1,
  morning: 0.25,
  afternoon: 0.3,
  evening: 0.25,
  night: 0.1,
};

/** Pseudo-session mass anchoring `observedWindowShare` to the default profile —
 *  "how many sessions of evidence move the share halfway off the prior" (at N=κ the
 *  blend is 50/50). Prior-favoring so a handful of sessions can't produce a degenerate
 *  share; a knob, calibrated later by S2's loop. */
export const WINDOW_SHARE_PRIOR_STRENGTH = 10;

/** Shrink an observed per-window session count toward DEFAULT_WINDOW_SHARE
 *  (Dirichlet posterior mean / additive smoothing): `(count_w + κ·p0_w)/(N + κ)`.
 *  No sessions ⇒ the default profile exactly; dense ⇒ the empirical distribution.
 *  Always sums to 1. Pure. */
export function observedWindowShare(
  counts: Record<TimeWindow, number>,
  opts: { strength?: number } = {},
): Record<TimeWindow, number> {
  const kappa = opts.strength ?? WINDOW_SHARE_PRIOR_STRENGTH;
  let total = 0;
  for (const w of ALL_WINDOWS) total += Math.max(0, counts[w] ?? 0);
  const denom = total + kappa;
  const share = {} as Record<TimeWindow, number>;
  for (const w of ALL_WINDOWS) {
    const c = Math.max(0, counts[w] ?? 0);
    share[w] = (c + kappa * DEFAULT_WINDOW_SHARE[w]) / denom;
  }
  return share;
}

/** Build a `WindowProfile` from the S2 energy-window read (`energyWindows`, which
 *  carries each window's multiplier `exp(μ_w)` + its session count) and the global
 *  prior. `netMultiplier = multiplier / exp(μ₀) = exp(μ_w − μ₀)` — exactly 1 for an
 *  unlearned window (its multiplier IS `exp(μ₀)`), so the profile is flat until windows
 *  are earned. Returns null when no window has any session (the no-signal gate: the
 *  caller then keeps the day-granular forecast, the exact pre-S3b path). */
export function windowProfileFromEnergy(
  energy: EnergyWindow[],
  prior: EstimationModel,
  opts: { strength?: number } = {},
): WindowProfile | null {
  if (!energy.some((e) => e.sampleSize > 0)) return null;
  const counts = {} as Record<TimeWindow, number>;
  const netMultiplier = {} as Record<TimeWindow, number>;
  for (const w of ALL_WINDOWS) {
    counts[w] = 0;
    netMultiplier[w] = 1;
  }
  const globalMult = Math.exp(prior.meanLog);
  for (const e of energy) {
    counts[e.window] = e.sampleSize;
    netMultiplier[e.window] = e.multiplier / globalMult;
  }
  return { share: observedWindowShare(counts, opts), netMultiplier };
}

/** Split each day's deployable minutes into the five window segments by `profile.share`,
 *  tagging each with the window's net multiplier — the windowed-forecast input. The split
 *  PRESERVES the day total exactly (largest-remainder rounding), so a flat profile flows
 *  byte-identically to the whole-day capacity (the no-regret anchor). Windows stay in clock
 *  order (early→night) so a task's start-window is the earliest unfilled window of its day.
 *  Pure; realise it against whichever day series a forecast pass uses (skip-safe). */
export function windowCapacities(
  days: DayCapacity[],
  profile: WindowProfile,
): WindowCapacity[] {
  const out: WindowCapacity[] = [];
  for (const day of days) {
    const parts = splitMinutes(day.capacityMinutes, profile.share);
    for (let i = 0; i < ALL_WINDOWS.length; i++) {
      const w = ALL_WINDOWS[i];
      out.push({
        iso: day.iso,
        window: w,
        capacityMinutes: parts[i],
        netMultiplier: profile.netMultiplier[w] ?? 1,
      });
    }
  }
  return out;
}

/** Split an integer `total` across the windows by `share`, preserving the sum exactly
 *  (floor each, hand the rounding remainder to the largest fractional parts; ties break
 *  on clock order). Deterministic — the byte-identical degradation depends on the parts
 *  summing to `total`. */
function splitMinutes(total: number, share: Record<TimeWindow, number>): number[] {
  if (total <= 0) return ALL_WINDOWS.map(() => 0);
  const raw = ALL_WINDOWS.map((w) => total * (share[w] ?? 0));
  const parts = raw.map((x) => Math.floor(x));
  let remainder = total - parts.reduce((s, x) => s + x, 0);
  const byFrac = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; k < byFrac.length && remainder > 0; k++) {
    parts[byFrac[k].i]++;
    remainder--;
  }
  return parts;
}

// --- Pillar 3 (Phase 3, slice 1): comfort-capped load smoothing ---
//
// Phases 1-2 arranged WITHIN a day (context-switch grouping, odds-neutral) and PRICED the
// canonical order's window placement. This is the first arrangement that changes the odds:
// it spreads HARD (cognitively-demanding) work across days so no day piles on more than a
// sustainable amount — productivity research caps focused work at ~3-4 h/day (Ericsson;
// "deep work"), and resource SMOOTHING relaxes a plan within its slack rather than levelling
// it to the deadline (which Parkinson's Law would just refill). Spreading work later costs
// completion odds, so the move is odds-GATED, never odds-authoring: a comfort-capped plan is
// admissible only while its `allOnTime ≥ canonical − ε`. `forecast()` stays the sole owner
// of odds (§0); the smoother only chooses among layouts the Monte Carlo prices.
//
// The order is UNCHANGED — only the per-day hard-work cap shifts WHEN work happens (no
// reorder, so dependencies/grouping are preserved for free, and the client reproduces the
// plan from a single shipped scalar in slice 2). Two-stage pricing: a deterministic
// point-estimate scan finds the most-comfortable cap that keeps every deadline; the full MC
// then gates it. No RNG ⇒ identical inputs, identical plan.

/** Target soft daily ceiling on HARD work (minutes) — what the smoother relaxes toward.
 *  ~4 h is the generous end of the sustainable focused-work window. A knob, calibrated later. */
export const COMFORT_CAP_MINUTES = 240;
/** Gate slack: a comfort-capped plan is admissible only if its `allOnTime` stays within this
 *  of the canonical (uncapped) plan's — it may spend a sliver of slack to relax the pace. */
export const ARRANGE_ODDS_EPSILON = 0.02;

export interface ComfortSmoothOptions {
  /** Estimation-bias options for the MC (sigma/meanLog; iterations optional). */
  forecast: ForecastOptions;
  /** Window profile for windowed pricing — applied to BOTH the canonical baseline AND the
   *  comfort-capped gate MC (Phase 4 composition), so the gate compares apples-to-apples:
   *  a windowed-canonical vs a windowed-comfort plan. (Pre-Phase-4 the comfort gate dropped
   *  windows, making it conservative when windows were favourable; the composition lifts that.) */
  windowProfile?: WindowProfile | null;
  /** Hard-work ceiling to relax toward (default COMFORT_CAP_MINUTES). */
  comfortCapMinutes?: number;
  /** Gate slack on `allOnTime` (default ARRANGE_ODDS_EPSILON). */
  oddsEpsilon?: number;
}

export interface ComfortSmoothResult {
  /** The applied hard-work cap (minutes) when smoothing fired, else null (canonical). The
   *  single scalar slice 2 ships to the client to reproduce the plan. */
  comfortCapMinutes: number | null;
  /** The MC odds of the RETURNED plan (comfort-capped when applied, else canonical) — the
   *  headline is always the plan you follow. */
  joint: { byProject: Map<string, number>; allOnTime: number };
  /** Whether comfort smoothing was applied (false ⇒ canonical / no affordable relaxation). */
  changed: boolean;
}

/** Each deadlined project's point-estimate lateness (`max(0, finishOffset − deadline)`) for
 *  the given finish offsets — the cheap, monotone feasibility proxy the cap scan screens on. */
function perProjectOverBy(
  offsets: number[],
  order: EffectiveOrderEntry[],
  deadlineOffset: Map<string, number>,
): Map<string, number> {
  const lastByProject = new Map<string, number>();
  for (let k = 0; k < order.length; k++) {
    const pid = order[k].projectId;
    if (!deadlineOffset.has(pid)) continue;
    const cur = lastByProject.get(pid);
    if (cur === undefined || offsets[k] > cur) lastByProject.set(pid, offsets[k]);
  }
  const over = new Map<string, number>();
  for (const [pid, fin] of lastByProject) {
    over.set(pid, Math.max(0, fin - deadlineOffset.get(pid)!));
  }
  return over;
}

/**
 * Spread hard work across days up to the comfort cap, but only when slack allows
 * (resource smoothing within float). Applies the target hard-work cap iff its
 * comfort-capped plan keeps every deadline (point-estimate screen) AND holds `allOnTime ≥
 * canonical − ε` (full MC gate); otherwise canonical stands (no affordable relaxation).
 * The order is never changed — only the per-day hard budget shifts WHEN work lands. Pure:
 * same inputs ⇒ same result. (A graduated scan over intermediate caps is a refinement; in
 * practice the gate is near all-or-nothing — full comfort under a loose deadline, none
 * under a tight one — so a single target keeps the mechanism honest and simple.)
 */
export function comfortSmooth(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
  opts: ComfortSmoothOptions,
): ComfortSmoothResult {
  const target = opts.comfortCapMinutes ?? COMFORT_CAP_MINUTES;
  const epsilon = opts.oddsEpsilon ?? ARRANGE_ODDS_EPSILON;

  // Canonical (uncapped) baseline — windowed when a profile is present, so a no-smooth
  // result matches the dashboard's existing headline exactly.
  const windowCaps = opts.windowProfile
    ? windowCapacities(capacities, opts.windowProfile)
    : undefined;
  const canonicalOpts: ForecastOptions = windowCaps
    ? { ...opts.forecast, windowCapacities: windowCaps }
    : opts.forecast;
  const canonicalJoint = globalForecastJoint(
    order,
    capacities,
    deadlineByProject,
    today,
    canonicalOpts,
  );
  const noChange: ComfortSmoothResult = {
    comfortCapMinutes: null,
    joint: canonicalJoint,
    changed: false,
  };
  // Nothing to spread: a single task, or no hard-work signal anywhere ⇒ today's plan.
  if (order.length <= 1 || !order.some((e) => (e.difficulty ?? 0) > 0)) return noChange;

  const deadlineOffset = new Map<string, number>();
  for (const [pid, dl] of deadlineByProject) {
    if (dl) deadlineOffset.set(pid, dayOffset(today, dl));
  }

  const durations = order.map((e) => Math.max(0, e.estimatedMinutes));
  const hardPoint = order.map((e, i) => (e.difficulty ?? 0) * durations[i]);

  // Nothing exceeds the comfort cap already ⇒ no day to relieve ⇒ today's plan stands.
  // (A cap ≥ every day's hard load never binds, so the comfort flow == the canonical flow.)
  const canonPack = packOffsets(durations, capacities);
  const hardByDay = new Map<number, number>();
  for (let k = 0; k < order.length; k++) {
    hardByDay.set(canonPack[k], (hardByDay.get(canonPack[k]) ?? 0) + hardPoint[k]);
  }
  let maxHardPerDay = 0;
  for (const h of hardByDay.values()) if (h > maxHardPerDay) maxHardPerDay = h;
  if (maxHardPerDay <= target) return noChange;

  // The canonical point-estimate lateness per project — the cap must not worsen it (spread
  // later, never past a met deadline nor a late project further).
  const canonicalOver = perProjectOverBy(
    flowFinishOffsets(durations, capacities),
    order,
    deadlineOffset,
  );

  // Stage 1 — deterministic point-estimate screen: does the comfort cap still hit every
  // deadline it currently hits (spread later, never past a met deadline nor a late one)?
  const proxyOver = perProjectOverBy(
    flowFinishOffsetsComfort(durations, capacities, hardPoint, target),
    order,
    deadlineOffset,
  );
  for (const [pid, over] of proxyOver) {
    if (over > (canonicalOver.get(pid) ?? 0)) return noChange;
  }
  // Stage 2 — the full MC gate: spread only as far as the odds can afford. The comfort cap
  // and the window pricing COMPOSE (Phase 4): the gate prices the comfort-capped plan with
  // the same window velocity the canonical baseline uses, so a favourable window doesn't make
  // a comfortable pace look worse than it is.
  const joint = globalForecastJoint(order, capacities, deadlineByProject, today, {
    ...opts.forecast,
    comfortCapMinutes: target,
    ...(windowCaps ? { windowCapacities: windowCaps } : {}),
  });
  if (joint.allOnTime >= canonicalJoint.allOnTime - epsilon) {
    return { comfortCapMinutes: target, joint, changed: true };
  }
  return noChange;
}

// --- Pillar 3 (Phase 3, slice 3): the odds-gated within-day reorder ----------
//
// `arrangeOrder` is the deterministic chooser; `gatedReorder` is its odds gate. It
// re-prices the arranged order with the SAME Monte Carlo (and the same comfort/window
// precedence) the headline uses and decides ONE boolean — "should the forecast flow
// the arranged order?" — that the strategy optimizer + the S1 client replay. The
// reorder is adopted only while `allOnTime ≥ canonical − ε` (§Decisions #3: arrangement
// is odds-gated, never odds-authoring). Because reordering the order array reseeds the
// MC, an odds-*neutral* reorder is not byte-identical — so when there is no odds-relevant
// signal (no windows AND no comfort) the grouping is returned for DISPLAY only and the
// forecast stays on the canonical order (the byte-identical no-regret anchor: a
// day-granular flow is order-invariant within a day, so the grouping is genuinely free).

export interface GatedReorderOptions {
  /** Estimation-bias options for the MC gate (sigma/meanLog; iterations optional). */
  forecast: ForecastOptions;
  /** Per-window velocity profile (activates the energy term + windowed pricing). */
  windowProfile?: WindowProfile | null;
  /** The comfort cap already decided for this plan (comfort takes pricing precedence). */
  comfortCapMinutes?: number | null;
  /** The at-risk (thin-buffer) project set decided on the base plan — the S3a `w_buffer`
   *  lever, biasing those projects' work into fast windows. Absent ⇒ no buffer bias. */
  thinBufferProjects?: ReadonlySet<string> | null;
  /** Gate slack on `allOnTime` (default ARRANGE_ODDS_EPSILON). */
  oddsEpsilon?: number;
  /** `J` term weights (default ARRANGE_WEIGHTS). */
  weights?: ArrangeWeights;
}

export interface GatedReorderResult {
  /** Whether the FORECAST should flow the arranged order — the single boolean the
   *  strategy base + the S1 client replay. True only when the reorder is odds-relevant
   *  (windows learned OR comfort active) AND the gate passed. */
  changed: boolean;
  /** The order to DISPLAY (arranged when grouping is admissible, else canonical). */
  order: EffectiveOrderEntry[];
  /** The odds to show — the arranged order's when flowed, else the canonical baseline. */
  joint: { byProject: Map<string, number>; allOnTime: number };
}

/**
 * Decide whether to adopt the within-day reorder, gating its odds against the canonical
 * baseline. Returns the boolean the client replays, the order to display, and the odds
 * to show. Pure given its inputs (the MC seed is fixed). See the section comment.
 */
export function gatedReorder(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
  deps: DependencyEdge[],
  canonicalJoint: { byProject: Map<string, number>; allOnTime: number },
  opts: GatedReorderOptions,
): GatedReorderResult {
  const profile = opts.windowProfile ?? null;
  const cap = opts.comfortCapMinutes ?? null;
  const arranged = arrangeOrder(order, capacities, deps, today, {
    windowProfile: profile,
    comfortCapMinutes: cap,
    thinBufferProjects: opts.thinBufferProjects,
    weights: opts.weights,
  });
  // Nothing moved ⇒ canonical everywhere (arrangeOrder returns the same reference).
  if (arranged === order) return { changed: false, order, joint: canonicalJoint };

  // No odds-relevant signal ⇒ the grouping is free: DISPLAY it, but keep the forecast on
  // the canonical order (byte-identical odds). `changed=false` ⇒ the client never flows it.
  if (cap == null && profile == null) {
    return { changed: false, order: arranged, joint: canonicalJoint };
  }

  // Odds-relevant ⇒ gate: re-price the arranged order the same way the headline does —
  // the comfort cap and window pricing COMPOSE (Phase 4), both applied when both are in
  // force — and adopt it only while `allOnTime ≥ canonical − ε`.
  const opts2: ForecastOptions = { ...opts.forecast };
  if (cap != null) opts2.comfortCapMinutes = cap;
  if (profile) opts2.windowCapacities = windowCapacities(capacities, profile);
  const arrangedJoint = globalForecastJoint(arranged, capacities, deadlineByProject, today, opts2);
  const epsilon = opts.oddsEpsilon ?? ARRANGE_ODDS_EPSILON;
  if (arrangedJoint.allOnTime >= canonicalJoint.allOnTime - epsilon) {
    return { changed: true, order: arranged, joint: arrangedJoint };
  }
  // Gate failed: don't show (or price) a grouping that costs odds — canonical stands.
  return { changed: false, order, joint: canonicalJoint };
}
