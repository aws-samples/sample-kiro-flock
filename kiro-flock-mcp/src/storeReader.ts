/**
 * Reads agent iteration logs from the store/ prefix in S3.
 *
 * Each agent writes an append-only NDJSON file at store/agent-N.ndjson.
 * Each line is: { ts, iteration, action, result, next_intent }
 *
 * This class provides raw log access for post-run analysis of convergence,
 * divergence, and agent coordination patterns.
 */

import { S3Client, GetObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

export interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

export interface AgentStoreFile {
  key: string;
  agentId: string;
  size: number;
  lastModified: string;
  entryCount?: number;
  /** Present when the file was found in a history/ archive rather than the
   *  live store (i.e. the cluster was stopped or restarted and its logs
   *  rotated). Value is the archive run id, e.g. "2026-07-30T19-09-12". */
  archivedRun?: string;
}

export class StoreReader {
  private s3: S3Client | null = null;
  private bucket: string | null = null;

  private getS3(): { s3: S3Client; bucket: string } {
    if (this.s3 && this.bucket) {
      return { s3: this.s3, bucket: this.bucket };
    }

    const bucket = process.env.FLOCK_S3_BUCKET;
    const region = process.env.FLOCK_S3_REGION ?? "us-east-1";

    if (!bucket) {
      throw new Error("FLOCK_S3_BUCKET must be set to read agent logs.");
    }

    this.bucket = bucket;
    this.s3 = new S3Client({ region, credentials: fromNodeProviderChain() });
    return { s3: this.s3, bucket: this.bucket };
  }

  /** List all agent log files in {clusterId}/store/.
   *
   *  Falls back to the newest history/ archive when the live store is empty.
   *  cluster_stop and cluster_start both rotate `{clusterId}/store/` into
   *  `history/<ts>/{clusterId}/store/`, so without this fallback a run's
   *  iteration logs become unreadable the moment the run ends — exactly when
   *  post-run analysis wants them. Archived entries carry `archivedRun`. */
  async listStoreLogs(clusterId?: string): Promise<AgentStoreFile[]> {
    const prefix = clusterId ? `${clusterId}/store/` : "store/";
    const live = await this.listLogsUnder(prefix);
    if (live.length > 0) return live;

    const archived = await this.findNewestArchive(prefix);
    if (!archived) return [];
    return archived.files.map(f => ({ ...f, archivedRun: archived.runId }));
  }

  /** List agent .ndjson files under an arbitrary store prefix. */
  private async listLogsUnder(prefix: string): Promise<AgentStoreFile[]> {
    const { s3, bucket } = this.getS3();
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    }));

    return (res.Contents ?? [])
      .filter(o => o.Key && /agent-\d+\.ndjson$/.test(o.Key))
      .map(o => {
        const key = o.Key!;
        const match = key.match(/agent-(\d+)\.ndjson$/);
        return {
          key,
          agentId: match ? `agent-${match[1]}` : key.replace(prefix, ""),
          size: o.Size ?? 0,
          lastModified: o.LastModified?.toISOString() ?? "",
        };
      })
      .sort((a, b) => a.agentId.localeCompare(b.agentId, undefined, { numeric: true }));
  }

  /** Newest history/<runId>/ archive containing agent logs for the given
   *  store prefix. Archives preserve the full original key under the run
   *  folder, so the probe is `history/<runId>/{clusterId}/store/`. Run ids
   *  are ISO-derived timestamps, so lexicographic order is time order. */
  private async findNewestArchive(
    storePrefix: string,
  ): Promise<{ runId: string; files: AgentStoreFile[] } | null> {
    const { s3, bucket } = this.getS3();

    const runIds: string[] = [];
    let continuationToken: string | undefined;
    do {
      const res = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "history/",
        Delimiter: "/",
        ContinuationToken: continuationToken,
      }));
      for (const cp of res.CommonPrefixes ?? []) {
        const p = cp.Prefix; // "history/<runId>/"
        if (p) runIds.push(p.slice("history/".length).replace(/\/$/, ""));
      }
      continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    runIds.sort().reverse();

    // Probe newest-first. Most archives belong to other clusters or other
    // runs, so cap the probes rather than scanning the whole history.
    for (const runId of runIds.slice(0, 25)) {
      const files = await this.listLogsUnder(`history/${runId}/${storePrefix}`);
      if (files.length > 0) return { runId, files };
    }
    return null;
  }

  /** Read and parse the full NDJSON log for one agent. */
  async readAgentLog(key: string): Promise<AgentLogEntry[]> {
    const { s3, bucket } = this.getS3();
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString("utf-8");
    if (!body) return [];

    return body
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        try { return JSON.parse(line) as AgentLogEntry; }
        catch { return null; }
      })
      .filter((e): e is AgentLogEntry => e !== null);
  }

  /** Read all agent logs and return a structured summary for analysis.
   *  When the live store is empty the logs come from the newest history/
   *  archive (see listStoreLogs) and `source` names the archive run. */
  async readAllLogs(clusterId?: string): Promise<{
    agents: { agentId: string; entries: AgentLogEntry[] }[];
    totalIterations: number;
    totalEntries: number;
    source: string;
  }> {
    const files = await this.listStoreLogs(clusterId);
    const agents = await Promise.all(
      files.map(async f => ({
        agentId: f.agentId,
        entries: await this.readAgentLog(f.key),
      }))
    );

    const totalEntries = agents.reduce((sum, a) => sum + a.entries.length, 0);
    const maxIteration = agents.reduce(
      (max, a) => Math.max(max, ...a.entries.map(e => e.iteration)),
      0
    );

    const archivedRun = files.find(f => f.archivedRun)?.archivedRun;
    const source = archivedRun ? `history/${archivedRun} (archived run)` : "live";

    return { agents, totalIterations: maxIteration, totalEntries, source };
  }
}
