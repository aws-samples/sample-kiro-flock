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
 *  shared environment/ root. When the cluster belongs to an Everforge group,
 *  the prefix nests under that group.
 *  Example: envPrefix("cluster_0")              → "environment/cluster_0/"
 *  Example: envPrefix("dev-fe", "my-project")   → "environment/my-project/dev-fe/" */
export function envPrefix(clusterId: string = DEFAULT_CLUSTER_ID, everforgeGroup?: string | null): string {
  if (everforgeGroup) {
    return `environment/${everforgeGroup}/${clusterId}/`;
  }
  return `environment/${clusterId}/`;
}

/** Returns the S3 key prefix for the deployed/ folder. For Everforge groups
 *  it lives at `environment/<group>/deployed/`. For ungrouped clusters it
 *  lives at `environment/deployed/`.
 *  Example: deployedPrefix()              → "environment/deployed/"
 *  Example: deployedPrefix("my-project")  → "environment/my-project/deployed/" */
export function deployedPrefix(everforgeGroup?: string | null): string {
  if (everforgeGroup) {
    return `environment/${everforgeGroup}/deployed/`;
  }
  return `environment/deployed/`;
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
   *  "resume-all", "first-iteration", "reconcile", "launch-failed" — informational, not
   *  consumed by code (except "launch-failed" which pairs with lastError). */
  reason?: string;
  /** Populated when a cluster start failed to launch instances (e.g.
   *  InsufficientInstanceCapacity or any non-throttle RunInstances error).
   *  Written alongside state "stopped" + reason "launch-failed" so the
   *  failure is visible in the dashboard and MCP instead of leaving the
   *  cluster wedged in "starting". Cleared on the next start attempt
   *  because setOperatorState writes a fresh doc without this field. */
  lastError?: { code: string; message: string; at: string } | null;
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

/** One line of `{clusterId}/store/transitions.ndjson` — the append-only
 *  lifecycle transitions log consumed by the dashboard's timeline band.
 *  Mirrors the fields of ClusterStateDoc that describe a transition. */
export interface TransitionEntry {
  ts: string;
  state: ClusterStateValue;
  /** "operator" for Lambda routes; "agent-N" for agent-side writers. */
  by: string;
  reason: string;
}

export function transitionsKey(clusterId: string = DEFAULT_CLUSTER_ID): string {
  return `${clusterPrefix(clusterId)}store/transitions.ndjson`;
}

/** Append one line to the transitions log (read-modify-write; S3 has no
 *  append — fine at this write rate). Best-effort by design: the log is
 *  observability data, so a failure here is logged and swallowed, never
 *  propagated. State.json remains the single source of truth and its
 *  ETag If-Match semantics are untouched by this call. */
export async function appendTransition(
  bucket: string,
  clusterId: string,
  entry: TransitionEntry,
): Promise<void> {
  const key = transitionsKey(clusterId);
  try {
    let existing = "";
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      existing = (await res.Body?.transformToString()) ?? "";
    } catch (e: unknown) {
      if (!(e instanceof Error && e.name === "NoSuchKey")) throw e;
    }
    const line = JSON.stringify(entry);
    const body = existing.length > 0 && !existing.endsWith("\n")
      ? `${existing}\n${line}\n`
      : `${existing}${line}\n`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/x-ndjson",
      CacheControl: "no-store",
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`appendTransition[${clusterId}] failed (best-effort, transition not logged): ${message}`);
  }
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
  /** Agent compute backend. "ecs" (default, faster startup) runs one
   *  Fargate ARM64 task per agent; "ec2" launches one EC2 instance per
   *  agent. Restart-required — changing it only affects the next start.
   *  Optional for backwards compatibility: configs that predate the field
   *  default to "ecs". */
  computeType?: "ec2" | "ecs";
  /** EC2 instance type. Only consulted when computeType is "ec2". */
  instanceType: string;
  /** Fargate task size. Only consulted when computeType is "ecs" — the
   *  ECS mirror of instanceType. Applied as task-level cpu/memory
   *  overrides at RunTask time (one task definition serves all sizes).
   *  small = 2 vCPU/4 GiB, medium = 4/8 (default, ≈ c8g.xlarge),
   *  large = 8/16, xlarge = 16/32. Restart-required. Optional for
   *  backwards compatibility: absent means "medium". */
  taskSize?: "small" | "medium" | "large" | "xlarge";
  loopIntervalSeconds: number;
  /** Model the agents run under, validated against the deployment catalog
   *  at `config/models.json`. `null` means "omit `--model` and use
   *  kiro-cli's own default". Not restart-required: each agent iteration
   *  spawns a fresh kiro-cli, so the agent loop re-reads this between
   *  iterations.
   *
   *  This is the cluster-wide baseline. Individual agents can override it
   *  via `models` below. */
  model: string | null;
  /** Per-agent model overrides, keyed by agent index as a string ("0", "3").
   *  Sparse: an agent with no key falls back to the cluster-wide `model`.
   *  An explicit `null` pins that agent to kiro-cli's own default, which is
   *  a different thing from "no override" — hence an object rather than an
   *  array, since an array has no way to express the absent case once
   *  `null` is taken.
   *
   *  Resolution is `models[String(agentIndex)] ?? model`, applied both at
   *  launch (ec2Manager / ecsManager, so iteration 1 is already correct)
   *  and on every dynamic reload in the agent loop.
   *
   *  Keys beyond `concurrency - 1` are tolerated and round-trip unused, the
   *  same way `swarmK` and `neighbourRadius` do when the active algorithm
   *  ignores them — so overrides can be set before scaling up. Optional for
   *  backwards compatibility: absent means "no agent overrides". */
  models?: Record<string, string | null>;
  /** Coordination algorithm. "amorphous" = ring neighbours at radius R.
   *  "mesh" = every other agent. "swarm" = K most recently active agents.
   *  "single" = every agent works the direction alone, no peers; N agents
   *  are N independent runs. */
  algorithm: "amorphous" | "mesh" | "swarm" | "single";
  /** Only used when algorithm === "swarm". Must be 1..concurrency-1. */
  swarmK: number;
  /** When true (default), the cluster pauses itself after every agent
   *  has reported `action: "idle"` for three consecutive iterations.
   *  Off means a forgotten cluster will keep iterating and billing. */
  autopause: boolean;
  /** When true, after each iteration the agent appends a self-reflection
   *  block to its own per-agent directive file. Cluster direction is
   *  untouched. Default false. */
  selfOptimizing: boolean;
  /** When true, agents get a Puppeteer MCP server for headless browser
   *  automation (screenshots, page interaction, testing). Default false. */
  browserAutomation: boolean;
  /** When true, all agents in the cluster are pre-trusted to deploy on
   *  start. A trusted approval file is written for every agent index at
   *  launch time so no per-request approval prompt is shown. Default false. */
  trustDeploy?: boolean;
  /** Optional Everforge group name. When set, the cluster's environment
   *  prefix becomes `environment/<everforgeGroup>/<clusterId>/` instead of
   *  `environment/<clusterId>/`. The deployed/ folder lives at
   *  `environment/<everforgeGroup>/deployed/` (shared by all clusters in
   *  the group). Omit or null for standard WeltenBuilder behaviour. */
  everforgeGroup?: string | null;
}

/**
 * Resolve the model one agent should run under: its entry in the per-agent
 * `models` override map when present, otherwise the cluster-wide `model`.
 *
 * The presence of the key is what matters, not its value — a key set to
 * `null` is a real override meaning "pin this agent to kiro-cli's own
 * default", which is distinct from having no key at all ("follow the cluster
 * model"). That is why `??` alone is not enough and `hasOwnProperty` is used.
 *
 * Used by the launch paths (ec2Manager, ecsManager) so an agent's very first
 * iteration already runs the right model, before the agent loop's own
 * dynamic reload kicks in. The agent loop applies the same rule independently
 * against the live config each iteration.
 */
export function resolveAgentModel(config: ClusterConfig, agentIndex: number): string | null {
  const overrides = config.models;
  if (overrides && typeof overrides === "object" && !Array.isArray(overrides)) {
    const key = String(agentIndex);
    if (Object.prototype.hasOwnProperty.call(overrides, key)) {
      const value = overrides[key];
      if (value === null || typeof value === "string") return value;
    }
  }
  return config.model;
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
  algorithm: "amorphous" | "mesh" | "swarm" | "single";
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
