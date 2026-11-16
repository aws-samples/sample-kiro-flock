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
 *   GET  /cluster/env-list/{cluster_id}       - paged listing scoped to environment/{cluster_id}/ (optional inline bodies)
 *   PUT  /cluster/env-put/{cluster_id}        - write one object under environment/{cluster_id}/queue/ (optional if-none-match)
 *   POST /cluster/env-delete/{cluster_id}     - delete up to 100 objects under environment/{cluster_id}/queue/
 *   GET  /cluster/direction/{cluster_id}      - read the operator's goal document
 *   PUT  /cluster/direction/{cluster_id}      - update the goal document
 *   GET  /cluster/agent-stream/{cluster_id}   - ?agentIndex=N&kind=console|acp[&sessionId=ID] — SSM tail of an agent's journald console or an ACP session (active by default, or a specific past iteration via sessionId). kind=acp-list returns the iteration/session list instead.
 *   GET  /cluster/agent-costs/{cluster_id}    - ?agentIndex=N — per-iteration credit spend entries + lifetime total from agent-N.costs.ndjson
 *   GET  /cluster/dashboard/runs/{cluster_id} - run selector list (current + archived) for the dashboard drill-down
 *   GET  /cluster/dashboard/{cluster_id}      - ?run=<runId> — per-run drill-down data (dashboard/{clusterId}/{runId}.json cache)
 *   GET  /cluster/dashboard/overview          - fleet-level dashboard aggregate (dashboard/overview.json cache)
 *
 * Global routes (no cluster_id):
 *   GET  /cluster/knowledge-base              - list shared knowledge-base files
 *   GET  /cluster/knowledge-base/file         - read a single knowledge-base file
 *   GET  /cluster/instance-types              - available Graviton types + account vCPU quota
 *   GET  /cluster/models                      - model catalog baked by install.sh (kiro-cli --list-models)
 *
 * Multi-cluster routes (WeltenBuilder):
 *   GET    /cluster/list                       - list registered clusters with live state
 *   DELETE /cluster/delete/{cluster_id}        - unregister a stopped cluster (preserves S3 data)
 *   POST   /cluster/stop-all                   - terminate every non-stopped cluster
 *   POST   /cluster/pause-all                  - pause every running cluster
 *   POST   /cluster/resume-all                 - resume every paused cluster
 *   POST   /cluster/clean-env/{cluster_id}     - archive environment/{cluster_id}/ to history/ (requires stopped)
 *   POST   /cluster/clean-env-all              - archive environment/ entirely to history/ (requires all stopped)
 *   POST   /cluster/clean-env-folder           - archive one top-level environment/<name>/ folder to history/
 *   POST   /cluster/delete-env-folder          - permanently delete one top-level environment/<name>/ folder (no history copy)
 *   POST   /cluster/delete-env-all             - permanently delete environment/ entirely (requires all stopped, no history copy)
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
  appendTransition,
  type ClusterEntry,
  type ClusterRegistry,
  type ClusterStateValue,
  type ClusterStateDoc,
} from "./s3Store";
import { loadPricingCatalog, perAgentHourlyRate } from "./pricing";
import { deriveRunManifest, earliestTs, parseRunIdTimestamp, parseTransitions } from "./dashboardCore";
import { getComputeManager, computeTypeOf, type ComputeType } from "./computeManager";
import * as deploymentService from "./deploymentService";
import { handleMetrics, handleLayout, handleStatusReport, handleStackInfo, handleDestroy } from "./forgeHandler";
import { fetchAgentStream, listAgentSessions, SESSION_ID_RE } from "./agentStream";
import {
  scopedKey,
  relativeKey,
  clampLimit,
  parseInline,
  parsePutBody,
  parseDeleteBody,
  contentTypeFor,
  INLINE_MAX_BYTES,
  INLINE_TOTAL_BYTES,
} from "./envQueue";

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
// Compute-backend specifics (AMI, security group, instance profile,
// subnets, ECS cluster/taskdef) are read from the env inside
// computeManager.ts / ec2Manager.ts / ecsManager.ts — the handler only
// dispatches on the cluster's configured computeType.
const BUCKET = process.env.BUCKET_NAME!;
const CONCURRENCY_CAP = parseInt(process.env.CONCURRENCY_CAP ?? "64", 10);
const SNAPSHOT_BUILDER_FN = process.env.SNAPSHOT_BUILDER_FN ?? "";
const ANALYSIS_BUILDER_FN = process.env.ANALYSIS_BUILDER_FN ?? "";
const DASHBOARD_BUILDER_FN = process.env.DASHBOARD_BUILDER_FN ?? "";

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

// Dashboard caches (overview + current-run drill-down) are served
// stale-while-revalidate: older than this fires an async rebuild while
// the stale doc is returned. Archived runs are immutable — never rebuilt.
const DASHBOARD_STALE_MS = 60_000;

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
 *  initiated route (start, stop, pause, resume, stop-all, pause-all,
 *  resume-all).
 *  Operator intent always wins, so no If-Match precondition. */
async function setOperatorState(
  clusterId: string,
  state: ClusterStateValue,
  reason: string,
  lastError?: { code: string; message: string; at: string } | null,
): Promise<void> {
  const doc: ClusterStateDoc = {
    state,
    transitionedAt: new Date().toISOString(),
    transitionedBy: "operator",
    reason,
  };
  // Only attach lastError when explicitly provided. Every normal transition
  // (start/stop/pause/resume) omits it, so the field is naturally absent and
  // reads back as null — which is how a successful start clears a prior
  // launch failure (the "starting" write that precedes a launch wipes it).
  if (lastError !== undefined) doc.lastError = lastError;
  await writeState(BUCKET, clusterId, doc);
  // Mirror the transition into the append-only transitions log for the
  // dashboard's lifecycle band. Best-effort by design (appendTransition
  // never throws) — the state transition itself is already committed.
  await appendTransition(BUCKET, clusterId, {
    ts: doc.transitionedAt,
    state: doc.state,
    by: doc.transitionedBy,
    reason,
  });
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
  // dashboard/* — multi-segment dashboard routes (4.7 dashboarding).
  //   dashboard/runs/{cluster_id}  → run selector list for one cluster
  //   dashboard/overview           → fleet-level aggregate (no cluster_id)
  //   dashboard/{cluster_id}       → per-run drill-down (?run=<runId>)
  if (segments[0] === "dashboard") {
    if (segments[1] === "runs") {
      return { action: "dashboard/runs", clusterId: segments[2] || DEFAULT_CLUSTER_ID };
    }
    if (segments[1] === "overview") {
      return { action: "dashboard/overview", clusterId: DEFAULT_CLUSTER_ID };
    }
    return { action: "dashboard", clusterId: segments[1] || DEFAULT_CLUSTER_ID };
  }

  // analyzer-tab/{tabId} — the tabId goes into the clusterId slot for
  // consistency with the suffix-style routing pattern.
  if (segments[0] === "analyzer-tab") {
    return { action: "analyzer-tab", clusterId: segments[1] || DEFAULT_CLUSTER_ID };
  }

  // deploy/* — deploy routes. The optional cluster_id suffix sits after the
  // full action path. Only deploy/records remains: runtime approvals were
  // replaced by config-time trust (trustDeploy).
  if (segments[0] === "deploy") {
    return { action: `deploy/${segments[1] || ""}`, clusterId: segments[2] || DEFAULT_CLUSTER_ID };
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

/** Fire-and-forget async invoke of the dashboard builder. The payload is
 *  either { target: "overview" } or { target: "cluster", clusterId, runId }
 *  — dashboardBuilder.ts scopes its S3 reads/writes accordingly. */
async function triggerDashboardBuild(
  payload: { target: "overview" } | { target: "cluster"; clusterId: string; runId: string },
): Promise<void> {
  if (!DASHBOARD_BUILDER_FN) {
    console.warn("DASHBOARD_BUILDER_FN not set; skipping builder invoke");
    return;
  }
  try {
    await lambdaClient.send(new InvokeCommand({
      FunctionName: DASHBOARD_BUILDER_FN,
      InvocationType: "Event",
      Payload: Buffer.from(JSON.stringify(payload)),
    }));
  } catch (err: unknown) {
    console.error("dashboard builder invoke failed:", err instanceof Error ? err.message : err);
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
 *  route (start/stop/pause/resume/stop-all/pause-all/resume-all) and by agents on
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
  hasAnyDirective: boolean;
  modelOverrideCount: number;
  lastBuiltMs: number | null;
  totalCredits: number | null;
  infraCostUsd: number | null;
}> {
  const empty = {
    lastUpdate: null,
    hasAnyDirective: false,
    modelOverrideCount: 0,
    lastBuiltMs: null,
    totalCredits: null,
    infraCostUsd: null,
  };
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: snapshotKey(clusterId) }));
    const text = (await resp.Body?.transformToString()) ?? "";
    if (!text) return empty;
    const snap = JSON.parse(text) as {
      lastBuilt?: unknown;
      hasAnyDirective?: unknown;
      totalCredits?: unknown;
      infraCostUsd?: unknown;
      config?: { models?: unknown } | null;
      agents?: Array<{
        agentId?: unknown;
        lastEntry?: { action?: unknown; iteration?: unknown } | null;
        lastUpdatedTs?: unknown;
        hasDirective?: unknown;
      }>;
    };
    let bestTs = 0;
    let best: { agentId: string; ts: string; action: string; iteration: number } | null = null;
    let anyDirective = false;
    for (const a of snap.agents ?? []) {
      if (a.hasDirective === true) anyDirective = true;
      if (!a.lastEntry || typeof a.lastUpdatedTs !== "string" || typeof a.agentId !== "string") continue;
      const t = new Date(a.lastUpdatedTs).getTime();
      if (!Number.isFinite(t) || t <= bestTs) continue;
      const action = typeof a.lastEntry.action === "string" ? a.lastEntry.action : "";
      const iter = typeof a.lastEntry.iteration === "number" ? a.lastEntry.iteration : 0;
      bestTs = t;
      best = { agentId: a.agentId, ts: a.lastUpdatedTs, action, iteration: iter };
    }
    // Snapshot may have a top-level summary flag; trust it over the
    // per-agent scan only when present (older snapshots predate it).
    const hasAnyDirective = typeof snap.hasAnyDirective === "boolean"
      ? snap.hasAnyDirective
      : anyDirective;
    const lastBuiltMs = typeof snap.lastBuilt === "string"
      ? (Number.isFinite(new Date(snap.lastBuilt).getTime()) ? new Date(snap.lastBuilt).getTime() : null)
      : null;
    const totalCredits = typeof snap.totalCredits === "number" && Number.isFinite(snap.totalCredits)
      ? snap.totalCredits
      : null;
    const infraCostUsd = typeof snap.infraCostUsd === "number" && Number.isFinite(snap.infraCostUsd)
      ? snap.infraCostUsd
      : null;
    // How many agents run a model other than the cluster baseline. Derived
    // from the config the snapshot already embeds verbatim, so there is no
    // separate builder field that could drift out of step with it.
    const rawModels = snap.config?.models;
    const modelOverrideCount =
      rawModels && typeof rawModels === "object" && !Array.isArray(rawModels)
        ? Object.keys(rawModels as Record<string, unknown>).filter(k => /^\d+$/.test(k)).length
        : 0;
    return { lastUpdate: best, hasAnyDirective, modelOverrideCount, lastBuiltMs, totalCredits, infraCostUsd };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return empty;
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`readSnapshotForList[${clusterId}] failed: ${message}`);
    return empty;
  }
}

/** GetObject as string for run.json derivation; "" when the key is absent. */
async function getTextOrEmpty(key: string): Promise<string> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return (await res.Body?.transformToString()) ?? "";
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return "";
    throw err;
  }
}

/** Count the objects under an S3 prefix (paged), skipping folder markers. */
async function countPrefix(prefix: string): Promise<number> {
  let count = 0;
  let token: string | undefined;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    count += (listed.Contents ?? []).filter(o => o.Key && !o.Key.endsWith("/")).length;
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return count;
}

/**
 * Write `history/<ts>/run.json` after an archive sweep (contract:
 * docs/dashboard-api.md "Backend storage"). Reads each archived
 * agent-N.ndjson once from its history/ destination (a GetObject per
 * agent file is acceptable at archive time), takes the last line of each
 * agent-N.costs.ndjson for credit totals, and derives startedAt from the
 * archived transitions log (earliest agent log ts as fallback).
 *
 * `envFileCount` is the number of environment files archived alongside
 * the store (clean-env path). Pass null for store-only archives — the
 * cluster's LIVE environment subfolder is counted instead, since the env
 * stays in place across store-only sweeps.
 *
 * Best-effort by design: a manifest failure is logged and swallowed so
 * the archive itself (already complete) is never rolled back or failed.
 */
async function writeRunManifest(
  clusterId: string,
  archivePrefix: string,
  archivedSourceKeys: string[],
  envFileCount: number | null,
  logTag: string,
): Promise<void> {
  try {
    const runId = archivePrefix.slice("history/".length).replace(/\/$/, "");
    const endedAt = new Date().toISOString();
    const destKeys = archivedSourceKeys.map(k => archivePrefix + k);
    const agentLogKeys = destKeys.filter(k => /\/agent-\d+\.ndjson$/.test(k));
    const costKeys = destKeys.filter(k => /\/agent-\d+\.costs\.ndjson$/.test(k));
    const transitionsDestKey = destKeys.find(k => k.endsWith("/transitions.ndjson")) ?? null;

    let config: ClusterConfig | null = null;
    try {
      config = await readClusterConfig(BUCKET, clusterId);
    } catch { /* never started / cleaned — manifest carries null config */ }

    const [agentLogTexts, costLogTexts, transitionsText, pricing, files] = await Promise.all([
      Promise.all(agentLogKeys.map(getTextOrEmpty)),
      Promise.all(costKeys.map(getTextOrEmpty)),
      transitionsDestKey ? getTextOrEmpty(transitionsDestKey) : Promise.resolve(""),
      loadPricingCatalog(s3, BUCKET),
      envFileCount !== null
        ? Promise.resolve(envFileCount)
        : countPrefix(envPrefix(clusterId, config?.everforgeGroup ?? null)),
    ]);

    const derived = deriveRunManifest({
      agentLogTexts,
      costLogTexts,
      transitionsText: transitionsText || null,
      fileCount: files,
      endedAt,
      hourlyRatePerAgent: perAgentHourlyRate(pricing, config),
    });

    const manifest = {
      clusterId,
      runId,
      startedAt: derived.startedAt,
      endedAt,
      config,
      totals: derived.totals,
      agents: derived.agents,
    };
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${archivePrefix}run.json`,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    }));
    console.log(`${logTag}: wrote ${archivePrefix}run.json (${derived.agents} agents, ${derived.totals.iterations} iterations)`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`${logTag}: run.json write failed (best-effort, archive is intact): ${message}`);
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
  const [envKeys, storeKeys] = await Promise.all([
    listAllKeys(envSubfolder),
    listAllKeys(storeSubfolder),
  ]);
  const toArchive = [
    ...envKeys.filter(k => k !== envSubfolder),
    ...storeKeys.filter(k => k !== storeSubfolder
      && k !== stateKey
      && k !== envSnapshotKey),
  ];
  if (toArchive.length === 0) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePrefix = `history/${ts}/`;
  console.log(`${logTag}: archiving ${toArchive.length} files to ${archivePrefix}`);
  await copyThenDeleteKeys(toArchive, key => archivePrefix + key);
  // Run manifest for the dashboard. The env files were archived in this
  // sweep, so their count is known without another LIST.
  const envArchivedCount = envKeys
    .filter(k => k !== envSubfolder && !k.endsWith("/")).length;
  await writeRunManifest(
    clusterId,
    archivePrefix,
    toArchive,
    envArchivedCount,
    logTag,
  );
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
  const storeKeys = await listAllKeys(storeSubfolder);
  const toArchive = storeKeys.filter(k => k !== storeSubfolder
    && k !== stateKey
    && k !== envSnapshotKey);
  if (toArchive.length === 0) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePrefix = `history/${ts}/`;
  console.log(`${logTag}: archiving ${toArchive.length} store files to ${archivePrefix}`);
  await copyThenDeleteKeys(toArchive, key => archivePrefix + key);
  // Run manifest for the dashboard. Store-only sweep — the environment
  // stays in place, so the cluster's live env subfolder is counted.
  await writeRunManifest(
    clusterId,
    archivePrefix,
    toArchive,
    null,
    logTag,
  );
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
  const storeKeys = await listAllKeys("store/");
  const toArchive = storeKeys.filter(k =>
    !k.startsWith("store/analyzer/")
    && k !== "store/"
  );
  if (toArchive.length === 0) return 0;
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const archivePrefix = `history/${ts}/legacy-store/`;
  console.log(`${logTag}: archiving ${toArchive.length} legacy store/ files to ${archivePrefix}`);
  await copyThenDeleteKeys(toArchive, key => archivePrefix + key);
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

/**
 * List every object key under an S3 prefix, following continuation tokens.
 * ListObjectsV2 caps at 1000 keys per page; Everforge project trees (with
 * agent-uploaded node_modules) routinely exceed that, so every archive
 * helper must paginate or it silently leaves files behind.
 */
async function listAllKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of listed.Contents ?? []) {
      if (o.Key) keys.push(o.Key);
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/**
 * Bounded concurrency for the archive copy fan-out. Serial copies blow
 * past the API Gateway 29s response limit on large folders (1500 files
 * ≈ 60-100s serial); unbounded Promise.all over thousands of keys risks
 * S3 throttling. ~30 workers archives a 1500-file tree in a few seconds.
 */
const ARCHIVE_COPY_CONCURRENCY = 30;

/**
 * Copy `keys` to their mapped destination with a bounded worker pool,
 * then batch-delete the originals (DeleteObjects, 1000 per call).
 * Copy-all-then-delete-all: originals are only removed after every copy
 * succeeded, so a mid-flight failure never loses data.
 */
async function copyThenDeleteKeys(keys: string[], destFor: (key: string) => string): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(ARCHIVE_COPY_CONCURRENCY, keys.length) }, async () => {
    while (next < keys.length) {
      const key = keys[next++];
      await s3.send(new CopyObjectCommand({
        Bucket: BUCKET,
        CopySource: `${BUCKET}/${encodeURIComponent(key).replace(/%2F/g, "/")}`,
        Key: destFor(key),
      }));
    }
  });
  await Promise.all(workers);
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await s3.send(new DeleteObjectsCommand({
      Bucket: BUCKET,
      Delete: { Objects: chunk.map((k) => ({ Key: k })), Quiet: true },
    }));
  }
}

/**
 * Copy all objects under `srcPrefix` to `dstPrefix`, then delete the originals.
 * Used by the per-folder clean endpoint to archive individual environment folders.
 */
async function copyAndDeletePrefix(srcPrefix: string, dstPrefix: string): Promise<number> {
  const keys = await listAllKeys(srcPrefix);
  if (keys.length === 0) return 0;
  await copyThenDeleteKeys(keys, (key) => dstPrefix + key.slice(srcPrefix.length));
  return keys.length;
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
 * Model catalog. The list of models the deployment's kiro-cli knows about,
 * baked into s3://BUCKET/config/models.json by install.sh (via
 * `kiro-cli --list-models`). Neither the browser nor this Lambda can run
 * kiro-cli, so this file is the single source of truth for the dashboard's
 * model picker and for validating a chosen model. No model ids are hardcoded
 * anywhere in this file — the allowed set comes entirely from the catalog.
 *
 * Cached in the warm container for a short TTL so a freshly-baked catalog is
 * picked up without waiting for the container to recycle, while repeated
 * validations don't hit S3 on every call.
 */
interface ModelCatalog {
  models: Array<{
    model_id: string;
    model_name?: string;
    description?: string;
    context_window_tokens?: number;
    [k: string]: unknown;
  }>;
  default_model?: string | null;
  [k: string]: unknown;
}

const MODEL_CATALOG_KEY = "config/models.json";
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;
let modelCatalogCache: { at: number; catalog: ModelCatalog | null } | null = null;

async function loadModelCatalog(): Promise<ModelCatalog | null> {
  const now = Date.now();
  if (modelCatalogCache && now - modelCatalogCache.at < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache.catalog;
  }
  let catalog: ModelCatalog | null = null;
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: MODEL_CATALOG_KEY }));
    const text = (await resp.Body?.transformToString()) ?? "";
    if (text) {
      const parsed = JSON.parse(text) as ModelCatalog;
      if (parsed && Array.isArray(parsed.models)) catalog = parsed;
    }
  } catch (err: unknown) {
    // A missing catalog (old deployment, or install.sh skipped the step) is
    // not fatal: validation falls back to a permissive charset check.
    if ((err as { name?: string }).name !== "NoSuchKey") {
      console.warn("loadModelCatalog: failed to read", MODEL_CATALOG_KEY, err);
    }
  }
  modelCatalogCache = { at: now, catalog };
  return catalog;
}

/** Valid model ids from the catalog, or null when the catalog is unavailable. */
function catalogModelIds(catalog: ModelCatalog | null): Set<string> | null {
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) return null;
  const ids = catalog.models
    .map(m => m.model_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length > 0 ? new Set(ids) : null;
}

/**
 * Validate the chosen agent model. `null` means "use kiro-cli's own default"
 * (the `--model` flag is omitted at launch). A non-null value must be a model
 * id present in the deployment catalog; when the catalog is unavailable we
 * fall back to a safe-charset check so selection still works and the agent's
 * own kiro-cli remains the final arbiter. On an unknown model the valid set
 * is returned so the caller (dashboard or MCP agent) gets immediate feedback.
 */
function validateModel(
  model: unknown,
  allowed: Set<string> | null,
): { error: string; validModels?: string[] } | null {
  if (model === null || model === undefined) return null;
  if (typeof model !== "string" || model.length === 0) {
    return { error: "model must be a non-empty string or null" };
  }
  if (allowed && allowed.size > 0) {
    if (!allowed.has(model)) {
      return {
        error: `model "${model}" is not in the deployment model catalog`,
        validModels: [...allowed],
      };
    }
    return null;
  }
  // Permissive fallback: catalog unavailable. Guard against garbage/injection
  // without blocking a model a newer agent-side kiro-cli may support.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(model)) {
    return { error: "model must be alphanumeric with '.', '_' or '-' (max 64 chars), or null" };
  }
  return null;
}

/**
 * Validate the cluster-wide `model` plus every entry of the per-agent
 * `models` override map in a single pass.
 *
 * Deliberately reports EVERY bad id at once rather than returning on the
 * first. A caller setting overrides for several agents would otherwise have
 * to fix one id, retry, discover the next, and retry again — one round trip
 * per mistake. The `validModels` set is attached whenever the catalog is
 * available so the caller can correct all of them in one go.
 *
 * Keys must be non-negative integers. Keys at or beyond `concurrency` are
 * accepted and round-trip unused (like a stale `swarmK` under a non-swarm
 * algorithm), so overrides can be staged before scaling the cluster up.
 */
function validateModelSelection(
  config: ClusterConfig,
  allowed: Set<string> | null,
): { error: string; validModels?: string[] } | null {
  const problems: string[] = [];

  const clusterErr = validateModel(config.model, allowed);
  if (clusterErr) problems.push(clusterErr.error);

  const models = config.models;
  if (models !== undefined && models !== null) {
    if (typeof models !== "object" || Array.isArray(models)) {
      // An array can't express "no override for this agent" once null means
      // "kiro-cli default", so it is rejected rather than coerced.
      return {
        error: "models must be an object keyed by agent index (e.g. {\"0\": \"model-id\", \"3\": null}), not an array",
      };
    }
    for (const [key, value] of Object.entries(models)) {
      if (!/^\d+$/.test(key)) {
        problems.push(`models key "${key}" must be a non-negative integer agent index`);
        continue;
      }
      const valueErr = validateModel(value, allowed);
      if (valueErr) problems.push(`models["${key}"]: ${valueErr.error}`);
    }
  }

  if (problems.length === 0) return null;
  const result: { error: string; validModels?: string[] } = { error: problems.join("; ") };
  if (allowed && allowed.size > 0) result.validModels = [...allowed];
  return result;
}

/**
 * Validate cluster config fields. Returns an error string or null if valid.
 * Used by both POST /cluster/start and PUT /cluster/config. Model validation
 * is handled separately by validateModelSelection() at each call site, since
 * it needs the (async-loaded) catalog and returns a richer error shape.
 */
function validateConfig(config: ClusterConfig): string | null {
  if (config.concurrency > CONCURRENCY_CAP) {
    return `concurrency ${config.concurrency} exceeds the configured cap of ${CONCURRENCY_CAP}`;
  }
  // computeType is optional (older configs) — absent means "ecs".
  if (config.computeType !== undefined && config.computeType !== "ec2" && config.computeType !== "ecs") {
    return `computeType must be "ec2" or "ecs"`;
  }
  // instanceType is only consumed on EC2, but validate its shape
  // unconditionally so a garbled config is caught regardless of the
  // active backend (the field round-trips either way, like swarmK).
  if (!/^(t|c|m|r)\d+g\.(small|medium|large|xlarge)$/.test(config.instanceType)) {
    return `instanceType "${config.instanceType}" is not in the allowed set (Graviton t/c/m/r families, small through xlarge)`;
  }
  // taskSize is the ECS mirror of instanceType — optional (absent means
  // "medium"), validated unconditionally like instanceType.
  if (
    config.taskSize !== undefined &&
    config.taskSize !== "small" && config.taskSize !== "medium" &&
    config.taskSize !== "large" && config.taskSize !== "xlarge"
  ) {
    return `taskSize must be one of "small", "medium", "large", "xlarge"`;
  }
  // Algorithm validation runs early so downstream field checks can branch
  // on the active algorithm (neighbourRadius is only used by amorphous;
  // swarmK only by swarm).
  if (
    config.algorithm !== "amorphous" &&
    config.algorithm !== "mesh" &&
    config.algorithm !== "swarm" &&
    config.algorithm !== "single"
  ) {
    return `algorithm must be one of "amorphous", "mesh", "swarm", "single"`;
  }
  // single takes any concurrency >= 1. Each agent runs the direction alone
  // with no peers, so N agents are N independent fire-and-forget runs of
  // the same direction (a Kiro Factory remote loop uses this for several
  // lone workers on one card). The old rule pinned it to exactly 1.
  if (config.algorithm === "single" && (!Number.isInteger(config.concurrency) || config.concurrency < 1)) {
    return `algorithm "single" requires concurrency >= 1 (got ${config.concurrency})`;
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
  // model and the per-agent models map are validated separately by
  // validateModelSelection() at each call site — it needs the async-loaded
  // catalog and returns the valid set on a bad value.
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
  if (typeof config.selfOptimizing !== "boolean") {
    return "selfOptimizing must be a boolean";
  }
  if (typeof config.browserAutomation !== "boolean") {
    return "browserAutomation must be a boolean";
  }
  // trustDeploy is optional — validate only when present
  if (config.trustDeploy !== undefined && typeof config.trustDeploy !== "boolean") {
    return "trustDeploy must be a boolean";
  }
  // everforgeGroup is optional — validate format when present
  if (config.everforgeGroup !== undefined && config.everforgeGroup !== null) {
    if (typeof config.everforgeGroup !== "string") {
      return "everforgeGroup must be a string or null";
    }
    if (!/^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/.test(config.everforgeGroup)) {
      return "everforgeGroup must match the same format as cluster IDs (lowercase alphanumerics/hyphens, 2-32 chars)";
    }
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
  computeType: "ecs",
  instanceType: "t4g.medium",
  taskSize: "medium",
  loopIntervalSeconds: 30,
  model: null,
  algorithm: "amorphous",
  swarmK: 4,
  autopause: true,
  selfOptimizing: false,
  browserAutomation: false,
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
  algorithm: "amorphous" | "mesh" | "swarm" | "single" = "amorphous",
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
      if (typeof existing.selfOptimizing !== "boolean") existing.selfOptimizing = false;
      if (typeof existing.browserAutomation !== "boolean") existing.browserAutomation = false;
      if (existing.trustDeploy === undefined) existing.trustDeploy = false;
      if (existing.computeType !== "ec2" && existing.computeType !== "ecs") existing.computeType = "ecs";
      if (existing.taskSize === undefined) existing.taskSize = "medium";
      const config = { ...existing, ...overrides } as ClusterConfig;

      const err = validateConfig(config);
      if (err) return json(400, { error: err });
      const modelErr = validateModelSelection(config, catalogModelIds(await loadModelCatalog()));
      if (modelErr) return json(400, modelErr);

      // Register the cluster on first Start so WeltenBuilder's list view
      // picks it up. Safe no-op if it's already registered.
      await ensureRegistered(clusterId, config.algorithm);

      // Compute backend for this start. Restart-required field, so the
      // value merged above is authoritative for the whole launch.
      const compute = getComputeManager(computeTypeOf(config), BUCKET);

      // If this is the async background invocation, do the actual work.
      if (event.headers?.["x-aga-async"] === "true") {
        // Guard against double-start. Scoped to this cluster (ClusterId
        // tag on EC2, startedBy on ECS) so one cluster's start never sees
        // another cluster's runtimes as "already running". Belt-and-braces
        // with the state.json check the sync path already did; covers the
        // unlikely case where two operators clicked Start simultaneously
        // and both passed the sync-path guard before either reached the
        // async invoke.
        const existingCount = await compute.liveCount(clusterId);
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

        // Re-seed the transitions log for the new run. The sync path's
        // "starting" transition was appended before the archive sweep, so
        // it just left with the previous run's store/. Without this the
        // new run's dashboard timeline band has no start marker.
        await appendTransition(BUCKET, clusterId, {
          ts: new Date().toISOString(),
          state: "starting",
          by: "operator",
          reason: "manual",
        });

        // Pre-trust: if trustDeploy is enabled, write a trusted approval
        // file for every agent so deploy_request fires immediately without
        // waiting for an operator click. Written before instances launch so
        // the file is in place when the first agent iteration runs.
        if (config.trustDeploy) {
          const preTrustPromises: Promise<void>[] = [];
          for (let i = 0; i < config.concurrency; i++) {
            const approvalKey = `store/approvals/${clusterId}/agent-${i}.json`;
            const approvalFile = {
              status: "trusted",
              mode: "remote",
              summary: "pre-trusted on cluster start",
              systemname: clusterId,
              cwd: "",
              stackName: "",
              createdAt: new Date().toISOString(),
              decidedBy: "operator (trustDeploy)",
              decidedAt: new Date().toISOString(),
            };
            preTrustPromises.push(
              s3.send(new PutObjectCommand({
                Bucket: BUCKET,
                Key: approvalKey,
                Body: JSON.stringify(approvalFile, null, 2),
                ContentType: "application/json",
              })).then(() => undefined),
            );
          }
          await Promise.all(preTrustPromises);
          console.log(`start[${clusterId}]: pre-trusted ${config.concurrency} agents (trustDeploy=true)`);
        }

        console.log(`start[${clusterId}]: launching`, config.concurrency, "agents on", compute.computeType, compute.computeType === "ec2" ? `(type ${config.instanceType})` : "(fargate)");
        await writeClusterConfig(BUCKET, config, clusterId);
        // Thread clusterId through so launched instances get a ClusterId
        // tag and the agent user-data sets AGA_CLUSTER_PREFIX correctly.
        //
        // A launch can fail mid-loop — most notably InsufficientInstanceCapacity
        // when the chosen instance type has no capacity in any of the cluster's
        // AZs. startCluster rethrows any non-throttle, non-capacity-fallback
        // error. Without this catch the throw unwinds to the outer handler,
        // returns a 500 that nobody reads (this is an async Event invocation),
        // and leaves state.json wedged in "starting" forever. Instead we:
        //   1. terminate any instances that DID launch before the throw, so a
        //      retry starts clean (stopCluster filters by the ClusterId tag,
        //      which every launched instance already carries),
        //   2. write a terminal, retryable state ("stopped") with the error
        //      attached so the dashboard, /cluster/list, and the MCP can show
        //      the operator exactly what went wrong.
        try {
          const ids = await compute.start(config, clusterId);
          return json(200, { instanceIds: ids });
        } catch (launchErr: unknown) {
          const code = (launchErr as { name?: string; Code?: string }).name
            ?? (launchErr as { Code?: string }).Code ?? "LaunchFailed";
          const message = launchErr instanceof Error ? launchErr.message : String(launchErr);
          console.error(`start[${clusterId}]: launch failed (${code}): ${message}`);
          // Partial-launch cleanup: terminate anything that came up before the
          // throw so the operator's retry isn't blocked by the double-start guard.
          try {
            await compute.stop(clusterId);
          } catch (cleanupErr: unknown) {
            const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
            console.error(`start[${clusterId}]: partial-launch cleanup failed: ${cleanupMsg}`);
          }
          // Roll state back to a terminal, retryable state with the cause
          // captured. Reusing "stopped" (rather than a new "failed" value)
          // keeps every exhaustive ClusterStateValue consumer correct; the
          // error rides as data on the state doc.
          await setOperatorState(clusterId, "stopped", "launch-failed", {
            code,
            message,
            at: new Date().toISOString(),
          });
          return json(500, { error: `launch failed: ${message}`, code });
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
      // The stored config tells us which compute backend the cluster was
      // started on. Missing config (never started / already cleaned) means
      // there is nothing to terminate on the non-default backend — fall
      // back to EC2, whose tag-scoped stop is a safe no-op.
      let stopCompute: ComputeType = "ec2";
      try {
        stopCompute = computeTypeOf(await readClusterConfig(BUCKET, clusterId));
      } catch { /* no config — default ec2 */ }
      const compute = getComputeManager(stopCompute, BUCKET);
      // Scope termination to this cluster's runtimes (ClusterId tag on
      // EC2, startedBy on ECS) so one cluster's stop doesn't take down
      // another.
      await compute.stop(clusterId);

      // If no runtimes remain (already terminated or never existed),
      // transition directly to "stopped" so the cluster doesn't get
      // stuck in "stopping" waiting for a reconciliation pass.
      const liveCount = await compute.liveCount(clusterId);
      if (liveCount === 0) {
        await setOperatorState(clusterId, "stopped", "immediate");
        console.log(`stop[${clusterId}]: no agent runtimes remain, state -> stopped`);
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
      // Read the full state doc (not just .state) so we can surface the
      // authoritative lastError and reason. state.json is the single source
      // of truth — updated synchronously on every operator transition and by
      // agents on Starting → Running — so the dashboard sees the click effect
      // and any launch failure on the very next poll.
      const { doc: stateDoc } = await readState(BUCKET, clusterId);
      const liveState = stateDoc.state;
      const lastError = stateDoc.lastError ?? null;
      const stateReason = stateDoc.reason ?? null;
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: snapshotKey(clusterId) }));
        const text = (await resp.Body?.transformToString()) ?? "";
        const snapshot = JSON.parse(text);
        snapshot.clusterState = liveState;
        snapshot.paused = liveState === "paused";
        snapshot.lastError = lastError;
        snapshot.stateReason = stateReason;

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
            lastError,
            stateReason,
          });
        }
        throw err;
      }
    }

    // ---- Dashboard: fleet overview -------------------------------------------
    // Serves the builder-produced dashboard/overview.json verbatim.
    // Stale-while-revalidate: a doc older than DASHBOARD_STALE_MS is
    // returned as-is with an async rebuild fired behind it. Before the
    // first build exists the route answers 202 {status:"building"} and
    // the frontend polls every 2 s until 200.
    if (method === "GET" && action === "dashboard/overview") {
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "dashboard/overview.json" }));
        const text = (await resp.Body?.transformToString()) ?? "";
        const doc = JSON.parse(text) as { lastBuilt?: unknown };
        const builtMs = typeof doc.lastBuilt === "string" ? new Date(doc.lastBuilt).getTime() : 0;
        if (!Number.isFinite(builtMs) || Date.now() - builtMs > DASHBOARD_STALE_MS) {
          void triggerDashboardBuild({ target: "overview" });
        }
        return json(200, doc);
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") {
          void triggerDashboardBuild({ target: "overview" });
          return json(202, { status: "building" });
        }
        throw err;
      }
    }

    // ---- Dashboard: run selector list ----------------------------------------
    // Lists selectable runs for one cluster: the live "current" run first
    // (when the cluster has agent logs or a non-stopped state), then
    // archived runs newest-first. Archived entries use history/<ts>/run.json
    // when present; legacy archives without a manifest fall back to the
    // folder timestamp for endedAt (the builder self-heals them lazily).
    if (method === "GET" && action === "dashboard/runs") {
      // Enumerate history/<ts>/ prefixes.
      const runIds: string[] = [];
      let token: string | undefined;
      do {
        const res = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET, Prefix: "history/", Delimiter: "/", ContinuationToken: token,
        }));
        for (const p of res.CommonPrefixes ?? []) {
          if (!p.Prefix) continue;
          const id = p.Prefix.slice("history/".length).replace(/\/$/, "");
          if (id) runIds.push(id);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token);

      const archived = (await Promise.all(runIds.map(async (runId) => {
        // run.json first: authoritative clusterId + timestamps.
        const manifestText = await getTextOrEmpty(`history/${runId}/run.json`);
        if (manifestText) {
          try {
            const m = JSON.parse(manifestText) as { clusterId?: unknown; startedAt?: unknown; endedAt?: unknown };
            if (m.clusterId !== clusterId) return null;
            return {
              runId,
              clusterId,
              startedAt: typeof m.startedAt === "string" ? m.startedAt : null,
              endedAt: typeof m.endedAt === "string" ? m.endedAt : parseRunIdTimestamp(runId),
              live: false,
            };
          } catch { /* malformed manifest — fall through to prefix probe */ }
        }
        // No manifest: probe whether this archive contains the cluster.
        const probe = await s3.send(new ListObjectsV2Command({
          Bucket: BUCKET, Prefix: `history/${runId}/${clusterPrefix(clusterId)}store/`, MaxKeys: 1,
        }));
        if ((probe.KeyCount ?? 0) === 0) return null;
        return { runId, clusterId, startedAt: null, endedAt: parseRunIdTimestamp(runId), live: false };
      }))).filter((r): r is NonNullable<typeof r> => r !== null)
        // Newest-first: the runId format sorts lexicographically by time.
        .sort((a, b) => b.runId.localeCompare(a.runId));

      // "current" appears when the cluster has a non-archived store/
      // (any agent logs or a non-stopped state).
      const [logProbe, stateRead, transitionsText] = await Promise.all([
        s3.send(new ListObjectsV2Command({
          Bucket: BUCKET, Prefix: `${clusterPrefix(clusterId)}store/agent-`, MaxKeys: 1,
        })),
        readState(BUCKET, clusterId),
        getTextOrEmpty(`${clusterPrefix(clusterId)}store/transitions.ndjson`),
      ]);
      const runs: Array<{ runId: string; clusterId: string; startedAt: string | null; endedAt: string | null; live: boolean }> = [];
      if ((logProbe.KeyCount ?? 0) > 0 || stateRead.doc.state !== "stopped") {
        // startedAt from the earliest transitions entry — the log is
        // append-only, re-seeded on every start, so its head marks the
        // current run's beginning. Null for runs predating the log.
        const startedAt = transitionsText ? earliestTs(parseTransitions(transitionsText)) : null;
        runs.push({ runId: "current", clusterId, startedAt, endedAt: null, live: true });
      }
      runs.push(...archived);
      return json(200, { runs });
    }

    // ---- Dashboard: per-run drill-down ----------------------------------------
    // Serves dashboard/{clusterId}/{runId}.json. `run` defaults to
    // "current". Archived runs are immutable — cached forever, never
    // rebuilt once present. The current run gets the same 202-while-
    // building and stale-while-revalidate treatment as the overview.
    if (method === "GET" && action === "dashboard") {
      const runId = event.queryStringParameters?.run || "current";
      // The runId is either "current" or a history/ folder timestamp;
      // reject anything that could traverse into another key space.
      if (!/^[A-Za-z0-9_.-]+$/.test(runId)) {
        return json(400, { error: "invalid run id" });
      }
      const cacheKey = `dashboard/${clusterId}/${runId}.json`;
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: cacheKey }));
        const text = (await resp.Body?.transformToString()) ?? "";
        const doc = JSON.parse(text) as { lastBuilt?: unknown };
        if (runId === "current") {
          const builtMs = typeof doc.lastBuilt === "string" ? new Date(doc.lastBuilt).getTime() : 0;
          if (!Number.isFinite(builtMs) || Date.now() - builtMs > DASHBOARD_STALE_MS) {
            void triggerDashboardBuild({ target: "cluster", clusterId, runId });
          }
        }
        return json(200, doc);
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") {
          void triggerDashboardBuild({ target: "cluster", clusterId, runId });
          return json(202, { status: "building" });
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

    // ---- Read per-agent directive ------------------------------------------
    // GET /cluster/agent-directive/{clusterId}?agentIndex=N
    //
    // Returns the markdown body of {clusterId}/store/agent-N.directive.md,
    // or { directive: null } when no directive has been issued. Cheap
    // single GetObject on operator click; the dashboard already knows
    // hasDirective from the snapshot poll, so this only fires when the
    // operator wants to read content.
    if (method === "GET" && action === "agent-directive") {
      const qs = event.queryStringParameters ?? {};
      const rawIdx = qs.agentIndex;
      if (typeof rawIdx !== "string" || !/^\d+$/.test(rawIdx)) {
        return json(400, { error: "agentIndex query parameter is required and must be a non-negative integer" });
      }
      const agentIndex = Number(rawIdx);
      const key = `${clusterPrefix(clusterId)}store/agent-${agentIndex}.directive.md`;
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const directive = (await resp.Body?.transformToString()) ?? "";
        return json(200, { agentIndex, directive });
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") {
          return json(200, { agentIndex, directive: null });
        }
        throw err;
      }
    }

    // ---- Per-agent iteration costs -------------------------------------------
    // GET /cluster/agent-costs/{clusterId}?agentIndex=N
    //
    // Returns the parsed contents of {clusterId}/store/agent-N.costs.ndjson:
    // one entry per completed iteration with its credit spend, plus the
    // agent's running lifetime total. Single GetObject, fetched lazily by
    // the Kiro Node view when the operator opens an agent — never on the
    // snapshot poll, so it adds nothing to the steady-state request load.
    // The file grows ~120 bytes per iteration, so even a 10k-iteration run
    // is ~1.2 MB — fine for an on-demand read.
    if (method === "GET" && action === "agent-costs") {
      const idError = validateClusterId(clusterId);
      if (idError) return json(400, { error: idError });
      const qs = event.queryStringParameters ?? {};
      const rawIdx = qs.agentIndex;
      if (typeof rawIdx !== "string" || !/^\d+$/.test(rawIdx)) {
        return json(400, { error: "agentIndex query parameter is required and must be a non-negative integer" });
      }
      const agentIndex = Number(rawIdx);
      const key = `${clusterPrefix(clusterId)}store/agent-${agentIndex}.costs.ndjson`;
      try {
        const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const text = (await resp.Body?.transformToString()) ?? "";
        // Two line shapes. A measured iteration carries `credits`; an
        // interrupted one carries `unmetered: true` and NO credits, because
        // kiro-cli only records metering for turns that complete, so the value
        // is genuinely unknown rather than late. Unmetered lines used to be
        // dropped by a `typeof credits === "number"` guard, which made every
        // total read as complete when it was only a floor.
        const entries: Array<{ ts: string; iteration: number; sessionId: string; credits: number | null; unmetered: boolean; totalCredits: number }> = [];
        for (const raw of text.split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          try {
            const e = JSON.parse(line) as { ts?: unknown; iteration?: unknown; sessionId?: unknown; credits?: unknown; unmetered?: unknown; totalCredits?: unknown };
            if (typeof e.iteration !== "number" || !Number.isFinite(e.iteration)) continue;
            const hasCredits = typeof e.credits === "number" && Number.isFinite(e.credits);
            const unmetered = e.unmetered === true || !hasCredits;
            entries.push({
              ts: typeof e.ts === "string" ? e.ts : "",
              iteration: e.iteration,
              sessionId: typeof e.sessionId === "string" ? e.sessionId : "",
              credits: hasCredits ? (e.credits as number) : null,
              unmetered,
              totalCredits: typeof e.totalCredits === "number" && Number.isFinite(e.totalCredits) ? e.totalCredits : 0,
            });
          } catch { /* skip malformed line */ }
        }
        // The running total is a sum of readings only, so take it from the last
        // line that actually carried one — an unmetered line carries the total
        // forward unchanged, but a trailing malformed line should not zero it.
        let totalCredits: number | null = null;
        for (let i = entries.length - 1; i >= 0; i--) {
          if (entries[i].totalCredits > 0 || entries[i].credits !== null) {
            totalCredits = entries[i].totalCredits;
            break;
          }
        }
        const unmeteredCount = entries.filter((e) => e.unmetered).length;
        return json(200, { agentIndex, entries, totalCredits, unmeteredCount });
      } catch (err: unknown) {
        if ((err as { name?: string }).name === "NoSuchKey") {
          return json(200, { agentIndex, entries: [], totalCredits: null });
        }
        throw err;
      }
    }

    // ---- Per-agent live stream tail (Kiro Node view) -------------------------
    // GET /cluster/agent-stream/{clusterId}?agentIndex=N&kind=console|acp
    //
    // One SSM RunCommand per fetch (a TAIL, never a full-session read —
    // see stream-console-plan.md). kind=console tails the aga-agent
    // journald unit; kind=acp tails the active ACP session .jsonl and
    // formats it to markdown. Lazy: only fires while an operator has the
    // Kiro Node section open on this agent, so SSM fan-out is bounded by
    // human behaviour. "Cluster not running" style situations answer 200
    // with { content: null, unavailable } so the UI shows a quiet empty
    // state instead of an error toast.
    if (method === "GET" && action === "agent-stream") {
      const idError = validateClusterId(clusterId);
      if (idError) return json(400, { error: idError });
      const qs = event.queryStringParameters ?? {};
      const rawIdx = qs.agentIndex;
      if (typeof rawIdx !== "string" || !/^\d+$/.test(rawIdx)) {
        return json(400, { error: "agentIndex query parameter is required and must be a non-negative integer" });
      }
      const kind = qs.kind;
      if (kind !== "console" && kind !== "acp" && kind !== "acp-list") {
        return json(400, { error: 'kind query parameter is required and must be "console", "acp", or "acp-list"' });
      }
      // Optional past-iteration selector (acp only). Allowlist-validated
      // here AND in agentStream.ts before it reaches the shell template.
      const sessionId = qs.sessionId;
      if (sessionId !== undefined && !SESSION_ID_RE.test(sessionId)) {
        return json(400, { error: "sessionId must match ^[A-Za-z0-9_-]{1,128}$" });
      }
      if (sessionId !== undefined && kind !== "acp") {
        return json(400, { error: 'sessionId is only valid with kind "acp"' });
      }
      // Works on both compute backends: agentStream routes on the shape of
      // the snapshot's per-agent runtime id — SSM RunCommand + journald on
      // EC2, ECS Exec + CloudWatch Logs on Fargate.
      try {
        if (kind === "acp-list") {
          const result = await listAgentSessions(s3, BUCKET, clusterId, Number(rawIdx));
          return json(200, result);
        }
        const result = await fetchAgentStream(s3, BUCKET, clusterId, Number(rawIdx), kind, sessionId);
        return json(200, result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return json(502, { error: `stream fetch failed: ${msg}` });
      }
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
      // Pass 8 backfill — off by default to preserve existing behaviour.
      if (typeof cfg.selfOptimizing !== "boolean") cfg.selfOptimizing = false;
      if (typeof cfg.browserAutomation !== "boolean") cfg.browserAutomation = false;
      if (cfg.trustDeploy === undefined) cfg.trustDeploy = false;
      if (cfg.computeType !== "ec2" && cfg.computeType !== "ecs") cfg.computeType = "ecs";
      if (cfg.taskSize === undefined) cfg.taskSize = "medium";
      // model: older configs predate the selectable-model feature. null means
      // "use kiro-cli's own default" — the same effective behaviour they had.
      if (cfg.model === undefined) cfg.model = null;
      // everforgeGroup: no backfill needed — undefined/null both mean "not grouped"
      return json(200, cfg);
    }

    // ---- Model catalog (global, not per-cluster) ----------------------------
    // Returns the models baked into config/models.json by install.sh
    // (`kiro-cli --list-models`). The dashboard reads this to populate its
    // model picker. When the catalog hasn't been baked yet (old deployment)
    // the models array is empty — the picker then offers only the "default"
    // option and the backend validates any chosen model permissively.
    if (method === "GET" && action === "models") {
      const catalog = await loadModelCatalog();
      return json(200, catalog ?? { models: [], default_model: null });
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
      // Pass 8 backfill.
      if (typeof existing.selfOptimizing !== "boolean") existing.selfOptimizing = false;
      if (typeof existing.browserAutomation !== "boolean") existing.browserAutomation = false;
      if (existing.trustDeploy === undefined) existing.trustDeploy = false;
      if (existing.computeType !== "ec2" && existing.computeType !== "ecs") existing.computeType = "ecs";
      if (existing.taskSize === undefined) existing.taskSize = "medium";
      const partial = JSON.parse(body ?? "{}");
      const merged: ClusterConfig = { ...existing, ...partial };

      const err = validateConfig(merged);
      if (err) return json(400, { error: err });
      const modelErr = validateModelSelection(merged, catalogModelIds(await loadModelCatalog()));
      if (modelErr) return json(400, modelErr);

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

    // ---- Scoped environment queue routes ------------------------------------
    // Three routes that let an external operator (Kiro Factory) move queue
    // items in and out of ONE cluster's environment/<id>/ prefix over REST.
    // Unlike habitat/, these are strictly scoped: every key is built
    // server-side as environment/<clusterId>/<rel> and <rel> is validated
    // by scopedKey (no "..", no leading "/", no control chars). Writes and
    // deletes are further confined to <rel> starting with "queue/". The
    // Lambda role is bucket-wide, so this validation IS the access control.
    //
    // Unknown cluster ids return 404 so a caller cannot probe or populate
    // prefixes for clusters that were never registered.
    // The cluster's deployment group decides where its folder is
    // (environment/<group>/<id>/ when set). Read once per request so every
    // scoped key below lands in the folder the agents actually use.
    let envGroup: string | null = null;
    if (action === "env-list" || action === "env-put" || action === "env-delete") {
      if (validateClusterId(clusterId) !== null) return json(404, { error: "cluster not found" });
      const registry = await readRegistry(BUCKET);
      if (!registry.clusters.some((c) => c.id === clusterId)) return json(404, { error: "cluster not found" });
      try {
        envGroup = (await readClusterConfig(BUCKET, clusterId))?.everforgeGroup ?? null;
      } catch {
        envGroup = null; // no config yet: ungrouped, same as the agents assume
      }
    }

    if (method === "GET" && action === "env-list") {
      const q = event.queryStringParameters ?? {};
      const scoped = scopedKey(clusterId, q.prefix ?? "", { allowEmpty: true, group: envGroup });
      if (!scoped.ok) return json(403, { error: scoped.error });
      const limit = clampLimit(q.limit);
      const inline = parseInline(q.inline);
      let startAfter: string | undefined;
      if (q.after) {
        const afterScoped = scopedKey(clusterId, q.after, { group: envGroup });
        if (!afterScoped.ok) return json(403, { error: afterScoped.error });
        startAfter = afterScoped.key;
      }

      const resp = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: scoped.key,
        MaxKeys: limit,
        StartAfter: startAfter,
      }));

      const files: { key: string; size: number; lastModified: string; content?: string }[] = [];
      let inlineBudget = INLINE_TOTAL_BYTES;
      for (const obj of resp.Contents ?? []) {
        if (!obj.Key) continue;
        const rel = relativeKey(clusterId, obj.Key, envGroup);
        if (!rel) continue;
        const size = obj.Size ?? 0;
        const entry: { key: string; size: number; lastModified: string; content?: string } = {
          key: rel,
          size,
          lastModified: obj.LastModified?.toISOString() ?? "",
        };
        if (inline && size <= INLINE_MAX_BYTES && size <= inlineBudget) {
          try {
            const got = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key }));
            entry.content = (await got.Body?.transformToString()) ?? "";
            inlineBudget -= size;
          } catch (err: unknown) {
            // Object vanished between list and get (another node moved it).
            // Leave content absent; the client fetches or skips.
            if ((err as { name?: string }).name !== "NoSuchKey") throw err;
          }
        }
        files.push(entry);
      }
      const next = resp.IsTruncated && files.length > 0 ? files[files.length - 1].key : null;
      return json(200, { files, next });
    }

    if (method === "PUT" && action === "env-put") {
      const parsed = parsePutBody(body);
      if (!parsed.ok) return json(parsed.status, { error: parsed.error });
      const scoped = scopedKey(clusterId, parsed.rel, { requireQueuePrefix: true, group: envGroup });
      if (!scoped.ok) return json(403, { error: scoped.error });
      try {
        const put = await s3.send(new PutObjectCommand({
          Bucket: BUCKET,
          Key: scoped.key,
          Body: parsed.content,
          ContentType: contentTypeFor(parsed.rel),
          ...(parsed.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        }));
        return json(200, { key: parsed.rel, etag: put.ETag ?? null });
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (name === "PreconditionFailed" || status === 412) return json(412, { error: "exists" });
        throw err;
      }
    }

    if (method === "POST" && action === "env-delete") {
      const parsed = parseDeleteBody(body);
      if (!parsed.ok) return json(parsed.status, { error: parsed.error });
      const absolute: string[] = [];
      for (const rel of parsed.rels) {
        const scoped = scopedKey(clusterId, rel, { requireQueuePrefix: true, group: envGroup });
        // One bad key rejects the whole call and nothing is deleted.
        if (!scoped.ok) return json(403, { error: `${rel}: ${scoped.error}` });
        absolute.push(scoped.key);
      }
      const resp = await s3.send(new DeleteObjectsCommand({
        Bucket: BUCKET,
        Delete: { Objects: absolute.map((k) => ({ Key: k })), Quiet: false },
      }));
      const deleted = (resp.Deleted ?? [])
        .map((d) => d.Key && relativeKey(clusterId, d.Key, envGroup))
        .filter((k): k is string => !!k);
      const errors = (resp.Errors ?? []).map((e) => ({
        key: (e.Key && relativeKey(clusterId, e.Key, envGroup)) ?? e.Key ?? "",
        code: e.Code ?? "",
        message: e.Message ?? "",
      }));
      return json(200, { deleted, errors });
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
            hasAnyDirective: snapshotRead.hasAnyDirective,
            // Number of agents pinned to a model other than the cluster
            // baseline. Drives the "mixed models" pill on the stack card so a
            // heterogeneous cluster is visible without drilling in.
            modelOverrideCount: snapshotRead.modelOverrideCount,
            // Lifetime credit spend of this cluster (sum of agent totals),
            // sourced from the snapshot so /list stays zero-extra-I/O.
            totalCredits: snapshotRead.totalCredits,
            // Estimated infra cost (EC2/Fargate) in USD for the current run.
            infraCostUsd: snapshotRead.infraCostUsd,
            // Surface a launch failure on the WeltenBuilder card. Null for a
            // healthy cluster; populated when the last start threw (e.g.
            // InsufficientInstanceCapacity) and rolled state back to stopped.
            lastError: stateRead.doc.lastError ?? null,
          };
        }),
      );

      // Reconcile any cluster stuck on "stopping": if its compute backend
      // reports zero live runtimes, flip state.json to "stopped". Only
      // fires if at least one cluster is mid-stop (rare) — the common
      // case pays zero compute-API cost. Stopping clusters are grouped by
      // their configured computeType so an EC2 cluster is checked against
      // DescribeInstances and an ECS one against ListTasks.
      const stoppingIds = enriched.filter(c => c.state === "stopping").map(c => c.id);
      if (stoppingIds.length > 0) {
        const byCompute = new Map<ComputeType, string[]>();
        await Promise.all(stoppingIds.map(async (id) => {
          let ct: ComputeType = "ec2";
          try {
            ct = computeTypeOf(await readClusterConfig(BUCKET, id));
          } catch { /* no config — default ec2 */ }
          const group = byCompute.get(ct) ?? [];
          group.push(id);
          byCompute.set(ct, group);
        }));
        const stillLive = new Set<string>();
        await Promise.all([...byCompute.entries()].map(async ([ct, ids]) => {
          const live = await getComputeManager(ct, BUCKET).liveClusterIds(ids);
          for (const id of live) stillLive.add(id);
        }));
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
          // Per-cluster stop, scoped to each cluster's runtimes (ClusterId
          // tag on EC2, startedBy on ECS) via its configured compute
          // backend. Flip state before terminate so the dashboard reflects
          // the click on the next poll; /cluster/list reconciles to
          // "stopped" once the backend shows zero live runtimes.
          let ct: ComputeType = "ec2";
          try {
            ct = computeTypeOf(await readClusterConfig(BUCKET, id));
          } catch { /* no config — default ec2 */ }
          await setOperatorState(id, "stopping", "stop-all");
          await getComputeManager(ct, BUCKET).stop(id);
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

    // ---- Resume every paused cluster -----------------------------------------
    // Flips state.json back to "running" under each paused cluster's prefix.
    // Only clusters in the "paused" state are targeted — anything else is
    // skipped rather than erroring, so the bulk call is safe to fire against
    // a mixed fleet. Mirrors pause-all: parallel calls, per-cluster failure
    // capture, snapshot rebuild fired per cluster so the dashboard reflects
    // the transition on the next poll.
    if (method === "POST" && action === "resume-all") {
      const registry = await readRegistry(BUCKET);
      const withState = await Promise.all(
        registry.clusters.map(async (c) => ({ id: c.id, state: await readClusterState(c.id) })),
      );
      const targets = withState.filter((c) => c.state === "paused");
      console.log(`resume-all: ${targets.length} of ${withState.length} clusters to resume`);

      const results = await Promise.all(targets.map(async ({ id }) => {
        try {
          await setOperatorState(id, "running", "resume-all");
          void triggerSnapshotBuild(id);
          return { id, ok: true as const };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`resume-all[${id}] failed:`, message);
          return { id, ok: false as const, error: message };
        }
      }));

      return json(200, { resumed: results });
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
    // Archives stopped clusters' env subfolders and store/ to
    // history/<ts>/. Running clusters are skipped (not blocked).
    // After archiving, any leftover orphan files directly under
    // environment/ that don't belong to a running cluster are wiped.
    if (method === "POST" && action === "clean-env-all") {
      const registry = await readRegistry(BUCKET);
      const withState = await Promise.all(
        registry.clusters.map(async (c) => ({ id: c.id, state: await readClusterState(c.id) })),
      );
      const stoppedIds = withState.filter((c) => c.state === "stopped").map((c) => c.id);
      const runningIds = withState.filter((c) => c.state !== "stopped").map((c) => c.id);
      if (stoppedIds.length === 0) {
        return json(200, { archived: 0, skipped: runningIds, message: "No stopped clusters to clean." });
      }
      let archived = 0;
      for (const id of stoppedIds) {
        archived += await archiveClusterToHistory(id, `clean-env-all[${id}]`);
      }

      // Legacy cleanup: archive any agent logs under the bare `store/` prefix.
      // Before per-cluster store layout was introduced, cluster_0 wrote logs
      // directly to `store/agent-N.ndjson`. These orphans are never touched by
      // archiveClusterToHistory (which looks at `{clusterId}/store/`). Archive
      // them now, but preserve `store/analyzer/` which is actively used.
      const legacyArchived = await archiveLegacyStore(`clean-env-all`);
      archived += legacyArchived;

      // Only wipe orphan environment files if ALL clusters are stopped.
      // If some are still running, just report what was archived.
      let deleted = 0;
      if (runningIds.length === 0) {
        deleted = await deletePrefix("environment/");
      }
      console.log(`clean-env-all: archived ${archived} files, swept ${deleted} orphans, skipped ${runningIds.length} running`);
      return json(200, { archived, deleted, skipped: runningIds });
    }

    // ---- Clean a specific top-level environment folder -----------------------
    // POST /cluster/clean-env-folder — archives a single top-level folder under
    // environment/ (e.g. "environment/my-project/" or "environment/deployed/").
    // No cluster-state check — the operator makes the call per-folder.
    if (method === "POST" && action === "clean-env-folder") {
      const payload = JSON.parse(body ?? "{}");
      const folder = payload.folder as string;
      if (!folder || !folder.startsWith("environment/") || !folder.endsWith("/")) {
        return json(400, { error: "folder must be a path like environment/<name>/" });
      }
      // Safety: don't allow cleaning the entire environment/ root
      const relative = folder.replace("environment/", "");
      if (!relative || relative === "/") {
        return json(400, { error: "Use clean-env-all to archive the entire environment" });
      }
      const ts = new Date().toISOString().replace(/[:T]/g, "-").replace(/\.\d+Z/, "");
      const historyPrefix = `history/${ts}/${folder}`;
      const archived = await copyAndDeletePrefix(folder, historyPrefix);
      console.log(`clean-env-folder[${folder}]: archived ${archived} files to ${historyPrefix}`);
      return json(200, { archived, folder });
    }

    // ---- Delete a specific top-level environment folder ----------------------
    // POST /cluster/delete-env-folder — permanently deletes a single top-level
    // folder under environment/ (e.g. "environment/my-project/"). Unlike the
    // clean-env-folder archive path there is NO copy to history/ — the files
    // are gone for good. Deletes are pure metadata ops (paginated
    // ListObjectsV2 + DeleteObjects in 1000-key batches), so this is faster
    // than an archive of the same folder. The frontend/MCP is expected to
    // gather explicit confirmation before calling; the backend just validates
    // the folder shape.
    if (method === "POST" && action === "delete-env-folder") {
      const payload = JSON.parse(body ?? "{}");
      const folder = payload.folder as string;
      if (!folder || !folder.startsWith("environment/") || !folder.endsWith("/")) {
        return json(400, { error: "folder must be a path like environment/<name>/" });
      }
      // Safety: don't allow deleting the entire environment/ root here.
      const relative = folder.replace("environment/", "");
      if (!relative || relative === "/") {
        return json(400, { error: "Use delete-env-all to delete the entire environment" });
      }
      const deleted = await deletePrefix(folder);
      console.log(`delete-env-folder[${folder}]: permanently deleted ${deleted} files`);
      return json(200, { deleted, folder });
    }

    // ---- Delete the entire environment ---------------------------------------
    // POST /cluster/delete-env-all — permanently deletes everything under
    // environment/. No history/ copy, no run manifest — irreversible by
    // design. Refuses unless every registered cluster is stopped, since
    // running agents may be mid-write in their environment subfolders.
    if (method === "POST" && action === "delete-env-all") {
      const registry = await readRegistry(BUCKET);
      const withState = await Promise.all(
        registry.clusters.map(async (c) => ({ id: c.id, state: await readClusterState(c.id) })),
      );
      const runningIds = withState.filter((c) => c.state !== "stopped").map((c) => c.id);
      if (runningIds.length > 0) {
        return json(409, {
          error: "all clusters must be stopped before deleting the environment",
          running: runningIds,
        });
      }
      const deleted = await deletePrefix("environment/");
      console.log(`delete-env-all: permanently deleted ${deleted} files`);
      return json(200, { deleted });
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
      if (operation.target !== undefined && !["agents", "files"].includes(operation.target)) {
        return json(400, { error: `invalid target: ${operation.target} (expected "agents" or "files")` });
      }
      // File operations are read-only. Fail fast here so the caller gets a 400
      // instead of an async error surfacing in the tab a second later.
      if (operation.target === "files" && operation.type !== "reduce") {
        return json(400, {
          error: `target "files" is read-only: ${operation.type} is not supported. Use target "agents" to write directives, or env_upload to place files in the environment.`,
        });
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

    // ---- Deployment flow routes -------------------------------------------
    // Runtime approvals were removed: trust is decided at cluster config time
    // via trustDeploy (pre-trusted marker files written on cluster_start).

    // GET /cluster/deploy/records — list deployment records by systemname
    if (method === "GET" && action === "deploy/records") {
      const systemname = event.queryStringParameters?.systemname;

      // If no override provided, try to read from cluster config
      let effectiveSystemname = systemname;
      if (!effectiveSystemname) {
        try {
          const cfg = await readClusterConfig(BUCKET, clusterId);
          effectiveSystemname = (cfg as unknown as Record<string, unknown>).systemname as string | undefined;
        } catch { /* no config */ }
      }

      const records = await deploymentService.listRecords(BUCKET, effectiveSystemname);
      return json(200, { records });
    }

    // ---- Forge (monitoring dashboard) -------------------------------------

    if (method === "POST" && path === "/forge/metrics") {
      const payload = JSON.parse(body ?? "{}");
      const group = payload.group || null;
      const range = payload.timeRange || "1h";
      const result = await handleMetrics(group, range);
      return json(200, result);
    }

    if (method === "POST" && path === "/forge/layout") {
      const payload = JSON.parse(body ?? "{}");
      const group = payload.group || null;
      const result = await handleLayout(group);
      return json(200, result);
    }

    if (method === "POST" && path === "/forge/status-report") {
      const payload = JSON.parse(body ?? "{}");
      const group = payload.group || null;
      const result = await handleStatusReport(group);
      return json(200, result);
    }

    // POST /forge/stack-info — stack name/status + deployer cluster states for
    // the destroy confirmation dialog.
    if (method === "POST" && path === "/forge/stack-info") {
      const payload = JSON.parse(body ?? "{}");
      const group = payload.group || null;
      const result = await handleStackInfo(group);
      return json(result.error ? 404 : 200, result);
    }

    // POST /forge/destroy — delete the CloudFormation stack backing a
    // deployment group. Irreversible; confirmation is gathered client-side
    // (typed phrase in the dashboard, confirm parameter in the MCP). No
    // cluster-state gate — a running deployer is warned about, not blocked on.
    if (method === "POST" && path === "/forge/destroy") {
      const payload = JSON.parse(body ?? "{}");
      const group = payload.group || null;
      const result = await handleDestroy(group);
      if (result.error) return json(404, result);
      console.log(`forge/destroy[${group ?? "default"}]: DeleteStack ${result.stackName}`);
      return json(200, result);
    }

    // POST /forge/cache-clear — delete the cached layout so next load regenerates
    if (method === "POST" && path === "/forge/cache-clear") {
      const payload = JSON.parse(body ?? "{}");
      const group = payload.group || "default";
      const cacheKey = `store/forge/${group}/layout.json`;
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: cacheKey }));
      } catch { /* ignore if not found */ }
      return json(200, { cleared: cacheKey });
    }

    return json(404, { error: "not found" });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("handler error:", method, path, message, err instanceof Error ? err.stack : "");
    return json(500, { error: message });
  }
}
