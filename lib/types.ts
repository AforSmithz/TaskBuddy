// Shared domain types for TaskBuddy.

// Type-only (erased at runtime → no import cycle): the serialized re-solve inputs
// the review screen ships to the client live beside the consumer in `portfolio-state`.
import type { ResolveInput } from "@/lib/portfolio-state";
// Type-only (same erased-cycle reason): the arrangement soft-weight shape, defined
// beside its calibrator in `arrange`; the tuning view contract reports it.
import type { ArrangeWeights } from "@/lib/arrange";
// Type-only (same erased-cycle reason): the recovery lean lives beside the Value
// Model that owns it; the offered-vs-kept row stores which one was in force.
import type { RecoveryStyle } from "@/lib/value-model";

export type Confidence = "High" | "Medium" | "Low";

/** Marked done by hand = self_assessed; strategist auto-complete = inferred; checked
 *  against the definition of done = verified. Tags both tasks and DoD criteria. */
export type CompletionConfidence = "verified" | "self_assessed" | "inferred";

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

export const SEED_AREAS = ["Work", "Personal", "Hobby"];

export type EntryKind = "meeting" | "plan";

/** A `project` is a task DAG + deadline; a `learning` goal is a skill graph +
 *  checkpoints + definition-of-done. Same engine underneath, `kind` just lets the UI
 *  and the decomposer treat them differently. */
export type GoalKind = "project" | "learning";

export const GOAL_KIND_LABELS: Record<GoalKind, string> = {
  project: "Project",
  learning: "Learning",
};

export type EntryStatus = "draft" | "active";

/** Filing choices confirmed in the review step. On the entry form these can all be
 *  "Auto"; review is where they get pinned down. */
export interface DraftClassification {
  area: string;
  projectId: string | null;
  newProjectName: string;
  newProjectKind: GoalKind;
  parentEntryId: string | null;
}

// --- Database row shapes ----------------------------------------------------

/** A goal - the spine of the app. Owns its tasks directly via Task.goal_id. Entries are
 *  a provenance link, not the structural parent. */
export interface Goal {
  id: string;
  user_id?: string | null;
  name: string;
  description: string | null;
  kind: GoalKind;
  /** The "finish line" the completion forecast is computed against. */
  deadline: string | null;
  created_at: string;
}

/** One line of a goal's definition of done. The goal is complete when criteria are
 *  non-empty AND all met (derived, never stored). */
export interface GoalCriterion {
  id: string;
  goal_id: string;
  text: string;
  met: boolean;
  met_confidence: CompletionConfidence | null;
  /** How a scope cut lowered this criterion's ambition ("now: managed provider, no
   *  SSO"), or null while intact. `text` stays verbatim so a goal can't be quietly
   *  redefined down. */
  degraded_note: string | null;
  sort_index: number;
  created_at: string;
}

/** Derived completion read (see lib/goal.ts). `complete` = criteria non-empty and all
 *  met; `verified` = complete and every met criterion verified; `confidence` is the
 *  weakest across met criteria. */
export interface GoalCompletion {
  complete: boolean;
  verified: boolean;
  confidence: CompletionConfidence | null;
  metCount: number;
  total: number;
}

/** One capability in a learning goal's skill graph. `prerequisites` are node ids that
 *  must come first (a DAG). Checkpoints drive SKILL progress while every node's effort
 *  drives EFFORT progress - the two diverge when you've put in hours but not yet hit a
 *  milestone. */
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
  /** Parked out of the current deadline push (the `defer_skill` recovery move).
   *  Not attained, still on the goal, reversible - the skill analogue of
   *  `Task.deferred`. Stops consuming forecast() budget while set. */
  deferred: boolean;
  deferred_at: string | null;
  sort_index: number;
  created_at: string;
}

/** Lifecycle of a proposed skill-node ↔ task link. Only `confirmed` drives a
 *  spillover move; `dismissed` is remembered so the linker stops re-proposing it. */
export type SkillTaskLinkStatus = "suggested" | "confirmed" | "dismissed";

/** An explicit "these two are the same work" edge between a skill node and a task.
 *  Title similarity can't find these - "Set up the auth provider" vs "Set up
 *  authentication with a provider" share almost no words, and 0 of 81 real pairs
 *  cleared the matcher's bar. So it's LLM-proposed and user-confirmed, and spillover
 *  reads it as a lookup rather than a guess. */
export interface SkillTaskLink {
  id: string;
  skill_node_id: string;
  task_id: string;
  status: SkillTaskLinkStatus;
  /** The model's one-line why, shown verbatim on the confirm surface. */
  rationale: string | null;
  created_at: string;
}

/** One link the LLM proposes, by the handles it was shown (`N1`, `T3`). `task_key` is
 *  absent in the preferred task-keyed response shape (the map key carries it). */
export interface ExtractedLink {
  node_key: string;
  task_key?: string;
  rationale: string;
}

/** The linker's raw response, before key resolution + sanitization.
 *
 *  The prompt asks for a TASK-KEYED MAP: unique JSON keys make "one skill per task"
 *  structurally impossible. Asked for a flat array the model fans out - it attached all
 *  8 skills of a graph to one weekly lesson. The array shape is still accepted so a
 *  schema-ignoring model doesn't kill the feature; normalizeLinks collapses it. */
export type LinkSuggestion =
  | { links: Record<string, ExtractedLink | null> }
  | { links: ExtractedLink[] };

/** Second-pass verdict on ONE pair, judged in isolation. Shown a menu of skills the
 *  model distributes ALL of them - observed twice, inventing a rationale wherever each
 *  landed. The bias is toward using up the menu, not toward truth, so judging one pair
 *  with no menu in context removes the pressure. */
export interface LinkVerdict {
  demonstrates: boolean;
  why?: string;
}

/** Derived progress for a learning goal (see lib/skill.ts). Effort progress (minutes
 *  attained / total) and skill progress (checkpoints met / total, falling back to nodes)
 *  are separate, because grinding hours isn't reaching a milestone. `unlocked` is the
 *  actionable frontier. */
export interface SkillProgress {
  total: number;
  attained: number;
  checkpointsTotal: number;
  checkpointsMet: number;
  effortMinutesDone: number;
  effortMinutesTotal: number;
  /** 0 - 1: minutes attained over total. */
  effortPct: number;
  /** 0 - 1: checkpoints met over total (or nodes attained when no checkpoints). */
  skillPct: number;
  /** Ids of unattained nodes whose prerequisites are all attained. */
  unlocked: string[];
}

export interface Entry {
  id: string;
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

/** Where a task came from, when that changes how it's treated. "debt" is a follow-up
 *  materialized by a scope cut - work owed after the deadline rather than erased. Free
 *  text so new origins don't need a migration. */
export type TaskOrigin = "debt";

export interface Task {
  id: string;
  entry_id: string;
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
  completion_confidence: CompletionConfidence | null;
  completed_at: string | null;
  /** Provenance when it changes treatment - `"debt"` for a scope-cut follow-up. */
  origin: TaskOrigin | null;
  /** How a blocker was resolved when reported through a check-in - free text like "Used
   *  a template". Display only, never a number or an id. */
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

export interface Availability {
  id?: string;
  user_id?: string | null;
  weekday: number;
  hours: number;
}

export interface AvailabilityOverride {
  id?: string;
  user_id?: string | null;
  date: string; // ISO date
  hours: number;
}

export interface Commitment {
  id: string;
  user_id?: string | null;
  date: string; // ISO date
  hours: number;
  label: string | null;
  created_at: string;
}

// --- Recurring activities (goals & routines) --------------------------------

export type ActivityCadencePeriod = "day" | "week";

/** The primitive behind both routines/habits and weekly goals. Drains the shared budget
 *  and emits a "do it" instance when due. Success/miss is DERIVED from the completion
 *  log (lib/recurring.ts), never stored. */
export interface RecurringActivity {
  id: string;
  user_id?: string | null;
  title: string;
  area: string;
  period: ActivityCadencePeriod;
  target_count: number;
  /** Restrict to certain weekdays (0=Sun..6=Sat); null = any eligible day. */
  weekdays: number[] | null;
  /** Minutes per session - the per-instance drain on the time budget. */
  estimated_minutes: number;
  // 1-5 factor ratings, same scale as tasks - score the synthetic queue instance.
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

/** One logged session (or skip) of a recurring activity. A skip resolves the period's
 *  obligation - stops draining budget, stops nagging - but doesn't count toward a
 *  streak. All streak state derives from these rows. */
export interface ActivityCompletion {
  id: string;
  user_id?: string | null;
  activity_id: string;
  date: string; // ISO YYYY-MM-DD the session was logged for
  minutes: number;
  skipped: boolean;
  created_at: string;
}

/** Local time-of-day bucket: early 05-09, morning 09-12, afternoon 12-17, evening
 *  17-22, night 22-05. Captured from the user's LOCAL clock at write time, never
 *  re-derived from a stored UTC instant. */
export type TimeWindow = "early" | "morning" | "afternoon" | "evening" | "night";

/** One work session - the WHEN signal the rest of the data lacks. `completed_at` is a
 *  single UTC "marked done" instant and `actual_minutes` is a cumulative total, so
 *  neither says when you actually worked. Records the local window + weekday + the day
 *  it counts for. Task effort XOR routine session. */
export interface WorkSession {
  id: string;
  user_id?: string | null;
  task_id: string | null;
  activity_id: string | null;
  /** ISO YYYY-MM-DD - the local day the work counts for. */
  logged_for: string;
  time_window: TimeWindow;
  /** 0=Sun..6=Sat, local. */
  weekday: number;
  /** This session's real length; 0 for a length-less completion event. */
  minutes: number;
  kind: "progress" | "complete";
  created_at: string;
}

/** The client-captured local stamp a completion passes to its server action. The action
 *  runs server-side and can't read the browser clock, so the client has to supply it.
 *  Built by localSessionStamp() in lib/work-session.ts. */
export interface WorkSessionLocal {
  time_window: TimeWindow;
  weekday: number;
  logged_for: string;
}

export type RecurringStatus = "met" | "due" | "missed" | "cold";

export interface RecurringState {
  activity: RecurringActivity;
  status: RecurringStatus;
  /** Consecutive eligible periods met, walking back from today (habit streak). */
  streak: number;
  progress: { done: number; target: number };
  doneToday: boolean;
  /** An instance is owed today (eligible day, period not yet met, not done). */
  dueToday: boolean;
}

// --- Forecast (the completion-probability engine) ---------------------------

/** The probability at or above which a project is "on track". One shared definition so
 *  the meter, the pill and the divergence detector draw the line in the same place. */
export const ON_TRACK_PROBABILITY = 0.8;

/** Compared on the same ROUNDED percentage the user sees, so something displaying as
 *  "80%" reads as on track everywhere with no off-by-a-rounding-step edge case. */
export function isOnTrack(probability: number): boolean {
  return Math.round(probability * 100) >= Math.round(ON_TRACK_PROBABILITY * 100);
}

export interface ForecastResult {
  /** P(finish all open work before the deadline), 0 - 1. */
  probability: number;
  /** Point-estimate remaining work, minutes. */
  expectedMinutes: number;
  deployableMinutes: number;
  /** deployable − expected; negative means over budget. */
  slackMinutes: number;
  openTaskCount: number;
  /** 80% central interval of remaining work, from the same Monte Carlo that prices the
   *  odds. p50/p90 anchor the critical-chain buffer (lib/buffer.ts): the gap between the
   *  safe and median outcome is the margin the variance demands. All 0 with no open work. */
  p10Minutes: number;
  p50Minutes: number;
  p90Minutes: number;
}

/** Learned estimation bias. True duration is modelled as `estimate × factor`, where
 *  log(factor) is normal with mean `meanLog` and sd `sigma`. meanLog > 0 means you run
 *  over your estimates. */
export interface EstimationModel {
  meanLog: number;
  /** Std dev of `log(actual / estimated)` - how spread out your estimation error is. */
  sigma: number;
  sampleSize: number;
}

/** The forecast-facing slice of an estimation model - just the log-space bias + spread
 *  the Monte Carlo samples with. The per-task velocity model rides this shape so a task
 *  can carry its own segment-shrunk bias instead of the one global scalar. */
export interface SegmentModel {
  meanLog: number;
  sigma: number;
}

/** Below this many samples we don't trust a fitted model - fall back to defaults. */
export const MIN_ESTIMATION_SAMPLES = 5;

export interface RecoveryMove {
  taskId: string;
  title: string;
  /** Probability if this task were deferred past the deadline. */
  probabilityAfter: number;
}
/** A learning goal's per-skill recovery move: park a non-checkpoint node to make
 *  the checkpoints + deadline fit. Mirrors `RecoveryMove` but keyed by node. */
export interface SkillRecoveryMove {
  nodeId: string;
  title: string;
  probabilityAfter: number;
}
/** Re-phase a frontier milestone chain out of the current push. Unlike SkillRecoveryMove
 *  (one optional leaf) this parks a checkpoint together with the prereqs that exist ONLY
 *  to serve it, so the goal can commit to fewer milestones and slide the rest. */
export interface SkillPathRescheduleMove {
  /** The descoped checkpoint (the milestone that slides out of the push). */
  checkpointId: string;
  checkpointTitle: string;
  /** The full strand-free park-set (checkpoint + its exclusive open prereqs). */
  nodeIds: string[];
  titles: string[];
  probabilityAfter: number;
}

export interface ProjectForecast extends ForecastResult {
  projectId: string;
  projectName: string;
  deadline: string | null;
}

export interface PitCall {
  projectId: string;
  projectName: string;
  probabilityBefore: number;
  probabilityAfter: number;
  moves: RecoveryMove[];
  reschedule: RescheduleMove | null;
}

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

/** The diagnosed CAUSE behind a divergence, one level below the symptom-level
 *  DivergenceReason. Picks the response class so the strategist doesn't reflexively cut
 *  scope over a one-off slip. Computed from residuals + a temporal baseline; the LLM
 *  may narrate it but never decides it. */
export type DivergenceCause =
  | "one_off_slip" // a single task blew up; the underlying pace is fine
  | "chronic_velocity" // estimates are systematically low - a pattern, not an event
  | "timing_placement" // the overrun is the low-energy WINDOWS worked in, not the estimates (S2)
  | "constraint_change" // the world moved since the plan was made
  | "scope_structural"; // simply too much committed work for the time

export interface CauseDiagnosis {
  cause: DivergenceCause;
  /** Human-readable explanation - computed from signals, never authored by the LLM. */
  detail: string;
}

/** The cost to the GOAL, not just the deadline, shown beside a move's odds gain. A
 *  deadline-buying cut can lift the odds while doing nothing for the goal's reason for
 *  being. Computed from goalCompletion/skillProgress so vibe-cutting can't hide behind a
 *  green number. */
export interface GoalCutCost {
  kind: GoalKind;
  criteriaUnmet: number;
  criteriaTotal: number;
  checkpointsMet: number;
  checkpointsTotal: number;
  skillPct: number;
  detail: string;
}

export interface RescheduleMove {
  /** ISO date of the earliest achievable deadline. */
  deadline: string;
  probabilityAfter: number;
}

/** Deterministic moves that would put an off-track project back on track. Always
 *  surfaced for approval, never auto-applied. */
export interface RecoveryPlan {
  projectId: string;
  projectName: string;
  currentProbability: number;
  reasons: DivergenceReason[];
  /** The diagnosed cause. Null when the project is flagged for attention but not
   *  genuinely off track (a blocked/overdue warning has no divergence to explain). */
  cause: CauseDiagnosis | null;
  /** What a deadline-buying move costs the goal itself - unmet DoD or skill milestones.
   *  Null when there's nothing to measure against. */
  goalCost: GoalCutCost | null;
  defer: RecoveryMove[];
  /** Park these non-checkpoint skill nodes (learning goals) to recover; best
   *  improvement first. Empty for project goals and for goals with no sheddable
   *  skill effort. */
  deferSkill: SkillRecoveryMove[];
  /** Milestone chains to re-phase out of the current push, best improvement first. Empty
   *  for project goals, and when nothing can slide without stranding a kept milestone. */
  rescheduleSkill: SkillPathRescheduleMove[];
  /** Earliest deadline clearing the target probability, or null if out of reach. */
  reschedule: RescheduleMove | null;
  /** Dependency-aware order to tackle the remaining open work (advisory). */
  sequence: { taskId: string; title: string }[];
  overdue: { taskId: string; title: string; dueDate: string | null }[];
  blocked: { taskId: string; title: string; blockedBy: string | null }[];
}

// --- LLM extraction shape (what the model is asked to return) ---------------

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
  depends_on: string[];
  priority_reason: string;
}

export interface ExtractionResult {
  title: string;
  summary: string;
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

/** One skill the decomposer proposes. `key` is a stable slug so `prerequisites` can
 *  reference other skills, mapped to UUIDs on persist like extracted-task depends_on. */
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

export interface SkillDecomposition {
  skills: ExtractedSkill[];
}

// --- LLM strategist (corrective task generation) ----------------------------

export type GapKind = "rework" | "unblock" | "de_risk";

/** A net-new corrective task for an off-track project - rework after a failed review, an
 *  unblock, or de-risking a task that's blowing its estimate. Same 1-5 factor ratings as
 *  an extracted task so it scores through computePriority. */
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

/** Strategist output for one off-track project: net-new tasks plus the probability the
 *  project would have with them. The probability always comes from forecast(). */
export interface RecoverySuggestion {
  projectId: string;
  tasks: SuggestedTask[];
  previewProbability: number;
  rationale: string;
}

// --- LLM strategist (existing-task modification) ----------------------------

/** "scope_down" replaces a task with a lighter version. "split" breaks a stuck monolith
 *  into real steps - which helps even at equal total minutes, because several understood
 *  estimates carry less compounding risk than one big opaque guess. */
export type ModificationKind = "scope_down" | "split";

/** One piece of reshaped work. Carries its own estimate + factor ratings so it scores
 *  through computePriority like an extracted task. */
export interface ModificationPart extends FactorScores {
  title: string;
  description: string;
  estimated_minutes: number;
  priority_reason: string;
}

/** `replacements` is the work that takes the task's place: exactly one for scope_down,
 *  two or more for split. */
export interface TaskModification {
  kind: ModificationKind;
  taskId: string;
  taskTitle: string;
  originalEstimate: number;
  rationale: string;
  replacements: ModificationPart[];
}

/** Strategist output: existing tasks reshaped to fit the budget, plus the resulting
 *  probability. As with Generate, the number comes from forecast(). */
export interface ModificationSuggestion {
  projectId: string;
  modifications: TaskModification[];
  previewProbability: number;
  rationale: string;
}

// --- LLM strategist (whole-plan re-route) -----------------------------------

/** One task in an alternative plan. Like SuggestedTask minus the gap/area bookkeeping
 *  the whole plan shares one area, applied on accept. */
export interface ReroutePart extends FactorScores {
  title: string;
  description: string;
  estimated_minutes: number;
  due_date: string | null;
  blocked_by: string | null;
  priority_reason: string;
}

/** A DoD criterion a reroute explicitly compromises, plus the note recording how. The
 *  LLM may author the note, but `criterionId` is validated against the goal's real
 *  criteria. Stored as the criterion's degraded_note on accept. */
export interface DegradedCriterion {
  /** The real criterion being lowered (validated against the goal's DoD). */
  criterionId: string;
  text: string;
  note: string;
}

/** The boldest move: a complete alternative plan hitting the same deliverable a
 *  different way (buy vs build, managed service vs custom). Replaces the whole open
 *  plan as an all-or-nothing draft, not a per-task pick. */
export interface RerouteSuggestion {
  projectId: string;
  approach: string;
  rationale: string;
  tasks: ReroutePart[];
  /** Current open tasks this plan swaps out (deferred on accept), for the before/after. */
  replaces: { taskId: string; title: string; estimated_minutes: number }[];
  /** DoD criteria this lighter route lowers, and how. Empty when it preserves the full
   *  bar. Shown in the before/after so the odds gain can't hide a quiet redefinition. */
  degradedCriteria: DegradedCriterion[];
  previewProbability: number;
}

// --- Pit-wall strategist (global, cross-project allocation) -----------------

/** One task's place in the single global order. Derived on top of the stored
 *  priority_score, never overwriting it: dependency topo-sort, then EDF by project
 *  deadline with WSJF as tiebreak (WSJF-first under overload). `pulledAhead` marks a
 *  task that leapfrogged higher-scored work because its own deadline is closer. */
export interface EffectiveOrderEntry {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  estimatedMinutes: number;
  rank: number;
  pulledAhead: boolean;
  /** Human-readable reason for the placement (e.g. "pulled ahead - Goal X due in 2 days"). */
  reason: string;
  /** This task's segment-shrunk (meanLog, sigma), so the joint sampler biases each task
   *  by its own domain velocity. Absent => the global scalar. */
  model?: SegmentModel;
  /** Cognitive load in [0,1]. The comfort-capped flow meters each day's hard minutes
   *  (difficulty × sampled duration) against the daily cap. Absent => unmetered. */
  difficulty?: number;
  /** Impact 1-5. Modulates ONLY the energy-placement term in arrange.ts, so high-value
   *  hard work gets first claim on fast windows. Never the comfort cap - that's
   *  cognitive load alone. Inert without a learned window profile. */
  impact?: number;
  /** Life-area. The within-day sequencer keeps same-area work adjacent, a coarser axis
   *  than projectId. Odds-neutral (it's a within-day permutation). */
  area?: string;
}

/** A pit-wall conflict: a project that can't finish in time, or two whose deadlines
 *  collide over the shared hours. */
export interface Conflict {
  kind: "infeasible" | "deadline_collision";
  projectId: string;
  projectName: string;
  detail: string;
}

/** Shed a low-value task to recover savable high-value work under overload. `wsjf` is
 *  the density it was chosen by; `probabilityAfter` comes from the forecast(). */
export interface TriageMove {
  taskId: string;
  title: string;
  projectId: string;
  estimatedMinutes: number;
  wsjf: number;
  probabilityAfter: number;
}

/** One way to resolve a comparable-value tie - the single escalated decision auto-triage
 *  refuses to make: protect one colliding project by shedding the others' open work.
 *  Surfaced only when PitWall.needsDecision. */
export interface PitWallOption {
  protectId: string;
  protectName: string;
  sacrificeNames: string[];
  sacrificeTaskIds: string[];
  /** Protected project's joint odds once the sacrifice set is shed. */
  probabilityAfter: number;
}

// --- Portfolio strategist (one cached, time-aware recommendation) -----------

/** Every move the portfolio strategy can recommend, 1:1 with an apply action. `hold` is
 *  the no-op "stay the course" outcome. */
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
  // Park a non-checkpoint skill node past the deadline (the learning-goal analogue
  // of `defer`). Sheds its effort from the current push so the checkpoints + date
  // fit; reversible. NEVER sheds a checkpoint (that would abandon a milestone).
  | "defer_skill"
  // Re-phase a whole milestone CHAIN - the learning-goal analogue of a scoped reschedule.
  // The middle lever between defer_skill (one optional leaf) and reschedule_deadline
  // (push the whole goal date). Unlike defer_skill it may touch a checkpoint, which is
  // surfaced via goalCost.
  | "reschedule_skill"
  // Resolve a structural blocker: mark done + cascade one-hop edge removal + stamp
  // provenance. Distinct from `unblock`, which clears the SOFT blocked_by flag on one
  // dependent.
  | "resolve_blocker"
  | "skip_activity"
  | "hold";

/** Arguments an apply action needs, discriminated by `kind`. Carries the FULL struct
 *  rather than a reference so a cached strategy applies without re-deriving it - a
 *  stale id just no-ops. */
export type StrategyMovePayload =
  | { kind: "defer"; taskId: string; title: string }
  | { kind: "reschedule_deadline"; deadline: string }
  | { kind: "reschedule_task"; taskId: string; title: string; dueDate: string }
  | { kind: "unblock"; taskId: string; title: string }
  | {
      kind: "mark_done";
      taskId: string;
      title: string;
      /** Provenance of the completion ( invariant: a pure function of WHERE the
       *  move came from). A check-in "I finished X" → `self_assessed`; omitted by the
       *  strategist's own inference → defaults to `inferred` in persist. */
      confidence?: CompletionConfidence;
      /** Set when this completion was INFERRED from attaining a LINKED skill node
       *  (`skill_task_links`) - the id of that node. Mirrors `attain_skill`'s field. */
      viaSpilloverFrom?: string;
      /** Free-text provenance written to `tasks.resolved_by` ("Credited via spillover
       *  from …"). Absent on a plain mark_done, which must not clear the column. */
      resolvedBy?: string;
    }
  | {
       // the user attained a skill node (drops its synthetic forecast() task).
      kind: "attain_skill";
      goalId: string;
      nodeId: string;
      title: string;
      /** `self_assessed` for a stated check-in skill; `inferred` for spillover. */
      confidence: CompletionConfidence;
      /** Set when this attainment was INFERRED from attaining an overlapping node
       *  in another goal - the spillover provenance (no DB column; lives here). */
      viaSpilloverFrom?: string;
    }
  | {
  // Persist marks the blocker done, deletes every edge INTO it, and stamps resolved_by.
  // freedTaskIds is advisory display only - persist re-derives from the live DAG.
      kind: "resolve_blocker";
      blockerTaskId: string;
      title: string;
      /** `self_assessed` for a check-in resolution (the user said it); the invariant. */
      confidence: CompletionConfidence;
      /** Free-text "how" ("Used a template"), or null for a plain resolution. */
      resolvedBy: string | null;
      /** The blocker's direct dependents at generation time - display only. */
      freedTaskIds: string[];
    }
  | {
  // Park a non-checkpoint skill node. Persist sets skill_nodes.deferred; the forecast()
  // twin drops its synthetic task, freeing the budget - same drop as attain_skill but
  // semantically parked, not done.
      kind: "defer_skill";
      goalId: string;
      nodeId: string;
      title: string;
    }
  | {
  // Park a frontier checkpoint plus its whole strand-free park-set. The full set rides
  // on the payload so a cached strategy applies without re-deriving the closure.
      kind: "reschedule_skill";
      goalId: string;
      nodeId: string;
      title: string;
      parkNodeIds: string[];
      parkTitles: string[];
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

/** One recommended move. `rationale` is prose (LLM or template); `probabilityAfter` is
 *  ALWAYS harvested from a forecast()-scored struct, never authored. */
export interface StrategyMove {
  kind: StrategyMoveKind;
  /** Owning project, or "" for cross-project triage. */
  projectId: string;
  projectName: string;
  rationale: string;
  /** The odds this move restores ON ITS OWN - solo per-project, from `forecast()`/`jointOdds`. */
  probabilityAfter: number;
  /** Cumulative portfolio odds after this move AND every move before it. Climbs to
   *  combinedProbability at the last one. Baked in at generation; rendered verbatim. */
  portfolioProbabilityAfter: number;
  /** Titles of existing open tasks this move defers out of the plan. Set for moves that
   *  shed real work (reroute, split's monolith, triage); omitted for those that don't.
   *  Full snapshots so the card renders the same detailed rows as the project page. */
  defers?: Task[];
  /** The cause(s) this move served, baked in at generation. Calibration bookkeeping,
   *  never displayed - it lets an applied bundle record the offer-time φ inputs without
   *  re-running the scorer just to log. Absent => a zero cause term. */
  causes?: CauseWeight[];
  payload: StrategyMovePayload;
}

/** The portfolio-wide recommendation on Today: a narrative assessment plus an ordered
 *  set of applyable moves. Cached, regenerated when the situation changes. */
export interface PortfolioStrategy {
  assessment: string;
  /** True ⇒ hold course; `moves` may be empty. */
  onTrack: boolean;
  moves: StrategyMove[];
  /** ISO timestamp - anchor for plan-vs-time drift continuity AND the age-based staleness gate. */
  generatedAt: string;
  /** Situation hash this strategy was generated for (see `computeSituationFingerprint`). */
  fingerprint: string;
  /** Per-project odds at generation time. The staleness gate diffs current odds against
   *  this, so only a change that materially moves them marks the strategy stale - the
   *  cheap pre-filter before any LLM call. */
  odds: Record<string, number>;
  /** False = deterministic fallback (no key / call failed). */
  usedLLM: boolean;
  /** Combined odds after applying every move. Equals the last move's
   *  portfolioProbabilityAfter. Surfaced at "Apply all". */
  combinedProbability: number;
  /** The grounded "steady plan" tier: mechanical-only moves picked by the joint greedy
   *  optimizer, beside the bold LLM recommendation. Null when there's nothing mechanical
   *  to do, or in the no-LLM fallback where the bold tier already IS the joint plan. */
  grounded: {
    moves: StrategyMove[];
    combinedProbability: number;
  } | null;
  /** The serialized gather slice that lets the review screen re-solve an arbitrary move
   *  subset client-side, so toggling a move recomputes the odds with no round-trip.
   *  Optional: the instant draft and older cached strategies carry none. */
  resolveInput?: ResolveInput;
}

/** Enough to revert one applied bundle. Snapshotted per BUNDLE, not per move, matching
 *  the bundle-level undo. `tasks`/`goals` hold PRIOR values (id + only the changed
 *  fields); the inserted-id arrays name synthetic rows to delete on undo. */
export interface RowSnapshot {
  /** Prior values of tasks the bundle mutated - id + only the changed fields. */
  tasks: (Partial<Task> & { id: string })[];
  goals: (Partial<Goal> & { id: string })[];
  /** Prior attainment of skill nodes an `attain_skill` move flipped - id +
   *  attained/confidence/at - so undo reverts a skill back to unattained. */
  skillNodes: (Partial<SkillNode> & { id: string })[];
  /** Synthetic task rows the bundle inserted (add_tasks / reshape-split / scope-down
   *  debt / reroute) - deleted on undo. */
  insertedTaskIds: string[];
  /** Synthetic recovery entries the inserted tasks were filed under - deleted on undo
   *  so an undone bundle leaves no dangling empty entry. */
  insertedEntryIds: string[];
  activityCompletionIds: string[];
  /** Edges a resolve_blocker cascade deleted - full rows, so undo re-inserts the
   *  originals byte-identically. Rows written before this read `?? []`. */
  deletedDependencies: TaskDependency[];
}

/** One applied bundle with the odds the user accepted and a restore snapshot. Every
 *  "Apply" writes one; the history view lists them and undo replays `restore`. Capped
 *  at 50 per user. */
export interface PlanVersion {
  id: string;
  createdAt: string;
  reason: string;
  moves: StrategyMove[];
  oddsBefore: number;
  /** The previewed combined odds the user accepted. */
  oddsAfter: number;
  /** Prior values + inserted ids - enough to revert the whole bundle. */
  restore: RowSnapshot;
  /** Set when undone; null while the bundle stands. */
  revertedAt: string | null;
}

// --- Rolling-horizon wrapper ----------------------------------------

/** Bump when the persisted CommittedPlan shape changes, so a stale row is invalidated
 *  (treated as "no committed plan") rather than mis-replayed. */
export const COMMITTED_PLAN_SCHEMA_VERSION = 1;

/** The plan the user is currently following - the state the rolling-horizon wrapper
 *  applies hysteresis against, so a reload doesn't thrash the imminent day for a
 *  marginal soft gain. One row per user. Authors NO odds and adds no arrangement
 *  quality: it only decides which already-priced arrangement to keep committing to.
 *  See design/s3c-rolling-horizon-wrapper.md. */
export interface CommittedPlan {
  schemaVersion: number;
  /** The committed cross-project order - the ARRANGED, gated order the user follows,
   *  not the canonical one. */
  order: EffectiveOrderEntry[];
  /** `todayISO()` at commit time - the frozen-zone (anchor) day. A date-granular roll
   *  fires when this advances; the read path tolerates a stale anchor safely. */
  anchor: string;
  /** Situation fingerprint at commit (see `rollFingerprint`), folding open-task
   *  membership, bucketed deadlines, the window/velocity generation, comfort + value
   *  model. An unchanged fingerprint + anchor ⇒ nothing material moved ⇒ stay put. */
  fingerprint: string;
  /** The committed arrangement's soft score `J` (from `arrangementScore`) - the
   *  quantity the stability gate weighs the fresh candidate's improvement against. */
  j: number;
  committedAt: string;
}

/** A local instant captured CLIENT-side. The scheduler is deliberately clock-free
 *  everywhere else (day-granular capacity, no stored timezone); the intra-day frozen
 *  zone is the one place a real "now" is needed, and the client knows its own offset so
 *  it captures its local time rather than the server guessing from a UTC instant.
 *  Passed per request, never stored. Absent => date-granular behaviour. */
export interface LocalNow {
  /** The client's local calendar day, `YYYY-MM-DD`. Compared against the plan's frozen-zone
   *  anchor; a mismatch (midnight rollover / travel / skew) ⇒ date-granular fallback. */
  date: string;
  /** Minutes since local midnight, `0..1439`. How far into today we are - the signal that
   *  slips the frozen zone forward through the day. */
  minutesSinceMidnight: number;
}

// --- Rolling-horizon history ----------------------------------------

/** Why a passive roll fired, for narration. `material` = the stability gate let a better
 *  candidate through; `anchor` = the date advanced and the near part re-froze; `initial`
 *  = first-ever commit, so prevJ is null. Free text so a new roll kind needs no
 *  migration; validated in TS. */
export type PlanRollKind = "material" | "anchor" | "initial";

/** One retained automatic roll. Where CommittedPlan is the single CURRENT plan, this is
 *  a capped history entry appended each time it actually rolls. Sibling to PlanVersion,
 *  not an overload: PlanVersion undoes ROW mutations, a PlanRoll retains an ARRANGEMENT
 *  whose undo restores a prior order through reconcile + re-price, so it can never
 *  resurrect a completed task. Capped at 50 per user. */
export interface PlanRoll {
  id: string;
  rolledAt: string;
  /** The committed plan's frozen-zone (anchor) day at roll time (CommittedPlan.anchor). */
  anchor: string;
  fingerprint: string;
  j: number;
  kind: PlanRollKind;
  /** The superseded arrangement's `J`; null for the first-ever commit (`initial`). */
  prevJ: number | null;
  /** The order this roll retained. A roll-undo feeds it back through reconcile as a
   *  preference seed, never restored verbatim as truth. Column is `plan_order`. */
  order: EffectiveOrderEntry[];
  /** Set when this roll is undone; the entry stays in history (struck-through). Null while it stands. */
  revertedAt: string | null;
  /** Reuse {@link COMMITTED_PLAN_SCHEMA_VERSION}: a row whose version doesn't match
   *  the current `order` shape is treated as invalid, like a stale CommittedPlan. */
  schemaVersion: number;
}

/** One captured drag-to-reorder of today's plan - the signal for the arrange-weight
 *  calibration tier. The reorder is applied silently and odds-gated, so nothing normally
 *  reveals which dial the user would have turned; a drag does. Kept as a
 *  revealed-preference PAIR (userOrder ≻ appOrder), recorded ONLY when the drag is
 *  odds-neutral - an odds-worsening drag is honored but never taught from. The client
 *  records an ORDER and nothing more; the server reconciles, re-prices and gates. */
export interface PlanReorder {
  id: string;
  date: string;
  capturedAt: string;
  /** The solver's own arrangement at capture time - the order the user dragged AWAY
   *  from. Column is `app_order`. */
  appOrder: EffectiveOrderEntry[];
  userOrder: EffectiveOrderEntry[];
  /** Reuse {@link COMMITTED_PLAN_SCHEMA_VERSION}: a row whose version doesn't match
   *  the current order shape is treated as invalid (dropped), like a stale roll. */
  schemaVersion: number;
}

// --- Offered-vs-kept move signal ---

/** Bumped when {@link OfferedMove} changes shape, so a stale row is dropped rather
 *  than mis-read. Mirrors `COMMITTED_PLAN_SCHEMA_VERSION`'s role for orders. */
export const MOVE_CHOICE_SCHEMA_VERSION = 1;

/** One move the strategist offered, and whether it survived the user's checkboxes.
 *  Stores the INPUTS to the preference vector φ - the move kind and the diagnosed
 *  cause(s) - never φ itself, so editing the preference tables re-prices the whole
 *  history. */
/** A diagnosed cause and the goalValue × risk weight its goal carried. Single-goal moves
 *  have one entry; a portfolio-wide move carries one per goal so the offer-time
 *  aggregation replays exactly. */
export interface CauseWeight {
  cause: DivergenceCause | null;
  weight: number;
}

export interface OfferedMove {
  kind: StrategyMoveKind;
  projectId: string;
  /** The cause(s) this move served at offer time. Empty ⇒ a zero cause term. */
  causes: CauseWeight[];
  kept: boolean;
}

/** One applied bundle as a revealed preference over move FAMILIES: what the user kept is
 *  preferred to what they declined. Only the strategist's own review surface writes
 *  these - check-in bundles are user-asserted facts with no diagnosed cause, so they
 *  carry no taste signal. */
export interface MoveChoice {
  id: string;
  capturedAt: string;
  /** The recovery style in force when the bundle was offered - an INPUT to φ, so it
   *  is stored rather than read live (the offer was made under this lean). */
  recoveryStyle: RecoveryStyle;
  offered: OfferedMove[];
  schemaVersion: number;
}

/** Read-only view of how the calibration seam has tuned the soft knobs to the user's
 *  behaviour. Every value is computed server-side. Both tiers start at their default and
 *  only sharpen off real evidence, so a fresh account shows defaults everywhere. */
export interface PlanTuning {
  arrange: {
    weights: ArrangeWeights;
    /** The default (no-data) weights `{1,1,1,1}` - the baseline "how far it moved" reads against. */
    prior: ArrangeWeights;
    /** How many odds-neutral drag observations the weights were learned from. */
    samples: number;
    /** Whether a time-of-day window profile is learned. The energy + buffer dials CANNOT move
     *  without one (their feature terms are identically 0), so the surface says so honestly. */
    windowLearned: boolean;
  };
  stability: {
    stabilityMargin: number;
    churnCost: number;
    /** The documented defaults, for the "× stiffer than default" read. */
    priorMargin: number;
    priorCost: number;
    materialRolls: number;
    /** How many of those you undid - the churn-regret signal that stiffens the knobs. */
    reverts: number;
  };
  /** The recovery-taste weights, learned from the offered-vs-kept move history:
   *  how much the user's recovery STYLE vs the diagnosed CAUSE arbitrates a sub-epsilon
   *  odds tie between two recovery moves. These never override real odds. */
  movePrefs: {
    style: number;
    cause: number;
    /** The co-equal `1.0 / 1.0` prior both shrink toward - the "how far it moved" baseline. */
    priorStyle: number;
    priorCause: number;
    /** Bundles that revealed a contrast (kept some, declined some). Keep-all / decline-all
     *  reveals nothing, so it is not counted. */
    samples: number;
    /** Under the `balanced` style every movePref is 0, so φ[0] ≡ 0 and the STYLE weight
     *  can never move off its prior. False => the surface says the dial is inert instead
     *  of showing a frozen number as if it were a reading. */
    styleLearnable: boolean;
  };
}

// --- NL check-in / reflection loop -------------------------------------
//
// interpret -> propose -> review -> commit over a free-form activity report.
// Interpret is three stages so the LLM never authors a binding:
//   A - interpretCheckin()   (LLM): NL -> ungrounded quoted intents
//   B - resolveCheckin()     (deterministic): bind quotes to live entities
//   C - proposeFromCheckin() (deterministic): resolved intents -> StrategyMove[];
//                             odds always from jointOddsWithMoves
//
// Two extra invariants: no move without a resolved entity AND a verbatim source quote
// (blocks fabrication and the injection vector of acting on an entity the user never
// named), and CompletionConfidence is a pure function of move PROVENANCE, never of any
// model confidence score - those gate review presentation only.

export type CheckinRegister = "status" | "idea" | "vent";

/** What one clause wants to do. Family A (forecast-affecting): completed, reschedule,
 *  add_task, skill_gained. Family B (odds-silent): time_logged, idea. `vent` maps to no
 *  move at all. */
export type CheckinIntentKind =
  | "completed" // → mark_done (or resolve_blocker when the task is a blocker, slice 6b)
  | "reschedule" // → reschedule_task / defer
  | "add_task" // → add_tasks
  | "skill_gained" // → attain_skill (the one new move kind, slice 4)
  | "resolved" // → resolve_blocker (blocker) / unblock (dependent) by DAG role (slice 6b)
  | "time_logged" // → log_progress (Family B)
  | "idea" // → quick capture (Family B)
  | "vent"; // → acknowledge only (no move)

/** Model/resolution confidence - gates REVIEW PRESENTATION only (high → checked
 *  by default, low → proposed unchecked). NEVER feeds CompletionConfidence. */
export type CheckinConfidence = "high" | "low";

/** Stage A output - one UNGROUNDED intent. References entities only by a verbatim quote
 *  plus a handle echoed from the candidate set we control, never a raw DB id. */
export interface CheckinIntent {
  kind: CheckinIntentKind;
  register: CheckinRegister;
  /** Verbatim span from the report that triggered this intent - the provenance
   *  every downstream move must trace to (invariant). */
  quote: string;
  /** The candidate handle the model echoed (e.g. "T3", "S1.2"), or null when the
   *  intent names no existing entity (a brand-new task, a pure idea/vent). */
  handle: string | null;
  /** The free-text surface form the user used for the entity - the fuzzy-resolve
   *  key when the handle is absent or wrong. Null for handle-less intents. */
  entityPhrase: string | null;
  /** Kind-specific free text resolved deterministically in stage C: the target
   *  date phrase for `reschedule` ("next week"), the new title for `add_task`,
   *  the minutes phrase for `time_logged`, the note body for `idea`. */
  detail: string | null;
  confidence: CheckinConfidence;
}

/** Stage A result, shaped like ExtractionResult (returned with a `source` sibling
 *  by interpretCheckin()). `intents` may be empty - a pure vent is valid. */
export interface CheckinInterpretation {
  intents: CheckinIntent[];
  rawReport: string;
}

/** One entity the resolver may bind a quote to - the candidate set is the blast
 *  radius (open tasks, the unlocked skill-node frontier, active activities). */
export interface CheckinCandidate {
  handle: string;
  type: "task" | "skill_node" | "activity";
  /** The real DB id - stage B emits this only on a confident bind. */
  id: string;
  title: string;
  goalId: string;
  goalName: string;
}

export type CheckinResolutionStatus = "resolved" | "ambiguous" | "unresolved";

export interface ResolvedCheckinIntent {
  intent: CheckinIntent;
  status: CheckinResolutionStatus;
  /** The bound candidate when `resolved`; the top match (shown, but proposed
   *  unchecked) when `ambiguous`; null when `unresolved`. */
  match: CheckinCandidate | null;
  /** Every candidate that matched - length > 1 surfaces the disambiguation
   *  affordance (the firewall against silently picking a winner). */
  candidates: CheckinCandidate[];
}

/** An odds-silent action to confirm. `log_progress` SETs actual time, so re-submitting
 *  is idempotent - it's inert today but the raw material for estimation calibration,
 *  so don't let a "logs are unused" cleanup drop it. */
export type CheckinActionIntent =
  | { kind: "log_progress"; taskId: string; title: string; minutes: number; quote: string }
  | { kind: "capture_idea"; text: string; quote: string }
  | { kind: "acknowledge"; quote: string };

export type CheckinProposalFamily = "A" | "B";

/**
 * Stage C output - one reviewable row. Family A carries a `StrategyMove` that
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
  /** Intents that resolved to nothing actionable - rendered as inert chips
   *  ("Couldn't match 'the thing I built yesterday'") + vent acknowledgements. */
  chips: ResolvedCheckinIntent[];
  rawReport: string;
}

/**
 * Project scope for a task-scoped check-in. When a check-in runs
 * bound to a goal (the capture bar on a project page), an `add_task` intent - "I
 * also need to do Y" - becomes a real Family-A `add_tasks` move ON THIS GOAL
 * (forecast()-affecting, live-re-solved), instead of the odds-silent standalone
 * capture the global bar produces with no project context. The scope is also the
 * disambiguation: the goal's own entities rank first in the interpret prompt.
 */
export interface CheckinScope {
  goalId: string;
  goalName: string;
  /** Life-area the new task inherits - the goal's modal task area (SuggestedTask
   *  requires one; the strategist's own adds inherit it the same way). */
  area: string;
}

// --- Asynchronous jobs (the queue-backed LLM path) --------------------------

/**
 * Where a queued job has got to.
 *
 * `retrying` is not decoration. SQS redelivers a failed message up to
 * `maxReceiveCount` times, so the first failure is usually transient (a Bedrock
 * throttle clears in seconds) and telling the user "that failed" would be a
 * lie the queue is about to disprove. The worker only writes `failed` on the
 * delivery it can prove is the last one.
 */
export type JobRunStatus =
  | "queued"
  | "running"
  | "retrying"
  | "succeeded"
  | "failed";

/** True once the job will not change state again on its own. */
export function isTerminalJobStatus(status: JobRunStatus): boolean {
  return status === "succeeded" || status === "failed";
}

/**
 * One attempt at a long job, as the browser sees it.
 *
 * This row exists because the Server Actions stopped waiting. A published event
 * gives the caller nothing to render, so without a status row "the request
 * returned immediately" and "nothing happened" look identical to the user.
 */
export interface JobRun {
  id: string;
  type: string;
  subjectId: string | null;
  status: JobRunStatus;
  /** Whatever the body returned that the UI needs, e.g. `{ created: 4 }`. */
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * How long a non-terminal job may sit untouched before the UI stops believing
 * in it and offers a retry.
 *
 * DERIVED FROM THE QUEUE, NOT CHOSEN. A failed delivery does not come back
 * immediately: the message reappears when its visibility timeout expires, so
 * the worst case before the DLQ is roughly
 * `WORKER_MAX_RECEIVE_COUNT * visibilityTimeout` — 3 x 360s in
 * aws/infra/lib/config.ts, plus slack for the bus hop and a cold start.
 *
 * Too short and the UI declares dead a job SQS is still going to run, and the
 * retry enqueues a second copy of work that is already in flight — billed
 * twice. Too long and a job whose event never reached the queue at all (the
 * bus-to-queue target has its own DLQ) pins the button forever. If the queue's
 * visibility timeout changes, change this with it.
 */
export const JOB_STALE_MS = 20 * 60 * 1000;

/** True when a job has stopped making progress and the UI should stop waiting. */
export function isJobAbandoned(run: JobRun, now: number = Date.now()): boolean {
  if (isTerminalJobStatus(run.status)) return false;
  return now - new Date(run.updatedAt).getTime() > JOB_STALE_MS;
}

/**
 * What a Server Action hands back once it no longer does the work itself.
 *
 * `ranInline` is the honest bit: with no `EVENT_BUS_NAME` (local development,
 * and any deployment without the events stack) `publish()` returns false and
 * the action runs the body in-request exactly as it used to. The caller gets a
 * job that is already terminal, and should not start polling for it.
 */
export interface JobHandle {
  jobId: string;
  status: JobRunStatus;
  ranInline: boolean;
  /**
   * The outcome, when the action already has one.
  *
   * These carry the INLINE path's result, and they are not a convenience: a
   * terminal job is never polled, so a handle that came back already finished
   * is the only chance the browser gets to see what it produced or why it
   * failed. On the queued path both are null and the poll fills them in.
   */
  result: Record<string, unknown> | null;
  error: string | null;
}
