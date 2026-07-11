import type { Conflict, EffectiveOrderEntry, SegmentModel, TaskStatus } from "./types";
import {
  dayCapacities,
  flowFinishOffsets,
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
/** Troubled projects whose deadlines fall within this window are fighting each other. */
const COLLISION_WINDOW_DAYS = 7;

// --- Date helpers (UTC-stable) ----------------------------------------------

/** Whole days from ISO date `a` to ISO date `b` (UTC, b − a). */
function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

/**
 * A task's cognitive-load weight in `[0,1]` from its 1-5 `effort` factor — the
 * "hard work" axis the S3b comfort cap meters (OVERHAUL §5a Phase 3). Productivity
 * research caps *sustainable focused work* at ~3-4 h/day; `effort` is the dedicated
 * difficulty factor, so a task's **hard minutes** = `difficulty × estimatedMinutes`.
 * effort 1 ⇒ 0 (trivial, doesn't tax a deep-work day), effort 5 ⇒ 1 (fully
 * demanding); a missing score reads as the neutral middle (3 ⇒ 0.5). Pure.
 */
export function effortToDifficulty(effortScore: number | null | undefined): number {
  const e = effortScore ?? 3;
  return Math.min(1, Math.max(0, (e - 1) / 4));
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
  /**
   * Value-Model importance multiplier on this task's cost-of-delay (its area's
   * weight; OVERHAUL §5.1). Optional — synthetic recurring lanes omit it and read
   * as neutral (1), so they keep their existing weight.
   */
  importance?: number;
  /**
   * Per-task velocity model (OVERHAUL S2): this task's domain-shrunk `(meanLog,
   * sigma)`, attached in `buildAllocTasks` from `Task.area`. Carried verbatim into
   * the order entry so the joint forecast samples each task by its own velocity;
   * synthetic/skill lanes omit it and fall back to the global scalar. Affects only
   * the sampler — never the ordering (cost-of-delay / WSJF ignore it).
   */
  model?: SegmentModel;
  /**
   * Cognitive-load weight in `[0,1]` (OVERHAUL S3b Phase 3 — the comfort cap's "hard
   * work" axis; see `effortToDifficulty`). Carried verbatim onto the order entry so the
   * comfort-capped flow can meter hard minutes per day. Optional — absent ⇒ unmetered
   * (0), so a plan with no difficulty signal degrades to today (no comfort capping).
   */
  difficulty?: number;
}

/** Id prefix for synthetic `AllocTask`s that stand in for a learning goal's skill
 *  nodes (`skill:<nodeId>`). Lives here, next to `AllocTask`, so the alloc layer can
 *  tell a real task row from an injected skill lane without importing upward. */
export const SKILL_TASK_PREFIX = "skill:";

export interface GlobalPlanInput {
  /** Open tasks across all projects (deadlined or not). */
  tasks: AllocTask[];
  deps: DependencyEdge[];
  /** projectId → deadline ISO date (or null for an undeadlined project). */
  deadlineByProject: Map<string, string | null>;
  /**
   * Optional ordering-ONLY deadline override (defaults to `deadlineByProject`).
   * Lets a lane be ranked as if due on a date without entering overload
   * detection or the forecast — used to float today's due recurring instances to
   * the top of the AGENDA order while the forecast still gates on real deadlines.
   */
  orderingDeadlineByProject?: Map<string, string | null>;
  budget: ScheduleBudget;
  today: string;
}

/** The deterministic global plan: one cross-project order + one unified schedule. */
export interface GlobalPlan {
  order: EffectiveOrderEntry[];
  /** Goal-tagged days over the shared budget. */
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
  task: Pick<AllocTask, "urgency" | "impact" | "risk" | "importance">,
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
  // The Value Model scales the WHOLE cost of delay (intrinsic value + deadline
  // pressure), so a more-important area's work both ranks earlier and is protected
  // harder under contention/triage. Neutral (1) when unweighted.
  const importance = task.importance ?? 1;
  return (value + proximity * PROXIMITY_WEIGHT) * importance;
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
  /** Ordering-only deadlines for the comparator; defaults to `deadlineByProject`. */
  orderingDeadlineByProject: Map<string, string | null> = deadlineByProject,
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

  // Overload uses the REAL deadlines (recurring's ordering-deadline must not
  // distort feasibility); the comparator uses the ordering deadlines so a due
  // recurring lane ranks as urgent.
  const overloaded = isOverloaded(schedulable, deadlineByProject, capacities, today);
  const dlOffset = (t: AllocTask) =>
    deadlineOffsetOf(orderingDeadlineByProject.get(t.projectId) ?? null, today);
  const density = (t: AllocTask) =>
    wsjf(t, orderingDeadlineByProject.get(t.projectId) ?? null, today);

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

    const dl = orderingDeadlineByProject.get(next.projectId) ?? null;
    const daysOut = dl ? daysBetween(today, dl) : null;
    order.push({
      taskId: next.id,
      title: next.title,
      projectId: next.projectId,
      projectName: next.projectName,
      estimatedMinutes: next.estimatedMinutes,
      // Carry the per-task velocity model (S2) into the order the forecast samples.
      model: next.model,
      // Carry the cognitive-load weight (S3b) so the comfort-capped flow meters it.
      difficulty: next.difficulty,
      // Carry the impact factor (S3b Phase 4) so the energy term can prefer fast windows
      // for high-value hard work; never touches the comfort cap or the odds.
      impact: next.impact,
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
 * greedy day-packing, one budget shared by all projects. With `comfortCapMinutes`
 * (OVERHAUL S3b Phase 3) the display mirrors the comfort-capped flow — hard work is
 * spread across days so the shown plan matches its comfort-priced odds; null ⇒ today's pack.
 */
export function packGlobal(
  order: EffectiveOrderEntry[],
  budget: ScheduleBudget,
  today: string,
  comfortCapMinutes?: number | null,
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
  const comfort =
    comfortCapMinutes != null
      ? { difficulty: order.map((e) => e.difficulty ?? 0), comfortCap: comfortCapMinutes }
      : undefined;
  return packBlocks(
    items,
    capacities,
    (it) => Math.max(15, it.estimatedMinutes || 30),
    { reviewBuffer: true, comfort },
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
    input.orderingDeadlineByProject,
  );
  const days = packGlobal(order, input.budget, input.today);
  return { order, days };
}

// --- Conflict detection (the pit wall) --------------------------------------

/**
 * Where a deadlined project lands in the point-estimate global plan vs. where
 * its deadline falls. `overBy > 0` means the project's last task finishes that
 * many days *after* its deadline once it has competed for the shared hours — the
 * core "can't make it" signal the pit wall reports.
 */
export interface ProjectFinish {
  projectId: string;
  projectName: string;
  /** Day offset (from today) the project's last task finishes in the global plan. */
  finishOffset: number;
  /** Day offset of the project's deadline. */
  deadlineOffset: number;
  /** finishOffset − deadlineOffset; > 0 = late under contention. */
  overBy: number;
}

/**
 * Each deadlined project's point-estimate finish vs. its deadline, under the one
 * global order. Uses `flowFinishOffsets` (the time-accurate carry the forecast
 * uses), NOT the display packer — an oversized task must spill across days here,
 * or a project would falsely "finish" on time. Pure given the order + capacities.
 */
export function projectFinishes(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
): ProjectFinish[] {
  const durations = order.map((e) => Math.max(0, e.estimatedMinutes));
  const offsets = flowFinishOffsets(durations, capacities);

  // Latest finish offset per deadlined project.
  const lastOffset = new Map<string, number>();
  const nameOf = new Map<string, string>();
  for (let k = 0; k < order.length; k++) {
    const e = order[k];
    if (!deadlineByProject.get(e.projectId)) continue; // only deadlined projects
    nameOf.set(e.projectId, e.projectName);
    const cur = lastOffset.get(e.projectId);
    if (cur === undefined || offsets[k] > cur) lastOffset.set(e.projectId, offsets[k]);
  }

  const out: ProjectFinish[] = [];
  for (const [projectId, finishOffset] of lastOffset) {
    const deadlineOffset = deadlineOffsetOf(
      deadlineByProject.get(projectId) ?? null,
      today,
    );
    out.push({
      projectId,
      projectName: nameOf.get(projectId) ?? "",
      finishOffset,
      deadlineOffset,
      overBy: finishOffset - deadlineOffset,
    });
  }
  return out;
}

/**
 * The pit-wall conflicts in the current global plan: deadlined projects that
 * can't finish in time once they've competed for the shared hours. Troubled
 * projects whose deadlines fall within `COLLISION_WINDOW_DAYS` of each other are
 * reported as a `deadline_collision` (they're fighting for the same days — the
 * case that may need a human call); a lone troubled project is `infeasible`.
 * Pure given the plan order + capacities.
 */
export function detectConflicts(
  order: EffectiveOrderEntry[],
  capacities: DayCapacity[],
  deadlineByProject: Map<string, string | null>,
  today: string,
): Conflict[] {
  const troubled = projectFinishes(order, capacities, deadlineByProject, today)
    .filter((f) => f.overBy > 0)
    // Earliest deadline first — the most urgent collision reads first.
    .sort((a, b) => a.deadlineOffset - b.deadlineOffset);
  if (troubled.length === 0) return [];

  return troubled.map((f) => {
    const collidesWith = troubled.filter(
      (o) =>
        o.projectId !== f.projectId &&
        Math.abs(o.deadlineOffset - f.deadlineOffset) <= COLLISION_WINDOW_DAYS,
    );
    const lateBy = `${f.overBy} day(s) past its deadline`;
    if (collidesWith.length > 0) {
      const others = collidesWith.map((o) => o.projectName).join(", ");
      return {
        kind: "deadline_collision",
        projectId: f.projectId,
        projectName: f.projectName,
        detail: `Competing with ${others} for the same hours — ${f.projectName} finishes ${lateBy}.`,
      };
    }
    return {
      kind: "infeasible",
      projectId: f.projectId,
      projectName: f.projectName,
      detail: `Can't finish in time — projected ${lateBy} once it shares your hours.`,
    };
  });
}

/** A task offered up for shedding, with the value density it was ranked by. */
export interface TriageCandidate {
  task: AllocTask;
  wsjf: number;
}

/**
 * The shed order: open tasks of the conflicted (over-budget) projects, lowest
 * value-density first — the lowest-WSJF "doomed" work whose hours are best spent
 * rescuing higher-value projects (locked decision #3). Blocked/done work excluded.
 *
 * Skill lanes are excluded too: a `skill:`-prefixed synthetic has no task row, so
 * shedding it here would drop it from the forecast preview but no-op on persist
 * (`updateTask` matches nothing). Parking a skill has its own move now (`defer_skill`),
 * which writes `skill_nodes.deferred`, so triage stays a real-task-only operation.
 */
export function triageCandidates(
  tasks: AllocTask[],
  conflictedProjectIds: Set<string>,
  deadlineByProject: Map<string, string | null>,
  today: string,
): TriageCandidate[] {
  return tasks
    .filter(
      (t) =>
        conflictedProjectIds.has(t.projectId) &&
        t.status !== "done" &&
        !t.id.startsWith(SKILL_TASK_PREFIX),
    )
    .map((task) => ({
      task,
      wsjf: wsjf(task, deadlineByProject.get(task.projectId) ?? null, today),
    }))
    .sort((a, b) => a.wsjf - b.wsjf || (a.task.id < b.task.id ? -1 : 1));
}

/**
 * Total cost-of-delay a project carries across its open tasks — its aggregate
 * value, used to decide whether a collision is a genuine comparable-value tie
 * that must escalate (vs. one project clearly worth protecting). Pure.
 */
export function projectValue(
  tasks: AllocTask[],
  projectId: string,
  deadlineByProject: Map<string, string | null>,
  today: string,
): number {
  const dl = deadlineByProject.get(projectId) ?? null;
  let sum = 0;
  for (const t of tasks) {
    if (t.projectId !== projectId || t.status === "done") continue;
    sum += costOfDelay(t, dl, today);
  }
  return sum;
}
