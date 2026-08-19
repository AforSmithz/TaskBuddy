import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  ForecastResult,
  RecoveryMove,
  SegmentModel,
  SkillNode,
  SkillPathRescheduleMove,
  SkillRecoveryMove,
} from "@/lib/types";
import {
  flowFinishOffsets,
  flowFinishOffsetsComfort,
  flowFinishOffsetsComfortLanes,
  flowFinishOffsetsLanes,
  type DayCapacity,
  type FlowLane,
  type WindowCapacity,
} from "@/lib/schedule";

// The forecast() engine - the "will I make it, and how sure?" number. Two pure halves:
// deployableMinutes() works out how much time you actually have before a deadline, and
// forecast() runs a Monte Carlo over how long the remaining tasks really take. The MC is
// seeded from its inputs, so identical inputs always give the same probability - the number
// is stable across renders, not jittery.

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
  overrides: AvailabilityOverride[];
  /** Events that consume hours on a date. */
  commitments: Pick<Commitment, "date" | "hours">[];
}

/** Total deployable minutes from today through the deadline, inclusive. Per day that's
 *  max(0, (override ?? template) - commitments). 0 with no deadline or a past one. */
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

/** Box - Muller standard normal from a uniform [0,1) generator. */
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

// --- 2. Monte Carlo forecast() ------------------------------------------------

export interface ForecastOptions {
  iterations?: number;
  sigma?: number;
  /** Mean of log(factor) - the learned bias. Omitted gives -sigma²/2, which makes E[factor]
   *  = 1 (unbiased on average). Positive means the user typically runs over. */
  meanLog?: number;
  /** Per-window capacity segments for the joint flow. When present the durations flow across
   *  these instead of whole days, charging each fraction of a task at the net multiplier of the
   *  window it occupies - so work in a learned-fast window genuinely shrinks and a task that
   *  spills into a slower one is priced part fast, part slow. The deadline check stays
   *  day-granular. A flat or unlearned split is byte-identical to the day-granular forecast(). */
  windowCapacities?: WindowCapacity[];
  /** Comfort-capped load smoothing. When set, each day's HARD minutes (difficulty × sampled
   *  duration) are metered against this soft ceiling so deep work spreads across days,
   *  finishing later - the honestly-priced cost of a humaner pace. The deadline check stays
   *  day-granular, so the result stays comparable to the uncapped forecast(). */
  comfortCapMinutes?: number;
}

/** Probability that the remaining work fits in the deployable time. Each task's true duration
 *  is `estimate × factor`, where log(factor) is normal with mean `meanLog` and sd `sigma`. By
 *  default meanLog = -sigma²/2 so estimates are unbiased on average; a fitted meanLog tilts it
 *  toward the user's real history. Sample the whole set many times, count how often the total
 *  lands within budget. */
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
    p10Minutes: 0,
    p50Minutes: 0,
    p90Minutes: 0,
  };

  // Nothing left to do - you've already "finished".
  if (open.length === 0) return { ...base, probability: 1 };

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const sigma = options.sigma ?? DEFAULT_SIGMA;
  // Default mean keeps E[factor] = 1 (unbiased); a fitted meanLog overrides it.
  const meanLog = options.meanLog ?? -(sigma * sigma) / 2;
  const rng = mulberry32(seedFrom(open, deployable));

  // The pass-rate is the probability, and the spread of sampled totals is an honest effort
  // interval around the point estimate. Computed even when over budget - it's a property of
  // the work, not the deadline.
  const totals = new Array<number>(iterations);
  let made = 0;
  for (let i = 0; i < iterations; i++) {
    let total = 0;
    for (const est of open) {
      total += est * Math.exp(meanLog + sigma * nextNormal(rng));
    }
    totals[i] = total;
    if (total <= deployable) made++;
  }
  totals.sort((a, b) => a - b);
  const withInterval = {
    ...base,
    p10Minutes: Math.round(percentile(totals, 0.1)),
    p50Minutes: Math.round(percentile(totals, 0.5)),
    p90Minutes: Math.round(percentile(totals, 0.9)),
  };

  // Work remains but no time to deploy - you won't make it.
  if (deployable <= 0) return { ...withInterval, probability: 0 };
  return { ...withInterval, probability: made / iterations };
}

/** Linear-interpolated percentile `p` (0 - 1) of an ascending-sorted array. */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// --- Global (contention-aware) forecast() -------------------------------------

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
  /** This task's own segment-shrunk (meanLog, sigma). When present the sampler biases THIS
   *  task by its own domain velocity instead of the global scalar. Riding the bias on the task
   *  rather than on the forecast() options is what lets domains differentiate within one run. */
  model?: SegmentModel;
  /** Cognitive load in [0,1]. With comfortCapMinutes set, the joint flow meters each day's
   *  hard minutes against the cap. Absent means unmetered. */
  difficulty?: number;
}

/** Contention-aware odds for every deadlined project, from ONE seeded joint Monte Carlo over
 *  the global order. forecast() generalised to the whole timeline: instead of asking per
 *  project "does my work fit my budget?", each iteration samples every open task's duration,
 *  walks the single global order across the real day-by-day capacities so projects compete for
 *  the same hours, and records whether each project's last task lands by its deadline. One run
 *  answers everything from the SAME sampled future, so the odds are mutually coherent and
 *  capture the cascade where one shared early overrun pushes everything downstream later.
 *
 *  With a single project the flow check reduces to forecast()'s sum-vs-deployable, so the
 *  numbers match up to sampling noise; the honest drop only appears when projects share hours.
 *  A deadlined project with no open work scores 1. */
export function globalForecast(
  order: GlobalForecastTask[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
  options: ForecastOptions = {},
): Map<string, number> {
  return globalForecastJoint(order, capacities, deadlineByProject, today, options)
    .byProject;
}

/** The full joint read: per-project odds plus `allOnTime`, the fraction of the SAME sampled
 *  futures in which EVERY deadlined project lands on time. That's the honest portfolio
 *  conjunction, not the product of independent per-project odds - the projects share one
 *  sampled future, so their finishes are correlated through contention. A deadlined project
 *  with no open work counts as on time; with no deadlined work at all, allOnTime is 1. */
export function globalForecastJoint(
  order: GlobalForecastTask[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
  options: ForecastOptions = {},
): { byProject: Map<string, number>; allOnTime: number } {
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
  // No deadlined project has open work ⇒ everything trivially lands on time.
  if (indicesByProject.size === 0) return { byProject: result, allOnTime: 1 };

  const estimates = order.map((t) => Math.max(0, t.estimatedMinutes));
  const deployableSum = capacities.reduce((s, c) => s + c.capacityMinutes, 0);

  const iterations = options.iterations ?? DEFAULT_ITERATIONS;
  const sigma = options.sigma ?? DEFAULT_SIGMA;
  const meanLog = options.meanLog ?? -(sigma * sigma) / 2;
  const rng = mulberry32(seedFrom(estimates, deployableSum));

  // When window segments are supplied, flow across them (each task scaled by the multiplier of
  // the window it starts in) instead of whole days. Built ONCE - the lanes are static across
  // iterations, only the sampled durations change. A flat split returns the same finish DAY,
  // so this is byte-identical until window velocity is earned.
  const windowLanes: FlowLane[] | null = options.windowCapacities
    ? options.windowCapacities.map((w) => ({
        capacityMinutes: w.capacityMinutes,
        netMultiplier: w.netMultiplier,
        dayOffset: daysBetweenISO(today, w.iso),
      }))
    : null;

    // Comfort-capped smoothing: meter each day's hard minutes against a soft ceiling so deep
    // work spreads across days. Difficulty weights are static; the hard vector is refilled per
    // iteration from the sampled durations. With window lanes also present the two compose
    // work flows across windows priced by velocity while hard work still spreads across days.
  const comfortCap = options.comfortCapMinutes;
  const difficulties = comfortCap != null ? order.map((t) => t.difficulty ?? 0) : null;
  const hard = comfortCap != null ? new Array<number>(order.length).fill(0) : null;

  const durations = new Array<number>(order.length).fill(0);
  const hits = new Map<string, number>();
  for (const pid of indicesByProject.keys()) hits.set(pid, 0);
  let allOnTimeHits = 0;

  for (let i = 0; i < iterations; i++) {
    for (let k = 0; k < order.length; k++) {
      const est = estimates[k];
      // Each task biased by its OWN velocity model when it carries one (OVERHAUL
      // S2), else the global scalar. The per-task bias is applied in-loop, not in
           // the seed, so determinism + the RNG stream stay identical to `forecast()`.
      const m = order[k].model;
      durations[k] =
        est > 0
          ? est *
            Math.exp((m?.meanLog ?? meanLog) + (m?.sigma ?? sigma) * nextNormal(rng))
          : 0;
    }
    let offsets: number[];
    if (comfortCap != null) {
      for (let k = 0; k < order.length; k++) hard![k] = difficulties![k] * durations[k];
      offsets = windowLanes
        ? flowFinishOffsetsComfortLanes(durations, windowLanes, hard!, comfortCap)
        : flowFinishOffsetsComfort(durations, capacities, hard!, comfortCap);
    } else if (windowLanes) {
      offsets = flowFinishOffsetsLanes(durations, windowLanes);
    } else {
      offsets = flowFinishOffsets(durations, capacities);
    }
    // Whether EVERY scored project landed on time in THIS sampled future - the
    // joint conjunction counter (decision: P(all deadlined projects meet date)).
    let allHit = true;
    for (const [pid, idxs] of indicesByProject) {
      let last = 0;
      for (const k of idxs) if (offsets[k] > last) last = offsets[k];
      if (last <= deadlineOffset.get(pid)!) hits.set(pid, hits.get(pid)! + 1);
      else allHit = false;
    }
    if (allHit) allOnTimeHits++;
  }

  for (const [pid, h] of hits) result.set(pid, h / iterations);
  return { byProject: result, allOnTime: allOnTimeHits / iterations };
}

// --- Recovery moves (pit-call recommendations) ------------------------------

export interface CandidateTask {
  id: string;
  title: string;
  estimated_minutes: number;
  priority_score: number | null;
}

/** Which task to defer past the deadline to recover probability. Tries lowest-priority tasks
 *  first (cheapest to the plan), recomputes without each, returns the ones that actually help,
 *  best improvement first. */
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

/** The non-checkpoint leaf skill nodes that can be parked without abandoning the goal - the
 *  sheddability rule shared by the per-goal defer_skill move and the pit wall's cross-project
 *  skill triage, so both agree on what's safe. A node qualifies only if the goal has more than
 *  one open node (a single remaining node IS the goal, so parking it is abandonment), it isn't
 *  a checkpoint (that's the goal's demonstrable bar), and nothing still-open depends on it
 *  (parking a prerequisite would strand its dependents).
 *
 *  Deferred/attained nodes are already out of the plan. Returned unsorted - each caller
 *  imposes its own shed order. */
export function sheddableSkillNodes(nodes: SkillNode[]): SkillNode[] {
  const open = nodes.filter((n) => !n.attained && !n.deferred);
  if (open.length <= 1) return [];
  const hasOpenDependent = (id: string) =>
    open.some((n) => n.prerequisites.includes(id));
  return open.filter((n) => !n.is_checkpoint && !hasOpenDependent(n.id));
}

/** Per-skill recovery for a learning goal: which non-checkpoint nodes, parked out of the
 *  current push, recover probability. The learning-goal analogue of recoveryMoves.
 *
 *  The forecast() reasons over both real tasks and unattained skill effort, so a node is measured
 *  by removing its estimate from that combined pool. Only sheddableSkillNodes are offered.
 *  Best improvement first; each kept move actually lifts the odds. */
export function skillRecoveryMoves(
  nodes: SkillNode[],
  realEstimates: number[],
  deployable: number,
  options: ForecastOptions = {},
  limit = 3,
): SkillRecoveryMove[] {
  const open = nodes.filter((n) => !n.attained && !n.deferred);
  // Never offer to park a goal down to nothing - a single remaining node is the
  // whole goal, and shedding it is abandonment, not recovery.
  if (open.length <= 1) return [];

  const baseSkill = open.map((n) => n.estimated_minutes);
  const current = forecast(
    [...realEstimates, ...baseSkill],
    deployable,
    options,
  ).probability;

  // Cheapest-to-give-up first (skills carry no priority_score, so ascending effort
  // is the tie order); then keep only the ones that actually help.
  const candidates = sheddableSkillNodes(nodes).sort(
    (a, b) => a.estimated_minutes - b.estimated_minutes,
  );

  const moves: SkillRecoveryMove[] = [];
  for (const node of candidates) {
    const remaining = open
      .filter((n) => n.id !== node.id)
      .map((n) => n.estimated_minutes);
    const after = forecast(
      [...realEstimates, ...remaining],
      deployable,
      options,
    ).probability;
    if (after > current + 0.01) {
      moves.push({ nodeId: node.id, title: node.title, probabilityAfter: after });
    }
  }

  return moves
    .sort((a, b) => b.probabilityAfter - a.probabilityAfter)
    .slice(0, limit);
}

/** For each descopable frontier milestone, the strand-free set of open nodes that become dead
 *  weight if it slides out of the current push - the unit a reschedule_skill move parks. The
 *  set-level generalization of sheddableSkillNodes: that offers a single leaf, this offers a
 *  whole checkpoint chain.
 *
 *  A checkpoint C is a candidate iff no OTHER open checkpoint transitively depends on it, so
 *  nothing kept needs it. Descoping C parks the connected component of C in the graph of open
 *  nodes with every prerequisite of a kept checkpoint removed - exactly C plus the prep that
 *  leads only to C. That's provably strand-free: a kept node's prereqs are all "needed by a
 *  kept checkpoint" and therefore excluded from every component but their own. */
export function descopableMilestoneParkSets(
  nodes: SkillNode[],
): { checkpoint: SkillNode; nodes: SkillNode[] }[] {
  const open = nodes.filter((n) => !n.attained && !n.deferred);
  if (open.length <= 1) return [];
  const byId = new Map(open.map((n) => [n.id, n]));

  // Transitive open ancestors (prerequisites, closed) of a node.
  const ancestorsOf = (id: string): Set<string> => {
    const acc = new Set<string>();
    const stack = [...(byId.get(id)?.prerequisites ?? [])];
    while (stack.length) {
      const p = stack.pop()!;
      if (!byId.has(p) || acc.has(p)) continue;
      acc.add(p);
      stack.push(...byId.get(p)!.prerequisites);
    }
    return acc;
  };

  const checkpoints = open.filter((n) => n.is_checkpoint);
  const ancByCheckpoint = new Map(checkpoints.map((c) => [c.id, ancestorsOf(c.id)]));
  // Frontier = a checkpoint no OTHER open checkpoint depends on (transitively).
  const frontier = checkpoints.filter(
    (c) =>
      !checkpoints.some(
        (o) => o.id !== c.id && ancByCheckpoint.get(o.id)!.has(c.id),
      ),
  );

  // Undirected adjacency among open nodes (a prereq edge connects both ends).
  const adj = new Map<string, Set<string>>(open.map((n) => [n.id, new Set<string>()]));
  for (const n of open) {
    for (const p of n.prerequisites) {
      if (!byId.has(p)) continue;
      adj.get(n.id)!.add(p);
      adj.get(p)!.add(n.id);
    }
  }

  const out: { checkpoint: SkillNode; nodes: SkillNode[] }[] = [];
  for (const c of frontier) {
    // Everything a KEPT checkpoint (every checkpoint but `c`) needs must stay - this
    // is the boundary the component BFS never crosses, which is what makes the park
    // strand-free.
    const neededByKept = new Set<string>();
    for (const k of checkpoints) {
      if (k.id === c.id) continue;
      neededByKept.add(k.id);
      for (const a of ancByCheckpoint.get(k.id)!) neededByKept.add(a);
    }
    // The connected component of `c` among open nodes, blocked at kept-needed nodes.
    const park = new Set<string>([c.id]);
    const queue: string[] = [c.id];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of adj.get(cur)!) {
        if (park.has(nb) || neededByKept.has(nb)) continue;
        park.add(nb);
        queue.push(nb);
      }
    }
    out.push({ checkpoint: c, nodes: open.filter((n) => park.has(n.id)) });
  }
  return out;
}

/** Per-path recovery: which frontier milestone chains, re-phased out of the current push,
 *  recover probability. Slides a whole checkpoint chain rather than shedding a single leaf or
 *  moving the whole goal date. Each candidate is measured by removing its entire park-set's
 *  effort from the combined pool. A set that would park the goal down to nothing is skipped -
 *  that's abandonment, not recovery. Best improvement first. */
export function skillPathRescheduleMoves(
  nodes: SkillNode[],
  realEstimates: number[],
  deployable: number,
  options: ForecastOptions = {},
  limit = 3,
): SkillPathRescheduleMove[] {
  const open = nodes.filter((n) => !n.attained && !n.deferred);
  if (open.length <= 1) return [];

  const baseSkill = open.map((n) => n.estimated_minutes);
  const current = forecast(
    [...realEstimates, ...baseSkill],
    deployable,
    options,
  ).probability;

  const moves: SkillPathRescheduleMove[] = [];
  for (const set of descopableMilestoneParkSets(nodes)) {
    const parkIds = new Set(set.nodes.map((n) => n.id));
    // Never re-phase the goal down to nothing.
    if (parkIds.size >= open.length) continue;
    const remaining = open
      .filter((n) => !parkIds.has(n.id))
      .map((n) => n.estimated_minutes);
    const after = forecast(
      [...realEstimates, ...remaining],
      deployable,
      options,
    ).probability;
    if (after > current + 0.01) {
      moves.push({
        checkpointId: set.checkpoint.id,
        checkpointTitle: set.checkpoint.title,
        nodeIds: set.nodes.map((n) => n.id),
        titles: set.nodes.map((n) => n.title),
        probabilityAfter: after,
      });
    }
  }

  return moves
    .sort((a, b) => b.probabilityAfter - a.probabilityAfter)
    .slice(0, limit);
}

// --- Re-dating (the answer for a blown / at-risk deadline) ------------------

/** The earliest deadline at which the remaining work clears `target`. The honest "you can't
 *  make May 29, but May 31 gets you 80%" answer, or null if nothing within maxDays reaches it.
 *  Probability is non-decreasing in the deadline - a later date can only add time - so we
 *  binary-search rather than scan (about 8 forecasts, not 180). */
export function earliestAchievableDeadline(
  estimates: number[],
  budget: Omit<DeployableInput, "deadline">,
  target = 0.8,
  options: ForecastOptions = {},
  maxDays = 180,
): { deadline: string; probability: number } | null {
  const open = estimates.filter((e) => e > 0);
  // No work left - today already clears any target.
  if (open.length === 0) return { deadline: budget.today, probability: 1 };

  const start = parseISODate(budget.today);
  const probAt = (day: number): { iso: string; probability: number } => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + day);
    const iso = toISODate(d);
    const deployable = deployableMinutes({ ...budget, deadline: iso });
    return { iso, probability: forecast(open, deployable, options).probability };
  };

  // Even the furthest allowed date can't clear the bar - out of reach.
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
