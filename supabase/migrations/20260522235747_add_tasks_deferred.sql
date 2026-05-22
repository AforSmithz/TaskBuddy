-- Deferrable tasks: a task pushed past the current deadline by a recovery move.
-- Orthogonal to workflow `status` (a task can be in_progress *and* deferred), so
-- it's a boolean flag rather than a new TaskStatus — keeps it off the kanban board.
alter table tasks add column if not exists deferred boolean not null default false;
