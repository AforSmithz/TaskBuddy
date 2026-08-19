-- Legacy-credential read path for TaskBuddy on Aurora PostgreSQL.
--
-- Run as the cluster master, AFTER 01_schema.sql and 02_grants.sql.
--
-- Why this file exists at all:
--
-- RLS on `users` is `id = app.uid()`, and app.uid() reads a transaction-local
-- GUC that the app sets from the session cookie. At LOGIN there is no session
-- yet — obtaining one is the point of the request. So the credential lookup
-- runs with app.uid() = NULL, the policy denies, and without the functions
-- below nobody can ever sign in. That is not a tuning detail; it makes the
-- application unbootable.
--
-- The tempting fix is a policy that opens `users` when app.uid() is null. Do
-- not: that exposes every password hash to any unauthenticated query. Instead
-- the two SECURITY DEFINER functions here run as the table owner and are the
-- only way past the policy. app.uid() stays fail-closed everywhere else.
--
-- This depends on `users` being ENABLE-but-not-FORCE row level security (see
-- the block at the end of 01_schema.sql). Under FORCE, the owner is subject to
-- RLS too and these functions would be denied along with everything else.

-- ---------------------------------------------------------------------------
-- Login lookup.
-- ---------------------------------------------------------------------------
-- `stable` (not volatile) so it can be inlined and planned sensibly; it writes
-- nothing. Empty search_path so nothing resolves through a schema the app role
-- could influence — with SECURITY DEFINER that would be privilege escalation,
-- which is why every reference below is schema-qualified.
--
-- Matching is on lower(email), which is exactly the expression behind
-- users_email_lower_key, so this uses the index rather than scanning.
create or replace function app.login_lookup(p_email text)
  returns table (id uuid, email text, full_name text, password_hash text)
  language sql
  stable
  security definer
  set search_path = ''
as $$
  select u.id, u.email, u.full_name, u.password_hash
  from public.users u
  where lower(u.email) = lower(p_email)
  limit 1
$$;

comment on function app.login_lookup(text) is
  'Credential lookup for sign-in. SECURITY DEFINER because it must run before app.user_id is set, when users_self denies by design.';

-- ---------------------------------------------------------------------------
-- Password hash write.
-- ---------------------------------------------------------------------------
-- Used for the transparent re-hash on successful login (one carried-over
-- account is bcrypt cost 6, which is far too weak to leave in place). Takes the
-- id, so it cannot overwrite an arbitrary account's hash without already
-- holding that id — which the caller only has because it just authenticated.
create or replace function app.set_password_hash(p_id uuid, p_hash text)
  returns void
  language sql
  volatile
  security definer
  set search_path = ''
as $$
  update public.users set password_hash = p_hash where id = p_id
$$;

comment on function app.set_password_hash(uuid, text) is
  'Sets a user password hash. SECURITY DEFINER; the app role has no direct UPDATE on users.password_hash.';

-- ---------------------------------------------------------------------------
-- Function privileges. Default is EXECUTE to public — revoke before granting.
-- ---------------------------------------------------------------------------
revoke all on function app.login_lookup(text)           from public;
revoke all on function app.set_password_hash(uuid,text) from public;

grant execute on function app.login_lookup(text)           to taskbuddy_app;
grant execute on function app.set_password_hash(uuid,text) to taskbuddy_app;
-- NOTE: set_password_hash is retained only as the break-glass admin reset
-- documented in aws/README.md. The application no longer calls it.

-- ---------------------------------------------------------------------------
-- Keep password_hash out of the app role's reach.
-- ---------------------------------------------------------------------------
-- 02_grants.sql issued a TABLE-level `grant select, insert, update, delete on
-- all tables in schema public`. A table-level privilege covers every column,
-- and revoking a COLUMN-level privilege does not subtract from it — so
-- `revoke select (password_hash) ...` on its own is a no-op. The table-level
-- grant has to come off first, then be re-granted column by column.
--
-- INSERT stays table-level: signup writes password_hash directly (inside a
-- transaction that has already set app.user_id to the new id, so the
-- users_self WITH CHECK passes). Reads and updates of the hash go through the
-- two functions above instead.
revoke select, update on public.users from taskbuddy_app;

grant select (id, email, full_name, created_at, last_login_at)
  on public.users to taskbuddy_app;

grant update (email, full_name, last_login_at)
  on public.users to taskbuddy_app;

-- ---------------------------------------------------------------------------
-- Verification. Run these after applying; each notes its expected result.
-- ---------------------------------------------------------------------------

-- 1. Both functions exist, are SECURITY DEFINER (prosecdef = true), and have an
--    empty search_path. Expect exactly 2 rows, both true.
select p.proname,
       p.prosecdef                       as security_definer,
       p.proconfig                       as settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app'
  and p.proname in ('login_lookup', 'set_password_hash');

-- 2. The app role cannot read or write password_hash directly.
--    Expect both columns false.
select has_column_privilege('taskbuddy_app', 'public.users', 'password_hash', 'SELECT') as can_read_hash,
       has_column_privilege('taskbuddy_app', 'public.users', 'password_hash', 'UPDATE') as can_write_hash;

-- 3. ...but can still read the columns it needs, and insert a new account.
--    Expect all true.
select has_column_privilege('taskbuddy_app', 'public.users', 'email', 'SELECT')         as can_read_email,
       has_column_privilege('taskbuddy_app', 'public.users', 'last_login_at', 'UPDATE') as can_touch_login,
       has_table_privilege ('taskbuddy_app', 'public.users', 'INSERT')                  as can_signup;

-- 4. `users` has RLS enabled but NOT forced — the precondition these functions
--    rely on. Expect rls_enabled = true, rls_forced = false.
select relrowsecurity      as rls_enabled,
       relforcerowsecurity as rls_forced
from pg_class
where oid = 'public.users'::regclass;
