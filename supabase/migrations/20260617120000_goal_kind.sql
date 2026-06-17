-- Goal.kind: re-introduce "project" as a first-class *type* under Goals.
-- A 'project' goal carries a task DAG + a deadline; a 'learning' goal will carry
-- a skill graph + checkpoints (built later, with the decomposer). Every existing
-- goal is deadline/task-shaped, so 'project' is the right backfill default.
alter table goals add column if not exists kind text not null default 'project';
