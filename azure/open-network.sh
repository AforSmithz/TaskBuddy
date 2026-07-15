#!/usr/bin/env bash
# Open network access to the Postgres server. Run this yourself:
#
#   bash azure/open-network.sh              # this machine only  (dev)
#   OPEN_TO_VERCEL=1 bash azure/open-network.sh   # + the whole internet (deploy)
#
# WHY THIS IS A SEPARATE SCRIPT. Both commands below change the database's
# exposure, so they are worth running deliberately rather than burying in the
# provisioning run.
#
#   1. `--public-access None` at create time DISABLED public networking outright.
#      Nothing can reach the server, including this laptop, and every
#      `firewall-rule create` fails with "not supported for a server without
#      public access enabled". This flips it on. Access is still governed
#      entirely by the firewall rules below.
#
#   2. The `dev-laptop` rule admits one IP: yours, right now. If your ISP gives
#      you a new address, re-run this.
#
#   3. `allow-vercel` (only with OPEN_TO_VERCEL=1) admits the entire IPv4 range.
#      That is not laziness: Vercel runs on AWS and gives no static egress IPs on
#      this plan, so there is no narrower rule to write. Do NOT substitute
#      `--public-access 0.0.0.0` — on Azure that string means *Azure-internal
#      only*, which admits every other Azure tenant while still blocking Vercel.
#      Once it is open, the defences are: TLS certificate verification, a
#      generated 32-char role password, `nobypassrls`, and RLS on every table.
#      Leave it off until you are actually deploying.
set -eu

cd "$(dirname "$0")/.."
. azure/env.sh

echo "==> server: $SRV  ($LOC)"

CURRENT=$(az postgres flexible-server show -g "$RG" -n "$SRV" \
  --query "network.publicNetworkAccess" -o tsv)
if [ "$CURRENT" = "Enabled" ]; then
  echo "==> public networking already enabled"
else
  echo "==> enabling public networking (currently: $CURRENT)"
  az postgres flexible-server update -g "$RG" -n "$SRV" --public-access Enabled -o none
fi

MYIP="$(curl -fsS https://api.ipify.org)"
echo "==> allowing this machine: $MYIP"
az postgres flexible-server firewall-rule create \
  -g "$RG" -s "$SRV" -n dev-laptop \
  --start-ip-address "$MYIP" --end-ip-address "$MYIP" -o none

if [ "${OPEN_TO_VERCEL:-0}" = "1" ]; then
  # PRECONDITION, not a courtesy check. Every other defence on this server
  # (TLS verification, the generated password, nobypassrls, RLS on every table)
  # only engages AFTER a connection authenticates. connection_throttle is the
  # one control that costs an attacker something for guessing, and port 5432 on
  # *.postgres.database.azure.com is continuously scanned. Opening the range
  # without it is the one combination that is meaningfully unsafe, so this
  # refuses rather than warns.
  echo "==> checking brute-force protection before opening the range"
  THROTTLE=$(az postgres flexible-server parameter show \
    -g "$RG" -s "$SRV" --name connection_throttle.enable --query value -o tsv)
  if [ "$THROTTLE" != "on" ]; then
    echo "REFUSING: connection_throttle.enable is '$THROTTLE', expected 'on'." >&2
    echo "Fix it first:" >&2
    echo "  az postgres flexible-server parameter set -g $RG -s $SRV \\" >&2
    echo "    --name connection_throttle.enable --value on" >&2
    exit 1
  fi
  echo "    connection_throttle.enable = on"

  echo "==> allowing the whole IPv4 range (for Vercel)"
  az postgres flexible-server firewall-rule create \
    -g "$RG" -s "$SRV" -n allow-vercel \
    --start-ip-address 0.0.0.0 --end-ip-address 255.255.255.255 -o none
else
  echo "==> skipping the open range (set OPEN_TO_VERCEL=1 when you deploy)"
fi

echo
echo "==> firewall rules now:"
az postgres flexible-server firewall-rule list -g "$RG" -s "$SRV" \
  --query "[].{name:name,start:startIpAddress,end:endIpAddress}" -o table

echo
echo "==> TLS chain (G-2: check the issuer of the top cert)"
openssl s_client -starttls postgres \
  -connect "$SRV.postgres.database.azure.com:5432" -showcerts </dev/null 2>/dev/null \
  | grep -E "^(depth|verify|s:|i:)" || echo "(no output; server may still be starting)"

echo
echo "==> done. Next: apply the schema, in this order:"
echo "    psql \"\$ADMIN_URL\" -f azure/sql/01_schema.sql"
echo "    psql \"\$ADMIN_URL\" -v app_password=\"\$APP_PW\" -v db_name=taskbuddy -f azure/sql/02_grants.sql"
echo "    psql \"\$ADMIN_URL\" -f azure/sql/03_auth.sql"
