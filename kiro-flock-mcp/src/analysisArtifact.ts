/**
 * Parse helper for the cluster-analysis artifact produced by the (future)
 * /cluster/analysis endpoint on the kiro-flock API.
 *
 * Artifact format: gzipped NDJSON. Each line is one agent log entry prefixed
 * with the agent ID. Two line shapes are accepted so the server side has some
 * flexibility when it lands:
 *
 *   1. Tab-separated prefix:
 *        agent-0\t{"ts":"...","iteration":1,"action":"...","result":"...","next_intent":"..."}
 *
 *   2. JSON object with top-level agentId:
 *        {"agentId":"agent-0","ts":"...","iteration":1,"action":"...", ...}
 *
 * Format (1) is the canonical server-side emit format. Format (2) is a
 * tolerated fallback. Malformed lines are silently skipped, matching the
 * permissive behaviour of the current direct-S3 path in StoreReader.
 */

import { gunzipSync } from "node:zlib";
import type { AgentLogEntry } from "./storeReader.js";

export interface StoreReadAllResult {
  agents: { agentId: string; entries: AgentLogEntry[] }[];
  totalIterations: number;
  totalEntries: number;
}

/**
 * Parse a gzipped NDJSON artifact buffer into the same shape that
 * StoreReader.readAllLogs() returns, so the MCP tool response stays identical
 * whether the path is direct-S3 or presigned-URL.
 */
export function parseAnalysisArtifact(gzipped: Uint8Array | Buffer): StoreReadAllResult {
  const buf = Buffer.isBuffer(gzipped) ? gzipped : Buffer.from(gzipped);
  const text = gunzipSync(buf).toString("utf-8");
  return parseAnalysisNdjson(text);
}

/**
 * Parse the decompressed NDJSON text. Exposed separately so callers that
 * already have the bytes unzipped (e.g. streaming) can reuse it.
 */
export function parseAnalysisNdjson(text: string): StoreReadAllResult {
  const byAgent = new Map<string, AgentLogEntry[]>();
  let maxIteration = 0;
  let totalEntries = 0;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parseLine(trimmed);
    if (!parsed) continue;

    const { agentId, entry } = parsed;
    let list = byAgent.get(agentId);
    if (!list) {
      list = [];
      byAgent.set(agentId, list);
    }
    list.push(entry);
    totalEntries += 1;
    if (entry.iteration > maxIteration) maxIteration = entry.iteration;
  }

  const agents = Array.from(byAgent.entries())
    .map(([agentId, entries]) => ({ agentId, entries }))
    .sort((a, b) =>
      a.agentId.localeCompare(b.agentId, undefined, { numeric: true })
    );

  return { agents, totalIterations: maxIteration, totalEntries };
}

function parseLine(
  line: string
): { agentId: string; entry: AgentLogEntry } | null {
  // Format 1: "<agentId>\t<json>"
  const tab = line.indexOf("\t");
  if (tab > 0 && line[tab + 1] === "{") {
    const agentId = line.slice(0, tab);
    const json = line.slice(tab + 1);
    const entry = safeParseEntry(json);
    if (entry) return { agentId, entry };
  }

  // Format 2: JSON object with agentId field
  if (line.startsWith("{")) {
    try {
      const obj = JSON.parse(line) as Partial<AgentLogEntry> & {
        agentId?: string;
      };
      if (typeof obj.agentId === "string") {
        const { agentId, ...rest } = obj;
        if (isAgentLogEntry(rest)) return { agentId, entry: rest };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function safeParseEntry(json: string): AgentLogEntry | null {
  try {
    const parsed = JSON.parse(json);
    return isAgentLogEntry(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isAgentLogEntry(obj: unknown): obj is AgentLogEntry {
  if (!obj || typeof obj !== "object") return false;
  const e = obj as Record<string, unknown>;
  return (
    typeof e.ts === "string" &&
    typeof e.iteration === "number" &&
    typeof e.action === "string" &&
    typeof e.result === "string" &&
    typeof e.next_intent === "string"
  );
}
