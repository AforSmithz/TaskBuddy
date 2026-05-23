import "server-only";
import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  Decision,
  DivergenceReason,
  DraftClassification,
  EntryKind,
  EntryStatus,
  Entry,
  EntryDetail,
  EstimationModel,
  ForecastResult,
  OpenQuestion,
  PitCall,
  Project,
  ProjectForecast,
  RecoveryPlan,
  RescheduleMove,
  Task,
  TaskDependency,
  TaskStatus,
} from "./types";
import { ON_TRACK_PROBABILITY, isOnTrack } from "./types";
import { extractEntry } from "./extraction";
import { estimationModel } from "./generate";
import { computePriority } from "./priority";
import {
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
  recoveryMoves,
  type CandidateTask,
} from "./forecast";
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
      "status" | "actual_minutes" | "blocked_by" | "area" | "deferred" | "due_date"
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
  return {
    projects: projects.filter((p) => p.deadline),
    tasksByProject,
    allTasksByProject,
    deps,
    projectOfEntry,
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

/** Run the forecast for every deadlined project under a given commitment set. */
function buildForecasts(
  g: ForecastGather,
  commitments: Pick<Commitment, "date" | "hours">[],
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
  model: EstimationModel;
}> {
  const g = await gatherForecast();
  const forecasts = buildForecasts(g, g.commitments);
  const recoveries = g.projects
    .map((p) => buildRecoveryPlan(g, p))
    .filter((plan): plan is RecoveryPlan => plan !== null);
  return { forecasts, recoveries, model: g.model };
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
  const projectForecast =
    buildForecasts({ ...g, projects: [project] }, g.commitments)[0] ?? null;
  return {
    forecast: projectForecast,
    recovery: buildRecoveryPlan(g, project),
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
  const before = buildForecasts(g, g.commitments);
  const after = buildForecasts(g, [
    ...g.commitments,
    { date, hours: Math.max(0, hours) },
  ]);

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

  // The commitment set the forecast now reflects (used for re-date suggestions).
  const newCommitments = [...g.commitments, { date, hours: Math.max(0, hours) }];

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
            commitments: newCommitments,
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

  return reasons;
}

/**
 * Assemble a recovery plan for one project from an already-gathered forecast
 * state. Returns null when on-track or the project has no deadline. Pure given
 * the gather — no I/O — so it can run for many projects off a single gather.
 */
function buildRecoveryPlan(g: ForecastGather, project: Project): RecoveryPlan | null {
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
  const fc = forecast(estimates, deployable, opts);

  const allTasks = g.allTasksByProject.get(projectId) ?? [];
  const reasons = detectDivergence(fc, project.deadline, allTasks, g.today);
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
