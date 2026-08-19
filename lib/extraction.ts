import type { EntryKind, ExtractionResult } from "@/lib/types";
import type { ChatMessage } from "@/lib/bedrock";
import { heuristicExtract, heuristicPlan } from "@/lib/heuristic";

// Meeting extraction orchestrator.
// Uses Amazon Bedrock when configured; otherwise falls back to the offline
// heuristic extractor so the app is fully usable without any API keys.

// Re-exported from the provider module so there is exactly one definition of
// "is the LLM layer configured". Nine modules and three route components import
// it from here, including app/(app)/layout.tsx, which uses it to decide demo
// mode - a second, drifting copy would silently flip half the app.
export { isLLMConfigured } from "@/lib/bedrock-config";
import { isLLMConfigured } from "@/lib/bedrock-config";

// The 1-5 rubric is shared by both prompts. It used to live only in the meeting prompt while the
// plan prompt referred to "the same rubrics as meeting extraction" - a dangling cross-reference,
// since exactly one of the two is ever sent. Every level is enumerated now: these six numbers
// feed computePriority directly, so an undefined middle level is where the run-to-run variance
// came from.
const FACTOR_RUBRIC = `Score each 1-5 factor. Use the whole scale.
- Urgency: 5=due today or tomorrow, 4=due in 2-3 days, 3=due this week, 2=due next week, 1=no deadline.
- Impact: 5=directly changes a deliverable or a stakeholder decision, 4=materially improves the deliverable, 3=useful supporting work, 2=nice to have, 1=optional.
- Dependency: 5=blocks several other tasks, 4=blocks one major task, 3=blocks one minor task, 2=loosely coupled to other work, 1=independent.
- Risk: 5=delay seriously hurts the deadline or quality, 4=delay causes visible slippage, 3=delay is recoverable, 2=minor consequence, 1=little consequence.
- Effort: 5=more than 4h, 4=2-4h, 3=1-2h, 2=30-60min, 1=under 30min.
- Confidence: 5=explicitly stated, 4=strongly implied, 3=reasonable suggestion, 2=a guess with some support, 1=uncertain.
estimated_minutes must fall inside the Effort bucket you chose.`;

// Constraints a JSON Schema cannot carry, shared by both prompts.
const SHARED_RULES = `- key is a short slug unique within this response, e.g. "t1".
- depends_on may only contain keys of other tasks in this same response. Never a task's own key, and never a cycle. If in doubt, leave it empty.
- Resolve every relative date against the Today's date given in the user message. due_date is YYYY-MM-DD and is never earlier than today.
- At most 15 tasks. At most 8 items in each of discussion_points, key_deliverables, assumptions, risks, decisions and open_questions. If the input yields more, merge the least important.
- On tasks, confidence is a 1-5 number. On decisions and open_questions it is "High", "Medium" or "Low".`;

const SYSTEM_PROMPT = `Convert messy meeting notes, transcripts or chat logs into a structured execution plan.

Rules:
- suggested_area: the single life-area that best fits the entry as a whole. Prefer one of "Work", "Personal", "Hobby"; only invent a new concise area if none fit. Classify by the nature of the activity, not the words used: learning an instrument or a sport is "Hobby", not "Work".
- suggested_project: a short project name that groups these tasks when they form an ongoing initiative or goal; otherwise null. If an existing project is provided and clearly fits, reuse its exact name.
- Extract tasks EXPLICITLY mentioned, AND suggest missing tasks needed to reach the objective. For a suggested task set is_ai_suggested true and source_quote null.
- source_quote must be copied character-for-character from the input, at most 160 characters. If you cannot copy it verbatim, use null. A paraphrased quote is worse than none, because it looks citable.
- Separate decisions (choices made) from tasks (work to do). If an item is both a decision and work to do, emit it in BOTH, with the task's source_quote matching the decision's. If an item is both an open question and work to do, emit it only as a task whose title is the investigation.
- blocked_by is a short human-readable note naming what blocks the task ("waiting on the vendor contract"), never a task key. null when nothing blocks it.
- Always return at least one task. If the input contains no actionable work, return exactly one task naming the clarification needed, with is_ai_suggested true, confidence 1, source_quote null, and a priority_reason saying what is missing.
- Be faithful to the source. Do not invent owners or dates. Keep titles concise.
${SHARED_RULES}

${FACTOR_RUBRIC}`;

const PLAN_SYSTEM_PROMPT = `Convert a personal goal or freeform note into a realistic, actionable plan.

Rules:
- suggested_area: the life-area that best fits this goal. Prefer one of "Work", "Personal", "Hobby". Classify by the nature of the activity: learning an instrument, a craft or a sport is "Hobby", not "Work".
- suggested_project: always propose a short project name for this goal, e.g. "Learning Guitar". If an existing project is provided and clearly fits, reuse its exact name.
- discussion_points, stakeholders, decisions and open_questions must be empty arrays. This is a plan, not a meeting.
- Every task is AI-suggested: is_ai_suggested true, source_quote null, owner null.
- Break the goal into concrete, sequenced steps a person can actually do, and sequence them with depends_on so prerequisites run first. You must acquire an instrument before you can practise it.
- Spread due dates evenly across the goal's stated timeframe. If the input states no timeframe, spread them over the next 30 days.
- If the input is empty or is not a goal at all, return exactly one task asking for the goal to be restated, with confidence 1.
- Keep titles concise and motivating.
${SHARED_RULES}

${FACTOR_RUBRIC}`;

// Strict JSON Schema for ExtractionResult. One schema serves BOTH prompts - the fields are
// identical, only the population rules differ, and the plan-only invariants are enforced in
// normalize() rather than by forking the schema.
//
// Strict mode requires every property in `required` and additionalProperties false everywhere;
// optionality is a ["string","null"] union, never an omitted key. Caps stay in prose - maxItems
// truncates the decoder rather than telling the model, which makes it cram the discarded content
// into the last surviving element.
const CONFIDENCE_ENUM = { type: "string", enum: ["High", "Medium", "Low"] };
const FACTOR = { type: "integer", enum: [1, 2, 3, 4, 5] };

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "title",
    "summary",
    "suggested_area",
    "suggested_project",
    "discussion_points",
    "stakeholders",
    "daily_objective",
    "key_deliverables",
    "assumptions",
    "risks",
    "decisions",
    "open_questions",
    "tasks",
  ],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    suggested_area: {
      type: ["string", "null"],
      description: 'Best life-area for the whole entry: "Work", "Personal", "Hobby", or a new concise area.',
    },
    suggested_project: {
      type: ["string", "null"],
      description: "Concise project name grouping these tasks, or null.",
    },
    discussion_points: { type: "array", items: { type: "string" } },
    stakeholders: { type: "array", items: { type: "string" } },
    daily_objective: { type: "string" },
    key_deliverables: { type: "array", items: { type: "string" } },
    assumptions: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "source_quote", "confidence"],
        properties: {
          decision: { type: "string" },
          source_quote: {
            type: ["string", "null"],
            description: "Verbatim substring of the input, at most 160 chars, or null.",
          },
          confidence: CONFIDENCE_ENUM,
        },
      },
    },
    open_questions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "related_stakeholder", "source_quote", "confidence"],
        properties: {
          question: { type: "string" },
          related_stakeholder: { type: ["string", "null"] },
          source_quote: {
            type: ["string", "null"],
            description: "Verbatim substring of the input, at most 160 chars, or null.",
          },
          confidence: CONFIDENCE_ENUM,
        },
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "key",
          "title",
          "description",
          "owner",
          "category",
          "due_date",
          "estimated_minutes",
          "source_quote",
          "is_ai_suggested",
          "blocked_by",
          "depends_on",
          "urgency",
          "impact",
          "dependency",
          "risk",
          "effort",
          "confidence",
          "priority_reason",
        ],
        properties: {
          key: { type: "string", description: 'Short slug unique in this response, e.g. "t1".' },
          title: { type: "string" },
          description: { type: "string" },
          owner: { type: ["string", "null"] },
          category: { type: ["string", "null"] },
          due_date: {
            type: ["string", "null"],
            description: "YYYY-MM-DD, never earlier than today, or null.",
          },
          estimated_minutes: { type: "integer" },
          source_quote: {
            type: ["string", "null"],
            description: "Verbatim substring of the input, or null for an AI-suggested task.",
          },
          is_ai_suggested: { type: "boolean" },
          blocked_by: {
            type: ["string", "null"],
            description: "Short note naming what blocks this task, never a task key.",
          },
          depends_on: {
            type: "array",
            items: { type: "string" },
            description: "Keys of prerequisite tasks in this same response.",
          },
          urgency: FACTOR,
          impact: FACTOR,
          dependency: FACTOR,
          risk: FACTOR,
          effort: FACTOR,
          confidence: FACTOR,
          priority_reason: { type: "string", description: "One sentence." },
        },
      },
    },
  },
} as const;

const HEURISTIC = {
  meeting: heuristicExtract,
  plan: heuristicPlan,
} as const;

const USER_LABEL: Record<EntryKind, string> = {
  meeting: "Meeting content",
  plan: "Goal or note",
};

// A strict schema removes the malformed-JSON and fenced-output failure modes
// entirely, so only truncation, refusal and 429 remain. Two attempts is enough;
// this was 3 when the fallback was a flaky free-tier model.
const MAX_LLM_ATTEMPTS = 2;

// Prose caps the model is asked to respect. Enforced here too, because a cap
// the model ignores must not reach the database.
const MAX_TASKS = 15;
const MAX_LIST_ITEMS = 8;

/** Extract a structured plan from raw input. `kind` selects the meeting-transcript prompt or the
 *  goal-planning one. Retried up to MAX_LLM_ATTEMPTS - a response with no tasks counts as a
 *  failure, since a fresh attempt often succeeds. If every attempt fails, falls back to the
 *  offline heuristic so the user gets something usable instead of an empty review page. */
export async function extractEntry(
  rawInput: string,
  kind: EntryKind,
  context: { projectNames?: string[] } = {},
): Promise<{ result: ExtractionResult; source: "llm" | "heuristic" }> {
  if (!isLLMConfigured()) {
    return { result: HEURISTIC[kind](rawInput), source: "heuristic" };
  }

  // Imported lazily so the app loads without Bedrock configured; lib/bedrock.ts
  // is server-only.
  const { callBedrockJSON } = await import("@/lib/bedrock");
  const projectHint = context.projectNames?.length
    ? `\n\nExisting projects you may reuse by exact name: ${context.projectNames.join(", ")}.`
    : "";
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: kind === "plan" ? PLAN_SYSTEM_PROMPT : SYSTEM_PROMPT,
    },
    {
      // The variable parts stay in the user message so the system prefix is
      // byte-stable and cacheable. Do not move the date into the system prompt.
      role: "user",
      content: `Today's date is ${new Date()
        .toISOString()
        .slice(0, 10)}.${projectHint}\n\n${USER_LABEL[kind]}:\n"""\n${rawInput}\n"""`,
    },
  ];

  for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
    try {
      const result = await callBedrockJSON<ExtractionResult>(messages, {
        schema: EXTRACTION_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "extraction_result",
        // Extraction is largely transcription; the judgement is in the scoring.
        reasoningEffort: "low",
        // The schema guarantees `tasks` is an array but not that it is
        // non-empty, and an extraction with no tasks is unusable downstream.
        validate: (r) => Array.isArray(r.tasks) && r.tasks.length > 0,
      });
      return { result: normalize(result, kind, rawInput), source: "llm" };
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

/** Enforces what the schema provably can't: the list caps, the plan-only invariants, depends_on
 *  referential integrity, and the verbatim-quote rule. The arr() / ?? null guards below are
 *  unreachable under a strict schema but kept as cheap defence for the heuristic path. */
function normalize(
  r: ExtractionResult,
  kind: EntryKind,
  rawInput: string,
): ExtractionResult {
  const arr = <T>(x: T[] | undefined | null): T[] => (Array.isArray(x) ? x : []);
  const cap = <T>(x: T[] | undefined | null): T[] =>
    arr(x).slice(0, MAX_LIST_ITEMS);
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
  // Provenance is the whole point of source_quote, so a quote that is not
  // actually in the input is dropped rather than shown as citable.
  const haystack = rawInput.toLowerCase();
  const quote = (x: unknown): string | null => {
    const v = str(x);
    if (!v) return null;
    return haystack.includes(v.toLowerCase()) ? v : null;
  };

  const isPlan = kind === "plan";
  const tasks = arr(r.tasks).slice(0, MAX_TASKS);
  // depends_on may only point at keys that exist in this response, and only
  // backwards, which makes a cycle unrepresentable.
  const seen = new Set<string>();

  return {
    title: r.title || "Untitled entry",
    summary: r.summary || "",
    suggested_area: str(r.suggested_area),
    suggested_project: str(r.suggested_project),
    discussion_points: isPlan ? [] : cap(r.discussion_points),
    stakeholders: isPlan ? [] : cap(r.stakeholders),
    daily_objective: r.daily_objective || "",
    key_deliverables: cap(r.key_deliverables),
    assumptions: cap(r.assumptions),
    risks: cap(r.risks),
    decisions: isPlan
      ? []
      : cap(r.decisions).map((d) => ({ ...d, source_quote: quote(d.source_quote) })),
    open_questions: isPlan
      ? []
      : cap(r.open_questions).map((q) => ({
          ...q,
          source_quote: quote(q.source_quote),
        })),
    tasks: tasks.map((t, i) => {
      const key = t.key || `t${i + 1}`;
      const dependsOn = arr(t.depends_on).filter(
        (k) => k !== key && seen.has(k),
      );
      seen.add(key);
      return {
        ...t,
        key,
        title: t.title || "Untitled task",
        description: t.description || "",
        // A plan has no meeting behind it, so these three are structural, not
        // stylistic. Prose asks for them; this guarantees them.
        owner: isPlan ? null : (t.owner ?? null),
        source_quote: isPlan ? null : quote(t.source_quote),
        is_ai_suggested: isPlan ? true : Boolean(t.is_ai_suggested),
        category: t.category ?? null,
        due_date: t.due_date ?? null,
        blocked_by: t.blocked_by ?? null,
        priority_reason: t.priority_reason || "",
        depends_on: dependsOn,
        estimated_minutes: Number(t.estimated_minutes) || 30,
        urgency: score(t.urgency),
        impact: score(t.impact),
        dependency: score(t.dependency),
        risk: score(t.risk),
        effort: score(t.effort),
        confidence: score(t.confidence),
      };
    }),
  };
}
