import type {
  DayCapacity,
  DependencyEdge,
  ScheduleDay,
  ScheduledBlock,
  WindowCapacity,
} from "./schedule";
import type { EstimationModel } from "./types";
import { ALL_WINDOWS, type EnergyWindow, type TimeWindow } from "./velocity";

// Local arrangement optimizer (OVERHAUL §5a substrate S3b) — the *arrangement*
// half of the forecast-as-risk-core / solver-as-arrangement split. The Monte-Carlo
// forecast stays the sole owner of feasibility & odds (§0); this module only makes
// the plan you actually *follow* good on the soft objectives the forecast doesn't
// price — context-switching, energy-window placement, daily load. Everything here
// is a pure, deterministic, dispose-side transform over the already-built plan: no
// LLM, no new probability authored anywhere.
//
// PHASE 1 (this commit) ships the substrate + the first, always-safe objective:
// context-switch grouping *within* each near-horizon day. It is **odds-neutral by
// construction** — reordering blocks within a fixed day never moves a task to a
// different day, so the day-granular forecast (`flowFinishOffsets` returns day
// offsets) sees an identical carry ⇒ identical `byProject` + `allOnTime`. No gate
// is needed at this phase; the regression harness asserts the neutrality.
//
// Phase 2 (energy-window placement) and Phase 3 (cross-day load smoothing) are
// odds-*coupled* and arrive with the windowed forecast + the odds gate
// (`allOnTime ≥ canonical − ε`). See `design/s3b-arrangement-optimizer.md`.

/** Per-objective weights for the soft score `J` (lower is better). All knobs. */
export interface ArrangeWeights {
  /** Penalty per project change across a day's within-day sequence. */
  switch: number;
}

/** Phase 1 default weights — `1.0` as a knob, calibrated later by S2's loop. */
export const ARRANGE_WEIGHTS: ArrangeWeights = { switch: 1 };

/** How far out we re-arrange: the committed near-horizon. Beyond it the plan is
 *  re-derived as time advances, so re-sequencing it now is wasted (and out of
 *  scope — §4 "committed horizon"). Out-of-horizon days are returned untouched. */
export const ARRANGE_HORIZON_DAYS = 14;

export interface ArrangeOptions {
  /** Moves confined to this many days from `today` (default ARRANGE_HORIZON_DAYS). */
  horizonDays?: number;
  /** `J` term weights (default ARRANGE_WEIGHTS). */
  weights?: ArrangeWeights;
}

export interface ArrangeResult {
  /** The plan with each near-horizon day's blocks re-sequenced (others untouched). */
  days: ScheduleDay[];
}

// --- Date helper (UTC-stable, mirroring schedule.ts/forecast.ts) ------------

function dayOffset(today: string, iso: string): number {
  const [ay, am, ad] = today.slice(0, 10).split("-").map(Number);
  const [by, bm, bd] = iso.slice(0, 10).split("-").map(Number);
  const a = Date.UTC(ay, am - 1, ad);
  const b = Date.UTC(by, bm - 1, bd);
  return Math.round((b - a) / 86_400_000);
}

// --- Context-switch grouping ------------------------------------------------

/** A block is real work iff it owns a task; the review buffer (`task_id===null`)
 *  is a per-day fixture that always pins last and is not part of the objective. */
function isWork(block: ScheduledBlock): boolean {
  return block.task_id !== null;
}

/** Number of project changes across a sequence of work blocks (the switch cost).
 *  Blocks without a project never count as a boundary. */
export function countSwitches(blocks: ScheduledBlock[]): number {
  let switches = 0;
  let prev: string | null | undefined;
  for (const b of blocks) {
    if (!isWork(b)) continue;
    const pid = b.projectId ?? null;
    if (prev !== undefined && pid !== prev) switches++;
    prev = pid;
  }
  return switches;
}

/**
 * Re-sequence one day's work blocks to minimise project context-switches while
 * staying dependency-valid. A greedy, deterministic constrained clustering:
 * among the blocks whose same-day prerequisites are already emitted ("ready"),
 * prefer to continue the current project's cluster; otherwise open the next
 * cluster with the lowest-canonical-rank ready block. Because we only ever emit
 * ready blocks, every same-day dependency is honoured; because ties break on the
 * original (canonical) index, the result is reproducible.
 *
 * Same-day clustering is the whole win: a day that ping-ponged A→B→A→B becomes
 * A→A→B→B. The buffer block (if any) is appended last, unchanged.
 */
export function clusterDay(blocks: ScheduledBlock[], deps: DependencyEdge[]): ScheduledBlock[] {
  const work = blocks.filter(isWork);
  const buffer = blocks.filter((b) => !isWork(b));
  if (work.length <= 1) return blocks; // nothing to group

  const inDay = new Set(work.map((b) => b.task_id as string));
  // Same-day prerequisites only — cross-day prereqs are already honoured by the
  // greedy flow that placed the days, and are outside this within-day permute.
  const prereqs = new Map<string, Set<string>>();
  for (const edge of deps) {
    if (!inDay.has(edge.task_id) || !inDay.has(edge.depends_on_task_id)) continue;
    if (!prereqs.has(edge.task_id)) prereqs.set(edge.task_id, new Set());
    prereqs.get(edge.task_id)!.add(edge.depends_on_task_id);
  }

  const rank = new Map<string, number>(); // canonical index, the deterministic tiebreak
  work.forEach((b, i) => rank.set(b.task_id as string, i));

  const emitted = new Set<string>();
  const out: ScheduledBlock[] = [];
  let current: string | null | undefined; // current cluster's projectId

  const isReady = (b: ScheduledBlock): boolean => {
    const reqs = prereqs.get(b.task_id as string);
    if (!reqs) return true;
    for (const r of reqs) if (!emitted.has(r)) return false;
    return true;
  };

  while (out.length < work.length) {
    const ready = work.filter((b) => !emitted.has(b.task_id as string) && isReady(b));
    // Prefer continuing the current project; else open the lowest-rank cluster.
    const sameProject = ready.filter((b) => (b.projectId ?? null) === current);
    const pool = sameProject.length > 0 ? sameProject : ready;
    pool.sort((a, c) => rank.get(a.task_id as string)! - rank.get(c.task_id as string)!);
    const next = pool[0];
    out.push(next);
    emitted.add(next.task_id as string);
    current = next.projectId ?? null;
  }

  return [...out, ...buffer];
}

/**
 * Arrange the global plan: re-sequence each near-horizon day to reduce context
 * switches. Pure and odds-neutral — only the order of blocks *within* a day
 * changes, so every task keeps its day and the forecast is unmoved.
 */
export function arrange(
  days: ScheduleDay[],
  deps: DependencyEdge[],
  today: string,
  opts: ArrangeOptions = {},
): ArrangeResult {
  const horizon = opts.horizonDays ?? ARRANGE_HORIZON_DAYS;
  const arranged = days.map((day) => {
    if (dayOffset(today, day.date) >= horizon) return day; // untouched beyond the horizon
    const blocks = clusterDay(day.blocks, deps);
    if (blocks === day.blocks) return day; // ≤1 work block — no change
    return { ...day, blocks };
  });
  return { days: arranged };
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
