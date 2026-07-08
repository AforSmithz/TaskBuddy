import "server-only";
import { createHash } from "crypto";
import { cookies } from "next/headers";
import type {
  GoalKind,
  SkillNode,
  ExtractedSkill,
  ActivityCadencePeriod,
  ActivityCompletion,
  WorkSession,
  WorkSessionLocal,
  Availability,
  AvailabilityOverride,
  CauseDiagnosis,
  Commitment,
  CompletionConfidence,
  Conflict,
  PitWallOption,
  Decision,
  DivergenceReason,
  DraftClassification,
  EffectiveOrderEntry,
  EntryKind,
  EntryStatus,
  DegradedCriterion,
  Entry,
  EntryDetail,
  EstimationModel,
  FactorScores,
  ForecastResult,
  GoalCriterion,
  OpenQuestion,
  CommittedPlan,
  LocalNow,
  PitCall,
  PlanVersion,
  PlanRoll,
  PlanRollKind,
  PlanReorder,
  PortfolioStrategy,
  Goal,
  ProjectForecast,
  RecoveryPlan,
  RecurringActivity,
  RecurringState,
  ReroutePart,
  RescheduleMove,
  RowSnapshot,
  StrategyMove,
  StrategyMoveKind,
  StrategyMovePayload,
  SuggestedTask,
  Task,
  TaskDependency,
  TaskModification,
  TaskOrigin,
  TaskStatus,
  TriageMove,
} from "./types";
import { COMMITTED_PLAN_SCHEMA_VERSION, ON_TRACK_PROBABILITY, isOnTrack } from "./types";
import { extractEntry } from "./extraction";
import { estimationModel } from "./generate";
import {
  energyWindows,
  fitVelocityModel,
  taskResidualSamples,
  toSegmentModel,
  workSessionResidualSamples,
  type ResidualSample,
  type VelocityModel,
} from "./velocity";
import { goalCompletion } from "./goal";
import { diagnoseCause, goalCutCost, type CauseBaseline } from "./grounding";
import { bufferUrgency, isBufferLow } from "./buffer";
import { formatMinutes } from "./format";
import { computePriority } from "./priority";
import {
  dayCapacities,
  daySlackHours,
  generateSchedule,
  orderSchedulableTasks,
  type DependencyEdge,
  type ScheduleDay,
  type SchedulableTask,
} from "./schedule";
import {
  deployableMinutes,
  earliestAchievableDeadline,
  forecast,
  globalForecast,
  globalForecastJoint,
  recoveryMoves,
  type CandidateTask,
  type ForecastOptions,
} from "./forecast";
import {
  buildGlobalPlan,
  detectConflicts,
  effortToDifficulty,
  packGlobal,
  projectValue,
  triageCandidates,
  type AllocTask,
  type GlobalPlan,
} from "./allocate";
import {
  arrangementScore,
  comfortSmooth,
  gatedReorder,
  windowCapacities,
  windowProfileFromEnergy,
  type ArrangeOrderOptions,
  type ComfortSmoothResult,
  type GatedReorderResult,
  type WindowProfile,
} from "./arrange";
import {
  rollDecision,
  planRollKind,
  undoRollDecision,
  calibrateHysteresis,
  type RollContext,
  type RollDecisionResult,
  type CalibratedHysteresis,
} from "./rolling";
import {
  SAMPLE_ACTIVITIES,
  SAMPLE_ENTRIES,
  SAMPLE_GOAL_CRITERIA,
  SAMPLE_PROJECTS,
  sampleActivityCompletions,
} from "./sample-data";
import {
  currentWeekOwedDates,
  recurringAllocTasksForToday,
  recurringStateFor,
  RECURRING_LANE_ID,
} from "./recurring";
import {
  areaWeight,
  normalizeValueModel,
  DEFAULT_VALUE_MODEL,
  type ValueModel,
} from "./value-model";
import {
  normalizeWindowAvailability,
  windowShareOverride,
  EMPTY_WINDOW_AVAILABILITY,
  type WindowAvailability,
} from "./window-availability";
import {
  forecastOptions,
  drainAsCommitments,
  syntheticAllocTask,
  jointOddsWithMoves,
  cumulativeJointOdds,
  SKILL_TASK_PREFIX,
  type AllocContext,
  type ResolveInput,
} from "./portfolio-state";
import { getRequestClient } from "./supabase";

// Central data layer.
// Uses Supabase when configured; otherwise an in-memory store seeded with
// sample data so the app is fully demoable without any backend setup.
// Every Supabase query runs through a request-scoped client carrying the
// user's session, so Row Level Security scopes reads and writes to that user.

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}

type RequestClient = Awaited<ReturnType<typeof getRequestClient>>;

/** Id of the signed-in user, or throw — used to stamp ownership on inserts. */
async function currentUserId(supabase: RequestClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be signed in to do that.");
  return user.id;
}

// --- In-memory store (survives HMR via globalThis) --------------------------

interface MemDB {
  projects: Goal[];
  /** Definition-of-done criteria, keyed by goal_id on each row. */
  goalCriteria: GoalCriterion[];
  /** Skill-graph nodes for learning goals, keyed by goal_id on each row. */
  skillNodes: SkillNode[];
  entries: Entry[];
  decisions: Decision[];
  questions: OpenQuestion[];
  tasks: Task[];
  deps: TaskDependency[];
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
  /** Recurring activities (routines & goals) — the whole-life sources. */
  recurringActivities: RecurringActivity[];
  /** Logged sessions/skips of recurring activities — the completion log. */
  activityCompletions: ActivityCompletion[];
  /** Real work sessions — the local when-signal the velocity loop accrues (S2). */
  workSessions: WorkSession[];
  /** Whether the pit-wall strategist auto-applies obvious triage (vs. surfacing it). */
  autoStrategy: boolean;
  /** The user's value model (importance weights + recovery style), or null => default. */
  valueModel: ValueModel | null;
  /** Explicit per-window availability override (S3b Phase 4), or null => derived share. */
  windowAvailability: WindowAvailability | null;
  /** The cached portfolio strategy (Phase 4), or null until first generated. */
  portfolioStrategy: PortfolioStrategy | null;
  /** Applied strategy bundles, newest-first — the plan version history (§1.3). */
  planVersions: PlanVersion[];
  /** The plan the user is currently following — the rolling-horizon committed row
   *  (S3c-1), or null until first committed. */
  committedPlan: CommittedPlan | null;
  /** Retained automatic rolls of the committed plan, newest-first — the passive-roll
   *  history (S3c-2), capped at `PLAN_ROLL_CAP`. */
  planRolls: PlanRoll[];
  /** Captured drag-to-reorder preference pairs, newest-first — the 🔴-tier calibration
   *  signal (S3c-5), capped at `PLAN_REORDER_CAP`. */
  planReorders: PlanReorder[];
  seeded: boolean;
}

/** Sensible starting template: ~4 focus-hours on weekdays, nothing on weekends. */
const DEFAULT_AVAILABILITY: Availability[] = [0, 1, 2, 3, 4, 5, 6].map(
  (weekday) => ({ weekday, hours: weekday >= 1 && weekday <= 5 ? 4 : 0 }),
);

const g = globalThis as typeof globalThis & { __taskbuddyDB?: MemDB };

function memDB(): MemDB {
  if (!g.__taskbuddyDB) {
    g.__taskbuddyDB = {
      projects: [],
      goalCriteria: [],
      skillNodes: [],
      entries: [],
      decisions: [],
      questions: [],
      tasks: [],
      deps: [],
      availability: DEFAULT_AVAILABILITY.map((a) => ({ ...a })),
      overrides: [],
      commitments: [],
      recurringActivities: [],
      activityCompletions: [],
      workSessions: [],
      windowAvailability: null,
      autoStrategy: false,
      valueModel: null,
      portfolioStrategy: null,
      planVersions: [],
      committedPlan: null,
      planRolls: [],
      planReorders: [],
      seeded: false,
    };
  }
  return g.__taskbuddyDB;
}

/** Today as an ISO `YYYY-MM-DD` date. */
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Overlay stored weekday hours on the default template so all 7 days exist. */
function mergeAvailability(stored: Availability[]): Availability[] {
  const byDay = new Map<number, number>(
    DEFAULT_AVAILABILITY.map((a) => [a.weekday, a.hours]),
  );
  for (const a of stored) byDay.set(a.weekday, a.hours);
  return [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
    weekday,
    hours: byDay.get(weekday) ?? 0,
  }));
}

// --- Assembly: raw notes -> fully scored & scheduled entry ------------------

interface AssembledEntry {
  entry: Entry;
  decisions: Decision[];
  questions: OpenQuestion[];
  tasks: Task[];
  deps: TaskDependency[];
}

export interface AssembleOptions {
  kind?: EntryKind;
  /**
   * Life-area applied to every extracted task (Today-page tabs). When omitted,
   * the area the extractor suggests for the entry is used.
   */
  area?: string;
  projectId?: string | null;
  /**
   * When true and no explicit project is given, attach the entry to the
   * project the extractor suggests — reusing an existing project of that name
   * or creating a new one.
   */
  autoProject?: boolean;
  parentEntryId?: string | null;
  status?: EntryStatus;
  createdAt?: string;
}

/**
 * Runs the full pipeline on raw input:
 * extract -> score priority -> resolve dependencies.
 * Every row is assigned a UUID up front so it can be persisted directly. The
 * recommended schedule is *not* part of this — it's a derived view computed on
 * read from live tasks + availability (see `getEntrySchedule`).
 */
export async function assembleEntry(
  rawInput: string,
  opts: AssembleOptions = {},
): Promise<AssembledEntry> {
  const kind = opts.kind ?? "meeting";
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const entryId = crypto.randomUUID();

  // When the project is left to TaskBuddy, fetch existing projects so the
  // extractor can reuse one by name and so a suggestion can be resolved below.
  // Skipped otherwise — notably during seeding, where listGoals() would
  // re-enter ensureSeeded().
  const resolveProject = opts.autoProject && !opts.projectId;
  const projects = resolveProject ? await listGoals() : [];
  const { result } = await extractEntry(rawInput, kind, {
    projectNames: projects.map((p) => p.name),
  });

  // Area: an explicit choice wins; otherwise use the extractor's suggestion.
  const area = opts.area ?? result.suggested_area ?? "Work";

  // Goal: an explicit choice wins; otherwise, when auto-filing, attach to
  // the suggested project — reusing an existing one of that name if it exists.
  let projectId = opts.projectId ?? null;
  if (resolveProject && result.suggested_project) {
    const name = result.suggested_project.trim();
    const match = projects.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    projectId = match ? match.id : await createGoal(name);
  }

  const entry: Entry = {
    id: entryId,
    title: result.title,
    raw_input: rawInput,
    summary: result.summary,
    discussion_points: result.discussion_points,
    stakeholders: result.stakeholders,
    daily_objective: result.daily_objective,
    key_deliverables: result.key_deliverables,
    assumptions: result.assumptions,
    risks: result.risks,
    kind,
    status: opts.status ?? "active",
    goal_id: projectId,
    parent_entry_id: opts.parentEntryId ?? null,
    created_at: createdAt,
  };

  const decisions: Decision[] = result.decisions.map((d) => ({
    id: crypto.randomUUID(),
    entry_id: entryId,
    decision: d.decision,
    source_quote: d.source_quote,
    confidence: d.confidence,
    created_at: createdAt,
  }));

  const questions: OpenQuestion[] = result.open_questions.map((q) => ({
    id: crypto.randomUUID(),
    entry_id: entryId,
    question: q.question,
    related_stakeholder: q.related_stakeholder,
    source_quote: q.source_quote,
    confidence: q.confidence,
    status: "open",
    created_at: createdAt,
  }));

  // Map the LLM's task `key` slugs to generated UUIDs for dependency wiring.
  const keyToId = new Map<string, string>();
  for (const t of result.tasks) keyToId.set(t.key, crypto.randomUUID());

  const tasks: Task[] = result.tasks.map((t, i) => {
    const { score, label } = computePriority(t);
    return {
      id: keyToId.get(t.key)!,
      entry_id: entryId,
      // The owning goal (the spine). Null on a draft until the goal is confirmed.
      goal_id: projectId,
      title: t.title,
      description: t.description,
      owner: t.owner,
      category: t.category,
      area,
      status: (t.blocked_by ? "blocked" : "todo") as TaskStatus,
      due_date: t.due_date,
      estimated_minutes: t.estimated_minutes,
      actual_minutes: 0,
      urgency_score: t.urgency,
      impact_score: t.impact,
      effort_score: t.effort,
      dependency_score: t.dependency,
      risk_score: t.risk,
      confidence_score: t.confidence,
      priority_score: score,
      priority_label: label,
      priority_reason: t.priority_reason,
      source_quote: t.source_quote,
      is_ai_suggested: t.is_ai_suggested,
      blocked_by: t.blocked_by,
      deferred: false,
      completion_confidence: null,
      completed_at: null,
      origin: null,
      resolved_by: null,
      sort_index: i,
      created_at: createdAt,
    };
  });

  const deps: TaskDependency[] = [];
  for (const t of result.tasks) {
    const taskId = keyToId.get(t.key)!;
    for (const depKey of t.depends_on) {
      const dependsOnId = keyToId.get(depKey);
      if (dependsOnId && dependsOnId !== taskId) {
        deps.push({
          id: crypto.randomUUID(),
          entry_id: entryId,
          task_id: taskId,
          depends_on_task_id: dependsOnId,
          reason: null,
        });
      }
    }
  }

  return { entry, decisions, questions, tasks, deps };
}

// --- Projects ---------------------------------------------------------------

export async function createGoal(
  name: string,
  description: string | null = null,
  kind: GoalKind = "project",
): Promise<string> {
  const project: Goal = {
    id: crypto.randomUUID(),
    name,
    description,
    kind,
    deadline: null,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("goals")
      .insert({ ...project, user_id });
    if (error) throw new Error(`Supabase project insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().projects.unshift(project);
  }
  return project.id;
}

export async function listGoals(): Promise<Goal[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("goals")
      .select("*")
      .order("created_at", { ascending: false });
    return (data as Goal[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().projects].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

export async function getGoal(id: string): Promise<Goal | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("goals")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return (data as Goal) ?? null;
  }
  await ensureSeeded();
  return memDB().projects.find((p) => p.id === id) ?? null;
}

/** Reclassify a goal as a project or a learning goal. */
export async function setGoalKind(id: string, kind: GoalKind): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase
      .from("goals")
      .update({ kind })
      .eq("id", id);
    if (error) throw new Error(`Supabase goal kind update failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const goal = memDB().projects.find((p) => p.id === id);
  if (goal) goal.kind = kind;
}

// --- Definition of done (goal criteria) -------------------------------------

/** A goal's definition-of-done criteria, in display order. */
export async function listGoalCriteria(
  goalId: string,
): Promise<GoalCriterion[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("goal_criteria")
      .select("*")
      .eq("goal_id", goalId)
      .order("sort_index", { ascending: true });
    return (data as GoalCriterion[]) ?? [];
  }
  await ensureSeeded();
  return memDB()
    .goalCriteria.filter((c) => c.goal_id === goalId)
    .sort((a, b) => a.sort_index - b.sort_index);
}

/** Append a new (unmet) criterion to a goal's definition of done. */
export async function addGoalCriterion(
  goalId: string,
  text: string,
): Promise<void> {
  const existing = await listGoalCriteria(goalId);
  const row: GoalCriterion = {
    id: crypto.randomUUID(),
    goal_id: goalId,
    text: text.trim(),
    met: false,
    met_confidence: null,
    degraded_note: null,
    sort_index: existing.length,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase.from("goal_criteria").insert(row);
    if (error)
      throw new Error(`Supabase goal_criteria insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().goalCriteria.push(row);
  }
}

/**
 * Mark a criterion met (at a given confidence) or unmet. Clearing `met` also
 * clears the recorded confidence.
 */
export async function setGoalCriterionMet(
  id: string,
  met: boolean,
  confidence: CompletionConfidence | null,
): Promise<void> {
  const patch = {
    met,
    met_confidence: met ? confidence : null,
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase
      .from("goal_criteria")
      .update(patch)
      .eq("id", id);
    if (error)
      throw new Error(`Supabase goal_criteria update failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const row = memDB().goalCriteria.find((c) => c.id === id);
  if (row) Object.assign(row, patch);
}

/** Remove a criterion from a goal's definition of done. */
export async function removeGoalCriterion(id: string): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase
      .from("goal_criteria")
      .delete()
      .eq("id", id);
    if (error)
      throw new Error(`Supabase goal_criteria delete failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.goalCriteria = db.goalCriteria.filter((c) => c.id !== id);
}

/**
 * Record how a scope-cutting recovery move degraded a criterion (§5 grounding
 * gate check 2). The original `text` is left intact; `degraded_note` carries the
 * compromise (e.g. "now: managed provider, no SSO"). Passing null clears it.
 */
export async function setGoalCriterionDegraded(
  id: string,
  note: string | null,
): Promise<void> {
  const degraded_note = note?.trim() || null;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase
      .from("goal_criteria")
      .update({ degraded_note })
      .eq("id", id);
    if (error)
      throw new Error(`Supabase goal_criteria update failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const row = memDB().goalCriteria.find((c) => c.id === id);
  if (row) row.degraded_note = degraded_note;
}

/** Every definition-of-done criterion across all goals — the forecast gather's
 *  bulk read (one query instead of N), so divergence detection sees real DoD. */
export async function listAllGoalCriteria(): Promise<GoalCriterion[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("goal_criteria")
      .select("*")
      .order("sort_index", { ascending: true });
    return (data as GoalCriterion[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().goalCriteria].sort((a, b) => a.sort_index - b.sort_index);
}

// --- Skill graph (learning-goal decomposer) ---------------------------------

/** A learning goal's skill nodes, oldest-first (already in graph order). */
export async function listSkillNodes(goalId: string): Promise<SkillNode[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("skill_nodes")
      .select("*")
      .eq("goal_id", goalId)
      .order("sort_index", { ascending: true });
    return (data as SkillNode[]) ?? [];
  }
  await ensureSeeded();
  return memDB()
    .skillNodes.filter((n) => n.goal_id === goalId)
    .sort((a, b) => a.sort_index - b.sort_index);
}

/** Every skill node across all goals — the forecast gather's bulk read (one query
 *  instead of N), so a learning goal's effort can enter the joint forecast. */
export async function listAllSkillNodes(): Promise<SkillNode[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("skill_nodes")
      .select("*")
      .order("sort_index", { ascending: true });
    return (data as SkillNode[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().skillNodes].sort((a, b) => a.sort_index - b.sort_index);
}

/**
 * Persist a freshly decomposed skill graph for a goal, replacing any prior plan.
 * Maps the decomposer's `key` slugs to UUIDs so `prerequisites` becomes a graph
 * of real ids (exactly how task `depends_on` keys are wired in `assembleEntry`).
 */
export async function replaceSkillNodes(
  goalId: string,
  skills: ExtractedSkill[],
): Promise<void> {
  const createdAt = new Date().toISOString();
  const keyToId = new Map<string, string>();
  for (const s of skills) keyToId.set(s.key, crypto.randomUUID());

  const nodes: SkillNode[] = skills.map((s, i) => ({
    id: keyToId.get(s.key)!,
    goal_id: goalId,
    title: s.title,
    description: s.description || null,
    prerequisites: s.prerequisites
      .map((k) => keyToId.get(k))
      .filter((id): id is string => Boolean(id)),
    is_checkpoint: s.is_checkpoint,
    estimated_minutes: s.estimated_minutes,
    attained: false,
    attained_confidence: null,
    attained_at: null,
    sort_index: i,
    created_at: createdAt,
  }));

  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase.from("skill_nodes").delete().eq("goal_id", goalId);
    if (nodes.length) {
      const { error } = await supabase.from("skill_nodes").insert(nodes);
      if (error)
        throw new Error(`Supabase skill_nodes insert failed: ${error.message}`);
    }
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.skillNodes = db.skillNodes.filter((n) => n.goal_id !== goalId);
  db.skillNodes.push(...nodes);
}

/**
 * Mark a skill attained (at a confidence) or not-yet. Clearing attainment also
 * clears the recorded confidence and timestamp — mirrors task completion.
 */
export async function setSkillNodeAttained(
  id: string,
  attained: boolean,
  confidence: CompletionConfidence | null,
): Promise<void> {
  const patch = {
    attained,
    attained_confidence: attained ? confidence : null,
    attained_at: attained ? new Date().toISOString() : null,
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase
      .from("skill_nodes")
      .update(patch)
      .eq("id", id);
    if (error)
      throw new Error(`Supabase skill_nodes update failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const row = memDB().skillNodes.find((n) => n.id === id);
  if (row) Object.assign(row, patch);
}

// --- Entries (meetings & plans) ---------------------------------------------

/** Assemble raw input into a draft entry awaiting review. Returns its id. */
export async function createDraft(
  rawInput: string,
  opts: AssembleOptions = {},
): Promise<string> {
  const assembled = await assembleEntry(rawInput, {
    ...opts,
    status: "draft",
  });
  if (isSupabaseConfigured()) {
    await persistSupabase(assembled);
  } else {
    await ensureSeeded();
    const db = memDB();
    db.entries.unshift(assembled.entry);
    db.decisions.push(...assembled.decisions);
    db.questions.push(...assembled.questions);
    db.tasks.push(...assembled.tasks);
    db.deps.push(...assembled.deps);
  }
  return assembled.entry.id;
}

/**
 * Finalise a draft: drop the declined tasks, apply the filing the user
 * confirmed in the review step (category, project, follow-up), and flip the
 * entry to active. The schedule is derived on read, so nothing to rebuild here.
 */
export async function confirmDraft(
  entryId: string,
  declinedTaskIds: string[],
  classification: DraftClassification,
): Promise<void> {
  const declined = new Set(declinedTaskIds);

  // Resolve the confirmed filing. A new project is created on demand; a
  // follow-up link to the entry itself is rejected defensively.
  const projectId = classification.newProjectName
    ? await createGoal(
        classification.newProjectName,
        null,
        classification.newProjectKind,
      )
    : classification.projectId;
  const parentEntryId =
    classification.parentEntryId &&
    classification.parentEntryId !== entryId
      ? classification.parentEntryId
      : null;
  const area = classification.area.trim() || "Work";

  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    if (declined.size) {
      // Cascades remove dependency edges for these tasks.
      await supabase
        .from("tasks")
        .delete()
        .in("id", [...declined]);
    }
    // Stamp the confirmed goal onto the entry's tasks (the spine edge) along
    // with the chosen area.
    await supabase
      .from("tasks")
      .update({ area, goal_id: projectId })
      .eq("entry_id", entryId);
    await supabase
      .from("entries")
      .update({
        status: "active",
        goal_id: projectId,
        parent_entry_id: parentEntryId,
      })
      .eq("id", entryId);
    return;
  }

  await ensureSeeded();
  const db = memDB();
  const entry = db.entries.find((m) => m.id === entryId);
  if (!entry) return;
  db.tasks = db.tasks.filter((t) => !declined.has(t.id));
  db.deps = db.deps.filter(
    (d) => !declined.has(d.task_id) && !declined.has(d.depends_on_task_id),
  );
  const survivors = db.tasks.filter((t) => t.entry_id === entryId);
  for (const t of survivors) {
    t.area = area;
    t.goal_id = projectId;
  }
  entry.status = "active";
  entry.goal_id = projectId;
  entry.parent_entry_id = parentEntryId;
}

/** Delete a draft entirely (used when the user discards it during review). */
export async function discardDraft(entryId: string): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    // Child rows cascade on entry delete.
    await supabase.from("entries").delete().eq("id", entryId);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.entries = db.entries.filter((m) => m.id !== entryId);
  db.decisions = db.decisions.filter((d) => d.entry_id !== entryId);
  db.questions = db.questions.filter((q) => q.entry_id !== entryId);
  db.tasks = db.tasks.filter((t) => t.entry_id !== entryId);
  db.deps = db.deps.filter((d) => d.entry_id !== entryId);
}

export async function listEntries(): Promise<Entry[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("entries")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false });
    return (data as Entry[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().entries]
    .filter((m) => m.status === "active")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getEntry(id: string): Promise<EntryDetail | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data: entry } = await supabase
      .from("entries")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!entry) return null;
    const [decisions, questions, tasks, deps] = await Promise.all([
      supabase.from("decisions").select("*").eq("entry_id", id),
      supabase.from("open_questions").select("*").eq("entry_id", id),
      supabase
        .from("tasks")
        .select("*")
        .eq("entry_id", id)
        .order("sort_index"),
      supabase.from("task_dependencies").select("*").eq("entry_id", id),
    ]);
    return {
      ...(entry as Entry),
      decisions: (decisions.data as Decision[]) ?? [],
      open_questions: (questions.data as OpenQuestion[]) ?? [],
      tasks: (tasks.data as Task[]) ?? [],
      dependencies: (deps.data as TaskDependency[]) ?? [],
    };
  }

  await ensureSeeded();
  const db = memDB();
  const entry = db.entries.find((m) => m.id === id);
  if (!entry) return null;
  return {
    ...entry,
    decisions: db.decisions.filter((d) => d.entry_id === id),
    open_questions: db.questions.filter((q) => q.entry_id === id),
    tasks: db.tasks
      .filter((t) => t.entry_id === id)
      .sort((a, b) => a.sort_index - b.sort_index),
    dependencies: db.deps.filter((d) => d.entry_id === id),
  };
}

/**
 * The recommended schedule for an entry, derived live from its open tasks +
 * current availability. Multi-day, anchored at today; never persisted, so it
 * always reflects the latest estimates and time budget.
 */
export async function getEntrySchedule(
  entry: EntryDetail,
): Promise<ScheduleDay[]> {
  const budget = await getTimeBudget();
  const tasks: SchedulableTask[] = entry.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    estimated_minutes: t.estimated_minutes,
    priority_score: t.priority_score ?? 0,
    impact_score: t.impact_score,
    status: t.status,
  }));
  const deps: DependencyEdge[] = entry.dependencies.map((d) => ({
    task_id: d.task_id,
    depends_on_task_id: d.depends_on_task_id,
  }));
  return generateSchedule(
    tasks,
    deps,
    {
      availability: budget.availability,
      overrides: budget.overrides,
      commitments: budget.commitments,
    },
    todayISO(),
  );
}

/** All tasks belonging to active (non-draft) entries. */
export async function listAllTasks(): Promise<Task[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data: active } = await supabase
      .from("entries")
      .select("id")
      .eq("status", "active");
    const ids = ((active as { id: string }[]) ?? []).map((m) => m.id);
    if (ids.length === 0) return [];
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .in("entry_id", ids)
      .order("created_at", { ascending: false });
    return (data as Task[]) ?? [];
  }
  await ensureSeeded();
  const db = memDB();
  const draftIds = new Set(
    db.entries.filter((m) => m.status === "draft").map((m) => m.id),
  );
  return db.tasks.filter((t) => !draftIds.has(t.entry_id));
}

/** All dependency edges belonging to active (non-draft) entries. */
export async function listAllDependencies(): Promise<TaskDependency[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data: active } = await supabase
      .from("entries")
      .select("id")
      .eq("status", "active");
    const ids = ((active as { id: string }[]) ?? []).map((m) => m.id);
    if (ids.length === 0) return [];
    const { data } = await supabase
      .from("task_dependencies")
      .select("*")
      .in("entry_id", ids);
    return (data as TaskDependency[]) ?? [];
  }
  await ensureSeeded();
  const db = memDB();
  const draftIds = new Set(
    db.entries.filter((m) => m.status === "draft").map((m) => m.id),
  );
  return db.deps.filter((d) => !draftIds.has(d.entry_id));
}

export async function updateTask(
  id: string,
  patch: Partial<
    Pick<
      Task,
      | "status"
      | "actual_minutes"
      | "blocked_by"
      | "area"
      | "deferred"
      | "due_date"
      // Confidence-tagged completion (set when status → done, cleared on reopen).
      | "completion_confidence"
      | "completed_at"
      // Blocker-resolution provenance (set by a resolve_blocker cascade, cleared on
      // reopen/undo). §5.6 slice 6b.
      | "resolved_by"
      // Reshaped in place by the strategist's scope-down move.
      | "title"
      | "description"
      | "estimated_minutes"
    >
  >,
): Promise<Task | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("tasks")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    return (data as Task) ?? null;
  }
  await ensureSeeded();
  const task = memDB().tasks.find((t) => t.id === id);
  if (!task) return null;
  Object.assign(task, patch);
  return task;
}

// --- Seeding & Supabase persistence ----------------------------------------

let seedPromise: Promise<void> | null = null;

async function ensureSeeded(): Promise<void> {
  const db = memDB();
  if (db.seeded) return;
  if (!seedPromise) {
    seedPromise = (async () => {
      db.projects.push(...SAMPLE_PROJECTS);
      db.goalCriteria.push(...SAMPLE_GOAL_CRITERIA);
      for (const sample of SAMPLE_ENTRIES) {
        const assembled = await assembleEntry(sample.notes, {
          kind: sample.kind,
          area: sample.area,
          projectId: sample.projectId,
          createdAt: sample.createdAt,
        });
        db.entries.push(assembled.entry);
        db.decisions.push(...assembled.decisions);
        db.questions.push(...assembled.questions);
        db.tasks.push(...assembled.tasks);
        db.deps.push(...assembled.deps);
      }
      db.recurringActivities.push(...SAMPLE_ACTIVITIES.map((a) => ({ ...a })));
      db.activityCompletions.push(...sampleActivityCompletions(todayISO()));
      db.seeded = true;
    })();
  }
  await seedPromise;
}

async function persistSupabase(a: AssembledEntry): Promise<void> {
  const supabase = await getRequestClient();
  const user_id = await currentUserId(supabase);
  const err = (label: string, e: { message: string } | null) => {
    if (e) throw new Error(`Supabase ${label} insert failed: ${e.message}`);
  };
  // Only the entry carries user_id; child rows inherit ownership through it
  // (see the RLS policies in supabase/schema.sql).
  err(
    "entry",
    (await supabase.from("entries").insert({ ...a.entry, user_id })).error,
  );
  if (a.decisions.length)
    err("decisions", (await supabase.from("decisions").insert(a.decisions)).error);
  if (a.questions.length)
    err(
      "open_questions",
      (await supabase.from("open_questions").insert(a.questions)).error,
    );
  if (a.tasks.length)
    err("tasks", (await supabase.from("tasks").insert(a.tasks)).error);
  if (a.deps.length)
    err(
      "task_dependencies",
      (await supabase.from("task_dependencies").insert(a.deps)).error,
    );
}

// --- Time budget ------------------------------------------------------------

/** Set (or clear) a project's deadline — the forecast's finish line. */
export async function setProjectDeadline(
  projectId: string,
  deadline: string | null,
): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase.from("goals").update({ deadline }).eq("id", projectId);
    return;
  }
  await ensureSeeded();
  const p = memDB().projects.find((x) => x.id === projectId);
  if (p) p.deadline = deadline;
}

/** The user's weekly availability template — all 7 weekdays, defaults merged in. */
export async function getAvailability(): Promise<Availability[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase.from("availability").select("*");
    return mergeAvailability((data as Availability[]) ?? []);
  }
  await ensureSeeded();
  return mergeAvailability(memDB().availability);
}

/** Upsert one or more weekdays of the availability template. */
export async function setAvailability(
  rows: { weekday: number; hours: number }[],
): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const payload = rows.map((r) => ({
      user_id,
      weekday: r.weekday,
      hours: Math.max(0, r.hours),
    }));
    const { error } = await supabase
      .from("availability")
      .upsert(payload, { onConflict: "user_id,weekday" });
    if (error)
      throw new Error(`Supabase availability upsert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  for (const r of rows) {
    const existing = db.availability.find((a) => a.weekday === r.weekday);
    if (existing) existing.hours = Math.max(0, r.hours);
    else db.availability.push({ weekday: r.weekday, hours: Math.max(0, r.hours) });
  }
}

/**
 * The pit-wall automation mode. On = auto applies the obvious low-value triage
 * itself and escalates only genuine ties; off = surface every option, never
 * auto-apply (locked decision #3). Off by default — the conservative choice, so
 * a new user is never surprised by tasks the strategist deferred on its own.
 */
export async function getAutoStrategy(): Promise<boolean> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("user_settings")
      .select("auto_strategy")
      .maybeSingle();
    return (data as { auto_strategy?: boolean } | null)?.auto_strategy ?? false;
  }
  await ensureSeeded();
  return memDB().autoStrategy;
}

/** Set the pit-wall automation mode (one row per user, upserted). */
export async function setAutoStrategy(value: boolean): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("user_settings")
      .upsert(
        { user_id, auto_strategy: value, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error)
      throw new Error(`Supabase user_settings upsert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().autoStrategy = value;
}

/** The user's value model — importance weights + recovery style. Defaults when unset. */
export async function getValueModel(): Promise<ValueModel> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("value_model")
      .select("model")
      .maybeSingle();
    const raw = (data as { model?: unknown } | null)?.model;
    return raw === undefined || raw === null
      ? { ...DEFAULT_VALUE_MODEL, areaWeights: {} }
      : normalizeValueModel(raw);
  }
  await ensureSeeded();
  return memDB().valueModel ?? { ...DEFAULT_VALUE_MODEL, areaWeights: {} };
}

/** Persist the value model (one row per user, upserted). Input is re-normalized. */
export async function setValueModel(model: ValueModel): Promise<void> {
  const clean = normalizeValueModel(model);
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("value_model")
      .upsert(
        { user_id, model: clean, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error)
      throw new Error(`Supabase value_model upsert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().valueModel = clean;
}

/** The user's explicit per-window availability (S3b Phase 4), or the unset default
 *  (all-zero weights ⇒ the derived share is used). */
export async function getWindowAvailability(): Promise<WindowAvailability> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("window_availability")
      .select("weights")
      .maybeSingle();
    const raw = (data as { weights?: unknown } | null)?.weights;
    return raw === undefined || raw === null
      ? EMPTY_WINDOW_AVAILABILITY
      : normalizeWindowAvailability(raw);
  }
  await ensureSeeded();
  return memDB().windowAvailability ?? EMPTY_WINDOW_AVAILABILITY;
}

/** Persist the per-window availability (one row per user, upserted). Re-normalized. */
export async function setWindowAvailability(avail: WindowAvailability): Promise<void> {
  const clean = normalizeWindowAvailability(avail);
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("window_availability")
      .upsert(
        { user_id, weights: clean.weights, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      );
    if (error)
      throw new Error(`Supabase window_availability upsert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().windowAvailability = clean;
}

// --- Portfolio strategy cache (Phase 4) -------------------------------------

/**
 * The cached portfolio strategy for the signed-in user, or null if none has been
 * generated. The Today load path reads this (never the generator) and compares
 * its `fingerprint` to the current situation to decide fresh vs. stale.
 */
export async function getCachedStrategy(): Promise<PortfolioStrategy | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("portfolio_strategy")
      .select("strategy")
      .maybeSingle();
    return (
      (data as { strategy?: PortfolioStrategy } | null)?.strategy ?? null
    );
  }
  await ensureSeeded();
  return memDB().portfolioStrategy;
}

/** Persist the freshly generated portfolio strategy (one row per user, upserted). */
export async function setCachedStrategy(
  strategy: PortfolioStrategy,
): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase.from("portfolio_strategy").upsert(
      {
        user_id,
        fingerprint: strategy.fingerprint,
        strategy,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    );
    if (error)
      throw new Error(
        `Supabase portfolio_strategy upsert failed: ${error.message}`,
      );
    return;
  }
  await ensureSeeded();
  memDB().portfolioStrategy = strategy;
}

// --- Rolling-horizon committed plan (S3c-1) ---------------------------------

/**
 * The plan the user is currently following (the rolling-horizon committed row), or null
 * if none has been committed yet. One row per user (mirrors the strategy cache). A row
 * whose `schemaVersion` doesn't match the current one is treated as absent — safe
 * invalidation to the no-regret fresh path rather than a mis-replay. Read on every load by
 * both read-path deciders (which persist nothing) and by the mutation-time roll.
 */
export async function getCommittedPlan(): Promise<CommittedPlan | null> {
  let plan: CommittedPlan | null;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("committed_plan")
      .select("plan")
      .maybeSingle();
    plan = (data as { plan?: CommittedPlan } | null)?.plan ?? null;
  } else {
    await ensureSeeded();
    plan = memDB().committedPlan;
  }
  if (plan && plan.schemaVersion !== COMMITTED_PLAN_SCHEMA_VERSION) return null;
  return plan;
}

/** Persist the committed plan (one row per user, upserted). Called only by the
 *  mutation-time roll (`commitRollingPlan`); the read path never writes. */
export async function setCommittedPlan(plan: CommittedPlan): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase.from("committed_plan").upsert(
      { user_id, plan, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error)
      throw new Error(`Supabase committed_plan upsert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().committedPlan = plan;
}

// --- Passive-roll history (S3c-2) -------------------------------------------
//
// Each automatic roll of the committed plan (a material better-candidate or an anchor
// advance, never a stay-put reload) is appended as a retained `PlanRoll` — the memory
// that powers the "how my plan evolved" timeline and a roll-undo. A SIBLING to the plan
// version history below, not an overload: a roll mutates no domain rows, only the
// arrangement, so its undo restores a prior order THROUGH reconcile rather than writing
// rows back (design §2). The arrangement lives in the `plan_order` jsonb column — `order`
// is a reserved word that collides with PostgREST's `?order=` sort param.

/** Soft cap on retained rolls per user; oldest pruned beyond this (design §3, mirrors
 *  `PLAN_VERSION_CAP`). */
const PLAN_ROLL_CAP = 50;

/** Append one roll to the history and prune to the cap. Best-effort at the call site:
 *  `commitRollingPlan` runs inside the mutation hook's swallowed try/catch, so a
 *  history-append failure can never break the mutation that triggered the roll. */
async function insertPlanRoll(roll: PlanRoll): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase.from("plan_rolls").insert({
      id: roll.id,
      user_id,
      rolled_at: roll.rolledAt,
      anchor: roll.anchor,
      fingerprint: roll.fingerprint,
      j: roll.j,
      kind: roll.kind,
      prev_j: roll.prevJ,
      plan_order: roll.order,
      reverted_at: roll.revertedAt,
      schema_version: roll.schemaVersion,
    });
    if (error)
      throw new Error(`Supabase plan_rolls insert failed: ${error.message}`);
    await prunePlanRolls(supabase);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.planRolls.unshift(roll);
  if (db.planRolls.length > PLAN_ROLL_CAP) db.planRolls.length = PLAN_ROLL_CAP;
}

/** Delete rolls older than the most recent `PLAN_ROLL_CAP` (soft cap). */
async function prunePlanRolls(supabase: RequestClient): Promise<void> {
  const { data } = await supabase
    .from("plan_rolls")
    .select("id")
    .order("rolled_at", { ascending: false })
    .range(PLAN_ROLL_CAP, PLAN_ROLL_CAP + 1000);
  const stale = (data as { id: string }[] | null) ?? [];
  if (stale.length)
    await supabase
      .from("plan_rolls")
      .delete()
      .in(
        "id",
        stale.map((r) => r.id),
      );
}

interface PlanRollRow {
  id: string;
  rolled_at: string;
  anchor: string;
  fingerprint: string;
  j: number;
  kind: PlanRollKind;
  prev_j: number | null;
  plan_order: EffectiveOrderEntry[];
  reverted_at: string | null;
  schema_version: number;
}

function rowToPlanRoll(r: PlanRollRow): PlanRoll {
  return {
    id: r.id,
    rolledAt: r.rolled_at,
    anchor: r.anchor,
    fingerprint: r.fingerprint,
    j: r.j,
    kind: r.kind,
    prevJ: r.prev_j,
    order: r.plan_order, // `plan_order` column ↔ `order` field (reserved-word remap)
    revertedAt: r.reverted_at,
    schemaVersion: r.schema_version,
  };
}

/** The passive-roll history, newest-first (capped at `PLAN_ROLL_CAP`). Rows whose
 *  `schemaVersion` no longer matches the current arrangement shape are dropped — like a
 *  stale `CommittedPlan` they can't be replayed through reconcile, so they can neither be
 *  shown nor undone. Mirrors `listPlanVersions`. */
export async function listPlanRolls(): Promise<PlanRoll[]> {
  let rolls: PlanRoll[];
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("plan_rolls")
      .select("*")
      .order("rolled_at", { ascending: false })
      .limit(PLAN_ROLL_CAP);
    rolls = ((data as PlanRollRow[]) ?? []).map(rowToPlanRoll);
  } else {
    await ensureSeeded();
    rolls = memDB().planRolls;
  }
  return rolls.filter((r) => r.schemaVersion === COMMITTED_PLAN_SCHEMA_VERSION);
}

async function getPlanRoll(id: string): Promise<PlanRoll | null> {
  let roll: PlanRoll | null;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("plan_rolls")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    roll = data ? rowToPlanRoll(data as PlanRollRow) : null;
  } else {
    await ensureSeeded();
    roll = memDB().planRolls.find((r) => r.id === id) ?? null;
  }
  if (roll && roll.schemaVersion !== COMMITTED_PLAN_SCHEMA_VERSION) return null;
  return roll;
}

/** The roll immediately BEFORE `roll` by `rolledAt` for this user — the arrangement `roll`
 *  superseded, hence what its undo restores. Null when `roll` is the earliest retained (it was
 *  the first-ever commit): undo then falls back to a fresh build (design §4). */
async function priorPlanRoll(roll: PlanRoll): Promise<PlanRoll | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("plan_rolls")
      .select("*")
      .lt("rolled_at", roll.rolledAt)
      .order("rolled_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data ? rowToPlanRoll(data as PlanRollRow) : null;
  }
  await ensureSeeded();
  // memDB is newest-first (unshift), so the first entry older than `roll` is its predecessor.
  return memDB().planRolls.find((r) => r.rolledAt < roll.rolledAt) ?? null;
}

async function markPlanRollReverted(id: string): Promise<void> {
  const revertedAt = new Date().toISOString();
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase
      .from("plan_rolls")
      .update({ reverted_at: revertedAt })
      .eq("id", id);
    return;
  }
  await ensureSeeded();
  const r = memDB().planRolls.find((x) => x.id === id);
  if (r) r.revertedAt = revertedAt;
}

// --- Drag-to-reorder signal (S3c-5, design §6) -----------------------------
//
// The 🔴-tier calibration signal: when the user drags today's plan into an order that
// is odds-neutral vs the solver's own order, we keep both orders as one revealed-
// preference pair (`user_order ≻ app_order`). S4's `calibrateArrangeWeights` recomputes
// the feature vector φ from the live feature functions over these two stored orders and
// nudges `ArrangeWeights`. A SIBLING to the roll history above (mirrors it): dispose-side
// bookkeeping, authors no odds. The jsonb columns are `app_order`/`user_order` — not a
// bare `order`, a reserved word that collides with PostgREST's `?order=` sort param.

/** Soft cap on retained reorder observations per user; oldest pruned beyond this
 *  (mirrors `PLAN_ROLL_CAP`). */
const PLAN_REORDER_CAP = 50;

/** Append one reorder observation to the history and prune to the cap. Best-effort at
 *  the call site (S3's `reorderTodayAction` runs the accrual inside the same swallowed
 *  path as the honoring commit), so a history-append failure can never break the drag. */
export async function insertPlanReorder(reorder: PlanReorder): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase.from("plan_reorders").insert({
      id: reorder.id,
      user_id,
      captured_at: reorder.capturedAt,
      date: reorder.date,
      app_order: reorder.appOrder,
      user_order: reorder.userOrder,
      schema_version: reorder.schemaVersion,
    });
    if (error)
      throw new Error(`Supabase plan_reorders insert failed: ${error.message}`);
    await prunePlanReorders(supabase);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.planReorders.unshift(reorder);
  if (db.planReorders.length > PLAN_REORDER_CAP)
    db.planReorders.length = PLAN_REORDER_CAP;
}

/** Delete reorders older than the most recent `PLAN_REORDER_CAP` (soft cap). */
async function prunePlanReorders(supabase: RequestClient): Promise<void> {
  const { data } = await supabase
    .from("plan_reorders")
    .select("id")
    .order("captured_at", { ascending: false })
    .range(PLAN_REORDER_CAP, PLAN_REORDER_CAP + 1000);
  const stale = (data as { id: string }[] | null) ?? [];
  if (stale.length)
    await supabase
      .from("plan_reorders")
      .delete()
      .in(
        "id",
        stale.map((r) => r.id),
      );
}

interface PlanReorderRow {
  id: string;
  captured_at: string;
  date: string;
  app_order: EffectiveOrderEntry[];
  user_order: EffectiveOrderEntry[];
  schema_version: number;
}

function rowToPlanReorder(r: PlanReorderRow): PlanReorder {
  return {
    id: r.id,
    capturedAt: r.captured_at,
    date: r.date,
    appOrder: r.app_order, // `app_order` column ↔ `appOrder` field (reserved-word remap)
    userOrder: r.user_order,
    schemaVersion: r.schema_version,
  };
}

/** The drag-to-reorder history, newest-first (capped at `PLAN_REORDER_CAP`). Rows whose
 *  `schemaVersion` no longer matches the current arrangement shape are dropped — like a
 *  stale `PlanRoll`, their stored orders can't be re-priced, so the calibrator skips
 *  them. Mirrors `listPlanRolls`. */
export async function listPlanReorders(): Promise<PlanReorder[]> {
  let reorders: PlanReorder[];
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("plan_reorders")
      .select("*")
      .order("captured_at", { ascending: false })
      .limit(PLAN_REORDER_CAP);
    reorders = ((data as PlanReorderRow[]) ?? []).map(rowToPlanReorder);
  } else {
    await ensureSeeded();
    reorders = memDB().planReorders;
  }
  return reorders.filter(
    (r) => r.schemaVersion === COMMITTED_PLAN_SCHEMA_VERSION,
  );
}

// --- Plan version history (S1 step 3 / vision §1.3) -------------------------
//
// Every applied strategy bundle is snapshotted as a `PlanVersion`: the committed
// moves, the odds the user accepted, and a `restore` (prior row values + inserted
// row ids). One snapshot per bundle ⇒ undo reverts the whole strategy at once.
// `commitStrategyBundle` is the single server-side authority for *applying* a move
// — the card routes every "Apply" through it, and each kind's snapshot + persist
// live together in one `MOVE_SPECS` entry (S1 step 4), so the previewed odds and the
// committed change can't drift.

/** Soft cap on retained versions per user; oldest pruned beyond this (decision #3). */
const PLAN_VERSION_CAP = 50;

/** Inserted-row ids returned by the recovery applies, so undo can delete them. */
interface RecoveryInserts {
  insertedTaskIds: string[];
  insertedEntryIds: string[];
}

/** Read the current value of specific fields off live task rows (the pre-image a
 *  bundle snapshots before it mutates them). */
async function snapshotTaskFields(
  ids: string[],
  fields: (keyof Task)[],
): Promise<(Partial<Task> & { id: string })[]> {
  const rows = await getTasksByIds(ids);
  return rows.map((t) => {
    const snap: Partial<Task> & { id: string } = { id: t.id };
    for (const f of fields) (snap as Record<string, unknown>)[f] = t[f];
    return snap;
  });
}

/** Batch-read tasks by id (current values) — for snapshotting + restore reads. */
async function getTasksByIds(ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase.from("tasks").select("*").in("id", ids);
    return (data as Task[]) ?? [];
  }
  await ensureSeeded();
  const set = new Set(ids);
  return memDB().tasks.filter((t) => set.has(t.id));
}

/** Read a skill node's current attainment fields — the pre-image an `attain_skill`
 *  move snapshots so undo can revert it to unattained (§5.6). */
async function snapshotSkillNodeAttainment(
  id: string,
): Promise<(Partial<SkillNode> & { id: string })[]> {
  const fields = ["attained", "attained_confidence", "attained_at"] as const;
  let row: SkillNode | undefined;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase.from("skill_nodes").select("*").eq("id", id).maybeSingle();
    row = (data as SkillNode | null) ?? undefined;
  } else {
    await ensureSeeded();
    row = memDB().skillNodes.find((n) => n.id === id);
  }
  if (!row) return [];
  const snap: Partial<SkillNode> & { id: string } = { id };
  for (const f of fields) (snap as Record<string, unknown>)[f] = row[f];
  return [snap];
}

/** The FULL dependency rows where a task is the PREREQ (`depends_on_task_id ===
 *  blockerId`) — the edges a `resolve_blocker` cascade frees (§5.6 6b). Read from
 *  the LIVE active DAG (`listAllDependencies`) so the snapshot pre-image and the
 *  persist delete agree, an off-DAG/stale advisory id no-ops, and it mirrors the
 *  forecast arm's `deps.filter(depends_on_task_id !== blocker)` exactly. */
async function getDependenciesByBlocker(blockerId: string): Promise<TaskDependency[]> {
  const all = await listAllDependencies();
  return all.filter((d) => d.depends_on_task_id === blockerId);
}

/** Delete dependency edges by id (supabase + memDB), mirroring `deleteTasks`. */
async function deleteDependencies(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase.from("task_dependencies").delete().in("id", ids);
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.deps = db.deps.filter((d) => !set.has(d.id));
}

/** Re-insert FULL dependency rows — the undo of a `resolve_blocker` cascade (§5.6 6b).
 *  Re-inserting the ORIGINAL rows (same id/entry_id) restores DAG identity and
 *  re-satisfies whatever FK/RLS admitted them. Mirrors `deleteTasks` across stores. */
async function insertDependencies(rows: TaskDependency[]): Promise<void> {
  if (rows.length === 0) return;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase.from("task_dependencies").insert(rows);
    if (error)
      throw new Error(`Supabase task_dependencies re-insert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().deps.push(...rows);
}

// --- Move spec registry (S1 step 4) ----------------------------------------
//
// One `MoveSpec` per `StrategyMoveKind` co-locates that kind's two server-side DB
// behaviors — the undo pre-image `snapshot` and the real `persist` — in a single
// entry, so they can't silently drift apart as kinds evolve (before this they were
// two separate switches ~60 lines apart, and `snapshot` has to capture exactly the
// fields `persist` mutates or undo is wrong). Bundle apply-order is a cross-kind
// policy, not a per-kind behavior, so it stays in `strategyApplyOrder`, not here.
//
// The forecast-domain twin of `persist` is the matching arm of `applyMoveToAlloc`
// (lib/portfolio-state.ts) — it stays THERE because the live re-solve runs it
// CLIENT-SIDE, so it can't share this `server-only` module (the deliberate step-1
// split overrides the design's original single-object `MoveSpec`). The two halves
// are bound only by the shared `StrategyMoveKind`: both this registry and
// `applyMoveToAlloc` are exhaustive over it, so a new kind can't compile until it
// has BOTH a forecast arm and a spec here. `persist` MUST encode the same effect its
// forecast arm previews, or the odds the user accepts would be a lie (§0).

/** Prior values of the rows one move mutates — its undo pre-image (id + only the
 *  fields that move's `persist` changes; restore writes exactly those back). */
type MoveRowSnapshot = {
  tasks: (Partial<Task> & { id: string })[];
  goals: (Partial<Goal> & { id: string })[];
  /** Prior attainment of skill nodes an `attain_skill` move flips (§5.6) — absent
   *  for every other kind. */
  skillNodes?: (Partial<SkillNode> & { id: string })[];
  /** FULL dependency rows a `resolve_blocker` cascade will DELETE (§5.6 6b) — captured
   *  as the pre-image so undo re-inserts the originals byte-identical; absent otherwise. */
  dependencies?: TaskDependency[];
};

/** The synthetic-row ids one move's `persist` inserted, so undo can delete them. */
type MovePersistResult = Partial<
  Pick<RowSnapshot, "insertedTaskIds" | "insertedEntryIds" | "activityCompletionIds">
>;

interface MoveSpec<K extends StrategyMoveKind> {
  /** Prior values of the rows `persist` will mutate — read BEFORE any apply so it is
   *  the true pre-image, capturing only the fields `persist` touches. Inserted
   *  synthetic rows are captured at apply time by `persist`, not here. */
  snapshot(
    payload: Extract<StrategyMovePayload, { kind: K }>,
    move: StrategyMove,
  ): Promise<MoveRowSnapshot>;
  /** The real DB mutation; returns the synthetic-row ids it inserted (for undo).
   *  `mark_done` stamps `inferred` — the strategist inferred the completion. */
  persist(
    payload: Extract<StrategyMovePayload, { kind: K }>,
    move: StrategyMove,
  ): Promise<MovePersistResult>;
}

const MOVE_SPECS: { [K in StrategyMoveKind]: MoveSpec<K> } = {
  defer: {
    snapshot: async (p) => ({ tasks: await snapshotTaskFields([p.taskId], ["deferred"]), goals: [] }),
    persist: async (p) => {
      await updateTask(p.taskId, { deferred: true });
      return {};
    },
  },
  triage: {
    snapshot: async (p) => ({ tasks: await snapshotTaskFields(p.taskIds, ["deferred"]), goals: [] }),
    persist: async (p) => {
      await Promise.all(p.taskIds.map((id) => updateTask(id, { deferred: true })));
      return {};
    },
  },
  reschedule_task: {
    snapshot: async (p) => ({ tasks: await snapshotTaskFields([p.taskId], ["due_date"]), goals: [] }),
    persist: async (p) => {
      await updateTask(p.taskId, { due_date: p.dueDate });
      return {};
    },
  },
  unblock: {
    snapshot: async (p) => ({
      tasks: await snapshotTaskFields([p.taskId], ["status", "blocked_by"]),
      goals: [],
    }),
    persist: async (p) => {
      await updateTask(p.taskId, { status: "todo", blocked_by: null });
      return {};
    },
  },
  resolve_blocker: {
    // §5.6 6b — snapshot the blocker's done-fields + provenance AND the FULL edge rows
    // the cascade will delete, so undo restores the task and re-inserts the exact edges.
    snapshot: async (p) => ({
      tasks: await snapshotTaskFields(
        [p.blockerTaskId],
        ["status", "completion_confidence", "completed_at", "resolved_by"],
      ),
      goals: [],
      dependencies: await getDependenciesByBlocker(p.blockerTaskId),
    }),
    persist: async (p) => {
      // Mark the blocker done (a check-in resolution is `self_assessed` — the invariant)
      // + stamp the free-text provenance, then delete every edge INTO it. The edges are
      // RE-DERIVED from the LIVE DAG here (never from the advisory `freedTaskIds`), so a
      // stale entry simply no-ops — decision #8. Cascade is one-hop: a freed dependent
      // becomes actionable but is NEVER auto-completed (the joint re-solve schedules it).
      await updateTask(p.blockerTaskId, {
        status: "done",
        completion_confidence: p.confidence ?? "self_assessed",
        completed_at: new Date().toISOString(),
        resolved_by: p.resolvedBy,
      });
      const edges = await getDependenciesByBlocker(p.blockerTaskId);
      await deleteDependencies(edges.map((e) => e.id));
      return {};
    },
  },
  mark_done: {
    snapshot: async (p) => ({
      tasks: await snapshotTaskFields(
        [p.taskId],
        ["status", "completion_confidence", "completed_at"],
      ),
      goals: [],
    }),
    persist: async (p) => {
      await updateTask(p.taskId, {
        status: "done",
        // §5.6: provenance rides on the payload. A check-in "I finished X" carries
        // `self_assessed`; the strategist's own inference omits it → `inferred`.
        completion_confidence: p.confidence ?? "inferred",
        completed_at: new Date().toISOString(),
      });
      return {};
    },
  },
  attain_skill: {
    snapshot: async (p) => ({
      tasks: [],
      goals: [],
      skillNodes: await snapshotSkillNodeAttainment(p.nodeId),
    }),
    persist: async (p) => {
      await setSkillNodeAttained(p.nodeId, true, p.confidence);
      return {};
    },
  },
  reschedule_deadline: {
    snapshot: async (_payload, move) => {
      const goal = await getGoal(move.projectId);
      return { tasks: [], goals: goal ? [{ id: goal.id, deadline: goal.deadline }] : [] };
    },
    persist: async (p, move) => {
      await setProjectDeadline(move.projectId, p.deadline);
      return {};
    },
  },
  reshape: {
    snapshot: async (p) => {
      // scope_down rewrites a task in place; split defers the monolith. Snapshot the
      // touched task's pre-image per mod (inserted steps/debt are captured at apply).
      const tasks: (Partial<Task> & { id: string })[] = [];
      for (const m of p.mods) {
        const fields: (keyof Task)[] =
          m.kind === "scope_down"
            ? ["title", "description", "estimated_minutes"]
            : ["deferred"];
        tasks.push(...(await snapshotTaskFields([m.taskId], fields)));
      }
      return { tasks, goals: [] };
    },
    // `RecoveryInserts` already IS the inserted-id shape, so return it directly.
    persist: async (p, move) => applyTaskModifications(move.projectId, p.mods),
  },
  reroute: {
    snapshot: async (p) => ({
      tasks: await snapshotTaskFields(p.replacedTaskIds, ["deferred"]),
      goals: [],
    }),
    persist: async (p, move) => applyReroute(move.projectId, p.replacedTaskIds, p.tasks),
  },
  add_tasks: {
    snapshot: async () => ({ tasks: [], goals: [] }),
    persist: async (p, move) => addCorrectiveTasks(move.projectId, p.tasks),
  },
  skip_activity: {
    snapshot: async () => ({ tasks: [], goals: [] }),
    persist: async (p) => ({ activityCompletionIds: await skipActivityForWeek(p.activityId) }),
  },
  hold: {
    snapshot: async () => ({ tasks: [], goals: [] }),
    persist: async () => ({}),
  },
};

/**
 * Look up a move's spec. TypeScript can't correlate the registry key with the
 * payload union (the known correlated-union limitation), so the looked-up spec is
 * widened to accept the full payload union at this single seam — sound because we
 * index `MOVE_SPECS` by the very `payload.kind` whose payload we then pass.
 */
function specFor(kind: StrategyMoveKind): MoveSpec<StrategyMoveKind> {
  return MOVE_SPECS[kind] as MoveSpec<StrategyMoveKind>;
}

/** Bundle apply order — deadline reschedules go last so deferrals free their hours
 *  first (`move.kind` mirrors `payload.kind` at construction, so either keys it). */
function strategyApplyOrder(a: StrategyMove, b: StrategyMove): number {
  const rank = (k: StrategyMoveKind) => (k === "reschedule_deadline" ? 1 : 0);
  return rank(a.payload.kind) - rank(b.payload.kind);
}

/**
 * Apply a strategy bundle and record it as a `PlanVersion`. (1) snapshot the prior
 * values of every row the moves will touch; (2) apply each move (deadline
 * reschedules last) capturing inserted ids; (3) persist the version. Returns the
 * version so the caller can offer an immediate Undo. `meta.odds*` are the previewed
 * numbers the user accepted (from the client re-solve) — informational, for the
 * history view.
 */
export async function commitStrategyBundle(
  moves: StrategyMove[],
  meta: { oddsBefore: number; oddsAfter: number; reason: string },
): Promise<PlanVersion> {
  const ordered = [...moves].sort(strategyApplyOrder);

  // 1. Snapshot prior values BEFORE applying (dedup by id; keep the first read so a
  //    later move in the same bundle can't overwrite an earlier move's pre-image).
  const taskSnap = new Map<string, Partial<Task> & { id: string }>();
  const goalSnap = new Map<string, Partial<Goal> & { id: string }>();
  const skillSnap = new Map<string, Partial<SkillNode> & { id: string }>();
  // Dependency edges a resolve_blocker cascade deletes — deduped by edge id as a
  // pre-image, so undo re-inserts each original exactly once (§5.6 6b).
  const depSnap = new Map<string, TaskDependency>();
  for (const move of ordered) {
    const { tasks, goals, skillNodes, dependencies } = await specFor(move.payload.kind).snapshot(move.payload, move);
    for (const t of tasks) if (!taskSnap.has(t.id)) taskSnap.set(t.id, t);
    for (const goal of goals) if (!goalSnap.has(goal.id)) goalSnap.set(goal.id, goal);
    for (const n of skillNodes ?? []) if (!skillSnap.has(n.id)) skillSnap.set(n.id, n);
    for (const d of dependencies ?? []) if (!depSnap.has(d.id)) depSnap.set(d.id, d);
  }

  // 2. Apply, accumulating the synthetic rows inserted (so undo can delete them).
  const insertedTaskIds: string[] = [];
  const insertedEntryIds: string[] = [];
  const activityCompletionIds: string[] = [];
  for (const move of ordered) {
    const eff = await specFor(move.payload.kind).persist(move.payload, move);
    if (eff.insertedTaskIds) insertedTaskIds.push(...eff.insertedTaskIds);
    if (eff.insertedEntryIds) insertedEntryIds.push(...eff.insertedEntryIds);
    if (eff.activityCompletionIds) activityCompletionIds.push(...eff.activityCompletionIds);
  }

  // Odds are informational (history display), but the columns are NOT NULL and
  // `JSON.stringify(NaN/undefined)` → null — a degraded cache (no resolveInput, a
  // non-finite combinedProbability) applied before auto-regen would otherwise throw
  // on insert and kill the whole Apply. Coerce to a finite value so a commit never
  // fails over a cosmetic number.
  const safeOdds = (n: number) => (Number.isFinite(n) ? n : 0);

  const version: PlanVersion = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    reason: meta.reason,
    moves: ordered,
    oddsBefore: safeOdds(meta.oddsBefore),
    oddsAfter: safeOdds(meta.oddsAfter),
    restore: {
      tasks: [...taskSnap.values()],
      goals: [...goalSnap.values()],
      skillNodes: [...skillSnap.values()],
      insertedTaskIds,
      insertedEntryIds,
      activityCompletionIds,
      deletedDependencies: [...depSnap.values()],
    },
    revertedAt: null,
  };

  await insertPlanVersion(version);
  return version;
}

/** A plan_versions row (snake_case) ↔ the camelCase `PlanVersion` domain type. */
interface PlanVersionRow {
  id: string;
  created_at: string;
  reverted_at: string | null;
  reason: string;
  odds_before: number;
  odds_after: number;
  moves: StrategyMove[];
  restore: RowSnapshot;
}

function rowToPlanVersion(r: PlanVersionRow): PlanVersion {
  return {
    id: r.id,
    createdAt: r.created_at,
    reason: r.reason,
    moves: r.moves,
    oddsBefore: r.odds_before,
    oddsAfter: r.odds_after,
    restore: r.restore,
    revertedAt: r.reverted_at,
  };
}

async function insertPlanVersion(version: PlanVersion): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase.from("plan_versions").insert({
      id: version.id,
      user_id,
      created_at: version.createdAt,
      reverted_at: version.revertedAt,
      reason: version.reason,
      odds_before: version.oddsBefore,
      odds_after: version.oddsAfter,
      moves: version.moves,
      restore: version.restore,
    });
    if (error)
      throw new Error(`Supabase plan_versions insert failed: ${error.message}`);
    await prunePlanVersions(supabase);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.planVersions.unshift(version);
  if (db.planVersions.length > PLAN_VERSION_CAP)
    db.planVersions.length = PLAN_VERSION_CAP;
}

/** Delete versions older than the most recent `PLAN_VERSION_CAP` (soft cap). */
async function prunePlanVersions(supabase: RequestClient): Promise<void> {
  const { data } = await supabase
    .from("plan_versions")
    .select("id")
    .order("created_at", { ascending: false })
    .range(PLAN_VERSION_CAP, PLAN_VERSION_CAP + 1000);
  const stale = (data as { id: string }[] | null) ?? [];
  if (stale.length)
    await supabase
      .from("plan_versions")
      .delete()
      .in(
        "id",
        stale.map((r) => r.id),
      );
}

/** The plan version history, newest-first (capped at `PLAN_VERSION_CAP`). */
export async function listPlanVersions(): Promise<PlanVersion[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("plan_versions")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(PLAN_VERSION_CAP);
    return ((data as PlanVersionRow[]) ?? []).map(rowToPlanVersion);
  }
  await ensureSeeded();
  return memDB().planVersions;
}

async function getPlanVersion(id: string): Promise<PlanVersion | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("plan_versions")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return data ? rowToPlanVersion(data as PlanVersionRow) : null;
  }
  await ensureSeeded();
  return memDB().planVersions.find((v) => v.id === id) ?? null;
}

async function markPlanVersionReverted(id: string): Promise<void> {
  const revertedAt = new Date().toISOString();
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase
      .from("plan_versions")
      .update({ reverted_at: revertedAt })
      .eq("id", id);
    return;
  }
  await ensureSeeded();
  const v = memDB().planVersions.find((x) => x.id === id);
  if (v) v.revertedAt = revertedAt;
}

/**
 * Revert one applied bundle whole (vision §8.2): write the snapshotted prior values
 * back, delete the synthetic rows the bundle inserted, and mark the version
 * reverted (it stays in history, struck through). No-op if already reverted.
 */
export async function undoPlanVersion(id: string): Promise<void> {
  const version = await getPlanVersion(id);
  if (!version || version.revertedAt) return;
  const { restore } = version;

  // Restore prior task values (exactly the snapshotted fields).
  for (const t of restore.tasks) {
    const { id: taskId, ...patch } = t;
    if (Object.keys(patch).length) await updateTask(taskId, patch);
  }
  // Restore prior goal deadlines.
  for (const goal of restore.goals) {
    if ("deadline" in goal) await setProjectDeadline(goal.id, goal.deadline ?? null);
  }
  // Restore prior skill-node attainment (§5.6) — revert an attained skill back to
  // whatever it was (typically unattained at its prior null confidence).
  for (const n of restore.skillNodes ?? []) {
    await setSkillNodeAttained(n.id, n.attained ?? false, n.attained_confidence ?? null);
  }
  // Re-insert the dependency edges a resolve_blocker cascade deleted (§5.6 6b) — the
  // ORIGINAL rows, so the DAG is byte-identical. `?? []` for bundles persisted before
  // 6b (their jsonb `restore` has no `deletedDependencies` key).
  await insertDependencies(restore.deletedDependencies ?? []);
  // Delete the synthetic rows the bundle inserted (tasks, their recovery entries,
  // and any skip rows).
  await deleteTasks(restore.insertedTaskIds);
  await deleteEntries(restore.insertedEntryIds);
  await deleteActivityCompletions(restore.activityCompletionIds);

  await markPlanVersionReverted(id);
}

async function deleteTasks(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase.from("tasks").delete().in("id", ids);
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.tasks = db.tasks.filter((t) => !set.has(t.id));
}

async function deleteEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase.from("entries").delete().in("id", ids);
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.entries = db.entries.filter((e) => !set.has(e.id));
}

async function deleteActivityCompletions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase.from("activity_completions").delete().in("id", ids);
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.activityCompletions = db.activityCompletions.filter((c) => !set.has(c.id));
}

/** Override the template for one specific date. */
export async function setOverride(date: string, hours: number): Promise<void> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("availability_overrides")
      .upsert(
        { user_id, date, hours: Math.max(0, hours) },
        { onConflict: "user_id,date" },
      );
    if (error)
      throw new Error(`Supabase override upsert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  const ex = db.overrides.find((o) => o.date === date);
  if (ex) ex.hours = Math.max(0, hours);
  else db.overrides.push({ date, hours: Math.max(0, hours) });
}

/** Upcoming logged commitments (today onward). */
export async function listCommitments(): Promise<Commitment[]> {
  const today = todayISO();
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("commitments")
      .select("*")
      .gte("date", today)
      .order("date");
    return (data as Commitment[]) ?? [];
  }
  await ensureSeeded();
  return memDB()
    .commitments.filter((c) => c.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date));
}

interface TimeBudget {
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
}

/**
 * Fold recurring activities' drain into the commitment set as synthetic
 * commitments — the SINGLE place recurring time-cost enters the budget (locked
 * invariant #1). Because every capacity consumer (`dayCapacities`,
 * `deployableMinutes`) subtracts commitment hours per date, the eaten time then
 * lands everywhere automatically. The agenda's synthetic recurring task is
 * display/order-only and must never be re-counted against capacity.
 */
/** Recurring drain as synthetic `Commitment` rows (date + hours; the rest is cosmetic). */
async function appendActivityDrain(budget: TimeBudget): Promise<TimeBudget> {
  const [activities, completions] = await Promise.all([
    listRecurringActivities(),
    listActivityCompletions(),
  ]);
  return {
    ...budget,
    commitments: [
      ...budget.commitments,
      ...drainAsCommitments(activities, completions, todayISO()),
    ],
  };
}

/** Raw time-budget inputs — the real availability/overrides/commitments, NO
 *  recurring drain folded in (so callers that need the un-drained set can get it). */
async function getRawTimeBudget(): Promise<TimeBudget> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const [avail, over, comm] = await Promise.all([
      supabase.from("availability").select("*"),
      supabase.from("availability_overrides").select("*"),
      supabase.from("commitments").select("*"),
    ]);
    return {
      availability: mergeAvailability((avail.data as Availability[]) ?? []),
      overrides: (over.data as AvailabilityOverride[]) ?? [],
      commitments: (comm.data as Commitment[]) ?? [],
    };
  }
  await ensureSeeded();
  const db = memDB();
  return {
    availability: mergeAvailability(db.availability),
    overrides: db.overrides,
    commitments: db.commitments,
  };
}

/** Effective time-budget inputs for the forecast engine (recurring drain folded in). */
async function getTimeBudget(): Promise<TimeBudget> {
  return appendActivityDrain(await getRawTimeBudget());
}

// --- Recurring activities (routines & goals) --------------------------------

/** All recurring activities for the user (active and archived). */
export async function listRecurringActivities(): Promise<RecurringActivity[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("recurring_activities")
      .select("*")
      .order("created_at", { ascending: false });
    return (data as RecurringActivity[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().recurringActivities].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

/** The full completion log for the user (all activities, all dates). */
export async function listActivityCompletions(): Promise<ActivityCompletion[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("activity_completions")
      .select("*")
      .order("date", { ascending: false });
    return (data as ActivityCompletion[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().activityCompletions];
}

export interface NewActivityInput {
  title: string;
  area?: string;
  period: ActivityCadencePeriod;
  target_count: number;
  weekdays?: number[] | null;
  estimated_minutes: number;
  urgency?: number;
  impact?: number;
  effort?: number;
  dependency?: number;
  risk?: number;
  confidence?: number;
  protected?: boolean;
}

/** Create a recurring activity. Streak habits (daily) default to protected. */
export async function createRecurringActivity(
  input: NewActivityInput,
): Promise<string> {
  const activity: RecurringActivity = {
    id: crypto.randomUUID(),
    title: input.title.trim(),
    area: input.area?.trim() || "Personal",
    period: input.period,
    target_count: Math.max(1, Math.round(input.target_count)),
    weekdays: input.weekdays ?? null,
    estimated_minutes: Math.max(1, Math.round(input.estimated_minutes)),
    urgency: input.urgency ?? 3,
    impact: input.impact ?? 3,
    effort: input.effort ?? 3,
    dependency: input.dependency ?? 1,
    risk: input.risk ?? 2,
    confidence: input.confidence ?? 4,
    protected: input.protected ?? input.period === "day",
    active: true,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("recurring_activities")
      .insert({ ...activity, user_id });
    if (error)
      throw new Error(`Supabase recurring_activities insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().recurringActivities.unshift(activity);
  }
  return activity.id;
}

/** Patch a recurring activity (edit, protect toggle, or soft-archive). */
export async function updateRecurringActivity(
  id: string,
  patch: Partial<
    Pick<
      RecurringActivity,
      | "title"
      | "area"
      | "period"
      | "target_count"
      | "weekdays"
      | "estimated_minutes"
      | "urgency"
      | "impact"
      | "effort"
      | "dependency"
      | "risk"
      | "confidence"
      | "protected"
      | "active"
    >
  >,
): Promise<RecurringActivity | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("recurring_activities")
      .update(patch)
      .eq("id", id)
      .select("*")
      .maybeSingle();
    return (data as RecurringActivity) ?? null;
  }
  await ensureSeeded();
  const a = memDB().recurringActivities.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch);
  return a;
}

/** Log a completed session for an activity on a date (defaults to today). */
export async function logActivityCompletion(
  activityId: string,
  date?: string,
  minutes?: number,
): Promise<void> {
  const row: ActivityCompletion = {
    id: crypto.randomUUID(),
    activity_id: activityId,
    date: (date ?? todayISO()).slice(0, 10),
    minutes: minutes !== undefined ? Math.max(0, Math.round(minutes)) : 0,
    skipped: false,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("activity_completions")
      .insert({ ...row, user_id });
    if (error)
      throw new Error(`Supabase activity_completions insert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().activityCompletions.push(row);
}

/**
 * Record one real work session — the local when-signal the velocity loop accrues
 * (OVERHAUL S2 slice B). `local` carries the CLIENT's local window/weekday/day (the
 * action runs server-side and can't read the browser clock), which resolves the
 * timezone gotcha. A session is task effort XOR a routine session.
 *
 * BEST-EFFORT by contract: this is pure telemetry accrual that must never regress
 * the completion that triggered it, so a failed insert is logged and swallowed —
 * never thrown. Nothing reads these rows until slice C.
 */
export async function logWorkSession(input: {
  taskId?: string | null;
  activityId?: string | null;
  minutes: number;
  kind: "progress" | "complete";
  local: WorkSessionLocal;
}): Promise<void> {
  const taskId = input.taskId ?? null;
  const activityId = input.activityId ?? null;
  // Enforce the table's XOR at the boundary: exactly one source. A malformed call
  // skips silently rather than tripping the DB constraint on a completion path.
  if ((taskId === null) === (activityId === null)) return;
  const row: WorkSession = {
    id: crypto.randomUUID(),
    task_id: taskId,
    activity_id: activityId,
    logged_for: input.local.logged_for.slice(0, 10),
    time_window: input.local.time_window,
    weekday: input.local.weekday,
    minutes: Math.max(0, Math.round(input.minutes)),
    kind: input.kind,
    created_at: new Date().toISOString(),
  };
  try {
    if (isSupabaseConfigured()) {
      const supabase = await getRequestClient();
      const user_id = await currentUserId(supabase);
      const { error } = await supabase.from("work_sessions").insert({ ...row, user_id });
      if (error) throw new Error(error.message);
      return;
    }
    await ensureSeeded();
    memDB().workSessions.push(row);
  } catch (e) {
    console.error("logWorkSession failed (accrual skipped):", e);
  }
}

/** All work sessions, oldest-first — the slice-C velocity/energy reads' source. */
export async function listWorkSessions(): Promise<WorkSession[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data, error } = await supabase
      .from("work_sessions")
      .select("*")
      .order("logged_for", { ascending: true });
    if (error) throw new Error(`Supabase work_sessions list failed: ${error.message}`);
    return (data ?? []) as WorkSession[];
  }
  await ensureSeeded();
  return [...memDB().workSessions];
}

/**
 * Skip an activity's current instance for a date (defaults to today): resolves
 * that period's obligation — stops draining the budget and nagging — without
 * crediting a streak. Reversible via `unskipActivity`.
 */
export async function skipActivity(
  activityId: string,
  date?: string,
): Promise<void> {
  const day = (date ?? todayISO()).slice(0, 10);
  const row: ActivityCompletion = {
    id: crypto.randomUUID(),
    activity_id: activityId,
    date: day,
    minutes: 0,
    skipped: true,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("activity_completions")
      .insert({ ...row, user_id });
    if (error)
      throw new Error(`Supabase activity skip insert failed: ${error.message}`);
    return;
  }
  await ensureSeeded();
  memDB().activityCompletions.push(row);
}

/** Undo a skip (delete the skip rows for that activity + date). */
export async function unskipActivity(
  activityId: string,
  date?: string,
): Promise<void> {
  const day = (date ?? todayISO()).slice(0, 10);
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    await supabase
      .from("activity_completions")
      .delete()
      .eq("activity_id", activityId)
      .eq("date", day)
      .eq("skipped", true);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.activityCompletions = db.activityCompletions.filter(
    (c) => !(c.activity_id === activityId && c.date === day && c.skipped),
  );
}

/**
 * The derived state (status / streak / progress / due-today) of every active
 * recurring activity — the read the activities UI and the strategist consume.
 * Archived activities are excluded.
 */
export async function getRecurringState(): Promise<RecurringState[]> {
  const [activities, completions] = await Promise.all([
    listRecurringActivities(),
    listActivityCompletions(),
  ]);
  const today = todayISO();
  return activities
    .filter((a) => a.active)
    .map((a) => recurringStateFor(a, completions, today));
}

/**
 * Skip an activity for the REST OF THIS WEEK — the apply behind a strategist
 * `skip_activity` move. Persists skip rows for exactly the current-week owed
 * instances the forecast probe freed, so the applied effect matches the shown
 * odds. Reversible by logging real sessions (or unskipping the dates).
 */
export async function skipActivityForWeek(activityId: string): Promise<string[]> {
  const [activities, completions] = await Promise.all([
    listRecurringActivities(),
    listActivityCompletions(),
  ]);
  const activity = activities.find((a) => a.id === activityId);
  if (!activity) return [];
  const dates = currentWeekOwedDates(activity, completions, todayISO());
  if (dates.length === 0) return [];
  const rows: ActivityCompletion[] = dates.map((date) => ({
    id: crypto.randomUUID(),
    activity_id: activityId,
    date,
    minutes: 0,
    skipped: true,
    created_at: new Date().toISOString(),
  }));
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("activity_completions")
      .insert(rows.map((r) => ({ ...r, user_id })));
    if (error)
      throw new Error(`Supabase activity week-skip insert failed: ${error.message}`);
    return rows.map((r) => r.id);
  }
  await ensureSeeded();
  memDB().activityCompletions.push(...rows);
  return rows.map((r) => r.id);
}

// --- Errands (one-off tasks under a reserved, deadline-less project) ---------

const ERRANDS_PROJECT_NAME = "Errands";

/** A minimal active holding entry for the reserved Errands project. */
function buildErrandsHoldingEntry(projectId: string): Entry {
  return {
    id: crypto.randomUUID(),
    title: "Errands",
    raw_input: "",
    summary: null,
    discussion_points: [],
    stakeholders: [],
    daily_objective: null,
    key_deliverables: [],
    assumptions: [],
    risks: [],
    kind: "plan",
    status: "active",
    goal_id: projectId,
    parent_entry_id: null,
    created_at: new Date().toISOString(),
  };
}

/**
 * The reserved deadline-less "Errands" project (and its holding entry) that
 * one-off errands attach to, created lazily on first use. An undeadlined project
 * still consumes the shared budget but receives no forecast probability — exactly
 * errand semantics — so errands reuse the whole task/agenda/defer machinery.
 */
export async function getOrCreateErrandsProject(): Promise<{
  projectId: string;
  entryId: string;
}> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { data: proj } = await supabase
      .from("goals")
      .select("id")
      .eq("name", ERRANDS_PROJECT_NAME)
      .limit(1)
      .maybeSingle();
    let projectId = (proj as { id: string } | null)?.id;
    if (!projectId) {
      projectId = crypto.randomUUID();
      const { error } = await supabase.from("goals").insert({
        id: projectId,
        name: ERRANDS_PROJECT_NAME,
        description: "One-off errands.",
        kind: "project",
        deadline: null,
        user_id,
      });
      if (error)
        throw new Error(`Supabase errands project insert failed: ${error.message}`);
    }
    const { data: ent } = await supabase
      .from("entries")
      .select("id")
      .eq("goal_id", projectId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    let entryId = (ent as { id: string } | null)?.id;
    if (!entryId) {
      const entry = buildErrandsHoldingEntry(projectId);
      entryId = entry.id;
      const { error } = await supabase
        .from("entries")
        .insert({ ...entry, user_id });
      if (error)
        throw new Error(`Supabase errands entry insert failed: ${error.message}`);
    }
    return { projectId, entryId };
  }
  await ensureSeeded();
  const db = memDB();
  let proj = db.projects.find((p) => p.name === ERRANDS_PROJECT_NAME);
  if (!proj) {
    proj = {
      id: crypto.randomUUID(),
      name: ERRANDS_PROJECT_NAME,
      description: "One-off errands.",
      kind: "project",
      deadline: null,
      created_at: new Date().toISOString(),
    };
    db.projects.unshift(proj);
  }
  let entry = db.entries.find(
    (e) => e.goal_id === proj!.id && e.status === "active",
  );
  if (!entry) {
    entry = buildErrandsHoldingEntry(proj.id);
    db.entries.unshift(entry);
  }
  return { projectId: proj.id, entryId: entry.id };
}

/** Create a one-off errand task (under the reserved Errands project). */
export async function createErrandTask(
  title: string,
  dueDate?: string | null,
  estimatedMinutes = 30,
): Promise<string> {
  const { projectId, entryId } = await getOrCreateErrandsProject();
  const f: FactorScores = {
    urgency: 3,
    impact: 2,
    effort: 1,
    dependency: 1,
    risk: 2,
    confidence: 4,
  };
  const { score, label } = computePriority(f);
  const task: Task = {
    id: crypto.randomUUID(),
    entry_id: entryId,
    goal_id: projectId,
    title: title.trim(),
    description: null,
    owner: null,
    category: null,
    area: "Personal",
    status: "todo",
    due_date: dueDate ?? null,
    estimated_minutes: Math.max(1, Math.round(estimatedMinutes)),
    actual_minutes: 0,
    urgency_score: f.urgency,
    impact_score: f.impact,
    effort_score: f.effort,
    dependency_score: f.dependency,
    risk_score: f.risk,
    confidence_score: f.confidence,
    priority_score: score,
    priority_label: label,
    priority_reason: "Quick one-off errand.",
    source_quote: null,
    is_ai_suggested: false,
    blocked_by: null,
    deferred: false,
    completion_confidence: null,
    completed_at: null,
    origin: null,
    resolved_by: null,
    sort_index: 0,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { error } = await supabase.from("tasks").insert(task);
    if (error)
      throw new Error(`Supabase errand task insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().tasks.push(task);
  }
  return task.id;
}

// --- Forecast ---------------------------------------------------------------

interface ForecastGather {
  projects: Goal[];
  /** Open (not done, not deferred) tasks per project — the forecast input. */
  tasksByProject: Map<string, CandidateTask[]>;
  /** All tasks per project (any status) — for divergence detection & sequencing. */
  allTasksByProject: Map<string, Task[]>;
  /**
   * A learning goal's unattained skill effort as synthetic work the ONE joint
   * forecast reasons over (alloc tasks + prereq dep edges + remaining estimates).
   * Keyed by goal id; only present for goals that have an open skill graph. This
   * is how skill progress moves the odds (OVERHAUL §5.4 follow-on). Recovery's
   * defer-moves deliberately ignore it — you can't yet "defer" a skill row.
   */
  skillWorkByProject: Map<string, SkillWork>;
  /** A goal's raw skill nodes (any state) — for the learning goal-cost read. */
  skillNodesByProject: Map<string, SkillNode[]>;
  /** A goal's definition-of-done criteria — for divergence detection & goal-cost. */
  criteriaByProject: Map<string, GoalCriterion[]>;
  /** Dependency edges keyed by entry — for the re-sequence recommendation. */
  deps: TaskDependency[];
  /** entry_id → the entry's goal (provenance only; tasks map to goals via `Task.goal_id`). */
  projectOfEntry: Map<string, string | null>;
  /** projectId → deadline (or null) for EVERY project — the global allocator spans all. */
  deadlineByProject: Map<string, string | null>;
  /** projectId → name for EVERY project — used to tag global order entries. */
  projectNameById: Map<string, string>;
  /** The user's estimation bias, fit from all completed tasks — calibrates the forecast. */
  model: EstimationModel;
  /**
   * The per-domain velocity model (OVERHAUL S2): `model` shrunk per `Task.area`,
   * with `model` as its global prior. `buildAllocTasks` reads `forSegment(area)`
   * to bias each task by its own domain velocity; a domain with no/sparse history
   * resolves to the global prior, so the forecast starts at today's number.
   */
  velocityModel: VelocityModel;
  /**
   * The GLOBAL per-window velocity (OVERHAUL S2 slice C) — `model` shrunk per
   * time-of-day window over every goal's session-tagged residuals. The energy-
   * window read renders from it, and `diagnoseCause`'s placement tempering uses it
   * as the prior. Empty session history ⇒ resolves to the global prior (no-regret).
   */
  windowVelocity: VelocityModel;
  /** projectId → its tasks' window-tagged residuals — the per-goal placement sample. */
  windowedResidualsByProject: Map<string, ResidualSample[]>;
  /**
   * OVERHAUL S3b Phase 2 — the global per-window velocity profile (share +
   * net-of-global multiplier) the windowed forecast flows over. Null until any
   * window has session history, so the forecast stays the exact day-granular path
   * (no-regret). Derived from `windowVelocity` + the session window counts.
   */
  windowProfile: WindowProfile | null;
  availability: Availability[];
  overrides: AvailabilityOverride[];
  /** All commitments INCLUDING the recurring drain (the base the forecast uses). */
  commitments: Commitment[];
  /** The real commitments WITHOUT recurring drain — for recomputing capacity when
   *  a skip-move probe removes some activity's hours. */
  realCommitments: Commitment[];
  /** Recurring activities + their completion log — the inputs a skip-move re-drains. */
  activities: RecurringActivity[];
  completions: ActivityCompletion[];
  /** The user's value model — importance weights + recovery style (OVERHAUL §5.1). */
  valueModel: ValueModel;
  today: string;
}

/** A learning goal's skill graph rendered as joint-forecast inputs. */
interface SkillWork {
  /** One synthetic alloc task per unattained skill — enters the global plan. */
  tasks: AllocTask[];
  /** Prereq edges among still-open skills (attained prereqs no longer constrain). */
  deps: DependencyEdge[];
  /** Unattained effort minutes — the per-goal forecast's remaining work. */
  estimates: number[];
}

// `SKILL_TASK_PREFIX` is defined in the client-safe portfolio-state module (the
// `attain_skill` forecast arm rebuilds the same id client-side) and imported above;
// the recovery/conflict code, which targets real rows, uses it to tell skill alloc
// tasks apart from real task uuids.

/**
 * Turn a learning goal's skill nodes into work the joint forecast can reason
 * over. Attained skills are "done" — dropped, exactly like done tasks; only the
 * unattained frontier consumes budget and carries prerequisite ordering. Pure.
 */
function skillAllocWork(
  nodes: SkillNode[],
  projectId: string,
  projectName: string,
): SkillWork {
  const open = nodes.filter((n) => !n.attained);
  const openIds = new Set(open.map((n) => n.id));
  const tasks = open.map((n) =>
    syntheticAllocTask(SKILL_TASK_PREFIX + n.id, projectId, projectName, n.title, n.estimated_minutes, {
      urgency: 3,
      // A checkpoint is a gate — weight it a touch higher so it orders ahead.
      impact: n.is_checkpoint ? 4 : 3,
      dependency: 3,
      risk: 3,
      effort: 3,
      confidence: 3,
    }),
  );
  const deps: DependencyEdge[] = [];
  for (const n of open) {
    for (const pre of n.prerequisites) {
      if (openIds.has(pre)) {
        deps.push({ task_id: SKILL_TASK_PREFIX + n.id, depends_on_task_id: SKILL_TASK_PREFIX + pre });
      }
    }
  }
  return { tasks, deps, estimates: open.map((n) => n.estimated_minutes) };
}

/** Collect deadlined projects, their open tasks, and the time budget. */
async function gatherForecast(): Promise<ForecastGather> {
  const [projects, entries, tasks, deps, rawBudget, activities, completions, valueModel, allSkillNodes, allGoalCriteria, workSessions, windowAvailability] =
    await Promise.all([
      listGoals(),
      listEntries(),
      listAllTasks(),
      listAllDependencies(),
      getRawTimeBudget(),
      listRecurringActivities(),
      listActivityCompletions(),
      getValueModel(),
      listAllSkillNodes(),
      listAllGoalCriteria(),
      listWorkSessions(),
      getWindowAvailability(),
    ]);
  const today = todayISO();
  // Fold the recurring drain into the commitment set the forecast reasons over.
  const commitments = [
    ...rawBudget.commitments,
    ...drainAsCommitments(activities, completions, today),
  ];
  const budget = {
    availability: rawBudget.availability,
    overrides: rawBudget.overrides,
    commitments,
  };
  const projectOfEntry = new Map(entries.map((e) => [e.id, e.goal_id]));
  const tasksByProject = new Map<string, CandidateTask[]>();
  const allTasksByProject = new Map<string, Task[]>();
  for (const t of tasks) {
    // The spine: a task belongs to its goal directly (no longer derived through
    // the entry it was ingested from). Entry is now just provenance.
    const pid = t.goal_id;
    if (!pid) continue;
    const all = allTasksByProject.get(pid) ?? [];
    all.push(t);
    allTasksByProject.set(pid, all);
    // Done work is finished; deferred work was pushed past this deadline — neither
    // counts against the time budget.
    if (t.status === "done" || t.deferred) continue;
    const list = tasksByProject.get(pid) ?? [];
    list.push({
      id: t.id,
      title: t.title,
      estimated_minutes: t.estimated_minutes,
      priority_score: t.priority_score,
    });
    tasksByProject.set(pid, list);
  }
  // Deadlines + names for EVERY project: the global allocator orders all open
  // work (undeadlined projects still consume the shared budget), even though
  // only deadlined projects receive a forecast probability.
  const deadlineByProject = new Map(projects.map((p) => [p.id, p.deadline]));
  const projectNameById = new Map(projects.map((p) => [p.id, p.name]));
  // Render each learning goal's open skill graph into joint-forecast work, so a
  // skill cleared frees budget and contention is shared with project tasks.
  const skillNodesByProject = new Map<string, SkillNode[]>();
  for (const n of allSkillNodes) {
    const list = skillNodesByProject.get(n.goal_id) ?? [];
    list.push(n);
    skillNodesByProject.set(n.goal_id, list);
  }
  const skillWorkByProject = new Map<string, SkillWork>();
  for (const [pid, nodes] of skillNodesByProject) {
    const work = skillAllocWork(nodes, pid, projectNameById.get(pid) ?? "");
    if (work.tasks.length) skillWorkByProject.set(pid, work);
  }
  // A goal's definition-of-done, grouped — divergence detection & the §5 goal-cost
  // read it per goal off the single bulk fetch (no per-goal round-trips).
  const criteriaByProject = new Map<string, GoalCriterion[]>();
  for (const c of allGoalCriteria) {
    const list = criteriaByProject.get(c.goal_id) ?? [];
    list.push(c);
    criteriaByProject.set(c.goal_id, list);
  }
  // Fit the global estimation bias once over every completed task (the bias is the
  // user's, not a project's), then shrink it per life-area (S2) using that same
  // fit as the prior — so a domain with one/sparse history stays at the global
  // number and only a clearly-divergent domain shifts its own tasks' odds.
  const model = estimationModel(tasks);
  const velocityModel = fitVelocityModel(
    taskResidualSamples(tasks),
    (s) => s.domain,
    model,
  );
  // S2 slice C — the WHEN axis. Join each goal's work sessions (local window) to
  // its tasks for window-tagged residuals: the global window velocity (the energy
  // windows the strategy surface renders + the placement-tempering prior) and the
  // per-goal sample the tempering asks "is this goal's overrun just its windows?"
  // over. Empty until session capture accrues ⇒ both resolve to the global prior.
  const tasksById = new Map(tasks.map((t) => [t.id, t]));
  const sessionsByProject = new Map<string, WorkSession[]>();
  for (const ws of workSessions) {
    const gid = ws.task_id ? tasksById.get(ws.task_id)?.goal_id : null;
    if (!gid) continue;
    const list = sessionsByProject.get(gid) ?? [];
    list.push(ws);
    sessionsByProject.set(gid, list);
  }
  const windowedResidualsByProject = new Map<string, ResidualSample[]>();
  for (const [gid, sess] of sessionsByProject) {
    windowedResidualsByProject.set(gid, workSessionResidualSamples(sess, tasksById));
  }
  const allWindowSamples = [...windowedResidualsByProject.values()].flat();
  const windowVelocity = fitVelocityModel(allWindowSamples, (s) => s.window, model);
  // S3b Phase 2 — the windowed-forecast profile: per-window net multiplier (from the
  // same shrunk window velocity the "reliable hours" card renders) + a shrunk session
  // share that bounds how much work claims each window. Null until a session is logged,
  // so the headline stays today's day-granular number until the loop has WHEN-data.
  // S3b Phase 4 — an explicit per-window availability (when the user pinned one) OVERRIDES
  // the derived share; the velocity multipliers still come from learned data, and the
  // null-gate is unchanged, so a pin has no effect until window velocity is earned.
  const windowProfile = windowProfileFromEnergy(
    energyWindows(allWindowSamples, model),
    model,
    { shareOverride: windowShareOverride(windowAvailability) },
  );
  return {
    projects: projects.filter((p) => p.deadline),
    tasksByProject,
    allTasksByProject,
    skillWorkByProject,
    skillNodesByProject,
    criteriaByProject,
    deps,
    projectOfEntry,
    deadlineByProject,
    projectNameById,
    model,
    velocityModel,
    windowVelocity,
    windowedResidualsByProject,
    windowProfile,
    availability: budget.availability,
    overrides: budget.overrides,
    commitments: budget.commitments,
    realCommitments: rawBudget.commitments,
    activities,
    completions,
    valueModel,
    today,
  };
}

/** Forecast options carrying the learned estimation bias (sigma + meanLog). */
/** Every open (not done, not deferred) task across all projects, as the allocator sees it. */
function buildAllocTasks(g: ForecastGather): AllocTask[] {
  const out: AllocTask[] = [];
  for (const [pid, tasks] of g.allTasksByProject) {
    const projectName = g.projectNameById.get(pid) ?? "";
    for (const t of tasks) {
      if (t.status === "done" || t.deferred) continue;
      out.push({
        id: t.id,
        title: t.title,
        projectId: pid,
        projectName,
        estimatedMinutes: t.estimated_minutes,
        status: t.status,
        priorityScore: t.priority_score ?? 0,
        urgency: t.urgency_score ?? 3,
        impact: t.impact_score ?? 3,
        risk: t.risk_score ?? 3,
        // Value Model: scale this task's cost-of-delay by its life-area's importance.
        importance: areaWeight(g.valueModel, t.area),
        // S2: bias this task's forecast by its life-area's own velocity (shrunk
        // toward the global bias; a sparse/new area resolves back to it).
        model: toSegmentModel(g.velocityModel.forSegment(t.area)),
        // S3b: cognitive-load weight (the comfort cap's "hard work" axis).
        difficulty: effortToDifficulty(t.effort_score),
      });
    }
  }
  // Learning goals' unattained skills compete for the same hours as project tasks.
  for (const work of g.skillWorkByProject.values()) out.push(...work.tasks);
  return out;
}

function allocContext(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
): AllocContext {
  const budget = { availability: g.availability, overrides: g.overrides, commitments };
  return {
    tasks: buildAllocTasks(g),
    deps: [
      ...g.deps.map((d) => ({
        task_id: d.task_id,
        depends_on_task_id: d.depends_on_task_id,
      })),
      // Skill prerequisites order the learning frontier inside the same plan.
      ...[...g.skillWorkByProject.values()].flatMap((w) => w.deps),
    ],
    budget,
    capacities: dayCapacities(budget, g.today),
  };
}

/**
 * Joint completion odds for every deadlined project from ONE Monte Carlo over
 * the global order built from `ctx.tasks`, optionally with some tasks shed
 * (`excluded` — the deferred set a triage probe is testing). Lower `iterations`
 * trades a little precision for speed on the repeated triage probes.
 */
function jointOdds(
  g: ForecastGather,
  ctx: AllocContext,
  excluded: Set<string> = new Set(),
  iterations?: number,
): Map<string, number> {
  const tasks = excluded.size
    ? ctx.tasks.filter((t) => !excluded.has(t.id))
    : ctx.tasks;
  const plan = buildGlobalPlan({
    tasks,
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    budget: ctx.budget,
    today: g.today,
  });
  const opts: ForecastOptions = {
    ...forecastOptions(g.model),
    ...(iterations !== undefined ? { iterations } : {}),
  };
  // S3b Phase 2 — price time-of-day velocity: split the day capacities into window
  // segments (net multipliers from the learned window velocity). Null profile ⇒ the
  // exact day-granular path, so the number is unchanged until the loop learns windows.
  if (g.windowProfile) {
    opts.windowCapacities = windowCapacities(ctx.capacities, g.windowProfile);
  }
  return globalForecast(plan.order, ctx.capacities, g.deadlineByProject, g.today, opts);
}

/**
 * Contention-aware completion odds for every deadlined project, from ONE joint
 * Monte Carlo over the global order under a given commitment set. The single
 * source the per-project forecasts and recovery gating both draw their
 * probability from (locked decision #1).
 */
function globalOdds(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
): Map<string, number> {
  return jointOdds(g, allocContext(g, commitments));
}


/** Fewer MC iterations for the optimizer's repeated probes (matches the triage
 *  probes' `TRIAGE_PROBE_ITERATIONS` — a relative read is all the greedy needs). */
const JOINT_PROBE_ITERATIONS = 2000;

/**
 * The portfolio strategy's joint scorer: one gather + dashboard computation, plus
 * closures the optimizer and the bold-tier re-scorer probe against. Built once
 * per generation so the strategist does not double-gather (replaces its
 * `forecastDashboard()` call). All inputs are server-only (RLS-scoped gather);
 * the scorer closures are pure CPU over the captured state.
 */
export interface JointScorer {
  forecasts: ProjectForecast[];
  recoveries: RecoveryPlan[];
  pitWall: PitWall;
  /** Active recurring activities — the pool of `skip_activity` candidates. */
  activities: RecurringActivity[];
  /** The user's value model — the optimizer reads its recovery-style move prefs. */
  valueModel: ValueModel;
  /** Current joint odds per deadlined project, no moves applied. */
  baseByProject: Map<string, number>;
  /** Current portfolio conjunction (P(all land)), no moves applied. */
  baseAllOnTime: number;
  /** Reduced-iteration joint score of an ordered move set — for optimizer probes. */
  score(moves: StrategyMove[]): { byProject: Map<string, number>; allOnTime: number };
  /** Full-iteration cumulative odds of an ordered move set — for the display. */
  cumulative(ordered: StrategyMove[]): { afterEach: number[]; combined: number };
  /** The serialized gather slice the review screen re-solves move subsets against
   *  client-side (attached to the generated `PortfolioStrategy`). */
  resolveInput: ResolveInput;
}

/**
 * Per-day HOURS that skipping each active recurring activity this week frees back to
 * the shared pool — its current-week owed instances' drain, attributed by day (the
 * owed-date logic single-sourced via `currentWeekOwedDates`, matching the skip arm of
 * `applyMoveToAlloc`). The client adds the selected activities' series onto the SIGNED
 * base slack (`ResolveInput.baseSlackHours`) and floors ONCE, so any subset of skips
 * composes EXACTLY as the server's `jointOddsWithMoves` recompute does — even on an
 * over-subscribed day, where the old floored-per-skip deltas under-counted. An activity
 * with nothing owed this week frees nothing (a zero series).
 */
function skipDrainHoursByActivity(
  g: ForecastGather,
  ctx: AllocContext,
): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  const isoIndex = new Map(ctx.capacities.map((c, i) => [c.iso, i] as const));
  for (const a of g.activities) {
    if (!a.active) continue;
    const series = ctx.capacities.map(() => 0);
    for (const date of currentWeekOwedDates(a, g.completions, g.today)) {
      const idx = isoIndex.get(date);
      if (idx !== undefined) series[idx] += a.estimated_minutes / 60;
    }
    out[a.id] = series;
  }
  return out;
}

/** Serialize the generation-time gather slice into the plain-JSON `ResolveInput`
 *  the review screen re-solves move subsets against (OVERHAUL S1 / vision §8.2).
 *  `baseSlackHours` is the SIGNED slack (its floor is `ctx.capacities`) so multi-skip
 *  re-solves compose exactly; see `skipDrainHoursByActivity`. */
function buildResolveInput(
  g: ForecastGather,
  ctx: AllocContext,
  comfortCapMinutes: number | null,
  arrangeReorder: boolean,
  thinBuffer: ReadonlyMap<string, number>,
  committedOrder: string[] | null,
): ResolveInput {
  return {
    tasks: ctx.tasks,
    deps: ctx.deps,
    capacities: ctx.capacities,
    deadlineByProject: [...g.deadlineByProject],
    today: g.today,
    model: { meanLog: g.model.meanLog, sigma: g.model.sigma },
    baseSlackHours: daySlackHours(ctx.budget, g.today).map((s) => s.slackHours),
    skipDrainHoursByActivity: skipDrainHoursByActivity(g, ctx),
    // S3b Phase 2 — ship the static window profile so the client rebuilds identical
    // window segments from its own (skip-adjusted) capacities (parity rides for free).
    windowProfile: g.windowProfile,
    // S3b Phase 3 slice 2 — ship the one comfort cap the scorer decided so the client's
    // subset re-solve meters by the same scalar (it takes precedence over the window
    // profile, matching `resolveSubsetOdds`).
    comfortCapMinutes,
    // S3b Phase 3 slice 3 — ship the within-day reorder flag the scorer decided so the
    // client replays the SAME deterministic `arrangeOrder` on its re-derived order (the
    // reorder reads only inputs already in `ResolveInput`, so parity rides for free).
    arrangeReorder,
    // S3b Phase 3 `w_buffer` follow-on (graded in Phase 4) — ship the at-risk projects'
    // thin-buffer URGENCY the scorer flagged on the base, as a JSON-safe record. The client
    // rebuilds the Map and feeds the SAME `arrangeOrder`, so the buffer-biased order stays
    // bit-identical (it can't be recomputed client-side — needs the per-project forecast dist).
    thinBufferUrgency: Object.fromEntries(thinBuffer),
    // S3c-1 — when the rolling-horizon wrapper is showing a STICKY committed plan, ship its
    // order (task-id sequence, already reconciled to the current set) so the client's empty
    // (base) subset prices it VERBATIM (reorder OFF) instead of re-deriving + re-arranging —
    // the server already arranged + gated it, so this is a pure replay and the base re-solve
    // stays client==server EXACT. Null (fresh candidate) ⇒ the pre-S3c path, bit-for-bit.
    committedOrder: committedOrder ?? undefined,
  };
}

// --- Rolling-horizon roll cycle (S3c-1) -------------------------------------
//
// The S3b arrangement pipeline (`buildGlobalPlan → comfortSmooth → gatedReorder`) prices the
// best arrangement RIGHT NOW; S3c decides which already-priced arrangement to keep committing
// to as time advances. `buildArrangement` is the shared pipeline both read paths and the
// mutation-time roll run (so all three price identically); `rollContextFor` wraps it as the
// pure `rollDecision`'s inputs (with the MC reprice + soft-J scorer injected as closures — the
// odds engine stays here, the decision logic lives in `lib/rolling.ts`). Reads DECIDE what to
// show and persist nothing; the write path (`commitRollingPlan`) is the only writer. See
// `design/s3c-rolling-horizon-wrapper.md`.

/** The S3b arrangement bundle for a gather: the canonical plan, the comfort decision, the
 *  thin-buffer urgency map, and the odds-gated candidate arrangement (order + priced odds) the
 *  user would otherwise follow. Computed once and shared by every S3c call site so the
 *  displayed plan, the strategy base, and the roll all price the SAME candidate. */
interface ArrangementBundle {
  canonical: GlobalPlan;
  smoothed: ComfortSmoothResult;
  thinBuffer: ReadonlyMap<string, number>;
  comfortCapMinutes: number | null;
  /** The odds-gated within-day reorder — `.order` is the display/candidate order, `.joint`
   *  its priced odds, `.changed` the single boolean the S1 client + probes replay. */
  reorder: GatedReorderResult;
  arrangeReorder: boolean;
  /** The arrange options the candidate was built under — reused by the churn bucketing +
   *  the soft-J scorer so the roll measures the same plan the forecast priced. */
  arrangeOpts: ArrangeOrderOptions;
}

/** Run the S3b arrangement pipeline for a gather (the same steps `forecastDashboard` /
 *  `createJointScorer` already ran inline). No Monte-Carlo beyond what `comfortSmooth` +
 *  `gatedReorder` already do. Pure over the gather. */
function buildArrangement(g: ForecastGather, ctx: AllocContext): ArrangementBundle {
  const canonical = buildGlobalPlan({
    tasks: ctx.tasks,
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    budget: ctx.budget,
    today: g.today,
  });
  const smoothed = comfortSmooth(canonical.order, ctx.capacities, g.deadlineByProject, g.today, {
    forecast: forecastOptions(g.model),
    windowProfile: g.windowProfile,
  });
  const comfortCapMinutes = smoothed.comfortCapMinutes;
  const thinBuffer = thinBufferUrgencyMap(g, g.commitments, smoothed.joint.byProject);
  const reorder = gatedReorder(
    canonical.order,
    ctx.capacities,
    g.deadlineByProject,
    g.today,
    ctx.deps,
    smoothed.joint,
    {
      forecast: forecastOptions(g.model),
      windowProfile: g.windowProfile,
      comfortCapMinutes,
      thinBufferUrgency: thinBuffer,
    },
  );
  const arrangeOpts: ArrangeOrderOptions = {
    windowProfile: g.windowProfile,
    comfortCapMinutes,
    thinBufferUrgency: thinBuffer,
  };
  return {
    canonical,
    smoothed,
    thinBuffer,
    comfortCapMinutes,
    reorder,
    arrangeReorder: reorder.changed,
    arrangeOpts,
  };
}

/**
 * A stable hash of the situation the committed plan is anchored to — the roll trigger. Reuses
 * the `computePortfolioFingerprint` discipline (bucketed due-dates so far-future edits don't
 * churn) but reads the already-built gather (pure, no re-query) and EXTENDS it with the
 * window-profile + velocity generation (`g.windowProfile` / `g.model`) so an S2 model update is
 * itself a legitimate roll trigger, and the value model (importance re-ranks under contention).
 * An unchanged fingerprint + anchor ⇒ nothing plan-relevant moved ⇒ the roll stays put cheaply.
 */
function rollFingerprint(g: ForecastGather, ctx: AllocContext): string {
  // Coarse due bucket relative to today — bucketing (not the raw date) keeps far-future
  // deadline edits from churning the fingerprint while still catching a deadline crossing into
  // "overdue" or "soon" (the `computePortfolioFingerprint` discipline, kept local + pure).
  const dueBucket = (dl: string): "overdue" | "soon" | "future" => {
    const d = dl.slice(0, 10);
    if (d < g.today) return "overdue";
    const [ay, am, ad] = g.today.split("-").map(Number);
    const [by, bm, bd] = d.split("-").map(Number);
    const days = Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
    return days <= 7 ? "soon" : "future";
  };
  const tasks = ctx.tasks
    .map((t) => ({
      id: t.id,
      est: t.estimatedMinutes,
      diff: t.difficulty ?? 0,
      imp: t.impact,
      urg: t.urgency,
      risk: t.risk,
      w: t.importance ?? 1,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const deadlines = [...g.deadlineByProject]
    .map(([id, dl]) => [id, dl ? dueBucket(dl) : "none"] as const)
    .sort((a, b) => a[0].localeCompare(b[0]));
  const commitments = g.commitments
    .map((c) => ({ date: c.date.slice(0, 10), hours: c.hours }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.hours - b.hours);
  // Availability + overrides are as capacity-determining as commitments (all three feed
  // `deployableMinutes`), so a change to either must roll the plan — hash them too, else the
  // write-side fast path would wrongly short-circuit on a pure capacity edit.
  const availability = g.availability
    .map((a) => ({ weekday: a.weekday, hours: a.hours }))
    .sort((a, b) => a.weekday - b.weekday);
  const overrides = g.overrides
    .map((o) => ({ date: o.date.slice(0, 10), hours: o.hours }))
    .sort((a, b) => a.date.localeCompare(b.date));
  const canonical = JSON.stringify({
    today: g.today,
    tasks,
    deadlines,
    commitments,
    availability,
    overrides,
    // The S2 window-velocity + global-velocity generation — a model update rolls the plan.
    windowProfile: g.windowProfile,
    model: { meanLog: g.model.meanLog, sigma: g.model.sigma, n: g.model.sampleSize },
    valueModel: g.valueModel,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The forecast options a committed order is REPRICED under — the same composition
 *  (`comfortCapMinutes` + windowed pricing) `gatedReorder` / `jointOddsWithMoves` use for the
 *  candidate, so the sticky plan is weighed apples-to-apples against the fresh one. */
function repriceOptionsFor(
  g: ForecastGather,
  ctx: AllocContext,
  bundle: ArrangementBundle,
): ForecastOptions {
  const opts: ForecastOptions = { ...forecastOptions(g.model) };
  if (bundle.comfortCapMinutes != null) opts.comfortCapMinutes = bundle.comfortCapMinutes;
  if (g.windowProfile) opts.windowCapacities = windowCapacities(ctx.capacities, g.windowProfile);
  return opts;
}

/** The cookie the client `LocalNowBeacon` stamps with the browser's local day + minute-of-day
 *  (S3c-4). Read-only server-side; the value the intra-day frozen zone sharpens against. */
const LOCAL_NOW_COOKIE = "tb_local_now";

/**
 * Read the client-captured local "now" from the request cookie (S3c-4) — the S2 timezone-gotcha
 * resolution: the browser stamps its OWN local day/minute (`LocalNowBeacon`), never re-derived
 * from the server's UTC clock. Returns `undefined` on any absence / malformation / out-of-range
 * value, so the roll falls back to date-granular churn, byte-identical to S3c-1 (the no-regret
 * path). Never throws: a bad cookie, or a call outside a request scope, must not break a render —
 * the anchor-dependent fallbacks (date mismatch, no day-0 capacity) live in `resolveElapsedToday`.
 * Format is `YYYY-MM-DD|minutesSinceMidnight`; parsed + bounds-checked here.
 */
async function readClientLocalNow(): Promise<LocalNow | undefined> {
  try {
    const raw = (await cookies()).get(LOCAL_NOW_COOKIE)?.value;
    if (!raw) return undefined;
    const [date, minsStr] = raw.split("|");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
    // Digit-shape guard BEFORE Number(): an empty / non-numeric minutes segment (`"2026-07-08|"`)
    // would otherwise coerce to 0 and read as midnight. Reject it ⇒ date-granular fallback.
    if (!minsStr || !/^\d+$/.test(minsStr)) return undefined;
    const minutesSinceMidnight = Number(minsStr);
    if (minutesSinceMidnight > 1439) return undefined;
    return { date, minutesSinceMidnight };
  } catch {
    return undefined;
  }
}

/** Build the pure `rollDecision` inputs for a gather + its arrangement bundle. The Monte-Carlo
 *  reprice and the soft-`J` scorer are injected as closures over the CURRENT situation, so the
 *  reconciled committed plan is priced apples-to-apples with the candidate (same comfort cap +
 *  window pricing), and the decision module authors no odds itself. `localNow` (S3c-4, the
 *  client-captured clock; `undefined` ⇒ date-granular) enters ONLY the churn near-weight — never
 *  odds, the persisted plan, or the fingerprint (a clock tick is not a situation change). */
function rollContextFor(
  g: ForecastGather,
  ctx: AllocContext,
  bundle: ArrangementBundle,
  committed: CommittedPlan | null,
  localNow?: LocalNow,
  hysteresis?: CalibratedHysteresis,
): RollContext {
  const repriceOpts = repriceOptionsFor(g, ctx, bundle);
  return {
    committed,
    canonicalOrder: bundle.canonical.order,
    candidate: { order: bundle.reorder.order, allOnTime: bundle.reorder.joint.allOnTime },
    anchor: g.today,
    fingerprint: rollFingerprint(g, ctx),
    localNow,
    repriceAllOnTime: (order) =>
      globalForecastJoint(order, ctx.capacities, g.deadlineByProject, g.today, repriceOpts).allOnTime,
    scoreJ: (order) => arrangementScore(order, ctx.capacities, g.today, bundle.arrangeOpts),
    capacities: ctx.capacities,
    arrangeOpts: bundle.arrangeOpts,
    // S3c-5 (🟡 tier): the hysteresis knobs, EB-calibrated from the user's roll-undo history
    // (`undefined` ⇒ rollDecision falls back to the documented constants, the no-regret path).
    stabilityMargin: hysteresis?.stabilityMargin,
    churnCost: hysteresis?.churnCost,
  };
}

/**
 * Roll the committed plan forward and PERSIST the winner — the write-path mutation (§4 step 6).
 * Called after every mutation (the situation-changing events); the read paths decide what to
 * show but never write. Fast path: an unchanged fingerprint + anchor with an existing row means
 * nothing plan-relevant moved, so it re-prices nothing and writes nothing. The mutation hook
 * (`afterMutation` in `actions.ts`) calls this best-effort — swallowing any failure so a roll
 * can never break the mutation that triggered it (the read path still shows a correct plan, and
 * the next mutation re-rolls). Returns the decision for observability.
 */
export async function commitRollingPlan(): Promise<RollDecisionResult | null> {
  const g = await gatherForecast();
  const ctx = allocContext(g, g.commitments);
  const committed = await getCommittedPlan();
  // Fast path — nothing plan-relevant changed since the committed row: keep it, no MC, no write.
  if (
    committed &&
    committed.anchor === g.today &&
    committed.fingerprint === rollFingerprint(g, ctx)
  ) {
    return null;
  }
  const bundle = buildArrangement(g, ctx);
  // S3c-4: the client's local "now" sharpens the frozen zone to the imminent part of today. It
  // rides ONLY the churn near-weight — it is deliberately NOT in `rollFingerprint`, so the fast
  // path above still short-circuits on a pure clock tick (a tick is not a situation change); it
  // only refines which sticky arrangement the gate prefers once a real mutation forces the roll.
  // S3c-5 (🟡 tier): calibrate the hysteresis knobs from the roll-undo history. Fetched only
  // past the fast path (a genuine re-plan), in parallel with the client clock — no rolls ⇒ the
  // documented constants, so a first-ever roll is byte-identical to pre-S3c-5.
  const [localNow, rolls] = await Promise.all([readClientLocalNow(), listPlanRolls()]);
  const hysteresis = calibrateHysteresis(rolls);
  const decision = rollDecision(rollContextFor(g, ctx, bundle, committed, localNow, hysteresis));
  if (decision.shouldPersist) {
    await setCommittedPlan(decision.toPersist);
    // Persist-on-roll (S3c-2): retain a history entry for a GENUINE plan change (a
    // material better-candidate or an anchor advance), never a stay-put freshen — so the
    // timeline shows real evolution, not every reload. Same best-effort guard as the
    // upsert above: a throw here is swallowed by the mutation hook's try/catch.
    const rollKind = planRollKind(decision, committed);
    if (rollKind) {
      const plan = decision.toPersist;
      await insertPlanRoll({
        id: crypto.randomUUID(),
        rolledAt: plan.committedAt,
        anchor: plan.anchor,
        fingerprint: plan.fingerprint,
        j: plan.j,
        kind: rollKind.kind,
        prevJ: rollKind.prevJ,
        order: plan.order,
        revertedAt: null,
        schemaVersion: plan.schemaVersion,
      });
    }
  }
  return decision;
}

/**
 * Undo one automatic roll (design/s3c2-passive-roll-history.md §4) — the ARRANGEMENT
 * counterpart to `undoPlanVersion`. NOT a row restore: it takes the arrangement `roll`
 * superseded (the immediately-prior roll's order, or a fresh build if `roll` was the
 * first-ever commit) and re-commits it, but only after feeding it back through the S3c-1
 * read path via `undoRollDecision` — reconcile against the current task set (a completed /
 * deleted-since task is dropped, never resurrected) then re-price, with odds/feasibility
 * overriding a stale restore. The stored order is a PREFERENCE SEED, not restored truth.
 *
 * Re-commits under the CURRENT fingerprint + anchor so the roll `revalidateAll` fires right
 * after this stays put: the restore holds against the soft stability gate (otherwise the very
 * gain that caused the roll would re-adopt the candidate and make undo a no-op). Idempotent —
 * a second undo of an already-reverted roll is a no-op. The undone roll stays in history with
 * `revertedAt` set (struck-through in the timeline), same as `undoPlanVersion`.
 */
export async function undoPlanRoll(id: string): Promise<void> {
  const roll = await getPlanRoll(id);
  if (!roll || roll.revertedAt) return; // idempotent — gone, or already reverted

  const prior = await priorPlanRoll(roll);
  const g = await gatherForecast();
  const ctx = allocContext(g, g.commitments);
  const bundle = buildArrangement(g, ctx);
  const repriceOpts = repriceOptionsFor(g, ctx, bundle);

  const decision = undoRollDecision({
    // The arrangement `roll` superseded: the immediately-prior roll, or (no prior ⇒ `roll`
    // was the first-ever commit) no earlier preference at all = a fresh S3b build.
    restoredOrder: prior ? prior.order : bundle.reorder.order,
    canonicalOrder: bundle.canonical.order,
    candidate: {
      order: bundle.reorder.order,
      allOnTime: bundle.reorder.joint.allOnTime,
    },
    repriceAllOnTime: (order) =>
      globalForecastJoint(order, ctx.capacities, g.deadlineByProject, g.today, repriceOpts)
        .allOnTime,
    scoreJ: (order) => arrangementScore(order, ctx.capacities, g.today, bundle.arrangeOpts),
  });

  await setCommittedPlan({
    schemaVersion: COMMITTED_PLAN_SCHEMA_VERSION,
    order: decision.order,
    anchor: g.today,
    fingerprint: rollFingerprint(g, ctx),
    j: decision.j,
    committedAt: new Date().toISOString(),
  });

  await markPlanRollReverted(id);
}

/**
 * S3c-6 — read-side idempotent anchor-roll. On a QUIET new day (a committed plan exists and the
 * roll decision kept it STICKY, but its frozen-zone `anchor` predates today) advance the stored
 * anchor to today FROM THE READ PATH, so the persisted frozen zone is fresh without waiting for
 * the next mutation. v1 already displays correctly regardless (`packGlobal` re-buckets from
 * `g.today`); this only tightens the stored `anchor` / `fingerprint` so the frozen-zone day is
 * accurate and the next mutation's fast path can short-circuit. It authors no odds and no new
 * arrangement — it re-anchors the plan the decision ALREADY chose to keep.
 *
 * Two guarantees keep this a safe write from a read (design §7 S3c-6 + the advance-silently call):
 *   - Gated on `decision.sticky`: a read NEVER persists a *material* re-arrangement. A genuine
 *     roll still waits for the mutation path (the sole writer of arrangement changes); here we
 *     only bump the anchor of a plan that stayed sticky.
 *   - No history row, just the convergent singleton `committed_plan` upsert: a silent day-advance
 *     is bookkeeping, not a timeline event, so concurrent loads on the same new day converge on
 *     the same anchor instead of double-logging an "anchor" roll. Best-effort — a write failure
 *     must never break a render (the displayed sticky plan is already correct), and it must not
 *     revalidate (we are inside a Server Component render; display already == the persisted order).
 *
 * Idempotent: after the write `committed.anchor === today`, so a second load the same day returns
 * before touching the DB. `decision.toPersist.anchor` is the read's `g.today`, so comparing the
 * stored anchor against it is the "is the frozen-zone day stale" test.
 */
async function advanceAnchorOnQuietDay(
  committed: CommittedPlan | null,
  decision: RollDecisionResult,
): Promise<void> {
  if (!committed || !decision.sticky) return;
  if (committed.anchor === decision.toPersist.anchor) return; // anchor already fresh — no-op
  try {
    await setCommittedPlan(decision.toPersist);
  } catch {
    // Leaving the stale anchor is harmless: the display is unaffected and the next mutation
    // advances it. A render must never fail on a bookkeeping refresh.
  }
}

export async function createJointScorer(): Promise<JointScorer> {
  // The cached strategy is the temporal baseline for cause-diagnosis: the
  // optimizer reads each recovery's `cause` for the step-5 response-class
  // tiebreak, and `constraint_change` can only be diagnosed against it (a task
  // added since, or odds that have since dropped). Without it the optimizer's
  // causes would silently collapse to the residual-only classes. Loaded in
  // parallel with the gather so it adds no latency.
  const [g, cachedStrategy, committed, localNow, rolls] = await Promise.all([
    gatherForecast(),
    getCachedStrategy(),
    getCommittedPlan(),
    readClientLocalNow(),
    listPlanRolls(),
  ]);
  const ctx = allocContext(g, g.commitments);
  // The S3b arrangement pipeline decides the comfort cap, the thin-buffer urgency, and the
  // odds-gated within-day reorder ONCE on the base canonical order (the same decision
  // `forecastDashboard` makes), then meters EVERY joint re-solve by them: the base, the
  // optimizer's move probes, the cumulative display, AND the client subset re-solve. No-regret:
  // no cap / no reorder signal ⇒ the exact pre-S3b (windowed) path, bit-for-bit.
  const bundle = buildArrangement(g, ctx);
  const { comfortCapMinutes, thinBuffer, arrangeReorder } = bundle;
  // S3c-1 rolling horizon — decide whether to keep committing to the plan the user is already
  // following (sticky) or adopt the fresh candidate. Reads persist NOTHING (the mutation-time
  // roll is the sole writer); this only picks the "before" the strategy page reasons from.
  // When sticky, the committed order is priced + shipped VERBATIM with the reorder flag OFF,
  // so the S1 client re-solve of the empty (base) subset stays EXACT (decision #5). Move-probes
  // (non-empty subsets) still use the fresh arrangement — a strategy move is a re-plan, never a
  // sticky hold. No-regret: no committed row ⇒ the candidate verbatim ⇒ pre-S3c path, bit-for-bit.
  // S3c-4: `localNow` sharpens the frozen zone to the imminent part of today (read-only; never
  // persisted, never in odds or the fingerprint) — `undefined` ⇒ date-granular, exactly S3c-1.
  // S3c-5 (🟡 tier): the read decides what to SHOW with the same calibrated hysteresis the
  // write path commits under, so display and persist never disagree on stickiness.
  const decision = rollDecision(
    rollContextFor(g, ctx, bundle, committed, localNow, calibrateHysteresis(rolls)),
  );
  // S3c-6: on a quiet new day, refresh the committed row's frozen-zone anchor from this read.
  await advanceAnchorOnQuietDay(committed, decision);
  const committedOrder = decision.sticky ? decision.order.map((e) => e.taskId) : null;
  // The joint re-solve context carries the cap + the reorder flag + the thin-buffer set
  // (mirrors how `windowProfile` rides on `g`) plus the sticky committed order; every
  // `jointOddsWithMoves` / `cumulativeJointOdds` below reads them off `jg`.
  const jg = { ...g, comfortCapMinutes, arrangeReorder, thinBufferUrgency: thinBuffer, committedOrder };
  const base = jointOddsWithMoves(jg, ctx, []);
  const baseByProject = base.byProject;

  const forecasts = buildForecasts(g, g.commitments, baseByProject);
  const pitWall = buildPitWall(g, ctx, baseByProject);
  const recoveries = g.projects
    .map((p) => buildRecoveryPlan(g, p, baseByProject, pitWall.conflicts, cachedStrategy))
    .filter((plan): plan is RecoveryPlan => plan !== null);

  return {
    forecasts,
    recoveries,
    pitWall,
    activities: g.activities.filter((a) => a.active),
    valueModel: g.valueModel,
    baseByProject,
    baseAllOnTime: base.allOnTime,
    score: (moves) => jointOddsWithMoves(jg, ctx, moves, JOINT_PROBE_ITERATIONS),
    cumulative: (ordered) => cumulativeJointOdds(jg, ctx, ordered),
    resolveInput: buildResolveInput(g, ctx, comfortCapMinutes, arrangeReorder, thinBuffer, committedOrder),
  };
}

// --- The pit wall: conflict detection + contention-aware triage -------------

/** How many lowest-WSJF tasks a triage search probes before giving up. */
const MAX_TRIAGE_PROBES = 12;
/** Fewer MC iterations on the repeated triage probes — they only need a relative read. */
const TRIAGE_PROBE_ITERATIONS = 2000;
/** A deferral counts as helping only if it lifts some project's odds by at least this. */
const TRIAGE_MIN_GAIN = 0.01;
/** Two still-failing projects whose values are this close are a genuine tie to escalate. */
const COMPARABLE_VALUE_RATIO = 0.75;

/**
 * What the global allocation can't satisfy, and what to do about it. `conflicts`
 * names the projects that can't make their deadlines once they share the hours;
 * `triage` is the recommended low-value work to shed to recover the savable ones
 * (best-first); `needsDecision` is the one case auto-triage won't resolve — two
 * comparable-value projects colliding, where the user must pick which to protect.
 */
export interface PitWall {
  conflicts: Conflict[];
  triage: TriageMove[];
  needsDecision: boolean;
  /**
   * When `needsDecision`, the mutually-exclusive resolutions of the tie — one
   * per colliding project, "protect this one, shed the others". Empty otherwise.
   */
  options: PitWallOption[];
}

/** Conflicts in the point-estimate global plan for this gather (no Monte Carlo). */
function planConflicts(g: ForecastGather, ctx: AllocContext): Conflict[] {
  const plan = buildGlobalPlan({
    tasks: ctx.tasks,
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    budget: ctx.budget,
    today: g.today,
  });
  return detectConflicts(plan.order, ctx.capacities, g.deadlineByProject, g.today);
}

/**
 * The pit wall for a gather: which deadlined projects can't make it under
 * contention, the lowest-WSJF work to shed to recover the savable ones, and
 * whether what's left is a comparable-value tie that must be escalated.
 *
 * Triage is contention-aware (the G3 promise): each candidate deferral is scored
 * by re-running the *joint* Monte Carlo with that task (and the ones already
 * shed) removed, so the recovered odds account for the freed shared hours — not a
 * solo per-project estimate. Walks candidates lowest-WSJF first and keeps a
 * deferral only when it meaningfully lifts some project's odds (locked #3).
 */
function buildPitWall(
  g: ForecastGather,
  ctx: AllocContext,
  baseOdds: Map<string, number>,
): PitWall {
  const conflicts = planConflicts(g, ctx);
  if (conflicts.length === 0) {
    return { conflicts: [], triage: [], needsDecision: false, options: [] };
  }

  const onTrackEverywhere = (odds: Map<string, number>) =>
    g.projects.every((p) => isOnTrack(odds.get(p.id) ?? 1));

  // Open-task count per project — so triage can scope a project *down* but never
  // shed its last task. Deferring a project's entire open work would read as a
  // vacuous 100% ("no work left ⇒ finished"), which is abandonment, not recovery
  // — and abandonment is the escalated decision below, never an auto move.
  const openCount = new Map<string, number>();
  for (const t of ctx.tasks) openCount.set(t.projectId, (openCount.get(t.projectId) ?? 0) + 1);

  // Shed the lowest-WSJF open work of the conflicted (over-budget) projects —
  // the obvious low-value doomed work auto can relieve on its own (locked #3).
  const conflictedIds = new Set(conflicts.map((c) => c.projectId));
  const candidates = triageCandidates(
    ctx.tasks,
    conflictedIds,
    g.deadlineByProject,
    g.today,
  ).slice(0, MAX_TRIAGE_PROBES);

  const triage: TriageMove[] = [];
  const deferred = new Set<string>();
  const remaining = new Map(openCount);
  let currentOdds = baseOdds;

  for (const cand of candidates) {
    if (onTrackEverywhere(currentOdds)) break;
    // Never abandon a project via triage (leave it at least one open task).
    if ((remaining.get(cand.task.projectId) ?? 0) <= 1) continue;

    const trial = jointOdds(
      g,
      ctx,
      new Set([...deferred, cand.task.id]),
      TRIAGE_PROBE_ITERATIONS,
    );
    // The project this deferral helps most — shedding low-value work of one
    // project frees shared hours that may rescue a different, higher-value one.
    let bestPid = "";
    let bestGain = 0;
    for (const p of g.projects) {
      const gain = (trial.get(p.id) ?? 1) - (currentOdds.get(p.id) ?? 1);
      if (gain > bestGain) {
        bestGain = gain;
        bestPid = p.id;
      }
    }
    if (bestGain >= TRIAGE_MIN_GAIN) {
      deferred.add(cand.task.id);
      remaining.set(cand.task.projectId, (remaining.get(cand.task.projectId) ?? 1) - 1);
      triage.push({
        taskId: cand.task.id,
        title: cand.task.title,
        projectId: cand.task.projectId,
        estimatedMinutes: cand.task.estimatedMinutes,
        wsjf: cand.wsjf,
        probabilityAfter: trial.get(bestPid) ?? 0,
      });
      currentOdds = trial;
    }
  }

  // Escalate ONLY a genuine tie: two projects whose deadlines collide over the
  // shared hours and whose aggregate values are close enough that auto can't say
  // which to protect — the one manual call (locked #3). A collision with a clear
  // low-value loser isn't a tie: triage above already sheds the loser's work.
  const collisionValues = conflicts
    .filter((c) => c.kind === "deadline_collision")
    .map((c) => projectValue(ctx.tasks, c.projectId, g.deadlineByProject, g.today))
    .sort((a, b) => b - a);
  const needsDecision =
    collisionValues.length >= 2 &&
    collisionValues[0] > 0 &&
    collisionValues[1] >= collisionValues[0] * COMPARABLE_VALUE_RATIO;

  const options = needsDecision ? escalationOptions(g, ctx, conflicts) : [];

  return { conflicts, triage, needsDecision, options };
}

/**
 * The mutually-exclusive ways to resolve a genuine comparable-value tie: for
 * each colliding project, "protect this one" means deferring the *other*
 * colliding projects' entire open work so the protected one gets the contested
 * hours. That's the abandonment auto-triage refuses to do on its own (it never
 * sheds a project's last task — line ~1080); here the user makes that call
 * deliberately, so each option's `probabilityAfter` is the protected project's
 * recovered joint odds once the sacrifice set is shed (one MC probe per option).
 */
function escalationOptions(
  g: ForecastGather,
  ctx: AllocContext,
  conflicts: Conflict[],
): PitWallOption[] {
  const colliding = conflicts.filter((c) => c.kind === "deadline_collision");
  const collidingIds = new Set(colliding.map((c) => c.projectId));
  // Open (still-forecast) task ids per colliding project — the deferrable batch.
  const openByProject = new Map<string, string[]>();
  for (const t of ctx.tasks) {
    if (t.status === "done" || !collidingIds.has(t.projectId)) continue;
    const ids = openByProject.get(t.projectId) ?? [];
    ids.push(t.id);
    openByProject.set(t.projectId, ids);
  }

  return colliding.map((protect) => {
    const others = colliding.filter((c) => c.projectId !== protect.projectId);
    const sacrificeTaskIds = others.flatMap(
      (o) => openByProject.get(o.projectId) ?? [],
    );
    const recovered = jointOdds(g, ctx, new Set(sacrificeTaskIds), TRIAGE_PROBE_ITERATIONS);
    return {
      protectId: protect.projectId,
      protectName: protect.projectName,
      sacrificeNames: others.map((o) => o.projectName),
      sacrificeTaskIds,
      probabilityAfter: recovered.get(protect.projectId) ?? 0,
    };
  });
}

/**
 * Forecast every deadlined project under a commitment set. Per-project
 * expected/deployable/slack still come from the project's own footprint, but the
 * headline `probability` is the honest, contention-aware joint odds (`odds`),
 * which the caller computes once per commitment set and shares across projects.
 */
function buildForecasts(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
  odds: Map<string, number>,
): ProjectForecast[] {
  return g.projects.map((p) => {
    const dep = deployableMinutes({
      today: g.today,
      deadline: p.deadline,
      availability: g.availability,
      overrides: g.overrides,
      commitments,
    });
    const tasks = g.tasksByProject.get(p.id) ?? [];
    // A learning goal carries no tasks — its remaining work is the unattained
    // skill effort. A project carries no skills. Union covers both kinds.
    const skillEstimates = g.skillWorkByProject.get(p.id)?.estimates ?? [];
    const result = forecast(
      [...tasks.map((t) => t.estimated_minutes), ...skillEstimates],
      dep,
      forecastOptions(g.model),
    );
    return {
      projectId: p.id,
      projectName: p.name,
      deadline: p.deadline,
      ...result,
      // Honest cross-project odds replace the (optimistic) solo probability.
      probability: odds.get(p.id) ?? result.probability,
    };
  });
}

/**
 * The canonical thin-buffer URGENCY map (OVERHAUL S3b `w_buffer` lever, graded in Phase 4):
 * projectId → urgency `(0,1]` for each deadlined project whose critical-chain buffer is "thin"
 * — on-track but below comfortable — under the BASE plan's odds, graded by HOW thin
 * (`bufferUrgency`, `lib/buffer.ts`: rising as the odds approach the on-track line). The
 * within-day reorder biases their work into the day's fast windows in proportion to urgency,
 * so the THINNEST deadline gets the strongest claim on the hours it is most likely to finish
 * in (widening its buffer). Decided ONCE on the base — like the comfort cap + reorder flag —
 * then replayed for every move subset and shipped to the client (which lacks the per-project
 * forecast distribution the buffer math needs). Reads each project's solo forecast
 * (p50/p90/deployable) with the joint `baselineOdds` as its probability — exactly the
 * `ProjectForecast` `buildForecasts` already returns. Non-thin projects are omitted.
 */
function thinBufferUrgencyMap(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
  baselineOdds: Map<string, number>,
): Map<string, number> {
  const urgency = new Map<string, number>();
  for (const fc of buildForecasts(g, commitments, baselineOdds)) {
    const u = bufferUrgency(fc);
    if (u > 0) urgency.set(fc.projectId, u);
  }
  return urgency;
}

/**
 * Live forecasts + proactive recovery plans for the Today dashboard. Runs a
 * single gather (both were previously computed off separate gathers).
 */
export async function forecastDashboard(): Promise<{
  forecasts: ProjectForecast[];
  recoveries: RecoveryPlan[];
  pitWall: PitWall;
  /** The single global allocation the Today views derive from (order + unified schedule). */
  globalPlan: GlobalPlan;
  /**
   * The agenda's ranking: the global order PLUS today's due recurring instances,
   * floated up via an ordering-only `today` deadline. Recurring rides this order
   * for display only — its time is already drained into capacity, so it never
   * enters the forecast (`globalPlan`/`jointOdds` stay over real project work).
   */
  agendaOrder: GlobalPlan["order"];
  model: EstimationModel;
}> {
  const [g, activities, completions, cachedStrategy, committed, localNow, rolls] = await Promise.all([
    gatherForecast(),
    listRecurringActivities(),
    listActivityCompletions(),
    getCachedStrategy(),
    getCommittedPlan(),
    readClientLocalNow(),
    listPlanRolls(),
  ]);
  const ctx = allocContext(g, g.commitments);
  // The S3b arrangement pipeline over all current open work (no triage shedding): the canonical
  // cross-project order, the comfort-cap decision (spread HARD work across days within slack),
  // the thin-buffer urgency, and the odds-gated within-day reorder (cut context switches + slot
  // hard/at-risk work into learned-fast windows). Recurring is NOT in here, so the schedule /
  // forecast never double-count its already-drained hours. No-regret: no cap / no reorder signal
  // ⇒ the canonical plan, bit-for-bit.
  const bundle = buildArrangement(g, ctx);
  // S3c-1 rolling horizon: keep committing to the plan the user is following (sticky) unless the
  // date rolled, the situation moved the fingerprint, or the fresh candidate's soft gain clears
  // the churn-scaled hysteresis (feasibility/odds always dominating). This READ decides what to
  // show and persists nothing (the mutation-time roll is the sole writer); a stale anchor on a
  // quiet new day is harmless — `packGlobal` re-buckets from `g.today` regardless. `decision.order`
  // IS the display order in both cases (== the fresh candidate when not sticky). No committed row
  // ⇒ the candidate verbatim ⇒ the exact pre-S3c dashboard, bit-for-bit. S3c-4: `localNow` (the
  // client clock, read-only) sharpens the frozen zone to the imminent part of today; `undefined`
  // ⇒ date-granular churn, exactly S3c-1.
  // S3c-5 (🟡 tier): same calibrated hysteresis as the write path, so the dashboard's sticky/roll
  // choice matches what the mutation-time roll would persist.
  const decision = rollDecision(
    rollContextFor(g, ctx, bundle, committed, localNow, calibrateHysteresis(rolls)),
  );
  // S3c-6: on a quiet new day, refresh the committed row's frozen-zone anchor from this read.
  await advanceAnchorOnQuietDay(committed, decision);
  // Display == priced: when sticky, reprice the reconciled committed order for the headline +
  // per-project odds; when fresh, reuse the candidate's already-computed joint (no extra MC).
  const priced = decision.sticky
    ? globalForecastJoint(
        decision.order,
        ctx.capacities,
        g.deadlineByProject,
        g.today,
        repriceOptionsFor(g, ctx, bundle),
      )
    : bundle.reorder.joint;
  const odds = priced.byProject;
  const forecasts = buildForecasts(g, g.commitments, odds);
  const pitWall = buildPitWall(g, ctx, odds);
  const recoveries = g.projects
    .map((p) => buildRecoveryPlan(g, p, odds, pitWall.conflicts, cachedStrategy))
    .filter((plan): plan is RecoveryPlan => plan !== null);
  // The displayed plan packs the FOLLOWED order (sticky committed or fresh candidate),
  // comfort-capped when smoothing fired, so the shown days match its priced odds (display ==
  // priced). `globalPlan.order` stays the canonical order — display metadata + stable priority
  // ranks, unaffected by the within-day arrangement / stickiness (which live in `days`).
  const globalPlan: GlobalPlan = {
    order: bundle.canonical.order,
    days: packGlobal(decision.order, ctx.budget, g.today, bundle.comfortCapMinutes),
  };
  // The agenda order: same plan plus today's due recurring instances, ranked as
  // if due today (ordering-only) so a due routine/goal surfaces near the top.
  const recurringTasks = recurringAllocTasksForToday(activities, completions, g.today);
  const orderingDeadlines = new Map(g.deadlineByProject);
  orderingDeadlines.set(RECURRING_LANE_ID, g.today);
  const agendaOrder = buildGlobalPlan({
    tasks: [...ctx.tasks, ...recurringTasks],
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    orderingDeadlineByProject: orderingDeadlines,
    budget: ctx.budget,
    today: g.today,
  }).order;
  return { forecasts, recoveries, pitWall, globalPlan, agendaOrder, model: g.model };
}

/**
 * Do the Value Model's area weights currently change the plan at all? The weights
 * scale each task's cost-of-delay, so they only re-rank work under contention
 * (overload → WSJF) or when goals share a deadline; with enough slack the order is
 * pure earliest-deadline-first and the weights are inert. Compares the canonical
 * order under the saved weights against a neutral (importance = 1) build, so the
 * settings page can honestly tell the user when their weights aren't doing anything
 * yet. Cheap: two deterministic plan builds, no Monte Carlo.
 */
export async function valueWeightsAffectPlan(): Promise<boolean> {
  const g = await gatherForecast();
  const ctx = allocContext(g, g.commitments);
  const base = {
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    budget: ctx.budget,
    today: g.today,
  };
  const weighted = buildGlobalPlan({ ...base, tasks: ctx.tasks }).order;
  const neutral = buildGlobalPlan({
    ...base,
    tasks: ctx.tasks.map((t) => ({ ...t, importance: 1 })),
  }).order;
  return (
    weighted.length !== neutral.length ||
    weighted.some((e, i) => e.taskId !== neutral[i].taskId)
  );
}

/**
 * Forecast + recovery for a single project (project page), off one gather.
 * Both are null when the project has no deadline / doesn't exist.
 */
export async function forecastProjectWithRecovery(projectId: string): Promise<{
  forecast: ProjectForecast | null;
  recovery: RecoveryPlan | null;
  model: EstimationModel;
}> {
  const [g, cachedStrategy] = await Promise.all([
    gatherForecast(),
    getCachedStrategy(),
  ]);
  const project = g.projects.find((p) => p.id === projectId);
  if (!project) return { forecast: null, recovery: null, model: g.model };
  // Build the plan over the FULL gather (all projects) so contention is real,
  // then read out just this project's odds and any conflict touching it.
  const ctx = allocContext(g, g.commitments);
  const odds = jointOdds(g, ctx);
  const conflicts = planConflicts(g, ctx);
  const projectForecast =
    buildForecasts({ ...g, projects: [project] }, g.commitments, odds)[0] ?? null;
  return {
    forecast: projectForecast,
    recovery: buildRecoveryPlan(g, project, odds, conflicts, cachedStrategy),
    model: g.model,
  };
}

/**
 * Log a commitment and return any "pit calls" it triggers: projects whose
 * completion probability dropped, each with the moves that would recover it.
 */
export async function logCommitment(
  date: string,
  hours: number,
  label: string | null,
): Promise<PitCall[]> {
  const g = await gatherForecast();
  const afterCommitments = [...g.commitments, { date, hours: Math.max(0, hours) }];
  const before = buildForecasts(g, g.commitments, globalOdds(g, g.commitments));
  const after = buildForecasts(g, afterCommitments, globalOdds(g, afterCommitments));

  // Persist the commitment.
  const row: Commitment = {
    id: crypto.randomUUID(),
    date,
    hours: Math.max(0, hours),
    label: label?.trim() || null,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("commitments")
      .insert({ ...row, user_id });
    if (error)
      throw new Error(`Supabase commitment insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().commitments.push(row);
  }

  // A pit call fires when a project's probability drops meaningfully.
  const pitCalls: PitCall[] = [];
  for (const a of after) {
    const b = before.find((x) => x.projectId === a.projectId);
    if (!b) continue;
    if (a.probability < b.probability - 0.02) {
      const candidates = g.tasksByProject.get(a.projectId) ?? [];
      const moves = recoveryMoves(candidates, a.deployableMinutes, forecastOptions(g.model));

      // Offer a re-date when the project is now below target, and only ever a
      // later date than its current deadline.
      let reschedule: RescheduleMove | null = null;
      if (!isOnTrack(a.probability) && a.deadline) {
        const rd = earliestAchievableDeadline(
          candidates.map((t) => t.estimated_minutes),
          {
            today: g.today,
            availability: g.availability,
            overrides: g.overrides,
            commitments: afterCommitments,
          },
          RECOVERY_TARGET,
          forecastOptions(g.model),
        );
        if (rd && rd.deadline > a.deadline.slice(0, 10)) {
          reschedule = { deadline: rd.deadline, probabilityAfter: rd.probability };
        }
      }

      pitCalls.push({
        projectId: a.projectId,
        projectName: a.projectName,
        probabilityBefore: b.probability,
        probabilityAfter: a.probability,
        moves,
        reschedule,
      });
    }
  }
  return pitCalls;
}

// --- Divergence detection & recovery ----------------------------------------

/**
 * Probability target a recovery plan aims to restore the project to — the same
 * line the forecast meter calls "on track" (see `isOnTrack`), so the callout
 * and the meter never disagree about whether a project is in trouble.
 */
const RECOVERY_TARGET = ON_TRACK_PROBABILITY;
/** A deadline within this many days counts as "imminent". */
const IMMINENT_DAYS = 3;

/** Whole days from ISO date `a` to ISO date `b` (UTC, b − a). */
function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

/**
 * Decide whether a project is off-track, and why, from signals that already
 * exist in the forecast and task data. Pure — caller supplies `today`.
 */
export function detectDivergence(
  fc: ForecastResult,
  deadline: string | null,
  tasks: Task[],
  today: string,
  conflicts: Conflict[] = [],
  criteria: GoalCriterion[] = [],
): DivergenceReason[] {
  const reasons: DivergenceReason[] = [];
  const open = tasks.filter((t) => t.status !== "done" && !t.deferred);
  // A learning goal has no task rows — its open work shows up as the forecast's
  // open count (unattained skills). Either source means there's work in jeopardy.
  const hasOpen = open.length > 0 || fc.openTaskCount > 0;

  // Timing signals — these mean the deadline itself is in jeopardy (critical).
  if (deadline) {
    const dl = deadline.slice(0, 10);
    if (dl < today && hasOpen) {
      reasons.push({
        kind: "deadline_past",
        severity: "critical",
        detail: `Deadline passed ${-daysBetween(today, deadline)} day(s) ago`,
      });
    } else if (dl >= today && hasOpen && !isOnTrack(fc.probability)) {
      // The headline probability is itself the signal — near deadline or far.
      // Surface the day count too when the deadline is also imminent.
      const days = daysBetween(today, deadline);
      const pct = Math.round(fc.probability * 100);
      reasons.push({
        kind: "at_risk",
        severity: "critical",
        detail:
          days <= IMMINENT_DAYS
            ? `Deadline in ${days} day(s); only ${pct}% likely on time`
            : `${pct}% likely to finish on time`,
      });
    }
  }

  if (fc.slackMinutes < 0 && fc.openTaskCount > 0) {
    reasons.push({
      kind: "over_budget",
      severity: "critical",
      detail: `${Math.ceil(-fc.slackMinutes / 60)}h more work than the budget allows`,
    });
  }

  // Critical-chain buffer early-warning (§5a S3a): the deadline clears the
  // on-track line but not the comfortable one, so the p90−p50 safety margin is
  // mostly committed and a single overrun could flip the goal. Advisory — the
  // forecast probability is unchanged (`forecast()` owns the odds, §0). The
  // `isBufferLow` gate is inherently on-track, so this never double-lists with the
  // critical `at_risk` / `over_budget` reasons above (and `isOnTrack ⇒ slack > 0`).
  if (isBufferLow(fc)) {
    reasons.push({
      kind: "buffer_low",
      severity: "warning",
      detail: "On track, but the safety margin is thin — a single overrun could flip this.",
    });
  }

  // Attention signals — worth surfacing, but not on their own a missed deadline.
  // A blocked task that's also past due is counted as blocked only (it surfaces
  // in its own bucket), so this matches the Today agenda and never double-lists.
  const overdue = open.filter(
    (t) =>
      t.status !== "blocked" && t.due_date && t.due_date.slice(0, 10) < today,
  );
  if (overdue.length > 0) {
    reasons.push({
      kind: "overdue_tasks",
      severity: "warning",
      detail: `${overdue.length} overdue task${overdue.length === 1 ? "" : "s"}`,
    });
  }

  const blocked = open.filter((t) => t.status === "blocked");
  if (blocked.length > 0) {
    reasons.push({
      kind: "blocked_tasks",
      severity: "warning",
      detail: `${blocked.length} blocked task${blocked.length === 1 ? "" : "s"}`,
    });
  }

  // Provisional completion (advisory): work marked done — or DoD criteria met —
  // at less than `verified` confidence. The forecast probability is unchanged
  // (a done task frees its budget either way); this only nudges the user to
  // confirm before treating the goal as truly finished. A done task with no
  // recorded confidence (legacy / pre-feature) is left alone, not flagged.
  const provisionalDone = tasks.filter(
    (t) =>
      t.status === "done" &&
      t.completion_confidence != null &&
      t.completion_confidence !== "verified",
  );
  const completion = goalCompletion(criteria);
  const provisionalCriteria = completion.complete && !completion.verified;
  if (provisionalDone.length > 0 || provisionalCriteria) {
    const bits: string[] = [];
    if (provisionalCriteria) bits.push("definition of done met but unverified");
    if (provisionalDone.length > 0)
      bits.push(
        `${provisionalDone.length} task${provisionalDone.length === 1 ? "" : "s"} done but unverified`,
      );
    reasons.push({
      kind: "provisional_completion",
      severity: "warning",
      detail: `Provisionally complete — ${bits.join("; ")}. Verify before relying on it.`,
    });
  }

  // Cross-project signal (the pit wall): this project can't make its deadline
  // once it competes with others for the shared hours. Critical — the deadline
  // itself is in jeopardy, for a reason no per-project view can see.
  for (const c of conflicts) {
    reasons.push({ kind: "contention", severity: "critical", detail: c.detail });
  }

  return reasons;
}

/**
 * Assemble a recovery plan for one project from an already-gathered forecast
 * state. Returns null when on-track or the project has no deadline. Pure given
 * the gather — no I/O — so it can run for many projects off a single gather.
 */
function buildRecoveryPlan(
  g: ForecastGather,
  project: Goal,
  odds: Map<string, number>,
  conflicts: Conflict[] = [],
  baselineStrategy: PortfolioStrategy | null = null,
): RecoveryPlan | null {
  if (!project.deadline) return null;
  const projectId = project.id;
  const candidates = g.tasksByProject.get(projectId) ?? [];
  // Forecast over BOTH real tasks and unattained skill effort (a learning goal's
  // remaining work); defer-moves below still draw only from `candidates` (real
  // task rows) — there's no "defer a skill" move yet.
  const skillEstimates = g.skillWorkByProject.get(projectId)?.estimates ?? [];
  const estimates = [...candidates.map((t) => t.estimated_minutes), ...skillEstimates];
  const budget = {
    today: g.today,
    availability: g.availability,
    overrides: g.overrides,
    commitments: g.commitments,
  };
  const deployable = deployableMinutes({ ...budget, deadline: project.deadline });
  const opts = forecastOptions(g.model);
  // Detection gates on the honest, contention-aware probability; the per-project
  // defer/reschedule moves below stay solo for now (made contention-aware in G3).
  const soloFc = forecast(estimates, deployable, opts);
  const fc: ForecastResult = {
    ...soloFc,
    probability: odds.get(projectId) ?? soloFc.probability,
  };

  const allTasks = g.allTasksByProject.get(projectId) ?? [];
  // The goal's definition of done — real now (was [] before §5 gate slice 3), so
  // a met-but-unverified DoD surfaces as a provisional-completion symptom.
  const criteria = g.criteriaByProject.get(projectId) ?? [];
  // Fold in any cross-project conflict touching this project (the pit-wall reason).
  const projectConflicts = conflicts.filter((c) => c.projectId === projectId);
  const reasons = detectDivergence(
    fc,
    project.deadline,
    allTasks,
    g.today,
    projectConflicts,
    criteria,
  );
  if (reasons.length === 0) return null;

  // Probability-recovery moves (defer / re-date) only make sense when the
  // project is actually off the on-track line. An on-track project flagged just
  // for a blocked or overdue task gets the inline actions below, not these.
  const offTrack = !isOnTrack(fc.probability);

  // Defer lowest-priority work first (best probability recovery first).
  const defer = offTrack ? recoveryMoves(candidates, deployable, opts) : [];

  // Re-date only when the current deadline can't already clear the target, and
  // only ever suggest a *later* date (pulling it earlier never helps).
  let reschedule: RecoveryPlan["reschedule"] = null;
  if (offTrack) {
    const rd = earliestAchievableDeadline(estimates, budget, RECOVERY_TARGET, opts);
    if (rd && rd.deadline > project.deadline.slice(0, 10)) {
      reschedule = { deadline: rd.deadline, probabilityAfter: rd.probability };
    }
  }

  // Dependency-aware order to tackle the open work (advisory): reuse the
  // schedule generator's ordering, flattened to a task sequence.
  const schedTasks: SchedulableTask[] = allTasks
    .filter((t) => t.status !== "done" && !t.deferred)
    .map((t) => ({
      id: t.id,
      title: t.title,
      estimated_minutes: t.estimated_minutes,
      priority_score: t.priority_score ?? 0,
      impact_score: t.impact_score,
      status: t.status,
    }));
  const schedIds = new Set(schedTasks.map((t) => t.id));
  const edges: DependencyEdge[] = g.deps
    .filter((d) => schedIds.has(d.task_id) && schedIds.has(d.depends_on_task_id))
    .map((d) => ({ task_id: d.task_id, depends_on_task_id: d.depends_on_task_id }));
  const sequence = orderSchedulableTasks(schedTasks, edges).map((t) => ({
    taskId: t.id,
    title: t.title,
  }));

  // The actual flagged tasks behind the overdue/blocked reasons, so the callout
  // can offer inline actions (reschedule / unblock) rather than just a count.
  const openTasks = allTasks.filter((t) => t.status !== "done" && !t.deferred);
  // Blocked tasks live only in the blocked bucket, even when also past due, so a
  // single task is never listed twice (mirrors the overdue reason count above).
  const overdue = openTasks
    .filter(
      (t) =>
        t.status !== "blocked" && t.due_date && t.due_date.slice(0, 10) < g.today,
    )
    .map((t) => ({ taskId: t.id, title: t.title, dueDate: t.due_date }));
  const blocked = openTasks
    .filter((t) => t.status === "blocked")
    .map((t) => ({ taskId: t.id, title: t.title, blockedBy: t.blocked_by }));

  // Diagnose the cause behind a genuine divergence (off-track only — a
  // warning-only flag has no cause to explain). The baseline comes from the last
  // cached strategy when the caller supplies one; without it constraint_change
  // simply can't fire and the cause falls through to the residual-based classes.
  const completedTasks = allTasks.filter((t) => t.status === "done");
  const baseline: CauseBaseline | null = baselineStrategy
    ? {
        generatedAt: baselineStrategy.generatedAt,
        probability: baselineStrategy.odds[projectId] ?? null,
      }
    : null;
  const cause = offTrack
    ? diagnoseCause({
        model: g.model,
        completedTasks,
        openTasks,
        reasons,
        currentProbability: fc.probability,
        baseline,
        windowVelocity: g.windowVelocity,
        windowedResiduals: g.windowedResidualsByProject.get(projectId),
      })
    : null;

  // Cost to the goal beyond the deadline (§5 gate check 3): the unmet definition
  // of done / skill milestones a deadline-buying move does nothing for. Shown
  // beside the moves so an odds gain can't hide that the goal's bar is unmoved.
  const goalCost = offTrack
    ? goalCutCost(project.kind, criteria, g.skillNodesByProject.get(projectId) ?? [])
    : null;

  return {
    projectId: project.id,
    projectName: project.name,
    currentProbability: fc.probability,
    reasons,
    cause,
    goalCost,
    defer,
    reschedule,
    sequence,
    overdue,
    blocked,
  };
}

// --- LLM strategist: corrective tasks ---------------------------------------

/** Everything the strategist needs to propose corrective tasks for one project. */
export interface RecoveryContext {
  project: Goal;
  /** Open (not done, not deferred) tasks — full rows, for prompt context. */
  openTasks: Task[];
  /** Completed (done) tasks — the per-goal residual sample for cause-diagnosis. */
  completedTasks: Task[];
  /** The goal's definition-of-done — for the gate's degraded-DoD + goal-cost checks. */
  criteria: GoalCriterion[];
  /** Deployable minutes from today through the deadline. */
  deployable: number;
  /** Why the project was flagged off-track. */
  reasons: DivergenceReason[];
  /** Current completion probability, before any suggested task. */
  currentProbability: number;
  /** The user's learned estimation bias — the same one the forecast uses. */
  model: EstimationModel;
  /** Life-area to file new tasks under (from existing tasks; "Work" by default). */
  area: string;
  /** The temporal/odds anchor from the last cached strategy (null when none). */
  baseline: CauseBaseline | null;
  /** The diagnosed cause behind the divergence (null when not genuinely off-track). */
  cause: CauseDiagnosis | null;
}

/**
 * Gather everything the LLM strategist needs to propose corrective tasks for
 * one project — off the same forecast gather the deterministic recovery plan
 * uses. Returns null when the project has no deadline or isn't flagged
 * off-track, so the strategist never runs on a healthy project.
 */
export async function getRecoveryContext(
  projectId: string,
): Promise<RecoveryContext | null> {
  const g = await gatherForecast();
  const project = g.projects.find((p) => p.id === projectId);
  if (!project || !project.deadline) return null;

  const candidates = g.tasksByProject.get(projectId) ?? [];
  const deployable = deployableMinutes({
    today: g.today,
    deadline: project.deadline,
    availability: g.availability,
    overrides: g.overrides,
    commitments: g.commitments,
  });
  const fc = forecast(
    candidates.map((t) => t.estimated_minutes),
    deployable,
    forecastOptions(g.model),
  );

  const allTasks = g.allTasksByProject.get(projectId) ?? [];
  const criteria = g.criteriaByProject.get(projectId) ?? [];
  const reasons = detectDivergence(
    fc,
    project.deadline,
    allTasks,
    g.today,
    [],
    criteria,
  );
  if (reasons.length === 0) return null;

  const openTasks = allTasks.filter((t) => t.status !== "done" && !t.deferred);
  const completedTasks = allTasks.filter((t) => t.status === "done");

  // Baseline = the last cached strategy: its per-project odds snapshot + when it
  // was generated. During portfolio generation this is the still-current `prev`
  // (not yet overwritten), so cause-diagnosis compares "now" against the world
  // the standing plan was built for. Cheap, additive — no new persistence (S1).
  const cached = await getCachedStrategy();
  const baseline: CauseBaseline | null = cached
    ? {
        generatedAt: cached.generatedAt,
        probability: cached.odds[projectId] ?? null,
      }
    : null;

  // Diagnose the cause only for a genuine divergence — a warning-only flag (a
  // blocked/overdue task on an otherwise on-track project) has no cause to explain.
  const offTrack =
    !isOnTrack(fc.probability) || reasons.some((r) => r.severity === "critical");
  const cause = offTrack
    ? diagnoseCause({
        model: g.model,
        completedTasks,
        openTasks,
        reasons,
        currentProbability: fc.probability,
        baseline,
        windowVelocity: g.windowVelocity,
        windowedResiduals: g.windowedResidualsByProject.get(projectId),
      })
    : null;

  return {
    project,
    openTasks,
    completedTasks,
    criteria,
    deployable,
    reasons,
    currentProbability: fc.probability,
    model: g.model,
    area: openTasks[0]?.area ?? "Work",
    baseline,
    cause,
  };
}

/**
 * Deterministic preview: the probability the project would have if these
 * suggested tasks were added to its open work. The forecast scores it — never
 * the LLM. Pure given the context, so the strategist can call it without I/O.
 */
export function previewProbabilityWithTasks(
  ctx: RecoveryContext,
  tasks: SuggestedTask[],
): number {
  const estimates = [
    ...ctx.openTasks.map((t) => t.estimated_minutes),
    ...tasks.map((t) => t.estimated_minutes),
  ];
  return forecast(estimates, ctx.deployable, forecastOptions(ctx.model)).probability;
}

/**
 * Persist user-accepted corrective tasks under a synthetic recovery entry
 * (kind "plan") owned by the project. Tasks inherit the project through the
 * entry, exactly like extracted tasks — no schema change.
 */
export async function addCorrectiveTasks(
  projectId: string,
  tasks: SuggestedTask[],
): Promise<RecoveryInserts> {
  const empty: RecoveryInserts = { insertedTaskIds: [], insertedEntryIds: [] };
  if (tasks.length === 0) return empty;
  const project = await getGoal(projectId);
  if (!project) return empty;

  const createdAt = new Date().toISOString();
  const taskRows = tasks.map((t, i) =>
    buildRecoveryTaskRow(
      { ...t, status: t.blocked_by ? "blocked" : "todo" },
      "",
      i,
      createdAt,
    ),
  );
  return persistRecoveryEntry(
    project,
    "AI-suggested corrective tasks to fill gaps in the plan.",
    taskRows,
    createdAt,
  );
}

// --- LLM strategist: modify existing tasks ----------------------------------

/**
 * Deterministic preview: the probability the project would have if these
 * modifications were applied — each reshaped task's original estimate removed
 * and its replacements' estimates added. The forecast scores it, never the LLM.
 * Pure given the context, so the strategist can call it without I/O.
 */
export function previewProbabilityWithModifications(
  ctx: RecoveryContext,
  mods: TaskModification[],
): number {
  const reshaped = new Set(mods.map((m) => m.taskId));
  const estimates = [
    ...ctx.openTasks
      .filter((t) => !reshaped.has(t.id))
      .map((t) => t.estimated_minutes),
    ...mods.flatMap((m) => m.replacements.map((r) => r.estimated_minutes)),
  ];
  return forecast(estimates, ctx.deployable, forecastOptions(ctx.model)).probability;
}

/**
 * Apply user-accepted task modifications:
 * - "scope_down" rewrites the existing task in place (lighter title, trimmed
 *   description, smaller estimate) — reversible by editing the task.
 * - "split" defers the original monolith (so it leaves the forecast and the
 *   working views, reversibly) and persists the smaller steps under a synthetic
 *   recovery entry, mirroring `addCorrectiveTasks`.
 */
export async function applyTaskModifications(
  projectId: string,
  mods: TaskModification[],
): Promise<RecoveryInserts> {
  const empty: RecoveryInserts = { insertedTaskIds: [], insertedEntryIds: [] };
  if (mods.length === 0) return empty;
  const project = await getGoal(projectId);
  if (!project) return empty;

  const createdAt = new Date().toISOString();
  const newRows: Task[] = [];

  for (const mod of mods) {
    if (mod.kind === "scope_down") {
      const part = mod.replacements[0];
      if (!part) continue;
      // Reshape the task in place (lighter title/description, smaller estimate).
      const original = await updateTask(mod.taskId, {
        title: part.title,
        description: part.description,
        estimated_minutes: part.estimated_minutes,
      });
      // Materialize the trimmed work as a debt task (§5 gate check 4): scope_down
      // is the one reshape that genuinely erases work — the estimate shrinks in
      // place with no other record. The debt task makes that cost owed, not
      // erased. It's deferred (so it stays OUT of this deadline's forecast — the
      // cut's odds gain holds) and due past the deadline, marked origin "debt".
      const trimmed = mod.originalEstimate - part.estimated_minutes;
      if (trimmed > 0) {
        newRows.push(
          buildDebtTaskRow(
            mod.taskTitle,
            trimmed,
            original?.area ?? "Work",
            project,
            newRows.length,
            createdAt,
          ),
        );
      }
    } else {
      // Split: the monolith is replaced by its steps. Defer it out of the
      // forecast (reversible); the steps inherit its life-area (updateTask
      // returns the row, so we read the area straight off it).
      const original = await updateTask(mod.taskId, { deferred: true });
      const area = original?.area ?? "Work";
      mod.replacements.forEach((part) =>
        newRows.push(
          buildRecoveryTaskRow(
            { ...part, area, status: "todo" },
            "",
            newRows.length,
            createdAt,
          ),
        ),
      );
    }
  }

  return persistRecoveryEntry(
    project,
    "Tasks reshaped to fit the budget.",
    newRows,
    createdAt,
  );
}

// --- LLM strategist: re-route the whole plan --------------------------------

/**
 * Deterministic preview: the probability the project would have if its entire
 * open plan were replaced by these alternative tasks. The forecast scores it,
 * never the LLM. Pure given the context, so the strategist can call it without
 * I/O.
 */
export function previewProbabilityWithReroute(
  ctx: RecoveryContext,
  tasks: { estimated_minutes: number }[],
): number {
  const estimates = tasks.map((t) => t.estimated_minutes);
  return forecast(estimates, ctx.deployable, forecastOptions(ctx.model)).probability;
}

/**
 * Apply a user-accepted re-route: defer every current open task out of the
 * forecast (reversibly, exactly like a split's monolith) and persist the
 * alternative approach's tasks under a synthetic recovery entry — the whole open
 * plan swapped for a lighter route. Self-contained via the passed task ids,
 * mirroring `applyTaskModifications`.
 */
export async function applyReroute(
  projectId: string,
  replacedTaskIds: string[],
  tasks: ReroutePart[],
  degradedCriteria: DegradedCriterion[] = [],
): Promise<RecoveryInserts> {
  const empty: RecoveryInserts = { insertedTaskIds: [], insertedEntryIds: [] };
  if (tasks.length === 0) return empty;
  const project = await getGoal(projectId);
  if (!project) return empty;

  const createdAt = new Date().toISOString();

  // Defer the current plan; read a life-area off the originals for the new tasks.
  let area = "Work";
  for (const taskId of replacedTaskIds) {
    const original = await updateTask(taskId, { deferred: true });
    if (original?.area) area = original.area;
  }

  const taskRows = tasks.map((t, i) =>
    buildRecoveryTaskRow(
      { ...t, area, status: t.blocked_by ? "blocked" : "todo" },
      "",
      i,
      createdAt,
    ),
  );
  const inserts = await persistRecoveryEntry(
    project,
    "Plan re-routed to a lighter approach.",
    taskRows,
    createdAt,
  );

  // §5 gate check 2: a lighter route that lowers the goal's definition of done
  // records how on each compromised criterion — the original text stays intact,
  // the note carries the compromise — so switching approach can't quietly
  // redefine the goal down ("no silent erosion").
  for (const d of degradedCriteria) {
    await setGoalCriterionDegraded(d.criterionId, d.note);
  }
  return inserts;
}

// --- Recovery-entry persistence (shared by Generate + Modify) ---------------

/** A factor-bearing row to file under a recovery entry. */
type RecoveryTaskInput = FactorScores & {
  title: string;
  description: string;
  estimated_minutes: number;
  due_date?: string | null;
  blocked_by?: string | null;
  priority_reason: string;
  area: string;
  status: TaskStatus;
  /** Set-aside on creation (e.g. a debt task parked past the deadline). */
  deferred?: boolean;
  /** Provenance — `"debt"` for a materialized scope-cut follow-up. */
  origin?: TaskOrigin | null;
};

/** Build a persistable Task row from strategist output, scored deterministically. */
function buildRecoveryTaskRow(
  input: RecoveryTaskInput,
  entryId: string,
  sortIndex: number,
  createdAt: string,
): Task {
  const { score, label } = computePriority(input);
  return {
    id: crypto.randomUUID(),
    entry_id: entryId,
    goal_id: null, // stamped by persistRecoveryEntry once the owning goal is known
    title: input.title,
    description: input.description,
    owner: null,
    category: null,
    area: input.area,
    status: input.status,
    due_date: input.due_date ?? null,
    estimated_minutes: input.estimated_minutes,
    actual_minutes: 0,
    urgency_score: input.urgency,
    impact_score: input.impact,
    effort_score: input.effort,
    dependency_score: input.dependency,
    risk_score: input.risk,
    confidence_score: input.confidence,
    priority_score: score,
    priority_label: label,
    priority_reason: input.priority_reason,
    source_quote: null,
    is_ai_suggested: true,
    blocked_by: input.blocked_by ?? null,
    deferred: input.deferred ?? false,
    completion_confidence: null,
    completed_at: null,
    origin: input.origin ?? null,
    resolved_by: null,
    sort_index: sortIndex,
    created_at: createdAt,
  };
}

/** Days a debt task is parked past the goal deadline before it comes due. */
const DEBT_DUE_BUFFER_DAYS = 7;

/** Map minutes onto the strategist's 1-5 effort scale (5 = >4h … 1 = <30m). */
function effortFromMinutes(min: number): number {
  if (min > 240) return 5;
  if (min > 120) return 4;
  if (min > 60) return 3;
  if (min > 30) return 2;
  return 1;
}

/** The day a debt task comes due — `buffer` days past the deadline, or null. */
function dueAfterDeadline(deadline: string | null): string | null {
  if (!deadline) return null;
  const ms =
    Date.parse(`${deadline.slice(0, 10)}T00:00:00Z`) +
    DEBT_DUE_BUFFER_DAYS * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build the deferred follow-up that captures work a scope-cut trimmed (§5 gate
 * check 4). Parked (deferred) so it stays out of the current deadline's forecast
 * — the cut's odds gain holds — yet persisted as a real, owed task: due past the
 * deadline, area inherited, origin "debt", provenance in its reason.
 */
function buildDebtTaskRow(
  originalTitle: string,
  trimmedMinutes: number,
  area: string,
  project: Goal,
  sortIndex: number,
  createdAt: string,
): Task {
  return buildRecoveryTaskRow(
    {
      urgency: 2,
      impact: 3,
      effort: effortFromMinutes(trimmedMinutes),
      dependency: 1,
      risk: 2,
      confidence: 4,
      title: `Restore trimmed scope: ${originalTitle}`,
      description: `${formatMinutes(trimmedMinutes)} of "${originalTitle}" was set aside to scope it down for ${project.name}'s deadline. Owed, not erased — pick this up after the deadline.`,
      estimated_minutes: trimmedMinutes,
      due_date: dueAfterDeadline(project.deadline),
      priority_reason: `Debt from scoping down "${originalTitle}" on ${project.name}.`,
      area,
      status: "todo",
      deferred: true,
      origin: "debt",
    },
    "",
    sortIndex,
    createdAt,
  );
}

/**
 * Persist task rows under a synthetic recovery entry (kind "plan") owned by the
 * project — the same vehicle Generate uses, so reshaped/added tasks inherit the
 * project through the entry with no schema change. No-op when there are no rows.
 */
async function persistRecoveryEntry(
  project: Goal,
  summary: string,
  taskRows: Task[],
  createdAt: string,
): Promise<RecoveryInserts> {
  if (taskRows.length === 0)
    return { insertedTaskIds: [], insertedEntryIds: [] };
  const entryId = crypto.randomUUID();
  for (const row of taskRows) {
    row.entry_id = entryId;
    row.goal_id = project.id; // the spine edge — these tasks belong to the goal
  }

  const entry: Entry = {
    id: entryId,
    title: `Recovery — ${project.name}`,
    raw_input: "",
    summary,
    discussion_points: [],
    stakeholders: [],
    daily_objective: "",
    key_deliverables: [],
    assumptions: [],
    risks: [],
    kind: "plan",
    status: "active",
    goal_id: project.id,
    parent_entry_id: null,
    created_at: createdAt,
  };

  const assembled: AssembledEntry = {
    entry,
    decisions: [],
    questions: [],
    tasks: taskRows,
    deps: [],
  };
  if (isSupabaseConfigured()) {
    await persistSupabase(assembled);
  } else {
    await ensureSeeded();
    const db = memDB();
    db.entries.unshift(entry);
    db.tasks.push(...taskRows);
  }
  return {
    insertedTaskIds: taskRows.map((r) => r.id),
    insertedEntryIds: [entryId],
  };
}
