import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  ForecastResult,
  RecoveryMove,
} from "./types";
import { flowFinishOffsets, type DayCapacity } from "./schedule";

// The forecast engine — TaskBuddy's "will I make it, and how sure?" number.
//
// Two independent halves, both pure and deterministic:
//   1. deployableMinutes(): how much time you actually have before a deadline,
//      from the weekly availability template, per-day overrides, and the
//      commitments that consume it.
//   2. forecast(): a Monte Carlo over how long the remaining tasks really take
//      (estimates are uncertain), giving the probability that the work fits in
//      the deployable time.
//
// The Monte Carlo is seeded from its inputs, so identical inputs always yield
// the same probability — the number is stable across renders, not jittery.

const MINUTES_PER_HOUR = 60;
const DEFAULT_ITERATIONS = 5000;
// Estimate uncertainty (log-normal sigma) used when we don't yet have enough of
// a user's own history to fit one (see `estimationModel`). A moderate spread.
export const DEFAULT_SIGMA = 0.35;

// --- Date helpers -----------------------------------------------------------

/** Parse an ISO `YYYY-MM-DD` date as UTC midnight (timezone-stable). */
function parseISODate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- 1. Deployable time -----------------------------------------------------

export interface DeployableInput {
  /** Today as an ISO `YYYY-MM-DD` date (caller supplies it for testability). */
  today: string;
  /** The deadline as an ISO date, or null when the project has none. */
  deadline: string | null;
  /** Weekly template: baseline hours per weekday (0=Sun .. 6=Sat). */
  availability: Availability[];
  /** Per-day overrides of the template. */
  overrides: AvailabilityOverride[];
  /** Events that consume hours on a date. */
  commitments: Pick<Commitment, "date" | "hours">[];
}

/**
 * Total deployable minutes from today through the deadline (both inclusive).
 *
 * For each day: deployable = max(0, (override ?? template) − commitments).
 * Returns 0 when there is no deadline or the deadline is already past.
 */
export function deployableMinutes(input: DeployableInput): number {
  if (!input.deadline) return 0;

  const start = parseISODate(input.today);
  const end = parseISODate(input.deadline);
  if (end < start) return 0;

  const template = new Map<number, number>();
  for (const a of input.availability) template.set(a.weekday, a.hours);

  const overrideByDate = new Map<string, number>();
  for (const o of input.overrides) overrideByDate.set(o.date.slice(0, 10), o.hours);

  const consumedByDate = new Map<string, number>();
  for (const c of input.commitments) {
    const key = c.date.slice(0, 10);
    consumedByDate.set(key, (consumedByDate.get(key) ?? 0) + c.hours);
  }

  let totalHours = 0;
  const cursor = new Date(start);
  while (cursor <= end) {
    const iso = toISODate(cursor);
    const base = overrideByDate.get(iso) ?? template.get(cursor.getUTCDay()) ?? 0;
    const consumed = consumedByDate.get(iso) ?? 0;
    totalHours += Math.max(0, base - consumed);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.round(totalHours * MINUTES_PER_HOUR);
}

// --- Seeded RNG (mulberry32) + standard normal ------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller standard normal from a uniform [0,1) generator. */
function nextNormal(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Stable integer seed from the forecast inputs. */
function seedFrom(estimates: number[], deployable: number): number {
  let h = 2166136261 ^ deployable;
  for (const e of estimates) {
    h = Math.imul(h ^ Math.round(e), 16777619);
  }
  return h >>> 0;
}

// --- 2. Monte Carlo forecast ------------------------------------------------

export interface ForecastOptions {
  iterations?: number;
  sigma?: number;
  /**
   * Mean of `log(factor)` — the learned estimation bias. Omitted ⇒ `-sigma²/2`,
   * which makes `E[factor] = 1` (estimates unbiased on average). A positive
   * value shifts the whole distribution up: the user typically runs over.
   */
  meanLog?: number;
}

/**
 * Probability that the remaining work fits in the deployable time.
 *
 * Each task's true duration is modelled as `estimate × factor`, where
 * `log(factor)` is normal with mean `meanLog` and std dev `sigma`. By default
 * `meanLog = -sigma²/2`, so `E[factor] = 1` (estimates unbiased on average,
 * spread either way). Passing a fitted `meanLog` tilts it toward the user's
 * real history. We sample the whole set many times and count how often the
 * total lands within budget.
 */
export function forecast(
  estimates: number[],
  deployable: number,
  options: ForecastOptions = {},
): ForecastResult {
  const open = estimates.filter((e) => e > 0);
  const expectedMinutes = open.reduce((s, e) => s + e, 0);
  const base: Omit<ForecastResult, "probability"> = {
    expectedMinutes,
    deployableMinutes: deployable,
    slackMinutes: deployable - expectedMinutes,
    openTaskCount: open.length,
  };

  // Nothing left to do — you've already "finished".
  if (open.length === 0) return { ...base, probability: 1 };
  // Work remains but no time to deploy — you won't make it.
  if (deployable <= 0) return { ...base, probability: 0 };

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const sigma = options.sigma ?? DEFAULT_SIGMA;
  // Default mean keeps E[factor] = 1 (unbiased); a fitted meanLog overrides it.
  const meanLog = options.meanLog ?? -(sigma * sigma) / 2;
  const rng = mulberry32(seedFrom(open, deployable));

  let made = 0;
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const est of open) {
      total += est * Math.exp(meanLog + sigma * nextNormal(rng));
    }
    if (total <= deployable) made++;
  }

  return { ...base, probability: made / iterations };
}

// --- Global (contention-aware) forecast -------------------------------------

/** Whole days from ISO date `a` to ISO date `b` (UTC, b − a). */
function daysBetweenISO(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

/** One task's place in the global order, as the simulation needs to see it. */
export interface GlobalForecastTask {
  taskId: string;
  estimatedMinutes: number;
  projectId: string;
}

/**
 * Contention-aware completion odds for every deadlined project, from ONE seeded
 * joint Monte Carlo over the global order. This is `forecast()` generalised to
 * the whole timeline: instead of asking per project "does my work fit in my
 * budget?", each iteration samples every open task's true duration, walks the
 * single global order across the real day-by-day capacities (so projects compete
 * for the same hours), and records for each project whether its last task lands
 * on or before its deadline. One run answers all projects from the *same* sampled
 * future, so the odds are mutually coherent and capture the cascade where a
 * shared early overrun pushes every downstream project later.
 *
 * Same seeded RNG + log-normal estimation model as `forecast()` — the Monte
 * Carlo still owns the odds; contention only changes which work competes and how
 * much time is left before each deadline. With a single project (no competing
 * work) the flow check reduces to `forecast()`'s sum-vs-deployable, so the number
 * matches it up to sampling noise; the honest drop appears only when projects
 * actually share hours.
 *
 * Returns `projectId → probability` for every project in `deadlineByProject` that
 * has a deadline. A deadlined project with no open work scores 1.
 */
export function globalForecast(
  order: GlobalForecastTask[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
  options: ForecastOptions = {},
): Map<string, number> {
  const result = new Map<string, number>();

  // Day offset each project's deadline allows work through; null deadlines skip.
  const deadlineOffset = new Map<string, number>();
  for (const [pid, dl] of deadlineByProject) {
    if (dl) deadlineOffset.set(pid, daysBetweenISO(today, dl));
  }

  // Task indices grouped by project (only projects we score).
  const indicesByProject = new Map<string, number[]>();
  for (let k = 0; k < order.length; k++) {
    const pid = order[k].projectId;
    if (!deadlineOffset.has(pid)) continue;
    const list = indicesByProject.get(pid) ?? [];
    list.push(k);
    indicesByProject.set(pid, list);
  }

  // Deadlined projects with no open work have already "finished".
  for (const pid of deadlineOffset.keys()) {
    if (!indicesByProject.has(pid)) result.set(pid, 1);
  }
  if (indicesByProject.size === 0) return result;

  const estimates = order.map((t) => Math.max(0, t.estimatedMinutes));
  const deployableSum = capacities.reduce((s, c) => s + c.capacityMinutes, 0);

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const sigma = options.sigma ?? DEFAULT_SIGMA;
  const meanLog = options.meanLog ?? -(sigma * sigma) / 2;
  const rng = mulberry32(seedFrom(estimates, deployableSum));

  const durations = new Array<number>(order.length).fill(0);
  const hits = new Map<string, number>();
  for (const pid of indicesByProject.keys()) hits.set(pid, 0);

  for (let i = 0; i < iterations; i++) {
    for (let k = 0; k < order.length; k++) {
      const est = estimates[k];
      // Sample only real work; keep the RNG stream identical to `forecast()`.
      durations[k] = est > 0 ? est * Math.exp(meanLog + sigma * nextNormal(rng)) : 0;
    }
    const offsets = flowFinishOffsets(durations, capacities);
    for (const [pid, idxs] of indicesByProject) {
      let last = 0;
      for (const k of idxs) if (offsets[k] > last) last = offsets[k];
      if (last <= deadlineOffset.get(pid)!) hits.set(pid, hits.get(pid)! + 1);
    }
  }

  for (const [pid, h] of hits) result.set(pid, h / iterations);
  return result;
}

// --- Recovery moves (pit-call recommendations) ------------------------------

export interface CandidateTask {
  id: string;
  title: string;
  estimated_minutes: number;
  priority_score: number | null;
}

/**
 * Recommend which task to defer past the deadline to recover probability.
 *
 * Tries deferring lowest-priority tasks first (cheapest to the plan), recomputes
 * the probability without each, and returns the moves that actually help —
 * best improvement first.
 */
export function recoveryMoves(
  tasks: CandidateTask[],
  deployable: number,
  options: ForecastOptions = {},
  limit = 3,
): RecoveryMove[] {
  const open = tasks.filter((t) => t.estimated_minutes > 0);
  if (open.length === 0) return [];

  const current = forecast(
    open.map((t) => t.estimated_minutes),
    deployable,
    options,
  ).probability;

  // Defer the least important work first.
  const candidates = [...open].sort(
    (a, b) => (a.priority_score ?? 0) - (b.priority_score ?? 0),
  );

  const moves: RecoveryMove[] = [];
  for (const task of candidates) {
    const remaining = open
      .filter((t) => t.id !== task.id)
      .map((t) => t.estimated_minutes);
    const after = forecast(remaining, deployable, options).probability;
    if (after > current + 0.01) {
      moves.push({
        taskId: task.id,
        title: task.title,
        probabilityAfter: after,
      });
    }
  }

  return moves
    .sort((a, b) => b.probabilityAfter - a.probabilityAfter)
    .slice(0, limit);
}

// --- Re-dating (the answer for a blown / at-risk deadline) ------------------

/**
 * The earliest deadline at which the remaining work clears `target` probability.
 *
 * Returns the honest "you can't make May 29, but May 31 → 80%" answer, or null
 * if no date within `maxDays` reaches the target (not enough hours to deploy).
 *
 * Probability is non-decreasing in the deadline — a later date can only add
 * deployable time, never remove it — so we binary-search the earliest day that
 * clears the target rather than scanning all `maxDays` (≈8 forecasts, not 180).
 */
export function earliestAchievableDeadline(
  estimates: number[],
  budget: Omit<DeployableInput, "deadline">,
  target = 0.8,
  options: ForecastOptions = {},
  maxDays = 180,
): { deadline: string; probability: number } | null {
  const open = estimates.filter((e) => e > 0);
  // No work left — today already clears any target.
  if (open.length === 0) return { deadline: budget.today, probability: 1 };

  const start = parseISODate(budget.today);
  const probAt = (day: number): { iso: string; probability: number } => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + day);
    const iso = toISODate(d);
    const deployable = deployableMinutes({ ...budget, deadline: iso });
    return { iso, probability: forecast(open, deployable, options).probability };
  };

  // Even the furthest allowed date can't clear the bar — out of reach.
  if (probAt(maxDays).probability < target) return null;

  let lo = 0;
  let hi = maxDays;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (probAt(mid).probability >= target) hi = mid;
    else lo = mid + 1;
  }
  const { iso, probability } = probAt(lo);
  return { deadline: iso, probability };
}
