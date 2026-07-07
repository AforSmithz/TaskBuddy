-- Passive-roll history (OVERHAUL §5a substrate S3c-2, design/s3c2-passive-roll-history.md).
-- S3c-1 keeps only the CURRENT committed plan (one upserted committed_plan row); when it
-- rolls, the prior arrangement is overwritten and gone. This table gives that evolving plan a
-- memory: one retained row per automatic roll (a material better-candidate OR an anchor
-- advance, never a stay-put reload), so the user gets a "how my plan evolved" timeline and can
-- undo a ROLL. That undo is distinct from plan_versions, which reverts an applied strategy
-- bundle's row mutations; a roll mutates no domain rows, only the arrangement. So this is a
-- SIBLING to plan_versions, not an overload of it (design §2): the two undo semantics stay
-- separate and the timeline UI unions them.
--
-- Dispose-side bookkeeping only: stores an arrangement snapshot + its soft score J, authors no
-- odds. `kind`/`prev_j` are the seam S3c-3's diagnoseRoll reads to narrate WHY a roll fired;
-- recorded now (cheap) so the history is diagnosable later without a backfill. The arrangement
-- lives in `plan_order` (jsonb, EffectiveOrderEntry[]), NOT a column named `order`: `order` is a
-- reserved word and collides with PostgREST's ?order= sort param. The domain field stays
-- PlanRoll.order, mapped like created_at <-> createdAt.
create table if not exists plan_rolls (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  rolled_at      timestamptz not null default now(),  -- when the roll fired
  anchor         date not null,                        -- CommittedPlan.anchor at roll time (frozen-zone day)
  fingerprint    text not null,                        -- CommittedPlan.fingerprint at roll time
  j              double precision not null,            -- committed arrangement soft score
  kind           text not null,                        -- 'material' | 'anchor' | 'initial' (free text, validated in TS)
  prev_j         double precision,                     -- superseded arrangement's j; null for 'initial'
  plan_order     jsonb not null,                       -- CommittedPlan.order (EffectiveOrderEntry[]) — the replay basis
  reverted_at    timestamptz,                          -- set when this roll is undone (stays in history, struck-through)
  schema_version integer not null                      -- COMMITTED_PLAN_SCHEMA_VERSION — safe invalidation of a stale order shape
);

create index if not exists plan_rolls_user_rolled_idx
  on plan_rolls (user_id, rolled_at desc);

alter table plan_rolls enable row level security;
drop policy if exists plan_rolls_owner on plan_rolls;
create policy plan_rolls_owner on plan_rolls
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
