/**
 * Snapshot builder Lambda.
 *
 * Async worker invoked by the API handler when `/cluster/status` finds a
 * stale or missing snapshot. Fetches everything the dashboard needs from
 * S3, EC2, and CloudWatch, then writes the composed snapshot to
 * `{clusterId}/store/cluster-snapshot.json`.
 *
 * Design goals:
 *  - O(1) for the API handler: a single GetObject replaces per-poll
 *    aggregation.
 *  - Scales to ~1000 agents. Agent log reads are tail-only (Range:
 *    bytes=-8192) and executed in parallel. DescribeInstances is one call.
 *    GetMetricData is batched at 500 queries per call and the batches
 *    run in parallel.
 *
 * Event payload: `{ clusterId?: string }`. When omitted the builder falls
 * back to the default cluster id so standalone single-cluster installs
 * keep working unchanged.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  EC2Client,
  DescribeInstancesCommand,
} from "@aws-sdk/client-ec2";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { parseTail, type AgentLogEntry } from "./tailParser";
import {
  DEFAULT_CLUSTER_ID,
  clusterPrefix,
  readConfig,
  readState,
  type ClusterConfig,
  type ClusterStateValue,
} from "./s3Store";

const BUCKET = process.env.BUCKET_NAME!;

// How many trailing bytes to read per agent log. 8 KiB is plenty for the
// last two entries even when the file grows unbounded — each iteration
// record is well under 1 KiB.
const TAIL_BYTES = 8192;

// CloudWatch GetMetricData hard limit is 500 queries per call.
const CW_BATCH_SIZE = 500;

const s3 = new S3Client({});
const ec2 = new EC2Client({});
const cw = new CloudWatchClient({});

// Must match the metric shape consumed by web/app.js and the previous
// handler.ts implementation. Changes here must be mirrored in the UI.
const METRICS = [
  { name: "CPUUtilization", stat: "Average", key: "cpu" },
  { name: "NetworkIn", stat: "Sum", key: "netIn" },
  { name: "NetworkOut", stat: "Sum", key: "netOut" },
  { name: "StatusCheckFailed", stat: "Maximum", key: "status" },
] as const;

interface AgentMetrics {
  cpu: number | null;
  netIn: number | null;
  netOut: number | null;
  status: number | null;
}

interface InstanceInfo {
  instanceId: string;
  agentIndex: number;
  state: string;
  launchTime: string | null;
}

interface AgentSnapshot {
  agentId: string;
  instanceId: string | null;
  instanceState: string;
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
  elapsedSeconds: number | null;
  status: string;
  neighbours: string[];
  metrics: AgentMetrics;
}

interface ClusterSnapshot {
  lastBuilt: string;
  agents: AgentSnapshot[];
  clusterState: ClusterStateValue;
  clusterStartTime: string | null;
  paused: boolean;
  /** Pass 7: selected config fields the dashboard needs to theme itself
   *  and to show the right labels. Null when config.json is missing. */
  config: ClusterConfig | null;
}

// ---------- Config -----------------------------------------------------------

/**
 * Read this cluster's config. Returns null when the file is missing so
 * the builder can still produce a partial snapshot (useful during cluster
 * creation before SeedConfig has finished writing).
 */
async function readClusterConfig(clusterId: string): Promise<ClusterConfig | null> {
  try {
    return await readConfig(BUCKET, clusterId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found in bucket")) return null;
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/**
 * Read `{clusterId}/store/state.json` and return the cluster's lifecycle
 * state plus a derived `paused` boolean for the legacy snapshot field.
 * State.json is the single source of truth for the cluster state machine
 * — written by the Lambda on every operator transition and by agents on
 * Starting → Running and on autopause. Missing file means stopped.
 */
async function readClusterStateDoc(clusterId: string): Promise<{ state: ClusterStateValue; paused: boolean }> {
  const { doc } = await readState(BUCKET, clusterId);
  return { state: doc.state, paused: doc.state === "paused" };
}

// ---------- Agent enumeration ------------------------------------------------

/**
 * Enumerate agent indexes by listing `{clusterId}/store/agent-*.ndjson` in
 * S3. Returns `{ index, lastModified }` tuples so the swarm algorithm can
 * rank agents by recency without an extra LIST call. Using the bucket as
 * source of truth keeps the snapshot accurate if the cluster is mid-
 * restart and the config hasn't caught up. Sorted ascending by index.
 */
async function listAgentIndexes(clusterId: string): Promise<Array<{ index: number; lastModified: Date | null }>> {
  const prefix = `${clusterPrefix(clusterId)}store/agent-`;
  const keyPattern = new RegExp(`^${clusterPrefix(clusterId)}store/agent-(\\d+)\\.ndjson$`);
  const found = new Map<number, Date | null>();
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const match = obj.Key.match(keyPattern);
      if (match) found.set(Number(match[1]), obj.LastModified ?? null);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return Array.from(found.entries())
    .map(([index, lastModified]) => ({ index, lastModified }))
    .sort((a, b) => a.index - b.index);
}

// ---------- Agent log tails --------------------------------------------------

async function readAgentTail(clusterId: string, agentIndex: number): Promise<{
  agentIndex: number;
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
}> {
  const key = `${clusterPrefix(clusterId)}store/agent-${agentIndex}.ndjson`;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Range: `bytes=-${TAIL_BYTES}`,
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    // When the file is smaller than TAIL_BYTES, S3 returns the whole file
    // and the first line is complete. ContentRange is like
    // "bytes 0-123/124" in that case. We treat any returned range whose
    // start is 0 as "not partial".
    const contentRange = res.ContentRange ?? "";
    const startsAtZero = /^bytes 0-/.test(contentRange);
    const parsed = parseTail(body, !startsAtZero);
    return { agentIndex, ...parsed };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NoSuchBucket") {
      return { agentIndex, lastEntry: null, prevEntry: null, lastUpdatedTs: null };
    }
    // A ranged read against an empty object returns InvalidRange.
    if (name === "InvalidRange") {
      return { agentIndex, lastEntry: null, prevEntry: null, lastUpdatedTs: null };
    }
    throw err;
  }
}

// ---------- EC2 --------------------------------------------------------------

async function describeFleet(clusterId: string): Promise<InstanceInfo[]> {
  const res = await ec2.send(new DescribeInstancesCommand({
    Filters: [
      { Name: "tag:Project", Values: ["kiro-flock"] },
      // Scope to this cluster so one cluster's snapshot never inherits
      // another cluster's agent panels. Without this filter a stopped
      // cluster_0 would show the agents of whichever cluster happened
      // to launch first because AgentIndex is the only key we match on.
      { Name: "tag:ClusterId", Values: [clusterId] },
      { Name: "instance-state-name", Values: ["pending", "running", "shutting-down", "stopping"] },
    ],
  }));
  const out: InstanceInfo[] = [];
  for (const r of res.Reservations ?? []) {
    for (const inst of r.Instances ?? []) {
      const indexTag = inst.Tags?.find(t => t.Key === "AgentIndex");
      out.push({
        instanceId: inst.InstanceId ?? "",
        agentIndex: indexTag?.Value != null ? Number(indexTag.Value) : -1,
        state: inst.State?.Name ?? "unknown",
        launchTime: inst.LaunchTime?.toISOString() ?? null,
      });
    }
  }
  return out.sort((a, b) => a.agentIndex - b.agentIndex);
}

// ---------- Metrics ----------------------------------------------------------

function emptyMetrics(): AgentMetrics {
  return { cpu: null, netIn: null, netOut: null, status: null };
}

/**
 * Fetch CloudWatch metrics for a set of instance IDs. Builds one query per
 * (instance, metric) pair, splits into batches of 500 to respect the
 * GetMetricData limit, and runs batches in parallel.
 */
async function getInstanceMetrics(instanceIds: string[]): Promise<Record<string, AgentMetrics>> {
  const result: Record<string, AgentMetrics> = {};
  for (const id of instanceIds) result[id] = emptyMetrics();
  if (instanceIds.length === 0) return result;

  const queries: Array<{ query: MetricDataQuery; instanceId: string; metricKey: string }> = [];
  for (const id of instanceIds) {
    for (const m of METRICS) {
      queries.push({
        query: {
          // GetMetricData requires Id to match ^[a-z][a-zA-Z0-9_]*$. We use
          // the query array index so it stays short and unique.
          Id: `m${queries.length}`,
          MetricStat: {
            Metric: {
              Namespace: "AWS/EC2",
              MetricName: m.name,
              Dimensions: [{ Name: "InstanceId", Value: id }],
            },
            Period: 300,
            Stat: m.stat,
          },
        },
        instanceId: id,
        metricKey: m.key,
      });
    }
  }

  const now = new Date();
  const startTime = new Date(now.getTime() - 10 * 60 * 1000);

  // Batch into groups of CW_BATCH_SIZE. Each batch carries its own index
  // → (instanceId, metricKey) lookup so we can route responses back.
  const batches: Array<{
    indexMap: Map<string, { instanceId: string; metricKey: string }>;
    queries: MetricDataQuery[];
  }> = [];
  for (let i = 0; i < queries.length; i += CW_BATCH_SIZE) {
    const chunk = queries.slice(i, i + CW_BATCH_SIZE);
    const indexMap = new Map<string, { instanceId: string; metricKey: string }>();
    const qs: MetricDataQuery[] = [];
    chunk.forEach((q, j) => {
      // Re-id within the batch so IDs stay compact and deterministic.
      const id = `m${j}`;
      indexMap.set(id, { instanceId: q.instanceId, metricKey: q.metricKey });
      qs.push({ ...q.query, Id: id });
    });
    batches.push({ indexMap, queries: qs });
  }

  const responses = await Promise.all(batches.map(batch =>
    cw.send(new GetMetricDataCommand({
      MetricDataQueries: batch.queries,
      StartTime: startTime,
      EndTime: now,
    })).then(res => ({ res, indexMap: batch.indexMap }))
  ));

  for (const { res, indexMap } of responses) {
    for (const r of res.MetricDataResults ?? []) {
      if (!r.Id) continue;
      const mapping = indexMap.get(r.Id);
      if (!mapping) continue;
      const values = r.Values ?? [];
      if (values.length > 0) {
        (result[mapping.instanceId] as unknown as Record<string, number | null>)[mapping.metricKey] = values[0];
      }
    }
  }

  return result;
}

// ---------- Topology --------------------------------------------------------

// Ring-topology neighbour calculation for the amorphous algorithm.
// Duplicated from agent/neighbourSelector.ts so the snapshot builder is
// self-contained (no shared module between Lambda code and agent code).
// Any change here must also land in the other copy.
function amorphousNeighbours(index: number, concurrency: number, radius: number): string[] {
  if (radius === 0 || concurrency <= 1) return [];
  const seen = new Set<number>();
  for (let k = -radius; k <= radius; k++) {
    if (k === 0) continue;
    seen.add(((index + k) % concurrency + concurrency) % concurrency);
  }
  seen.delete(index);
  return Array.from(seen).sort((a, b) => a - b).slice(0, concurrency - 1).map(i => `agent-${i}`);
}

/**
 * Compute the neighbour list each agent will see on its next iteration,
 * based on the configured algorithm. Mirrors the agent-side logic in
 * agent/neighbourSelector.ts so the dashboard label matches what the
 * running agents actually read.
 *
 * swarmRanked is the pre-sorted output of listAgentIndexes() re-ordered
 * by lastModified desc. For swarm we take the top K excluding self.
 */
function neighboursForAgent(
  index: number,
  concurrency: number,
  algorithm: "amorphous" | "mesh" | "swarm",
  radius: number,
  swarmK: number,
  swarmRanked: number[],
): string[] {
  if (algorithm === "mesh") {
    const out: string[] = [];
    for (let i = 0; i < concurrency; i++) {
      if (i !== index) out.push(`agent-${i}`);
    }
    return out;
  }
  if (algorithm === "swarm") {
    const picked = swarmRanked.filter((i) => i !== index).slice(0, swarmK);
    // Fall back to amorphous ring when no activity exists yet (same edge
    // case the agent-side selector handles). Keeps the dashboard label
    // accurate during iteration 0.
    if (picked.length === 0) {
      return amorphousNeighbours(index, concurrency, radius);
    }
    return picked.slice().sort((a, b) => a - b).map((i) => `agent-${i}`);
  }
  return amorphousNeighbours(index, concurrency, radius);
}

// ---------- Cluster state ---------------------------------------------------
//
// Cluster state is no longer derived from EC2 + agent activity. It comes
// from `{clusterId}/store/state.json`, written synchronously by every
// operator route (start/stop/pause/resume) and by agents on
// Starting → Running and on autopause. The snapshot just echoes the
// authoritative value into its own field for backwards compatibility
// with older dashboard polls that read `snapshot.clusterState`.

// ---------- Handler ---------------------------------------------------------

interface SnapshotBuilderEvent {
  clusterId?: string;
}

export async function handler(event: SnapshotBuilderEvent, _context: unknown): Promise<void> {
  const started = Date.now();
  // Default to cluster_0 so a legacy invoke with no payload still lands
  // somewhere sensible. Callers (the API handler) always pass clusterId
  // explicitly, but a one-off test invoke from the console shouldn't
  // silently no-op.
  const clusterId = event?.clusterId ?? DEFAULT_CLUSTER_ID;

  // Enumerate agents from S3 and read config + state.json in parallel.
  // We use the union of config.concurrency and the on-disk agent indexes
  // so a mid-restart cluster (logs lagging config, or vice versa) still
  // gets a complete snapshot.
  const [config, agentIndexEntries, instances, stateRead] = await Promise.all([
    readClusterConfig(clusterId),
    listAgentIndexes(clusterId),
    describeFleet(clusterId),
    readClusterStateDoc(clusterId),
  ]);
  const paused = stateRead.paused;

  const concurrency = config?.concurrency ?? 0;
  const radius = config?.neighbourRadius ?? 0;
  const algorithm = config?.algorithm ?? "amorphous";
  const swarmK = config?.swarmK ?? 0;

  const agentIndexes = agentIndexEntries.map((e) => e.index);
  const indexSet = new Set<number>(agentIndexes);
  for (let i = 0; i < concurrency; i++) indexSet.add(i);
  for (const inst of instances) {
    if (inst.agentIndex >= 0) indexSet.add(inst.agentIndex);
  }
  const allIndexes = Array.from(indexSet).sort((a, b) => a - b);

  // Pre-compute the swarm ranking once: indexes ordered by lastModified
  // desc, ties broken by ascending index. Reused for every agent's
  // neighbour list.
  const swarmRanked = agentIndexEntries
    .slice()
    .sort((a, b) => {
      const at = a.lastModified?.getTime() ?? 0;
      const bt = b.lastModified?.getTime() ?? 0;
      if (bt !== at) return bt - at;
      return a.index - b.index;
    })
    .map((e) => e.index);

  // Tails + metrics in parallel. Metrics only need to run when there are
  // live instances; an empty list is cheap to short-circuit.
  const instanceIds = instances.map(i => i.instanceId).filter(Boolean);
  const [tails, metricsMap] = await Promise.all([
    Promise.all(allIndexes.map((i) => readAgentTail(clusterId, i))),
    instanceIds.length > 0 ? getInstanceMetrics(instanceIds) : Promise.resolve<Record<string, AgentMetrics>>({}),
  ]);

  const tailByIndex = new Map(tails.map(t => [t.agentIndex, t]));
  const instanceByIndex = new Map(instances.map(i => [i.agentIndex, i]));

  const now = Date.now();
  const totalAgents = Math.max(concurrency, allIndexes.length > 0 ? (allIndexes[allIndexes.length - 1] + 1) : 0);

  const agents: AgentSnapshot[] = allIndexes.map(i => {
    const tail = tailByIndex.get(i) ?? { agentIndex: i, lastEntry: null, prevEntry: null, lastUpdatedTs: null };
    const inst = instanceByIndex.get(i);
    const elapsed = tail.lastUpdatedTs
      ? Math.round((now - new Date(tail.lastUpdatedTs).getTime()) / 1000)
      : null;

    // Per-agent status uses the same five lifecycle values as the cluster
    // state machine. The cluster's `paused` setting wins over per-agent
    // computation: a paused cluster's instances are still alive, the loop
    // is just parked between iterations, and the dashboard should show
    // every panel as paused rather than "running" with stale logs.
    let status: string;
    if (!inst) status = "stopped";
    else if (inst.state === "shutting-down" || inst.state === "stopping") status = "stopping";
    else if (inst.state === "terminated" || inst.state === "stopped") status = "stopped";
    else if (paused) status = "paused";
    else if (!tail.lastEntry) status = "starting";
    else status = "running";

    const metrics = inst?.instanceId ? (metricsMap[inst.instanceId] ?? emptyMetrics()) : emptyMetrics();

    return {
      agentId: `agent-${i}`,
      instanceId: inst?.instanceId ?? null,
      instanceState: inst?.state ?? (status === "stopped" ? "terminated" : "unknown"),
      lastEntry: tail.lastEntry,
      prevEntry: tail.prevEntry,
      lastUpdatedTs: tail.lastUpdatedTs,
      elapsedSeconds: elapsed,
      status,
      neighbours: neighboursForAgent(i, totalAgents, algorithm, radius, swarmK, swarmRanked),
      metrics,
    };
  });

  const clusterState: ClusterStateValue = stateRead.state;
  const launchTimes = instances.map(i => i.launchTime).filter(Boolean) as string[];
  const clusterStartTime = launchTimes.length > 0 ? launchTimes.sort()[0] : null;

  const snapshot: ClusterSnapshot = {
    lastBuilt: new Date().toISOString(),
    agents,
    clusterState,
    clusterStartTime,
    paused,
    config: config ?? null,
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `${clusterPrefix(clusterId)}store/cluster-snapshot.json`,
    Body: JSON.stringify(snapshot),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));

  console.log(
    `snapshot[${clusterId}] built in ${Date.now() - started}ms: ${agents.length} agents, ${instances.length} instances, state=${clusterState}`,
  );
}
