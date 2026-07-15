// Key Vault and the RBAC that makes the workload identity useful.
//
// WHAT IS NOT HERE, AND CANNOT BE. The app registration `taskbuddy-vercel`, its
// service principal, and its two federated credentials are Microsoft Graph
// objects, not ARM resources. Bicep addresses them only through the preview
// `Microsoft.Graph` extension, which needs its own provider registration and a
// separate Graph permission model. Pinning a preview extension into the one
// template whose acceptance test is "what-if reports no changes" is a bad
// trade, so directory objects stay in azure/identity.sh and this module covers
// the ARM half. The split is along a real boundary — directory versus
// subscription — rather than an arbitrary one.
//
// Consequence worth stating plainly: `principalId` below has to be passed in.
// It comes from identity.sh, which prints it, and there is no way for this
// template to look it up.

@description('Key Vault name. Globally unique across *.vault.azure.net.')
param vaultName string

@description('Region. Constrained by the sys.regionrestriction policy on this subscription.')
param location string

@description('Object id of the taskbuddy-vercel service principal. From azure/identity.sh.')
param appPrincipalId string

@description('Object id of the human operator. Writes secrets; the app only reads them.')
param operatorPrincipalId string

@description('Foundry account the workload identity is granted inference on.')
param foundryAccountName string

// Built-in role definition ids. Referenced by GUID because the names are not
// stable identifiers and `subscriptionResourceId` needs the id form.
var roles = {
  // Inference only. NOT 'Cognitive Services User' (a0104474-...), which carries
  // accounts/listkeys/action and would let the federated principal fetch the
  // very API key this design exists to delete.
  cognitiveServicesOpenAIUser: '5e0bd9bd-7b93-4f28-af87-19fc36ad61bd'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId

    // RBAC, not access policies. Access policies are the legacy per-vault ACL
    // model: they do not appear in `az role assignment list`, so a
    // subscription-wide audit of "who can read what" silently misses them.
    enableRbacAuthorization: true

    // Soft delete at the 7-day minimum. Purge protection is deliberately NOT
    // enabled: it is correct for production and wrong here, because it makes
    // the vault undeletable for the retention window on a student subscription
    // with a 12-month expiry clock. Note that enabling it is irreversible, and
    // that ARM rejects `enablePurgeProtection: false` outright rather than
    // treating it as the default — the property has to be absent, which is why
    // it is not written here.
    enableSoftDelete: true
    softDeleteRetentionInDays: 7

    // Public endpoint, matching every other resource in this deployment.
    // Private Endpoint is the correct answer and is blocked for a structural
    // reason rather than an oversight: the compute is on Vercel, which has no
    // VNet to peer and no static egress on this plan. See azure/README.md.
    //
    // `networkAcls` is deliberately NOT stated. With defaultAction 'Allow' and
    // no rules, Azure does not persist the object at all — it reads back null
    // even immediately after a deployment that set it. Declaring it therefore
    // produces a Modify diff on every single what-if that can never converge,
    // which would quietly destroy the value of this template's acceptance test.
    // Add it back only alongside a real rule set.
    publicNetworkAccess: 'Enabled'
  }
}

resource foundry 'Microsoft.CognitiveServices/accounts@2025-06-01' existing = {
  name: foundryAccountName
}

// Scoped to the ONE account, not the resource group. There is a single
// Cognitive Services account today; scoping to the RG would silently widen this
// grant the moment a second one appeared.
resource foundryInference 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  // Deterministic and idempotent: the same triple always produces the same
  // assignment name, so a redeploy updates rather than duplicating.
  name: guid(foundry.id, appPrincipalId, roles.cognitiveServicesOpenAIUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roles.cognitiveServicesOpenAIUser
    )
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The human gets the same inference grant, which is not a convenience: it is
// what allowed the token path to be proven before any Vercel deployment
// existed, and it is what lets the tsx harnesses under azure/harness/ run
// without an API key. Owner does NOT imply this — Owner carries `*` actions but
// no dataActions, and inference is a dataAction.
resource operatorInference 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: foundry
  name: guid(foundry.id, operatorPrincipalId, roles.cognitiveServicesOpenAIUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roles.cognitiveServicesOpenAIUser
    )
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}

// The app reads secrets and can do nothing else. 'Key Vault Secrets User' has
// exactly two dataActions — getSecret and readMetadata — and no management
// actions at all, so a compromised function cannot rotate, delete or purge.
resource appSecretsRead 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, appPrincipalId, roles.keyVaultSecretsUser)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roles.keyVaultSecretsUser
    )
    principalId: appPrincipalId
    principalType: 'ServicePrincipal'
  }
}

// The human writes them. Splitting read from write is the whole point of having
// two principals; granting Officer to both would make the vault a shared folder.
resource operatorSecretsWrite 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: vault
  name: guid(vault.id, operatorPrincipalId, roles.keyVaultSecretsOfficer)
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      roles.keyVaultSecretsOfficer
    )
    principalId: operatorPrincipalId
    principalType: 'User'
  }
}

output vaultUri string = vault.properties.vaultUri
output vaultId string = vault.id
