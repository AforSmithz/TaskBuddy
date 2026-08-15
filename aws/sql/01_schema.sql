-- TaskBuddy schema for Amazon Aurora PostgreSQL (Serverless v2).
--
-- Carried over from azure/sql/01_schema.sql with NO table changes. Every table,
-- index, constraint and policy below is byte-for-byte what the Azure server
-- ran, because the whole point of choosing Aurora over DynamoDB was that this
-- file does not have to be rewritten.
--
-- Two things about the identity model are worth stating up front, because they
-- are what let the rest stay untouched:
--
--   1. `users.id` is still the uuid every foreign key and every policy resolves
--      through. Cognito mints its own `sub` and offers no way to choose it, so
--      the Cognito subject is deliberately NOT the app's user id. The Postgres
--      id travels in the ID token as `custom:app_uid` instead.
--   2. `app.uid()` still reads a transaction-local GUC. What changed is only
--      where the app got the value: a self-signed JWT before, a Cognito ID
--      token now. Nothing in this file can tell the difference, which is the
--      property that made the auth migration survivable.
--
-- Run order:  01_schema.sql -> 02_grants.sql -> 03_auth.sql -> 04_cognito.sql
-- Connect as the cluster master (aws/scripts/apply-sql.sh does).
--
-- 03 MUST be re-run after any re-run of 02. 02 issues a blanket table-level
-- grant that re-grants SELECT/UPDATE on users.password_hash, which is exactly
-- what 03 exists to take away. Re-running 02 alone silently undoes it.

-- gen_random_uuid() is core since PG13, so pgcrypto is not strictly required.
-- Kept for parity with the Supabase schema; harmless if the extension is not
-- on the Aurora shared_preload/extension allowlist, since nothing below depends on it.
do $$
begin
  create extension if not exists "pgcrypto";
exception when others then
  raise notice 'pgcrypto unavailable (fine: gen_random_uuid is built in on PG13+)';
end
$$;

-- ===========================================================================
-- 00 — Identity. Replaces Supabase's `auth.users`.
-- ===========================================================================
--
-- One row per person. Email is the login key and `password_hash` is a bcrypt
-- modular-crypt string (60 chars, `$2a$`), verified in Node — never in the DB.
-- The two accounts carried over from Supabase keep their existing hashes, so
-- both keep their existing passwords.
--
-- `id` stays a uuid so every existing `user_id` column, foreign key, index and
-- policy keeps working unchanged, and so the two Supabase user ids can carry
-- straight across (no row data is migrated, but the identities are).
create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  password_hash text not null,
  full_name     text,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);

-- Unique on lower(email), not `citext`: a functional index needs no extension,
-- and citext may not be on the Aurora shared_preload/extension allowlist. The app normalises
-- with trim().toLowerCase() before both lookup and insert.
create unique index if not exists users_email_lower_key on users (lower(email));

-- ---------------------------------------------------------------------------
-- app.uid() — the RLS anchor.
--
-- Supabase derived the current user from a verified JWT inside PostgREST. We
-- have no PostgREST, so the app sets `app.user_id` with `set_config(..., true)`
-- (transaction-local) immediately after BEGIN, on the same connection, before
-- any statement runs. See lib/db/pool.ts.
--
-- `current_setting(..., true)` returns NULL rather than erroring when the GUC
-- was never set, and `nullif` maps the empty string to NULL as well. Both
-- matter: an unset user id yields NULL, `user_id = NULL` is never true, and
-- every policy therefore denies. Failing closed is the whole point — a bug in
-- the app layer must lose data access, not leak it.
-- ---------------------------------------------------------------------------
create schema if not exists app;

create or replace function app.uid() returns uuid
  language sql
  stable
  -- Empty search_path: this function must not resolve anything it does not
  -- fully qualify, so a rogue schema earlier on the path cannot shadow it.
  set search_path = ''
as $$
  select nullif(current_setting('app.user_id', true), '')::uuid
$$;

comment on function app.uid() is
  'Current user id for RLS, from the transaction-local app.user_id GUC. NULL when unset, which denies every policy.';

-- ===========================================================================
-- Goals: the spine of the app. A goal owns its tasks directly (tasks.goal_id)
-- and carries a definition-of-done (goal_criteria) + a deadline. Entries are a
-- provenance/source link, no longer the structural parent of tasks.
-- ===========================================================================
-- user_id is NOT NULL here, unlike live Supabase where it was added by a later
-- `alter table ... add column` and so could not be constrained on a populated
-- table. A NULL owner never matches the ownership test in any policy, so such
-- a row is unreadable and undeletable by anyone, forever, and it orphans its
-- whole subtree of tasks/criteria. Starting empty is the free moment to close
-- that; every write path in lib/store.ts already sets user_id.
create table if not exists goals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  description text,
  deadline    date,
  kind        text not null default 'project',   -- project | learning
  created_at  timestamptz not null default now()
);

create index if not exists goals_user_id_idx on goals(user_id);

-- ---------------------------------------------------------------------------
-- Entries: one row per entry (meeting transcript or goal plan), plus its
-- AI-derived planning. `kind` distinguishes the two; `status` gates drafts.
-- ---------------------------------------------------------------------------
-- NOT NULL for the same reason as goals.user_id above.
create table if not exists entries (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
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

-- This table has no user_id; decisions_owner scopes it with an EXISTS subquery
-- through entry_id. That subquery runs on EVERY access, not just on explicit
-- joins, so the FK needs its own index or the policy costs a sequential scan
-- each time. Storage here is P4 at 120 IOPS, which punishes scans out of
-- proportion to table size.
create index if not exists decisions_entry_id_idx on decisions(entry_id);

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

-- Same reason as decisions_entry_id_idx: open_questions_owner is an EXISTS
-- policy through entry_id.
create index if not exists open_questions_entry_id_idx on open_questions(entry_id);

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
  completed_at      timestamptz,                    -- set when status -> done
  origin            text,                           -- 'debt' for materialized scope-cut follow-ups (null = ordinary task)
  resolved_by       text,                           -- 5.6 6b: how a blocker was resolved ('Used a template'); null = none
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

-- The unique constraint above already indexes task_id, but only as the LEADING
-- column, so it does nothing for the reverse-edge lookup ("what depends on this
-- task?") that dependency-graph walks and cascade deletes both perform. entry_id
-- gets its own index for the same EXISTS-policy reason as the two above.
create index if not exists task_dependencies_entry_id_idx
  on task_dependencies(entry_id);
create index if not exists task_dependencies_depends_on_idx
  on task_dependencies(depends_on_task_id);

-- ---------------------------------------------------------------------------
-- Goal criteria: the definition-of-done checklist for a goal.
-- ---------------------------------------------------------------------------
create table if not exists goal_criteria (
  id             uuid primary key default gen_random_uuid(),
  goal_id        uuid not null references goals(id) on delete cascade,
  text           text not null,
  met            boolean not null default false,
  met_confidence text,                              -- verified|self_assessed|inferred|in_progress (null until met)
  degraded_note  text,                              -- how a scope-cut lowered this bar (null = intact)
  sort_index     integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists goal_criteria_goal_id_idx on goal_criteria(goal_id);

-- ---------------------------------------------------------------------------
-- Skill graph for learning goals (the decomposer / 5.3b data model).
-- ---------------------------------------------------------------------------
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
  deferred            boolean not null default false,
  deferred_at         timestamptz,
  sort_index          integer not null default 0,
  created_at          timestamptz not null default now()
);

create index if not exists skill_nodes_goal_id_idx on skill_nodes(goal_id);

-- ---------------------------------------------------------------------------
-- Skill-node <-> task links: the explicit "these two are the same work" edge
-- that spillover reads.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- Availability: weekly template, per-day overrides, and logged commitments.
-- ---------------------------------------------------------------------------
create table if not exists availability (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  hours   numeric(4,2) not null default 0,
  unique (user_id, weekday)
);
create index if not exists availability_user_id_idx on availability(user_id);

create table if not exists availability_overrides (
  id      uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  date    date not null,
  hours   numeric(4,2) not null default 0,
  unique (user_id, date)
);
create index if not exists availability_overrides_user_idx on availability_overrides(user_id, date);

create table if not exists commitments (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  date       date not null,
  hours      numeric(4,2) not null default 0,
  label      text,
  created_at timestamptz not null default now()
);
create index if not exists commitments_user_idx on commitments(user_id, date);

-- ---------------------------------------------------------------------------
-- Per-user automation preferences and cached strategy.
-- ---------------------------------------------------------------------------
create table if not exists user_settings (
  user_id       uuid primary key references users(id) on delete cascade,
  auto_strategy boolean not null default false,
  updated_at    timestamptz not null default now()
);

create table if not exists portfolio_strategy (
  user_id     uuid primary key references users(id) on delete cascade,
  fingerprint text not null,
  strategy    jsonb not null,
  updated_at  timestamptz not null default now()
);

-- The user's value model: importance weights + recovery style.
--
-- NOTE: this table exists in the live Supabase database but was never captured
-- in supabase/schema.sql or any migration — it was applied by hand in the SQL
-- editor. It is reconstructed here from its only two call sites in
-- lib/store.ts (getValueModel / setValueModel), which read `model` and upsert
-- `{user_id, model, updated_at}` on conflict of user_id. Verified against the
-- live Supabase table on 2026-08-15: this reconstruction is exact.
create table if not exists value_model (
  user_id    uuid primary key references users(id) on delete cascade,
  model      jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Whole-life sources: recurring activities (routines & goals) sharing the same
-- daily hour pool as projects.
-- ---------------------------------------------------------------------------
create table if not exists recurring_activities (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(id) on delete cascade,
  title             text not null,
  area              text not null default 'Personal',
  period            text not null default 'day',   -- day | week
  target_count      integer not null default 1,
  weekdays          jsonb,                          -- int[] (0=Sun..6=Sat) or null
  estimated_minutes integer not null default 30,
  -- 1-5 factor ratings (same scale as tasks)
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

create table if not exists activity_completions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users(id) on delete cascade,
  activity_id  uuid not null references recurring_activities(id) on delete cascade,
  date         date not null,
  minutes      integer not null default 0,
  skipped      boolean not null default false,
  created_at   timestamptz not null default now()
);
create index if not exists activity_completions_activity_idx
  on activity_completions(activity_id, date);

-- ---------------------------------------------------------------------------
-- Work sessions: the local when-signal the velocity loop reads.
-- ---------------------------------------------------------------------------
create table if not exists work_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
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

-- ---------------------------------------------------------------------------
-- Explicit per-window availability (optional override of the
-- work_sessions-derived window share).
-- ---------------------------------------------------------------------------
create table if not exists window_availability (
  user_id    uuid primary key references users(id) on delete cascade,
  weights    jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Plan history: versions (undoable move bundles), the committed rolling plan,
-- rolls, reorders, and offered-vs-kept move slates.
-- ---------------------------------------------------------------------------
create table if not exists plan_versions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  reverted_at timestamptz,                          -- set when undone (null while it stands)
  reason      text not null,                        -- synthesis assessment, or "Applied N moves"
  odds_before double precision not null,            -- portfolio odds before the bundle
  odds_after  double precision not null,            -- the previewed number the user accepted
  moves       jsonb not null,                       -- StrategyMove[] - the committed bundle
  restore     jsonb not null                        -- RowSnapshot - prior values + inserted ids
);
create index if not exists plan_versions_user_created_idx
  on plan_versions (user_id, created_at desc);

create table if not exists committed_plan (
  user_id     uuid primary key references users(id) on delete cascade,
  plan        jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists plan_rolls (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  rolled_at      timestamptz not null default now(),  -- when the roll fired
  anchor         date not null,                        -- CommittedPlan.anchor at roll time
  fingerprint    text not null,                        -- CommittedPlan.fingerprint at roll time
  j              double precision not null,            -- committed arrangement soft score
  kind           text not null,                        -- 'material' | 'anchor' | 'initial'
  prev_j         double precision,                     -- superseded arrangement's j; null for 'initial'
  plan_order     jsonb not null,                       -- CommittedPlan.order - the replay basis
  reverted_at    timestamptz,                          -- set when this roll is undone
  schema_version integer not null                      -- COMMITTED_PLAN_SCHEMA_VERSION
);
create index if not exists plan_rolls_user_rolled_idx
  on plan_rolls (user_id, rolled_at desc);

create table if not exists plan_reorders (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  captured_at    timestamptz not null default now(),   -- when the drag was captured
  date           date not null,                         -- the plan day the reorder applies to
  app_order      jsonb not null,                        -- the solver's order a*
  user_order     jsonb not null,                        -- the user's dragged order
  schema_version integer not null                       -- COMMITTED_PLAN_SCHEMA_VERSION
);
create index if not exists plan_reorders_user_captured_idx
  on plan_reorders (user_id, captured_at desc);

create table if not exists move_choices (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  captured_at    timestamptz not null default now(),
  recovery_style text not null,
  offered        jsonb not null,
  schema_version integer not null
);
create index if not exists move_choices_user_captured_idx
  on move_choices (user_id, captured_at desc);

-- ===========================================================================
-- Row Level Security.
--
-- Identical in shape to the Supabase policies, with auth.uid() -> app.uid():
--   * goals & entries are owned directly via user_id
--   * child tables inherit ownership through their parent entry/goal
--
-- Two differences from Supabase, both load-bearing:
--
--   `force row level security` — on Supabase the app connected as a role that
--   never owned these tables, so RLS always applied. Here the tables are owned
--   by the server admin, and a table owner is exempt from its own RLS unless
--   forced. Without FORCE, one accidental connection as the admin returns
--   every user's rows with no error and no log line. FORCE closes that.
--
--   `users` is readable only as yourself. Nothing in the app lists users, so
--   the policy is a plain identity check rather than a join.
--
-- OPERATOR NOTE — FORCE applies to the table owner too. An admin maintenance
-- statement (a backfill, a manual fix) will match ZERO rows unless you first
-- run, in the same transaction:
--     select set_config('app.user_id', '<the user uuid>', true);
-- or temporarily `alter table <t> no force row level security` and re-force
-- after. The failure mode is silence, not an error. Always check the row count.
--
-- Every ownership test below is written `= (select app.uid())`, not
-- `= app.uid()`. app.uid() carries `set search_path = ''`, and PostgreSQL will
-- not inline a SQL function that has a SET clause — so the bare call is
-- re-evaluated PER ROW, on every policy, on a 1-vCore server. Wrapping it in a
-- scalar subquery makes it an InitPlan the planner runs once per statement.
-- Semantics are identical because app.uid() is STABLE. Verified with EXPLAIN:
-- the plan shows `InitPlan 1 (returns $0)` and `Filter: (user_id = $0)`.
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array[
    'goals', 'entries', 'decisions', 'open_questions', 'tasks',
    'task_dependencies', 'goal_criteria', 'skill_nodes', 'skill_task_links',
    'availability', 'availability_overrides', 'commitments', 'user_settings',
    'portfolio_strategy', 'value_model', 'recurring_activities',
    'activity_completions', 'work_sessions', 'window_availability',
    'plan_versions', 'committed_plan', 'plan_rolls', 'plan_reorders',
    'move_choices'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force  row level security', t);
  end loop;
end
$$;

-- `users` is ENABLE-but-not-FORCE, and that asymmetry is deliberate.
--
-- Login has a chicken-and-egg problem: the credential lookup must run BEFORE
-- app.user_id is set, because setting it is what logging in produces. Under
-- `users_self` an unset GUC denies, so the lookup goes through the SECURITY
-- DEFINER function app.login_lookup() in 03_auth.sql, which runs as the table
-- owner. FORCE would subject the owner to RLS as well and deny that function
-- too, making login structurally impossible.
--
-- This costs nothing: `taskbuddy_app` does not own `users`, so it is still
-- fully constrained by users_self and can never read another account's row.
-- Only the owner-defined auth functions see past the policy, which is exactly
-- the one path that has to.
alter table users enable row level security;

-- --- Identity ---------------------------------------------------------------
drop policy if exists users_self on users;
create policy users_self on users
  for all
  using (id = (select app.uid()))
  with check (id = (select app.uid()));

-- --- Directly owned ---------------------------------------------------------
drop policy if exists goals_owner on goals;
create policy goals_owner on goals
  for all
  using (user_id = (select app.uid()))
  with check (user_id = (select app.uid()));

drop policy if exists entries_owner on entries;
create policy entries_owner on entries
  for all
  using (user_id = (select app.uid()))
  with check (user_id = (select app.uid()));

-- --- Owned through the parent entry -----------------------------------------
drop policy if exists decisions_owner on decisions;
create policy decisions_owner on decisions
  for all
  using (exists (select 1 from entries e
                 where e.id = decisions.entry_id and e.user_id = (select app.uid())))
  with check (exists (select 1 from entries e
                      where e.id = decisions.entry_id and e.user_id = (select app.uid())));

drop policy if exists open_questions_owner on open_questions;
create policy open_questions_owner on open_questions
  for all
  using (exists (select 1 from entries e
                 where e.id = open_questions.entry_id and e.user_id = (select app.uid())))
  with check (exists (select 1 from entries e
                      where e.id = open_questions.entry_id and e.user_id = (select app.uid())));

drop policy if exists tasks_owner on tasks;
create policy tasks_owner on tasks
  for all
  using (exists (select 1 from entries e
                 where e.id = tasks.entry_id and e.user_id = (select app.uid())))
  with check (exists (select 1 from entries e
                      where e.id = tasks.entry_id and e.user_id = (select app.uid())));

drop policy if exists task_dependencies_owner on task_dependencies;
create policy task_dependencies_owner on task_dependencies
  for all
  using (exists (select 1 from entries e
                 where e.id = task_dependencies.entry_id and e.user_id = (select app.uid())))
  with check (exists (select 1 from entries e
                      where e.id = task_dependencies.entry_id and e.user_id = (select app.uid())));

-- --- Owned through the parent goal ------------------------------------------
drop policy if exists goal_criteria_owner on goal_criteria;
create policy goal_criteria_owner on goal_criteria
  for all
  using (exists (select 1 from goals g
                 where g.id = goal_criteria.goal_id and g.user_id = (select app.uid())))
  with check (exists (select 1 from goals g
                      where g.id = goal_criteria.goal_id and g.user_id = (select app.uid())));

drop policy if exists skill_nodes_owner on skill_nodes;
create policy skill_nodes_owner on skill_nodes
  for all
  using (exists (select 1 from goals g
                 where g.id = skill_nodes.goal_id and g.user_id = (select app.uid())))
  with check (exists (select 1 from goals g
                      where g.id = skill_nodes.goal_id and g.user_id = (select app.uid())));

-- Ownership is checked on BOTH sides: the node (via goals) and the task (via
-- entries), so a link can never straddle two users' rows.
drop policy if exists skill_task_links_owner on skill_task_links;
create policy skill_task_links_owner on skill_task_links
  for all
  using (exists (select 1 from skill_nodes s join goals g on g.id = s.goal_id
                 where s.id = skill_task_links.skill_node_id and g.user_id = (select app.uid()))
     and exists (select 1 from tasks t join entries e on e.id = t.entry_id
                 where t.id = skill_task_links.task_id and e.user_id = (select app.uid())))
  with check (exists (select 1 from skill_nodes s join goals g on g.id = s.goal_id
                      where s.id = skill_task_links.skill_node_id and g.user_id = (select app.uid()))
          and exists (select 1 from tasks t join entries e on e.id = t.entry_id
                      where t.id = skill_task_links.task_id and e.user_id = (select app.uid())));

-- --- The remaining directly-owned tables ------------------------------------
-- All share the same `user_id = (select app.uid())` shape, so they are generated rather
-- than spelled out 15 times.
do $$
declare
  t text;
begin
  foreach t in array array[
    'availability', 'availability_overrides', 'commitments', 'user_settings',
    'portfolio_strategy', 'value_model', 'recurring_activities',
    'activity_completions', 'work_sessions', 'window_availability',
    'plan_versions', 'committed_plan', 'plan_rolls', 'plan_reorders',
    'move_choices'
  ]
  loop
    execute format('drop policy if exists %I on %I', t || '_owner', t);
    execute format(
      'create policy %I on %I for all using (user_id = (select app.uid())) with check (user_id = (select app.uid()))',
      t || '_owner', t
    );
  end loop;
end
$$;
