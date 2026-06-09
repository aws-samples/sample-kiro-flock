// S3 key layout (per cluster, prefixed with {clusterId}/):
// {clusterId}/config.json            — cluster config
// {clusterId}/direction.md           — cluster direction
// {clusterId}/store/state.json       — authoritative cluster lifecycle state
// {clusterId}/store/agent-N.ndjson   — agent logs (NDJSON, one JSON per line)
// {clusterId}/store/cluster-snapshot.json — pre-computed dashboard snapshot
//
// Environment is shared across clusters under the bucket-level `environment/`
// folder. Each cluster's primary workspace is `environment/{clusterId}/`.
//
// The registry lives at the bucket root:
// clusters.json                     — ClusterRegistry (all registered clusters)

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

/** Default cluster id used for backwards compatibility when callers omit a
 *  cluster id. A standalone kiro-flock install behaves as a WeltenBuilder
 *  with one cluster named "cluster_0". */
export const DEFAULT_CLUSTER_ID = "cluster_0";

/** Returns the S3 key prefix for a cluster's operational data:
 *  config, direction, store/.
 *  Example: clusterPrefix("cluster_0") → "cluster_0/". */
export function clusterPrefix(clusterId: string = DEFAULT_CLUSTER_ID): string {
  return `${clusterId}/`;
}

/** Returns the S3 key prefix for a cluster's environment subfolder under the
 *  shared environment/ root.
 *  Example: envPrefix("cluster_0") → "environment/cluster_0/". */
export function envPrefix(clusterId: string = DEFAULT_CLUSTER_ID): string {
  return `environment/${clusterId}/`;
}

/** Cluster lifecycle state. The same five values are used both for the
 *  cluster as a whole (from state.json) and for individual agents (derived
 *  from EC2 state + log activity, with the cluster's Paused state taking
 *  precedence over the per-agent computation). */
export type ClusterStateValue = "starting" | "running" | "paused" | "stopping" | "stopped";

export const STATE_FILE_KEY_SUFFIX = "store/state.json";

export function stateFileKey(clusterId: string = DEFAULT_CLUSTER_ID): string {
  return `${clusterPrefix(clusterId)}${STATE_FILE_KEY_SUFFIX}`;
}

/** Authoritative cluster state document. Single source of truth for which
 *  lifecycle phase the cluster is in. Written by the Lambda on every
 *  operator action, by agents on Starting → Running and on autopause.
 *  Reads are unconditional; writes from agents use the matching ETag as
 *  an If-Match precondition so a Lambda transition that fires inside the
 *  agent's read-modify-write window always wins. */
export interface ClusterStateDoc {
  state: ClusterStateValue;
  /** ISO-8601 UTC timestamp of the transition. */
  transitionedAt: string;
  /** Who wrote the transition. "operator" for Lambda routes; "agent-N"
   *  for autopause and Starting → Running. */
  transitionedBy: string;
  /** Optional context. "manual", "autopause", "stop-all", "pause-all",
   *  "first-iteration", "reconcile" — informational, not consumed by code. */
  reason?: string;
}

export interface ClusterStateRead {
  doc: ClusterStateDoc;
  etag: string | null;
}

/** Read state.json. Missing file is treated as "stopped" — a freshly
 *  created cluster that has never been started has no state.json yet,
 *  and the absence of the document is itself a meaningful signal. */
export async function readState(
  bucket: string,
  clusterId: string = DEFAULT_CLUSTER_ID,
): Promise<ClusterStateRead> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: stateFileKey(clusterId),
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) {
      return { doc: { state: "stopped", transitionedAt: "1970-01-01T00:00:00.000Z", transitionedBy: "system" }, etag: null };
    }
    const parsed = JSON.parse(body) as ClusterStateDoc;
    return { doc: parsed, etag: res.ETag ?? null };
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NoSuchKey") {
      return { doc: { state: "stopped", transitionedAt: "1970-01-01T00:00:00.000Z", transitionedBy: "system" }, etag: null };
    }
    throw e;
  }
}

/** Write state.json. When `ifMatch` is supplied, the put includes an
 *  If-Match header so a concurrent transition that updated state.json
 *  between the caller's read and write will fail with 412. Lambda routes
 *  call this without ifMatch (operator intent always wins). Agent writers
 *  always pass the etag they read so an in-flight operator transition
 *  silently aborts the agent's write rather than overwriting it. */
export async function writeState(
  bucket: string,
  clusterId: string,
  doc: ClusterStateDoc,
  options?: { ifMatch?: string | null },
): Promise<void> {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: stateFileKey(clusterId),
    Body: JSON.stringify(doc),
    ContentType: "application/json",
    CacheControl: "no-store",
    ...(options?.ifMatch ? { IfMatch: options.ifMatch } : {}),
  });
  await s3.send(cmd);
}

/** Delete state.json. Used by clean-env paths that wipe a cluster's
 *  store/ subfolder; ignored if absent. */
export async function deleteState(
  bucket: string,
  clusterId: string,
): Promise<void> {
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: stateFileKey(clusterId) }));
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NoSuchKey") return;
    throw e;
  }
}

export interface ClusterConfig {
  concurrency: number;
  neighbourRadius: number;
  instanceType: string;
  loopIntervalSeconds: number;
  model: string | null;
  /** Coordination algorithm. "amorphous" = ring neighbours at radius R.
   *  "mesh" = every other agent. "swarm" = K most recently active agents. */
  algorithm: "amorphous" | "mesh" | "swarm";
  /** Only used when algorithm === "swarm". Must be 1..concurrency-1. */
  swarmK: number;
  /** When true, agents get a fetch MCP tool for web research. Read-only
   *  HTTP GET, returns pages as markdown. Default false. */
  internetAccess: boolean;
  /** When true (default), the cluster pauses itself after every agent
   *  has reported `action: "idle"` for three consecutive iterations.
   *  Off means a forgotten cluster will keep iterating and billing. */
  autopause: boolean;
}

export interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

export interface AgentLogs {
  agentId: string;
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
}

async function getObject(bucket: string, key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return (await res.Body?.transformToString()) ?? null;
  } catch (e: unknown) {
    if (e instanceof Error && e.name === "NoSuchKey") return null;
    throw e;
  }
}

export async function readConfig(
  bucket: string,
  clusterId: string = DEFAULT_CLUSTER_ID,
): Promise<ClusterConfig> {
  const key = `${clusterPrefix(clusterId)}config.json`;
  const body = await getObject(bucket, key);
  if (!body) throw new Error(`${key} not found in bucket`);
  return JSON.parse(body) as ClusterConfig;
}

export async function writeConfig(
  bucket: string,
  cfg: ClusterConfig,
  clusterId: string = DEFAULT_CLUSTER_ID,
): Promise<void> {
  const key = `${clusterPrefix(clusterId)}config.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key,
    Body: JSON.stringify(cfg), ContentType: "application/json",
  }));
}

export async function readAgentLogs(bucket: string, concurrency: number): Promise<AgentLogs[]> {
  const results = await Promise.all(
    Array.from({ length: concurrency }, (_, i) => {
      const agentId = `agent-${i}`;
      const key = `store/${agentId}.ndjson`;
      return getObject(bucket, key).then((body): AgentLogs => {
        if (!body) return { agentId, lastEntry: null, prevEntry: null, lastUpdatedTs: null };
        const lines = body.split("\n").filter(l => l.trim());
        const entries = lines.map(l => JSON.parse(l) as AgentLogEntry);
        const last = entries.length > 0 ? entries[entries.length - 1] : null;
        const prev = entries.length > 1 ? entries[entries.length - 2] : null;
        return { agentId, lastEntry: last, prevEntry: prev, lastUpdatedTs: last?.ts ?? null };
      });
    })
  );
  return results;
}
export interface ClusterEntry {
  id: string;           // e.g. "cluster_0"
  name: string;         // Display name
  algorithm: "amorphous" | "mesh" | "swarm";
  createdAt: string;    // ISO timestamp
}

export interface ClusterRegistry {
  clusters: ClusterEntry[];
}

export async function readRegistry(bucket: string): Promise<ClusterRegistry> {
  const body = await getObject(bucket, "clusters.json");
  const parsed = body ? (JSON.parse(body) as ClusterRegistry) : { clusters: [] };
  // The registry always shows at least cluster_0 so the single-cluster path
  // is visible in WeltenBuilder even if SeedRegistry didn't run (for example
  // a deployment that predates WeltenBuilder). We synthesise the entry in
  // memory only; writeRegistry is never called on the read path, so a real
  // create still owns the first on-disk write.
  if (parsed.clusters.length === 0) {
    parsed.clusters.push({
      id: DEFAULT_CLUSTER_ID,
      name: DEFAULT_CLUSTER_ID,
      algorithm: "amorphous",
      createdAt: "1970-01-01T00:00:00.000Z",
    });
  }
  return parsed;
}

export async function writeRegistry(bucket: string, registry: ClusterRegistry): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: "clusters.json",
    Body: JSON.stringify(registry), ContentType: "application/json",
  }));
}
