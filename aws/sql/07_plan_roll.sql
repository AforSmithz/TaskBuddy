-- Account enumeration for the scheduled daily roll.
--
-- Run as the cluster master, AFTER 01_schema.sql and 02_grants.sql.
--
-- Why this file exists:
--
-- EventBridge Scheduler fires `plan.roll.daily` on a timer with a fixed payload.
-- There is no user on that message and there cannot be one: the schedule is a
-- single cron entry, not one per account. But the work it triggers - rolling the
-- committed plan forward, see lib/rolling.ts - is per-user, so the worker has to
-- turn one timer tick into one message per account.
--
-- That needs a read across tenants, which is the single thing RLS is set up to
-- make impossible. `taskbuddy_app` is `nobypassrls` (02_grants.sql) and the
-- users_self policy is `id = app.uid()`, so the app role selecting from
-- public.users sees exactly one row: its own. For the fan-out it needs all of
-- them.
--
-- The precedent is 03_auth.sql, which had the same shape of problem (the login
-- lookup must run before a session exists) and solved it with a narrow SECURITY
-- DEFINER function rather than by loosening a policy. This is the same move, and
-- a strictly smaller one: app.login_lookup returns password hashes, this returns
-- nothing but uuids.
--
-- What it deliberately does NOT do:
--
--   * return email, full_name, or anything else identifying. A uuid is the
--     entire input the fan-out needs, so the function returns the entire input
--     and nothing more. Widening this later means widening the blast radius of
--     an app-role compromise, so widen the SQL, not the caller.
--   * grant to public. Only taskbuddy_app may execute it.
--   * bypass RLS for the actual work. The ids come back here; every read and
--     write the roll then performs still runs inside runAsUser(uid) with the
--     session GUC set, under the same policies as a browser request.

-- ---------------------------------------------------------------------------
-- The function.
-- ---------------------------------------------------------------------------
-- `stable` (not volatile): it writes nothing, so the planner may inline it.
--
-- Empty search_path so nothing resolves through a schema the app role could
-- influence - with SECURITY DEFINER that is privilege escalation, which is why
-- public.users below is schema-qualified. Same reasoning as 03_auth.sql.
create or replace function app.all_user_ids()
  returns table (id uuid)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select u.id from public.users u order by u.id
$$;

comment on function app.all_user_ids() is
  'Account ids for the scheduled plan roll fan-out. SECURITY DEFINER because the schedule carries no user and users_self would show the app role only its own row. Returns uuids and nothing else.';

-- `create or replace function` leaves the grants on an existing function in place
-- but a first run grants EXECUTE to public by default, so revoke before
-- granting rather than after.
revoke all on function app.all_user_ids() from public;
grant execute on function app.all_user_ids() to taskbuddy_app;

-- ---------------------------------------------------------------------------
-- Verification. Run these after applying; each notes its expected result.
-- ---------------------------------------------------------------------------

-- 1. The function exists, is SECURITY DEFINER (prosecdef = true), and has an
--    empty search_path. Expect exactly 1 row, security_definer = true,
--    settings = {search_path=}.
select p.proname,
       p.prosecdef as security_definer,
       p.proconfig as settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app'
  and p.proname = 'all_user_ids';

-- 2. Only the app role may execute it. Expect app_can_execute = true and
--    public_can_execute = false. The second is the one that matters: a function
--    that enumerates every account must not be callable by PUBLIC.
select has_function_privilege('taskbuddy_app', 'app.all_user_ids()', 'EXECUTE') as app_can_execute,
       has_function_privilege('public',        'app.all_user_ids()', 'EXECUTE') as public_can_execute;

-- 3. The app role still cannot read across tenants by ordinary means - the
--    function is the ONLY path. Expect nobypassrls (rolbypassrls = false) and
--    users RLS still enabled.
select (select rolbypassrls from pg_roles where rolname = 'taskbuddy_app') as app_bypasses_rls,
       (select relrowsecurity from pg_class where oid = 'public.users'::regclass) as users_rls_enabled;
