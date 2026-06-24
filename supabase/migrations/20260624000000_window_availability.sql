-- Explicit per-window availability (OVERHAUL §5a S3b Phase 4, design Pillar 1 / decision #5).
-- The windowed forecast DERIVES how a day's hours split across the five time-of-day windows
-- from observed `work_sessions`; this lets a user PIN that split instead ("I work mornings
-- and evenings, never afternoons"). One row per user, the relative weight per window as jsonb
-- (all-zero / absent ⇒ unset, fall back to the derived share). An OPTIONAL override — it only
-- bounds how much work claims each window's learned velocity, never authors odds.
create table if not exists window_availability (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  weights    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table window_availability enable row level security;
drop policy if exists window_availability_owner on window_availability;
create policy window_availability_owner on window_availability
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
