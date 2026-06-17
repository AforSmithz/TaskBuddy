-- Skill graph for learning goals (the §5.4 decomposer, §5.3b data model).
-- A learning goal decomposes into a prerequisite graph of capabilities. Each
-- node is a skill to attain; `prerequisites` holds the ids of nodes that must be
-- attained first (a DAG, stored inline like tasks.depends_on). `is_checkpoint`
-- marks a verifiable milestone — checkpoints drive *skill* progress, while every
-- node's effort drives *effort* progress (the two can diverge). Attainment is
-- confidence-tagged exactly like task completion (self_assessed/inferred/verified).
create table if not exists skill_nodes (
  id                  uuid primary key default gen_random_uuid(),
  goal_id             uuid not null references goals(id) on delete cascade,
  title               text not null,
  description         text,
  prerequisites       jsonb not null default '[]'::jsonb,  -- uuid[] of prerequisite skill_nodes
  is_checkpoint       boolean not null default false,
  estimated_minutes   integer not null default 60,
  attained            boolean not null default false,
  attained_confidence text,                                -- self_assessed|inferred|verified (null until attained)
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
