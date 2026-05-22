// Shared domain types for TaskBuddy.

export type Confidence = "High" | "Medium" | "Low";

/** Result of a login/signup Server Action, surfaced via `useActionState`. */
export interface AuthState {
  error: string | null;
  /** Non-error message, e.g. "check your email to confirm". */
  notice?: string | null;
}

export type TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "blocked"
  | "review"
  | "done";

export const TASK_STATUSES: TaskStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "blocked",
  "review",
  "done",
];

export const STATUS_LABELS: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  review: "Review",
  done: "Done",
};

export type PriorityLabel = "Critical" | "High" | "Medium" | "Low" | "Backlog";

/** Default life-areas always shown as Today-page tabs. */
export const SEED_AREAS = ["Work", "Personal", "Hobby"];

/** How an entry was created: a meeting transcript or a personal goal/note. */
export type EntryKind = "meeting" | "plan";

/** Lifecycle of an entry: a draft awaiting review, or live. */
export type EntryStatus = "draft" | "active";

/**
 * The filing choices a user confirms in the review step before a draft goes
 * live. On the entry form any of these may be left on "Auto"; the review step
 * is where they are explicitly confirmed (or corrected).
 */
export interface DraftClassification {
  /** Life-area applied to every task in the entry. */
  area: string;
  /** Existing project to attach the entry to, or null for none. */
  projectId: string | null;
  /** Name of a brand-new project to create; empty string when not creating one. */
  newProjectName: string;
  /** Earlier entry this one follows up on, or null. */
  parentEntryId: string | null;
}

// --- Database row shapes ----------------------------------------------------

export interface Project {
  id: string;
  /** Owner of the project. Undefined in offline demo mode. */
  user_id?: string | null;
  name: string;
  description: string | null;
  /** The "finish line" the completion forecast is computed against. */
  deadline: string | null;
  created_at: string;
}

export interface Entry {
  id: string;
  /** Owner of the entry. Undefined in offline demo mode. */
  user_id?: string | null;
  title: string;
  raw_input: string;
  summary: string | null;
  discussion_points: string[];
  stakeholders: string[];
  daily_objective: string | null;
  key_deliverables: string[];
  assumptions: string[];
  risks: string[];
  kind: EntryKind;
  status: EntryStatus;
  project_id: string | null;
  parent_entry_id: string | null;
  created_at: string;
}

export interface Decision {
  id: string;
  entry_id: string;
  decision: string;
  source_quote: string | null;
  confidence: string | null;
  created_at: string;
}

export interface OpenQuestion {
  id: string;
  entry_id: string;
  question: string;
  related_stakeholder: string | null;
  source_quote: string | null;
  confidence: string | null;
  status: string;
  created_at: string;
}

export interface Task {
  id: string;
  entry_id: string;
  title: string;
  description: string | null;
  owner: string | null;
  category: string | null;
  area: string;
  status: TaskStatus;
  due_date: string | null;
  estimated_minutes: number;
  actual_minutes: number;
  urgency_score: number | null;
  impact_score: number | null;
  effort_score: number | null;
  dependency_score: number | null;
  risk_score: number | null;
  confidence_score: number | null;
  priority_score: number | null;
  priority_label: PriorityLabel | null;
  priority_reason: string | null;
  source_quote: string | null;
  is_ai_suggested: boolean;
  blocked_by: string | null;
  sort_index: number;
  created_at: string;
}

export interface TaskDependency {
  id: string;
  entry_id: string;
  task_id: string;
  depends_on_task_id: string;
  reason: string | null;
}

export interface ScheduleBlock {
  id: string;
  entry_id: string;
  task_id: string | null;
  label: string;
  start_time: string;
  end_time: string;
  reason: string | null;
  sort_index: number;
}

// --- Composed views ---------------------------------------------------------

export interface EntryDetail extends Entry {
  decisions: Decision[];
  open_questions: OpenQuestion[];
  tasks: Task[];
  dependencies: TaskDependency[];
  schedule: ScheduleBlock[];
}

// --- Time budget (the deployable-hours model) -------------------------------

/** One weekday's baseline deployable hours (0=Sun .. 6=Sat). */
export interface Availability {
  id?: string;
  user_id?: string | null;
  weekday: number;
  hours: number;
}

/** A specific date's override of the weekly template. */
export interface AvailabilityOverride {
  id?: string;
  user_id?: string | null;
  date: string; // ISO date
  hours: number;
}

/** A logged event that consumes hours on a date ("friends 6-9pm"). */
export interface Commitment {
  id: string;
  user_id?: string | null;
  date: string; // ISO date
  hours: number;
  label: string | null;
  created_at: string;
}

// --- Forecast (the completion-probability engine) ---------------------------

/** The headline output of the forecast for a single project. */
export interface ForecastResult {
  /** P(finish all open work before the deadline), 0–1. */
  probability: number;
  /** Point-estimate remaining work, minutes. */
  expectedMinutes: number;
  /** Deployable minutes between now and the deadline. */
  deployableMinutes: number;
  /** deployable − expected; negative means over budget. */
  slackMinutes: number;
  openTaskCount: number;
}

/** A recommended plan change and the probability it would restore. */
export interface RecoveryMove {
  taskId: string;
  title: string;
  /** Probability if this task were deferred past the deadline. */
  probabilityAfter: number;
}

/** A forecast attached to its project — what the UI renders. */
export interface ProjectForecast extends ForecastResult {
  projectId: string;
  projectName: string;
  deadline: string | null;
}

/**
 * An advisory "pit call": a project whose probability dropped after new data,
 * with the moves that would recover it.
 */
export interface PitCall {
  projectId: string;
  projectName: string;
  probabilityBefore: number;
  probabilityAfter: number;
  moves: RecoveryMove[];
}

// --- LLM extraction shape (what the model is asked to return) ---------------

/** The five 1-5 factor ratings the LLM assigns per task. */
export interface FactorScores {
  urgency: number;
  impact: number;
  dependency: number;
  risk: number;
  effort: number;
  confidence: number;
}

export interface ExtractedTask extends FactorScores {
  /** Stable slug the LLM uses so dependencies can reference this task. */
  key: string;
  title: string;
  description: string;
  owner: string | null;
  category: string | null;
  due_date: string | null; // ISO date or null
  estimated_minutes: number;
  source_quote: string | null;
  is_ai_suggested: boolean;
  blocked_by: string | null;
  /** keys of tasks this one depends on. */
  depends_on: string[];
  priority_reason: string;
}

export interface ExtractionResult {
  title: string;
  summary: string;
  /** Best-fitting life-area for the whole entry (Work/Personal/Hobby/custom). */
  suggested_area: string | null;
  /** Concise project name that groups this entry's tasks, or null if none fits. */
  suggested_project: string | null;
  discussion_points: string[];
  stakeholders: string[];
  daily_objective: string;
  key_deliverables: string[];
  assumptions: string[];
  risks: string[];
  decisions: {
    decision: string;
    source_quote: string | null;
    confidence: Confidence;
  }[];
  open_questions: {
    question: string;
    related_stakeholder: string | null;
    source_quote: string | null;
    confidence: Confidence;
  }[];
  tasks: ExtractedTask[];
}
