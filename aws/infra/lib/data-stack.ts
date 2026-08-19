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
 * Aurora PostgreSQL Serverless v2 and the network it sits in.
 *
 * Not DynamoDB: the schema is 25 tables, 24 indexes and 11 RLS policies, and seven of those
 * scope rows through a parent foreign key with an EXISTS subquery because those tables have no
 * user_id column at all. DynamoDB has no joins, no foreign keys and no RLS, so porting them
 * means re-deriving tenancy in application code - the precise failure RLS exists to prevent.
 * Aurora DSQL was rejected too: no foreign keys.
 *
 * The cluster is public because Lambda here is deliberately NOT VPC-attached. A VPC-attached
 * function reaches Bedrock, Cognito and SQS only through a NAT gateway (~$33/mo) or interface
 * endpoints (~$7.30/mo each, per AZ), either of which costs more than the rest of this
 * architecture combined.
 *
 * So it's publicly routable, exactly as the Azure Postgres firewall was opened for Vercel. What
 * is NOT carried over is the password: iamAuthentication is on and the app role is granted
 * rds_iam, which makes password auth for that role impossible rather than merely unused - a
 * caller needs a SigV4 token signed by an IAM principal in this account, valid 15 minutes. TLS
 * is enforced server-side and verified client-side against the RDS CA bundle, and RLS is forced
 * on every table with the app role NOBYPASSRLS.
 *
 * That's materially stronger than the Azure posture, where a static 32-character password was
 * the only thing between the open firewall and the data. Azure rejected token auth for a good
 * reason - an Entra token is a network round trip and connections are made constantly - but
 * that doesn't transfer: an RDS IAM token is an HMAC computed locally, no network call.
 */
export class DataStack extends Stack {
  readonly vpc: ec2.Vpc;
  readonly cluster: rds.DatabaseCluster;
  readonly clusterSg: ec2.SecurityGroup;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Public subnets only. Nothing runs in a private one: with no NAT gateway a private subnet
    // has no route to Bedrock or Cognito, and adding it is the $33/mo this design avoids. Two
    // AZs because an Aurora subnet group requires two, not because there's a second instance.
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

      // Data API deliberately off. It would let the cluster stay fully private, which is
      // tempting, but it's one HTTPS call per statement with no multi-statement mode. A
      // dashboard render fires ~21 statements, each needing BeginTransaction + set_config +
      // the statement + Commit: ~84 round trips where the pool does 63.
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

    // Two warnings are expected here, permanently. Every cdk synth prints:
    //
    //   W2508  Security group allows 0.0.0.0/0 access to sensitive port 5432
    //   W9011  RDS instance has PubliclyAccessible set to true
    //
    // Both are correct readings of the deliberate trade in this file's header. They can't be
    // suppressed either: Annotations.acknowledgeWarning() only silences CDK's own annotations, not
    // the cdk-validate plugin that emits these, so a call to it would look like the warnings had
    // been handled while changing nothing.
    //
    // So they stay, and they're load-bearing: if either one ever STOPS appearing, something
    // changed the network posture and the compensating controls need re-checking (IAM-only auth,
    // forced TLS against a pinned regional CA, forced RLS on every table).

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
