-- FINAL CLEANUP. Do not run this as part of the cutover.
--
-- STOP AND CHECK FIRST:
--
--   select * from app.migration_status;
--
-- Run this only when `legacy_accounts = legacy_signed_in`. Every remaining
-- legacy hash is the ONLY copy of that password anywhere: Cognito cannot import
-- bcrypt, this deployment has no email provider, and the USER_MIGRATION trigger
-- is the sole reader. Dropping the column with an unmigrated account left means
-- that person can never sign in again, and the fix is an administrator setting
-- their password by hand.
--
-- There is no rush. The column is nullable, unread by the application, and
-- ungranted to the application role. Leaving it in place costs nothing.

begin;

drop function if exists app.login_lookup(text);
drop function if exists app.set_password_hash(uuid, text);

alter table users drop column if exists password_hash;

commit;

-- After this, aws/lambda/user-migration can be removed from the user pool's
-- triggers and the app client can move from ADMIN_USER_PASSWORD_AUTH to SRP -
-- the migration trigger was the only reason the plaintext password had to reach
-- Cognito at all. See aws/SPEC.md.

-- Expect zero rows.
select p.proname
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'app' and p.proname in ('login_lookup', 'set_password_hash');

-- Expect zero rows.
select column_name
from information_schema.columns
where table_schema = 'public' and table_name = 'users' and column_name = 'password_hash';
