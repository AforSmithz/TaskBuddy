import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as rds from "aws-cdk-lib/aws-rds";
import type { Construct } from "constructs";
import {
  APP,
  DB_APP_ROLE,
  DB_AUTO_PAUSE_SECONDS,
  DB_BACKUP_RETENTION_DAYS,
  DB_MAX_ACU,
  DB_MIN_ACU,
  DB_NAME,
} from "./config";

/**
 * Aurora PostgreSQL Serverless v2, and the network it sits in.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT DYNAMODB
 * ---------------------------------------------------------------------------
 * The schema is 25 tables, 24 indexes and 11 row-level-security policies, and
 * seven of those policies (`decisions`, `open_questions`, `tasks`,
 * `task_dependencies`, `goal_criteria`, `skill_nodes`, `skill_task_links`) scope
 * rows through a parent foreign key with an EXISTS subquery, because those
 * tables have no `user_id` column at all. DynamoDB has no joins, no foreign
 * keys and no RLS, so porting them means re-deriving tenancy in application
 * code - which is the precise failure mode RLS exists to prevent. Aurora DSQL
 * was also rejected: it does not support foreign keys.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CLUSTER IS PUBLIC, AND WHAT DEFENDS IT
 * ---------------------------------------------------------------------------
 * Lambda functions here are deliberately NOT VPC-attached. A VPC-attached
 * function reaches Bedrock, Cognito and SQS only through a NAT gateway
 * (~$33/mo) or interface endpoints (~$7.30/mo each, per AZ) - either one costs
 * more than the rest of this architecture combined and would consume the whole
 * credit allowance on plumbing.
 *
 * So the cluster is publicly routable, exactly as the Azure Postgres firewall
 * was opened for Vercel. What is NOT carried over is the password:
 *
 *   - `iamAuthentication` is on and the app role is granted `rds_iam`, which in
 *     Postgres makes password authentication for that role IMPOSSIBLE rather
 *     than merely unused. A caller needs a SigV4 token signed by an IAM
 *     principal in this account, valid for 15 minutes.
 *   - TLS is enforced server-side (`rds.force_ssl=1`) and verified client-side
 *     against the RDS CA bundle.
 *   - RLS is forced on every table, and the app role is `NOBYPASSRLS`.
 *
 * That is materially stronger than the Azure posture it replaces, where a
 * static 32-character password was the only thing between the open firewall and
 * the data. Azure rejected token auth for a good reason - acquiring an Entra
 * token is a network round trip, and `idleTimeoutMillis: 10s` means connections
 * are made constantly. That reason does not transfer: an RDS IAM token is an
 * HMAC computed locally from credentials the function already holds, with no
 * network call at all.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly cluster: rds.DatabaseCluster;
  readonly clusterSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Public subnets only. There is no private subnet because nothing runs in
    // one: no NAT gateway means a private subnet has no route to Bedrock or
    // Cognito, and adding the route is the $33/mo this design exists to avoid.
    // Two AZs because an Aurora subnet group requires two, not because there is
    // a second instance to put in one.
    this.vpc = new ec2.Vpc(this, "Vpc", {
      vpcName: `${APP}-vpc`,
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    this.clusterSg = new ec2.SecurityGroup(this, "ClusterSg", {
      vpc: this.vpc,
      securityGroupName: `${APP}-db`,
      description:
        "Aurora ingress. Open on 5432 because Lambda has no static egress IP " +
        "without a NAT gateway; IAM auth + forced TLS + RLS are the controls.",
      allowAllOutbound: false,
    });
    this.clusterSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(5432),
      "Postgres from Lambda (no static egress IP available)",
    );

    // force_ssl is the half of the TLS story the client cannot provide. Without
    // it a client that forgot `ssl: {...}` connects in cleartext and nothing
    // complains; with it the server refuses.
    const parameterGroup = new rds.ParameterGroup(this, "ClusterParams", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      description: `${APP} cluster parameters`,
      parameters: {
        "rds.force_ssl": "1",
        // A transaction left open by a crashed request holds a connection and,
        // worse here than on Azure, keeps the cluster from ever auto-pausing.
        // This is both the connection-leak guard and a cost control.
        idle_in_transaction_session_timeout: "30000",
        // Every statement the app issues is sub-second; anything past 15s is a
        // runaway that would otherwise hold capacity awake.
        statement_timeout: "15000",
        log_min_duration_statement: "1000",
      },
    });

    this.cluster = new rds.DatabaseCluster(this, "Cluster", {
      clusterIdentifier: `${APP}-db`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_13,
      }),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [this.clusterSg],
      parameterGroup,
      defaultDatabaseName: DB_NAME,

      // The master credential. Rotated by Secrets Manager, used ONLY by
      // aws/scripts/apply-sql.sh and the break-glass path - never by the app,
      // which authenticates as DB_APP_ROLE with an IAM token.
      credentials: rds.Credentials.fromGeneratedSecret("taskbuddy_admin", {
        secretName: `${APP}/db/master`,
      }),

      // The whole point. See config.ts: min 0 is the cost control.
      serverlessV2MinCapacity: DB_MIN_ACU,
      serverlessV2MaxCapacity: DB_MAX_ACU,
      serverlessV2AutoPauseDuration: Duration.seconds(DB_AUTO_PAUSE_SECONDS),

      writer: rds.ClusterInstance.serverlessV2("writer", {
        // Reachable from outside the VPC. Without this the public subnet placement
        // does nothing and every connection times out - a failure that looks like
        // a security group problem and is not.
        publiclyAccessible: true,
        // No reader instance. A reader would double the ACU floor and, because
        // it holds its own connections, would keep the cluster from pausing.
        enablePerformanceInsights: false,
      }),

      // Lets the app authenticate with a SigV4 token instead of a password.
      iamAuthentication: true,

      // Data API deliberately OFF. It would let the cluster stay fully private,
      // which is tempting - but it is one HTTPS call per statement and has no
      // multi-statement mode. A dashboard render fires ~21 statements, each
      // needing BeginTransaction + set_config + the statement + Commit: ~84
      // round trips where the current pool does 63. See aws/README.md.
      enableDataApi: false,

      storageEncrypted: true,
      // 1 day, not 7: the Free account plan caps it. See DB_BACKUP_RETENTION_DAYS.
      backup: {
        retention: Duration.days(DB_BACKUP_RETENTION_DAYS),
        preferredWindow: "17:00-18:00",
      },
      // 17:00 UTC is midnight in Jakarta - outside the hours anyone is using it,
      // and inside the window the cluster would be paused anyway.
      preferredMaintenanceWindow: "Sun:18:00-Sun:19:00",
      cloudwatchLogsExports: ["postgresql"],
      monitoringInterval: Duration.seconds(0),
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // -----------------------------------------------------------------------
    // TWO WARNINGS ARE EXPECTED HERE, PERMANENTLY.
    // -----------------------------------------------------------------------
    // Every `cdk synth` prints:
    //
    //   W2508  Security group allows 0.0.0.0/0 access to sensitive port 5432
    //   W9011  RDS instance has PubliclyAccessible set to true
    //
    // Both are correct readings of a deliberate trade, explained in this file's
    // header: Lambda has no static egress IP without a NAT gateway, and a NAT
    // gateway (~$33/mo) or the interface endpoints that would replace it
    // (~$7.30/mo each, per AZ) cost more than everything else in this
    // architecture combined.
    //
    // They cannot be suppressed. `Annotations.acknowledgeWarning` only silences
    // CDK's own annotations, not the cdk-validate plugin that emits these - a
    // call to it here would look like the warnings had been handled while
    // changing nothing, which is worse than leaving them visible.
    //
    // So they stay, and they are load-bearing documentation: if either one ever
    // STOPS appearing, something changed the network posture and the
    // compensating controls below need re-checking. Those controls are IAM-only
    // authentication (`rds_iam` makes password auth impossible for the app
    // role - see aws/sql/02_grants.sql), forced TLS against a pinned regional
    // CA, and forced RLS on every table.

    new CfnOutput(this, "ClusterEndpoint", {
      value: this.cluster.clusterEndpoint.hostname,
      description: "Aurora writer endpoint (PGHOST)",
      exportName: `${APP}-db-endpoint`,
    });
    new CfnOutput(this, "ClusterResourceId", {
      value: this.cluster.clusterResourceIdentifier,
      description:
        "Used in the rds-db:connect IAM resource ARN. Note this is the cluster " +
        "RESOURCE id (cluster-XXXX), not the cluster identifier - policies " +
        "written against the identifier silently grant nothing.",
    });
    new CfnOutput(this, "MasterSecretArn", {
      value: this.cluster.secret?.secretArn ?? "none",
      description: "Master credential, for apply-sql.sh only",
    });
    new CfnOutput(this, "AppDbRole", { value: DB_APP_ROLE });
  }
}
