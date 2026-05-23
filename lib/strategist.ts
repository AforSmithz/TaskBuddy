import "server-only";

import type {
  GapKind,
  ModificationKind,
  ModificationPart,
  ModificationSuggestion,
  RecoverySuggestion,
  ReroutePart,
  RerouteSuggestion,
  SuggestedTask,
  TaskModification,
} from "./types";
import type { Task } from "./types";
import type { ChatMessage } from "./openrouter";
import { isLLMConfigured } from "./extraction";
import {
  getRecoveryContext,
  previewProbabilityWithModifications,
  previewProbabilityWithReroute,
  previewProbabilityWithTasks,
  type RecoveryContext,
} from "./store";

// LLM strategist — Step 1: Generate.
//
// The deterministic recovery engine only rearranges opaque blocks (defer /
// re-date / re-sequence). This module is the one move that needs the LLM: it
// proposes *net-new* corrective tasks for genuine holes reality created —
// rework after a failed review, an unblock action, or work to de-risk a task
// that's blowing its estimate. Everything here is advisory and user-approved.
//
// Hard guardrail: the LLM proposes *what to do*; only `forecast()` (via
// previewProbabilityWithTasks) assigns *how likely it is*. The model never
// emits a probability.

const GAP_KINDS: GapKind[] = ["rework", "unblock", "de_risk"];

// Keep the proposal tight — a recovery shouldn't bury the user in new work.
const MAX_SUGGESTIONS = 4;

const SYSTEM_PROMPT = `You are TaskBuddy's recovery strategist. A project is off track and
the deterministic engine has already tried rearranging the existing work (deferring,
re-dating, re-sequencing). Your job is the one thing it can't do: propose NET-NEW tasks
that fill genuine holes reality created.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "rationale": string,             // one sentence: the gap these tasks fill
  "tasks": [{
    "title": string,
    "description": string,
    "estimated_minutes": number,
    "due_date": string|null,       // ISO date YYYY-MM-DD or null
    "blocked_by": string|null,     // short note if this new task is itself blocked
    "gap_kind": "rework"|"unblock"|"de_risk",
    "urgency": number,             // 1-5
    "impact": number,              // 1-5
    "dependency": number,          // 1-5
    "risk": number,                // 1-5
    "effort": number,              // 1-5
    "confidence": number,          // 1-5
    "priority_reason": string      // one sentence explaining the priority
  }]
}

Rules:
- Propose tasks ONLY for genuine gaps. If nothing is truly missing — the work just
  needs reordering or the deadline moving — return an EMPTY tasks array. Adding
  busywork makes the plan worse, not better.
- gap_kind must be one of:
  - "rework": corrective work after a failed/at-risk review (e.g. "Address review
    feedback on X").
  - "unblock": a concrete action that clears a long-blocked task (e.g. "Get sign-off
    from Y", "Provision the staging DB").
  - "de_risk": work to harden a task that is overrunning its estimate (e.g. "Write a
    spike to de-risk the migration").
- Do NOT re-create tasks that already exist. Do NOT split or reshape existing tasks
  (that is a separate move). Only add work that is currently absent.
- Score each 1-5 factor honestly:
  Urgency: 5=due today/tomorrow ... 1=no deadline.
  Impact: 5=directly unblocks the deliverable ... 1=optional.
  Dependency: 5=blocks multiple tasks ... 1=independent.
  Risk: 5=delay seriously hurts the deadline ... 1=little consequence.
  Effort: 5=>4h, 4=2-4h, 3=1-2h, 2=30-60min, 1=<30min.
  Confidence: 5=clearly needed ... 1=speculative.
- Keep titles concise and actionable. Estimate minutes realistically.
- NEVER output a probability, percentage, or likelihood. You propose the work;
  TaskBuddy scores the odds.`;

interface RawSuggestion {
  rationale?: unknown;
  tasks?: unknown;
}

/**
 * Propose net-new corrective tasks for an off-track project. Returns null when
 * the LLM is unconfigured, the project isn't off-track, the call fails, or the
 * model finds no genuine gap — every one of those means "show nothing", so the
 * UI never nags. The returned probability is computed by `forecast()`.
 */
export async function generateCorrectiveTasks(
  projectId: string,
): Promise<RecoverySuggestion | null> {
  if (!isLLMConfigured()) return null;

  const ctx = await getRecoveryContext(projectId);
  if (!ctx) return null;

  // Imported lazily so the app loads without an OpenRouter key configured.
  const { callOpenRouterJSON } = await import("./openrouter");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(ctx) },
  ];

  let raw: RawSuggestion;
  try {
    raw = await callOpenRouterJSON<RawSuggestion>(messages, {
      // An empty tasks array is a valid answer ("no gap"); only a missing/
      // non-array tasks field is a failure worth advancing the model chain.
      validate: (r) => Array.isArray(r.tasks),
    });
  } catch (err) {
    console.error("Strategist task generation failed:", err);
    return null;
  }

  const tasks = normalizeTasks(raw.tasks, ctx);
  if (tasks.length === 0) return null;

  return {
    projectId,
    tasks,
    // Guardrail: the deterministic forecast scores the proposal, not the LLM.
    previewProbability: previewProbabilityWithTasks(ctx, tasks),
    rationale:
      typeof raw.rationale === "string" && raw.rationale.trim()
        ? raw.rationale.trim()
        : "Corrective tasks to fill gaps in the current plan.",
  };
}

/** The off-track signals + open work the model reasons over. */
function buildUserPrompt(ctx: RecoveryContext): string {
  const today = new Date().toISOString().slice(0, 10);
  const reasons = ctx.reasons.map((r) => `- ${r.detail}`).join("\n") || "- (none)";

  const open = ctx.openTasks
    .map((t) => {
      const flags: string[] = [`status=${t.status}`];
      if (t.blocked_by) flags.push(`blocked_by="${t.blocked_by}"`);
      if (t.due_date) flags.push(`due=${t.due_date.slice(0, 10)}`);
      return `- "${t.title}" (${t.estimated_minutes}m, ${flags.join(", ")})`;
    })
    .join("\n") || "- (no open tasks)";

  const deficitH = Math.max(0, Math.round((estimateTotal(ctx) - ctx.deployable) / 60));

  return [
    `Today's date is ${today}.`,
    `Project: "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}).`,
    `Current probability of finishing on time: ${Math.round(ctx.currentProbability * 100)}%.`,
    deficitH > 0
      ? `The open work is roughly ${deficitH}h more than the time budget allows.`
      : `The open work fits the budget, but the plan is flagged for the reasons below.`,
    ``,
    `Why it's off track:`,
    reasons,
    ``,
    `Open tasks:`,
    open,
    ``,
    `Propose net-new corrective tasks ONLY for genuine gaps, or an empty list if none.`,
  ].join("\n");
}

function estimateTotal(ctx: RecoveryContext): number {
  return ctx.openTasks.reduce((s, t) => s + t.estimated_minutes, 0);
}

/** Clamp/coerce the model's tasks into SuggestedTask, dedup, and cap the count. */
function normalizeTasks(raw: unknown, ctx: RecoveryContext): SuggestedTask[] {
  if (!Array.isArray(raw)) return [];

  // Clamp a 1-5 factor; default to the neutral 3 when missing/invalid.
  const score = (n: unknown): number => {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
  };
  const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
  const gap = (x: unknown): GapKind =>
    GAP_KINDS.includes(x as GapKind) ? (x as GapKind) : "rework";

  const existing = new Set(
    ctx.openTasks.map((t) => t.title.trim().toLowerCase()),
  );
  const seen = new Set<string>();
  const out: SuggestedTask[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const t = item as Record<string, unknown>;
    const title = str(t.title);
    if (!title) continue;
    const key = title.toLowerCase();
    // Skip tasks that already exist or that the model repeated.
    if (existing.has(key) || seen.has(key)) continue;
    seen.add(key);

    const minutes = Math.round(Number(t.estimated_minutes));
    out.push({
      title,
      description: str(t.description),
      estimated_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
      due_date: str(t.due_date) || null,
      blocked_by: str(t.blocked_by) || null,
      priority_reason: str(t.priority_reason),
      area: ctx.area,
      gap_kind: gap(t.gap_kind),
      urgency: score(t.urgency),
      impact: score(t.impact),
      dependency: score(t.dependency),
      risk: score(t.risk),
      effort: score(t.effort),
      confidence: score(t.confidence),
    });
    if (out.length >= MAX_SUGGESTIONS) break;
  }

  return out;
}

// LLM strategist — Step 2: Modify.
//
// Generate adds net-new work; Modify reshapes the work that already exists so it
// fits the budget. Two moves, both needing the LLM to understand what a task *is*:
//   - scope_down: replace a task with a lighter version (smaller estimate).
//   - split:      break a stuck monolith into smaller real steps.
//
// Same hard guardrail as Generate: the model proposes the reshape;
// `previewProbabilityWithModifications` (i.e. `forecast()`) scores it, and a
// reshape that doesn't actually improve the odds is dropped before it's shown.

const MOD_KINDS: ModificationKind[] = ["scope_down", "split"];

// Reshaping more than a few tasks at once stops being a recovery and starts
// being a re-plan (that's Step 3).
const MAX_MODIFICATIONS = 3;

const MODIFY_SYSTEM_PROMPT = `You are TaskBuddy's recovery strategist. A project is off track because the open
work doesn't fit the time budget. The deterministic engine has already tried
deferring and re-dating. Your job is the move it can't make: reshape EXISTING
tasks so the plan fits, without dropping the deliverable.

You have two moves per task:
- "scope_down": replace a task with a lighter version that takes less time — a
  smaller, good-enough cut of the same work (e.g. "Full test suite" -> "Smoke
  tests for the critical path"). The new estimate MUST be smaller than the
  original.
- "split": break one big, vague, or stuck task into 2-4 smaller concrete steps.
  Splitting a fuzzy monolith into well-understood steps lowers estimation risk
  even when the minutes are similar. The steps' total MUST NOT exceed the
  original estimate.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "rationale": string,               // one sentence: the reshaping strategy
  "modifications": [{
    "task_ref": string,              // the "T#" ref of the existing task to reshape
    "kind": "scope_down"|"split",
    "rationale": string,             // one sentence: why this reshape helps
    "replacements": [{               // 1 item for scope_down, 2-4 for split
      "title": string,
      "description": string,
      "estimated_minutes": number,
      "urgency": number,             // 1-5
      "impact": number,              // 1-5
      "dependency": number,          // 1-5
      "risk": number,                // 1-5
      "effort": number,              // 1-5
      "confidence": number,          // 1-5
      "priority_reason": string      // one sentence
    }]
  }]
}

Rules:
- Reshape ONLY tasks where it genuinely helps the budget. If the work simply
  needs doing as-is, return an EMPTY modifications array. Don't pad estimates or
  invent steps — a reshape that doesn't shrink the work or the risk is noise.
- Only reference tasks by their given "T#" ref. Never invent a ref.
- Reshape at most ${MAX_MODIFICATIONS} tasks — pick the ones with the most slack
  to recover (usually the largest or most uncertain).
- Prefer scope_down for oversized but clear work; split for big/vague/stuck work.
- Keep titles concise and actionable; estimate minutes realistically.
- Score each 1-5 factor honestly (urgency, impact, dependency, risk, effort,
  confidence), same scale as the original tasks.
- NEVER output a probability, percentage, or likelihood. You propose the reshape;
  TaskBuddy scores the odds.`;

interface RawModifications {
  rationale?: unknown;
  modifications?: unknown;
}

/**
 * Reshape existing tasks to fit the budget. Returns null on the same "show
 * nothing" conditions as Generate (LLM unconfigured, project on-track, the call
 * fails, or nothing reshapes usefully). Every surviving modification is one the
 * deterministic forecast confirms actually improves the odds.
 */
export async function generateTaskModifications(
  projectId: string,
): Promise<ModificationSuggestion | null> {
  if (!isLLMConfigured()) return null;

  const ctx = await getRecoveryContext(projectId);
  if (!ctx) return null;

  const { callOpenRouterJSON } = await import("./openrouter");

  const messages: ChatMessage[] = [
    { role: "system", content: MODIFY_SYSTEM_PROMPT },
    { role: "user", content: buildModifyPrompt(ctx) },
  ];

  let raw: RawModifications;
  try {
    raw = await callOpenRouterJSON<RawModifications>(messages, {
      validate: (r) => Array.isArray(r.modifications),
    });
  } catch (err) {
    console.error("Strategist task modification failed:", err);
    return null;
  }

  const mods = normalizeModifications(raw.modifications, ctx);
  if (mods.length === 0) return null;

  return {
    projectId,
    modifications: mods,
    // Guardrail: the deterministic forecast scores the reshaped plan.
    previewProbability: previewProbabilityWithModifications(ctx, mods),
    rationale:
      typeof raw.rationale === "string" && raw.rationale.trim()
        ? raw.rationale.trim()
        : "Reshape the heaviest open work to fit the budget.",
  };
}

/** Stable "T#" ref → task, so the model points at tasks without leaking UUIDs. */
function taskRefs(openTasks: Task[]): Map<string, Task> {
  return new Map(openTasks.map((t, i) => [`T${i + 1}`, t]));
}

/** The open tasks (with refs + estimates) the model reshapes. */
function buildModifyPrompt(ctx: RecoveryContext): string {
  const today = new Date().toISOString().slice(0, 10);
  const refs = taskRefs(ctx.openTasks);

  const open = [...refs.entries()]
    .map(([ref, t]) => {
      const flags: string[] = [`status=${t.status}`];
      if (t.blocked_by) flags.push(`blocked_by="${t.blocked_by}"`);
      if (t.due_date) flags.push(`due=${t.due_date.slice(0, 10)}`);
      return `- ${ref}: "${t.title}" (${t.estimated_minutes}m, ${flags.join(", ")})`;
    })
    .join("\n") || "- (no open tasks)";

  const deficitH = Math.max(0, Math.round((estimateTotal(ctx) - ctx.deployable) / 60));

  return [
    `Today's date is ${today}.`,
    `Project: "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}).`,
    `Current probability of finishing on time: ${Math.round(ctx.currentProbability * 100)}%.`,
    deficitH > 0
      ? `The open work is roughly ${deficitH}h more than the time budget allows — reshaping needs to claw that back.`
      : `The open work narrowly fits, but the plan is at risk; reshaping the riskiest work buys margin.`,
    ``,
    `Open tasks:`,
    open,
    ``,
    `Reshape existing tasks to fit the budget, or return an empty list if none should change.`,
  ].join("\n");
}

/** Clamp/coerce the model's modifications, resolve refs, drop the ones that don't help. */
function normalizeModifications(
  raw: unknown,
  ctx: RecoveryContext,
): TaskModification[] {
  if (!Array.isArray(raw)) return [];

  const refs = taskRefs(ctx.openTasks);
  const score = (n: unknown): number => {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
  };
  const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
  const kindOf = (x: unknown): ModificationKind =>
    MOD_KINDS.includes(x as ModificationKind) ? (x as ModificationKind) : "scope_down";

  const part = (x: unknown): ModificationPart | null => {
    if (typeof x !== "object" || x === null) return null;
    const p = x as Record<string, unknown>;
    const title = str(p.title);
    if (!title) return null;
    const minutes = Math.round(Number(p.estimated_minutes));
    return {
      title,
      description: str(p.description),
      estimated_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
      priority_reason: str(p.priority_reason),
      urgency: score(p.urgency),
      impact: score(p.impact),
      dependency: score(p.dependency),
      risk: score(p.risk),
      effort: score(p.effort),
      confidence: score(p.confidence),
    };
  };

  const usedTasks = new Set<string>();
  const out: TaskModification[] = [];

  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const task = refs.get(str(m.task_ref));
    // Skip unknown refs and tasks already reshaped by an earlier modification.
    if (!task || usedTasks.has(task.id)) continue;

    const kind = kindOf(m.kind);
    const parts = Array.isArray(m.replacements)
      ? (m.replacements.map(part).filter((p): p is ModificationPart => p !== null))
      : [];

    let replacements: ModificationPart[];
    if (kind === "scope_down") {
      const lighter = parts[0];
      // A scope-down must actually be lighter than the original.
      if (!lighter || lighter.estimated_minutes >= task.estimated_minutes) continue;
      replacements = [lighter];
    } else {
      // A split needs at least two steps and must not inflate the total work.
      if (parts.length < 2) continue;
      const total = parts.reduce((s, p) => s + p.estimated_minutes, 0);
      if (total > task.estimated_minutes) continue;
      replacements = parts.slice(0, 4);
    }

    const mod: TaskModification = {
      kind,
      taskId: task.id,
      taskTitle: task.title,
      originalEstimate: task.estimated_minutes,
      rationale: str(m.rationale),
      replacements,
    };

    // Deterministic guardrail: only keep reshapes the forecast confirms help.
    // Compared against the current probability with a small margin so a change
    // that only moved by forecast discretization isn't surfaced as a fix.
    if (previewProbabilityWithModifications(ctx, [mod]) <= ctx.currentProbability + 0.005) {
      continue;
    }

    usedTasks.add(task.id);
    out.push(mod);
    if (out.length >= MAX_MODIFICATIONS) break;
  }

  return out;
}

// LLM strategist — Step 3: Re-route.
//
// Generate adds, Modify reshapes — both keep the current plan's *approach*. This
// is the boldest move: when the path itself won't fit, replace the entire open
// plan with a different way to hit the same deliverable (buy vs build, a managed
// service vs custom, a template vs from-scratch). All-or-nothing — the user
// switches to the new approach or keeps the old one.
//
// The division of labour: the LLM judges *whether* a genuinely lighter route
// exists and *what* it is (returning nothing when the plan only needs trimming —
// that's Modify's job). `previewProbabilityWithReroute` (i.e. `forecast()`) is
// the sole authority on whether the alternative is actually better; a re-route
// that doesn't clear the current odds by a real margin is dropped before it's
// shown. As always, the model never emits a probability.

// A whole new plan can run a little longer than Generate's gap-fill, but a
// re-route with a dozen tasks isn't a route, it's another monolith.
const MAX_REROUTE_TASKS = 6;

// A whole-plan swap should clearly help, not move the needle by a rounding step,
// so the bar is well above Modify's 0.005.
const REROUTE_MIN_GAIN = 0.05;

const REROUTE_SYSTEM_PROMPT = `You are TaskBuddy's recovery strategist. A project is off track because its
current plan — the approach itself — won't fit the time budget before the
deadline. The deterministic engine has already tried rearranging the work, and
the other strategist moves add or reshape individual tasks. Your job is the
boldest move: propose a COMPLETE alternative plan that hits the SAME deliverable
by a fundamentally DIFFERENT approach that takes materially less work.

Think buy-vs-build: a managed service instead of a custom one, a template or
library instead of from-scratch, a narrower good-enough cut of the goal. The new
plan replaces the entire current plan.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "approach": string,            // short name of the alternative (e.g. "Use a managed auth provider")
  "rationale": string,           // one sentence: how it differs and why it fits the budget
  "tasks": [{
    "title": string,
    "description": string,
    "estimated_minutes": number,
    "due_date": string|null,     // ISO date YYYY-MM-DD or null
    "blocked_by": string|null,   // short note if this task is itself blocked
    "urgency": number,           // 1-5
    "impact": number,            // 1-5
    "dependency": number,        // 1-5
    "risk": number,              // 1-5
    "effort": number,            // 1-5
    "confidence": number,        // 1-5
    "priority_reason": string    // one sentence explaining the priority
  }]
}

Rules:
- Propose a re-route ONLY when a genuinely different approach exists that takes
  materially less work. If the current tasks just need trimming, splitting, or
  reordering, return an EMPTY tasks array — that is a different move, not yours.
- The new plan must reach the SAME deliverable. Don't quietly drop the goal.
- The new plan's total estimated time must be clearly less than the current
  plan's, or the re-route is pointless.
- Keep it to a handful of concrete, actionable tasks. Estimate minutes honestly.
- Score each 1-5 factor (urgency, impact, dependency, risk, effort, confidence),
  same scale as the original tasks.
- NEVER output a probability, percentage, or likelihood. You propose the route;
  TaskBuddy scores the odds.`;

interface RawReroute {
  approach?: unknown;
  rationale?: unknown;
  tasks?: unknown;
}

/**
 * Propose a whole-plan alternative for an off-track project. Returns null on the
 * same "show nothing" conditions as the other moves (LLM unconfigured, project
 * on-track, the call fails, the model finds no genuine alternative) — and also
 * when the deterministic forecast says the proposed route doesn't beat the
 * current odds by a real margin. The probability is always `forecast()`'s.
 */
export async function generateReroute(
  projectId: string,
): Promise<RerouteSuggestion | null> {
  if (!isLLMConfigured()) return null;

  const ctx = await getRecoveryContext(projectId);
  if (!ctx) return null;

  const { callOpenRouterJSON } = await import("./openrouter");

  const messages: ChatMessage[] = [
    { role: "system", content: REROUTE_SYSTEM_PROMPT },
    { role: "user", content: buildReroutePrompt(ctx) },
  ];

  let raw: RawReroute;
  try {
    raw = await callOpenRouterJSON<RawReroute>(messages, {
      validate: (r) => Array.isArray(r.tasks),
    });
  } catch (err) {
    console.error("Strategist re-route failed:", err);
    return null;
  }

  const tasks = normalizeReroute(raw.tasks);
  if (tasks.length === 0) return null;

  const previewProbability = previewProbabilityWithReroute(ctx, tasks);
  // Deterministic guardrail: a whole-plan swap only earns its place if the
  // forecast says it clearly improves the odds.
  if (previewProbability <= ctx.currentProbability + REROUTE_MIN_GAIN) {
    return null;
  }

  return {
    projectId,
    approach:
      typeof raw.approach === "string" && raw.approach.trim()
        ? raw.approach.trim()
        : "A lighter approach to the same goal",
    rationale:
      typeof raw.rationale === "string" && raw.rationale.trim()
        ? raw.rationale.trim()
        : "Replace the current plan with a lighter route to the same deliverable.",
    tasks,
    replaces: ctx.openTasks.map((t) => ({
      taskId: t.id,
      title: t.title,
      estimated_minutes: t.estimated_minutes,
    })),
    previewProbability,
  };
}

/** The deliverable + the full open plan (with descriptions) the model re-routes. */
function buildReroutePrompt(ctx: RecoveryContext): string {
  const today = new Date().toISOString().slice(0, 10);

  // Descriptions matter here: re-routing needs the substance of the work to
  // infer the deliverable and find a different way to reach it.
  const open = ctx.openTasks
    .map((t) => {
      const desc = t.description?.trim() ? ` — ${t.description.trim()}` : "";
      return `- "${t.title}" (${t.estimated_minutes}m)${desc}`;
    })
    .join("\n") || "- (no open tasks)";

  const deficitH = Math.max(0, Math.round((estimateTotal(ctx) - ctx.deployable) / 60));

  return [
    `Today's date is ${today}.`,
    `Project: "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}).`,
    `Current probability of finishing on time: ${Math.round(ctx.currentProbability * 100)}%.`,
    deficitH > 0
      ? `The current plan is roughly ${deficitH}h more work than the budget allows — a re-route must claw most of that back.`
      : `The current plan narrowly fits but is at risk; a lighter route buys real margin.`,
    ``,
    `The current plan (this is what a re-route would replace):`,
    open,
    ``,
    `Propose a complete alternative plan that reaches the same deliverable with materially less work, or an empty list if no genuinely different approach exists.`,
  ].join("\n");
}

/** Clamp/coerce the model's alternative tasks into ReroutePart, dedup, cap the count. */
function normalizeReroute(raw: unknown): ReroutePart[] {
  if (!Array.isArray(raw)) return [];

  const score = (n: unknown): number => {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
  };
  const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");

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

    const minutes = Math.round(Number(t.estimated_minutes));
    out.push({
      title,
      description: str(t.description),
      estimated_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 30,
      due_date: str(t.due_date) || null,
      blocked_by: str(t.blocked_by) || null,
      priority_reason: str(t.priority_reason),
      urgency: score(t.urgency),
      impact: score(t.impact),
      dependency: score(t.dependency),
      risk: score(t.risk),
      effort: score(t.effort),
      confidence: score(t.confidence),
    });
    if (out.length >= MAX_REROUTE_TASKS) break;
  }

  return out;
}
