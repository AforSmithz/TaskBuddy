-- Per-user strategist preferences. `auto_strategy` controls the pit wall:
-- on = auto-apply the obvious low-value triage and escalate only genuine ties;
-- off (default) = surface every option, never auto-apply. One row per user.
create table if not exists user_settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  auto_strategy boolean not null default false,
  updated_at    timestamptz not null default now()
);

alter table user_settings enable row level security;

drop policy if exists user_settings_owner on user_settings;
create policy user_settings_owner on user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
