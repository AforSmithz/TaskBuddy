#!/usr/bin/env bash
# Checks that must pass before `cdk deploy` can possibly work.
#
#   bash aws/scripts/preflight.sh
#
# Every check here corresponds to a failure that would otherwise surface late,
# as a CloudFormation rollback after several minutes, with a message that names
# something other than the cause.
set -uo pipefail

REGION="${AWS_REGION:-ap-southeast-1}"
LWA_ACCOUNT=753240598075
fail=0

ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; fail=$((fail+1)); }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }

echo
echo "preflight (region: $REGION)"
echo

# --- 1. Credentials --------------------------------------------------------
ident=$(aws sts get-caller-identity --output json 2>&1)
if echo "$ident" | grep -q '"Account"'; then
  account=$(echo "$ident" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Account"])')
  arn=$(echo "$ident" | python3 -c 'import sys,json;print(json.load(sys.stdin)["Arn"])')
  ok "credentials resolve (account $account)"
  # Root credentials can do everything, including things no deployment should.
  # This is a warning rather than a failure so a first bootstrap is not blocked,
  # but it should be fixed before anything real is deployed.
  case "$arn" in
    *":root") warn "running as ROOT. Create an admin IAM user, enable MFA on root, and use that instead." ;;
    *) ok "not running as root ($arn)" ;;
  esac
else
  bad "no usable credentials: $ident"
fi

# --- 2. Account activation -------------------------------------------------
# The check that matters on a fresh account. Signup can be incomplete while STS
# still answers, and every service call then fails with a message that sounds
# like a permissions problem rather than an unfinished registration.
for svc in "s3api list-buckets" "lambda list-functions" "ec2 describe-vpcs" "rds describe-db-clusters"; do
  name="${svc%% *}"
  out=$(aws $svc --region "$REGION" 2>&1)
  case "$out" in
    *NotSignedUp*|*SubscriptionRequired*|*OptInRequired*)
      bad "$name: account is not subscribed. Finish AWS signup (payment method) before deploying." ;;
    *"error"*|*"Error"*)
      warn "$name: $(echo "$out" | head -1)" ;;
    *) ok "$name reachable" ;;
  esac
done

# --- 3. Bedrock model access ----------------------------------------------
# A model that is not enabled fails at the first LLM call, in a worker, hours
# after a deploy that looked clean.
for model in "${BEDROCK_MODEL:-global.anthropic.claude-haiku-4-5-20251001-v1:0}" \
             "${BEDROCK_FALLBACK_MODEL:-global.anthropic.claude-sonnet-4-6}"; do
  if aws bedrock list-inference-profiles --region "$REGION" \
       --query "inferenceProfileSummaries[?inferenceProfileId=='$model'].status" \
       --output text 2>/dev/null | grep -q ACTIVE; then
    ok "bedrock profile active: $model"
  else
    bad "bedrock profile not ACTIVE in $REGION: $model"
  fi
done

# --- 4. Lambda Web Adapter layer ------------------------------------------
# A stale pinned version fails as an opaque "layer not found" during rollback.
LWA=$(grep -o 'LambdaAdapterLayerArm64:[0-9]*' aws/infra/lib/config.ts | head -1)
LWA_VER="${LWA##*:}"
latest=$(aws lambda list-layer-versions --region "$REGION" \
  --layer-name "arn:aws:lambda:${REGION}:${LWA_ACCOUNT}:layer:LambdaAdapterLayerArm64" \
  --query 'LayerVersions[0].Version' --output text 2>/dev/null)
if [ -n "${latest:-}" ] && [ "$latest" != "None" ]; then
  if [ "$LWA_VER" = "$latest" ]; then
    ok "LWA layer pinned at the current version ($LWA_VER)"
  else
    warn "LWA layer pinned at $LWA_VER, current is $latest. Bumping changes the process supervisor in front of \`next start\` - do it deliberately."
  fi
else
  bad "cannot read the LWA layer in $REGION - check the region supports it"
fi

# --- 5. CDK bootstrap ------------------------------------------------------
if aws cloudformation describe-stacks --stack-name CDKToolkit --region "$REGION" >/dev/null 2>&1; then
  ok "CDK bootstrapped in $REGION"
else
  bad "CDK not bootstrapped in $REGION. Run: npx cdk bootstrap aws://<account>/$REGION"
fi
# us-east-1 too: the edge stack lives there because CloudFront metrics only
# report from us-east-1.
if aws cloudformation describe-stacks --stack-name CDKToolkit --region us-east-1 >/dev/null 2>&1; then
  ok "CDK bootstrapped in us-east-1 (needed by taskbuddy-edge)"
else
  warn "CDK not bootstrapped in us-east-1; taskbuddy-edge will fail to deploy"
fi

# --- 6. Build artefacts ----------------------------------------------------
if [ -f aws/.build/web/run.sh ] && [ -d aws/.build/static ]; then
  ok "web bundle present ($(du -sh aws/.build/web | cut -f1))"
else
  bad "no web bundle. Run: bash aws/scripts/build-web.sh"
fi

# --- 7. Alert email --------------------------------------------------------
if [ -n "${TASKBUDDY_ALERT_EMAIL:-}" ]; then
  ok "alert email set"
else
  bad "TASKBUDDY_ALERT_EMAIL is unset. Alarms with no subscriber are decoration."
fi

echo
if [ "$fail" -gt 0 ]; then
  echo "$fail check(s) failed - do not deploy yet."
  exit 1
fi
echo "preflight clean."
