/**
 * Offline harness. No network, no AWS account, no database.
 *
 *   npx tsx aws/harness/offline.ts
 *
 * Exists because the AWS account isn't activated yet, so the usual offline-then-live-then-commit
 * discipline can't reach its second step. Everything below is a claim made somewhere in this
 * migration that would otherwise only be asserted in prose, and that fails SILENTLY if wrong.
 *
 * Deliberately does NOT cover the parts a live pass must: IAM auth against Aurora, the Cognito
 * migration trigger, and a real Bedrock call. Those are the live checklist in aws/SPEC.md.
 */
import Module from "module";
import path from "path";

// --- shim `server-only` before anything imports it --------------------------
// Same trick the Azure harnesses used: server-only is resolved by Next's build alias and isn't
// an installed package, so plain Node can't load anything under lib/ without this. __dirname
// rather than import.meta.url, because tsx compiles this repo as CommonJS - hence the async
// main() below too.
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
  const { splitMessages } = await import("@/lib/bedrock");
  const { bedrockEffort, isLLMConfigured, modelChain } = await import(
    "@/lib/bedrock-config"
  );
  const { runAsUser, ambientUserId } = await import("@/lib/db/context");
  const { attemptOf, isFinalAttempt, parse } = await import(
    "@/aws/lambda/llm-worker/index"
  );
  const { JOB_STALE_MS, isJobAbandoned, isTerminalJobStatus } = await import(
    "@/lib/types"
  );
  const { WORKER_MAX_RECEIVE_COUNT, WORKER_TIMEOUT_SECONDS, WORKER_VISIBILITY_TIMEOUT_SECONDS } =
    await import("@/aws/infra/lib/config");

  // ===========================================================================
  console.log("\nsplitMessages - system prompts must not become user turns");
  // The highest-value assertion in this file. All eleven call sites build
  // [{role:"system"}, {role:"user"}], and Converse takes system prompts in a separate array.
  // Passing them through as messages still produces an answer, just one where the instructions
  // were content. There's no error to notice.
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
  // The other assertion that matters. A Lambda execution environment is reused, so an ambient
  // user in a module-scope variable would survive between jobs and job B would run as job A's
  // user, writing one account's data into another's. These check the ALS actually scopes.
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

    // A user-scoped job with no user can never run correctly, and retrying it
    // three times only delays someone noticing.
    check(
      "user job with no userId is rejected",
      parse(rec({ detail: { type: "goal.decompose.requested", goalId: "g" } })),
      null,
    );

    // DEPLOY-WINDOW TOLERANCE. The web function and the worker are separate
    // stacks updated seconds apart, so a message published by the older web
    // code arrives with no jobId. Rejecting it would DELETE it (unparseable
    // messages are never retried) and the user's job would silently vanish.
    check(
      "job with no jobId is still accepted",
      parse(rec({ detail: { type: "strategy.refresh.requested", userId: "u" } })),
      { type: "strategy.refresh.requested", userId: "u" },
    );
    check(
      "jobId round-trips through the envelope",
      parse(
        rec({
          detail: {
            type: "goal.decompose.requested",
            userId: "u",
            goalId: "g",
            jobId: "j",
          },
        }),
      ),
      { type: "goal.decompose.requested", userId: "u", goalId: "g", jobId: "j" },
    );
  }

  // ===========================================================================
  console.log("\nretry accounting - a transient failure must not read as final");
  // The worker writes 'retrying' or 'failed' on the row the browser is watching, and only the
  // receive count tells them apart. An off-by-one shows a permanent failure while SQS is still
  // retrying, or leaves a DLQ'd job spinning on the page forever.
  {
    const rec = (attributes?: Record<string, string>) =>
      ({ body: "{}", messageId: "m1", attributes }) as unknown as Parameters<
        typeof attemptOf
      >[0];

    check("first delivery reads as attempt 1", attemptOf(rec({ ApproximateReceiveCount: "1" })), 1);
    check("third delivery reads as attempt 3", attemptOf(rec({ ApproximateReceiveCount: "3" })), 3);
    // @types declares `attributes` non-optional, so the compiler never warns
    // about a record built by cast - as the harness itself builds them.
    check("missing attributes default to attempt 1", attemptOf(rec(undefined)), 1);
    check("garbage receive count defaults to 1", attemptOf(rec({ ApproximateReceiveCount: "x" })), 1);

    check("attempt 1 of 3 is not final", isFinalAttempt(1, 3), false);
    check("attempt 2 of 3 is not final", isFinalAttempt(2, 3), false);
    // SQS routes to the DLQ on the receive that WOULD exceed maxReceiveCount,
    // so the third delivery is the last one this worker ever sees.
    check("attempt 3 of 3 IS final", isFinalAttempt(3, 3), true);
  }

  // ===========================================================================
  console.log("\njob staleness - the window the pending UI gives up in");
  // ===========================================================================
  {
    const run = (status: string, ageMs: number) =>
      ({
        id: "j",
        type: "goal.decompose.requested",
        subjectId: "g",
        status,
        result: null,
        error: null,
        createdAt: new Date(1_700_000_000_000 - ageMs).toISOString(),
        updatedAt: new Date(1_700_000_000_000 - ageMs).toISOString(),
      }) as Parameters<typeof isJobAbandoned>[0];
    const NOW = 1_700_000_000_000;

    check("a fresh queued job is not abandoned", isJobAbandoned(run("queued", 5_000), NOW), false);
    check("a long-silent running job is abandoned", isJobAbandoned(run("running", JOB_STALE_MS + 1), NOW), true);
    // A finished job is never abandoned however old it is - otherwise every
    // historical row would render as a failure.
    check("a succeeded job is never abandoned", isJobAbandoned(run("succeeded", JOB_STALE_MS * 10), NOW), false);
    check("succeeded is terminal", isTerminalJobStatus("succeeded"), true);
    check("retrying is NOT terminal", isTerminalJobStatus("retrying"), false);

    // A failed delivery doesn't come back immediately, it reappears when the visibility timeout
    // expires - so if the UI gives up sooner than the queue does, it declares dead a job SQS is
    // still going to run, and the retry button pays for the same model call twice.
    const queueWorstCaseMs =
      WORKER_MAX_RECEIVE_COUNT * WORKER_VISIBILITY_TIMEOUT_SECONDS * 1000;
    checkThat(
      "UI waits longer than the queue's worst-case retry schedule",
      JOB_STALE_MS > queueWorstCaseMs,
      `JOB_STALE_MS is ${JOB_STALE_MS}ms but SQS can take ${queueWorstCaseMs}ms to exhaust its attempts`,
    );
    // Below the function timeout, a message is redelivered while its first copy
    // is still running: the model is invoked, and billed, twice for one job.
    checkThat(
      "visibility timeout outlasts the function timeout",
      WORKER_VISIBILITY_TIMEOUT_SECONDS > WORKER_TIMEOUT_SECONDS,
      `visibility ${WORKER_VISIBILITY_TIMEOUT_SECONDS}s must exceed function timeout ${WORKER_TIMEOUT_SECONDS}s`,
    );
  }

  // ===========================================================================
  console.log("\nquery builder - IS NULL is not reachable through .eq()");
  // The portfolio-wide job has no subject, so its lookup is `subject_id IS NULL`. Written as
  // .eq("subject_id", null) that binds a parameter and becomes `subject_id = NULL`, which is
  // never true - the query returns nothing, no error, and the page shows an idle button beside a
  // job that's still running.
  {
    const { QueryBuilder } = await import("@/lib/db/query");
    const sql = new QueryBuilder("job_runs", null)
      .select("id")
      .eq("type", "strategy.refresh.requested")
      .isNull("subject_id")
      .toSQL();
    checkThat(
      "isNull emits IS NULL",
      Boolean(sql && /"?subject_id"?\s+IS NULL/.test(sql.text)),
      `got: ${sql?.text}`,
    );
    checkThat(
      "...and binds no parameter for it",
      sql?.values.length === 1,
      `expected only the type parameter, got ${JSON.stringify(sql?.values)}`,
    );
  }

  // ===========================================================================
  console.log("\nschema - job_runs is RLS-protected on both loops");
  // 01_schema.sql enables RLS from one array of table names and creates the owner policies from
  // another. A table in the first but not the second has RLS on with NO policy, which denies
  // everything - and the worker's first status write then fails naming no policy at all.
  {
    const fs = await import("fs");
    const sql = fs.readFileSync(path.join(__dirname, "..", "sql", "01_schema.sql"), "utf8");
    check("job_runs appears in both table-name arrays", (sql.match(/'job_runs'/g) ?? []).length, 2);
    checkThat(
      "the one-live-job index is declared nulls not distinct",
      /job_runs_one_live_per_subject[\s\S]{0,200}nulls not distinct/.test(sql),
      "without it the strategy refresh (subject_id IS NULL) escapes the guard it most needs",
    );
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
