#!/usr/bin/env bash
# Apply the schema to Aurora, in order, as the cluster master.
#
#   bash aws/scripts/apply-sql.sh
#
# Connects with the master credential from Secrets Manager - NOT with the
# application role. The app role holds no DDL and deliberately cannot create the
# objects below; running this as taskbuddy_app fails halfway through with
# permission errors on a partially-applied schema.
#
# 05_drop_password_hash.sql is NOT run here. It is destructive and irreversible
# and must not happen as part of a cutover; see the header of that file.
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-ap-southeast-1}"
SECRET_NAME="${DB_SECRET_NAME:-taskbuddy/db/master}"

command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 1; }

echo "==> reading master credential from Secrets Manager"
SECRET=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$SECRET_NAME" --query SecretString --output text)

PGHOST=$(echo "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["host"])')
PGUSER=$(echo "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["username"])')
PGPASSWORD=$(echo "$SECRET" | python3 -c 'import sys,json;print(json.load(sys.stdin)["password"])')
PGDATABASE="${PGDATABASE:-taskbuddy}"
export PGPASSWORD

echo "==> $PGUSER@$PGHOST/$PGDATABASE"
echo
echo "    NOTE: the first connection after an idle period wakes the cluster from"
echo "    auto-pause and can take ~15s. That is the design working, not a hang."
echo

# ON_ERROR_STOP is the whole point. Without it psql prints the error, continues,
# and reports success - leaving a half-applied schema that looks fine until the
# first query hits a missing policy.
run() {
  echo "==> $1"
  psql --set ON_ERROR_STOP=1 \
       --set db_name="$PGDATABASE" \
       -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
       -v ON_ERROR_STOP=1 -f "sql/$1"
  echo
}

run 01_schema.sql
run 02_grants.sql
# 03 MUST follow 02: 02's blanket table grant re-grants SELECT/UPDATE on
# users.password_hash, which is exactly what 03 exists to take away.
run 03_auth.sql
run 04_cognito.sql

echo "all applied. Review the verification query output above - each file ends"
echo "with checks whose expected results are stated in its comments."
