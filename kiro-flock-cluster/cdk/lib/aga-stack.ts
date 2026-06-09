import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as apigw from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as path from 'node:path';
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
  algorithm: 'amorphous' as 'amorphous' | 'mesh' | 'swarm',
  // Only used when algorithm === "swarm". Must be 1..concurrency-1.
  swarmK: 4,
  // When true, agents get a fetch MCP tool for web research.
  internetAccess: false,
  // When true (default), the cluster pauses itself after every agent
  // reports `action: "idle"` for three consecutive iterations. Off lets a
  // forgotten cluster keep iterating and billing.
  autopause: true,
};

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

    // ---------- VPC ----------
    // Single-AZ public subnet, IGW attached. Agents get public IPs so they
    // can reach S3 / Kiro endpoints without a NAT gateway.
    const vpc = new ec2.Vpc(this, 'AgaVpc', {
      maxAzs: 1,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, 'AgentSg', {
      vpc,
      description: 'AGA agent instances - outbound only',
      allowAllOutbound: true,
    });

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
    new s3deploy.BucketDeployment(this, 'WebAssets', {
      sources: [
        s3deploy.Source.asset(path.join(repoRoot, 'web')),
        s3deploy.Source.asset(path.join(repoRoot, 'web-shared')),
      ],
      destinationBucket: bucket,
      destinationKeyPrefix: 'web',
      prune: false,
    });

    // WeltenBuilder multi-cluster front-end → s3://bucket/welten-web/
    // Deployed alongside the kiro-flock dashboard (req 6.4: no CDK
    // parameterisation, both assets always ship). Distinct prefix keeps
    // the two apps from overwriting each other in S3. Source lives in
    // `weltenbuilder/web/` under the kiro-flock repo root so everything
    // ships together from a single repo. Same shared envPanel bundle.
    new s3deploy.BucketDeployment(this, 'WeltenWebAssets', {
      sources: [
        s3deploy.Source.asset(path.join(repoRoot, 'weltenbuilder', 'web')),
        s3deploy.Source.asset(path.join(repoRoot, 'web-shared')),
      ],
      destinationBucket: bucket,
      destinationKeyPrefix: 'welten-web',
      prune: false,
    });

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

    // ---------- IAM for EC2 agents ----------
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
    });
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
    agentRole.addToPolicy(new iam.PolicyStatement({
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
    agentRole.addToPolicy(new iam.PolicyStatement({
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
        // prerogative belongs to the operator, via kb_upload_file /
        // kb_upload_folder on the MCP side, which run under the operator's
        // own AWS credentials, not the agent role. Earlier builds allowed
        // agents to write here; the cluster then filled the kb with
        // inter-agent debates and ghost "orchestration skill" docs that
        // subsequent runs then cited back as authoritative. See the
        // explicit Deny statement below for defence-in-depth.
        // clusters.json is also absent here — agents must never edit the
        // cluster registry. Only the Lambda (operator) writes that file.
      ],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({
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
    agentRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.DENY,
      actions: ['s3:PutObject', 's3:DeleteObject'],
      resources: [
        bucket.arnForObjects('web/*'),
        bucket.arnForObjects('agent/*'),
        bucket.arnForObjects('history/*'),
        bucket.arnForObjects('knowledge-base/*'),
        bucket.arnForObjects('clusters.json'),
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
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:PutMetricData'],
      resources: ['*'],
    }));
    // SSM managed instance core — lets us connect via Session Manager if needed
    agentRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );
    // Allow agents to read the Kiro API key from SSM Parameter Store
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:*:${this.account}:parameter/aga/kiro-api-key`],
    }));
    const instanceProfile = new iam.CfnInstanceProfile(this, 'AgentInstanceProfile', {
      roles: [agentRole.roleName],
    });

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
      runtime: lambda.Runtime.NODEJS_20_X,
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
        SUBNET_ID: vpc.publicSubnets[0].subnetId,
        CONCURRENCY_CAP: '64',
        // Tell the Node SDK to keep TCP connections alive across S3
        // calls inside one invocation, dramatically reducing the cost
        // of the parallel fan-out in /cluster/list.
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    bucket.grantReadWrite(fn);

    // Snapshot builder Lambda. Runs asynchronously, writes
    // store/cluster-snapshot.json. The API handler invokes it whenever
    // /cluster/status finds the snapshot missing or stale. Bundled the
    // same way as the API handler (NodejsFunction + esbuild).
    const snapshotBuilderFn = new NodejsFunction(this, 'SnapshotBuilderFn', {
      entry: path.join(repoRoot, 'lambda/snapshotBuilder.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
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
      runtime: lambda.Runtime.NODEJS_20_X,
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

    // Analyzer Lambda — Bedrock-powered cluster analysis and direction
    // optimization. Reads all cluster state from S3, calls Bedrock Converse
    // with Claude Sonnet 4.6, persists structured results to S3.
    const analyzerFn = new NodejsFunction(this, 'AnalyzerFn', {
      entry: path.join(repoRoot, 'lambda/analyzerHandler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
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
    const mapreduceEngineFn = new NodejsFunction(this, 'MapReduceEngineFn', {
      entry: path.join(repoRoot, 'lambda/mapreduceEngine.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(120),
      memorySize: 512,
      environment: {
        BUCKET_NAME: bucket.bucketName,
        ANALYZER_MODEL_ID: 'eu.anthropic.claude-sonnet-4-6',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
    });
    // S3 access: read cluster data + agent logs, write directives + tab results.
    mapreduceEngineFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject'],
      resources: [
        bucket.arnForObjects('*/store/*'),
        bucket.arnForObjects('*/config.json'),
        bucket.arnForObjects('*/direction.md'),
        bucket.arnForObjects('clusters.json'),
        bucket.arnForObjects('environment/*'),
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
          's3:prefix': ['*/store/*', 'environment/*'],
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
      runtime: lambda.Runtime.NODEJS_20_X,
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
        'ec2:CreateTags',
      ],
      resources: ['*'],
    }));
    // Task 3.3.5 / 3.4 coordination:
    //
    //   ec2:CreateTags above already allows the Lambda to tag instances with
    //   whatever key/value pairs we like at RunInstances time. Propagating
    //   the ClusterId tag onto each instance is a pure application-layer
    //   change in lambda/ec2Manager.ts (start) and the stopCluster filter
    //   (owned by task 3.4). No CDK change is needed — we do not want an
    //   IAM condition constraining tag keys because the Lambda needs
    //   flexibility to add future tags without redeploying the stack.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: [`arn:aws:ec2:*:${this.account}:instance/*`],
      conditions: {
        StringEquals: { 'aws:ResourceTag/Project': 'kiro-flock' },
      },
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['cloudwatch:GetMetricData'],
      resources: ['*'],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [agentRole.roleArn],
    }));
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['servicequotas:GetServiceQuota'],
      resources: ['*'],
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
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
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
      authFlows: { userSrp: true, adminUserPassword: true },
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
    const api = new apigw.RestApi(this, 'AgaApi', {
      restApiName: 'aga-api',
      deployOptions: {
        stageName: 'prod',
      },
      binaryMediaTypes: ['*/*'],
    });

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

    // GET /welten → s3://bucket/welten-web/index.html
    // GET /welten/{proxy+} → s3://bucket/welten-web/{proxy}
    //
    // WeltenBuilder is served as a sibling SPA under the same API Gateway.
    // Must be declared BEFORE the catch-all /{proxy+} below or API Gateway
    // picks the more greedy pattern first. /welten (no trailing segment)
    // maps to index.html; /welten/* maps into welten-web/.
    const welten = api.root.addResource('welten');
    welten.addMethod('GET', new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/welten-web/index.html`,
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

    const weltenProxy = welten.addResource('{proxy+}');
    weltenProxy.addMethod('GET', new apigw.AwsIntegration({
      service: 's3',
      integrationHttpMethod: 'GET',
      path: `${bucket.bucketName}/welten-web/{proxy}`,
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
    new cdk.CfnOutput(this, 'WeltenUrl', { value: `${api.url}welten` });
    new cdk.CfnOutput(this, 'BucketName', { value: bucket.bucketName });
    new cdk.CfnOutput(this, 'SecurityGroupId', { value: sg.securityGroupId });
    new cdk.CfnOutput(this, 'SubnetId', { value: vpc.publicSubnets[0].subnetId });
    new cdk.CfnOutput(this, 'InstanceProfileArn', { value: instanceProfile.attrArn });
    new cdk.CfnOutput(this, 'AmiId', { value: amiId });
    new cdk.CfnOutput(this, 'UserPoolId', { value: userPool.userPoolId });
    new cdk.CfnOutput(this, 'UserPoolClientId', { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `${cognitoDomain.domainName}.auth.${this.region}.amazoncognito.com`,
    });
  }
}
