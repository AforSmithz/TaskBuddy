/**
 * Live harness: drives the REAL prompts and REAL strict schemas against the
 * deployed Foundry models.
 *
 *   npx tsx azure/harness/foundry-live.ts
 *
 * Spends tokens. Reads AZURE_FOUNDRY_* from .env.local.
 *
 * This is the check the offline harness cannot make. An illegal strict schema
 * is a 400 from Azure, a prompt that lost a rule shows up as wrong content, and
 * the reasoning/chat parameter split only bites against a real deployment. It
 * calls the exported entry points rather than re-implementing them, so what runs
 * here is what runs in the app.
 *
 * `lib/foundry.ts`, `lib/decompose.ts` and the strategists are `server-only`,
 * which Next aliases and plain Node cannot resolve. The shim below makes that
 * import a no-op for the harness process. It is the only concession; every other
 * line of the path under test is the production one.
 *
 * NOT covered here: the two strategist modules. Both need a live
 * `getRecoveryContext(projectId)` - a real project with real tasks - so they are
 * verified through the running app instead.
 */
import Module from "module";
import fs from "fs";
import path from "path";

// --- shim `server-only` before anything imports it --------------------------
const shimPath = path.join(__dirname, ".server-only-shim.js");
fs.writeFileSync(shimPath, "module.exports = {};\n");
type ResolveFn = (request: string, ...rest: unknown[]) => string;
const mod = Module as unknown as { _resolveFilename: ResolveFn };
const originalResolve = mod._resolveFilename;
mod._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === "server-only") return shimPath;
  return originalResolve.call(this, request, ...rest);
};

// --- load .env.local ---------------------------------------------------------
const envFile = path.join(__dirname, "..", "..", ".env.local");
for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

let passed = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const TRANSCRIPT = `Standup, 14 March.
Ana: the auth flow is done, I merged it this morning.
Ben: I still can't start the billing page, I'm waiting on the Stripe keys from finance.
Ana: we decided to drop SSO from v1, it's too much for the deadline.
Ben: someone needs to find out whether legal signed off on the new terms.
Ana: I'll write the migration script before Friday.`;

async function main(): Promise<void> {
  const { isLLMConfigured } = await import("../../lib/foundry-config");
  if (!isLLMConfigured()) {
    console.error("AZURE_FOUNDRY_ENDPOINT / AZURE_FOUNDRY_API_KEY not set.");
    process.exit(1);
  }

  // --- 1. Extraction: the largest schema (38 properties, depth 3) -----------
  console.log("\n[1] extractEntry — meeting");
  const { extractEntry } = await import("../../lib/extraction");
  const meeting = await extractEntry(TRANSCRIPT, "meeting");
  ok("meeting used the LLM, not the heuristic", meeting.source === "llm", meeting.source);
  const r = meeting.result;
  ok("returned at least one task", r.tasks.length > 0, `${r.tasks.length}`);
  ok("respects the 15-task cap", r.tasks.length <= 15, `${r.tasks.length}`);
  ok(
    "every factor is an integer 1-5",
    r.tasks.every((t) =>
      [t.urgency, t.impact, t.dependency, t.risk, t.effort, t.confidence].every(
        (n) => Number.isInteger(n) && n >= 1 && n <= 5,
      ),
    ),
  );
  const keys = new Set(r.tasks.map((t) => t.key));
  ok(
    "depends_on only references keys in this response",
    r.tasks.every((t) => t.depends_on.every((d) => keys.has(d) && d !== t.key)),
    JSON.stringify(r.tasks.map((t) => [t.key, t.depends_on])),
  );
  ok(
    "every source_quote is verbatim in the input",
    r.tasks.every((t) => !t.source_quote || TRANSCRIPT.includes(t.source_quote)),
    JSON.stringify(r.tasks.map((t) => t.source_quote).filter(Boolean)),
  );
  ok(
    "decisions confidence uses the High/Medium/Low enum",
    r.decisions.every((d) => ["High", "Medium", "Low"].includes(d.confidence)),
    JSON.stringify(r.decisions.map((d) => d.confidence)),
  );
  ok("captured the SSO decision", r.decisions.length > 0, JSON.stringify(r.decisions));
  ok("captured an open question", r.open_questions.length > 0);
  ok("suggested_area is Work", r.suggested_area === "Work", String(r.suggested_area));
  console.log(`       tasks: ${r.tasks.map((t) => t.title).join(" | ")}`);

  // --- 2. Extraction: plan-only invariants ---------------------------------
  console.log("\n[2] extractEntry — plan");
  const plan = await extractEntry(
    "I want to learn to play the guitar over the next three months.",
    "plan",
  );
  ok("plan used the LLM", plan.source === "llm", plan.source);
  const p = plan.result;
  ok("plan tasks are all AI-suggested", p.tasks.every((t) => t.is_ai_suggested));
  ok("plan tasks have no owner", p.tasks.every((t) => t.owner === null));
  ok("plan tasks have no source_quote", p.tasks.every((t) => t.source_quote === null));
  ok("plan has no decisions", p.decisions.length === 0);
  ok("plan has no stakeholders", p.stakeholders.length === 0);
  ok("plan classified as Hobby", p.suggested_area === "Hobby", String(p.suggested_area));
  ok("plan proposed a project name", Boolean(p.suggested_project), String(p.suggested_project));

  // --- 3. Check-in: per-request handle enum + verbatim quotes ---------------
  console.log("\n[3] interpretCheckin");
  const { interpretCheckin } = await import("../../lib/checkin");
  const candidates = [
    { handle: "T1", title: "Build the API client", type: "task", goalName: "Mobile App" },
    { handle: "T2", title: "Ship the deploy", type: "task", goalName: "Mobile App" },
    { handle: "S1", title: "Write a SQL join", type: "skill_node", goalName: "Learn SQL" },
  ] as never as Parameters<typeof interpretCheckin>[1];
  const REPORT =
    "finished the API client and pushed the deploy to next week. spent ~2h on it. ugh, rough day though.";
  const ci = await interpretCheckin(REPORT, candidates);
  ok("check-in used the LLM", ci.source === "llm", ci.source);
  const intents = ci.result.intents;
  ok("produced intents", intents.length > 0, `${intents.length}`);
  ok("respects the 12-intent cap", intents.length <= 12, `${intents.length}`);
  ok(
    "every quote is verbatim in the report",
    intents.every((i) => REPORT.toLowerCase().includes(i.quote.toLowerCase().trim())),
    JSON.stringify(intents.map((i) => i.quote)),
  );
  ok(
    "every handle came from the candidate list",
    intents.every((i) => i.handle === null || ["T1", "T2", "S1"].includes(i.handle)),
    JSON.stringify(intents.map((i) => i.handle)),
  );
  ok(
    "split the compound sentence into completed + reschedule",
    intents.some((i) => i.kind === "completed") &&
      intents.some((i) => i.kind === "reschedule"),
    JSON.stringify(intents.map((i) => i.kind)),
  );
  const resched = intents.find((i) => i.kind === "reschedule");
  ok(
    "reschedule detail is a resolvable relative phrase",
    !resched ||
      resched.detail === null ||
      /^(today|tomorrow|this week|next week|next month|in \d+ (days?|weeks?))$/i.test(
        resched.detail.trim(),
      ),
    String(resched?.detail),
  );
  ok("captured the vent", intents.some((i) => i.register === "vent"), JSON.stringify(intents.map((i) => i.register)));
  console.log(
    `       intents: ${intents.map((i) => `${i.kind}/${i.handle ?? "-"}/${i.confidence}`).join(" | ")}`,
  );

  // Empty report must not cost a request.
  const empty = await interpretCheckin("   ", candidates);
  ok("empty report short-circuits", empty.result.intents.length === 0 && empty.source === "heuristic");

  // --- 4. Decomposer -------------------------------------------------------
  console.log("\n[4] decomposeLearningGoal");
  const { decomposeLearningGoal } = await import("../../lib/decompose");
  const skills = await decomposeLearningGoal("Conversational Spanish", null);
  ok("produced 5-9 skills", skills.length >= 5 && skills.length <= 9, `${skills.length}`);
  // The heuristic ladder is exactly 5 nodes titled "Learn the fundamentals of X".
  // Asserting on CONTENT is the only way to tell a real decomposition from the
  // silent fallback - a broken config produces a plausible-looking graph.
  ok(
    "not the generic heuristic ladder",
    !skills.some((s) => /^Learn the fundamentals of /.test(s.title)),
    skills[0]?.title,
  );
  ok(
    "content is Spanish-specific",
    skills.some((s) => /spanish|verb|tense|vocab|conjugat|pronunc|greet/i.test(s.title + s.description)),
    skills.map((s) => s.title).join(" | "),
  );
  const seenKeys = new Set<string>();
  ok(
    "topological order: prerequisites appear earlier",
    skills.every((s) => {
      const good = s.prerequisites.every((k) => seenKeys.has(k));
      seenKeys.add(s.key);
      return good;
    }),
  );
  ok("keys are unique", new Set(skills.map((s) => s.key)).size === skills.length);
  const ckpts = skills.filter((s) => s.is_checkpoint).length;
  ok("2-4 checkpoints", ckpts >= 2 && ckpts <= 4, `${ckpts}`);
  ok(
    "estimated_minutes clamped to 30-1200",
    skills.every((s) => s.estimated_minutes >= 30 && s.estimated_minutes <= 1200),
    JSON.stringify(skills.map((s) => s.estimated_minutes)),
  );
  ok(
    "parallel foundations are allowed, not forced into a chain",
    skills.filter((s) => s.prerequisites.length === 0).length >= 1,
  );
  console.log(`       skills: ${skills.map((s) => `${s.key}${s.is_checkpoint ? "*" : ""}`).join(" ")}`);

  // Degenerate input must yield nothing rather than a confident hallucination.
  const junk = await decomposeLearningGoal("asdf", null);
  ok(
    "nonsense goal yields an empty graph or the heuristic, not a confident plan",
    junk.length === 0 || junk.every((s) => /^Learn the fundamentals of /.test(s.title)),
    `${junk.length}: ${junk.map((s) => s.title).join(" | ")}`,
  );

  // --- 5. Skill linker: the two recorded live false positives --------------
  console.log("\n[5] suggestSkillTaskLinks");
  const { suggestSkillTaskLinks } = await import("../../lib/skill-links");
  const nodes = [
    { id: "n1", title: "Use common greetings", is_checkpoint: false, prerequisites: [], attained_at: null },
    { id: "n2", title: "Describe daily routines with present tense verbs", is_checkpoint: true, prerequisites: [], attained_at: null },
    { id: "n3", title: "Express future plans and intentions", is_checkpoint: true, prerequisites: [], attained_at: null },
  ] as never as Parameters<typeof suggestSkillTaskLinks>[0];
  const tasks = [
    { id: "t1", title: "Take a weekly italki lesson", status: "todo", deferred: false },
    { id: "t2", title: "Watch a Spanish show", status: "todo", deferred: false },
    { id: "t3", title: "Set measurable milestones for conversation goal", status: "todo", deferred: false },
    { id: "t4", title: "Buy a Spanish grammar book", status: "todo", deferred: false },
  ] as never as Parameters<typeof suggestSkillTaskLinks>[1];
  const proposed = await suggestSkillTaskLinks(nodes, tasks, new Set());
  console.log(
    `       proposed: ${proposed.map((l) => `${l.task_id}->${l.skill_node_id}`).join(", ") || "(none)"}`,
  );
  ok(
    "rejects passive exposure: 'Watch a Spanish show' -> 'Describe daily routines'",
    !proposed.some((l) => l.task_id === "t2" && l.skill_node_id === "n2"),
  );
  ok(
    "rejects the pun: 'Set measurable milestones' -> 'Express future plans'",
    !proposed.some((l) => l.task_id === "t3" && l.skill_node_id === "n3"),
  );
  ok("rejects buying gear", !proposed.some((l) => l.task_id === "t4"));
  ok("at most one skill per task", new Set(proposed.map((l) => l.task_id)).size === proposed.length);
  ok(
    "no numbers leaked into any rationale",
    proposed.every((l) => !/\d|%/.test(l.rationale)),
    JSON.stringify(proposed.map((l) => l.rationale)),
  );

  // --- 6. Schema legality for the paths a harness cannot drive --------------
  // The strategists need a live getRecoveryContext(projectId) - a real project
  // with real tasks - so their prompts are exercised through the running app.
  // What CAN be settled here is the thing most likely to break: whether Azure
  // accepts each strict schema at all. An illegal one is a 400, not a bad answer.
  console.log("\n[6] strategist + portfolio schema legality");
  const { GENERATE_SCHEMA, modifySchema, rerouteSchema } = await import(
    "../../lib/strategist"
  );
  const { generativeSchema, SYNTHESIS_SCHEMA } = await import(
    "../../lib/portfolio-strategist"
  );
  const { VERDICT_SCHEMA: verdict, linkSchema } = await import(
    "../../lib/skill-links"
  );

  const endpoint = `${process.env.AZURE_FOUNDRY_ENDPOINT!.replace(/\/+$/, "")}/openai/v1/chat/completions`;
  async function schemaAccepted(name: string, schema: unknown): Promise<void> {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "api-key": process.env.AZURE_FOUNDRY_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.AZURE_FOUNDRY_DEPLOYMENT ?? "gpt-5-mini",
        reasoning_effort: "minimal",
        max_completion_tokens: 4000,
        messages: [{ role: "user", content: "Return a minimal valid instance." }],
        response_format: {
          type: "json_schema",
          json_schema: { name, strict: true, schema },
        },
      }),
    });
    const detail = res.ok ? "" : (await res.text()).slice(0, 240);
    ok(`schema accepted by Azure: ${name}`, res.ok, detail);
  }

  await schemaAccepted("corrective_tasks", GENERATE_SCHEMA);
  await schemaAccepted("task_modifications", modifySchema(["T1", "T2", "T3"]));
  await schemaAccepted("reroute_plan", rerouteSchema(["C1", "C2"]));
  await schemaAccepted(
    "portfolio_generative_moves",
    generativeSchema(["P1", "P2"], ["P1.T1", "P1.T2", "P2.T1"]),
  );
  await schemaAccepted("portfolio_synthesis", SYNTHESIS_SCHEMA);
  await schemaAccepted("link_verdict", verdict);
  await schemaAccepted("skill_task_links", linkSchema(["T1"], ["N1"]));

  // --- report ---------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log("live foundry harness green\n");
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    try {
      fs.unlinkSync(shimPath);
    } catch {
      /* already gone */
    }
  });
