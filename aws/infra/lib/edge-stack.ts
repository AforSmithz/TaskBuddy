import { Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import type { Construct } from "constructs";
import { APP } from "./config";

export interface EdgeStackProps extends StackProps {
  readonly alertEmail: string;
  readonly distributionId: string;
}

/**
 * CloudFront alarms, which can only live in us-east-1.
 *
 * CloudFront publishes its metrics to us-east-1 with `Region: "Global"` no
 * matter where the distribution serves from, so an alarm created in
 * ap-southeast-1 would evaluate against a metric that never reports and sit in
 * INSUFFICIENT_DATA forever - looking healthy while watching nothing. That is
 * the only reason this is a separate stack, and it carries its own SNS topic
 * because an alarm cannot notify a topic in another region.
 */
export class EdgeStack extends Stack {
  constructor(scope: Construct, id: string, props: EdgeStackProps) {
    super(scope, id, props);

    const alerts = new sns.Topic(this, "EdgeAlerts", {
      topicName: `${APP}-edge-alerts`,
    });
    alerts.addSubscription(new subs.EmailSubscription(props.alertEmail));

    // The failure this is really watching for: the Lambda Web Adapter starts
    // forwarding to `next start` before it is listening, and every cold start
    // answers 502. It is invisible in Lambda's own Errors metric, because from
    // Lambda's point of view the invocation succeeded.
    const errorRate = new cw.Alarm(this, "Cdn5xx", {
      alarmName: `${APP}-cdn-5xx`,
      alarmDescription:
        "CloudFront is serving 5xx. If this fires on cold starts only, the " +
        "adapter readiness check (AWS_LWA_READINESS_CHECK_PATH) is wrong.",
      metric: new cw.Metric({
        namespace: "AWS/CloudFront",
        metricName: "5xxErrorRate",
        dimensionsMap: {
          DistributionId: props.distributionId,
          Region: "Global",
        },
        statistic: "Average",
        period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: cw.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
    });
    errorRate.addAlarmAction(new cwActions.SnsAction(alerts));
  }
}
