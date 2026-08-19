import "server-only";

import type {
  DegradedCriterion,
  GapKind,
  GoalCriterion,
  ModificationKind,
  ModificationPart,
  ModificationSuggestion,
  RecoverySuggestion,
  ReroutePart,
  RerouteSuggestion,
  SuggestedTask,
  TaskModification,
} from "@/lib/types";
import type { Task } from "@/lib/types";
import type { ChatMessage } from "@/lib/bedrock";
import { isLLMConfigured } from "@/lib/extraction";
import {
  getRecoveryContext,
  previewProbabilityWithModifications,
  previewProbabilityWithReroute,
  previewProbabilityWithTasks,
  type RecoveryContext,
} from "@/lib/store";

// LLM strategist, step 1: Generate.
//
// The deterministic recovery engine only rearranges opaque blocks (defer / re-date /
// re-sequence). This is the one move that needs the LLM: proposing NET-NEW corrective tasks for
// holes reality created - rework after a failed review, an unblock action, work to de-risk a
// task blowing its estimate. All advisory and user-approved.
//
// Guardrail: the LLM proposes what to do, only forecast() assigns how likely it is.

const GAP_KINDS: GapKind[] = ["rework", "unblock", "de_risk"];

// Keep the proposal tight - a recovery shouldn't bury the user in new work.
const MAX_SUGGESTIONS = 4;

// Every level of every factor is spelled out. The old version gave endpoints and an
// ellipsis for five of the six, and these numbers feed computePriority directly, so the
// undefined middle was where all the run-to-run variance lived.
const FACTOR_RUBRIC = `Score each 1-5 factor. Use the whole scale.
- Urgency: 5=due today or tomorrow, 4=due this week, 3=due this month, 2=has a deadline beyond a month, 1=no deadline.
- Impact: 5=directly unblocks the deliverable, 4=materially advances it, 3=useful supporting work, 2=nice to have, 1=optional.
- Dependency: 5=blocks several other tasks, 4=blocks one major task, 3=blocks one minor task, 2=loosely coupled, 1=independent.
- Risk: 5=delay seriously hurts the deadline, 4=delay causes visible slippage, 3=delay is recoverable, 2=minor consequence, 1=little consequence.
- Effort: 5=more than 4h, 4=2-4h, 3=1-2h, 2=30-60min, 1=under 30min.
- Confidence: 5=clearly needed, 4=very likely needed, 3=probably needed, 2=a guess with some support, 1=speculative.`;

// Scoped to the fields a number could actually land in. The old blanket "NEVER output a
// probability" was a no-op against a schema with no numeric probability field, while the
// real leak vector - a percentage inside the free text - went unnamed. The user prompt
// hands the model the current probability as context, so a blanket ban was also friction.
const NO_ODDS_RULE = `- Do not put a probability, percentage or odds language inside "rationale", "description" or "priority_reason". Those strings are shown beside TaskBuddy's own computed probability and must not compete with it. The current probability is given to you as context only.`;

const SYSTEM_PROMPT = `You are TaskBuddy's recovery strategist. A project is off track and
the deterministic engine has already tried rearranging the existing work (deferring,
re-dating, re-sequencing). Your job is the one thing it can't do: propose NET-NEW tasks
that fill genuine holes reality created.

Rules:
- Propose tasks ONLY for genuine gaps. If nothing is truly missing — the work just
  needs reordering or the deadline moving — return an EMPTY tasks array. Adding
  busywork makes the plan worse, not better.
- If the open-task list is "(no open tasks)" or the off-track reasons are "(none)",
  return an empty tasks array. There is no gap to fill in an empty plan.
- gap_kind must be one of:
  - "rework": corrective work after a failed/at-risk review (e.g. "Address review
    feedback on X").
  - "unblock": a concrete action that clears a long-blocked task (e.g. "Get sign-off
    from Y", "Provision the staging DB").
  - "de_risk": work to harden a task that is overrunning its estimate (e.g. "Write a
    spike to de-risk the migration").
  Every task must fit one of these three. If a task you were going to propose fits none
  of them, do not propose it.
- Propose at most ${MAX_SUGGESTIONS} tasks, most important first. If more than
  ${MAX_SUGGESTIONS} genuine gaps exist, keep the ones that most improve the chance of
  hitting the deadline: rank by what blocks the most other work, then by soonest deadline
  impact, then by smallest effort.
- Do NOT re-create tasks that already exist. Do NOT split or reshape existing tasks
  (that is a separate move). Only add work that is currently absent.
- due_date must be on or after today and on or before the goal deadline, or null if the
  task has no date of its own.
- blocked_by is a short human-readable note naming what blocks this new task ("waiting on
  the vendor contract"), never a task ref. null when nothing blocks it.
- Keep titles concise and actionable. Estimate minutes realistically.
${NO_ODDS_RULE}

${FACTOR_RUBRIC}`;

// --- Strict response schemas -----------------------------------------------
//
// These replace the prose shape blocks the prompts used to carry. What a schema CAN'T express
// stays in prose and in the normalizers, which are still load-bearing: the scope_down/split
// arithmetic, cross-item ref uniqueness, date validity, and the two forecast() gates. maxItems is
// deliberately unused - it truncates the array without telling the model, so it crams the
// discarded content into the last element instead of planning for the cap.

const FACTOR = { type: "integer", enum: [1, 2, 3, 4, 5] };
const FACTOR_KEYS = [
  "urgency",
  "impact",
  "dependency",
  "risk",
  "effort",
  "confidence",
];
const FACTOR_PROPS = {
  urgency: FACTOR,
  impact: FACTOR,
  dependency: FACTOR,
  risk: FACTOR,
  effort: FACTOR,
  confidence: FACTOR,
};

function taskObject(withGapKind: boolean) {
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
      ...FACTOR_KEYS,
      "priority_reason",
    ],
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      estimated_minutes: { type: "integer" },
      due_date: {
        type: ["string", "null"],
        description: "YYYY-MM-DD between today and the goal deadline, or null.",
      },
      blocked_by: {
        type: ["string", "null"],
        description:
          "Short note naming what blocks this task, never a task ref. null when nothing does.",
      },
      ...(withGapKind
        ? { gap_kind: { type: "string", enum: [...GAP_KINDS] } }
        : {}),
      ...FACTOR_PROPS,
      priority_reason: { type: "string", description: "One sentence." },
    },
  };
}

export const GENERATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["rationale", "tasks"],
  properties: {
    rationale: { type: "string", description: "One sentence: the gap these tasks fill." },
    tasks: { type: "array", items: taskObject(true) },
  },
};

/** Built per request so `task_ref` is a closed set - an invented ref becomes impossible
 *  rather than silently dropped by `normalizeModifications`. */
export function modifySchema(refs: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["rationale", "modifications"],
    properties: {
      rationale: {
        type: "string",
        description: "One sentence naming the overall strategy across all modifications.",
      },
      modifications: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["task_ref", "kind", "rationale", "replacements"],
          properties: {
            task_ref: refs.length
              ? { type: "string", enum: refs }
              : { type: "string" },
            kind: { type: "string", enum: ["scope_down", "split"] },
            rationale: {
              type: "string",
              description:
                "One sentence naming what THIS reshape buys, in minutes or risk.",
            },
            replacements: {
              type: "array",
              description: "Exactly 1 item for scope_down, 2 to 4 for split.",
              items: {
                type: "object",
                additionalProperties: false,
                required: [
                  "title",
                  "description",
                  "estimated_minutes",
                  ...FACTOR_KEYS,
                  "priority_reason",
                ],
                properties: {
                  title: { type: "string" },
                  description: { type: "string" },
                  estimated_minutes: { type: "integer" },
                  ...FACTOR_PROPS,
                  priority_reason: { type: "string", description: "One sentence." },
                },
              },
            },
          },
        },
      },
    },
  };
}

/** Built per request so `criterion_id` is a closed set of C1..Cn handles. This ends the
 *  bracket ambiguity that used to lose degraded-criteria notes silently: the user prompt
 *  renders `- [C1] "text"`, the prompt's example was unbracketed, and the normalizer does
 *  an exact lookup, so `[C1]` matched nothing. */
export function rerouteSchema(handles: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["approach", "rationale", "tasks", "degraded_criteria"],
    properties: {
      approach: {
        type: "string",
        description:
          'Short name of the alternative, e.g. "Use a managed auth provider". Empty string when abstaining.',
      },
      rationale: {
        type: "string",
        description: "One sentence: how it differs and why it fits the budget.",
      },
      tasks: { type: "array", items: taskObject(false) },
      degraded_criteria: {
        type: "array",
        description:
          "Empty when the route preserves the full definition of done, or none was given.",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["criterion_id", "note"],
          properties: {
            criterion_id: handles.length
              ? { type: "string", enum: handles }
              : { type: "string" },
            note: {
              type: "string",
              description: 'How it is lowered, e.g. "managed provider, no SSO".',
            },
          },
        },
      },
    },
  };
}

interface RawSuggestion {
  rationale?: unknown;
  tasks?: unknown;
}

/** Propose net-new corrective tasks for an off-track project. Null when the LLM is
 *  unconfigured, the project isn't off-track, the call fails, or the model finds no genuine
 *  gap - all of those mean "show nothing", so the UI never nags. */
export async function generateCorrectiveTasks(
  projectId: string,
): Promise<RecoverySuggestion | null> {
  if (!isLLMConfigured()) return null;

  const ctx = await getRecoveryContext(projectId);
  if (!ctx) return null;

  // Imported lazily so the app loads without Bedrock configured.
  const { callBedrockJSON } = await import("@/lib/bedrock");

  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(ctx) },
  ];

  let raw: RawSuggestion;
  try {
    raw = await callBedrockJSON<RawSuggestion>(messages, {
      schema: GENERATE_SCHEMA,
      schemaName: "corrective_tasks",
      // Rubric scoring and a genuine-gap judgement, not transcription.
      reasoningEffort: "medium",
      // An empty tasks array is a valid answer ("no gap"); only a missing/
      // non-array tasks field is a failure worth advancing the deployment chain.
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
    // Guardrail: the deterministic forecast() scores the proposal, not the LLM.
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
    `Goal: "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}).`,
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

// LLM strategist, step 2: Modify.
//
// Generate adds net-new work; Modify reshapes what already exists so it fits the budget.
// scope_down replaces a task with a lighter version, split breaks a stuck monolith into real
// steps. Same guardrail: the model proposes the reshape, forecast() scores it, and a reshape
// that doesn't actually improve the odds is dropped before it's shown.

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

Rules:
- Reshape ONLY tasks where it genuinely helps the budget. If the work simply
  needs doing as-is, return an EMPTY modifications array. Don't pad estimates or
  invent steps — a reshape that doesn't shrink the work or the risk is noise.
- Reshape at most ${MAX_MODIFICATIONS} tasks. Rank candidates by estimated_minutes
  descending; break ties in favour of tasks that are blocked or whose title is vague.
  Reshape the top ${MAX_MODIFICATIONS} only.
- At most one modification per task. Never emit two entries with the same "task_ref" —
  choose scope_down or split, not both.
- "replacements" holds exactly 1 item for scope_down, and 2 to 4 for split.
- Each task's current estimate is shown in the request as "(NNNm)". Before answering,
  check: a scope_down replacement's minutes are less than NNN, and a split's step minutes
  sum to no more than NNN. A modification that fails this check is discarded entirely, so
  do not emit it.
- Prefer scope_down for oversized but clear work; split for big/vague/stuck work.
- Keep titles concise and actionable; estimate minutes realistically.
- The top-level "rationale" names the overall strategy across all modifications. Each
  modification's own "rationale" names what that specific reshape buys, in minutes or
  risk. Do not repeat the top-level sentence.
${NO_ODDS_RULE}

${FACTOR_RUBRIC}`;

interface RawModifications {
  rationale?: unknown;
  modifications?: unknown;
}

/** Reshape existing tasks to fit the budget. Null on the same "show nothing" conditions as
 *  Generate. Every surviving modification is one the forecast() confirms improves the odds. */
export async function generateTaskModifications(
  projectId: string,
): Promise<ModificationSuggestion | null> {
  if (!isLLMConfigured()) return null;

  const ctx = await getRecoveryContext(projectId);
  if (!ctx) return null;

  const { callBedrockJSON } = await import("@/lib/bedrock");

  const messages: ChatMessage[] = [
    { role: "system", content: MODIFY_SYSTEM_PROMPT },
    { role: "user", content: buildModifyPrompt(ctx) },
  ];

  let raw: RawModifications;
  try {
    raw = await callBedrockJSON<RawModifications>(messages, {
      schema: modifySchema([...taskRefs(ctx.openTasks).keys()]),
      schemaName: "task_modifications",
      // The two arithmetic checks in the prompt are the reasoning-heaviest thing
      // any strategist move asks for.
      reasoningEffort: "medium",
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
    // Guardrail: the deterministic forecast() scores the reshaped plan.
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
    `Goal: "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}).`,
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

    // Deterministic guardrail: only keep reshapes the forecast() confirms help.
    // Compared against the current probability with a small margin so a change
    // that only moved by forecast() discretization isn't surfaced as a fix.
    if (previewProbabilityWithModifications(ctx, [mod]) <= ctx.currentProbability + 0.005) {
      continue;
    }

    usedTasks.add(task.id);
    out.push(mod);
    if (out.length >= MAX_MODIFICATIONS) break;
  }

  return out;
}

// LLM strategist, step 3: Re-route.
//
// Generate adds and Modify reshapes, both keeping the current approach. This is the boldest
// move: when the path itself won't fit, replace the whole open plan with a different way to hit
// the same deliverable (buy vs build, managed service vs custom). All-or-nothing.
//
// The LLM judges WHETHER a genuinely lighter route exists and WHAT it is, returning nothing
// when the plan only needs trimming - that's Modify's job. forecast() is the sole authority on
// whether the alternative is actually better; a route that doesn't clear the current odds by a
// real margin is dropped before it's shown.

// A whole new plan can run a little longer than Generate's gap-fill, but a
// re-route with a dozen tasks isn't a route, it's another monolith.
const MAX_REROUTE_TASKS = 6;

// A whole-plan swap should clearly help, not move the needle by a rounding step,
// so the bar is well above Modify's 0.005.
const REROUTE_MIN_GAIN = 0.05;

const REROUTE_SYSTEM_PROMPT = `You are TaskBuddy's recovery strategist. A project is off track because its
current plan — the approach itself — won't fit the time budget before the
deadline. Your job is the boldest move: propose a COMPLETE alternative plan that
hits the SAME deliverable by a fundamentally DIFFERENT approach that takes
materially less work.

Think buy-vs-build: a managed service instead of a custom one, a template or
library instead of from-scratch, a narrower good-enough cut of the goal. The new
plan replaces the entire current plan.

Rules:
- Propose a re-route ONLY when a genuinely different approach exists that takes
  materially less work. If the current tasks just need trimming, splitting, or
  reordering, that is a different move, not yours. In that case return "tasks": [],
  "degraded_criteria": [], "approach": "", and a one-sentence "rationale" explaining why
  the current approach is already the right one.
- The new plan must reach the SAME deliverable. Don't quietly drop the goal.
- The request states the current plan's total in minutes and the target your plan must
  come in under. Meet that target; a re-route that does not is pointless.
- At most ${MAX_REROUTE_TASKS} tasks, in the order they would be executed. Estimate
  minutes honestly.
- due_date must be on or after today and on or before the goal deadline, or null.
- HONESTY: "degraded_criteria" is always present. If a definition-of-done list is given
  in the request and your lighter route lowers any of those items, name each compromised
  one by its handle exactly as listed — "C1", "C2", without the square brackets — with a
  short note on how it is lowered. If the route preserves the full definition of done, or
  no definition of done was given, return an empty list. This makes the cost of the cut
  honest; it is not optional when you genuinely lower the bar.
${NO_ODDS_RULE}

${FACTOR_RUBRIC}`;

interface RawReroute {
  approach?: unknown;
  rationale?: unknown;
  tasks?: unknown;
  degraded_criteria?: unknown;
}

/** Propose a whole-plan alternative. Null on the same conditions as the other moves, and also
 *  when the forecast() says the route doesn't beat the current odds by a real margin. */
export async function generateReroute(
  projectId: string,
): Promise<RerouteSuggestion | null> {
  if (!isLLMConfigured()) return null;

  const ctx = await getRecoveryContext(projectId);
  if (!ctx) return null;

  const { callBedrockJSON } = await import("@/lib/bedrock");

  const messages: ChatMessage[] = [
    { role: "system", content: REROUTE_SYSTEM_PROMPT },
    { role: "user", content: buildReroutePrompt(ctx) },
  ];

  let raw: RawReroute;
  try {
    raw = await callBedrockJSON<RawReroute>(messages, {
      schema: rerouteSchema(ctx.criteria.map((_, i) => criterionHandle(i))),
      schemaName: "reroute_plan",
      reasoningEffort: "medium",
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
  // forecast() says it clearly improves the odds.
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
    // The definition-of-done items this lighter route lowers - validated against
    // the goal's real criteria, recorded as degraded notes on accept.
    degradedCriteria: normalizeDegradedCriteria(raw.degraded_criteria, ctx.criteria),
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

  // The definition of done, handle-tagged (C1, C2, …) so the model can flag - by
  // handle, never by raw id - any criterion its lighter route would lower. The
  // handles are the criteria's stable order, the same order the normalizer reads.
  const dod = ctx.criteria.length
    ? [
        ``,
        `The goal's definition of done — if your lighter route lowers any of these, you MUST list it in "degraded_criteria" by its handle (the bare "C1" form, without the brackets):`,
        ...ctx.criteria.map(
          (c, i) =>
            `- [${criterionHandle(i)}] "${c.text}"${c.met ? " (already met)" : ""}`,
        ),
      ].join("\n")
    : `\nNo definition of done is recorded for this goal; return an empty "degraded_criteria" list.`;

  // The model used to be told its plan must be "clearly less" than the current one while
  // being scored against an entirely different, invisible bar. State the number instead,
  // so it optimises the thing it is judged on.
  const currentTotal = estimateTotal(ctx);
  const target = Math.round(currentTotal * 0.6);

  return [
    `Today's date is ${today}.`,
    `Goal: "${ctx.project.name}" (deadline ${ctx.project.deadline?.slice(0, 10) ?? "none"}).`,
    `Current probability of finishing on time: ${Math.round(ctx.currentProbability * 100)}%.`,
    deficitH > 0
      ? `The current plan is roughly ${deficitH}h more work than the budget allows — a re-route must claw most of that back.`
      : `The current plan narrowly fits but is at risk; a lighter route buys real margin.`,
    `The current plan totals ${currentTotal} minutes. Your plan's total must be at most ${target} minutes.`,
    ``,
    `The current plan (this is what a re-route would replace):`,
    open,
    dod,
    ``,
    `Propose a complete alternative plan that reaches the same deliverable with materially less work, or an empty list if no genuinely different approach exists.`,
  ].join("\n");
}

/** Stable C1..Cn handle for a criterion at index `i` - the LLM round-trips this
 *  short handle instead of a raw UUID (far less error-prone), and the normalizer
 *  derives the same mapping from the criteria in their stored order. */
function criterionHandle(i: number): string {
  return `C${i + 1}`;
}

/** Validate the model's degraded-DoD claims against the goal's real criteria. Drops anything
 *  that doesn't map to a provided handle or carries no note, and dedups - so a hallucinated id
 *  can never write a degraded_note. Which criteria exist is the data's call; only the note is
 *  the model's. */
function normalizeDegradedCriteria(
  raw: unknown,
  criteria: GoalCriterion[],
): DegradedCriterion[] {
  if (!Array.isArray(raw) || criteria.length === 0) return [];
  const byHandle = new Map(criteria.map((c, i) => [criterionHandle(i), c]));
  const seen = new Set<string>();
  const out: DegradedCriterion[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    // Brackets stripped defensively: the user prompt renders the handle as `[C1]`, so a
    // model echoing the rendered form used to miss this exact lookup and lose the note.
    // The per-request enum now prevents it, but the guard costs nothing.
    const handle =
      typeof r.criterion_id === "string"
        ? r.criterion_id.trim().replace(/^\[|\]$/g, "")
        : "";
    const note = typeof r.note === "string" ? r.note.trim() : "";
    const c = byHandle.get(handle);
    if (!c || !note || seen.has(c.id)) continue;
    seen.add(c.id);
    out.push({ criterionId: c.id, text: c.text, note });
  }
  return out;
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
