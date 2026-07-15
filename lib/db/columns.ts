// The jsonb columns, per table. This is the only schema knowledge the shim
// holds, and it exists to defend against one specific node-postgres behaviour.
//
// `prepareValue` turns a JS array into a **PostgreSQL array literal** - `{a,b}` - 
// not JSON. Objects it happens to `JSON.stringify`, so object-valued jsonb works
// by accident while array-valued jsonb breaks silently: the insert either errors
// with "malformed array literal" or, worse, stores something that reads back as
// the wrong shape.
//
// So every value bound to a column listed here is `JSON.stringify`d and cast
// `$n::jsonb` explicitly, regardless of whether it is an array or an object.
//
// `plan_versions.restore` is the one that is easy to miss. It holds a
// `RowSnapshot` *object* today, so it would survive a partial list by accident - 
// until the day it doesn't, and undo is the feature the whole `plan_versions`
// table exists for.
//
// Verified exhaustively against `azure/sql/01_schema.sql`: 17 columns across
// 12 tables. If you add a jsonb column, add it here in the same commit.

export const JSONB_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  entries: [
    "discussion_points",
    "stakeholders",
    "key_deliverables",
    "assumptions",
    "risks",
  ],
  skill_nodes: ["prerequisites"],
  portfolio_strategy: ["strategy"],
  value_model: ["model"],
  recurring_activities: ["weekdays"],
  window_availability: ["weights"],
  plan_versions: ["moves", "restore"],
  committed_plan: ["plan"],
  plan_rolls: ["plan_order"],
  plan_reorders: ["app_order", "user_order"],
  move_choices: ["offered"],
};

/** True when `column` on `table` is jsonb and must be bound as `$n::jsonb`. */
export function isJsonbColumn(table: string, column: string): boolean {
  return JSONB_COLUMNS[table]?.includes(column) ?? false;
}
