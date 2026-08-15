-- Application role for TaskBuddy on Amazon Aurora PostgreSQL.
--
-- Run as the cluster master, AFTER 01_schema.sql.
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
-- ===========================================================================
-- THERE IS NO PASSWORD, AND THAT IS THE HEADLINE CHANGE
-- ===========================================================================
--
-- The Azure version of this file set one with `alter role ... with password`,
-- and argued at length that a vault could not help because reading a secret
-- from a vault needs a credential that would itself have to be stored. It then
-- reversed itself once workload-identity federation removed the root secret.
--
-- On AWS the chain is shorter still. `grant rds_iam` makes this role
-- authenticate ONLY with an IAM token: `Signer.getAuthToken()` produces a
-- 15-minute credential signed with the caller's execution role. There is no
-- password to store, rotate, leak, or forget to revoke - and, importantly,
-- granting `rds_iam` does not merely make password auth unused, it makes it
-- IMPOSSIBLE for this role. A stolen connection string is worth nothing
-- without a signature from an IAM principal in this account.
--
-- That matters here more than it would elsewhere, because the cluster's
-- security group is open on 5432. Lambda has no static egress IP without a NAT
-- gateway, and a NAT gateway costs more per month than the rest of this
-- architecture combined. IAM auth, forced TLS with a pinned regional CA, and
-- the RLS below are what make that acceptable rather than reckless.
--
-- THE ONE THING TO GET RIGHT. The IAM policy on each function grants
-- `rds-db:connect` on
--   arn:aws:rds-db:<region>:<account>:dbuser:<CLUSTER RESOURCE ID>/taskbuddy_app
-- using the cluster RESOURCE id (cluster-ABC123...), not the cluster
-- identifier. A policy written against the identifier parses, deploys, and
-- grants exactly nothing - the symptom is PAM authentication failure for a
-- role whose permissions all look correct.

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

-- NO PASSWORD IS SET. See the header. `rds_iam` is what replaces it, and it is
-- mutually exclusive with password authentication for this role by design.
grant rds_iam to taskbuddy_app;

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
-- which server version Aurora provisioned.
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

-- 4. The role authenticates by IAM, not by password. Expect rds_iam = true and
--    has_password = false. A `true` in the second column means `grant rds_iam`
--    did not take and the role is still password-authenticable.
select
  pg_has_role('taskbuddy_app', 'rds_iam', 'member')                       as rds_iam,
  (select rolpassword is not null
     from pg_authid where rolname = 'taskbuddy_app')                      as has_password;
