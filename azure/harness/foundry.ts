/**
 * Offline harness for the OpenRouter -> Microsoft Foundry migration.
 *
 *   npx tsx azure/harness/foundry.ts
 *
 * No network, no Next runtime, no API key. Covers the pure properties the
 * provider swap put at risk:
 *
 *  - the deployment-capability split, because gpt-5-mini and gpt-4.1-mini reject
 *    each other's request parameters and the fallback only runs when the primary
 *    is already broken;
 *  - the strict-mode legality rules every response schema must satisfy;
 *  - `bestPerTask`, which became the ONLY fan-out defence in lib/skill-links.ts
 *    once the task-keyed map (whose unique JSON keys made two-skills-on-one-task
 *    unrepresentable) had to become a flat array.
 *
 * Schema legality is also proven live: an illegal schema makes Azure return 400,
 * so the live pass is the stronger check. This file catches it a round trip
 * earlier and without spending tokens.
 */
import {
  deploymentNames,
  isLLMConfigured,
  isReasoningDeployment,
  normalizeEndpoint,
} from "../../lib/foundry-config";
import {
  MAX_LINKS,
  VERDICT_SCHEMA,
  bestPerTask,
  filterVerified,
  linkSchema,
  pairKey,
  sanitizeLinks,
  type ProposedLink,
} from "../../lib/skill-links";
import type { SkillNode, Task } from "../../lib/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
  } else {
    failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) passed++;
  else failures.push(`${name}${detail ? `\n    ${detail}` : ""}`);
}

// --- 1. Deployment capability split -----------------------------------------
// The migration's sharpest edge: send `temperature` to gpt-5-mini and it 400s;
// send `reasoning_effort` to gpt-4.1-mini and it 400s. Both confirmed against
// the live deployment. The wrapper picks the body shape from the name, so the
// name classifier is load-bearing.

check("reasoning: gpt-5-mini", isReasoningDeployment("gpt-5-mini"), true);
check("reasoning: gpt-5", isReasoningDeployment("gpt-5"), true);
check("reasoning: o4-mini", isReasoningDeployment("o4-mini"), true);
check("reasoning: o3", isReasoningDeployment("o3"), true);
check("NOT reasoning: gpt-4.1-mini", isReasoningDeployment("gpt-4.1-mini"), false);
check("NOT reasoning: gpt-4o", isReasoningDeployment("gpt-4o"), false);
check("NOT reasoning: gpt-oss-120b", isReasoningDeployment("gpt-oss-120b"), false);

// The override exists for deployments not named after their model.
process.env.AZURE_FOUNDRY_REASONING_DEPLOYMENTS = "my-thinker";
check("override: named deployment is reasoning", isReasoningDeployment("my-thinker"), true);
check("override: excludes gpt-5-mini", isReasoningDeployment("gpt-5-mini"), false);
delete process.env.AZURE_FOUNDRY_REASONING_DEPLOYMENTS;
check("override cleared", isReasoningDeployment("gpt-5-mini"), true);

// --- 2. Endpoint normalisation ----------------------------------------------
// Every one of these is a plausible paste from the portal, and each would
// otherwise produce a 404 that reads like a wrong deployment name.
const EP = "https://taskbuddy-foundry.openai.azure.com";
check("endpoint: bare", normalizeEndpoint(EP), EP);
check("endpoint: trailing slash", normalizeEndpoint(EP + "/"), EP);
check("endpoint: /openai", normalizeEndpoint(EP + "/openai"), EP);
check("endpoint: /openai/v1", normalizeEndpoint(EP + "/openai/v1"), EP);
check("endpoint: /openai/v1/", normalizeEndpoint(EP + "/openai/v1/"), EP);

// --- 3. The config gate ------------------------------------------------------
// This is the one-line change that silently disables every LLM feature if it is
// missed: nine modules and three route components read it, and layout.tsx uses
// it to decide demo mode.
delete process.env.AZURE_FOUNDRY_ENDPOINT;
delete process.env.AZURE_FOUNDRY_API_KEY;
check("gate: unset", isLLMConfigured(), false);
process.env.AZURE_FOUNDRY_ENDPOINT = EP;
check("gate: endpoint only", isLLMConfigured(), false);
process.env.AZURE_FOUNDRY_API_KEY = "k";
check("gate: both set", isLLMConfigured(), true);

check("deployments: defaults", deploymentNames(), ["gpt-5-mini", "gpt-4.1-mini"]);
process.env.AZURE_FOUNDRY_FALLBACK_DEPLOYMENT = "gpt-5-mini";
check("deployments: deduped", deploymentNames(), ["gpt-5-mini"]);
delete process.env.AZURE_FOUNDRY_FALLBACK_DEPLOYMENT;

// --- 4. Strict-mode schema legality -----------------------------------------
// Azure's rules: every property listed in `required`, `additionalProperties:
// false` on every object, at most 100 properties and 5 levels of nesting, and
// the root may not be `anyOf`. Optionality is a ["T","null"] union, never an
// omitted key.

interface SchemaProblem {
  path: string;
  problem: string;
}

function auditSchema(
  node: unknown,
  path = "$",
  depth = 0,
  acc: { problems: SchemaProblem[]; props: number; maxDepth: number } = {
    problems: [],
    props: 0,
    maxDepth: 0,
  },
): { problems: SchemaProblem[]; props: number; maxDepth: number } {
  if (typeof node !== "object" || node === null) return acc;
  const s = node as Record<string, unknown>;
  acc.maxDepth = Math.max(acc.maxDepth, depth);

  if (s.type === "object" || s.properties) {
    if (s.additionalProperties !== false) {
      acc.problems.push({ path, problem: "additionalProperties is not false" });
    }
    const props = (s.properties ?? {}) as Record<string, unknown>;
    const keys = Object.keys(props);
    acc.props += keys.length;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const k of keys) {
      if (!required.includes(k)) {
        acc.problems.push({ path: `${path}.${k}`, problem: "not in required" });
      }
    }
    for (const r of required) {
      if (!keys.includes(r)) {
        acc.problems.push({ path: `${path}.${r}`, problem: "required but not a property" });
      }
    }
    for (const k of keys) auditSchema(props[k], `${path}.${k}`, depth + 1, acc);
  }
  if (s.items) auditSchema(s.items, `${path}[]`, depth + 1, acc);
  return acc;
}

/** Keywords we deliberately never emit — see azure/FOUNDRY.md §4 for why. */
const BANNED = [
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "minLength",
  "maxLength",
  "patternProperties",
  "propertyNames",
];

function findBanned(node: unknown, path = "$", found: string[] = []): string[] {
  if (typeof node !== "object" || node === null) return found;
  const s = node as Record<string, unknown>;
  for (const b of BANNED) if (b in s) found.push(`${path}.${b}`);
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "object" && v !== null) findBanned(v, `${path}.${k}`, found);
  }
  return found;
}

function assertSchema(name: string, schema: unknown): void {
  const { problems, props, maxDepth } = auditSchema(schema);
  ok(`${name}: strict-mode legal`, problems.length === 0, JSON.stringify(problems));
  ok(`${name}: <= 100 properties`, props <= 100, `has ${props}`);
  ok(`${name}: <= 5 nesting levels`, maxDepth <= 5, `depth ${maxDepth}`);
  const banned = findBanned(schema);
  ok(`${name}: no unreliable keywords`, banned.length === 0, banned.join(", "));
  ok(
    `${name}: root is not anyOf`,
    !(schema as Record<string, unknown>)?.anyOf,
  );
}

assertSchema("link_verdict", VERDICT_SCHEMA);
assertSchema("skill_task_links", linkSchema(["T1", "T2"], ["N1", "N2"]));

// The extraction, decomposer and strategist schemas live in modules that are
// `server-only` or pull in `server-only` transitively, so they cannot be
// imported here. They are audited by the same `assertSchema` in the LIVE
// harness, which shims that import — see azure/harness/foundry-live.ts.

// `why` must precede `demonstrates`: structured outputs generate in schema
// order, so the sentence conditions the verdict rather than rationalising it.
check(
  "link_verdict: why is generated before demonstrates",
  Object.keys(VERDICT_SCHEMA.properties),
  ["why", "demonstrates"],
);

// The per-request enums are what make a hallucinated handle impossible.
const ls = linkSchema(["T1", "T2", "T3"], ["N1"]) as never as {
  properties: {
    links: { items: { properties: { task_key: { enum: string[] }; node_key: { enum: string[] } } } };
  };
};
check("links: task_key enum", ls.properties.links.items.properties.task_key.enum, ["T1", "T2", "T3"]);
check("links: node_key enum", ls.properties.links.items.properties.node_key.enum, ["N1"]);

// --- 5. bestPerTask: the fan-out defence ------------------------------------
// The observed live failure was 8 skills assigned onto 1 task. With the keyed
// map gone, this function is the only thing that collapses it.

function node(id: string, title: string, opts: { ckpt?: boolean; prereqs?: string[] } = {}): SkillNode {
  return {
    id,
    title,
    is_checkpoint: opts.ckpt ?? false,
    prerequisites: opts.prereqs ?? [],
  } as never as SkillNode;
}

const n1 = node("id1", "Learn the alphabet");
const n2 = node("id2", "Order food in a cafe", { ckpt: true });
const n3 = node("id3", "Hold a 5-minute conversation", { ckpt: true, prereqs: ["id2"] });
const n4 = node("id4", "Conjugate present tense", { prereqs: ["id1"] });
const byId = new Map([n1, n2, n3, n4].map((n) => [n.id, n]));

// Eight skills fanned onto one task, emitted in plain graph order — which is
// exactly why "keep the first" is the wrong collapse: it would keep the most
// foundational, least specific one.
const fanned = [n1, n4, n2, n3].map((n, i) => ({
  taskKey: "T1",
  node: n,
  rationale: "r",
  order: i,
}));
const collapsed = bestPerTask(fanned, byId);
check("fan-out collapses to one link", collapsed.length, 1);
check("fan-out keeps the deepest checkpoint", collapsed[0]?.node.id, "id3");

// A checkpoint beats a deeper non-checkpoint: the tiebreak is is_checkpoint first.
const mixed = [
  { taskKey: "T1", node: n4, rationale: "r", order: 0 }, // depth 1, not a checkpoint
  { taskKey: "T1", node: n2, rationale: "r", order: 1 }, // depth 0, checkpoint
];
check("checkpoint outranks depth", bestPerTask(mixed, byId)[0]?.node.id, "id2");

// Distinct tasks are untouched by the collapse.
const twoTasks = [
  { taskKey: "T1", node: n2, rationale: "r", order: 0 },
  { taskKey: "T2", node: n3, rationale: "r", order: 1 },
];
check("distinct tasks both survive", bestPerTask(twoTasks, byId).length, 2);

// --- 6. sanitizeLinks --------------------------------------------------------

function task(id: string, title: string): Task {
  return { id, title, status: "todo", deferred: false } as never as Task;
}
const nodeByKey = new Map([
  ["N1", n1],
  ["N2", n2],
]);
const taskByKey = new Map([
  ["T1", task("t1", "Record a demo")],
  ["T2", task("t2", "Buy a capo")],
]);
const noPairs = new Set<string>();

check(
  "empty array yields nothing",
  sanitizeLinks([], nodeByKey, taskByKey, noPairs, byId),
  [],
);

check(
  "array shape is accepted",
  sanitizeLinks(
    [{ task_key: "T1", node_key: "N2", rationale: "Recording means playing it." }],
    nodeByKey,
    taskByKey,
    noPairs,
    byId,
  ),
  [{ skill_node_id: "id2", task_id: "t1", rationale: "Recording means playing it." }],
);

check(
  "legacy map shape still accepted",
  sanitizeLinks(
    { T1: { node_key: "N2", rationale: "Recording means playing it." }, T2: null },
    nodeByKey,
    taskByKey,
    noPairs,
    byId,
  ),
  [{ skill_node_id: "id2", task_id: "t1", rationale: "Recording means playing it." }],
);

check(
  "unknown node_key dropped",
  sanitizeLinks(
    [{ task_key: "T1", node_key: "N99", rationale: "made up" }],
    nodeByKey,
    taskByKey,
    noPairs,
    byId,
  ),
  [],
);

check(
  "unknown task_key dropped",
  sanitizeLinks(
    [{ task_key: "T99", node_key: "N1", rationale: "made up" }],
    nodeByKey,
    taskByKey,
    noPairs,
    byId,
  ),
  [],
);

// forecast() is the sole owner of odds. The rationale is persisted and shown
// verbatim, so a prose-only ban on numbers is not a ban.
check(
  "rationale containing a number is rejected",
  sanitizeLinks(
    [{ task_key: "T1", node_key: "N1", rationale: "About 80% of the skill." }],
    nodeByKey,
    taskByKey,
    noPairs,
    byId,
  ),
  [],
);

check(
  "already-known pair is skipped",
  sanitizeLinks(
    [{ task_key: "T1", node_key: "N2", rationale: "Recording means playing it." }],
    nodeByKey,
    taskByKey,
    new Set([pairKey("id2", "t1")]),
    byId,
  ),
  [],
);

// The MAX_LINKS cap: prose asks for it, the schema cannot enforce it, so the
// code must.
const manyNodes = new Map<string, SkillNode>();
const manyTasks = new Map<string, Task>();
const manyLinks = [];
for (let i = 1; i <= MAX_LINKS + 8; i++) {
  const n = node(`n${i}`, `Skill ${i}`);
  manyNodes.set(`N${i}`, n);
  manyTasks.set(`T${i}`, task(`t${i}`, `Task ${i}`));
  manyLinks.push({ task_key: `T${i}`, node_key: `N${i}`, rationale: "because" });
}
check(
  "truncated at MAX_LINKS",
  sanitizeLinks(manyLinks, manyNodes, manyTasks, noPairs, new Map()).length,
  MAX_LINKS,
);

// --- 7. filterVerified: fail-closed, bounded concurrency ---------------------
// A verification that errors drops the pair; the cost of a false negative is a
// missing suggestion, of a false positive a wrong credit.

async function asyncChecks(): Promise<void> {
  const links: ProposedLink[] = [
    { skill_node_id: "id1", task_id: "t1", rationale: "a" },
    { skill_node_id: "id2", task_id: "t2", rationale: "b" },
  ];
  const nodeById = new Map([
    ["id1", n1],
    ["id2", n2],
  ]);
  const taskById = new Map([
    ["t1", task("t1", "Task one")],
    ["t2", task("t2", "Task two")],
  ]);

  const kept = await filterVerified(links, nodeById, taskById, async (t) =>
    t === "Task two",
  );
  check("judge false drops the pair", kept.map((l) => l.task_id), ["t2"]);

  const allDropped = await filterVerified(links, nodeById, taskById, async () => {
    throw new Error("429");
  });
  check("judge throwing fails closed", allDropped, []);

  // Concurrency is capped at 4 so a burst of judge calls cannot 429 itself into
  // silently deleting good suggestions.
  let inFlight = 0;
  let peak = 0;
  const wide: ProposedLink[] = Array.from({ length: 12 }, (_, i) => ({
    skill_node_id: "id1",
    task_id: "t1",
    rationale: `r${i}`,
  }));
  await filterVerified(wide, nodeById, taskById, async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return true;
  });
  ok("judge concurrency capped at 4", peak <= 4, `peak was ${peak}`);
}

// --- report ------------------------------------------------------------------

asyncChecks().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log("offline foundry harness green\n");
});
