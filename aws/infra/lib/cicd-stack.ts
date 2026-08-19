import { CfnOutput, Duration, Stack, type StackProps } from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import type { Construct } from "constructs";
import {
  APP,
  CDK_QUALIFIER,
  EDGE_REGION,
  GITHUB_DEPLOY_BRANCH,
  GITHUB_OWNER,
  GITHUB_REPO,
  REGION,
} from "./config";

const GITHUB_OIDC_HOST = "token.actions.githubusercontent.com";
const GITHUB_OIDC_URL = `https://${GITHUB_OIDC_HOST}`;

// The audience aws-actions/configure-aws-credentials requests. Not "the GitHub
// default": GitHub will mint a token for any audience you ask for, and IAM
// checks this claim, so it has to match what the action sends.
const AUDIENCE = "sts.amazonaws.com";

/**
 * The identity GitHub Actions deploys as. Deployed once from a laptop; after
 * that CI maintains everything else and nothing maintains this.
 *
 * NO ACCESS KEYS. A long-lived key in a repository secret is a credential that
 * exists whether or not a workflow is running, can be exfiltrated by anything
 * that can read the runner's environment, and has to be rotated by a human who
 * will not. OIDC issues a token per job, scoped by the `sub` claim below, valid
 * for the length of that job.
 *
 * TWO ROLES, NOT ONE, and the split is the point:
 *
 *   deploy - assumable only by a workflow running on refs/heads/main. It can
 *            assume the four CDK bootstrap roles, which is what `cdk deploy`
 *            actually uses; it holds no create/update permission of its own.
 *   diff   - assumable only by a pull_request workflow. It can read, and it can
 *            assume the bootstrap LOOKUP role. It cannot assume the deploy role,
 *            so a workflow triggered from a branch cannot change production
 *            even if its YAML is edited in the same pull request. That last
 *            clause is the whole reason the roles are separate: a pull_request
 *            workflow runs the attacker's version of the workflow file.
 *
 * The deploy role is still, transitively, able to do nearly anything - the CDK
 * execution role bootstrap creates is AdministratorAccess. That is a property of
 * CDK bootstrap, not of this stack, and the branch condition is what bounds it.
 */
export class CicdStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const account = Stack.of(this).account;

    // Account-global, and there can be exactly one per URL. If a second GitHub
    // integration is ever added to this account, it reuses this provider rather
    // than creating another - a duplicate fails with EntityAlreadyExists partway
    // through a deploy.
    //
    // No thumbprint is pinned. IAM stopped requiring one for the well-known
    // public issuers, and a pinned leaf thumbprint is a time bomb: it changes
    // when GitHub rotates its certificate and every deploy fails at once.
    const provider = new iam.OpenIdConnectProvider(this, "GitHubOidc", {
      url: GITHUB_OIDC_URL,
      clientIds: [AUDIENCE],
    });

    // One specific GitHub context in one specific repository. StringEquals, not
    // StringLike: a wildcard in a `sub` condition is how these trust policies
    // end up matching every branch in the repo, including a branch someone
    // opened a pull request from.
    const principalFor = (sub: string) =>
      new iam.OpenIdConnectPrincipal(provider, {
        StringEquals: {
          [`${GITHUB_OIDC_HOST}:aud`]: AUDIENCE,
          [`${GITHUB_OIDC_HOST}:sub`]: sub,
        },
      });

    const repo = `repo:${GITHUB_OWNER}/${GITHUB_REPO}`;
    const bootstrapRole = (name: string, region: string) =>
      `arn:aws:iam::${account}:role/cdk-${CDK_QUALIFIER}-${name}-${account}-${region}`;

    // Both regions: the edge stack is deployed to us-east-1 in the same run.
    const regions = [REGION, EDGE_REGION];
    const deployableRoles = ["deploy-role", "file-publishing-role", "image-publishing-role", "lookup-role"]
      .flatMap((name) => regions.map((r) => bootstrapRole(name, r)));
    const lookupRoles = regions.map((r) => bootstrapRole("lookup-role", r));

    // Read-only calls aws/scripts/preflight.sh makes before every deploy. They
    // are enumerated rather than covered by the ReadOnlyAccess managed policy on
    // purpose: ReadOnlyAccess includes s3:GetObject on every bucket in the
    // account, which is a strange thing to hand a CI job whose stated purpose is
    // "check the layer version resolves".
    const preflightReads = new iam.PolicyStatement({
      actions: [
        "account:GetAccountInformation",
        "cloudformation:DescribeStacks",
        "cognito-idp:ListUserPools",
        "ec2:DescribeVpcs",
        "lambda:GetLayerVersion",
        "lambda:ListFunctions",
        "rds:DescribeDBClusters",
        "s3:ListAllMyBuckets",
        "sqs:ListQueues",
      ],
      // Every action here is either account-scoped or a List that does not take
      // a resource. GetLayerVersion is against AWS's own published layer, in
      // account 753240598075, so it cannot be narrowed to this account either.
      resources: ["*"],
    });

    // The CDK CLI reads the bootstrap version from SSM before it will deploy.
    const bootstrapVersion = new iam.PolicyStatement({
      actions: ["ssm:GetParameter"],
      resources: regions.map(
        (r) => `arn:aws:ssm:${r}:${account}:parameter/cdk-bootstrap/${CDK_QUALIFIER}/version`,
      ),
    });

    const deployRole = new iam.Role(this, "DeployRole", {
      roleName: `${APP}-github-deploy`,
      description: `cdk deploy from ${GITHUB_OWNER}/${GITHUB_REPO} on ${GITHUB_DEPLOY_BRANCH}`,
      assumedBy: principalFor(`${repo}:ref:refs/heads/${GITHUB_DEPLOY_BRANCH}`),
      // An Aurora parameter change can run past the one-hour default, and the
      // credentials expire mid-rollback rather than mid-deploy, which is worse.
      maxSessionDuration: Duration.hours(2),
    });
    deployRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: deployableRoles }),
    );
    deployRole.addToPolicy(preflightReads);
    deployRole.addToPolicy(bootstrapVersion);

    const diffRole = new iam.Role(this, "DiffRole", {
      roleName: `${APP}-github-diff`,
      description: `cdk diff from pull requests in ${GITHUB_OWNER}/${GITHUB_REPO}`,
      assumedBy: principalFor(`${repo}:pull_request`),
      maxSessionDuration: Duration.hours(1),
    });
    diffRole.addToPolicy(
      new iam.PolicyStatement({ actions: ["sts:AssumeRole"], resources: lookupRoles }),
    );
    diffRole.addToPolicy(preflightReads);
    diffRole.addToPolicy(bootstrapVersion);
    // `cdk diff` compares the synthesised template against the deployed one. It
    // normally does that through the lookup role above; these two make the
    // fallback path - plain caller credentials - work as well, scoped to this
    // app's stacks so a diff job cannot read templates belonging to anything
    // else in the account.
    diffRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["cloudformation:GetTemplate", "cloudformation:DescribeStackEvents"],
        resources: regions.map((r) => `arn:aws:cloudformation:${r}:${account}:stack/${APP}-*/*`),
      }),
    );

    new CfnOutput(this, "DeployRoleArn", {
      value: deployRole.roleArn,
      description: "Set as the AWS_DEPLOY_ROLE_ARN repository variable",
    });
    new CfnOutput(this, "DiffRoleArn", {
      value: diffRole.roleArn,
      description: "Set as the AWS_DIFF_ROLE_ARN repository variable",
    });
  }
}
