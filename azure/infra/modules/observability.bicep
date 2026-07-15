// Logging and alerting.
//
// provision.sh builds the thing that serves traffic; this builds the thing that
// tells you the truth about it. None of this existed before 2026-08-17: the
// migration had excellent documentation and no signals, which meant every
// invariant had to be re-verified by a human reading prose.

@description('Log Analytics workspace name.')
param workspaceName string

@description('Region for the workspace. Diagnostic settings may cross regions, so this need not match the monitored resources.')
param location string

@description('Postgres server name, monitored in place.')
param postgresServerName string

@description('Foundry account name, monitored in place.')
param foundryAccountName string

@description('Email address receiving every alert.')
param alertEmail string

resource postgres 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' existing = {
  name: postgresServerName
}

resource foundry 'Microsoft.CognitiveServices/accounts@2026-05-01' existing = {
  name: foundryAccountName
}

// ---------------------------------------------------------------------------
// Log Analytics.
// ---------------------------------------------------------------------------
// The daily cap is the cost control and 0.1 GB is the floor Azure accepts.
// Worst case 3 GB/month against a 5 GB/month free ingestion grant, and 20-50x
// this app's real volume, so it is a runaway guard rather than a budget.
//
// The trade-off to know about: if the cap is ever hit, ingestion STOPS for the
// rest of the day and security logs are lost for that window. At this headroom
// that is the right side of the trade, but it is a trade.
resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    // 30 days is the free tier. Beyond it, billing starts per GB-month.
    retentionInDays: 30
    workspaceCapping: {
      dailyQuotaGb: json('0.1')
    }
  }
}

// ---------------------------------------------------------------------------
// Diagnostic settings.
// ---------------------------------------------------------------------------
// Without these the server has no record of who tried to reach it, which
// matters because the firewall admits the entire IPv4 range once Vercel is in
// play. PostgreSQLLogs carries authentication failures: the evidence that
// connection_throttle is doing its job.
// Every category the resource provider offers is listed, including the ones
// left off. Omitting a category is not the same as disabling it: the platform
// materialises the full list either way, so an incomplete template shows up as
// permanent what-if drift and, worse, makes "is this off on purpose?"
// unanswerable from the source.
resource postgresDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'pg-diagnostics'
  scope: postgres
  properties: {
    workspaceId: workspace.id
    // AzureDiagnostics rather than Dedicated: the KQL in azure/README.md queries
    // the shared AzureDiagnostics table.
    logAnalyticsDestinationType: 'AzureDiagnostics'
    logs: [
      { category: 'PostgreSQLLogs', enabled: true, retentionPolicy: { days: 0, enabled: false } }
      { category: 'PostgreSQLFlexSessions', enabled: true, retentionPolicy: { days: 0, enabled: false } }
      // Query Store categories are off: pg_stat_statements already covers this
      // ground and these are the highest-volume categories against a 0.1 GB cap.
      { category: 'PostgreSQLFlexQueryStoreRuntime', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      { category: 'PostgreSQLFlexQueryStoreWaitStats', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      { category: 'PostgreSQLFlexTableStats', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      { category: 'PostgreSQLFlexDatabaseXacts', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      // PgBouncer is not enabled on this server.
      { category: 'PostgreSQLFlexPGBouncer', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      // Would log statement text, which carries the user's own notes.
      { category: 'PostgreSQLQueryStoreSqlText', enabled: false, retentionPolicy: { days: 0, enabled: false } }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true, retentionPolicy: { days: 0, enabled: false } }
    ]
  }
}

// Server-side backstop to the app-side `foundry.call` line in lib/foundry.ts.
// Audit is the auth trail; RequestResponse is call metadata. Prompt bodies are
// NOT captured: Azure OpenAI content logging is a separate opt-in, deliberately
// left off because the prompts carry the user's own notes.
resource foundryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'foundry-diagnostics'
  scope: foundry
  properties: {
    workspaceId: workspace.id
    logs: [
      { category: 'Audit', enabled: true, retentionPolicy: { days: 0, enabled: false } }
      { category: 'RequestResponse', enabled: true, retentionPolicy: { days: 0, enabled: false } }
      // Off deliberately. AzureOpenAIRequestUsage duplicates the per-call cost
      // attribution already written by lib/foundry.ts; Trace carries prompt
      // content, which is the user's own notes.
      { category: 'AzureOpenAIRequestUsage', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      { category: 'Trace', enabled: false, retentionPolicy: { days: 0, enabled: false } }
      { category: 'ManagedNetworkEvent', enabled: false, retentionPolicy: { days: 0, enabled: false } }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true, retentionPolicy: { days: 0, enabled: false } }
    ]
  }
}

// ---------------------------------------------------------------------------
// Alerts.
// ---------------------------------------------------------------------------
resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'taskbuddy-oncall'
  location: 'global'
  properties: {
    groupShortName: 'tbcall'
    enabled: true
    emailReceivers: [
      {
        name: 'primary'
        emailAddress: alertEmail
        useCommonAlertSchema: false
      }
    ]
  }
}

var metricAlerts = [
  {
    name: 'pg-cpu-credits-low'
    // THE ONE THAT MATTERS MOST, and the one nobody sets. A B-series vCore
    // earns credits when idle and spends them under load; exhausted credits do
    // not look like an outage, they look like everything getting slower while
    // every health check stays green. This architecture is unusually exposed:
    // a dashboard render fires ~21 statements, so a throttled vCore multiplies
    // straight into TTFB.
    description: 'B1ms CPU credits nearly exhausted. Does not present as an outage: everything slows while health checks stay green.'
    metricName: 'cpu_credits_remaining'
    operator: 'LessThan'
    threshold: 30
    windowSize: 'PT15M'
    evaluationFrequency: 'PT5M'
  }
  {
    name: 'pg-connections-high'
    // Guards the pool sizing in lib/db/pool.ts. `max: 6` assumes a handful of
    // warm Fluid Compute instances against ~35 usable connections; this turns
    // that assumption into something watched rather than merely asserted.
    description: 'Approaching the ~35 usable connection ceiling on B1ms. Check pool max in lib/db/pool.ts and Fluid Compute instance count.'
    metricName: 'active_connections'
    operator: 'GreaterThan'
    threshold: 25
    windowSize: 'PT5M'
    evaluationFrequency: 'PT5M'
  }
  {
    name: 'pg-storage-high'
    // Auto-grow is OFF deliberately (it is what keeps storage inside the free
    // 32 GB allowance), which means a full disk is a hard stop, not a bill.
    description: 'Storage above 80 percent. Auto-grow is DISABLED on purpose (it is what keeps the server inside the free 32 GB allowance), so this will not self-heal.'
    metricName: 'storage_percent'
    operator: 'GreaterThan'
    threshold: 80
    windowSize: 'PT15M'
    evaluationFrequency: 'PT15M'
  }
]

resource alerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for a in metricAlerts: {
    name: a.name
    location: 'global'
    properties: {
      description: a.description
      severity: 2
      enabled: true
      scopes: [postgres.id]
      evaluationFrequency: a.evaluationFrequency
      windowSize: a.windowSize
      // targetResourceType and criteria.metricNamespace are deliberately NOT
      // set. Both are optional and inferred from `scopes` for a single-resource
      // alert, and the live alerts (created by `az monitor metrics alert
      // create`) leave them null. Setting them here would be a real change to
      // working alerts in exchange for nothing.
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [
          {
            // `cond0` is the name the CLI generates. Renaming it would recreate
            // the criterion for cosmetic reasons.
            name: 'cond0'
            metricName: a.metricName
            operator: a.operator
            threshold: a.threshold
            timeAggregation: 'Average'
            criterionType: 'StaticThresholdCriterion'
          }
        ]
      }
      actions: [
        {
          actionGroupId: actionGroup.id
        }
      ]
    }
  }
]

resource serviceHealth 'Microsoft.Insights/activityLogAlerts@2020-10-01' = {
  name: 'taskbuddy-service-health'
  location: 'global'
  properties: {
    description: 'Azure Service Health events affecting this subscription: outages, planned maintenance, health advisories.'
    enabled: true
    scopes: [subscription().id]
    condition: {
      allOf: [
        {
          field: 'category'
          equals: 'ServiceHealth'
        }
      ]
    }
    actions: {
      actionGroups: [
        {
          actionGroupId: actionGroup.id
        }
      ]
    }
  }
}

output workspaceId string = workspace.id
output actionGroupId string = actionGroup.id
