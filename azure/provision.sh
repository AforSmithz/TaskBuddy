#!/usr/bin/env bash
# Provision the Azure Database for PostgreSQL Flexible Server for TaskBuddy.
# SPEC.md section B. Idempotent-ish: safe to re-run, `create` is a no-op if the
# server already exists with the same shape.
#
#   source azure/env.sh && bash azure/provision.sh
#
# --tier / --storage-size are NON-DEFAULTS. Omitting them quadruples the bill.
# --zonal-resiliency (not --high-availability, gone in az 2.89.1) is Disabled:
# Burstable does not support HA regardless of what list-skus claims.
#
# REGION. This subscription carries the Azure-managed `sys.regionrestriction`
# policy assignment, which allows only japanwest, centralindia, indonesiacentral,
# koreacentral and eastasia. southeastasia — the region the spec originally
# named — is refused at create time with RequestDisallowedByAzure. eastasia is
# the replacement, paired with Vercel's hkg1 so the function and the database sit
# in the same metro; see azure/README.md.
set -eu

: "${RG:?source azure/env.sh first}"
: "${SRV:?}" "${LOC:?}" "${ADMIN:?}" "${ADMIN_PW:?}" "${DB:?}"

echo "==> 1. resource group"
az group create --name "$RG" --location "$LOC" -o none

echo "==> 2. server $SRV (this takes 5-10 minutes)"
az postgres flexible-server create \
  --resource-group "$RG" \
  --name "$SRV" \
  --location "$LOC" \
  --admin-user "$ADMIN" \
  --admin-password "$ADMIN_PW" \
  --tier Burstable \
  --sku-name Standard_B1ms \
  --version 17 \
  --storage-size 32 \
  --storage-type Premium_LRS \
  --storage-auto-grow Disabled \
  --backup-retention 7 \
  --geo-redundant-backup Disabled \
  --zonal-resiliency Disabled \
  --public-access None \
  --yes \
  -o none

# NOTE: `-n` is the DATABASE name here and `-s` is the server; `-d` does not
# exist on this subcommand in az 2.89.1.
echo "==> 3. database $DB"
az postgres flexible-server db create -g "$RG" -s "$SRV" -n "$DB" -o none

# `--public-access None` at create time DISABLES public networking outright, it
# does not mean "enabled with no rules" — and firewall-rule create then fails
# with "not supported for a server without public access enabled". Flip it on
# before adding any rule.
echo "==> 4a. enable public networking"
az postgres flexible-server update -g "$RG" -n "$SRV" --public-access Enabled -o none

# Two rules, added separately and deliberately:
#
#   dev-laptop   — this machine only, enough for applying schema and running
#                  azure/harness/live.ts.
#   allow-vercel — the whole IPv4 range. Vercel has no static egress IPs on this
#                  plan, so there is nothing narrower to allow. Do NOT write
#                  `--public-access 0.0.0.0`: on Azure that string means
#                  *Azure-internal only*, which would admit every other Azure
#                  tenant while still blocking your own app.
#
# Add allow-vercel only when you are ready to deploy. Until then the database is
# reachable from one IP. Compensating controls once it is open: certificate
# verification, a generated 32-char role password, nobypassrls, RLS everywhere.
echo "==> 4b. firewall: this machine"
MYIP="$(curl -fsS https://api.ipify.org)"
az postgres flexible-server firewall-rule create \
  -g "$RG" -s "$SRV" -n dev-laptop \
  --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none

if [ "${OPEN_TO_VERCEL:-0}" = "1" ]; then
  echo "==> 4c. firewall: open range for Vercel"
  az postgres flexible-server firewall-rule create \
    -g "$RG" -s "$SRV" -n allow-vercel \
    --start-ip-address 0.0.0.0 --end-ip-address 255.255.255.255 -o none
else
  echo "==> 4c. skipped (set OPEN_TO_VERCEL=1 when deploying to Vercel)"
fi

# The single most important parameter: the RLS design opens a transaction per
# statement, and a transaction left open by a crashed request pins one of only
# ~35 usable connections forever. 30s kills it.
echo "==> 5. server parameters"
az postgres flexible-server parameter set \
  -g "$RG" -s "$SRV" --name idle_in_transaction_session_timeout --value 30000 -o none
az postgres flexible-server parameter set \
  -g "$RG" -s "$SRV" --name statement_timeout --value 15000 -o none

echo "==> 6. verify limits"
echo -n "max_connections = "
az postgres flexible-server parameter show \
  -g "$RG" -s "$SRV" --name max_connections --query value -o tsv

echo "==> 7. TLS pre-flight (G-2: read the issuer of the top cert)"
openssl s_client -starttls postgres \
  -connect "$SRV.postgres.database.azure.com:5432" -showcerts </dev/null 2>/dev/null \
  | grep -E "^(depth|verify|s:|i:)" || echo "(openssl probe returned nothing)"

echo
echo "==> done. host: $SRV.postgres.database.azure.com"
