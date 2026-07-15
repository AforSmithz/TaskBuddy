// Consumption budget. Separate file because budgets are subscription-scoped and
// cannot be deployed in the same operation as the resource-group template.
//
//   az deployment sub what-if -l eastasia -f azure/infra/budget.bicep \
//     -p alertEmail=<email>
//
// $10, not the $50 the original plan named. Compute and storage are on free
// meters, so the real run-rate is cents of Foundry tokens per day. A $50
// threshold would only fire long after something had gone badly wrong; $10 is
// ~6x headroom over a heavy month, which keeps it quiet AND meaningful.
//
// Worth being clear about the failure mode this protects against. The
// subscription has spendingLimit=On, so overspend does not produce a bill, it
// DISABLES the subscription, which stops the database and takes the app dark.
// This is an availability control at least as much as a financial one.

targetScope = 'subscription'

@description('Email address receiving budget notifications.')
param alertEmail string

@description('First day of the budget period, ISO 8601. Must be the first of a month.')
param startDate string

@description('Budget ceiling in USD.')
param amount int = 10

resource budget 'Microsoft.Consumption/budgets@2023-05-01' = {
  name: 'taskbuddy-monthly'
  properties: {
    category: 'Cost'
    amount: amount
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: startDate
      endDate: '2027-12-01T00:00:00Z'
    }
    notifications: {
      actual50: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 50
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
      actual80: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 80
        thresholdType: 'Actual'
        contactEmails: [alertEmail]
      }
      forecast100: {
        enabled: true
        operator: 'GreaterThan'
        threshold: 100
        thresholdType: 'Forecasted'
        contactEmails: [alertEmail]
      }
    }
  }
}
