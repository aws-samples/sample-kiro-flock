import {
  EC2Client,
  RunInstancesCommand,
  TerminateInstancesCommand,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { ClusterConfig, resolveAgentModel } from "./s3Store";
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
  /** The profile carrying the deployer role. Used when `config.trustDeploy`
   *  is set; absent on a stack that predates it, in which case a trusted
   *  cluster cannot start (the role it needs does not exist). */
  deployerInstanceProfileArn?: string;
  /** Public subnet IDs, one per AZ. Instances are spread across them and a
   *  per-instance capacity shortage (InsufficientInstanceCapacity) falls back
   *  to the next subnet before giving up. Single-element lists behave like the
   *  old single-AZ launch. */
  subnetIds: string[];
}

/** How many RunInstances calls to keep in flight at once.
 *
 *  Launching sequentially is simple but O(N) in wall-clock. At 64 agents,
 *  with the per-instance AZ-fallback cost under a capacity shortage (two
 *  failed RunInstances attempts before a success, a few seconds each), the
 *  sequential loop blew past the launcher Lambda's 120s timeout and left a
 *  partial fleet — which the async retry then disowned via the double-start
 *  guard. A bounded-concurrency window collapses the launch to a handful of
 *  seconds while staying gentle enough on the RunInstances rate limit that
 *  the (shortened) throttle backoff in runInstanceWithRetry can absorb the
 *  occasional RequestLimitExceeded. */
const LAUNCH_CONCURRENCY = 16;

/**
 * Run `fn` over `items` with at most `limit` concurrent executions, preserving
 * result order. A pool of `limit` workers pulls from a shared cursor. On the
 * first error a worker records it and sets the abort flag so no new launches
 * are dispatched; in-flight calls finish, then the recorded error is rethrown.
 * Results for slots completed before the abort are dropped on the throw path —
 * the caller's catch terminates any partial fleet by ClusterId tag, so they
 * don't need to be returned.
 */
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

  const workerCount = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError !== null) throw firstError;
  return results;
}

/**
 * Launch one EC2 instance per agent slot in the cluster.
 *
 * `clusterId` is stamped onto every instance as a `ClusterId` tag and
 * threaded into the agent user-data so each agent reads/writes under the
 * correct S3 prefix. Defaults to `"cluster_0"` so single-cluster callers
 * that haven't been updated keep working (backwards compat with the
 * pre-WeltenBuilder shape).
 *
 * Launches run concurrently in a bounded window (LAUNCH_CONCURRENCY) so a
 * large cluster comes up in seconds rather than minutes. Each agent still
 * gets its own AZ-preference rotation and the full AZ-fallback + throttle
 * backoff. On the first hard failure (all AZs capacity-exhausted, or any
 * non-throttle error) the launch stops dispatching and rethrows; the
 * handler's catch terminates the partial fleet by tag and records lastError.
 */
export async function startCluster(
  ctx: StartClusterContext,
  config: ClusterConfig,
  clusterId: string = "cluster_0",
): Promise<string[]> {
  const region = await ec2.config.region();

  // Defensive: a misconfigured stack could hand us an empty list. Fail loudly
  // rather than calling RunInstances with no subnet (which the SDK rejects
  // with a confusing error).
  if (ctx.subnetIds.length === 0) {
    throw new Error("startCluster: no subnet IDs provided (check SUBNET_IDS env)");
  }
  // trustDeploy is an IAM decision made here, once, at launch: a trusted
  // cluster runs on the deployer role (which can assume the CDK bootstrap
  // roles), every other cluster on the agent role (which cannot).
  const instanceProfileArn = config.trustDeploy ? ctx.deployerInstanceProfileArn : ctx.instanceProfileArn;
  if (!instanceProfileArn) {
    throw new Error(
      "startCluster: trustDeploy is set but the stack has no deployer instance profile. " +
      "Redeploy the stack (setup.sh) to provision the deployer role.",
    );
  }

  const indexes = Array.from({ length: config.concurrency }, (_, i) => i);

  const launchAgent = async (i: number): Promise<string | null> => {
    const userData = renderAgentUserData({
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
    });

    // Spread instances across AZs by rotating the subnet preference order per
    // agent index. Agent 0 prefers subnet[0], agent 1 prefers subnet[1], and
    // so on, wrapping around. runInstanceWithRetry then walks the rotated list
    // on capacity shortage so a hot AZ doesn't sink the whole launch.
    const offset = i % ctx.subnetIds.length;
    const subnetPreference = [
      ...ctx.subnetIds.slice(offset),
      ...ctx.subnetIds.slice(0, offset),
    ];

    return runInstanceWithRetry(ec2, {
      ImageId: ctx.amiId,
      InstanceType: config.instanceType as any,
      MinCount: 1,
      MaxCount: 1,
      SecurityGroupIds: [ctx.securityGroupId],
      IamInstanceProfile: { Arn: instanceProfileArn },
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
    }, subnetPreference);
  };

  const launched = await mapWithConcurrency(indexes, LAUNCH_CONCURRENCY, launchAgent);
  return launched.filter((id): id is string => id !== null);
}

/**
 * RunInstances with two layers of resilience:
 *
 *  1. Throttle backoff. EC2 throttles accounts that fire many RunInstances
 *     calls in quick succession — now expected, since startCluster launches
 *     up to LAUNCH_CONCURRENCY at once. Throttle codes (RequestLimitExceeded /
 *     Throttling / ThrottlingException) are retried in-place with jittered
 *     exponential backoff. The backoff is deliberately short (0.5s, 1s, 2s
 *     base, 3 retries) so a large concurrent launch stays comfortably inside
 *     the launcher Lambda's timeout even when several agents back off at once.
 *     Throttling is account-wide, not AZ-specific, so we do NOT switch subnets
 *     for it.
 *
 *  2. AZ fallback. InsufficientInstanceCapacity means the requested instance
 *     type has no capacity in that specific AZ. We walk `subnetPreference` in
 *     order, moving to the next subnet/AZ on a capacity shortage, and only
 *     give up (rethrow the last capacity error) once every AZ is exhausted.
 *     The caller's try/catch then records the failure as lastError.
 *
 * Any other RunInstances error is rethrown immediately — it's not something a
 * retry or a different AZ will fix.
 *
 * `params` must NOT carry a SubnetId; this function sets it per attempt from
 * `subnetPreference`.
 */
async function runInstanceWithRetry(
  client: EC2Client,
  params: ConstructorParameters<typeof RunInstancesCommand>[0],
  subnetPreference: string[],
  maxRetries = 3,
): Promise<string | null> {
  let lastCapacityErr: unknown = null;

  for (let s = 0; s < subnetPreference.length; s++) {
    const subnetId = subnetPreference[s];

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await client.send(new RunInstancesCommand({ ...params, SubnetId: subnetId }));
        return res.Instances?.[0]?.InstanceId ?? null;
      } catch (err: unknown) {
        const code = (err as { name?: string; Code?: string }).name
          ?? (err as { Code?: string }).Code ?? "";

        // Capacity shortage in this AZ — soft failure. Stop retrying this
        // subnet and fall through to the next one in preference order.
        if (code === "InsufficientInstanceCapacity") {
          lastCapacityErr = err;
          const next = subnetPreference[s + 1];
          console.log(
            `RunInstances InsufficientInstanceCapacity in subnet ${subnetId}` +
            (next ? `, falling back to ${next}` : " (no more subnets to try)"),
          );
          break; // next subnet
        }

        const isThrottle = code === "RequestLimitExceeded"
          || code === "Throttling"
          || code === "ThrottlingException";

        // Non-throttle, non-capacity errors are not retryable and won't be
        // fixed by another AZ. Surface immediately.
        if (!isThrottle) {
          throw err;
        }

        // Throttle: account-wide, so retrying a different subnet wouldn't
        // help. Back off and retry the SAME subnet, up to maxRetries.
        if (attempt === maxRetries) {
          throw err;
        }
        const baseMs = 500 * Math.pow(2, attempt);
        const jitter = Math.floor(Math.random() * 500);
        const delayMs = baseMs + jitter;
        console.log(`RunInstances throttled (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${delayMs}ms`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // Every subnet was capacity-exhausted. Rethrow the last capacity error so
  // the caller records it as lastError (code InsufficientInstanceCapacity).
  if (lastCapacityErr) throw lastCapacityErr;
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
