import { isJsonbColumn } from "@/lib/db/columns";

// A PostgREST-compatible query builder.
//
// Deliberately pure: no server-only, no next/headers, no pool. It turns a chain of builder
// calls into { text, values } and hands that to an injected executor; ./shim.ts is the
// request-scoped wrapper that supplies a real one. That split is what lets azure/harness/
// assert the exact SQL text offline, with no database and no Next runtime - and this is the
// part that can be wrong in ways nothing else notices (an off-by-one in `.range()` deletes live
// undo history, a missed jsonb cast breaks undo silently).
//
// store.ts is 5.7k lines and 103 query chains and is NOT being rewritten. This exists so it
// doesn't have to be: it reimplements exactly the slice of the supabase-js surface store.ts
// uses, same { data, error } contract, nothing else.
//
// The method surface is deliberately incomplete. `.single()`, `.neq`, `.or`, `.filter`,
// `.contains`, `.rpc`, embedded selects and the `count` option all have zero call sites
// (verified), so reaching for one is a TypeError rather than a subtly wrong query. A wrong
// `.single()` is worse than no `.single()`.
//
// The one rule this file must never break: a terminal RESOLVES, it never rejects. bestEffortRows
// in store.ts inspects res.error as a value, and a thrown rejection would propagate past it and
// fell the whole Strategy page instead of degrading one panel. Every path funnels through fail().

export type Row = Record<string, unknown>;

/** A settled response, shaped exactly like PostgREST's. */
export interface ShimResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Runs one statement and returns its rows. `null` instead of an executor means
 * "no session" - see {@link QueryBuilder.execute} for why that must not run.
 */
export type Executor = (text: string, values: unknown[]) => Promise<Row[]>;

const IDENT_RE = /^[a-z_][a-z0-9_]*$/i;

function ident(name: string, what: string): string {
  if (!IDENT_RE.test(name)) {
    throw new Error(`Unsafe ${what} identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** `"*"`, `"id"`, or a comma-separated column list. Embedded selects are not supported. */
function columnList(cols: string): string {
  const trimmed = cols.trim();
  if (trimmed === "" || trimmed === "*") return "*";
  if (trimmed.includes("(")) {
    throw new Error(
      `Embedded select is not supported by this shim: ${JSON.stringify(cols)}`,
    );
  }
  return trimmed
    .split(",")
    .map((c) => ident(c.trim(), "column"))
    .join(", ");
}

function fail(message: string): ShimResult {
  return { data: null, error: { message } };
}

function messageOf(err: unknown): string {
  if (err && typeof err === "object") {
    const e = err as { message?: unknown; code?: unknown; detail?: unknown };
    const msg = typeof e.message === "string" ? e.message : String(err);
    // Carry the SQLSTATE. This whole file is the mitigation for a class of bug
    // where a failed query was indistinguishable from an empty table; when one
    // does fail(), the operator should not have to guess why.
    const code = typeof e.code === "string" ? `${e.code}: ` : "";
    const detail = typeof e.detail === "string" ? ` (${e.detail})` : "";
    return `${code}${msg}${detail}`;
  }
  return String(err);
}

// --- payload normalisation --------------------------------------------------

/** Mirror JSON.stringify: drop undefined-valued keys, keep null as SQL NULL. PostgREST got a
 *  JSON body, so an undefined field simply wasn't there and the column kept its value - a naive
 *  Object.entries() would write NULL instead. The live path that needs this is
 *  updateActivityAction, which passes a caller-supplied patch straight through. */
function definedEntries(obj: Row): [string, unknown][] {
  return Object.entries(obj).filter(([, v]) => v !== undefined);
}

interface Binder {
  /** Bind `value` and return its placeholder, e.g. `$3` or `$3::jsonb`. */
  bind(table: string, column: string, value: unknown): string;
  values: unknown[];
}

function makeBinder(): Binder {
  const values: unknown[] = [];
  return {
    values,
    bind(table, column, value) {
      // jsonb needs an explicit stringify and cast. node-postgres' prepareValue
      // turns a JS array into a PostgreSQL array literal - `{a,b}` - rather than
      // JSON, so object-valued jsonb survives by accident while array-valued
           // jsonb breaks silently. See ./columns.ts.
      if (isJsonbColumn(table, column)) {
        values.push(value === null ? null : JSON.stringify(value));
        return `$${values.length}::jsonb`;
      }
      values.push(value);
      return `$${values.length}`;
    },
  };
}

// --- the builder ------------------------------------------------------------

type Verb = "select" | "insert" | "update" | "upsert" | "delete";

interface Filter {
  column: string;
  op: "eq" | "lt" | "gte" | "in" | "isNull";
  value: unknown;
}

export class QueryBuilder implements PromiseLike<ShimResult> {
  private readonly table: string;
  private readonly exec: Executor | null;

  private verb: Verb | null = null;
  private selectCols = "*";
  private returning: string | null = null;

  private payload: Row[] | null = null;
  private patch: Row | null = null;
  private conflictColumns: string[] = [];

  private readonly filters: Filter[] = [];
  private readonly orderBys: { column: string; ascending: boolean }[] = [];
  private limitCount: number | null = null;
  private offsetCount: number | null = null;
  private wantSingle = false;

  private settled: Promise<ShimResult> | null = null;

  constructor(table: string, exec: Executor | null) {
    this.table = table;
    this.exec = exec;
  }

  /** The SQL this chain would run, without running it. For the harness, which asserts the exact
   *  text and parameters for every chain shape store.ts uses - and for debugging at 2am. */
  toSQL(): { text: string; values: unknown[] } | null {
    return this.build();
  }

   // --- verbs ---------------------------------------------------------------

  /**
   * Before a verb: this is a read, and `cols` is the projection. After a write
   * verb: this is `RETURNING`, matching PostgREST's `Prefer: return=representation`.
   */
  select(cols = "*"): this {
    if (this.verb === null) {
      this.verb = "select";
      this.selectCols = cols;
    } else {
      this.returning = cols;
    }
    return this;
  }

  // Payloads are typed `object`, not Record<string, unknown>, on purpose: store.ts passes domain
  // interfaces straight in, and a TS interface has no implicit index signature, so the stricter
  // type would reject every real call site.
  insert<T extends object>(values: T | T[]): this {
    this.verb = "insert";
    this.payload = (Array.isArray(values) ? values : [values]) as Row[];
    return this;
  }

  upsert<T extends object>(values: T | T[], options: { onConflict: string }): this {
    this.verb = "upsert";
    this.payload = (Array.isArray(values) ? values : [values]) as Row[];
    this.conflictColumns = options.onConflict.split(",").map((c) => c.trim());
    return this;
  }

  update<T extends object>(patch: T): this {
    this.verb = "update";
    this.patch = patch as Row;
    return this;
  }

  delete(): this {
    this.verb = "delete";
    return this;
  }

   // --- filters -------------------------------------------------------------

  eq(column: string, value: string | number | boolean | null): this {
    this.filters.push({ column, op: "eq", value });
    return this;
  }

  /** `column IS NULL`. Not reachable through.eq(col, null), and that's the classic SQL trap
   *  rather than a style choice: .eq binds a parameter and `col = NULL` is never true, so the
   *  query silently returns nothing. The one caller is the job-run lookup for portfolio-wide
   *  work, whose subject_id is genuinely NULL. */
  isNull(column: string): this {
    this.filters.push({ column, op: "isNull", value: null });
    return this;
  }

  lt(column: string, value: string | number): this {
    this.filters.push({ column, op: "lt", value });
    return this;
  }

  gte(column: string, value: string | number): this {
    this.filters.push({ column, op: "gte", value });
    return this;
  }

  in(column: string, values: readonly string[]): this {
    this.filters.push({ column, op: "in", value: [...values] });
    return this;
  }

   // --- shaping -------------------------------------------------------------

  order(column: string, options?: { ascending?: boolean }): this {
    this.orderBys.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  /** PostgREST ranges are INCLUSIVE at both ends: range(50, 1050) is rows 51-1051, i.e.
   *  OFFSET 50 LIMIT 1001. Four soft-cap prunes read .order(...).range(CAP, CAP+1000) and delete
   *  every id that comes back, so an off-by-one here destroys live undo state. The +1 isn't
   *  cosmetic. */
  range(from: number, to: number): this {
    this.offsetCount = from;
    this.limitCount = to - from + 1;
    return this;
  }

  /** 0 rows -> null. 1 row -> the row. >1 row -> an error, never "the first one". */
  maybeSingle(): this {
    this.wantSingle = true;
    return this;
  }

   // --- execution -----------------------------------------------------------

  then<TResult1 = ShimResult, TResult2 = never>(
    onfulfilled?:
      | ((value: ShimResult) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    // Thenable rather than a promise-returning terminal, because builders are
    // stored un-awaited in arrays and resolved by Promise.all - `store.ts:1182`
    // (4 builders) and `:2827` (3 builders).
    this.settled ??= this.execute();
    return this.settled.then(onfulfilled, onrejected);
  }

  private async execute(): Promise<ShimResult> {
  // No session: do not execute. Thirteen.select chains carry no filter at all, and four
  // prune DELETEs carry none either - their entire scoping is app.user_id. Running any of them
  // with the GUC unset is a cross-tenant read at best and a cross-tenant DELETE at worst.
    if (!this.exec) {
      return fail("Not signed in.");
    }

    let built: { text: string; values: unknown[] } | null;
    try {
      built = this.build();
    } catch (err) {
      return fail(messageOf(err));
    }

       // A no-op write (see build()): nothing to send, and PostgREST answered 200.
    if (built === null) return { data: null, error: null };

    try {
      return this.shape(await this.exec(built.text, built.values));
    } catch (err) {
      return fail(messageOf(err));
    }
  }

  /** Rows -> the response body the caller expects. */
  private shape(rows: Row[]): ShimResult {
    if (this.wantSingle) {
      if (rows.length === 0) return { data: null, error: null };
      if (rows.length > 1) {
        // PostgREST's PGRST116. `mustOne` treats a nullish `data` as "genuinely
        // absent", so quietly handing back rows[0] would let one user's row
        // stand in for a query that was never unambiguous.
        return fail(
          `JSON object requested, multiple (or no) rows returned (got ${rows.length})`,
        );
      }
      return { data: rows[0], error: null };
    }

       // A write with no `.select()` returns no body, exactly like PostgREST's
    // default `Prefer: return=minimal`. Only `mustOk` reads these.
    if (this.verb !== "select" && this.returning === null) {
      return { data: null, error: null };
    }

    return { data: rows, error: null };
  }

   // --- SQL generation ------------------------------------------------------

  /** Returns null when the statement is a legitimate no-op. */
  private build(): { text: string; values: unknown[] } | null {
    const verb = this.verb ?? "select";
    const table = ident(this.table, "table");
    const b = makeBinder();

    switch (verb) {
      case "select": {
        const sql =
          `SELECT ${columnList(this.selectCols)} FROM ${table}` +
          this.whereClause(b) +
          this.orderClause() +
          this.limitClause();
        return { text: sql, values: b.values };
      }

      case "insert": {
        const rows = this.payload ?? [];
        // No site inserts an empty array today (all 8 are length-guarded), but
               // `INSERT INTO t () VALUES ()` does not parse, so make it a no-op.
        if (rows.length === 0) return null;
        return this.buildInsert(rows, b, null);
      }

      case "upsert": {
        const rows = this.dedupeByConflictKey(this.payload ?? []);
        if (rows.length === 0) return null;
        return this.buildInsert(rows, b, this.conflictColumns);
      }

      case "update": {
        const entries = definedEntries(this.patch ?? {});
        // .update({}) is a LIVE path: updateRecurringActivity has no empty-patch guard, unlike
        // updateTask, and updateActivityAction feeds it a caller-supplied patch. PostgREST
        // answered 200 with no change, while `UPDATE t SET  WHERE id = $1` is a syntax error.
        // Resolve as the no-op the caller already expects.
        if (entries.length === 0) return null;
        if (this.filters.length === 0) {
          throw new Error(
            `Refusing an unfiltered UPDATE on ${this.table}: every update in ` +
              "this codebase carries a filter, so a missing one is a bug.",
          );
        }
        const sets = entries
          .map(([k, v]) => `${ident(k, "column")} = ${b.bind(this.table, k, v)}`)
          .join(", ");
        const sql =
          `UPDATE ${table} SET ${sets}` +
          this.whereClause(b) +
          this.returningClause();
        return { text: sql, values: b.values };
      }

      case "delete": {
        if (this.filters.length === 0) {
          // Free insurance: PostgREST permitted this, all 13 deletes here carry
                   // `.eq()` or `.in()`, and an accidental table-wide DELETE inside a
          // transaction that commits is unrecoverable.
          throw new Error(
            `Refusing an unfiltered DELETE on ${this.table}: every delete in ` +
              "this codebase carries a filter, so a missing one is a bug.",
          );
        }
        const sql =
          `DELETE FROM ${table}` + this.whereClause(b) + this.returningClause();
        return { text: sql, values: b.values };
      }
    }
  }

  private buildInsert(
    rows: Row[],
    b: Binder,
    conflict: string[] | null,
  ): { text: string; values: unknown[] } {
    // Union of keys across all rows, so a row missing a key gets NULL rather
    // than silently dropping the column for everyone. Every array insert in
       // store.ts is built by a `.map()` and is uniform, so this is belt-and-braces.
    const columns: string[] = [];
    for (const row of rows) {
      for (const [k] of definedEntries(row)) {
        if (!columns.includes(k)) columns.push(k);
      }
    }
    if (columns.length === 0) {
      throw new Error(`Refusing an INSERT into ${this.table} with no columns.`);
    }

    const tuples = rows
      .map(
        (row) =>
          "(" +
          columns
            .map((c) =>
              c in row && row[c] !== undefined
                ? b.bind(this.table, c, row[c])
                : b.bind(this.table, c, null),
            )
            .join(", ") +
          ")",
      )
      .join(", ");

    let sql =
      `INSERT INTO ${ident(this.table, "table")} ` +
      `(${columns.map((c) => ident(c, "column")).join(", ")}) VALUES ${tuples}`;

    if (conflict) {
      const target = conflict.map((c) => ident(c, "column")).join(", ");
      // DO UPDATE SET lists only the payload's own columns. Two of the seven
      // upsert sites omit `id` from their payload; including an unlisted column
      // here would null it or regenerate the primary key.
      const sets = columns
        .map((c) => `${ident(c, "column")} = EXCLUDED.${ident(c, "column")}`)
        .join(", ");
      sql += ` ON CONFLICT (${target}) DO ${sets ? `UPDATE SET ${sets}` : "NOTHING"}`;
    }

    return { text: sql + this.returningClause(), values: b.values };
  }

  /** Last write wins per conflict key. Postgres raises "ON CONFLICT DO UPDATE command cannot
   *  affect row a second time" if one statement touches the same key twice. Only availability
   *  upserts multiple rows and its single() caller passes one today, so this is latent rather than
   *  live - which is exactly when it's cheapest to fix. */
  private dedupeByConflictKey(rows: Row[]): Row[] {
    if (rows.length < 2 || this.conflictColumns.length === 0) return rows;
    const seen = new Map<string, Row>();
    for (const row of rows) {
      const key = JSON.stringify(this.conflictColumns.map((c) => row[c]));
      seen.set(key, row);
    }
    return [...seen.values()];
  }

  private whereClause(b: Binder): string {
    if (this.filters.length === 0) return "";
    const parts = this.filters.map((f) => {
      const col = ident(f.column, "column");
      switch (f.op) {
        case "eq":
          return `${col} = ${b.bind(this.table, f.column, f.value)}`;
        case "lt":
          return `${col} < ${b.bind(this.table, f.column, f.value)}`;
        case "gte":
          return `${col} >= ${b.bind(this.table, f.column, f.value)}`;
        case "isNull":
          return `${col} IS NULL`;
        case "in":
                 // `= ANY($n::uuid[])`. All 13 `.in()` sites target `id`, `entry_id` or
          // `skill_node_id`, all uuid. It is also valid on an empty array and
          // correctly returns zero rows, which the callers already guard for.
          b.values.push(f.value);
          return `${col} = ANY($${b.values.length}::uuid[])`;
      }
    });
    // Comparisons bind as a bare `$n`: PostgreSQL resolves the parameter type
    // from the column, so uuid / date / timestamptz / boolean / text all parse
    // from the text form node-postgres sends. Explicit casts would only narrow it.
    return ` WHERE ${parts.join(" AND ")}`;
  }

  private orderClause(): string {
    if (this.orderBys.length === 0) return "";
    const parts = this.orderBys.map(
      (o) => `${ident(o.column, "column")} ${o.ascending ? "ASC" : "DESC"}`,
    );
    return ` ORDER BY ${parts.join(", ")}`;
  }

  private limitClause(): string {
    let sql = "";
    if (this.limitCount !== null) sql += ` LIMIT ${Number(this.limitCount)}`;
    if (this.offsetCount !== null) sql += ` OFFSET ${Number(this.offsetCount)}`;
    return sql;
  }

  private returningClause(): string {
    return this.returning === null
      ? ""
      : ` RETURNING ${columnList(this.returning)}`;
  }
}
