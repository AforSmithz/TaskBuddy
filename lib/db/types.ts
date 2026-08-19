import { types } from "pg";

// node-postgres type parsers. Imported for side effect at the top of pool.ts, before any Pool is
// constructed.
//
// PostgREST handed us JSON: numbers were numbers, dates and timestamps were ISO strings.
// node-postgres doesn't. It parses numeric to a STRING and date/timestamp/timestamptz to a Date().
// lib/types.ts declares all of those as number/string, and TypeScript can't catch the difference
// because the shim's rows are `unknown` cast to a domain type.
//
// The failure isn't a clean crash. "4.50" + 0.5 is "4.50.5", so the dependency-aware ordering in
// schedule.ts silently degrades to a no-op BEFORE anything throws, and the capacity math in
// forecast.ts concatenates instead of adding - one commitment on a day coerces back by luck, two
// give NaN, and Math.max(0, NaN) is NaN rather than 0, which poisons every later day.
//
// These four are the complete set, verified against the schema: 4 numeric columns, 8 date
// columns, 0 bare timestamp columns, 0 bigint.

/** numeric -> number. `tasks.priority_score` and the three `hours` columns. */
types.setTypeParser(1700, Number);

// date -> keep the raw 'YYYY-MM-DD' string. MUST BE IDENTITY. pg-types' parseDate builds a Date()
// at LOCAL midnight, and the obvious "fix" (new Date(v).toISOString.slice(0,10)) shifts every
// date back a day for anyone west of UTC, corrupting all ~15.slice(0,10) call sites at once and
// invisibly. The app has always treated these as plain strings.
types.setTypeParser(1082, (v) => v);

// timestamp (no time zone) -> ISO string. No such column exists in the schema
// today; registered so that adding one later cannot reintroduce a Date() object.
types.setTypeParser(1114, (v) => new Date(v + "Z").toISOString());

// timestamptz -> ISO string in Z form. Z and not +00:00, because the app writes
// new Date().toISOString itself in several places and mixing the two forms inside one
// localeCompare sort isn't order-safe.
types.setTypeParser(1184, (v) => new Date(v).toISOString());

// Deliberately not set: int8 (no bigint column anywhere and no count option, so the default
// string parse is unreachable), and int2/int4/float8/jsonb, which are already correct.
// plan_versions.odds_* and plan_rolls.j are float8, not numeric, so they're unaffected.

export {};
