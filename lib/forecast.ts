import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  ForecastResult,
  RecoveryMove,
} from "./types";

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
// Estimate uncertainty (log-normal sigma). Until we learn a user's personal
// estimation bias from history (Phase 2), assume everyone runs moderately over.
const DEFAULT_SIGMA = 0.35;

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
}

/**
 * Probability that the remaining work fits in the deployable time.
 *
 * Each task's true duration is modelled as `estimate × factor`, where `factor`
 * is log-normal with mean 1 (so estimates are unbiased on average but spread
 * either way). We sample the whole set many times and count how often the
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
  const drift = (sigma * sigma) / 2; // keeps E[factor] = 1
  const rng = mulberry32(seedFrom(open, deployable));

  let made = 0;
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const est of open) {
      total += est * Math.exp(sigma * nextNormal(rng) - drift);
    }
    if (total <= deployable) made++;
  }

  return { ...base, probability: made / iterations };
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
