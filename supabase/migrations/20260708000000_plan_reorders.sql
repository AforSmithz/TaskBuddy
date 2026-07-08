-- Drag-to-reorder signal (OVERHAUL §5a substrate S3c-5, design/s3c5-shared-calibration-brain.md §6).
-- The 🔴 tier of the calibration cohort (ARRANGE_WEIGHTS.{switch,energy,buffer}) has no signal to
-- learn from: the arrangement reorder is applied silently and odds-gated, so nothing reveals which
-- soft dial the user would have turned. This table is that missing signal. When the user drags
-- today's plan into a new order that is odds-NEUTRAL vs the solver's order (an odds-worsening drag
-- is still honored but NOT recorded here), we keep both orders as one revealed-preference pair
-- `user_order ≻ app_order`. S4's `calibrateArrangeWeights` recomputes the feature vector φ from the
-- live feature functions over these two orders (single source of truth — a feature-fn change
-- re-prices history, same choice as diagnoseRoll reading stored orders) and nudges the weights.
--
-- A SIBLING to plan_rolls (mirrors it structurally): dispose-side bookkeeping only, authors no odds.
-- The client records an ORDER, nothing more; the server reconciles, re-prices, gates, and
-- calibrates. Both orders are EffectiveOrderEntry[] (same shape as CommittedPlan.order /
-- plan_rolls.plan_order), so schema_version reuses COMMITTED_PLAN_SCHEMA_VERSION for safe
-- invalidation of a stale order shape. The jsonb columns are named app_order/user_order (not a bare
-- `order`, a reserved word that collides with PostgREST's ?order= sort param — the plan_rolls
-- lesson); the domain fields stay PlanReorder.appOrder/userOrder, mapped like captured_at <->
-- capturedAt.
create table if not exists plan_reorders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  captured_at    timestamptz not null default now(),   -- when the drag was captured
  date           date not null,                         -- the plan day the reorder applies to (today only, v1)
  app_order      jsonb not null,                        -- the solver's order a* (EffectiveOrderEntry[]) — φ(a*)
  user_order     jsonb not null,                        -- the user's dragged order (EffectiveOrderEntry[]) — φ(u)
  schema_version integer not null                       -- COMMITTED_PLAN_SCHEMA_VERSION — drop a stale order shape
);

create index if not exists plan_reorders_user_captured_idx
  on plan_reorders (user_id, captured_at desc);

alter table plan_reorders enable row level security;
drop policy if exists plan_reorders_owner on plan_reorders;
create policy plan_reorders_owner on plan_reorders
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
