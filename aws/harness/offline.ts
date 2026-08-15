/**
 * Offline harness. No network, no AWS account, no database.
 *
 *   npx tsx aws/harness/offline.ts
 *
 * This exists because the AWS account is not yet activated, so the usual
 * discipline - offline harness, then a live Playwright pass, then commit -
 * cannot reach its second step. Everything below is a claim made somewhere in
 * this migration that would otherwise be asserted only in prose, and that fails
 * SILENTLY rather than loudly if it is wrong.
 *
 * It deliberately does NOT test the parts a live pass must cover: IAM auth
 * against Aurora, the Cognito migration trigger, and a real Bedrock call. Those
 * are listed in aws/SPEC.md as the live checklist.
 */
import Module from "module";
import path from "path";

// --- shim `server-only` before anything imports it --------------------------
// Same trick the Azure harnesses used: `server-only` is resolved by Next's own
// build alias and is not an installed package, so plain Node cannot load any
// module under lib/ without this.
// `__dirname`, not import.meta.url: tsx compiles this repo's .ts as CommonJS
// (there is no "type": "module" in package.json), so import.meta is unavailable
// and top-level await is a transform error. Hence the async main() below too.
const shimPath = path.join(__dirname, "..", "lambda", "shims", "server-only.js");
const originalResolve = (
  Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string }
)._resolveFilename;
(
  Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string }
)._resolveFilename = function (request: string, ...args: unknown[]) {
  if (request === "server-only") return shimPath;
  return originalResolve.call(this, request, ...args);
};

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}\n    expected: ${e}\n    actual:   ${a}`);
    console.log(`  FAIL  ${name}`);
  }
}

function checkThat(name: string, predicate: boolean, detail: string): void {
  if (predicate) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failures.push(`${name}\n    ${detail}`);
    console.log(`  FAIL  ${name}`);
  }
}

async function main(): Promise<void> {
  const { splitMessages } = await import("../../lib/bedrock");
  const { bedrockEffort, isLLMConfigured, modelChain } = await import(
    "../../lib/bedrock-config"
  );
  const { runAsUser, ambientUserId } = await import("../../lib/db/context");
  const { parse } = await import("../lambda/llm-worker/index");

  // ===========================================================================
  console.log("\nsplitMessages - system prompts must not become user turns");
  // ===========================================================================
  // THE HIGHEST-VALUE ASSERTION IN THIS FILE. Every one of the eleven call sites
  // builds [{role:"system"}, {role:"user"}]. Converse takes system prompts in a
  // separate array; passing them through as messages still produces an answer,
  // just one where the instructions were content. There is no error to notice.
  {
    const { system, turns } = splitMessages([
      { role: "system", content: "SYS" },
      { role: "user", content: "USER" },
    ]);
    check("system prompt extracted", system, [{ text: "SYS" }]);
    check("user turn preserved", turns, [
      { role: "user", content: [{ text: "USER" }] },
    ]);
  }
  {
    // Converse rejects two consecutive turns with the same role; the OpenAI shape
    // tolerated it. Merging is the documented transformation.
    const { turns } = splitMessages([
      { role: "user", content: "A" },
      { role: "user", content: "B" },
    ]);
    check("adjacent same-role turns merged", turns, [
      { role: "user", content: [{ text: "A\n\nB" }] },
    ]);
  }
  {
    // Converse requires the first turn to be `user`. A system-only call would
    // otherwise send an empty messages array and 400.
    const { system, turns } = splitMessages([{ role: "system", content: "ONLY" }]);
    check("system-only call still has a user turn", turns.length, 1);
    check("...and keeps the system prompt", system.length, 1);
    checkThat(
      "first turn is user",
      turns[0].role === "user",
      `first role was ${turns[0].role}`,
    );
  }
  {
    const { turns } = splitMessages([
      { role: "system", content: "S" },
      { role: "user", content: "U" },
      { role: "assistant", content: "A" },
      { role: "user", content: "U2" },
    ]);
    check("multi-turn order preserved", turns.map((t) => t.role), [
      "user",
      "assistant",
      "user",
    ]);
  }

  // ===========================================================================
  console.log("\nbedrockEffort - the app's four levels onto Bedrock's five");
  // ===========================================================================
  check("minimal maps down to low", bedrockEffort("minimal"), "low");
  check("low", bedrockEffort("low"), "low");
  check("medium", bedrockEffort("medium"), "medium");
  check("high", bedrockEffort("high"), "high");
  check("undefined defaults to low", bedrockEffort(undefined), "low");
  checkThat(
    "never emits xhigh or max",
    !["xhigh", "max"].includes(bedrockEffort("high")),
    "those levels require extended thinking and are deliberately unreachable",
  );

  // ===========================================================================
  console.log("\nmodel chain");
  // ===========================================================================
  {
    const before = { m: process.env.BEDROCK_MODEL, f: process.env.BEDROCK_FALLBACK_MODEL };
    delete process.env.BEDROCK_MODEL;
    delete process.env.BEDROCK_FALLBACK_MODEL;
    const chain = modelChain();
    check("defaults to two distinct models", chain.length, 2);
    checkThat(
      "defaults are inference profiles, not bare model ids",
      chain.every((m) => m.startsWith("global.") || m.startsWith("apac.") || m.startsWith("us.")),
      `got ${chain.join(", ")} - a bare model id is refused on-demand by Claude 4.5+`,
    );

    process.env.BEDROCK_MODEL = "same";
    process.env.BEDROCK_FALLBACK_MODEL = "same";
    check("identical primary and fallback collapse to one", modelChain(), ["same"]);

    if (before.m) process.env.BEDROCK_MODEL = before.m; else delete process.env.BEDROCK_MODEL;
    if (before.f) process.env.BEDROCK_FALLBACK_MODEL = before.f; else delete process.env.BEDROCK_FALLBACK_MODEL;
  }

  // ===========================================================================
  console.log("\nisLLMConfigured");
  // ===========================================================================
  {
    const saved = process.env.TASKBUDDY_NO_LLM;
    process.env.TASKBUDDY_NO_LLM = "1";
    check("explicit opt-out wins over any credential", isLLMConfigured(), false);
    if (saved) process.env.TASKBUDDY_NO_LLM = saved;
    else delete process.env.TASKBUDDY_NO_LLM;
  }

  // ===========================================================================
  console.log("\nrunAsUser - tenant isolation across a reused execution environment");
  // ===========================================================================
  // THE OTHER ASSERTION THAT MATTERS. A Lambda execution environment is reused,
  // so an ambient user held in a module-scope variable would survive from one job
  // to the next and job B would run as job A's user - writing one account's data
  // into another's. These check the ALS actually scopes.
  {
    check("no ambient user outside runAsUser", ambientUserId(), null);

    const A = "11111111-1111-4111-8111-111111111111";
    const B = "22222222-2222-4222-8222-222222222222";

    await runAsUser(A, async () => {
      check("inside runAsUser(A)", ambientUserId(), A);
    });
    check("cleared after runAsUser(A) returns", ambientUserId(), null);

    // Concurrent jobs must not see each other's user, which is exactly what a
    // module-scope variable would get wrong.
    const seen: string[] = [];
    await Promise.all([
      runAsUser(A, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(`A:${ambientUserId()}`);
      }),
      runAsUser(B, async () => {
        seen.push(`B:${ambientUserId()}`);
        await new Promise((r) => setTimeout(r, 20));
        seen.push(`B2:${ambientUserId()}`);
      }),
    ]);
    check("interleaved jobs keep their own user", seen.sort(), [
      `A:${A}`,
      `B2:${B}`,
      `B:${B}`,
    ]);

    // A throw must not leak the user either.
    await runAsUser(A, async () => {
      throw new Error("boom");
    }).catch(() => {});
    check("cleared after a throwing job", ambientUserId(), null);
  }

  // ===========================================================================
  console.log("\nworker message parsing - two envelopes arrive on one queue");
  // ===========================================================================
  // EventBridge wraps the payload in `detail`; EventBridge Scheduler sends the
  // literal `input` with no envelope. Reading only `detail` makes every scheduled
  // roll a silent no-op - it would never throw, never retry, never reach the DLQ.
  {
    const rec = (body: unknown) =>
      ({ body: JSON.stringify(body), messageId: "m1" }) as Parameters<typeof parse>[0];

    check(
      "EventBridge envelope unwrapped",
      parse(
        rec({
          source: "taskbuddy",
          "detail-type": "goal.decompose.requested",
          detail: { type: "goal.decompose.requested", userId: "u", goalId: "g" },
        }),
      ),
      { type: "goal.decompose.requested", userId: "u", goalId: "g" },
    );
    check(
      "Scheduler bare payload accepted",
      parse(rec({ type: "plan.roll.daily" })),
      { type: "plan.roll.daily" },
    );
    check("unparseable body returns null", parse({ body: "{oops", messageId: "m" } as Parameters<typeof parse>[0]), null);
    check("body with no type returns null", parse(rec({ detail: { nope: 1 } })), null);
  }

  // ===========================================================================
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    console.log("\n" + failures.map((f) => `  ${f}`).join("\n\n"));
    process.exit(1);
  }

}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
