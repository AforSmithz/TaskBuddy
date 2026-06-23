import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  TaskStatus,
  TimeWindow,
} from "./types";

// Deterministic schedule generator.
// Orders tasks by dependency first, then by a schedule score derived from
// priority, and packs them across real days using the same deployable-hours
// model the forecast uses — so the plan respects your actual availability
// (weekends, day capacities, commitments) instead of a fictional 9–5.
//
// The output is a *derived view*: it carries no wall-clock times (we only know
// hours per day, not when you sit down) and is recomputed from live tasks +
// availability rather than persisted, so it never goes stale.

export interface SchedulableTask {
  id: string;
  title: string;
  estimated_minutes: number;
  priority_score: number;
  impact_score: number | null;
  status: TaskStatus;
}

export interface DependencyEdge {
  task_id: string;
  depends_on_task_id: string;
}

/** One task's slot within a day — a duration, not a clock range. */
export interface ScheduledBlock {
  task_id: string | null;
  label: string;
  minutes: number;
  reason: string;
  /** Owning project, set only on global (cross-project) schedules. */
  projectId?: string | null;
  projectName?: string;
}

/** A day's worth of work, sized to that day's real deployable capacity. */
export interface ScheduleDay {
  date: string; // ISO "YYYY-MM-DD"
  /** Deployable minutes that day: (override ?? weekday template) − commitments. */
  capacityMinutes: number;
  /** Minutes booked; may exceed capacity when a single task is bigger than a day. */
  usedMinutes: number;
  blocks: ScheduledBlock[];
}

/** The availability inputs that size each day (same source as the forecast). */
export interface ScheduleBudget {
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Pick<Commitment, "date" | "hours">[];
}

const MINUTES_PER_HOUR = 60;
const REVIEW_BUFFER_MINUTES = 30;
// Don't search past this many days for a free day (a runaway guard).
const HORIZON_DAYS = 120;

// --- Date helpers (UTC-stable, mirroring forecast.ts) -----------------------

function parseISODate(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISODate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// --- Ordering ---------------------------------------------------------------

interface OrderPlan {
  order: SchedulableTask[];
  /** How many tasks each task unblocks. */
  unblockCount: Map<string, number>;
  /** Each task's schedulable prerequisites. */
  prereqs: Map<string, Set<string>>;
}

/**
 * Dependency-aware ordering: a topological sort that, among the tasks whose
 * prerequisites are already placed, always takes the highest schedule score
 * next. `done`/`blocked` tasks are dropped.
 */
function planOrder(
  tasks: SchedulableTask[],
  dependencies: DependencyEdge[],
): OrderPlan {
  const schedulable = tasks.filter(
    (t) => t.status !== "done" && t.status !== "blocked",
  );
  const byId = new Map(schedulable.map((t) => [t.id, t]));

  const prereqs = new Map<string, Set<string>>();
  const unblockCount = new Map<string, number>();
  for (const edge of dependencies) {
    if (!byId.has(edge.task_id) || !byId.has(edge.depends_on_task_id)) continue;
    if (!prereqs.has(edge.task_id)) prereqs.set(edge.task_id, new Set());
    prereqs.get(edge.task_id)!.add(edge.depends_on_task_id);
    unblockCount.set(
      edge.depends_on_task_id,
      (unblockCount.get(edge.depends_on_task_id) ?? 0) + 1,
    );
  }

  const scheduleScore = (t: SchedulableTask): number => {
    let s = t.priority_score;
    if ((unblockCount.get(t.id) ?? 0) > 0) s += 0.5; // unblocks other work
    if (
      t.estimated_minutes > 0 &&
      t.estimated_minutes <= 30 &&
      (t.impact_score ?? 0) >= 4
    ) {
      s += 0.3; // quick win with high impact
    }
    return s;
  };

  const remaining = new Set(schedulable.map((t) => t.id));
  const placed = new Set<string>();
  const order: SchedulableTask[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((t) => {
        const need = prereqs.get(t.id);
        return !need || [...need].every((d) => placed.has(d) || !byId.has(d));
      });

    // If a dependency cycle leaves nothing ready, fall back to all remaining.
    const pool =
      ready.length > 0 ? ready : [...remaining].map((id) => byId.get(id)!);
    pool.sort((a, b) => scheduleScore(b) - scheduleScore(a));

    const next = pool[0];
    order.push(next);
    remaining.delete(next.id);
    placed.add(next.id);
  }

  return { order, unblockCount, prereqs };
}

/** Just the dependency-aware task order (no day packing). */
export function orderSchedulableTasks(
  tasks: SchedulableTask[],
  dependencies: DependencyEdge[],
): SchedulableTask[] {
  return planOrder(tasks, dependencies).order;
}

function reasonFor(
  task: SchedulableTask,
  unblockCount: Map<string, number>,
  prereqs: Map<string, Set<string>>,
): string {
  const parts: string[] = [];
  if ((unblockCount.get(task.id) ?? 0) > 0) {
    parts.push("unblocks downstream tasks");
  }
  if (prereqs.get(task.id)?.size) {
    parts.push("runs after its prerequisites");
  }
  parts.push(`priority ${task.priority_score.toFixed(2)}`);
  return `Scheduled here because it ${parts.join(", ")}.`;
}

// --- Reusable day-capacity + packing core -----------------------------------

/** One day's deployable capacity, in calendar order from an anchor date. */
export interface DayCapacity {
  iso: string;
  capacityMinutes: number;
}

/** One time-of-day SEGMENT of a day's capacity (OVERHAUL S3b Pillar 2): the slice
 *  of the day's minutes that falls in one of the five S2 windows, plus that window's
 *  net velocity multiplier. A windowed forecast flows across these instead of whole
 *  days — but the deadline check stays day-granular (every segment carries its `iso`).
 *  Built by `arrange.ts windowCapacities`; a flat/unlearned split sums per day to the
 *  whole-day capacity with `netMultiplier === 1`, so it degrades to today bit-for-bit. */
export interface WindowCapacity {
  iso: string;
  window: TimeWindow;
  capacityMinutes: number;
  /** `exp(μ_window − μ₀)`: <1 faster, >1 slower, =1 unlearned. Applied to work that STARTS here. */
  netMultiplier: number;
}

/**
 * Deployable minutes for each day from `anchorDate` forward across `horizonDays`:
 * (override ?? weekday template) − commitments, floored at 0. Zero-capacity days
 * (weekends / fully-committed) are kept so a caller can index by day offset. This
 * is the same per-day math the forecast's `deployableMinutes` sums — exposed here
 * as a per-day series the packer and the global Monte Carlo both walk.
 */
/** Signed, UNFLOORED per-day slack in hours: availability − all consumed (incl. the
 *  recurring drain folded into `commitments`). `dayCapacities` is just its non-negative
 *  floor; the strategy review screen ships the signed value so a multi-skip re-solve can
 *  add freed drain back and apply the floor ONCE — composing any subset of skips exactly,
 *  even on a day whose drain already exceeds availability (where per-skip floored vectors
 *  would under-count). */
export interface DaySlack {
  iso: string;
  slackHours: number;
}

export function daySlackHours(
  budget: ScheduleBudget,
  anchorDate: string,
  horizonDays = HORIZON_DAYS,
): DaySlack[] {
  const template = new Map<number, number>();
  for (const a of budget.availability) template.set(a.weekday, a.hours);
  const overrideByDate = new Map<string, number>();
  for (const o of budget.overrides) {
    overrideByDate.set(o.date.slice(0, 10), o.hours);
  }
  const consumedByDate = new Map<string, number>();
  for (const c of budget.commitments) {
    const key = c.date.slice(0, 10);
    consumedByDate.set(key, (consumedByDate.get(key) ?? 0) + c.hours);
  }

  const start = parseISODate(anchorDate);
  const out: DaySlack[] = [];
  for (let offset = 0; offset <= horizonDays; offset++) {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + offset);
    const iso = toISODate(d);
    const base = overrideByDate.get(iso) ?? template.get(d.getUTCDay()) ?? 0;
    const consumed = consumedByDate.get(iso) ?? 0;
    out.push({ iso, slackHours: base - consumed });
  }
  return out;
}

export function dayCapacities(
  budget: ScheduleBudget,
  anchorDate: string,
  horizonDays = HORIZON_DAYS,
): DayCapacity[] {
  return daySlackHours(budget, anchorDate, horizonDays).map((s) => ({
    iso: s.iso,
    capacityMinutes: Math.round(Math.max(0, s.slackHours) * MINUTES_PER_HOUR),
  }));
}

/** Index of the first day at or after `from` that has any capacity. */
function firstOpenDay(capacities: DayCapacity[], from: number): number {
  let i = from;
  while (i < capacities.length && capacities[i].capacityMinutes <= 0) i++;
  return i;
}

/**
 * Greedy packing core: walk `durations` (already in the order to schedule) across
 * the day capacities and return the 0-based day offset each item lands on. Each
 * item fills the current day until it would overflow, then rolls to the next day
 * with capacity; an item larger than a whole day stays on a fresh day and overruns
 * it (never loops). Items that run past the horizon pin to the last day.
 *
 * Pure numbers, no allocation beyond the result — this is the hot path the global
 * Monte Carlo calls once per iteration, so it takes raw durations (the caller
 * decides any flooring/defaulting) and never builds block objects.
 */
export function packOffsets(
  durations: number[],
  capacities: DayCapacity[],
): number[] {
  const offsets = new Array<number>(durations.length).fill(0);
  if (capacities.length === 0) return offsets;

  let dayIdx = firstOpenDay(capacities, 0);
  // No deployable time anywhere — everything lands on the final day (overrun).
  if (dayIdx >= capacities.length) return offsets.fill(capacities.length - 1);

  let used = 0;
  for (let k = 0; k < durations.length; k++) {
    const duration = durations[k];
    if (
      used > 0 &&
      used + duration > capacities[dayIdx].capacityMinutes
    ) {
      const next = firstOpenDay(capacities, dayIdx + 1);
      if (next < capacities.length) {
        dayIdx = next;
        used = 0;
      }
      // else: past the horizon — stay on the current day and overrun it.
    }
    offsets[k] = dayIdx;
    used += duration;
  }
  return offsets;
}

/**
 * The comfort-capped variant of `packOffsets` (OVERHAUL S3b Phase 3): the same greedy
 * single-day assignment, but ALSO meter each day's HARD-work minutes (`hardMinutes[k]` =
 * a task's difficulty-weighted minutes) against a soft daily `comfortCap`. A hard task
 * rolls to the next open day when the current day already holds hard work and this task
 * would push it past the cap — so deep work spreads across days instead of cramming one.
 * The total per-day capacity still bounds placement. With `comfortCap === Infinity` (or
 * all `hardMinutes === 0`) it never rolls for the cap ⇒ byte-identical to `packOffsets`.
 */
export function packOffsetsComfort(
  durations: number[],
  capacities: DayCapacity[],
  hardMinutes: number[],
  comfortCap: number,
): number[] {
  const offsets = new Array<number>(durations.length).fill(0);
  if (capacities.length === 0) return offsets;

  let dayIdx = firstOpenDay(capacities, 0);
  if (dayIdx >= capacities.length) return offsets.fill(capacities.length - 1);

  let used = 0;
  let hardUsed = 0;
  for (let k = 0; k < durations.length; k++) {
    const hard = hardMinutes[k];
    const rollTotal = used > 0 && used + durations[k] > capacities[dayIdx].capacityMinutes;
    const rollHard = hard > 0 && hardUsed > 0 && hardUsed + hard > comfortCap;
    if (rollTotal || rollHard) {
      const next = firstOpenDay(capacities, dayIdx + 1);
      if (next < capacities.length) {
        dayIdx = next;
        used = 0;
        hardUsed = 0;
      }
      // else: past the horizon — stay on the current day and overrun it.
    }
    offsets[k] = dayIdx;
    used += durations[k];
    hardUsed += hard;
  }
  return offsets;
}

/**
 * Time-accurate finish offsets: walk `durations` (in order) and flow each task's
 * minutes across day capacities as a continuous resource — a task longer than a
 * day's remaining time spills into the following days, finishing on the day its
 * last minute lands. This is the multi-day generalisation of "does the work fit
 * in the budget?" the forecast needs (unlike `packOffsets`, which keeps an
 * oversized task as one overrunning block for display). Equivalent to the old
 * sum-vs-deployable check for a single project, but honours real per-day capacity
 * and cross-project contention. Items past the horizon pin to the last day.
 */
export function flowFinishOffsets(
  durations: number[],
  capacities: DayCapacity[],
): number[] {
  const offsets = new Array<number>(durations.length).fill(0);
  if (capacities.length === 0) return offsets;

  let dayIdx = firstOpenDay(capacities, 0);
  if (dayIdx >= capacities.length) return offsets.fill(capacities.length - 1);

  let remaining = capacities[dayIdx].capacityMinutes;
  for (let k = 0; k < durations.length; k++) {
    let need = durations[k];
    while (need > remaining) {
      const next = firstOpenDay(capacities, dayIdx + 1);
      if (next >= capacities.length) {
        // Out of budget — this task and everything after it spill past the horizon.
        for (let j = k; j < durations.length; j++) offsets[j] = capacities.length - 1;
        return offsets;
      }
      need -= remaining;
      dayIdx = next;
      remaining = capacities[dayIdx].capacityMinutes;
    }
    remaining -= need;
    offsets[k] = dayIdx;
  }
  return offsets;
}

/**
 * The comfort-capped generalisation of `flowFinishOffsets` (OVERHAUL S3b Phase 3): flow
 * `durations` across day capacities exactly as `flowFinishOffsets` does (a task longer
 * than a day spills into following days), but ALSO meter each day's HARD-work minutes
 * (`hardMinutes[k]` = a task's difficulty-weighted minutes) against a soft daily
 * `comfortCap`. Before a hard task starts, if the current day already holds hard work and
 * adding it would exceed the cap, it rolls to the next open day first — spreading deep
 * work across days. Hard load is booked on the day the task lands; a single task bigger
 * than the cap can't be split, so it overruns the cap on its own day (the cap is soft).
 *
 * No-regret: with `comfortCap === Infinity` (or every `hardMinutes === 0`) it NEVER rolls
 * for the cap, so it is byte-identical to `flowFinishOffsets` — the regression the harness
 * pins. The deadline check stays day-granular (returns finish-day offsets), so the gate is
 * apples-to-apples against the canonical (uncapped) forecast.
 */
export function flowFinishOffsetsComfort(
  durations: number[],
  capacities: DayCapacity[],
  hardMinutes: number[],
  comfortCap: number,
): number[] {
  const offsets = new Array<number>(durations.length).fill(0);
  if (capacities.length === 0) return offsets;

  let dayIdx = firstOpenDay(capacities, 0);
  if (dayIdx >= capacities.length) return offsets.fill(capacities.length - 1);

  let remaining = capacities[dayIdx].capacityMinutes;
  let hardUsed = 0;
  for (let k = 0; k < durations.length; k++) {
    const hard = hardMinutes[k];
    // Comfort roll: a deep-work block that won't fit the day's hard budget (and the day
    // already holds hard work) waits for the next open day.
    if (hard > 0 && hardUsed > 0 && hardUsed + hard > comfortCap) {
      const next = firstOpenDay(capacities, dayIdx + 1);
      if (next >= capacities.length) {
        for (let j = k; j < durations.length; j++) offsets[j] = capacities.length - 1;
        return offsets;
      }
      dayIdx = next;
      remaining = capacities[dayIdx].capacityMinutes;
      hardUsed = 0;
    }
    let need = durations[k];
    let spilled = false;
    while (need > remaining) {
      const next = firstOpenDay(capacities, dayIdx + 1);
      if (next >= capacities.length) {
        for (let j = k; j < durations.length; j++) offsets[j] = capacities.length - 1;
        return offsets;
      }
      need -= remaining;
      dayIdx = next;
      remaining = capacities[dayIdx].capacityMinutes;
      spilled = true;
    }
    remaining -= need;
    // Hard load counts on the day the task lands; a spilled task resets the day's hard
    // tally to its own load (it's the only work on that landing day so far).
    hardUsed = spilled ? hard : hardUsed + hard;
    offsets[k] = dayIdx;
  }
  return offsets;
}

/** One lane of the windowed flow (OVERHAUL S3b Pillar 2): a contiguous capacity
 *  bucket the sampled work fills, the net velocity multiplier applied to work that
 *  STARTS in it, and the day offset it reports as a finish (so the deadline check
 *  stays day-granular even when lanes are sub-day window segments). The day-granular
 *  flow is the special case: one lane per day, `netMultiplier === 1`, `dayOffset` =
 *  the day's index. */
export interface FlowLane {
  capacityMinutes: number;
  netMultiplier: number;
  dayOffset: number;
}

/** Index of the first lane at or after `from` with any capacity. */
function firstOpenLane(lanes: FlowLane[], from: number): number {
  let i = from;
  while (i < lanes.length && lanes[i].capacityMinutes <= 0) i++;
  return i;
}

/**
 * The windowed generalisation of `flowFinishOffsets`: flow `durations` (in order)
 * across capacity LANES, scaling each task by the net velocity multiplier of the
 * lane it STARTS in, and returning the `dayOffset` of the lane its last minute
 * lands on. With one lane per day and `netMultiplier === 1` it is byte-identical to
 * `flowFinishOffsets` — the no-regret anchor the harness proves. The windowed series
 * is a safe superset: lanes summing to a day's capacity, filled in clock order,
 * consume exactly that capacity before crossing to the next day, so a flat, unlearned
 * split returns the same finish DAY for every task. The start-lane multiplier is read
 * only AFTER rolling past any exhausted lane (and only for real work, so a zero-minute
 * task never advances the cursor — that keeps the daily path bit-identical), so a task
 * that genuinely begins in a learned-fast window shrinks.
 */
export function flowFinishOffsetsLanes(
  durations: number[],
  lanes: FlowLane[],
): number[] {
  const offsets = new Array<number>(durations.length).fill(0);
  if (lanes.length === 0) return offsets;
  const lastOffset = lanes[lanes.length - 1].dayOffset;

  let i = firstOpenLane(lanes, 0);
  if (i >= lanes.length) return offsets.fill(lastOffset);
  let remaining = lanes[i].capacityMinutes;

  for (let k = 0; k < durations.length; k++) {
    // Roll to the lane this task's first minute actually lands in BEFORE reading
    // its start-window multiplier; guarded on real work so a zero-minute task stays
    // put (the daily path's exact behaviour).
    if (durations[k] > 0 && remaining <= 0) {
      const next = firstOpenLane(lanes, i + 1);
      if (next >= lanes.length) {
        for (let j = k; j < durations.length; j++) offsets[j] = lastOffset;
        return offsets;
      }
      i = next;
      remaining = lanes[i].capacityMinutes;
    }
    let need = durations[k] * lanes[i].netMultiplier;
    while (need > remaining) {
      const next = firstOpenLane(lanes, i + 1);
      if (next >= lanes.length) {
        for (let j = k; j < durations.length; j++) offsets[j] = lastOffset;
        return offsets;
      }
      need -= remaining;
      i = next;
      remaining = lanes[i].capacityMinutes;
    }
    remaining -= need;
    offsets[k] = lanes[i].dayOffset;
  }
  return offsets;
}

/** One item to pack: a task block's display metadata plus its base estimate. */
export interface PackItem {
  taskId: string;
  label: string;
  reason: string;
  estimatedMinutes: number;
  /** Owning project, set on global (cross-project) packs. */
  projectId?: string | null;
  projectName?: string;
}

export interface PackResult {
  days: ScheduleDay[];
  /** taskId → 0-based day offset from the anchor where its block landed. */
  finishOffsetByTask: Map<string, number>;
}

/**
 * Pack `items` into real days using `packOffsets`, building the rich
 * `ScheduleDay[]` view. `durationOf` supplies each item's minutes — a point
 * estimate for a deterministic schedule, a sampled duration inside a simulation.
 * With `reviewBuffer`, a closing buffer caps the last day with work. With `comfort`,
 * the display mirrors the comfort-capped flow (OVERHAUL S3b Phase 3): each item's hard
 * minutes (`difficulty × its packed duration`) are metered per day against `comfortCap`,
 * so the shown plan matches its comfort-priced odds. Absent ⇒ today's greedy pack.
 */
export function packBlocks(
  items: PackItem[],
  capacities: DayCapacity[],
  durationOf: (item: PackItem) => number,
  opts: {
    reviewBuffer?: boolean;
    comfort?: { difficulty: number[]; comfortCap: number };
  } = {},
): PackResult {
  // No deployable time anywhere in the horizon — no schedule to show.
  if (items.length === 0 || firstOpenDay(capacities, 0) >= capacities.length) {
    return { days: [], finishOffsetByTask: new Map() };
  }

  const durations = items.map(durationOf);
  const offsets = opts.comfort
    ? packOffsetsComfort(
        durations,
        capacities,
        durations.map((d, i) => (opts.comfort!.difficulty[i] ?? 0) * d),
        opts.comfort.comfortCap,
      )
    : packOffsets(durations, capacities);

  const days: ScheduleDay[] = [];
  const dayByOffset = new Map<number, ScheduleDay>();
  const finishOffsetByTask = new Map<string, number>();

  // Offsets are non-decreasing, so days are pushed in calendar order.
  for (let k = 0; k < items.length; k++) {
    const off = offsets[k];
    let day = dayByOffset.get(off);
    if (!day) {
      const cap = capacities[off];
      day = { date: cap.iso, capacityMinutes: cap.capacityMinutes, usedMinutes: 0, blocks: [] };
      dayByOffset.set(off, day);
      days.push(day);
    }
    const item = items[k];
    const block: ScheduledBlock = {
      task_id: item.taskId,
      label: item.label,
      minutes: durations[k],
      reason: item.reason,
    };
    if (item.projectId !== undefined) {
      block.projectId = item.projectId;
      block.projectName = item.projectName;
    }
    day.blocks.push(block);
    day.usedMinutes += durations[k];
    finishOffsetByTask.set(item.taskId, off);
  }

  if (opts.reviewBuffer && days.length > 0) {
    const last = days[days.length - 1];
    last.blocks.push({
      task_id: null,
      label: "Review & follow-up buffer",
      minutes: REVIEW_BUFFER_MINUTES,
      reason: "Reserved time to review progress and send follow-up messages.",
    });
    last.usedMinutes += REVIEW_BUFFER_MINUTES;
  }

  return { days, finishOffsetByTask };
}

// --- Multi-day packing ------------------------------------------------------

/**
 * Build a recommended schedule, spread across real days from `anchorDate`.
 *
 * Tasks are ordered (dependency + score), then greedily packed across real days
 * (skipping weekends / fully-committed days). A task larger than a whole day is
 * placed on a fresh day and allowed to overrun it. A closing review buffer caps
 * the last day.
 */
export function generateSchedule(
  tasks: SchedulableTask[],
  dependencies: DependencyEdge[],
  budget: ScheduleBudget,
  anchorDate: string,
): ScheduleDay[] {
  const { order, unblockCount, prereqs } = planOrder(tasks, dependencies);
  if (order.length === 0) return [];

  const capacities = dayCapacities(budget, anchorDate);
  const items: PackItem[] = order.map((t) => ({
    taskId: t.id,
    label: t.title,
    reason: reasonFor(t, unblockCount, prereqs),
    estimatedMinutes: t.estimated_minutes,
  }));

  return packBlocks(
    items,
    capacities,
    (it) => Math.max(15, it.estimatedMinutes || 30),
    { reviewBuffer: true },
  ).days;
}
