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
#
# Environment:
#   TASKBUDDY_SESSION_MAC_KEY   required - the key 06_session_mac.sql seeds into
#                               app.session_key. MUST be the same value the web and
#                               worker functions hold as DB_SESSION_KEY, which is to
#                               say the same value TASKBUDDY_SESSION_MAC_KEY had when
#                               aws/scripts/deploy.sh last ran. If they disagree,
#                               app.uid() returns NULL for everyone, every RLS policy
#                               denies, and the app reads as signed-out with no error
#                               in any log. Recover the deployed value with:
#
#   aws lambda get-function-configuration --function-name taskbuddy-web \
#     --region ap-southeast-1 --query 'Environment.Variables.DB_SESSION_KEY' --output text
#
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TASKBUDDY_SESSION_MAC_KEY:?set TASKBUDDY_SESSION_MAC_KEY (see aws/sql/06_session_mac.sql)}"

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
       --set session_key="$TASKBUDDY_SESSION_MAC_KEY" \
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
# 06 MUST follow 01: it replaces the app.uid() that 01 creates with one that verifies a
# signature instead of trusting the GUC. Re-running 01 later puts the trusting version
# back, with nothing failing to say so - see that file's header.
run 06_session_mac.sql
# 07 MUST follow 02, like 03: 02's blanket grants do not cover app-schema
# functions, but a re-run of 02 is the moment someone is most likely to assume
# every grant is back. 07 owns its own revoke/grant pair, so re-running it is
# the fix.
run 07_plan_roll.sql

echo "all applied. Review the verification query output above - each file ends"
echo "with checks whose expected results are stated in its comments."
