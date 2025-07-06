-- TaskBuddy database schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Projects: top-level grouping for meetings and goal plans.
-- ---------------------------------------------------------------------------
create table if not exists projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Meetings: one row per entry (meeting transcript or goal plan), plus its
-- AI-derived planning. `kind` distinguishes the two; `status` gates drafts.
-- ---------------------------------------------------------------------------
create table if not exists meetings (
  id                uuid primary key default gen_random_uuid(),
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
  parent_meeting_id uuid references meetings(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists meetings_project_id_idx on meetings(project_id);

-- For existing databases, add the new columns in place:
alter table meetings
  add column if not exists kind              text not null default 'meeting',
  add column if not exists status            text not null default 'active',
  add column if not exists project_id        uuid references projects(id) on delete set null,
  add column if not exists parent_meeting_id uuid references meetings(id) on delete set null;

-- ---------------------------------------------------------------------------
-- Decisions: choices made in the meeting (kept separate from tasks).
-- ---------------------------------------------------------------------------
create table if not exists decisions (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references meetings(id) on delete cascade,
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
  meeting_id          uuid not null references meetings(id) on delete cascade,
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
  meeting_id        uuid not null references meetings(id) on delete cascade,
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

create index if not exists tasks_meeting_id_idx on tasks(meeting_id);
create index if not exists tasks_status_idx on tasks(status);

-- ---------------------------------------------------------------------------
-- Task dependencies: directed edges (task depends_on another task).
-- ---------------------------------------------------------------------------
create table if not exists task_dependencies (
  id                  uuid primary key default gen_random_uuid(),
  meeting_id          uuid not null references meetings(id) on delete cascade,
  task_id             uuid not null references tasks(id) on delete cascade,
  depends_on_task_id  uuid not null references tasks(id) on delete cascade,
  reason              text,
  unique (task_id, depends_on_task_id)
);

-- ---------------------------------------------------------------------------
-- Schedule blocks: deterministic recommended schedule for a meeting's tasks.
-- ---------------------------------------------------------------------------
create table if not exists schedule_blocks (
  id          uuid primary key default gen_random_uuid(),
  meeting_id  uuid not null references meetings(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,
  label       text not null,
  start_time  text not null,                       -- "09:00"
  end_time    text not null,                       -- "10:30"
  reason      text,
  sort_index  integer default 0
);

create index if not exists schedule_meeting_id_idx on schedule_blocks(meeting_id);
