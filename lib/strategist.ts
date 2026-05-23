import "server-only";

import type { GapKind, RecoverySuggestion, SuggestedTask } from "./types";
import type { ChatMessage } from "./openrouter";
import { isLLMConfigured } from "./extraction";
import {
  getRecoveryContext,
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
