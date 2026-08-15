#!/usr/bin/env bash
# The whole deployment, in the order the dependencies require.
#
#   TASKBUDDY_ALERT_EMAIL=you@example.com bash aws/scripts/deploy.sh
#
# Build first, always. The web stack packages aws/.build/web, and CDK will
# happily deploy a stale bundle from a previous build without saying so.
set -euo pipefail
cd "$(dirname "$0")/../.."

: "${TASKBUDDY_ALERT_EMAIL:?set TASKBUDDY_ALERT_EMAIL}"
REGION="${AWS_REGION:-ap-southeast-1}"

bash aws/scripts/build-web.sh
bash aws/scripts/preflight.sh

cd aws/infra
echo
echo "==> diff (read this before answering the approval prompt)"
npx cdk diff --all || true

echo
echo "==> deploy"
# Order is explicit rather than left to CDK's dependency sort, because it is
# also the order a human should watch: data first (everything references the
# cluster), then auth and events, then web, then the things that only observe.
npx cdk deploy \
  taskbuddy-data \
  taskbuddy-auth \
  taskbuddy-events \
  taskbuddy-web \
  taskbuddy-observability \
  taskbuddy-edge \
  --require-approval broadening

echo
echo "Next: bash aws/scripts/apply-sql.sh   (the schema is not deployed by CDK)"
