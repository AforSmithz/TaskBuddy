-- Goal spine + definition-of-done + confidence-tagged completion (OVERHAUL §5 step 2).
--
-- Inverts the data spine: the old `projects` table becomes `goals`, tasks gain a
-- direct `goal_id` (the new canonical ownership edge — entries recede to a
-- provenance/source link), goals gain a definition-of-done criteria checklist,
-- and task completion is confidence-tagged.

-- 1. Promote projects → goals. FKs, indexes, and the RLS policy follow the rename.
alter table projects rename to goals;
alter index if exists projects_user_id_idx rename to goals_user_id_idx;
alter policy projects_owner on goals rename to goals_owner;

-- 2. The entry's goal link is now provenance, not the spine — renamed for clarity.
alter table entries rename column project_id to goal_id;
alter index if exists entries_project_id_idx rename to entries_goal_id_idx;

-- 3. Tasks: the new canonical ownership edge + confidence-tagged completion.
alter table tasks
  add column if not exists goal_id               uuid references goals(id) on delete set null,
  add column if not exists completion_confidence text,        -- verified|self_assessed|inferred|in_progress (null while open)
  add column if not exists completed_at          timestamptz; -- set when status → done

create index if not exists tasks_goal_id_idx on tasks(goal_id);

-- Backfill goal_id from the existing entry → goal chain.
update tasks t
   set goal_id = e.goal_id
  from entries e
 where e.id = t.entry_id and t.goal_id is null;

-- 4. Definition of done: a structured criteria checklist per goal. Goal "complete"
--    stays derived in code (criteria non-empty AND all met) — nothing to drift.
create table if not exists goal_criteria (
  id             uuid primary key default gen_random_uuid(),
  goal_id        uuid not null references goals(id) on delete cascade,
  text           text not null,
  met            boolean not null default false,
  met_confidence text,                              -- verified|self_assessed|inferred|in_progress (null until met)
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
