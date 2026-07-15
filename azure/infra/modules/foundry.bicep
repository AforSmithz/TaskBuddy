// Microsoft Foundry (Cognitive Services / AIServices) account and model
// deployments.
//
// REGION. This account is in koreacentral while the database is in eastasia.
// That split is deliberate: koreacentral is where this subscription has
// non-zero chat quota for the chosen models. See azure/FOUNDRY.md section 1.

@description('Foundry account name. Also used as the custom subdomain, which is required for token-based auth.')
param accountName string

@description('Region. koreacentral, chosen for model quota, not for proximity.')
param location string

resource account 'Microsoft.CognitiveServices/accounts@2026-05-01' = {
  name: accountName
  location: location
  kind: 'AIServices'
  sku: {
    name: 'S0'
  }
  // Present on the live account. Not used by anything yet: the app authenticates
  // with an API key. It is the identity that would hold a Key Vault role once
  // secrets move off env vars.
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    // Required before Entra token auth can be used at all. Setting it up front
    // means enabling OIDC federation later is a policy flip, not a migration.
    customSubDomainName: accountName
    publicNetworkAccess: 'Enabled'
    allowProjectManagement: true
    // disableLocalAuth is deliberately NOT set here. It is null on the live
    // account, and the API key is the rollback path until Vercel OIDC
    // federation is verified working. azure/VERCEL.md section 2 step 4 is what
    // flips it to true, and that is the step that makes the change real.
  }
}

// Serial (@batchSize(1)) is mandatory: parallel model deployments against one
// Cognitive Services account race on the capacity ledger and fail.
var deployments = [
  {
    name: 'gpt-5-mini'
    model: 'gpt-5-mini'
    version: '2025-08-07'
    capacity: 250
  }
  {
    name: 'gpt-4.1-mini'
    model: 'gpt-4.1-mini'
    version: '2025-04-14'
    capacity: 100
  }
]

@batchSize(1)
resource modelDeployments 'Microsoft.CognitiveServices/accounts/deployments@2026-05-01' = [
  for d in deployments: {
    parent: account
    name: d.name
    sku: {
      name: 'GlobalStandard'
      capacity: d.capacity
    }
    properties: {
      model: {
        format: 'OpenAI'
        name: d.model
        version: d.version
      }
      raiPolicyName: 'Microsoft.DefaultV2'
      // WARNING, and this reflects live state rather than endorsing it.
      // OnceNewDefaultVersionAvailable lets Azure move these deployments to a
      // new model version on its own schedule. This codebase pins versions
      // deliberately and drives them through strict JSON schemas with prompts
      // tuned per model (azure/FOUNDRY.md section 5), so an unattended version
      // change can alter output shape with no commit on our side and nothing in
      // the logs pointing at a cause.
      //
      // OnceCurrentVersionExpired is the setting that matches the intent: no
      // surprise upgrades, but no hard break when a version retires either.
      // Changing it is a real change, not reconciliation, so it is left alone
      // here and raised as its own decision.
      versionUpgradeOption: 'OnceNewDefaultVersionAvailable'
    }
  }
]

output accountId string = account.id
output endpoint string = account.properties.endpoint
