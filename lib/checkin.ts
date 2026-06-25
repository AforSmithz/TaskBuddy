import type {
  CheckinCandidate,
  CheckinConfidence,
  CheckinIntent,
  CheckinIntentKind,
  CheckinInterpretation,
  CheckinRegister,
} from "./types";
import type { ChatMessage } from "./openrouter";

// §5.6 stage A — interpret a free-form activity report into ungrounded, quoted,
// register-tagged intents (design/s5.6-nl-checkin-loop.md). Shaped exactly like
// `lib/extraction.ts`: an OpenRouter call when configured, else an offline
// heuristic parser, so the loop is fully usable with no API key. The LLM stays on
// natural language — it may echo a candidate HANDLE but never a DB id; the
// deterministic stage B (resolveCheckin) does the binding (§0 firewall).
//
// Divergence from extraction: an EMPTY `intents` array is VALID, not a failure —
// a pure vent ("ugh, rough day") legitimately yields zero moves. So `validate`
// checks the *presence* of the array, never its length, and there is no retry-on-
// empty loop.

export function isLLMConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

const INTENT_KINDS: readonly CheckinIntentKind[] = [
  "completed",
  "reschedule",
  "add_task",
  "skill_gained",
  "time_logged",
  "idea",
  "vent",
];

const REGISTERS: readonly CheckinRegister[] = ["status", "idea", "vent"];

const SYSTEM_PROMPT = `You are TaskBuddy's check-in interpreter. The user types a
free-form report of what they did, what changed, ideas, or how they feel. You turn
it into a list of typed, UNGROUNDED intents — one per distinct clause.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "intents": [{
    "kind": "completed"|"reschedule"|"add_task"|"skill_gained"|"time_logged"|"idea"|"vent",
    "register": "status"|"idea"|"vent",
    "quote": string,            // a VERBATIM span copied from the report — the words that triggered this intent
    "handle": string|null,      // the handle of the candidate entity this clause names, copied EXACTLY from the list below; null if it names none
    "entityPhrase": string|null,// the user's own words for that entity (e.g. "the auth flow"); null if none
    "detail": string|null,      // kind-specific: the target time for reschedule ("next week"), the new title for add_task, the amount for time_logged ("~2h"), the note for idea; else null
    "confidence": "high"|"low"  // how sure you are this clause is a real, correctly-typed intent
  }]
}

Intent kinds:
- "completed": the user says they finished / did / wrapped up an EXISTING item. -> names a task handle.
- "reschedule": the user is pushing / postponing / moving an existing item to a later time. -> names a task handle + a time in "detail".
- "add_task": the user says they need to do something NOT already in the list. -> handle null, entityPhrase null, the new work in "detail".
- "skill_gained": the user says they can now do something they couldn't before ("I can finally write a SQL join"). -> names a skill handle if one matches, else handle null + the skill in "detail".
- "time_logged": the user reports how long they spent on an existing item ("spent ~2h on the API client"). -> names a task handle + the amount in "detail".
- "idea": a thought / suggestion to capture for later, register "idea".
- "vent": an emotional note with no action ("ugh, rough day"), register "vent".

Rules:
- Output one intent per distinct clause. A report may yield several intents, or
  ZERO (a pure vent that names nothing is still fine — return an empty array).
- The "quote" MUST be a verbatim substring of the report. Never paraphrase it.
- For "handle", copy a handle from the candidate list EXACTLY, or use null. NEVER
  invent a handle or emit a database id. If unsure which candidate is meant, set
  handle null and put the user's words in "entityPhrase" — downstream code resolves it.
- Respect NEGATION: "did NOT finish the auth flow" is not a "completed" intent.
- "register" is the tone (status update / idea / vent); "kind" is the action.
- Be faithful: do not invent work, times, or completions the user didn't state.`;

/** Format the candidate set for the prompt, mirroring extraction's project hint
 *  (`T3 "Build the API client" — Project: Mobile App`). Capped by the caller. */
function formatCandidates(candidates: CheckinCandidate[]): string {
  if (candidates.length === 0) return "";
  const lines = candidates
    .map(
      (c) =>
        `${c.handle} "${c.title}"${c.goalName ? ` — ${c.type === "skill_node" ? "Skill in" : "Project"}: ${c.goalName}` : ""}`,
    )
    .join("\n");
  return `\n\nCandidate entities you may reference by handle (open work only):\n${lines}`;
}

/**
 * Interpret a check-in report into ungrounded intents. `candidates` is the capped
 * prompt set the model may reference by handle; stage B resolves against the full
 * set. Falls back to the offline heuristic parser when no key is configured or the
 * model fails — both paths feed the identical deterministic stages B + C.
 */
export async function interpretCheckin(
  rawReport: string,
  candidates: CheckinCandidate[] = [],
): Promise<{ result: CheckinInterpretation; source: "llm" | "heuristic" }> {
  const report = rawReport.trim();
  if (!isLLMConfigured()) {
    return { result: heuristicInterpret(report), source: "heuristic" };
  }

  const { callOpenRouterJSON } = await import("./openrouter");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content: `Today's date is ${new Date()
        .toISOString()
        .slice(0, 10)}.${formatCandidates(candidates)}\n\nThe user's check-in:\n"""\n${report}\n"""`,
    },
  ];

  try {
    const result = await callOpenRouterJSON<CheckinInterpretation>(messages, {
      // Presence, NOT non-emptiness: a vent with zero intents is a valid result.
      validate: (r) => Array.isArray(r.intents),
    });
    return { result: normalize(result, report, candidates), source: "llm" };
  } catch (err) {
    console.error("LLM check-in interpret failed, using heuristic fallback:", err);
    return { result: heuristicInterpret(report), source: "heuristic" };
  }
}

const VALID_HANDLES = (candidates: CheckinCandidate[]) =>
  new Set(candidates.map((c) => c.handle));

/** Defensive normalisation: drop malformed intents, clamp enums, and — the safety
 *  property — strip any `handle` the model invented that isn't in the candidate set
 *  (so stage B can never bind to a fabricated handle; it falls back to the phrase). */
function normalize(
  r: CheckinInterpretation,
  rawReport: string,
  candidates: CheckinCandidate[],
): CheckinInterpretation {
  const handles = VALID_HANDLES(candidates);
  const str = (x: unknown): string | null => {
    const v = typeof x === "string" ? x.trim() : "";
    return v.length > 0 ? v : null;
  };
  const intents = (Array.isArray(r.intents) ? r.intents : [])
    .map((raw): CheckinIntent | null => {
      const quote = str(raw?.quote);
      if (!quote) return null; // no provenance ⇒ unusable (invariant)
      const kind = INTENT_KINDS.includes(raw?.kind) ? raw.kind : "vent";
      const register = REGISTERS.includes(raw?.register)
        ? raw.register
        : defaultRegister(kind);
      const handle = str(raw?.handle);
      const confidence: CheckinConfidence = raw?.confidence === "low" ? "low" : "high";
      return {
        kind,
        register,
        quote,
        // Strip a hallucinated handle — only an echoed candidate handle survives.
        handle: handle && handles.has(handle) ? handle : null,
        entityPhrase: str(raw?.entityPhrase),
        detail: str(raw?.detail),
        confidence,
      };
    })
    .filter((i): i is CheckinIntent => i !== null);
  return { intents, rawReport };
}

function defaultRegister(kind: CheckinIntentKind): CheckinRegister {
  if (kind === "idea") return "idea";
  if (kind === "vent") return "vent";
  return "status";
}

// --- Offline heuristic parser ----------------------------------------------
//
// A weak verb/keyword parser so the loop works with no API key and so the Tier-2
// contract tests run an always-green path in CI. It never produces a handle (it
// can't match the candidate set reliably) — it leans on `entityPhrase`, which
// stage B fuzzy-resolves. Deliberately conservative: prefer a `vent`/`idea` chip
// over a wrong `completed`.

const COMPLETED_RE = /\b(finished|completed|wrapped up|wrapped|done with|did the|got through|shipped)\b/i;
const RESCHEDULE_RE = /\b(push(?:ing)?|postpon\w*|defer\w*|moving|move|reschedul\w*|bumping|put off)\b/i;
const ADD_RE = /\b(need to|have to|also need|must|should|todo|to-do|add a|going to)\b/i;
const SKILL_RE = /\b(can (?:now|finally)|finally (?:can|able)|learned (?:how|to)|figured out how|now able to|i can)\b/i;
const TIME_RE = /\b(spent|put in|logged|took me)\b|~?\s*\d+\s*(?:h\b|hr|hour|min|m\b)/i;
const IDEA_RE = /\b(idea|maybe|thinking about|what if|consider|might)\b/i;
const NEGATION_RE = /\b(not|didn'?t|couldn'?t|won'?t|failed to|haven'?t)\b/i;

/** Split a report into clauses on sentence punctuation, commas, and conjunctions.
 *  Deliberately greedy — a weak parser over-splitting ("ugh, rough day" → two vent
 *  clauses) is harmless; under-splitting (one clause with two actions) is not. */
function splitClauses(report: string): string[] {
  return report
    .split(/[.!?;\n]+|,\s*|\s+\b(?:and then|and also|and|but|then|also)\b\s+/i)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

function classifyClause(clause: string): CheckinIntentKind {
  const negated = NEGATION_RE.test(clause);
  // A negated completion isn't a completion — fall through to a status/vent note.
  if (!negated && COMPLETED_RE.test(clause)) return "completed";
  if (RESCHEDULE_RE.test(clause)) return "reschedule";
  if (!negated && SKILL_RE.test(clause)) return "skill_gained";
  if (TIME_RE.test(clause)) return "time_logged";
  if (ADD_RE.test(clause)) return "add_task";
  if (IDEA_RE.test(clause)) return "idea";
  return "vent";
}

/** Pull the user's entity phrase from a clause: the words after the action verb,
 *  stripped of leading articles — a best-effort surface form for stage B. */
function extractPhrase(clause: string, kind: CheckinIntentKind): string | null {
  const after = clause.replace(
    /^.*?\b(finished|completed|wrapped up|wrapped|done with|did the|push(?:ing)?|postpon\w*|defer\w*|moving|reschedul\w*|spent|logged|need to|have to|add a)\b\s*/i,
    "",
  );
  const phrase = after
    // For "spent ~2h on the API client" drop the leading duration + "on/for".
    .replace(/^~?\s*\d+\s*(?:h\b|hr\w*|hour\w*|min\w*|m\b)\s*(?:on|for)?\s*/i, "")
    .replace(/^(the|a|an|my|to|on|with)\s+/i, "")
    .replace(/\s+(to|by|next|tomorrow|this|until).*$/i, "")
    .trim();
  if (kind === "vent" || kind === "idea" || kind === "add_task") return null;
  return phrase.length > 1 && phrase !== clause ? phrase : null;
}

function heuristicInterpret(rawReport: string): CheckinInterpretation {
  const intents = splitClauses(rawReport)
    .map((clause): CheckinIntent | null => {
      const kind = classifyClause(clause);
      // A bare vent clause that names nothing actionable is still emitted as a
      // vent intent (so the review can acknowledge it), but skip empty noise.
      return {
        kind,
        register: defaultRegister(kind),
        quote: clause,
        handle: null,
        entityPhrase: extractPhrase(clause, kind),
        detail:
          kind === "add_task" || kind === "idea"
            ? clause
            : kind === "reschedule" || kind === "time_logged"
              ? (clause.match(/\b(next week|tomorrow|today|this week|~?\s*\d+\s*(?:h\b|hr|hour|min|m\b)[^,.]*)/i)?.[0]?.trim() ?? null)
              : null,
        // Heuristic can't gauge real confidence; mark low so review proposes it
        // unchecked (the user confirms) rather than auto-applying a guess.
        confidence: "low",
      };
    })
    .filter((i): i is CheckinIntent => i !== null);
  return { intents, rawReport };
}
