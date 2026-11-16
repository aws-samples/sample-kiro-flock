/**
 * ECS/Fargate compute backend — the RunTask/StopTask/ListTasks mirror of
 * ec2Manager.ts. One Fargate task per agent slot, ARM64 (Graviton
 * pricing, same philosophy as the EC2 Graviton-only instance policy).
 *
 * Task identity and scoping:
 *   - `startedBy` is set to `aga-{clusterId}` (clusterId is capped at 32
 *     chars, so this fits ECS's 36-char startedBy limit). ListTasks can
 *     filter by startedBy directly, which is how stop/describe scope to a
 *     single cluster without a tagging-API round trip.
 *   - Tags Project / ClusterId / AgentIndex are stamped on each task to
 *     match the EC2 tag scheme (dashboards, humans in the console).
 *   - Per-agent config is injected via a container override:
 *     AGA_AGENT_CONFIG carries the same JSON that userData.ts writes to
 *     /etc/aga/agent.json on EC2. bootstrap.ts prefers the env var.
 *
 * Environment (set by the CDK stack on the handler Lambda):
 *   ECS_CLUSTER_ARN     — the AGA ECS cluster
 *   ECS_TASK_DEF_ARN    — agent task definition (family:revision or full ARN)
 *   ECS_CONTAINER_NAME  — container name inside the task def ("agent")
 *   ECS_SUBNET_IDS      — comma-separated public subnet IDs (same as EC2)
 *   ECS_SECURITY_GROUP  — the shared AgentSg
 */
import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  ListTasksCommand,
  DescribeTasksCommand,
  type Task,
} from "@aws-sdk/client-ecs";
import { ClusterConfig, resolveAgentModel } from "./s3Store";
import type { AgentUserDataConfig } from "./userData";

const ecs = new ECSClient({});

/** Same bounded-concurrency shape as ec2Manager's launcher: abort new
 *  dispatches on the first error, let in-flight calls finish, rethrow. */
const LAUNCH_CONCURRENCY = 10;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let aborted = false;
  let firstError: unknown = null;

  async function worker(): Promise<void> {
    while (!aborted) {
      const slot = next++;
      if (slot >= items.length) return;
      try {
        results[slot] = await fn(items[slot]);
      } catch (err) {
        if (firstError === null) firstError = err;
        aborted = true;
        return;
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  if (firstError !== null) throw firstError;
  return results;
}

export interface EcsContext {
  bucket: string;
  clusterArn: string;
  taskDefinitionArn: string;
  /** The task definition on the deployer role. Used when `config.trustDeploy`
   *  is set; absent on a stack that predates it. */
  deployerTaskDefinitionArn?: string;
  containerName: string;
  subnetIds: string[];
  securityGroupId: string;
}

/** Read the ECS context from the Lambda environment. Throws with a clear
 *  message when the stack predates the ECS option (env vars absent). */
export function ecsContextFromEnv(bucket: string): EcsContext {
  const clusterArn = process.env.ECS_CLUSTER_ARN ?? "";
  const taskDefinitionArn = process.env.ECS_TASK_DEF_ARN ?? "";
  const containerName = process.env.ECS_CONTAINER_NAME ?? "agent";
  const subnetIds = (process.env.ECS_SUBNET_IDS ?? process.env.SUBNET_IDS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const securityGroupId = process.env.ECS_SECURITY_GROUP ?? process.env.SECURITY_GROUP_ID ?? "";
  if (!clusterArn || !taskDefinitionArn) {
    throw new Error(
      "ECS compute is not configured (ECS_CLUSTER_ARN / ECS_TASK_DEF_ARN missing). " +
      "Redeploy the stack (setup.sh) to provision the ECS resources.",
    );
  }
  if (subnetIds.length === 0 || !securityGroupId) {
    throw new Error("ECS compute misconfigured: no subnets or security group in env");
  }
  const deployerTaskDefinitionArn = process.env.ECS_DEPLOYER_TASK_DEF_ARN || undefined;
  return { bucket, clusterArn, taskDefinitionArn, deployerTaskDefinitionArn, containerName, subnetIds, securityGroupId };
}

function startedByFor(clusterId: string): string {
  // clusterId is validated to <= 32 chars; "aga-" + 32 = 36 = ECS max.
  return `aga-${clusterId}`;
}

/**
 * Fargate task sizes — the ECS mirror of the EC2 instanceType picker.
 * Applied as task-level RunTask overrides, so a single task definition
 * serves every size. Fargate vCPUs are dedicated (no burstable tier), so
 * "medium" here ≈ the c8g.xlarge the EC2 fleets settled on, not the
 * throttled t4g.medium default.
 */
export const TASK_SIZES = {
  small:  { cpu: "2048",  memory: "4096",  label: "2 vCPU / 4 GiB" },
  medium: { cpu: "4096",  memory: "8192",  label: "4 vCPU / 8 GiB" },
  large:  { cpu: "8192",  memory: "16384", label: "8 vCPU / 16 GiB" },
  xlarge: { cpu: "16384", memory: "32768", label: "16 vCPU / 32 GiB" },
} as const;

export type TaskSize = keyof typeof TASK_SIZES;

/** Normalize a config's taskSize; absent/unknown means "medium". */
export function taskSizeOf(config: Pick<ClusterConfig, "taskSize">): TaskSize {
  const v = config.taskSize;
  return v === "small" || v === "large" || v === "xlarge" ? v : "medium";
}

/** ECS task lastStatus → the EC2-ish state vocabulary the dashboard and
 *  snapshot already understand. */
function mapTaskState(lastStatus: string | undefined): string {
  switch ((lastStatus ?? "").toUpperCase()) {
    case "PROVISIONING":
    case "PENDING":
    case "ACTIVATING":
      return "pending";
    case "RUNNING":
      return "running";
    case "DEACTIVATING":
    case "STOPPING":
    case "DEPROVISIONING":
      return "shutting-down";
    case "STOPPED":
    case "DELETED":
      return "terminated";
    default:
      return "unknown";
  }
}

export interface AgentTaskInfo {
  /** Full task ARN. Fills the `instanceId` slot in snapshot/dashboard
   *  shapes — it's the unique per-agent runtime resource id. */
  taskArn: string;
  agentIndex: number;
  state: string;
  launchTime: string | null;
}

/**
 * Launch one Fargate task per agent slot. Mirrors ec2Manager.startCluster:
 * bounded concurrency, first hard failure aborts and rethrows so the
 * handler's catch can terminate the partial fleet and record lastError.
 * Returns the launched task ARNs.
 */
export async function startCluster(
  ctx: EcsContext,
  config: ClusterConfig,
  clusterId: string = "cluster_0",
): Promise<string[]> {
  const region = await ecs.config.region();
  const indexes = Array.from({ length: config.concurrency }, (_, i) => i);
  // trustDeploy is an IAM decision made here, once, at launch: a trusted
  // cluster runs on the deployer task definition (whose role can assume the
  // CDK bootstrap roles), every other cluster on the agent one (which cannot).
  const taskDefinition = config.trustDeploy ? ctx.deployerTaskDefinitionArn : ctx.taskDefinitionArn;
  if (!taskDefinition) {
    throw new Error(
      "startCluster: trustDeploy is set but the stack has no deployer task definition. " +
      "Redeploy the stack (setup.sh) to provision the deployer role.",
    );
  }

  const launchAgent = async (i: number): Promise<string | null> => {
    // The exact same config shape userData.ts embeds in /etc/aga/agent.json.
    const agentConfig: AgentUserDataConfig = {
      agentIndex: i,
      concurrency: config.concurrency,
      neighbourRadius: config.neighbourRadius,
      bucket: ctx.bucket,
      region,
      loopIntervalSeconds: config.loopIntervalSeconds,
      // Per-agent override wins over the cluster-wide model, so agent i can
      // boot straight onto its own model instead of running one iteration on
      // the cluster default before the loop's reload corrects it.
      model: resolveAgentModel(config, i),
      algorithm: config.algorithm,
      swarmK: config.swarmK,
      clusterId,
      autopause: config.autopause,
      selfOptimizing: config.selfOptimizing,
      browserAutomation: config.browserAutomation,
      everforgeGroup: config.everforgeGroup ?? null,
    };

    const res = await runTaskWithRetry({
      cluster: ctx.clusterArn,
      taskDefinition,
      launchType: "FARGATE",
      count: 1,
      // ECS Exec: embeds an SSM Session Manager agent in the task so a
      // future agentStream reimplementation can run the same chunked-read
      // commands via ExecuteCommand (SSM RunCommand doesn't reach Fargate
      // tasks — they aren't managed instances). The task role carries the
      // required ssmmessages:* permissions (see CDK stack). Enabled now so
      // running clusters don't need a restart when the stream lands.
      enableExecuteCommand: true,
      startedBy: startedByFor(clusterId),
      group: startedByFor(clusterId),
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ctx.subnetIds,
          securityGroups: [ctx.securityGroupId],
          // Public subnets, no NAT — same as EC2: tasks need public IPs to
          // reach S3 / Kiro endpoints.
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        // Task-level sizing from config.taskSize — overrides the task
        // definition's baked-in cpu/memory per launch.
        cpu: TASK_SIZES[taskSizeOf(config)].cpu,
        memory: TASK_SIZES[taskSizeOf(config)].memory,
        containerOverrides: [{
          name: ctx.containerName,
          environment: [
            { name: "AGA_AGENT_CONFIG", value: JSON.stringify(agentConfig) },
          ],
        }],
      },
      tags: [
        { key: "Project", value: "kiro-flock" },
        { key: "ClusterId", value: clusterId },
        { key: "AgentIndex", value: String(i) },
        { key: "Name", value: `aga-${clusterId}-agent-${i}` },
      ],
    });
    return res;
  };

  const launched = await mapWithConcurrency(indexes, LAUNCH_CONCURRENCY, launchAgent);
  return launched.filter((arn): arn is string => arn !== null);
}

/**
 * RunTask with throttle backoff and capacity retry.
 *
 * Fargate has no per-AZ capacity fallback to walk (the service places the
 * task across the provided subnets itself), so unlike EC2 there is only
 * one axis of resilience: retry-in-place with jittered backoff on
 * throttles and on Fargate's transient "Capacity is unavailable at this
 * time" failures (surfaced per-task, not thrown). Everything else is a
 * hard error.
 */
async function runTaskWithRetry(
  params: ConstructorParameters<typeof RunTaskCommand>[0],
  maxRetries = 4,
): Promise<string | null> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let failureReason: string | null = null;
    try {
      const res = await ecs.send(new RunTaskCommand(params));
      const arn = res.tasks?.[0]?.taskArn;
      if (arn) return arn;
      // RunTask can "succeed" with an empty tasks list and a failures[]
      // entry (e.g. Capacity is unavailable). Treat retryable reasons as
      // soft; rethrow the rest.
      const failure = res.failures?.[0];
      failureReason = failure ? `${failure.reason ?? "unknown"}: ${failure.detail ?? ""}` : "no task returned";
      const retryable = /capacity|throttl|limit/i.test(failureReason);
      if (!retryable) throw new Error(`RunTask failed: ${failureReason}`);
    } catch (err: unknown) {
      if (failureReason === null) {
        const code = (err as { name?: string }).name ?? "";
        const isThrottle = code === "ThrottlingException"
          || code === "Throttling"
          || code === "RequestLimitExceeded";
        if (!isThrottle) throw err;
        failureReason = code;
      } else {
        throw err;
      }
    }
    if (attempt === maxRetries) {
      throw new Error(`RunTask failed after ${maxRetries + 1} attempts: ${failureReason}`);
    }
    const delayMs = 500 * Math.pow(2, attempt) + Math.floor(Math.random() * 500);
    console.log(`RunTask retry (${failureReason}), attempt ${attempt + 1}/${maxRetries + 1} in ${delayMs}ms`);
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return null; // unreachable
}

/** List this cluster's live task ARNs (desiredStatus RUNNING covers
 *  provisioning + running; tasks told to stop drop out immediately). */
async function listLiveTaskArns(ctx: EcsContext, clusterId: string): Promise<string[]> {
  const arns: string[] = [];
  let nextToken: string | undefined;
  do {
    const res = await ecs.send(new ListTasksCommand({
      cluster: ctx.clusterArn,
      startedBy: startedByFor(clusterId),
      desiredStatus: "RUNNING",
      nextToken,
    }));
    arns.push(...(res.taskArns ?? []));
    nextToken = res.nextToken;
  } while (nextToken);
  return arns;
}

/** Stop every task belonging to `clusterId`. Scoped by startedBy, so one
 *  cluster's stop never touches another's tasks. */
export async function stopCluster(ctx: EcsContext, clusterId: string = "cluster_0"): Promise<void> {
  const arns = await listLiveTaskArns(ctx, clusterId);
  await Promise.all(arns.map(taskArn =>
    ecs.send(new StopTaskCommand({
      cluster: ctx.clusterArn,
      task: taskArn,
      reason: "operator stop",
    })),
  ));
}

/** Describe this cluster's tasks in the ec2Manager describeCluster shape. */
export async function describeCluster(
  ctx: EcsContext,
  clusterId: string = "cluster_0",
): Promise<AgentTaskInfo[]> {
  const arns = await listLiveTaskArns(ctx, clusterId);
  if (arns.length === 0) return [];

  // DescribeTasks caps at 100 ARNs per call.
  const tasks: Task[] = [];
  for (let i = 0; i < arns.length; i += 100) {
    const res = await ecs.send(new DescribeTasksCommand({
      cluster: ctx.clusterArn,
      tasks: arns.slice(i, i + 100),
      include: ["TAGS"],
    }));
    tasks.push(...(res.tasks ?? []));
  }

  const agents: AgentTaskInfo[] = tasks.map((t) => {
    const indexTag = t.tags?.find(tag => tag.key === "AgentIndex");
    return {
      taskArn: t.taskArn ?? "",
      agentIndex: indexTag?.value != null ? Number(indexTag.value) : -1,
      state: mapTaskState(t.lastStatus),
      launchTime: t.createdAt ? new Date(t.createdAt).toISOString() : null,
    };
  });
  return agents.sort((a, b) => a.agentIndex - b.agentIndex);
}

/** Count live tasks for a cluster — double-start guard + stop reconcile. */
export async function countLiveTasks(ctx: EcsContext, clusterId: string): Promise<number> {
  return (await listLiveTaskArns(ctx, clusterId)).length;
}
