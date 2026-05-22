import type { EntryKind, ExtractionResult } from "./types";
import type { ChatMessage } from "./openrouter";
import { heuristicExtract, heuristicPlan } from "./heuristic";

// Meeting extraction orchestrator.
// Uses OpenRouter when configured; otherwise falls back to the offline
// heuristic extractor so the app is fully usable without any API keys.

export function isLLMConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

const SYSTEM_PROMPT = `You are TaskBuddy's meeting analyst. You convert messy meeting
notes, transcripts, or chat logs into a structured execution plan.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "title": string,
  "summary": string,
  "suggested_area": string,        // best life-area for the whole entry
  "suggested_project": string|null,// concise project name grouping these tasks, or null
  "discussion_points": string[],
  "stakeholders": string[],
  "daily_objective": string,
  "key_deliverables": string[],
  "assumptions": string[],
  "risks": string[],
  "decisions": [{ "decision": string, "source_quote": string|null, "confidence": "High"|"Medium"|"Low" }],
  "open_questions": [{ "question": string, "related_stakeholder": string|null, "source_quote": string|null, "confidence": "High"|"Medium"|"Low" }],
  "tasks": [{
    "key": string,                 // unique slug, e.g. "t1", used by depends_on
    "title": string,
    "description": string,
    "owner": string|null,
    "category": string|null,
    "due_date": string|null,       // ISO date YYYY-MM-DD or null
    "estimated_minutes": number,
    "source_quote": string|null,   // null for AI-suggested tasks
    "is_ai_suggested": boolean,
    "blocked_by": string|null,     // short note if blocked
    "depends_on": string[],        // keys of prerequisite tasks
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
- suggested_area: the single life-area that best fits the entry as a whole. Prefer
  one of "Work", "Personal", "Hobby"; only invent a new concise area if none fit.
  Classify by the nature of the activity, not the words used — e.g. learning an
  instrument or a sport is "Hobby", not "Work".
- suggested_project: a short project name that groups these tasks when they form an
  ongoing initiative or goal; otherwise null. If an existing project is provided
  and clearly fits, reuse its exact name.
- Extract tasks EXPLICITLY mentioned, AND suggest missing tasks needed to reach the
  objective (set is_ai_suggested true, source_quote null for those).
- Score each 1-5 factor honestly using these rubrics:
  Urgency: 5=due today/tomorrow, 4=2-3 days, 3=this week, 2=next week, 1=no deadline.
  Impact: 5=directly affects deliverable/stakeholder decision ... 1=optional.
  Dependency: 5=blocks multiple tasks, 4=blocks one major task ... 1=independent.
  Risk: 5=delay seriously hurts deadline/quality ... 1=little consequence.
  Effort: 5=>4h, 4=2-4h, 3=1-2h, 2=30-60min, 1=<30min.
  Confidence: 5=explicitly stated, 4=strongly implied, 3=reasonable suggestion ... 1=uncertain.
- Separate decisions (choices made) from tasks (work to do).
- Open questions are unresolved points that need follow-up.
- Keep titles concise. Be faithful to the source; do not invent owners or dates.`;

const PLAN_SYSTEM_PROMPT = `You are TaskBuddy's planning coach. You convert a personal
goal or freeform note into a realistic, actionable plan.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "title": string,                 // a short name for the goal
  "summary": string,                // a brief overview of the plan
  "suggested_area": string,          // best life-area: "Work", "Personal", "Hobby", ...
  "suggested_project": string,       // a concise project name for this goal
  "discussion_points": [],           // leave empty
  "stakeholders": [],                // leave empty
  "daily_objective": string,         // restate the goal as a clear objective
  "key_deliverables": string[],      // the milestones that mark real progress
  "assumptions": string[],           // assumptions the plan relies on
  "risks": string[],                 // things that could derail the plan
  "decisions": [],                   // leave empty
  "open_questions": [],              // leave empty
  "tasks": [{
    "key": string,                 // unique slug, e.g. "t1", used by depends_on
    "title": string,
    "description": string,
    "owner": null,
    "category": string|null,
    "due_date": string|null,       // ISO date YYYY-MM-DD or null
    "estimated_minutes": number,
    "source_quote": null,
    "is_ai_suggested": true,        // every task in a plan is AI-suggested
    "blocked_by": string|null,
    "depends_on": string[],        // keys of prerequisite tasks
    "urgency": number,             // 1-5
    "impact": number,              // 1-5
    "dependency": number,          // 1-5
    "risk": number,                // 1-5
    "effort": number,              // 1-5
    "confidence": number,          // 1-5
    "priority_reason": string
  }]
}

Rules:
- suggested_area: the life-area that best fits this goal. Prefer one of "Work",
  "Personal", "Hobby"; classify by the nature of the activity — learning an
  instrument, a craft, or a sport is "Hobby", not "Work".
- suggested_project: always propose a short project name for this goal (e.g.
  "Learning Guitar"). If an existing project is provided and clearly fits, reuse
  its exact name.
- Break the goal into concrete, sequenced steps a person can actually do.
- Sequence the steps with depends_on so prerequisite steps run first (e.g. you
  must acquire an instrument before you can practice it).
- Spread due dates sensibly across the goal's timeframe (e.g. "this week").
- Score each 1-5 factor using the same rubrics as meeting extraction.
- Every task is AI-suggested: set is_ai_suggested true and source_quote null.
- Keep titles concise and motivating.`;

const HEURISTIC = {
  meeting: heuristicExtract,
  plan: heuristicPlan,
} as const;

const USER_LABEL: Record<EntryKind, string> = {
  meeting: "Meeting content",
  plan: "Goal or note",
};

// A flaky free model can return an empty or unusable response on any given
// call, so the LLM extraction is retried this many times before giving up.
const MAX_LLM_ATTEMPTS = 3;

/**
 * Extract a structured plan from raw input. `kind` selects the meeting
 * transcript prompt or the goal-planning prompt.
 *
 * The LLM call is retried up to MAX_LLM_ATTEMPTS times — a response with no
 * tasks is treated as a failure, since a fresh attempt often succeeds. If
 * every attempt fails, falls back to the offline heuristic so the user always
 * gets a usable result instead of an empty review page.
 */
export async function extractEntry(
  rawInput: string,
  kind: EntryKind,
  context: { projectNames?: string[] } = {},
): Promise<{ result: ExtractionResult; source: "llm" | "heuristic" }> {
  if (!isLLMConfigured()) {
    return { result: HEURISTIC[kind](rawInput), source: "heuristic" };
  }

  // Imported lazily so the app loads without an OpenRouter key configured.
  const { callOpenRouterJSON } = await import("./openrouter");
  const projectHint = context.projectNames?.length
    ? `\n\nExisting projects you may reuse by exact name: ${context.projectNames.join(", ")}.`
    : "";
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: kind === "plan" ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT,
    },
    {
      role: "user",
      content: `Today's date is ${new Date()
        .toISOString()
        .slice(0, 10)}.${projectHint}\n\n${USER_LABEL[kind]}:\n"""\n${rawInput}\n"""`,
    },
  ];

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      const result = await callOpenRouterJSON<ExtractionResult>(messages, {
        // An extraction with no tasks is unusable: reject it so the model
        // fallback chain advances, and so this whole attempt counts as a
        // failure worth retrying.
        validate: (r) => Array.isArray(r.tasks) && r.tasks.length > 0,
      });
      return { result: normalize(result), source: "llm" };
    } catch (err) {
      console.error(
        `LLM extraction attempt ${attempt}/${MAX_LLM_ATTEMPTS} failed:`,
        err,
      );
    }
  }

  console.error(
    "LLM extraction exhausted all attempts, using heuristic fallback.",
  );
  return { result: HEURISTIC[kind](rawInput), source: "heuristic" };
}

/** Defensive normalisation in case the model omits arrays or mistypes fields. */
function normalize(r: ExtractionResult): ExtractionResult {
  const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
  // Clamp a 1-5 factor score; default to the neutral 3 when missing/invalid.
  const score = (n: unknown): number => {
    const v = Math.round(Number(n));
    return Number.isFinite(v) ? Math.min(5, Math.max(1, v)) : 3;
  };
  // Trim a string field, treating blanks/non-strings as null.
  const str = (x: unknown): string | null => {
    const v = typeof x === "string" ? x.trim() : "";
    return v.length > 0 ? v : null;
  };
  return {
    title: r.title || "Untitled entry",
    summary: r.summary || "",
    suggested_area: str(r.suggested_area),
    suggested_project: str(r.suggested_project),
    discussion_points: arr(r.discussion_points),
    stakeholders: arr(r.stakeholders),
    daily_objective: r.daily_objective || "",
    key_deliverables: arr(r.key_deliverables),
    assumptions: arr(r.assumptions),
    risks: arr(r.risks),
    decisions: arr(r.decisions),
    open_questions: arr(r.open_questions),
    tasks: arr(r.tasks).map((t, i) => ({
      ...t,
      key: t.key || `t${i + 1}`,
      title: t.title || "Untitled task",
      description: t.description || "",
      owner: t.owner ?? null,
      category: t.category ?? null,
      due_date: t.due_date ?? null,
      source_quote: t.source_quote ?? null,
      blocked_by: t.blocked_by ?? null,
      priority_reason: t.priority_reason || "",
      depends_on: arr(t.depends_on),
      estimated_minutes: Number(t.estimated_minutes) || 30,
      is_ai_suggested: Boolean(t.is_ai_suggested),
      urgency: score(t.urgency),
      impact: score(t.impact),
      dependency: score(t.dependency),
      risk: score(t.risk),
      effort: score(t.effort),
      confidence: score(t.confidence),
    })),
  };
}
