/**
 * Offline harness: asserts the exact SQL and parameter list the shim generates
 * for every distinct chain shape `lib/store.ts` actually uses.
 *
 *   pnpm dlx tsx azure/harness/sql.ts
 *
 * No database, no Next runtime, no network. `lib/db/query.ts` is pure for
 * exactly this reason.
 *
 * WHY THIS EXISTS. `lib/store.ts:216-245` documents the failure this whole
 * migration has to avoid: a swallowed query error is bit-indistinguishable from
 * an empty table, so the calibration dials sit at their defaults and the UI says
 * a confident "no decisions yet". `move_choices` shipped exactly that way and
 * nothing looked wrong. A hand-rolled shim with a wrong `.range()` bound or a
 * missing jsonb cast reintroduces that class of bug — silently, and in the two
 * features (undo, capacity) whose breakage is hardest to notice.
 *
 * The chain shapes below are transcribed from real call sites; the line numbers
 * are cited so they can be re-checked when store.ts moves.
 */
import { QueryBuilder } from "../../lib/db/query";

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

/** A builder with a dummy executor, so `.toSQL()` reflects a signed-in chain. */
function q(table: string): QueryBuilder {
  return new QueryBuilder(table, async () => []);
}

function sql(b: QueryBuilder): string | null {
  return b.toSQL()?.text ?? null;
}

function params(b: QueryBuilder): unknown[] | null {
  return b.toSQL()?.values ?? null;
}

// --- 1. reads ---------------------------------------------------------------

check(
  "select * with no filter at all (store.ts:2830, getRawTimeBudget)",
  sql(q("availability").select("*")),
  'SELECT * FROM "availability"',
);

check(
  "select.eq.maybeSingle (store.ts:1178, entry read)",
  sql(q("entries").select("*").eq("id", "E1").maybeSingle()),
  'SELECT * FROM "entries" WHERE "id" = $1',
);

check(
  "select.eq.order (store.ts:1186, entry tasks)",
  sql(q("tasks").select("*").eq("entry_id", "E1").order("sort_index")),
  'SELECT * FROM "tasks" WHERE "entry_id" = $1 ORDER BY "sort_index" ASC',
);

check(
  "order descending (store.ts:615)",
  sql(q("goals").select("*").order("created_at", { ascending: false })),
  'SELECT * FROM "goals" ORDER BY "created_at" DESC',
);

check(
  "select.in (store.ts:836)",
  sql(q("tasks").select("*").in("entry_id", ["A", "B"])),
  'SELECT * FROM "tasks" WHERE "entry_id" = ANY($1::uuid[])',
);

check(
  "select.in binds the array as one parameter",
  params(q("tasks").select("*").in("entry_id", ["A", "B"])),
  [["A", "B"]],
);

check(
  "two .eq() AND together (store.ts:3259, errands entry read)",
  sql(
    q("entries")
      .select("id")
      .eq("goal_id", "G1")
      .eq("status", "active")
      .limit(1)
      .maybeSingle(),
  ),
  'SELECT "id" FROM "entries" WHERE "goal_id" = $1 AND "status" = $2 LIMIT 1',
);

check(
  "select.lt.order.limit.maybeSingle (store.ts:1818)",
  sql(
    q("plan_rolls")
      .select("*")
      .lt("rolled_at", "2026-08-16T00:00:00.000Z")
      .order("rolled_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ),
  'SELECT * FROM "plan_rolls" WHERE "rolled_at" < $1 ORDER BY "rolled_at" DESC LIMIT 1',
);

check(
  "select.gte.order (store.ts:2780)",
  sql(q("commitments").select("*").gte("date", "2026-08-16").order("date")),
  'SELECT * FROM "commitments" WHERE "date" >= $1 ORDER BY "date" ASC',
);

// --- 2. .range() — the four soft-cap prunes ---------------------------------
//
// PostgREST ranges are inclusive at BOTH ends: range(50, 1050) is rows 51..1051.
// These four reads feed a DELETE of every id returned, so an off-by-one here
// destroys live plan_versions / plan_rolls undo state. This is the single
// highest-consequence assertion in the file.

check(
  "range(50, 1050) is OFFSET 50 LIMIT 1001 (store.ts:1723)",
  sql(
    q("plan_rolls")
      .select("id")
      .order("rolled_at", { ascending: false })
      .range(50, 1050),
  ),
  'SELECT "id" FROM "plan_rolls" ORDER BY "rolled_at" DESC LIMIT 1001 OFFSET 50',
);

// --- 3. writes --------------------------------------------------------------

check(
  "insert single object, no returning (store.ts:600)",
  sql(q("goals").insert({ id: "G1", user_id: "U1", title: "x" })),
  'INSERT INTO "goals" ("id", "user_id", "title") VALUES ($1, $2, $3)',
);

check(
  "insert(arr).select() returns everything (store.ts:878)",
  sql(q("skill_task_links").insert([{ id: "L1" }, { id: "L2" }]).select()),
  'INSERT INTO "skill_task_links" ("id") VALUES ($1), ($2) RETURNING *',
);

check(
  "update.eq.select('*').maybeSingle (store.ts:1328)",
  sql(
    q("tasks")
      .update({ status: "done" })
      .eq("id", "T1")
      .select("*")
      .maybeSingle(),
  ),
  'UPDATE "tasks" SET "status" = $1 WHERE "id" = $2 RETURNING *',
);

check(
  "delete.in (store.ts:1732, prune)",
  sql(q("plan_rolls").delete().in("id", ["a", "b"])),
  'DELETE FROM "plan_rolls" WHERE "id" = ANY($1::uuid[])',
);

check(
  "delete with three .eq() (store.ts:3122, activity unskip)",
  sql(
    q("activity_completions")
      .delete()
      .eq("activity_id", "A1")
      .eq("date", "2026-08-16")
      .eq("skipped", true),
  ),
  'DELETE FROM "activity_completions" WHERE "activity_id" = $1 AND "date" = $2 AND "skipped" = $3',
);

check(
  "bulk update by non-PK still works (store.ts:1098)",
  sql(q("tasks").update({ area: "work", goal_id: "G1" }).eq("entry_id", "E1")),
  'UPDATE "tasks" SET "area" = $1, "goal_id" = $2 WHERE "entry_id" = $3',
);

// --- 4. upsert --------------------------------------------------------------

check(
  "upsert on a composite key (store.ts:1453, availability)",
  sql(
    q("availability").upsert(
      { user_id: "U1", weekday: 1, hours: 3 },
      { onConflict: "user_id,weekday" },
    ),
  ),
  'INSERT INTO "availability" ("user_id", "weekday", "hours") VALUES ($1, $2, $3) ' +
    'ON CONFLICT ("user_id", "weekday") DO UPDATE SET "user_id" = EXCLUDED."user_id", ' +
    '"weekday" = EXCLUDED."weekday", "hours" = EXCLUDED."hours"',
);

check(
  "upsert de-duplicates by conflict key (D.7: 'cannot affect row a second time')",
  params(
    q("availability").upsert(
      [
        { user_id: "U1", weekday: 1, hours: 3 },
        { user_id: "U1", weekday: 1, hours: 9 },
      ],
      { onConflict: "user_id,weekday" },
    ),
  ),
  ["U1", 1, 9],
);

// --- 5. jsonb ---------------------------------------------------------------
//
// node-postgres turns a JS array into a PG array literal `{a,b}` rather than
// JSON, so array-valued jsonb breaks silently while object-valued jsonb survives
// by accident. Every one of the 17 jsonb columns must be stringified and cast.

check(
  "jsonb ARRAY column is stringified and cast (entries.risks)",
  q("entries").insert({ id: "E1", risks: ["a", "b"] }).toSQL(),
  {
    text: 'INSERT INTO "entries" ("id", "risks") VALUES ($1, $2::jsonb)',
    values: ["E1", '["a","b"]'],
  },
);

check(
  "plan_versions.restore is cast too — omitting it breaks undo (G-10)",
  q("plan_versions")
    .insert({ id: "V1", restore: { tasks: [{ id: "T1" }] } })
    .toSQL(),
  {
    text: 'INSERT INTO "plan_versions" ("id", "restore") VALUES ($1, $2::jsonb)',
    values: ["V1", '{"tasks":[{"id":"T1"}]}'],
  },
);

check(
  "a NULL jsonb value stays SQL NULL, not the string 'null'",
  params(q("plan_versions").insert({ id: "V1", restore: null })),
  ["V1", null],
);

check(
  "a non-jsonb column is NOT cast",
  q("tasks").insert({ id: "T1", title: "x" }).toSQL(),
  {
    text: 'INSERT INTO "tasks" ("id", "title") VALUES ($1, $2)',
    values: ["T1", "x"],
  },
);

// --- 6. payload key handling ------------------------------------------------

check(
  "undefined keys are dropped, mirroring JSON.stringify (D.10)",
  q("tasks").update({ title: "x", notes: undefined }).eq("id", "T1").toSQL(),
  {
    text: 'UPDATE "tasks" SET "title" = $1 WHERE "id" = $2',
    values: ["x", "T1"],
  },
);

check(
  "null keys are preserved as SQL NULL",
  params(q("tasks").update({ due_date: null }).eq("id", "T1")),
  [null, "T1"],
);

check(
  "insert union-of-keys NULL-fills a row missing a column",
  q("tasks").insert([{ id: "a", title: "x" }, { id: "b" }]).toSQL(),
  {
    text: 'INSERT INTO "tasks" ("id", "title") VALUES ($1, $2), ($3, $4)',
    values: ["a", "x", "b", null],
  },
);

// --- 7. empty-collection and guard behaviour --------------------------------

check(
  "update({}) is a no-op, not a syntax error (G-9, live path at actions.ts:955)",
  q("recurring_activities").update({}).eq("id", "A1").toSQL(),
  null,
);

check("insert([]) is a no-op", q("tasks").insert([]).toSQL(), null);

check(
  "in(col, []) is valid SQL and returns zero rows",
  sql(q("tasks").delete().in("id", [])),
  'DELETE FROM "tasks" WHERE "id" = ANY($1::uuid[])',
);

function throws(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.slice(0, 40) : String(e);
  }
}

check(
  "unfiltered DELETE is refused",
  throws(() => q("tasks").delete().toSQL()) !== null,
  true,
);

check(
  "unfiltered UPDATE is refused",
  throws(() => q("tasks").update({ title: "x" }).toSQL()) !== null,
  true,
);

check(
  "an embedded select is refused rather than mis-generated",
  throws(() => q("entries").select("id, tasks(*)").toSQL()) !== null,
  true,
);

check(
  "a non-identifier column is refused",
  throws(() => q("tasks").select('id"; drop table users --').toSQL()) !== null,
  true,
);

// --- 8. the response contract -----------------------------------------------

async function results(): Promise<void> {
  // A terminal must RESOLVE, never reject: store.ts's `bestEffortRows` inspects
  // `res.error` as a value, and a rejection would propagate past it and fell the
  // whole Strategy page instead of thinning one panel.
  const boom = new QueryBuilder("tasks", async () => {
    throw Object.assign(new Error('relation "tasks" does not exist'), {
      code: "42P01",
    });
  });
  const errored = await boom.select("*");
  check(
    "a query error resolves as { data: null, error } and keeps the SQLSTATE",
    errored,
    { data: null, error: { message: '42P01: relation "tasks" does not exist' } },
  );

  const noSession = new QueryBuilder("tasks", null);
  check(
    "no session refuses to execute (D.2: the 4 prune DELETEs carry no user filter)",
    await noSession.select("*"),
    { data: null, error: { message: "Not signed in." } },
  );

  const two = () =>
    new QueryBuilder("user_settings", async () => [{ id: "a" }, { id: "b" }]);
  check(
    "maybeSingle on >1 row is an ERROR, never 'the first row' (D.8)",
    ((await two().select("*").maybeSingle()) as { data: unknown }).data,
    null,
  );
  check(
    "…and it reports why",
    ((await two().select("*").maybeSingle()) as { error: { message: string } })
      .error.message.startsWith("JSON object requested"),
    true,
  );

  const none = new QueryBuilder("user_settings", async () => []);
  check(
    "maybeSingle on 0 rows is { data: null, error: null } — genuinely absent",
    await none.select("*").maybeSingle(),
    { data: null, error: null },
  );

  const one = new QueryBuilder("user_settings", async () => [{ id: "a" }]);
  check("maybeSingle on 1 row returns the row", await one.select("*").maybeSingle(), {
    data: { id: "a" },
    error: null,
  });

  const rows = new QueryBuilder("tasks", async () => [{ id: "a" }]);
  check("a plain select returns an array", await rows.select("*"), {
    data: [{ id: "a" }],
    error: null,
  });

  const written = new QueryBuilder("tasks", async () => []);
  check(
    "a write with no .select() returns data: null, like Prefer: return=minimal",
    await written.update({ title: "x" }).eq("id", "T1"),
    { data: null, error: null },
  );

  // Builders are stored un-awaited in arrays and resolved by Promise.all —
  // store.ts:1182 (4 builders) and :2827 (3 builders).
  const [a, b] = await Promise.all([
    new QueryBuilder("tasks", async () => [{ id: "a" }]).select("*"),
    new QueryBuilder("decisions", async () => [{ id: "b" }]).select("*"),
  ]);
  check("builders are thenable and survive Promise.all", [a, b], [
    { data: [{ id: "a" }], error: null },
    { data: [{ id: "b" }], error: null },
  ]);

  let calls = 0;
  const once = new QueryBuilder("tasks", async () => {
    calls++;
    return [];
  });
  const builder = once.select("*");
  await builder;
  await builder;
  check("awaiting a builder twice runs the statement once", calls, 1);
}

results().then(() => {
  console.log(`\n  ${passed} passed, ${failures.length} failed\n`);
  for (const f of failures) console.log(`  FAIL  ${f}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
});
