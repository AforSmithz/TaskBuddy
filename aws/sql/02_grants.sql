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
--
-- Two of the five attributes cannot be SET here, and that is Aurora, not a bug.
-- The cluster master is `rds_superuser`, which is not a true superuser, and
-- PostgreSQL requires you already hold an attribute to change it:
--
--   nosuperuser    ERROR: Only roles with the SUPERUSER attribute may change
--                  the SUPERUSER attribute.
--   noreplication  ERROR: Only roles with the REPLICATION attribute may change
--                  the REPLICATION attribute.
--
-- `nobypassrls` - the one that actually matters - IS settable, and is set.
alter role taskbuddy_app with nocreatedb nocreaterole nobypassrls;

-- The two that could not be set are ASSERTED instead, because `create role
-- ... login` above defaults both to false. Asserting is not decoration: the
-- alternative is a script that appears to enforce a posture it silently could
-- not apply. If either is ever true, this stops the deploy right here rather
-- than handing the app a role that can bypass every policy in 01_schema.sql.
do $$
declare
  is_super bool;
  is_repl  bool;
begin
  select rolsuper, rolreplication into is_super, is_repl
    from pg_roles where rolname = 'taskbuddy_app';
  if is_super then
    raise exception 'taskbuddy_app has SUPERUSER; it would bypass all RLS. Remove it with a superuser and re-run.';
  end if;
  if is_repl then
    raise exception 'taskbuddy_app has REPLICATION; it must not. Remove it with a replication role and re-run.';
  end if;
end
$$;

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

-- 4. The role authenticates by IAM, not by password.
--
-- This used to also read `rolpassword from pg_authid` to prove no password
-- existed. That cannot work on Aurora: `pg_authid` holds password hashes and is
-- readable only by a true superuser, so the cluster master - `rds_superuser` -
-- gets "permission denied for table pg_authid" and the whole script stops one
-- statement short of finishing. The check was unrunnable where it mattered.
--
-- Membership in `rds_iam` is the stronger statement anyway. It is not a hint
-- that the app prefers IAM; RDS makes password authentication IMPOSSIBLE for a
-- role holding it, whether or not a password was ever set. So the hash is moot
-- and the membership is the control.
--
-- Raised rather than selected, because a printed row only helps if someone
-- reads it. If this grant silently failed, every Lambda would get PAM
-- authentication failures at runtime and nothing here would have said so.
do $$
begin
  if not pg_has_role('taskbuddy_app', 'rds_iam', 'member') then
    raise exception
      'taskbuddy_app is not a member of rds_iam. IAM token auth will fail with '
      '"PAM authentication failed" for a role whose grants all look correct. '
      'Re-run `grant rds_iam to taskbuddy_app;` as the cluster master.';
  end if;
  raise notice 'ok: taskbuddy_app authenticates via rds_iam (password auth is impossible for it)';
end
$$;
