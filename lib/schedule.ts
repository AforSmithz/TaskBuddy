import type { TaskStatus } from "./types";

// Deterministic schedule generator.
// Orders tasks by dependency first, then by a schedule score derived from
// priority, and packs them into a configurable workday.

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

export interface PlannedBlock {
  task_id: string | null;
  label: string;
  start_time: string; // "HH:MM"
  end_time: string;
  reason: string;
  sort_index: number;
}

interface WorkdayConfig {
  startMinutes: number; // minutes from midnight
  endMinutes: number;
  lunchStart: number;
  lunchEnd: number;
}

const DEFAULT_DAY: WorkdayConfig = {
  startMinutes: 9 * 60, // 09:00
  endMinutes: 17 * 60, // 17:00
  lunchStart: 12 * 60, // 12:00
  lunchEnd: 13 * 60, // 13:00
};

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Build a recommended schedule.
 * - `done` and `blocked` tasks are excluded from time blocks.
 * - Tasks whose prerequisites are unscheduled wait until those run first.
 * - Within the ready set, the highest schedule score goes next.
 */
export function generateSchedule(
  tasks: SchedulableTask[],
  dependencies: DependencyEdge[],
  config: WorkdayConfig = DEFAULT_DAY,
): PlannedBlock[] {
  const schedulable = tasks.filter(
    (t) => t.status !== "done" && t.status !== "blocked",
  );
  const byId = new Map(schedulable.map((t) => [t.id, t]));

  // Dependency edges that point at another schedulable task.
  const prereqs = new Map<string, Set<string>>();
  // How many tasks each task unblocks (used in the schedule score).
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
    if (t.estimated_minutes > 0 && t.estimated_minutes <= 30 &&
        (t.impact_score ?? 0) >= 4) {
      s += 0.3; // quick win with high impact
    }
    return s;
  };

  // Topological ordering: repeatedly take the best task whose prereqs are done.
  const remaining = new Set(schedulable.map((t) => t.id));
  const done = new Set<string>();
  const order: SchedulableTask[] = [];

  while (remaining.size > 0) {
    const ready = [...remaining]
      .map((id) => byId.get(id)!)
      .filter((t) => {
        const need = prereqs.get(t.id);
        return !need || [...need].every((d) => done.has(d) || !byId.has(d));
      });

    // If a dependency cycle leaves nothing ready, fall back to all remaining.
    const pool = ready.length > 0 ? ready : [...remaining].map((id) => byId.get(id)!);
    pool.sort((a, b) => scheduleScore(b) - scheduleScore(a));

    const next = pool[0];
    order.push(next);
    remaining.delete(next.id);
    done.add(next.id);
  }

  // Pack the ordered tasks into the workday.
  const blocks: PlannedBlock[] = [];
  let cursor = config.startMinutes;
  let sort = 0;

  for (const task of order) {
    const duration = Math.max(15, task.estimated_minutes || 30);
    let start = cursor;

    // Skip the lunch break.
    if (start < config.lunchEnd && start + duration > config.lunchStart) {
      start = config.lunchEnd;
    }
    const end = start + duration;

    const reasonParts: string[] = [];
    if ((unblockCount.get(task.id) ?? 0) > 0) {
      reasonParts.push("unblocks downstream tasks");
    }
    if (prereqs.get(task.id)?.size) {
      reasonParts.push("runs after its prerequisites");
    }
    reasonParts.push(`priority ${task.priority_score.toFixed(2)}`);

    blocks.push({
      task_id: task.id,
      label: task.title,
      start_time: fmt(start),
      end_time: fmt(end),
      reason: `Scheduled here because it ${reasonParts.join(", ")}.`,
      sort_index: sort++,
    });
    cursor = end;
  }

  // Closing review/admin buffer if the day still has room.
  if (cursor < config.endMinutes) {
    const start = Math.max(cursor, config.endMinutes - 30);
    blocks.push({
      task_id: null,
      label: "Review & follow-up buffer",
      start_time: fmt(start),
      end_time: fmt(config.endMinutes),
      reason: "Reserved time to review progress and send follow-up messages.",
      sort_index: sort++,
    });
  }

  return blocks;
}
