#!/usr/bin/env bash
# Fail the deploy if the cluster's schema is not the one this commit expects.
#
#   bash aws/scripts/check-schema.sh
#
# The problem it solves: the schema is applied by a human running apply-sql.sh,
# the code is deployed by GitHub Actions, and those are two separate acts. Ship
# code whose SQL half never landed and the failure is silent - `07_plan_roll.sql`
# adds a function the worker calls, so the daily roll would fail with `function
# app.all_user_ids() does not exist` while the deploy went green and every alarm
# stayed quiet.
#
# It VERIFIES and never APPLIES, and that asymmetry is the entire design. Every
# file in aws/sql defines the security boundary itself - app.uid(), the RLS
# policies, the SECURITY DEFINER functions - so anything able to apply them can
# rewrite the answer to "which user is this?" and read every account's data.
# Automating that would hand CI the database to save one command a few times a
# year. Verifying costs a read-only grant.
#
# WHICH IS WHY IT CONNECTS AS taskbuddy_app, over a 15-minute IAM token, with no
# stored secret anywhere. That role is `nobypassrls` and this script sets no
# session GUC, so app.uid() is NULL and every ordinary policy denies. The only
# thing this connection can read is app.schema_applied, because that is the only
# thing 08_schema_state.sql grants it. A leaked token from a CI log is worth a
# list of filenames and hashes.
#
# Environment:
#   AWS_REGION      optional, defaults to ap-southeast-1
#   PGDATABASE      optional, defaults to taskbuddy
#
# Exit codes: 0 in sync, 1 drift (with the remediation printed), 2 could not check.
set -euo pipefail
cd "$(dirname "$0")/.."

source scripts/schema-files.sh

REGION="${AWS_REGION:-ap-southeast-1}"
PGDATABASE="${PGDATABASE:-taskbuddy}"
DB_USER="taskbuddy_app"

command -v psql >/dev/null || { echo "psql not found (brew install libpq)" >&2; exit 2; }

# The CA comes out of lib/db/rds-ca.ts, NOT aws/certs/*.pem. The .pem is an
# intermediate that fetch-rds-ca.sh writes on the way to generating that module,
# and `*.pem` is gitignored - so it exists on the laptop that last ran the script
# and on no CI runner ever. Reading the committed module instead means the gate
# trusts exactly the roots the application trusts, reviewed in the same diff,
# rather than whatever a fresh download produced a moment ago.
CA_BUNDLE=$(mktemp)
trap 'rm -f "$CA_BUNDLE"' EXIT
sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \
  ../lib/db/rds-ca.ts > "$CA_BUNDLE"
grep -q "BEGIN CERTIFICATE" "$CA_BUNDLE" || {
  echo "no certificates found in lib/db/rds-ca.ts" >&2
  echo "Regenerate it with: bash aws/scripts/fetch-rds-ca.sh" >&2
  exit 2
}

# The writer endpoint, from the stack that owns it rather than hardcoded.
PGHOST=$(aws cloudformation describe-stacks --stack-name taskbuddy-data --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='ClusterEndpoint'].OutputValue" --output text 2>/dev/null || true)
if [ -z "$PGHOST" ] || [ "$PGHOST" = "None" ]; then
  PGHOST=$(aws rds describe-db-clusters --region "$REGION" \
    --db-cluster-identifier taskbuddy-db --query 'DBClusters[0].Endpoint' --output text)
fi
[ -n "$PGHOST" ] && [ "$PGHOST" != "None" ] || { echo "could not resolve the cluster endpoint" >&2; exit 2; }

# A 15-minute credential signed with this caller's execution role. Nothing is
# stored; there is no password for this role to leak (see 02_grants.sql).
PGPASSWORD=$(aws rds generate-db-auth-token \
  --hostname "$PGHOST" --port 5432 --username "$DB_USER" --region "$REGION")
export PGPASSWORD

# verify-full, not require: `require` encrypts but does not check who answered,
# which against a publicly-reachable cluster is most of the point of TLS.
CONN="host=$PGHOST port=5432 dbname=$PGDATABASE user=$DB_USER sslmode=verify-full sslrootcert=$CA_BUNDLE"

echo "==> $DB_USER@$PGHOST/$PGDATABASE (IAM token, read-only)"
echo "    NOTE: the first connection after an idle period wakes the cluster from"
echo "    auto-pause and can take ~15s."
echo

RECORDED=$(psql "$CONN" -Atq -v ON_ERROR_STOP=1 \
  -c "select filename || ' ' || sha256 from app.schema_applied order by filename;" 2>&1) || {
  echo "$RECORDED" >&2
  echo >&2
  echo "Could not read app.schema_applied. If it does not exist yet, this cluster" >&2
  echo "predates the gate: run 'bash aws/scripts/apply-sql.sh' once to create and" >&2
  echo "populate it." >&2
  exit 2
}

# Resolved ONCE, into a variable, and every later test reads that variable rather
# than re-running the function through a pipe. `schema_files | grep -q ...` looks
# equivalent and is not: grep -q exits on the first match, schema_files takes
# SIGPIPE, and `set -o pipefail` reports the whole pipeline as failed - so the
# membership test answers "no" for every file except the last one it lists.
EXPECTED=$(schema_files)

missing=(); changed=(); ok=0
for f in $EXPECTED; do
  want=$(sql_sha256 "sql/$f")
  got=$(printf '%s\n' "$RECORDED" | awk -v n="$f" '$1 == n { print $2 }')
  if   [ -z "$got" ];      then missing+=("$f")
  elif [ "$got" != "$want" ]; then changed+=("$f  repo:${want:0:12} cluster:${got:0:12}")
  else ok=$((ok + 1))
  fi
done

# A row for a file the repo no longer has. Not a failure - the schema is a
# superset of what this commit needs, which is safe - but it is drift, and the
# next person to wonder why should not have to query for it.
while read -r name _; do
  [ -z "$name" ] && continue
  grep -qx "$name" <<< "$EXPECTED" || echo "note: cluster records $name, which is not in this commit"
done <<< "$RECORDED"

echo "$ok file(s) in sync"

if [ ${#missing[@]} -eq 0 ] && [ ${#changed[@]} -eq 0 ]; then
  echo "schema matches this commit."
  exit 0
fi

echo >&2
echo "SCHEMA DRIFT. This commit expects SQL the cluster has not been given." >&2
for f in "${missing[@]:-}"; do [ -n "$f" ] && echo "  never applied: $f" >&2; done
for f in "${changed[@]:-}"; do [ -n "$f" ] && echo "  changed since applied: $f" >&2; done
echo >&2
echo "Deploying now would ship code against a schema that cannot support it." >&2
echo "The fix is to apply the SQL first, then re-run this deploy:" >&2
echo >&2
echo "  TASKBUDDY_SESSION_MAC_KEY=... bash aws/scripts/apply-sql.sh" >&2
echo >&2
echo "The key must be the value the functions already hold, NOT a fresh one:" >&2
echo "  aws lambda get-function-configuration --function-name taskbuddy-web \\" >&2
echo "    --region $REGION --query 'Environment.Variables.DB_SESSION_KEY' --output text" >&2
exit 1
