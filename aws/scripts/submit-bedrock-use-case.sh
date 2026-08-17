#!/usr/bin/env bash
# Submit the Anthropic first-time-user use case details for this account.
#
#   bash aws/scripts/submit-bedrock-use-case.sh
#
# Until this lands, every Anthropic model on the account answers
#   ResourceNotFoundException: Model use case details have not been submitted
#   for this account.
# and the whole LLM layer silently degrades to its offline heuristics - see the
# "Failing / blocked" section of aws/CUTOVER.md.
#
# The Bedrock console's Model access page was retired; serverless models now
# enable themselves on first invoke. The Anthropic form did NOT go away with it,
# it just moved: either the Model catalog prompts for it, or you call this API.
# This script is the API path so the account state is reproducible.
#
# Submitted once per account. In an Organization, submit from the management
# account and it propagates to members. Access is granted immediately.
set -euo pipefail
cd "$(dirname "$0")/.."

# Region is nearly irrelevant here - the grant is account-wide and the models are
# `global.*` inference profiles - but the call still has to go somewhere.
REGION="${BEDROCK_REGION:-us-east-1}"

COMPANY_NAME="${USE_CASE_COMPANY:-TaskBuddy}"
COMPANY_WEBSITE="${USE_CASE_WEBSITE:-https://d2ssublkln0az9.cloudfront.net}"
# "0" = internal users only, "1" = external. A personal project serving its own
# author is internal.
INTENDED_USERS="${USE_CASE_USERS:-0}"
INDUSTRY="${USE_CASE_INDUSTRY:-Technology}"
OTHER_INDUSTRY=""
USE_CASES="${USE_CASE_TEXT:-Personal task and goal planning application. Claude models are used server-side to decompose user-authored goals into task graphs, interpret natural-language check-ins into structured plan edits, and draft scheduling suggestions. Output is shown only to the single account owner who wrote the input; nothing is published or served to third parties.}"

command -v aws >/dev/null || { echo "aws cli not found" >&2; exit 1; }
aws sts get-caller-identity >/dev/null 2>&1 || {
  echo "no valid AWS session - run 'aws login' first" >&2; exit 1; }

echo "==> account: $(aws sts get-caller-identity --query Account --output text)"

# Already submitted? Then this is a no-op and re-submitting is pointless noise.
if aws bedrock get-use-case-for-model-access --region "$REGION" >/dev/null 2>&1; then
  echo "==> use case details already on file for this account, nothing to do"
  exit 0
fi

# Exported so the python heredoc below can read them.
export COMPANY_NAME COMPANY_WEBSITE INTENDED_USERS INDUSTRY OTHER_INDUSTRY USE_CASES

# --form-data is a base64 blob. AWS CLI v2 reads blob params as base64 by
# default, so encode here. `tr -d` because GNU base64 wraps at 76 columns and a
# wrapped blob fails validation.
FORM_DATA=$(python3 - <<'PY' | base64 | tr -d '\n'
import json, os
print(json.dumps({
    "companyName":         os.environ["COMPANY_NAME"],
    "companyWebsite":      os.environ["COMPANY_WEBSITE"],
    "intendedUsers":       os.environ["INTENDED_USERS"],
    "industryOption":      os.environ["INDUSTRY"],
    "otherIndustryOption": os.environ["OTHER_INDUSTRY"],
    "useCases":            os.environ["USE_CASES"],
}), end="")
PY
)

echo "==> submitting use case details in $REGION"
aws bedrock put-use-case-for-model-access --region "$REGION" --form-data "$FORM_DATA"

echo "==> submitted. verifying with a real one-token Converse"
exec bash scripts/preflight.sh
