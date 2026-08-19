import {
  flowFinishOffsets,
  flowFinishOffsetsComfort,
  packOffsets,
  packOffsetsComfort,
  type DayCapacity,
  type DependencyEdge,
  type WindowCapacity,
} from "@/lib/schedule";
import type { EffectiveOrderEntry, EstimationModel, PlanReorder } from "@/lib/types";
import { globalForecastJoint, type ForecastOptions } from "@/lib/forecast";
import { ALL_WINDOWS, type EnergyWindow, type TimeWindow } from "@/lib/velocity";
import { fitCalibratedWeights, type PreferencePair } from "@/lib/calibrate";

// Local arrangement optimizer. The Monte Carlo forecast owns feasibility and odds; this
// module only makes the plan you actually follow good on the soft stuff the forecast
// doesn't price: context switching, energy-window placement, daily load. Pure and
// deterministic, no LLM, no probability authored here.
//
// arrangeOrder buckets the canonical order into the days the greedy pack lands it on,
// then re-sequences each near-horizon day to group projects and slot hard work into
// learned-fast windows. gatedReorder re-prices the result with the same Monte Carlo the
// headline uses and adopts it only while allOnTime >= canonical - eps. The reorder is
// deterministic and reads only inputs the client already mirrors, so the whole gate
// decision compresses to one boolean the client replays.
//
// Reordering the array reseeds the forecast, so an odds-neutral reorder isn't
// byte-identical. The gate boolean is therefore only set when there's an odds-relevant
// signal (windows learned or comfort active) AND the gate passes; with no signal the
// grouping is display-only. See design/s3b-arrangement-optimizer.md.

/** Per-objective weights for the soft score J (lower is better), all defaulting to 1 and
 *  calibrated later. At the defaults the switch term dominates the energy term, so energy
 *  placement operates WITHIN a project's cluster; raising `energy` is what lets it break a
 *  cluster for a strong window gain. Energy and buffer share the (netMult-1) coupling, so
 *  both vanish without a learned profile and J reduces to pure grouping. */
export interface ArrangeWeights {
  /** Penalty per project change across a day's within-day sequence (context-switch cost). */
  switch: number;
  /** Penalty per LIFE-AREA change within a day. Coarser than `switch`: a project belongs to
   *  one area, so an area change always implies a project change - this never fires without
   *  `switch` also firing, it only biases WHICH project to switch to (Work with Work, Hobby
   *  with Hobby). Degrades to 0 when areas are absent. */
  domain: number;
  /** Weight on `difficulty·impactBoost·(netMult-1)` - negative (reward) for hard work in a
   *  fast window, positive for hard work in a slow one. Basically "do hard work when you're
   *  sharp", with impact as a secondary tiebreak so a fast window goes to work that's hard
   *  AND valuable. Inert without a learned window profile. Not duration-weighted on purpose:
   *  a long task would hog the fast lane. */
  energy: number;
  /** Weight on `urgency·(netMult-1)` for a thin-buffer project's work - same window coupling
   *  as energy but independent of difficulty. Gives the work whose safety margin is thinnest
   *  first claim on the day's fast windows, widening its buffer even when the remaining work
   *  is light. urgency grades by HOW thin (was a binary flag). Inert without a window profile
   *  or when nothing is thin. */
  buffer: number;
}

/** Default weights - `1.0` as knobs, calibrated later by S2's loop. */
export const ARRANGE_WEIGHTS: ArrangeWeights = { switch: 1, domain: 1, energy: 1, buffer: 1 };

/** How strongly impact modulates the ENERGY term: the boost spans [1-w, 1+w] across impact
 *  1->5, neutral at 3. Set to 0 to make energy purely effort-driven. Effort stays dominant -
 *  this only breaks near-ties in favour of the more valuable task. */
export const IMPACT_ENERGY_WEIGHT = 0.5;

/** Impact 1-5 → an energy-term multiplier in `[1−IMPACT_ENERGY_WEIGHT, 1+IMPACT_ENERGY_WEIGHT]`
 *  (neutral 1 at impact 3 or absent). Pure. */
function impactEnergyBoost(impact: number | undefined): number {
  return 1 + (IMPACT_ENERGY_WEIGHT * ((impact ?? 3) - 3)) / 2;
}

/** Shared empty thin-buffer urgency map - the no-buffer-bias default (avoids per-call allocation). */
const NO_THIN_BUFFER: ReadonlyMap<string, number> = new Map();

/** How far out we re-arrange: the committed near-horizon. Beyond it the plan is
 *  re-derived as time advances, so re-sequencing it now is wasted (and out of
 *  scope - "committed horizon"). Out-of-horizon days are returned untouched. */
export const ARRANGE_HORIZON_DAYS = 14;

export interface ArrangeOrderOptions {
  windowProfile?: WindowProfile | null;
  /** Comfort cap (hard min/day) - when set, the day-bucketing mirrors the comfort-capped
   *  pack so the reorder permutes inside the same days the comfort flow lands work on. */
  comfortCapMinutes?: number | null;
  /** projectId → thin-buffer URGENCY `(0,1]` under the base plan - the S3a `w_buffer` lever,
   *  graded by how thin. Their work is biased into the day's fast windows in
   *  proportion to urgency. Decided once on the base + shipped for parity; absent/empty ⇒ no
   *  buffer bias. */
  thinBufferUrgency?: ReadonlyMap<string, number> | null;
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
// arrangeOrder re-sequences the canonical order within each near-horizon day. It buckets
// by the greedy pack offsets, then runs a dependency-safe search over each bucket
// minimising the per-pick marginal J. Picking a task advances the day's cumulative
// minutes, which selects the next task's window (hence its netMult), so within a cluster
// the greedy slots hard work into the fastest windows while continuing that cluster.
//
// Two stages: a greedy CONSTRUCTION, then a best-improvement swap loop that repairs the
// greedy's one-step myopia (a task's window depends on the whole day-prefix, not just its
// predecessor). The second stage only accepts strict J drops, so it's never worse. With no
// window profile the energy term is 0 and this reduces to context-switch clustering.

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

/** Which window (0..4, clock order) a task starting at `cumMinutes` into the day falls in.
 *  Skips exhausted windows and clamps an over-capacity cursor to the last one, mirroring
 *  the lane walk the windowed forecast does so the estimate matches what it'll be priced at. */
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

/** Safety cap on best-improvement passes per day (`improveDaySwaps`). Each accepted pass
 *  strictly lowers the day `J`, so a local optimum is reached in far fewer than this for a
 *  real day bucket (a handful of tasks); the bound only guards against a pathological float
 *  landscape. Not a tuning knob - the search is exhaustive within a pass, this just terminates it. */
const ARRANGE_MAX_IMPROVE_STEPS = 64;

/** The four unweighted terms of placing `e` next - the per-pick contribution to
 *  φ = (switch, domain, energy, buffer). A switch is a unit when the project changes, a
 *  domain switch when the life-area does (so dm <= sw). Both window terms carry (mult - 1),
 *  so both vanish with no learned profile and φ reduces to the switch + domain counts.
 *  The single source of the term math: marginalJ dots it with the weights and
 *  arrangementFeatures sums it, so chooser, scorer and calibrator can't drift apart. */
function marginalFeatures(
  e: EffectiveOrderEntry,
  current: string | null | undefined,
  currentArea: string | null | undefined,
  mult: number,
  thinBuffer: ReadonlyMap<string, number>,
): [number, number, number, number] {
  const sw = current !== undefined && (e.projectId ?? null) !== current ? 1 : 0;
  // Domain-axis grouping: a unit per LIFE-AREA change (a coarser sibling of `switch`). Since
  // area change implies project change, `dm` is a subset of `sw` - it only settles which
  // project to switch to. An absent area (null both sides) is never a change, so a plan with
  // no area signal contributes 0 here (degrades to switch-only grouping).
  const dm = currentArea !== undefined && (e.area ?? null) !== currentArea ? 1 : 0;
  const en = (e.difficulty ?? 0) * impactEnergyBoost(e.impact) * (mult - 1);
  const bf = (thinBuffer.get(e.projectId) ?? 0) * (mult - 1);
  return [sw, dm, en, bf];
}

/** The marginal J of placing `e` next. sequenceDay minimises it, arrangementScore sums it,
 *  both through marginalFeatures, so the chooser and the scorer can't drift. */
function marginalJ(
  e: EffectiveOrderEntry,
  current: string | null | undefined,
  currentArea: string | null | undefined,
  mult: number,
  weights: ArrangeWeights,
  thinBuffer: ReadonlyMap<string, number>,
): number {
  const [sw, dm, en, bf] = marginalFeatures(e, current, currentArea, mult, thinBuffer);
  return weights.switch * sw + weights.domain * dm + weights.energy * en + weights.buffer * bf;
}

/** The full-day J of a within-day sequence. The window a task lands in depends on the
 *  running cumulative minutes - i.e. on the whole prefix, not just its predecessor. That
 *  coupling is exactly what a one-step greedy misjudges and best-improvement repairs. */
function dayScore(
  seq: readonly EffectiveOrderEntry[],
  segs: { caps: number[]; mult: number[] },
  weights: ArrangeWeights,
  thinBuffer: ReadonlyMap<string, number>,
): number {
  let cum = 0;
  let J = 0;
  let current: string | null | undefined;
  let currentArea: string | null | undefined;
  for (const e of seq) {
    const mult = segs.mult[windowIndexAt(cum, segs.caps)];
    J += marginalJ(e, current, currentArea, mult, weights, thinBuffer);
    cum += Math.max(0, e.estimatedMinutes);
    current = e.projectId ?? null;
    currentArea = e.area ?? null;
  }
  return J;
}

/** True when `seq` respects every same-day prerequisite (each in-bucket prereq of a task appears
 *  at an earlier position). A candidate swap is admitted only if it keeps this - so best-improvement
 *  never moves a task before a same-day prerequisite. Cross-day prereqs are honoured by the bucketing
 *  (an earlier day fully precedes a later one), so `prereqs` holds only same-bucket edges. Pure. */
function seqDepsValid(
  seq: readonly EffectiveOrderEntry[],
  prereqs: Map<string, Set<string>>,
): boolean {
  const pos = new Map<string, number>();
  seq.forEach((e, i) => pos.set(e.taskId, i));
  for (let i = 0; i < seq.length; i++) {
    const reqs = prereqs.get(seq[i].taskId);
    if (!reqs) continue;
    for (const r of reqs) {
      const rp = pos.get(r);
      if (rp !== undefined && rp > i) return false;
    }
  }
  return true;
}

/** Best-improvement local search over pairwise swaps from `seed`. sequenceDay runs it from
 *  two starts (the greedy construction and the canonical order) and keeps the better, because
 *  the greedy is one-step myopic: placing a big easy task early can shove a hard task out of a
 *  fast window in a way a nearest-neighbour pick can't foresee. Each pass applies the single
 *  dependency-valid swap that most lowers J, up to a local optimum or ARRANGE_MAX_IMPROVE_STEPS.
 *
 *  Deterministic (fixed scan order, strict improvement only) and monotone, so the result is
 *  never worse than the seed and the client replays it exactly. */
function improveDaySwaps(
  seed: EffectiveOrderEntry[],
  prereqs: Map<string, Set<string>>,
  segs: { caps: number[]; mult: number[] },
  weights: ArrangeWeights,
  thinBuffer: ReadonlyMap<string, number>,
): EffectiveOrderEntry[] {
  const n = seed.length;
  if (n < 2) return seed; // nothing to swap
  let cur = seed;
  let curJ = dayScore(cur, segs, weights, thinBuffer);
  for (let step = 0; step < ARRANGE_MAX_IMPROVE_STEPS; step++) {
    let bestJ = curJ;
    let bestSeq: EffectiveOrderEntry[] | null = null;
    for (let i = 0; i < n - 1; i++) {
      for (let j = i + 1; j < n; j++) {
        const cand = cur.slice();
        [cand[i], cand[j]] = [cand[j], cand[i]];
        if (!seqDepsValid(cand, prereqs)) continue;
        const candJ = dayScore(cand, segs, weights, thinBuffer);
        if (candJ < bestJ - COST_EPSILON) {
          bestJ = candJ;
          bestSeq = cand;
        }
      }
    }
    if (!bestSeq) break; // local optimum
    cur = bestSeq;
    curJ = bestJ;
  }
  return cur;
}

/** Re-sequence one day's tasks to descend J, staying dependency-valid, in two stages: a
 *  greedy construction then a best-improvement search. The greedy takes, among ready tasks,
 *  the lowest marginal cost for the current cursor - continuing the project and, in a fast
 *  window, preferring hard work. Ties break on canonical rank so it's reproducible. */
function sequenceDay(
  entries: EffectiveOrderEntry[],
  prereqs: Map<string, Set<string>>,
  segs: { caps: number[]; mult: number[] },
  weights: ArrangeWeights,
  thinBuffer: ReadonlyMap<string, number>,
): EffectiveOrderEntry[] {
  const rank = new Map<string, number>();
  entries.forEach((e, i) => rank.set(e.taskId, i)); // canonical index = deterministic tiebreak

  const emitted = new Set<string>();
  const out: EffectiveOrderEntry[] = [];
  let cum = 0;
  let current: string | null | undefined; // last placed task's project
  let currentArea: string | null | undefined; // last placed task's life-area

  while (out.length < entries.length) {
    const ready = entries.filter((e) => !emitted.has(e.taskId) && depsReady(e.taskId, prereqs, emitted));
    // A dependency cycle would leave nothing ready (can't happen for a canonical-ordered
    // bucket, which is already a valid topological order) - fall back to all unemitted so
    // we always make progress, mirroring `effectiveOrder`'s cycle guard.
    const pool = ready.length > 0 ? ready : entries.filter((e) => !emitted.has(e.taskId));
    const mult = segs.mult[windowIndexAt(cum, segs.caps)];
    let best = pool[0];
    let bestCost = Infinity;
    for (const e of pool) {
      // Switch + domain (keep same-area work together) + energy (hard/valuable work into fast
      // windows) + buffer (at-risk work into fast windows) - the shared objective
      // `arrangementScore` also prices. See `marginalJ`.
      const cost = marginalJ(e, current, currentArea, mult, weights, thinBuffer);
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
    currentArea = best.area ?? null;
  }
  // Two-start best-improvement: descend from BOTH the greedy construction and the canonical
  // bucket order (itself a valid topological order) and keep the lower J. The greedy is the
  // better start most days, but its myopic construction can occasionally score above the
  // order it was handed - starting from canonical too guarantees the arrangement is never
  // worse than the input. Ties keep the greedy-seeded result.
  const fromGreedy = improveDaySwaps(out, prereqs, segs, weights, thinBuffer);
  const fromCanonical = improveDaySwaps(entries.slice(), prereqs, segs, weights, thinBuffer);
  return dayScore(fromCanonical, segs, weights, thinBuffer) <
    dayScore(fromGreedy, segs, weights, thinBuffer) - COST_EPSILON
    ? fromCanonical
    : fromGreedy;
}

/** Re-sequence the canonical order within each near-horizon day to descend J,
 *  dependency-safe. Pure and deterministic, so the client replays it exactly.
 *  Out-of-horizon and single-task buckets come back unchanged. Cross-day order is
 *  preserved - only tasks the pack lands on the same day are permuted. */
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
  const thinBuffer = opts.thinBufferUrgency ?? NO_THIN_BUFFER;

  // Bucket the order into the days the greedy pack lands it on (comfort-capped when a
   // cap is in force, so the buckets match the days the comfort flow actually uses) -
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
      // Same-day prerequisites only - cross-day prereqs are honoured by the bucket
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

/** φ = (switch, domain, energy, buffer) for an order - the unweighted decomposition of
 *  arrangementScore, so J = weights · φ exactly. */
export interface ArrangeFeatures {
  switch: number;
  domain: number;
  energy: number;
  buffer: number;
}

/** φ for an order AS GIVEN - the weight-independent inputs arrangementScore weights and
 *  sums. Buckets by the identical pack, then walks each near-horizon bucket summing
 *  marginalFeatures with no re-sequencing. This is what the drag calibrator contrasts
 *  between the user's order and the solver's; because φ is weight-free, a stored pair
 *  re-prices under the CURRENT feature functions. */
export function arrangementFeatures(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  today: string,
  opts: ArrangeOrderOptions = {},
): ArrangeFeatures {
  if (order.length === 0) return { switch: 0, domain: 0, energy: 0, buffer: 0 };
  const horizon = opts.horizonDays ?? ARRANGE_HORIZON_DAYS;
  const profile = opts.windowProfile ?? null;
  const cap = opts.comfortCapMinutes ?? null;
  const thinBuffer = opts.thinBufferUrgency ?? NO_THIN_BUFFER;

  // Identical bucketing to `arrangeOrder` (comfort-capped when a cap is set) so `φ` measures
  // the same day layout the arranger optimises.
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

  let sSwitch = 0;
  let sDomain = 0;
  let sEnergy = 0;
  let sBuffer = 0;
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j < order.length && offsets[j] === offsets[i]) j++;
    const off = offsets[i];
    if (off < horizon) {
      const segs = daySegments(capacities[off]?.capacityMinutes ?? 0, profile);
      let cum = 0;
      let current: string | null | undefined;
      let currentArea: string | null | undefined;
      for (let k = i; k < j; k++) {
        const e = order[k];
        const mult = segs.mult[windowIndexAt(cum, segs.caps)];
        const [sw, dm, en, bf] = marginalFeatures(e, current, currentArea, mult, thinBuffer);
        sSwitch += sw;
        sDomain += dm;
        sEnergy += en;
        sBuffer += bf;
        cum += Math.max(0, e.estimatedMinutes);
        current = e.projectId ?? null;
        currentArea = e.area ?? null;
      }
    }
    i = j;
  }
  return { switch: sSwitch, domain: sDomain, energy: sEnergy, buffer: sBuffer };
}

/** The total soft score J of an order as given - the same objective arrangeOrder minimises,
 *  evaluated instead of optimised. Routing through arrangementFeatures keeps the scorer, the
 *  chooser and the calibrator's φ on identical term math. This is what the rolling-horizon
 *  stability gate weighs. */
export function arrangementScore(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  today: string,
  opts: ArrangeOrderOptions = {},
): number {
  const weights = opts.weights ?? ARRANGE_WEIGHTS;
  const f = arrangementFeatures(order, capacities, today, opts);
  return weights.switch * f.switch + weights.domain * f.domain + weights.energy * f.energy + weights.buffer * f.buffer;
}

/** Calibrate ArrangeWeights from the drag-to-reorder history. Each stored pair is a
 *  revealed preference (userOrder ≻ appOrder) captured odds-neutral; we recompute φ for BOTH
 *  orders under the CURRENT feature functions, so a feature change re-prices history, and
 *  hand the contrasts to the shared perceptron+shrink seam. The solver picks argmin w·φ, so
 *  the user's order is the should-score-lower side.
 *
 *  No drags means no pairs means the seam returns the prior, so this is a no-op until there
 *  is real evidence. The energy/buffer components are 0 until a window profile is learned,
 *  so those weights stay at prior; switch and domain are always live, so grouping
 *  preferences get taught first. */
export function calibrateArrangeWeights(
  prefs: readonly Pick<PlanReorder, "appOrder" | "userOrder">[],
  capacities: DayCapacity[],
  today: string,
  opts: ArrangeOrderOptions = {},
): ArrangeWeights {
  const prior = [ARRANGE_WEIGHTS.switch, ARRANGE_WEIGHTS.domain, ARRANGE_WEIGHTS.energy, ARRANGE_WEIGHTS.buffer];
  const pairs: PreferencePair[] = prefs.map((p) => {
    const a = arrangementFeatures(p.appOrder, capacities, today, opts);
    const u = arrangementFeatures(p.userOrder, capacities, today, opts);
    return { solver: [a.switch, a.domain, a.energy, a.buffer], user: [u.switch, u.domain, u.energy, u.buffer] };
  });
  const [sw, dm, en, bf] = fitCalibratedWeights(pairs, prior);
  return { switch: sw, domain: dm, energy: en, buffer: bf };
}

// --- The window-capacity model ---------------------------------------------
//
// To price work by time-of-day we need to know how much room each window holds. Capacity
// is hours-per-DAY, so we split each day's minutes across the five windows by a shrunk
// observed share and tag each segment with its net-of-global velocity multiplier. Both
// inputs degrade to a no-op: an unobserved share gives the default profile, an unlearned
// window gives multiplier 1, so a flat split flows byte-identically to the day-granular
// forecast. Pure and client-safe, so the client re-solve rebuilds identical segments.

/** A day's deployable minutes spread across the five windows plus each window's net
 *  velocity multiplier. Realised against ANY day series (base or skip-adjusted), so server
 *  and client build identical segments from identical capacities. */
export interface WindowProfile {
  /** Per-window fraction of a day's minutes (sums to 1); shrunk toward DEFAULT_WINDOW_SHARE. */
  share: Record<TimeWindow, number>;
  /** `exp(μ_window − μ₀)` per window: <1 faster, >1 slower, =1 unlearned (net of the global bias). */
  netMultiplier: Record<TimeWindow, number>;
}

/** A-priori split of deployable minutes across the day, used until session history earns
 *  the real one. Daytime-skewed. It only BOUNDS how much work may claim a window's
 *  multiplier, never feasibility, so a rough prior is safe. Sums to 1. */
export const DEFAULT_WINDOW_SHARE: Record<TimeWindow, number> = {
  early: 0.1,
  morning: 0.25,
  afternoon: 0.3,
  evening: 0.25,
  night: 0.1,
};

/** Pseudo-session mass anchoring `observedWindowShare` to the default profile -
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

/** Build a WindowProfile from the energy-window read and the global prior.
 *  `netMultiplier = exp(μ_w - μ₀)`, so exactly 1 for an unlearned window and the profile is
 *  flat until windows are earned. Null when no window has any session, which is the
 *  no-signal gate - the caller then stays on the day-granular forecast. `shareOverride`
 *  replaces the derived share when the user pinned an explicit availability. */
export function windowProfileFromEnergy(
  energy: EnergyWindow[],
  prior: EstimationModel,
  opts: { strength?: number; shareOverride?: Record<TimeWindow, number> | null } = {},
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
  return { share: opts.shareOverride ?? observedWindowShare(counts, opts), netMultiplier };
}

/** Split each day's minutes into the five window segments by profile.share, tagging each
 *  with its net multiplier. Largest-remainder rounding preserves the day total exactly, so a
 *  flat profile flows byte-identically to whole-day capacity. Windows stay in clock order so
 *  a task's start window is the earliest unfilled window of its day. */
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
 *  on clock order). Deterministic - the byte-identical degradation depends on the parts
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

// --- Comfort-capped load smoothing -----------------------------------------
//
// The first arrangement that changes the odds: it spreads cognitively hard work across days
// so no day piles on more than a sustainable amount. Focused work caps out around 3-4h/day,
// and smoothing relaxes a plan within its slack rather than levelling it to the deadline
// (which Parkinson's Law would just refill). Spreading work later costs odds, so it's
// odds-GATED: a capped plan is admissible only while allOnTime >= canonical - eps.
//
// The ORDER is unchanged - only the per-day hard-work cap shifts when work happens - so
// dependencies and grouping are preserved for free and the client reproduces the plan from
// one shipped scalar. Two-stage: a point-estimate scan finds the most comfortable cap that
// keeps every deadline, then the full MC gates it.

/** Target soft daily ceiling on HARD work (minutes) - what the smoother relaxes toward.
 *  ~4 h is the generous end of the sustainable focused-work window. A knob, calibrated later. */
export const COMFORT_CAP_MINUTES = 240;
/** Gate slack: a comfort-capped plan is admissible only if its `allOnTime` stays within this
 *  of the canonical (uncapped) plan's - it may spend a sliver of slack to relax the pace. */
export const ARRANGE_ODDS_EPSILON = 0.02;

export interface ComfortSmoothOptions {
  /** Estimation-bias options for the MC (sigma/meanLog; iterations optional). */
  forecast: ForecastOptions;
  /** Window profile for windowed pricing - applied to BOTH the canonical baseline AND the
   *  comfort-capped gate MC, so the gate compares apples-to-apples:
   *  a windowed-canonical vs a windowed-comfort plan. (Pre-Phase-4 the comfort gate dropped
   *  windows, making it conservative when windows were favourable; the composition lifts that.) */
  windowProfile?: WindowProfile | null;
  comfortCapMinutes?: number;
  oddsEpsilon?: number;
}

export interface ComfortSmoothResult {
  /** The applied hard-work cap (minutes) when smoothing fired, else null (canonical). The
   *  single scalar slice 2 ships to the client to reproduce the plan. */
  comfortCapMinutes: number | null;
  /** The MC odds of the RETURNED plan (comfort-capped when applied, else canonical) - the
   *  headline is always the plan you follow. */
  joint: { byProject: Map<string, number>; allOnTime: number };
  /** Whether comfort smoothing was applied (false ⇒ canonical / no affordable relaxation). */
  changed: boolean;
}

/** Each deadlined project's point-estimate lateness (`max(0, finishOffset − deadline)`) for
 *  the given finish offsets - the cheap, monotone feasibility proxy the cap scan screens on. */
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

/** Spread hard work across days up to the comfort cap, but only when slack allows. Applies
 *  the cap iff the capped plan keeps every deadline (point-estimate screen) AND holds
 *  allOnTime >= canonical - eps (MC gate); otherwise canonical stands. The order never
 *  changes. A graduated scan over intermediate caps would be a refinement, but in practice
 *  the gate is near all-or-nothing, so one target keeps it honest and simple. */
export function comfortSmooth(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
  opts: ComfortSmoothOptions,
): ComfortSmoothResult {
  const target = opts.comfortCapMinutes ?? COMFORT_CAP_MINUTES;
  const epsilon = opts.oddsEpsilon ?? ARRANGE_ODDS_EPSILON;

  // Canonical (uncapped) baseline - windowed when a profile is present, so a no-smooth
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

  // The canonical point-estimate lateness per project - the cap must not worsen it (spread
  // later, never past a met deadline nor a late project further).
  const canonicalOver = perProjectOverBy(
    flowFinishOffsets(durations, capacities),
    order,
    deadlineOffset,
  );

  // Stage 1 - deterministic point-estimate screen: does the comfort cap still hit every
  // deadline it currently hits (spread later, never past a met deadline nor a late one)?
  const proxyOver = perProjectOverBy(
    flowFinishOffsetsComfort(durations, capacities, hardPoint, target),
    order,
    deadlineOffset,
  );
  for (const [pid, over] of proxyOver) {
    if (over > (canonicalOver.get(pid) ?? 0)) return noChange;
  }
  // Stage 2 - the full MC gate: spread only as far as the odds can afford. The comfort cap
  // and the window pricing COMPOSE: the gate prices the comfort-capped plan with
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

// --- The odds-gated within-day reorder -------------------------------------
//
// arrangeOrder is the chooser, gatedReorder is its gate. It re-prices the arranged order
// with the same Monte Carlo the headline uses and decides ONE boolean - should the forecast
// flow the arranged order? - that the optimizer and the client replay. Adopted only while
// allOnTime >= canonical - eps. Because reordering reseeds the MC, an odds-neutral reorder
// isn't byte-identical, so with no odds-relevant signal the grouping is display-only and the
// forecast stays on the canonical order.

export interface GatedReorderOptions {
  /** Estimation-bias options for the MC gate (sigma/meanLog; iterations optional). */
  forecast: ForecastOptions;
  windowProfile?: WindowProfile | null;
  comfortCapMinutes?: number | null;
  /** projectId → thin-buffer urgency `(0,1]` decided on the base plan - the S3a `w_buffer`
   *  lever (graded, S3b Phase 4), biasing those projects' work into fast windows in
   *  proportion to how thin. Absent ⇒ no buffer bias. */
  thinBufferUrgency?: ReadonlyMap<string, number> | null;
  oddsEpsilon?: number;
  /** `J` term weights (default ARRANGE_WEIGHTS). */
  weights?: ArrangeWeights;
}

export interface GatedReorderResult {
  /** Whether the FORECAST should flow the arranged order - the single boolean the
   *  strategy base + the S1 client replay. True only when the reorder is odds-relevant
   *  (windows learned OR comfort active) AND the gate passed. */
  changed: boolean;
  /** The order to DISPLAY (arranged when grouping is admissible, else canonical). */
  order: EffectiveOrderEntry[];
  /** The odds to show - the arranged order's when flowed, else the canonical baseline. */
  joint: { byProject: Map<string, number>; allOnTime: number };
}

/** Decide whether to adopt the within-day reorder. Returns the boolean the client replays,
 *  the order to display, and the odds to show. See the section comment above. */
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
    thinBufferUrgency: opts.thinBufferUrgency,
    weights: opts.weights,
  });
  // Nothing moved ⇒ canonical everywhere (arrangeOrder returns the same reference).
  if (arranged === order) return { changed: false, order, joint: canonicalJoint };

  // No odds-relevant signal ⇒ the grouping is free: DISPLAY it, but keep the forecast on
  // the canonical order (byte-identical odds). `changed=false` ⇒ the client never flows it.
  if (cap == null && profile == null) {
    return { changed: false, order: arranged, joint: canonicalJoint };
  }

   // Odds-relevant ⇒ gate: re-price the arranged order the same way the headline does -
  // the comfort cap and window pricing COMPOSE, both applied when both are in
  // force - and adopt it only while `allOnTime ≥ canonical − ε`.
  const opts2: ForecastOptions = { ...opts.forecast };
  if (cap != null) opts2.comfortCapMinutes = cap;
  if (profile) opts2.windowCapacities = windowCapacities(capacities, profile);
  const arrangedJoint = globalForecastJoint(arranged, capacities, deadlineByProject, today, opts2);
  const epsilon = opts.oddsEpsilon ?? ARRANGE_ODDS_EPSILON;
  if (arrangedJoint.allOnTime >= canonicalJoint.allOnTime - epsilon) {
    return { changed: true, order: arranged, joint: arrangedJoint };
  }
  // Gate failed: don't show (or price) a grouping that costs odds - canonical stands.
  return { changed: false, order, joint: canonicalJoint };
}
