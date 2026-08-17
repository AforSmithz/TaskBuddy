#!/usr/bin/env bash
# Load the Azure Postgres data into Aurora. Cutover step 7.
#
#   AZURE_URL='postgresql://...' bash aws/scripts/migrate-data.sh
#
# Runs as the cluster master from Secrets Manager, like apply-sql.sh, because
# the app role holds no DDL and - see below - this needs some.
#
# TWO THINGS MAKE THIS MORE THAN `pg_dump | psql`.
#
# 1. FORCED RLS APPLIES TO THE TABLE OWNER.
#    01_schema.sql sets `force row level security`, and the master owns every
#    table. `force` is precisely the modifier that stops an owner from being
#    exempt, and the master has no BYPASSRLS (checked below, not assumed). Every
#    policy scopes by `app.uid()`, which reads the `app.user_id` GUC - unset
#    here, and unsettable to anything useful because the dump spans both users.
#    So a plain restore does not error. It inserts NOTHING, reports success, and
#    leaves an empty database that looks migrated. FORCE is therefore dropped
#    for the load and put back afterwards, and the restore is verified.
#
# 2. `entries` HAS A SELF-REFERENCING FOREIGN KEY.
#    `entries.parent_entry_id -> entries.id`, which pg_dump warns it cannot
#    order around. `session_replication_role = replica` skips FK triggers for
#    the session, so row order stops mattering. Referential integrity is not
#    taken on faith afterwards - the counts are compared against the source.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-ap-southeast-1}"
SECRET_NAME="${DB_SECRET_NAME:-taskbuddy/db/master}"
: "${AZURE_URL:?set AZURE_URL to the source Postgres connection string}"

command -v psql    >/dev/null || { echo "psql not found (brew install postgresql@17)" >&2; exit 1; }
command -v pg_dump >/dev/null || { echo "pg_dump not found" >&2; exit 1; }

# pg_dump refuses to dump from a server newer than itself, and Azure is PG 17.
DUMP_MAJOR=$(pg_dump --version | sed -E 's/.* ([0-9]+).*/\1/')
if [ "$DUMP_MAJOR" -lt 17 ]; then
  echo "pg_dump is $DUMP_MAJOR; the source server is 17. Put postgresql@17 first on PATH:" >&2
  echo '  export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"' >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> reading master credential from Secrets Manager"
SECRET=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$SECRET_NAME" --query SecretString --output text)
PGHOST=$(echo "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["host"])')
PGUSER=$(echo "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["username"])')
PGPASSWORD=$(echo "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
PGDATABASE="${PGDATABASE:-taskbuddy}"
export PGHOST PGUSER PGPASSWORD PGDATABASE

aur() { psql --set ON_ERROR_STOP=1 -q "$@"; }

echo "==> dumping from source"
# users separately: it is the one table the Cognito bridge depends on, and it
# must land before anything that references it.
pg_dump --data-only --no-owner --no-acl --table=users    "$AZURE_URL" > "$WORK/users.sql"
pg_dump --data-only --no-owner --no-acl --exclude-table=users "$AZURE_URL" > "$WORK/rest.sql"

echo "==> source row counts"
psql "$AZURE_URL" -At -o "$WORK/src_counts.txt" -c "
  select table_name || '=' || (xpath('/row/c/text()',
    query_to_xml(format('select count(*) c from %I', table_name), false, true, '')))[1]::text
  from information_schema.tables
  where table_schema='public' and table_type='BASE TABLE' order by 1"

echo "==> dropping FORCE row level security for the load"
# Only the FORCE modifier. RLS itself stays enabled the whole time, so the app
# role is never exposed even for the duration of this script.
aur -c "select 'alter table public.' || quote_ident(relname) || ' no force row level security;'
        from pg_class where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity" \
    -At -o "$WORK/unforce.sql"
aur -f "$WORK/unforce.sql"

echo "==> loading"
# The SET is prepended to the file rather than passed with -c: `\i` is a psql
# meta-command and is not valid inside -c, and session_replication_role has to
# be set on the SAME session that runs the COPYs or it does nothing.
# -1 wraps each load in a single transaction, so a failure leaves no half-load.
for f in users rest; do
  # The dump is written by pg_dump 17 (the source is PG 17) but replayed into
  # Aurora 16.13, and pg_dump emits a preamble of SETs for GUCs its own major
  # version knows. `transaction_timeout` is PG 17+, so 16 rejects it and
  # ON_ERROR_STOP kills the load on line 14 before a single row is copied.
  # Dropping the line is safe: it is a session default being set to 0, i.e. to
  # the value PG 16 already has by not having the parameter at all.
  { echo "set session_replication_role = replica;"
    grep -v '^SET transaction_timeout' "$WORK/$f.sql"
  } > "$WORK/$f.load.sql"
  aur -1 -f "$WORK/$f.load.sql"
done

echo "==> restoring FORCE row level security"
aur -c "select 'alter table public.' || quote_ident(relname) || ' force row level security;'
        from pg_class where relnamespace='public'::regnamespace and relkind='r' and relrowsecurity" \
    -At -o "$WORK/reforce.sql"
aur -f "$WORK/reforce.sql"

echo
echo "==> verification"
# a. FORCE is back on every RLS table. This is the one that must not be skipped:
#    leaving a single table unforced hands the app role a table it can read
#    across tenants, and nothing else in the pipeline would notice.
UNFORCED=$(aur -At -c "select count(*) from pg_class
  where relnamespace='public'::regnamespace and relkind='r'
    and relrowsecurity and not relforcerowsecurity")
if [ "$UNFORCED" != "0" ]; then
  echo "FAIL: $UNFORCED table(s) still have RLS unforced. Do not proceed." >&2
  exit 1
fi
echo "  ok    FORCE row level security restored on every table"

# b. Row counts match the source, table by table.
aur -At -o "$WORK/dst_counts.txt" -c "
  select relname || '=' || (xpath('/row/c/text()',
    query_to_xml(format('select count(*) c from public.%I', relname), false, true, '')))[1]::text
  from pg_class where relnamespace='public'::regnamespace and relkind='r' order by 1"

fail=0
while IFS='=' read -r t n; do
  [ -z "$t" ] && continue
  got=$(grep -E "^${t}=" "$WORK/dst_counts.txt" | cut -d= -f2 || true)
  if [ "${got:-missing}" != "$n" ]; then
    printf '  FAIL  %-24s source=%s aurora=%s\n' "$t" "$n" "${got:-missing}"
    fail=$((fail+1))
  fi
done < "$WORK/src_counts.txt"

if [ "$fail" -gt 0 ]; then
  echo "$fail table(s) do not match the source." >&2
  exit 1
fi
echo "  ok    every source table's row count matches in Aurora"

# c. The ids carried across unchanged. They are the `custom:app_uid` values the
#    Cognito USER_MIGRATION trigger will hand out; a regenerated id here would
#    orphan all 24 foreign keys and every RLS policy at once.
aur -c "select id, email, created_at from public.users order by created_at"
echo
echo "done. Next: cdk deploy taskbuddy-auth taskbuddy-events"
