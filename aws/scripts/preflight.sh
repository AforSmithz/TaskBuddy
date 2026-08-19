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

# Checks can be turned off by name: PREFLIGHT_SKIP=bedrock,probes
#
# Only two are skippable, and only because CI has a reason to. `bedrock` sends a
# real (billed) Converse on every run, and model access is an account-level
# grant that does not change between deploys - checking it on every push is
# paying repeatedly for an answer that changed once, in August. `probes` needs
# read permission on six services, which the deploy role has, but a tightened
# role would fail them in a way that looks like an outage and is not.
#
# Nothing that can differ per commit is skippable: the LWA pin, the bootstrap
# state, the build artefacts and the alert email always run.
skipped() {
  case ",${PREFLIGHT_SKIP:-}," in
    *",$1,"*) printf '  \033[90mskip\033[0m  %s (PREFLIGHT_SKIP)\n' "$1"; return 0 ;;
    *) return 1 ;;
  esac
}

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
# ASK THE ACCOUNT, DO NOT INFER FROM SERVICE ERRORS.
#
# An earlier version of this script guessed at activation by probing S3, Lambda,
# EC2 and RDS and pattern-matching NotSignedUp / SubscriptionRequired /
# OptInRequired. That works, but it is indirect and it cannot tell an unfinished
# signup apart from a disabled region or a policy denial - three very different
# problems that produce nearly identical text.
#
# `account get-account-information` answers directly. PENDING_ACTIVATION means
# signup has not completed, full stop, and no amount of retrying will change it.
info=$(aws account get-account-information --output json 2>&1)
if echo "$info" | grep -q '"AccountState"'; then
  state=$(echo "$info" | python3 -c 'import sys,json;print(json.load(sys.stdin)["AccountState"])')
  created=$(echo "$info" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("AccountCreatedDate",""))')
  case "$state" in
    ACTIVE)
      ok "account is ACTIVE" ;;
    PENDING_ACTIVATION)
      bad "account is PENDING_ACTIVATION (created $created)."
      cat <<'EOM'
        Signup has not finished. Nothing can be provisioned, including
        `cdk bootstrap`. Usually one of:
          - the payment method was declined or never accepted (AWS places a
            small verification hold; cards without international transactions
            enabled commonly fail)
          - phone / identity verification was not completed
          - the account is in manual review
        Check https://console.aws.amazon.com for a banner, and the signup email
        (including spam). Activation is normally minutes; if it has been more
        than 24 hours, AWS account-activation support is free without a support
        plan: https://support.aws.amazon.com/#/contacts/aws-account-support
EOM
      ;;
    SUSPENDED)
      bad "account is SUSPENDED (created $created). Billing or policy issue; contact AWS support." ;;
    *)
      warn "account state is $state (created $created) - not a state this script knows about" ;;
  esac
else
  warn "cannot read account state: $(echo "$info" | head -1)"
fi

# The probes stay, but now as a check on REACHABILITY given an active account,
# not as the activation test. They are what catches a service disabled by an SCP
# or a region that is genuinely not opted in.
probe() {
  local name="$1"; shift
  local out
  out=$("$@" --region "$REGION" 2>&1)
  case "$out" in
    *NotSignedUp*|*SubscriptionRequired*|*OptInRequired*)
      bad "$name: not subscribed (consistent with the account state above)" ;;
    *AccessDenied*|*UnauthorizedOperation*)
      bad "$name: access denied - check for a service control policy" ;;
    *"error"*|*"Error"*)
      warn "$name: $(echo "$out" | head -1 | cut -c1-90)" ;;
    *) ok "$name reachable" ;;
  esac
}
if skipped probes; then :; else
probe s3         aws s3api list-buckets
probe lambda     aws lambda list-functions
probe ec2        aws ec2 describe-vpcs
probe rds        aws rds describe-db-clusters
probe cognito    aws cognito-idp list-user-pools --max-results 1
probe sqs        aws sqs list-queues
fi

# --- 3. Bedrock model access ----------------------------------------------
# A model that is not enabled fails at the first LLM call, in a worker, hours
# after a deploy that looked clean.
#
# THIS SENDS A REAL REQUEST, and the earlier version did not. It listed
# inference profiles and checked for status ACTIVE, which proves only that the
# profile EXISTS in the region - it is true for every account, including one that
# has never been granted access to the model behind it. That check passed on
# 2026-08-19 while every call in the deployed app was failing with:
#
#   ResourceNotFoundException: Model use case details have not been submitted
#   for this account. Fill out the Anthropic use case details form.
#
# which is a one-time per-account submission that nothing in the API surface
# hints at. The Model access console page it used to live on has since been
# retired; submit it with aws/scripts/submit-bedrock-use-case.sh instead. A
# one-token Converse costs a fraction of a cent and is the only thing that
# actually answers "can this account call this model".
if skipped bedrock; then :; else
for model in "${BEDROCK_MODEL:-global.anthropic.claude-haiku-4-5-20251001-v1:0}" \
             "${BEDROCK_FALLBACK_MODEL:-global.anthropic.claude-sonnet-4-6}"; do
  out=$(aws bedrock-runtime converse --region "$REGION" --model-id "$model" \
        --messages '[{"role":"user","content":[{"text":"hi"}]}]' \
        --inference-config '{"maxTokens":1}' 2>&1)
  case "$out" in
    *use\ case\ details*)
      bad "bedrock: $model needs the Anthropic use case details. Run: bash aws/scripts/submit-bedrock-use-case.sh" ;;
    *AccessDenied*|*don\'t\ have\ access*|*not\ authorized*)
      bad "bedrock: no access to $model. Check the execution role has bedrock:InvokeModel on it - the Model access page no longer gates this." ;;
    *ResourceNotFound*)
      bad "bedrock: $model not found in $REGION (check the inference profile id)" ;;
    *ValidationException*)
      # The request shape is this script's, not the app's; a validation error
      # still proves the account can reach the model.
      warn "bedrock: $model reachable, but rejected the probe request: $(echo "$out" | head -1 | cut -c1-70)" ;;
    *usage*|*output*)
      ok "bedrock: $model answered a real request" ;;
    *)
      warn "bedrock: $model - unrecognised response: $(echo "$out" | head -1 | cut -c1-70)" ;;
  esac
done
fi

# --- 4. Lambda Web Adapter layer ------------------------------------------
# A stale pinned version fails as an opaque "layer not found" during rollback.
#
# This asks whether the PINNED version can be read, not what the newest one is.
# The LWA layer's resource policy grants `GetLayerVersion` to everyone but not
# `ListLayerVersions`, so listing returns AccessDeniedException from any account
# that does not own the layer - i.e. every account that would ever run this.
# The earlier version of this check listed, and could therefore never pass; its
# FAIL read as "the region lacks the layer", which was wrong in both directions.
#
# Reading the pin is also the check that matters. A version that resolves is one
# CloudFormation can attach; the newest version is a bump decision, not a gate.
LWA=$(grep -o 'LambdaAdapterLayerArm64:[0-9]*' aws/infra/lib/config.ts | head -1)
LWA_VER="${LWA##*:}"
LWA_BASE="arn:aws:lambda:${REGION}:${LWA_ACCOUNT}:layer:LambdaAdapterLayerArm64"
lwa_arch=$(aws lambda get-layer-version-by-arn --region "$REGION" \
  --arn "${LWA_BASE}:${LWA_VER}" \
  --query 'CompatibleArchitectures[0]' --output text 2>/dev/null)
if [ "${lwa_arch:-}" = "arm64" ]; then
  ok "LWA layer v$LWA_VER resolves in $REGION (arm64)"
  # Walk forward from the pin to find the newest readable version. Bounded, so a
  # long-abandoned pin reports "at least N" rather than looping.
  newest="$LWA_VER"; probe_v=$((LWA_VER + 1)); tries=0
  while [ "$tries" -lt 12 ]; do
    aws lambda get-layer-version-by-arn --region "$REGION" \
      --arn "${LWA_BASE}:${probe_v}" --query 'Version' --output text >/dev/null 2>&1 || break
    newest="$probe_v"; probe_v=$((probe_v + 1)); tries=$((tries + 1))
  done
  if [ "$newest" != "$LWA_VER" ]; then
    warn "LWA layer pinned at $LWA_VER, v$newest exists. Bumping changes the process supervisor in front of \`next start\` - do it deliberately."
  fi
elif [ -n "${lwa_arch:-}" ] && [ "$lwa_arch" != "None" ]; then
  bad "LWA layer v$LWA_VER in $REGION reports architecture '$lwa_arch', not arm64 - the web function is arm64."
else
  bad "LWA layer v$LWA_VER does not resolve in $REGION. Check the version exists: aws lambda get-layer-version-by-arn --arn ${LWA_BASE}:${LWA_VER}"
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
