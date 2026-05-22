import "server-only";
import type {
  Availability,
  AvailabilityOverride,
  Commitment,
  Decision,
  DraftClassification,
  EntryKind,
  EntryStatus,
  Entry,
  EntryDetail,
  OpenQuestion,
  PitCall,
  Project,
  ProjectForecast,
  ScheduleBlock,
  Task,
  TaskDependency,
  TaskStatus,
} from "./types";
import { extractEntry } from "./extraction";
import { computePriority } from "./priority";
import { generateSchedule } from "./schedule";
import {
  deployableMinutes,
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
  schedule: ScheduleBlock[];
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
      schedule: [],
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
  schedule: ScheduleBlock[];
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

/** Build the recommended schedule for a set of tasks + dependency edges. */
function buildSchedule(
  entryId: string,
  tasks: Task[],
  deps: TaskDependency[],
): ScheduleBlock[] {
  const planned = generateSchedule(
    tasks.map((t) => ({
      id: t.id,
      title: t.title,
      estimated_minutes: t.estimated_minutes,
      priority_score: t.priority_score ?? 0,
      impact_score: t.impact_score,
      status: t.status,
    })),
    deps.map((d) => ({
      task_id: d.task_id,
      depends_on_task_id: d.depends_on_task_id,
    })),
  );
  return planned.map((b) => ({
    id: crypto.randomUUID(),
    entry_id: entryId,
    task_id: b.task_id,
    label: b.label,
    start_time: b.start_time,
    end_time: b.end_time,
    reason: b.reason,
    sort_index: b.sort_index,
  }));
}

/**
 * Runs the full pipeline on raw input:
 * extract -> score priority -> resolve dependencies -> generate schedule.
 * Every row is assigned a UUID up front so it can be persisted directly.
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

  const schedule = buildSchedule(entryId, tasks, deps);

  return { entry, decisions, questions, tasks, deps, schedule };
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
    db.schedule.push(...assembled.schedule);
  }
  return assembled.entry.id;
}

/**
 * Finalise a draft: drop the declined tasks, apply the filing the user
 * confirmed in the review step (category, project, follow-up), rebuild the
 * schedule from the survivors, and flip the entry to active.
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
      // Cascades remove dependency edges and schedule blocks for these tasks.
      await supabase
        .from("tasks")
        .delete()
        .in("id", [...declined]);
    }
    await supabase.from("tasks").update({ area }).eq("entry_id", entryId);
    const [{ data: tasks }, { data: deps }] = await Promise.all([
      supabase.from("tasks").select("*").eq("entry_id", entryId),
      supabase
        .from("task_dependencies")
        .select("*")
        .eq("entry_id", entryId),
    ]);
    const schedule = buildSchedule(
      entryId,
      (tasks as Task[]) ?? [],
      (deps as TaskDependency[]) ?? [],
    );
    await supabase.from("schedule_blocks").delete().eq("entry_id", entryId);
    if (schedule.length)
      await supabase.from("schedule_blocks").insert(schedule);
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
  const deps = db.deps.filter((d) => d.entry_id === entryId);
  db.schedule = db.schedule.filter((s) => s.entry_id !== entryId);
  db.schedule.push(...buildSchedule(entryId, survivors, deps));
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
  db.schedule = db.schedule.filter((s) => s.entry_id !== entryId);
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
    const [decisions, questions, tasks, deps, schedule] = await Promise.all([
      supabase.from("decisions").select("*").eq("entry_id", id),
      supabase.from("open_questions").select("*").eq("entry_id", id),
      supabase
        .from("tasks")
        .select("*")
        .eq("entry_id", id)
        .order("sort_index"),
      supabase.from("task_dependencies").select("*").eq("entry_id", id),
      supabase
        .from("schedule_blocks")
        .select("*")
        .eq("entry_id", id)
        .order("sort_index"),
    ]);
    return {
      ...(entry as Entry),
      decisions: (decisions.data as Decision[]) ?? [],
      open_questions: (questions.data as OpenQuestion[]) ?? [],
      tasks: (tasks.data as Task[]) ?? [],
      dependencies: (deps.data as TaskDependency[]) ?? [],
      schedule: (schedule.data as ScheduleBlock[]) ?? [],
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
    schedule: db.schedule
      .filter((s) => s.entry_id === id)
      .sort((a, b) => a.sort_index - b.sort_index),
  };
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
  patch: Partial<Pick<Task, "status" | "actual_minutes" | "blocked_by" | "area">>,
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
        db.schedule.push(...assembled.schedule);
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
  if (a.schedule.length)
    err(
      "schedule_blocks",
      (await supabase.from("schedule_blocks").insert(a.schedule)).error,
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
  tasksByProject: Map<string, CandidateTask[]>;
  availability: Availability[];
  overrides: AvailabilityOverride[];
  commitments: Commitment[];
  today: string;
}

/** Collect deadlined projects, their open tasks, and the time budget. */
async function gatherForecast(): Promise<ForecastGather> {
  const [projects, entries, tasks, budget] = await Promise.all([
    listProjects(),
    listEntries(),
    listAllTasks(),
    getTimeBudget(),
  ]);
  const projectOfEntry = new Map(entries.map((e) => [e.id, e.project_id]));
  const tasksByProject = new Map<string, CandidateTask[]>();
  for (const t of tasks) {
    if (t.status === "done") continue;
    const pid = projectOfEntry.get(t.entry_id);
    if (!pid) continue;
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
    availability: budget.availability,
    overrides: budget.overrides,
    commitments: budget.commitments,
    today: todayISO(),
  };
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
    );
    return {
      projectId: p.id,
      projectName: p.name,
      deadline: p.deadline,
      ...result,
    };
  });
}

/** Live forecast for every project that has a deadline. */
export async function forecastProjects(): Promise<ProjectForecast[]> {
  const g = await gatherForecast();
  return buildForecasts(g, g.commitments);
}

/** Live forecast for a single project, or null if it has no deadline. */
export async function forecastProject(
  projectId: string,
): Promise<ProjectForecast | null> {
  const g = await gatherForecast();
  const one = g.projects.find((p) => p.id === projectId);
  if (!one) return null;
  return buildForecasts({ ...g, projects: [one] }, g.commitments)[0] ?? null;
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

  // A pit call fires when a project's probability drops meaningfully.
  const pitCalls: PitCall[] = [];
  for (const a of after) {
    const b = before.find((x) => x.projectId === a.projectId);
    if (!b) continue;
    if (a.probability < b.probability - 0.02) {
      const moves = recoveryMoves(
        g.tasksByProject.get(a.projectId) ?? [],
        a.deployableMinutes,
      );
      pitCalls.push({
        projectId: a.projectId,
        projectName: a.projectName,
        probabilityBefore: b.probability,
        probabilityAfter: a.probability,
        moves,
      });
    }
  }
  return pitCalls;
}
