-- Rolling-horizon wrapper (OVERHAUL §5a substrate S3c-1, design/s3c-rolling-horizon-wrapper.md).
-- The ONE piece of state anti-thrash needs: what plan the user is currently following, so
-- a reload doesn't reshuffle the imminent day for a sub-epsilon soft-objective gain. One row
-- per user (mirrors portfolio_strategy / value_model / window_availability): the committed
-- arrangement (order + anchor day + situation fingerprint + its soft score J) as jsonb, upserted.
-- Dispose-side only: authors no odds, feasibility/odds always dominate stickiness. A full
-- roll-HISTORY timeline is deferred (S3c-2) — this is the single current-plan row.
create table if not exists committed_plan (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  plan        jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table committed_plan enable row level security;

drop policy if exists committed_plan_owner on committed_plan;
create policy committed_plan_owner on committed_plan
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
