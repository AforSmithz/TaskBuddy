-- TaskBuddy database schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Projects: top-level grouping for entries and goal plans.
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create index if not exists projects_user_id_idx on projects(user_id);

-- ---------------------------------------------------------------------------
-- Entries: one row per entry (meeting transcript or goal plan), plus its
-- AI-derived planning. `kind` distinguishes the two; `status` gates drafts.
-- ---------------------------------------------------------------------------
create table if not exists entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid references auth.users(id) on delete cascade,
  title             text not null,
  raw_input         text not null,
  summary           text,
  discussion_points jsonb default '[]'::jsonb,   -- string[]
  stakeholders      jsonb default '[]'::jsonb,   -- string[]
  daily_objective   text,
  key_deliverables  jsonb default '[]'::jsonb,   -- string[]
  assumptions       jsonb default '[]'::jsonb,   -- string[]
  risks             jsonb default '[]'::jsonb,   -- string[]
  kind              text not null default 'meeting', -- meeting | plan
  status            text not null default 'active',  -- draft | active
  project_id        uuid references projects(id) on delete set null,
  parent_entry_id   uuid references entries(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists entries_project_id_idx on entries(project_id);
create index if not exists entries_user_id_idx on entries(user_id);

-- For existing databases, add the new columns in place:
alter table entries
  add column if not exists kind            text not null default 'meeting',
  add column if not exists status          text not null default 'active',
  add column if not exists user_id         uuid references auth.users(id) on delete cascade,
  add column if not exists project_id      uuid references projects(id) on delete set null,
  add column if not exists parent_entry_id uuid references entries(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Decisions: choices made in the entry (kept separate from tasks).
-- ---------------------------------------------------------------------------
create table if not exists decisions (
  id           uuid primary key default gen_random_uuid(),
  entry_id     uuid not null references entries(id) on delete cascade,
  decision     text not null,
  source_quote text,
  confidence   text,                              -- High | Medium | Low
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Open questions: unresolved points needing follow-up.
-- ---------------------------------------------------------------------------
create table if not exists open_questions (
  id                  uuid primary key default gen_random_uuid(),
  entry_id            uuid not null references entries(id) on delete cascade,
  question            text not null,
  related_stakeholder text,
  source_quote        text,
  confidence          text,
  status              text not null default 'open', -- open | resolved
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Tasks: explicit + AI-suggested action items with scoring.
-- ---------------------------------------------------------------------------
create table if not exists tasks (
  id                uuid primary key default gen_random_uuid(),
  entry_id          uuid not null references entries(id) on delete cascade,
  title             text not null,
  description       text,
  owner             text,
  category          text,
  area              text not null default 'Work', -- life-area for Today-page tabs
  status            text not null default 'todo', -- backlog|todo|in_progress|blocked|review|done
  due_date          date,
  estimated_minutes integer default 0,
  actual_minutes    integer default 0,
  -- 1-5 factor ratings produced by the LLM
  urgency_score     integer,
  impact_score      integer,
  effort_score      integer,
  dependency_score  integer,
  risk_score        integer,
  confidence_score  integer,
  -- deterministic outputs computed in code
  priority_score    numeric(4,2),
  priority_label    text,                          -- Critical|High|Medium|Low|Backlog
  priority_reason   text,
  source_quote      text,
  is_ai_suggested   boolean not null default false,
  blocked_by        text,                          -- human-readable blocker note
  sort_index        integer default 0,
  created_at        timestamptz not null default now()
);

create index if not exists tasks_entry_id_idx on tasks(entry_id);
create index if not exists tasks_status_idx on tasks(status);

-- ---------------------------------------------------------------------------
-- Task dependencies: directed edges (task depends_on another task).
-- ---------------------------------------------------------------------------
create table if not exists task_dependencies (
  id                  uuid primary key default gen_random_uuid(),
  entry_id            uuid not null references entries(id) on delete cascade,
  task_id             uuid not null references tasks(id) on delete cascade,
  depends_on_task_id  uuid not null references tasks(id) on delete cascade,
  reason              text,
  unique (task_id, depends_on_task_id)
);

-- ---------------------------------------------------------------------------
-- Schedule blocks: deterministic recommended schedule for an entry's tasks.
-- ---------------------------------------------------------------------------
create table if not exists schedule_blocks (
  id          uuid primary key default gen_random_uuid(),
  entry_id    uuid not null references entries(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,
  label       text not null,
  start_time  text not null,                       -- "09:00"
  end_time    text not null,                       -- "10:30"
  reason      text,
  sort_index  integer default 0
);

create index if not exists schedule_entry_id_idx on schedule_blocks(entry_id);

-- ---------------------------------------------------------------------------
-- Row Level Security: each user sees only their own data.
--   * projects & entries are owned directly via user_id
--   * child tables (decisions, open_questions, tasks, task_dependencies,
--     schedule_blocks) inherit ownership through their parent entry
-- The app connects with the publishable (anon) key carrying the user's
-- session, so these policies — not application code — enforce isolation.
-- ---------------------------------------------------------------------------
alter table projects          enable row level security;
alter table entries           enable row level security;
alter table decisions         enable row level security;
alter table open_questions    enable row level security;
alter table tasks             enable row level security;
alter table task_dependencies enable row level security;
alter table schedule_blocks   enable row level security;

drop policy if exists projects_owner on projects;
create policy projects_owner on projects
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists entries_owner on entries;
create policy entries_owner on entries
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Child-table policies. `<table>_owner` is true when the parent entry
-- belongs to the current user.
drop policy if exists decisions_owner on decisions;
create policy decisions_owner on decisions
  for all
  using (exists (select 1 from entries e
                 where e.id = decisions.entry_id and e.user_id = auth.uid()))
  with check (exists (select 1 from entries e
                      where e.id = decisions.entry_id and e.user_id = auth.uid()));

drop policy if exists open_questions_owner on open_questions;
create policy open_questions_owner on open_questions
  for all
  using (exists (select 1 from entries e
                 where e.id = open_questions.entry_id and e.user_id = auth.uid()))
  with check (exists (select 1 from entries e
                      where e.id = open_questions.entry_id and e.user_id = auth.uid()));

drop policy if exists tasks_owner on tasks;
create policy tasks_owner on tasks
  for all
  using (exists (select 1 from entries e
                 where e.id = tasks.entry_id and e.user_id = auth.uid()))
  with check (exists (select 1 from entries e
                      where e.id = tasks.entry_id and e.user_id = auth.uid()));

drop policy if exists task_dependencies_owner on task_dependencies;
create policy task_dependencies_owner on task_dependencies
  for all
  using (exists (select 1 from entries e
                 where e.id = task_dependencies.entry_id and e.user_id = auth.uid()))
  with check (exists (select 1 from entries e
                      where e.id = task_dependencies.entry_id and e.user_id = auth.uid()));

drop policy if exists schedule_blocks_owner on schedule_blocks;
create policy schedule_blocks_owner on schedule_blocks
  for all
  using (exists (select 1 from entries e
                 where e.id = schedule_blocks.entry_id and e.user_id = auth.uid()))
  with check (exists (select 1 from entries e
                      where e.id = schedule_blocks.entry_id and e.user_id = auth.uid()));

-- ===========================================================================
-- Phase 1 — the strategy layer: a finish line + a time budget, which together
-- feed the completion-probability forecast (see lib/forecast.ts).
-- ===========================================================================

-- A project's deadline is the "race distance" probability is computed against.
alter table projects add column if not exists deadline date;

-- Weekly availability template: baseline deployable hours per weekday
-- (0=Sun .. 6=Sat, matching JS Date.getDay()).
create table if not exists availability (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  hours   numeric(4,2) not null default 0,
  unique (user_id, weekday)
);
create index if not exists availability_user_id_idx on availability(user_id);

-- Per-day overrides: exceptions to the weekly template for a specific date.
create table if not exists availability_overrides (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  date    date not null,
  hours   numeric(4,2) not null default 0,
  unique (user_id, date)
);
create index if not exists availability_overrides_user_idx on availability_overrides(user_id, date);

-- Commitments: logged events ("friends 6-9pm") that consume hours on a date.
create table if not exists commitments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  date       date not null,
  hours      numeric(4,2) not null default 0,
  label      text,
  created_at timestamptz not null default now()
);
create index if not exists commitments_user_idx on commitments(user_id, date);

alter table availability            enable row level security;
alter table availability_overrides  enable row level security;
alter table commitments             enable row level security;

drop policy if exists availability_owner on availability;
create policy availability_owner on availability
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists availability_overrides_owner on availability_overrides;
create policy availability_overrides_owner on availability_overrides
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists commitments_owner on commitments;
create policy commitments_owner on commitments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
