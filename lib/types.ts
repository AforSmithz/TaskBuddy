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
    | "blocked_tasks" // open tasks stuck in `blocked`
    | "contention"; // competing with another project for the same shared hours (pit wall)
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
  /** Human-readable reason for the placement (e.g. "pulled ahead — Project X due in 2 days"). */
  reason: string;
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
  | { kind: "mark_done"; taskId: string; title: string }
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
}
