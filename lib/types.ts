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
  /** Pushed past the current deadline by a recovery move; excluded from the forecast. */
  deferred: boolean;
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

// --- Composed views ---------------------------------------------------------

export interface EntryDetail extends Entry {
  decisions: Decision[];
  open_questions: OpenQuestion[];
  tasks: Task[];
  dependencies: TaskDependency[];
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

/**
 * The completion probability at or above which a project counts as "on track".
 * A single shared definition so the forecast meter, the on-track pill, and the
 * divergence detector all draw the line in the same place (the recovery plan
 * also aims to restore a project to this number).
 */
export const ON_TRACK_PROBABILITY = 0.8;

/**
 * Whether a probability counts as on track — compared on the same rounded
 * percentage the user actually sees, so a value that displays as "80%" reads as
 * on track everywhere, with no off-by-a-rounding-step contradiction at the edge.
 */
export function isOnTrack(probability: number): boolean {
  return Math.round(probability * 100) >= Math.round(ON_TRACK_PROBABILITY * 100);
}

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

/**
 * The user's learned estimation bias, fit from completed tasks. Models the true
 * duration of a task as `estimate × factor`, where `log(factor)` is normal with
 * mean `meanLog` and std dev `sigma`. `meanLog > 0` means you systematically run
 * over your estimates; `< 0` means you finish under.
 */
export interface EstimationModel {
  /** Mean of `log(actual / estimated)` over completed tasks — the systematic bias. */
  meanLog: number;
  /** Std dev of `log(actual / estimated)` — how spread out your estimation error is. */
  sigma: number;
  /** Completed tasks (with both estimated + actual time) the model was fit on. */
  sampleSize: number;
}

/** Below this many samples we don't trust a fitted model — fall back to defaults. */
export const MIN_ESTIMATION_SAMPLES = 5;

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
  /** Earliest deadline that would restore the target probability, if any. */
  reschedule: RescheduleMove | null;
}

/** Why a project was flagged off-track — one human-readable divergence signal. */
export interface DivergenceReason {
  kind:
    | "over_budget" // negative slack: the open work doesn't fit the time budget
    | "deadline_past" // the deadline is already behind us
    | "at_risk" // open work is below the target probability of finishing on time
    | "overdue_tasks" // open tasks whose due_date has passed
    | "blocked_tasks"; // open tasks stuck in `blocked`
  /** "critical" = the deadline itself is in jeopardy; "warning" = needs attention but on time. */
  severity: "critical" | "warning";
  detail: string;
}

/** A move that re-dates the project to the earliest deadline that clears the target. */
export interface RescheduleMove {
  /** ISO date of the earliest achievable deadline. */
  deadline: string;
  /** Probability the project would have at that deadline. */
  probabilityAfter: number;
}

/**
 * A proactive recovery plan: the deterministic moves that would put an
 * off-track project back on track. Surfaced for the user to approve — never
 * auto-applied.
 */
export interface RecoveryPlan {
  projectId: string;
  projectName: string;
  /** Current completion probability (before any move). */
  currentProbability: number;
  /** Why we flagged the project. */
  reasons: DivergenceReason[];
  /** Defer these (lowest-priority-first) to recover; best improvement first. */
  defer: RecoveryMove[];
  /** Earliest deadline clearing the target probability, or null if out of reach. */
  reschedule: RescheduleMove | null;
  /** Dependency-aware order to tackle the remaining open work (advisory). */
  sequence: { taskId: string; title: string }[];
  /** Open tasks past their due date — surfaced to reschedule or complete inline. */
  overdue: { taskId: string; title: string; dueDate: string | null }[];
  /** Open tasks stuck in `blocked` — surfaced to unblock inline. */
  blocked: { taskId: string; title: string; blockedBy: string | null }[];
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
