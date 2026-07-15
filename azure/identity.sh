#!/usr/bin/env bash
# Workload identity: an Entra principal for the app, and Azure resources that
# accept its tokens.
#
#   source azure/env.sh && bash azure/identity.sh
#
# Idempotent: every step is a create-or-update guarded by an existence check.
# Safe to re-run.
#
# WHY THIS EXISTS AS A SEPARATE SCRIPT. provision.sh builds what serves traffic,
# observability.sh builds what tells you the truth about it. This builds who
# everything is allowed to be.
#
# THE PROBLEM IT SOLVES. Before this, every Azure credential the app held was a
# long-lived secret in a Vercel env var: the Foundry API key, the database
# password. `azure/sql/02_grants.sql` argued that Key Vault could not fix that,
# because reading a secret from Key Vault needs a credential that would itself
# live in a Vercel env var. That was correct. Federation is what changes it: the
# root credential becomes a short-lived assertion Vercel mints per invocation,
# so there is no first secret for the chain to bottom out in.
#
# WHAT THIS SCRIPT DOES AND DOES NOT CREATE. It creates the DIRECTORY objects —
# the app registration and its federated credentials — because those are
# Microsoft Graph, not ARM, and Bicep reaches them only through a preview
# extension. It creates none of the ARM objects. The Key Vault and all four role
# assignments live in azure/infra/modules/identity.bicep and are deployed by
# step 4 below.
#
# That split is not cosmetic. Role assignments created here would get random
# GUID names, while Bicep derives deterministic ones from
# guid(scope, principal, role) — so the same grant would exist under two names,
# and the next `az deployment group create` would fail with RoleAssignmentExists.
# Whichever tool owns a resource has to own it exclusively.
set -eu

: "${RG:?source azure/env.sh first}"
: "${SRV:?}"

cd "$(dirname "$0")/.."

SUB="$(az account show --query id -o tsv)"
TENANT="$(az account show --query tenantId -o tsv)"
FOUNDRY="${FOUNDRY:-taskbuddy-foundry}"
VAULT="${VAULT:-taskbuddy-kv-3d2b5c}"
APP_NAME="${APP_NAME:-taskbuddy-vercel}"

# The Vercel OIDC issuer is keyed on the team SLUG, not the team id. Getting
# this wrong is the classic failure: Entra rejects the assertion with an opaque
# AADSTS700213 and nothing in the message mentions the issuer.
VERCEL_TEAM_SLUG="${VERCEL_TEAM_SLUG:-aforsmithzs-projects}"
VERCEL_PROJECT="${VERCEL_PROJECT:-taskbuddy}"

echo "==> 1. app registration + service principal"
APP_ID="$(az ad app list --display-name "$APP_NAME" --query "[0].appId" -o tsv)"
if [ -z "$APP_ID" ]; then
  # Single tenant. The default (AzureADandPersonalMicrosoftAccount) would let
  # personal Microsoft accounts sign in to something that is not a sign-in app.
  APP_ID="$(az ad app create --display-name "$APP_NAME" \
    --sign-in-audience AzureADMyOrg --query appId -o tsv)"
  echo "    created app $APP_ID"
else
  echo "    app $APP_ID exists"
fi

SP_OID="$(az ad sp list --filter "appId eq '$APP_ID'" --query "[0].id" -o tsv)"
if [ -z "$SP_OID" ]; then
  SP_OID="$(az ad sp create --id "$APP_ID" --query id -o tsv)"
  echo "    created sp $SP_OID"
else
  echo "    sp $SP_OID exists"
fi

# NOTE what is absent: there is no `az ad app credential reset` anywhere in this
# script. The app registration has no client secret and no certificate, by
# design. If one ever appears in `az ad app credential list`, something has
# regressed to secret-based auth.

echo "==> 2. federated credentials"
# One per Vercel environment. The subject claim carries the environment, so
# production and preview are genuinely different principals-in-context, and
# forgetting preview is the usual way this fails after it "works".
for ENVN in production preview; do
  if az ad app federated-credential show --id "$APP_ID" \
      --federated-credential-id "vercel-$ENVN" -o none 2>/dev/null; then
    echo "    vercel-$ENVN exists"
  else
    az ad app federated-credential create --id "$APP_ID" --parameters "{
      \"name\": \"vercel-$ENVN\",
      \"issuer\": \"https://oidc.vercel.com/$VERCEL_TEAM_SLUG\",
      \"subject\": \"owner:$VERCEL_TEAM_SLUG:project:$VERCEL_PROJECT:environment:$ENVN\",
      \"audiences\": [\"api://AzureADTokenExchange\"],
      \"description\": \"Vercel OIDC, $VERCEL_PROJECT $ENVN deployments\"
    }" -o none
    echo "    created vercel-$ENVN"
  fi
done

echo "==> 3. Postgres Microsoft Entra authentication"
# Enabled ALONGSIDE password auth, not instead of it. Password auth is the
# rollback, and lib/db/pool.ts still uses it deliberately: the pool's
# idleTimeoutMillis of 10s means connections are created constantly and each new
# one would need a live token, which adds a failure mode to the hottest path in
# the system for a credential that is already strong and already rotatable.
#
# What this DOES buy today: schema work and the harnesses stop needing the
# server admin password at all. See azure/secrets.sh.
#
# Takes a few minutes; the server reconfigures rather than restarting.
az postgres flexible-server update -g "$RG" -n "$SRV" \
  --microsoft-entra-auth Enabled --password-auth Enabled -o none
echo "    entra auth enabled (password auth retained as rollback)"

HUMAN_OID="$(az ad signed-in-user show --query id -o tsv)"
HUMAN_UPN="$(az ad signed-in-user show --query userPrincipalName -o tsv)"
if az postgres flexible-server microsoft-entra-admin show -g "$RG" -s "$SRV" \
    --object-id "$HUMAN_OID" -o none 2>/dev/null; then
  echo "    entra admin exists"
else
  az postgres flexible-server microsoft-entra-admin create -g "$RG" -s "$SRV" \
    --display-name "$HUMAN_UPN" --object-id "$HUMAN_OID" --type User -o none
  echo "    entra admin created"
fi
# Postgres truncates role names at its 63-character identifier limit, so
# `current_user` comes back as "...onmicros" rather than the full UPN. That is
# cosmetic, but it looks like a bug the first time you see it.

echo "==> 4. the ARM half: Key Vault + role assignments, via Bicep"
# Deployed as a module rather than through main.bicep so a re-run cannot touch
# Postgres or the alert rules. Deterministic assignment names make this
# idempotent: the same guid(scope, principal, role) updates in place.
#
# The roles, and why each is the tighter of two plausible choices:
#   Cognitive Services OpenAI User  not 'Cognitive Services User', which carries
#                                   accounts/listkeys/action and would let the
#                                   federated principal fetch the very API key
#                                   this exercise exists to delete
#   Key Vault Secrets User          the app: getSecret + readMetadata, nothing else
#   Key Vault Secrets Officer       the human: writes. A compromised function
#                                   cannot rotate or delete a secret.
az deployment group create -g "$RG" -n "identity-$(date +%s)" \
  -f azure/infra/modules/identity.bicep \
  -p vaultName="$VAULT" \
  -p location="${LOC:-eastasia}" \
  -p appPrincipalId="$SP_OID" \
  -p operatorPrincipalId="$HUMAN_OID" \
  -p foundryAccountName="$FOUNDRY" \
  --query "properties.provisioningState" -o tsv

echo
echo "Vercel environment variables — NEITHER OF THESE IS A SECRET:"
echo "  AZURE_TENANT_ID=$TENANT"
echo "  AZURE_CLIENT_ID=$APP_ID"
echo
echo "Both are public directory identifiers. Without a signed assertion from"
echo "https://oidc.vercel.com/$VERCEL_TEAM_SLUG they grant nothing."
echo
echo "Next: populate the vault, then see azure/VERCEL.md section 2."
echo "  source azure/secrets.sh   # verifies the whole chain works"
