import type { DependencyEdge, ScheduleDay, ScheduledBlock } from "./schedule";

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
