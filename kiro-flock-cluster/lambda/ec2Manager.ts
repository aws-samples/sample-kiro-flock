import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { ClusterConfig } from "./s3Store";
import { renderAgentUserData } from "./userData";

const ec2 = new EC2Client({});

export interface AgentInstanceInfo {
  instanceId: string;
  agentIndex: number;
  state: string;
  launchTime: string | null;
}

export interface StartClusterContext {
  bucket: string;
  amiId: string;
  securityGroupId: string;
  instanceProfileArn: string;
  subnetId: string;
}

/**
 * Launch one EC2 instance per agent slot in the cluster.
 *
 * `clusterId` is stamped onto every instance as a `ClusterId` tag and
 * threaded into the agent user-data so each agent reads/writes under the
 * correct S3 prefix. Defaults to `"cluster_0"` so single-cluster callers
 * that haven't been updated keep working (backwards compat with the
 * pre-WeltenBuilder shape).
 */
export async function startCluster(
  ctx: StartClusterContext,
  config: ClusterConfig,
  clusterId: string = "cluster_0",
): Promise<string[]> {
  const region = await ec2.config.region();
  const ids: string[] = [];

  for (let i = 0; i < config.concurrency; i++) {
    const userData = renderAgentUserData({
      agentIndex: i,
      concurrency: config.concurrency,
      neighbourRadius: config.neighbourRadius,
      bucket: ctx.bucket,
      region,
      loopIntervalSeconds: config.loopIntervalSeconds,
      model: config.model,
      algorithm: config.algorithm,
      swarmK: config.swarmK,
      clusterId,
      internetAccess: config.internetAccess,
      autopause: config.autopause,
    });

    const id = await runInstanceWithRetry(ec2, {
      ImageId: ctx.amiId,
      InstanceType: config.instanceType as any,
      MinCount: 1,
      MaxCount: 1,
      SubnetId: ctx.subnetId,
      SecurityGroupIds: [ctx.securityGroupId],
      IamInstanceProfile: { Arn: ctx.instanceProfileArn },
      UserData: Buffer.from(userData).toString("base64"),
      TagSpecifications: [{
        ResourceType: "instance",
        Tags: [
          { Key: "Project", Value: "kiro-flock" },
          { Key: "ClusterId", Value: clusterId },
          { Key: "AgentIndex", Value: String(i) },
          { Key: "Name", Value: `aga-${clusterId}-agent-${i}` },
        ],
      }],
    });

    if (id) ids.push(id);
  }

  return ids;
}

/**
 * RunInstances with exponential backoff retry on RequestLimitExceeded.
 * EC2 throttles accounts that fire many RunInstances calls in quick
 * succession (common when launching multiple clusters simultaneously).
 * Retries up to 5 times with jittered exponential backoff (1s, 2s, 4s,
 * 8s, 16s base delays).
 */
async function runInstanceWithRetry(
  client: EC2Client,
  params: ConstructorParameters<typeof RunInstancesCommand>[0],
  maxRetries = 5,
): Promise<string | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await client.send(new RunInstancesCommand(params));
      return res.Instances?.[0]?.InstanceId ?? null;
    } catch (err: unknown) {
      const code = (err as { name?: string; Code?: string }).name
        ?? (err as { Code?: string }).Code ?? "";
      const isThrottle = code === "RequestLimitExceeded"
        || code === "Throttling"
        || code === "ThrottlingException";

      if (!isThrottle || attempt === maxRetries) {
        throw err;
      }

      // Exponential backoff with jitter: base * 2^attempt + random 0-500ms
      const baseMs = 1000 * Math.pow(2, attempt);
      const jitter = Math.floor(Math.random() * 500);
      const delayMs = baseMs + jitter;
      console.log(`RunInstances throttled (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return null; // unreachable but satisfies TS
}

/**
 * Terminate all agent instances belonging to `clusterId`. Always filters
 * by the ClusterId tag so one cluster's stop never touches another's
 * instances, even for the default `cluster_0`.
 *
 * Pre-WeltenBuilder instances launched without a ClusterId tag are no
 * longer reachable this way. Those builds are long gone; if an operator
 * has stale instances from that era they can be cleaned up manually once.
 */
export async function stopCluster(bucket: string, clusterId: string = "cluster_0"): Promise<void> {
  // Find all instances by tag, not just the stored IDs, to catch any that
  // were launched but not recorded (e.g. due to a Lambda timeout).
  const filters = [
    { Name: "tag:Project", Values: ["kiro-flock"] },
    { Name: "tag:ClusterId", Values: [clusterId] },
    { Name: "instance-state-name", Values: ["pending", "running", "stopping", "shutting-down"] },
  ];
  const tagRes = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));
  const ids: string[] = [];
  for (const r of tagRes.Reservations ?? []) {
    for (const inst of r.Instances ?? []) {
      if (inst.InstanceId) ids.push(inst.InstanceId);
    }
  }
  if (ids.length === 0) return;
  await ec2.send(new TerminateInstancesCommand({ InstanceIds: ids }));
}

/**
 * List agent instances belonging to `clusterId`. Always filters by the
 * ClusterId tag so one cluster's describe never sees another's instances,
 * same scoping rule as `stopCluster`.
 */
export async function describeCluster(
  bucket: string,
  clusterId: string = "cluster_0",
): Promise<AgentInstanceInfo[]> {
  // Query EC2 by tags as the single source of truth.
  const filters = [
    { Name: "tag:Project", Values: ["kiro-flock"] },
    { Name: "tag:ClusterId", Values: [clusterId] },
    { Name: "instance-state-name", Values: ["pending", "running", "shutting-down", "stopping"] },
  ];
  const tagRes = await ec2.send(new DescribeInstancesCommand({ Filters: filters }));

  const agents: AgentInstanceInfo[] = [];
  for (const reservation of tagRes.Reservations ?? []) {
    for (const inst of reservation.Instances ?? []) {
      const state = inst.State?.Name ?? "unknown";
      const indexTag = inst.Tags?.find(t => t.Key === "AgentIndex");
      agents.push({
        instanceId: inst.InstanceId ?? "",
        agentIndex: indexTag?.Value != null ? Number(indexTag.Value) : -1,
        state,
        launchTime: inst.LaunchTime?.toISOString() ?? null,
      });
    }
  }

  if (agents.length === 0) return [];

  return agents.sort((a, b) => a.agentIndex - b.agentIndex);
}
