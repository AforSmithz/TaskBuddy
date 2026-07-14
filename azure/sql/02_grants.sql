-- Application role for TaskBuddy on Azure Database for PostgreSQL.
--
-- Run as the server admin, AFTER 01_schema.sql.
--
-- IF YOU RE-RUN THIS FILE, RE-RUN 03_auth.sql AFTERWARDS. The blanket
-- `grant select, insert, update, delete on all tables` below re-grants
-- SELECT/UPDATE on users.password_hash, which 03_auth.sql exists to revoke.
-- Nothing errors; the hardening just quietly disappears.
--
-- Why a separate role at all, when 01_schema.sql already FORCEs RLS?
--
-- Because the two defend different mistakes. FORCE stops the *owner* from
-- bypassing its own policies. This role stops the app from ever holding rights
-- it should not have in the first place: no DDL, no ownership, no superuser,
-- no ability to disable RLS or drop a policy. If the app is compromised, the
-- blast radius is "read/write rows the policies allow", not "drop the schema".
--
-- On Supabase this came for free — the anon/authenticated roles were built
-- that way. Off Supabase it has to be spelled out, and forgetting it is the
-- single most common way a migration like this silently loses its isolation.
--
-- Set the password before running:
--   \set app_password 'the-generated-password'
-- or replace :'app_password' inline. Use a generated value: it is the
-- credential the Next.js app on Vercel connects with, stored as DATABASE_URL
-- in the Vercel project's environment variables. Not Key Vault — reading a
-- secret from Key Vault needs an Azure credential, which would itself have to
-- live in a Vercel env var, so it only moves the problem.

-- ---------------------------------------------------------------------------
-- The role.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'taskbuddy_app') then
    create role taskbuddy_app login;
  end if;
end
$$;

alter role taskbuddy_app with password :'app_password';

-- Explicitly deny the things this role must never have. `nobypassrls` is the
-- important one: a BYPASSRLS role would sail straight through every policy in
-- 01_schema.sql, FORCE or not.
alter role taskbuddy_app with nosuperuser nocreatedb nocreaterole noreplication nobypassrls;

-- ---------------------------------------------------------------------------
-- Grants. Data only — never DDL.
-- ---------------------------------------------------------------------------
grant connect on database :"db_name" to taskbuddy_app;

grant usage on schema public to taskbuddy_app;
grant usage on schema app    to taskbuddy_app;

grant select, insert, update, delete on all tables in schema public to taskbuddy_app;
grant usage, select on all sequences in schema public to taskbuddy_app;
grant execute on function app.uid() to taskbuddy_app;

-- Anything created later (a new table from a future migration) is covered
-- without a second visit here.
alter default privileges in schema public
  grant select, insert, update, delete on tables to taskbuddy_app;
alter default privileges in schema public
  grant usage, select on sequences to taskbuddy_app;

-- The app must not be able to create objects in public. Postgres 15+ already
-- revokes this by default; stated explicitly so the posture does not depend on
-- which server version Azure provisioned.
revoke create on schema public from public;
revoke create on schema public from taskbuddy_app;

-- ---------------------------------------------------------------------------
-- Verification. Both queries must come back empty / as noted.
-- ---------------------------------------------------------------------------

-- 1. Every table has RLS enabled AND forced. Any row returned here is a table
--    the app could read across users.
--
--    `users` is excluded deliberately: it is ENABLE-but-not-FORCE so that the
--    SECURITY DEFINER login functions in 03_auth.sql can read it before a
--    session exists. It is still RLS-enabled, and taskbuddy_app does not own
--    it, so the app role remains scoped to its own row. See 03_auth.sql.
select relname as table_without_full_rls,
       relrowsecurity  as rls_enabled,
       relforcerowsecurity as rls_forced
from pg_class
where relnamespace = 'public'::regnamespace
  and relkind = 'r'
  and relname <> 'users'
  and (relrowsecurity is false or relforcerowsecurity is false);

-- 2. Every table has at least one policy. A table with RLS on and no policy
--    denies everything, which fails closed but breaks the app loudly.
select c.relname as table_without_policy
from pg_class c
where c.relnamespace = 'public'::regnamespace
  and c.relkind = 'r'
  and not exists (select 1 from pg_policy p where p.polrelid = c.oid);

-- 3. The app role holds no bypass. Expect a single row, all false.
select rolname, rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
from pg_roles
where rolname = 'taskbuddy_app';
