-- Parking a skill node: the learning-goal analogue of `tasks.deferred`. A deferred
-- node is NOT attained (you didn't demonstrate it) and NOT part of the current
-- deadline push (it stops consuming forecast budget), but it stays on the goal so
-- the choice is reversible. Set by the `defer_skill` recovery move, cleared by Undo.
alter table skill_nodes
  add column if not exists deferred    boolean     not null default false,
  add column if not exists deferred_at timestamptz;
