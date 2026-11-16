import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { NagSuppressions } from 'cdk-nag';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';

const DEFAULT_CONFIG = {
  concurrency: 3,
  neighbourRadius: 1,
  instanceType: 't4g.medium',
  loopIntervalSeconds: 30,
  model: null,
  // Pass 7: pluggable coordination algorithms. "amorphous" is the default
  // (ring neighbours at radius R). "mesh" reads every other agent. "swarm"
  // reads the K most recently active agents via S3 LastModified.
  // Pass 8: "single" is a lone-agent mode for specialised roles in
  // WeltenBuilder multi-cluster setups (deployer, reviewer, integration
  // coordinator). Also usable as a single-cluster long-running worker.
  // Agent compute backend. "ec2" = one instance per agent (the original).
  // "ecs" = one Fargate ARM64 task per agent. Restart-required.
  computeType: 'ecs' as 'ec2' | 'ecs',
  // Fargate task size (ecs only) — applied as RunTask cpu/memory overrides.
  // small 2/4, medium 4/8 (default), large 8/16, xlarge 16/32 (vCPU/GiB).
  taskSize: 'medium' as 'small' | 'medium' | 'large' | 'xlarge',
  algorithm: 'amorphous' as 'amorphous' | 'mesh' | 'swarm' | 'single',
  // Only used when algorithm === "swarm". Must be 1..concurrency-1.
  swarmK: 4,
  // When true (default), the cluster pauses itself after every agent
  // reports `action: "idle"` for three consecutive iterations. Off lets a
  // forgotten cluster keep iterating and billing.
  autopause: true,
  // Pass 8: when true, after each iteration every agent appends a
  // self-reflection block to its own per-agent directive file. Cluster
  // direction stays untouched. Independent of `algorithm` — works
  // identically across amorphous, mesh, swarm, and single, at any
  // cluster size.
  selfOptimizing: false,
  // When true, agents get a Puppeteer MCP server for headless browser
  // automation (screenshots, page interaction, testing).
  browserAutomation: false,
};

/**
 * The tag `cdk deploy` puts on every stack an agent deploys (deployMcp.ts
 * passes `--tags`), and on every resource in it that CloudFormation can tag.
 *
 * It is what lets the rest of this stack tell an agent-made stack from any
 * other in the account: the Lambda may only delete stacks that carry it, and a
 * deployer agent may only push to CodeCommit repositories that carry it. Change
 * the key here and in deployMcp.ts together.
 */
const DEPLOY_TAG_KEY = 'KiroFlockManaged';
/** Qualifier of the bootstrap deployer clusters use. Mirrors agent/deployMcp.ts and scripts/install.sh. */
const AGENT_BOOTSTRAP_QUALIFIER = 'kflock';
/** Prefix for deploy source snapshots; DeployerRole writes, AgentRole is denied. Mirrors agent/deployMcp.ts. */
const DEPLOY_SRC_PREFIX = 'deploy-src';
const DEPLOY_TAG_VALUE = 'true';

export class AgaStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------- Build the agent bundle up-front (synth-time step) ----------
    // esbuild-bundles agent/bootstrap.ts + copies runtime assets into
    // dist/agent-bundle/. BucketDeployment zips and uploads this folder.
    const repoRoot = path.resolve(__dirname, '..', '..');
    execSync('node scripts/build-agent-bundle.js', {
      cwd: repoRoot,
      stdio: 'inherit',
    });

    const agentBundleDir = path.join(repoRoot, 'dist', 'agent-bundle');

    // ---------- Agent container image (ECS compute) ----------
    // Assemble a minimal build context at dist/agent-image/ so the image
    // asset hash tracks exactly what the image contains (Dockerfile,
    // entrypoint, agent bundle) and nothing else — pointing the asset at
    // the repo root would drag node_modules into the context and bust the
    // cache on every unrelated change. Local builds use finch; CDK picks
    // it up via the CDK_DOCKER env var (exported by scripts/install.sh).
    const agentImageDir = path.join(repoRoot, 'dist', 'agent-image');
    fs.rmSync(agentImageDir, { recursive: true, force: true });
    fs.mkdirSync(agentImageDir, { recursive: true });
    fs.cpSync(agentBundleDir, path.join(agentImageDir, 'agent-bundle'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, 'docker', 'Dockerfile.agent'), path.join(agentImageDir, 'Dockerfile'));
    fs.copyFileSync(path.join(repoRoot, 'docker', 'entrypoint.sh'), path.join(agentImageDir, 'entrypoint.sh'));

    const agentImage = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: agentImageDir,
      platform: ecrAssets.Platform.LINUX_ARM64,
    });

    // ---------- VPC ----------
    // Multi-AZ public subnets, IGW attached. Agents get public IPs so they
    // can reach S3 / Kiro endpoints without a NAT gateway. Spreading across
    // three AZs lets the launcher fall back to another AZ when one runs out
    // of capacity for the chosen instance type (InsufficientInstanceCapacity).
    const vpc = new ec2.Vpc(this, 'AgaVpc', {
      maxAzs: 3,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });
    // Flow logs: the agents have unrestricted egress (they fetch dependencies
    // and call Kiro), so the one record of where they connected is this.
    vpc.addFlowLog('FlowLog', {
      destination: ec2.FlowLogDestination.toCloudWatchLogs(
        new logs.LogGroup(this, 'VpcFlowLogs', {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
      ),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    const sg = new ec2.SecurityGroup(this, 'AgentSg', {
      vpc,
      description: 'AGA agent instances - outbound only',
      allowAllOutbound: true,
    });
    // Allow all TCP traffic between agents in the same security group.
    // Required for local-mode deployments where one agent serves a workload
    // and other agents (or the test cluster) connect to it over the private network.
    sg.addIngressRule(sg, ec2.Port.allTcp(), 'intra-cluster agent traffic');

    // ---------- S3 bucket ----------
    const accessLogsBucket = new s3.Bucket(this, 'AgaAccessLogsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
    });

    const bucket = new s3.Bucket(this, 'AgaBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: accessLogsBucket,
      serverAccessLogsPrefix: 'access-logs/',
    });

    // Web dashboard assets → s3://bucket/web/
    // Includes the shared envPanel module so the dashboard and
    // WeltenBuilder render identical environment trees from one codebase.
    // version.js is generated from version.json and included in all UIs.
    const versionJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'version.json'), 'utf8'));
    const versionJs = [
      `window.KIRO_FLOCK_VERSION="${versionJson.version}";`,
      `document.addEventListener("DOMContentLoaded",function(){`,
      `  document.querySelectorAll(".version-label").forEach(function(el){el.textContent=window.KIRO_FLOCK_VERSION;});`,
      `});`,
    ].join('\n');
    const versionSource = s3deploy.Source.data('version.js', versionJs);

    new s3deploy.BucketDeployment(this, 'WebAssets', {
      sources: [
        s3deploy.Source.asset(path.join(repoRoot, 'web')),
        s3deploy.Source.asset(path.join(repoRoot, 'web-shared')),
        versionSource,
      ],
      destinationBucket: bucket,
      destinationKeyPrefix: 'web',
      prune: false,
    });

    // NOTE: the former WeltenBuilder (welten-web/) and Everforge
    // (forge-web/) deployments are gone — all three UIs merged into the
    // unified accordion shell shipped by WebAssets above. The legacy
    // /welten and /forge routes serve web/legacy-redirect.html (below)
    // so old bookmarks land on the matching accordion section.

    // Agent bundle → s3://bucket/agent/*
    new s3deploy.BucketDeployment(this, 'AgentBundle', {
      sources: [s3deploy.Source.asset(agentBundleDir)],
      destinationBucket: bucket,
      destinationKeyPrefix: 'agent',
      prune: false,
    });

    // Seed initial cluster config for the default cluster (cluster_0).
    // Per-cluster config now lives under `{clusterId}/config.json`. The
    // Lambda and agent code both default to `cluster_0` when no explicit
    // cluster id is provided, which preserves backwards compatibility for
    // standalone kiro-flock installs.
    new s3deploy.BucketDeployment(this, 'SeedConfig', {
      sources: [
        s3deploy.Source.jsonData('cluster_0/config.json', DEFAULT_CONFIG),
      ],
      destinationBucket: bucket,
      prune: false,
    });

    // Seed the cluster registry with a single default entry. WeltenBuilder
    // and the backwards-compatible single-cluster API both read this file
    // to enumerate clusters. Seeding it on first deploy avoids a bootstrap
    // race where the UI loads before any cluster has been created.
    const defaultRegistry = {
      clusters: [
        {
          id: 'cluster_0',
          name: 'cluster_0',
          algorithm: DEFAULT_CONFIG.algorithm,
          createdAt: '1970-01-01T00:00:00.000Z',
        },
      ],
    };
    new s3deploy.BucketDeployment(this, 'SeedRegistry', {
      sources: [
        s3deploy.Source.jsonData('clusters.json', defaultRegistry),
      ],
      destinationBucket: bucket,
      prune: false,
    });

    // ---------- IAM for agents ----------
    // Two roles, one set of runtime permissions. Both backends use them the
    // same way: EC2 assumes a role via its instance profile, ECS as the task
    // role; the agent code is identical.
    //
    //   AgentRole     every cluster. S3 scopes below, metrics, SSM session.
    //   DeployerRole  only clusters started with `trustDeploy: true`. The
    //                 same, plus the right to assume the CDK bootstrap roles
    //                 and so to run `cdk deploy`.
    //
    // They are separate so that `trustDeploy` is an IAM boundary and not just
    // a flag the Deploy MCP reads. With one shared role every agent could
    // assume the bootstrap deploy role, which with a default `cdk bootstrap`
    // runs CloudFormation as an administrator; a cluster configured not to
    // deploy was only prevented from doing so by its own tooling. The Lambda
    // launches a cluster on whichever role its config calls for
    // (ecsManager.ts / ec2Manager.ts pick the task definition and instance
    // profile), and a running cluster cannot switch.
    const agentPrincipals = new iam.CompositePrincipal(
      new iam.ServicePrincipal('ec2.amazonaws.com'),
      new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    );
    const agentRole = new iam.Role(this, 'AgentRole', { assumedBy: agentPrincipals });
    const deployerRole = new iam.Role(this, 'DeployerRole', { assumedBy: agentPrincipals });
    // Everything below up to the instance profiles is attached to both roles.
    const agentPolicy = new iam.Policy(this, 'AgentPolicy', { roles: [agentRole, deployerRole] });
    const forBothRoles = (statement: iam.PolicyStatement): void => agentPolicy.addStatements(statement);
    // Scoped S3 access for the multi-cluster layout (req 6.3).
    //
    // Layout recap:
    //   clusters.json                 — registry, operator-only
    //   web/, agent/, history/,       — operator/infra-only
    //   knowledge-base/               — operator-curated, read-only for agents
    //   environment/                  — shared across all clusters (read/write)
    //     environment/{clusterId}/    — each cluster's primary workspace
    //   {clusterId}/config.json       — per-cluster, read-only for agents
    //   {clusterId}/direction.md      — per-cluster, read-only for agents
    //   {clusterId}/store/            — per-cluster, read/write for agents
    //     state.json                  — read/write for agents (Starting →
    //                                   Running and autopause transitions)
    //     agent-N.ndjson              — agent's own log
    //
    // We cannot constrain the cluster_id at IAM level without session tags,
    // so these policies use `*/...` wildcards that match any cluster prefix.
    // The agent code is the source of truth for which cluster it belongs to
    // (driven by AGA_CLUSTER_PREFIX at boot, see userData.ts + bootstrap.ts).
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        // Shared reads across all clusters.
        bucket.arnForObjects('agent/*'),
        bucket.arnForObjects('environment/*'),
        bucket.arnForObjects('knowledge-base/*'),
        // Per-cluster reads — `*/foo` matches `{clusterId}/foo` for any cluster.
        // Stores are readable across clusters so agents can observe each other
        // (used by neighbour selection even though agents only coordinate
        // within their own cluster in the common case).
        bucket.arnForObjects('*/config.json'),
        bucket.arnForObjects('*/direction.md'),
        bucket.arnForObjects('*/store/*'),
      ],
    }));
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [
        // Per-cluster store writes — each agent writes its own NDJSON log
        // and (for Starting → Running and autopause) state.json. Lambda
        // is the primary state.json author; agents only flip running →
        // paused (autopause) and starting → running with an If-Match
        // precondition so an in-flight operator transition wins.
        bucket.arnForObjects('*/store/*'),
        // Shared environment — agents write primarily to their own cluster
        // subfolder (environment/{clusterId}/) but the design allows
        // cross-cluster writes anywhere under environment/ when direction
        // requires it (req 3.4).
        bucket.arnForObjects('environment/*'),
        // knowledge-base/* is intentionally NOT in this list. Agents read
        // the kb as reference material but must not write to it — that
        // prerogative belongs to the operator, via kb_upload on the MCP
        // side, which runs under the operator's own AWS credentials, not
        // the agent role. Earlier builds allowed agents to write here; the
        // cluster then filled the kb with inter-agent debates and ghost
        // "orchestration skill" docs that subsequent runs then cited back
        // as authoritative. See the explicit Deny statement below for
        // defence-in-depth.
        // clusters.json is also absent here — agents must never edit the
        // cluster registry. Only the Lambda (operator) writes that file.
      ],
    }));
    // Allow agents to delete files in environment/ only. This lets them
    // clean up build artifacts, remove stale .ts files after compiling to
    // .js, and keep the workspace tidy. DeleteObject is NOT granted on
    // store/, knowledge-base/, or any other prefix.
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:DeleteObject'],
      resources: [bucket.arnForObjects('environment/*')],
    }));
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': [
            'agent/*',
            'environment/*',
            'knowledge-base/*',
            '*/store/*',
          ],
        },
      },
    }));
    // Explicit deny on sensitive prefixes as defence-in-depth.
    // `*/direction.md` and `*/config.json` prevent agents from altering
    // their own (or any cluster's) instructions or config. Only the
    // Lambda (operator) may write those.
    // knowledge-base/* is operator-curated read-only reference material.
    // Agents read it but must not write; kb_upload_* tools on the MCP
    // side use operator credentials, not this role.
    // clusters.json is the cluster registry — agents must never touch it.
    // state.json is intentionally NOT denied: agents need to write it for
    // the Starting → Running and autopause transitions. Operator writes
    // are unconditional (always win on race), agent writes use If-Match
    // so an in-flight operator transition aborts the agent's write
    // silently. The blast radius of a compromised agent here is "make a
    // running cluster look paused for one snapshot rebuild" — a
    // pre-existing capability via the agent's existing log writes which
    // can already produce misleading dashboard output.
    forBothRoles(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [
        bucket.arnForObjects('web/*'),
        bucket.arnForObjects('agent/*'),
        bucket.arnForObjects('history/*'),
        bucket.arnForObjects('knowledge-base/*'),
        bucket.arnForObjects('clusters.json'),
        // Deploy trust markers: written by the Lambda on cluster start, read
        // by the Deploy MCP. An agent must not be able to trust itself.
        bucket.arnForObjects('store/approvals/*'),
        // Per-cluster control files — all wildcarded so every cluster is
        // covered, not just the agent's own.
        bucket.arnForObjects('*/config.json'),
        bucket.arnForObjects('*/direction.md'),
        // Legacy flat paths retained for defence-in-depth in case an old
        // layout ever reappears. Cheap to include.
        bucket.arnForObjects('config.json'),
        bucket.arnForObjects('direction.md'),
      ],
    }));
    // ---------- Deployment flow: trust markers at store/approvals/ ----------
    // The root-level `store/approvals/` prefix is NOT matched by `*/store/*`
    // (that pattern requires at least one character before the slash). The
    // Lambda writes a marker per agent on cluster start when `trustDeploy` is
    // set; the Deploy MCP reads its own. Read and list only: an agent that
    // could write here could mark itself trusted. Writes and deletes are in
    // the explicit deny above as well.
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [bucket.arnForObjects('store/approvals/*')],
    }));
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['store/approvals/*'] },
      },
    }));

    // ---------- Deployment flow: remote-mode CDK deploy permissions ----------
    // Deployer clusters only. The agent assumes CDK bootstrap roles to run
    // `cdk deploy`; the deploy role does the CloudFormation / PassRole work, so
    // the agent never holds iam:PassRole itself.
    //
    // Not the account's default bootstrap (qualifier hnb659fds): its deploy
    // role may change or delete any stack and its execution role is an
    // administrator. Deployer clusters use the `kflock` bootstrap that
    // install.sh creates from cdk/bootstrap/agent-bootstrap.template.yaml. Its
    // deploy role only touches stacks tagged KiroFlockManaged=true (and cannot
    // add that tag to a stack that lacks it, since tagging is an update), and
    // its execution role runs under a scoped policy plus a permissions boundary
    // that every role an agent stack creates must carry. The Deploy MCP passes
    // the qualifier to `cdk deploy`; a bare `cdk deploy` from an agent shell
    // fails at IAM because AgentRole and DeployerRole cannot assume hnb659fds.
    deployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [
        `arn:aws:iam::${this.account}:role/cdk-${AGENT_BOOTSTRAP_QUALIFIER}-deploy-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-${AGENT_BOOTSTRAP_QUALIFIER}-file-publishing-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-${AGENT_BOOTSTRAP_QUALIFIER}-image-publishing-role-${this.account}-${this.region}`,
        `arn:aws:iam::${this.account}:role/cdk-${AGENT_BOOTSTRAP_QUALIFIER}-lookup-role-${this.account}-${this.region}`,
      ],
    }));
    forBothRoles(new iam.PolicyStatement({
      actions: [
        'cloudformation:DescribeStacks',
        'cloudformation:GetTemplate',
        'cloudformation:DescribeStackEvents',
        'cloudformation:DescribeStackResources',
        'cloudformation:ListStacks',
      ],
      resources: ['*'],
    }));
    // Read-only, and only used to resolve a deployed site URL for the
    // deployment record. Agent-authored CDK stacks routinely omit a SiteUrl
    // output, and a distribution's physical id (E1ABCDEF) has no derivable
    // relationship to its default domain (d111111abcdef8.cloudfront.net), so
    // DescribeStackResources alone cannot get us there — the domain has to be
    // read from CloudFront. Without this the Forge live-preview pane stays
    // empty for every CloudFront-fronted stack that forgot its output.
    forBothRoles(new iam.PolicyStatement({
      actions: ['cloudfront:GetDistribution'],
      resources: ['*'],
    }));
    deployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/cdk-bootstrap/${AGENT_BOOTSTRAP_QUALIFIER}/*`],
    }));
    // ---------- Deployment flow: deploy-src/ snapshots ----------
    // Every agent may write anywhere under environment/, so a cluster started
    // without trustDeploy could place the CDK app a deployer cluster then
    // deploys. The Deploy MCP therefore copies the folder it is about to deploy
    // to deploy-src/<group>/<stack>/<time>/ first and records that prefix in the
    // deployment record. Only DeployerRole can write there; AgentRole is denied
    // explicitly below. The snapshot is the source of record for what was
    // deployed, and nothing a non-deployer cluster can alter afterwards.
    deployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects(`${DEPLOY_SRC_PREFIX}/*`)],
    }));
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [bucket.arnForObjects(`${DEPLOY_SRC_PREFIX}/*`)],
    }));
    forBothRoles(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: { StringLike: { 's3:prefix': [`${DEPLOY_SRC_PREFIX}/*`] } },
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [bucket.arnForObjects(`${DEPLOY_SRC_PREFIX}/*`)],
    }));

    forBothRoles(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    // SSM managed instance core — lets us connect via Session Manager if needed
    for (const role of [agentRole, deployerRole]) {
      role.addManagedPolicy(iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'));
    }
    // ECS Exec channel permissions (ecs backend). Fargate tasks aren't SSM
    // managed instances, so RunCommand can't reach them — ECS Exec embeds a
    // Session Manager agent in the task instead, talking over ssmmessages.
    // Tasks launch with enableExecuteCommand (see ecsManager.ts); this is
    // the task-role half of that handshake. Groundwork for reimplementing
    // the live agent streams on ECS via ExecuteCommand.
    forBothRoles(new iam.PolicyStatement({
      actions: [
        'ssmmessages:CreateControlChannel',
        'ssmmessages:CreateDataChannel',
        'ssmmessages:OpenControlChannel',
        'ssmmessages:OpenDataChannel',
      ],
      resources: ['*'],
    }));
    // Allow agents to read the Kiro API key from SSM Parameter Store
    forBothRoles(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter/aga/kiro-api-key`],
    }));
    // CodeCommit: deployer clusters may need to clone, pull and push to
    // repositories their own stacks created (continuous-deployment content
    // pipelines). Deployer only - a cluster that cannot deploy has no such
    // repositories - and only repositories carrying the tag `cdk deploy`
    // puts on every resource of an agent stack (see deployMcp.ts), so the
    // account's other repositories are out of reach. ListRepositories has no
    // resource to scope and is harmless.
    deployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codecommit:GitPull', 'codecommit:GitPush', 'codecommit:GetRepository'],
      resources: [`arn:aws:codecommit:${this.region}:${this.account}:*`],
      conditions: {
        StringEquals: { [`aws:ResourceTag/${DEPLOY_TAG_KEY}`]: DEPLOY_TAG_VALUE },
      },
    }));
    deployerRole.addToPolicy(new iam.PolicyStatement({
      actions: ['codecommit:ListRepositories'],
      resources: ['*'],
    }));
    const instanceProfile = new iam.CfnInstanceProfile(this, 'AgentInstanceProfile', {
      roles: [agentRole.roleName],
    });
    const deployerInstanceProfile = new iam.CfnInstanceProfile(this, 'DeployerInstanceProfile', {
      roles: [deployerRole.roleName],
    });

    // ---------- ECS (Fargate) compute backend ----------
    // One standalone Fargate ARM64 task per agent, launched by the
    // handler via RunTask (lambda/ecsManager.ts). No service — tasks are
    // the flock's unit of lifecycle, exactly like EC2 instances are on
    // the ec2 backend. Runs in the same public subnets with the same
    // security group; assignPublicIp gives tasks the outbound path to
    // S3 / Kiro endpoints without a NAT.
    const ecsCluster = new ecs.Cluster(this, 'AgaEcsCluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
    });

    // The Kiro API key arrives as a container secret resolved by the ECS
    // execution role from the same SSM parameter the EC2 user-data reads.
    // install.sh step 4 writes the parameter; tasks started before that
    // fail fast with a clear ResourceInitializationError.
    const kiroApiKeyParam = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'KiroApiKeyParam', {
      parameterName: '/aga/kiro-api-key',
    });

    const agentLogGroup = new logs.LogGroup(this, 'AgentTaskLogs', {
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Two task definitions that differ only in their task role (see the IAM
    // section). The Lambda launches a cluster on the deployer one exactly when
    // its config says `trustDeploy: true`.
    const taskDefinitionFor = (id: string, family: string, taskRole: iam.Role): ecs.FargateTaskDefinition => {
      const def = new ecs.FargateTaskDefinition(this, id, {
        family,
        // t4g.medium equivalence (2 vCPU / 4 GiB) — the same default the
        // EC2 backend launches. Task sizing is fixed per deployment for
        // now; config.instanceType only applies to the ec2 backend.
        cpu: 2048,
        memoryLimitMiB: 4096,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        taskRole,
      });
      def.addContainer('agent', {
        image: ecs.ContainerImage.fromDockerImageAsset(agentImage),
        logging: ecs.LogDrivers.awsLogs({
          logGroup: agentLogGroup,
          streamPrefix: 'aga-agent',
        }),
        secrets: {
          KIRO_API_KEY: ecs.Secret.fromSsmParameter(kiroApiKeyParam),
        },
        // Per-agent config (AGA_AGENT_CONFIG) is injected at RunTask time
        // via container overrides — nothing agent-specific is baked here.
      });
      return def;
    };
    const agentTaskDef = taskDefinitionFor('AgentTaskDef', 'aga-agent', agentRole);
    const deployerTaskDef = taskDefinitionFor('DeployerTaskDef', 'aga-deployer', deployerRole);
    const agentContainer = agentTaskDef.defaultContainer!;

    // ---------- AMI ----------
    const amiImage = ec2.MachineImage.latestAmazonLinux2023({
      cpuType: ec2.AmazonLinuxCpuType.ARM_64,
    });
    // Resolve the AMI ID for this stack's region at synth time so the Lambda
    // can pass it straight through to RunInstances.
    const amiId = amiImage.getImage(this).imageId;

    // ---------- Lambda ----------
    const fn = new NodejsFunction(this, 'IncubatorFn', {
      entry: path.join(repoRoot, 'lambda/handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(120),
      // 512MB ≈ 4x CPU vs the 128MB default. /cluster/list fans out to
      // S3 in parallel for every cluster; CPU saturates fast at low
      // memory and pushes per-invocation latency into the second
      // (visible to the WeltenBuilder polling indicator).
      memorySize: 512,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        AMI_ID: amiId,
        SECURITY_GROUP_ID: sg.securityGroupId,
        INSTANCE_PROFILE_ARN: instanceProfile.attrArn,
        DEPLOYER_INSTANCE_PROFILE_ARN: deployerInstanceProfile.attrArn,
        DEPLOY_TAG_KEY,
        DEPLOY_TAG_VALUE,
        // Comma-separated public subnet IDs, one per AZ. The launcher spreads
        // instances across them and falls back to another AZ on
        // InsufficientInstanceCapacity. SUBNET_ID (singular) is kept for
        // backwards compatibility with the handler's env fallback.
        SUBNET_IDS: vpc.publicSubnets.map((s) => s.subnetId).join(','),
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        CONCURRENCY_CAP: '64',
        // Tell the Node SDK to keep TCP connections alive across S3
        // calls inside one invocation, dramatically reducing the cost
        // of the parallel fan-out in /cluster/list.
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    bucket.grantReadWrite(fn);

    // ---------- ECS compute wiring for the API handler ----------
    // Env vars consumed by lambda/ecsManager.ts (ecsContextFromEnv).
    fn.addEnvironment('ECS_CLUSTER_ARN', ecsCluster.clusterArn);
    fn.addEnvironment('ECS_TASK_DEF_ARN', agentTaskDef.taskDefinitionArn);
    fn.addEnvironment('ECS_DEPLOYER_TASK_DEF_ARN', deployerTaskDef.taskDefinitionArn);
    fn.addEnvironment('ECS_CONTAINER_NAME', agentContainer.containerName);
    fn.addEnvironment('ECS_SUBNET_IDS', vpc.publicSubnets.map((s) => s.subnetId).join(','));
    fn.addEnvironment('ECS_SECURITY_GROUP', sg.securityGroupId);

    // RunTask on the agent task definition, constrained to our cluster.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:RunTask'],
      resources: [agentTaskDef.taskDefinitionArn, deployerTaskDef.taskDefinitionArn],
      conditions: {
        ArnEquals: { 'ecs:cluster': ecsCluster.clusterArn },
      },
    }));
    // RunTask with tags additionally requires ecs:TagResource on the task
    // being created. Constrained to tags applied at RunTask time (the
    // ecs:CreateAction condition) so the handler can't retag existing
    // resources.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:TagResource'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'ecs:CreateAction': 'RunTask' },
      },
    }));
    // Task lifecycle + inspection + live tails, constrained to our
    // cluster. StopTask / DescribeTasks / ExecuteCommand resources are
    // task ARNs (unpredictable ids), so the ecs:cluster condition carries
    // the scoping. ExecuteCommand powers the agent-stream route on ecs
    // compute (ECS Exec session in place of SSM RunCommand).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:StopTask', 'ecs:DescribeTasks', 'ecs:ListTasks', 'ecs:ExecuteCommand'],
      resources: ['*'],
      conditions: {
        ArnEquals: { 'ecs:cluster': ecsCluster.clusterArn },
      },
    }));
    // Console tails on ecs compute read the task's awslogs stream.
    fn.addEnvironment('AGENT_LOG_GROUP', agentLogGroup.logGroupName);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['logs:GetLogEvents'],
      resources: [agentLogGroup.logGroupArn, `${agentLogGroup.logGroupArn}:*`],
    }));
    // RunTask passes both the task role (agentRole) and the execution
    // role to ECS.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [
        agentRole.roleArn,
        deployerRole.roleArn,
        agentTaskDef.obtainExecutionRole().roleArn,
        deployerTaskDef.obtainExecutionRole().roleArn,
      ],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
      },
    }));

    // Snapshot builder Lambda. Runs asynchronously, writes
    // store/cluster-snapshot.json. The API handler invokes it whenever
    // /cluster/status finds the snapshot missing or stale. Bundled the
    // same way as the API handler (NodejsFunction + esbuild).
    const snapshotBuilderFn = new NodejsFunction(this, 'SnapshotBuilderFn', {
      entry: path.join(repoRoot, 'lambda/snapshotBuilder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // Scoped S3 access for the snapshot builder. Reads every per-cluster
    // store file plus config.json under any cluster prefix; writes the
    // snapshot back under the same cluster's prefix. Wildcards on
    // `*/...` match `{clusterId}/...` for any registered cluster — the
    // Lambda is invoked with a specific clusterId and constrains which
    // prefix it actually touches at the application level.
    snapshotBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        bucket.arnForObjects('*/store/*'),
        bucket.arnForObjects('*/config.json'),
        // Pricing catalog written by install.sh — read on every snapshot
        // build to compute infraCostUsd. Without this grant the builder
        // gets AccessDenied and silently reports infra cost as unknown.
        bucket.arnForObjects('config/pricing.json'),
      ],
    }));
    snapshotBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['*/store/*'] },
      },
    }));
    snapshotBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects('*/store/cluster-snapshot.json')],
    }));
    snapshotBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));
    // ECS fleet describe for ecs-compute clusters (describeFleet branch).
    snapshotBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
      resources: ['*'],
      conditions: {
        ArnEquals: { 'ecs:cluster': ecsCluster.clusterArn },
      },
    }));
    snapshotBuilderFn.addEnvironment('ECS_CLUSTER_ARN', ecsCluster.clusterArn);
    snapshotBuilderFn.addEnvironment('ECS_TASK_DEF_ARN', agentTaskDef.taskDefinitionArn);
    snapshotBuilderFn.addEnvironment('ECS_CONTAINER_NAME', agentContainer.containerName);
    snapshotBuilderFn.addEnvironment('ECS_SUBNET_IDS', vpc.publicSubnets.map((s) => s.subnetId).join(','));
    snapshotBuilderFn.addEnvironment('ECS_SECURITY_GROUP', sg.securityGroupId);
    snapshotBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));

    // Let the API handler invoke the builder asynchronously and know
    // its function name at runtime.
    snapshotBuilderFn.grantInvoke(fn);
    fn.addEnvironment('SNAPSHOT_BUILDER_FN', snapshotBuilderFn.functionName);

    // Analysis builder Lambda. Reads every store/agent-N.ndjson in full,
    // concatenates into one gzipped NDJSON artifact, writes it to S3, and
    // updates a pointer file so the API handler can presign a URL in O(1).
    // Larger memory and a longer timeout than the snapshot builder because
    // post-run analysis at 1000 agents can touch many MB of logs.
    const analysisBuilderFn = new NodejsFunction(this, 'AnalysisBuilderFn', {
      entry: path.join(repoRoot, 'lambda/analysisBuilder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // Scoped S3 access: read every per-cluster store file, write analysis
    // artifacts and the latest-pointer file under the cluster's prefix.
    analysisBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [bucket.arnForObjects('*/store/*')],
    }));
    analysisBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': ['*/store/*'] },
      },
    }));
    analysisBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [
        bucket.arnForObjects('*/store/cluster-analysis-*'),
        bucket.arnForObjects('*/store/cluster-analysis-latest.json'),
      ],
    }));

    // Let the API handler invoke the analysis builder asynchronously and
    // read the pointer + artifacts it produces. The handler already has
    // bucket-wide read/write via `bucket.grantReadWrite(fn)` above, so no
    // additional S3 grant is strictly needed here. Presigned URL
    // generation is a client-side signing operation that uses the signer's
    // existing credentials and does not require a separate IAM action.
    analysisBuilderFn.grantInvoke(fn);
    fn.addEnvironment('ANALYSIS_BUILDER_FN', analysisBuilderFn.functionName);

    // Dashboard builder Lambda (4.7 dashboarding). Async-invoked by the
    // API handler when a dashboard cache (overview or per-run drill-down)
    // is missing or stale. Parses full agent logs + cost logs + the
    // transitions log, buckets everything at 1-minute resolution, and
    // writes dashboard/overview.json and dashboard/{clusterId}/{runId}.json.
    // Longer timeout + larger memory than the snapshot builder because it
    // reads NDJSON files in full (like the analysis builder). No EC2 or
    // CloudWatch access needed — everything it consumes lives in S3
    // (pricing comes from config/pricing.json).
    const dashboardBuilderFn = new NodejsFunction(this, 'DashboardBuilderFn', {
      entry: path.join(repoRoot, 'lambda/dashboardBuilder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(120),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // Broad bucket read: the builder touches per-cluster stores, config
    // files, the clusters.json registry, history/ archives, environment/
    // listings, and config/pricing.json — effectively every prefix.
    bucket.grantRead(dashboardBuilderFn);
    // Writes are scoped to its two cache outputs plus the self-healed
    // run.json manifests for legacy archives.
    dashboardBuilderFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [
        bucket.arnForObjects('dashboard/*'),
        bucket.arnForObjects('history/*/run.json'),
      ],
    }));

    // Let the API handler invoke the dashboard builder asynchronously and
    // know its function name at runtime.
    dashboardBuilderFn.grantInvoke(fn);
    fn.addEnvironment('DASHBOARD_BUILDER_FN', dashboardBuilderFn.functionName);

    // Analyzer Lambda — Bedrock-powered cluster analysis and direction
    // optimization. Reads all cluster state from S3, calls Bedrock Converse
    // with Claude Sonnet 4.6, persists structured results to S3.
    const analyzerFn = new NodejsFunction(this, 'AnalyzerFn', {
      entry: path.join(repoRoot, 'lambda/analyzerHandler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        ANALYZER_MODEL_ID: 'eu.anthropic.claude-sonnet-4-6',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // S3 access: read all cluster data, write analyzer results.
    analyzerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        bucket.arnForObjects('*/store/*'),
        bucket.arnForObjects('*/config.json'),
        bucket.arnForObjects('*/direction.md'),
        bucket.arnForObjects('clusters.json'),
        bucket.arnForObjects('environment/*'),
        bucket.arnForObjects('knowledge-base/*'),
        bucket.arnForObjects('store/analyzer/*'),
      ],
    }));
    analyzerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['*/store/*', 'environment/*', 'knowledge-base/*', 'store/analyzer/*'],
        },
      },
    }));
    analyzerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects('store/analyzer/*')],
    }));
    // Bedrock access: invoke Claude Sonnet 4.6 via Converse API.
    analyzerFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/eu.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
      ],
    }));

    analyzerFn.grantInvoke(fn);
    fn.addEnvironment('ANALYZER_FN', analyzerFn.functionName);

    // Map-Reduce Engine Lambda — executes structured map/filter/reduce
    // operations against agent logs and directive files in S3.
    // Invoked asynchronously (the API returns 202 immediately and the result
    // lands in an analyzer tab), so the timeout is sized for the file-target
    // content scan rather than for a synchronous request. Listing is uncapped
    // and reads run 64-way concurrent, so a multi-thousand-file corpus fits
    // well inside this; memory is 1024 both for the extra CPU share during
    // regex scanning and for the bounded read buffers.
    const mapreduceEngineFn = new NodejsFunction(this, 'MapReduceEngineFn', {
      entry: path.join(repoRoot, 'lambda/mapreduceEngine.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(300),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        ANALYZER_MODEL_ID: 'eu.anthropic.claude-sonnet-4-6',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // S3 access: read cluster data + agent logs, write directives + tab results.
    // knowledge-base/ is readable because the file target can be scoped to it;
    // it stays read-only there, as do all file-target operations.
    mapreduceEngineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        bucket.arnForObjects('*/store/*'),
        bucket.arnForObjects('*/config.json'),
        bucket.arnForObjects('*/direction.md'),
        bucket.arnForObjects('clusters.json'),
        bucket.arnForObjects('environment/*'),
        bucket.arnForObjects('knowledge-base/*'),
      ],
    }));
    mapreduceEngineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [
        bucket.arnForObjects('*/store/agent-*.directive.md'),
        bucket.arnForObjects('store/analyzer/*'),
      ],
    }));
    mapreduceEngineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['*/store/*', 'environment/*', 'knowledge-base/*'],
        },
      },
    }));
    // Bedrock access for reduce/summarize mode.
    mapreduceEngineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/eu.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
      ],
    }));

    mapreduceEngineFn.grantInvoke(fn);
    fn.addEnvironment('MAPREDUCE_ENGINE_FN', mapreduceEngineFn.functionName);

    // Map-Reduce Translator Lambda — converts natural language prompts into
    // structured operations via Bedrock, then invokes the engine Lambda.
    const mapreduceTranslatorFn = new NodejsFunction(this, 'MapReduceTranslatorFn', {
      entry: path.join(repoRoot, 'lambda/mapreduceTranslator.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        ANALYZER_MODEL_ID: 'eu.anthropic.claude-sonnet-4-6',
        MAPREDUCE_ENGINE_FN: mapreduceEngineFn.functionName,
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // S3 access: read cluster registry/state/config/direction for context.
    mapreduceTranslatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        bucket.arnForObjects('clusters.json'),
        bucket.arnForObjects('*/store/state.json'),
        bucket.arnForObjects('*/config.json'),
        bucket.arnForObjects('*/direction.md'),
      ],
    }));
    // ListBucket (prefix-scoped) so GetObject on a missing key returns a
    // clean 404 (NoSuchKey) instead of a 403 naming s3:ListBucket. Without
    // this, a registered-but-never-started cluster (no state.json yet)
    // makes gatherContext blow up with an AccessDenied.
    mapreduceTranslatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:ListBucket'],
      resources: [bucket.bucketArn],
      conditions: {
        StringLike: {
          's3:prefix': ['*/store/*', '*/config.json', '*/direction.md', 'clusters.json'],
        },
      },
    }));
    // Write the processing placeholder to the tab.
    mapreduceTranslatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [bucket.arnForObjects('store/analyzer/*')],
    }));
    // Bedrock access for translation.
    mapreduceTranslatorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/eu.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
      ],
    }));
    // Invoke the engine Lambda.
    mapreduceEngineFn.grantInvoke(mapreduceTranslatorFn);

    mapreduceTranslatorFn.grantInvoke(fn);
    fn.addEnvironment('MAPREDUCE_TRANSLATOR_FN', mapreduceTranslatorFn.functionName);

    // RunInstances: restrict instance type to Graviton families. Split into two
    // statements because ec2:InstanceType only applies to the instance resource
    // type — other resource types (volume, ENI, etc.) would fail the condition.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringLike: { 'ec2:InstanceType': ['t*g.*', 'c*g.*', 'm*g.*', 'r*g.*'] },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:aws:ec2:*:${this.account}:volume/*`,
        `arn:aws:ec2:*:${this.account}:network-interface/*`,
        `arn:aws:ec2:*:${this.account}:security-group/*`,
        `arn:aws:ec2:*:${this.account}:subnet/*`,
        `arn:aws:ec2:*::image/*`,
        `arn:aws:ec2:*:${this.account}:key-pair/*`,
      ],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'ec2:DescribeInstances',
        'ec2:DescribeInstanceTypes',
      ],
      resources: ['*'],
    }));
    // Tags are only written at launch. TerminateInstances and SendCommand
    // below are conditioned on Project=kiro-flock, so an unconditioned
    // CreateTags would let this function tag any instance in the account and
    // then terminate it or run a command on it. Tying the grant to the
    // RunInstances call keeps the tag set to instances this function created.
    // The tag keys themselves stay free so ec2Manager.ts can add more.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringEquals: { 'ec2:CreateAction': 'RunInstances' },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/Project': 'kiro-flock' },
      },
    }));
    // Per-agent live stream tails (Kiro Node view, lambda/agentStream.ts):
    // the Lambda runs ONE fixed tail command per fetch on agent instances
    // via SSM RunCommand. This is the conscious privilege escalation
    // called out in stream-console-plan.md, kept as tight as SSM allows:
    // only the stock AWS-RunShellScript document, only against
    // Project=kiro-flock-tagged instances, and the command templates are
    // fixed server-side — operator input never reaches the shell.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/Project': 'kiro-flock' },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: ['arn:aws:ssm:*::document/AWS-RunShellScript'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetCommandInvocation'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    // RunInstances with an instance profile needs PassRole on its role.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [agentRole.roleArn, deployerRole.roleArn],
      conditions: {
        StringEquals: { 'iam:PassedToService': 'ec2.amazonaws.com' },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['servicequotas:GetServiceQuota'],
      resources: ['*'],
    }));
    // Forge monitoring: CloudFormation describe + Bedrock for layout generation
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        'cloudformation:DescribeStackResources',
        'cloudformation:DescribeStacks',
        'cloudformation:ListStacks',
      ],
      resources: ['*'],
    }));
    // Forge destroy (POST /forge/destroy): delete the stack backing a
    // deployment group. The stack name comes from `deployed/latest.json`,
    // which agents can write, so the grant is conditioned on the tag every
    // agent deploy carries (DEPLOY_TAG_KEY): a stack this flock did not
    // deploy cannot be named into deletion. forgeHandler.ts checks the same
    // tag before calling, so the refusal is a clear message rather than an
    // AccessDenied. The resource deletion itself runs under the service role
    // CloudFormation recorded on the stack at deploy time (the CDK bootstrap
    // cfn-exec role), not this Lambda's role.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudformation:DeleteStack'],
      resources: [`arn:aws:cloudformation:${this.region}:${this.account}:stack/*`],
      conditions: {
        StringEquals: { [`aws:ResourceTag/${DEPLOY_TAG_KEY}`]: DEPLOY_TAG_VALUE },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['apigateway:GET'],
      resources: [`arn:aws:apigateway:${this.region}::/restapis/*`],
    }));
    // Read-only. Used when the Forge routes reconcile a missing deployment
    // record, to resolve a CloudFront-fronted site URL for stacks that declare
    // no URL output. Same reason the agent role has it.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudfront:GetDistribution'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        `arn:aws:bedrock:*::foundation-model/anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/eu.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/us.anthropic.claude-sonnet-4-6`,
        `arn:aws:bedrock:*:${this.account}:inference-profile/global.anthropic.claude-sonnet-4-6`,
      ],
    }));
    // Allow the Lambda to invoke itself asynchronously for long-running
    // start operations that would exceed the API Gateway 29s timeout.
    // Uses a wildcard ARN to avoid circular dependency between the function,
    // its role policy, and the API Gateway deployment. The handler only ever
    // invokes itself (via AWS_LAMBDA_FUNCTION_NAME).
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:AgaStack-*`],
    }));

    // ---------- Cognito ----------
    const userPool = new cognito.UserPool(this, 'FlockUserPool', {
      userPoolName: 'kiro-flock-users',
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      // A password alone can start deployer clusters, and the Cognito endpoints
      // are not behind the stage's WAF allowlist, so every sign-in needs a
      // TOTP code as well. The hosted UI enrolls the authenticator on the first
      // sign-in; the factory answers the SOFTWARE_TOKEN_MFA challenge with the
      // code the operator types. SMS is off: no phone numbers are collected.
      mfa: cognito.Mfa.REQUIRED,
      mfaSecondFactor: { sms: false, otp: true },
      // Applies to passwords set from now on; an existing user keeps theirs
      // until it is changed.
      passwordPolicy: {
        minLength: 12,
        requireUppercase: true,
        requireLowercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Cognito hosted UI domain (uses a prefix on the Cognito domain)
    const cognitoDomain = userPool.addDomain('FlockDomain', {
      cognitoDomain: {
        domainPrefix: `kiro-flock-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    // App client for the dashboard (PKCE flow, no client secret)
    const userPoolClient = userPool.addClient('FlockDashboardClientV2', {
      userPoolClientName: 'flock-dashboard',
      generateSecret: false,
      // userPassword: the factory signs in with USER_PASSWORD_AUTH (one
      // InitiateAuth call over TLS) instead of carrying its own SRP code.
      authFlows: { userSrp: true, userPassword: true, adminUserPassword: true },
      accessTokenValidity: cdk.Duration.hours(24),
      idTokenValidity: cdk.Duration.hours(24),
      refreshTokenValidity: cdk.Duration.days(7),
      oAuth: {
        flows: { implicitCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID],
        // Placeholder only — install.sh updates this to the real API Gateway URL
        // via aws cognito-idp update-user-pool-client after deploy.
        callbackUrls: ['https://localhost/callback'],
        logoutUrls: ['https://localhost/'],
      },
      preventUserExistenceErrors: true,
    });

    // ---------- API Gateway (REST API v1 — required for WAF) ----------
    const apiAccessLogs = new logs.LogGroup(this, 'ApiAccessLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const api = new apigw.RestApi(this, 'AgaApi', {
      restApiName: 'aga-api',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigw.LogGroupLogDestination(apiAccessLogs),
        accessLogFormat: apigw.AccessLogFormat.jsonWithStandardFields(),
        // Errors only, and no request/response bodies: the bodies carry
        // Cognito tokens and queue payloads, which do not belong in a log.
        loggingLevel: apigw.MethodLoggingLevel.ERROR,
        dataTraceEnabled: false,
      },
      binaryMediaTypes: ['*/*'],
    });

    // ---------- WAF: IP allowlist in front of the dashboard ----------
    // Cognito decides who may call /cluster/* and /forge/*. The allowlist
    // decides who may reach the API at all, the sign-in page included, so a
    // leaked URL is not a sign-in form on the open internet. The set starts
    // empty and the default action is block: nothing answers until
    // `update-ip.sh` has added the operator's address, which install.sh does
    // at the end of setup. Run it again when your public IP changes.
    //
    // IPv4 only. The script resolves the public IPv4 address; an operator on
    // IPv6-only connectivity would need a second set and rule here.
    const allowedIps = new wafv2.CfnIPSet(this, 'DashboardAllowList', {
      name: `kiro-flock-allowlist-${cdk.Aws.ACCOUNT_ID}`,
      scope: 'REGIONAL',
      ipAddressVersion: 'IPV4',
      addresses: [],
      description: 'Operator addresses allowed to reach the kiro-flock dashboard and API',
    });
    const webAcl = new wafv2.CfnWebACL(this, 'DashboardWebAcl', {
      name: `kiro-flock-dashboard-${cdk.Aws.ACCOUNT_ID}`,
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'kiro-flock-dashboard',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AllowListedAddresses',
          priority: 0,
          action: { allow: {} },
          statement: { ipSetReferenceStatement: { arn: allowedIps.attrArn } },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'kiro-flock-allowlisted',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'DashboardWebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });
    new cdk.CfnOutput(this, 'AllowListIpSetId', { value: allowedIps.attrId });
    new cdk.CfnOutput(this, 'AllowListIpSetName', { value: allowedIps.name! });

    // Cognito authorizer for API endpoints
    const authorizer = new apigw.CognitoUserPoolsAuthorizer(this, 'FlockAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'flock-cognito-auth',
    });

    // /cluster/{proxy+} → Lambda (Cognito-protected)
    //
    // {proxy+} is a greedy catch-all that matches any number of path
    // segments, so it covers the full suffix-style routing surface
    // introduced by WeltenBuilder:
    //   /cluster/start                  -> proxy = "start"
    //   /cluster/start/my-cluster       -> proxy = "start/my-cluster"
    //   /cluster/habitat/file/cluster_0 -> proxy = "habitat/file/cluster_0"
    //   /cluster/stop-all               -> proxy = "stop-all"
    //   /cluster/clean-env-all          -> proxy = "clean-env-all"
    // The Lambda integration below forwards the whole proxy path via
    // method.request.path.proxy, and the handler's parseRoute() splits it
    // into { action, clusterId } at the application layer. This means no
    // CDK change is required when new actions or paths are added — the
    // handler owns the routing.
    const cluster = api.root.addResource('cluster');
    const clusterProxy = cluster.addResource('{proxy+}');
    clusterProxy.addMethod('ANY', new apigw.LambdaIntegration(fn), {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    });

    // Role API Gateway uses to read from S3
    const apiS3Role = new iam.Role(this, 'ApiS3Role', {
      assumedBy: new iam.ServicePrincipal('apigateway.amazonaws.com'),
    });
    bucket.grantRead(apiS3Role);

    // GET / → s3://bucket/web/index.html
    // Also handles /prod/ (trailing slash) since /{proxy+} cannot match empty proxy.
    api.root.addMethod('GET', new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/web/index.html`,
      options: {
        credentialsRole: apiS3Role,
        integrationResponses: [{
          statusCode: '200',
          responseParameters: {
            'method.response.header.Content-Type': 'integration.response.header.Content-Type',
          },
        }],
      },
    }), {
      methodResponses: [{
        statusCode: '200',
        responseParameters: { 'method.response.header.Content-Type': true },
      }],
    });

    // GET /welten and GET /forge → s3://bucket/web/legacy-redirect.html
    //
    // The three UIs merged into the unified accordion shell at the stage
    // root. These legacy routes serve a tiny client-side redirect page
    // that maps old bookmarks onto the matching accordion section
    // (/welten → #multi-cluster, /forge → #continuous). Must be declared
    // BEFORE the catch-all /{proxy+} below or API Gateway picks the more
    // greedy pattern first.
    const legacyRedirectIntegration = new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/web/legacy-redirect.html`,
      options: {
        credentialsRole: apiS3Role,
        integrationResponses: [{
          statusCode: '200',
          responseParameters: {
            'method.response.header.Content-Type': 'integration.response.header.Content-Type',
          },
        }],
      },
    });
    const legacyMethodOptions = {
      methodResponses: [{
        statusCode: '200',
        responseParameters: { 'method.response.header.Content-Type': true },
      }],
    };
    const welten = api.root.addResource('welten');
    welten.addMethod('GET', legacyRedirectIntegration, legacyMethodOptions);

    // POST /forge/{proxy+} → Lambda (for /forge/metrics, /forge/layout,
    // /forge/status-report, /forge/cache-clear — still consumed by the
    // Continuous Deployments accordion section).
    const forge = api.root.addResource('forge');
    forge.addMethod('GET', legacyRedirectIntegration, legacyMethodOptions);

    const forgeProxy = forge.addResource('{proxy+}');

    // POST /forge/* goes to Lambda for metrics/layout endpoints
    forgeProxy.addMethod('POST', new apigw.LambdaIntegration(fn), {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      authorizer,
      authorizationType: apigw.AuthorizationType.COGNITO,
    });

    // GET /{proxy+} → s3://bucket/web/{proxy}
    const rootProxy = api.root.addResource('{proxy+}');
    rootProxy.addMethod('GET', new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/web/{proxy}`,
      options: {
        credentialsRole: apiS3Role,
        requestParameters: {
          'integration.request.path.proxy': 'method.request.path.proxy',
        },
        integrationResponses: [{
          statusCode: '200',
          responseParameters: {
            'method.response.header.Content-Type': 'integration.response.header.Content-Type',
          },
        }],
      },
    }), {
      requestParameters: {
        'method.request.path.proxy': true,
      },
      methodResponses: [{
        statusCode: '200',
        responseParameters: { 'method.response.header.Content-Type': true },
      }],
    });


    // ---------- Outputs ----------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.url });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'SecurityGroupId', { value: sg.securityGroupId });
    new cdk.CfnOutput(this, 'SubnetId', { value: vpc.publicSubnets[0].subnetId });
    new cdk.CfnOutput(this, 'SubnetIds', { value: vpc.publicSubnets.map((s) => s.subnetId).join(',') });
    new cdk.CfnOutput(this, 'InstanceProfileArn', { value: instanceProfile.attrArn });
    new cdk.CfnOutput(this, 'DeployerInstanceProfileArn', { value: deployerInstanceProfile.attrArn });
    new cdk.CfnOutput(this, 'AmiId', { value: amiId });
    new cdk.CfnOutput(this, 'EcsClusterArn', { value: ecsCluster.clusterArn });
    new cdk.CfnOutput(this, 'AgentLogGroup', { value: agentLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `${cognitoDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });

    this.suppressNagFindings(api, userPool, bucket);
  }

  /**
   * cdk-nag (AwsSolutions) findings this stack accepts, each with its reason.
   *
   * Everything cdk-nag flagged that could be fixed was fixed in place: Node 22
   * runtimes, VPC flow logs, container insights, API access and error logging,
   * a 12-character password policy, and the WAF in front of the API. What is
   * left is either a wildcard that the resource model forces, a managed policy
   * that is the documented way to grant a service's baseline, or a control
   * that does not fit a single-operator sample. A suppression here is a
   * decision, not a dismissal; the reason says what would have to change for
   * the finding to apply.
   */
  private suppressNagFindings(api: apigw.RestApi, userPool: cognito.UserPool, bucket: s3.Bucket): void {
    const bucketLogicalId = this.getLogicalId(bucket.node.defaultChild as s3.CfnBucket);
    // Managed policies. Each is the AWS-documented baseline for its service
    // and grants nothing the role would not otherwise need spelled out.
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM4',
        reason:
          'AWSLambdaBasicExecutionRole (CloudWatch Logs for every function), AmazonSSMManagedInstanceCore ' +
          '(Session Manager onto agent hosts, replacing SSH) and AmazonAPIGatewayPushToCloudWatchLogs ' +
          '(the API access log above) are the documented baselines for those services.',
        appliesTo: [
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/AmazonSSMManagedInstanceCore',
          'Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs',
        ],
      },
    ]);
    // Wildcard findings, one block per IAM entity. `appliesTo` names the exact
    // Resource:: / Action:: finding so a new wildcard shows up as a new error
    // instead of disappearing under a stack-wide reason. Account and region
    // bearing ARNs are matched by regex because they resolve at synth time.
    const bucketKeys = (...keys: string[]): string[] => keys.map((k) => `Resource::<${bucketLogicalId}.Arn>/${k}`);
    const arn = (pattern: string): { regex: string } => ({ regex: `/^Resource::${pattern}$/g` });
    const fnArn = (logicalPrefix: string): { regex: string } => ({ regex: `/^Resource::<${logicalPrefix}[A-F0-9]+\\.Arn>:\\*$/g` });
    const bedrockModels = [arn('arn:aws:bedrock:\\*::foundation-model/.*'), arn('arn:aws:bedrock:\\*:.*:inference-profile/.*')];
    const s3ReadActions = ['Action::s3:GetObject*', 'Action::s3:GetBucket*', 'Action::s3:List*'];
    const iam5 = (constructPath: string, reason: string, appliesTo: Array<string | { regex: string }>): void =>
      NagSuppressions.addResourceSuppressionsByPath(this, `/${this.stackName}/${constructPath}`, [{ id: 'AwsSolutions-IAM5', reason, appliesTo }]);

    iam5('AgentPolicy/Resource',
      'Agent runtime policy shared by AgentRole and DeployerRole: key prefixes inside the one bucket this stack owns ' +
      '(the layout is documented on the policy; `*/` stands for any cluster id, which IAM cannot learn without session tags), ' +
      'the one SSM parameter holding the Kiro API key, and three APIs that take no resource ' +
      '(cloudwatch:PutMetricData, cloudformation:Describe*/List*, cloudfront:GetDistribution).',
      [...bucketKeys('agent/*', 'environment/*', 'knowledge-base/*', 'deploy-src/*', 'store/approvals/*', '*/config.json', '*/direction.md', '*/store/*'),
        arn('arn:aws:ssm:\\*:.*:parameter/aga/kiro-api-key'), 'Resource::*']);
    iam5('DeployerRole/DefaultPolicy/Resource',
      'Deployer clusters only: the deploy-src/ snapshot prefix (write), the kflock bootstrap SSM version parameter, ' +
      'CodeCommit repositories limited by the KiroFlockManaged tag condition on the statement, and sts:GetCallerIdentity.',
      [...bucketKeys('deploy-src/*'), arn('arn:aws:ssm:.*:parameter/cdk-bootstrap/kflock/\\*'), arn('arn:aws:codecommit:.*:\\*'), 'Resource::*']);
    for (const task of ['AgentTaskDef', 'DeployerTaskDef']) {
      iam5(`${task}/ExecutionRole/DefaultPolicy/Resource`,
        'ECS execution role: ecr:GetAuthorizationToken takes no resource; the image pull and log statements are resource-scoped by the CDK.',
        ['Resource::*']);
    }
    iam5('IncubatorFn/ServiceRole/DefaultPolicy/Resource',
      'Control-plane Lambda. Bucket-wide read and write over the cluster layout it owns; ec2:RunInstances resource types ' +
      'minted at launch (instance, volume, ENI, subnet, SG, AMI, key pair) with instance-type and tag conditions; ' +
      'TerminateInstances, SendCommand and CreateTags are conditioned on the Project tag or ec2:CreateAction; the fixed ' +
      'AWS-RunShellScript document; its own log group streams and sibling functions it invokes; the API stage it ' +
      'invalidates; CloudFormation stacks (DescribeStacks on any, DeleteStack tag-conditioned); Bedrock models for the ' +
      'cluster analysis; ec2/ecs Describe*, ssm:GetCommandInvocation and cloudwatch:GetMetricData take no resource.',
      [...s3ReadActions, 'Action::s3:DeleteObject*', 'Action::s3:Abort*', ...bucketKeys('*'),
        fnArn('AgentTaskLogs'), fnArn('AnalysisBuilderFn'), fnArn('AnalyzerFn'), fnArn('DashboardBuilderFn'),
        fnArn('MapReduceEngineFn'), fnArn('MapReduceTranslatorFn'), fnArn('SnapshotBuilderFn'),
        arn('arn:aws:apigateway:.*::/restapis/\\*'), ...bedrockModels, arn('arn:aws:cloudformation:.*:stack/\\*'),
        arn('arn:aws:ec2:\\*:.*:(instance|key-pair|network-interface|security-group|subnet|volume)/\\*'), arn('arn:aws:ec2:\\*::image/\\*'),
        arn('arn:aws:lambda:.*:function:AgaStack-\\*'), arn('arn:aws:ssm:\\*::document/AWS-RunShellScript'), 'Resource::*']);
    iam5('AnalyzerFn/ServiceRole/DefaultPolicy/Resource',
      'Reads cluster config, direction, stores and the shared environment for any cluster id; writes its analysis under store/analyzer/; Bedrock model and inference-profile ARNs.',
      [...bucketKeys('*/config.json', '*/direction.md', '*/store/*', 'environment/*', 'knowledge-base/*', 'store/analyzer/*'), ...bedrockModels]);
    iam5('MapReduceEngineFn/ServiceRole/DefaultPolicy/Resource',
      'Same cluster-layout reads as the analyzer plus the per-agent directive files it writes; Bedrock model and inference-profile ARNs.',
      [...bucketKeys('*/config.json', '*/direction.md', '*/store/*', '*/store/agent-*.directive.md', 'environment/*', 'knowledge-base/*', 'store/analyzer/*'), ...bedrockModels]);
    iam5('MapReduceTranslatorFn/ServiceRole/DefaultPolicy/Resource',
      'Reads cluster config, direction and state for any cluster id, the analyzer output, invokes the engine function; Bedrock model and inference-profile ARNs.',
      [...bucketKeys('*/config.json', '*/direction.md', '*/store/state.json', 'store/analyzer/*'), fnArn('MapReduceEngineFn'), ...bedrockModels]);
    iam5('SnapshotBuilderFn/ServiceRole/DefaultPolicy/Resource',
      'Reads every cluster\'s config and store, writes cluster-snapshot.json per cluster; cloudwatch:GetMetricData takes no resource.',
      [...bucketKeys('*/config.json', '*/store/*', '*/store/cluster-snapshot.json'), 'Resource::*']);
    iam5('AnalysisBuilderFn/ServiceRole/DefaultPolicy/Resource',
      'Reads every cluster\'s store and writes the cluster-analysis files per cluster.',
      bucketKeys('*/store/*', '*/store/cluster-analysis-*', '*/store/cluster-analysis-latest.json'));
    iam5('DashboardBuilderFn/ServiceRole/DefaultPolicy/Resource',
      'Bucket-wide read (grantRead) to render the dashboard, writes under dashboard/ and the per-run history record.',
      [...s3ReadActions, ...bucketKeys('*', 'dashboard/*', 'history/*/run.json')]);
    iam5('ApiS3Role/DefaultPolicy/Resource',
      'API Gateway S3 integration role: read-only over the bucket (grantRead) to serve the dashboard files.',
      [...s3ReadActions, ...bucketKeys('*')]);
    // The BucketDeployment custom resource is generated by aws-cdk-lib: its
    // provider runs on the runtime the library chose, and its role copies from
    // the CDK assets bucket into ours.
    for (const c of this.node.findAll()) {
      if (!c.node.id.startsWith('Custom::CDKBucketDeployment')) continue;
      NagSuppressions.addResourceSuppressions(c, [
        {
          id: 'AwsSolutions-L1',
          reason: 'aws-cdk-lib BucketDeployment provider; its runtime is chosen by the library, not this stack. Every function this stack defines runs on NODEJS_24_X.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'aws-cdk-lib BucketDeployment provider role: reads the CDK assets bucket and writes the destination bucket, as generated by the library.',
          appliesTo: [...s3ReadActions, 'Action::s3:DeleteObject*', 'Action::s3:Abort*', ...bucketKeys('*'), arn('arn:<AWS::Partition>:s3:::cdk-hnb659fds-assets-.*/\\*')],
        },
      ], true);
    }

    // The three unauthenticated GET routes serve the dashboard's static files
    // from S3 (index.html, the legacy redirect page, and /{proxy+} for the
    // bundle). The page is what performs the Cognito sign-in, so it has to be
    // reachable before a token exists. Everything the Lambda answers
    // (/cluster/*, /forge/*) requires a Cognito token, and the WAF allowlist in
    // front of the stage restricts who can fetch the page at all.
    for (const p of ['GET', 'welten/GET', 'forge/GET', '{proxy+}/GET']) {
      NagSuppressions.addResourceSuppressionsByPath(this, `/${this.stackName}/AgaApi/Default/${p}/Resource`, [
        { id: 'AwsSolutions-APIG4', reason: 'Static dashboard assets; the page performs the Cognito sign-in. Data routes are Cognito-authorized and the stage sits behind the WAF IP allowlist.' },
        { id: 'AwsSolutions-COG4', reason: 'Same: static assets served from S3, not a data route.' },
      ]);
    }
    NagSuppressions.addResourceSuppressions(api, [
      {
        id: 'AwsSolutions-APIG2',
        reason:
          'Every data route is a Lambda proxy integration; the handler validates each request body itself ' +
          '(lambda/handler.ts validateConfig and friends), and a gateway model would duplicate those rules.',
      },
    ]);
    NagSuppressions.addResourceSuppressions(userPool, [
      {
        id: 'AwsSolutions-COG8',
        reason:
          'Cognito advanced security (Plus tier) is a paid feature; a sample deployed into a sandbox ' +
          'account should not carry that cost by default. Enable it in the console for a long-lived install.',
      },
    ]);
  }
}
