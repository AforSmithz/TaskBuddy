import "server-only";
import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  Conflict,
  PitWallOption,
  Decision,
  DivergenceReason,
  DraftClassification,
  EntryKind,
  EntryStatus,
  Entry,
  EntryDetail,
  EstimationModel,
  FactorScores,
  ForecastResult,
  OpenQuestion,
  PitCall,
  PortfolioStrategy,
  Project,
  ProjectForecast,
  RecoveryPlan,
  ReroutePart,
  RescheduleMove,
  SuggestedTask,
  Task,
  TaskDependency,
  TaskModification,
  TaskStatus,
  TriageMove,
} from "./types";
import { ON_TRACK_PROBABILITY, isOnTrack } from "./types";
import { extractEntry } from "./extraction";
import { estimationModel } from "./generate";
import { computePriority } from "./priority";
import {
  dayCapacities,
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
  recoveryMoves,
  type CandidateTask,
} from "./forecast";
import {
  buildGlobalPlan,
  detectConflicts,
  projectValue,
  triageCandidates,
  type AllocTask,
  type GlobalPlan,
} from "./allocate";
import { SAMPLE_ENTRIES, SAMPLE_PROJECTS } from "./sample-data";
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
  projects: Project[];
  entries: Entry[];
  decisions: Decision[];
  questions: OpenQuestion[];
  tasks: Task[];
  deps: TaskDependency[];
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
  /** Whether the pit-wall strategist auto-applies obvious triage (vs. surfacing it). */
  autoStrategy: boolean;
  /** The cached portfolio strategy (Phase 4), or null until first generated. */
  portfolioStrategy: PortfolioStrategy | null;
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
      entries: [],
      decisions: [],
      questions: [],
      tasks: [],
      deps: [],
      availability: DEFAULT_AVAILABILITY.map((a) => ({ ...a })),
      overrides: [],
      commitments: [],
      autoStrategy: false,
      portfolioStrategy: null,
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
  // Skipped otherwise — notably during seeding, where listProjects() would
  // re-enter ensureSeeded().
  const resolveProject = opts.autoProject && !opts.projectId;
  const projects = resolveProject ? await listProjects() : [];
  const { result } = await extractEntry(rawInput, kind, {
    projectNames: projects.map((p) => p.name),
  });

  // Area: an explicit choice wins; otherwise use the extractor's suggestion.
  const area = opts.area ?? result.suggested_area ?? "Work";

  // Project: an explicit choice wins; otherwise, when auto-filing, attach to
  // the suggested project — reusing an existing one of that name if it exists.
  let projectId = opts.projectId ?? null;
  if (resolveProject && result.suggested_project) {
    const name = result.suggested_project.trim();
    const match = projects.find(
      (p) => p.name.toLowerCase() === name.toLowerCase(),
    );
    projectId = match ? match.id : await createProject(name);
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
    project_id: projectId,
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

export async function createProject(
  name: string,
  description: string | null = null,
): Promise<string> {
  const project: Project = {
    id: crypto.randomUUID(),
    name,
    description,
    deadline: null,
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const user_id = await currentUserId(supabase);
    const { error } = await supabase
      .from("projects")
      .insert({ ...project, user_id });
    if (error) throw new Error(`Supabase project insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().projects.unshift(project);
  }
  return project.id;
}

export async function listProjects(): Promise<Project[]> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("projects")
      .select("*")
      .order("created_at", { ascending: false });
    return (data as Project[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().projects].sort((a, b) =>
    b.created_at.localeCompare(a.created_at),
  );
}

export async function getProject(id: string): Promise<Project | null> {
  if (isSupabaseConfigured()) {
    const supabase = await getRequestClient();
    const { data } = await supabase
      .from("projects")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return (data as Project) ?? null;
  }
  await ensureSeeded();
  return memDB().projects.find((p) => p.id === id) ?? null;
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
    ? await createProject(classification.newProjectName)
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
    await supabase.from("tasks").update({ area }).eq("entry_id", entryId);
    await supabase
      .from("entries")
      .update({
        status: "active",
        project_id: projectId,
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
  for (const t of survivors) t.area = area;
  entry.status = "active";
  entry.project_id = projectId;
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
    await supabase.from("projects").update({ deadline }).eq("id", projectId);
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

/** Effective time-budget inputs for the forecast engine. */
async function getTimeBudget(): Promise<{
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
}> {
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

// --- Forecast ---------------------------------------------------------------

interface ForecastGather {
  projects: Project[];
  /** Open (not done, not deferred) tasks per project — the forecast input. */
  tasksByProject: Map<string, CandidateTask[]>;
  /** All tasks per project (any status) — for divergence detection & sequencing. */
  allTasksByProject: Map<string, Task[]>;
  /** Dependency edges keyed by entry — for the re-sequence recommendation. */
  deps: TaskDependency[];
  /** entry_id → owning project_id, for mapping tasks to projects. */
  projectOfEntry: Map<string, string | null>;
  /** projectId → deadline (or null) for EVERY project — the global allocator spans all. */
  deadlineByProject: Map<string, string | null>;
  /** projectId → name for EVERY project — used to tag global order entries. */
  projectNameById: Map<string, string>;
  /** The user's estimation bias, fit from all completed tasks — calibrates the forecast. */
  model: EstimationModel;
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
  today: string;
}

/** Collect deadlined projects, their open tasks, and the time budget. */
async function gatherForecast(): Promise<ForecastGather> {
  const [projects, entries, tasks, deps, budget] = await Promise.all([
    listProjects(),
    listEntries(),
    listAllTasks(),
    listAllDependencies(),
    getTimeBudget(),
  ]);
  const projectOfEntry = new Map(entries.map((e) => [e.id, e.project_id]));
  const tasksByProject = new Map<string, CandidateTask[]>();
  const allTasksByProject = new Map<string, Task[]>();
  for (const t of tasks) {
    const pid = projectOfEntry.get(t.entry_id);
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
  return {
    projects: projects.filter((p) => p.deadline),
    tasksByProject,
    allTasksByProject,
    deps,
    projectOfEntry,
    deadlineByProject,
    projectNameById,
    // Fit once over every completed task — the bias is the user's, not a project's.
    model: estimationModel(tasks),
    availability: budget.availability,
    overrides: budget.overrides,
    commitments: budget.commitments,
    today: todayISO(),
  };
}

/** Forecast options carrying the learned estimation bias (sigma + meanLog). */
function forecastOptions(model: EstimationModel) {
  return { sigma: model.sigma, meanLog: model.meanLog };
}

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
      });
    }
  }
  return out;
}

/**
 * The shared inputs for one global allocation pass: the alloc tasks, dependency
 * edges, and the per-day capacities under a commitment set. Built once so the
 * odds, the conflict detection, and the triage probes all reason over the same
 * contention picture.
 */
interface AllocContext {
  tasks: AllocTask[];
  deps: DependencyEdge[];
  budget: { availability: Availability[]; overrides: AvailabilityOverride[]; commitments: Pick<Commitment, "date" | "hours">[] };
  capacities: ReturnType<typeof dayCapacities>;
}

function allocContext(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
): AllocContext {
  const budget = { availability: g.availability, overrides: g.overrides, commitments };
  return {
    tasks: buildAllocTasks(g),
    deps: g.deps.map((d) => ({
      task_id: d.task_id,
      depends_on_task_id: d.depends_on_task_id,
    })),
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
  return globalForecast(plan.order, ctx.capacities, g.deadlineByProject, g.today, {
    ...forecastOptions(g.model),
    ...(iterations !== undefined ? { iterations } : {}),
  });
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
    const result = forecast(
      tasks.map((t) => t.estimated_minutes),
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
 * Live forecasts + proactive recovery plans for the Today dashboard. Runs a
 * single gather (both were previously computed off separate gathers).
 */
export async function forecastDashboard(): Promise<{
  forecasts: ProjectForecast[];
  recoveries: RecoveryPlan[];
  pitWall: PitWall;
  /** The single global allocation the Today views derive from (order + unified schedule). */
  globalPlan: GlobalPlan;
  model: EstimationModel;
}> {
  const g = await gatherForecast();
  const ctx = allocContext(g, g.commitments);
  const odds = jointOdds(g, ctx);
  const forecasts = buildForecasts(g, g.commitments, odds);
  const pitWall = buildPitWall(g, ctx, odds);
  const recoveries = g.projects
    .map((p) => buildRecoveryPlan(g, p, odds, pitWall.conflicts))
    .filter((plan): plan is RecoveryPlan => plan !== null);
  // The canonical plan over all current open work (no triage shedding) — the
  // cross-project order the agenda ranks by and the unified schedule it renders.
  const globalPlan = buildGlobalPlan({
    tasks: ctx.tasks,
    deps: ctx.deps,
    deadlineByProject: g.deadlineByProject,
    budget: ctx.budget,
    today: g.today,
  });
  return { forecasts, recoveries, pitWall, globalPlan, model: g.model };
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
  const g = await gatherForecast();
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
    recovery: buildRecoveryPlan(g, project, odds, conflicts),
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
): DivergenceReason[] {
  const reasons: DivergenceReason[] = [];
  const open = tasks.filter((t) => t.status !== "done" && !t.deferred);
  const hasOpen = open.length > 0;

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
  project: Project,
  odds: Map<string, number>,
  conflicts: Conflict[] = [],
): RecoveryPlan | null {
  if (!project.deadline) return null;
  const projectId = project.id;
  const candidates = g.tasksByProject.get(projectId) ?? [];
  const estimates = candidates.map((t) => t.estimated_minutes);
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
  // Fold in any cross-project conflict touching this project (the pit-wall reason).
  const projectConflicts = conflicts.filter((c) => c.projectId === projectId);
  const reasons = detectDivergence(
    fc,
    project.deadline,
    allTasks,
    g.today,
    projectConflicts,
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

  return {
    projectId: project.id,
    projectName: project.name,
    currentProbability: fc.probability,
    reasons,
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
  project: Project;
  /** Open (not done, not deferred) tasks — full rows, for prompt context. */
  openTasks: Task[];
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
  const reasons = detectDivergence(fc, project.deadline, allTasks, g.today);
  if (reasons.length === 0) return null;

  const openTasks = allTasks.filter((t) => t.status !== "done" && !t.deferred);
  return {
    project,
    openTasks,
    deployable,
    reasons,
    currentProbability: fc.probability,
    model: g.model,
    area: openTasks[0]?.area ?? "Work",
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
): Promise<void> {
  if (tasks.length === 0) return;
  const project = await getProject(projectId);
  if (!project) return;

  const createdAt = new Date().toISOString();
  const taskRows = tasks.map((t, i) =>
    buildRecoveryTaskRow(
      { ...t, status: t.blocked_by ? "blocked" : "todo" },
      "",
      i,
      createdAt,
    ),
  );
  await persistRecoveryEntry(
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
): Promise<void> {
  if (mods.length === 0) return;
  const project = await getProject(projectId);
  if (!project) return;

  const createdAt = new Date().toISOString();
  const newRows: Task[] = [];

  for (const mod of mods) {
    if (mod.kind === "scope_down") {
      const part = mod.replacements[0];
      if (!part) continue;
      await updateTask(mod.taskId, {
        title: part.title,
        description: part.description,
        estimated_minutes: part.estimated_minutes,
      });
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

  await persistRecoveryEntry(
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
): Promise<void> {
  if (tasks.length === 0) return;
  const project = await getProject(projectId);
  if (!project) return;

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
  await persistRecoveryEntry(
    project,
    "Plan re-routed to a lighter approach.",
    taskRows,
    createdAt,
  );
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
    deferred: false,
    sort_index: sortIndex,
    created_at: createdAt,
  };
}

/**
 * Persist task rows under a synthetic recovery entry (kind "plan") owned by the
 * project — the same vehicle Generate uses, so reshaped/added tasks inherit the
 * project through the entry with no schema change. No-op when there are no rows.
 */
async function persistRecoveryEntry(
  project: Project,
  summary: string,
  taskRows: Task[],
  createdAt: string,
): Promise<void> {
  if (taskRows.length === 0) return;
  const entryId = crypto.randomUUID();
  for (const row of taskRows) row.entry_id = entryId;

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
    project_id: project.id,
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
}
