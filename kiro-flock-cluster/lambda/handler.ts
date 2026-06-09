/**
 * Lambda handler for the cluster API. Sits behind API Gateway (REST v1)
 * with Cognito auth on /cluster/* routes. Routes are dispatched via
 * parseRoute(), which extracts the action and optional cluster_id suffix
 * from suffix-style paths: /cluster/{action}/{cluster_id}
 *
 * When {cluster_id} is omitted, the handler defaults to "cluster_0" so
 * existing single-cluster clients continue to work unchanged.
 *
 * Existing routes (all accept optional /{cluster_id} suffix):
 *   POST /cluster/start/{cluster_id}          - validate config, archive this cluster's run, launch EC2 agents
 *   POST /cluster/stop/{cluster_id}           - terminate agent instances
 *   POST /cluster/pause/{cluster_id}          - flip state.json to "paused" so agents halt between iterations
 *   POST /cluster/resume/{cluster_id}         - flip state.json back to "running" so agents resume their loop
 *   GET  /cluster/status/{cluster_id}         - read pre-computed snapshot from S3; trigger async rebuild if stale
 *   GET  /cluster/analysis/{cluster_id}       - presigned URL for post-run NDJSON.gz artifact; triggers build if missing
 *   GET  /cluster/config/{cluster_id}         - read cluster config from S3
 *   PUT  /cluster/config/{cluster_id}         - merge partial update into config
 *   GET  /cluster/habitat/{cluster_id}        - list files this cluster's agents wrote to environment/{cluster_id}/
 *   GET  /cluster/habitat/file/{cluster_id}   - read a single environment file by key (cross-cluster reads allowed)
 *   GET  /cluster/direction/{cluster_id}      - read the operator's goal document
 *   PUT  /cluster/direction/{cluster_id}      - update the goal document
 *
 * Global routes (no cluster_id):
 *   GET  /cluster/knowledge-base              - list shared knowledge-base files
 *   GET  /cluster/knowledge-base/file         - read a single knowledge-base file
 *   GET  /cluster/instance-types              - available Graviton types + account vCPU quota
 *
 * Multi-cluster routes (WeltenBuilder):
 *   GET    /cluster/list                       - list registered clusters with live state
 *   DELETE /cluster/delete/{cluster_id}        - unregister a stopped cluster (preserves S3 data)
 *   POST   /cluster/stop-all                   - terminate every non-stopped cluster
 *   POST   /cluster/pause-all                  - pause every running cluster
 *   POST   /cluster/clean-env/{cluster_id}     - wipe environment/{cluster_id}/ (requires stopped)
 *   POST   /cluster/clean-env-all              - wipe environment/ entirely (requires all stopped)
 */
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  CopyObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  EC2Client,
  DescribeInstancesCommand,
  DescribeInstanceTypesCommand,
} from "@aws-sdk/client-ec2";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  ServiceQuotasClient,
  GetServiceQuotaCommand,
} from "@aws-sdk/client-service-quotas";
import {
  ClusterConfig,
  DEFAULT_CLUSTER_ID,
  clusterPrefix,
  envPrefix,
  readConfig as readClusterConfig,
  writeConfig as writeClusterConfig,
  readRegistry,
  writeRegistry,
  readState,
  writeState,
  type ClusterEntry,
  type ClusterRegistry,
  type ClusterStateValue,
  type ClusterStateDoc,
} from "./s3Store";
import { startCluster, stopCluster } from "./ec2Manager";

// Module-scoped AWS SDK clients. The Node SDK reuses underlying TCP
// sockets across calls on a single client instance, so hoisting these
// out of every handler branch (rather than `new S3Client({})` each
// invocation) is a meaningful perf win on /cluster/list which fans out
// to S3 in parallel for every cluster. Pair this with
// AWS_NODEJS_CONNECTION_REUSE_ENABLED=1 set on the function.
const s3 = new S3Client({});
const ec2 = new EC2Client({});
const lambdaClient = new LambdaClient({});
const serviceQuotas = new ServiceQuotasClient({});

// Environment variables set by the CDK stack. Captured at module load.
const BUCKET = process.env.BUCKET_NAME!;
const AMI_ID = process.env.AMI_ID!;
const SG_ID = process.env.SECURITY_GROUP_ID!;
const INSTANCE_PROFILE = process.env.INSTANCE_PROFILE_ARN!;
const SUBNET_ID = process.env.SUBNET_ID!;
const CONCURRENCY_CAP = parseInt(process.env.CONCURRENCY_CAP ?? "64", 10);
const SNAPSHOT_BUILDER_FN = process.env.SNAPSHOT_BUILDER_FN ?? "";
const ANALYSIS_BUILDER_FN = process.env.ANALYSIS_BUILDER_FN ?? "";

// Snapshot is considered fresh for this many milliseconds. Beyond this
// the handler returns the stale snapshot and fires a rebuild so the next
// poll picks up the updated data.
const SNAPSHOT_STALE_MS = 4000;

// Analysis freshness window for a running cluster. Stopped clusters
// accept any age (no further writes are happening).
const ANALYSIS_STALE_MS_RUNNING = 60_000;
const ANALYSIS_PRESIGN_EXPIRY_S = 900;
// Bounded poll after firing a fresh build. Cap at 20 s; one read per second.
// The poll replaces a client-side retry loop for the first-ever analysis
// request. See the analysis handler for the full rationale.
const ANALYSIS_POLL_MS = 20_000;
const ANALYSIS_POLL_STEP_MS = 1000;
const ANALYSIS_RETRY_AFTER_S = 15;

// ---- Cluster key prefix helpers ---------------------------------------------
// `clusterPrefix`, `envPrefix`, `DEFAULT_CLUSTER_ID`, `readClusterConfig`,
// and `writeClusterConfig` are imported from "./s3Store" above. The local
// copies that used to live here are gone — s3Store is now the single
// source of truth for all multi-cluster S3 key composition.

// Per-cluster S3 key suffixes (appended under `{clusterId}/`).
const CONFIG_KEY_SUFFIX = "config.json";
const DIRECTION_KEY_SUFFIX = "direction.md";
const SNAPSHOT_KEY_SUFFIX = "store/cluster-snapshot.json";
const ANALYSIS_POINTER_SUFFIX = "store/cluster-analysis-latest.json";

const configKey = (clusterId: string) => `${clusterPrefix(clusterId)}${CONFIG_KEY_SUFFIX}`;
const directionKey = (clusterId: string) => `${clusterPrefix(clusterId)}${DIRECTION_KEY_SUFFIX}`;
const snapshotKey = (clusterId: string) => `${clusterPrefix(clusterId)}${SNAPSHOT_KEY_SUFFIX}`;
const analysisPointerKey = (clusterId: string) => `${clusterPrefix(clusterId)}${ANALYSIS_POINTER_SUFFIX}`;

/** Write a fresh state.json, unconditionally. Used by every operator-
 *  initiated route (start, stop, pause, resume, stop-all, pause-all).
 *  Operator intent always wins, so no If-Match precondition. */
async function setOperatorState(
  clusterId: string,
  state: ClusterStateValue,
  reason: string,
): Promise<void> {
  const doc: ClusterStateDoc = {
    state,
    transitionedAt: new Date().toISOString(),
    transitionedBy: "operator",
    reason,
  };
  await writeState(BUCKET, clusterId, doc);
}

// ---- Route parsing -----------------------------------------------------------
/**
 * Parse an API path into an action and clusterId. The project uses
 * suffix-style routing: /cluster/{action}/{cluster_id}. When the suffix
 * is omitted, clusterId defaults to "cluster_0" for backwards compatibility
 * with single-cluster clients.
 *
 * Examples:
 *   /cluster/start/my-cluster            → { action: "start",               clusterId: "my-cluster" }
 *   /cluster/start                       → { action: "start",               clusterId: "cluster_0" }
 *   /cluster/habitat/file/ci             → { action: "habitat/file",        clusterId: "ci" }
 *   /cluster/habitat/file                → { action: "habitat/file",        clusterId: "cluster_0" }
 *   /cluster/knowledge-base/file         → { action: "knowledge-base/file", clusterId: "cluster_0" }
 *   /cluster/knowledge-base              → { action: "knowledge-base",      clusterId: "cluster_0" }
 *
 * Multi-segment actions ("habitat/file", "knowledge-base/file") are
 * handled explicitly so segments[1] isn't mistaken for a cluster_id.
 */
export function parseRoute(path: string): { action: string; clusterId: string } {
  const stripped = path.replace(/^\/cluster\/?/, "");
  const segments = stripped.split("/").filter(s => s.length > 0);
  if (segments.length === 0) return { action: "", clusterId: DEFAULT_CLUSTER_ID };

  if (segments[0] === "habitat" && segments[1] === "file") {
    return { action: "habitat/file", clusterId: segments[2] || DEFAULT_CLUSTER_ID };
  }
  if (segments[0] === "knowledge-base" && segments[1] === "file") {
    // knowledge-base is a shared global resource; cluster_id is accepted
    // for URL shape consistency but ignored by the handler.
    return { action: "knowledge-base/file", clusterId: segments[2] || DEFAULT_CLUSTER_ID };
  }
  // analyzer-tab/{tabId} — the tabId goes into the clusterId slot for
  // consistency with the suffix-style routing pattern.
  if (segments[0] === "analyzer-tab") {
    return { action: "analyzer-tab", clusterId: segments[1] || DEFAULT_CLUSTER_ID };
  }

  return { action: segments[0], clusterId: segments[1] || DEFAULT_CLUSTER_ID };
}

// ---- Per-cluster config read/write ------------------------------------------
// Config read/write are imported directly from s3Store (aliased as
// readClusterConfig / writeClusterConfig above). The local wrappers that
// used to live here are gone — s3Store is the single source of truth.

/** Fire-and-forget async invoke of the snapshot builder for one cluster. */
async function triggerSnapshotBuild(clusterId: string): Promise<void> {
  if (!SNAPSHOT_BUILDER_FN) {
    console.warn("SNAPSHOT_BUILDER_FN not set; skipping builder invoke");
    return;
  }
  try {
    // snapshotBuilder.ts reads `clusterId` from this payload and scopes
    // its S3 reads/writes to `{clusterId}/store/`.
    await lambdaClient.send(new InvokeCommand({
      FunctionName: SNAPSHOT_BUILDER_FN,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ clusterId })),
    }));
  } catch (err: unknown) {
    console.error("snapshot builder invoke failed:", err instanceof Error ? err.message : err);
  }
}

/** Fire-and-forget async invoke of the analysis builder for one cluster. */
async function triggerAnalysisBuild(clusterId: string): Promise<void> {
  if (!ANALYSIS_BUILDER_FN) {
    console.warn("ANALYSIS_BUILDER_FN not set; skipping builder invoke");
    return;
  }
  try {
    // analysisBuilder.ts reads `clusterId` from this payload and scopes
    // its S3 reads/writes to `{clusterId}/store/`.
    await lambdaClient.send(new InvokeCommand({
      FunctionName: ANALYSIS_BUILDER_FN,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify({ clusterId })),
    }));
  } catch (err: unknown) {
    console.error("analysis builder invoke failed:", err instanceof Error ? err.message : err);
  }
}

/** Read the analysis pointer for a given cluster. Returns null if absent. */
async function readAnalysisPointer(
  clusterId: string,
): Promise<{ key: string; builtAt: string; agents: number; totalBytes: number } | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: analysisPointerKey(clusterId) }));
    const text = (await resp.Body?.transformToString()) ?? "";
    if (!text) return null;
    return JSON.parse(text);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/** Generate a presigned GET URL for an arbitrary S3 key in the cluster bucket. */
async function presignAnalysisUrl(key: string): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, cmd, { expiresIn: ANALYSIS_PRESIGN_EXPIRY_S });
}

/** Read current cluster state from `{clusterId}/store/state.json`. Returns
 *  "stopped" if the file is absent or unreadable — both mean "no live
 *  cluster" for the purposes of guard checks (stop-before-delete,
 *  stopped-before-pause, etc.). The file is written by every operator
 *  route (start/stop/pause/resume/stop-all/pause-all) and by agents on
 *  the Starting → Running and Running → Paused (autopause) transitions. */
async function readClusterState(clusterId: string): Promise<ClusterStateValue> {
  const { doc } = await readState(BUCKET, clusterId);
  return doc.state;
}

/**
 * Read `{clusterId}/store/cluster-snapshot.json` and pick the
 * most-recent agent log entry from it for the WeltenBuilder card. The
 * snapshot is built by the snapshot Lambda on every status poll, so it
 * already contains every agent's tail entry. Reading it gives us the
 * last-update info in one S3 GET instead of a ListObjectsV2 + ranged
 * GetObject pair.
 *
 * Returns `lastUpdate` (newest entry across agents) or null if the
 * snapshot is missing or has no agents with log entries.
 */
async function readSnapshotForList(clusterId: string): Promise<{
  lastUpdate: { agentId: string; ts: string; action: string; iteration: number } | null;
  lastBuiltMs: number | null;
}> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: snapshotKey(clusterId) }));
    const text = (await resp.Body?.transformToString()) ?? "";
    if (!text) return { lastUpdate: null, lastBuiltMs: null };
    const snap = JSON.parse(text) as {
      lastBuilt?: unknown;
      agents?: Array<{
        agentId?: unknown;
        lastEntry?: { action?: unknown; iteration?: unknown } | null;
        lastUpdatedTs?: unknown;
      }>;
    };
    let bestTs = 0;
    let best: { agentId: string; ts: string; action: string; iteration: number } | null = null;
    for (const a of snap.agents ?? []) {
      if (!a.lastEntry || typeof a.lastUpdatedTs !== "string" || typeof a.agentId !== "string") continue;
      const t = new Date(a.lastUpdatedTs).getTime();
      if (!Number.isFinite(t) || t <= bestTs) continue;
      const action = typeof a.lastEntry.action === "string" ? a.lastEntry.action : "";
      const iter = typeof a.lastEntry.iteration === "number" ? a.lastEntry.iteration : 0;
      bestTs = t;
      best = { agentId: a.agentId, ts: a.lastUpdatedTs, action, iteration: iter };
    }
    const lastBuiltMs = typeof snap.lastBuilt === "string"
      ? (Number.isFinite(new Date(snap.lastBuilt).getTime()) ? new Date(snap.lastBuilt).getTime() : null)
      : null;
    return { lastUpdate: best, lastBuiltMs };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return { lastUpdate: null, lastBuiltMs: null };
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`readSnapshotForList[${clusterId}] failed: ${message}`);
    return { lastUpdate: null, lastBuiltMs: null };
  }
}

/**
 * Archive a cluster's env subfolder and per-cluster store/ to history/<ts>/
 * and then delete them from their source locations. The shared
 * `environment/` folder stays intact; only `environment/{clusterId}/`
 * and `{clusterId}/store/` are touched, so other clusters are not
 * disturbed. History is a global bucket-level archive keyed by timestamp
 * per design 3.3.
 *
 * Used by POST /cluster/clean-env (archive on explicit clean). Returns the
 * number of files archived.
 */
async function archiveClusterToHistory(clusterId: string, logTag: string): Promise<number> {
  const envSubfolder = envPrefix(clusterId);
  const storeSubfolder = `${clusterPrefix(clusterId)}store/`;
  const stateKey = stateFileKeyFor(clusterId);
  const envSnapshotKey = `${storeSubfolder}cluster-snapshot.json`;
  const [envObjs, storeObjs] = await Promise.all([
    s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: envSubfolder })),
    s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: storeSubfolder })),
  ]);
  const toArchive = [
    ...(envObjs.Contents ?? []).filter(o => o.Key && o.Key !== envSubfolder),
    ...(storeObjs.Contents ?? []).filter(o => o.Key
      && o.Key !== storeSubfolder
      && o.Key !== stateKey
      && o.Key !== envSnapshotKey),
  ];
  if (toArchive.length === 0) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePrefix = `history/${ts}/`;
  console.log(`${logTag}: archiving ${toArchive.length} files to ${archivePrefix}`);
  await Promise.all(toArchive.map(async obj => {
    const destKey = archivePrefix + obj.Key!;
    await s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${obj.Key}`, Key: destKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }));
  }));
  return toArchive.length;
}

/**
 * Archive only the per-cluster store/ to history/<ts>/, leaving the
 * environment untouched. Used by stop, stop-all, and start to clear
 * agent logs between runs without disturbing uploaded context files.
 */
async function archiveStoreToHistory(clusterId: string, logTag: string): Promise<number> {
  const storeSubfolder = `${clusterPrefix(clusterId)}store/`;
  const stateKey = stateFileKeyFor(clusterId);
  const envSnapshotKey = `${storeSubfolder}cluster-snapshot.json`;
  const storeObjs = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: storeSubfolder }));
  const toArchive = (storeObjs.Contents ?? []).filter(o => o.Key
    && o.Key !== storeSubfolder
    && o.Key !== stateKey
    && o.Key !== envSnapshotKey);
  if (toArchive.length === 0) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePrefix = `history/${ts}/`;
  console.log(`${logTag}: archiving ${toArchive.length} store files to ${archivePrefix}`);
  await Promise.all(toArchive.map(async obj => {
    const destKey = archivePrefix + obj.Key!;
    await s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${obj.Key}`, Key: destKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }));
  }));
  return toArchive.length;
}

/** Local mirror of `stateFileKey` from s3Store.ts so archiveClusterToHistory
 *  doesn't need an extra import roundtrip. Both forms produce the same key. */
function stateFileKeyFor(clusterId: string): string {
  return `${clusterPrefix(clusterId)}store/state.json`;
}

/**
 * Archive legacy agent logs from the bare `store/` prefix to history/<ts>/.
 * Before per-cluster store layout, cluster_0 wrote logs directly to
 * `store/agent-N.ndjson`. These are never touched by archiveClusterToHistory
 * (which targets `{clusterId}/store/`). This function sweeps them while
 * preserving `store/analyzer/` which is actively used by the analyzer feature.
 */
async function archiveLegacyStore(logTag: string): Promise<number> {
  const storeObjs = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "store/" }));
  const toArchive = (storeObjs.Contents ?? []).filter(o =>
    o.Key
    && !o.Key.startsWith("store/analyzer/")
    && o.Key !== "store/"
  );
  if (toArchive.length === 0) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePrefix = `history/${ts}/legacy-store/`;
  console.log(`${logTag}: archiving ${toArchive.length} legacy store/ files to ${archivePrefix}`);
  await Promise.all(toArchive.map(async obj => {
    const destKey = archivePrefix + obj.Key!;
    await s3.send(new CopyObjectCommand({ Bucket: BUCKET, CopySource: `${BUCKET}/${obj.Key}`, Key: destKey }));
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }));
  }));
  return toArchive.length;
}

/**
 * Delete every object under an S3 prefix. Returns the number of objects
 * deleted. Uses ListObjectsV2 + DeleteObjects in batches of 1000 (the
 * DeleteObjects limit), iterating pages for large prefixes. Empty prefixes
 * return 0 without erroring.
 */
async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => !!k);
    // Batch the DeleteObjects call in chunks of 1000 (the API ceiling) in
    // case a single ListObjectsV2 page ever grows past it.
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: chunk.map((k) => ({ Key: k })), Quiet: true },
      }));
      deleted += chunk.length;
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

/** Wrap a value in an API Gateway JSON response. */
function json(statusCode: number, body: unknown): APIGatewayProxyResult {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** API Gateway base64-encodes the body when binaryMediaTypes includes *\/*. */
function getBody(event: APIGatewayProxyEvent): string | null {
  if (!event.body) return null;
  if (event.isBase64Encoded) return Buffer.from(event.body, "base64").toString("utf-8");
  return event.body;
}

/**
 * Validate cluster config fields. Returns an error string or null if valid.
 * Used by both POST /cluster/start and PUT /cluster/config.
 */
function validateConfig(config: ClusterConfig): string | null {
  if (config.concurrency > CONCURRENCY_CAP) {
    return `concurrency ${config.concurrency} exceeds the configured cap of ${CONCURRENCY_CAP}`;
  }
  if (!/^(t|c|m|r)\d+g\.(small|medium|large|xlarge)$/.test(config.instanceType)) {
    return `instanceType "${config.instanceType}" is not in the allowed set (Graviton t/c/m/r families, small through xlarge)`;
  }
  // Algorithm validation runs early so downstream field checks can branch
  // on the active algorithm (neighbourRadius is only used by amorphous;
  // swarmK only by swarm).
  if (config.algorithm !== "amorphous" && config.algorithm !== "mesh" && config.algorithm !== "swarm") {
    return `algorithm must be one of "amorphous", "mesh", "swarm"`;
  }
  // neighbourRadius is only used by the amorphous algorithm. mesh and
  // swarm ignore it at runtime, so don't reject a stale value when the
  // active algorithm doesn't care. The field round-trips either way so
  // the UI can retain the user's pick across a mode switch back.
  if (config.algorithm === "amorphous") {
    const maxRadius = Math.floor(config.concurrency / 2);
    if (!Number.isInteger(config.neighbourRadius) || config.neighbourRadius < 0 || config.neighbourRadius > maxRadius) {
      return `neighbourRadius must be an integer between 0 and ${maxRadius} (concurrency / 2)`;
    }
  } else {
    // Still require an integer shape so a garbled config.json is caught,
    // even though the value won't be used.
    if (!Number.isInteger(config.neighbourRadius) || config.neighbourRadius < 0) {
      return "neighbourRadius must be a non-negative integer";
    }
  }
  if (!Number.isInteger(config.loopIntervalSeconds) || config.loopIntervalSeconds < 0 || config.loopIntervalSeconds > 3600) {
    return "loopIntervalSeconds must be an integer between 0 and 3600";
  }
  if (config.model !== null) {
    return "model must be null (auto); custom model selection is not yet supported";
  }
  // swarmK range is only enforced when algorithm === "swarm" (the field is
  // accepted either way so the UI can populate it ahead of a mode switch).
  if (config.algorithm === "swarm") {
    if (!Number.isInteger(config.swarmK) || config.swarmK < 1 || config.swarmK > config.concurrency - 1) {
      return `swarmK must be an integer between 1 and ${config.concurrency - 1} (concurrency - 1)`;
    }
  }
  if (typeof config.autopause !== "boolean") {
    return "autopause must be a boolean";
  }
  return null;
}

/**
 * Cluster ID regex per design.md error handling. Must start and end with
 * an alphanumeric, may contain hyphens and underscores, max 32 chars
 * total. Underscore is permitted so the default cluster_N naming works
 * (cluster_0, cluster_1234). Matches the shape used by S3 prefixes and
 * EC2 tag values.
 */
const CLUSTER_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

function validateClusterId(id: unknown): string | null {
  if (typeof id !== "string") return "cluster id must be a string";
  if (!CLUSTER_ID_REGEX.test(id)) {
    return `cluster id "${id}" must match ${CLUSTER_ID_REGEX} (lowercase alphanumerics and hyphens, 2-32 chars, start/end alphanumeric)`;
  }
  return null;
}

/**
 * Default cluster config used when POST /cluster/create is called without
 * overrides. Mirrors the CDK `SeedConfig` defaults so a newly-created
 * cluster and a freshly-deployed stack look identical to clients. Any
 * change here must also land in cdk/lib/aga-stack.ts.
 */
const DEFAULT_CLUSTER_CONFIG: ClusterConfig = {
  concurrency: 3,
  neighbourRadius: 1,
  instanceType: "t4g.medium",
  loopIntervalSeconds: 30,
  model: null,
  algorithm: "amorphous",
  swarmK: 4,
  internetAccess: false,
  autopause: true,
};

/**
 * Idempotently append a cluster entry to clusters.json if it isn't
 * already present. Called from write paths (PUT config, PUT direction,
 * POST start) so a cluster the operator lands on from the WeltenBuilder
 * "+" card gets registered the moment they interact with it, without
 * requiring them to call POST /cluster/create explicitly.
 *
 * `algorithm` is sourced from the caller's config (falling back to the
 * default) so the registry entry reflects what the cluster will actually
 * run. Failure to validate the id is treated as a no-op rather than an
 * error — the write path has its own validation and this helper is a
 * best-effort convenience.
 *
 * The default cluster_0 sentinel synthesised by readRegistry is not
 * persisted here; we only write when a real registry change is needed.
 */
async function ensureRegistered(
  clusterId: string,
  algorithm: "amorphous" | "mesh" | "swarm" = "amorphous",
): Promise<void> {
  if (validateClusterId(clusterId) !== null) return;
  let onDisk: ClusterRegistry = { clusters: [] };
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "clusters.json" }));
    const text = (await resp.Body?.transformToString()) ?? "";
    if (text) onDisk = JSON.parse(text) as ClusterRegistry;
  } catch (err: unknown) {
    if ((err as { name?: string }).name !== "NoSuchKey") throw err;
  }
  if (onDisk.clusters.some(c => c.id === clusterId)) return;
  const entry: ClusterEntry = {
    id: clusterId,
    name: clusterId,
    algorithm,
    createdAt: new Date().toISOString(),
  };
  const updated: ClusterRegistry = { clusters: [...onDisk.clusters, entry] };
  await writeRegistry(BUCKET, updated);
  console.log(`ensureRegistered[${clusterId}]: added to registry`);
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const method = event.httpMethod;
  const path = event.path;
  const body = getBody(event);
  const { action, clusterId } = parseRoute(path);

  try {

    // ---- Start the cluster --------------------------------------------------
    // The actual launch can take minutes for large clusters (sequential
    // RunInstances calls). To avoid the API Gateway 29s timeout, the handler
    // invokes itself asynchronously and returns immediately.
    if (method === "POST" && action === "start") {
      const overrides = body ? JSON.parse(body) : {};

      // Config and direction must exist before start. No defaults.
      // The operator must call config_set and direction_set first.
      let existing: ClusterConfig;
      try {
        existing = await readClusterConfig(BUCKET, clusterId);
      } catch {
        return json(400, { error: `No config found for cluster "${clusterId}". Set config with PUT /cluster/config/${clusterId} before starting.` });
      }

      // Direction must exist and be non-empty.
      try {
        const dirRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: directionKey(clusterId) }));
        const dirBody = await dirRes.Body?.transformToString();
        if (!dirBody || !dirBody.trim()) {
          return json(400, { error: `No direction set for cluster "${clusterId}". Set direction with PUT /cluster/direction/${clusterId} before starting.` });
        }
      } catch {
        return json(400, { error: `No direction set for cluster "${clusterId}". Set direction with PUT /cluster/direction/${clusterId} before starting.` });
      }

      // Backfill optional fields that may be absent in older configs.
      if (existing.algorithm === undefined) existing.algorithm = "amorphous";
      if (existing.swarmK === undefined) existing.swarmK = 4;
      if (typeof existing.autopause !== "boolean") existing.autopause = true;

      const config = { ...existing, ...overrides } as ClusterConfig;

      const err = validateConfig(config);
      if (err) return json(400, { error: err });

      // Register the cluster on first Start so WeltenBuilder's list view
      // picks it up. Safe no-op if it's already registered.
      await ensureRegistered(clusterId, config.algorithm);

      // If this is the async background invocation, do the actual work.
      if (event.headers?.["x-aga-async"] === "true") {
        try {
        // Guard against double-start. Filter by tag:ClusterId so one
        // cluster's start never sees another cluster's instances as
        // "already running". Belt-and-braces with the state.json check
        // the sync path already did; covers the unlikely case where two
        // operators clicked Start simultaneously and both passed the
        // sync-path guard before either reached the async invoke.
        const startFilters: Array<{ Name: string; Values: string[] }> = [
          { Name: "tag:Project", Values: ["kiro-flock"] },
          { Name: "tag:ClusterId", Values: [clusterId] },
          { Name: "instance-state-name", Values: ["pending", "running"] },
        ];
        const existingInstances = await ec2.send(new DescribeInstancesCommand({ Filters: startFilters }));
        const existingCount = (existingInstances.Reservations ?? []).flatMap(r => r.Instances ?? []).length;
        if (existingCount > 0) {
          console.log(`start[${clusterId}]: rejected, ${existingCount} agents already running`);
          // Roll the state back so the operator can retry once the
          // existing cluster has been stopped.
          await setOperatorState(clusterId, "stopped", "double-start-rejected");
          return json(409, { error: `${existingCount} agents already running, stop the cluster first` });
        }

        // Archive this cluster's store/ to history/<ts>/ so the new run
        // starts with clean agent logs. The environment is left intact so
        // operators can reuse uploaded context by reusing the cluster name.
        // state.json and cluster-snapshot.json are excluded from the sweep.
        await archiveStoreToHistory(clusterId, `start[${clusterId}]`);

        console.log(`start[${clusterId}]: launching`, config.concurrency, "instances, type:", config.instanceType);
        await writeClusterConfig(BUCKET, config, clusterId);
        // Thread clusterId through so launched instances get a ClusterId
        // tag and the agent user-data sets AGA_CLUSTER_PREFIX correctly.
        const ids = await startCluster(
          { bucket: BUCKET, amiId: AMI_ID, securityGroupId: SG_ID, instanceProfileArn: INSTANCE_PROFILE, subnetId: SUBNET_ID },
          config,
          clusterId,
        );
        return json(200, { instanceIds: ids });
        } catch (err) {
          // If the async path fails (e.g. RunInstances throws after partial
          // launch), terminate any instances that did start and roll state
          // back to stopped so the operator can retry cleanly.
          console.error(`start[${clusterId}]: async path failed, rolling back`, err);
          try {
            await stopCluster(BUCKET, clusterId);
          } catch (cleanupErr) {
            console.error(`start[${clusterId}]: cleanup termination also failed`, cleanupErr);
          }
          await setOperatorState(clusterId, "stopped", `start-failed: ${err instanceof Error ? err.message : String(err)}`);
          return json(500, { error: `cluster start failed: ${err instanceof Error ? err.message : String(err)}` });
        }
      }

      // Synchronous path: guard, flip state, invoke async, return 202.
      // The state guard refuses the click if the cluster is already
      // mid-life so we don't double-launch via two clicks before EC2
      // catches up. Reading state.json is cheap (single S3 GET).
      const currentState = await readClusterState(clusterId);
      if (currentState !== "stopped") {
        return json(409, { error: `cluster is ${currentState}, stop it before starting again` });
      }

      // Flip state to "starting" right here in the sync path so the
      // dashboard and WeltenBuilder pick it up on the very next poll.
      await setOperatorState(clusterId, "starting", "manual");

      const asyncEvent = {
        ...event,
        headers: { ...event.headers, "x-aga-async": "true" },
      };
      await lambdaClient.send(new InvokeCommand({
        FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME!,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(asyncEvent)),
      }));
      return json(202, { status: "starting" });
    }

    // ---- Stop the cluster ---------------------------------------------------
    // Synchronous path: DescribeInstances + TerminateInstances, both small.
    // Comfortably inside API Gateway's 29 s budget even at high concurrency,
    // so no async split is needed here. We flip state.json to "stopping"
    // before TerminateInstances so the operator's click registers
    // immediately, then `/cluster/list` reconciles it to "stopped" once
    // EC2 reports zero live instances for the cluster (~30 s later).
    // After terminating, fire-and-forget a cluster-analysis build so the
    // first store_read_all after stop is instant.
    if (method === "POST" && action === "stop") {
      console.log(`stop[${clusterId}]: terminating cluster`);
      await setOperatorState(clusterId, "stopping", "manual");
      // Scope termination to this cluster's instances via the ClusterId
      // tag so one cluster's stop doesn't take down another.
      await stopCluster(BUCKET, clusterId);

      // If no instances remain (already terminated or never existed),
      // transition directly to "stopped" so the cluster doesn't get
      // stuck in "stopping" waiting for a reconciliation pass.
      const remaining = await ec2.send(new DescribeInstancesCommand({
        Filters: [
          { Name: "tag:Project", Values: ["kiro-flock"] },
          { Name: "tag:ClusterId", Values: [clusterId] },
          { Name: "instance-state-name", Values: ["pending", "running", "stopping", "shutting-down"] },
        ],
      }));
      const liveCount = (remaining.Reservations ?? []).reduce(
        (n, r) => n + (r.Instances?.length ?? 0), 0);
      if (liveCount === 0) {
        await setOperatorState(clusterId, "stopped", "immediate");
        console.log(`stop[${clusterId}]: no instances remain, state -> stopped`);
      }

      // Archive the store to history/ so the next start gets a clean slate.
      // With named clusters the same store prefix persists across runs,
      // so without this the next run appends to stale logs.
      const archived = await archiveStoreToHistory(clusterId, `stop[${clusterId}]`);
      console.log(`stop[${clusterId}]: archived ${archived} store files to history/`);
      void triggerAnalysisBuild(clusterId);
      return json(200, { ok: true });
    }

    // ---- Pause the cluster --------------------------------------------------
    // Flips state.json to "paused". Agents read state.json between
    // iterations; "paused" puts them in a 10 s slow-poll loop that does
    // no work until state.json transitions back to "running" (operator
    // resume) or "stopping"/"stopped" (operator stop). Only valid when
    // the cluster is running or starting — anything else 409s.
    if (method === "POST" && action === "pause") {
      const state = await readClusterState(clusterId);
      if (state !== "running" && state !== "starting") {
        return json(409, {
          error: `cluster is ${state}, can only pause a running or starting cluster`,
        });
      }
      await setOperatorState(clusterId, "paused", "manual");
      console.log(`pause[${clusterId}]: state -> paused`);
      // Fire a snapshot rebuild so the dashboard reflects paused state quickly.
      void triggerSnapshotBuild(clusterId);
      return json(200, { ok: true });
    }

    // ---- Resume the cluster -------------------------------------------------
    // Flips state.json from "paused" back to "running". Returns 409 if the
    // cluster isn't currently paused — callers should treat "already
    // resumed" as an error to avoid confusing UI feedback.
    if (method === "POST" && action === "resume") {
      const state = await readClusterState(clusterId);
      if (state !== "paused") {
        return json(409, { error: "cluster is not paused" });
      }
      await setOperatorState(clusterId, "running", "manual");
      console.log(`resume[${clusterId}]: state -> running`);
      void triggerSnapshotBuild(clusterId);
      return json(200, { ok: true });
    }

    // ---- Cluster status -----------------------------------------------------
    // O(1) read: the SnapshotBuilderFn Lambda writes a pre-computed
    // snapshot to S3; this handler just fetches and returns it. If the
    // snapshot is missing or older than SNAPSHOT_STALE_MS, an async rebuild
    // is fired and the stale (or stub) data is returned in the meantime.
    // The live cluster state always comes from state.json, not from the
    // snapshot's cached `clusterState` field — state.json is updated
    // synchronously on every operator transition and by agents on
    // Starting → Running, so the dashboard sees the click effect on the
    // very next poll regardless of when the snapshot last rebuilt.
    if (method === "GET" && action === "status") {
      const liveState = await readClusterState(clusterId);
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: snapshotKey(clusterId) }));
        const text = (await resp.Body?.transformToString()) ?? "";
        const snapshot = JSON.parse(text);
        snapshot.clusterState = liveState;
        snapshot.paused = liveState === "paused";

        const lastBuiltMs = snapshot.lastBuilt ? new Date(snapshot.lastBuilt).getTime() : 0;
        const age = Date.now() - lastBuiltMs;
        if (!Number.isFinite(lastBuiltMs) || age > SNAPSHOT_STALE_MS) {
          // Fire and forget. Duplicate invocations are tolerable and
          // we want to return the current snapshot immediately.
          void triggerSnapshotBuild(clusterId);
        }
        return json(200, snapshot);
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        if (name === "NoSuchKey") {
          void triggerSnapshotBuild(clusterId);
          return json(200, {
            lastBuilt: null,
            agents: [],
            clusterState: liveState,
            clusterStartTime: null,
            paused: liveState === "paused",
          });
        }
        throw err;
      }
    }

    // ---- Cluster analysis artifact (pre-signed URL) ------------------------
    // Post-run store_read_all path. Returns either:
    //   200 { url }                              (artifact ready, fetch directly from S3)
    //   202 { status: "pending", retryAfter }    (builder still running, try again later)
    //
    // Contract matches kiro-flock-feed-mcp/src/flockClient.ts fetchAnalysisViaUrl().
    //
    // Flow:
    //   1. Read {clusterId}/store/cluster-analysis-latest.json to locate the
    //      current artifact.
    //   2. If present and fresh (running cluster → <60 s; stopped → any age),
    //      presign and return 200.
    //   3. If present but stale (running cluster, >60 s old): fire-and-forget
    //      a rebuild, return the stale presigned URL. Post-run analysis on a
    //      running cluster is unusual; prioritise responding over freshness.
    //   4. If absent: fire the builder and briefly poll (one S3 read per
    //      second, up to 20 s). If the pointer appears, presign and return 200.
    //      Otherwise return 202 with retryAfter = 15 s.
    if (method === "GET" && action === "analysis") {
      const pointer = await readAnalysisPointer(clusterId);
      if (pointer) {
        const age = Date.now() - new Date(pointer.builtAt).getTime();
        const state = await readClusterState(clusterId);
        const staleWindow = state === "running" ? ANALYSIS_STALE_MS_RUNNING : Number.POSITIVE_INFINITY;
        if (Number.isFinite(age) && age > staleWindow) {
          void triggerAnalysisBuild(clusterId);
        }
        const url = await presignAnalysisUrl(pointer.key);
        return json(200, { url });
      }

      // No pointer: fire a build, then poll for up to ANALYSIS_POLL_MS.
      void triggerAnalysisBuild(clusterId);

      const deadline = Date.now() + ANALYSIS_POLL_MS;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, ANALYSIS_POLL_STEP_MS));
        const ready = await readAnalysisPointer(clusterId);
        if (ready) {
          const url = await presignAnalysisUrl(ready.key);
          return json(200, { url });
        }
      }

      return json(202, { status: "pending", retryAfter: ANALYSIS_RETRY_AFTER_S });
    }

    // ---- Read config --------------------------------------------------------
    if (method === "GET" && action === "config") {
      // A cluster the operator just landed on from the WeltenBuilder "+"
      // card won't have a config.json yet. Return defaults so the
      // dashboard can populate its form; the first PUT or Start writes
      // the real file.
      let cfg: ClusterConfig;
      try {
        cfg = await readClusterConfig(BUCKET, clusterId);
      } catch {
        cfg = { ...DEFAULT_CLUSTER_CONFIG };
      }
      // Backfill Pass 7 defaults when reading an older config.json that
      // predates algorithm + swarmK. The SeedConfig in CDK writes these on
      // fresh stacks, but existing clusters may have an older file.
      if (cfg.algorithm === undefined) cfg.algorithm = "amorphous";
      if (cfg.swarmK === undefined) cfg.swarmK = 4;
      if (typeof cfg.autopause !== "boolean") cfg.autopause = true;
      return json(200, cfg);
    }

    // ---- Update config (partial merge) --------------------------------------
    if (method === "PUT" && action === "config") {
      // Same missing-file tolerance as GET /config so WeltenBuilder's
      // first Save on a freshly-landed cluster works without needing a
      // prior create step.
      let existing: ClusterConfig;
      try {
        existing = await readClusterConfig(BUCKET, clusterId);
      } catch {
        existing = { ...DEFAULT_CLUSTER_CONFIG };
      }
      // Apply the same backfill before merging so validation sees a complete
      // object even when the stored file predates Pass 7.
      if (existing.algorithm === undefined) existing.algorithm = "amorphous";
      if (existing.swarmK === undefined) existing.swarmK = 4;
      if (typeof existing.autopause !== "boolean") existing.autopause = true;
      const partial = JSON.parse(body ?? "{}");
      const merged: ClusterConfig = { ...existing, ...partial };

      const err = validateConfig(merged);
      if (err) return json(400, { error: err });

      console.log(`config[${clusterId}] update:`, JSON.stringify(merged));
      await writeClusterConfig(BUCKET, merged, clusterId);
      await ensureRegistered(clusterId, merged.algorithm);
      return json(200, merged);
    }

    // ---- List knowledge-base files (global, not per-cluster) ----------------
    // Knowledge-base is a shared operator-curated resource that persists
    // across runs. All clusters see the same files. Paginates in case the
    // kb grows beyond a page.
    if (method === "GET" && action === "knowledge-base") {
      const files: { key: string; size: number; lastModified: string }[] = [];
      let token: string | undefined;
      do {
        const resp = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: "knowledge-base/",
          ContinuationToken: token,
        }));
        for (const obj of resp.Contents ?? []) {
          if (!obj.Key || obj.Key === "knowledge-base/") continue;
          files.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? "",
          });
        }
        token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (token);
      files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
      return json(200, { files });
    }

    // ---- Read a single knowledge-base file (global) -------------------------
    if (method === "GET" && action === "knowledge-base/file") {
      const key = event.queryStringParameters?.key;
      if (!key) return json(400, { error: "key required" });
      // Path traversal guard: key must be under knowledge-base/ and contain no ".."
      if (!key.startsWith("knowledge-base/") || key.includes("..")) return json(403, { error: "forbidden" });
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const text = (await resp.Body?.transformToString()) ?? "";
        return json(200, { key, content: text });
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") return json(404, { error: "not found" });
        throw err;
      }
    }

    // ---- List environment files (habitat) -----------------------------------
    // Returns the whole `environment/` folder across all clusters. The
    // dashboard and WeltenBuilder both render a unified tree; the
    // dashboard auto-expands the current cluster's subfolder and leaves
    // siblings collapsed. archivedRuns and kbFileCount are bucket-level
    // counts (history/ and knowledge-base/ are shared resources).
    //
    // The clusterId parsed from the URL is ignored here — scope is
    // always "everything". Kept in the URL shape for consistency with
    // every other /cluster/<action>/<id> route.
    if (method === "GET" && action === "habitat") {
      const files: { key: string; size: number; lastModified: string }[] = [];
      let envToken: string | undefined;
      do {
        const resp = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: "environment/",
          ContinuationToken: envToken,
        }));
        for (const obj of resp.Contents ?? []) {
          if (!obj.Key || obj.Key === "environment/") continue;
          files.push({
            key: obj.Key,
            size: obj.Size ?? 0,
            lastModified: obj.LastModified?.toISOString() ?? "",
          });
        }
        envToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
      } while (envToken);
      files.sort((a, b) => b.lastModified.localeCompare(a.lastModified));

      // Count archived runs for the UI badge (global).
      const histResp = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: "history/", Delimiter: "/" }));
      const archivedRuns = (histResp.CommonPrefixes ?? []).length;

      // Count knowledge-base files so the UI can show a hint. Paginates
      // in case the kb grows beyond 1000 objects (ListObjectsV2 defaults
      // to 1000 per page).
      let kbFileCount = 0;
      let kbToken: string | undefined;
      do {
        const kbResp = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: "knowledge-base/",
          ContinuationToken: kbToken,
        }));
        kbFileCount += (kbResp.Contents ?? []).filter(o => o.Key && o.Key !== "knowledge-base/").length;
        kbToken = kbResp.IsTruncated ? kbResp.NextContinuationToken : undefined;
      } while (kbToken);

      return json(200, { files, archivedRuns, kbFileCount });
    }

    // ---- Read a single environment file -------------------------------------
    // The shared environment/ folder is readable across clusters — the tree
    // view is unified and operators occasionally need to inspect another
    // cluster's output. The clusterId in the URL is therefore informational
    // and doesn't tighten the path guard below.
    if (method === "GET" && action === "habitat/file") {
      const key = event.queryStringParameters?.key;
      if (!key) return json(400, { error: "key required" });
      // Path traversal guard: key must be under environment/ and contain no ".."
      if (!key.startsWith("environment/") || key.includes("..")) return json(403, { error: "forbidden" });
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const text = (await resp.Body?.transformToString()) ?? "";
        return json(200, { key, content: text });
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") return json(404, { error: "not found" });
        throw err;
      }
    }

    // ---- Read direction (operator goal) -------------------------------------
    if (method === "GET" && action === "direction") {
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: directionKey(clusterId) }));
        const text = (await resp.Body?.transformToString()) ?? "";
        return json(200, { direction: text });
      } catch (err: unknown) {
        // Missing direction is not an error, just means none has been set yet
        if ((err as { name?: string }).name === "NoSuchKey") return json(200, { direction: "" });
        throw err;
      }
    }

    // ---- Update direction ---------------------------------------------------
    if (method === "PUT" && action === "direction") {
      const { direction } = JSON.parse(body ?? "{}");
      if (typeof direction !== "string") return json(400, { error: "direction must be a string" });
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: directionKey(clusterId), Body: direction }));
      console.log(`direction[${clusterId}] updated, length:`, direction.length);
      // A direction save is often the operator's first write on a
      // freshly-landed cluster. Register it so WeltenBuilder sees the
      // card without waiting for a Start.
      await ensureRegistered(clusterId);
      return json(200, { ok: true });
    }

    // ---- Available instance types + vCPU quota (global) --------------------
    // Queries EC2 for current-gen Graviton types in the t/c/m/r families,
    // picks the latest generation per family+size slot, and fetches the
    // account's on-demand vCPU quota so the UI can show capacity limits.
    // This is an account-wide query — no per-cluster scoping applies.
    if (method === "GET" && action === "instance-types") {
      const allowed = /^(t|c|m|r)\d+g\.(small|medium|large|xlarge)$/;
      const wantSlots = new Map([
        ["t-small", null as any], ["t-medium", null as any],
        ["m-medium", null as any], ["m-large", null as any],
        ["c-large", null as any], ["r-large", null as any],
        ["m-xlarge", null as any],
      ]);
      let nextToken: string | undefined;
      do {
        const resp = await ec2.send(new DescribeInstanceTypesCommand({
          Filters: [
            { Name: "current-generation", Values: ["true"] },
            { Name: "processor-info.supported-architecture", Values: ["arm64"] },
          ],
          MaxResults: 100,
          NextToken: nextToken,
        }));
        for (const t of resp.InstanceTypes ?? []) {
          if (!t.InstanceType || !allowed.test(t.InstanceType)) continue;
          const family = t.InstanceType.replace(/\d.*/, "");
          const size = t.InstanceType.split(".")[1];
          const slot = `${family}-${size}`;
          if (!wantSlots.has(slot)) continue;
          const existing = wantSlots.get(slot);
          const gen = parseInt(t.InstanceType.replace(/\D+/g, ""));
          if (!existing || gen > existing.gen) {
            wantSlots.set(slot, {
              gen,
              type: t.InstanceType,
              vcpus: t.VCpuInfo?.DefaultVCpus ?? 0,
              memoryMb: t.MemoryInfo?.SizeInMiB ?? 0,
            });
          }
        }
        nextToken = resp.NextToken;
      } while (nextToken);

      // Sort: small to xlarge, then t < c < m < r within each size
      const sizeOrder: Record<string, number> = { small: 0, medium: 1, large: 2, xlarge: 3 };
      const familyOrder: Record<string, number> = { t: 0, c: 1, m: 2, r: 3 };
      const types = Array.from(wantSlots.values())
        .filter(Boolean)
        .map(v => ({ type: v.type, vcpus: v.vcpus, memoryGb: Math.round(v.memoryMb / 1024) }))
        .sort((a, b) => {
          const af = a.type.replace(/\d.*/, ""), bf = b.type.replace(/\d.*/, "");
          const as = a.type.split(".")[1], bs = b.type.split(".")[1];
          const sd = (sizeOrder[as] ?? 9) - (sizeOrder[bs] ?? 9);
          if (sd !== 0) return sd;
          return (familyOrder[af] ?? 9) - (familyOrder[bf] ?? 9);
        });

      // On-demand vCPU quota (L-1216C47A = standard families A,C,D,H,I,M,R,T,Z)
      let vcpuQuota = 0;
      try {
        const qr = await serviceQuotas.send(new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: "L-1216C47A" }));
        vcpuQuota = qr.Quota?.Value ?? 0;
      } catch { vcpuQuota = 0; }

      return json(200, { instanceTypes: types, vcpuQuota, concurrencyCap: CONCURRENCY_CAP });
    }

    // ---- List registered clusters -------------------------------------------
    // Reads the global registry and enriches each entry with live state
    // from `{clusterId}/store/cluster-snapshot.json`. Returns the shape the
    // WeltenBuilder dashboard polls on interval to render the stack cards.
    //
    // Registry backfill: the registry may not know about every running
    // cluster. Two things can go wrong:
    //   1. The snapshot for a registered cluster is stale and says
    //      "stopped" when EC2 actually shows running instances.
    //   2. An operator started a cluster via the single-cluster dashboard
    //      or MCP with a clusterId that was never written to the registry
    //      (e.g. the user landed on ?cluster=cluster_4321 and hit Start
    //      before anything registered the id).
    // ---- List registered clusters -------------------------------------------
    // Reads the global registry and enriches each entry with live state
    // and last-update info from per-cluster S3 reads:
    //
    //   {clusterId}/store/state.json           — authoritative lifecycle state
    //   {clusterId}/store/cluster-snapshot.json — last-update from agents
    //
    // Both reads run in parallel for every cluster. EC2 is only probed if
    // any cluster is currently in "stopping" state (rare): we use a single
    // DescribeInstances scoped to the affected ids to reconcile
    // stopping → stopped once the instances have actually died. The
    // common case — no cluster mid-stop — pays zero EC2 cost.
    if (method === "GET" && action === "list") {
      const registry = await readRegistry(BUCKET);

      const enriched = await Promise.all(
        registry.clusters.map(async (entry) => {
          const [stateRead, snapshotRead] = await Promise.all([
            readState(BUCKET, entry.id),
            readSnapshotForList(entry.id),
          ]);
          // Refresh snapshots for any non-stopped cluster whose data is
          // stale or missing. Fire-and-forget; the next /list (3s later)
          // picks up the new lastUpdate. Without this, a cluster only
          // visible in WeltenBuilder (no dashboard tab open) would never
          // have its snapshot rebuilt and lastUpdate would freeze.
          if (stateRead.doc.state !== "stopped"
              && (!snapshotRead.lastBuiltMs || Date.now() - snapshotRead.lastBuiltMs > SNAPSHOT_STALE_MS)) {
            void triggerSnapshotBuild(entry.id);
          }
          return {
            ...entry,
            state: stateRead.doc.state,
            _stoppedAt: stateRead.doc.transitionedAt,
            lastUpdate: snapshotRead.lastUpdate,
          };
        }),
      );

      // Reconcile any cluster stuck on "stopping": if EC2 reports zero
      // live instances for it, flip state.json to "stopped". Single
      // DescribeInstances filtered by tag, only fires if at least one
      // cluster is mid-stop.
      const stoppingIds = enriched.filter(c => c.state === "stopping").map(c => c.id);
      if (stoppingIds.length > 0) {
        const liveResp = await ec2.send(new DescribeInstancesCommand({
          Filters: [
            { Name: "tag:Project", Values: ["kiro-flock"] },
            { Name: "tag:ClusterId", Values: stoppingIds },
            { Name: "instance-state-name", Values: ["pending", "running", "stopping", "shutting-down"] },
          ],
        }));
        const stillLive = new Set<string>();
        for (const r of liveResp.Reservations ?? []) {
          for (const inst of r.Instances ?? []) {
            const tag = inst.Tags?.find(t => t.Key === "ClusterId");
            if (tag?.Value) stillLive.add(tag.Value);
          }
        }
        await Promise.all(stoppingIds
          .filter(id => !stillLive.has(id))
          .map(async (id) => {
            try {
              await setOperatorState(id, "stopped", "reconcile");
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              console.warn(`list[${id}] reconcile to stopped failed: ${message}`);
            }
            const target = enriched.find(c => c.id === id);
            if (target) target.state = "stopped";
          }));
      }

      // Auto-prune: remove clusters stopped >7 days from the registry.
      // Zero extra I/O — uses state already fetched above. Only writes
      // clusters.json on the rare poll where something actually expires.
      // After the first prune the registry is small and this is just an
      // array filter (no S3 reads, no latency impact on the response).
      const PRUNE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const toPrune = enriched.filter(c => {
        if (c.state !== "stopped") return false;
        const stoppedAt = (c as any)._stoppedAt;
        if (!stoppedAt) return false;
        const ts = new Date(stoppedAt).getTime();
        // Skip clusters that were never actually stopped (epoch = never started)
        if (!Number.isFinite(ts) || ts === 0) return false;
        return now - ts > PRUNE_AGE_MS;
      }).map(c => c.id);

      if (toPrune.length > 0) {
        const pruneSet = new Set(toPrune);
        const freshRegistry = await readRegistry(BUCKET);
        const pruned = freshRegistry.clusters.filter(c => !pruneSet.has(c.id));
        if (pruned.length < freshRegistry.clusters.length) {
          // Fire-and-forget: registry write + S3 key cleanup.
          void (async () => {
            try {
              await writeRegistry(BUCKET, { clusters: pruned });
              // Clean up orphan S3 keys for pruned clusters.
              await Promise.all(toPrune.map(async (id) => {
                const keys = [`${id}/config.json`, `${id}/direction.md`];
                await Promise.all(keys.map(key =>
                  s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {}),
                ));
              }));
              console.log(`list: auto-pruned ${toPrune.length} stale clusters (registry + S3 keys): ${toPrune.join(", ")}`);
            } catch (err: unknown) {
              console.warn("list: prune failed:", err instanceof Error ? err.message : err);
            }
          })();
        }
        // Exclude pruned from the response immediately.
        const filtered = enriched.filter(c => !pruneSet.has(c.id));
        return json(200, { clusters: filtered });
      }

      return json(200, { clusters: enriched });
    }


    // ---- Delete a cluster ---------------------------------------------------
    // Removes the cluster from the registry. S3 data under `{id}/` and
    // `environment/{id}/` is intentionally preserved so history/logs stay
    // accessible for post-hoc review. Refuses to delete a non-stopped
    // cluster or the default `cluster_0` sentinel.
    if (method === "DELETE" && action === "delete") {
      if (clusterId === DEFAULT_CLUSTER_ID) {
        return json(409, { error: `"${DEFAULT_CLUSTER_ID}" is the default cluster and cannot be deleted` });
      }
      const state = await readClusterState(clusterId);
      if (state !== "stopped") {
        return json(409, { error: `cluster is ${state}, stop it before deleting` });
      }
      const registry = await readRegistry(BUCKET);
      const before = registry.clusters.length;
      const updated: ClusterRegistry = {
        clusters: registry.clusters.filter((c) => c.id !== clusterId),
      };
      if (updated.clusters.length === before) {
        return json(404, { error: `cluster "${clusterId}" not found in registry` });
      }
      await writeRegistry(BUCKET, updated);
      console.log(`delete[${clusterId}]: removed from registry (S3 data preserved)`);
      return json(200, { ok: true });
    }

    // ---- Stop every running cluster -----------------------------------------
    // Iterates the registry and terminates any cluster that isn't already
    // stopped. Calls run in parallel. Individual failures are captured per
    // cluster so one broken call doesn't block the others. Analysis builds
    // are fired for each stopped cluster so the post-run artifact is ready
    // when the operator next opens the drill-down.
    if (method === "POST" && action === "stop-all") {
      const registry = await readRegistry(BUCKET);
      const withState = await Promise.all(
        registry.clusters.map(async (c) => ({ id: c.id, state: await readClusterState(c.id) })),
      );
      const targets = withState.filter((c) => c.state !== "stopped");
      console.log(`stop-all: ${targets.length} of ${withState.length} clusters to stop`);

      const results = await Promise.all(targets.map(async ({ id }) => {
        try {
          // Per-cluster stop: stopCluster filters by ClusterId tag so each
          // call only touches the target cluster's instances. Flip state
          // before terminate so the dashboard reflects the click on the
          // next poll; /cluster/list reconciles to "stopped" once EC2
          // shows zero live instances for the cluster.
          await setOperatorState(id, "stopping", "stop-all");
          await stopCluster(BUCKET, id);
          await archiveStoreToHistory(id, `stop-all[${id}]`);
          void triggerAnalysisBuild(id);
          return { id, ok: true as const };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`stop-all[${id}] failed:`, message);
          return { id, ok: false as const, error: message };
        }
      }));

      return json(200, { stopped: results });
    }

    // ---- Pause every running cluster ----------------------------------------
    // Flips state.json to "paused" under each running cluster's prefix.
    // Clusters not in the "running" or "starting" state are skipped.
    if (method === "POST" && action === "pause-all") {
      const registry = await readRegistry(BUCKET);
      const withState = await Promise.all(
        registry.clusters.map(async (c) => ({ id: c.id, state: await readClusterState(c.id) })),
      );
      const targets = withState.filter((c) => c.state === "running" || c.state === "starting");
      console.log(`pause-all: ${targets.length} of ${withState.length} active clusters to pause`);

      const results = await Promise.all(targets.map(async ({ id }) => {
        try {
          await setOperatorState(id, "paused", "pause-all");
          void triggerSnapshotBuild(id);
          return { id, ok: true as const };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`pause-all[${id}] failed:`, message);
          return { id, ok: false as const, error: message };
        }
      }));

      return json(200, { paused: results });
    }

    // ---- Clean environment for one cluster ----------------------------------
    // Archives `environment/{clusterId}/` and `{clusterId}/store/` to
    // history/<ts>/ and removes them from their source locations. Same
    // behaviour as POST /cluster/start's archive step, but fired on
    // explicit operator intent rather than implicitly at launch.
    // Refuses if the cluster is not stopped — running agents might be
    // mid-write. The frontend is expected to show a confirmation dialog
    // before calling this; the backend just enforces the stopped-state
    // guard.
    if (method === "POST" && action === "clean-env") {
      const state = await readClusterState(clusterId);
      if (state !== "stopped") {
        return json(409, { error: `cluster is ${state}, stop it before cleaning the environment` });
      }
      const archived = await archiveClusterToHistory(clusterId, `clean-env[${clusterId}]`);
      console.log(`clean-env[${clusterId}]: archived ${archived} files to history/`);
      return json(200, { archived });
    }

    // ---- Clean environment for every cluster --------------------------------
    // Archives every registered cluster's env subfolder and store/ to
    // history/<ts>/, the same way per-cluster clean-env and the start
    // path do. After archiving, any leftover files directly under
    // environment/ (rare, but possible via cross-cluster writes) are
    // wiped so the folder ends up clean. Refuses if any cluster in the
    // registry is not stopped; frontend owns the confirmation.
    if (method === "POST" && action === "clean-env-all") {
      const registry = await readRegistry(BUCKET);
      const withState = await Promise.all(
        registry.clusters.map(async (c) => ({ id: c.id, state: await readClusterState(c.id) })),
      );
      const runningIds = withState.filter((c) => c.state !== "stopped").map((c) => c.id);
      if (runningIds.length > 0) {
        return json(409, {
          error: `${runningIds.length} cluster(s) not stopped: ${runningIds.join(", ")}. Stop them before cleaning the environment.`,
        });
      }
      let archived = 0;
      for (const { id } of withState) {
        archived += await archiveClusterToHistory(id, `clean-env-all[${id}]`);
      }

      // Legacy cleanup: archive any agent logs under the bare `store/` prefix.
      // Before per-cluster store layout was introduced, cluster_0 wrote logs
      // directly to `store/agent-N.ndjson`. These orphans are never touched by
      // archiveClusterToHistory (which looks at `{clusterId}/store/`). Archive
      // them now, but preserve `store/analyzer/` which is actively used.
      const legacyArchived = await archiveLegacyStore(`clean-env-all`);
      archived += legacyArchived;

      // Any files left under environment/ after archiving the known
      // clusters are orphans (unregistered ids or root-level writes).
      // Wipe them to keep the folder tidy.
      const deleted = await deletePrefix("environment/");
      console.log(`clean-env-all: archived ${archived} files, swept ${deleted} orphans`);
      return json(200, { archived, deleted });
    }

    // ---- Analyzer: trigger analysis or optimization --------------------------
    // POST /cluster/analyze — gather all cluster state, invoke the analyzer
    // Lambda asynchronously, return the tab ID for polling.
    // POST /cluster/optimize — same data, different prompt (direction proposals).
    if (method === "POST" && (action === "analyze" || action === "optimize")) {
      const tabId = `${Date.now()}-${action}`;
      const analyzerFn = process.env.ANALYZER_FN;
      if (!analyzerFn) {
        return json(503, { error: "Analyzer Lambda not configured" });
      }

      // Write a placeholder so the UI can show "processing" immediately.
      const placeholder = {
        tabId,
        mode: action,
        status: "processing",
        createdAt: new Date().toISOString(),
      };
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `store/analyzer/tab-${tabId}.json`,
        Body: JSON.stringify(placeholder),
        ContentType: "application/json",
      }));

      // Invoke the analyzer Lambda asynchronously.
      await lambdaClient.send(new InvokeCommand({
        FunctionName: analyzerFn,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ mode: action, tabId })),
      }));

      return json(202, { tabId, status: "processing" });
    }

    // ---- Analyzer: poll for result ------------------------------------------
    // GET /cluster/analyzer-tab/{tabId} — read a specific tab result from S3.
    if (method === "GET" && action === "analyzer-tab") {
      const tabId = clusterId; // parseRoute puts the suffix in clusterId
      const key = `store/analyzer/tab-${tabId}.json`;
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const text = (await res.Body?.transformToString()) ?? "";
        return json(200, JSON.parse(text));
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") {
          return json(404, { error: "tab not found" });
        }
        throw err;
      }
    }

    // ---- Analyzer: list all tabs --------------------------------------------
    // GET /cluster/analyzer-tabs — list all persisted analyzer/optimizer tabs.
    if (method === "GET" && action === "analyzer-tabs") {
      const prefix = "store/analyzer/";
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
      const tabs: unknown[] = [];
      for (const obj of listed.Contents ?? []) {
        if (!obj.Key || !obj.Key.endsWith(".json")) continue;
        try {
          const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
          const text = (await res.Body?.transformToString()) ?? "";
          if (text) tabs.push(JSON.parse(text));
        } catch { /* skip unreadable */ }
      }
      // Sort newest first
      tabs.sort((a: any, b: any) => (b.createdAt || "").localeCompare(a.createdAt || ""));
      return json(200, { tabs });
    }

    // ---- Analyzer: delete a tab ---------------------------------------------
    // DELETE /cluster/analyzer-tab/{tabId}
    if (method === "DELETE" && action === "analyzer-tab") {
      const tabId = clusterId;
      const key = `store/analyzer/tab-${tabId}.json`;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      } catch { /* ignore if already gone */ }
      return json(200, { deleted: tabId });
    }

    // ---- Optimizer: apply proposed directions --------------------------------
    // POST /cluster/optimize-apply — reads the optimize tab result and writes
    // each proposed direction to the corresponding cluster's direction.md.
    if (method === "POST" && action === "optimize-apply") {
      const bodyParsed = body ? JSON.parse(body) : {};
      const tabId = bodyParsed.tabId;
      if (!tabId) return json(400, { error: "tabId required" });

      // Read the optimize result
      const key = `store/analyzer/tab-${tabId}.json`;
      let tabData: any;
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const text = (await res.Body?.transformToString()) ?? "";
        tabData = JSON.parse(text);
      } catch {
        return json(404, { error: "optimize tab not found" });
      }

      if (tabData.mode !== "optimize" || tabData.status !== "complete") {
        return json(400, { error: "tab is not a completed optimize result" });
      }

      const proposals = tabData.data?.proposals;
      if (!Array.isArray(proposals)) {
        return json(400, { error: "no proposals found in optimize result" });
      }

      // Optional filter: only apply to specific clusters
      const filterIds: string[] | null = Array.isArray(bodyParsed.clusterIds) && bodyParsed.clusterIds.length > 0
        ? bodyParsed.clusterIds
        : null;

      // Apply each proposed direction (supports both old changeType and new action schema)
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const p of proposals) {
        const action = p.action || (p.changeType === "unchanged" ? "leave-running" : "direction-update");
        const hasDirection = !!p.proposedDirection;

        // Skip if not a direction-update or no direction text
        if (!p.clusterId || action !== "direction-update" || !hasDirection) {
          skipped.push(p.clusterId || "unknown");
          continue;
        }
        // Skip if filter is active and this cluster isn't in it
        if (filterIds && !filterIds.includes(p.clusterId)) {
          skipped.push(p.clusterId);
          continue;
        }
        const dirKey = `${clusterPrefix(p.clusterId)}direction.md`;
        await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: dirKey,
          Body: p.proposedDirection,
          ContentType: "text/markdown",
        }));
        applied.push(p.clusterId);
      }

      // Mark the tab as applied (only set appliedAt when applying all, not single-cluster cherry-picks)
      if (!filterIds) {
        tabData.appliedAt = new Date().toISOString();
      }
      // Track which clusters have been applied (for partial apply UI state)
      if (!tabData.appliedClusters) tabData.appliedClusters = [];
      tabData.appliedClusters.push(...applied);
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: JSON.stringify(tabData),
        ContentType: "application/json",
      }));

      return json(200, { applied, skipped });
    }

    // ---- Map-Reduce: natural language prompt ---------------------------------
    // POST /cluster/mapreduce — accepts a natural language prompt, invokes the
    // translation Lambda (Bedrock) which then dispatches to the execution engine.
    // Returns a tab ID for polling. Results appear in the analyzer tab panel.
    if (method === "POST" && action === "mapreduce") {
      const payload = body ? JSON.parse(body) : {};
      const prompt = payload.prompt;
      if (typeof prompt !== "string" || prompt.trim().length === 0) {
        return json(400, { error: "prompt is required (non-empty string)" });
      }

      const translatorFn = process.env.MAPREDUCE_TRANSLATOR_FN;
      if (!translatorFn) {
        return json(503, { error: "Map-reduce translator Lambda not configured" });
      }

      const tabId = `${Date.now()}-mapreduce`;

      // Write a placeholder so the UI can show "processing" immediately.
      const placeholder = {
        tabId,
        mode: "map/reduce",
        status: "processing",
        createdAt: new Date().toISOString(),
        originalPrompt: prompt,
      };
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `store/analyzer/tab-${tabId}.json`,
        Body: JSON.stringify(placeholder),
        ContentType: "application/json",
      }));

      // Invoke the translator Lambda asynchronously.
      await lambdaClient.send(new InvokeCommand({
        FunctionName: translatorFn,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ tabId, prompt })),
      }));

      return json(202, { tabId, status: "processing" });
    }

    // ---- Map-Reduce: structured execution -----------------------------------
    // POST /cluster/mapreduce-exec — accepts a pre-built structured operation,
    // skips the translation layer, invokes the execution engine directly.
    // Used by the MCP for programmatic orchestration.
    if (method === "POST" && action === "mapreduce-exec") {
      const payload = body ? JSON.parse(body) : {};
      const operation = payload.operation;
      if (!operation || !operation.type) {
        return json(400, { error: "operation with type is required" });
      }
      if (!["map", "map-clear", "reduce"].includes(operation.type)) {
        return json(400, { error: `invalid operation type: ${operation.type}` });
      }

      const engineFn = process.env.MAPREDUCE_ENGINE_FN;
      if (!engineFn) {
        return json(503, { error: "Map-reduce engine Lambda not configured" });
      }

      const tabId = `${Date.now()}-mapreduce`;

      // Write a placeholder.
      const placeholder = {
        tabId,
        mode: "map/reduce",
        status: "processing",
        createdAt: new Date().toISOString(),
        operation,
      };
      await s3.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: `store/analyzer/tab-${tabId}.json`,
        Body: JSON.stringify(placeholder),
        ContentType: "application/json",
      }));

      // Invoke the engine Lambda asynchronously.
      await lambdaClient.send(new InvokeCommand({
        FunctionName: engineFn,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify({ tabId, operation })),
      }));

      return json(202, { tabId, status: "processing" });
    }


    return json(404, { error: "not found" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("handler error:", method, path, message, err instanceof Error ? err.stack : "");
    return json(500, { error: message });
  }
}
