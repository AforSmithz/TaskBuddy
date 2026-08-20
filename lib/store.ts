import "server-only";
import { createHash } from "crypto";
import { cookies } from "next/headers";
import type {
  GoalKind,
  SkillNode,
  SkillTaskLink,
  SkillTaskLinkStatus,
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
  JobRun,
  JobRunStatus,
  OpenQuestion,
  CommittedPlan,
  LocalNow,
  PitCall,
  PlanVersion,
  PlanRoll,
  PlanTuning,
  PlanRollKind,
  PlanReorder,
  MoveChoice,
  OfferedMove,
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
} from "@/lib/types";
import {
  COMMITTED_PLAN_SCHEMA_VERSION,
  MOVE_CHOICE_SCHEMA_VERSION,
  ON_TRACK_PROBABILITY,
  isJobAbandoned,
  isOnTrack,
  isTerminalJobStatus,
} from "@/lib/types";
import { extractEntry } from "@/lib/extraction";
import { estimationModel } from "@/lib/generate";
import {
  energyWindows,
  fitVelocityModel,
  taskResidualSamples,
  toSegmentModel,
  workSessionResidualSamples,
  type ResidualSample,
  type VelocityModel,
} from "@/lib/velocity";
import { goalCompletion } from "@/lib/goal";
import {
  calibrateMovePrefWeights,
  diagnoseCause,
  goalCutCost,
  CAUSE_PREF_WEIGHT,
  STYLE_PREF_WEIGHT,
  type CauseBaseline,
  type MovePrefWeights,
} from "@/lib/grounding";
import { bufferUrgency, isBufferLow } from "@/lib/buffer";
import { formatMinutes } from "@/lib/format";
import { computePriority } from "@/lib/priority";
import {
  dayCapacities,
  daySlackHours,
  generateSchedule,
  orderSchedulableTasks,
  type DependencyEdge,
  type ScheduleDay,
  type SchedulableTask,
} from "@/lib/schedule";
import {
  deployableMinutes,
  earliestAchievableDeadline,
  forecast,
  globalForecast,
  globalForecastJoint,
  recoveryMoves,
  sheddableSkillNodes,
  skillPathRescheduleMoves,
  skillRecoveryMoves,
  type CandidateTask,
  type ForecastOptions,
} from "@/lib/forecast";
import {
  buildGlobalPlan,
  detectConflicts,
  effortToDifficulty,
  packGlobal,
  projectValue,
  triageCandidates,
  type AllocTask,
  type GlobalPlan,
} from "@/lib/allocate";
import {
  ARRANGE_WEIGHTS,
  arrangementScore,
  calibrateArrangeWeights,
  comfortSmooth,
  gatedReorder,
  windowCapacities,
  windowProfileFromEnergy,
  type ArrangeOrderOptions,
  type ArrangeWeights,
  type ComfortSmoothResult,
  type GatedReorderResult,
  type WindowProfile,
} from "@/lib/arrange";
import {
  rollDecision,
  planRollKind,
  undoRollDecision,
  reorderDecision,
  calibrateHysteresis,
  STABILITY_MARGIN,
  CHURN_COST,
  type RollContext,
  type RollDecisionResult,
  type CalibratedHysteresis,
} from "@/lib/rolling";
import {
  SAMPLE_ACTIVITIES,
  SAMPLE_ENTRIES,
  SAMPLE_GOAL_CRITERIA,
  SAMPLE_PROJECTS,
  sampleActivityCompletions,
} from "@/lib/sample-data";
import {
  currentWeekOwedDates,
  recurringAllocTasksForToday,
  recurringStateFor,
  spliceRecurringIntoOrder,
  RECURRING_LANE_ID,
} from "@/lib/recurring";
import {
  areaWeight,
  normalizeValueModel,
  DEFAULT_VALUE_MODEL,
  type RecoveryStyle,
  type ValueModel,
} from "@/lib/value-model";
import {
  normalizeWindowAvailability,
  windowShareOverride,
  EMPTY_WINDOW_AVAILABILITY,
  type WindowAvailability,
} from "@/lib/window-availability";
import {
  forecastOptions,
  drainAsCommitments,
  syntheticAllocTask,
  jointOddsWithMoves,
  cumulativeJointOdds,
  SKILL_TASK_PREFIX,
  type AllocContext,
  type ResolveInput,
} from "@/lib/portfolio-state";
import { getRequestClient } from "@/lib/db/shim";
import { isDbConfigured } from "@/lib/db/pool";

// Central data layer. Postgres when configured, otherwise an in-memory store
// seeded with sample data so the app demos without a backend. Every query goes
// through a request-scoped client carrying the session, so RLS scopes it.

export { isDbConfigured };

type RequestClient = Awaited<ReturnType<typeof getRequestClient>>;

/** Id of the signed-in user, or throw - used to stamp ownership on inserts. */
async function currentUserId(supabase: RequestClient): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("You must be signed in to do that.");
  return user.id;
}

// Every query here unwraps through mustOk/mustRows/mustOne, which throw on error.
// A read failure has to be an exception, not an empty list: calibration falls back
// to priors when there's no data, so a swallowed error looks identical to an empty
// table. That's how move_choices shipped broken for weeks with nothing looking wrong.
// bestEffortRows/bestEffortPrune are the two narrow exceptions, and they log.

/** A settled PostgREST response: `.select()`, `.insert()`, `.update()`, `.delete()`. */
interface PostgrestResult {
  data: unknown;
  error: { message: string } | null;
}

/** Throw if the query failed. All a write with no returning rows needs. */
function mustOk(res: Pick<PostgrestResult, "error">, what: string): void {
  if (res.error) throw new Error(`DB ${what} failed: ${res.error.message}`);
}

/** Rows from a read, or throw. An empty list means the table really was empty. */
function mustRows<T>(res: PostgrestResult, what: string): T[] {
  mustOk(res, what);
  return (res.data as T[] | null) ?? [];
}

/** The row from a `.maybeSingle()` read, or throw. `null` means genuinely absent -
 *  the one place a nullish `data` is a fact about the table and not about the query. */
function mustOne<T>(res: PostgrestResult, what: string): T | null {
  mustOk(res, what);
  return (res.data as T | null) ?? null;
}

/** Rows for a display-only read: log and return [] on error. Never use for anything
 *  that feeds a forecast, calibration dial, undo or gated write. */
function bestEffortRows<T>(res: PostgrestResult, what: string): T[] {
  if (res.error) {
    console.error(`${what} read failed (degraded to empty, display-only):`, res.error.message);
    return [];
  }
  return (res.data as T[] | null) ?? [];
}

/** Soft-cap prune, logging and swallowing failures. The row we just appended is the
 *  contract; the cap gets re-enforced on the next append. */
async function bestEffortPrune(
  table: string,
  prune: () => Promise<void>,
): Promise<void> {
  try {
    await prune();
  } catch (e) {
    console.error(`${table} prune failed (skipped, retried on next append):`, e);
  }
}

// --- In-memory store (survives HMR via globalThis) --------------------------

interface MemDB {
  projects: Goal[];
  goalCriteria: GoalCriterion[];
  skillNodes: SkillNode[];
  skillTaskLinks: SkillTaskLink[];
  entries: Entry[];
  decisions: Decision[];
  questions: OpenQuestion[];
  tasks: Task[];
  deps: TaskDependency[];
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
  recurringActivities: RecurringActivity[];
  /** Logged sessions/skips of recurring activities - the completion log. */
  activityCompletions: ActivityCompletion[];
  workSessions: WorkSession[];
  /** Whether the pit-wall strategist auto-applies obvious triage (vs. surfacing it). */
  autoStrategy: boolean;
  valueModel: ValueModel | null;
  windowAvailability: WindowAvailability | null;
  portfolioStrategy: PortfolioStrategy | null;
  /** Applied strategy bundles, newest-first - the plan version history. */
  planVersions: PlanVersion[];
 /** The plan the user is currently following - the rolling-horizon committed row
  * or null until first committed. */
  committedPlan: CommittedPlan | null;
  /** Retained automatic rolls of the committed plan, newest-first - the passive-roll
   *  history, capped at `PLAN_ROLL_CAP`. */
  planRolls: PlanRoll[];
  /** Captured drag-to-reorder preference pairs, newest-first - the calibration
   *  signal, capped at `PLAN_REORDER_CAP`. */
  planReorders: PlanReorder[];
  /** Captured offered-vs-kept move slates, newest-first - the calibration
   *  signal (STYLE/CAUSE pref weights), capped at `MOVE_CHOICE_CAP`. */
  moveChoices: MoveChoice[];
  /** Attempts at the queue-backed LLM jobs, newest-first - what the pending UI
   *  polls. Capped at `JOB_RUN_CAP`. */
  jobRuns: JobRun[];
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
      skillTaskLinks: [],
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
      moveChoices: [],
      jobRuns: [],
      seeded: false,
    };
  }
  return g.__taskbuddyDB;
}

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
 /** Life-area for every extracted task. Falls back to whatever the extractor suggests. */
  area?: string;
  projectId?: string | null;
 /** With no explicit project, attach to the one the extractor suggests, reusing an
  * existing project of that name or creating it. */
  autoProject?: boolean;
  parentEntryId?: string | null;
  status?: EntryStatus;
  createdAt?: string;
}

/** extract -> score priority -> resolve dependencies. UUIDs are assigned up front so
 *  rows persist directly. The schedule isn't here, it's derived on read. */
export async function assembleEntry(
  rawInput: string,
  opts: AssembleOptions = {},
): Promise<AssembledEntry> {
  const kind = opts.kind ?? "meeting";
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const entryId = crypto.randomUUID();

  // Only when the project is left to us: the extractor needs existing projects to reuse
  // one by name. Skipped during seeding, where listGoals would re-enter ensureSeeded.
  const resolveProject = opts.autoProject && !opts.projectId;
  const projects = resolveProject ? await listGoals() : [];
  const { result } = await extractEntry(rawInput, kind, {
    projectNames: projects.map((p) => p.name),
  });

  // Area: an explicit choice wins; otherwise use the extractor's suggestion.
  const area = opts.area ?? result.suggested_area ?? "Work";

  // Goal: an explicit choice wins; otherwise, when auto-filing, attach to
  // the suggested project - reusing an existing one of that name if it exists.
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("goals").insert({ ...project, user_id }),
      "project insert",
    );
  } else {
    await ensureSeeded();
    memDB().projects.unshift(project);
  }
  return project.id;
}

export async function listGoals(): Promise<Goal[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<Goal>(
      await supabase
        .from("goals")
        .select("*")
        .order("created_at", { ascending: false }),
      "goals list",
    );
  }
  await ensureSeeded();
  return [...memDB().projects].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

export async function getGoal(id: string): Promise<Goal | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustOne<Goal>(
      await supabase.from("goals").select("*").eq("id", id).maybeSingle(),
      "goal read",
    );
  }
  await ensureSeeded();
  return memDB().projects.find((p) => p.id === id) ?? null;
}

export async function setGoalKind(id: string, kind: GoalKind): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("goals").update({ kind }).eq("id", id),
      "goal kind update",
    );
    return;
  }
  await ensureSeeded();
  const goal = memDB().projects.find((p) => p.id === id);
  if (goal) goal.kind = kind;
}

// --- Definition of done (goal criteria) -------------------------------------

export async function listGoalCriteria(
  goalId: string,
): Promise<GoalCriterion[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<GoalCriterion>(
      await supabase
        .from("goal_criteria")
        .select("*")
        .eq("goal_id", goalId)
        .order("sort_index", { ascending: true }),
      "goal_criteria list",
    );
  }
  await ensureSeeded();
  return memDB()
    .goalCriteria.filter((c) => c.goal_id === goalId)
    .sort((a, b) => a.sort_index - b.sort_index);
}

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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("goal_criteria").insert(row),
      "goal_criteria insert",
    );
  } else {
    await ensureSeeded();
    memDB().goalCriteria.push(row);
  }
}

export async function setGoalCriterionMet(
  id: string,
  met: boolean,
  confidence: CompletionConfidence | null,
): Promise<void> {
  const patch = {
    met,
    met_confidence: met ? confidence : null,
  };
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("goal_criteria").update(patch).eq("id", id),
      "goal_criteria update",
    );
    return;
  }
  await ensureSeeded();
  const row = memDB().goalCriteria.find((c) => c.id === id);
  if (row) Object.assign(row, patch);
}

export async function removeGoalCriterion(id: string): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("goal_criteria").delete().eq("id", id),
      "goal_criteria delete",
    );
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.goalCriteria = db.goalCriteria.filter((c) => c.id !== id);
}

/** Record how a scope cut degraded a criterion. `text` stays intact; `degraded_note`
 * carries the compromise ("now: managed provider, no SSO"). null clears it. */
export async function setGoalCriterionDegraded(
  id: string,
  note: string | null,
): Promise<void> {
  const degraded_note = note?.trim() || null;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("goal_criteria").update({ degraded_note }).eq("id", id),
      "goal_criteria update",
    );
    return;
  }
  await ensureSeeded();
  const row = memDB().goalCriteria.find((c) => c.id === id);
  if (row) row.degraded_note = degraded_note;
}

/** Every definition-of-done criterion across all goals - the forecast gather's
 *  bulk read (one query instead of N), so divergence detection sees real DoD. */
export async function listAllGoalCriteria(): Promise<GoalCriterion[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<GoalCriterion>(
      await supabase
        .from("goal_criteria")
        .select("*")
        .order("sort_index", { ascending: true }),
      "goal_criteria list (all)",
    );
  }
  await ensureSeeded();
  return [...memDB().goalCriteria].sort((a, b) => a.sort_index - b.sort_index);
}

// --- Skill graph (learning-goal decomposer) ---------------------------------

export async function listSkillNodes(goalId: string): Promise<SkillNode[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<SkillNode>(
      await supabase
        .from("skill_nodes")
        .select("*")
        .eq("goal_id", goalId)
        .order("sort_index", { ascending: true }),
      "skill_nodes list",
    );
  }
  await ensureSeeded();
  return memDB()
    .skillNodes.filter((n) => n.goal_id === goalId)
    .sort((a, b) => a.sort_index - b.sort_index);
}

/** Every skill node across all goals - the forecast gather's bulk read (one query
 *  instead of N), so a learning goal's effort can enter the joint forecast. */
export async function listAllSkillNodes(): Promise<SkillNode[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<SkillNode>(
      await supabase
        .from("skill_nodes")
        .select("*")
        .order("sort_index", { ascending: true }),
      "skill_nodes list (all)",
    );
  }
  await ensureSeeded();
  return [...memDB().skillNodes].sort((a, b) => a.sort_index - b.sort_index);
}

// --- Skill-node ↔ task links (spillover's explicit edge) --------------------

/** Every link touching a goal's skill nodes, in any status - the confirm surface
 *  shows suggested + confirmed, and needs dismissed ones to avoid re-proposing. */
export async function listSkillTaskLinksForGoal(goalId: string): Promise<SkillTaskLink[]> {
  const nodes = await listSkillNodes(goalId);
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (nodeIds.size === 0) return [];
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<SkillTaskLink>(
      await supabase
        .from("skill_task_links")
        .select("*")
        .in("skill_node_id", [...nodeIds])
        .order("created_at", { ascending: true }),
      "skill_task_links list",
    );
  }
  await ensureSeeded();
  return memDB().skillTaskLinks.filter((l) => nodeIds.has(l.skill_node_id));
}

/** Only the confirmed links, across every goal - the set spillover is allowed to
 *  act on. Suggested links are inert until the user says yes; dismissed stay dead. */
export async function listConfirmedSkillTaskLinks(): Promise<SkillTaskLink[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<SkillTaskLink>(
      await supabase.from("skill_task_links").select("*").eq("status", "confirmed"),
      "skill_task_links list (confirmed)",
    );
  }
  await ensureSeeded();
  return memDB().skillTaskLinks.filter((l) => l.status === "confirmed");
}

/** Insert freshly proposed links as `suggested`. Pairs that already exist in ANY
 *  status are skipped by the caller, so this never resurrects a dismissed pair. */
export async function insertSuggestedLinks(
  rows: { skill_node_id: string; task_id: string; rationale: string }[],
): Promise<SkillTaskLink[]> {
  if (rows.length === 0) return [];
  const created: SkillTaskLink[] = rows.map((r) => ({
    id: crypto.randomUUID(),
    skill_node_id: r.skill_node_id,
    task_id: r.task_id,
    status: "suggested" as const,
    rationale: r.rationale,
    created_at: new Date().toISOString(),
  }));
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<SkillTaskLink>(
      await supabase.from("skill_task_links").insert(created).select(),
      "skill_task_links insert",
    );
  }
  await ensureSeeded();
  memDB().skillTaskLinks.push(...created);
  return created;
}

export async function setSkillTaskLinkStatus(
  linkId: string,
  status: SkillTaskLinkStatus,
): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("skill_task_links").update({ status }).eq("id", linkId),
      "skill_task_links status update",
    );
    return;
  }
  await ensureSeeded();
  const link = memDB().skillTaskLinks.find((l) => l.id === linkId);
  if (link) link.status = status;
}

/** Persist a decomposed skill graph, replacing any prior plan. Maps the decomposer's
 * `key` slugs to UUIDs so `prerequisites` becomes a graph of real ids. */
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
    deferred: false,
    deferred_at: null,
    sort_index: i,
    created_at: createdAt,
  }));

  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    // Must throw: a swallowed delete followed by a successful insert would leave
    // the goal carrying two overlapping skill graphs.
    mustOk(
      await supabase.from("skill_nodes").delete().eq("goal_id", goalId),
      "skill_nodes delete",
    );
    if (nodes.length) {
      mustOk(
        await supabase.from("skill_nodes").insert(nodes),
        "skill_nodes insert",
      );
    }
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.skillNodes = db.skillNodes.filter((n) => n.goal_id !== goalId);
  db.skillNodes.push(...nodes);
}

/** Mark a skill attained (at a confidence) or not. Clearing also clears confidence +
 * timestamp, mirroring task completion. */
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("skill_nodes").update(patch).eq("id", id),
      "skill_nodes update",
    );
    return;
  }
  await ensureSeeded();
  const row = memDB().skillNodes.find((n) => n.id === id);
  if (row) Object.assign(row, patch);
}

export async function setSkillNodeDeferred(
  id: string,
  deferred: boolean,
): Promise<void> {
  const patch = {
    deferred,
    deferred_at: deferred ? new Date().toISOString() : null,
  };
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("skill_nodes").update(patch).eq("id", id),
      "skill_nodes update",
    );
    return;
  }
  await ensureSeeded();
  const row = memDB().skillNodes.find((n) => n.id === id);
  if (row) Object.assign(row, patch);
}

/** Park/restore one triage id. A `skill:<nodeId>` lane has no task row so it goes
 *  through setSkillNodeDeferred; everything else is a task deferral. Both triage
 *  surfaces route through here or a shed skill lane silently doesn't stick. */
export async function setTriageItemDeferred(
  id: string,
  deferred: boolean,
): Promise<void> {
  if (id.startsWith(SKILL_TASK_PREFIX)) {
    await setSkillNodeDeferred(id.slice(SKILL_TASK_PREFIX.length), deferred);
  } else {
    await updateTask(id, { deferred });
  }
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
  if (isDbConfigured()) {
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

/** Finalise a draft: drop declined tasks, apply the confirmed filing, flip to active.
 * The schedule is derived on read, so there's nothing to rebuild. */
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

  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    if (declined.size) {
      // Cascades remove dependency edges for these tasks.
      mustOk(
        await supabase
          .from("tasks")
          .delete()
          .in("id", [...declined]),
        "declined tasks delete",
      );
    }
    // Stamp the confirmed goal onto the entry's tasks (the spine edge) along
    // with the chosen area.
    mustOk(
      await supabase
        .from("tasks")
        .update({ area, goal_id: projectId })
        .eq("entry_id", entryId),
      "tasks filing update",
    );
    mustOk(
      await supabase
        .from("entries")
        .update({
          status: "active",
          goal_id: projectId,
          parent_entry_id: parentEntryId,
        })
        .eq("id", entryId),
      "entry activate update",
    );
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

export async function discardDraft(entryId: string): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    // Child rows cascade on entry delete.
    mustOk(
      await supabase.from("entries").delete().eq("id", entryId),
      "entry delete",
    );
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<Entry>(
      await supabase
        .from("entries")
        .select("*")
        .eq("status", "active")
        .order("created_at", { ascending: false }),
      "entries list",
    );
  }
  await ensureSeeded();
  return [...memDB().entries]
    .filter((m) => m.status === "active")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getEntry(id: string): Promise<EntryDetail | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const entry = mustOne<Entry>(
      await supabase.from("entries").select("*").eq("id", id).maybeSingle(),
      "entry read",
    );
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
      ...entry,
      decisions: mustRows<Decision>(decisions, "decisions list"),
      open_questions: mustRows<OpenQuestion>(questions, "open_questions list"),
      tasks: mustRows<Task>(tasks, "entry tasks list"),
      dependencies: mustRows<TaskDependency>(deps, "task_dependencies list"),
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

/** Recommended schedule for an entry, derived live from open tasks + availability.
 * Never persisted, so it always reflects the latest estimates. */
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

export async function listAllTasks(): Promise<Task[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const active = mustRows<{ id: string }>(
      await supabase.from("entries").select("id").eq("status", "active"),
      "active entry ids list",
    );
    const ids = active.map((m) => m.id);
    if (ids.length === 0) return [];
    return mustRows<Task>(
      await supabase
        .from("tasks")
        .select("*")
        .in("entry_id", ids)
        .order("created_at", { ascending: false }),
      "tasks list (all)",
    );
  }
  await ensureSeeded();
  const db = memDB();
  const draftIds = new Set(
    db.entries.filter((m) => m.status === "draft").map((m) => m.id),
  );
  return db.tasks.filter((t) => !draftIds.has(t.entry_id));
}

export async function listAllDependencies(): Promise<TaskDependency[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const active = mustRows<{ id: string }>(
      await supabase.from("entries").select("id").eq("status", "active"),
      "active entry ids list",
    );
    const ids = active.map((m) => m.id);
    if (ids.length === 0) return [];
    return mustRows<TaskDependency>(
      await supabase.from("task_dependencies").select("*").in("entry_id", ids),
      "task_dependencies list (all)",
    );
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
      // reopen/undo). slice 6b.
      | "resolved_by"
      // Reshaped in place by the strategist's scope-down move.
      | "title"
      | "description"
      | "estimated_minutes"
    >
  >,
): Promise<Task | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    // `null` here means no row matched the id, never that the update failed.
    return mustOne<Task>(
      await supabase
        .from("tasks")
        .update(patch)
        .eq("id", id)
        .select("*")
        .maybeSingle(),
      "task update",
    );
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
  // Only the entry carries user_id; child rows inherit ownership through it
  // (see the RLS policies in supabase/schema.sql).
  mustOk(
    await supabase.from("entries").insert({ ...a.entry, user_id }),
    "entry insert",
  );
  if (a.decisions.length)
    mustOk(
      await supabase.from("decisions").insert(a.decisions),
      "decisions insert",
    );
  if (a.questions.length)
    mustOk(
      await supabase.from("open_questions").insert(a.questions),
      "open_questions insert",
    );
  if (a.tasks.length)
    mustOk(await supabase.from("tasks").insert(a.tasks), "tasks insert");
  if (a.deps.length)
    mustOk(
      await supabase.from("task_dependencies").insert(a.deps),
      "task_dependencies insert",
    );
}

// --- Time budget ------------------------------------------------------------

export async function setProjectDeadline(
  projectId: string,
  deadline: string | null,
): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("goals").update({ deadline }).eq("id", projectId),
      "goal deadline update",
    );
    return;
  }
  await ensureSeeded();
  const p = memDB().projects.find((x) => x.id === projectId);
  if (p) p.deadline = deadline;
}

/** The user's weekly availability template - all 7 weekdays, defaults merged in. */
export async function getAvailability(): Promise<Availability[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mergeAvailability(
      mustRows<Availability>(
        await supabase.from("availability").select("*"),
        "availability list",
      ),
    );
  }
  await ensureSeeded();
  return mergeAvailability(memDB().availability);
}

export async function setAvailability(
  rows: { weekday: number; hours: number }[],
): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const payload = rows.map((r) => ({
      user_id,
      weekday: r.weekday,
      hours: Math.max(0, r.hours),
    }));
    mustOk(
      await supabase
        .from("availability")
        .upsert(payload, { onConflict: "user_id,weekday" }),
      "availability upsert",
    );
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

/** Pit-wall automation. On = auto-apply obvious low-value triage, escalate ties.
 *  Off by default so nothing gets deferred behind the user's back. */
export async function getAutoStrategy(): Promise<boolean> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<{ auto_strategy?: boolean }>(
      await supabase.from("user_settings").select("auto_strategy").maybeSingle(),
      "user_settings read",
    );
    return row?.auto_strategy ?? false;
  }
  await ensureSeeded();
  return memDB().autoStrategy;
}

export async function setAutoStrategy(value: boolean): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase
        .from("user_settings")
        .upsert(
          { user_id, auto_strategy: value, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        ),
      "user_settings upsert",
    );
    return;
  }
  await ensureSeeded();
  memDB().autoStrategy = value;
}

export async function getValueModel(): Promise<ValueModel> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<{ model?: unknown }>(
      await supabase.from("value_model").select("model").maybeSingle(),
      "value_model read",
    );
    const raw = row?.model;
    return raw === undefined || raw === null
      ? { ...DEFAULT_VALUE_MODEL, areaWeights: {} }
      : normalizeValueModel(raw);
  }
  await ensureSeeded();
  return memDB().valueModel ?? { ...DEFAULT_VALUE_MODEL, areaWeights: {} };
}

export async function setValueModel(model: ValueModel): Promise<void> {
  const clean = normalizeValueModel(model);
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase
        .from("value_model")
        .upsert(
          { user_id, model: clean, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        ),
      "value_model upsert",
    );
    return;
  }
  await ensureSeeded();
  memDB().valueModel = clean;
}

/** The user's explicit per-window availability, or the unset default
 *  (all-zero weights ⇒ the derived share is used). */
export async function getWindowAvailability(): Promise<WindowAvailability> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<{ weights?: unknown }>(
      await supabase.from("window_availability").select("weights").maybeSingle(),
      "window_availability read",
    );
    const raw = row?.weights;
    return raw === undefined || raw === null
      ? EMPTY_WINDOW_AVAILABILITY
      : normalizeWindowAvailability(raw);
  }
  await ensureSeeded();
  return memDB().windowAvailability ?? EMPTY_WINDOW_AVAILABILITY;
}

export async function setWindowAvailability(avail: WindowAvailability): Promise<void> {
  const clean = normalizeWindowAvailability(avail);
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase
        .from("window_availability")
        .upsert(
          { user_id, weights: clean.weights, updated_at: new Date().toISOString() },
          { onConflict: "user_id" },
        ),
      "window_availability upsert",
    );
    return;
  }
  await ensureSeeded();
  memDB().windowAvailability = clean;
}

// --- Portfolio strategy cache -------------------------------------

/** The cached portfolio strategy, or null. The Today load path reads this, never the
 * generator, and compares `fingerprint` to decide fresh vs stale. */
export async function getCachedStrategy(): Promise<PortfolioStrategy | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<{ strategy?: PortfolioStrategy }>(
      await supabase.from("portfolio_strategy").select("strategy").maybeSingle(),
      "portfolio_strategy read",
    );
    return row?.strategy ?? null;
  }
  await ensureSeeded();
  return memDB().portfolioStrategy;
}

export async function setCachedStrategy(
  strategy: PortfolioStrategy,
): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("portfolio_strategy").upsert(
        {
          user_id,
          fingerprint: strategy.fingerprint,
          strategy,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      ),
      "portfolio_strategy upsert",
    );
    return;
  }
  await ensureSeeded();
  memDB().portfolioStrategy = strategy;
}

// --- Asynchronous job runs (the queue-backed LLM path) ----------------------
//
// Three actions publish an EventBridge event and return before the work finishes.
// These rows are the only way the browser tells "queued" from "nothing happened",
// and the only place a worker failure can surface at all. Written from both
// runtimes (action creates, SQS worker settles), both RLS-scoped, so no user id.

interface JobRunRow {
  id: string;
  type: string;
  subject_id: string | null;
  status: JobRunStatus;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

const JOB_RUN_COLUMNS =
  "id, type, subject_id, status, result, error, created_at, updated_at";

// Rows kept per user before pruneJobRuns() starts deleting terminal ones by age.
//
// Raised from 50 when DAILY_JOB_QUOTA arrived, and the relationship is load-bearing rather
// than incidental: the quota is enforced by COUNTING rows in a 24-hour window, so a cap
// below the quota would delete the evidence before the limit could ever be reached and the
// quota would silently never fire. Keep this comfortably above DAILY_JOB_QUOTA.
const JOB_RUN_CAP = 200;

/** Model calls one account may start per rolling 24 hours.
 *
 *  A spend ceiling, not a fairness mechanism. WORKER_MAX_CONCURRENCY caps how many Bedrock
 *  requests run AT ONCE, which bounds the rate and not the total - a signed-in account can
 *  create goals in a loop and decompose each one, and the in-flight guard below does not stop
 *  that because every one of them is a different subject. Two users cannot legitimately need
 *  120 model calls in a day; the heaviest real day measured on the previous stack was a
 *  fraction of it. */
export const DAILY_JOB_QUOTA = 120;

function toJobRun(row: JobRunRow): JobRun {
  return {
    id: row.id,
    type: row.type,
    subjectId: row.subject_id,
    status: row.status,
    result: row.result,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** True when this account has started DAILY_JOB_QUOTA jobs in the last 24 hours.
 *
 *  Scoped to the caller by RLS, not by a where clause - job_runs.user_id is covered by
 *  job_runs_owner, so there is no user id to pass and no way to ask about someone else.
 *
 *  Reads ids with a LIMIT rather than asking for a count: lib/db/query.ts implements no count
 *  option (see its header), and a bounded read is the cheaper question anyway - "are there at
 *  least N" needs at most N rows, while a count scans the whole window.
 *
 *  Demo mode has no Bedrock behind it and nothing to spend, so it never blocks. */
export async function jobQuotaExceeded(): Promise<boolean> {
  if (!isDbConfigured()) return false;

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const supabase = await getRequestClient();
  const rows = mustRows<{ id: string }>(
    await supabase
      .from("job_runs")
      .select("id")
      .gte("created_at", since)
      .limit(DAILY_JOB_QUOTA),
    "job_runs quota count",
  );
  return rows.length >= DAILY_JOB_QUOTA;
}

/** Newest job run of `type` for `subjectId`, any state. Subject match is in SQL via
 *  .isNull - filtering in JS means a long-running job sinks below the LIMIT and the
 *  page shows an idle button for work that's still going. */
export async function latestJobRun(
  type: string,
  subjectId: string | null = null,
): Promise<JobRun | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const q = supabase.from("job_runs").select(JOB_RUN_COLUMNS).eq("type", type);
    const scoped =
      subjectId === null ? q.isNull("subject_id") : q.eq("subject_id", subjectId);
    const rows = mustRows<JobRunRow>(
      await scoped.order("created_at", { ascending: false }).limit(1),
      "job_runs latest read",
    );
    return rows[0] ? toJobRun(rows[0]) : null;
  }
  await ensureSeeded();
  return (
    memDB().jobRuns.find((r) => r.type === type && r.subjectId === subjectId) ??
    null
  );
}

/** Newest SUCCEEDED run of `type` for `subjectId`, or null.
 *
 *  Separate from latestJobRun because "is something running" and "what did the last good run
 *  produce" are different questions with different right answers, and one row cannot serve both:
 *  a regenerate that fails is the newest run AND must not erase the draft the previous one
 *  produced. Status is filtered in SQL for the same reason the subject match is - a failed retry
 *  between here and the last success would otherwise sink the row we want below the LIMIT.
 *
 *  This is how a job whose OUTPUT is the whole product survives a reload. Jobs that write rows
 *  (decompose, the link proposer) do not need it; the follow-up draft lives nowhere but
 *  `job_runs.result`, so without this read the card silently loses it. Retention is JOB_RUN_CAP
 *  terminal rows per user, which is the honest lifetime for a draft. */
export async function latestSucceededJobRun(
  type: string,
  subjectId: string | null = null,
): Promise<JobRun | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const q = supabase
      .from("job_runs")
      .select(JOB_RUN_COLUMNS)
      .eq("type", type)
      .eq("status", "succeeded");
    const scoped =
      subjectId === null ? q.isNull("subject_id") : q.eq("subject_id", subjectId);
    const rows = mustRows<JobRunRow>(
      await scoped.order("created_at", { ascending: false }).limit(1),
      "job_runs latest succeeded read",
    );
    return rows[0] ? toJobRun(rows[0]) : null;
  }
  await ensureSeeded();
  return (
    memDB().jobRuns.find(
      (r) =>
        r.type === type && r.subjectId === subjectId && r.status === "succeeded",
    ) ?? null
  );
}

export async function getJobRun(id: string): Promise<JobRun | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<JobRunRow>(
      await supabase
        .from("job_runs")
        .select(JOB_RUN_COLUMNS)
        .eq("id", id)
        .maybeSingle(),
      "job_runs read",
    );
    return row ? toJobRun(row) : null;
  }
  await ensureSeeded();
  return memDB().jobRuns.find((r) => r.id === id) ?? null;
}

/** The job still expected to finish, or null. Not the same as "not terminal": a row
 *  can be stranded by a bus-to-queue DLQ drop or a worker killed on timeout, so
 *  isJobAbandoned is what keeps those from pinning a button forever. */
export async function activeJobRun(
  type: string,
  subjectId: string | null = null,
): Promise<JobRun | null> {
  const run = await latestJobRun(type, subjectId);
  if (!run || isTerminalJobStatus(run.status) || isJobAbandoned(run)) return null;
  return run;
}

/** Take the one live slot for (type, subject). Returns the EXISTING run if one is in
 *  flight rather than starting a second billed model call (the strategy refresh fires
 *  on mount from two pages); `reused: true` means don't publish. A stale live row is
 *  failed first, otherwise the partial unique index rejects the replacement. */
export async function startJobRun(
  type: string,
  subjectId: string | null = null,
): Promise<{ run: JobRun; reused: boolean }> {
  const existing = await latestJobRun(type, subjectId);
  if (existing && !isTerminalJobStatus(existing.status)) {
    if (!isJobAbandoned(existing)) return { run: existing, reused: true };
    await settleJobRun(existing.id, "failed", {
      error: "Gave up waiting for this job; it never reported back.",
    });
  }

  const now = new Date().toISOString();
  const run: JobRun = {
    id: crypto.randomUUID(),
    type,
    subjectId,
    status: "queued",
    result: null,
    error: null,
    createdAt: now,
    updatedAt: now,
  };

  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const res = await supabase.from("job_runs").insert({
      id: run.id,
      user_id,
      type: run.type,
      subject_id: run.subjectId,
      status: run.status,
      result: run.result,
      error: run.error,
      created_at: run.createdAt,
      updated_at: run.updatedAt,
    });
    if (res.error) {
    // Two clicks 50ms apart are two Lambda invocations that can't see each other's
    // uncommitted row, so the index - not the read above - enforces one live job.
    // Losing the race is fine: the winner's row is the job.
      if (res.error.message.includes("job_runs_one_live_per_subject")) {
        const live = await latestJobRun(type, subjectId);
        if (live) return { run: live, reused: true };
      }
      throw new Error(`DB job_runs insert failed: ${res.error.message}`);
    }
    await bestEffortPrune("job_runs", () => pruneJobRuns(supabase));
    return { run, reused: false };
  }

  await ensureSeeded();
  const db = memDB();
  db.jobRuns.unshift(run);
  if (db.jobRuns.length > JOB_RUN_CAP) db.jobRuns.length = JOB_RUN_CAP;
  return { run, reused: false };
}

/** Delete terminal job rows past JOB_RUN_CAP. Terminal only - rank is by age, and
 *  deleting a still-running job makes its watcher's next poll return null, which the
 *  hook reads as "gone" and drops the pending state on live work. */
async function pruneJobRuns(supabase: RequestClient): Promise<void> {
  const older = mustRows<{ id: string; status: JobRunStatus }>(
    await supabase
      .from("job_runs")
      .select("id, status")
      .order("created_at", { ascending: false })
      .range(JOB_RUN_CAP, JOB_RUN_CAP + 1000),
    "job_runs stale list",
  );
  const stale = older.filter((r) => isTerminalJobStatus(r.status));
  if (stale.length)
    mustOk(
      await supabase
        .from("job_runs")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        ),
      "job_runs prune delete",
    );
}

/** Move a job to `running`; false means it's already settled. That happens on SQS
 *  redelivery when the visibility timeout lapses just as the job completes, and
 *  skipping matters because replaceSkillNodes wipes and rewrites the whole skill graph.
 *
 *  This does NOT make redelivery safe in general. A worker killed mid-job leaves the
 *  row `running`, claims fine and re-runs - correct, it never finished. But "died
 *  before the work" and "died after committing, before settling" look identical here.
 *  That window is the price of at-least-once. */
export async function claimJobRun(id: string): Promise<boolean> {
  const run = await getJobRun(id);
  if (!run || isTerminalJobStatus(run.status)) return false;
  // Clear the last attempt's message on the way in, or a row that failed once and then
  // succeeded keeps its error text and the card renders red under a working result.
  await settleJobRun(id, "running", { error: null });
  return true;
}

/** Write a job's state. The one writer for every post-insert transition, so `updated_at`
 * can't be forgotten - and forgetting it looks exactly like an abandoned job. */
export async function settleJobRun(
  id: string,
  status: JobRunStatus,
  fields: { result?: Record<string, unknown> | null; error?: string | null },
): Promise<void> {
  const updatedAt = new Date().toISOString();
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const patch: Record<string, unknown> = { status, updated_at: updatedAt };
    // `definedEntries` in the query builder drops undefined keys, so naming a
    // field here only when the caller passed one keeps a retry from wiping the
    // error message it just wrote.
    if (fields.result !== undefined) patch.result = fields.result;
    if (fields.error !== undefined) patch.error = fields.error;
    mustOk(
      await supabase.from("job_runs").update(patch).eq("id", id),
      "job_runs settle",
    );
    return;
  }
  await ensureSeeded();
  const run = memDB().jobRuns.find((r) => r.id === id);
  if (!run) return;
  run.status = status;
  run.updatedAt = updatedAt;
  if (fields.result !== undefined) run.result = fields.result;
  if (fields.error !== undefined) run.error = fields.error;
}

// --- Rolling-horizon committed plan ---------------------------------

/** The rolling-horizon committed plan, or null. One row per user. A schemaVersion
 *  mismatch is treated as absent - safer to re-plan than mis-replay. */
export async function getCommittedPlan(): Promise<CommittedPlan | null> {
  let plan: CommittedPlan | null;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<{ plan?: CommittedPlan }>(
      await supabase.from("committed_plan").select("plan").maybeSingle(),
      "committed_plan read",
    );
    plan = row?.plan ?? null;
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("committed_plan").upsert(
        { user_id, plan, updated_at: new Date().toISOString() },
        { onConflict: "user_id" },
      ),
      "committed_plan upsert",
    );
    return;
  }
  await ensureSeeded();
  memDB().committedPlan = plan;
}

// --- Passive-roll history -------------------------------------------
//
// Each automatic roll (a material better candidate or an anchor advance, never a
// stay-put reload) is appended as a PlanRoll, powering the evolution timeline and
// roll-undo. A roll mutates no domain rows, only the arrangement, so undo restores
// an order through reconcile rather than writing rows back. Column is `plan_order`:
// `order` collides with PostgREST's ?order= sort param.

/** Soft cap on retained rolls per user; oldest pruned beyond this (design, mirrors
 *  `PLAN_VERSION_CAP`). */
const PLAN_ROLL_CAP = 50;

/** Append one roll to the history and prune to the cap. Best-effort at the call site:
 *  `commitRollingPlan` runs inside the mutation hook's swallowed try/catch, so a
 *  history-append failure can never break the mutation that triggered the roll. */
async function insertPlanRoll(roll: PlanRoll): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("plan_rolls").insert({
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
      }),
      "plan_rolls insert",
    );
    await bestEffortPrune("plan_rolls", () => prunePlanRolls(supabase));
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.planRolls.unshift(roll);
  if (db.planRolls.length > PLAN_ROLL_CAP) db.planRolls.length = PLAN_ROLL_CAP;
}

async function prunePlanRolls(supabase: RequestClient): Promise<void> {
  const stale = mustRows<{ id: string }>(
    await supabase
      .from("plan_rolls")
      .select("id")
      .order("rolled_at", { ascending: false })
      .range(PLAN_ROLL_CAP, PLAN_ROLL_CAP + 1000),
    "plan_rolls stale list",
  );
  if (stale.length)
    mustOk(
      await supabase
        .from("plan_rolls")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        ),
      "plan_rolls prune delete",
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

/** Passive-roll history, newest first. Rows whose schemaVersion no longer matches the
 * current arrangement shape are dropped: they can't be replayed through reconcile. */
export async function listPlanRolls(): Promise<PlanRoll[]> {
  let rolls: PlanRoll[];
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    rolls = mustRows<PlanRollRow>(
      await supabase
        .from("plan_rolls")
        .select("*")
        .order("rolled_at", { ascending: false })
        .limit(PLAN_ROLL_CAP),
      "plan_rolls list",
    ).map(rowToPlanRoll);
  } else {
    await ensureSeeded();
    rolls = memDB().planRolls;
  }
  return rolls.filter((r) => r.schemaVersion === COMMITTED_PLAN_SCHEMA_VERSION);
}

async function getPlanRoll(id: string): Promise<PlanRoll | null> {
  let roll: PlanRoll | null;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<PlanRollRow>(
      await supabase.from("plan_rolls").select("*").eq("id", id).maybeSingle(),
      "plan_roll read",
    );
    roll = row ? rowToPlanRoll(row) : null;
  } else {
    await ensureSeeded();
    roll = memDB().planRolls.find((r) => r.id === id) ?? null;
  }
  if (roll && roll.schemaVersion !== COMMITTED_PLAN_SCHEMA_VERSION) return null;
  return roll;
}

/** The roll immediately BEFORE `roll` by `rolledAt` for this user - the arrangement `roll`
 *  superseded, hence what its undo restores. Null when `roll` is the earliest retained (it was
 *  the first-ever commit): undo then falls back to a fresh build. */
async function priorPlanRoll(roll: PlanRoll): Promise<PlanRoll | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<PlanRollRow>(
      await supabase
        .from("plan_rolls")
        .select("*")
        .lt("rolled_at", roll.rolledAt)
        .order("rolled_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      "prior plan_roll read",
    );
    return row ? rowToPlanRoll(row) : null;
  }
  await ensureSeeded();
  // memDB is newest-first (unshift), so the first entry older than `roll` is its predecessor.
  return memDB().planRolls.find((r) => r.rolledAt < roll.rolledAt) ?? null;
}

async function markPlanRollReverted(id: string): Promise<void> {
  const revertedAt = new Date().toISOString();
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase
        .from("plan_rolls")
        .update({ reverted_at: revertedAt })
        .eq("id", id),
      "plan_rolls reverted update",
    );
    return;
  }
  await ensureSeeded();
  const r = memDB().planRolls.find((x) => x.id === id);
  if (r) r.revertedAt = revertedAt;
}

// --- Drag-to-reorder signal ---------------------------------------
//
// When the user drags today's plan into an odds-neutral order we keep both orders as
// a revealed-preference pair (user ≻ app) and calibrateArrangeWeights nudges
// ArrangeWeights off it. Columns are app_order/user_order, not `order` (PostgREST).

/** Soft cap on retained reorder observations per user; oldest pruned beyond this
 *  (mirrors `PLAN_ROLL_CAP`). */
const PLAN_REORDER_CAP = 50;

/** Append one reorder observation to the history and prune to the cap. Best-effort at
 *  the call site (S3's `reorderTodayAction` runs the accrual inside the same swallowed
 *  path as the honoring commit), so a history-append failure can never break the drag. */
export async function insertPlanReorder(reorder: PlanReorder): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("plan_reorders").insert({
        id: reorder.id,
        user_id,
        captured_at: reorder.capturedAt,
        date: reorder.date,
        app_order: reorder.appOrder,
        user_order: reorder.userOrder,
        schema_version: reorder.schemaVersion,
      }),
      "plan_reorders insert",
    );
    await bestEffortPrune("plan_reorders", () => prunePlanReorders(supabase));
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.planReorders.unshift(reorder);
  if (db.planReorders.length > PLAN_REORDER_CAP)
    db.planReorders.length = PLAN_REORDER_CAP;
}

async function prunePlanReorders(supabase: RequestClient): Promise<void> {
  const stale = mustRows<{ id: string }>(
    await supabase
      .from("plan_reorders")
      .select("id")
      .order("captured_at", { ascending: false })
      .range(PLAN_REORDER_CAP, PLAN_REORDER_CAP + 1000),
    "plan_reorders stale list",
  );
  if (stale.length)
    mustOk(
      await supabase
        .from("plan_reorders")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        ),
      "plan_reorders prune delete",
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

/** Drag-to-reorder history, newest first. Stale-schema rows are dropped - their orders
 * can't be re-priced, so the calibrator skips them. */
export async function listPlanReorders(): Promise<PlanReorder[]> {
  let reorders: PlanReorder[];
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    reorders = mustRows<PlanReorderRow>(
      await supabase
        .from("plan_reorders")
        .select("*")
        .order("captured_at", { ascending: false })
        .limit(PLAN_REORDER_CAP),
      "plan_reorders list",
    ).map(rowToPlanReorder);
  } else {
    await ensureSeeded();
    reorders = memDB().planReorders;
  }
  return reorders.filter(
    (r) => r.schemaVersion === COMMITTED_PLAN_SCHEMA_VERSION,
  );
}

// --- Offered-vs-kept move signal -------------------------------------------
//
// prefFor sums a STYLE nudge and a CAUSE nudge 1:1 and nothing revealed whether that
// ratio is right, because plan_versions only keeps moves the user COMMITTED. These
// rows keep the whole offered slate flagged kept/declined so the ratio is learnable.

const MOVE_CHOICE_CAP = 50;

/** Append one offered-vs-kept observation and prune to the cap. Best-effort at the call
 *  site: an accrual failure must never break the bundle the user just applied. */
export async function insertMoveChoice(choice: MoveChoice): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("move_choices").insert({
        id: choice.id,
        user_id,
        captured_at: choice.capturedAt,
        recovery_style: choice.recoveryStyle,
        offered: choice.offered,
        schema_version: choice.schemaVersion,
      }),
      "move_choices insert",
    );
    await bestEffortPrune("move_choices", () => pruneMoveChoices(supabase));
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.moveChoices.unshift(choice);
  if (db.moveChoices.length > MOVE_CHOICE_CAP)
    db.moveChoices.length = MOVE_CHOICE_CAP;
}

async function pruneMoveChoices(supabase: RequestClient): Promise<void> {
  const stale = mustRows<{ id: string }>(
    await supabase
      .from("move_choices")
      .select("id")
      .order("captured_at", { ascending: false })
      .range(MOVE_CHOICE_CAP, MOVE_CHOICE_CAP + 1000),
    "move_choices stale list",
  );
  if (stale.length)
    mustOk(
      await supabase
        .from("move_choices")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        ),
      "move_choices prune delete",
    );
}

interface MoveChoiceRow {
  id: string;
  captured_at: string;
  recovery_style: RecoveryStyle;
  offered: OfferedMove[];
  schema_version: number;
}

function rowToMoveChoice(r: MoveChoiceRow): MoveChoice {
  return {
    id: r.id,
    capturedAt: r.captured_at,
    recoveryStyle: r.recovery_style,
    offered: r.offered,
    schemaVersion: r.schema_version,
  };
}

/** The offered-vs-kept history, newest-first (capped). Rows whose `schemaVersion` no
 *  longer matches the current `OfferedMove` shape are dropped - their stored inputs
 *  can't be re-priced, so the calibrator skips them. Mirrors `listPlanReorders`. */
export async function listMoveChoices(): Promise<MoveChoice[]> {
  let choices: MoveChoice[];
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    choices = mustRows<MoveChoiceRow>(
      await supabase
        .from("move_choices")
        .select("*")
        .order("captured_at", { ascending: false })
        .limit(MOVE_CHOICE_CAP),
      "move_choices list",
    ).map(rowToMoveChoice);
  } else {
    await ensureSeeded();
    choices = memDB().moveChoices;
  }
  return choices.filter((c) => c.schemaVersion === MOVE_CHOICE_SCHEMA_VERSION);
}

// --- Plan version history --------------------------------------------------
//
// Every applied strategy bundle is snapshotted: committed moves, accepted odds, and a
// restore (prior row values + inserted ids). One snapshot per bundle, so undo reverts
// the whole strategy at once. commitStrategyBundle is the only server-side authority
// for applying a move.

/** Soft cap on retained versions per user; oldest pruned beyond this. */
const PLAN_VERSION_CAP = 50;

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

async function getTasksByIds(ids: string[]): Promise<Task[]> {
  if (ids.length === 0) return [];
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<Task>(
      await supabase.from("tasks").select("*").in("id", ids),
      "tasks by id list",
    );
  }
  await ensureSeeded();
  const set = new Set(ids);
  return memDB().tasks.filter((t) => set.has(t.id));
}

/** Read a skill node's current attainment fields - the pre-image an `attain_skill`
 *  move snapshots so undo can revert it to unattained. */
async function snapshotSkillNodeAttainment(
  id: string,
): Promise<(Partial<SkillNode> & { id: string })[]> {
  const fields = ["attained", "attained_confidence", "attained_at"] as const;
  let row: SkillNode | undefined;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    row =
      mustOne<SkillNode>(
        await supabase.from("skill_nodes").select("*").eq("id", id).maybeSingle(),
        "skill_node read",
      ) ?? undefined;
  } else {
    await ensureSeeded();
    row = memDB().skillNodes.find((n) => n.id === id);
  }
  if (!row) return [];
  const snap: Partial<SkillNode> & { id: string } = { id };
  for (const f of fields) (snap as Record<string, unknown>)[f] = row[f];
  return [snap];
}

/** Read a skill node's current deferral fields - the pre-image a `defer_skill`
 *  move snapshots so undo can un-park it. */
async function snapshotSkillNodeDeferral(
  id: string,
): Promise<(Partial<SkillNode> & { id: string })[]> {
  let row: SkillNode | undefined;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    row =
      mustOne<SkillNode>(
        await supabase.from("skill_nodes").select("*").eq("id", id).maybeSingle(),
        "skill_node read",
      ) ?? undefined;
  } else {
    await ensureSeeded();
    row = memDB().skillNodes.find((n) => n.id === id);
  }
  if (!row) return [];
  return [{ id, deferred: row.deferred, deferred_at: row.deferred_at }];
}

/** Dependency rows where a task is the PREREQ - the edges a resolve_blocker cascade
 * frees. Read from the LIVE DAG so the snapshot and the persist delete agree and a
 * stale advisory id just no-ops. */
async function getDependenciesByBlocker(blockerId: string): Promise<TaskDependency[]> {
  const all = await listAllDependencies();
  return all.filter((d) => d.depends_on_task_id === blockerId);
}

async function deleteDependencies(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("task_dependencies").delete().in("id", ids),
      "task_dependencies delete",
    );
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.deps = db.deps.filter((d) => !set.has(d.id));
}

/** Re-insert FULL dependency rows - the undo of a `resolve_blocker` cascade.
 *  Re-inserting the ORIGINAL rows (same id/entry_id) restores DAG identity and
 *  re-satisfies whatever FK/RLS admitted them. Mirrors `deleteTasks` across stores. */
async function insertDependencies(rows: TaskDependency[]): Promise<void> {
  if (rows.length === 0) return;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("task_dependencies").insert(rows),
      "task_dependencies re-insert",
    );
    return;
  }
  await ensureSeeded();
  memDB().deps.push(...rows);
}

// --- Move spec registry ----------------------------------------------------
//
// One MoveSpec per kind, co-locating the undo pre-image `snapshot` with the real
// `persist`. These used to be two switches ~60 lines apart and snapshot has to capture
// exactly the fields persist mutates or undo is wrong.
//
// The forecast twin of `persist` is applyMoveToAlloc in portfolio-state.ts - it stays
// there because the live re-solve runs it CLIENT-side and can't import this
// server-only module. Both are exhaustive over StrategyMoveKind, so a new kind won't
// compile without both halves. persist MUST match what its forecast arm previewed or
// the odds the user accepted were a lie.

/** Prior values of the rows one move mutates - its undo pre-image (id + only the
 *  fields that move's `persist` changes; restore writes exactly those back). */
type MoveRowSnapshot = {
  tasks: (Partial<Task> & { id: string })[];
  goals: (Partial<Goal> & { id: string })[];
  /** Prior attainment of skill nodes an `attain_skill` move flips - absent
   *  for every other kind. */
  skillNodes?: (Partial<SkillNode> & { id: string })[];
  /** FULL dependency rows a `resolve_blocker` cascade will DELETE - captured
   *  as the pre-image so undo re-inserts the originals byte-identical; absent otherwise. */
  dependencies?: TaskDependency[];
};

type MovePersistResult = Partial<
  Pick<RowSnapshot, "insertedTaskIds" | "insertedEntryIds" | "activityCompletionIds">
>;

interface MoveSpec<K extends StrategyMoveKind> {
  /** Prior values of the rows `persist` will mutate - read BEFORE any apply so it is
   *  the true pre-image, capturing only the fields `persist` touches. Inserted
   *  synthetic rows are captured at apply time by `persist`, not here. */
  snapshot(
    payload: Extract<StrategyMovePayload, { kind: K }>,
    move: StrategyMove,
  ): Promise<MoveRowSnapshot>;
  /** The real DB mutation; returns the synthetic-row ids it inserted (for undo).
   *  `mark_done` stamps `inferred` - the strategist inferred the completion. */
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
  // The batch mixes real tasks with sheddable skill lanes (`skill:<nodeId>`), so
  // snapshot each id from the right table - task `deferred` vs skill
  // `deferred`/`deferred_at`. The restore loop is field-aware.
    snapshot: async (p) => {
      const taskIds = p.taskIds.filter((id) => !id.startsWith(SKILL_TASK_PREFIX));
      const skillNodeIds = p.taskIds
        .filter((id) => id.startsWith(SKILL_TASK_PREFIX))
        .map((id) => id.slice(SKILL_TASK_PREFIX.length));
      const skillNodes = (
        await Promise.all(skillNodeIds.map((id) => snapshotSkillNodeDeferral(id)))
      ).flat();
      return {
        tasks: await snapshotTaskFields(taskIds, ["deferred"]),
        goals: [],
        ...(skillNodes.length ? { skillNodes } : {}),
      };
    },
    persist: async (p) => {
      await Promise.all(p.taskIds.map((id) => setTriageItemDeferred(id, true)));
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
     // 6b - snapshot the blocker's done-fields + provenance AND the FULL edge rows
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
    // Mark the blocker done (check-in resolutions are always self_assessed), stamp the
    // provenance, then delete every edge into it. Edges are re-derived from the live
    // DAG, never from the advisory freedTaskIds, so a stale entry no-ops. Cascade is
    // one-hop: a freed dependent becomes actionable, never auto-completed.
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
        ["status", "completion_confidence", "completed_at", "resolved_by"],
      ),
      goals: [],
    }),
    persist: async (p) => {
      await updateTask(p.taskId, {
        status: "done",
        // provenance rides on the payload. A check-in "I finished X" carries
        // `self_assessed`; the strategist's own inference omits it → `inferred`.
        completion_confidence: p.confidence ?? "inferred",
        completed_at: new Date().toISOString(),
        // Only a linked-spillover completion carries free text; a plain mark_done
        // leaves any existing `resolved_by` untouched.
        ...(p.resolvedBy !== undefined && { resolved_by: p.resolvedBy }),
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
  defer_skill: {
    snapshot: async (p) => ({
      tasks: [],
      goals: [],
      skillNodes: await snapshotSkillNodeDeferral(p.nodeId),
    }),
    persist: async (p) => {
      await setSkillNodeDeferred(p.nodeId, true);
      return {};
    },
  },
  reschedule_skill: {
  // Parks the whole milestone chain, descoped checkpoint included. Snapshot each node's
  // pre-image so undo un-parks the exact set.
    snapshot: async (p) => ({
      tasks: [],
      goals: [],
      skillNodes: (
        await Promise.all(p.parkNodeIds.map((id) => snapshotSkillNodeDeferral(id)))
      ).flat(),
    }),
    persist: async (p) => {
      await Promise.all(p.parkNodeIds.map((id) => setSkillNodeDeferred(id, true)));
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

/** Look up a move's spec. TS can't correlate the registry key with the payload union,
 *  so the spec is widened here - sound because we index by the payload's own kind. */
function specFor(kind: StrategyMoveKind): MoveSpec<StrategyMoveKind> {
  return MOVE_SPECS[kind] as MoveSpec<StrategyMoveKind>;
}

/** Bundle apply order - deadline reschedules go last so deferrals free their hours
 *  first (`move.kind` mirrors `payload.kind` at construction, so either keys it). */
function strategyApplyOrder(a: StrategyMove, b: StrategyMove): number {
  const rank = (k: StrategyMoveKind) => (k === "reschedule_deadline" ? 1 : 0);
  return rank(a.payload.kind) - rank(b.payload.kind);
}

/** Apply a bundle and record it as a PlanVersion: snapshot prior values, apply each
 *  move (deadline reschedules last), persist the version. Returned so the caller can
 *  offer Undo. meta.odds* are the numbers the user accepted, for the history view. */
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
  // Dependency edges a resolve_blocker cascade deletes - deduped by edge id as a
  // pre-image, so undo re-inserts each original exactly once.
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

  // Odds are display-only but the columns are NOT NULL, and JSON.stringify(NaN) → null.
  // A degraded cache applied before auto-regen would throw on insert and kill the whole
  // Apply, so coerce - a commit shouldn't fail over a cosmetic number.
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("plan_versions").insert({
        id: version.id,
        user_id,
        created_at: version.createdAt,
        reverted_at: version.revertedAt,
        reason: version.reason,
        odds_before: version.oddsBefore,
        odds_after: version.oddsAfter,
        moves: version.moves,
        restore: version.restore,
      }),
      "plan_versions insert",
    );
    await bestEffortPrune("plan_versions", () => prunePlanVersions(supabase));
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.planVersions.unshift(version);
  if (db.planVersions.length > PLAN_VERSION_CAP)
    db.planVersions.length = PLAN_VERSION_CAP;
}

async function prunePlanVersions(supabase: RequestClient): Promise<void> {
  const stale = mustRows<{ id: string }>(
    await supabase
      .from("plan_versions")
      .select("id")
      .order("created_at", { ascending: false })
      .range(PLAN_VERSION_CAP, PLAN_VERSION_CAP + 1000),
    "plan_versions stale list",
  );
  if (stale.length)
    mustOk(
      await supabase
        .from("plan_versions")
        .delete()
        .in(
          "id",
          stale.map((r) => r.id),
        ),
      "plan_versions prune delete",
    );
}

/** Plan version history, newest first. Display-only, so bestEffortRows - if this table
 *  alone is unhealthy the timeline empties instead of felling the Strategy page. The
 *  undo path reads a single row via getPlanVersion, which still throws. */
export async function listPlanVersions(): Promise<PlanVersion[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return bestEffortRows<PlanVersionRow>(
      await supabase
        .from("plan_versions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(PLAN_VERSION_CAP),
      "plan_versions list",
    ).map(rowToPlanVersion);
  }
  await ensureSeeded();
  return memDB().planVersions;
}

async function getPlanVersion(id: string): Promise<PlanVersion | null> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const row = mustOne<PlanVersionRow>(
      await supabase.from("plan_versions").select("*").eq("id", id).maybeSingle(),
      "plan_version read",
    );
    return row ? rowToPlanVersion(row) : null;
  }
  await ensureSeeded();
  return memDB().planVersions.find((v) => v.id === id) ?? null;
}

async function markPlanVersionReverted(id: string): Promise<void> {
  const revertedAt = new Date().toISOString();
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase
        .from("plan_versions")
        .update({ reverted_at: revertedAt })
        .eq("id", id),
      "plan_versions reverted update",
    );
    return;
  }
  await ensureSeeded();
  const v = memDB().planVersions.find((x) => x.id === id);
  if (v) v.revertedAt = revertedAt;
}

/** Revert one applied bundle whole: write snapshotted values back, delete the rows it
 * inserted, mark it reverted (stays in history, struck through). No-op if already done. */
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
  // Restore prior skill-node attainment / deferral (defer_skill) - each
  // move snapshots only the fields it touched, so revert only those (an
  // attain_skill snapshot carries `attained`, a defer_skill one carries `deferred`).
  for (const n of restore.skillNodes ?? []) {
    if ("attained" in n) await setSkillNodeAttained(n.id, n.attained ?? false, n.attained_confidence ?? null);
    if ("deferred" in n) await setSkillNodeDeferred(n.id, n.deferred ?? false);
  }
  // Re-insert the dependency edges a resolve_blocker cascade deleted - the
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("tasks").delete().in("id", ids),
      "tasks delete",
    );
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.tasks = db.tasks.filter((t) => !set.has(t.id));
}

async function deleteEntries(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("entries").delete().in("id", ids),
      "entries delete",
    );
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.entries = db.entries.filter((e) => !set.has(e.id));
}

async function deleteActivityCompletions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase.from("activity_completions").delete().in("id", ids),
      "activity_completions delete",
    );
    return;
  }
  await ensureSeeded();
  const set = new Set(ids);
  const db = memDB();
  db.activityCompletions = db.activityCompletions.filter((c) => !set.has(c.id));
}

export async function setOverride(date: string, hours: number): Promise<void> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase
        .from("availability_overrides")
        .upsert(
          { user_id, date, hours: Math.max(0, hours) },
          { onConflict: "user_id,date" },
        ),
      "override upsert",
    );
    return;
  }
  await ensureSeeded();
  const db = memDB();
  const ex = db.overrides.find((o) => o.date === date);
  if (ex) ex.hours = Math.max(0, hours);
  else db.overrides.push({ date, hours: Math.max(0, hours) });
}

export async function listCommitments(): Promise<Commitment[]> {
  const today = todayISO();
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<Commitment>(
      await supabase
        .from("commitments")
        .select("*")
        .gte("date", today)
        .order("date"),
      "commitments list (upcoming)",
    );
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

/** Recurring drain as synthetic Commitment rows - the single place recurring time-cost
 *  enters the budget. Every capacity consumer subtracts commitment hours per date, so
 *  it lands everywhere automatically. The agenda's synthetic recurring task is display
 *  only and must never be counted against capacity again. */
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

/** Raw time-budget inputs - the real availability/overrides/commitments, NO
 *  recurring drain folded in (so callers that need the un-drained set can get it). */
async function getRawTimeBudget(): Promise<TimeBudget> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const [avail, over, comm] = await Promise.all([
      supabase.from("availability").select("*"),
      supabase.from("availability_overrides").select("*"),
      supabase.from("commitments").select("*"),
    ]);
    return {
      availability: mergeAvailability(
        mustRows<Availability>(avail, "availability list"),
      ),
      overrides: mustRows<AvailabilityOverride>(
        over,
        "availability_overrides list",
      ),
      commitments: mustRows<Commitment>(comm, "commitments list"),
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

async function getTimeBudget(): Promise<TimeBudget> {
  return appendActivityDrain(await getRawTimeBudget());
}

// --- Recurring activities (routines & goals) --------------------------------

export async function listRecurringActivities(): Promise<RecurringActivity[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<RecurringActivity>(
      await supabase
        .from("recurring_activities")
        .select("*")
        .order("created_at", { ascending: false }),
      "recurring_activities list",
    );
  }
  await ensureSeeded();
  return [...memDB().recurringActivities].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

export async function listActivityCompletions(): Promise<ActivityCompletion[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<ActivityCompletion>(
      await supabase
        .from("activity_completions")
        .select("*")
        .order("date", { ascending: false }),
      "activity_completions list",
    );
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("recurring_activities").insert({ ...activity, user_id }),
      "recurring_activities insert",
    );
  } else {
    await ensureSeeded();
    memDB().recurringActivities.unshift(activity);
  }
  return activity.id;
}

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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    // `null` here means no row matched the id, never that the update failed.
    return mustOne<RecurringActivity>(
      await supabase
        .from("recurring_activities")
        .update(patch)
        .eq("id", id)
        .select("*")
        .maybeSingle(),
      "recurring_activities update",
    );
  }
  await ensureSeeded();
  const a = memDB().recurringActivities.find((x) => x.id === id);
  if (!a) return null;
  Object.assign(a, patch);
  return a;
}

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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("activity_completions").insert({ ...row, user_id }),
      "activity_completions insert",
    );
    return;
  }
  await ensureSeeded();
  memDB().activityCompletions.push(row);
}

/** Record one work session - the local when-signal the velocity loop accrues. `local`
 *  carries the CLIENT's window/weekday/day since the action can't read the browser
 *  clock. Task effort XOR routine session. Best-effort: pure telemetry, and it must
 *  never regress the completion that triggered it, so failures are logged not thrown. */
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
    if (isDbConfigured()) {
      const supabase = await getRequestClient();
      const user_id = await currentUserId(supabase);
      mustOk(
        await supabase.from("work_sessions").insert({ ...row, user_id }),
        "work_sessions insert",
      );
      return;
    }
    await ensureSeeded();
    memDB().workSessions.push(row);
  } catch (e) {
    console.error("logWorkSession failed (accrual skipped):", e);
  }
}

export async function listWorkSessions(): Promise<WorkSession[]> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    return mustRows<WorkSession>(
      await supabase
        .from("work_sessions")
        .select("*")
        .order("logged_for", { ascending: true }),
      "work_sessions list",
    );
  }
  await ensureSeeded();
  return [...memDB().workSessions];
}

/** Skip an activity's current instance: resolves that period's obligation without
 * crediting a streak. Reversible via unskipActivity. */
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("activity_completions").insert({ ...row, user_id }),
      "activity skip insert",
    );
    return;
  }
  await ensureSeeded();
  memDB().activityCompletions.push(row);
}

export async function unskipActivity(
  activityId: string,
  date?: string,
): Promise<void> {
  const day = (date ?? todayISO()).slice(0, 10);
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(
      await supabase
        .from("activity_completions")
        .delete()
        .eq("activity_id", activityId)
        .eq("date", day)
        .eq("skipped", true),
      "activity unskip delete",
    );
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.activityCompletions = db.activityCompletions.filter(
    (c) => !(c.activity_id === activityId && c.date === day && c.skipped),
  );
}

/** Derived state (status / streak / progress / due-today) of every active recurring
 * activity. Archived ones excluded. */
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

/** Skip an activity for the rest of the week - the apply behind `skip_activity`.
 *  Persists exactly the current-week owed instances the forecast probe freed, so the
 *  effect matches the shown odds. */
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase
        .from("activity_completions")
        .insert(rows.map((r) => ({ ...r, user_id }))),
      "activity week-skip insert",
    );
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

/** The reserved deadline-less "Errands" project, created lazily. An undeadlined
 *  project consumes budget but gets no forecast probability, which is exactly errand
 *  semantics, so errands reuse the whole task/agenda/defer machinery. */
export async function getOrCreateErrandsProject(): Promise<{
  projectId: string;
  entryId: string;
}> {
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    // Must throw, not degrade: a swallowed read here reports "no errands goal" and
    // the branch below then creates a second one.
    const proj = mustOne<{ id: string }>(
      await supabase
        .from("goals")
        .select("id")
        .eq("name", ERRANDS_PROJECT_NAME)
        .limit(1)
        .maybeSingle(),
      "errands project read",
    );
    let projectId = proj?.id;
    if (!projectId) {
      projectId = crypto.randomUUID();
      mustOk(
        await supabase.from("goals").insert({
          id: projectId,
          name: ERRANDS_PROJECT_NAME,
          description: "One-off errands.",
          kind: "project",
          deadline: null,
          user_id,
        }),
        "errands project insert",
      );
    }
    const ent = mustOne<{ id: string }>(
      await supabase
        .from("entries")
        .select("id")
        .eq("goal_id", projectId)
        .eq("status", "active")
        .limit(1)
        .maybeSingle(),
      "errands entry read",
    );
    let entryId = ent?.id;
    if (!entryId) {
      const entry = buildErrandsHoldingEntry(projectId);
      entryId = entry.id;
      mustOk(
        await supabase.from("entries").insert({ ...entry, user_id }),
        "errands entry insert",
      );
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    mustOk(await supabase.from("tasks").insert(task), "errand task insert");
  } else {
    await ensureSeeded();
    memDB().tasks.push(task);
  }
  return task.id;
}

// --- Forecast ---------------------------------------------------------------

interface ForecastGather {
  projects: Goal[];
  tasksByProject: Map<string, CandidateTask[]>;
  allTasksByProject: Map<string, Task[]>;
  /** A learning goal's unattained skill effort as synthetic work the joint forecast
   *  reasons over. Keyed by goal id, only for goals with an open skill graph. Recovery's
   *  defer-moves ignore it - you can't defer a skill row yet. */
  skillWorkByProject: Map<string, SkillWork>;
  skillNodesByProject: Map<string, SkillNode[]>;
  /** A goal's definition-of-done criteria - for divergence detection & goal-cost. */
  criteriaByProject: Map<string, GoalCriterion[]>;
  /** Dependency edges keyed by entry - for the re-sequence recommendation. */
  deps: TaskDependency[];
  /** entry_id → the entry's goal (provenance only; tasks map to goals via `Task.goal_id`). */
  projectOfEntry: Map<string, string | null>;
  deadlineByProject: Map<string, string | null>;
  projectNameById: Map<string, string>;
  /** The user's estimation bias, fit from all completed tasks - calibrates the forecast. */
  model: EstimationModel;
  /** Per-domain velocity: `model` shrunk per Task.area with `model` as the prior. A
   *  domain with sparse history resolves to the global prior. */
  velocityModel: VelocityModel;
  /** Global per-window velocity - `model` shrunk per time-of-day over session-tagged
   *  residuals. Empty history resolves to the global prior. */
  windowVelocity: VelocityModel;
  windowedResidualsByProject: Map<string, ResidualSample[]>;
  /** Per-window profile (share + net-of-global multiplier) the windowed forecast flows
   *  over. Null until some window has session history, so the forecast stays on the
   *  day-granular path until then. */
  windowProfile: WindowProfile | null;
  availability: Availability[];
  overrides: AvailabilityOverride[];
  /** All commitments INCLUDING the recurring drain (the base the forecast uses). */
  commitments: Commitment[];
  /** The real commitments WITHOUT recurring drain - for recomputing capacity when
   *  a skip-move probe removes some activity's hours. */
  realCommitments: Commitment[];
  /** Recurring activities + their completion log - the inputs a skip-move re-drains. */
  activities: RecurringActivity[];
  completions: ActivityCompletion[];
  valueModel: ValueModel;
 /** Drag-to-reorder pairs the arrangement-weight calibrator learns from. Raw here; the
  * calibrated weights are derived in buildArrangement, which needs the comfort cap. */
  planReorders: PlanReorder[];
  today: string;
}

interface SkillWork {
  /** One synthetic alloc task per unattained skill - enters the global plan. */
  tasks: AllocTask[];
  /** Prereq edges among still-open skills (attained prereqs no longer constrain). */
  deps: DependencyEdge[];
  /** Unattained effort minutes - the per-goal forecast's remaining work. */
  estimates: number[];
}

// SKILL_TASK_PREFIX lives in the client-safe portfolio-state module (the attain_skill
// forecast arm rebuilds the same id client-side). Used here to tell skill alloc tasks
// apart from real task uuids.

/** Skill nodes as work the joint forecast can reason over. Attained = done, deferred =
 *  parked, both dropped like done/deferred tasks; only the live frontier consumes budget
 *  and carries prereq ordering. Pure. */
function skillAllocWork(
  nodes: SkillNode[],
  projectId: string,
  projectName: string,
): SkillWork {
  const open = nodes.filter((n) => !n.attained && !n.deferred);
  const openIds = new Set(open.map((n) => n.id));
  const tasks = open.map((n) =>
    syntheticAllocTask(SKILL_TASK_PREFIX + n.id, projectId, projectName, n.title, n.estimated_minutes, {
      urgency: 3,
      // A checkpoint is a gate - weight it a touch higher so it orders ahead.
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
  const [projects, entries, tasks, deps, rawBudget, activities, completions, valueModel, allSkillNodes, allGoalCriteria, workSessions, windowAvailability, planReorders] =
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
      listPlanReorders(),
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
    // Done work is finished; deferred work was pushed past this deadline - neither
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
  // A goal's definition-of-done, grouped - divergence detection & the goal-cost
  // read it per goal off the single bulk fetch (no per-goal round-trips).
  const criteriaByProject = new Map<string, GoalCriterion[]>();
  for (const c of allGoalCriteria) {
    const list = criteriaByProject.get(c.goal_id) ?? [];
    list.push(c);
    criteriaByProject.set(c.goal_id, list);
  }
  // Fit the global estimation bias once over all completed tasks (the bias is the user's,
  // not a project's), then shrink per life-area against that fit, so a sparse domain
  // stays at the global number and only a clearly divergent one moves its own odds.
  const model = estimationModel(tasks);
  const velocityModel = fitVelocityModel(
    taskResidualSamples(tasks),
    (s) => s.domain,
    model,
  );
  // The WHEN axis: join each goal's sessions to its tasks for window-tagged residuals.
  // Empty until session capture accrues, at which point both fall back to the global prior.
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
  // Per-window net multiplier plus a shrunk session share bounding how much work claims
  // each window. Null until a session is logged. An explicit pinned availability
  // overrides the derived share; multipliers still come from learned data, so a pin does
  // nothing until window velocity is earned.
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
    planReorders,
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
        // S3b domain-axis grouping: keep same-area work adjacent within a day.
        area: t.area,
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

/** Joint odds for every deadlined project from ONE Monte Carlo over the global order,
 *  optionally with some tasks shed (the set a triage probe is testing). Lower
 *  `iterations` trades precision for speed on repeated probes. */
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
  // S3b Phase 2 - price time-of-day velocity: split the day capacities into window
  // segments (net multipliers from the learned window velocity). Null profile ⇒ the
  // exact day-granular path, so the number is unchanged until the loop learns windows.
  if (g.windowProfile) {
    opts.windowCapacities = windowCapacities(ctx.capacities, g.windowProfile);
  }
  return globalForecast(plan.order, ctx.capacities, g.deadlineByProject, g.today, opts);
}

/** Contention-aware odds for every deadlined project from ONE joint Monte Carlo. The
 *  single source both per-project forecasts and recovery gating read. */
function globalOdds(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
): Map<string, number> {
  return jointOdds(g, allocContext(g, commitments));
}


/** Fewer MC iterations for the optimizer's repeated probes (matches the triage
 *  probes' `TRIAGE_PROBE_ITERATIONS` - a relative read is all the greedy needs). */
const JOINT_PROBE_ITERATIONS = 2000;

/** The strategy's joint scorer: one gather + dashboard computation plus the closures
 *  the optimizer probes against. Built once per generation so the strategist doesn't
 *  double-gather. */
export interface JointScorer {
  forecasts: ProjectForecast[];
  recoveries: RecoveryPlan[];
  pitWall: PitWall;
  /** Active recurring activities - the pool of `skip_activity` candidates. */
  activities: RecurringActivity[];
  valueModel: ValueModel;
  /** Calibrated relative weights of the two odds-tie nudges (style vs diagnosed
   *  cause), learned from the offered-vs-kept history. Prior `{1, 1}` when unlearned. */
  movePrefWeights: MovePrefWeights;
  /** Current joint odds per deadlined project, no moves applied. */
  baseByProject: Map<string, number>;
  /** Current portfolio conjunction (P(all land)), no moves applied. */
  baseAllOnTime: number;
  /** Reduced-iteration joint score of an ordered move set - for optimizer probes. */
  score(moves: StrategyMove[]): { byProject: Map<string, number>; allOnTime: number };
  /** Full-iteration cumulative odds of an ordered move set - for the display. */
  cumulative(ordered: StrategyMove[]): { afterEach: number[]; combined: number };
  /** The serialized gather slice the review screen re-solves move subsets against
   *  client-side (attached to the generated `PortfolioStrategy`). */
  resolveInput: ResolveInput;
}

/** Per-day hours that skipping each active activity frees back to the pool. The client
 *  adds the selected series onto the SIGNED base slack and floors ONCE, so any subset of
 *  skips composes exactly as the server's recompute does - floored-per-skip deltas
 *  under-counted on over-subscribed days. Nothing owed this week frees nothing. */
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

/** Serialize the gather slice into the plain-JSON ResolveInput the review screen re-solves
 * against. baseSlackHours is SIGNED so multi-skip re-solves compose exactly. */
function buildResolveInput(
  g: ForecastGather,
  ctx: AllocContext,
  comfortCapMinutes: number | null,
  arrangeReorder: boolean,
  thinBuffer: ReadonlyMap<string, number>,
  committedOrder: string[] | null,
  arrangeWeights: ArrangeWeights,
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
    // S3b Phase 2 - ship the static window profile so the client rebuilds identical
    // window segments from its own (skip-adjusted) capacities (parity rides for free).
    windowProfile: g.windowProfile,
    // S3b Phase 3 slice 2 - ship the one comfort cap the scorer decided so the client's
    // subset re-solve meters by the same scalar (it takes precedence over the window
    // profile, matching `resolveSubsetOdds`).
    comfortCapMinutes,
    // S3b Phase 3 slice 3 - ship the within-day reorder flag the scorer decided so the
    // client replays the SAME deterministic `arrangeOrder` on its re-derived order (the
    // reorder reads only inputs already in `ResolveInput`, so parity rides for free).
    arrangeReorder,
    // Ship the calibrated soft-J weights so the client's arrangeOrder weights φ exactly as
    // the server did - otherwise a learned weight reshapes the server's order but not the
    // client's and parity breaks.
    arrangeWeights,
    // Ship the thin-buffer urgency as a JSON-safe record: the client rebuilds the Map and
    // feeds the same arrangeOrder. It can't be recomputed client-side, it needs the
    // per-project forecast distribution.
    thinBufferUrgency: Object.fromEntries(thinBuffer),
    // When showing a STICKY committed plan, ship its order so the client's base subset
    // prices it verbatim instead of re-deriving and re-arranging. Null (fresh candidate)
    // takes the old path.
    committedOrder: committedOrder ?? undefined,
  };
}

// --- Rolling-horizon roll cycle -------------------------------------
//
// S3b prices the best arrangement right now; S3c decides which already-priced
// arrangement to keep committing to as time advances. buildArrangement is the shared
// pipeline both read paths and the mutation-time roll run, so all three price
// identically. Reads decide what to show and persist nothing; commitRollingPlan is the
// only writer. See design/s3c-rolling-horizon-wrapper.md.

/** The arrangement bundle for a gather: canonical plan, comfort decision, thin-buffer
 * urgency, and the odds-gated candidate. Computed once and shared by every call site so
 * the displayed plan, the strategy base and the roll all price the SAME candidate. */
interface ArrangementBundle {
  canonical: GlobalPlan;
  smoothed: ComfortSmoothResult;
  thinBuffer: ReadonlyMap<string, number>;
  comfortCapMinutes: number | null;
  /** The odds-gated within-day reorder - `.order` is the display/candidate order, `.joint`
   *  its priced odds, `.changed` the single boolean the S1 client + probes replay. */
  reorder: GatedReorderResult;
  arrangeReorder: boolean;
  /** The calibrated arrangement weights learned from the drag history - the
   *  soft-`J` term weights the reorder + scorer used. Prior `{1,1,1}` with no drags (no-regret).
   *  Shipped to the client so its `arrangeOrder` replay stays bit-identical (S1 parity). */
  weights: ArrangeWeights;
  /** The arrange options the candidate was built under (INCLUDING `weights`) - reused by the churn
   *  bucketing + the soft-J scorer so the roll measures the same plan the forecast priced. */
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
  // Calibrate the soft J weights off the drag history, priced under THIS pass's arrange
  // context so φ is the same feature vector the reorder scores. After the comfort/buffer
  // decision (weights read them), before the reorder (reads the weights). No drags ⇒
  // prior {1,1,1}.
  const weights = calibrateArrangeWeights(g.planReorders, ctx.capacities, g.today, {
    windowProfile: g.windowProfile,
    comfortCapMinutes,
    thinBufferUrgency: thinBuffer,
  });
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
      weights,
    },
  );
  const arrangeOpts: ArrangeOrderOptions = {
    windowProfile: g.windowProfile,
    comfortCapMinutes,
    thinBufferUrgency: thinBuffer,
    weights,
  };
  return {
    canonical,
    smoothed,
    thinBuffer,
    comfortCapMinutes,
    reorder,
    arrangeReorder: reorder.changed,
    weights,
    arrangeOpts,
  };
}

/** Stable hash of the situation the committed plan is anchored to - the roll trigger.
 *  Bucketed due-dates so far-future edits don't churn. Reads the already-built gather
 *  and extends it with the window profile + velocity generation, so a model update is
 *  itself a legit trigger. Unchanged fingerprint + anchor ⇒ stay put cheaply. */
function rollFingerprint(g: ForecastGather, ctx: AllocContext): string {
  // Coarse due bucket relative to today - bucketing (not the raw date) keeps far-future
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
  // `deployableMinutes`), so a change to either must roll the plan - hash them too, else the
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
    // The S2 window-velocity + global-velocity generation - a model update rolls the plan.
    windowProfile: g.windowProfile,
    model: { meanLog: g.model.meanLog, sigma: g.model.sigma, n: g.model.sampleSize },
    valueModel: g.valueModel,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** The forecast options a committed order is REPRICED under - the same composition
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
 * . Read-only server-side; the value the intra-day frozen zone sharpens against. */
const LOCAL_NOW_COOKIE = "tb_local_now";

/** The client-captured local "now" from the request cookie - the browser stamps its own
 *  day/minute rather than us re-deriving from the server's UTC clock. Returns undefined
 *  on anything malformed or out of range, falling back to date-granular churn. Never
 *  throws: a bad cookie must not break a render. Format `YYYY-MM-DD|minutesSinceMidnight`. */
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

/** Pure rollDecision inputs for a gather + its arrangement bundle. The MC reprice and
 *  soft-J scorer are injected as closures over the current situation so committed and
 *  candidate are priced apples-to-apples. `localNow` enters only the churn near-weight,
 *  never odds or the fingerprint - a clock tick is not a situation change. */
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
    // S3c-5: the hysteresis knobs, EB-calibrated from the user's roll-undo history
    // (`undefined` ⇒ rollDecision falls back to the documented constants, the no-regret path).
    stabilityMargin: hysteresis?.stabilityMargin,
    churnCost: hysteresis?.churnCost,
  };
}

/** Roll the committed plan forward and persist the winner. Called after every mutation;
 *  read paths decide what to show but never write. Unchanged fingerprint + anchor means
 *  nothing moved, so it prices and writes nothing. afterMutation calls this best-effort
 *  so a roll can never break the mutation that triggered it. */
export async function commitRollingPlan(): Promise<RollDecisionResult | null> {
  const g = await gatherForecast();
  const ctx = allocContext(g, g.commitments);
  const committed = await getCommittedPlan();
  // Fast path - nothing plan-relevant changed since the committed row: keep it, no MC, no write.
  if (
    committed &&
    committed.anchor === g.today &&
    committed.fingerprint === rollFingerprint(g, ctx)
  ) {
    return null;
  }
  const bundle = buildArrangement(g, ctx);
  // The client clock sharpens the frozen zone to the imminent part of today. Deliberately
  // NOT in rollFingerprint, so the fast path still short-circuits on a pure clock tick.
  // Hysteresis knobs come from the roll-undo history, fetched only past the fast path.
  // No rolls ⇒ the documented constants.
  const [localNow, rolls] = await Promise.all([readClientLocalNow(), listPlanRolls()]);
  const hysteresis = calibrateHysteresis(rolls);
  const decision = rollDecision(rollContextFor(g, ctx, bundle, committed, localNow, hysteresis));
  if (decision.shouldPersist) {
    await setCommittedPlan(decision.toPersist);
    // Retain history only for a GENUINE plan change, never a stay-put freshen, so the
    // timeline shows real evolution instead of every reload.
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

/** Undo one automatic roll - the arrangement counterpart to undoPlanVersion. Not a row
 *  restore: it takes the order `roll` superseded and re-commits it, but only after
 *  feeding it back through the read path - reconciled against the current task set (a
 *  since-completed task is dropped, never resurrected) then re-priced. The stored order
 *  is a preference seed, not restored truth.
 *
 *  Re-commits under the CURRENT fingerprint so the revalidateAll roll right after stays
 *  put, otherwise the gain that caused the roll re-adopts the candidate and undo is a
 *  no-op. Idempotent. The undone roll stays in history with revertedAt set. */
export async function undoPlanRoll(id: string): Promise<void> {
  const roll = await getPlanRoll(id);
  if (!roll || roll.revertedAt) return; // idempotent - gone, or already reverted

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

/** What a drag-to-reorder produced, for the client's optimistic UI + warning. */
export interface ReorderOutcome {
  /** True ⇒ the honored order cost more than ε of odds - the client shows a "this costs some
   *  odds" note. */
  oddsCost: boolean;
  /** True ⇒ an odds-neutral, genuinely-resequencing drag was accrued as a calibration
   *  observation (a `plan_reorders` row). False ⇒ honored but not taught from. */
  recorded: boolean;
}

/** Honor a drag-to-reorder of today's plan and, when it's odds-neutral, accrue it as a
 *  revealed-preference pair. The dragged order is a seed fed through the same reconcile +
 *  re-price as roll-undo, then committed under the current fingerprint so the roll right
 *  after stays put. Unlike an undo, a deliberate drag is ALWAYS honored even if it costs
 *  odds; the comparison only sets the warning and gates whether the pair teaches the
 *  calibrator. `date` is the plan day it was for; the stored row uses the server's
 *  g.today so a stale client date can't mislabel it. Accrual is best-effort. */
export async function reorderToday(
  date: string,
  orderedTaskIds: string[],
): Promise<ReorderOutcome> {
  const [g, committed, localNow, rolls] = await Promise.all([
    gatherForecast(),
    getCommittedPlan(),
    readClientLocalNow(),
    listPlanRolls(),
  ]);
  const ctx = allocContext(g, g.commitments);
  const bundle = buildArrangement(g, ctx);
  // The order the user is following / saw - the same sticky-vs-fresh choice the read path makes,
  // so the drag's "before" and its priced baseline match what's on screen (no extra Monte Carlo).
  const decision = rollDecision(
    rollContextFor(g, ctx, bundle, committed, localNow, calibrateHysteresis(rolls)),
  );
  const repriceOpts = repriceOptionsFor(g, ctx, bundle);
  const result = reorderDecision({
    followedOrder: decision.order,
    followedOdds: decision.allOnTime,
    orderedTaskIds,
    canonicalOrder: bundle.canonical.order,
    repriceAllOnTime: (order) =>
      globalForecastJoint(order, ctx.capacities, g.deadlineByProject, g.today, repriceOpts)
        .allOnTime,
    scoreJ: (order) => arrangementScore(order, ctx.capacities, g.today, bundle.arrangeOpts),
  });

  // Honor unconditionally - commit the dragged order under the current fingerprint.
  await setCommittedPlan({
    schemaVersion: COMMITTED_PLAN_SCHEMA_VERSION,
    order: result.order,
    anchor: g.today,
    fingerprint: rollFingerprint(g, ctx),
    j: result.j,
    committedAt: new Date().toISOString(),
  });

  // Accrue only the odds-neutral, genuinely-resequencing drags - the signal
  // S4's `calibrateArrangeWeights` learns from.
  let recorded = false;
  if (result.record) {
    await insertPlanReorder({
      id: crypto.randomUUID(),
      // The plan day the drag was for. Trust a well-formed client date (the day they were
      // viewing, matching the LocalNow beacon), else fall back to server `g.today` - never a
      // malformed value. v1 is today-only, so this is normally just `g.today`.
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : g.today,
      capturedAt: new Date().toISOString(),
      appOrder: result.record.appOrder,
      userOrder: result.record.userOrder,
      schemaVersion: COMMITTED_PLAN_SCHEMA_VERSION,
    });
    recorded = true;
  }
  return { oddsCost: result.oddsCost, recorded };
}

/** Read-side idempotent anchor-roll. On a quiet new day (committed plan exists, decision
 *  kept it sticky, anchor predates today) advance the stored anchor from the read path so
 *  the frozen zone is fresh without waiting for a mutation. Display is already correct
 *  either way - this only tightens the stored anchor/fingerprint.
 *
 *  Two things keep a write-from-a-read safe: it's gated on decision.sticky (a read never
 *  persists a material re-arrangement), and it's a convergent singleton upsert with no
 *  history row, so concurrent loads on the same day converge instead of double-logging.
 *  Best-effort, and it must not revalidate - we're inside a Server Component render.
 *  Idempotent: after the write anchor === today, so the next load returns early. */
async function advanceAnchorOnQuietDay(
  committed: CommittedPlan | null,
  decision: RollDecisionResult,
): Promise<void> {
  if (!committed || !decision.sticky) return;
  if (committed.anchor === decision.toPersist.anchor) return; // anchor already fresh - no-op
  try {
    await setCommittedPlan(decision.toPersist);
  } catch {
    // Leaving the stale anchor is harmless: the display is unaffected and the next mutation
    // advances it. A render must never fail on a bookkeeping refresh.
  }
}

export async function createJointScorer(): Promise<JointScorer> {
  // The cached strategy is the temporal baseline for cause diagnosis - constraint_change
  // can only be diagnosed against it (a task added since, odds that have since dropped).
  // Without it the causes collapse to the residual-only classes. Loaded in parallel with
  // the gather so it costs no latency.
  const [g, cachedStrategy, committed, localNow, rolls, moveChoices] = await Promise.all([
    gatherForecast(),
    getCachedStrategy(),
    getCommittedPlan(),
    readClientLocalNow(),
    listPlanRolls(),
    listMoveChoices(),
  ]);
  const ctx = allocContext(g, g.commitments);
  // Decide the comfort cap, thin-buffer urgency and reorder ONCE on the base order (same
  // decision forecastDashboard makes), then meter every joint re-solve by them: base,
  // move probes, cumulative display, and the client subset re-solve.
  const bundle = buildArrangement(g, ctx);
  const { comfortCapMinutes, thinBuffer, arrangeReorder, weights: arrangeWeights } = bundle;
  // Rolling horizon: keep committing to the plan the user is following unless the date
  // rolled, the fingerprint moved, or the candidate's gain clears the hysteresis. This
  // read persists nothing. When sticky the committed order is priced and shipped verbatim
  // with the reorder flag off, so the client's base re-solve stays exact. Move-probes
  // still use the fresh arrangement - a strategy move is a re-plan, never a sticky hold.
  const decision = rollDecision(
    rollContextFor(g, ctx, bundle, committed, localNow, calibrateHysteresis(rolls)),
  );
  // S3c-6: on a quiet new day, refresh the committed row's frozen-zone anchor from this read.
  await advanceAnchorOnQuietDay(committed, decision);
  const committedOrder = decision.sticky ? decision.order.map((e) => e.taskId) : null;
  // The joint re-solve context carries the cap + the reorder flag + the thin-buffer set
  // (mirrors how `windowProfile` rides on `g`) plus the sticky committed order; every
  // `jointOddsWithMoves` / `cumulativeJointOdds` below reads them off `jg`.
  const jg = { ...g, comfortCapMinutes, arrangeReorder, arrangeWeights, thinBufferUrgency: thinBuffer, committedOrder };
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
    // The style-vs-cause tiebreak ratio, learned off the offered-vs-kept
    // history. No rows ⇒ the co-equal 1.0/1.0 prior, bit-identically.
    movePrefWeights: calibrateMovePrefWeights(moveChoices),
    baseByProject,
    baseAllOnTime: base.allOnTime,
    score: (moves) => jointOddsWithMoves(jg, ctx, moves, JOINT_PROBE_ITERATIONS),
    cumulative: (ordered) => cumulativeJointOdds(jg, ctx, ordered),
    resolveInput: buildResolveInput(g, ctx, comfortCapMinutes, arrangeReorder, thinBuffer, committedOrder, arrangeWeights),
  };
}

// --- The pit wall: conflict detection + contention-aware triage -------------

const MAX_TRIAGE_PROBES = 12;
const TRIAGE_PROBE_ITERATIONS = 2000;
/** A deferral counts as helping only if it lifts some project's odds by at least this. */
const TRIAGE_MIN_GAIN = 0.01;
/** Two still-failing projects whose values are this close are a genuine tie to escalate. */
const COMPARABLE_VALUE_RATIO = 0.75;

/** What the global allocation can't satisfy. `conflicts` names the projects that miss
 *  their deadlines once they share hours; `triage` is the low-value work to shed
 *  (best-first); `needsDecision` is the one case auto-triage won't touch - two
 *  comparable-value projects colliding, where the user picks. */
export interface PitWall {
  conflicts: Conflict[];
  triage: TriageMove[];
  needsDecision: boolean;
 /** When `needsDecision`, the mutually-exclusive resolutions - one per colliding project,
  * "protect this one, shed the others". Empty otherwise. */
  options: PitWallOption[];
}

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

/** The pit wall for a gather. Triage is contention-aware: each candidate deferral is
 *  scored by re-running the JOINT Monte Carlo with that task (and the already-shed ones)
 *  removed, so recovered odds account for the freed shared hours rather than a solo
 *  per-project estimate. Walks lowest-WSJF first, keeps a deferral only when it
 *  meaningfully lifts something. */
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

    // Open-task count per project, so triage can scope a project down but never shed its
    // last task. Deferring all of a project's work reads as a vacuous 100%, which is
    // abandonment, not recovery - that's the escalated decision below.
  const openCount = new Map<string, number>();
  for (const t of ctx.tasks) openCount.set(t.projectId, (openCount.get(t.projectId) ?? 0) + 1);

  // Shed the lowest-WSJF open work of the over-budget projects. Sheddable skill lanes
  // compete in the same order; the `skill:<nodeId>` id routes to setSkillNodeDeferred on
  // persist, and only eligible ids are offered so the shed always sticks.
  const conflictedIds = new Set(conflicts.map((c) => c.projectId));
  const sheddableSkillIds = new Set<string>();
  for (const nodes of g.skillNodesByProject.values()) {
    for (const n of sheddableSkillNodes(nodes)) {
      sheddableSkillIds.add(SKILL_TASK_PREFIX + n.id);
    }
  }
  const candidates = triageCandidates(
    ctx.tasks,
    conflictedIds,
    g.deadlineByProject,
    g.today,
    sheddableSkillIds,
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
    // The project this deferral helps most - shedding low-value work of one
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

  // Escalate ONLY a real tie: colliding deadlines whose aggregate values are close enough
  // that auto can't pick. A collision with a clear loser isn't a tie - triage already
  // shed the loser's work.
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

/** The mutually-exclusive ways to resolve a real tie: "protect this one" defers the
 *  other colliding projects' entire open work. That's the abandonment auto-triage
 *  refuses to do on its own - here the user makes the call, so each option's
 *  probabilityAfter is the protected project's recovered odds (one MC probe each). */
function escalationOptions(
  g: ForecastGather,
  ctx: AllocContext,
  conflicts: Conflict[],
): PitWallOption[] {
  const colliding = conflicts.filter((c) => c.kind === "deadline_collision");
  const collidingIds = new Set(colliding.map((c) => c.projectId));
  // Open (still-forecast) task ids per colliding project - the deferrable batch.
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

/** Forecast every deadlined project under a commitment set. Per-project numbers come
 *  from each project's own footprint, but the headline probability is the joint
 *  contention-aware odds the caller computes once and shares. */
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
    // A learning goal carries no tasks - its remaining work is the unattained
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

/** projectId → urgency (0,1] for each deadlined project whose critical-chain buffer is
 *  thin - on track but not comfortable - graded by how thin. The within-day reorder
 *  biases their work into the day's fast windows in proportion, so the thinnest deadline
 *  gets the strongest claim on the hours it's most likely to finish in. Decided once on
 *  the base, then replayed for every move subset and shipped to the client, which lacks
 *  the per-project distribution the buffer math needs. Non-thin projects are omitted. */
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

/** Forecasts + recovery plans for the Today dashboard, off a single gather. */
export async function forecastDashboard(): Promise<{
  forecasts: ProjectForecast[];
  recoveries: RecoveryPlan[];
  pitWall: PitWall;
  /** The single global allocation the Today views derive from (order + unified schedule). */
  globalPlan: GlobalPlan;
  /** The agenda's ranking: the FOLLOWED order (arranged, roll-sticky) the plan card also
   *  shows, plus today's due recurring instances floated up via an ordering-only `today`
   *  deadline. Recurring rides this for display only - its time is already drained into
   *  capacity, so it never enters the forecast. */
  agendaOrder: GlobalPlan["order"];
  model: EstimationModel;
  /** How the calibration seam has tuned the plan's soft knobs to the user - the
   *  read-only "how your plan is tuned to you" surface. Defaults everywhere until evidence. */
  tuning: PlanTuning;
}> {
  const [g, activities, completions, cachedStrategy, committed, localNow, rolls, moveChoices] =
    await Promise.all([
      gatherForecast(),
      listRecurringActivities(),
      listActivityCompletions(),
      getCachedStrategy(),
      getCommittedPlan(),
      readClientLocalNow(),
      listPlanRolls(),
      listMoveChoices(),
    ]);
  const ctx = allocContext(g, g.commitments);
  // The arrangement pipeline over all open work, no triage shedding: canonical order,
  // comfort cap, thin-buffer urgency, odds-gated reorder. Recurring is NOT in here so the
  // schedule never double-counts its already-drained hours.
  const bundle = buildArrangement(g, ctx);
  // Rolling horizon (see commitRollingPlan). This read decides what to show and persists
  // nothing. A stale anchor on a quiet new day is harmless - packGlobal re-buckets from
  // g.today regardless. decision.order IS the display order either way.
  const hysteresis = calibrateHysteresis(rolls);
  const decision = rollDecision(
    rollContextFor(g, ctx, bundle, committed, localNow, hysteresis),
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
    // The displayed plan packs the FOLLOWED order, comfort-capped when smoothing fired, so
    // the shown days match its priced odds. globalPlan.order stays the canonical order for
    // display metadata and stable ranks.
  const globalPlan: GlobalPlan = {
    order: bundle.canonical.order,
    days: packGlobal(decision.order, ctx.budget, g.today, bundle.comfortCapMinutes),
  };
  // The agenda order: the followed plan exactly as TodayPlan shows it, plus today's due
  // recurring instances ranked as if due today. The union plan below exists only to place
  // the routines - spliceRecurringIntoOrder reproduces decision.order's real-task sequence
  // verbatim, so agenda and plan card can't disagree, and the agenda inherits stickiness
  // for free. Routine minutes stay out of ctx.tasks; they're already drained into capacity.
  const recurringTasks = recurringAllocTasksForToday(activities, completions, g.today);
  const orderingDeadlines = new Map(g.deadlineByProject);
  orderingDeadlines.set(RECURRING_LANE_ID, g.today);
  const unionOrder = buildGlobalPlan({
    tasks: [...ctx.tasks, ...recurringTasks],
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    orderingDeadlineByProject: orderingDeadlines,
    budget: ctx.budget,
    today: g.today,
  }).order;
  const agendaOrder = spliceRecurringIntoOrder(decision.order, unionOrder);
  // The "how your plan is tuned to you" read: the same calibrated knobs the plan was just
  // built under, plus the sample counts behind them. Computed server-side and shipped
  // whole; the surface renders and computes nothing. The move-pref tier joins them here
  // because it's the third knob the same seam learns.
  const materialRolls = rolls.filter((r) => r.kind === "material");
  const movePrefs = calibrateMovePrefWeights(moveChoices);
  const tuning: PlanTuning = {
    arrange: {
      weights: bundle.weights,
      prior: ARRANGE_WEIGHTS,
      samples: g.planReorders.length,
      windowLearned: g.windowProfile !== null,
    },
    stability: {
      stabilityMargin: hysteresis.stabilityMargin,
      churnCost: hysteresis.churnCost,
      priorMargin: STABILITY_MARGIN,
      priorCost: CHURN_COST,
      materialRolls: materialRolls.length,
      reverts: materialRolls.filter((r) => r.revertedAt != null).length,
    },
    movePrefs: {
      style: movePrefs.style,
      cause: movePrefs.cause,
      priorStyle: STYLE_PREF_WEIGHT,
      priorCause: CAUSE_PREF_WEIGHT,
      samples: movePrefs.samples,
      // `balanced` zeroes every style preference ⇒ φ[0] ≡ 0 ⇒ the style weight is pinned to
      // its prior no matter how many bundles are recorded. Report that, don't render a dial.
      styleLearnable: g.valueModel.recoveryStyle !== "balanced",
    },
  };
  return { forecasts, recoveries, pitWall, globalPlan, agendaOrder, model: g.model, tuning };
}

/** Do the Value Model's area weights change the plan at all right now? They scale
 * cost-of-delay, so they only re-rank under contention or shared deadlines - with slack
 * the order is pure earliest-deadline-first and the weights are inert. Compares the
 * canonical order against a neutral (importance = 1) build so the settings page can say
 * so honestly. Two deterministic plan builds, no Monte Carlo. */
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

/** Log a commitment and return any pit calls it triggers: projects whose odds dropped,
 * each with the moves that would recover them. */
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
  if (isDbConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    mustOk(
      await supabase.from("commitments").insert({ ...row, user_id }),
      "commitment insert",
    );
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

/** Probability a recovery plan aims to restore the project to - the same line the meter
 * calls "on track", so the callout and the meter never disagree. */
const RECOVERY_TARGET = ON_TRACK_PROBABILITY;
const IMMINENT_DAYS = 3;

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

/** Whether a project is off-track and why, from signals already in the forecast. Pure. */
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
  // A learning goal has no task rows - its open work shows up as the forecast's
  // open count (unattained skills). Either source means there's work in jeopardy.
  const hasOpen = open.length > 0 || fc.openTaskCount > 0;

  // Timing signals - these mean the deadline itself is in jeopardy (critical).
  if (deadline) {
    const dl = deadline.slice(0, 10);
    if (dl < today && hasOpen) {
      reasons.push({
        kind: "deadline_past",
        severity: "critical",
        detail: `Deadline passed ${-daysBetween(today, deadline)} day(s) ago`,
      });
    } else if (dl >= today && hasOpen && !isOnTrack(fc.probability)) {
      // The headline probability is itself the signal - near deadline or far.
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

  // Critical-chain buffer warning: past the on-track line but not the comfortable one, so
  // the p90-p50 margin is mostly committed and one overrun could flip it. Advisory only.
  // isBufferLow is inherently on-track, so this never double-lists with at_risk above.
  if (isBufferLow(fc)) {
    reasons.push({
      kind: "buffer_low",
      severity: "warning",
      detail: "On track, but the safety margin is thin — a single overrun could flip this.",
    });
  }

  // Attention signals - worth surfacing, but not on their own a missed deadline.
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

  // Provisional completion: work done, or DoD criteria met, below `verified` confidence.
  // Advisory - a done task frees its budget either way. Just nudges the user to confirm
  // before treating the goal as finished. No recorded confidence (legacy) isn't flagged.
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
  // once it competes with others for the shared hours. Critical - the deadline
  // itself is in jeopardy, for a reason no per-project view can see.
  for (const c of conflicts) {
    reasons.push({ kind: "contention", severity: "critical", detail: c.detail });
  }

  return reasons;
}

/** Recovery plan for one project from an already-gathered state. Null when on-track or
 * undeadlined. Pure given the gather, so it can run for many projects off one. */
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
  // task rows) - there's no "defer a skill" move yet.
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
  // The goal's definition of done - real now (was [] before gate slice 3), so
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

  // Learning goals: which non-checkpoint skill nodes, if parked out of the current
  // push, recover odds. Empty for project goals (no skill nodes) and when nothing
  // sheds usefully; measured against the same real-work + skill-effort pool.
  const deferSkill = offTrack
    ? skillRecoveryMoves(
        g.skillNodesByProject.get(projectId) ?? [],
        candidates.map((t) => t.estimated_minutes),
        deployable,
        opts,
      )
    : [];

  // Learning goals: which frontier milestone chains, if re-phased out of the current
  // push, recover odds. The middle lever between deferSkill (one optional leaf) and
  // re-dating the whole goal - parks a checkpoint plus the prep that serves only it.
  const rescheduleSkill = offTrack
    ? skillPathRescheduleMoves(
        g.skillNodesByProject.get(projectId) ?? [],
        candidates.map((t) => t.estimated_minutes),
        deployable,
        opts,
      )
    : [];

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

    // Diagnose the cause behind a real divergence (off-track only - a warning has no cause).
    // Without a cached-strategy baseline, constraint_change can't fire and the cause falls
    // through to the residual classes.
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

    // Cost to the goal beyond the deadline: the unmet definition
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
    deferSkill,
    rescheduleSkill,
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
  openTasks: Task[];
  completedTasks: Task[];
  /** The goal's definition-of-done - for the gate's degraded-DoD + goal-cost checks. */
  criteria: GoalCriterion[];
  /** Deployable minutes from today through the deadline. */
  deployable: number;
  /** Why the project was flagged off-track. */
  reasons: DivergenceReason[];
  currentProbability: number;
  /** The user's learned estimation bias - the same one the forecast uses. */
  model: EstimationModel;
  /** Life-area to file new tasks under (from existing tasks; "Work" by default). */
  area: string;
  /** The temporal/odds anchor from the last cached strategy (null when none). */
  baseline: CauseBaseline | null;
  /** The diagnosed cause behind the divergence (null when not genuinely off-track). */
  cause: CauseDiagnosis | null;
}

/** Everything the LLM strategist needs to propose corrective tasks for one project, off
 * the same gather the deterministic plan uses. Null unless the project is deadlined and
 * flagged off-track, so the strategist never runs on a healthy project. */
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

  // Baseline is the last cached strategy. During portfolio generation that's the still
  // current `prev`, so cause diagnosis compares now against the world the standing plan
  // was built for.
  const cached = await getCachedStrategy();
  const baseline: CauseBaseline | null = cached
    ? {
        generatedAt: cached.generatedAt,
        probability: cached.odds[projectId] ?? null,
      }
    : null;

  // Diagnose the cause only for a genuine divergence - a warning-only flag (a
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

/** Preview: the probability the project would have with these suggested tasks added. The
 * forecast scores it, never the LLM. Pure, so the strategist can call it without I/O. */
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

/** Persist accepted corrective tasks under a synthetic recovery entry owned by the
 * project. Tasks inherit the project through the entry, like extracted tasks. */
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

/** Preview: the probability with these modifications applied - each reshaped task's
 * original estimate removed, its replacements' added. Scored by the forecast, not the LLM. */
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

/** Apply accepted modifications. "scope_down" rewrites the task in place (lighter title,
 * smaller estimate), reversible by editing it. "split" defers the original monolith so it
 * leaves the forecast reversibly, and persists the smaller steps under a recovery entry. */
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
      // Materialize the trimmed work as a debt task. scope_down is the one reshape that
      // genuinely erases work - the estimate shrinks in place with no other record - so
      // this makes the cost owed rather than erased. Deferred (stays out of this
      // deadline's forecast, so the cut's gain holds) and due past the deadline.
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

/** Preview: the probability if the whole open plan were replaced by these alternatives.
 * Scored by the forecast, never the LLM. */
export function previewProbabilityWithReroute(
  ctx: RecoveryContext,
  tasks: { estimated_minutes: number }[],
): number {
  const estimates = tasks.map((t) => t.estimated_minutes);
  return forecast(estimates, ctx.deployable, forecastOptions(ctx.model)).probability;
}

/** Apply an accepted re-route: defer every open task out of the forecast (reversibly,
 * like a split's monolith) and persist the alternative tasks under a recovery entry. */
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

  // A lighter route that lowers the definition of done records how on each compromised
  // criterion - original text intact, note carries the compromise - so switching approach
  // can't quietly redefine the goal down.
  for (const d of degradedCriteria) {
    await setGoalCriterionDegraded(d.criterionId, d.note);
  }
  return inserts;
}

// --- Recovery-entry persistence (shared by Generate + Modify) ---------------

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
  /** Provenance - `"debt"` for a materialized scope-cut follow-up. */
  origin?: TaskOrigin | null;
};

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

const DEBT_DUE_BUFFER_DAYS = 7;

function effortFromMinutes(min: number): number {
  if (min > 240) return 5;
  if (min > 120) return 4;
  if (min > 60) return 3;
  if (min > 30) return 2;
  return 1;
}

function dueAfterDeadline(deadline: string | null): string | null {
  if (!deadline) return null;
  const ms =
    Date.parse(`${deadline.slice(0, 10)}T00:00:00Z`) +
    DEBT_DUE_BUFFER_DAYS * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** The deferred follow-up capturing work a scope cut trimmed. Parked so it stays out of
 * the current deadline's forecast, but persisted as a real owed task: due past the
 * deadline, area inherited, origin "debt". */
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

/** Persist task rows under a synthetic recovery entry owned by the project - the same
 * vehicle Generate uses. No-op when there are no rows. */
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
    row.goal_id = project.id; // the spine edge - these tasks belong to the goal
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
  if (isDbConfigured()) {
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
