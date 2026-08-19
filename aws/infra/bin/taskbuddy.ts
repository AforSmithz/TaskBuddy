#!/usr/bin/env node
import { App, Tags } from "aws-cdk-lib";
import { APP, REGION } from "../lib/config";
import { AuthStack } from "../lib/auth-stack";
import { CicdStack } from "../lib/cicd-stack";
import { DataStack } from "../lib/data-stack";
import { EdgeStack } from "../lib/edge-stack";
import { EventsStack } from "../lib/events-stack";
import { ObservabilityStack } from "../lib/observability-stack";
import { WebStack } from "../lib/web-stack";

const app = new App();

const account =
  app.node.tryGetContext("account") ?? process.env.CDK_DEFAULT_ACCOUNT;

// Where every alarm and budget notification goes. Passed as context rather than
// committed, because it is the one value in this app that is personal data.
const alertEmail: string =
  app.node.tryGetContext("alertEmail") ?? process.env.TASKBUDDY_ALERT_EMAIL ?? "";
if (!alertEmail) {
  throw new Error(
    "No alert email. Pass -c alertEmail=you@example.com or set " +
      "TASKBUDDY_ALERT_EMAIL. Alarms with no subscriber are decoration.",
  );
}

const env = { account, region: REGION };

// Stack order below is the dependency order, and it is also the order the
// cutover runs in: data before auth (the migration trigger reads Postgres),
// auth and events before web (the web function needs both their identifiers).
const data = new DataStack(app, `${APP}-data`, {
  env,
  description: "Aurora Serverless v2 and the VPC it sits in",
});

const auth = new AuthStack(app, `${APP}-auth`, {
  env,
  description: "Cognito user pool and the legacy bcrypt migration trigger",
  cluster: data.cluster,
});

const eventsStack = new EventsStack(app, `${APP}-events`, {
  env,
  description: "EventBridge bus, LLM job queue, workers and schedules",
  cluster: data.cluster,
});

const web = new WebStack(app, `${APP}-web`, {
  env,
  description: "Next.js on Lambda behind CloudFront",
  cluster: data.cluster,
  userPool: auth.userPool,
  userPoolClient: auth.userPoolClient,
  bus: eventsStack.bus,
  jobQueue: eventsStack.jobQueue,
});

new ObservabilityStack(app, `${APP}-observability`, {
  env,
  description: "Alarms, dashboard and the monthly budget",
  alertEmail,
  cluster: data.cluster,
  dlq: eventsStack.dlq,
  jobQueue: eventsStack.jobQueue,
  worker: eventsStack.worker,
});

// Deployed once, by hand, from a laptop - and then never again by CI, which is
// why it is not in the list aws/scripts/deploy.sh deploys. A pipeline that can
// rewrite its own trust policy is a pipeline whose branch condition means
// nothing. Deploy it with:
//
//   cd aws/infra && npx cdk deploy taskbuddy-cicd
//
new CicdStack(app, `${APP}-cicd`, {
  env,
  description: "GitHub Actions OIDC provider and the two roles CI assumes",
});

// us-east-1 only. See edge-stack.ts.
new EdgeStack(app, `${APP}-edge`, {
  env: { account, region: "us-east-1" },
  description: "CloudFront alarms, which only report in us-east-1",
  crossRegionReferences: true,
  alertEmail,
  distributionId: web.distribution.distributionId,
});

Tags.of(app).add("app", APP);
Tags.of(app).add("managed-by", "cdk");
