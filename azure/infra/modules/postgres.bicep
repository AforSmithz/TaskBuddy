// Azure Database for PostgreSQL Flexible Server.
//
// Every non-default here is load-bearing and most of them are cost controls.
// See azure/README.md "The free tier has exact edges" before changing any of
// skuName, storageSizeGB, autoGrow, highAvailability or geoRedundantBackup:
// each one individually converts this server from $0.00/mo to ~$25.68/mo.

@description('Server name. Globally unique across *.postgres.database.azure.com.')
param serverName string

@description('Region. Constrained by the sys.regionrestriction policy on this subscription.')
param location string

@description('Application database name.')
param databaseName string

@description('Administrator role name.')
param adminUsername string

@description('Administrator password. Write-only: Azure never returns it, so what-if always reports this as a change.')
@secure()
param adminPassword string

@description('Single IP allowed for schema application and the live harness.')
param devLaptopIp string

@description('Entra tenant backing Microsoft Entra authentication on this server.')
param tenantId string = subscription().tenantId

@description('''
Open the firewall to the entire IPv4 range for Vercel.
Vercel has no static egress IPs on this plan, so there is nothing narrower to
allow. Kept as an explicit opt-in, mirroring OPEN_TO_VERCEL in provision.sh.
Do NOT express this as 0.0.0.0-0.0.0.0: on Azure that means *Azure-internal
only*, which admits every other Azure tenant while still blocking your app.
''')
param openToVercel bool = false

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: serverName
  location: location
  sku: {
    name: 'Standard_B1ms'
    tier: 'Burstable'
  }
  properties: {
    version: '17'
    administratorLogin: adminUsername
    administratorLoginPassword: adminPassword
    storage: {
      // 32 GB is the exact free-tier ceiling. autoGrow is the cost control, not
      // an ops preference: enabling it silently leaves the free allowance.
      storageSizeGB: 32
      autoGrow: 'Disabled'
      type: 'Premium_LRS'
      // Derived from storageSizeGB, but pinned because it is the billing tier.
      // If a future edit to storageSizeGB moves this off P4, that is the line
      // that shows up in the diff.
      tier: 'P4'
      // Fixed by the P4 tier rather than chosen. Stated so the template and the
      // live resource agree; it is not a provisioned-IOPS setting at this tier.
      iops: 120
    }
    // Platform-managed keys. Customer-managed keys would need a Key Vault plus
    // a user-assigned identity, and would not be free.
    dataEncryption: {
      type: 'SystemManaged'
    }
    // No read replica: a replica is a second billable server and the 750 free
    // compute-hours are shared across the subscription. replicationRole is the
    // legacy flat field and `replica` the nested one; the platform populates
    // both, so both are stated.
    replicationRole: 'Primary'
    replica: {
      role: 'Primary'
    }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    // Burstable does not support HA regardless of what `list-skus` claims.
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: 'Enabled'
    }
    // BOTH auth modes, and the pairing is deliberate.
    //
    // Entra auth is what lets operators and the tsx harnesses reach this server
    // with a bearer token instead of the admin password (see azure/secrets.sh).
    // Password auth stays enabled because the APPLICATION still uses it:
    // lib/db/pool.ts sets idleTimeoutMillis to 10s, so connections churn and
    // each new one would need a live token. That is a new failure mode on the
    // hottest path, for a credential already scoped by sql/02_grants.sql.
    //
    // Setting activeDirectoryAuth back to 'Disabled' here would not just drift
    // from live, it would REVOKE the operator path on the next deployment and
    // the failure would surface as an authentication error with no obvious
    // cause. tenantId is required and non-null once Entra auth is on.
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Enabled'
      tenantId: tenantId
    }
    // Sunday 18:00 UTC is 01:00 Monday in Jakarta. Unpinned, Azure picks, and
    // on Burstable a maintenance restart is not instant.
    maintenanceWindow: {
      customWindow: 'Enabled'
      dayOfWeek: 0
      startHour: 18
      startMinute: 0
    }
  }
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

resource devLaptopRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = {
  parent: server
  name: 'dev-laptop'
  properties: {
    startIpAddress: devLaptopIp
    endIpAddress: devLaptopIp
  }
}

resource vercelRule 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = if (openToVercel) {
  parent: server
  name: 'allow-vercel'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '255.255.255.255'
  }
}

// ---------------------------------------------------------------------------
// Server parameters.
// ---------------------------------------------------------------------------
// Deployed serially (@batchSize(1)): concurrent configuration writes against
// one Flexible Server conflict and fail the deployment.
var serverParameters = [
  {
    // The single most important parameter. The RLS design opens a transaction
    // per statement, and a transaction left open by a crashed request pins one
    // of only ~35 usable connections forever.
    name: 'idle_in_transaction_session_timeout'
    value: '30000'
  }
  {
    name: 'statement_timeout'
    value: '15000'
  }
  {
    // The only control here that costs an attacker anything BEFORE they have
    // authenticated. TLS verification, the generated password, nobypassrls and
    // RLS all assume the connection already got in. Non-negotiable once the
    // firewall admits the whole IPv4 range.
    name: 'connection_throttle.enable'
    value: 'on'
  }
  {
    // pg_stat_statements is already in shared_preload_libraries on Flexible
    // Server; azure.extensions is the separate allowlist permitting
    // CREATE EXTENSION.
    name: 'azure.extensions'
    value: 'pg_stat_statements'
  }
  {
    // 2s is well above every normal statement here, so the slow-query log stays
    // quiet until something is genuinely wrong.
    name: 'log_min_duration_statement'
    value: '2000'
  }
  {
    name: 'track_io_timing'
    value: 'on'
  }
]

@batchSize(1)
resource configurations 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = [
  for p in serverParameters: {
    parent: server
    name: p.name
    properties: {
      value: p.value
      source: 'user-override'
    }
  }
]

output serverId string = server.id
output fqdn string = server.properties.fullyQualifiedDomainName
