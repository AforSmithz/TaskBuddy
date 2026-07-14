#!/usr/bin/env bash
# Apply the schema to Azure, in order, as the server admin.
#
#   bash azure/apply-sql.sh
#
# ORDER MATTERS AND SO DOES RE-RUNNING. 02 issues a blanket table-level
# `grant select, insert, update, delete on all tables`, and 03 then revokes
# table-level SELECT/UPDATE on `users` and re-grants column lists so the app role
# can never read or write `password_hash`. Re-running 02 on its own silently puts
# that grant back, with no error and no log line. So: never run 02 without
# running 03 straight after. This script always runs all three.
set -eu

cd "$(dirname "$0")/.."
. azure/env.sh

echo "==> 01_schema.sql"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f azure/sql/01_schema.sql

echo "==> 02_grants.sql"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 \
  -v app_password="$APP_PW" -v db_name="$DB" -f azure/sql/02_grants.sql

echo "==> 03_auth.sql   (must follow 02, always)"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -f azure/sql/03_auth.sql

echo
echo "==> verification"
psql "$ADMIN_URL" -v ON_ERROR_STOP=1 <<'SQL'
\echo '-- tables with RLS off (expect zero rows) --'
select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;

\echo '-- users must be ENABLE but NOT FORCE, or login is impossible --'
select relrowsecurity as rls_enabled, relforcerowsecurity as rls_forced
from pg_class where relname = 'users';

\echo '-- the app role must not reach password_hash --'
select has_column_privilege('taskbuddy_app','users','password_hash','select') as can_read_hash,
       has_column_privilege('taskbuddy_app','users','password_hash','update') as can_write_hash;

\echo '-- the app role must not be able to bypass RLS --'
select rolsuper as is_super, rolbypassrls as can_bypass
from pg_roles where rolname = 'taskbuddy_app';

\echo '-- policy count (expect 25 tables covered) --'
select count(distinct tablename) as tables_with_policies from pg_policies where schemaname = 'public';
SQL

echo
echo "==> expected: no rows; rls_enabled=t rls_forced=f; both hash columns f;"
echo "    is_super=f can_bypass=f; 25 tables with policies."
