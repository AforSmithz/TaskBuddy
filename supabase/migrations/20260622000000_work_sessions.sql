-- Session-clock capture (OVERHAUL S2 slice B / vision §5, §9.1).
-- One real work session: how long you actually sat down (minutes), the local
-- time-of-day window + weekday you worked in, and the day it counts for. This is
-- the WHEN-signal today's data lacks — `tasks.completed_at` is a single UTC
-- "marked done" instant + `actual_minutes` is a cumulative total, neither of which
-- says when (locally) you worked. Slice C reads these (keyed by window/weekday) for
-- energy windows + adherence. `window`/`weekday` are captured LOCAL at write time
-- (the client knows its offset), sidestepping the stored-timezone gap entirely.
-- A session is task effort XOR a routine session. Pure accrual — no behaviour
-- change in slice B; only slice C consumes it.
create table if not exists work_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,                 -- task/errand effort…
  activity_id uuid references recurring_activities(id) on delete cascade,  -- …or routine/goal session
  logged_for  date not null,                                               -- the day the work counts for
  time_window text not null check (time_window in
                ('early','morning','afternoon','evening','night')),        -- local TimeWindow at write time ("window" is a reserved word)
  weekday     integer not null check (weekday between 0 and 6),            -- 0=Sun..6=Sat, local
  minutes     integer not null default 0 check (minutes >= 0),            -- this session's real length
  kind        text not null check (kind in ('progress','complete')),
  created_at  timestamptz not null default now(),
  -- exactly one source: task effort or a routine session, never both/neither
  constraint work_sessions_one_source check ((task_id is not null) <> (activity_id is not null))
);

create index if not exists work_sessions_user_logged_idx
  on work_sessions (user_id, logged_for);

alter table work_sessions enable row level security;
drop policy if exists work_sessions_owner on work_sessions;
create policy work_sessions_owner on work_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
