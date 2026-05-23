import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  TaskStatus,
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

// --- Multi-day packing ------------------------------------------------------

/**
 * Build a recommended schedule, spread across real days from `anchorDate`.
 *
 * Tasks are ordered (dependency + score), then greedily packed: each task fills
 * the current day until it would overflow, then rolls to the next day that has
 * any deployable time (skipping weekends / fully-committed days). A task larger
 * than a whole day is placed on a fresh day and allowed to overrun it. A closing
 * review buffer caps the last day.
 */
export function generateSchedule(
  tasks: SchedulableTask[],
  dependencies: DependencyEdge[],
  budget: ScheduleBudget,
  anchorDate: string,
): ScheduleDay[] {
  const { order, unblockCount, prereqs } = planOrder(tasks, dependencies);
  if (order.length === 0) return [];

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
  const capacityAt = (offset: number): { iso: string; cap: number } => {
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + offset);
    const iso = toISODate(d);
    const base = overrideByDate.get(iso) ?? template.get(d.getUTCDay()) ?? 0;
    const consumed = consumedByDate.get(iso) ?? 0;
    return { iso, cap: Math.round(Math.max(0, base - consumed) * MINUTES_PER_HOUR) };
  };

  const days: ScheduleDay[] = [];
  let offset = 0;
  // Open the next day that actually has time; null once past the horizon.
  const openNextDay = (): ScheduleDay | null => {
    while (offset <= HORIZON_DAYS) {
      const { iso, cap } = capacityAt(offset);
      offset++;
      if (cap > 0) {
        const day: ScheduleDay = {
          date: iso,
          capacityMinutes: cap,
          usedMinutes: 0,
          blocks: [],
        };
        days.push(day);
        return day;
      }
    }
    return null;
  };

  let current = openNextDay();
  if (!current) return []; // no deployable time anywhere in the horizon

  for (const task of order) {
    const duration = Math.max(15, task.estimated_minutes || 30);
    // Roll to the next day when this won't fit — but never strand a day empty
    // (an oversized task stays put and overruns rather than looping forever).
    if (
      current.usedMinutes > 0 &&
      current.usedMinutes + duration > current.capacityMinutes
    ) {
      current = openNextDay() ?? current;
    }
    current.blocks.push({
      task_id: task.id,
      label: task.title,
      minutes: duration,
      reason: reasonFor(task, unblockCount, prereqs),
    });
    current.usedMinutes += duration;
  }

  // Closing review/admin buffer on the last day with work.
  const last = days[days.length - 1];
  last.blocks.push({
    task_id: null,
    label: "Review & follow-up buffer",
    minutes: REVIEW_BUFFER_MINUTES,
    reason: "Reserved time to review progress and send follow-up messages.",
  });
  last.usedMinutes += REVIEW_BUFFER_MINUTES;

  return days;
}
