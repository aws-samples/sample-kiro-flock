/**
 * HTTP client for the kiro-flock cluster REST API.
 *
 * All requests are authenticated with a Cognito ID token passed as
 * Authorization: Bearer <token>.
 *
 * Multi-cluster routing
 * ---------------------
 * Every cluster-scoped endpoint uses suffix-style addressing:
 *   /cluster/{action}/{cluster_id}
 *
 * When a cluster_id is omitted, the backend defaults to `cluster_0` for
 * backwards compatibility with single-cluster deployments. This client
 * mirrors that contract: pass `clusterId` to target a specific cluster,
 * omit it to fall through to the default.
 *
 * Shared resources (knowledge-base) do not take a cluster_id.
 */

export interface ClusterConfig {
  concurrency: number;
  neighbourRadius: number;
  /** Agent compute backend: "ec2" (default, one instance per agent) or
   *  "ecs" (one Fargate ARM64 task per agent). Restart-required. */
  computeType?: "ec2" | "ecs";
  /** EC2 instance type. Only consulted when computeType is "ec2". */
  instanceType: string;
  /** Fargate task size. Only consulted when computeType is "ecs".
   *  small = 2 vCPU/4 GiB, medium = 4/8 (default), large = 8/16,
   *  xlarge = 16/32. Restart-required. */
  taskSize?: "small" | "medium" | "large" | "xlarge";
  loopIntervalSeconds: number;
  /** Model the agents run under. `null` means "use kiro-cli's default".
   *  Reloads dynamically between iterations. */
  model: string | null;
  /** Pass 7: coordination algorithm. "amorphous" (ring), "mesh" (all),
   *  "swarm" (K most recently active), or "single" (lone agent, no peers). */
  algorithm: "amorphous" | "mesh" | "swarm" | "single";
  /** Pass 7: peer count for swarm algorithm. Ignored otherwise. */
  swarmK: number;
  /** Pass 8: when true, agents append a self-reflection block to their
   *  own per-agent directive after each iteration. */
  selfOptimizing?: boolean;
  /** When true, agents get a Puppeteer MCP server for headless browser
   *  automation. */
  browserAutomation?: boolean;
  /** Per-agent model overrides, keyed by agent index as a string. Sparse:
   *  an agent with no key follows the cluster-wide `model`, while an explicit
   *  null pins it to kiro-cli's own default. Reloads dynamically. */
  models?: Record<string, string | null>;
}

/** One entry in the deployment's model catalog. `model_id` is the value that
 *  goes into config (and becomes kiro-cli's `--model`); the rest is metadata
 *  for choosing between them. */
export interface ModelCatalogEntry {
  model_id: string;
  model_name?: string;
  description?: string;
  context_window_tokens?: number;
}

export interface ModelCatalog {
  models: ModelCatalogEntry[];
  /** What kiro-cli uses when no `--model` flag is passed, i.e. what a null
   *  model resolves to. Null when the catalog doesn't record it. */
  default_model?: string | null;
}

export interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

export interface AgentStatus {
  agentId: string;
  instanceId: string | null;
  instanceState: string;
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
  metrics: Record<string, unknown> | null;
}

export interface ClusterStatus {
  state: "stopped" | "starting" | "running" | "stopping" | "paused";
  agents: AgentStatus[];
  config: ClusterConfig;
  /** Populated when the last start failed to launch instances (e.g.
   *  InsufficientInstanceCapacity or any non-throttle RunInstances error).
   *  The cluster is rolled back to "stopped" and this carries the cause so
   *  the operator can see why the launch hung. Null on a healthy cluster
   *  and cleared on the next start attempt. */
  lastError?: { code: string; message: string; at: string } | null;
  /** The reason recorded on the current state transition (e.g.
   *  "launch-failed", "manual", "autopause"). Informational. */
  stateReason?: string | null;
}

export interface HabitatFile {
  key: string;
  size: number;
  lastModified: string;
}

export interface StreamLogsResult {
  agents: {
    agentId: string;
    newEntries: AgentLogEntry[];
    latestTs: string | null;
  }[];
  asOf: string;
  clusterState: string;
}

export interface CompletionResult {
  reason: "stopped" | "idle" | "timeout";
  durationSeconds: number;
  finalStatus: ClusterStatus;
}

/**
 * Entry returned by GET /cluster/list. Shape matches the ClusterEntry
 * contract in design.md, with optional `state` populated by the backend
 * from each cluster's latest snapshot.
 */
export interface ClusterRegistryEntry {
  id: string;
  name: string;
  algorithm: "amorphous" | "mesh" | "swarm" | "single";
  createdAt: string;
  state?: "stopped" | "starting" | "running" | "stopping" | "paused";
  /** Pass 8: true if any agent in the cluster has a per-agent directive
   *  set. Surfaced for WeltenBuilder so it can show a single pill on the
   *  cluster card without an extra fetch. */
  hasAnyDirective?: boolean;
  /** How many agents in the cluster run a model other than the cluster-wide
   *  baseline (i.e. the size of the config's `models` override map). 0 or
   *  absent means the whole flock is on one model. */
  modelOverrideCount?: number;
  /** Populated when this cluster's last start failed to launch (e.g.
   *  InsufficientInstanceCapacity). The cluster reads as "stopped" but
   *  carries the failure cause. Null/absent on a healthy cluster. */
  lastError?: { code: string; message: string; at: string } | null;
}

export interface ClusterListResult {
  clusters: ClusterRegistryEntry[];
}

import type { AuthManager } from "./authManager.js";
import {
  parseAnalysisArtifact,
  type StoreReadAllResult,
} from "./analysisArtifact.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Result of fetchAnalysisViaUrl. Either the artifact is ready and parsed into
 * the same shape store_read_all returns today, or the server is still
 * building it and the caller should retry after `retryAfter` seconds.
 */
export type AnalysisFetchResult =
  | { status: "ready"; data: StoreReadAllResult }
  | { status: "pending"; retryAfter: number };

export class FlockClient {
  private baseUrl: string;
  private auth: AuthManager;

  constructor(baseUrl: string, auth: AuthManager) {
    // Strip trailing slash
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.auth = auth;
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const token = await this.auth.getToken();
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${path} → ${res.status} ${res.statusText}: ${text}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return res.json() as Promise<T>;
    }
    return res.text() as unknown as T;
  }

  /**
   * Build a cluster-scoped path. Appends /{clusterId} suffix when a cluster
   * id is provided; otherwise leaves the path plain so the backend picks up
   * its default (cluster_0). Any trailing query string on `action` is
   * preserved and placed after the suffix.
   */
  private clusterPath(action: string, clusterId?: string): string {
    if (!clusterId) return `/cluster/${action}`;
    // Split off a query string if present so the suffix lands before it.
    const qIdx = action.indexOf("?");
    if (qIdx === -1) {
      return `/cluster/${action}/${clusterId}`;
    }
    const base = action.slice(0, qIdx);
    const query = action.slice(qIdx);
    return `/cluster/${base}/${clusterId}${query}`;
  }

  // ── Cluster registry ─────────────────────────────────────────────────────

  async listClusters(): Promise<ClusterListResult> {
    return this.request<ClusterListResult>("GET", "/cluster/list");
  }

  // ── Cluster lifecycle ────────────────────────────────────────────────────

  async getStatus(clusterId?: string): Promise<ClusterStatus> {
    return this.request<ClusterStatus>("GET", this.clusterPath("status", clusterId));
  }

  async startCluster(
    configOverrides?: Record<string, unknown>,
    clusterId?: string
  ): Promise<unknown> {
    return this.request("POST", this.clusterPath("start", clusterId), configOverrides ?? {});
  }

  async stopCluster(clusterId?: string): Promise<void> {
    await this.request("POST", this.clusterPath("stop", clusterId));
  }

  async pauseCluster(clusterId?: string): Promise<void> {
    await this.request("POST", this.clusterPath("pause", clusterId));
  }

  async resumeCluster(clusterId?: string): Promise<void> {
    await this.request("POST", this.clusterPath("resume", clusterId));
  }

  async getConfig(clusterId?: string): Promise<ClusterConfig> {
    return this.request<ClusterConfig>("GET", this.clusterPath("config", clusterId));
  }

  async setConfig(
    partial: Record<string, unknown>,
    clusterId?: string
  ): Promise<ClusterConfig> {
    return this.request<ClusterConfig>("PUT", this.clusterPath("config", clusterId), partial);
  }

  /** The deployment's model catalog. Global, not per-cluster: it reflects
   *  what the agents' kiro-cli build supports, baked to
   *  `config/models.json` by install.sh. Cached 5 minutes server-side. */
  async listModels(): Promise<ModelCatalog> {
    return this.request<ModelCatalog>("GET", "/cluster/models");
  }

  // ── Direction ────────────────────────────────────────────────────────────

  async getDirection(clusterId?: string): Promise<string> {
    const res = await this.request<string | { direction: string }>(
      "GET",
      this.clusterPath("direction", clusterId)
    );
    if (typeof res === "object" && res !== null && "direction" in res) {
      return (res as { direction: string }).direction;
    }
    return res as string;
  }

  async setDirection(text: string, clusterId?: string): Promise<void> {
    await this.request("PUT", this.clusterPath("direction", clusterId), { direction: text });
  }

  // ── Environment (per-run working area) ───────────────────────────────────

  async listEnvironment(clusterId?: string): Promise<HabitatFile[]> {
    const res = await this.request<{ files: HabitatFile[] }>(
      "GET",
      this.clusterPath("habitat", clusterId)
    );
    return res.files ?? [];
  }

  async readEnvironment(key: string, clusterId?: string): Promise<string> {
    const encoded = encodeURIComponent(key);
    // habitat/file is a multi-segment action; the cluster suffix must sit
    // between the action and the query string.
    const path = this.clusterPath(`habitat/file?key=${encoded}`, clusterId);
    const res = await this.request<string | { content: string } | { body: string }>("GET", path);
    if (typeof res === "string") return res;
    if (typeof res === "object" && res !== null) {
      if ("content" in res) return (res as { content: string }).content;
      if ("body" in res) return (res as { body: string }).body;
      return JSON.stringify(res, null, 2);
    }
    return String(res);
  }

  /**
   * Permanently delete one environment folder (e.g. "environment/cluster_0/"
   * or "environment/<group>/<clusterId>/"). No history/ copy is made — the
   * backend runs a pure ListObjectsV2 + DeleteObjects sweep. Irreversible.
   */
  async deleteEnvironmentFolder(folder: string): Promise<{ deleted: number; folder: string }> {
    return this.request<{ deleted: number; folder: string }>(
      "POST",
      "/cluster/delete-env-folder",
      { folder },
    );
  }

  // ── Continuous deployment (forge) ─────────────────────────────────────────

  /**
   * Stack name/status backing a deployment group, plus the state of every
   * cluster bound to the group via everforgeGroup. `group` null targets the
   * ungrouped environment/deployed/ record.
   */
  async stackInfo(group: string | null): Promise<{
    stackName: string | null;
    stackStatus: string | null;
    clusters: { id: string; name: string; state: string }[];
    deployerRunning: boolean;
    error?: string;
  }> {
    return this.request("POST", "/forge/stack-info", { group });
  }

  /**
   * Delete the CloudFormation stack backing a deployment group. Irreversible.
   * The caller is responsible for gathering confirmation first.
   */
  async destroyStack(group: string | null): Promise<{ stackName: string; status: string }> {
    return this.request("POST", "/forge/destroy", { group });
  }

  // ── Knowledge-base (persistent, shared across all clusters) ─────────────
  //
  // Knowledge-base is a single shared resource. No cluster suffix.

  async listKnowledgeBase(): Promise<HabitatFile[]> {
    const res = await this.request<{ files: HabitatFile[] }>("GET", "/cluster/knowledge-base");
    return res.files ?? [];
  }

  async readKnowledgeBase(key: string): Promise<string> {
    const encoded = encodeURIComponent(key);
    const res = await this.request<string | { content: string } | { body: string }>("GET", `/cluster/knowledge-base/file?key=${encoded}`);
    if (typeof res === "string") return res;
    if (typeof res === "object" && res !== null) {
      if ("content" in res) return (res as { content: string }).content;
      if ("body" in res) return (res as { body: string }).body;
      return JSON.stringify(res, null, 2);
    }
    return String(res);
  }

  // ── Post-run analysis via presigned URL ──────────────────────────────────
  //
  // When FLOCK_ANALYSIS_URL_MODE is set (see index.ts), store_read_all goes
  // through this path instead of reading every agent NDJSON directly from S3.
  // The API Gateway /cluster/analysis endpoint either returns a presigned S3
  // URL (200) for a gzipped NDJSON artifact, or {status:"pending"} (202) when
  // the artifact is still being built. On "ready", this method fetches the
  // artifact directly, decompresses it, and parses it into the same shape
  // StoreReader.readAllLogs() produces today.
  //
  // Server side is not built yet. See kiro-flock/tasks.md Pass 5.
  async fetchAnalysisViaUrl(clusterId?: string): Promise<AnalysisFetchResult> {
    const token = await this.auth.getToken();
    const path = this.clusterPath("analysis", clusterId);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (res.status === 202) {
      const body = (await res.json().catch(() => ({}))) as {
        status?: string;
        retryAfter?: number;
      };
      const retryAfter =
        typeof body.retryAfter === "number" && body.retryAfter > 0
          ? body.retryAfter
          : parseRetryAfterHeader(res.headers.get("retry-after")) ?? 10;
      return { status: "pending", retryAfter };
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `GET ${path} → ${res.status} ${res.statusText}: ${text}`
      );
    }

    const body = (await res.json()) as { url?: string };
    if (!body.url) {
      throw new Error(
        `GET ${path} returned 200 but no 'url' field in the body.`
      );
    }

    // Fetch the artifact directly from S3. No Authorization header — the
    // presigned URL carries its own signature, and adding one would break it.
    const artifactRes = await fetch(body.url);
    if (!artifactRes.ok) {
      const text = await artifactRes.text().catch(() => "");
      throw new Error(
        `Fetching analysis artifact → ${artifactRes.status} ${artifactRes.statusText}: ${text}`
      );
    }

    const buf = Buffer.from(await artifactRes.arrayBuffer());
    const data = parseAnalysisArtifact(buf);
    return { status: "ready", data };
  }

  // ── Log streaming ────────────────────────────────────────────────────────

  /**
   * Fetch the latest agent log entries. If `since` is provided, only entries
   * with ts > since are returned. Returns immediately.
   */
  async streamLogs(since?: string, clusterId?: string): Promise<StreamLogsResult> {
    const status = await this.getStatus(clusterId);
    const asOf = new Date().toISOString();

    const agents = status.agents.map((agent) => {
      const entries: AgentLogEntry[] = [];
      if (agent.lastEntry) entries.push(agent.lastEntry);

      const newEntries = since
        ? entries.filter((e) => e.ts > since)
        : entries;

      return {
        agentId: agent.agentId,
        newEntries,
        latestTs: agent.lastUpdatedTs,
      };
    });

    return { agents, asOf, clusterState: status.state };
  }

  /**
   * Poll until the cluster stops, goes idle, or the timeout is reached.
   *
   * "Idle" means no agent has produced a new log entry for `idleTimeoutS` seconds.
   */
  async waitForCompletion(
    pollIntervalMs: number,
    idleTimeoutS: number,
    timeoutS: number,
    clusterId?: string
  ): Promise<CompletionResult> {
    const startTime = Date.now();
    const timeoutMs = timeoutS * 1000;
    const idleTimeoutMs = idleTimeoutS * 1000;

    let lastActivityMs = Date.now();
    let lastSeenTs: string | null = null;

    while (true) {
      const elapsed = Date.now() - startTime;
      if (elapsed >= timeoutMs) {
        const finalStatus = await this.getStatus(clusterId);
        return {
          reason: "timeout",
          durationSeconds: Math.round(elapsed / 1000),
          finalStatus,
        };
      }

      const status = await this.getStatus(clusterId);

      if (status.state === "stopped") {
        return {
          reason: "stopped",
          durationSeconds: Math.round((Date.now() - startTime) / 1000),
          finalStatus: status,
        };
      }

      // Check for new activity
      const latestTs = status.agents
        .map((a) => a.lastUpdatedTs)
        .filter((ts): ts is string => ts !== null)
        .sort()
        .at(-1) ?? null;

      if (latestTs && latestTs !== lastSeenTs) {
        lastSeenTs = latestTs;
        lastActivityMs = Date.now();
      }

      const idleMs = Date.now() - lastActivityMs;
      if (lastSeenTs !== null && idleMs >= idleTimeoutMs) {
        return {
          reason: "idle",
          durationSeconds: Math.round((Date.now() - startTime) / 1000),
          finalStatus: status,
        };
      }

      await sleep(pollIntervalMs);
    }
  }

  // ── Deployment flow (operator-side) ──────────────────────────────────────
  // Runtime approvals were removed: trust is decided at cluster config time
  // via trustDeploy. Only deployment-record browsing remains.

  async deployRecordList(
    systemname?: string,
    clusterId?: string,
  ): Promise<{ records: unknown[] }> {
    const qs = systemname ? `?systemname=${encodeURIComponent(systemname)}` : "";
    return this.request("GET", this.clusterPath(`deploy/records${qs}`, clusterId));
  }
}

/**
 * Parse a Retry-After header. Supports delta-seconds only (the HTTP-date form
 * is rare in practice and not needed for our API). Returns null if the header
 * is absent or unparseable.
 */
function parseRetryAfterHeader(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  return Number.isFinite(n) && n > 0 ? n : null;
}
