// Shared domain types for TaskBuddy.

// Type-only (erased at runtime → no import cycle): the serialized re-solve inputs
// the review screen ships to the client live beside the consumer in `portfolio-state`.
import type { ResolveInput } from "./portfolio-state";

export type Confidence = "High" | "Medium" | "Low";

/**
 * How sure we are that a completion is real. A task marked done by hand is
 * `self_assessed`; the strategist auto-completing one is `inferred`; an explicit
 * check that it meets the definition-of-done is `verified`. Used to tag both task
 * completion and the meeting of a goal's definition-of-done criteria.
 */
export type CompletionConfidence = "verified" | "self_assessed" | "inferred";

/**
 * Strength ordering (higher = surer). Used to take the *weakest* confidence
 * across a goal's met criteria, and to decide whether a goal is "verified
 * complete" (every met criterion is `verified`).
 */
export const COMPLETION_CONFIDENCE_RANK: Record<CompletionConfidence, number> = {
  verified: 3,
  self_assessed: 2,
  inferred: 1,
};

export const COMPLETION_CONFIDENCE_LABELS: Record<CompletionConfidence, string> = {
  verified: "Verified",
  self_assessed: "Self-assessed",
  inferred: "Inferred",
};

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

/**
 * The flavour of a goal. A `project` carries a task DAG + a deadline (work that
 * ships by a date); a `learning` goal carries a skill graph + checkpoints +
 * definition-of-done (a capability you build up over time). The same engine runs
 * under both — `kind` is what lets the UI and (later) the decomposer treat them
 * differently. The skill-graph structure itself lands with the decomposer.
 */
export type GoalKind = "project" | "learning";

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  project: "Project",
  learning: "Learning",
};

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
  /** Kind for a brand-new goal (only read when `newProjectName` is set). */
  newProjectKind: GoalKind;
  /** Earlier entry this one follows up on, or null. */
  parentEntryId: string | null;
}

// --- Database row shapes ----------------------------------------------------

/**
 * A goal — the spine of the app. Owns its tasks directly (`Task.goal_id`) and
 * carries a definition-of-done (`GoalCriterion[]`) plus a deadline. Subsumes the
 * old "project" (a project goal = task DAG + deadline; a learning goal will add a
 * skill graph in a later step). Entries are a provenance/source link, not the
 * structural parent.
 */
export interface Goal {
  id: string;
  /** Owner of the goal. Undefined in offline demo mode. */
  user_id?: string | null;
  name: string;
  description: string | null;
  /** Project (task DAG + deadline) vs learning (skill graph + checkpoints). */
  kind: GoalKind;
  /** The "finish line" the completion forecast is computed against. */
  deadline: string | null;
  created_at: string;
}

/**
 * One line of a goal's definition-of-done. The goal counts as complete when its
 * criteria are non-empty AND all `met` (derived, never stored). `met_confidence`
 * records how sure we were when it was checked off.
 */
export interface GoalCriterion {
  id: string;
  goal_id: string;
  text: string;
  met: boolean;
  met_confidence: CompletionConfidence | null;
  /**
   * How a scope-cutting recovery move lowered this criterion's ambition (e.g.
   * "now: managed provider, no SSO"), or null while it stands intact. The
   * original `text` is kept verbatim; this records the compromise so a goal can't
   * be quietly redefined down (§5 grounding gate check 2 — "no silent erosion").
   */
  degraded_note: string | null;
  sort_index: number;
  created_at: string;
}

/**
 * A goal's derived completion read (computed in `lib/goal.ts`), for the UI and
 * the divergence detector. `complete` = criteria non-empty AND all met;
 * `verified` = complete AND every met criterion is `verified`; `confidence` is
 * the weakest confidence across met criteria (null when nothing is met).
 */
export interface GoalCompletion {
  complete: boolean;
  verified: boolean;
  confidence: CompletionConfidence | null;
  metCount: number;
  total: number;
}

/**
 * One node in a learning goal's skill graph: a capability to attain. The
 * `prerequisites` are ids of nodes that must be attained first (a DAG). A
 * `is_checkpoint` node is a verifiable milestone — checkpoints drive *skill*
 * progress, while every node's effort drives *effort* progress (the two diverge
 * when you've put in hours but not yet hit a milestone). Attainment is
 * confidence-tagged exactly like task completion.
 */
export interface SkillNode {
  id: string;
  goal_id: string;
  title: string;
  description: string | null;
  /** Ids of skill nodes that must be attained before this one is unlocked. */
  prerequisites: string[];
  is_checkpoint: boolean;
  estimated_minutes: number;
  attained: boolean;
  attained_confidence: CompletionConfidence | null;
  attained_at: string | null;
  sort_index: number;
  created_at: string;
}

/**
 * A learning goal's derived progress (computed in `lib/skill.ts`). The crux of
 * §5.3b: *effort* progress (minutes attained / total) and *skill* progress
 * (checkpoints met / total, falling back to nodes when a plan has no
 * checkpoints) are tracked separately, because grinding hours isn't the same as
 * demonstrably reaching a milestone. `unlocked` are the not-yet-attained nodes
 * whose prerequisites are all met — the actionable frontier.
 */
export interface SkillProgress {
  total: number;
  attained: number;
  checkpointsTotal: number;
  checkpointsMet: number;
  effortMinutesDone: number;
  effortMinutesTotal: number;
  /** 0–1: minutes attained over total. */
  effortPct: number;
  /** 0–1: checkpoints met over total (or nodes attained when no checkpoints). */
  skillPct: number;
  /** Ids of unattained nodes whose prerequisites are all attained. */
  unlocked: string[];
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
  goal_id: string | null;
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

/**
 * Where a task came from, when that provenance changes how it's treated.
 * `"debt"` marks a follow-up materialized by a scope-cutting recovery move — the
 * trimmed work, owed after the deadline rather than silently erased (§5 gate
 * check 4). Null for an ordinary task. Stored as free text so future origins
 * extend without a migration.
 */
export type TaskOrigin = "debt";

export interface Task {
  id: string;
  entry_id: string;
  /** The owning goal — the canonical spine edge. Null only for unfiled drafts. */
  goal_id: string | null;
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
  /** How sure we are this completion is real (set when status → done; null while open). */
  completion_confidence: CompletionConfidence | null;
  /** When the task was marked done (null while open). */
  completed_at: string | null;
  /** Provenance when it changes treatment — `"debt"` for a scope-cut follow-up. */
  origin: TaskOrigin | null;
  /**
   * How a blocker was resolved, when reported through a check-in (§5.6 slice 6b,
   * cascade-with-provenance) — free text like "Used a template". Display/audit
   * provenance only, never a number or an id (§0-safe); null for an ordinary task
   * or a plain resolution with no stated method.
   */
  resolved_by: string | null;
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

// --- Recurring activities (goals & routines) --------------------------------

/**
 * A recurring activity's cadence period. "day" => routine/habit (daily, streak-
 * based); "week" => goal (a weekly session target).
 */
export type ActivityCadencePeriod = "day" | "week";

/**
 * The unified primitive behind both routines/habits (daily, streak-based) and
 * goals (weekly target, cadence-based). It contributes a recurring time-drain on
 * the shared budget and emits a "do it" instance into the Now/Next queue when
 * due. Its success/miss state is DERIVED from the completion log (see
 * `lib/recurring.ts`), never stored.
 */
export interface RecurringActivity {
  id: string;
  /** Owner. Undefined in offline demo mode. */
  user_id?: string | null;
  title: string;
  /** Life-area, reusing the Today-page tabs (Work/Personal/Hobby/custom). */
  area: string;
  /** "day" => daily routine/habit; "week" => weekly goal. */
  period: ActivityCadencePeriod;
  /** Sessions targeted per period (daily habit = 1; goal e.g. 3 per week). */
  target_count: number;
  /** Restrict to certain weekdays (0=Sun..6=Sat); null = any eligible day. */
  weekdays: number[] | null;
  /** Minutes per session — the per-instance drain on the time budget. */
  estimated_minutes: number;
  // 1-5 factor ratings, same scale as tasks — score the synthetic queue instance.
  urgency: number;
  impact: number;
  effort: number;
  dependency: number;
  risk: number;
  confidence: number;
  /** When true, the strategist will never auto-sacrifice this activity. */
  protected: boolean;
  /** Soft-archive without losing completion history. */
  active: boolean;
  created_at: string;
}

/**
 * One logged session (or skip) of a recurring activity on a date. A skip
 * (`skipped: true`) resolves that period's obligation — it stops draining the
 * budget and stops nagging — but does NOT count toward a streak. All
 * streak/progress state is derived from these rows; nothing is precomputed.
 */
export interface ActivityCompletion {
  id: string;
  user_id?: string | null;
  activity_id: string;
  date: string; // ISO YYYY-MM-DD the session was logged for
  minutes: number;
  skipped: boolean;
  created_at: string;
}

/**
 * Local time-of-day bucket a work session happened in (OVERHAUL S2). Fixed
 * boundaries: early 05–09 · morning 09–12 · afternoon 12–17 · evening 17–22 ·
 * night 22–05. Captured from the user's LOCAL clock at write time (`windowOf` in
 * `lib/velocity.ts`); never re-derived from a stored UTC instant.
 */
export type TimeWindow = "early" | "morning" | "afternoon" | "evening" | "night";

/**
 * One real work session (OVERHAUL S2 slice B) — the WHEN-signal today's data
 * lacks: `tasks.completed_at` is a single UTC "marked done" instant and
 * `actual_minutes` is a cumulative total, so neither says when (locally) you
 * worked. A row records the local time-of-day window + weekday + the day it counts
 * for, captured at write time. A session is task effort XOR a routine session
 * (`task_id`/`activity_id`). Slice C reads these (keyed by window/weekday) for
 * energy windows + adherence; on its own slice B is pure accrual — no behaviour
 * change.
 */
export interface WorkSession {
  id: string;
  user_id?: string | null;
  task_id: string | null;
  activity_id: string | null;
  /** ISO YYYY-MM-DD — the local day the work counts for. */
  logged_for: string;
  /** Local time-of-day bucket, captured at write time. */
  time_window: TimeWindow;
  /** 0=Sun..6=Sat, local. */
  weekday: number;
  /** This session's real length; 0 for a length-less completion event. */
  minutes: number;
  kind: "progress" | "complete";
  created_at: string;
}

/**
 * The client-captured local stamp a completion/effort-log passes to its server
 * action so the work session records the user's LOCAL window/weekday — the action
 * runs server-side and can't read the client clock, so the client must supply it
 * (the timezone-gotcha resolution). Built by `localSessionStamp()` in
 * `lib/work-session.ts`.
 */
export interface WorkSessionLocal {
  time_window: TimeWindow;
  weekday: number;
  logged_for: string;
}

/** A recurring activity's derived success state (computed in `lib/recurring.ts`). */
export type RecurringStatus = "met" | "due" | "missed" | "cold";

/** The derived read of a recurring activity, for the UI and the strategist. */
export interface RecurringState {
  activity: RecurringActivity;
  status: RecurringStatus;
  /** Consecutive eligible periods met, walking back from today (habit streak). */
  streak: number;
  /** Sessions completed vs targeted in the current period. */
  progress: { done: number; target: number };
  /** A session (not a skip) was logged for today. */
  doneToday: boolean;
  /** An instance is owed today (eligible day, period not yet met, not done). */
  dueToday: boolean;
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
  /**
   * 80% central interval of the *remaining work* (minutes), from the same Monte
   * Carlo that prices the odds: the work lands between `p10Minutes` and
   * `p90Minutes` in ~80% of sampled futures, with `p50Minutes` the median
   * outcome. Turns the single `expectedMinutes` point estimate into an honest
   * range — and `p50`/`p90` anchor the critical-chain buffer (`lib/buffer.ts`):
   * the gap between the safe (p90) and median (p50) outcome is the safety margin
   * the variance demands. All 0 when there's no open work.
   */
  p10Minutes: number;
  p50Minutes: number;
  p90Minutes: number;
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

/**
 * The forecast-facing slice of an estimation model — just the log-space bias +
 * spread the Monte Carlo samples with (a full `EstimationModel` is structurally
 * assignable to it). The per-task velocity model (OVERHAUL S2) rides on this
 * shape so a single task can carry its own segment-shrunk bias into the sampler
 * instead of the one global scalar. See `lib/velocity.ts` and
 * `design/s2-context-tags-and-shrinkage.md`.
 */
export interface SegmentModel {
  meanLog: number;
  sigma: number;
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
    | "buffer_low" // on track, but the critical-chain safety buffer is mostly committed
    | "overdue_tasks" // open tasks whose due_date has passed
    | "blocked_tasks" // open tasks stuck in `blocked`
    | "provisional_completion" // done work / met criteria rest on unverified confidence
    | "contention"; // competing with another project for the same shared hours (pit wall)
  /** "critical" = the deadline itself is in jeopardy; "warning" = needs attention but on time. */
  severity: "critical" | "warning";
  detail: string;
}

/**
 * The diagnosed *cause* behind a divergence — one level deeper than the
 * symptom-level {@link DivergenceReason}. The cause picks the response *class*
 * (which family of moves to prefer) so the strategist doesn't reflexively cut
 * scope for a one-off slip. Computed deterministically from estimation residuals
 * and a temporal baseline (see `lib/grounding.ts`); the LLM may narrate it but
 * never decides it (§0).
 */
export type DivergenceCause =
  | "one_off_slip" // a single task blew up; the underlying pace is fine
  | "chronic_velocity" // estimates are systematically low — a pattern, not an event
  | "timing_placement" // the overrun is the low-energy WINDOWS worked in, not the estimates (S2)
  | "constraint_change" // the world moved since the plan was made
  | "scope_structural"; // simply too much committed work for the time

/** A diagnosed cause plus the one-line, deterministic "why" shown to the user. */
export interface CauseDiagnosis {
  cause: DivergenceCause;
  /** Human-readable explanation — computed from signals, never authored by the LLM. */
  detail: string;
}

/**
 * The honest "cost to the goal, not just the deadline" shown beside a recovery
 * move's odds gain (§5 grounding gate check 3). A deadline-buying cut can lift
 * the odds while doing nothing for the goal's reason for being — its definition
 * of done (project) or its skill milestones (learning). Computed deterministically
 * from `goalCompletion` / `skillProgress` (never authored), so vibe-cutting can't
 * hide behind a green number.
 */
export interface GoalCutCost {
  kind: GoalKind;
  /** Definition-of-done criteria still unmet (project goals). */
  criteriaUnmet: number;
  /** Total definition-of-done criteria recorded (project goals; 0 when none). */
  criteriaTotal: number;
  /** Skill milestones cleared (learning goals). */
  checkpointsMet: number;
  /** Total skill milestones (learning goals; 0 when none). */
  checkpointsTotal: number;
  /** 0–1 demonstrable-skill progress (learning goals). */
  skillPct: number;
  /** One-line honest summary for the UI. */
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
  /**
   * The diagnosed cause behind the divergence — the "why" one level below the
   * symptoms. Null when the project is flagged for attention but not genuinely
   * off track (a blocked/overdue warning with no divergence to explain).
   */
  cause: CauseDiagnosis | null;
  /**
   * The cost to the goal beyond the deadline — its unmet definition of done
   * (project) or skill milestones (learning) that a deadline-buying move does
   * nothing for. Null when the goal records no DoD/skills to measure against, or
   * when it isn't genuinely off track. §5 grounding gate check 3.
   */
  goalCost: GoalCutCost | null;
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

// --- LLM decomposer (learning-goal skill graph) -----------------------------

/**
 * One skill the decomposer proposes for a learning goal. `key` is a stable slug
 * the model uses so `prerequisites` can reference other skills (mapped to UUIDs
 * on persist, exactly like extracted-task `depends_on`). The LLM proposes the
 * structure; it never decides progress.
 */
export interface ExtractedSkill {
  key: string;
  title: string;
  description: string;
  /** Keys of skills that must be learned first. */
  prerequisites: string[];
  /** A verifiable milestone (e.g. "hold a 5-minute conversation"). */
  is_checkpoint: boolean;
  estimated_minutes: number;
}

/** What the decomposer LLM is asked to return for a learning goal. */
export interface SkillDecomposition {
  skills: ExtractedSkill[];
}

// --- LLM strategist (corrective task generation) ----------------------------

/** What kind of hole a corrective task fills. */
export type GapKind = "rework" | "unblock" | "de_risk";

/**
 * A net-new corrective task the strategist proposes to fill a real gap in an
 * off-track project — rework after a failed review, an unblock action, or work
 * to de-risk a task that's blowing its estimate. Carries the same 1-5 factor
 * ratings as an extracted task so it scores through `computePriority`.
 */
export interface SuggestedTask extends FactorScores {
  title: string;
  description: string;
  estimated_minutes: number;
  due_date: string | null;
  blocked_by: string | null;
  priority_reason: string;
  /** Life-area to file the task under (inherited from the project's tasks). */
  area: string;
  gap_kind: GapKind;
}

/**
 * The strategist's advisory output for one off-track project: net-new tasks to
 * fill genuine gaps, plus the probability the project would have if they were
 * added. The probability is always computed by `forecast()` — the LLM proposes
 * the tasks, never the likelihood.
 */
export interface RecoverySuggestion {
  projectId: string;
  tasks: SuggestedTask[];
  /** Completion probability after adding the suggested tasks — from `forecast()`. */
  previewProbability: number;
  /** One-line explanation of the gap these tasks fill. */
  rationale: string;
}

// --- LLM strategist (existing-task modification) ----------------------------

/**
 * How the strategist reshapes an existing task to fit the budget:
 * - "scope_down": replace it with a lighter version (a smaller estimate, trimmed
 *   scope) — recovers the forecast by lowering the expected work.
 * - "split": break a stuck monolith into smaller real steps — recovers the
 *   forecast because the sum of several well-understood estimates carries less
 *   compounding risk than one big opaque guess (even at equal total minutes).
 */
export type ModificationKind = "scope_down" | "split";

/**
 * One piece of the reshaped work — the lighter version of a scoped-down task, or
 * one step of a split. Carries its own estimate + 1-5 factor ratings so it scores
 * through `computePriority` exactly like an extracted task.
 */
export interface ModificationPart extends FactorScores {
  title: string;
  description: string;
  estimated_minutes: number;
  priority_reason: string;
}

/**
 * A proposal to reshape one existing task. `replacements` holds the work that
 * takes its place: exactly one part for "scope_down", two or more for "split".
 */
export interface TaskModification {
  kind: ModificationKind;
  /** The existing open task being reshaped. */
  taskId: string;
  /** Its current title, for display. */
  taskTitle: string;
  /** Its current estimate (minutes), for the before/after comparison. */
  originalEstimate: number;
  /** One-line explanation of why this reshape helps. */
  rationale: string;
  replacements: ModificationPart[];
}

/**
 * The strategist's advisory output for one off-track project: existing tasks
 * reshaped to fit the budget, plus the probability the project would have if the
 * reshapes were applied. As with Generate, the probability is always computed by
 * `forecast()` — the LLM proposes the reshape, never the likelihood.
 */
export interface ModificationSuggestion {
  projectId: string;
  modifications: TaskModification[];
  /** Completion probability after applying the modifications — from `forecast()`. */
  previewProbability: number;
  /** One-line explanation of the reshaping strategy. */
  rationale: string;
}

// --- LLM strategist (whole-plan re-route) -----------------------------------

/**
 * One task in an alternative plan. Same shape as a `SuggestedTask` minus the
 * gap/area bookkeeping — the whole plan shares one area, applied on accept.
 * Carries its own estimate + 1-5 factor ratings so it scores through
 * `computePriority` exactly like an extracted task.
 */
export interface ReroutePart extends FactorScores {
  title: string;
  description: string;
  estimated_minutes: number;
  due_date: string | null;
  blocked_by: string | null;
  priority_reason: string;
}

/**
 * A definition-of-done criterion a reroute explicitly compromises, with the
 * one-line note recording how (§5 grounding gate check 2). The LLM may author the
 * note (narration), but `criterionId` is validated against the goal's real
 * criteria — which criteria exist and the odds are never the model's call (§0).
 * Recorded as the criterion's `degraded_note` on accept, so switching to a
 * lighter approach can't quietly redefine the goal down.
 */
export interface DegradedCriterion {
  /** The real criterion being lowered (validated against the goal's DoD). */
  criterionId: string;
  /** The criterion's current text, for the before/after display. */
  text: string;
  /** How the reroute lowers this bar (e.g. "managed provider, no SSO"). */
  note: string;
}

/**
 * The strategist's boldest move: a complete alternative plan that hits the same
 * deliverable by a fundamentally different approach (buy vs build, a managed
 * service vs custom, a template vs from-scratch). It replaces the entire current
 * open plan — surfaced as an all-or-nothing draft, not a per-task pick. As with
 * the other moves, the probability is always computed by `forecast()`; the LLM
 * proposes the approach, never the likelihood.
 */
export interface RerouteSuggestion {
  projectId: string;
  /** Short name of the alternative approach (e.g. "Use a managed auth provider"). */
  approach: string;
  /** One sentence: how the new route differs and why it fits the budget. */
  rationale: string;
  /** The replacement tasks — the new approach. */
  tasks: ReroutePart[];
  /** Current open tasks this plan swaps out (deferred on accept), for the before/after. */
  replaces: { taskId: string; title: string; estimated_minutes: number }[];
  /**
   * Definition-of-done criteria this lighter route lowers, with how (§5 gate
   * check 2) — empty when the route preserves the full bar. Recorded as each
   * criterion's `degraded_note` on accept, and shown in the before/after so the
   * odds gain can't hide a quiet redefinition of done.
   */
  degradedCriteria: DegradedCriterion[];
  /** Completion probability after switching to this plan — from `forecast()`. */
  previewProbability: number;
}

// --- Pit-wall strategist (global, cross-project allocation) -----------------

/**
 * One task's place in the single global order across all projects. The order is
 * a *derived* view layered on top of the stored `priority_score` (never
 * overwrites it): dependency topo-sort, then EDF by project deadline with WSJF
 * as the tiebreak (and WSJF-first under overload). `pulledAhead` marks a task
 * that leapfrogged higher-`priority_score` work from another project because its
 * own project's deadline is closer.
 */
export interface EffectiveOrderEntry {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  estimatedMinutes: number;
  /** 0-based position in the global order. */
  rank: number;
  /** True when deadline pressure pulled this ahead of more intrinsically important work. */
  pulledAhead: boolean;
  /** Human-readable reason for the placement (e.g. "pulled ahead — Goal X due in 2 days"). */
  reason: string;
  /**
   * Per-task velocity model (OVERHAUL S2): this task's segment-shrunk `(meanLog,
   * sigma)`, carried from its `AllocTask` so the joint sampler biases each task by
   * its own domain velocity. Absent ⇒ the global scalar in the forecast options.
   */
  model?: SegmentModel;
  /**
   * Cognitive-load weight in `[0,1]` (OVERHAUL S3b Phase 3): the comfort-capped flow
   * meters each day's **hard minutes** (`difficulty × sampled duration`) against the
   * daily comfort cap. Absent ⇒ unmetered (0). See `allocate.ts effortToDifficulty`.
   */
  difficulty?: number;
  /**
   * Impact factor 1-5 (OVERHAUL S3b Phase 4): modulates ONLY the energy-placement term
   * in `arrange.ts` (high-value hard work gets first claim on fast windows), never the
   * comfort cap (that's cognitive load = `difficulty` alone). Carried from `AllocTask`.
   * Absent ⇒ neutral. Does not affect ordering or odds without a learned window profile.
   */
  impact?: number;
}

/**
 * A pit-wall conflict surfaced by the global allocation: a project that can't
 * finish in time, or two projects whose deadlines collide over the shared hours.
 * Defined here; the detector that produces these lands in a later step (G3).
 */
export interface Conflict {
  kind: "infeasible" | "deadline_collision";
  projectId: string;
  projectName: string;
  detail: string;
}

/**
 * A recommended triage move: shed (defer) a low-value task to recover the
 * savable high-value work under overload. `wsjf` is the value density it was
 * chosen by; `probabilityAfter` is the recovered odds — always from the
 * forecast, never the LLM. Consumed in a later step (G3).
 */
export interface TriageMove {
  taskId: string;
  title: string;
  projectId: string;
  /** The task's estimate (minutes) — for the before/after task display. */
  estimatedMinutes: number;
  wsjf: number;
  probabilityAfter: number;
}

/**
 * One mutually-exclusive way to resolve a genuine comparable-value tie (the
 * single escalated decision auto-triage refuses to make for you): protect one
 * colliding project by shedding the open work of the others it's fighting for
 * the shared hours with. `probabilityAfter` is the protected project's recovered
 * joint odds once that sacrifice is made — always from the forecast, never the
 * LLM. Surfaced only when `PitWall.needsDecision`.
 */
export interface PitWallOption {
  protectId: string;
  protectName: string;
  /** The colliding projects whose open work is deferred to protect the above. */
  sacrificeNames: string[];
  /** Their open tasks — the batch a one-click "Protect this" defers. */
  sacrificeTaskIds: string[];
  /** Protected project's joint odds once the sacrifice set is shed. */
  probabilityAfter: number;
}

// --- Portfolio strategist (one cached, time-aware recommendation) -----------

/**
 * Every move the portfolio strategy can recommend. Maps 1:1 to an existing apply
 * action (see `lib/portfolio-strategist.ts`). `hold` is the no-op "stay the
 * course" outcome — surfaced when the synthesis decides no change is needed.
 */
export type StrategyMoveKind =
  | "defer"
  | "reschedule_deadline"
  | "reschedule_task"
  | "unblock"
  | "triage"
  | "add_tasks"
  | "reshape"
  | "reroute"
  | "mark_done"
  | "attain_skill"
  // §5.6 slice 6b — resolve a structural blocker: mark it done + cascade one-hop
  // edge removal over `task_dependencies` (frees its direct dependents) + stamp
  // free-text provenance. Distinct from `unblock` (which clears the SOFT
  // `blocked_by` flag on one dependent); never overloads it.
  | "resolve_blocker"
  | "skip_activity"
  | "hold";

/**
 * The literal arguments an apply action needs, discriminated by `kind`. The
 * payload carries the *full* struct (not a reference) so a cached strategy can be
 * applied without re-deriving it — a stale id simply no-ops in the apply action.
 */
export type StrategyMovePayload =
  | { kind: "defer"; taskId: string; title: string }
  | { kind: "reschedule_deadline"; deadline: string }
  | { kind: "reschedule_task"; taskId: string; title: string; dueDate: string }
  | { kind: "unblock"; taskId: string; title: string }
  | {
      kind: "mark_done";
      taskId: string;
      title: string;
      /** Provenance of the completion (§5.6 invariant: a pure function of WHERE the
       *  move came from). A check-in "I finished X" → `self_assessed`; omitted by the
       *  strategist's own inference → defaults to `inferred` in persist. */
      confidence?: CompletionConfidence;
    }
  | {
      // §5.6 — the user attained a skill node (drops its synthetic forecast task).
      kind: "attain_skill";
      goalId: string;
      nodeId: string;
      title: string;
      /** `self_assessed` for a stated check-in skill; `inferred` for spillover. */
      confidence: CompletionConfidence;
      /** Set when this attainment was INFERRED from attaining an overlapping node
       *  in another goal — the spillover provenance (no DB column; lives here). */
      viaSpilloverFrom?: string;
    }
  | {
      // §5.6 slice 6b — the user resolved a blocker (a task others depend on). Persist
      // marks it done, deletes every `task_dependencies` edge INTO it (`depends_on_task_id
      // === blockerTaskId`), and stamps `resolved_by`. `freedTaskIds` is advisory display
      // only — persist re-derives the edges from the LIVE DAG, so a stale id no-ops.
      kind: "resolve_blocker";
      blockerTaskId: string;
      title: string;
      /** `self_assessed` for a check-in resolution (the user said it); the invariant. */
      confidence: CompletionConfidence;
      /** Free-text "how" ("Used a template"), or null for a plain resolution. */
      resolvedBy: string | null;
      /** The blocker's direct dependents at generation time — display only. */
      freedTaskIds: string[];
    }
  | { kind: "triage"; taskIds: string[]; titles: string[] }
  | { kind: "add_tasks"; tasks: SuggestedTask[] }
  | { kind: "reshape"; mods: TaskModification[] }
  | {
      kind: "reroute";
      replacedTaskIds: string[];
      tasks: ReroutePart[];
      approach: string;
    }
  | {
      kind: "skip_activity";
      activityId: string;
      title: string;
      period: ActivityCadencePeriod;
    }
  | { kind: "hold" };

/**
 * One recommended move in the portfolio strategy. `rationale` is human prose (the
 * synthesis LLM's, or a deterministic template); `probabilityAfter` is ALWAYS
 * harvested from a `forecast()`-scored struct, never authored by the LLM.
 */
export interface StrategyMove {
  kind: StrategyMoveKind;
  /** Owning project, or "" for cross-project triage. */
  projectId: string;
  projectName: string;
  rationale: string;
  /** The odds this move restores ON ITS OWN — solo per-project, from `forecast()`/`jointOdds`. */
  probabilityAfter: number;
  /**
   * The CUMULATIVE contention-aware portfolio odds (P(all deadlined projects
   * land) — `globalForecastJoint.allOnTime`) after applying this move *and every
   * move ordered before it*. Climbs to `PortfolioStrategy.combinedProbability` at
   * the last move. Baked in at generation time; the frontend renders it verbatim.
   */
  portfolioProbabilityAfter: number;
  /**
   * Titles of EXISTING open tasks this move defers (reversibly) out of the plan —
   * the work that gets set aside so the lighter/alternative plan can fit. Set for
   * the moves that shed real work (reroute replaces the whole plan; reshape-split
   * defers the monolith; triage sheds a batch); omitted for moves that don't
   * (reschedule, unblock, a plain single defer whose own rationale already says it).
   * Full task snapshots (hydrated at generation time) so the card renders them as
   * the same detailed task rows used on the project page — priority, due, scores.
   */
  defers?: Task[];
  /** The literal args the mapped apply action needs, discriminated by kind. */
  payload: StrategyMovePayload;
}

/**
 * The single portfolio-wide recommendation rendered on Today: a narrative
 * assessment plus an ordered (best-first) set of applyable moves. Cached and
 * regenerated only when the situation changes or the user asks (see §C).
 */
export interface PortfolioStrategy {
  /** Narrative across the whole portfolio. */
  assessment: string;
  /** True ⇒ hold course; `moves` may be empty. */
  onTrack: boolean;
  /** Ordered best-first; each mapped to an apply action. */
  moves: StrategyMove[];
  /** ISO timestamp — anchor for plan-vs-time drift continuity AND the age-based staleness gate. */
  generatedAt: string;
  /** Situation hash this strategy was generated for (see `computeSituationFingerprint`). */
  fingerprint: string;
  /**
   * Per-project completion odds (contention-aware) at generation time, keyed by
   * projectId. The staleness gate diffs the *current* odds against this snapshot
   * so only a change that materially moves the odds (not a cosmetic edit) marks
   * the strategy stale — the cheap deterministic pre-filter before any LLM call.
   */
  odds: Record<string, number>;
  /** False = deterministic fallback (no key / call failed). */
  usedLLM: boolean;
  /**
   * The bold tier's combined portfolio odds — P(all deadlined projects land)
   * after applying every move in `moves`. Equals the last move's
   * `portfolioProbabilityAfter` (the base joint odds when `moves` is empty).
   * Surfaced at "Apply all".
   */
  combinedProbability: number;
  /**
   * The grounded "steady plan" tier: mechanical-only moves (defer / reschedule /
   * unblock / mark_done / triage) chosen by the joint greedy optimizer, beside
   * the bold LLM recommendation. Each move carries its own cumulative
   * `portfolioProbabilityAfter`. Null when there's nothing mechanical to do or in
   * the no-LLM fallback (where the single bold tier already IS the joint plan).
   */
  grounded: {
    moves: StrategyMove[];
    combinedProbability: number;
  } | null;
  /**
   * The serialized generation-time gather slice that lets the review screen
   * re-solve an arbitrary move subset client-side (OVERHAUL S1 / vision §8.2) —
   * toggling a move off recomputes the headline + per-move odds with no round-trip,
   * matching the baked numbers for the same subset. Optional: the synchronous
   * instant draft and pre-S1 cached strategies carry none (the card then renders
   * the baked values without live re-solve, upgrading on the next generation).
   */
  resolveInput?: ResolveInput;
}

/**
 * Enough to revert one applied strategy bundle (OVERHAUL S1 step 3 / vision §1.3).
 * Snapshotted *per bundle* (not per move) — it matches the bundle-level undo and
 * doubles as the version record. `tasks`/`goals` hold the PRIOR values (id + only
 * the fields the bundle changed) so a restore writes exactly those back; the
 * inserted-id arrays name the synthetic rows the bundle created, deleted on undo.
 */
export interface RowSnapshot {
  /** Prior values of tasks the bundle mutated — id + only the changed fields. */
  tasks: (Partial<Task> & { id: string })[];
  /** Prior values of goals the bundle mutated — id + the prior deadline. */
  goals: (Partial<Goal> & { id: string })[];
  /** Prior attainment of skill nodes an `attain_skill` move flipped (§5.6) — id +
   *  attained/confidence/at — so undo reverts a skill back to unattained. */
  skillNodes: (Partial<SkillNode> & { id: string })[];
  /** Synthetic task rows the bundle inserted (add_tasks / reshape-split / scope-down
   *  debt / reroute) — deleted on undo. */
  insertedTaskIds: string[];
  /** Synthetic recovery entries the inserted tasks were filed under — deleted on undo
   *  so an undone bundle leaves no dangling empty entry. */
  insertedEntryIds: string[];
  /** Skip rows (ActivityCompletion) a `skip_activity` move inserted — deleted on undo. */
  activityCompletionIds: string[];
  /** Dependency edges a `resolve_blocker` cascade DELETED (§5.6 slice 6b) — the FULL
   *  rows (id/entry_id/reason), so undo re-INSERTS the originals and the DAG is byte-
   *  identical. `plan_versions.restore` is jsonb ⇒ no migration; rows persisted before
   *  6b read `deletedDependencies ?? []`. */
  deletedDependencies: TaskDependency[];
}

/**
 * One recorded adaptation: a strategy bundle the user applied, with the odds they
 * accepted and a `restore` snapshot that reverts it whole (OVERHAUL S1 step 3 /
 * vision §1.3). Every "Apply" — a single move or a whole tier — writes one of
 * these; the history view lists them (reason · before → after · time) and undo
 * replays `restore`. Capped at the most recent 50 per user (oldest pruned).
 */
export interface PlanVersion {
  id: string;
  /** ISO timestamp the bundle was applied. */
  createdAt: string;
  /** Human reason: the synthesis assessment, or "Applied N moves". */
  reason: string;
  /** The committed bundle (the moves as applied, in apply order). */
  moves: StrategyMove[];
  /** Portfolio odds before the bundle (base joint odds). */
  oddsBefore: number;
  /** The previewed combined odds the user accepted. */
  oddsAfter: number;
  /** Prior values + inserted ids — enough to revert the whole bundle. */
  restore: RowSnapshot;
  /** Set when undone; null while the bundle stands. */
  revertedAt: string | null;
}

// --- Rolling-horizon wrapper (S3c-1) ----------------------------------------

/**
 * Bumped when the persisted `CommittedPlan` shape changes so a stale row is safely
 * invalidated (treated as "no committed plan" ⇒ the no-regret fresh path) rather
 * than mis-replayed. Start at 1.
 */
export const COMMITTED_PLAN_SCHEMA_VERSION = 1;

/**
 * The plan the user is currently following — the single piece of state the
 * rolling-horizon wrapper (OVERHAUL §5a substrate S3c-1) applies hysteresis
 * against so a reload doesn't thrash the imminent day for a marginal soft-objective
 * gain. One upserted row per user (mirrors `PortfolioStrategy`'s cache row); the
 * read path decides *what to show* against it (sticky vs. fresh) and the mutation
 * write path *rolls* it forward. It authors NO odds and adds no arrangement quality
 * — it only decides which already-priced arrangement to keep committing to as the
 * days advance. See `design/s3c-rolling-horizon-wrapper.md` and `lib/rolling.ts`.
 */
export interface CommittedPlan {
  /** Forward-compat / safe invalidation (see COMMITTED_PLAN_SCHEMA_VERSION). */
  schemaVersion: number;
  /**
   * The committed cross-project order (the replay basis) — the ARRANGED, gated
   * order the user follows (post `gatedReorder`), NOT the canonical order. Shipped
   * for the dashboard display pack, the churn/J metrics, and (as a task-id sequence)
   * the S1 re-solve verbatim replay.
   */
  order: EffectiveOrderEntry[];
  /** `todayISO()` at commit time — the frozen-zone (anchor) day. A date-granular roll
   *  fires when this advances; the read path tolerates a stale anchor safely. */
  anchor: string;
  /** Situation fingerprint at commit (see `rollFingerprint`), folding open-task
   *  membership, bucketed deadlines, the window/velocity generation, comfort + value
   *  model. An unchanged fingerprint + anchor ⇒ nothing material moved ⇒ stay put. */
  fingerprint: string;
  /** The committed arrangement's soft score `J` (from `arrangementScore`) — the
   *  quantity the stability gate weighs the fresh candidate's improvement against. */
  j: number;
  /** ISO timestamp the arrangement was committed. */
  committedAt: string;
}

/**
 * A local instant captured CLIENT-SIDE (OVERHAUL §5a substrate S3c-4,
 * design/s3c4-intraday-frozen-zone.md). The scheduler is deliberately clock-free
 * everywhere else (day-granular capacity, no timezone stored — S3b decision #5); the
 * intra-day frozen zone is the one place a real "now" is needed, and it follows the S2
 * timezone-gotcha resolution: the client knows its own offset, so it captures its local
 * time rather than the server deriving it from a UTC instant (which would be wrong by the
 * user's offset). Passed per request, NEVER stored — no migration, no stored timezone. It
 * enters ONLY the churn near-weight; absent or ambiguous ⇒ the wrapper is byte-identical to
 * the date-granular S3c-1 behaviour (no-regret).
 */
export interface LocalNow {
  /** The client's local calendar day, `YYYY-MM-DD`. Compared against the plan's frozen-zone
   *  anchor; a mismatch (midnight rollover / travel / skew) ⇒ date-granular fallback. */
  date: string;
  /** Minutes since local midnight, `0..1439`. How far into today we are — the signal that
   *  slips the frozen zone forward through the day. */
  minutesSinceMidnight: number;
}

// --- Rolling-horizon history (S3c-2) ----------------------------------------

/**
 * Why a passive roll fired — the seam S3c-3's `diagnoseRoll` reads to narrate it
 * ("shifted because the Recital deadline moved in"). `material` = the stability
 * gate let a materially-better candidate through; `anchor` = the date advanced and
 * the near part re-froze; `initial` = the first-ever commit (no prior arrangement
 * to diff, so `prevJ` is null). Stored as free text (like {@link TaskOrigin}) so a
 * future roll-kind needs no migration; validated in TS.
 */
export type PlanRollKind = "material" | "anchor" | "initial";

/**
 * One retained automatic roll of the committed plan (OVERHAUL §5a substrate S3c-2,
 * design/s3c2-passive-roll-history.md). Where {@link CommittedPlan} is the single
 * CURRENT plan, a `PlanRoll` is a capped history entry the rolling wrapper appends
 * each time it actually rolls (a material better-candidate or an anchor advance,
 * never a stay-put reload) — the memory that powers the "how my plan evolved"
 * timeline and a roll-undo. A SIBLING to {@link PlanVersion}, not an overload:
 * `PlanVersion` undoes an applied strategy bundle's ROW mutations, whereas a
 * `PlanRoll` retains an ARRANGEMENT snapshot whose undo restores a prior order
 * THROUGH reconcile + re-price (never resurrecting a completed/deleted task).
 * Authors no odds — it stores an arrangement + its soft score `j` only. Capped at
 * the most recent 50 per user (oldest pruned).
 */
export interface PlanRoll {
  id: string;
  /** ISO timestamp the roll fired. */
  rolledAt: string;
  /** The committed plan's frozen-zone (anchor) day at roll time (CommittedPlan.anchor). */
  anchor: string;
  /** The committed plan's situation fingerprint at roll time (CommittedPlan.fingerprint). */
  fingerprint: string;
  /** The committed arrangement's soft score `J` (from `arrangementScore`). */
  j: number;
  /** Why the roll fired — the diff seam S3c-3's `diagnoseRoll` reads. */
  kind: PlanRollKind;
  /** The superseded arrangement's `J`; null for the first-ever commit (`initial`). */
  prevJ: number | null;
  /**
   * The committed cross-project order this roll retained — the ARRANGED, gated
   * order (post `gatedReorder`), same shape as `CommittedPlan.order`. The replay
   * basis a roll-undo feeds back through reconcile as a preference seed (never
   * restored-verbatim as truth), so it can't resurrect a completed/deleted task.
   * Persisted to the `plan_order` jsonb column (not `order`, a reserved word).
   */
  order: EffectiveOrderEntry[];
  /** Set when this roll is undone; the entry stays in history (struck-through). Null while it stands. */
  revertedAt: string | null;
  /** Reuse {@link COMMITTED_PLAN_SCHEMA_VERSION}: a row whose version doesn't match
   *  the current `order` shape is treated as invalid, like a stale CommittedPlan. */
  schemaVersion: number;
}

// --- §5.6 NL check-in / reflection loop -------------------------------------
//
// The interpret → propose → review → commit loop over a free-form activity
// report (design/s5.6-nl-checkin-loop.md). Interpret is THREE stages so the LLM
// never authors a binding (§0 firewall):
//   A — interpretCheckin()  (LLM, fuzzy): NL → ungrounded, quoted, register-tagged
//                            intents referencing entities by quote + echoed handle.
//   B — resolveCheckin()    (deterministic): fuzzy-bind each quote to the live
//                            candidate set → resolved | ambiguous | unresolved.
//   C — proposeFromCheckin() (deterministic): resolved intents → StrategyMove[]
//                            (Family A) + odds-silent action intents (Family B);
//                            odds ALWAYS from jointOddsWithMoves, never the LLM.
//
// Two invariants this loop adds to the S1 list:
//   - No move without a resolved entity AND a verbatim source quote (blocks
//     fabrication, stale ids, and the prompt-injection vector of acting on an
//     entity the user never named — every move traces to a `quote` span).
//   - CompletionConfidence is a pure function of move PROVENANCE (check-in
//     mark_done = self_assessed; spillover attain_skill = inferred), never of any
//     model/resolution confidence score — those gate review PRESENTATION only.

/** The user's tone for one clause — orthogonal to the action it implies. */
export type CheckinRegister = "status" | "idea" | "vent";

/**
 * What one clause of a report wants to do — drives the move family in stage C.
 * Family A (forecast-affecting, rides S1 review/commit/undo): completed,
 * reschedule, add_task, skill_gained. Family B (odds-silent): time_logged, idea.
 * vent maps to no move (a non-actionable acknowledgement chip).
 */
export type CheckinIntentKind =
  | "completed" // → mark_done (or resolve_blocker when the task is a blocker, slice 6b)
  | "reschedule" // → reschedule_task / defer
  | "add_task" // → add_tasks
  | "skill_gained" // → attain_skill (the one new move kind, slice 4)
  | "resolved" // → resolve_blocker (blocker) / unblock (dependent) by DAG role (slice 6b)
  | "time_logged" // → log_progress (Family B)
  | "idea" // → quick capture (Family B)
  | "vent"; // → acknowledge only (no move)

/** Model/resolution confidence — gates REVIEW PRESENTATION only (high → checked
 *  by default, low → proposed unchecked). NEVER feeds CompletionConfidence. */
export type CheckinConfidence = "high" | "low";

/**
 * Stage A output — one *ungrounded* intent. References any existing entity ONLY
 * by a verbatim `quote` plus the `handle` the model echoed from the candidate set
 * we control; it never emits a raw DB id. Deterministic stage B binds the handle/
 * phrase to a real entity; stage C turns it into a move.
 */
export interface CheckinIntent {
  kind: CheckinIntentKind;
  register: CheckinRegister;
  /** Verbatim span from the report that triggered this intent — the provenance
   *  every downstream move must trace to (invariant). */
  quote: string;
  /** The candidate handle the model echoed (e.g. "T3", "S1.2"), or null when the
   *  intent names no existing entity (a brand-new task, a pure idea/vent). */
  handle: string | null;
  /** The free-text surface form the user used for the entity — the fuzzy-resolve
   *  key when the handle is absent or wrong. Null for handle-less intents. */
  entityPhrase: string | null;
  /** Kind-specific free text resolved deterministically in stage C: the target
   *  date phrase for `reschedule` ("next week"), the new title for `add_task`,
   *  the minutes phrase for `time_logged`, the note body for `idea`. */
  detail: string | null;
  confidence: CheckinConfidence;
}

/** Stage A result, shaped like ExtractionResult (returned with a `source` sibling
 *  by interpretCheckin). `intents` may be empty — a pure vent is valid. */
export interface CheckinInterpretation {
  intents: CheckinIntent[];
  /** Echo of the raw report — the review header + observability context. */
  rawReport: string;
}

/** One entity the resolver may bind a quote to — the candidate set is the blast
 *  radius (open tasks, the unlocked skill-node frontier, active activities). */
export interface CheckinCandidate {
  /** Stable handle shown to the model + used to disambiguate (e.g. "T3"). */
  handle: string;
  type: "task" | "skill_node" | "activity";
  /** The real DB id — stage B emits this only on a confident bind. */
  id: string;
  title: string;
  /** Owning goal/project (for move construction + display). */
  goalId: string;
  goalName: string;
}

export type CheckinResolutionStatus = "resolved" | "ambiguous" | "unresolved";

/** Stage B output — an intent paired with the outcome of binding it. */
export interface ResolvedCheckinIntent {
  intent: CheckinIntent;
  status: CheckinResolutionStatus;
  /** The bound candidate when `resolved`; the top match (shown, but proposed
   *  unchecked) when `ambiguous`; null when `unresolved`. */
  match: CheckinCandidate | null;
  /** Every candidate that matched — length > 1 surfaces the disambiguation
   *  affordance (the firewall against silently picking a winner). */
  candidates: CheckinCandidate[];
}

/** A Family-B (odds-silent) action to confirm — a descriptor the capture bar
 *  dispatches to the matching Server Action. `log_progress` SETs actual time (so
 *  re-submitting is idempotent); it is odds-silent now but the raw material for
 *  future estimation calibration — don't let a "logs are inert" cleanup drop it. */
export type CheckinActionIntent =
  | { kind: "log_progress"; taskId: string; title: string; minutes: number; quote: string }
  | { kind: "capture_idea"; text: string; quote: string }
  | { kind: "acknowledge"; quote: string };

export type CheckinProposalFamily = "A" | "B";

/**
 * Stage C output — one reviewable row. Family A carries a `StrategyMove` that
 * rides S1's review/commit/undo with live re-solved odds; Family B carries an
 * odds-silent `CheckinActionIntent`. Membership is DERIVED (Family A iff the move's
 * `applyMoveToAlloc` arm is non-identity), never a hand list. `defaultChecked`
 * derives from intent confidence + resolution status (high + resolved → true).
 */
export interface CheckinProposal {
  family: CheckinProposalFamily;
  resolved: ResolvedCheckinIntent;
  /** Family A: the move (else null). Family B: the action (else null). */
  move: StrategyMove | null;
  action: CheckinActionIntent | null;
  defaultChecked: boolean;
}

/** The full review surface stage C hands the capture bar: actionable proposals
 *  plus the non-actionable chips (unresolved references + acknowledged vents). */
export interface CheckinReview {
  proposals: CheckinProposal[];
  /** Intents that resolved to nothing actionable — rendered as inert chips
   *  ("Couldn't match 'the thing I built yesterday'") + vent acknowledgements. */
  chips: ResolvedCheckinIntent[];
  rawReport: string;
}

/**
 * Project scope for a task-scoped check-in (§5.6 slice 6a). When a check-in runs
 * bound to a goal (the capture bar on a project page), an `add_task` intent — "I
 * also need to do Y" — becomes a real Family-A `add_tasks` move ON THIS GOAL
 * (forecast-affecting, live-re-solved), instead of the odds-silent standalone
 * capture the global bar produces with no project context. The scope is also the
 * disambiguation: the goal's own entities rank first in the interpret prompt.
 */
export interface CheckinScope {
  goalId: string;
  goalName: string;
  /** Life-area the new task inherits — the goal's modal task area (SuggestedTask
   *  requires one; the strategist's own adds inherit it the same way). */
  area: string;
}
