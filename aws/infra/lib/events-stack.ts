import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as iam from "aws-cdk-lib/aws-iam";
import type * as lambda from "aws-cdk-lib/aws-lambda";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import type * as rds from "aws-cdk-lib/aws-rds";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as sqs from "aws-cdk-lib/aws-sqs";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";
import type { Construct } from "constructs";
import {
  APP,
  BEDROCK_FALLBACK_MODEL,
  BEDROCK_PRIMARY_MODEL,
  DB_APP_ROLE,
  DB_NAME,
  WORKER_MAX_CONCURRENCY,
  WORKER_MEMORY_MB,
  WORKER_TIMEOUT_SECONDS,
} from "./config";
import { nodeFunction } from "./node-function";

export interface EventsStackProps extends StackProps {
  readonly cluster: rds.DatabaseCluster;
}

/**
 * The asynchronous half of the application.
 *
 * ---------------------------------------------------------------------------
 * WHAT PROBLEM THIS ACTUALLY SOLVES
 * ---------------------------------------------------------------------------
 * This is not event-driven architecture for its own sake. The app has eleven
 * LLM call sites and seven of them run at `reasoningEffort: "medium"`; the
 * `skill_decomposition` call was measured at 43 seconds against the previous
 * provider. Today every one of those runs inside a Server Action while the user
 * waits, which means a page render is coupled to a model's latency.
 *
 * Moving them behind a queue buys four things that are not available in-process:
 *
 *   1. The request returns immediately; the render is no longer hostage to a
 *      43-second call.
 *   2. Retries survive the request. An in-process retry dies with the
 *      invocation; an SQS redrive does not.
 *   3. Failures become visible instead of silent. `filterVerified` in
 *      lib/skill-links.ts fails CLOSED by design, so a burst of 429s currently
 *      deletes good suggestions with nothing but a console line. On a queue the
 *      same burst becomes a retry, and a genuine failure lands in a DLQ that an
 *      alarm watches.
 *   4. Concurrency becomes a budget control the platform enforces, rather than
 *      an in-process semaphore that resets whenever an instance recycles.
 */
export class EventsStack extends Stack {
  readonly bus: events.EventBus;
  readonly jobQueue: sqs.Queue;
  readonly dlq: sqs.Queue;
  readonly worker: lambda.Function;
  readonly skillLinkMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: EventsStackProps) {
    super(scope, id, props);

    // A dedicated bus, not the default one. The default bus also carries every
    // AWS service event in the account, so a rule pattern written slightly too
    // broadly there can match infrastructure events and loop.
    this.bus = new events.EventBus(this, "Bus", { eventBusName: APP });

    this.dlq = new sqs.Queue(this, "JobDlq", {
      queueName: `${APP}-llm-jobs-dlq`,
      // Two weeks. A job that failed three times is a bug, and a bug needs to
      // still be there on Monday morning to be diagnosable.
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    this.jobQueue = new sqs.Queue(this, "JobQueue", {
      queueName: `${APP}-llm-jobs`,
      // Six times the function timeout, per the SQS rule. Anything less and a
      // slow-but-succeeding job gets redelivered while the first copy is still
      // running, so the model is invoked twice and billed twice.
      visibilityTimeout: Duration.seconds(WORKER_TIMEOUT_SECONDS * 6),
      retentionPeriod: Duration.days(4),
      enforceSSL: true,
      deadLetterQueue: {
        queue: this.dlq,
        // Three attempts. Bedrock throttles are transient and clear in seconds;
        // a schema or prompt failure will fail identically forever, and paying
        // for ten attempts at a 43-second reasoning call to learn that is
        // expensive in both senses.
        maxReceiveCount: 3,
      },
    });

    this.worker = nodeFunction(this, "LlmWorker", {
      functionName: `${APP}-llm-worker`,
      entry: "../lambda/llm-worker/index.ts",
      description: "Runs long LLM jobs off the request path. SQS-driven.",
      timeout: Duration.seconds(WORKER_TIMEOUT_SECONDS),
      memorySize: WORKER_MEMORY_MB,
      environment: {
        PGHOST: props.cluster.clusterEndpoint.hostname,
        PGDATABASE: DB_NAME,
        PGUSER: DB_APP_ROLE,
        BEDROCK_MODEL: BEDROCK_PRIMARY_MODEL,
        BEDROCK_FALLBACK_MODEL,
        EVENT_BUS_NAME: this.bus.eventBusName,
      },
    });

    const judge = nodeFunction(this, "SkillJudge", {
      functionName: `${APP}-skill-judge`,
      entry: "../lambda/skill-judge/index.ts",
      description:
        "Judges one (task, skill) pair. Invoked per item by the Distributed Map.",
      timeout: Duration.seconds(60),
      memorySize: 256,
      environment: {
        BEDROCK_MODEL: BEDROCK_PRIMARY_MODEL,
        BEDROCK_FALLBACK_MODEL,
      },
    });

    for (const fn of [this.worker, judge]) {
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
          // Both the inference profile and the underlying foundation models it
          // can route to. A policy naming only the profile fails at invoke
          // time with an AccessDenied that names a model nobody configured,
          // because a global profile resolves to a model ARN in another region.
          resources: [
            `arn:aws:bedrock:*:${this.account}:inference-profile/*`,
            "arn:aws:bedrock:*::foundation-model/anthropic.*",
          ],
        }),
      );
    }

    // See auth-stack.ts for why this is grantConnect and not a literal ARN.
    props.cluster.grantConnect(this.worker, DB_APP_ROLE);
    this.bus.grantPutEventsTo(this.worker);

    this.worker.addEventSource(
      new SqsEventSource(this.jobQueue, {
        batchSize: 1,
        // The budget control. Each concurrent worker is another billable
        // Bedrock request; two users cannot legitimately need more in flight.
        maxConcurrency: WORKER_MAX_CONCURRENCY,
        // Without this, one poison message in a batch redelivers the whole
        // batch and every job in it runs the model again.
        reportBatchItemFailures: true,
      }),
    );

    // -----------------------------------------------------------------------
    // Skill-link verification: Distributed Map, not Promise.all.
    // -----------------------------------------------------------------------
    // lib/skill-links.ts judges each (task, skill) pair with an isolated model
    // call and drops any pair whose judge errored. In-process that means a
    // throttling burst quietly deletes good links. Here each pair is a Map
    // item: it retries on its own schedule, and a pair that still fails is a
    // recorded failure rather than a silent false.
    const judgeTask = new tasks.LambdaInvoke(this, "JudgePair", {
      lambdaFunction: judge,
      outputPath: "$.Payload",
    });
    judgeTask.addRetry({
      errors: ["ThrottlingException", "TooManyRequestsException", "ServiceUnavailableException"],
      interval: Duration.seconds(2),
      maxAttempts: 4,
      backoffRate: 2,
    });

    const map = new sfn.DistributedMap(this, "JudgeAllPairs", {
      itemsPath: "$.pairs",
      // The same cap as the queue, and for the same reason. A goal with thirty
      // candidate links would otherwise open thirty concurrent model calls.
      maxConcurrency: WORKER_MAX_CONCURRENCY,
      // A single unjudgeable pair must not fail the whole verification run.
      toleratedFailurePercentage: 100,
      resultPath: "$.verdicts",
    });
    map.itemProcessor(judgeTask);

    this.skillLinkMachine = new sfn.StateMachine(this, "SkillLinkMachine", {
      stateMachineName: `${APP}-skill-links`,
      definitionBody: sfn.DefinitionBody.fromChainable(map),
      // STANDARD, not Express. Express caps at five minutes and does not
      // support Distributed Map at all; a fan-out of thirty pairs at four
      // retries each can legitimately outlive five minutes.
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.minutes(15),
      tracingEnabled: true,
    });

    // -----------------------------------------------------------------------
    // Routing: bus -> queue.
    // -----------------------------------------------------------------------
    // One rule, an explicit detail-type allow-list. A pattern like
    // `{ source: ["taskbuddy"] }` would also match every future event type,
    // including ones added for something other than the LLM workers.
    new events.Rule(this, "LlmJobsRule", {
      ruleName: `${APP}-llm-jobs`,
      eventBus: this.bus,
      description: "Domain events that require a model call.",
      eventPattern: {
        source: [APP],
        detailType: [
          "goal.decompose.requested",
          "goal.skill_links.requested",
          "strategy.refresh.requested",
          "checkin.submitted",
          "entry.extract.requested",
        ],
      },
      targets: [
        new targets.SqsQueue(this.jobQueue, {
          deadLetterQueue: this.dlq,
          retryAttempts: 2,
        }),
      ],
    });

    // -----------------------------------------------------------------------
    // The daily roll.
    // -----------------------------------------------------------------------
    // lib/rolling.ts decides which committed plan to keep as days pass. Today
    // that is computed on read, so the first person to load a page after
    // midnight pays for it. EventBridge Scheduler moves it to a fixed time.
    //
    // Scheduler rather than an EventBridge rule with a cron expression: it
    // understands time zones natively, so this stays correct across a DST
    // change without anyone recomputing a UTC offset.
    const schedulerRole = new iam.Role(this, "SchedulerRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com"),
    });
    this.jobQueue.grantSendMessages(schedulerRole);

    new scheduler.CfnSchedule(this, "DailyRoll", {
      name: `${APP}-daily-roll`,
      description: "Rolling-horizon reconcile, before anyone is awake to see it.",
      flexibleTimeWindow: { mode: "FLEXIBLE", maximumWindowInMinutes: 15 },
      scheduleExpression: "cron(0 4 * * ? *)",
      scheduleExpressionTimezone: "Asia/Jakarta",
      target: {
        arn: this.jobQueue.queueArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ type: "plan.roll.daily" }),
      },
    });

    new CfnOutput(this, "BusName", { value: this.bus.eventBusName });
    new CfnOutput(this, "JobQueueUrl", { value: this.jobQueue.queueUrl });
    new CfnOutput(this, "SkillLinkMachineArn", {
      value: this.skillLinkMachine.stateMachineArn,
    });
  }
}
