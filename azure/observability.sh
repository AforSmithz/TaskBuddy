#!/usr/bin/env bash
# Logging, alerting and the spend ceiling. Everything in here is free or
# effectively free; the point is that the system tells you when an assumption
# stops holding instead of waiting for a person to re-read a paragraph.
#
#   source azure/env.sh && bash azure/observability.sh
#
# Idempotent: every command is a create-or-update. Safe to re-run.
#
# WHY THIS EXISTS AS A SEPARATE SCRIPT. provision.sh builds the thing that
# serves traffic. This builds the thing that tells you the truth about it. They
# fail differently and get re-run at different times, so they are kept apart.
#
# Requires three resource providers that are NOT registered on a fresh
# subscription. Registration is asynchronous and takes a minute or two; the
# script waits.
set -eu

: "${RG:?source azure/env.sh first}"
: "${SRV:?}" "${LOC:?}"

SUB="$(az account show --query id -o tsv)"
FOUNDRY="${FOUNDRY:-taskbuddy-foundry}"
ALERT_EMAIL="${ALERT_EMAIL:-abiseno.arya@gmail.com}"
WORKSPACE="${WORKSPACE:-taskbuddy-logs}"

PG_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.DBforPostgreSQL/flexibleServers/$SRV"
FOUNDRY_ID="/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/$FOUNDRY"

echo "==> 0. resource providers"
for p in Microsoft.OperationalInsights Microsoft.Insights Microsoft.AlertsManagement; do
  state=$(az provider show -n "$p" --query registrationState -o tsv 2>/dev/null || echo NotRegistered)
  if [ "$state" != "Registered" ]; then
    echo "    registering $p (async, ~1-2 min)"
    az provider register -n "$p" -o none
    until [ "$(az provider show -n "$p" --query registrationState -o tsv)" = "Registered" ]; do
      sleep 10
    done
  fi
  echo "    $p ok"
done

# ---------------------------------------------------------------------------
# Log Analytics.
# ---------------------------------------------------------------------------
# The daily cap is the cost control, and 0.1 GB is the floor Azure accepts. A
# two-user app producing Postgres logs at log_min_duration_statement=2000 plus
# connection records will not come close to it, so this is a runaway guard
# rather than a budget: 3 GB/month worst case, inside the 5 GB/month free
# ingestion grant. Retention of 30 days is also the free tier; going beyond it
# starts billing per GB-month.
#
# The trade-off to know about: if the cap is ever hit, ingestion STOPS for the
# rest of the day and you lose security logs for that window. At 20-50x
# headroom that is the right side of the trade, but it is a trade.
echo "==> 1. log analytics workspace"
az monitor log-analytics workspace create \
  -g "$RG" -n "$WORKSPACE" -l "$LOC" \
  --retention-time 30 --quota 0.1 -o none
WS=$(az monitor log-analytics workspace show -g "$RG" -n "$WORKSPACE" --query id -o tsv)

# ---------------------------------------------------------------------------
# Diagnostic settings.
# ---------------------------------------------------------------------------
# Without these the server has no record of who tried to reach it, which
# matters because the firewall admits the entire IPv4 range once Vercel is in
# play. PostgreSQLLogs carries authentication failures — the evidence that
# connection_throttle is doing its job.
echo "==> 2a. diagnostics: postgres"
az monitor diagnostic-settings create \
  -n pg-diagnostics --workspace "$WS" --resource "$PG_ID" \
  --logs '[{"category":"PostgreSQLLogs","enabled":true},{"category":"PostgreSQLFlexSessions","enabled":true}]' \
  --metrics '[{"category":"AllMetrics","enabled":true}]' -o none

# Foundry logs are the server-side backstop to the app-side `foundry.call` line
# in lib/foundry.ts. Audit is the auth trail; RequestResponse is call metadata
# (not prompt bodies — Azure OpenAI content logging is a separate opt-in and is
# deliberately NOT enabled, since the prompts carry the user's own notes).
echo "==> 2b. diagnostics: foundry"
az monitor diagnostic-settings create \
  -n foundry-diagnostics --workspace "$WS" --resource "$FOUNDRY_ID" \
  --logs '[{"category":"Audit","enabled":true},{"category":"RequestResponse","enabled":true}]' \
  --metrics '[{"category":"AllMetrics","enabled":true}]' -o none

# ---------------------------------------------------------------------------
# Alerts.
# ---------------------------------------------------------------------------
echo "==> 3. action group"
az monitor action-group create \
  -g "$RG" -n taskbuddy-oncall --short-name tbcall \
  --action email primary "$ALERT_EMAIL" -o none
AG=$(az monitor action-group show -g "$RG" -n taskbuddy-oncall --query id -o tsv)

# THE ONE THAT MATTERS MOST, and the one nobody sets. A B-series vCore earns
# credits when idle and spends them under load; exhausted credits do not look
# like an outage, they look like everything getting slower while every health
# check stays green. This architecture is unusually exposed to it: a dashboard
# render fires ~21 statements, so a throttled vCore multiplies straight into
# TTFB.
echo "==> 4a. alert: cpu credits"
az monitor metrics alert create \
  -g "$RG" -n pg-cpu-credits-low --scopes "$PG_ID" --action "$AG" \
  --condition "avg cpu_credits_remaining < 30" \
  --window-size 15m --evaluation-frequency 5m --severity 2 \
  --description "B1ms CPU credits nearly exhausted. Does not present as an outage: everything slows while health checks stay green." \
  -o none

# Guards the pool sizing in lib/db/pool.ts. `max: 6` assumes a handful of warm
# Fluid Compute instances against ~35 usable connections; this is what turns
# that assumption into something watched rather than merely asserted. Raise the
# threshold if you raise `max`.
echo "==> 4b. alert: connections"
az monitor metrics alert create \
  -g "$RG" -n pg-connections-high --scopes "$PG_ID" --action "$AG" \
  --condition "avg active_connections > 25" \
  --window-size 5m --evaluation-frequency 5m --severity 2 \
  --description "Approaching the ~35 usable connection ceiling on B1ms. Check pool max in lib/db/pool.ts and Fluid Compute instance count." \
  -o none

# Auto-grow is OFF deliberately (it is what keeps storage inside the free 32 GB
# allowance), which means a full disk is a hard stop rather than a bill.
echo "==> 4c. alert: storage"
az monitor metrics alert create \
  -g "$RG" -n pg-storage-high --scopes "$PG_ID" --action "$AG" \
  --condition "avg storage_percent > 80" \
  --window-size 15m --evaluation-frequency 15m --severity 2 \
  --description "Storage above 80 percent. Auto-grow is DISABLED on purpose, so this will not self-heal." \
  -o none

echo "==> 4d. alert: service health"
az monitor activity-log alert create \
  -g "$RG" -n taskbuddy-service-health \
  --scope "/subscriptions/$SUB" \
  --condition category=ServiceHealth --action-group "$AG" \
  --description "Azure Service Health events affecting this subscription." -o none

# ---------------------------------------------------------------------------
# Budget.
# ---------------------------------------------------------------------------
# $10, not the $50 the original plan named. Compute and storage are on free
# meters, so the real run-rate is cents of Foundry tokens per day. A $50
# threshold would only fire long after something had gone badly wrong; $10 is
# ~6x headroom over a heavy month, which keeps it quiet AND meaningful.
#
# Worth being clear about the failure mode this protects against. The
# subscription has spendingLimit=On, so overspend does not produce a bill — it
# DISABLES the subscription, which stops the database and takes the app dark.
# The budget is an availability control at least as much as a financial one.
echo "==> 5. budget"
START="$(date -u +%Y-%m-01T00:00:00Z)"
az rest --method put \
  --url "https://management.azure.com/subscriptions/$SUB/providers/Microsoft.Consumption/budgets/taskbuddy-monthly?api-version=2024-08-01" \
  --body "{
    \"properties\": {
      \"category\": \"Cost\",
      \"amount\": 10,
      \"timeGrain\": \"Monthly\",
      \"timePeriod\": { \"startDate\": \"$START\", \"endDate\": \"2027-12-01T00:00:00Z\" },
      \"notifications\": {
        \"actual50\":    { \"enabled\": true, \"operator\": \"GreaterThan\", \"threshold\": 50,  \"thresholdType\": \"Actual\",     \"contactEmails\": [\"$ALERT_EMAIL\"] },
        \"actual80\":    { \"enabled\": true, \"operator\": \"GreaterThan\", \"threshold\": 80,  \"thresholdType\": \"Actual\",     \"contactEmails\": [\"$ALERT_EMAIL\"] },
        \"forecast100\": { \"enabled\": true, \"operator\": \"GreaterThan\", \"threshold\": 100, \"thresholdType\": \"Forecasted\", \"contactEmails\": [\"$ALERT_EMAIL\"] }
      }
    }
  }" -o none

echo
echo "==> done. current state:"
az monitor metrics alert list -g "$RG" --query "[].{alert:name,enabled:enabled}" -o table
echo
echo "Useful queries once logs have flowed (Log Analytics -> $WORKSPACE):"
echo "  AzureDiagnostics | where Category == 'PostgreSQLLogs' and Message contains 'password authentication failed'"
echo "  AzureMetrics     | where MetricName == 'cpu_credits_remaining' | summarize min(Minimum) by bin(TimeGenerated, 1h)"
