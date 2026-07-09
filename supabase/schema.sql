-- TaskBuddy database schema
-- Run this in the Supabase SQL editor (Project > SQL Editor > New query).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Goals: the spine of the app. A goal owns its tasks directly (tasks.goal_id)
-- and carries a definition-of-done (goal_criteria) + a deadline. Entries are a
-- provenance/source link, no longer the structural parent of tasks.
-- ---------------------------------------------------------------------------
create table if not exists goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid references auth.users(id) on delete cascade,
  name        text not null,
  description text,
  created_at  timestamptz not null default now()
);

create index if not exists goals_user_id_idx on goals(user_id);

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
  goal_id           uuid references goals(id) on delete set null,
  parent_entry_id   uuid references entries(id) on delete set null,
  created_at        timestamptz not null default now()
);

create index if not exists entries_goal_id_idx on entries(goal_id);
create index if not exists entries_user_id_idx on entries(user_id);

-- For existing databases, add the new columns in place:
alter table entries
  add column if not exists kind            text not null default 'meeting',
  add column if not exists status          text not null default 'active',
  add column if not exists user_id         uuid references auth.users(id) on delete cascade,
  add column if not exists goal_id         uuid references goals(id) on delete set null,
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
  goal_id           uuid references goals(id) on delete set null, -- the canonical owning goal (spine)
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
  deferred          boolean not null default false, -- pushed past the deadline by a recovery move
  completion_confidence text,                       -- verified|self_assessed|inferred|in_progress (null while open)
  completed_at      timestamptz,                    -- set when status → done
  origin            text,                            -- 'debt' for materialized scope-cut follow-ups (null = ordinary task)
  resolved_by       text,                            -- §5.6 6b: how a blocker was resolved ('Used a template'); null = none
  sort_index        integer default 0,
  created_at        timestamptz not null default now()
);

create index if not exists tasks_entry_id_idx on tasks(entry_id);
create index if not exists tasks_goal_id_idx on tasks(goal_id);
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
-- Row Level Security: each user sees only their own data.
--   * goals & entries are owned directly via user_id
--   * child tables (decisions, open_questions, tasks, task_dependencies,
--     goal_criteria) inherit ownership through their parent entry/goal
-- The app connects with the publishable (anon) key carrying the user's
-- session, so these policies — not application code — enforce isolation.
-- (The recommended schedule is derived on read, not stored, so there's no
-- schedule_blocks table.)
-- ---------------------------------------------------------------------------
alter table goals             enable row level security;
alter table entries           enable row level security;
alter table decisions         enable row level security;
alter table open_questions    enable row level security;
alter table tasks             enable row level security;
alter table task_dependencies enable row level security;

drop policy if exists goals_owner on goals;
create policy goals_owner on goals
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

-- ===========================================================================
-- Phase 1 — the strategy layer: a finish line + a time budget, which together
-- feed the completion-probability forecast (see lib/forecast.ts).
-- ===========================================================================

-- A goal's deadline is the "race distance" probability is computed against.
alter table goals add column if not exists deadline date;

-- A goal's kind: 'project' (task DAG + deadline) or 'learning' (skill graph +
-- checkpoints, built later). Existing goals are all deadline/task-shaped.
alter table goals add column if not exists kind text not null default 'project';

-- ---------------------------------------------------------------------------
-- Goal criteria: the definition-of-done checklist for a goal. A goal counts as
-- complete when its criteria are non-empty AND all met (derived in code). Each
-- criterion carries the confidence at which it was marked met.
-- ---------------------------------------------------------------------------
create table if not exists goal_criteria (
  id             uuid primary key default gen_random_uuid(),
  goal_id        uuid not null references goals(id) on delete cascade,
  text           text not null,
  met            boolean not null default false,
  met_confidence text,                              -- verified|self_assessed|inferred|in_progress (null until met)
  degraded_note  text,                              -- how a scope-cut lowered this bar (null = intact); §5 gate check 2
  sort_index     integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists goal_criteria_goal_id_idx on goal_criteria(goal_id);

alter table goal_criteria enable row level security;
drop policy if exists goal_criteria_owner on goal_criteria;
create policy goal_criteria_owner on goal_criteria
  for all
  using (exists (select 1 from goals g
                 where g.id = goal_criteria.goal_id and g.user_id = auth.uid()))
  with check (exists (select 1 from goals g
                      where g.id = goal_criteria.goal_id and g.user_id = auth.uid()));

-- Skill graph for learning goals (the decomposer / §5.3b data model). A learning
-- goal decomposes into a prerequisite DAG of capabilities; `prerequisites` holds
-- the ids that must be attained first; `is_checkpoint` marks a verifiable
-- milestone (checkpoints drive skill-progress, all nodes' effort drives
-- effort-progress). Attainment is confidence-tagged like task completion.
create table if not exists skill_nodes (
  id                  uuid primary key default gen_random_uuid(),
  goal_id             uuid not null references goals(id) on delete cascade,
  title               text not null,
  description         text,
  prerequisites       jsonb not null default '[]'::jsonb,
  is_checkpoint       boolean not null default false,
  estimated_minutes   integer not null default 60,
  attained            boolean not null default false,
  attained_confidence text,
  attained_at         timestamptz,
  sort_index          integer not null default 0,
  created_at          timestamptz not null default now()
);

create index if not exists skill_nodes_goal_id_idx on skill_nodes(goal_id);

alter table skill_nodes enable row level security;
drop policy if exists skill_nodes_owner on skill_nodes;
create policy skill_nodes_owner on skill_nodes
  for all
  using (exists (select 1 from goals g
                 where g.id = skill_nodes.goal_id and g.user_id = auth.uid()))
  with check (exists (select 1 from goals g
                      where g.id = skill_nodes.goal_id and g.user_id = auth.uid()));

-- Skill-node <-> task links: the explicit "these two are the same work" edge that
-- spillover reads. Title similarity cannot find these pairs (a skill node is phrased
-- as a capability, a task as an action), so the edge is LLM-proposed and user-confirmed.
-- Only `confirmed` rows drive a spillover move; `dismissed` rows suppress re-suggestion.
create table if not exists skill_task_links (
  id            uuid primary key default gen_random_uuid(),
  skill_node_id uuid not null references skill_nodes(id) on delete cascade,
  task_id       uuid not null references tasks(id) on delete cascade,
  status        text not null default 'suggested',  -- suggested | confirmed | dismissed
  rationale     text,                               -- the model's one-line why, shown verbatim
  created_at    timestamptz not null default now(),
  unique (skill_node_id, task_id)
);

create index if not exists skill_task_links_node_idx on skill_task_links(skill_node_id);
create index if not exists skill_task_links_task_idx on skill_task_links(task_id);

-- Ownership is checked on BOTH sides: the node (via goals) and the task (via entries),
-- so a link can never straddle two users' rows.
alter table skill_task_links enable row level security;
drop policy if exists skill_task_links_owner on skill_task_links;
create policy skill_task_links_owner on skill_task_links
  for all
  using (exists (select 1 from skill_nodes s join goals g on g.id = s.goal_id
                 where s.id = skill_task_links.skill_node_id and g.user_id = auth.uid())
     and exists (select 1 from tasks t join entries e on e.id = t.entry_id
                 where t.id = skill_task_links.task_id and e.user_id = auth.uid()))
  with check (exists (select 1 from skill_nodes s join goals g on g.id = s.goal_id
                      where s.id = skill_task_links.skill_node_id and g.user_id = auth.uid())
          and exists (select 1 from tasks t join entries e on e.id = t.entry_id
                      where t.id = skill_task_links.task_id and e.user_id = auth.uid()));

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

-- ===========================================================================
-- Phase 3 — the pit-wall strategist: per-user automation preferences.
-- ===========================================================================

-- `auto_strategy` on = auto-apply the obvious low-value triage and escalate only
-- genuine ties; off (default) = surface every option, never auto-apply.
create table if not exists user_settings (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  auto_strategy boolean not null default false,
  updated_at    timestamptz not null default now()
);

alter table user_settings enable row level security;

drop policy if exists user_settings_owner on user_settings;
create policy user_settings_owner on user_settings
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===========================================================================
-- Phase 4 — the portfolio strategist: one cached, time-aware recommendation.
-- ===========================================================================

-- Caches the synthesized portfolio strategy per user so it only regenerates when
-- the situation changes (fingerprint mismatch) or the user explicitly asks.
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

-- ===========================================================================
-- Phase 5 — whole-life sources: recurring activities (routines & goals) that
-- share the same daily hour pool as projects. Routines are daily/streak-based
-- (period='day'); goals are a weekly session target (period='week'). Errands
-- are NOT modelled here — they are plain one-off tasks under a reserved,
-- deadline-less "Errands" project, so they reuse the tasks table as-is.
-- ===========================================================================

create table if not exists recurring_activities (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  title             text not null,
  area              text not null default 'Personal',
  period            text not null default 'day',   -- day | week
  target_count      integer not null default 1,
  weekdays          jsonb,                          -- int[] (0=Sun..6=Sat) or null
  estimated_minutes integer not null default 30,
  -- 1-5 factor ratings (same scale as tasks); score the synthetic queue instance.
  urgency           integer not null default 3,
  impact            integer not null default 3,
  effort            integer not null default 3,
  dependency        integer not null default 3,
  risk              integer not null default 3,
  confidence        integer not null default 3,
  protected         boolean not null default false,
  active            boolean not null default true,
  created_at        timestamptz not null default now()
);
create index if not exists recurring_activities_user_idx on recurring_activities(user_id);

-- One logged session (or skip) of a recurring activity. A skip resolves the
-- period's obligation without counting toward a streak. Streak/progress are
-- derived from these rows on read.
create table if not exists activity_completions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  activity_id  uuid not null references recurring_activities(id) on delete cascade,
  date         date not null,
  minutes      integer not null default 0,
  skipped      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists activity_completions_activity_idx
  on activity_completions(activity_id, date);

alter table recurring_activities  enable row level security;
alter table activity_completions  enable row level security;

drop policy if exists recurring_activities_owner on recurring_activities;
create policy recurring_activities_owner on recurring_activities
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists activity_completions_owner on activity_completions;
create policy activity_completions_owner on activity_completions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- One real work session (OVERHAUL S2 slice B): how long you actually sat down +
-- the LOCAL time-of-day window/weekday you worked in, captured at write time so we
-- never re-derive a local window from the UTC `tasks.completed_at` instant. The
-- when-signal the velocity loop's energy-windows + adherence (slice C) read. A
-- session is task effort XOR a routine session. Pure accrual — no behaviour change.
create table if not exists work_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  task_id     uuid references tasks(id) on delete cascade,
  activity_id uuid references recurring_activities(id) on delete cascade,
  logged_for  date not null,
  time_window text not null check (time_window in    -- "window" is a reserved word
                ('early','morning','afternoon','evening','night')),
  weekday     integer not null check (weekday between 0 and 6),
  minutes     integer not null default 0 check (minutes >= 0),
  kind        text not null check (kind in ('progress','complete')),
  created_at  timestamptz not null default now(),
  constraint work_sessions_one_source check ((task_id is not null) <> (activity_id is not null))
);
create index if not exists work_sessions_user_logged_idx
  on work_sessions (user_id, logged_for);

alter table work_sessions enable row level security;
drop policy if exists work_sessions_owner on work_sessions;
create policy work_sessions_owner on work_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ===========================================================================
-- S3b Phase 4 — explicit per-window availability (an optional override of the
-- work_sessions-derived window share; OVERHAUL §5a). One row per user.
-- ===========================================================================
create table if not exists window_availability (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  weights    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table window_availability enable row level security;
drop policy if exists window_availability_owner on window_availability;
create policy window_availability_owner on window_availability
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Offered-vs-kept move slates — the revealed preference `kept ≻ declined` that
-- calibrates the STYLE/CAUSE tiebreak weights. Sibling to plan_reorders; written only
-- by the strategist card's whole-slate Apply. See the migration for the full rationale.
create table if not exists move_choices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  captured_at    timestamptz not null default now(),
  recovery_style text not null,
  offered        jsonb not null,
  schema_version integer not null
);

create index if not exists move_choices_user_captured_idx
  on move_choices (user_id, captured_at desc);

alter table move_choices enable row level security;
drop policy if exists move_choices_owner on move_choices;
create policy move_choices_owner on move_choices
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
