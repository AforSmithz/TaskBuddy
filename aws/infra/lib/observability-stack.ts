import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type * as sqs from "aws-cdk-lib/aws-sqs";
import type { Construct } from "constructs";
import { APP, DB_MAX_ACU, MONTHLY_BUDGET_USD } from "./config";

export interface ObservabilityStackProps extends StackProps {
  readonly alertEmail: string;
  readonly cluster: rds.DatabaseCluster;
  readonly dlq: sqs.Queue;
  readonly jobQueue: sqs.Queue;
  readonly worker: lambda.Function;
  /** The web function's log group. Read for the origin-reject metric filter below. */
  readonly webLogs: logs.ILogGroup;
}

/** Signals. Written at the same time as the rest of the stack, deliberately - the Azure migration
 *  shipped with excellent prose and no telemetry, so every invariant had to be re-verified by a
 *  human reading comments. Each alarm below is annotated with the claim it guards. */
export class ObservabilityStack extends Stack {
  readonly alerts: sns.Topic;

  constructor(scope: Construct, id: string, props: ObservabilityStackProps) {
    super(scope, id, props);

    this.alerts = new sns.Topic(this, "Alerts", {
      topicName: `${APP}-alerts`,
      displayName: "TaskBuddy alerts",
    });
    this.alerts.addSubscription(new subs.EmailSubscription(props.alertEmail));

    const action = new cwActions.SnsAction(this.alerts);
    const alarm = (
      id: string,
      metric: cw.IMetric,
      opts: Omit<cw.AlarmProps, "metric">,
    ): cw.Alarm => {
      const a = new cw.Alarm(this, id, { metric, ...opts });
      a.addAlarmAction(action);
      return a;
    };

    const clusterDim = { DBClusterIdentifier: props.cluster.clusterIdentifier };
    const rdsMetric = (name: string, stat: string) =>
      new cw.Metric({
        namespace: "AWS/RDS",
        metricName: name,
        dimensionsMap: clusterDim,
        statistic: stat,
        period: Duration.minutes(5),
      });

      // The alarm that matters most here. On Azure the equivalent was cpu_credits_remaining,
      // because B-series credit exhaustion presents as "everything is slow and every health check
      // is green". The Aurora analogue isn't performance, it's spend: capacity that never returns
      // to zero is the single failure mode that takes this cluster from ~$10/mo to ~$50/mo, and
      // nothing about it looks like an outage. One leaked transaction or one forgotten psql session
      // is enough. Sustained for an hour, because a real working session legitimately holds
      // capacity for minutes at a time.
    alarm("CapacityNeverPauses", rdsMetric("ServerlessDatabaseCapacity", "Minimum"), {
      alarmName: `${APP}-db-not-pausing`,
      alarmDescription:
        "Aurora has not returned to 0 ACU for an hour. Something is holding a " +
        "connection open; at this rate the cluster bills ~5x its expected cost.",
      threshold: 0.5,
      evaluationPeriods: 12,
      datapointsToAlarm: 12,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // Guards the `max: 6` pool sizing carried over from lib/db/pool.ts. If that
    // is raised, raise this with it - the number is per Lambda instance, and
    // Lambda scales instances, so the product is what reaches the database.
    alarm("DbConnections", rdsMetric("DatabaseConnections", "Maximum"), {
      alarmName: `${APP}-db-connections`,
      alarmDescription:
        "Connection count is climbing. Pool max is per instance; Lambda " +
        "multiplies it by concurrency.",
      threshold: 60,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // The ceiling is a runaway guard, so touching it means the guard is working
    // and something is wrong upstream.
    alarm("DbAtCeiling", rdsMetric("ServerlessDatabaseCapacity", "Maximum"), {
      alarmName: `${APP}-db-at-max-acu`,
      alarmDescription: `Aurora is pinned at the ${DB_MAX_ACU} ACU ceiling.`,
      threshold: DB_MAX_ACU,
      evaluationPeriods: 3,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // A message in the DLQ is never routine. This is the alarm that replaces a console.error
    // nobody reads, and it's the whole reason filterVerified's fail-closed behaviour becomes safe
    // on a queue: a dropped judgement now has somewhere to land and something watching it.
    alarm(
      "DlqNotEmpty",
      props.dlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      {
        alarmName: `${APP}-llm-dlq`,
        alarmDescription:
          "Something gave up. Either an LLM job failed three times, or the daily " +
          "roll schedule exhausted its retry policy - the message body carries the " +
          "job type and the ids either way. Nothing has been lost; nothing will retry.",
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      },
    );

    // Jobs arriving faster than WORKER_MAX_CONCURRENCY can clear them. At two
    // users this means a bug, not growth.
    alarm(
      "JobBacklog",
      props.jobQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
        statistic: "Maximum",
      }),
      {
        alarmName: `${APP}-llm-backlog`,
        alarmDescription: "A queued job has been waiting more than 15 minutes.",
        threshold: Duration.minutes(15).toSeconds(),
        evaluationPeriods: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      },
    );

    alarm("WorkerErrors", props.worker.metricErrors({ period: Duration.minutes(5) }), {
      alarmName: `${APP}-worker-errors`,
      alarmDescription: "The LLM worker is throwing before it can nack cleanly.",
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // Bedrock publishes nothing until the first invocation, so missing data
    // must not read as a breach - otherwise this alarms on a fresh deploy.
    alarm(
      "BedrockThrottles",
      new cw.Metric({
        namespace: "AWS/Bedrock",
        metricName: "InvocationThrottles",
        statistic: "Sum",
        period: Duration.minutes(15),
      }),
      {
        alarmName: `${APP}-bedrock-throttles`,
        alarmDescription:
          "Bedrock is throttling. Check that maxTokens is set on every call - " +
          "an unset value reserves the model maximum against the quota.",
        threshold: 5,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      },
    );

    // ---------------------------------------------------------------------
    // The daily roll.
    //
    // Dimension is ScheduleGroup and only ScheduleGroup - EventBridge Scheduler
    // publishes no per-schedule dimension, so these are account-wide within the
    // group. `default` is where taskbuddy-daily-roll lives because the schedule
    // names no group, and it is the only schedule in this account, so the
    // aggregate is exact today and would need a dedicated group the day it isn't.
    // ---------------------------------------------------------------------
    const schedulerMetric = (name: string) =>
      new cw.Metric({
        namespace: "AWS/Scheduler",
        metricName: name,
        dimensionsMap: { ScheduleGroup: "default" },
        statistic: "Sum",
        period: Duration.hours(1),
      });

    // Delivery to SQS is failing. Distinct from the roll itself failing, which is
    // the worker's problem and shows up on taskbuddy-worker-errors: this is the
    // event never reaching the queue at all, usually a role or a policy.
    alarm("ScheduleTargetErrors", schedulerMetric("TargetErrorCount"), {
      alarmName: `${APP}-schedule-target-errors`,
      alarmDescription:
        "EventBridge Scheduler could not deliver the daily roll to SQS. Check the " +
        "scheduler role's SendMessage grant on both the queue and the DLQ.",
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // Retries exhausted. Before the schedule had a DLQ this was the whole failure:
    // the invocation was dropped and the only evidence was this datapoint. It still
    // deserves its own alarm because it says WHY the DLQ alarm fired, and it fires
    // even if the DLQ write is what broke.
    alarm("ScheduleDropped", schedulerMetric("InvocationDroppedCount"), {
      alarmName: `${APP}-schedule-dropped`,
      alarmDescription:
        "The daily roll exhausted its retry policy. It will not run again until " +
        "tomorrow; the payload is in the DLQ.",
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });

    // ---------------------------------------------------------------------
    // Requests that reached the function URL without the CloudFront header.
    //
    // The function URL is authType NONE and kept private by ORIGIN_SECRET_HEADER
    // alone (see config.ts). The accepted weakness of that control is that anyone
    // holding the value can bypass the edge - and until this filter existed,
    // nothing anywhere would have said so. proxy.ts 404s the request silently.
    //
    // What this counts is REJECTED attempts, so it cannot detect a successful
    // bypass by someone who has the header. It detects the reconnaissance that
    // precedes one, and it detects a rotation done wrong - if the CDN and the
    // function disagree about the value, every real request lands here and this
    // goes vertical, which is a much faster diagnosis than a site that 404s.
    //
    // One custom metric, ~$0.30/mo. The only line item this whole pass adds.
    // ---------------------------------------------------------------------
    const originRejects = new logs.MetricFilter(this, "OriginRejects", {
      logGroup: props.webLogs,
      metricNamespace: `${APP}/edge`,
      metricName: "OriginReject",
      // Matches the literal token proxy.ts logs. A quoted term is a substring
      // match on the whole line, which is what we want - the path is appended and
      // must not have to be matched.
      filterPattern: logs.FilterPattern.literal('"origin-reject"'),
      metricValue: "1",
      // Without this the metric reports NOTHING on a quiet period rather than
      // zero, and an alarm over it sits in INSUFFICIENT_DATA instead of OK.
      defaultValue: 0,
    });

    alarm(
      "OriginProbing",
      originRejects.metric({ statistic: "Sum", period: Duration.minutes(15) }),
      {
        alarmName: `${APP}-origin-probing`,
        alarmDescription:
          "Requests are hitting the Lambda function URL without the CloudFront " +
          "origin header. A handful is background internet noise finding a public " +
          "HTTPS endpoint. A sustained rate means someone has the URL and is " +
          "working on it - or ORIGIN_SECRET and the CDN's custom header have " +
          "drifted apart, in which case this is every real request.",
        threshold: 20,
        evaluationPeriods: 2,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      },
    );

    // Budget. $10: the stack should sit near $13-17/mo, so a threshold at the credit allowance
    // would only speak long after something had gone wrong.
    new budgets.CfnBudget(this, "MonthlyBudget", {
      budget: {
        budgetName: `${APP}-monthly`,
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: MONTHLY_BUDGET_USD, unit: "USD" },
      },
      notificationsWithSubscribers: [
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 50,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
        },
        {
          notification: {
            notificationType: "ACTUAL",
            comparisonOperator: "GREATER_THAN",
            threshold: 80,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
        },
        {
          // The one that gives warning rather than condolences.
          notification: {
            notificationType: "FORECASTED",
            comparisonOperator: "GREATER_THAN",
            threshold: 100,
            thresholdType: "PERCENTAGE",
          },
          subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
        },
      ],
    });

       // -----------------------------------------------------------------------
    // Dashboard.
       // -----------------------------------------------------------------------
    const dashboard = new cw.Dashboard(this, "Dashboard", {
      dashboardName: `${APP}`,
      defaultInterval: Duration.days(7),
    });

    dashboard.addWidgets(
      new cw.GraphWidget({
        title: "Aurora capacity (ACU) - should touch zero every night",
        left: [rdsMetric("ServerlessDatabaseCapacity", "Average")],
        right: [rdsMetric("DatabaseConnections", "Maximum")],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "LLM jobs",
        left: [
          props.jobQueue.metricApproximateNumberOfMessagesVisible(),
          props.dlq.metricApproximateNumberOfMessagesVisible(),
        ],
        right: [props.worker.metricDuration({ statistic: "p95" })],
        width: 12,
      }),
      // The Azure build logged one `foundry.call` line per completion with
      // token counts and a reasoning share. That line is now emitted as
      // CloudWatch Embedded Metric Format, so the same numbers are queryable
      // and chartable instead of only greppable. See lib/bedrock.ts.
      new cw.GraphWidget({
        title: "Bedrock tokens by call site",
        left: [
          new cw.Metric({
            namespace: `${APP}/llm`,
            metricName: "OutputTokens",
            statistic: "Sum",
            period: Duration.hours(1),
          }),
          new cw.Metric({
            namespace: `${APP}/llm`,
            metricName: "InputTokens",
            statistic: "Sum",
            period: Duration.hours(1),
          }),
        ],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "Origin rejects - requests that skipped CloudFront",
        left: [originRejects.metric({ statistic: "Sum" })],
        width: 12,
      }),
      new cw.GraphWidget({
        title: "LLM latency by call site (p95)",
        left: [
          new cw.Metric({
            namespace: `${APP}/llm`,
            metricName: "Latency",
            statistic: "p95",
            period: Duration.hours(1),
          }),
        ],
        width: 12,
      }),
    );
  }
}
