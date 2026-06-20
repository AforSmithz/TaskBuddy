-- Degraded definition-of-done note (OVERHAUL §5 step 5, grounding gate check 2).
-- When a scope-cutting recovery move lowers a goal's ambition (e.g. a reroute to a
-- managed provider that drops SSO), the affected definition-of-done criterion is
-- annotated with how it was degraded instead of silently shrinking — "no silent
-- erosion". Keeps the original criterion `text` intact; the note records the
-- compromise. Null for every criterion that has not been degraded.
alter table goal_criteria add column if not exists degraded_note text; -- how a scope-cut lowered this bar (null = intact)
