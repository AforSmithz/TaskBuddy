import type {
  ActivityCompletion,
  Commitment,
  FactorScores,
  RecurringActivity,
  RecurringState,
  RecurringStatus,
  Task,
} from "./types";
import type { AllocTask } from "./allocate";
import { computePriority } from "./priority";

// Pure cadence/streak/miss detection for recurring activities (routines & goals).
// No I/O — every read is derived from the completion log, mirroring the
// "derive on read, never persist derived state" style of forecast.ts/allocate.ts.
//
// A routine is a daily, streak-based activity (`period: "day"`); a goal is a
// weekly session target (`period: "week"`). A COMPLETION credits the period; a
// SKIP (a completion row with `skipped: true`) resolves the period's obligation
// — it stops the drain and the nagging — without crediting a streak.

/** The synthetic project lane recurring instances ride into the global queue on. */
export const RECURRING_LANE_ID = "__recurring__";
export const RECURRING_LANE_NAME = "Routines";

const HORIZON_DAYS = 120;

// --- Date helpers (UTC-stable, mirroring forecast.ts / schedule.ts) ----------

function parseISO(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function toISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = parseISO(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}

/** Weekday of an ISO date (0=Sun .. 6=Sat), matching the availability template. */
function weekdayOf(iso: string): number {
  return parseISO(iso).getUTCDay();
}

/** Monday (ISO-week start) of the week containing `iso`. */
function weekStart(iso: string): string {
  const wd = weekdayOf(iso); // 0=Sun..6=Sat
  const sinceMonday = (wd + 6) % 7; // Mon→0, Tue→1, … Sun→6
  return addDays(iso, -sinceMonday);
}

// --- Cadence primitives ------------------------------------------------------

/** Whether the activity may run on `date` (weekday filter; null = any day). */
export function isEligible(activity: RecurringActivity, date: string): boolean {
  if (!activity.weekdays || activity.weekdays.length === 0) return true;
  return activity.weekdays.includes(weekdayOf(date));
}

export interface PeriodWindow {
  start: string;
  end: string;
}

/** The day or ISO-week window containing `date` for this activity's cadence. */
export function periodWindow(
  activity: RecurringActivity,
  date: string,
): PeriodWindow {
  const day = date.slice(0, 10);
  if (activity.period === "day") return { start: day, end: day };
  const start = weekStart(day);
  return { start, end: addDays(start, 6) };
}

function inWindow(date: string, win: PeriodWindow): boolean {
  const d = date.slice(0, 10);
  return d >= win.start && d <= win.end;
}

/** Sessions logged (done) and whether the window was skipped. */
export function windowStats(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  win: PeriodWindow,
): { done: number; skipped: boolean } {
  let done = 0;
  let skipped = false;
  for (const c of completions) {
    if (c.activity_id !== activity.id) continue;
    if (!inWindow(c.date, win)) continue;
    if (c.skipped) skipped = true;
    else done += 1;
  }
  return { done, skipped };
}

/** Sessions targeted in `win`: target_count, or 0 for a daily ineligible day. */
export function instancesExpectedInWindow(
  activity: RecurringActivity,
  win: PeriodWindow,
): number {
  if (activity.period === "day" && !isEligible(activity, win.start)) return 0;
  return activity.target_count;
}

/** Is a session owed on `date` (eligible, window unmet/un-skipped, not done today)? */
export function isDueOn(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  date: string,
): boolean {
  if (!activity.active) return false;
  if (!isEligible(activity, date)) return false;
  const win = periodWindow(activity, date);
  const { done, skipped } = windowStats(activity, completions, win);
  if (skipped) return false;
  if (done >= activity.target_count) return false;
  if (activity.period === "day") {
    // A daily instance is owed only on its own day (the window is that day).
    return true;
  }
  // A weekly goal is owed on any eligible day until the target is met.
  return true;
}

// --- Streak / progress -------------------------------------------------------

/** Consecutive eligible periods met, walking back from today (today gets grace). */
export function streak(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): number {
  return activity.period === "day"
    ? dailyStreak(activity, completions, today)
    : weeklyStreak(activity, completions, today);
}

function dailyStreak(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): number {
  const done = new Set<string>();
  const skip = new Set<string>();
  for (const c of completions) {
    if (c.activity_id !== activity.id) continue;
    (c.skipped ? skip : done).add(c.date.slice(0, 10));
  }

  let count = 0;
  let d = today;
  // Today's grace: if eligible-and-not-yet-done (no skip), step back without
  // breaking — the streak is still alive until the day actually lapses.
  if (isEligible(activity, d)) {
    if (done.has(d)) count += 1;
    else if (skip.has(d)) return count; // an explicit skip today breaks it
    // else: not done yet today — grace, fall through to walk prior days.
  }
  d = addDays(d, -1);

  for (let i = 0; i < 400; i++) {
    if (!isEligible(activity, d)) {
      d = addDays(d, -1);
      continue;
    }
    if (done.has(d)) {
      count += 1;
      d = addDays(d, -1);
      continue;
    }
    break; // an eligible day with no completion (missed or skipped) ends it
  }
  return count;
}

function weeklyStreak(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): number {
  let count = 0;
  // Current week gets grace: count it only if already met, never break on it.
  const current = periodWindow(activity, today);
  const cur = windowStats(activity, completions, current);
  if (cur.done >= activity.target_count) count += 1;

  let start = addDays(current.start, -7);
  for (let i = 0; i < 200; i++) {
    const win: PeriodWindow = { start, end: addDays(start, 6) };
    const { done, skipped } = windowStats(activity, completions, win);
    if (!skipped && done >= activity.target_count) {
      count += 1;
      start = addDays(start, -7);
      continue;
    }
    break;
  }
  return count;
}

/** Sessions done vs targeted in the current period. */
export function weeklyProgress(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): { done: number; target: number } {
  const win = periodWindow(activity, today);
  const { done } = windowStats(activity, completions, win);
  return { done, target: activity.target_count };
}

// --- Status (met / due / missed / cold) --------------------------------------

/** The most recent eligible day strictly before `today` had no completion. */
function lapsedRecently(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): boolean {
  const done = new Set<string>();
  for (const c of completions) {
    if (c.activity_id === activity.id && !c.skipped) done.add(c.date.slice(0, 10));
  }
  let d = addDays(today, -1);
  for (let i = 0; i < 14; i++) {
    if (isEligible(activity, d)) return !done.has(d);
    d = addDays(d, -1);
  }
  return false;
}

/** No non-skip completion across the two full periods before the current one. */
function coldWeekly(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): boolean {
  const current = periodWindow(activity, today);
  for (let back = 1; back <= 2; back++) {
    const start = addDays(current.start, -7 * back);
    const { done } = windowStats(activity, completions, {
      start,
      end: addDays(start, 6),
    });
    if (done > 0) return false;
  }
  return true;
}

/** Fraction of the current week elapsed, inclusive of today (1/7 .. 1). */
function weekElapsedFraction(today: string): number {
  const start = weekStart(today);
  const dayIndex = Math.round(
    (parseISO(today).getTime() - parseISO(start).getTime()) / 86_400_000,
  );
  return (dayIndex + 1) / 7;
}

/** Derived health of a recurring activity in its current period. */
export function status(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): RecurringStatus {
  const win = periodWindow(activity, today);
  const { done, skipped } = windowStats(activity, completions, win);

  if (skipped || done >= activity.target_count) return "met";

  if (activity.period === "day") {
    if (!isEligible(activity, today)) return "met"; // nothing owed today
    return lapsedRecently(activity, completions, today) ? "missed" : "due";
  }

  // Weekly goal. "Cold" only when there's been no activity recently AT ALL —
  // a session already logged this week means it's alive, just behind or on pace.
  if (done === 0 && coldWeekly(activity, completions, today)) return "cold";
  const expectedByNow = Math.floor(
    activity.target_count * weekElapsedFraction(today),
  );
  return done < expectedByNow ? "missed" : "due";
}

/** The full derived read of one activity, for the UI and the strategist. */
export function recurringStateFor(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): RecurringState {
  const win = periodWindow(activity, today);
  const { done } = windowStats(activity, completions, win);
  const doneToday = completions.some(
    (c) =>
      c.activity_id === activity.id &&
      !c.skipped &&
      c.date.slice(0, 10) === today,
  );
  return {
    activity,
    status: status(activity, completions, today),
    streak: streak(activity, completions, today),
    progress: { done, target: activity.target_count },
    doneToday,
    dueToday: isDueOn(activity, completions, today),
  };
}

// --- Capacity drain ----------------------------------------------------------

/** The factor scores an activity carries (for priority + synthetic alloc tasks). */
function activityFactors(activity: RecurringActivity): FactorScores {
  return {
    urgency: activity.urgency,
    impact: activity.impact,
    dependency: activity.dependency,
    risk: activity.risk,
    confidence: activity.confidence,
    effort: activity.effort,
  };
}

/**
 * The dates (one per owed session) an activity still owes across the horizon.
 * Daily: every eligible, unresolved day. Weekly: the remaining sessions of each
 * week window placed on its earliest eligible days at/after today. `droppedIds`
 * lets a strategist "skip" probe pretend an activity owes nothing (it drops out
 * of the drain entirely). Used both for capacity drain and the skip-move scorer.
 */
export function owedInstanceDates(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
  horizonDays: number = HORIZON_DAYS,
): string[] {
  if (!activity.active) return [];
  const out: string[] = [];
  const lastDay = addDays(today, horizonDays);

  if (activity.period === "day") {
    let d = today;
    while (d <= lastDay) {
      if (isEligible(activity, d)) {
        const { done, skipped } = windowStats(activity, completions, {
          start: d,
          end: d,
        });
        const owed = Math.max(0, activity.target_count - done);
        if (!skipped) for (let k = 0; k < owed; k++) out.push(d);
      }
      d = addDays(d, 1);
    }
    return out;
  }

  // Weekly: walk week windows from the current one forward.
  let start = weekStart(today);
  while (start <= lastDay) {
    const win: PeriodWindow = { start, end: addDays(start, 6) };
    const { done, skipped } = windowStats(activity, completions, win);
    let remaining = skipped ? 0 : Math.max(0, activity.target_count - done);
    // Place remaining sessions on the earliest eligible days at/after today.
    let d = start < today ? today : start;
    while (remaining > 0 && d <= win.end && d <= lastDay) {
      if (isEligible(activity, d)) {
        out.push(d);
        remaining -= 1;
      }
      d = addDays(d, 1);
    }
    start = addDays(start, 7);
  }
  return out;
}

/**
 * The owed instance dates of an activity within the CURRENT week (today through
 * this week's end). Skipping these is what a strategist "skip this week" move
 * frees — and exactly what the apply persists, so the probe and the action move
 * the same hours. Empty when nothing's owed this week (e.g. already done/skipped).
 */
export function currentWeekOwedDates(
  activity: RecurringActivity,
  completions: ActivityCompletion[],
  today: string,
): string[] {
  const weekEnd = addDays(weekStart(today), 6);
  // Owed dates over the next week, clamped to this week's end.
  return owedInstanceDates(activity, completions, today, 6).filter(
    (d) => d <= weekEnd,
  );
}

/**
 * Recurring activities as synthetic commitments draining the shared budget,
 * `estimated_minutes` per owed session on the day it's expected. Folded into the
 * real commitment set in `getTimeBudget`, so `dayCapacities`/`deployableMinutes`
 * see the eaten time everywhere — the single source of truth for recurring
 * capacity cost (the agenda's synthetic task is display-only, never re-counted).
 * `droppedIds` excludes activities a strategist skip-move is probing.
 */
export function activityDrainCommitments(
  activities: RecurringActivity[],
  completions: ActivityCompletion[],
  today: string,
  horizonDays: number = HORIZON_DAYS,
  droppedIds: Set<string> = new Set(),
): Pick<Commitment, "date" | "hours">[] {
  const minutesByDate = new Map<string, number>();
  for (const activity of activities) {
    if (!activity.active || droppedIds.has(activity.id)) continue;
    for (const date of owedInstanceDates(
      activity,
      completions,
      today,
      horizonDays,
    )) {
      minutesByDate.set(
        date,
        (minutesByDate.get(date) ?? 0) + activity.estimated_minutes,
      );
    }
  }
  return [...minutesByDate.entries()].map(([date, minutes]) => ({
    date,
    hours: minutes / 60,
  }));
}

// --- Synthetic queue tasks (today's due instances) ---------------------------

/**
 * One synthetic `AllocTask` per activity with an instance due today — the rows
 * that surface routines/goals in the Now/Next agenda. These ride the reserved
 * `RECURRING_LANE_ID` lane and are DISPLAY/ORDER-ONLY: their minutes are already
 * drained via `activityDrainCommitments`, so they must be kept out of the
 * forecast's capacity math (locked invariant #1).
 */
export function recurringAllocTasksForToday(
  activities: RecurringActivity[],
  completions: ActivityCompletion[],
  today: string,
): AllocTask[] {
  const out: AllocTask[] = [];
  for (const activity of activities) {
    if (!isDueOn(activity, completions, today)) continue;
    const f = activityFactors(activity);
    out.push({
      id: `recurring:${activity.id}:${today}`,
      title: activity.title,
      projectId: RECURRING_LANE_ID,
      projectName: RECURRING_LANE_NAME,
      estimatedMinutes: activity.estimated_minutes,
      status: "todo",
      priorityScore: computePriority(f).score,
      urgency: activity.urgency,
      impact: activity.impact,
      risk: activity.risk,
    });
  }
  return out;
}

/** Extract the activity id from a synthetic recurring task id, or null. */
export function activityIdFromTaskId(taskId: string): string | null {
  if (!taskId.startsWith("recurring:")) return null;
  return taskId.split(":")[1] ?? null;
}

/** Whether a task id belongs to a synthetic recurring instance. */
export function isRecurringTaskId(taskId: string): boolean {
  return taskId.startsWith("recurring:");
}

/**
 * A synthetic `Task`-shaped row for an activity due today — the object the Today
 * agenda renders interleaved with real tasks. Its id matches the agenda-order
 * entry from `recurringAllocTasksForToday`; `due_date` is today so it buckets
 * under "Due today". Carries no `entry_id` (it has no entry) — the agenda routes
 * its actions to the activity, not the task table.
 */
export function recurringAgendaTask(
  activity: RecurringActivity,
  today: string,
): Task {
  const f = activityFactors(activity);
  const { score, label } = computePriority(f);
  return {
    id: `recurring:${activity.id}:${today}`,
    entry_id: "",
    goal_id: null, // synthetic recurring lane — owned by an activity, not a goal
    title: activity.title,
    description: null,
    owner: null,
    category: null,
    area: activity.area,
    status: "todo",
    due_date: today,
    estimated_minutes: activity.estimated_minutes,
    actual_minutes: 0,
    urgency_score: activity.urgency,
    impact_score: activity.impact,
    effort_score: activity.effort,
    dependency_score: activity.dependency,
    risk_score: activity.risk,
    confidence_score: activity.confidence,
    priority_score: score,
    priority_label: label,
    priority_reason: null,
    source_quote: null,
    is_ai_suggested: false,
    blocked_by: null,
    deferred: false,
    completion_confidence: null,
    completed_at: null,
    origin: null,
    resolved_by: null,
    sort_index: 0,
    created_at: activity.created_at,
  };
}
