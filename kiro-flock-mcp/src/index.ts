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
import { AuthManager } from "./authManager.js";
import { TOOLS } from "./tools.js";

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
      case "kb_upload_file": {
        const localPath = a.local_path as string;
        const key = a.key as string | undefined;
        const uploaded = await uploader.uploadFile("knowledge-base", localPath, key);
        return { content: [{ type: "text", text: `Uploaded to knowledge-base: ${uploaded}` }] };
      }

      case "kb_upload_folder": {
        const localPath = a.local_path as string;
        const prefix = a.prefix as string | undefined;
        const results = await uploader.uploadFolder("knowledge-base", localPath, prefix);
        return {
          content: [{
            type: "text",
            text: `Uploaded ${results.length} file(s) to knowledge-base:\n${results.map((r: string) => `  ${r}`).join("\n")}`,
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
      case "env_upload_file": {
        const localPath = a.local_path as string;
        const key = a.key as string | undefined;
        const uploaded = await uploader.uploadFile("environment", localPath, key, clusterId);
        return { content: [{ type: "text", text: `Uploaded to environment: ${uploaded}` }] };
      }

      case "env_upload_folder": {
        const localPath = a.local_path as string;
        const prefix = a.prefix as string | undefined;
        const results = await uploader.uploadFolder("environment", localPath, prefix, clusterId);
        return {
          content: [{
            type: "text",
            text: `Uploaded ${results.length} file(s) to environment:\n${results.map((r: string) => `  ${r}`).join("\n")}`,
          }],
        };
      }

      case "env_list": {
        const files = await client.listEnvironment(clusterId);
        return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
      }

      case "env_read": {
        const key = a.key as string;
        const content = await client.readEnvironment(key, clusterId);
        return { content: [{ type: "text", text: content }] };
      }

      case "env_download_all": {
        // Always fetch the full environment listing (backend returns all
        // clusters regardless of the clusterId in the URL). Then filter
        // client-side when a specific cluster was requested.
        const allFiles = await client.listEnvironment(clusterId);
        const scopePrefix = clusterId ? `environment/${clusterId}/` : null;
        const files = scopePrefix
          ? allFiles.filter(f => f.key.startsWith(scopePrefix))
          : allFiles;
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
        if (isAnalysisUrlModeEnabled()) {
          const result = await client.fetchAnalysisViaUrl(clusterId);
          if (result.status === "pending") {
            const pending = { status: "pending", retryAfter: result.retryAfter };
            return { content: [{ type: "text", text: JSON.stringify(pending, null, 2) }] };
          }
          return { content: [{ type: "text", text: JSON.stringify(result.data, null, 2) }] };
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
