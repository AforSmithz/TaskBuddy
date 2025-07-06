import "server-only";
import type {
  Decision,
  DraftClassification,
  EntryKind,
  EntryStatus,
  Meeting,
  MeetingDetail,
  OpenQuestion,
  Project,
  ScheduleBlock,
  Task,
  TaskDependency,
  TaskStatus,
} from "./types";
import { extractEntry } from "./extraction";
import { computePriority } from "./priority";
import { generateSchedule } from "./schedule";
import { SAMPLE_MEETINGS, SAMPLE_PROJECTS } from "./sample-data";

// Central data layer.
// Uses Supabase when configured; otherwise an in-memory store seeded with
// sample data so the app is fully demoable without any backend setup.

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
}

// --- In-memory store (survives HMR via globalThis) --------------------------

interface MemDB {
  projects: Project[];
  meetings: Meeting[];
  decisions: Decision[];
  questions: OpenQuestion[];
  tasks: Task[];
  deps: TaskDependency[];
  schedule: ScheduleBlock[];
  seeded: boolean;
}

const g = globalThis as typeof globalThis & { __taskbuddyDB?: MemDB };

function memDB(): MemDB {
  if (!g.__taskbuddyDB) {
    g.__taskbuddyDB = {
      projects: [],
      meetings: [],
      decisions: [],
      questions: [],
      tasks: [],
      deps: [],
      schedule: [],
      seeded: false,
    };
  }
  return g.__taskbuddyDB;
}

// --- Assembly: raw notes -> fully scored & scheduled meeting ----------------

interface AssembledMeeting {
  meeting: Meeting;
  decisions: Decision[];
  questions: OpenQuestion[];
  tasks: Task[];
  deps: TaskDependency[];
  schedule: ScheduleBlock[];
}

export interface AssembleOptions {
  kind?: EntryKind;
  /** Life-area applied to every extracted task (Today-page tabs). */
  area?: string;
  projectId?: string | null;
  parentMeetingId?: string | null;
  status?: EntryStatus;
  createdAt?: string;
}

/** Build the recommended schedule for a set of tasks + dependency edges. */
function buildSchedule(
  meetingId: string,
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
    meeting_id: meetingId,
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
export async function assembleMeeting(
  rawInput: string,
  opts: AssembleOptions = {},
): Promise<AssembledMeeting> {
  const kind = opts.kind ?? "meeting";
  const area = opts.area ?? "Work";
  const createdAt = opts.createdAt ?? new Date().toISOString();
  const { result } = await extractEntry(rawInput, kind);
  const meetingId = crypto.randomUUID();

  const meeting: Meeting = {
    id: meetingId,
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
    project_id: opts.projectId ?? null,
    parent_meeting_id: opts.parentMeetingId ?? null,
    created_at: createdAt,
  };

  const decisions: Decision[] = result.decisions.map((d) => ({
    id: crypto.randomUUID(),
    meeting_id: meetingId,
    decision: d.decision,
    source_quote: d.source_quote,
    confidence: d.confidence,
    created_at: createdAt,
  }));

  const questions: OpenQuestion[] = result.open_questions.map((q) => ({
    id: crypto.randomUUID(),
    meeting_id: meetingId,
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
      meeting_id: meetingId,
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
          meeting_id: meetingId,
          task_id: taskId,
          depends_on_task_id: dependsOnId,
          reason: null,
        });
      }
    }
  }

  const schedule = buildSchedule(meetingId, tasks, deps);

  return { meeting, decisions, questions, tasks, deps, schedule };
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
    created_at: new Date().toISOString(),
  };
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
    const { error } = await supabase.from("projects").insert(project);
    if (error) throw new Error(`Supabase project insert failed: ${error.message}`);
  } else {
    await ensureSeeded();
    memDB().projects.unshift(project);
  }
  return project.id;
}

export async function listProjects(): Promise<Project[]> {
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
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
    const { supabase } = await import("./supabase");
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
  const assembled = await assembleMeeting(rawInput, {
    ...opts,
    status: "draft",
  });
  if (isSupabaseConfigured()) {
    await persistSupabase(assembled);
  } else {
    await ensureSeeded();
    const db = memDB();
    db.meetings.unshift(assembled.meeting);
    db.decisions.push(...assembled.decisions);
    db.questions.push(...assembled.questions);
    db.tasks.push(...assembled.tasks);
    db.deps.push(...assembled.deps);
    db.schedule.push(...assembled.schedule);
  }
  return assembled.meeting.id;
}

/**
 * Finalise a draft: drop the declined tasks, apply the filing the user
 * confirmed in the review step (category, project, follow-up), rebuild the
 * schedule from the survivors, and flip the entry to active.
 */
export async function confirmDraft(
  meetingId: string,
  declinedTaskIds: string[],
  classification: DraftClassification,
): Promise<void> {
  const declined = new Set(declinedTaskIds);

  // Resolve the confirmed filing. A new project is created on demand; a
  // follow-up link to the entry itself is rejected defensively.
  const projectId = classification.newProjectName
    ? await createProject(classification.newProjectName)
    : classification.projectId;
  const parentMeetingId =
    classification.parentMeetingId &&
    classification.parentMeetingId !== meetingId
      ? classification.parentMeetingId
      : null;
  const area = classification.area.trim() || "Work";

  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
    if (declined.size) {
      // Cascades remove dependency edges and schedule blocks for these tasks.
      await supabase
        .from("tasks")
        .delete()
        .in("id", [...declined]);
    }
    await supabase.from("tasks").update({ area }).eq("meeting_id", meetingId);
    const [{ data: tasks }, { data: deps }] = await Promise.all([
      supabase.from("tasks").select("*").eq("meeting_id", meetingId),
      supabase
        .from("task_dependencies")
        .select("*")
        .eq("meeting_id", meetingId),
    ]);
    const schedule = buildSchedule(
      meetingId,
      (tasks as Task[]) ?? [],
      (deps as TaskDependency[]) ?? [],
    );
    await supabase.from("schedule_blocks").delete().eq("meeting_id", meetingId);
    if (schedule.length)
      await supabase.from("schedule_blocks").insert(schedule);
    await supabase
      .from("meetings")
      .update({
        status: "active",
        project_id: projectId,
        parent_meeting_id: parentMeetingId,
      })
      .eq("id", meetingId);
    return;
  }

  await ensureSeeded();
  const db = memDB();
  const meeting = db.meetings.find((m) => m.id === meetingId);
  if (!meeting) return;
  db.tasks = db.tasks.filter((t) => !declined.has(t.id));
  db.deps = db.deps.filter(
    (d) => !declined.has(d.task_id) && !declined.has(d.depends_on_task_id),
  );
  const survivors = db.tasks.filter((t) => t.meeting_id === meetingId);
  for (const t of survivors) t.area = area;
  const deps = db.deps.filter((d) => d.meeting_id === meetingId);
  db.schedule = db.schedule.filter((s) => s.meeting_id !== meetingId);
  db.schedule.push(...buildSchedule(meetingId, survivors, deps));
  meeting.status = "active";
  meeting.project_id = projectId;
  meeting.parent_meeting_id = parentMeetingId;
}

/** Delete a draft entirely (used when the user discards it during review). */
export async function discardDraft(meetingId: string): Promise<void> {
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
    // Child rows cascade on meeting delete.
    await supabase.from("meetings").delete().eq("id", meetingId);
    return;
  }
  await ensureSeeded();
  const db = memDB();
  db.meetings = db.meetings.filter((m) => m.id !== meetingId);
  db.decisions = db.decisions.filter((d) => d.meeting_id !== meetingId);
  db.questions = db.questions.filter((q) => q.meeting_id !== meetingId);
  db.tasks = db.tasks.filter((t) => t.meeting_id !== meetingId);
  db.deps = db.deps.filter((d) => d.meeting_id !== meetingId);
  db.schedule = db.schedule.filter((s) => s.meeting_id !== meetingId);
}

export async function listMeetings(): Promise<Meeting[]> {
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
    const { data } = await supabase
      .from("meetings")
      .select("*")
      .eq("status", "active")
      .order("created_at", { ascending: false });
    return (data as Meeting[]) ?? [];
  }
  await ensureSeeded();
  return [...memDB().meetings]
    .filter((m) => m.status === "active")
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function getMeeting(id: string): Promise<MeetingDetail | null> {
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
    const { data: meeting } = await supabase
      .from("meetings")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!meeting) return null;
    const [decisions, questions, tasks, deps, schedule] = await Promise.all([
      supabase.from("decisions").select("*").eq("meeting_id", id),
      supabase.from("open_questions").select("*").eq("meeting_id", id),
      supabase
        .from("tasks")
        .select("*")
        .eq("meeting_id", id)
        .order("sort_index"),
      supabase.from("task_dependencies").select("*").eq("meeting_id", id),
      supabase
        .from("schedule_blocks")
        .select("*")
        .eq("meeting_id", id)
        .order("sort_index"),
    ]);
    return {
      ...(meeting as Meeting),
      decisions: (decisions.data as Decision[]) ?? [],
      open_questions: (questions.data as OpenQuestion[]) ?? [],
      tasks: (tasks.data as Task[]) ?? [],
      dependencies: (deps.data as TaskDependency[]) ?? [],
      schedule: (schedule.data as ScheduleBlock[]) ?? [],
    };
  }

  await ensureSeeded();
  const db = memDB();
  const meeting = db.meetings.find((m) => m.id === id);
  if (!meeting) return null;
  return {
    ...meeting,
    decisions: db.decisions.filter((d) => d.meeting_id === id),
    open_questions: db.questions.filter((q) => q.meeting_id === id),
    tasks: db.tasks
      .filter((t) => t.meeting_id === id)
      .sort((a, b) => a.sort_index - b.sort_index),
    dependencies: db.deps.filter((d) => d.meeting_id === id),
    schedule: db.schedule
      .filter((s) => s.meeting_id === id)
      .sort((a, b) => a.sort_index - b.sort_index),
  };
}

/** All tasks belonging to active (non-draft) entries. */
export async function listAllTasks(): Promise<Task[]> {
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
    const { data: active } = await supabase
      .from("meetings")
      .select("id")
      .eq("status", "active");
    const ids = ((active as { id: string }[]) ?? []).map((m) => m.id);
    if (ids.length === 0) return [];
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .in("meeting_id", ids)
      .order("created_at", { ascending: false });
    return (data as Task[]) ?? [];
  }
  await ensureSeeded();
  const db = memDB();
  const draftIds = new Set(
    db.meetings.filter((m) => m.status === "draft").map((m) => m.id),
  );
  return db.tasks.filter((t) => !draftIds.has(t.meeting_id));
}

export async function updateTask(
  id: string,
  patch: Partial<Pick<Task, "status" | "actual_minutes" | "blocked_by" | "area">>,
): Promise<Task | null> {
  if (isSupabaseConfigured()) {
    const { supabase } = await import("./supabase");
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
      for (const sample of SAMPLE_MEETINGS) {
        const assembled = await assembleMeeting(sample.notes, {
          kind: sample.kind,
          area: sample.area,
          projectId: sample.projectId,
          createdAt: sample.createdAt,
        });
        db.meetings.push(assembled.meeting);
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

async function persistSupabase(a: AssembledMeeting): Promise<void> {
  const { supabase } = await import("./supabase");
  const err = (label: string, e: { message: string } | null) => {
    if (e) throw new Error(`Supabase ${label} insert failed: ${e.message}`);
  };
  err("meeting", (await supabase.from("meetings").insert(a.meeting)).error);
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
