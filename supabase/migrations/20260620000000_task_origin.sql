-- Debt-task provenance (OVERHAUL §5 step 5, grounding gate check 4).
-- When a scope-cutting recovery move trims work to hit a deadline, the cut work
-- is materialized as a real, deferred follow-up task instead of silently
-- vanishing — "the cost is owed, not erased". `origin` marks where such a task
-- came from (currently only 'debt') so the agenda/forecast/UI can style it and
-- so it's cleanly queryable. Null for every ordinary task.
alter table tasks add column if not exists origin text; -- e.g. 'debt' (null = ordinary task)
