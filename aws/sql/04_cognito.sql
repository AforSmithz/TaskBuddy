-- Cognito adaptation. Run as the cluster master, AFTER 03_auth.sql.
--
-- Cognito holds credentials now, so `users.password_hash` stops being the
-- source of truth and becomes migration residue: it is read exactly once per
-- carried-over account, by the USER_MIGRATION Lambda, and never written again.
--
-- This file makes the column optional. It does NOT drop it - that is
-- 05_drop_password_hash.sql, and it must not run until every legacy account has
-- signed in at least once. Dropping early is unrecoverable: the hashes are the
-- only copy of those credentials that exists anywhere, Cognito cannot import
-- them, and there is no email provider on this deployment to send a reset
-- through. The recovery would be an admin setting each password by hand.

-- ---------------------------------------------------------------------------
-- 1. password_hash becomes nullable.
-- ---------------------------------------------------------------------------
-- Accounts created through `signupAction` never have one: the password goes
-- straight to Cognito and the `users` row carries only identity. Without this,
-- every new signup fails on a not-null violation - and it fails INSIDE the
-- transaction that already created the Cognito user, leaving an account that
-- can authenticate but has no row to authorise against.
alter table users alter column password_hash drop not null;

comment on column users.password_hash is
  'Legacy bcrypt hash, pre-Cognito. Read only by the USER_MIGRATION trigger, '
  'never written. Dropped by 05_drop_password_hash.sql once every legacy '
  'account has migrated. NULL for every account created after the cutover.';

-- ---------------------------------------------------------------------------
-- 2. Migration progress, as a view rather than a runbook step.
-- ---------------------------------------------------------------------------
-- The question "is it safe to run 05 yet?" should be answerable by a query
-- instead of by someone remembering who has logged in. A legacy account is
-- migrated once Cognito owns it, and the observable proxy for that is
-- `last_login_at` being set after the cutover date.
create or replace view app.migration_status as
  select
    count(*) filter (where password_hash is not null)              as legacy_accounts,
    count(*) filter (where password_hash is not null
                       and last_login_at is not null)              as legacy_signed_in,
    count(*) filter (where password_hash is null)                  as cognito_native
  from users;

comment on view app.migration_status is
  'Run before 05_drop_password_hash.sql. Safe to drop the column only when '
  'legacy_accounts = legacy_signed_in.';

grant select on app.migration_status to taskbuddy_app;

-- ---------------------------------------------------------------------------
-- 3. The application role loses its remaining write path to the hash.
-- ---------------------------------------------------------------------------
-- 03_auth.sql already removed table-level SELECT/UPDATE on users and re-granted
-- specific columns. The app used to need INSERT on password_hash for signup;
-- it does not any more, because signup writes no hash at all. Narrowing the
-- INSERT grant to the columns actually written closes the last path by which
-- application code could put a credential in this table.
revoke insert on public.users from taskbuddy_app;
grant insert (id, email, full_name) on public.users to taskbuddy_app;

-- ---------------------------------------------------------------------------
-- Verification.
-- ---------------------------------------------------------------------------

-- 1. The column is nullable. Expect is_nullable = YES.
select is_nullable
from information_schema.columns
where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash';

-- 2. The app role can neither read nor write the hash, by any route.
--    Expect all three false.
select has_column_privilege('taskbuddy_app', 'public.users', 'password_hash', 'SELECT') as can_read,
       has_column_privilege('taskbuddy_app', 'public.users', 'password_hash', 'UPDATE') as can_write,
       has_column_privilege('taskbuddy_app', 'public.users', 'password_hash', 'INSERT') as can_insert;

-- 3. ...but signup still works. Expect all true.
select has_column_privilege('taskbuddy_app', 'public.users', 'id', 'INSERT')        as can_insert_id,
       has_column_privilege('taskbuddy_app', 'public.users', 'email', 'INSERT')     as can_insert_email,
       has_column_privilege('taskbuddy_app', 'public.users', 'full_name', 'INSERT') as can_insert_name;

-- 4. Where the migration stands.
select * from app.migration_status;
