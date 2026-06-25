import type {
  CheckinActionIntent,
  CheckinCandidate,
  CheckinConfidence,
  CheckinIntent,
  CheckinIntentKind,
  CheckinInterpretation,
  CheckinProposal,
  CheckinRegister,
  CheckinReview,
  ResolvedCheckinIntent,
  StrategyMove,
  StrategyMovePayload,
  SuggestedTask,
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

// --- §5.6 stage B — resolveCheckin() (deterministic, zero LLM) ---------------
//
// Fuzzy-bind each ungrounded intent's handle/phrase to the LIVE candidate set →
// resolved | ambiguous | unresolved. The firewall against "marked the wrong task
// done": this module only ever emits ids that exist in the candidate set; an
// uncertain reference surfaces as ambiguous/unresolved for the user, never a
// silent mutation. Pure → the bulk of the Tier-1 golden tests live here.
//
// `attain_skill`-bound intents (skill_gained) resolve against the *unlocked
// skill-node frontier*; the cross-goal spillover detector (slice 4) runs on top
// of these resolutions, not inside them.

/** Which candidate entity types each intent kind may bind to. Kinds that create
 *  NEW work or no entity (add_task, idea, vent) need no resolution → they pass
 *  through as `resolved` with a null match (their "entity" is the source quote). */
const ALLOWED_TYPES: Record<CheckinIntentKind, CheckinCandidate["type"][]> = {
  completed: ["task"],
  reschedule: ["task", "activity"],
  time_logged: ["task"],
  skill_gained: ["skill_node"],
  add_task: [],
  idea: [],
  vent: [],
};

/** Coverage below this is not a match at all. */
const MATCH_THRESHOLD = 0.6;
/** A second candidate within this of the best makes the binding AMBIGUOUS. */
const AMBIGUITY_EPSILON = 0.15;

// Noise tokens stripped before scoring: articles/prepositions plus the action
// verbs a quote-fallback drags in ("finished the auth flow" → {auth, flow}).
const STOPWORDS = new Set([
  "the", "a", "an", "my", "to", "on", "of", "for", "with", "in", "at", "and",
  "or", "this", "that", "it", "i", "im", "ive", "now", "finally", "basic",
  "finished", "completed", "wrapped", "done", "did", "spent", "logged", "push",
  "pushing", "moving", "move", "reschedule", "rescheduling", "deferring", "defer",
  "habit", "task",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Levenshtein distance, capped early — only used for single-token typo tolerance. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return 3; // too far apart to be a typo
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n];
}

/** Two tokens match if equal, a shared ≥4-char prefix (so "auth" binds both "Auth
 *  flow" and "Authorization" — surfacing the ambiguity), or a 1-2 edit typo. */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length < 4 || b.length < 4) return false; // too short for safe fuzzing
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const tol = Math.min(2, Math.floor(Math.min(a.length, b.length) / 4));
  return editDistance(a, b) <= Math.max(1, tol);
}

/**
 * How well the user's phrase is covered by a candidate title: the share of the
 * phrase's content tokens that appear (exact or typo-close) in the title. 1.0 =
 * every word the user used is in the title ("the auth flow" ⊆ "Auth flow setup").
 */
function coverage(phrase: string, title: string): number {
  const pt = tokenize(phrase);
  const tt = tokenize(title);
  if (pt.length === 0 || tt.length === 0) return 0;
  const matched = pt.filter((p) => tt.some((t) => tokensMatch(p, t))).length;
  return matched / pt.length;
}

function resolved(
  intent: CheckinIntent,
  match: CheckinCandidate,
  candidates: CheckinCandidate[],
): ResolvedCheckinIntent {
  return { intent, status: "resolved", match, candidates };
}

/**
 * Resolve one intent against the full candidate set. Handle-exact bind wins; else
 * fuzzy phrase coverage decides. Two near-tied matches ⇒ `ambiguous` (the top is
 * shown but proposed unchecked, all ties offered for disambiguation), never an
 * auto-pick. No match ⇒ `unresolved` (a non-actionable chip).
 */
function resolveOne(
  intent: CheckinIntent,
  candidates: CheckinCandidate[],
): ResolvedCheckinIntent {
  const allowed = ALLOWED_TYPES[intent.kind];
  // Kinds that need no existing entity are resolved by construction.
  if (allowed.length === 0) {
    return { intent, status: "resolved", match: null, candidates: [] };
  }

  const pool = candidates.filter((c) => allowed.includes(c.type));

  // 1. Exact handle bind — the model echoed a candidate handle (already validated
  //    against the prompt set in normalize; the prompt set ⊆ this full set).
  if (intent.handle) {
    const hit = pool.find((c) => c.handle === intent.handle);
    if (hit) return resolved(intent, hit, [hit]);
  }

  // 2. Fuzzy phrase match. Fall back to the quote when no phrase was extracted.
  const phrase = intent.entityPhrase ?? intent.quote;
  const scored = pool
    .map((c) => ({ c, score: coverage(phrase, c.title) }))
    .filter((s) => s.score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { intent, status: "unresolved", match: null, candidates: [] };
  }

  const top = scored[0];
  const ties = scored.filter((s) => top.score - s.score <= AMBIGUITY_EPSILON);
  if (ties.length > 1) {
    // Two comparable matches — surface both, auto-apply neither.
    return {
      intent,
      status: "ambiguous",
      match: top.c,
      candidates: ties.map((s) => s.c),
    };
  }
  return resolved(intent, top.c, [top.c]);
}

/** Stage B: resolve every interpreted intent against the live candidate set. */
export function resolveCheckin(
  interpretation: CheckinInterpretation,
  candidates: CheckinCandidate[],
): ResolvedCheckinIntent[] {
  return interpretation.intents.map((intent) => resolveOne(intent, candidates));
}

// --- §5.6 stage C — proposeFromCheckin() (deterministic) --------------------
//
// Resolved intents → reviewable proposals. Family A (forecast-affecting) become
// `StrategyMove`s that ride S1's review/commit/undo, with odds re-solved through
// the SAME `jointOddsWithMoves` the strategy card uses (so the previewed number ==
// a direct call — the S1 parity gate). Family B (odds-silent) become
// `CheckinActionIntent`s rendered as confirmable but number-less rows. Everything
// that resolved to nothing actionable (unresolved references, vents) becomes a
// chip. Pure: the scoring context is injected, so the whole stage is fixture-testable.
//
// skill_gained → `attain_skill` is the one new move kind and lands in SLICE 4 with
// its forecast arm + persist spec; until then a resolved skill_gained intent is
// surfaced as an inert chip, never silently dropped.

/** The minimal slice of `JointScorer` (lib/store.ts) stage C needs — injected so
 *  the stage stays pure/testable. `cumulative` IS `jointOddsWithMoves` at full
 *  iterations, so odds parity with the strategy card holds by construction. */
export interface CheckinProposeContext {
  today: string;
  baseAllOnTime: number;
  cumulative(ordered: StrategyMove[]): { afterEach: number[]; combined: number };
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Resolve a relative date phrase ("next week", "tomorrow", "in 3 days") to an ISO
 *  date, or null when it names no parseable target (→ a plain defer instead). */
function resolveDatePhrase(phrase: string | null, today: string): string | null {
  if (!phrase) return null;
  const p = phrase.toLowerCase();
  if (/\btomorrow\b/.test(p)) return addDays(today, 1);
  if (/\btoday\b/.test(p)) return today;
  if (/\bnext week\b/.test(p)) return addDays(today, 7);
  if (/\bnext month\b/.test(p)) return addDays(today, 30);
  if (/\bthis week\b/.test(p)) return addDays(today, 3);
  const inDays = p.match(/\bin (\d+) days?\b/);
  if (inDays) return addDays(today, Number(inDays[1]));
  const inWeeks = p.match(/\bin (\d+) weeks?\b/);
  if (inWeeks) return addDays(today, Number(inWeeks[1]) * 7);
  return null;
}

/** Parse a logged-time phrase ("~2h", "90 min", "1.5 hours") to minutes, or null. */
function parseMinutes(detail: string | null): number | null {
  if (!detail) return null;
  const hr = detail.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hr|hour)/i);
  if (hr) return Math.round(Number(hr[1]) * 60);
  const min = detail.match(/(\d+)\s*(?:m\b|min)/i);
  if (min) return Number(min[1]);
  return null;
}

/** A move's review row is checked by default only when its intent is confident AND
 *  cleanly resolved — an ambiguous or low-confidence match is proposed unchecked. */
function isDefaultChecked(r: ResolvedCheckinIntent): boolean {
  return r.status === "resolved" && r.intent.confidence === "high";
}

/** Neutral 1-5 factors for a check-in-captured task — it scores plausibly through
 *  `computePriority` without the interpreter authoring a priority. */
const NEUTRAL_FACTORS = {
  urgency: 3,
  impact: 3,
  dependency: 1,
  risk: 2,
  effort: 2,
  confidence: 3,
} as const;

/** Build the Family-A `StrategyMove` for a resolved intent, or null when the kind
 *  has no forecast-affecting move yet (skill_gained → slice 4) or no valid target. */
function moveForIntent(r: ResolvedCheckinIntent, today: string): StrategyMove | null {
  const { intent, match } = r;
  // Every Family-A move must trace to a resolved entity (the invariant).
  if (!match) return null;

  const base = {
    projectId: match.goalId,
    projectName: match.goalName,
    // Odds are filled in by the cumulative re-solve below; seed at the base.
    probabilityAfter: 0,
    portfolioProbabilityAfter: 0,
  };

  let payload: StrategyMovePayload;
  let rationale: string;

  switch (intent.kind) {
    case "completed":
      payload = { kind: "mark_done", taskId: match.id, title: match.title };
      rationale = `You said you finished "${match.title}".`;
      break;
    case "reschedule": {
      if (match.type === "activity") {
        payload = { kind: "skip_activity", activityId: match.id, title: match.title, period: "week" };
        rationale = `Skipping "${match.title}" this week.`;
        break;
      }
      const dueDate = resolveDatePhrase(intent.detail, today);
      if (dueDate) {
        payload = { kind: "reschedule_task", taskId: match.id, title: match.title, dueDate };
        rationale = `Pushing "${match.title}" to ${dueDate}.`;
      } else {
        payload = { kind: "defer", taskId: match.id, title: match.title };
        rationale = `Setting "${match.title}" aside for now.`;
      }
      break;
    }
    default:
      // completed/reschedule are the only entity-bound Family-A kinds in slice 3.
      return null;
  }

  return { ...base, kind: payload.kind, rationale, payload };
}

/** Build the Family-B odds-silent action for a resolved intent, or null. */
function actionForIntent(r: ResolvedCheckinIntent): CheckinActionIntent | null {
  const { intent, match } = r;
  switch (intent.kind) {
    case "time_logged": {
      if (!match) return null;
      const minutes = parseMinutes(intent.detail);
      if (minutes === null) return null;
      return { kind: "log_progress", taskId: match.id, title: match.title, minutes, quote: intent.quote };
    }
    case "add_task":
    case "idea":
      // v1: a check-in add with no project context is captured as a standalone
      // item (quick errand), not a project-scoped add_tasks move — odds-silent.
      // Project-scoped add_tasks rides with task-scoped NL (slice 6).
      return { kind: "capture_idea", text: intent.detail ?? intent.quote, quote: intent.quote };
    default:
      return null;
  }
}

/**
 * Stage C: turn resolved intents into the review surface. Family-A moves are
 * scored together through one `cumulative` call so each row shows the contention-
 * correct portfolio odds AFTER it (and every move before it) — the exact number the
 * client live re-solve will reproduce. `add_tasks` of a synthesized SuggestedTask is
 * available for a future project-scoped path; v1 keeps captures in Family B.
 */
export function proposeFromCheckin(
  resolved: ResolvedCheckinIntent[],
  ctx: CheckinProposeContext,
): CheckinReview {
  const proposals: CheckinProposal[] = [];
  const chips: ResolvedCheckinIntent[] = [];

  // First pass: classify each resolved intent into a Family-A move, a Family-B
  // action, or a chip — without odds yet (the moves are scored together after).
  type Pending =
    | { family: "A"; resolved: ResolvedCheckinIntent; move: StrategyMove }
    | { family: "B"; resolved: ResolvedCheckinIntent; action: CheckinActionIntent };
  const pending: Pending[] = [];

  for (const r of resolved) {
    if (r.status === "unresolved") {
      chips.push(r);
      continue;
    }
    const move = moveForIntent(r, ctx.today);
    if (move) {
      pending.push({ family: "A", resolved: r, move });
      continue;
    }
    const action = actionForIntent(r);
    if (action) {
      pending.push({ family: "B", resolved: r, action });
      continue;
    }
    // vent, an as-yet-unsupported skill_gained, or a target-less intent → chip.
    chips.push(r);
  }

  // Score every Family-A move together so each carries its cumulative portfolio
  // odds — identical to a direct `jointOddsWithMoves` over the same prefix (S1 parity).
  const familyA = pending.filter((p): p is Extract<Pending, { family: "A" }> => p.family === "A");
  const orderedMoves = familyA.map((p) => p.move);
  const { afterEach } = ctx.cumulative(orderedMoves);
  familyA.forEach((p, i) => {
    const after = afterEach[i] ?? ctx.baseAllOnTime;
    // Solo odds: this one move applied alone (what it buys on its own).
    p.move.probabilityAfter = ctx.cumulative([p.move]).combined;
    p.move.portfolioProbabilityAfter = after;
  });

  for (const p of pending) {
    if (p.family === "A") {
      proposals.push({
        family: "A",
        resolved: p.resolved,
        move: p.move,
        action: null,
        defaultChecked: isDefaultChecked(p.resolved),
      });
    } else {
      proposals.push({
        family: "B",
        resolved: p.resolved,
        move: null,
        action: p.action,
        defaultChecked: isDefaultChecked(p.resolved),
      });
    }
  }

  return { proposals, chips, rawReport: "" };
}

/** Synthesize a SuggestedTask from a captured add-task intent — kept for the
 *  future project-scoped `add_tasks` path (slice 6); unused by the v1 propose. */
export function suggestedTaskFromIntent(intent: CheckinIntent, area: string): SuggestedTask {
  return {
    ...NEUTRAL_FACTORS,
    title: (intent.detail ?? intent.quote).slice(0, 120),
    description: "",
    estimated_minutes: 30,
    due_date: null,
    blocked_by: null,
    priority_reason: "Captured from a check-in.",
    area,
    gap_kind: "rework",
  };
}
