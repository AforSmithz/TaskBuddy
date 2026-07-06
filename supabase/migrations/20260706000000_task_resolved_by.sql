-- Blocker-resolution provenance (OVERHAUL §5.6 slice 6b, cascade-with-provenance).
-- When a check-in reports resolving a blocker (a task others depend on), the
-- cascade marks it done, frees its direct dependents, and records HOW it was
-- resolved here ("Used a template"). Display/audit provenance only — never a
-- number or an id (§0-safe). Null for an ordinary task or a plain resolution
-- with no stated method.
alter table tasks add column if not exists resolved_by text; -- e.g. 'Used a template' (null = none)
