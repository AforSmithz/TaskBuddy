#!/usr/bin/env bash
# Operator credentials, resolved from Microsoft Entra and Key Vault instead of
# from a file of plaintext on the laptop.
#
#   source azure/secrets.sh
#
# WHAT THIS REPLACES. `azure/env.sh` is a chmod-600 file holding the server
# admin password, the app role password and two connection URLs in the clear. It
# is gitignored, which stops it reaching GitHub and stops nothing else: it
# survives in backups, in Spotlight, in any process that can read the home
# directory, and forever in shell history the moment someone cats it.
#
# THE BOOTSTRAP QUESTION, ANSWERED. The obvious objection to "put the secrets in
# Key Vault" is the one `sql/02_grants.sql` used to make: reading a vault needs
# a credential, so where does THAT live? Here it lives nowhere. `az login` is an
# interactive Entra sign-in against a human identity with MFA behind it; the
# only thing on disk afterwards is a refresh token scoped to that human, which
# is revocable centrally and expires on its own. There is no shared secret in
# the chain at any point:
#
#   az login (human, MFA) -> Entra -> Key Vault -> the secret
#   az login (human, MFA) -> Entra -> a Postgres access token
#
# THE DATABASE CONNECTION IS PASSWORDLESS. `ADMIN_PW` is not exported at all.
# The server has Microsoft Entra authentication enabled (azure/identity.sh step
# 4) and the human is its Entra admin, so psql authenticates with a bearer token
# and the admin password is now break-glass only. It is kept in the vault as
# `postgres-admin-password` for the case where Entra itself is the thing that is
# broken.
#
# NOT A REPLACEMENT FOR .env.local. The Next app still reads DATABASE_URL from
# its own environment; see the note at the bottom of this file for why that is
# deliberate and not an oversight.
#
# Tokens last about an hour. Re-source this if a long session starts failing
# authentication.

VAULT="${VAULT:-taskbuddy-kv-3d2b5c}"

# --- non-secret topology. No reason for these to be in a vault. --------------
export RG="${RG:-taskbuddy-rg}"
export LOC="${LOC:-eastasia}"
export SRV="${SRV:-taskbuddy-pg-3d2b5c}"
export DB="${DB:-taskbuddy}"

if ! az account show -o none 2>/dev/null; then
  echo "azure/secrets.sh: not signed in. Run 'az login' first." >&2
  return 1 2>/dev/null || exit 1
fi

kv() { az keyvault secret show --vault-name "$VAULT" -n "$1" --query value -o tsv; }

# --- psql as the Entra admin, with no password anywhere ----------------------
# Discrete libpq variables rather than a URL on purpose: an access token is ~2KB
# of base64 with characters that would have to be percent-encoded to survive a
# connection string, and a single missed encoding turns into an authentication
# failure that reads like a wrong password.
export PGHOST="$SRV.postgres.database.azure.com"
export PGPORT=5432
export PGDATABASE="$DB"
export PGUSER="$(az ad signed-in-user show --query userPrincipalName -o tsv)"
export PGPASSWORD="$(az account get-access-token --resource-type oss-rdbms --query accessToken -o tsv)"

# verify-full, not require. The Postgres firewall is open to a single laptop IP
# today but will be open far wider once Vercel is cut over, and `require`
# encrypts the connection to whoever answers rather than to the right server.
export PGSSLMODE=verify-full
export PGSSLROOTCERT="${PGSSLROOTCERT:-/etc/ssl/cert.pem}"

# Left EMPTY so `psql "$ADMIN_URL"` in apply-sql.sh falls through to the PG*
# variables above. An empty conninfo string is valid libpq and means exactly
# that. Sourcing azure/env.sh instead still sets a real URL, so both paths work.
export ADMIN_URL=""

# --- application secrets, for the scripts that still need them ---------------
export APP_PW="$(kv app-role-password 2>/dev/null || true)"
export APP_URL="$(kv database-url)"

echo "azure/secrets.sh: $PGUSER on $PGHOST/$PGDATABASE, token auth, no password on disk."

# WHY DATABASE_URL IS STILL A VERCEL ENVIRONMENT VARIABLE.
#
# The app could read it from this vault at boot, and deliberately does not.
# `lib/db/pool.ts` exposes `isDbConfigured()` as a SYNCHRONOUS boolean, and 86
# call sites across lib/store.ts and lib/auth-actions.ts use it as the gate
# between the real database and the in-memory demo store. Fetching from Key
# Vault is async, so making the app read it there means making that gate async
# across all 86 sites, on the hottest path in the system, to protect a
# credential that is already scoped to a role with no DDL, no ownership and no
# BYPASSRLS.
#
# That is the same trade `sql/02_grants.sql` refuses for Entra token auth on the
# app's own connection, and it comes out the same way. What the vault buys here
# is a canonical copy for rotation, an access log for reads, and the end of this
# laptop being the only place some of these strings exist.
