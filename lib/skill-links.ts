import type { ExtractedLink, LinkSuggestion, LinkVerdict, SkillNode, Task } from "./types";
import type { ChatMessage } from "./openrouter";
import { isLLMConfigured } from "./checkin";
import { skillProgress } from "./skill";

// The skill-node ↔ task linker (the LLM-proposes half of §0, applied to spillover).
//
// Why this needs a model at all: the decomposer phrases a skill node as a CAPABILITY
// ("Navigate a short spontaneous conversation") and the extraction pipeline phrases a
// task as an ACTION ("Take weekly italki lesson"). Those describe the same evening and
// share no words. Measured over the real workspace: 0 of 81 node×task pairs cleared the
// fuzzy title matcher's bar, while the matcher scored a hand-written matching pair at
// 1.00 — it works, it just cannot see this relation. So the edge is proposed
// semantically, confirmed by the user, and only then read by spillover.
//
// The model proposes pairs + prose. It never outputs a score, a probability, or an
// ordering — `forecast()` remains the sole owner of odds (§0).
//
// No `server-only` directive and no static `openrouter` import: the client is pulled in
// dynamically inside the one async call, exactly as `checkin.ts` does it, so the pure
// half (`sanitizeLinks`, `pairKey`) stays importable from a plain-Node test harness.

/** Cap what the model sees, so a large workspace can't blow the context window. */
const MAX_NODES = 40;
const MAX_TASKS = 60;
/** Cap what it can propose in one pass — a linker that returns 50 pairs is guessing. */
const MAX_LINKS = 12;

const SYSTEM_PROMPT = `You are TaskBuddy's work linker. You are given SKILLS (capabilities
someone is learning) and TASKS (concrete work they have to do). A few tasks, when done,
DEMONSTRATE one of the skills — the same effort proves both. Your job is to find those.

For EACH task, name the single skill it most directly demonstrates, or null if none.

Return ONLY a JSON object with this exact shape (no markdown, no commentary):

{
  "links": {
    "T1": {"node_key": "N2", "rationale": "one short sentence: why doing T1 shows N2"},
    "T2": null
  }
}

Rules:
- One skill per task, at most. If a task seems to demonstrate several skills, it is broad
  practice rather than proof — name the single most specific skill it shows, or null.
  One band rehearsal brushes against tuning, rhythm and improvisation; crediting all three
  would hand over a syllabus for one evening's work.
- Ask of each pair: "having done this task, is THIS skill now demonstrated?" If the honest
  answer is "it helped, a bit", the answer is null.
- Do NOT link on topic overlap alone. "Buy a new capo" and "Play barre chords" are both
  guitar, but buying gear demonstrates no technique.
- A skill may be demonstrated by more than one task. Most tasks link to nothing; null is
  the common, correct answer.
- Most SKILLS will have no task at all. Leaving a skill unused is the normal, correct
  outcome — do not try to find a home for every skill on the list. A list of five skills
  and no suitable tasks should produce five nulls.
- Skills and tasks may belong to different goals. A task from an unrelated-sounding goal
  can still be the very work that demonstrates a skill.
- Every link is shown to the user for confirmation before it does anything. You are
  drafting a shortlist for review, not making an irreversible decision.
- At most ${MAX_LINKS} non-null links.
- rationale is one plain sentence. Never include numbers, scores, percentages, or
  estimates of any kind.

Worked example.

SKILLS:
N1: Play a song end-to-end from memory
N2: Read standard notation
TASKS:
T1: Record a demo track
T2: Buy a new capo
T3: Sight-read one etude each morning

Correct answer:
{"links":{
  "T1": {"node_key":"N1","rationale":"Recording a take means playing the song straight through from memory."},
  "T2": null,
  "T3": {"node_key":"N2","rationale":"Sight-reading an etude is reading standard notation."}
}}`;

/** Reject a response that carries no `links` container, so the model chain advances to
 *  the fallback model. Both the task-keyed map and the legacy array are usable. */
function isUsable(d: LinkSuggestion): boolean {
  const links = (d as { links?: unknown })?.links;
  return Array.isArray(links) || (typeof links === "object" && links !== null);
}

/**
 * Longest path from a root, over the goal's own prerequisite DAG — a node's specificity.
 * Foundations sit at depth 0; a capstone with three layers of prerequisites at depth 3.
 * Cycle-safe (the decomposer's `sanitizeSkills` already strips them, but a hand-edited
 * graph must not hang this). Used only to break a tie between two candidate skills.
 */
export function nodeDepth(node: SkillNode, byId: Map<string, SkillNode>): number {
  const memo = new Map<string, number>();
  const walk = (id: string, seen: Set<string>): number => {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0; // cycle guard
    const n = byId.get(id);
    if (!n || n.prerequisites.length === 0) return 0;
    seen.add(id);
    const d = 1 + Math.max(...n.prerequisites.map((p) => walk(p, seen)));
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  return walk(node.id, new Set());
}

/**
 * When a model ignores the one-skill-per-task schema and returns an array, collapse it
 * deterministically instead of trusting its ordering.
 *
 * Ordering cannot be trusted: in the observed fan-out the model emitted the skills in
 * plain graph order (N1, N2, … N8), so "keep the first" would have kept the two most
 * FOUNDATIONAL, least specific skills. In a well-formed run it led with the most advanced.
 * Same code, opposite meaning. So the tiebreak is explicit: a checkpoint (the decomposer
 * defines those as milestones you could prove to someone — exactly demonstration) beats a
 * drill; deeper in the DAG beats shallower; the model's order decides only a true tie.
 */
export function bestPerTask(
  entries: { taskKey: string; node: SkillNode; rationale: string; order: number }[],
  byId: Map<string, SkillNode>,
): { taskKey: string; node: SkillNode; rationale: string }[] {
  const best = new Map<string, { taskKey: string; node: SkillNode; rationale: string; order: number }>();
  for (const e of entries) {
    const cur = best.get(e.taskKey);
    if (!cur) {
      best.set(e.taskKey, e);
      continue;
    }
    const better =
      Number(e.node.is_checkpoint) - Number(cur.node.is_checkpoint) ||
      nodeDepth(e.node, byId) - nodeDepth(cur.node, byId) ||
      cur.order - e.order;
    if (better > 0) best.set(e.taskKey, e);
  }
  return [...best.values()]
    .sort((a, b) => a.order - b.order)
    .map((e) => ({ taskKey: e.taskKey, node: e.node, rationale: e.rationale }));
}

/**
 * Second pass: judge ONE pair, with no other skills or tasks in context.
 *
 * The two failures this rejects were both observed live, and both were rationalised
 * fluently inside the assignment prompt: "Watch a Spanish show" → "Describe daily routines
 * with present tense verbs" (passive exposure standing in for a productive skill), and
 * "Set measurable milestones for conversation goal" → "Express future plans and intentions"
 * (a pun — planning your study in English is not expressing future plans in Spanish).
 * Alone, with nothing to assign, each is easy to reject.
 */
const VERIFY_SYSTEM_PROMPT = `You are checking ONE claim, in isolation. You are given a
single TASK and a single SKILL.

Question: does carrying out that task NECESSARILY involve performing that skill? Not
"could it", not "does it help" — would someone doing this task unavoidably exercise this
skill along the way?

Return ONLY a JSON object (no markdown, no commentary):

{"demonstrates": true, "why": "one short sentence"}

Answer TRUE when the skill is unavoidably exercised by doing the task. A conversation
lesson necessarily involves greeting the other person, so "Take a weekly lesson" does
involve "Use common greetings".

Answer FALSE when:
- The skill is only OPTIONALLY exercised. That same lesson might never touch the past
  tense, so it does not involve "Talk about past experiences".
- The task is passive exposure (watching, reading, listening) and the skill is a
  productive ability (speaking, writing, building something).
- The task is ABOUT the goal rather than doing it: planning, scheduling, setting
  milestones, reviewing progress, buying equipment, choosing materials.
- The link rests on a phrase appearing in both. "Setting milestones for next month" is
  not "expressing future plans" in a foreign language; the words match, the acts do not.

You are not judging mastery. You are judging whether the act contains the act.

Never include numbers, scores, percentages, or estimates.`;

/** How a single pair is judged. Injected so the filter is testable without a network. */
export type LinkJudge = (taskTitle: string, skillTitle: string) => Promise<boolean>;

/** The live judge: one isolated LLM call per pair. Fails CLOSED — a verification that
 *  errors drops the suggestion rather than admitting an unchecked link. The cost of a
 *  false negative is a missing suggestion; of a false positive, a wrong credit. */
async function llmJudge(taskTitle: string, skillTitle: string): Promise<boolean> {
  const { callOpenRouterJSON } = await import("./openrouter");
  const messages: ChatMessage[] = [
    { role: "system", content: VERIFY_SYSTEM_PROMPT },
    { role: "user", content: `TASK: ${taskTitle}\nSKILL: ${skillTitle}` },
  ];
  try {
    const verdict = await callOpenRouterJSON<LinkVerdict>(messages, {
      validate: (d) => typeof d?.demonstrates === "boolean",
    });
    return verdict.demonstrates === true;
  } catch (err) {
    console.error("link verification failed, dropping the pair:", err);
    return false;
  }
}

/**
 * Drop every proposed link the judge won't vouch for. Pairs are judged concurrently but
 * independently — no pair ever sees another, which is the entire point.
 */
export async function filterVerified(
  links: ProposedLink[],
  nodeById: Map<string, SkillNode>,
  taskById: Map<string, Task>,
  judge: LinkJudge,
): Promise<ProposedLink[]> {
  if (links.length === 0) return [];
  const verdicts = await Promise.all(
    links.map((l) => {
      const node = nodeById.get(l.skill_node_id);
      const task = taskById.get(l.task_id);
      if (!node || !task) return Promise.resolve(false);
      return judge(task.title, node.title);
    }),
  );
  return links.filter((_, i) => verdicts[i]);
}

/** `${nodeId}:${taskId}` — the pair identity used to skip already-known links. */
export function pairKey(nodeId: string, taskId: string): string {
  return `${nodeId}:${taskId}`;
}

export interface ProposedLink {
  skill_node_id: string;
  task_id: string;
  rationale: string;
}

/**
 * Propose skill-node ↔ task links. `existingPairs` holds every pair already on record
 * in ANY status, so a dismissed pair is never resurrected and a confirmed one is never
 * duplicated. Returns [] when no LLM is configured — the offline fallback for this
 * feature is *nothing*, deliberately: the only offline matcher available is the title
 * similarity that this whole edge exists to work around, so a heuristic here would
 * manufacture links it cannot justify.
 *
 * Only the **unlocked frontier** is offered as a link target (`skillProgress().unlocked`
 * — unattained nodes whose prerequisites are all attained). A link is a device for
 * *inferring* an attainment, and inference may only walk the graph one node at a time;
 * without this the linker happily proposed a capstone three unmet prerequisites deep,
 * and spillover credited it. Saying "I can do X" outright is unaffected — assertion may
 * jump the graph, inference may not.
 */
export async function suggestSkillTaskLinks(
  nodes: SkillNode[],
  tasks: Task[],
  existingPairs: Set<string>,
): Promise<ProposedLink[]> {
  const unlocked = new Set(skillProgress(nodes).unlocked);
  const openNodes = nodes.filter((n) => unlocked.has(n.id)).slice(0, MAX_NODES);
  const openTasks = tasks.filter((t) => t.status !== "done" && !t.deferred).slice(0, MAX_TASKS);
  if (openNodes.length === 0 || openTasks.length === 0) return [];
  if (!isLLMConfigured()) return [];

  const nodeByKey = new Map(openNodes.map((n, i) => [`N${i + 1}`, n]));
  const taskByKey = new Map(openTasks.map((t, i) => [`T${i + 1}`, t]));
  // Depth is measured over the WHOLE graph, not just the frontier slice.
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const skillLines = [...nodeByKey].map(([k, n]) => `${k}: ${n.title}`).join("\n");
  const taskLines = [...taskByKey].map(([k, t]) => `${k}: ${t.title}`).join("\n");

  const { callOpenRouterJSON } = await import("./openrouter");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `SKILLS:\n${skillLines}\n\nTASKS:\n${taskLines}` },
  ];

  try {
    const result = await callOpenRouterJSON<LinkSuggestion>(messages, { validate: isUsable });
    const proposed = sanitizeLinks(result.links, nodeByKey, taskByKey, existingPairs, byId);
    // Second pass: re-judge each surviving pair alone. The first call is an assignment
    // problem and the model will empty the menu into it; this one is a yes/no with
    // nothing to assign.
    const taskById = new Map(openTasks.map((t) => [t.id, t]));
    return filterVerified(proposed, byId, taskById, llmJudge);
  } catch (err) {
    console.error("suggestSkillTaskLinks failed, proposing nothing:", err);
    return [];
  }
}

/**
 * Defensive clean-up of an LLM-proposed link set: drop hallucinated handles, pairs we
 * already know about (in any status), and duplicates within the response itself. Keeps
 * persistence honest regardless of what the model returns.
 *
 * `nodeByKey` contains ONLY the unlocked frontier, so a locked node is unreachable here
 * even if the model invents its handle. Fan-out is bounded structurally: the task-keyed
 * map has unique keys, and a legacy array is collapsed one-per-task by `bestPerTask`.
 */
export function sanitizeLinks(
  links: Record<string, ExtractedLink | null> | ExtractedLink[],
  nodeByKey: Map<string, SkillNode>,
  taskByKey: Map<string, Task>,
  existingPairs: Set<string>,
  byId: Map<string, SkillNode> = new Map(),
): ProposedLink[] {
  // Normalize both shapes to (taskKey, node, rationale) candidates, preserving order.
  const candidates: { taskKey: string; node: SkillNode; rationale: string; order: number }[] = [];
  const push = (taskKey: string, raw: ExtractedLink | null | undefined, order: number) => {
    if (!raw) return;
    const node = nodeByKey.get(raw.node_key ?? "");
    if (!node || !taskByKey.has(taskKey)) return;
    const rationale = (raw.rationale ?? "").trim();
    if (!rationale) return;
    candidates.push({ taskKey, node, rationale, order });
  };

  if (Array.isArray(links)) {
    links.forEach((l, i) => push(l?.task_key ?? "", l, i));
  } else {
    Object.entries(links ?? {}).forEach(([taskKey, l], i) => push(taskKey, l, i));
  }

  const out: ProposedLink[] = [];
  const seen = new Set<string>();
  for (const { taskKey, node, rationale } of bestPerTask(candidates, byId)) {
    const task = taskByKey.get(taskKey)!;
    const key = pairKey(node.id, task.id);
    if (existingPairs.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ skill_node_id: node.id, task_id: task.id, rationale });
    if (out.length >= MAX_LINKS) break;
  }
  return out;
}
