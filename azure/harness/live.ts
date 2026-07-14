/**
 * Live harness: runs the shim's generated SQL against the real Azure database
 * and asserts the things only a real server can settle — type parsing, jsonb
 * round-trips, and RLS isolation between two users.
 *
 *   source azure/env.sh && npx tsx azure/harness/live.ts
 *
 * Reads DATABASE_URL from the environment (or APP_URL from azure/env.sh) and
 * connects as `taskbuddy_app` — the same restricted role Vercel uses, not the
 * server admin. Testing as admin would pass while the real app failed, because
 * admin bypasses the column grants that `03_auth.sql` exists to impose.
 *
 * It creates two throwaway users, exercises them, and deletes them. It does not
 * touch any pre-existing row.
 *
 * The pool/transaction wrapper is re-implemented in a few lines below rather
 * than imported, because `lib/db/pool.ts` is `server-only` and cannot load
 * outside Next. Keep the two in step: this file's `withUser` must match it.
 */
import { randomUUID } from "crypto";
import { Pool, type PoolClient } from "pg";
import "../../lib/db/types";
import { QueryBuilder, type Row } from "../../lib/db/query";

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
    console.log(`  FAIL  ${name}  (${detail})`);
  }
}

const raw = process.env.DATABASE_URL ?? process.env.APP_URL;
if (!raw) {
  console.error("Set DATABASE_URL, or `source azure/env.sh` for APP_URL.");
  process.exit(2);
}
const url = new URL(raw);

const pool = new Pool({
  host: url.hostname,
  port: Number(url.port || 5432),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ""),
  ssl: { rejectUnauthorized: process.env.PGSSL_STRICT !== "0" },
  max: 4,
  idleTimeoutMillis: 5_000,
});

/** Mirrors lib/db/pool.ts `withUser`. */
async function withUser<T>(
  uid: string,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("select set_config('app.user_id', $1, true)", [uid]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try {
      await client.query("ROLLBACK");
    } catch {
      /* connection already broken */
    }
    throw e;
  } finally {
    client.release();
  }
}

function clientFor(uid: string) {
  return (table: string) =>
    new QueryBuilder(table, (text, values) =>
      withUser(uid, async (c) => (await c.query(text, values)).rows as Row[]),
    );
}

/**
 * Await a setup write and throw if it failed.
 *
 * The shim resolves errors instead of rejecting — that is the contract, and it
 * is the right one — but it means an unchecked setup write leaves a null for
 * some later assertion to trip over, three steps from the actual cause. Every
 * arrangement step in this file goes through here.
 */
async function must(
  what: string,
  p: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<unknown> {
  const res = await p;
  if (res.error) throw new Error(`setup "${what}" failed: ${res.error.message}`);
  return res.data;
}

/** The single row from a `.maybeSingle()`, or throw. */
async function one(
  what: string,
  p: PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<Record<string, unknown>> {
  const data = await must(what, p);
  if (!data) throw new Error(`setup "${what}" returned no row`);
  return data as Record<string, unknown>;
}

const ALICE = randomUUID();
const BOB = randomUUID();

async function main(): Promise<void> {
  const alice = clientFor(ALICE);
  const bob = clientFor(BOB);

  console.log(`\n  ${url.hostname} as ${decodeURIComponent(url.username)}\n`);

  // --- 0. the role is not a superuser and cannot bypass RLS ----------------
  const who = await pool.query<{
    current_user: string;
    super: boolean;
    bypass: boolean;
  }>(
    "select current_user, rolsuper as super, rolbypassrls as bypass " +
      "from pg_roles where rolname = current_user",
  );
  check("connected as taskbuddy_app", who.rows[0].current_user, "taskbuddy_app");
  check("the app role is not a superuser", who.rows[0].super, false);
  check("the app role cannot bypass RLS", who.rows[0].bypass, false);

  const hash = await pool.query(
    "select has_column_privilege('taskbuddy_app','users','password_hash','select') as can_read, " +
      "has_column_privilege('taskbuddy_app','users','password_hash','update') as can_write",
  );
  check("the app role cannot read password_hash", hash.rows[0].can_read, false);
  check("the app role cannot write password_hash", hash.rows[0].can_write, false);

  // --- 1. seed two users ---------------------------------------------------
  // Through app.set_password_hash so the harness never needs a hash grant.
  for (const [id, email] of [
    [ALICE, `harness-alice-${ALICE.slice(0, 8)}@example.invalid`],
    [BOB, `harness-bob-${BOB.slice(0, 8)}@example.invalid`],
  ]) {
    await withUser(id, async (c) => {
      await c.query(
        "insert into users (id, email, password_hash, full_name) values ($1,$2,$3,$4)",
        [id, email, "$2a$12$" + "x".repeat(53), "Harness"],
      );
    });
  }
  check("two throwaway users inserted under their own RLS", true, true);

  // --- 2. type parsers, against real column types --------------------------
  const goalId = randomUUID();
  await must(
    "goal insert",
    alice("goals").insert({
      id: goalId,
      user_id: ALICE,
      name: "Harness goal",
      kind: "project",
      deadline: "2026-12-25",
    }),
  );

  const goal = await one(
    "goal read",
    alice("goals").select("*").eq("id", goalId).maybeSingle(),
  );

  check(
    "date comes back as a raw 'YYYY-MM-DD' string, NOT a Date (D.5)",
    goal.deadline,
    "2026-12-25",
  );
  checkThat(
    "timestamptz comes back as an ISO string ending in Z",
    typeof goal.created_at === "string" && String(goal.created_at).endsWith("Z"),
    `created_at = ${JSON.stringify(goal.created_at)}`,
  );

  const entryId = randomUUID();
  await must(
    "entry insert",
    alice("entries").insert({
      id: entryId,
      user_id: ALICE,
      goal_id: goalId,
      title: "Harness entry",
      raw_input: "notes from the harness",
      kind: "meeting",
      status: "active",
      risks: ["late supplier", "scope creep"],
      stakeholders: [{ name: "Dana", role: "PM" }],
    }),
  );

  const taskId = randomUUID();
  await must(
    "task insert",
    alice("tasks").insert({
      id: taskId,
      entry_id: entryId,
      goal_id: goalId,
      title: "Harness task",
      status: "todo",
      sort_index: 0,
      priority_score: 4.5,
      due_date: "2026-09-01",
    }),
  );

  const task = await one(
    "task read",
    alice("tasks").select("*").eq("id", taskId).maybeSingle(),
  );

  checkThat(
    "numeric comes back as a NUMBER, not a string (D.5)",
    typeof task.priority_score === "number",
    `priority_score = ${JSON.stringify(task.priority_score)} (${typeof task.priority_score})`,
  );
  check("…with the right value", task.priority_score, 4.5);
  checkThat(
    "and arithmetic on it does not concatenate",
    (task.priority_score as number) + 0.5 === 5,
    `${task.priority_score} + 0.5 = ${(task.priority_score as number) + 0.5}`,
  );
  check("due_date stays a string", task.due_date, "2026-09-01");

  // --- 3. jsonb round-trip -------------------------------------------------
  const entry = await one(
    "entry read",
    alice("entries").select("*").eq("id", entryId).maybeSingle(),
  );
  check(
    "a jsonb ARRAY survives the round trip (this is what breaks silently)",
    entry.risks,
    ["late supplier", "scope creep"],
  );
  check("a jsonb array of objects survives too", entry.stakeholders, [
    { name: "Dana", role: "PM" },
  ]);

  // plan_versions.restore is the one that breaks undo if it is missed (G-10).
  const versionId = randomUUID();
  const restore = { tasks: [{ id: taskId, sort_index: 3 }] };
  await must(
    "plan_version insert",
    alice("plan_versions").insert({
      id: versionId,
      user_id: ALICE,
      reason: "harness",
      moves: [{ kind: "reorder" }],
      restore,
      odds_before: 0.4,
      odds_after: 0.7,
    }),
  );
  const version = await one(
    "plan_version read",
    alice("plan_versions").select("*").eq("id", versionId).maybeSingle(),
  );
  check("plan_versions.restore round-trips — undo depends on it", version.restore, restore);
  check("plan_versions.moves (an array) round-trips", version.moves, [
    { kind: "reorder" },
  ]);
  check("float8 stays a number", version.odds_after, 0.7);

  // --- 4. RLS isolation ----------------------------------------------------
  const bobSees = (await bob("goals").select("*").eq("id", goalId)) as {
    data: unknown[];
  };
  check("Bob cannot read Alice's goal (direct user_id policy)", bobSees.data, []);

  const bobTasks = (await bob("tasks").select("*").eq("id", taskId)) as {
    data: unknown[];
  };
  check(
    "Bob cannot read Alice's task (EXISTS-subquery policy, no user_id column)",
    bobTasks.data,
    [],
  );

  const bobDeletes = (await bob("goals").delete().eq("id", goalId)) as {
    error: unknown;
  };
  check("Bob's delete of Alice's goal reports no error…", bobDeletes.error, null);
  const stillThere = (await alice("goals").select("id").eq("id", goalId)) as {
    data: unknown[];
  };
  check("…and removes nothing", stillThere.data.length, 1);

  // The four soft-cap prunes carry NO user filter at all — their entire scoping
  // is app.user_id. This is the assertion that says that actually works.
  const bobUnfiltered = (await bob("plan_versions").select("id")) as {
    data: unknown[];
  };
  check(
    "an UNFILTERED select sees only your own rows (D.9)",
    bobUnfiltered.data,
    [],
  );

  // --- 5. the live .update({}) path (G-9) ----------------------------------
  const activityId = randomUUID();
  await must(
    "activity insert",
    alice("recurring_activities").insert({
      id: activityId,
      user_id: ALICE,
      title: "Harness activity",
      period: "week",
      target_count: 1,
      weekdays: [1, 3, 5],
      active: true,
    }),
  );
  const emptyPatch = await alice("recurring_activities")
    .update({})
    .eq("id", activityId)
    .select("*")
    .maybeSingle();
  check(
    "update({}) resolves cleanly instead of raising a syntax error",
    emptyPatch,
    { data: null, error: null },
  );
  const activity = await one(
    "activity read",
    alice("recurring_activities").select("*").eq("id", activityId).maybeSingle(),
  );
  check("…and changed nothing", activity.weekdays, [1, 3, 5]);

  // --- 6. maybeSingle over >1 row -----------------------------------------
  const t2 = randomUUID();
  await must(
    "second task insert",
    alice("tasks").insert({
      id: t2,
      entry_id: entryId,
      goal_id: goalId,
      title: "Harness task 2",
      status: "todo",
      sort_index: 1,
    }),
  );
  const ambiguous = (await alice("tasks")
    .select("*")
    .eq("entry_id", entryId)
    .maybeSingle()) as { data: unknown; error: { message: string } | null };
  check("maybeSingle over 2 real rows returns no data", ambiguous.data, null);
  checkThat(
    "…and an explicit error rather than an arbitrary row",
    ambiguous.error !== null,
    `error = ${JSON.stringify(ambiguous.error)}`,
  );

  // --- 7. upsert -----------------------------------------------------------
  for (const hours of [3, 7]) {
    await must(
      `availability upsert (${hours}h)`,
      alice("availability").upsert(
        { id: randomUUID(), user_id: ALICE, weekday: 2, hours },
        { onConflict: "user_id,weekday" },
      ),
    );
  }
  const avail = (await alice("availability").select("*").eq("weekday", 2)) as {
    data: { hours: number }[];
  };
  check("upsert on a composite key updates rather than duplicating", avail.data.length, 1);
  check("…and the second write won", avail.data[0].hours, 7);

  // --- 8. concurrency: a dashboard render is ~21 statements ----------------
  const t0 = Date.now();
  const many = await Promise.all(
    Array.from({ length: 21 }, () => alice("tasks").select("*")),
  );
  const elapsed = Date.now() - t0;
  checkThat(
    `21 concurrent statements all succeed (${elapsed}ms)`,
    many.every((r) => (r as { error: unknown }).error === null),
    JSON.stringify(many.find((r) => (r as { error: unknown }).error !== null)),
  );

  const idle = await pool.query<{ n: string }>(
    "select count(*) as n from pg_stat_activity where usename = current_user and state = 'idle in transaction'",
  );
  check(
    "no transaction was left open (G-5)",
    Number(idle.rows[0].n),
    0,
  );

  // --- 9. the auth path ----------------------------------------------------
  const lookupEmail = `harness-alice-${ALICE.slice(0, 8)}@example.invalid`;
  const found = await pool.query(
    "select id, email, password_hash from app.login_lookup($1)",
    [lookupEmail.toUpperCase()],
  );
  check("app.login_lookup reads past users_self with no session", found.rowCount, 1);
  check("…and is case-insensitive on email", found.rows[0].id, ALICE);
  checkThat(
    "…and returns the hash the app role cannot select directly",
    typeof found.rows[0].password_hash === "string",
    "no hash returned",
  );

  await pool.query("select app.set_password_hash($1,$2)", [
    ALICE,
    "$2a$12$" + "y".repeat(53),
  ]);
  const rehashed = await pool.query(
    "select password_hash from app.login_lookup($1)",
    [lookupEmail],
  );
  checkThat(
    "app.set_password_hash writes a column the app role cannot update",
    String(rehashed.rows[0].password_hash).includes("y"),
    String(rehashed.rows[0].password_hash).slice(0, 12),
  );

  const direct = await pool
    .query("select password_hash from users limit 1")
    .then(() => "no error")
    .catch((e: { code?: string }) => e.code ?? "error");
  check(
    "a DIRECT select of password_hash is refused (42501)",
    direct,
    "42501",
  );
}

async function cleanup(): Promise<void> {
  // goals/entries cascade; users are deleted last, under their own RLS.
  for (const id of [ALICE, BOB]) {
    try {
      await withUser(id, async (c) => {
        await c.query("delete from goals where user_id = $1", [id]);
        await c.query("delete from plan_versions where user_id = $1", [id]);
        await c.query("delete from recurring_activities where user_id = $1", [id]);
        await c.query("delete from availability where user_id = $1", [id]);
        await c.query("delete from users where id = $1", [id]);
      });
    } catch (e) {
      console.error(`  cleanup for ${id} failed:`, e);
    }
  }
}

main()
  .catch((e) => {
    failures.push(`harness threw: ${e instanceof Error ? e.stack : String(e)}`);
  })
  .then(cleanup)
  .then(async () => {
    await pool.end();
    console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
    for (const f of failures) console.log(`  FAIL  ${f}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
  });
