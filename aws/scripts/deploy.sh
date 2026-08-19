#!/usr/bin/env bash
# The whole deployment, in the order the dependencies require.
#
#   TASKBUDDY_ALERT_EMAIL=you@example.com bash aws/scripts/deploy.sh
#   TASKBUDDY_ALERT_EMAIL=... bash aws/scripts/deploy.sh taskbuddy-web taskbuddy-edge
#
# Build first, always. The web stack packages aws/.build/web, and CDK will
# happily deploy a stale bundle from a previous build without saying so.
#
# RUNS UNATTENDED IN CI. GitHub Actions sets CI=true, and there is nobody there
# to answer `--require-approval broadening`, so in CI the approval prompt is
# turned off and the stateful guard below takes its place. That guard is the
# thing that stops a pipeline quietly replacing the database; the approval
# prompt was never more than a human doing the same check by eye.
#
# Environment:
#   TASKBUDDY_ALERT_EMAIL       required - where alarms go
#   TASKBUDDY_ORIGIN_SECRET     required - the CloudFront-to-origin shared header
#   SKIP_BUILD=1                reuse the existing aws/.build (rerunning a deploy)
#   PREFLIGHT_SKIP=bedrock      see aws/scripts/preflight.sh
#   ALLOW_STATEFUL_REPLACEMENT=1  proceed even if Aurora or the user pool would
#                               be replaced or destroyed. Read the diff first.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${TASKBUDDY_ALERT_EMAIL:?set TASKBUDDY_ALERT_EMAIL}"
# Required by the web stack for any cdk command, not just a deploy of that stack
# - the app constructs all six stacks on every synth. Checked here so it fails in
# a second rather than after a five-minute Next build. Recover the deployed value
# with:
#
#   aws lambda get-function-configuration --function-name taskbuddy-web \
#     --region ap-southeast-1 --query 'Environment.Variables.ORIGIN_SECRET' --output text
#
: "${TASKBUDDY_ORIGIN_SECRET:?set TASKBUDDY_ORIGIN_SECRET (see aws/infra/lib/web-stack.ts)}"
REGION="${AWS_REGION:-ap-southeast-1}"

# Order is explicit rather than left to CDK's dependency sort, because it is
# also the order a human should watch: data first (everything references the
# cluster), then auth and events, then web, then the things that only observe.
ALL_STACKS=(
  taskbuddy-data
  taskbuddy-auth
  taskbuddy-events
  taskbuddy-web
  taskbuddy-observability
  taskbuddy-edge
)

# The two stacks that hold state nothing else can recreate: the Aurora cluster
# and the Cognito user pool. Losing either means losing the users.
STATEFUL_STACKS=(taskbuddy-data taskbuddy-auth)

if [ "$#" -gt 0 ]; then STACKS=("$@"); else STACKS=("${ALL_STACKS[@]}"); fi

# taskbuddy-cicd is not deployable from here. It owns the trust policy that
# decides who may run this script; a pipeline able to widen that policy is a
# pipeline with no branch restriction at all. Deploy it by hand.
for s in "${STACKS[@]}"; do
  if [ "$s" = "taskbuddy-cicd" ]; then
    echo "taskbuddy-cicd is deployed by hand, not by this script. See aws/infra/bin/taskbuddy.ts." >&2
    exit 1
  fi
done

if [ -n "${CI:-}" ]; then
  APPROVAL=never
else
  APPROVAL=broadening
fi

if [ -n "${SKIP_BUILD:-}" ]; then
  echo "==> skipping build (SKIP_BUILD set); aws/.build must already be current"
else
  bash aws/scripts/build-web.sh
fi
bash aws/scripts/preflight.sh

cd aws/infra

# Portable form: GNU mktemp rejects a -t template with no X's, BSD mktemp does not.
DIFF_FILE="$(mktemp "${TMPDIR:-/tmp}/taskbuddy-diff.XXXXXX")"
trap 'rm -f "$DIFF_FILE"' EXIT

echo
echo "==> diff (read this before answering the approval prompt)"
# Never fails the deploy: a diff against a stack that does not exist yet is an
# error, and the first deploy of any stack is exactly that case.
npx cdk diff "${STACKS[@]}" >"$DIFF_FILE" 2>&1 || true
cat "$DIFF_FILE"

# --- the stateful guard ----------------------------------------------------
# CloudFormation replaces a resource silently when an immutable property
# changes: rename the cluster identifier, change the engine, touch a Cognito
# pool's schema, and it builds a new one, points everything at it, and deletes
# the old one with the data in it. `cdk diff` says so, in one line, in the
# middle of several hundred.
#
# So: scan only the sections belonging to the stateful stacks, and stop if
# anything in them is being replaced or destroyed.
guarded=0
for s in "${STACKS[@]}"; do
  for t in "${STATEFUL_STACKS[@]}"; do [ "$s" = "$t" ] && guarded=1; done
done

if [ "$guarded" = "1" ] && [ -z "${ALLOW_STATEFUL_REPLACEMENT:-}" ]; then
  # `cdk diff` prints one "Stack <name>" header per stack, so the stateful
  # sections can be cut out of the diff that was already produced above.
  #
  # If that output format ever changes the awk matches nothing, and rather than
  # scanning the whole diff - which would block on the web function's asset
  # hash, every single time - the guard re-runs the diff scoped to the two
  # stacks. Slower, and independent of how the output is laid out.
  section=$(awk -v want="${STATEFUL_STACKS[*]}" '
    /^Stack /   { keep = index(want, $2) > 0 }
    keep        { print }
  ' "$DIFF_FILE")
  if [ -z "$section" ]; then
    echo "    (could not split the diff by stack; re-running it for the stateful stacks)"
    section=$(npx cdk diff "${STATEFUL_STACKS[@]}" 2>&1 || true)
  fi

  if echo "$section" | grep -qiE 'requires replacement|may be destroyed|destructive|orphan'; then
    echo
    echo "REFUSING TO DEPLOY: the diff replaces or destroys a stateful resource." >&2
    echo "The Aurora cluster and the Cognito user pool are the two things in this" >&2
    echo "account that cannot be rebuilt from the repository." >&2
    echo >&2
    echo "$section" | grep -iE 'requires replacement|may be destroyed|destructive|orphan' >&2
    echo >&2
    echo "If that is genuinely intended, take a snapshot first and re-run with" >&2
    echo "ALLOW_STATEFUL_REPLACEMENT=1." >&2
    exit 1
  fi
fi

echo
echo "==> deploy (approval: $APPROVAL, region: $REGION)"
npx cdk deploy "${STACKS[@]}" --require-approval "$APPROVAL"

echo
echo "Next: bash aws/scripts/apply-sql.sh   (the schema is not deployed by CDK)"
