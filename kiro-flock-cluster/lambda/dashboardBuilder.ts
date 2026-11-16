/**
 * Dashboard builder Lambda (4.7 dashboarding).
 *
 * Async worker invoked by the API handler (snapshotBuilder pattern) when
 * a dashboard cache is missing or stale. Reads full agent logs, cost
 * logs, the transitions log, and environment file listings from S3,
 * buckets everything at 1-minute resolution per docs/dashboard-api.md,
 * and writes the composed JSON caches:
 *
 *   dashboard/overview.json                — fleet-level aggregate
 *   dashboard/{clusterId}/{runId}.json     — per-run drill-down
 *
 * Full-file NDJSON reads are fine here: this runs asynchronously, not
 * per-poll, and archived runs are built exactly once (immutable caches).
 *
 * Event payload:
 *   { target: "overview" }
 *   { target: "cluster", clusterId: string, runId: string }
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  DEFAULT_CLUSTER_ID,
  clusterPrefix,
  envPrefix,
  readConfig,
  readRegistry,
  readState,
  type ClusterConfig,
  type TransitionEntry,
} from "./s3Store";
import { loadPricingCatalog, perAgentHourlyRate } from "./pricing";
import {
  buildClusterSeries,
  deriveRunManifest,
  durationBucket,
  isoWeekStart,
  nodesBucket,
  parseAgentLog,
  parseCostLog,
  parseRunIdTimestamp,
  parseTransitions,
  type AgentLogLine,
  type CostLine,
  type RunTotals,
} from "./dashboardCore";

const BUCKET = process.env.BUCKET_NAME!;
const s3 = new S3Client({});

// Overview sort weight for topRuns: converts raw credits to USD so AI and
// infra spend rank on the same scale. Mirrors the frontend's shared
// OVERAGE_RATE (web/costFormat.js) — used for ORDERING only; the response
// carries raw credits per the contract's units section.
const TOP_RUNS_CREDIT_USD = 0.04;
const TOP_RUNS_LIMIT = 10;

// ---------- Event ------------------------------------------------------------

type DashboardBuilderEvent =
  | { target: "overview" }
  | { target: "cluster"; clusterId: string; runId: string };

// ---------- Shared S3 helpers ------------------------------------------------

/** GetObject as string; null on NoSuchKey. */
async function getText(key: string): Promise<string | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return (await res.Body?.transformToString()) ?? "";
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/** List every object under a prefix (paged). */
async function listAll(prefix: string): Promise<Array<{ key: string; lastModified: Date | null }>> {
  const out: Array<{ key: string; lastModified: Date | null }> = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (obj.Key) out.push({ key: obj.Key, lastModified: obj.LastModified ?? null });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** List the top-level history/<ts>/ run prefixes (paged, delimiter). */
async function listHistoryRunIds(): Promise<string[]> {
  const out: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: "history/",
      Delimiter: "/",
      ContinuationToken: token,
    }));
    for (const p of res.CommonPrefixes ?? []) {
      if (!p.Prefix) continue;
      // "history/2026-07-26T14-03-11/" → "2026-07-26T14-03-11"
      const runId = p.Prefix.slice("history/".length).replace(/\/$/, "");
      if (runId) out.push(runId);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Read this cluster's config; null when missing. */
async function readConfigOrNull(clusterId: string): Promise<ClusterConfig | null> {
  try {
    return await readConfig(BUCKET, clusterId);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("not found in bucket")) return null;
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

// ---------- Run manifest (history/<ts>/run.json) ------------------------------

export interface RunManifest {
  clusterId: string;
  runId: string;
  startedAt: string | null;
  endedAt: string | null;
  config: ClusterConfig | null;
  totals: RunTotals;
  agents: number;
}

/** Read history/<runId>/run.json; null when absent or unparsable. */
async function readRunManifest(runId: string): Promise<RunManifest | null> {
  const text = await getText(`history/${runId}/run.json`);
  if (!text) return null;
  try {
    return JSON.parse(text) as RunManifest;
  } catch {
    console.warn(`dashboard: history/${runId}/run.json is malformed — rebuilding`);
    return null;
  }
}

/**
 * Self-healing for legacy archives: aggregate a history/<runId>/ folder
 * that predates the run.json manifest, write the manifest back, and
 * return it. Returns null when the folder has no recognisable cluster
 * store (e.g. legacy-store sweeps).
 */
async function healRunManifest(runId: string): Promise<RunManifest | null> {
  const prefix = `history/${runId}/`;
  const objects = await listAll(prefix);
  if (objects.length === 0) return null;

  // Find the archived cluster's store: history/<ts>/{clusterId}/store/...
  // A folder may in rare cases contain more than one cluster (parallel
  // stop-all archives landing in the same second); the manifest format
  // carries one clusterId, so we take the first found and aggregate its
  // store only.
  let clusterId: string | null = null;
  const storeRe = new RegExp(`^history/${runId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/store/`);
  for (const obj of objects) {
    const m = obj.key.match(storeRe);
    if (m && m[1] !== "environment" && m[1] !== "legacy-store") {
      clusterId = m[1];
      break;
    }
  }
  if (!clusterId) return null;

  const storePrefix = `${prefix}${clusterId}/store/`;
  const agentLogKeys = objects.filter(o => /\/agent-\d+\.ndjson$/.test(o.key) && o.key.startsWith(storePrefix));
  const costKeys = objects.filter(o => /\/agent-\d+\.costs\.ndjson$/.test(o.key) && o.key.startsWith(storePrefix));
  const envFileCount = objects.filter(o => o.key.startsWith(`${prefix}environment/`) && !o.key.endsWith("/")).length;

  const [agentLogTexts, costLogTexts, transitionsText] = await Promise.all([
    Promise.all(agentLogKeys.map(o => getText(o.key).then(t => t ?? ""))),
    Promise.all(costKeys.map(o => getText(o.key).then(t => t ?? ""))),
    getText(`${storePrefix}transitions.ndjson`),
  ]);

  const endedAt = parseRunIdTimestamp(runId) ?? new Date().toISOString();
  // Legacy archives carry no config snapshot, so the infra rate is
  // unknown — infraUsd stays 0 rather than guessing an instance type.
  const derived = deriveRunManifest({
    agentLogTexts,
    costLogTexts,
    transitionsText,
    fileCount: envFileCount,
    endedAt,
    hourlyRatePerAgent: null,
  });

  const manifest: RunManifest = {
    clusterId,
    runId,
    startedAt: derived.startedAt,
    endedAt,
    config: null,
    totals: derived.totals,
    agents: derived.agents,
  };
  try {
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${prefix}run.json`,
      Body: JSON.stringify(manifest),
      ContentType: "application/json",
    }));
    console.log(`dashboard: self-healed run.json for legacy archive ${runId} (${clusterId})`);
  } catch (err: unknown) {
    console.warn(`dashboard: failed to write self-healed run.json for ${runId}:`, err instanceof Error ? err.message : err);
  }
  return manifest;
}

// ---------- Cluster target ----------------------------------------------------

/** Selected config fields the drill-down response carries (contract). */
function configSubset(config: ClusterConfig | null): Record<string, unknown> | null {
  if (!config) return null;
  return {
    concurrency: config.concurrency,
    computeType: config.computeType ?? "ecs",
    taskSize: config.taskSize ?? "medium",
    instanceType: config.instanceType,
    model: config.model,
    algorithm: config.algorithm,
    loopIntervalSeconds: config.loopIntervalSeconds,
  };
}

async function buildClusterDashboard(clusterId: string, runId: string): Promise<void> {
  const started = Date.now();
  const live = runId === "current";
  const storePrefix = live
    ? `${clusterPrefix(clusterId)}store/`
    : `history/${runId}/${clusterPrefix(clusterId)}store/`;

  // Config: archived runs prefer the config snapshotted into run.json so
  // the drill-down reflects what the run actually ran with; the current
  // run (and archives without a manifest) use the live config.json.
  const manifest = live ? null : await readRunManifest(runId);
  const liveConfig = await readConfigOrNull(clusterId);
  const config = (!live && manifest?.config) ? manifest.config : liveConfig;

  const [storeObjects, pricing, stateRead] = await Promise.all([
    listAll(storePrefix),
    loadPricingCatalog(s3, BUCKET),
    live ? readState(BUCKET, clusterId) : Promise.resolve(null),
  ]);

  const agentLogKeys = storeObjects.filter(o => /\/agent-(\d+)\.ndjson$/.test(o.key));
  const costKeys = storeObjects.filter(o => /\/agent-(\d+)\.costs\.ndjson$/.test(o.key));

  // Environment listing: live runs list the cluster's live environment
  // subfolder (Everforge-group aware via envPrefix); archived runs list
  // the same subfolder under the history/ archive prefix.
  const envSubPrefix = envPrefix(clusterId, config?.everforgeGroup ?? null);
  const envListPrefix = live ? envSubPrefix : `history/${runId}/${envSubPrefix}`;

  const [agentLogTexts, costTexts, transitionsText, envObjects] = await Promise.all([
    Promise.all(agentLogKeys.map(o => getText(o.key).then(t => ({ key: o.key, text: t ?? "" })))),
    Promise.all(costKeys.map(o => getText(o.key).then(t => ({ key: o.key, text: t ?? "" })))),
    getText(`${storePrefix}transitions.ndjson`),
    listAll(envListPrefix),
  ]);

  const agentLogs = new Map<string, AgentLogLine[]>();
  for (const { key, text } of agentLogTexts) {
    const m = key.match(/\/agent-(\d+)\.ndjson$/);
    if (m) agentLogs.set(`agent-${m[1]}`, parseAgentLog(text));
  }
  const costLogs = new Map<string, CostLine[]>();
  for (const { key, text } of costTexts) {
    const m = key.match(/\/agent-(\d+)\.costs\.ndjson$/);
    if (m) costLogs.set(`agent-${m[1]}`, parseCostLog(text));
  }

  const transitions: TransitionEntry[] = transitionsText ? parseTransitions(transitionsText) : [];

  // startedAt: earliest transitions entry, falling back to the earliest
  // agent log line, then to the archive manifest / folder timestamp.
  let startedAt: string | null = null;
  {
    const candidates: Array<{ ts: string }> = [...transitions];
    for (const entries of agentLogs.values()) {
      if (entries.length > 0) candidates.push({ ts: entries[0].ts });
    }
    let bestMs = Number.POSITIVE_INFINITY;
    for (const c of candidates) {
      const ms = new Date(c.ts).getTime();
      if (Number.isFinite(ms) && ms < bestMs) {
        bestMs = ms;
        startedAt = c.ts;
      }
    }
  }
  if (!startedAt && manifest?.startedAt) startedAt = manifest.startedAt;

  const endedAt = live
    ? null
    : (manifest?.endedAt ?? parseRunIdTimestamp(runId) ?? new Date().toISOString());

  const hourlyRate = perAgentHourlyRate(pricing, config);
  const nowMs = Date.now();
  // Extend agent activity windows to now only while the cluster is
  // actually iterating; a paused/stopping live run should show its
  // activity taper off rather than paint every agent active-to-now.
  const clusterState = stateRead?.doc.state ?? "stopped";
  const extendToNow = live && (clusterState === "running" || clusterState === "starting");

  // Empty run (no logs, no transitions): pin the series to a single
  // bucket at now so the response stays valid JSON per contract.
  const effectiveStart = startedAt ?? new Date(nowMs).toISOString();

  const series = buildClusterSeries({
    agentLogs,
    costLogs,
    fileTimestampsMs: envObjects
      .filter(o => !o.key.endsWith("/"))
      .map(o => o.lastModified?.getTime() ?? NaN)
      .filter(ms => Number.isFinite(ms)),
    startedAt: effectiveStart,
    endedAt,
    nowMs,
    extendToNow,
    hourlyRatePerAgent: hourlyRate,
  });

  const doc = {
    lastBuilt: new Date().toISOString(),
    clusterId,
    runId,
    live,
    startedAt,
    endedAt,
    config: configSubset(config),
    infraHourlyRatePerAgent: hourlyRate,
    transitions,
    buckets: series.buckets,
    agents: series.agents,
    totals: series.totals,
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: `dashboard/${clusterId}/${runId}.json`,
    Body: JSON.stringify(doc),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));

  console.log(
    `dashboard[${clusterId}]: built ${runId} in ${Date.now() - started}ms: ${series.agents.length} agents, ${series.buckets.length} buckets, ${transitions.length} transitions`,
  );
}

// ---------- Overview target ----------------------------------------------------

async function buildOverview(): Promise<void> {
  const started = Date.now();
  const [runIds, registry] = await Promise.all([
    listHistoryRunIds(),
    readRegistry(BUCKET),
  ]);

  // Load (or self-heal) every run manifest. Legacy-store sweeps and empty
  // folders resolve to null and drop out.
  const manifests = (await Promise.all(
    runIds.map(async (runId) => (await readRunManifest(runId)) ?? (await healRunManifest(runId))),
  )).filter((m): m is RunManifest => m !== null);

  const nowMs = Date.now();

  // Live clusters: registry entries whose state.json says non-stopped,
  // enriched from the pre-computed cluster snapshot (agents, costs,
  // start time) — same source /cluster/list uses.
  const running = (await Promise.all(registry.clusters.map(async (entry) => {
    const [stateRead, snapshotText] = await Promise.all([
      readState(BUCKET, entry.id),
      getText(`${clusterPrefix(entry.id)}store/cluster-snapshot.json`),
    ]);
    if (stateRead.doc.state === "stopped") return null;
    let agents = 0;
    let aiCredits: number | null = null;
    let infraUsd: number | null = null;
    let startedAt: string | null = null;
    if (snapshotText) {
      try {
        const snap = JSON.parse(snapshotText) as {
          agents?: unknown[];
          totalCredits?: unknown;
          infraCostUsd?: unknown;
          clusterStartTime?: unknown;
        };
        agents = Array.isArray(snap.agents) ? snap.agents.length : 0;
        aiCredits = typeof snap.totalCredits === "number" ? snap.totalCredits : null;
        infraUsd = typeof snap.infraCostUsd === "number" ? snap.infraCostUsd : null;
        startedAt = typeof snap.clusterStartTime === "string" ? snap.clusterStartTime : null;
      } catch { /* stale/malformed snapshot — leave defaults */ }
    }
    return {
      clusterId: entry.id,
      name: entry.name,
      state: stateRead.doc.state,
      agents,
      aiCredits: aiCredits ?? 0,
      infraUsd: infraUsd ?? 0,
      startedAt,
    };
  }))).filter((c): c is NonNullable<typeof c> => c !== null);

  // All clusters & runs: union of registry entries and every clusterId
  // seen in the history manifests, so stopped clusters that predate the
  // registry (or were deregistered) still get a door into the drill-down.
  const manifestsByCluster = new Map<string, RunManifest[]>();
  for (const m of manifests) {
    const list = manifestsByCluster.get(m.clusterId) ?? [];
    list.push(m);
    manifestsByCluster.set(m.clusterId, list);
  }
  const runningById = new Map(running.map(r => [r.clusterId, r]));
  const registryById = new Map(registry.clusters.map(c => [c.id, c]));
  const allClusterIds = new Set<string>([...registryById.keys(), ...manifestsByCluster.keys()]);
  const clusters = Array.from(allClusterIds).map((id) => {
    const runs = (manifestsByCluster.get(id) ?? [])
      .slice()
      .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? ""));
    const live = runningById.get(id) ?? null;
    return {
      clusterId: id,
      name: registryById.get(id)?.name ?? id,
      state: live?.state ?? "stopped",
      live: live !== null,
      runCount: runs.length + (live ? 1 : 0),
      lastRunAt: live?.startedAt ?? runs[0]?.startedAt ?? runs[0]?.endedAt ?? null,
      totalAiCredits: runs.reduce((s, m) => s + m.totals.aiCredits, 0) + (live?.aiCredits ?? 0),
      totalInfraUsd: runs.reduce((s, m) => s + m.totals.infraUsd, 0) + (live?.infraUsd ?? 0),
      // Drill-down entry point: the live run when running, else the
      // newest archived run. Null for a registered-but-never-run cluster.
      latestRunId: live ? "current" : (runs[0]?.runId ?? null),
    };
  }).sort((a, b) => {
    // Live clusters first, then by recency.
    if (a.live !== b.live) return a.live ? -1 : 1;
    return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "");
  });

  // Per-run reference time for weekly grouping: startedAt, falling back
  // to endedAt for manifests without a derivable start.
  const runRefMs = (m: RunManifest): number | null => {
    const ref = m.startedAt ?? m.endedAt;
    if (!ref) return null;
    const ms = new Date(ref).getTime();
    return Number.isFinite(ms) ? ms : null;
  };

  // Weekly: last 12 ISO weeks, oldest first, zero-filled.
  const weekStarts: string[] = [];
  for (let i = 11; i >= 0; i--) {
    weekStarts.push(isoWeekStart(nowMs - i * 7 * 24 * 3_600_000));
  }
  const weeklyMap = new Map<string, { weekStart: string; runs: number; aiCredits: number; infraUsd: number; files: number }>();
  for (const ws of weekStarts) {
    weeklyMap.set(ws, { weekStart: ws, runs: 0, aiCredits: 0, infraUsd: 0, files: 0 });
  }
  // Per-cluster weekly breakdown: weekStart → clusterId → cost + run hours.
  // Feeds the overview's "cost per week by cluster" and "run hours per week
  // by cluster" stacked charts. Runs attribute wholly to the week of their
  // reference time (no cross-week splitting — good enough at week grain).
  const weeklyClusterMap = new Map<string, Map<string, { aiCredits: number; infraUsd: number; hours: number }>>();
  for (const ws of weekStarts) weeklyClusterMap.set(ws, new Map());
  for (const m of manifests) {
    const ms = runRefMs(m);
    if (ms == null) continue;
    const ws = isoWeekStart(ms);
    const slot = weeklyMap.get(ws);
    if (!slot) continue; // older than 12 weeks
    slot.runs += 1;
    slot.aiCredits += m.totals.aiCredits;
    slot.infraUsd += m.totals.infraUsd;
    slot.files += m.totals.files;

    const perCluster = weeklyClusterMap.get(ws)!;
    const entry = perCluster.get(m.clusterId) ?? { aiCredits: 0, infraUsd: 0, hours: 0 };
    entry.aiCredits += m.totals.aiCredits;
    entry.infraUsd += m.totals.infraUsd;
    if (m.startedAt && m.endedAt) {
      const hours = (new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 3_600_000;
      if (Number.isFinite(hours) && hours > 0) entry.hours += hours;
    }
    perCluster.set(m.clusterId, entry);
  }
  const weeklyByCluster = weekStarts.map((ws) => ({
    weekStart: ws,
    clusters: Array.from(weeklyClusterMap.get(ws)!.entries()).map(([clusterId, v]) => ({
      clusterId,
      aiCredits: v.aiCredits,
      infraUsd: v.infraUsd,
      hours: v.hours,
    })),
  }));

  // Histograms.
  const durationCounts = new Map<string, number>([["<30m", 0], ["30m-2h", 0], ["2h-8h", 0], [">8h", 0]]);
  const nodesCounts = new Map<string, number>([["1", 0], ["2-4", 0], ["5-8", 0], ["9-16", 0], ["17+", 0]]);
  let durationSumMinutes = 0;
  let durationSamples = 0;
  let nodesSum = 0;
  let nodesSamples = 0;
  for (const m of manifests) {
    if (m.startedAt && m.endedAt) {
      const minutes = (new Date(m.endedAt).getTime() - new Date(m.startedAt).getTime()) / 60_000;
      if (Number.isFinite(minutes) && minutes >= 0) {
        durationCounts.set(durationBucket(minutes), (durationCounts.get(durationBucket(minutes)) ?? 0) + 1);
        durationSumMinutes += minutes;
        durationSamples += 1;
      }
    }
    if (m.agents > 0) {
      nodesCounts.set(nodesBucket(m.agents), (nodesCounts.get(nodesBucket(m.agents)) ?? 0) + 1);
      nodesSum += m.agents;
      nodesSamples += 1;
    }
  }

  // Top runs by combined spend (credits converted at the shared overage
  // rate for ORDERING only — the response fields stay raw per contract).
  const topRuns = manifests
    .slice()
    .sort((a, b) =>
      (b.totals.aiCredits * TOP_RUNS_CREDIT_USD + b.totals.infraUsd)
      - (a.totals.aiCredits * TOP_RUNS_CREDIT_USD + a.totals.infraUsd))
    .slice(0, TOP_RUNS_LIMIT)
    .map(m => ({
      clusterId: m.clusterId,
      runId: m.runId,
      startedAt: m.startedAt,
      aiCredits: m.totals.aiCredits,
      infraUsd: m.totals.infraUsd,
    }));

  const currentWeekStart = isoWeekStart(nowMs);
  const runsThisWeek = manifests.filter(m => {
    const ms = runRefMs(m);
    return ms != null && isoWeekStart(ms) === currentWeekStart;
  }).length;

  const doc = {
    lastBuilt: new Date().toISOString(),
    stats: {
      totalRuns: manifests.length,
      runsThisWeek,
      liveClusters: running.length,
      avgNodesPerCluster: nodesSamples > 0 ? nodesSum / nodesSamples : 0,
      avgRunDurationMinutes: durationSamples > 0 ? durationSumMinutes / durationSamples : 0,
      totalAiCredits: manifests.reduce((s, m) => s + m.totals.aiCredits, 0),
      totalInfraUsd: manifests.reduce((s, m) => s + m.totals.infraUsd, 0),
      totalFiles: manifests.reduce((s, m) => s + m.totals.files, 0),
    },
    weekly: weekStarts.map(ws => weeklyMap.get(ws)!),
    weeklyByCluster,
    durationHistogram: Array.from(durationCounts.entries()).map(([bucket, count]) => ({ bucket, count })),
    nodesHistogram: Array.from(nodesCounts.entries()).map(([bucket, count]) => ({ bucket, count })),
    topRuns,
    running,
    clusters,
  };

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: "dashboard/overview.json",
    Body: JSON.stringify(doc),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));

  console.log(
    `dashboard[overview]: built in ${Date.now() - started}ms: ${manifests.length} runs, ${running.length} live clusters`,
  );
}

// ---------- Handler ------------------------------------------------------------

export async function handler(event: DashboardBuilderEvent, _context: unknown): Promise<void> {
  if (event?.target === "cluster") {
    const clusterId = event.clusterId || DEFAULT_CLUSTER_ID;
    const runId = event.runId || "current";
    await buildClusterDashboard(clusterId, runId);
    return;
  }
  // Default (and explicit "overview") — a console test invoke with no
  // payload rebuilds the fleet aggregate, which is always safe.
  await buildOverview();
}
