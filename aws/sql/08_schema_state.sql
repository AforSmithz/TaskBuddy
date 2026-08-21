-- What the pipeline reads to decide whether the schema matches the code.
--
-- Run as the cluster master, AFTER 01_schema.sql and 02_grants.sql.
--
-- Why this file exists:
--
-- The schema is applied by a human running apply-sql.sh; the code is deployed by
-- GitHub Actions. Those are two separate acts on two separate schedules, and
-- until this table existed nothing could tell whether they agreed. The failure
-- that motivated it: `07_plan_roll.sql` adds a function the worker calls, so
-- shipping the worker without applying the SQL means every daily roll fails with
-- `function app.all_user_ids() does not exist` - and nothing in CI, in the
-- alarms, or in the deploy output would have said so.
--
-- Deliberately NOT an auto-applier. Everything in aws/sql defines the security
-- boundary itself - app.uid(), the RLS policies, the SECURITY DEFINER functions -
-- so whatever can apply these files can rewrite the answer to "which user is
-- this?" and read every account's data. Handing that to CI would be a much
-- larger change than the one it prevents. This table is the other half of the
-- trade: the pipeline gets to VERIFY, and never to APPLY. See aws/SPEC.md.
--
-- The design is Flyway's checksum idea and nothing else from Flyway: one row per
-- applied file, carrying the sha256 of its contents. apply-sql.sh writes the
-- rows after a successful run; aws/scripts/check-schema.sh recomputes the hashes
-- from the repo and fails the deploy on any mismatch.

-- ---------------------------------------------------------------------------
-- The table.
-- ---------------------------------------------------------------------------
-- In `app`, not `public`: it holds no user data and must not be swept up by the
-- blanket grants or the RLS conventions that govern application tables. The
-- verification queries in 02_grants.sql only look at `public` for exactly that
-- reason, so this does not become a table-without-RLS finding.
create table if not exists app.schema_applied (
  filename   text primary key,
  sha256     text not null,
  applied_at timestamptz not null default now(),
  -- Who ran it. Not decorative: when the gate trips, the first question is
  -- always "did someone apply this from a laptop that has since gone stale?"
  applied_by text not null default current_user,
  constraint schema_applied_sha256_shape check (sha256 ~ '^[0-9a-f]{64}$')
);

comment on table app.schema_applied is
  'One row per aws/sql file applied by apply-sql.sh, with the sha256 of its contents. Read by aws/scripts/check-schema.sh to fail a deploy whose code expects a schema the cluster does not have.';

-- ---------------------------------------------------------------------------
-- Grants.
-- ---------------------------------------------------------------------------
-- SELECT only, and only to the app role. The pipeline reads this table as
-- taskbuddy_app over an IAM token, which is the whole point of the design: CI
-- never holds a credential that can change anything. Writing is the master's
-- job, because writing is what apply-sql.sh does.
revoke all on app.schema_applied from public;
grant select on app.schema_applied to taskbuddy_app;

-- No RLS. There is no user data here and no app.uid() to scope it by - the
-- pipeline reads this with no session at all, which every ordinary policy would
-- (correctly) deny. Stated so the absence reads as a decision.

-- ---------------------------------------------------------------------------
-- Verification. Run these after applying; each notes its expected result.
-- ---------------------------------------------------------------------------

-- 1. The app role can read it and cannot write it. Expect can_read = true and
--    the three write columns all false.
select has_table_privilege('taskbuddy_app', 'app.schema_applied', 'SELECT') as can_read,
       has_table_privilege('taskbuddy_app', 'app.schema_applied', 'INSERT') as can_insert,
       has_table_privilege('taskbuddy_app', 'app.schema_applied', 'UPDATE') as can_update,
       has_table_privilege('taskbuddy_app', 'app.schema_applied', 'DELETE') as can_delete;

-- 2. PUBLIC holds nothing on it. Expect false.
select has_table_privilege('public', 'app.schema_applied', 'SELECT') as public_can_read;
