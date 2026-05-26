-- Phase 4 — the portfolio strategist: one cached, time-aware recommendation.
-- Caches the synthesized portfolio strategy per user so it only regenerates when
-- the situation changes (fingerprint mismatch) or the user explicitly asks. One
-- row per user; the strategy object (assessment + moves + metadata) is stored as
-- JSON, with `fingerprint` the situation hash it was generated for.
create table if not exists portfolio_strategy (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  fingerprint text not null,
  strategy    jsonb not null,
  updated_at  timestamptz not null default now()
);

alter table portfolio_strategy enable row level security;

drop policy if exists portfolio_strategy_owner on portfolio_strategy;
create policy portfolio_strategy_owner on portfolio_strategy
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
