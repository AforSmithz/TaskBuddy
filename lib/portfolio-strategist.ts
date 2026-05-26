import "server-only";

import { createHash } from "crypto";
import type {
  FactorScores,
  ModificationKind,
  ModificationPart,
  PortfolioStrategy,
  ProjectForecast,
  RecoveryPlan,
  ReroutePart,
  StrategyMove,
  SuggestedTask,
  TaskModification,
} from "./types";
import { isOnTrack } from "./types";
import type { ChatMessage } from "./openrouter";
import { isLLMConfigured } from "./extraction";
import {
  forecastDashboard,
  getRecoveryContext,
  listAllTasks,
  listCommitments,
  listProjects,
  previewProbabilityWithModifications,
  previewProbabilityWithReroute,
  previewProbabilityWithTasks,
  type PitWall,
  type RecoveryContext,
} from "./store";

// The portfolio strategist (Phase 4) — one cached, time-aware recommendation
// across ALL projects. It collapses the per-project recovery stack into a single
// portfolio-wide answer to "reality deviated — how do I move forward?".
//
// Architecture: "select among precomputed candidates," not free-form. The LLM is
// handed a numbered menu of fully-formed candidate moves (each carrying its
// payload + a forecast-scored probability) and returns only the ordered ids to
// include plus prose. It can never invent a probability — the same hard guardrail
// as the per-project strategist (`strategist.ts`).
//
// The menu has two halves:
//   - MECHANICAL moves (defer / reschedule / triage / unblock / mark_done) are
//     *enumerable* — every one is built deterministically off the dashboard. The
//     LLM can't be "more creative" here, so it doesn't author them.
//   - GENERATIVE moves (add_tasks / reshape / reroute) are *invented* — net-new
//     work. Here the LLM proposes freely across the whole portfolio in ONE call;
//     each proposal is validated, resolved against real tasks, and scored by
//     `forecast()` before it becomes a selectable candidate. So the LLM is
//     unconstrained in *what it can propose*, while every probability stays real
//     and every move stays safely applyable.
//
// This module is the ONLY caller of the generator; it runs solely on an explicit
// or auto-triggered refresh (see `refreshPortfolioStrategyAction`), gated by the
// deterministic staleness check below — never blindly on a plain load.

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
 * catching the one transition that matters — a task crossing into "overdue".
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
 * A stable hash of the situation a strategy was generated for — stored for the
 * record / debugging. The *staleness decision* is made by `assessStaleness`
 * (odds-delta + age), not this hash; the fingerprint just records the exact
 * inputs the strategy was synthesized against.
 */
export async function computePortfolioFingerprint(): Promise<string> {
  const [tasks, projects, commitments] = await Promise.all([
    listAllTasks(),
    listProjects(),
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
 * Decide whether a cached strategy is stale — the cheap pre-filter that gates
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

/** A fully-formed candidate the synthesis selects from — never invented by the LLM. */
interface Candidate {
  move: StrategyMove;
  /** Compact one-line menu label shown to the synthesis LLM. */
  label: string;
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
): Candidate[] {
  const out: Candidate[] = [];

  for (const plan of recoveries) {
    const { projectId, projectName, currentProbability } = plan;

    for (const m of plan.defer) {
      out.push({
        move: {
          kind: "defer",
          projectId,
          projectName,
          rationale: `Defer "${m.title}" in ${projectName} past the deadline.`,
          probabilityAfter: m.probabilityAfter,
          payload: { kind: "defer", taskId: m.taskId, title: m.title },
        },
        label: `Defer "${m.title}" (${projectName})`,
      });
    }

    if (plan.reschedule) {
      out.push({
        move: {
          kind: "reschedule_deadline",
          projectId,
          projectName,
          rationale: `Move ${projectName}'s deadline to ${plan.reschedule.deadline}.`,
          probabilityAfter: plan.reschedule.probabilityAfter,
          payload: {
            kind: "reschedule_deadline",
            deadline: plan.reschedule.deadline,
          },
        },
        label: `Move ${projectName}'s deadline to ${plan.reschedule.deadline}`,
      });
    }

    for (const t of plan.overdue) {
      const dueDate = new Date().toISOString().slice(0, 10);
      out.push({
        move: {
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
        },
        label: `Reschedule overdue "${t.title}" (${projectName})`,
      });
      out.push({
        move: {
          kind: "mark_done",
          projectId,
          projectName,
          rationale: `Mark the overdue task "${t.title}" in ${projectName} done.`,
          probabilityAfter: currentProbability,
          payload: { kind: "mark_done", taskId: t.taskId, title: t.title },
        },
        label: `Mark overdue "${t.title}" done (${projectName})`,
      });
    }

    for (const t of plan.blocked) {
      out.push({
        move: {
          kind: "unblock",
          projectId,
          projectName,
          rationale: `Clear the blocker on "${t.title}" in ${projectName}.`,
          probabilityAfter: currentProbability,
          payload: { kind: "unblock", taskId: t.taskId, title: t.title },
        },
        label: `Unblock "${t.title}" (${projectName})`,
      });
    }
  }

  // Cross-project pit-wall triage — the lowest-value doomed work to shed, as one
  // batch. probabilityAfter is the best odds the batch buys (off the forecast).
  if (pitWall.triage.length > 0) {
    const best = pitWall.triage.reduce(
      (m, t) => Math.max(m, t.probabilityAfter),
      0,
    );
    out.push({
      move: {
        kind: "triage",
        projectId: "",
        projectName: "",
        rationale: `Shed ${pitWall.triage.length} low-value task(s) so the shared hours protect your at-risk deadlines.`,
        probabilityAfter: best,
        payload: {
          kind: "triage",
          taskIds: pitWall.triage.map((t) => t.taskId),
          titles: pitWall.triage.map((t) => t.title),
        },
      },
      label: `Triage ${pitWall.triage.length} low-value task(s) across projects`,
    });
  }

  // Escalated ties — each option protects one colliding project by sacrificing
  // the others' open work. A genuine "your call" trade-off.
  for (const opt of pitWall.options) {
    out.push({
      move: {
        kind: "triage",
        projectId: opt.protectId,
        projectName: opt.protectName,
        rationale: `Protect ${opt.protectName} by deferring ${opt.sacrificeNames.join(", ")}.`,
        probabilityAfter: opt.probabilityAfter,
        payload: {
          kind: "triage",
          taskIds: opt.sacrificeTaskIds,
          titles: [],
        },
      },
      label: `Protect ${opt.protectName} (defer ${opt.sacrificeNames.join(", ")})`,
    });
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
- "reshape": reshape an EXISTING task (by its "T#" ref within that project) —
  "scope_down" replaces it with a lighter version (smaller estimate), or "split"
  breaks a vague/stuck monolith into 2-4 concrete steps whose total does not
  exceed the original.
- "reroute": replace a project's ENTIRE open plan with a fundamentally different,
  lighter approach to the same deliverable (buy vs build, template vs scratch).

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "moves": [
    {
      "project": "P1",
      "kind": "add_tasks",
      "rationale": "one sentence: the gap these tasks fill",
      "tasks": [{ "title": string, "description": string, "estimated_minutes": number,
        "due_date": string|null, "blocked_by": string|null,
        "gap_kind": "rework"|"unblock"|"de_risk",
        "urgency": number, "impact": number, "dependency": number, "risk": number,
        "effort": number, "confidence": number, "priority_reason": string }]
    },
    {
      "project": "P1",
      "kind": "reshape",
      "rationale": "one sentence: the reshaping strategy",
      "modifications": [{ "task_ref": "T1", "kind": "scope_down"|"split",
        "rationale": string,
        "replacements": [{ "title": string, "description": string,
          "estimated_minutes": number, "urgency": number, "impact": number,
          "dependency": number, "risk": number, "effort": number,
          "confidence": number, "priority_reason": string }] }]
    },
    {
      "project": "P2",
      "kind": "reroute",
      "approach": "short name of the alternative approach",
      "rationale": "one sentence: how it differs and why it fits",
      "tasks": [{ "title": string, "description": string, "estimated_minutes": number,
        "due_date": string|null, "blocked_by": string|null,
        "urgency": number, "impact": number, "dependency": number, "risk": number,
        "effort": number, "confidence": number, "priority_reason": string }]
    }
  ]
}

Rules:
- Propose moves ONLY where they genuinely help. If a project just needs its work
  done or rearranged, propose nothing for it. An empty "moves" array is valid.
- Only reference projects/tasks by the "P#"/"T#" refs you are given. Never invent a ref.
- A scope_down's estimate MUST be smaller than the original; a split needs 2-4 steps
  whose total does NOT exceed the original; a reroute must be materially lighter.
- Score every 1-5 factor honestly (urgency, impact, dependency, risk, effort,
  confidence), same scale as the existing tasks.
- NEVER output a probability, percentage, or likelihood. You propose the work;
  TaskBuddy scores the odds.`;

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
 * open tasks, and scored by `forecast()` (via the preview helpers) — only ones
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

  // Recovery contexts (open tasks + estimates + odds) for scoring — no LLM here.
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

  const { callOpenRouterJSON } = await import("./openrouter");
  let raw: RawGenerative;
  try {
    raw = await callOpenRouterJSON<RawGenerative>(
      [
        { role: "system", content: GENERATIVE_SYSTEM_PROMPT },
        { role: "user", content: buildGenerativePrompt(ctxByRef) },
      ],
      { validate: (r) => Array.isArray(r.moves) },
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
    const cand = scoreGenerativeMove(m, ctx, projectId, projectName);
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
          return `  T${i + 1}: "${t.title}" (${t.estimated_minutes}m, ${flags.join(", ")})${desc}`;
        })
        .join("\n") || "  (no open tasks)";
    blocks.push(tasks, ``);
  }
  blocks.push(
    `Propose generative moves (add_tasks / reshape / reroute) only where they genuinely help. Empty is fine.`,
  );
  return blocks.join("\n");
}

/** Validate + forecast-score one proposed generative move into a Candidate, or null. */
function scoreGenerativeMove(
  m: Record<string, unknown>,
  ctx: RecoveryContext,
  projectId: string,
  projectName: string,
): Candidate | null {
  const kind = str(m.kind);

  if (kind === "add_tasks") {
    const tasks = normalizeAddTasks(m.tasks, ctx);
    if (tasks.length === 0) return null;
    const prob = previewProbabilityWithTasks(ctx, tasks);
    return {
      move: {
        kind: "add_tasks",
        projectId,
        projectName,
        rationale: str(m.rationale) || `Add corrective tasks to ${projectName}.`,
        probabilityAfter: prob,
        payload: { kind: "add_tasks", tasks },
      },
      label: `Add ${tasks.length} corrective task(s) to ${projectName}`,
    };
  }

  if (kind === "reshape") {
    const mods = normalizeReshape(m.modifications, ctx);
    if (mods.length === 0) return null;
    const prob = previewProbabilityWithModifications(ctx, mods);
    if (prob <= ctx.currentProbability + RESHAPE_MIN_GAIN) return null;
    return {
      move: {
        kind: "reshape",
        projectId,
        projectName,
        rationale: str(m.rationale) || `Reshape work in ${projectName} to fit the budget.`,
        probabilityAfter: prob,
        payload: { kind: "reshape", mods },
      },
      label: `Reshape ${mods.length} task(s) in ${projectName}`,
    };
  }

  if (kind === "reroute") {
    const tasks = normalizeReroute(m.tasks);
    if (tasks.length === 0) return null;
    const prob = previewProbabilityWithReroute(ctx, tasks);
    if (prob <= ctx.currentProbability + REROUTE_MIN_GAIN) return null;
    const approach = str(m.approach) || "A lighter approach to the same goal";
    return {
      move: {
        kind: "reroute",
        projectId,
        projectName,
        rationale: str(m.rationale) || `Re-route ${projectName} to a lighter plan.`,
        probabilityAfter: prob,
        payload: {
          kind: "reroute",
          replacedTaskIds: ctx.openTasks.map((t) => t.id),
          tasks,
          approach,
        },
      },
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

function normalizeReshape(raw: unknown, ctx: RecoveryContext): TaskModification[] {
  if (!Array.isArray(raw)) return [];
  const refs = new Map(ctx.openTasks.map((t, i) => [`T${i + 1}`, t]));
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
 * A compact, deterministic read of how far reality has slipped from the plan —
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

  return lines.length ? lines.join("\n") : "No projects are off track.";
}

// --- B3. Synthesis LLM call -------------------------------------------------

const SYNTHESIS_SYSTEM_PROMPT = `You are TaskBuddy's portfolio strategist. The user lost time, missed some tasks,
and competing projects share one pool of hours. The deterministic engine has
already forecast every project and precomputed a MENU of concrete candidate
moves, each with the probability it would restore (always computed by the
forecast, never by you).

Your job: decide whether the portfolio needs to change at all, and if so, choose
the FEWEST moves from the menu that put the whole portfolio back on the best
footing — then write a short, plain-language assessment.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "on_track": boolean,            // true => hold course; selected_move_ids may be empty
  "assessment": string,           // 2-4 sentences across the whole portfolio, in plain language
  "selected_move_ids": number[]   // ids from the menu, ORDERED best-first; [] is valid when on_track
}

Rules:
- Select ONLY from the given menu, by id. NEVER invent a move, a task, or a
  probability. If you want an action that isn't on the menu, you can't have it.
- Holding course is a valid answer. If the projects already fit and nothing is at
  risk, set on_track=true and return an empty selection.
- Prefer the fewest moves that restore the portfolio. Don't pile on moves that
  don't materially help — a shorter plan the user will actually follow beats a
  longer one they won't.
- The assessment must reason across ALL projects together (including hobby work
  that still competes for the hours), reference the time drift you were given, and
  — when a previous strategy is provided — note continuity ("last time I suggested
  X; you've slipped further, so now…").
- Order selected_move_ids best-first (most important / highest-leverage first).`;

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
  const { callOpenRouterJSON } = await import("./openrouter");

  const messages: ChatMessage[] = [
    { role: "system", content: SYNTHESIS_SYSTEM_PROMPT },
    { role: "user", content: buildSynthesisPrompt(args) },
  ];

  const raw = await callOpenRouterJSON<RawSynthesis>(messages, {
    validate: (r) => Array.isArray(r.selected_move_ids),
  });

  const selectedIds = Array.isArray(raw.selected_move_ids)
    ? raw.selected_move_ids
        .map((n) => Math.trunc(Number(n)))
        .filter((n) => Number.isInteger(n) && n >= 0 && n < args.candidates.length)
    : [];
  const seen = new Set<number>();
  const ordered = selectedIds.filter((id) =>
    seen.has(id) ? false : (seen.add(id), true),
  );

  return {
    onTrack: raw.on_track === true,
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

// --- B-fallback. Deterministic (no key / call failed) -----------------------

function templateAssessment(calm: boolean): string {
  return calm
    ? "Everything fits your hours right now — hold course. Log new commitments as they come up and I'll flag any project that slips."
    : "Some projects are competing for the same hours and a few are slipping. The moves below are ordered by how much they recover — apply the top ones first to protect your deadlines.";
}

/**
 * The full demo-mode / failure path: no generative proposal, no synthesis.
 * On-track is purely deterministic; moves are the mechanical candidate set ranked
 * by recovered odds.
 */
function deterministicFallback(
  candidates: Candidate[],
  recoveries: RecoveryPlan[],
  pitWall: PitWall,
  forecasts: ProjectForecast[],
  fingerprint: string,
  generatedAt: string,
): PortfolioStrategy {
  const onTrack = recoveries.length === 0 && pitWall.conflicts.length === 0;
  const moves = onTrack
    ? []
    : [...candidates]
        .sort((a, b) => b.move.probabilityAfter - a.move.probabilityAfter)
        .slice(0, MAX_FALLBACK_MOVES)
        .map((c) => c.move);

  return {
    assessment: templateAssessment(onTrack),
    onTrack,
    moves,
    generatedAt,
    fingerprint,
    odds: oddsSnapshot(forecasts),
    usedLLM: false,
  };
}

/**
 * Build the deterministic strategy from an already-gathered dashboard — the
 * load-path fallback when no strategy is cached yet. Pure and LLM-free, so a
 * Today/Strategy render can show a genuinely useful strategy immediately without
 * ever firing the generator.
 */
export function deterministicStrategyFrom(
  recoveries: RecoveryPlan[],
  pitWall: PitWall,
  forecasts: ProjectForecast[],
): PortfolioStrategy {
  const candidates = buildDeterministicCandidates(recoveries, pitWall);
  return deterministicFallback(
    candidates,
    recoveries,
    pitWall,
    forecasts,
    "",
    new Date().toISOString(),
  );
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

  const { forecasts, recoveries, pitWall } = await forecastDashboard();
  const candidates = buildDeterministicCandidates(recoveries, pitWall);

  // Deterministic fallback: no LLM, no generative proposal, no synthesis.
  if (!isLLMConfigured()) {
    return deterministicFallback(
      candidates,
      recoveries,
      pitWall,
      forecasts,
      fingerprint,
      generatedAt,
    );
  }

  // B2 — one generative-proposal call (the LLM's free canvas, scored). May be empty.
  const generative = await proposeGenerativeCandidates(recoveries, forecasts);
  const allCandidates = [...candidates, ...generative];

  // B3 — one synthesis call. On any failure, fall back deterministically.
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
    return deterministicFallback(
      candidates,
      recoveries,
      pitWall,
      forecasts,
      fingerprint,
      generatedAt,
    );
  }

  // B4 — map selected ids back to moves (dropping any unknown id).
  const moves = result.selectedIds
    .map((id) => allCandidates[id]?.move)
    .filter((m): m is StrategyMove => m !== undefined);

  return {
    assessment: result.assessment,
    onTrack: result.onTrack,
    moves,
    generatedAt,
    fingerprint,
    odds: oddsSnapshot(forecasts),
    usedLLM: true,
  };
}
