#!/usr/bin/env node
/**
 * kiro-flock-feed-mcp
 *
 * MCP server that lets a local Kiro agent drive a remote kiro-flock cluster:
 *   - list clusters and upload context files into per-cluster environments
 *   - upload context files into the per-run environment/ or the shared
 *     knowledge-base/
 *   - set the cluster direction
 *   - start / stop / pause / resume a cluster
 *   - stream agent iteration logs
 *   - read environment and knowledge-base files
 *
 * Multi-cluster addressing
 * ------------------------
 * Every cluster-scoped tool accepts an optional `cluster_id` argument. When
 * omitted, the backend defaults to `cluster_0` for backwards compatibility
 * with single-cluster deployments. Use `clusters_list` to discover available
 * cluster ids.
 *
 * Config via environment variables:
 *   FLOCK_API_URL          — API Gateway base URL (required)
 *   FLOCK_COGNITO_TOKEN    — Cognito ID token (required)
 *   FLOCK_POLL_INTERVAL_MS — polling interval for wait_for_completion (default 5000)
 *   FLOCK_IDLE_TIMEOUT_S   — idle seconds before wait_for_completion returns (default 120)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { FlockClient } from "./flockClient.js";
import { Uploader } from "./feeder.js";
import { StoreReader } from "./storeReader.js";
import { AcpReader } from "./acpReader.js";
import { AuthManager } from "./authManager.js";
import { TOOLS } from "./tools.js";
import * as coderSync from "./coderSync.js";
import { stateFilePath, loadState } from "./coderState.js";

// Minimal CRC-32 for ZIP file generation (STORE mode, no compression).
// Same table-based approach the web dashboard uses in envPanel.js.
const _crc32Table = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) crc = _crc32Table[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

const apiUrl = process.env.FLOCK_API_URL;
if (!apiUrl) {
  process.stderr.write("ERROR: FLOCK_API_URL must be set\n");
  process.exit(1);
}

// Auth config — needed for browser login and silent refresh.
// Falls back to env vars written by get-mcp-env.sh for backward compat.
const cognitoDomain = process.env.FLOCK_COGNITO_DOMAIN;
const clientId = process.env.FLOCK_COGNITO_CLIENT_ID;
const userPoolId = process.env.FLOCK_COGNITO_USER_POOL_ID;
const region = process.env.FLOCK_S3_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-central-1";
const awsProfile = process.env.AWS_PROFILE;

if (!cognitoDomain || !clientId || !userPoolId) {
  process.stderr.write(
    "ERROR: FLOCK_COGNITO_DOMAIN, FLOCK_COGNITO_CLIENT_ID, and FLOCK_COGNITO_USER_POOL_ID must be set.\n" +
    "Re-run setup.sh or scripts/get-mcp-env.sh to configure them.\n"
  );
  process.exit(1);
}

const auth = new AuthManager({
  cognitoDomain,
  clientId,
  userPoolId,
  region,
  awsProfile,
  initialIdToken: process.env.FLOCK_COGNITO_TOKEN,
  initialRefreshToken: process.env.FLOCK_COGNITO_REFRESH_TOKEN,
});

const client = new FlockClient(apiUrl, auth);
const uploader = new Uploader(client);
const store = new StoreReader();
const acpReader = new AcpReader();

// ── Coder sync state ─────────────────────────────────────────────────────────
let coderActiveRoot: string | null = null;

/**
 * Feature flag gate for the presigned-URL path for store_read_all.
 *
 * FLOCK_ANALYSIS_URL_MODE enables the new path when set to anything other
 * than "", "0", or "false" (case-insensitive). Default is off so existing
 * deployments keep the direct-S3 behaviour until the server-side
 * /cluster/analysis endpoint ships.
 */
function isAnalysisUrlModeEnabled(): boolean {
  const raw = process.env.FLOCK_ANALYSIS_URL_MODE;
  if (!raw) return false;
  const normalised = raw.trim().toLowerCase();
  return normalised !== "" && normalised !== "0" && normalised !== "false";
}

/**
 * Pull an optional cluster_id out of a tool args object. Returns undefined
 * when absent or not a string, which lets downstream calls fall through to
 * the backend default (cluster_0).
 */
function pickClusterId(a: Record<string, unknown>): string | undefined {
  const v = a.cluster_id;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/**
 * List environment files scoped to a single cluster.
 *
 * The backend `habitat` endpoint deliberately returns the entire
 * `environment/` tree across every cluster (the web dashboard renders a
 * unified tree). That is far too much for an MCP caller and blows the
 * context window. So when a cluster_id is supplied we resolve its env
 * prefix — honouring an everforgeGroup when configured — and filter the
 * listing down to just that cluster's files. With no cluster_id we return
 * everything, preserving the "unless cluster is not set" contract.
 */
async function listScopedEnvironment(clusterId?: string) {
  const allFiles = await client.listEnvironment(clusterId);
  if (!clusterId) return allFiles;
  const scopePrefix = await resolveEnvPrefix(clusterId);
  return allFiles.filter((f) => f.key.startsWith(scopePrefix));
}

/**
 * Resolve a cluster's environment prefix, honouring an everforgeGroup when
 * one is configured. Falls back to the ungrouped prefix if the config can't
 * be read (never-started cluster, transient error).
 */
async function resolveEnvPrefix(clusterId: string): Promise<string> {
  try {
    const cfg = await client.getConfig(clusterId);
    const group = (cfg as unknown as Record<string, unknown>).everforgeGroup as string | null;
    return group
      ? `environment/${group}/${clusterId}/`
      : `environment/${clusterId}/`;
  } catch {
    return `environment/${clusterId}/`;
  }
}

/**
 * Poll a map-reduce tab until it completes or errors. Returns the full
 * tab result. Polls every 2 seconds, gives up after 60 seconds.
 */
async function pollMapReduceTab(tabId: string): Promise<unknown> {
  const maxWaitMs = 60_000;
  const pollIntervalMs = 2_000;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
    const token = await auth.getToken();
    const res = await fetch(`${apiUrl}/cluster/analyzer-tab/${tabId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const data = (await res.json()) as { status?: string };
    if (data.status && data.status !== "processing") {
      return data;
    }
  }

  return { tabId, status: "timeout", error: "Map-reduce operation did not complete within 60 seconds. Check the analyzer tab panel in the UI." };
}

const server = new Server(
  { name: "kiro-flock-feed-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const a = (args ?? {}) as Record<string, unknown>;
  const clusterId = pickClusterId(a);

  try {
    switch (name) {
      // ── Cluster registry ───────────────────────────────────────────────
      case "clusters_list": {
        const result = await client.listClusters();
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Cluster lifecycle ──────────────────────────────────────────────
      case "cluster_status": {
        const status = await client.getStatus(clusterId);
        return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
      }

      case "cluster_start": {
        const overrides = a.config as Record<string, unknown> | undefined;
        const result = await client.startCluster(overrides, clusterId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "cluster_stop": {
        await client.stopCluster(clusterId);
        return { content: [{ type: "text", text: "Cluster stop requested. Instances are terminating." }] };
      }

      case "cluster_pause": {
        await client.pauseCluster(clusterId);
        return { content: [{ type: "text", text: "Cluster paused. Agents will stop between iterations on their next check. Call cluster_resume to continue." }] };
      }

      case "cluster_resume": {
        await client.resumeCluster(clusterId);
        return { content: [{ type: "text", text: "Cluster resumed. Agents will pick up their loop within 10 s." }] };
      }

      case "models_list": {
        const catalog = await client.listModels();
        return { content: [{ type: "text", text: JSON.stringify(catalog, null, 2) }] };
      }

      case "cluster_config_get": {
        const cfg = await client.getConfig(clusterId);
        return { content: [{ type: "text", text: JSON.stringify(cfg, null, 2) }] };
      }

      case "cluster_config_set": {
        const cfg = a.config as Record<string, unknown>;
        const updated = await client.setConfig(cfg, clusterId);
        return { content: [{ type: "text", text: JSON.stringify(updated, null, 2) }] };
      }

      // ── Direction ──────────────────────────────────────────────────────
      case "direction_get": {
        const direction = await client.getDirection(clusterId);
        return { content: [{ type: "text", text: direction }] };
      }

      case "direction_set": {
        const text = a.direction as string;
        await client.setDirection(text, clusterId);
        return { content: [{ type: "text", text: "Direction updated. Agents will pick it up on their next iteration." }] };
      }

      // ── Knowledge-base (shared across all clusters) ────────────────────
      case "kb_upload": {
        const localPath = a.local_path as string;
        const key = a.key as string | undefined;
        const result = await uploader.upload("knowledge-base", localPath, key);
        if (result.type === "file") {
          return { content: [{ type: "text", text: `Uploaded to knowledge-base: ${result.keys[0]}` }] };
        }
        return {
          content: [{
            type: "text",
            text: `Uploaded ${result.keys.length} file(s) to knowledge-base:\n${result.keys.map((r: string) => `  ${r}`).join("\n")}`,
          }],
        };
      }

      case "kb_list": {
        const files = await client.listKnowledgeBase();
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "kb_read": {
        const key = a.key as string;
        const content = await client.readKnowledgeBase(key);
        return { content: [{ type: "text", text: content }] };
      }

      // ── Environment (per-cluster, archived on cluster_start) ───────────
      case "env_upload": {
        const localPath = a.local_path as string;
        const key = a.key as string | undefined;
        const result = await uploader.upload("environment", localPath, key, clusterId);
        if (result.type === "file") {
          return { content: [{ type: "text", text: `Uploaded to environment: ${result.keys[0]}` }] };
        }
        return {
          content: [{
            type: "text",
            text: `Uploaded ${result.keys.length} file(s) to environment:\n${result.keys.map((r: string) => `  ${r}`).join("\n")}`,
          }],
        };
      }

      case "env_list": {
        const files = await listScopedEnvironment(clusterId);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "env_read": {
        const key = a.key as string;
        const content = await client.readEnvironment(key, clusterId);
        return { content: [{ type: "text", text: content }] };
      }

      case "env_delete": {
        // Explicit folder wins; otherwise resolve the target cluster's env
        // prefix (group-aware). The backend rejects the bare environment/
        // root, so a whole-environment wipe is only reachable by deleting
        // cluster folders one at a time — deliberate for an AI caller.
        let folder = (a.folder as string | undefined)?.trim();
        if (folder) {
          if (!folder.endsWith("/")) folder += "/";
          if (!folder.startsWith("environment/")) {
            throw new Error(`folder must start with "environment/" (got "${folder}")`);
          }
        } else {
          folder = await resolveEnvPrefix(clusterId ?? "cluster_0");
        }
        const result = await client.deleteEnvironmentFolder(folder);
        return {
          content: [{
            type: "text",
            text: `Permanently deleted ${result.deleted} file(s) from ${result.folder}. No history/ copy was made — this is irreversible.`,
          }],
        };
      }

      case "env_download_all": {
        // Scope the listing to the requested cluster (or everything when
        // no cluster_id is set). The backend habitat endpoint returns all
        // clusters regardless of the URL, so listScopedEnvironment filters
        // client-side.
        const files = await listScopedEnvironment(clusterId);
        if (files.length === 0) {
          return { content: [{ type: "text", text: "No environment files to download." }] };
        }
        const cid = clusterId || "all";
        const outputPath = (a.output_path as string) || `./environment-${cid}.zip`;
        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { dirname, resolve } = await import("node:path");

        // Minimal ZIP builder (STORE, no compression — same approach as
        // the web dashboard's envPanel.js). Good enough for text files.
        const entries: Array<{ name: string; data: Buffer }> = [];
        for (const f of files) {
          try {
            const text = await client.readEnvironment(f.key, clusterId);
            // Strip the "environment/" prefix so paths inside the zip
            // start at the cluster folder level.
            const zipPath = f.key.replace(/^environment\//, "");
            entries.push({ name: zipPath, data: Buffer.from(text, "utf-8") });
          } catch {
            // Skip unreadable files (binary, permissions, etc.)
          }
        }
        if (entries.length === 0) {
          return { content: [{ type: "text", text: "All files were unreadable. Nothing to zip." }] };
        }

        // Build ZIP in memory
        const parts: Buffer[] = [];
        const centralDir: Buffer[] = [];
        let offset = 0;
        for (const entry of entries) {
          const nameBytes = Buffer.from(entry.name, "utf-8");
          const crc = crc32(entry.data);
          // Local file header
          const local = Buffer.alloc(30 + nameBytes.length);
          local.writeUInt32LE(0x04034b50, 0); // signature
          local.writeUInt16LE(20, 4); // version needed
          local.writeUInt16LE(0, 6); // flags
          local.writeUInt16LE(0, 8); // compression: STORE
          local.writeUInt16LE(0, 10); // mod time
          local.writeUInt16LE(0, 12); // mod date
          local.writeUInt32LE(crc, 14);
          local.writeUInt32LE(entry.data.length, 18); // compressed
          local.writeUInt32LE(entry.data.length, 22); // uncompressed
          local.writeUInt16LE(nameBytes.length, 26);
          local.writeUInt16LE(0, 28); // extra length
          nameBytes.copy(local, 30);
          parts.push(local, entry.data);

          // Central directory entry
          const cd = Buffer.alloc(46 + nameBytes.length);
          cd.writeUInt32LE(0x02014b50, 0);
          cd.writeUInt16LE(20, 4); // version made by
          cd.writeUInt16LE(20, 6); // version needed
          cd.writeUInt16LE(0, 8); // flags
          cd.writeUInt16LE(0, 10); // compression
          cd.writeUInt16LE(0, 12); // mod time
          cd.writeUInt16LE(0, 14); // mod date
          cd.writeUInt32LE(crc, 16);
          cd.writeUInt32LE(entry.data.length, 20);
          cd.writeUInt32LE(entry.data.length, 24);
          cd.writeUInt16LE(nameBytes.length, 28);
          cd.writeUInt16LE(0, 30); // extra
          cd.writeUInt16LE(0, 32); // comment
          cd.writeUInt16LE(0, 34); // disk
          cd.writeUInt16LE(0, 36); // internal attrs
          cd.writeUInt32LE(0, 38); // external attrs
          cd.writeUInt32LE(offset, 42); // local header offset
          nameBytes.copy(cd, 46);
          centralDir.push(cd);

          offset += local.length + entry.data.length;
        }

        const cdOffset = offset;
        const cdSize = centralDir.reduce((s, b) => s + b.length, 0);
        // End of central directory
        const eocd = Buffer.alloc(22);
        eocd.writeUInt32LE(0x06054b50, 0);
        eocd.writeUInt16LE(0, 4); // disk
        eocd.writeUInt16LE(0, 6); // cd disk
        eocd.writeUInt16LE(entries.length, 8);
        eocd.writeUInt16LE(entries.length, 10);
        eocd.writeUInt32LE(cdSize, 12);
        eocd.writeUInt32LE(cdOffset, 16);
        eocd.writeUInt16LE(0, 20); // comment

        const zip = Buffer.concat([...parts, ...centralDir, eocd]);
        const absPath = resolve(outputPath);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, zip);

        return { content: [{ type: "text", text: `Downloaded ${entries.length} files to ${absPath} (${zip.length} bytes)` }] };
      }

      // ── Log streaming ──────────────────────────────────────────────────
      case "stream_logs": {
        const since = a.since as string | undefined;
        const logs = await client.streamLogs(since, clusterId);
        return { content: [{ type: "text", text: JSON.stringify(logs, null, 2) }] };
      }

      // ── ACP session streaming ────────────────────────────────────────────
      case "list_acp_sessions": {
        const agentIndex = typeof a.agent_index === "number" ? a.agent_index : 0;
        const cid = clusterId ?? "cluster_0";
        const result = await acpReader.listSessions(cid, agentIndex);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "stream_acp": {
        const agentIndex = typeof a.agent_index === "number" ? a.agent_index : 0;
        const offset = typeof a.offset === "number" ? a.offset : 0;
        const cid = clusterId ?? "cluster_0";
        const result = await acpReader.readAgentSessions(cid, agentIndex, offset);
        return { content: [{ type: "text", text: result }] };
      }

      // ── Store (post-run analysis) ────────────────────────────────────────
      case "store_list": {
        const files = await store.listStoreLogs(clusterId);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "store_read": {
        const key = a.key as string;
        const entries = await store.readAgentLog(key);
        return { content: [{ type: "text", text: JSON.stringify(entries, null, 2) }] };
      }

      case "store_read_all": {
        // Feature flag: FLOCK_ANALYSIS_URL_MODE
        //   When set (and not "0" / empty), route this call through the new
        //   /cluster/analysis endpoint which returns a presigned S3 URL for a
        //   gzipped NDJSON artifact. The MCP fetches and parses it directly,
        //   bypassing the 10 MB API Gateway response cap.
        //   When unset, fall through to the direct-S3 StoreReader path, which
        //   is the current behaviour and is unchanged.
        //   Server side lands in a later round (kiro-flock/tasks.md Pass 5).
        if (isAnalysisUrlModeEnabled()) {
          const result = await client.fetchAnalysisViaUrl(clusterId);
          if (result.status === "pending") {
            const pending = { status: "pending", retryAfter: result.retryAfter };
            return { content: [{ type: "text", text: JSON.stringify(pending, null, 2) }] };
          }
          // An empty artifact usually means the run's logs were already
          // rotated into history/ (cluster stopped or restarted). The direct
          // reader below falls back to the newest archive, so let it try
          // before returning an empty result for a run that has data.
          const data = result.data as { totalEntries?: number } | undefined;
          if (data && data.totalEntries !== 0) {
            return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
          }
        }
        const allLogs = await store.readAllLogs(clusterId);
        return { content: [{ type: "text", text: JSON.stringify(allLogs, null, 2) }] };
      }

      // ── Map-Reduce ────────────────────────────────────────────────────
      case "mapreduce_prompt": {
        const prompt = a.prompt as string;
        const token = await auth.getToken();
        const res = await fetch(`${apiUrl}/cluster/mapreduce`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ prompt }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`mapreduce → ${res.status}: ${text}`);
        }
        const { tabId } = (await res.json()) as { tabId: string };
        const result = await pollMapReduceTab(tabId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "mapreduce_exec": {
        const operation = a.operation as Record<string, unknown>;
        const token = await auth.getToken();
        const res = await fetch(`${apiUrl}/cluster/mapreduce-exec`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ operation }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(`mapreduce-exec → ${res.status}: ${text}`);
        }
        const { tabId } = (await res.json()) as { tabId: string };
        const result = await pollMapReduceTab(tabId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      // ── Deployment records (operator-side) ───────────────────────────────
      case "deploy_record_list": {
        const systemname = a.systemname as string | undefined;
        const result = await client.deployRecordList(systemname, clusterId);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }

      case "deploy_record_write": {
        const bucket = process.env.FLOCK_S3_BUCKET;
        const s3Region = process.env.FLOCK_S3_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-central-1";
        if (!bucket) {
          return { content: [{ type: "text", text: "FLOCK_S3_BUCKET not configured. Re-run setup.sh." }], isError: true };
        }

        const systemname = a.systemname as string;
        const stackName = a.stackName as string;
        const url = a.url as string;
        const changelogEntry = a.changelog_entry as string;
        const status = (a.status as string) ?? "UPDATE_COMPLETE";
        const region = (a.region as string) ?? s3Region;
        const deploymentTime = (a.deploymentTime as string) ?? undefined;
        const outputs = (a.outputs as Record<string, string>) ?? undefined;

        // Resolve everforgeGroup from cluster config
        let everforgeGroup: string | null = null;
        try {
          const config = await client.getConfig(clusterId);
          everforgeGroup = (config as unknown as Record<string, unknown>).everforgeGroup as string | null || null;
        } catch { /* no group */ }

        // Build the deployed/ prefix
        const deployedPrefix = everforgeGroup
          ? `environment/${everforgeGroup}/deployed`
          : "environment/deployed";

        const timestamp = new Date().toISOString();

        // 1. Write latest.json
        const latestJson: Record<string, unknown> = {
          stackName,
          timestamp,
          status,
          url,
          apiUrl: url,
          region,
          systemname,
          deployedBy: "local-user",
        };
        if (deploymentTime) latestJson.deploymentTime = deploymentTime;
        if (outputs) latestJson.outputs = outputs;

        const { S3Client, PutObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
        const { fromNodeProviderChain } = await import("@aws-sdk/credential-providers");
        const s3 = new S3Client({ region: s3Region, credentials: fromNodeProviderChain() });

        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${deployedPrefix}/latest.json`,
          Body: JSON.stringify(latestJson, null, 2),
          ContentType: "application/json",
        }));

        // 2. Update changelog.md (read existing, prepend new entry with [DEPLOYED] marker)
        let existingChangelog = "";
        try {
          const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${deployedPrefix}/changelog.md` }));
          existingChangelog = await resp.Body!.transformToString();
        } catch { /* file may not exist yet */ }

        // Remove previous [DEPLOYED] marker
        const cleanedChangelog = existingChangelog.replace(/\[DEPLOYED\]\s*/g, "");

        const newEntry = `## [DEPLOYED] ${timestamp} — ${systemname}\n\n${changelogEntry}\n\n- Stack: ${stackName} (${status}${deploymentTime ? `, ${deploymentTime}` : ""})\n- URL: ${url}\n- Deployed by: local-user\n`;
        const fullChangelog = newEntry + "\n" + cleanedChangelog;

        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${deployedPrefix}/changelog.md`,
          Body: fullChangelog,
          ContentType: "text/markdown",
        }));

        // 3. Write deployment-{systemname}.md record
        const outputLines = outputs
          ? Object.entries(outputs).map(([k, v]) => `  ${k}: "${v}"`)
          : [];
        const outputSection = outputs
          ? Object.entries(outputs).map(([k, v]) => `- **${k}**: ${v}`)
          : [];
        const recordBody = [
          "---",
          `systemname: ${systemname}`,
          `mode: remote`,
          `agentId: local-user`,
          `clusterId: ${clusterId ?? "local"}`,
          `deployedAt: ${timestamp}`,
          `stackName: ${stackName}`,
          ...(outputLines.length ? ["outputs:", ...outputLines] : []),
          "---",
          "",
          `# Deployment: ${systemname}`,
          "",
          `Remote deployment (CDK) by local-user.`,
          "",
          `**Stack:** ${stackName}`,
          `**Status:** ${status}`,
          `**URL:** ${url}`,
          ...(outputSection.length ? ["", "**Outputs:**", ...outputSection] : []),
          "",
        ].join("\n");

        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: `${deployedPrefix}/deployment-${systemname}.md`,
          Body: recordBody,
          ContentType: "text/markdown",
        }));

        const summary = [
          `Deployment recorded for ${systemname}:`,
          `  latest.json: ${deployedPrefix}/latest.json`,
          `  changelog:   ${deployedPrefix}/changelog.md`,
          `  record:      ${deployedPrefix}/deployment-${systemname}.md`,
          "",
          `Stack: ${stackName}`,
          `URL: ${url}`,
          `Timestamp: ${timestamp}`,
        ].join("\n");
        return { content: [{ type: "text", text: summary }] };
      }

      case "deploy_destroy": {
        const group = typeof a.group === "string" && a.group.trim() !== "" ? a.group.trim() : null;
        const confirm = typeof a.confirm === "string" ? a.confirm : null;

        // Always resolve the stack first — both steps need it, and a wrong
        // group should fail loudly before anything is deleted.
        const info = await client.stackInfo(group);
        if (!info.stackName) {
          return {
            content: [{ type: "text", text: info.error ?? "No stack found for this deployment group." }],
            isError: true,
          };
        }

        const phrase = `goodbye ${info.stackName}`;
        const runningNote = info.deployerRunning
          ? `WARNING: deployer cluster(s) for this group are still active (${info.clusters
              .filter((c) => c.state !== "stopped")
              .map((c) => `${c.name}: ${c.state}`)
              .join(", ")}). Destruction is allowed, but a running deployer may redeploy the stack afterwards.`
          : "No deployer cluster for this group is running.";

        if (confirm !== phrase) {
          const preview = {
            status: "confirmation_required",
            stackName: info.stackName,
            stackStatus: info.stackStatus,
            clusters: info.clusters,
            deployerRunning: info.deployerRunning,
            note: runningNote,
            message:
              `This will permanently delete CloudFormation stack "${info.stackName}" and all its resources. ` +
              `Deployment records under environment/ are kept as the audit trail. ` +
              `To proceed, call deploy_destroy again with confirm: "${phrase}".`,
          };
          return { content: [{ type: "text", text: JSON.stringify(preview, null, 2) }] };
        }

        const result = await client.destroyStack(group);
        const done = {
          ...result,
          note: runningNote,
          records: "Deployment records under environment/ were kept; use env_delete to remove them.",
        };
        return { content: [{ type: "text", text: JSON.stringify(done, null, 2) }] };
      }

      // ── Coder (local IDE sync) ─────────────────────────────────────────
      case "coder_attach": {
        const group = a.group as string;
        const localPath = a.path as string;
        if (!group) {
          return { content: [{ type: "text", text: "group is required" }], isError: true };
        }
        if (!localPath) {
          return { content: [{ type: "text", text: "path is required" }], isError: true };
        }
        const bucket = process.env.FLOCK_S3_BUCKET;
        const coderRegion = process.env.FLOCK_S3_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-central-1";
        const coderProfile = process.env.AWS_PROFILE || undefined;
        if (!bucket) {
          return { content: [{ type: "text", text: "FLOCK_S3_BUCKET not configured. Re-run setup.sh." }], isError: true };
        }
        const result = await coderSync.attach(bucket, coderRegion, coderProfile, group, localPath);
        coderActiveRoot = result.localPath;
        const lines = [
          `Attached to group: ${group}`,
          `Local path: ${result.localPath}`,
          `Files downloaded: ${result.fileCount}`,
          "",
          "Open this directory in your IDE to start editing.",
          "Use coder_push to upload changes, coder_pull to get remote updates.",
          "Use coder_log to tell agents what you're working on.",
        ];
        if (result.skipped.length > 0) {
          lines.push("", `Skipped ${result.skipped.length} remote key(s) whose path would leave the local folder:`, ...result.skipped.map(k => `  ! ${k}`));
        }
        if (result.fileCount <= 50) {
          lines.push("", "Files:", ...result.files.map(f => `  ${f}`));
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "coder_pull": {
        if (!coderActiveRoot) {
          return { content: [{ type: "text", text: "Not attached to any cluster. Run coder_attach first." }], isError: true };
        }
        const result = await coderSync.pull(coderActiveRoot);
        const lines: string[] = [];
        if (result.downloaded.length > 0) {
          lines.push(`Downloaded (${result.downloaded.length}):`);
          lines.push(...result.downloaded.map(f => `  ↓ ${f}`));
        }
        if (result.deleted.length > 0) {
          lines.push(`Deleted locally (${result.deleted.length}):`);
          lines.push(...result.deleted.map(f => `  ✕ ${f}`));
        }
        if (result.conflicts.length > 0) {
          lines.push(`Conflicts (${result.conflicts.length}) — skipped:`);
          lines.push(...result.conflicts.map(f => `  ⚠ ${f}`));
          lines.push("", "Resolve conflicts manually, then push or pull again.");
        }
        if (result.skipped.length > 0) {
          lines.push(`Skipped ${result.skipped.length} remote key(s) whose path would leave the local folder:`);
          lines.push(...result.skipped.map(k => `  ! ${k}`));
        }
        if (lines.length === 0) {
          lines.push(`Up to date. (${result.unchanged} files unchanged)`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "coder_push": {
        if (!coderActiveRoot) {
          return { content: [{ type: "text", text: "Not attached to any cluster. Run coder_attach first." }], isError: true };
        }
        const message = a.message as string | undefined;
        const result = await coderSync.push(coderActiveRoot, message);
        const lines: string[] = [];
        if (result.pushed.length > 0) {
          lines.push(`Pushed (${result.pushed.length}):`);
          lines.push(...result.pushed.map(f => `  ↑ ${f}`));
        }
        if (result.deleted.length > 0) {
          lines.push(`Deleted remotely (${result.deleted.length}):`);
          lines.push(...result.deleted.map(f => `  ✕ ${f}`));
        }
        if (result.conflicts.length > 0) {
          lines.push(`\nConflicts (${result.conflicts.length}) — NOT pushed:`);
          for (const c of result.conflicts) {
            lines.push(`\n  ⚠ ${c.file}`);
            lines.push(c.diff);
          }
          lines.push("\nPull first to get remote versions, then re-push.");
        }
        if (result.pushed.length === 0 && result.deleted.length === 0 && result.conflicts.length === 0) {
          lines.push("Nothing to push. Local copy matches last sync state.");
        }
        if (message && (result.pushed.length > 0 || result.deleted.length > 0)) {
          lines.push(`\nChangelog written to coder-log.md`);
        }

        // Auto-append coder-log check to directions of running clusters in this group
        if (result.pushed.length > 0 || result.deleted.length > 0) {
          const state = await loadState(coderActiveRoot);
          if (state) {
            const suffix = `Check environment/${state.group}/coder-log.md each iteration for human developer updates and incorporate them.`;
            try {
              const clusters = await client.listClusters();
              const groupClusters = (clusters as unknown as Array<{ id: string; state: string; config?: { everforgeGroup?: string } }>)
                .filter(c => c.config?.everforgeGroup === state.group && c.state === "running");
              for (const c of groupClusters) {
                const direction = await client.getDirection(c.id).catch(() => "");
                if (!direction.includes(suffix)) {
                  await client.setDirection(direction ? `${direction}\n\n${suffix}` : suffix, c.id);
                }
              }
              if (groupClusters.length > 0) {
                lines.push(`\nAppended coder-log instruction to ${groupClusters.length} running cluster(s).`);
              }
            } catch {
              // Non-fatal: direction update is best-effort
            }
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "coder_status": {
        if (!coderActiveRoot) {
          return { content: [{ type: "text", text: "Not attached to any cluster. Run coder_attach first." }], isError: true };
        }
        const result = await coderSync.status(coderActiveRoot);
        const lines: string[] = [];
        if (result.localChanges.length > 0) {
          lines.push(`Local changes (not pushed):`);
          lines.push(...result.localChanges.map(f => `  M ${f}`));
        }
        if (result.localDeleted.length > 0) {
          lines.push(`Deleted locally (not pushed):`);
          lines.push(...result.localDeleted.map(f => `  D ${f}`));
        }
        if (result.remoteChanges.length > 0) {
          lines.push(`Remote changes (not pulled):`);
          lines.push(...result.remoteChanges.map(f => `  ↓ ${f}`));
        }
        if (result.remoteDeleted.length > 0) {
          lines.push(`Deleted remotely (not pulled):`);
          lines.push(...result.remoteDeleted.map(f => `  ✕ ${f}`));
        }
        if (result.conflicts.length > 0) {
          lines.push(`Conflicts (both changed):`);
          lines.push(...result.conflicts.map(f => `  ⚠ ${f}`));
        }
        if (lines.length === 0) {
          lines.push("Clean. Local and remote are in sync.");
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      case "coder_log": {
        if (!coderActiveRoot) {
          return { content: [{ type: "text", text: "Not attached to any cluster. Run coder_attach first." }], isError: true };
        }
        const message = a.message as string;
        if (!message) {
          return { content: [{ type: "text", text: "message is required" }], isError: true };
        }
        const result = await coderSync.logMessage(coderActiveRoot, message);
        return { content: [{ type: "text", text: result }] };
      }

      case "coder_detach": {
        if (!coderActiveRoot) {
          return { content: [{ type: "text", text: "Not attached to anything." }], isError: true };
        }
        const sf = stateFilePath(coderActiveRoot);
        try { await (await import("node:fs/promises")).unlink(sf); } catch { /* already gone */ }
        const path = coderActiveRoot;
        coderActiveRoot = null;
        return { content: [{ type: "text", text: `Detached. Local files remain at ${path}` }] };
      }

      default:
        return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
