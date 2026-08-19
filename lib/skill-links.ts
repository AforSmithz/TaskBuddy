import type { ExtractedLink, LinkSuggestion, LinkVerdict, SkillNode, Task } from "@/lib/types";
import type { ChatMessage } from "@/lib/bedrock";
import { isLLMConfigured } from "@/lib/checkin";
import { skillProgress } from "@/lib/skill";

// The skill-node <-> task linker.
//
// Why this needs a model at all: the decomposer phrases a skill node as a CAPABILITY
// ("Navigate a short spontaneous conversation") and extraction phrases a task as an ACTION
// ("Take weekly italki lesson"). Those describe the same evening and share no words. Over the
// real workspace, 0 of 81 node×task pairs cleared the fuzzy title matcher's bar while it scored
// a hand-written matching pair at 1.00 - it works, it just can't see this relation. So the edge
// is proposed semantically, confirmed by the user, and only then read by spillover.
//
// The model proposes pairs and prose. It never outputs a score, a probability, or an ordering.
//
// No server-only directive and no static bedrock import: the client is pulled in dynamically
// inside the one async call, so the pure half stays importable from a plain-Node harness.
//
// The wire shape is an ARRAY, not the task-keyed map it used to be. The map bought a structural
// one-skill-per-task guarantee for free (unique JSON keys), but strict structured outputs need
// an enumerated properties set, so keeping it would mean a fresh 60-property schema every call.
// bestPerTask is now the ONLY fan-out defence. What the schema buys back is bigger: task_key
// and node_key are per-request ENUMS built from the handles actually shipped, so a hallucinated
// handle is structurally impossible rather than filtered after the fact.

/** Cap what the model sees, so a large workspace can't blow the context window. */
const MAX_NODES = 40;
const MAX_TASKS = 60;
/** Cap what it can propose in one pass - a linker that returns 50 pairs is guessing. */
export const MAX_LINKS = 12;
/** Judge calls run concurrently, but not unboundedly: a 429 becomes a dropped pair. */
const JUDGE_CONCURRENCY = 4;

const SYSTEM_PROMPT = `You are given SKILLS (capabilities someone is learning) and TASKS
(concrete work they have to do). A few tasks, when done, DEMONSTRATE one of the skills —
the same effort proves both. Find those, and only those.

Emit an entry ONLY for a task that genuinely demonstrates a skill. Emit nothing for the
rest. If no task on the list demonstrates any skill, return {"links": []} — that is the
expected outcome for most inputs.

Rules:
- Ask of each pair: would someone carrying out this task unavoidably exercise this skill
  along the way? If the honest answer is "it helped, a bit" or "it might", the answer is no.
- One skill per task, at most. Each task_key may appear at most once. If a task seems to
  demonstrate several skills, it is broad practice rather than proof — name the single most
  specific skill, or none. One band rehearsal brushes against tuning, rhythm and
  improvisation; crediting all three would hand over a syllabus for one evening's work.
- "Most specific" means: prefer a skill that is a verifiable milestone over a practice
  drill. If still tied, prefer the one with more prerequisite skills behind it.
- Do NOT link on topic overlap alone. "Buy a new capo" and "Play barre chords" are both
  guitar, but buying gear demonstrates no technique.
- A skill may be demonstrated by more than one task. Most tasks link to nothing.
- Most SKILLS will have no task at all. Leaving a skill unused is the normal, correct
  outcome — do not try to find a home for every skill on the list.
- Judge each pair on the acts themselves. A task whose title sounds unrelated can still be
  exactly the work that demonstrates a skill, and two titles sharing words often are not.
- A wrong link costs the user more than a missing one: a confirmed link can silently close
  a task. When unsure, omit.
- At most ${MAX_LINKS} links.
- rationale is one plain sentence. Never include numbers, scores, percentages, or
  estimates of any kind.

Worked example.

SKILLS:
N1: Play a song end-to-end from memory
N2: Read standard notation
N3: Improvise over a 12-bar blues
TASKS:
T1: Record a demo track
T2: Buy a new capo
T3: Watch a documentary about jazz
T4: Book a rehearsal room
T5: Restring the guitar
T6: Update the setlist spreadsheet

Correct answer:
{"links":[
  {"task_key":"T1","node_key":"N1","rationale":"Recording a take means playing the song straight through from memory."}
]}

Five of the six tasks link to nothing, which is normal. T3 is passive exposure, not
playing. T2, T4, T5 and T6 are about the music without being the music. N2 and N3 go
unused because no task on this list exercises them.`;

/**
 * Reject a response the pipeline cannot use. Under a strict schema `links` is guaranteed
 * to be an array, so this is now a cheap assertion rather than a chain-advancing filter -
 * an EMPTY array is the expected, correct answer most of the time and must pass.
 */
function isUsable(d: LinkSuggestion): boolean {
  const links = (d as { links?: unknown })?.links;
  return Array.isArray(links) || (typeof links === "object" && links !== null);
}

/** Built per request so task_key and node_key are closed sets - the model can't name a handle
 *  that wasn't shipped, which turns sanitizeLinks' hallucinated-handle filter into a redundant
 *  assertion. The schema string differs every call, so expect no server-side caching. */
export function linkSchema(taskKeys: string[], nodeKeys: string[]) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["links"],
    properties: {
      links: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["task_key", "node_key", "rationale"],
          properties: {
            task_key: { type: "string", enum: taskKeys },
            node_key: { type: "string", enum: nodeKeys },
            rationale: {
              type: "string",
              description:
                "One plain sentence on why doing the task demonstrates the skill. No numbers.",
            },
          },
        },
      },
    },
  };
}

/** Longest path from a root over the goal's prerequisite DAG - a node's specificity.
 *  Foundations sit at 0, a capstone three layers deep at 3. Cycle-safe (sanitizeSkills already
 *  strips them, but a hand-edited graph mustn't hang this). Only breaks ties. */
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

/** When a model ignores the one-skill-per-task schema and returns an array, collapse it
 *  deterministically instead of trusting its ordering.
 *
 *  Ordering can't be trusted: in the observed fan-out the model emitted skills in plain graph
 *  order, so "keep the first" would have kept the two most FOUNDATIONAL ones; in a well-formed
 *  run it led with the most advanced. Same code, opposite meaning. So the tiebreak is explicit:
 *  a checkpoint beats a drill, deeper in the DAG beats shallower, and the model's order decides
 *  only a true tie. */
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

/** Second pass: judge ONE pair with no other skills or tasks in context.
 *
 *  Both failures this rejects were observed live and fluently rationalised inside the
 *  assignment prompt: "Watch a Spanish show" -> "Describe daily routines with present tense
 *  verbs" (passive exposure standing in for a productive skill), and "Set measurable milestones
 *  for conversation goal" -> "Express future plans and intentions" (a pun - planning your study
 *  in English is not expressing future plans in Spanish). Alone, with nothing to assign, each is
 *  easy to reject. */
const VERIFY_SYSTEM_PROMPT = `You are checking ONE claim, in isolation. You are given a
single TASK and a single SKILL.

Question: does carrying out that task NECESSARILY involve performing that skill? Not
"could it", not "does it help" — would someone doing this task unavoidably exercise this
skill along the way?

Answer FALSE when:
- The skill is only OPTIONALLY exercised. A conversation lesson might never touch the past
  tense, so it does not involve "Talk about past experiences".
- The task is passive exposure (watching, reading, listening) and the skill is a
  productive ability (speaking, writing, building something).
- The task is ABOUT the goal rather than doing it: planning, scheduling, setting
  milestones, reviewing progress, buying equipment, choosing materials.
- The link rests on a phrase appearing in both; the words match, the acts do not.
- The task title is too vague or generic to tell. Absence of evidence is a FALSE here,
  not a maybe.

Answer TRUE only when the skill is unavoidably exercised by doing the task.

Two worked cases.

FALSE — TASK: "Set measurable milestones for conversation goal" / SKILL: "Express future
plans and intentions". Planning your study in English is not expressing future plans in
Spanish. The phrase overlaps; the act does not.

TRUE — TASK: "Take a weekly lesson" / SKILL: "Use common greetings". A conversation lesson
necessarily begins by greeting the other person.

You are not judging mastery. You are judging whether the act contains the act.

Write "why" first and let it decide the verdict, not the other way round. "why" contains
no numbers, scores, percentages or estimates.`;

// `why` is deliberately FIRST in the property list: structured outputs generate in schema
// order, so the sentence conditions the boolean instead of rationalising one already
// chosen. It was optional in LinkVerdict and never read; it is now required and logged on
// a FALSE verdict, so a dropped pair is diagnosable.
export const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["why", "demonstrates"],
  properties: {
    why: { type: "string", description: "One short sentence, written before deciding." },
    demonstrates: { type: "boolean" },
  },
} as const;

/** How a single pair is judged. Injected so the filter is testable without a network. */
export type LinkJudge = (taskTitle: string, skillTitle: string) => Promise<boolean>;

/** The live judge: one isolated LLM call per pair. Fails CLOSED - a verification that
 *  errors drops the suggestion rather than admitting an unchecked link. The cost of a
 *  false negative is a missing suggestion; of a false positive, a wrong credit. */
async function llmJudge(taskTitle: string, skillTitle: string): Promise<boolean> {
  const { callBedrockJSON } = await import("@/lib/bedrock");
  const messages: ChatMessage[] = [
    { role: "system", content: VERIFY_SYSTEM_PROMPT },
    { role: "user", content: `TASK: ${taskTitle}\nSKILL: ${skillTitle}` },
  ];
  try {
    const verdict = await callBedrockJSON<LinkVerdict>(messages, {
      schema: VERDICT_SCHEMA as unknown as Record<string, unknown>,
      schemaName: "link_verdict",
      // A single yes/no with two titles in context.
      reasoningEffort: "low",
    });
    if (verdict.demonstrates !== true) {
      // Logged so a good suggestion killed by the judge is diagnosable, and so a
      // "could not judge" is distinguishable from a considered no.
      console.debug(
        `link judged false: "${taskTitle}" / "${skillTitle}" — ${verdict.why ?? "(no reason)"}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error("link verification errored, dropping the pair:", err);
    return false;
  }
}

/** Drop every proposed link the judge won't vouch for. Pairs are judged concurrently but
 *  independently - no pair ever sees another, which is the whole point. Concurrency is capped:
 *  one click used to fire up to MAX_LINKS judge calls at once, and because the judge fails
 *  CLOSED a burst of 429s silently deleted good suggestions instead of surfacing an error. */
export async function filterVerified(
  links: ProposedLink[],
  nodeById: Map<string, SkillNode>,
  taskById: Map<string, Task>,
  judge: LinkJudge,
): Promise<ProposedLink[]> {
  if (links.length === 0) return [];
  const verdicts = new Array<boolean>(links.length).fill(false);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < links.length) {
      const i = cursor++;
      const l = links[i];
      const node = nodeById.get(l.skill_node_id);
      const task = taskById.get(l.task_id);
      if (!node || !task) continue;
      try {
        verdicts[i] = await judge(task.title, node.title);
      } catch (err) {
        // Fail closed per pair, not per batch. `llmJudge` already catches its
        // own errors, but an injected judge (or a future one) must not be able
        // to take the whole linker down with it.
        console.error("link verification errored, dropping the pair:", err);
        verdicts[i] = false;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(JUDGE_CONCURRENCY, links.length) }, worker),
  );
  return links.filter((_, i) => verdicts[i]);
}

/** `${nodeId}:${taskId}` - the pair identity used to skip already-known links. */
export function pairKey(nodeId: string, taskId: string): string {
  return `${nodeId}:${taskId}`;
}

export interface ProposedLink {
  skill_node_id: string;
  task_id: string;
  rationale: string;
}

/** Propose skill-node <-> task links. `existingPairs` holds every pair already on record in ANY
 *  status, so a dismissed pair is never resurrected and a confirmed one never duplicated.
 *  Returns [] with no LLM configured - the offline fallback here is deliberately NOTHING, since
 *  the only offline matcher available is the title similarity this edge exists to work around.
 *
 *  Only the unlocked frontier is offered as a target. A link is a device for INFERRING an
 *  attainment, and inference may only walk the graph one node at a time; without this the
 *  linker happily proposed a capstone three unmet prerequisites deep and spillover credited it.
 *  Saying "I can do X" outright is unaffected - assertion may jump the graph, inference may not. */
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

  const { callBedrockJSON } = await import("@/lib/bedrock");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `SKILLS:\n${skillLines}\n\nTASKS:\n${taskLines}` },
  ];

  try {
    const result = await callBedrockJSON<LinkSuggestion>(messages, {
      schema: linkSchema([...taskByKey.keys()], [...nodeByKey.keys()]),
      schemaName: "skill_task_links",
      // The assignment pass compares every task against every skill and applies the
      // checkpoint/depth tie-break. The isolated judge below stays cheap.
      reasoningEffort: "medium",
      validate: isUsable,
    });
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

/** Defensive clean-up of a proposed link set: drop hallucinated handles, pairs we already know
 *  about, and duplicates within the response itself.
 *
 *  `nodeByKey` contains ONLY the unlocked frontier, so a locked node is unreachable even if the
 *  model invents its handle - and under the per-request enum it can't invent one at all.
 *
 *  The array is the shape the prompt asks for; the task-keyed map is a legacy branch kept
 *  because it costs nothing. Fan-out is no longer bounded by unique JSON keys, so bestPerTask is
 *  the only thing between a fanned-out response and the review surface. Don't remove it. */
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
    const rationale = (raw.rationale ?? "").trim().slice(0, 160);
    if (!rationale) return;
       // `forecast()` is the sole owner of odds. The prompt forbids numbers in the
    // rationale, but this string is persisted and shown verbatim on the confirm surface,
    // so a prose-only invariant is not an invariant.
    if (/\d|%/.test(rationale)) return;
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
