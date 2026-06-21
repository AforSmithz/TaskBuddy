-- Plan version history (OVERHAUL S1 step 3 / vision §1.3).
-- Every applied strategy bundle is recorded as a `PlanVersion`: the committed
-- moves, the odds the user accepted (before → after), and a `restore` snapshot of
-- the prior values of every row the bundle touched (plus the ids of any synthetic
-- rows it inserted). One snapshot per bundle ⇒ undo reverts the whole strategy at
-- once (§8.2). `reverted_at` marks a version that has been undone. `moves` and
-- `restore` are jsonb; the rest are queryable columns (history list + pruning).
create table if not exists plan_versions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  reverted_at timestamptz,                          -- set when undone (null while it stands)
  reason      text not null,                        -- synthesis assessment, or "Applied N moves"
  odds_before double precision not null,            -- portfolio odds before the bundle
  odds_after  double precision not null,            -- the previewed number the user accepted
  moves       jsonb not null,                       -- StrategyMove[] — the committed bundle
  restore     jsonb not null                        -- RowSnapshot — prior values + inserted ids
);

create index if not exists plan_versions_user_created_idx
  on plan_versions (user_id, created_at desc);

alter table plan_versions enable row level security;
drop policy if exists plan_versions_owner on plan_versions;
create policy plan_versions_owner on plan_versions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
