/**
 * Compute manager — one interface over the per-backend agent runtimes.
 *
 * Backends:
 *   "ec2" — one EC2 instance per agent (ec2Manager.ts). The original.
 *   "ecs" — one Fargate ARM64 task per agent (ecsManager.ts).
 *
 * The handler dispatches on `config.computeType` (restart-required field,
 * default "ecs" for faster startup). Each manager exposes the same lifecycle surface:
 *
 *   start        — launch one runtime per agent slot, returns resource ids
 *   stop         — terminate every runtime belonging to the cluster
 *   describe     — list the cluster's runtimes as AgentRuntimeInfo
 *   liveCount    — number of live runtimes (double-start guard, stop check)
 *   liveClusterIds — which of the given clusters still have live runtimes
 *                    (the /cluster/list stopping→stopped reconcile)
 *
 * `resourceId` is an EC2 instance id or an ECS task ARN — the snapshot
 * builder and dashboard treat it as an opaque per-agent runtime id.
 */
import {
  EC2Client,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import { ClusterConfig } from "./s3Store";
import * as ec2Manager from "./ec2Manager";
import * as ecsManager from "./ecsManager";

export type ComputeType = "ec2" | "ecs";

/** Normalize a config's computeType, defaulting configs that predate the
 *  field to ECS (faster startup). */
export function computeTypeOf(config: Pick<ClusterConfig, "computeType"> | null | undefined): ComputeType {
  return config?.computeType === "ec2" ? "ec2" : "ecs";
}

export interface AgentRuntimeInfo {
  /** EC2 instance id or ECS task ARN. */
  resourceId: string;
  agentIndex: number;
  /** EC2-ish state vocabulary: pending | running | shutting-down | ... */
  state: string;
  launchTime: string | null;
}

export interface ComputeManager {
  readonly computeType: ComputeType;
  start(config: ClusterConfig, clusterId: string): Promise<string[]>;
  stop(clusterId: string): Promise<void>;
  describe(clusterId: string): Promise<AgentRuntimeInfo[]>;
  liveCount(clusterId: string): Promise<number>;
  liveClusterIds(clusterIds: string[]): Promise<Set<string>>;
}

// ---------------------------------------------------------------------------
// EC2 backend
// ---------------------------------------------------------------------------

const ec2 = new EC2Client({});

function ec2ContextFromEnv(bucket: string): ec2Manager.StartClusterContext {
  return {
    bucket,
    amiId: process.env.AMI_ID ?? "",
    securityGroupId: process.env.SECURITY_GROUP_ID ?? "",
    instanceProfileArn: process.env.INSTANCE_PROFILE_ARN ?? "",
    deployerInstanceProfileArn: process.env.DEPLOYER_INSTANCE_PROFILE_ARN || undefined,
    subnetIds: (process.env.SUBNET_IDS ?? process.env.SUBNET_ID ?? "")
      .split(",").map(s => s.trim()).filter(Boolean),
  };
}

/** DescribeInstances filtered to live instances of the given clusters,
 *  returning the set of cluster ids that still have at least one. */
async function ec2LiveClusterIds(clusterIds: string[]): Promise<Set<string>> {
  const live = new Set<string>();
  if (clusterIds.length === 0) return live;
  const res = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "tag:Project", Values: ["kiro-flock"] },
      { Name: "tag:ClusterId", Values: clusterIds },
      { Name: "instance-state-name", Values: ["pending", "running", "stopping", "shutting-down"] },
    ],
  }));
  for (const r of res.Reservations ?? []) {
    for (const inst of r.Instances ?? []) {
      const tag = inst.Tags?.find(t => t.Key === "ClusterId");
      if (tag?.Value) live.add(tag.Value);
    }
  }
  return live;
}

function makeEc2Manager(bucket: string): ComputeManager {
  return {
    computeType: "ec2",
    start: (config, clusterId) =>
      ec2Manager.startCluster(ec2ContextFromEnv(bucket), config, clusterId),
    stop: (clusterId) => ec2Manager.stopCluster(bucket, clusterId),
    describe: async (clusterId) =>
      (await ec2Manager.describeCluster(bucket, clusterId)).map(i => ({
        resourceId: i.instanceId,
        agentIndex: i.agentIndex,
        state: i.state,
        launchTime: i.launchTime,
      })),
    liveCount: async (clusterId) =>
      (await ec2Manager.describeCluster(bucket, clusterId)).length,
    liveClusterIds: ec2LiveClusterIds,
  };
}

// ---------------------------------------------------------------------------
// ECS backend
// ---------------------------------------------------------------------------

function makeEcsManager(bucket: string): ComputeManager {
  const ctx = () => ecsManager.ecsContextFromEnv(bucket);
  return {
    computeType: "ecs",
    start: (config, clusterId) => ecsManager.startCluster(ctx(), config, clusterId),
    stop: (clusterId) => ecsManager.stopCluster(ctx(), clusterId),
    describe: async (clusterId) =>
      (await ecsManager.describeCluster(ctx(), clusterId)).map(t => ({
        resourceId: t.taskArn,
        agentIndex: t.agentIndex,
        state: t.state,
        launchTime: t.launchTime,
      })),
    liveCount: (clusterId) => ecsManager.countLiveTasks(ctx(), clusterId),
    liveClusterIds: async (clusterIds) => {
      const c = ctx();
      const counts = await Promise.all(
        clusterIds.map(async (id) => [id, await ecsManager.countLiveTasks(c, id)] as const),
      );
      return new Set(counts.filter(([, n]) => n > 0).map(([id]) => id));
    },
  };
}

// ---------------------------------------------------------------------------

export function getComputeManager(computeType: ComputeType, bucket: string): ComputeManager {
  return computeType === "ecs" ? makeEcsManager(bucket) : makeEc2Manager(bucket);
}
