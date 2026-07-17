// TaskBuddy infrastructure, resource-group scope.
//
//   az deployment group what-if -g taskbuddy-rg -f azure/infra/main.bicep \
//     -p azure/infra/main.bicepparam
//
// This template describes infrastructure that ALREADY EXISTS. It was written by
// reading live state back out of Azure, not by transcribing provision.sh, and
// the acceptance test is that what-if reports no changes. Read
// azure/infra/README.md before running anything that is not what-if.
//
// THE ACCEPTANCE TEST HAS THREE KNOWN EXCEPTIONS, all on the Foundry account:
//
//   Microsoft.CognitiveServices/accounts/taskbuddy-foundry
//     properties.a365LoggingEnabled, properties.a365Status
//   .../deployments/gpt-5-mini and .../deployments/gpt-4.1-mini
//     properties.currentCapacity, properties.deploymentState
//
// All five are read-only properties the platform populates. ARM rejects them as
// template input, so they cannot be declared, and what-if therefore reports
// them as being nulled on every run. They are false positives and a real
// deployment does not change them. Treat "3 Modify, all Foundry, deltas only in
// those five fields" as green; anything else is real drift.
//
// The same trap caught a genuine bug in modules/identity.bicep — see the
// networkAcls note there. The difference is that one WAS fixable by not
// declaring the property, and these are not.
//
// NOT expressed here, on purpose:
//   - resource provider registration (not a resource; stays in observability.sh)
//   - the dev-laptop IP lookup (a curl; passed in as a parameter instead)
//   - the consumption budget (subscription scope; see budget.bicep)
//   - SQL schema, roles and RLS (azure/sql/, applied by apply-sql.sh)
//   - the Entra app registration and its federated credentials (Microsoft Graph
//     objects, not ARM; azure/identity.sh, and see modules/identity.bicep)

targetScope = 'resourceGroup'

@description('Postgres server name.')
param postgresServerName string

@description('Application database name.')
param databaseName string = 'taskbuddy'

@description('Postgres administrator role name.')
param adminUsername string

@description('Postgres administrator password.')
@secure()
param adminPassword string

@description('Single IP allowed to reach Postgres for schema work and the live harness.')
param devLaptopIp string

@description('Open the Postgres firewall to the whole IPv4 range for Vercel. See modules/postgres.bicep.')
// Defaults TRUE because production depends on it. This was false once, and the
// deployed server ended up with only the dev-laptop rule: every Vercel function
// was dropped at the firewall, so sign-in failed with a 10s connection timeout
// while local dev kept working. A default that silently breaks production the
// next time someone deploys in Complete mode is the wrong default.
// Set OPEN_TO_VERCEL=false only for a server nothing is deployed against.
param openToVercel bool = true

@description('Foundry account name.')
param foundryAccountName string

@description('Foundry region. Differs from the resource group region by design: quota, not proximity.')
param foundryLocation string = 'koreacentral'

@description('Log Analytics workspace name.')
param workspaceName string = 'taskbuddy-logs'

@description('Email address receiving every alert.')
param alertEmail string

@description('Key Vault name. Globally unique across *.vault.azure.net.')
param vaultName string = 'taskbuddy-kv-3d2b5c'

@description('''
Object id of the taskbuddy-vercel service principal, printed by
azure/identity.sh. Not derivable here: it is a directory object, and Bicep
reaches those only through the preview Microsoft.Graph extension.
''')
param appPrincipalId string

@description('Object id of the human operator. Writes secrets; the app only reads them.')
param operatorPrincipalId string

@description('Region for the database and workspace. Constrained by the sys.regionrestriction policy on this subscription.')
param location string = resourceGroup().location

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    serverName: postgresServerName
    location: location
    databaseName: databaseName
    adminUsername: adminUsername
    adminPassword: adminPassword
    devLaptopIp: devLaptopIp
    openToVercel: openToVercel
  }
}

module foundry 'modules/foundry.bicep' = {
  name: 'foundry'
  params: {
    accountName: foundryAccountName
    location: foundryLocation
  }
}

// Depends on both of the above only because its diagnostic settings attach to
// them; Bicep infers that from the existing-resource references by name.
module observability 'modules/observability.bicep' = {
  name: 'observability'
  params: {
    workspaceName: workspaceName
    location: location
    postgresServerName: postgresServerName
    foundryAccountName: foundryAccountName
    alertEmail: alertEmail
  }
  dependsOn: [
    postgres
    foundry
  ]
}

// The ARM half of the identity story: the vault, and the role assignments that
// give the federated principal something to be. The directory half — the app
// registration and its federated credentials — lives in azure/identity.sh; see
// the header of modules/identity.bicep for why that split is real rather than
// arbitrary.
module identity 'modules/identity.bicep' = {
  name: 'identity'
  params: {
    vaultName: vaultName
    location: location
    appPrincipalId: appPrincipalId
    operatorPrincipalId: operatorPrincipalId
    foundryAccountName: foundryAccountName
  }
  dependsOn: [
    foundry
  ]
}

output postgresFqdn string = postgres.outputs.fqdn
output foundryEndpoint string = foundry.outputs.endpoint
output vaultUri string = identity.outputs.vaultUri
