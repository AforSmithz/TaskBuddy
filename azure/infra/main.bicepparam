// Parameters for main.bicep.
//
//   source azure/env.sh && az deployment group what-if \
//     -g $RG -f azure/infra/main.bicep -p azure/infra/main.bicepparam
//
// Secrets and the laptop IP are read from the environment rather than written
// here, so this file is safe to commit. azure/env.sh supplies them and is
// gitignored.
using 'main.bicep'

param postgresServerName = readEnvironmentVariable('SRV', 'taskbuddy-pg-3d2b5c')
param databaseName = readEnvironmentVariable('DB', 'taskbuddy')
param adminUsername = readEnvironmentVariable('ADMIN', 'tbadmin')
param adminPassword = readEnvironmentVariable('ADMIN_PW')
param location = readEnvironmentVariable('LOC', 'eastasia')

// Defaults to the IP currently in Azure. Override by exporting DEV_IP after
// running `curl -fsS https://api.ipify.org` when your address changes.
param devLaptopIp = readEnvironmentVariable('DEV_IP', '182.8.227.216')

// Mirrors OPEN_TO_VERCEL in provision.sh. Defaults TRUE: the app is deployed on
// Vercel, so the rule is part of the working state, not an opt-in extra. See the
// note on the parameter in main.bicep for what a false default cost us.
param openToVercel = bool(readEnvironmentVariable('OPEN_TO_VERCEL', 'true'))

param foundryAccountName = readEnvironmentVariable('FOUNDRY', 'taskbuddy-foundry')
param foundryLocation = 'koreacentral'
param workspaceName = readEnvironmentVariable('WORKSPACE', 'taskbuddy-logs')
param alertEmail = readEnvironmentVariable('ALERT_EMAIL', 'abiseno.arya@gmail.com')

// --- identity ---------------------------------------------------------------
// Object ids, not secrets: they identify principals and grant nothing on their
// own. Hardcoded as defaults because they are stable for the life of the app
// registration and because azure/identity.sh is the only thing that can mint
// them — a directory lookup is not available from a .bicepparam file.
//
//   appPrincipalId      az ad sp list --filter "displayName eq 'taskbuddy-vercel'" --query "[0].id" -o tsv
//   operatorPrincipalId az ad signed-in-user show --query id -o tsv
param vaultName = readEnvironmentVariable('VAULT', 'taskbuddy-kv-3d2b5c')
param appPrincipalId = readEnvironmentVariable('SP_OID', '6e895f0a-4d79-4377-a7de-2d0ef9b05d5f')
param operatorPrincipalId = readEnvironmentVariable('HUMAN_OID', '750945c9-8390-469e-9616-5dd65072a3b2')
