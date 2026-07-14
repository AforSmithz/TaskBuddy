import { types } from "pg";

// node-postgres type parsers. Imported for side effect at the top of `pool.ts`,
// before any Pool is constructed.
//
// WHY THIS FILE EXISTS
//
// PostgREST handed us JSON: numbers were numbers, dates and timestamps were
// ISO strings. node-postgres does not. It parses `numeric` to a **string** and
// `date`/`timestamp`/`timestamptz` to a **Date object**. `lib/types.ts` declares
// every one of those columns as `number` / `string`, and TypeScript cannot catch
// the difference because the shim's rows are `unknown` cast to a domain type.
//
// The failure is not a clean crash. `"4.50" + 0.5` is `"4.50.5"`, so the
// dependency-aware task ordering in `lib/schedule.ts:114` silently degrades to a
// no-op *before* anything throws, and the capacity math in `lib/forecast.ts:90`
// concatenates instead of adding — one commitment on a day coerces back by luck,
// two give NaN, and `Math.max(0, NaN)` is NaN rather than 0, which then poisons
// every subsequent day. Intermittent, not a clean zero.
//
// These four are the complete set. Verified against `azure/sql/01_schema.sql`:
// 4 numeric columns, 8 date columns, 0 bare `timestamp` columns, 0 bigint.

/** numeric -> number. `tasks.priority_score` and the three `hours` columns. */
types.setTypeParser(1700, Number);

// date -> keep the raw 'YYYY-MM-DD' string. MUST BE IDENTITY.
//
// pg-types' built-in parseDate builds a Date at **local** midnight. The obvious
// "fix" — `new Date(v).toISOString().slice(0, 10)` — shifts every date back one
// day for anyone west of UTC, which corrupts all ~15 `.slice(0, 10)` call sites
// at once and does it invisibly. The app has always treated these as plain
// strings; keep them that way.
types.setTypeParser(1082, (v) => v);

// timestamp (no time zone) -> ISO string. No such column exists in the schema
// today; registered so that adding one later cannot reintroduce a Date object.
types.setTypeParser(1114, (v) => new Date(v + "Z").toISOString());

// timestamptz -> ISO string, in `Z` form.
//
// `Z` and not `+00:00`: the app writes `new Date().toISOString()` itself in
// several places, and mixing the two forms inside one `localeCompare` sort is
// not order-safe.
types.setTypeParser(1184, (v) => new Date(v).toISOString());

// DELIBERATELY NOT SET:
//   OID 20 (int8) — there is no bigint/bigserial column anywhere in the schema
//     and no `count` option is used, so the default string parse is unreachable.
//   int2 / int4 -> number, float8 -> number, jsonb -> parsed object. All already
//     correct by default. `plan_versions.odds_before/odds_after` and
//     `plan_rolls.j/prev_j` are float8, not numeric, so they are unaffected.

export {};
