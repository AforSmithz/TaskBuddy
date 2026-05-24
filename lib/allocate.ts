import type { EffectiveOrderEntry, TaskStatus } from "./types";
import {
  dayCapacities,
  packBlocks,
  type DayCapacity,
  type DependencyEdge,
  type PackItem,
  type ScheduleBudget,
  type ScheduleDay,
} from "./schedule";

// The pit-wall allocator — the single deterministic pass that turns all open
// work across every project into ONE global order and ONE unified day schedule
// over the shared hour-budget. Pure: given the same gather it always produces
// the same plan. The forecast, daily agenda, recommendation, and recovery all
// derive from this (Phase 3, locked decision #1).
//
// Two ideas drive the order:
//   - Cost of delay: how much it hurts to put a task off — its intrinsic value
//     (impact/urgency/risk, the same 1-5 factors `computePriority` already uses)
//     plus a term that grows as its project's deadline nears.
//   - WSJF (cost of delay ÷ estimate): value *density*. Used as the tiebreak
//     while there's slack, and as the primary key under overload — sheddng the
//     lowest-density work first instead of letting EDF dominoes sink everything.
//
// The stored `priority_score` is never touched; the global order is a derived
// view layered on top of it (locked decision #2).

// --- Tunables ---------------------------------------------------------------

const COD_WEIGHTS = { impact: 1, urgency: 1, risk: 0.5 } as const;
/** Weight on the deadline-proximity term within cost of delay. */
const PROXIMITY_WEIGHT = 2;
/** Days out at which deadline proximity starts to bite (linearly to the deadline). */
const PROXIMITY_WINDOW_DAYS = 14;
/** Floor on the WSJF denominator so a near-zero estimate can't blow it up. */
const WSJF_EPSILON = 1;
/** A deadline this many days out (or further) exerts no proximity pull. */
const FAR_FUTURE_OFFSET = 1e9;

// --- Date helpers (UTC-stable) ----------------------------------------------

/** Whole days from ISO date `a` to ISO date `b` (UTC, b − a). */
function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

// --- Task input -------------------------------------------------------------

/**
 * One open task as the allocator sees it: identity, owning project + deadline
 * (via `deadlineByProject`), its estimate, and the three cost-of-delay factors.
 * `priorityScore` is the stored intrinsic score, used only to detect when
 * deadline pressure pulled a task ahead of more important work.
 */
export interface AllocTask {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  estimatedMinutes: number;
  status: TaskStatus;
  priorityScore: number;
  urgency: number;
  impact: number;
  risk: number;
}

export interface GlobalPlanInput {
  /** Open tasks across all projects (deadlined or not). */
  tasks: AllocTask[];
  deps: DependencyEdge[];
  /** projectId → deadline ISO date (or null for an undeadlined project). */
  deadlineByProject: Map<string, string | null>;
  budget: ScheduleBudget;
  today: string;
}

/** The deterministic global plan: one cross-project order + one unified schedule. */
export interface GlobalPlan {
  order: EffectiveOrderEntry[];
  /** Project-tagged days over the shared budget. */
  days: ScheduleDay[];
}

// --- Cost of delay + WSJF ---------------------------------------------------

/** Day offset of a project deadline from today; far-future when undeadlined/past-horizon. */
function deadlineOffsetOf(deadline: string | null, today: string): number {
  if (!deadline) return FAR_FUTURE_OFFSET;
  return daysBetween(today, deadline);
}

/**
 * How much it costs to delay this task: intrinsic value (impact + urgency +
 * risk, the 1-5 factors) plus a deadline-proximity term that rises linearly as
 * the project's deadline approaches and pins at its max once due/overdue.
 */
export function costOfDelay(
  task: Pick<AllocTask, "urgency" | "impact" | "risk">,
  deadline: string | null,
  today: string,
): number {
  const value =
    task.impact * COD_WEIGHTS.impact +
    task.urgency * COD_WEIGHTS.urgency +
    task.risk * COD_WEIGHTS.risk;

  let proximity = 0;
  if (deadline) {
    const daysOut = daysBetween(today, deadline);
    // 0 when far out, ramping to 1 at the deadline, capped at 1 once overdue.
    proximity = Math.min(1, Math.max(0, (PROXIMITY_WINDOW_DAYS - daysOut) / PROXIMITY_WINDOW_DAYS));
  }
  return value + proximity * PROXIMITY_WEIGHT;
}

/** WSJF — cost of delay per minute of work (value density). Higher = do sooner. */
export function wsjf(task: AllocTask, deadline: string | null, today: string): number {
  return costOfDelay(task, deadline, today) / Math.max(task.estimatedMinutes, WSJF_EPSILON);
}

// --- The global order -------------------------------------------------------

/**
 * Is the deadlined work infeasible — does it exceed the deployable hours before
 * the last deadline? Drives the adaptive switch from EDF to WSJF (locked
 * decision #3): EDF is optimal while slack exists, but collapses into a domino
 * of misses under overload, where shedding the lowest-density work first is the
 * honest move.
 */
function isOverloaded(
  tasks: AllocTask[],
  deadlineByProject: Map<string, string | null>,
  capacities: DayCapacity[],
  today: string,
): boolean {
  let maxOffset = -1;
  let work = 0;
  for (const t of tasks) {
    const dl = deadlineByProject.get(t.projectId) ?? null;
    if (!dl) continue; // undeadlined work never forces overload on its own
    work += Math.max(0, t.estimatedMinutes);
    maxOffset = Math.max(maxOffset, deadlineOffsetOf(dl, today));
  }
  if (maxOffset < 0) return false; // no deadlined work
  const lastDay = Math.min(maxOffset, capacities.length - 1);
  let budget = 0;
  for (let i = 0; i <= lastDay; i++) budget += capacities[i].capacityMinutes;
  return work > budget;
}

/**
 * The single global order across all projects. A dependency topological sort
 * (generalising `orderSchedulableTasks`): among the tasks whose prerequisites
 * are already placed, pick the next by Earliest-Deadline-First while feasible,
 * switching to WSJF / value-density under overload. WSJF breaks EDF ties (and
 * EDF breaks WSJF ties), so the order is always total and deterministic.
 *
 * Each entry records its `rank` and, when deadline pressure pulled a task ahead
 * of more intrinsically important work from another project, `pulledAhead` + a
 * human-readable reason.
 */
export function effectiveOrder(
  tasks: AllocTask[],
  deps: DependencyEdge[],
  deadlineByProject: Map<string, string | null>,
  capacities: DayCapacity[],
  today: string,
): EffectiveOrderEntry[] {
  // Keep blocked tasks in the order: they're still open work that consumes the
  // budget before a deadline, so the contention forecast must account for them
  // (we assume they'll be unblocked). Deferred/done work is excluded upstream.
  const schedulable = tasks.filter((t) => t.status !== "done");
  const byId = new Map(schedulable.map((t) => [t.id, t]));

  const prereqs = new Map<string, Set<string>>();
  const unblockCount = new Map<string, number>();
  for (const edge of deps) {
    if (!byId.has(edge.task_id) || !byId.has(edge.depends_on_task_id)) continue;
    if (!prereqs.has(edge.task_id)) prereqs.set(edge.task_id, new Set());
    prereqs.get(edge.task_id)!.add(edge.depends_on_task_id);
    unblockCount.set(
      edge.depends_on_task_id,
      (unblockCount.get(edge.depends_on_task_id) ?? 0) + 1,
    );
  }

  const overloaded = isOverloaded(schedulable, deadlineByProject, capacities, today);
  const dlOffset = (t: AllocTask) =>
    deadlineOffsetOf(deadlineByProject.get(t.projectId) ?? null, today);
  const density = (t: AllocTask) =>
    wsjf(t, deadlineByProject.get(t.projectId) ?? null, today);

  // Ready-task comparator: `< 0` means `a` goes before `b`.
  const compare = (a: AllocTask, b: AllocTask): number => {
    const ea = dlOffset(a);
    const eb = dlOffset(b);
    const da = density(a);
    const db = density(b);
    if (overloaded) {
      if (db !== da) return db - da; // value density first
      if (ea !== eb) return ea - eb; // then earliest deadline
    } else {
      if (ea !== eb) return ea - eb; // earliest deadline first
      if (db !== da) return db - da; // then value density
    }
    const ua = unblockCount.get(a.id) ?? 0;
    const ub = unblockCount.get(b.id) ?? 0;
    if (ub !== ua) return ub - ua; // prefer tasks that unblock more work
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // stable final tiebreak
  };

  const remaining = new Set(schedulable.map((t) => t.id));
  const placed = new Set<string>();
  const order: EffectiveOrderEntry[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((t) => {
        const need = prereqs.get(t.id);
        return !need || [...need].every((d) => placed.has(d) || !byId.has(d));
      });
    // A dependency cycle can leave nothing ready — fall back to all remaining.
    const pool = ready.length > 0 ? ready : [...remaining].map((id) => byId.get(id)!);
    pool.sort(compare);
    const next = pool[0];

    // Pulled ahead = a different project's task ranked higher by intrinsic score
    // was passed over because `next`'s deadline is closer (EDF mode only).
    const leapfrogged = !overloaded
      ? pool.find(
          (o) =>
            o.projectId !== next.projectId &&
            o.priorityScore > next.priorityScore &&
            dlOffset(next) < dlOffset(o),
        )
      : undefined;

    const dl = deadlineByProject.get(next.projectId) ?? null;
    const daysOut = dl ? daysBetween(today, dl) : null;
    order.push({
      taskId: next.id,
      title: next.title,
      projectId: next.projectId,
      projectName: next.projectName,
      estimatedMinutes: next.estimatedMinutes,
      rank: order.length,
      pulledAhead: Boolean(leapfrogged),
      reason: leapfrogged
        ? `Pulled ahead — ${next.projectName} ${
            daysOut !== null && daysOut >= 0
              ? `due in ${daysOut} day(s)`
              : "deadline passed"
          }, ahead of ${leapfrogged.projectName}`
        : reasonFor(next, dl, today, overloaded, unblockCount.get(next.id) ?? 0),
    });

    remaining.delete(next.id);
    placed.add(next.id);
  }

  return order;
}

/** Plain-language placement reason for a task that wasn't pulled ahead. */
function reasonFor(
  task: AllocTask,
  deadline: string | null,
  today: string,
  overloaded: boolean,
  unblocks: number,
): string {
  if (overloaded) {
    return `Ordered by value density (WSJF ${wsjf(task, deadline, today).toFixed(3)}) under overload.`;
  }
  const parts: string[] = [];
  if (deadline) {
    const d = daysBetween(today, deadline);
    parts.push(d >= 0 ? `${task.projectName} due in ${d} day(s)` : `${task.projectName} deadline passed`);
  } else {
    parts.push("no deadline");
  }
  if (unblocks > 0) parts.push("unblocks downstream work");
  return `Earliest-deadline-first: ${parts.join(", ")}.`;
}

// --- The unified schedule ---------------------------------------------------

/**
 * Pack the global order across the real shared days, tagging every block with
 * its project. Generalises `generateSchedule` (already wall-clock-free): same
 * greedy day-packing, one budget shared by all projects.
 */
export function packGlobal(
  order: EffectiveOrderEntry[],
  budget: ScheduleBudget,
  today: string,
): ScheduleDay[] {
  const capacities = dayCapacities(budget, today);
  const items: PackItem[] = order.map((e) => ({
    taskId: e.taskId,
    label: e.title,
    reason: e.reason,
    estimatedMinutes: e.estimatedMinutes,
    projectId: e.projectId,
    projectName: e.projectName,
  }));
  return packBlocks(
    items,
    capacities,
    (it) => Math.max(15, it.estimatedMinutes || 30),
    { reviewBuffer: true },
  ).days;
}

/** The whole deterministic global plan, pure given its input. */
export function buildGlobalPlan(input: GlobalPlanInput): GlobalPlan {
  const capacities = dayCapacities(input.budget, input.today);
  const order = effectiveOrder(
    input.tasks,
    input.deps,
    input.deadlineByProject,
    capacities,
    input.today,
  );
  const days = packGlobal(order, input.budget, input.today);
  return { order, days };
}
