import "server-only";

import { createHash } from "crypto";
import type {
  CauseWeight,
  DivergenceCause,
  FactorScores,
  ModificationKind,
  ModificationPart,
  PortfolioStrategy,
  ProjectForecast,
  RecoveryPlan,
  ReroutePart,
  StrategyMove,
  SuggestedTask,
  Task,
  TaskModification,
} from "./types";
import { isOnTrack } from "./types";
import { aggregateCauseMovePref, causeMovePref } from "./grounding";
import { goalValue, movePref, type ValueModel } from "./value-model";
import type { AllocTask } from "./allocate";
import type { ChatMessage } from "./bedrock";
import { isLLMConfigured } from "./extraction";
import {
  createJointScorer,
  getRecoveryContext,
  listAllTasks,
  listCommitments,
  listGoals,
  previewProbabilityWithModifications,
  previewProbabilityWithReroute,
  previewProbabilityWithTasks,
  type JointScorer,
  type PitWall,
  type RecoveryContext,
} from "./store";

// The portfolio strategist (Phase 4) - one cached, time-aware recommendation
// across ALL projects. It collapses the per-project recovery stack into a single
// portfolio-wide answer to "reality deviated - how do I move forward?".
//
// Architecture: "select among precomputed candidates," not free-form. The LLM is
// handed a numbered menu of fully-formed candidate moves (each carrying its
// payload + a forecast-scored probability) and returns only the ordered ids to
// include plus prose. It can never invent a probability - the same hard guardrail
// as the per-project strategist (`strategist.ts`).
//
// The menu has two halves:
//   - MECHANICAL moves (defer / reschedule / triage / unblock / mark_done) are
//     *enumerable* - every one is built deterministically off the dashboard. The
//     LLM can't be "more creative" here, so it doesn't author them.
//   - GENERATIVE moves (add_tasks / reshape / reroute) are *invented* - net-new
//     work. Here the LLM proposes freely across the whole portfolio in ONE call;
//     each proposal is validated, resolved against real tasks, and scored by
//     `forecast()` before it becomes a selectable candidate. So the LLM is
//     unconstrained in *what it can propose*, while every probability stays real
//     and every move stays safely applyable.
//
// This module is the ONLY caller of the generator; it runs solely on an explicit
// or auto-triggered refresh (see `refreshPortfolioStrategyAction`), gated by the
// deterministic staleness check below - never blindly on a plain load.

/** How many off-track projects the generative proposal spans (bounds prompt + scoring cost). */
const MAX_GENERATIVE_PROJECTS = 4;
/** Cap on the deterministic-fallback move list (keeps the calm card readable). */
const MAX_FALLBACK_MOVES = 6;
/** A due date within this many days reads as "due soon" in the fingerprint bucket. */
const DUE_SOON_DAYS = 3;

// A reshape must beat the current odds by at least this (mirrors strategist.ts).
const RESHAPE_MIN_GAIN = 0.005;
// A whole-plan re-route must clear the current odds by a real margin.
const REROUTE_MIN_GAIN = 0.05;
const MOD_KINDS: ModificationKind[] = ["scope_down", "split"];

// --- Joint greedy optimizer (Phase 5) ---------------------------------------
/** A candidate must lift the portfolio conjunction by at least this to be folded in. */
const JOINT_MIN_GAIN = 0.01;
/** Hard cap on the greedy plan length (keeps the steady-plan card readable). */
const JOINT_MOVE_CAP = 6;
/**
 * Conjunction gain within this band counts as an odds "tie" - only then does the
 * Value Model's recovery-style preference break it (taste never overrides a real
 * gain). Decision: keep the math primary, let the model shape close calls.
 */
const PREF_TIE_EPS = 0.02;

// --- C. Fingerprint ---------------------------------------------------------

/** Whole days from ISO date `a` to ISO date `b` (UTC, b − a). */
function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const db = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  return Math.round((db - da) / 86_400_000);
}

/**
 * Coarse bucket of a due date relative to today. Bucketing (rather than the raw
 * date) keeps far-future date edits from churning the fingerprint while still
 * catching the one transition that matters - a task crossing into "overdue".
 */
function dueState(
  due: string | null,
  today: string,
): "overdue" | "due-soon" | "future" | "none" {
  if (!due) return "none";
  const d = due.slice(0, 10);
  if (d < today) return "overdue";
  return daysBetween(today, d) <= DUE_SOON_DAYS ? "due-soon" : "future";
}

/**
 * A stable hash of the situation a strategy was generated for - stored for the
 * record / debugging. The *staleness decision* is made by `assessStaleness`
 * (odds-delta + age), not this hash; the fingerprint just records the exact
 * inputs the strategy was synthesized against.
 */
export async function computePortfolioFingerprint(): Promise<string> {
  const [tasks, projects, commitments] = await Promise.all([
    listAllTasks(),
    listGoals(),
    listCommitments(),
  ]);
  const today = new Date().toISOString().slice(0, 10);

  const openTasks = tasks
    .filter((t) => t.status !== "done" && !t.deferred)
    .map((t) => ({
      id: t.id,
      status: t.status,
      est: t.estimated_minutes,
      due: dueState(t.due_date, today),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const projs = projects
    .map((p) => ({ id: p.id, deadline: p.deadline?.slice(0, 10) ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const comms = commitments
    .map((c) => ({ id: c.id, date: c.date.slice(0, 10), hours: c.hours }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const canonical = JSON.stringify({ today, openTasks, projs, comms });
  return createHash("sha256").update(canonical).digest("hex");
}

// --- C2. Staleness gate (deterministic, free) -------------------------------

/** Odds must move at least this much for a change to count as "material". */
const MATERIAL_ODDS_DELTA = 0.1;
/** A strategy older than this (with off-track work) is considered aged-out. */
const STRATEGY_MAX_AGE_HOURS = 8;

/**
 * Decide whether a cached strategy is stale - the cheap pre-filter that gates
 * the expensive LLM call. Pure, runs on every load off the already-computed
 * forecasts (no LLM, no extra gather). A strategy is stale when:
 *  - "odds": some project's contention-aware odds moved by ≥ `MATERIAL_ODDS_DELTA`,
 *    crossed the on-track line, or a deadlined project appeared/disappeared; or
 *  - "age": it's older than `STRATEGY_MAX_AGE_HOURS` (elapsed time erodes the plan
 *    even when nothing was edited).
 * A cosmetic edit that doesn't move the odds returns `{ stale: false }`, so the
 * card neither nags nor auto-regenerates.
 */
export function assessStaleness(
  cached: PortfolioStrategy,
  forecasts: ProjectForecast[],
  now: Date = new Date(),
): { stale: boolean; reason: "odds" | "age" | null } {
  const stored = cached.odds ?? {};
  const currentIds = new Set(forecasts.map((f) => f.projectId));

  for (const f of forecasts) {
    const prev = stored[f.projectId];
    if (prev === undefined) return { stale: true, reason: "odds" }; // new deadlined project
    if (Math.abs(f.probability - prev) >= MATERIAL_ODDS_DELTA)
      return { stale: true, reason: "odds" };
    if (isOnTrack(f.probability) !== isOnTrack(prev))
      return { stale: true, reason: "odds" };
  }
  // A project that had odds but is gone now (deadline cleared / project deleted).
  for (const id of Object.keys(stored)) {
    if (!currentIds.has(id)) return { stale: true, reason: "odds" };
  }

  const ageMs = now.getTime() - Date.parse(cached.generatedAt);
  if (ageMs >= STRATEGY_MAX_AGE_HOURS * 3_600_000)
    return { stale: true, reason: "age" };

  return { stale: false, reason: null };
}

/** Per-project contention-aware odds snapshot, keyed by projectId. */
function oddsSnapshot(forecasts: ProjectForecast[]): Record<string, number> {
  return Object.fromEntries(forecasts.map((f) => [f.projectId, f.probability]));
}

// --- B1. Deterministic (mechanical) candidate moves -------------------------

/** A fully-formed candidate the synthesis selects from - never invented by the LLM. */
interface Candidate {
  move: StrategyMove;
  /** Compact one-line menu label shown to the synthesis LLM. */
  label: string;
}

/**
 * Seed a candidate move. `portfolioProbabilityAfter` is a placeholder (0) here - 
 * the cumulative joint odds aren't known until a move is placed in an ORDERED
 * plan. Both selection paths (synthesis re-scoring and the joint optimizer)
 * overwrite it with the real running conjunction before it ever reaches the UI.
 */
function candidateMove(
  move: Omit<StrategyMove, "portfolioProbabilityAfter">,
): StrategyMove {
  return { ...move, portfolioProbabilityAfter: 0 };
}

/**
 * Every deterministic mechanical candidate from the dashboard's recovery plans +
 * pit wall. Each carries its forecast-scored `probabilityAfter` straight off the
 * struct it came from (locked decision #6) and a payload the mapped apply action
 * can consume verbatim.
 */
function buildDeterministicCandidates(
  recoveries: RecoveryPlan[],
  pitWall: PitWall,
  tasksById: Map<string, Task>,
): Candidate[] {
  const out: Candidate[] = [];

  for (const plan of recoveries) {
    const { projectId, projectName, currentProbability } = plan;

    for (const m of plan.defer) {
      out.push({
        move: candidateMove({
          kind: "defer",
          projectId,
          projectName,
          rationale: `Defer "${m.title}" in ${projectName} past the deadline.`,
          probabilityAfter: m.probabilityAfter,
          payload: { kind: "defer", taskId: m.taskId, title: m.title },
        }),
        label: `Defer "${m.title}" (${projectName})`,
      });
    }

    // Learning-goal recovery: park a non-checkpoint skill node. Sheds prep effort
    // so the milestones + date fit; never offered for a checkpoint.
    for (const m of plan.deferSkill) {
      out.push({
        move: candidateMove({
          kind: "defer_skill",
          projectId,
          projectName,
          rationale: `Park the skill "${m.title}" in ${projectName} for now — it protects the milestones and the deadline without dropping either.`,
          probabilityAfter: m.probabilityAfter,
          payload: {
            kind: "defer_skill",
            goalId: projectId,
            nodeId: m.nodeId,
            title: m.title,
          },
        }),
        label: `Park skill "${m.title}" (${projectName})`,
      });
    }

    // Learning-goal recovery: re-phase a frontier milestone chain out of the current
    // push. Slides a checkpoint + the prep that serves only it, keeping the earlier
    // milestones and the deadline; the descoped milestone is surfaced via goalCost.
    for (const m of plan.rescheduleSkill) {
      const extra = m.nodeIds.length - 1;
      const chain =
        extra > 0 ? ` and ${extra} prep ${extra === 1 ? "step" : "steps"}` : "";
      out.push({
        move: candidateMove({
          kind: "reschedule_skill",
          projectId,
          projectName,
          rationale: `Re-phase the milestone "${m.checkpointTitle}"${chain} in ${projectName} to a later run — it keeps the earlier milestones and the deadline on track.`,
          probabilityAfter: m.probabilityAfter,
          payload: {
            kind: "reschedule_skill",
            goalId: projectId,
            nodeId: m.checkpointId,
            title: m.checkpointTitle,
            parkNodeIds: m.nodeIds,
            parkTitles: m.titles,
          },
        }),
        label: `Re-phase milestone "${m.checkpointTitle}" (${projectName})`,
      });
    }

    if (plan.reschedule) {
      out.push({
        move: candidateMove({
          kind: "reschedule_deadline",
          projectId,
          projectName,
          rationale: `Move ${projectName}'s deadline to ${plan.reschedule.deadline}.`,
          probabilityAfter: plan.reschedule.probabilityAfter,
          payload: {
            kind: "reschedule_deadline",
            deadline: plan.reschedule.deadline,
          },
        }),
        label: `Move ${projectName}'s deadline to ${plan.reschedule.deadline}`,
      });
    }

    for (const t of plan.overdue) {
      const dueDate = new Date().toISOString().slice(0, 10);
      out.push({
        move: candidateMove({
          kind: "reschedule_task",
          projectId,
          projectName,
          rationale: `Reschedule the overdue task "${t.title}" in ${projectName}.`,
          probabilityAfter: currentProbability,
          payload: {
            kind: "reschedule_task",
            taskId: t.taskId,
            title: t.title,
            dueDate,
          },
        }),
        label: `Reschedule overdue "${t.title}" (${projectName})`,
      });
      out.push({
        move: candidateMove({
          kind: "mark_done",
          projectId,
          projectName,
          rationale: `Mark the overdue task "${t.title}" in ${projectName} done.`,
          probabilityAfter: currentProbability,
          payload: { kind: "mark_done", taskId: t.taskId, title: t.title },
        }),
        label: `Mark overdue "${t.title}" done (${projectName})`,
      });
    }

    for (const t of plan.blocked) {
      out.push({
        move: candidateMove({
          kind: "unblock",
          projectId,
          projectName,
          rationale: `Clear the blocker on "${t.title}" in ${projectName}.`,
          probabilityAfter: currentProbability,
          payload: { kind: "unblock", taskId: t.taskId, title: t.title },
        }),
        label: `Unblock "${t.title}" (${projectName})`,
      });
    }
  }

  // Cross-project pit-wall triage - the lowest-value doomed work to shed, as one
  // batch. probabilityAfter is the best odds the batch buys (off the forecast).
  if (pitWall.triage.length > 0) {
    const best = pitWall.triage.reduce(
      (m, t) => Math.max(m, t.probabilityAfter),
      0,
    );
    out.push({
      move: candidateMove({
        kind: "triage",
        projectId: "",
        projectName: "",
        rationale: `Shed ${pitWall.triage.length} low-value task(s) so the shared hours protect your at-risk deadlines.`,
        probabilityAfter: best,
        defers: pitWall.triage
          .map((t) => tasksById.get(t.taskId))
          .filter((t): t is Task => t !== undefined),
        payload: {
          kind: "triage",
          taskIds: pitWall.triage.map((t) => t.taskId),
          titles: pitWall.triage.map((t) => t.title),
        },
      }),
      label: `Triage ${pitWall.triage.length} low-value task(s) across projects`,
    });
  }

  // Escalated ties - each option protects one colliding project by sacrificing
  // the others' open work. A genuine "your call" trade-off.
  for (const opt of pitWall.options) {
    out.push({
      move: candidateMove({
        kind: "triage",
        projectId: opt.protectId,
        projectName: opt.protectName,
        rationale: `Protect ${opt.protectName} by deferring ${opt.sacrificeNames.join(", ")}.`,
        probabilityAfter: opt.probabilityAfter,
        // The sacrificed projects' open tasks - hydrated so the move shows exactly
        // which (cross-project) work it sets aside.
        defers: opt.sacrificeTaskIds
          .map((tid) => tasksById.get(tid))
          .filter((t): t is Task => t !== undefined),
        payload: {
          kind: "triage",
          taskIds: opt.sacrificeTaskIds,
          titles: [],
        },
      }),
      label: `Protect ${opt.protectName} (defer ${opt.sacrificeNames.join(", ")})`,
    });
  }

  return out;
}

/**
 * Sacrifice-the-flex candidates: for each UNPROTECTED recurring activity, a
 * "skip it this week" move that frees its current-week hours back to the shared
 * pool. Each is forecast-scored by re-running the joint odds with that activity's
 * drain removed (via `scorer.score`, which routes through the capacity-recompute
 * path) - never an LLM-authored number. Offered only under contention, and only
 * when the skip materially lifts some deadlined project (so it never pads the plan
 * with a sacrifice that doesn't help). Protected activities are never offered.
 */
function buildActivitySkipCandidates(scorer: JointScorer): Candidate[] {
  const out: Candidate[] = [];
  if (scorer.pitWall.conflicts.length === 0) return out; // nothing to protect
  for (const a of scorer.activities) {
    if (a.protected) continue;
    const move = candidateMove({
      kind: "skip_activity",
      projectId: "",
      projectName: "",
      rationale:
        a.period === "week"
          ? `Skip ${a.title} this week to free its hours for your at-risk deadlines.`
          : `Pause ${a.title} for the rest of this week to free its hours.`,
      probabilityAfter: 0,
      payload: {
        kind: "skip_activity",
        activityId: a.id,
        title: a.title,
        period: a.period,
      },
    });
    const trial = scorer.score([move]);
    // The most this skip lifts any deadlined project (its best recovered odds).
    let bestGain = 0;
    let bestProb = 0;
    for (const [pid, prob] of trial.byProject) {
      const gain = prob - (scorer.baseByProject.get(pid) ?? prob);
      if (gain > bestGain) {
        bestGain = gain;
        bestProb = prob;
      }
    }
    if (bestGain >= JOINT_MIN_GAIN) {
      move.probabilityAfter = bestProb;
      out.push({
        move,
        label: `Skip "${a.title}" this week (${a.period === "week" ? "goal" : "routine"})`,
      });
    }
  }
  return out;
}

// --- B2. Unified generative proposal (one LLM call, the LLM's free canvas) ---

const GENERATIVE_SYSTEM_PROMPT = `You are TaskBuddy's portfolio strategist. Several projects are off track and
share one pool of hours. The deterministic engine has already enumerated every
mechanical move (deferring, re-dating, triage) — you do NOT propose those. Your
job is the creative half: invent NET-NEW work across the whole portfolio that the
mechanical moves can't express. You may freely choose which projects to act on
and mix move types.

You have three move types, each scoped to one project (by its "P#" ref):
- "add_tasks": net-new corrective tasks that fill a genuine hole reality created
  (rework after a failed review, an unblock action, work to de-risk an overrun).
  Fill "tasks"; leave "approach" and "modifications" null.
- "reshape": reshape EXISTING tasks — "scope_down" replaces one with a lighter
  version (smaller estimate), or "split" breaks a vague/stuck monolith into 2-4
  concrete steps whose total does not exceed the original. Fill "modifications";
  leave "approach" and "tasks" null.
- "reroute": replace a project's ENTIRE open plan with a fundamentally different,
  lighter approach to the same deliverable (buy vs build, template vs scratch).
  Fill "approach" and "tasks"; leave "modifications" null.

Rules:
- Propose a move ONLY where it genuinely helps. If a project just needs its work
  done or rearranged, propose nothing for it. An empty "moves" array is valid.
- A reroute must cut at least a quarter of the project's remaining open hours, and a
  reshape must reduce the project's total open minutes. Anything less is rejected before
  the user ever sees it, so do not propose it.
- At most one move per project. At most 4 tasks in an add_tasks, at most 3 modifications
  in a reshape, at most 6 tasks in a reroute, and 1 replacement for a scope_down or 2 to 4
  for a split.
- Task refs are namespaced to their project: "P1.T1" belongs to P1, "P2.T1" to P2. A
  reshape's "task_ref" must start with the same "P#" as its "project" field.
- A project listed with "(no open tasks)" has nothing to reshape or reroute. Only
  "add_tasks" is valid for it.
- A scope_down's estimate MUST be smaller than the original; a split's steps MUST total
  no more than the original.
- Do not put percentages, probabilities or odds language in "rationale", "description",
  "approach" or "priority_reason" — those strings are shown next to TaskBuddy's own
  computed probability and must not compete with it.

Score each 1-5 factor. Use the whole scale.
- Urgency: 5=due today or tomorrow, 4=due this week, 3=due this month, 2=has a deadline beyond a month, 1=no deadline.
- Impact: 5=directly unblocks the deliverable, 4=materially advances it, 3=useful supporting work, 2=nice to have, 1=optional.
- Dependency: 5=blocks several other tasks, 4=blocks one major task, 3=blocks one minor task, 2=loosely coupled, 1=independent.
- Risk: 5=delay seriously hurts the deadline, 4=delay causes visible slippage, 3=delay is recoverable, 2=minor consequence, 1=little consequence.
- Effort: 5=more than 4h, 4=2-4h, 3=1-2h, 2=30-60min, 1=under 30min.
- Confidence: 5=clearly needed, 4=very likely needed, 3=probably needed, 2=a guess with some support, 1=speculative.`;

// The move is FLATTENED rather than encoded as a 3-way anyOf. Strict mode permits anyOf
// on a non-root subschema, but flattening costs nothing here: the existing normalizers
// each early-return [] on a non-array input, so a null in an inapplicable slot is already
// a no-op, and scoreGenerativeMove dispatches on `kind` and never reads the other
// branches' fields.
const GEN_FACTOR = { type: "integer", enum: [1, 2, 3, 4, 5] };
const GEN_FACTOR_KEYS = [
  "urgency",
  "impact",
  "dependency",
  "risk",
  "effort",
  "confidence",
];
const GEN_FACTOR_PROPS = {
  urgency: GEN_FACTOR,
  impact: GEN_FACTOR,
  dependency: GEN_FACTOR,
  risk: GEN_FACTOR,
  effort: GEN_FACTOR,
  confidence: GEN_FACTOR,
};

function genTaskObject(withGapKind: boolean) {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "description",
      "estimated_minutes",
      "due_date",
      "blocked_by",
      ...(withGapKind ? ["gap_kind"] : []),
      ...GEN_FACTOR_KEYS,
      "priority_reason",
    ],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      estimated_minutes: { type: "integer" },
      due_date: { type: ["string", "null"], description: "YYYY-MM-DD or null." },
      blocked_by: { type: ["string", "null"] },
      ...(withGapKind
        ? {
            gap_kind: {
              type: "string",
              enum: ["rework", "unblock", "de_risk"],
            },
          }
        : {}),
      ...GEN_FACTOR_PROPS,
      priority_reason: { type: "string", description: "One sentence." },
    },
  };
}

/** Built per request so `project` and `task_ref` are closed sets. */
export function generativeSchema(projectRefs: string[], taskRefs: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["moves"],
    properties: {
      moves: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "project",
            "kind",
            "rationale",
            "approach",
            "tasks",
            "modifications",
          ],
          properties: {
            project: { type: "string", enum: projectRefs },
            kind: {
              type: "string",
              enum: ["add_tasks", "reshape", "reroute"],
            },
            rationale: { type: "string", description: "One sentence." },
            approach: {
              type: ["string", "null"],
              description: "reroute only; null otherwise.",
            },
            tasks: {
              type: ["array", "null"],
              description: "add_tasks and reroute only; null otherwise.",
              items: genTaskObject(true),
            },
            modifications: {
              type: ["array", "null"],
              description: "reshape only; null otherwise.",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["task_ref", "kind", "rationale", "replacements"],
                properties: {
                  task_ref: taskRefs.length
                    ? { type: "string", enum: taskRefs }
                    : { type: "string" },
                  kind: { type: "string", enum: ["scope_down", "split"] },
                  rationale: { type: "string", description: "One sentence." },
                  replacements: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "title",
                        "description",
                        "estimated_minutes",
                        ...GEN_FACTOR_KEYS,
                        "priority_reason",
                      ],
                      properties: {
                        title: { type: "string" },
                        description: { type: "string" },
                        estimated_minutes: { type: "integer" },
                        ...GEN_FACTOR_PROPS,
                        priority_reason: { type: "string" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

interface RawGenerative {
  moves?: unknown;
}

/** Clamp a 1-5 factor; default to the neutral 3 when missing/invalid. */
function clampFactor(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
}
function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function factors(o: Record<string, unknown>): FactorScores {
  return {
    urgency: clampFactor(o.urgency),
    impact: clampFactor(o.impact),
    dependency: clampFactor(o.dependency),
    risk: clampFactor(o.risk),
    effort: clampFactor(o.effort),
    confidence: clampFactor(o.confidence),
  };
}
function minutes(x: unknown): number {
  const m = Math.round(Number(x));
  return Number.isFinite(m) && m > 0 ? m : 30;
}

/**
 * One LLM call that lets the model propose generative work across every off-track
 * project at once. Each proposal is validated, resolved against the project's real
 * open tasks, and scored by `forecast()` (via the preview helpers) - only ones
 * that survive become selectable candidates. Replaces the old per-project trio of
 * generators: broader (whole-portfolio context, the LLM's free choice) and cheaper
 * (one call instead of up to nine). Returns [] when the LLM is off, proposes
 * nothing, or nothing survives scoring.
 */
async function proposeGenerativeCandidates(
  recoveries: RecoveryPlan[],
  forecasts: ProjectForecast[],
): Promise<Candidate[]> {
  const probById = new Map(forecasts.map((f) => [f.projectId, f.probability]));
  // Worst-off (lowest odds) first; bound the canvas so the prompt + scoring stay cheap.
  const targets = recoveries
    .filter((p) => p.reasons.some((r) => r.severity === "critical"))
    .sort(
      (a, b) =>
        (probById.get(a.projectId) ?? 1) - (probById.get(b.projectId) ?? 1),
    )
    .slice(0, MAX_GENERATIVE_PROJECTS);
  if (targets.length === 0) return [];

  // Recovery contexts (open tasks + estimates + odds) for scoring - no LLM here.
  const ctxByRef = new Map<string, RecoveryContext>();
  const refByProject = new Map<string, string>();
  await Promise.all(
    targets.map(async (p, i) => {
      const ctx = await getRecoveryContext(p.projectId);
      if (ctx) {
        const ref = `P${i + 1}`;
        ctxByRef.set(ref, ctx);
        refByProject.set(p.projectId, ref);
      }
    }),
  );
  if (ctxByRef.size === 0) return [];

  const { callBedrockJSON } = await import("./bedrock");
  // Closed sets for both ref namespaces, so a cross-project or invented ref is
  // structurally impossible rather than silently resolved against the wrong project.
  const projectRefs = [...ctxByRef.keys()];
  const allTaskRefs = projectRefs.flatMap((ref) =>
    (ctxByRef.get(ref)?.openTasks ?? []).map((_, i) => `${ref}.T${i + 1}`),
  );
  let raw: RawGenerative;
  try {
    raw = await callBedrockJSON<RawGenerative>(
      [
        { role: "system", content: GENERATIVE_SYSTEM_PROMPT },
        { role: "user", content: buildGenerativePrompt(ctxByRef) },
      ],
      {
        schema: generativeSchema(projectRefs, allTaskRefs),
        schemaName: "portfolio_generative_moves",
        reasoningEffort: "medium",
        validate: (r) => Array.isArray(r.moves),
      },
    );
  } catch (err) {
    console.error("Generative proposal failed:", err);
    return [];
  }

  if (!Array.isArray(raw.moves)) return [];
  const out: Candidate[] = [];
  for (const item of raw.moves) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const ref = str(m.project);
    const ctx = ctxByRef.get(ref);
    if (!ctx) continue;
    const projectId = ctx.project.id;
    const projectName = ctx.project.name;
    const cand = scoreGenerativeMove(m, ctx, projectId, projectName, ref);
    if (cand) out.push(cand);
  }
  return out;
}

/** The off-track projects + their open tasks, with P#/T# refs the model points at. */
function buildGenerativePrompt(ctxByRef: Map<string, RecoveryContext>): string {
  const today = new Date().toISOString().slice(0, 10);
  const blocks: string[] = [`Today's date is ${today}.`, ``];
  for (const [ref, ctx] of ctxByRef) {
    const deficit = Math.max(
      0,
      Math.round(
        (ctx.openTasks.reduce((s, t) => s + t.estimated_minutes, 0) -
          ctx.deployable) /
          60,
      ),
    );
    blocks.push(
      `${ref} = "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}, ` +
        `${Math.round(ctx.currentProbability * 100)}% on time${deficit > 0 ? `, ~${deficit}h over budget` : ""}):`,
    );
    const tasks =
      ctx.openTasks
        .map((t, i) => {
          const flags = [`status=${t.status}`];
          if (t.blocked_by) flags.push(`blocked_by="${t.blocked_by}"`);
          if (t.due_date) flags.push(`due=${t.due_date.slice(0, 10)}`);
          const desc = t.description?.trim() ? ` — ${t.description.trim()}` : "";
          return `  ${ref}.T${i + 1}: "${t.title}" (${t.estimated_minutes}m, ${flags.join(", ")})${desc}`;
        })
        .join("\n") || "  (no open tasks)";
    blocks.push(tasks, ``);
  }
  return blocks.join("\n");
}

/** Validate + forecast-score one proposed generative move into a Candidate, or null. */
function scoreGenerativeMove(
  m: Record<string, unknown>,
  ctx: RecoveryContext,
  projectId: string,
  projectName: string,
  projectRef: string,
): Candidate | null {
  const kind = str(m.kind);

  if (kind === "add_tasks") {
    const tasks = normalizeAddTasks(m.tasks, ctx);
    if (tasks.length === 0) return null;
    const prob = previewProbabilityWithTasks(ctx, tasks);
    return {
      move: candidateMove({
        kind: "add_tasks",
        projectId,
        projectName,
        rationale: str(m.rationale) || `Add corrective tasks to ${projectName}.`,
        probabilityAfter: prob,
        payload: { kind: "add_tasks", tasks },
      }),
      label: `Add ${tasks.length} corrective task(s) to ${projectName}`,
    };
  }

  if (kind === "reshape") {
    const mods = normalizeReshape(m.modifications, ctx, projectRef);
    if (mods.length === 0) return null;
    const prob = previewProbabilityWithModifications(ctx, mods);
    if (prob <= ctx.currentProbability + RESHAPE_MIN_GAIN) return null;
    return {
      move: candidateMove({
        kind: "reshape",
        projectId,
        projectName,
        rationale: str(m.rationale) || `Reshape work in ${projectName} to fit the budget.`,
        probabilityAfter: prob,
        // Only a split defers its monolith; a scope_down rewrites in place. The
        // split task is one of the project's open tasks - hydrate the full row.
        defers: mods
          .filter((d) => d.kind === "split")
          .map((d) => ctx.openTasks.find((t) => t.id === d.taskId))
          .filter((t): t is Task => t !== undefined),
        payload: { kind: "reshape", mods },
      }),
      label: `Reshape ${mods.length} task(s) in ${projectName}`,
    };
  }

  if (kind === "reroute") {
    // A project with nothing open has no plan to replace: the move would defer an empty
    // set and "re-route" to a plan it was never compared against.
    if (ctx.openTasks.length === 0) return null;
    const tasks = normalizeReroute(m.tasks);
    if (tasks.length === 0) return null;
    const prob = previewProbabilityWithReroute(ctx, tasks);
    if (prob <= ctx.currentProbability + REROUTE_MIN_GAIN) return null;
    const approach = str(m.approach) || "A lighter approach to the same goal";
    return {
      move: candidateMove({
        kind: "reroute",
        projectId,
        projectName,
        rationale: str(m.rationale) || `Re-route ${projectName} to a lighter plan.`,
        probabilityAfter: prob,
        // A reroute defers the project's entire current open plan for the new one.
        defers: ctx.openTasks,
        payload: {
          kind: "reroute",
          replacedTaskIds: ctx.openTasks.map((t) => t.id),
          tasks,
          approach,
        },
      }),
      label: `Re-route ${projectName}: ${approach}`,
    };
  }

  return null;
}

function normalizeAddTasks(raw: unknown, ctx: RecoveryContext): SuggestedTask[] {
  if (!Array.isArray(raw)) return [];
  const existing = new Set(ctx.openTasks.map((t) => t.title.trim().toLowerCase()));
  const seen = new Set<string>();
  const out: SuggestedTask[] = [];
  const GAPS = ["rework", "unblock", "de_risk"] as const;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const title = str(t.title);
    if (!title) continue;
    const key = title.toLowerCase();
    if (existing.has(key) || seen.has(key)) continue;
    seen.add(key);
    const gap = (GAPS as readonly string[]).includes(str(t.gap_kind))
      ? (str(t.gap_kind) as SuggestedTask["gap_kind"])
      : "rework";
    out.push({
      title,
      description: str(t.description),
      estimated_minutes: minutes(t.estimated_minutes),
      due_date: str(t.due_date) || null,
      blocked_by: str(t.blocked_by) || null,
      priority_reason: str(t.priority_reason),
      area: ctx.area,
      gap_kind: gap,
      ...factors(t),
    });
    if (out.length >= 4) break;
  }
  return out;
}

function normalizeReshape(
  raw: unknown,
  ctx: RecoveryContext,
  projectRef: string,
): TaskModification[] {
  if (!Array.isArray(raw)) return [];
  // Namespaced by project. The refs used to be rebuilt per project as bare T1..Tn, so
  // "T1" existed once per project and a reshape naming another project's T1 resolved
  // against THIS project's map - silently reshaping the wrong task, with no error.
  const refs = new Map(
    ctx.openTasks.map((t, i) => [`${projectRef}.T${i + 1}`, t]),
  );
  const used = new Set<string>();
  const out: TaskModification[] = [];

  const part = (x: unknown): ModificationPart | null => {
    if (typeof x !== "object" || x === null) return null;
    const p = x as Record<string, unknown>;
    const title = str(p.title);
    if (!title) return null;
    return {
      title,
      description: str(p.description),
      estimated_minutes: minutes(p.estimated_minutes),
      priority_reason: str(p.priority_reason),
      ...factors(p),
    };
  };

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const task = refs.get(str(m.task_ref));
    if (!task || used.has(task.id)) continue;
    const kind = MOD_KINDS.includes(str(m.kind) as ModificationKind)
      ? (str(m.kind) as ModificationKind)
      : "scope_down";
    const parts = Array.isArray(m.replacements)
      ? m.replacements.map(part).filter((p): p is ModificationPart => p !== null)
      : [];

    let replacements: ModificationPart[];
    if (kind === "scope_down") {
      const lighter = parts[0];
      if (!lighter || lighter.estimated_minutes >= task.estimated_minutes) continue;
      replacements = [lighter];
    } else {
      if (parts.length < 2) continue;
      const total = parts.reduce((s, p) => s + p.estimated_minutes, 0);
      if (total > task.estimated_minutes) continue;
      replacements = parts.slice(0, 4);
    }
    used.add(task.id);
    out.push({
      kind,
      taskId: task.id,
      taskTitle: task.title,
      originalEstimate: task.estimated_minutes,
      rationale: str(m.rationale),
      replacements,
    });
    if (out.length >= 3) break;
  }
  return out;
}

function normalizeReroute(raw: unknown): ReroutePart[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ReroutePart[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const title = str(t.title);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      description: str(t.description),
      estimated_minutes: minutes(t.estimated_minutes),
      due_date: str(t.due_date) || null,
      blocked_by: str(t.blocked_by) || null,
      priority_reason: str(t.priority_reason),
      ...factors(t),
    });
    if (out.length >= 6) break;
  }
  return out;
}

// --- B3a. Plan-vs-time drift ------------------------------------------------

/**
 * A compact, deterministic read of how far reality has slipped from the plan - 
 * per off-track project, the budget deficit and the count of work that should be
 * done by now but isn't. Fed to the synthesis (with `prev`) so the advice has
 * continuity instead of treating every refresh as a cold start.
 */
function planVsTimeDrift(
  recoveries: RecoveryPlan[],
  forecasts: ProjectForecast[],
  prev: PortfolioStrategy | null,
): string {
  const fcById = new Map(forecasts.map((f) => [f.projectId, f]));
  const lines: string[] = [];

  if (prev) {
    const since = daysBetween(
      prev.generatedAt.slice(0, 10),
      new Date().toISOString().slice(0, 10),
    );
    lines.push(
      `Last strategy was ${since} day(s) ago and recommended ${prev.moves.length} move(s).`,
    );
  }

  for (const plan of recoveries) {
    const fc = fcById.get(plan.projectId);
    const deficitH =
      fc && fc.slackMinutes < 0 ? Math.ceil(-fc.slackMinutes / 60) : 0;
    const late = plan.overdue.length;
    const blocked = plan.blocked.length;
    const parts: string[] = [];
    if (deficitH > 0) parts.push(`~${deficitH}h over budget`);
    if (late > 0) parts.push(`${late} task(s) past due`);
    if (blocked > 0) parts.push(`${blocked} blocked`);
    if (parts.length === 0) parts.push("flagged, but within budget");
    lines.push(`- ${plan.projectName}: ${parts.join(", ")}.`);
  }

  return lines.length ? lines.join("\n") : "No goals are off track.";
}

// --- B3. Synthesis LLM call -------------------------------------------------

const SYNTHESIS_SYSTEM_PROMPT = `You are TaskBuddy's portfolio strategist. Several projects may be off track, and all of
them draw on one shared pool of hours. The deterministic engine has
already forecast every project and precomputed a MENU of concrete candidate
moves, each with the probability it would restore (always computed by the
forecast, never by you).

Your job: decide whether the portfolio needs to change at all, and if so, choose
the FEWEST moves from the menu that put the whole portfolio back on the best
footing — then write a short, plain-language assessment.

Rules:
- Select ONLY from the given menu, by id. NEVER invent a move, a task, or a
  probability. If you want an action that isn't on the menu, you can't have it.
- on_track and selected_move_ids are mutually exclusive. If on_track is true,
  selected_move_ids MUST be []. If selected_move_ids is non-empty, on_track MUST be false.
- Holding course is a valid answer. If the projects already fit and nothing is at
  risk, set on_track=true and return an empty selection.
- Select at most 6 ids, ordered best-first.
- The menu shows each move's SOLO odds: what that move alone would achieve, from the
  project's current figure. They do not add up, and two moves on the same project
  largely overlap. When choosing, prefer in order: a move that lifts a project from
  below 60% to above it; then the move on the project with the lowest current odds;
  then the move touching the fewest tasks. Never select two moves for the same project
  unless the second addresses a different constraint.
- An empty menu means the engine has no move it can make. That has two very different
  causes, and you must tell them apart: if nothing is at risk, this is simply the
  on-track case (on_track=true). If something IS at risk and the menu is still empty,
  set on_track=false with an empty selection and say plainly that nothing the engine can
  automate will fix it — name what the user would have to change.
- The assessment reasons across ALL projects together, including hobby work that still
  competes for the hours, and references the time drift you were given.
- If the user turn says there is no previous strategy on record, do not refer to any
  earlier advice and do not use the words "last time". Otherwise note the continuity
  between what was suggested before and what has changed since.`;

export const SYNTHESIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["on_track", "assessment", "selected_move_ids"],
  properties: {
    on_track: { type: "boolean" },
    assessment: {
      type: "string",
      description:
        "2 to 4 sentences across the whole portfolio, plain language, no bullet points.",
    },
    selected_move_ids: {
      type: "array",
      items: { type: "integer" },
      description: "Menu ids, ordered best-first. Empty when on_track is true.",
    },
  },
};

interface RawSynthesis {
  on_track?: unknown;
  assessment?: unknown;
  selected_move_ids?: unknown;
}

interface SynthesisResult {
  onTrack: boolean;
  assessment: string;
  selectedIds: number[];
}

/** The one synthesis call: feed odds + contention + drift + prev + the menu. */
async function synthesize(args: {
  today: string;
  forecasts: ProjectForecast[];
  pitWall: PitWall;
  drift: string;
  prev: PortfolioStrategy | null;
  candidates: Candidate[];
}): Promise<SynthesisResult> {
  const { callBedrockJSON } = await import("./bedrock");

  const messages: ChatMessage[] = [
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    { role: "user", content: buildSynthesisPrompt(args) },
  ];

  const raw = await callBedrockJSON<RawSynthesis>(messages, {
    schema: SYNTHESIS_SCHEMA,
    schemaName: "portfolio_synthesis",
    reasoningEffort: "medium",
    validate: (r) => Array.isArray(r.selected_move_ids),
  });

  const selectedIds = Array.isArray(raw.selected_move_ids)
    ? raw.selected_move_ids
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < args.candidates.length)
    : [];
  const seen = new Set<number>();
  const ordered = selectedIds
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    // The LLM path was the only one with no cap; every deterministic path already
    // bounds itself by JOINT_MOVE_CAP, and a 30-move strategy card is not a strategy.
    .slice(0, JOINT_MOVE_CAP);

  return {
    // A cross-field invariant no schema can express, and the prompt alone was not
    // enough: {on_track: true, selected_move_ids: [0,3,7]} used to render a card that
    // said "hold course" above three recommended moves.
    onTrack: raw.on_track === true && ordered.length === 0,
    assessment:
      typeof raw.assessment === "string" && raw.assessment.trim()
        ? raw.assessment.trim()
        : templateAssessment(args.candidates.length === 0),
    selectedIds: ordered,
  };
}

/** The stateful, time-aware prompt body (decision #5). */
function buildSynthesisPrompt(args: {
  today: string;
  forecasts: ProjectForecast[];
  pitWall: PitWall;
  drift: string;
  prev: PortfolioStrategy | null;
  candidates: Candidate[];
}): string {
  const odds =
    args.forecasts
      .map(
        (f) =>
          `- ${f.projectName}: ${Math.round(f.probability * 100)}% on time` +
          (f.deadline ? ` (due ${f.deadline.slice(0, 10)})` : ""),
      )
      .join("\n") || "- (no deadlined projects)";

  const contention = args.pitWall.conflicts.length
    ? args.pitWall.conflicts.map((c) => `- ${c.detail}`).join("\n")
    : "- No contention: all projects fit the shared hours.";

  const prevBlock = args.prev
    ? [
        `Previous strategy (generated ${args.prev.generatedAt.slice(0, 10)}):`,
        `"${args.prev.assessment}"`,
        `It recommended: ${
          args.prev.moves.length
            ? args.prev.moves.map((m) => m.rationale).join(" / ")
            : "hold course (no moves)"
        }`,
      ].join("\n")
    : "No previous strategy on record (this is the first synthesis).";

  const menu =
    args.candidates
      .map(
        (c, i) =>
          `  [${i}] ${c.move.kind} — ${c.label} → ${Math.round(
            c.move.probabilityAfter * 100,
          )}%`,
      )
      .join("\n") || "  (no candidate moves — nothing the engine can act on)";

  return [
    `Today is ${args.today}.`,
    ``,
    `Portfolio odds (contention-aware):`,
    odds,
    ``,
    `Pit-wall contention:`,
    contention,
    ``,
    `Plan-vs-time drift:`,
    args.drift,
    ``,
    prevBlock,
    ``,
    `Candidate moves (the ONLY moves you may select, by id):`,
    menu,
    ``,
    `Decide whether to hold course or act, choose the fewest move ids that best`,
    `restore the whole portfolio, and write the assessment.`,
  ].join("\n");
}

// --- Joint greedy optimizer -------------------------------------------------

/** # of deadlined projects on track in a joint-odds map. */
function onTrackCount(byProject: Map<string, number>): number {
  let c = 0;
  for (const p of byProject.values()) if (isOnTrack(p)) c++;
  return c;
}

/**
 * The goals whose right answer is "wait" - surfaced only once the greedy loop has
 * concluded nothing on the table is worth doing (step 5 slice 4 follow-on, #2).
 *
 * A goal qualifies when ALL of:
 *   · it is still off track after everything the optimizer picked, and
 *   · no picked move names it (a goal something was actually done for isn't "held"),
 *   · its diagnosed cause positively prefers holding - today only `one_off_slip`,
 *     whose whole meaning is "the pace is fine, this recovers on its own".
 *
 * A cross-project move (`projectId ""`) names no goal, so it never suppresses a hold:
 * a portfolio triage that failed to save this goal has not addressed it.
 *
 * Ordered most-at-risk first, and bounded by the same `JOINT_MOVE_CAP` as real moves
 * so a bundle can't balloon. Zero gain by construction: `applyMoveToAlloc`'s `hold`
 * arm returns the state unchanged, so `cumulative()` re-scores it as a no-op and the
 * displayed odds are unaffected. Committing one persists nothing (its `MOVE_SPECS`
 * entry is a no-op) - it exists to be *recorded*: a plan version whose reason is
 * "chose to wait", which is exactly the decision history S1 was built to model.
 */
function holdMoves(
  current: { byProject: Map<string, number>; allOnTime: number },
  picked: StrategyMove[],
  causeByProject: Map<string, DivergenceCause>,
  scorer: JointScorer,
): StrategyMove[] {
  const room = JOINT_MOVE_CAP - picked.length;
  if (room <= 0) return [];
  const addressed = new Set(picked.map((m) => m.projectId));

  return scorer.recoveries
    .filter((r) => {
      const odds = current.byProject.get(r.projectId);
      if (odds === undefined || isOnTrack(odds)) return false; // recovered ⇒ nothing to wait on
      if (addressed.has(r.projectId)) return false; // something was done for it
      const cause = causeByProject.get(r.projectId) ?? null;
      return causeMovePref(cause, "hold") > 0;
    })
    .sort(
      (a, b) =>
        (current.byProject.get(a.projectId) ?? 1) -
        (current.byProject.get(b.projectId) ?? 1),
    )
    .slice(0, room)
    .map((r) => ({
      kind: "hold" as const,
      projectId: r.projectId,
      projectName: r.projectName,
      // The cause's own words - nothing invented, nothing promised.
      rationale: `Hold — ${r.cause?.detail ?? "no move improves the odds right now."}`,
      probabilityAfter: r.currentProbability,
      portfolioProbabilityAfter: current.allOnTime,
      causes: [{ cause: causeByProject.get(r.projectId) ?? null, weight: 1 }],
      payload: { kind: "hold" as const },
    }));
}

/**
 * Sequential greedy plan, scored jointly (decision #3). From the base state, each
 * round joint-scores every not-yet-picked candidate against the accumulated
 * picks, keeps the one that best improves the lexicographic objective - 
 * (#on-track ↑, then portfolio conjunction ↑) - folds it in, and repeats. Stops
 * when everyone savable is on track, no remaining candidate gains ≥ `JOINT_MIN_GAIN`
 * on the conjunction (without adding an on-track project), or the move cap is hit.
 * Redundant moves fall out for free: a move whose project is already saved buys
 * ~0 gain, so it's never picked. The chosen set is re-scored once at full
 * iterations for the displayed cumulative odds; each returned move carries its
 * cumulative `portfolioProbabilityAfter`.
 */
function optimizeJointPlan(
  scorer: JointScorer,
  candidates: Candidate[],
  vm: ValueModel,
): { moves: StrategyMove[]; afterEach: number[]; combined: number } {
  const picked: StrategyMove[] = [];
  const remaining = [...candidates];
  let current = { byProject: scorer.baseByProject, allOnTime: scorer.baseAllOnTime };

  // Step 5 slice 4: each project's diagnosed cause picks which move *family* fits,
  // applied alongside the value model's recovery-style taste in the odds-tie
  // tiebreak below. A cross-project move (projectId "" - portfolio-wide triage,
  // activity skip) has no single owning goal, so its cause bias is the weighted
  // mean over every diagnosed goal (the goals it actually serves).
  //
  // The weight is `goalValue × risk` (step-5 follow-on, VM v2). Both terms are
  // needed and neither suffices:
  //   · risk  = 1 − currentProbability - a portfolio move is *about* the goals it
  //     is actually rescuing, so the most endangered should dominate.
  //   · value = the Value Model's per-goal importance (explicit, else derived from
  //     the area weights of its open work) - a doomed errand should not outvote a
  //     salvageable goal that matters.
  // NO-REGRET: with no project weights and no area weights every goalValue is 1, so
  // this reduces bit-identically to the risk-only v1 weighting.
  const openWorkByProject = new Map<string, AllocTask[]>();
  for (const t of scorer.resolveInput.tasks) {
    const bucket = openWorkByProject.get(t.projectId);
    if (bucket) bucket.push(t);
    else openWorkByProject.set(t.projectId, [t]);
  }

  const causeByProject = new Map<string, DivergenceCause>();
  const crossProjectCauses: { cause: DivergenceCause | null; weight: number }[] = [];
  for (const r of scorer.recoveries) {
    if (r.cause) {
      causeByProject.set(r.projectId, r.cause.cause);
      const risk = Math.max(1 - r.currentProbability, 0);
      const value = goalValue(vm, r.projectId, openWorkByProject.get(r.projectId) ?? []);
      crossProjectCauses.push({ cause: r.cause.cause, weight: value * risk });
    }
  }
  /** The cause entries a move is priced against - one per goal it serves. */
  const causesFor = (m: StrategyMove): CauseWeight[] =>
    m.projectId === ""
      ? crossProjectCauses
      : [{ cause: causeByProject.get(m.projectId) ?? null, weight: 1 }];

  const causePrefFor = (m: StrategyMove): number =>
    aggregateCauseMovePref(causesFor(m), m.kind);
  // The style:cause ratio is LEARNED from the user's own accept/decline history
  // (`calibrateMovePrefWeights`), falling back bit-identically to the co-equal
  // 1.0/1.0 prior when nothing has been revealed yet.
  const w = scorer.movePrefWeights;
  const prefFor = (m: StrategyMove): number =>
    w.style * movePref(vm, m.kind) + w.cause * causePrefFor(m);

  while (picked.length < JOINT_MOVE_CAP && remaining.length > 0) {
    // Everyone deadlined is already on track - nothing left worth doing.
    if (onTrackCount(current.byProject) >= current.byProject.size) break;

    let best:
      | { idx: number; result: { byProject: Map<string, number>; allOnTime: number }; pref: number }
      | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const result = scorer.score([...picked, remaining[i].move]);
      const pref = prefFor(remaining[i].move);
      if (best === null) {
        best = { idx: i, result, pref };
        continue;
      }
      // Lexicographic objective: (#on-track ↑, then conjunction ↑) - UNCHANGED.
      // Taste only arbitrates when the conjunction is within an epsilon: a true
      // odds tie defers to the user's recovery-style preference plus the diagnosed
      // cause's preferred move family (step 5 slice 4) - never overriding real odds.
      const otc = onTrackCount(result.byProject);
      const botc = onTrackCount(best.result.byProject);
      let better: boolean;
      if (otc !== botc) {
        better = otc > botc;
      } else {
        const delta = result.allOnTime - best.result.allOnTime;
        better =
          Math.abs(delta) <= PREF_TIE_EPS
            ? pref > best.pref || (pref === best.pref && delta > 0)
            : delta > 0;
      }
      if (better) best = { idx: i, result, pref };
    }
    if (!best) break;

    // Accept a move that saves a project outright, else only if it lifts the
    // conjunction by a real margin (so redundant moves are dropped for free).
    const savesProject =
      onTrackCount(best.result.byProject) > onTrackCount(current.byProject);
    const gain = best.result.allOnTime - current.allOnTime;
    if (!savesProject && gain < JOINT_MIN_GAIN) break;

    picked.push(remaining[best.idx].move);
    remaining.splice(best.idx, 1);
    current = best.result;
  }

  // "Hold / do nothing" as a first-class DECISION (step 5 slice 4 follow-on,
  // limitation #2). We arrive here having concluded that nothing left on the table
  // is worth doing. For a goal whose diagnosed cause says the slip is a blip that
  // recovers on its own, that conclusion is a *choice to wait* - and it deserves to
  // be said, and recorded in the plan-version history, rather than left as the
  // silent absence of a recommendation.
  //
  // The accept gate above is UNTOUCHED: a hold has zero gain and can never win a
  // round against a real move. It is appended only after the loop has already
  // given up, so it cannot displace anything or shorten the plan.
  picked.push(...holdMoves(current, picked, causeByProject, scorer));

  // Re-score the final ordered set once at full iterations for the display.
  const { afterEach, combined } = scorer.cumulative(picked);
  const moves = picked.map((m, i) => ({
    ...m,
    portfolioProbabilityAfter: afterEach[i] ?? m.probabilityAfter,
    // Bake the offer-time cause inputs onto the move so that if the user applies
    // this bundle we can record the revealed preference (`OfferedMove`) without
    // rebuilding a scorer. A single-goal move gets its one cause at weight 1 - 
    // a one-entry weighted mean is the direct lookup, so the weight is inert.
    causes: causesFor(m),
  }));
  return { moves, afterEach, combined };
}

// --- B-fallback. Deterministic (no key / call failed) -----------------------

function templateAssessment(calm: boolean): string {
  return calm
    ? "Everything fits your hours right now — hold course. Log new commitments as they come up and I'll flag any project that slips."
    : "Some projects are competing for the same hours and a few are slipping. The moves below are ordered by how much they recover — apply the top ones first to protect your deadlines.";
}

/**
 * The full demo-mode / synthesis-failure path: no generative proposal, no
 * synthesis. On-track is purely deterministic; the single bold tier is the
 * joint-optimized mechanical plan (decision #8) - contention-correct and free of
 * redundant moves. `grounded` is null here: the bold tier already IS the joint
 * steady plan, so a second copy would just duplicate it (decision #5).
 */
function deterministicFallback(
  scorer: JointScorer,
  candidates: Candidate[],
  fingerprint: string,
  generatedAt: string,
): PortfolioStrategy {
  const onTrack =
    scorer.recoveries.length === 0 && scorer.pitWall.conflicts.length === 0;
  const { moves, combined } = onTrack
    ? { moves: [] as StrategyMove[], combined: scorer.baseAllOnTime }
    : optimizeJointPlan(scorer, candidates, scorer.valueModel);

  return {
    assessment: templateAssessment(onTrack),
    onTrack,
    moves,
    generatedAt,
    fingerprint,
    odds: oddsSnapshot(scorer.forecasts),
    usedLLM: false,
    combinedProbability: combined,
    grounded: null,
    resolveInput: scorer.resolveInput,
  };
}

/**
 * The instant load-path draft when no strategy is cached yet - synchronous and
 * LLM-free, off the already-computed dashboard. It keeps the cheap solo ranking
 * (no extra gather / no joint MC here): each move's `portfolioProbabilityAfter`
 * is seeded from its solo odds as a placeholder. The aggressive auto-refresh
 * immediately replaces this with the real joint-scored, two-tier strategy
 * (decision #5), so this never needs to run the optimizer itself.
 */
export function deterministicStrategyFrom(
  recoveries: RecoveryPlan[],
  pitWall: PitWall,
  forecasts: ProjectForecast[],
  tasksById: Map<string, Task>,
): PortfolioStrategy {
  const candidates = buildDeterministicCandidates(recoveries, pitWall, tasksById);
  const onTrack = recoveries.length === 0 && pitWall.conflicts.length === 0;
  const moves = onTrack
    ? []
    : [...candidates]
        .sort((a, b) => b.move.probabilityAfter - a.move.probabilityAfter)
        .slice(0, MAX_FALLBACK_MOVES)
        .map((c) => ({
          ...c.move,
          portfolioProbabilityAfter: c.move.probabilityAfter,
        }));

  return {
    assessment: templateAssessment(onTrack),
    onTrack,
    moves,
    generatedAt: new Date().toISOString(),
    fingerprint: "",
    odds: oddsSnapshot(forecasts),
    usedLLM: false,
    combinedProbability: moves.length
      ? moves[moves.length - 1].portfolioProbabilityAfter
      : onTrack
        ? 1
        : 0,
    grounded: null,
  };
}

// --- The generator ----------------------------------------------------------

/**
 * Generate the portfolio strategy. Reuses `forecastDashboard()` for the
 * deterministic core, runs ONE bounded generative-proposal call (the LLM's free
 * canvas, validated + forecast-scored), then makes ONE synthesis call that selects
 * from the combined menu. `prev` is fed in for continuity. Falls back to a fully
 * deterministic strategy when the LLM is unconfigured or a call fails.
 *
 * Two LLM calls in the happy path (propose + synthesize). This is the only place
 * the LLM fires; callers gate it behind the deterministic staleness check.
 */
export async function generatePortfolioStrategy(
  prev: PortfolioStrategy | null,
): Promise<PortfolioStrategy> {
  const fingerprint = await computePortfolioFingerprint();
  const generatedAt = new Date().toISOString();
  const today = generatedAt.slice(0, 10);

  // One gather + dashboard, plus the joint scorer the optimizer + bold re-scorer
  // probe against (decision #9 - replaces the old forecastDashboard() call).
  const scorer = await createJointScorer();
  const { forecasts, recoveries, pitWall } = scorer;
  const tasksById = new Map((await listAllTasks()).map((t) => [t.id, t]));
  const candidates = buildDeterministicCandidates(recoveries, pitWall, tasksById);
  // Sacrifice-the-flex: skip an unprotected routine/goal to free its hours. Folded
  // into the mechanical menu so synthesis, the joint optimizer, and the
  // deterministic fallback can all pick it.
  candidates.push(...buildActivitySkipCandidates(scorer));

  // Deterministic fallback: no LLM, no generative proposal, no synthesis. The
  // single bold tier IS the joint-optimized mechanical plan (decision #8).
  if (!isLLMConfigured()) {
    return deterministicFallback(scorer, candidates, fingerprint, generatedAt);
  }

  // B2 - one generative-proposal call (the LLM's free canvas, scored). May be empty.
  const generative = await proposeGenerativeCandidates(recoveries, forecasts);
  const allCandidates = [...candidates, ...generative];

  // B3 - one synthesis call. On any failure, fall back deterministically.
  const drift = planVsTimeDrift(recoveries, forecasts, prev);
  let result: SynthesisResult;
  try {
    result = await synthesize({
      today,
      forecasts,
      pitWall,
      drift,
      prev,
      candidates: allCandidates,
    });
  } catch (err) {
    console.error("Portfolio synthesis failed:", err);
    // allCandidates, not candidates: the generative moves have already been produced,
    // validated and forecast-scored, and throwing them away because the SELECTION step
    // failed loses work that is still perfectly usable.
    return deterministicFallback(scorer, allCandidates, fingerprint, generatedAt);
  }

  // B4 - map selected ids back to moves (dropping any unknown id). The LLM still
  // chooses (decision #7); selection is unchanged from Phase 4.
  const selected = result.selectedIds
    .map((id) => allCandidates[id]?.move)
    .filter((m): m is StrategyMove => m !== undefined);

  // Bold tier: re-score the LLM's exact ordered set jointly so each move shows the
  // running portfolio conjunction (decision #5/#7) instead of its solo odds.
  const bold = scorer.cumulative(selected);
  const moves = selected.map((m, i) => ({
    ...m,
    portfolioProbabilityAfter: bold.afterEach[i] ?? m.probabilityAfter,
  }));

  // Grounded "steady plan" tier (decision #1): mechanical-only moves chosen by the
  // joint greedy optimizer. Null when there's nothing mechanical worth doing.
  const groundedPlan = optimizeJointPlan(scorer, candidates, scorer.valueModel);
  const grounded =
    groundedPlan.moves.length > 0
      ? {
          moves: groundedPlan.moves,
          combinedProbability: groundedPlan.combined,
        }
      : null;

  return {
    assessment: result.assessment,
    onTrack: result.onTrack,
    moves,
    generatedAt,
    fingerprint,
    odds: oddsSnapshot(forecasts),
    usedLLM: true,
    combinedProbability: bold.combined,
    grounded,
    resolveInput: scorer.resolveInput,
  };
}
