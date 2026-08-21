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

# The file list and the hash function, shared with check-schema.sh so the
# applier and the gate cannot disagree about what the schema is.
# shellcheck source=./schema-files.sh
source scripts/schema-files.sh

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

# Lexicographic order, which is what the numeric prefixes encode. The orderings
# that MATTER, and why, so renumbering a file is not done casually:
#   03 after 02 - 02's blanket table grant re-grants SELECT/UPDATE on
#                 users.password_hash, which is exactly what 03 takes away.
#   06 after 01 - 06 replaces the app.uid() that 01 creates with one that
#                 verifies a signature instead of trusting the GUC. Re-running
#                 01 later puts the trusting version back, silently.
#   07 after 02 - 07 owns its own revoke/grant pair, so re-running it is the fix
#                 when a re-run of 02 makes someone assume every grant is back.
#   08 after 02 - it grants SELECT on app.schema_applied to taskbuddy_app, which
#                 needs the role 02 creates to exist.
APPLIED=()
for f in $(schema_files); do
  run "$f"
  APPLIED+=("$f")
done

# Record what was applied, now that all of it succeeded. AFTER the loop and not
# inside it on purpose: ON_ERROR_STOP means a failure halts the run partway, and
# a half-applied schema must NOT look verified to the gate. Nothing is recorded
# unless every file landed.
#
# --single-transaction so the table matches the run atomically. The DELETE
# clears rows for files that no longer exist in the repo, which is otherwise a
# quiet way for the gate to keep passing on a schema nobody ships any more.
echo "==> recording applied hashes"
{
  echo "begin;"
  printf 'delete from app.schema_applied where filename not in ('
  printf "'%s'," "${APPLIED[@]}" | sed 's/,$//'
  printf ');\n'
  for f in "${APPLIED[@]}"; do
    printf "insert into app.schema_applied (filename, sha256, applied_at, applied_by)
            values ('%s', '%s', now(), current_user)
            on conflict (filename) do update set sha256 = excluded.sha256,
                                                 applied_at = excluded.applied_at,
                                                 applied_by = excluded.applied_by;\n" \
      "$f" "$(sql_sha256 "sql/$f")"
  done
  echo "commit;"
} | psql --set ON_ERROR_STOP=1 -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -q

psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" \
  -c "select filename, left(sha256, 12) as sha, applied_by, applied_at from app.schema_applied order by filename;"

echo
echo "all applied. Review the verification query output above - each file ends"
echo "with checks whose expected results are stated in its comments."
echo "The pipeline will now let a deploy through; aws/scripts/check-schema.sh is"
echo "what enforces that, and it reads the table printed above."
