/**
 * Reads agent iteration logs from the store/ prefix in S3.
 *
 * Each agent writes an append-only NDJSON file at {clusterId}/store/agent-N.ndjson.
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
}

/** Default cluster ID matching the Lambda handler's default. */
const DEFAULT_CLUSTER_ID = "cluster_0";

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

  /**
   * Build the S3 prefix for a cluster's store.
   * Per-cluster layout: {clusterId}/store/
   * Legacy layout (cluster_0 only): store/
   */
  private storePrefix(clusterId: string): string {
    return `${clusterId}/store/`;
  }

  /** List all agent log files in the cluster's store/. */
  async listStoreLogs(clusterId?: string): Promise<AgentStoreFile[]> {
    const { s3, bucket } = this.getS3();
    const cid = clusterId || DEFAULT_CLUSTER_ID;
    const prefix = this.storePrefix(cid);

    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
    }));

    let files = (res.Contents ?? [])
      .filter(o => o.Key && o.Key.endsWith(".ndjson"))
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

    // Legacy fallback: if the cluster is cluster_0 and the per-cluster
    // prefix returned nothing, check the bare store/ prefix from before
    // the multi-cluster layout was introduced.
    if (files.length === 0 && cid === DEFAULT_CLUSTER_ID) {
      const legacyRes = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: "store/",
      }));
      files = (legacyRes.Contents ?? [])
        .filter(o => o.Key && o.Key.endsWith(".ndjson"))
        .map(o => {
          const key = o.Key!;
          const match = key.match(/agent-(\d+)\.ndjson$/);
          return {
            key,
            agentId: match ? `agent-${match[1]}` : key.replace("store/", ""),
            size: o.Size ?? 0,
            lastModified: o.LastModified?.toISOString() ?? "",
          };
        })
        .sort((a, b) => a.agentId.localeCompare(b.agentId, undefined, { numeric: true }));
    }

    return files;
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

  /** Read all agent logs and return a structured summary for analysis. */
  async readAllLogs(clusterId?: string): Promise<{
    agents: { agentId: string; entries: AgentLogEntry[] }[];
    totalIterations: number;
    totalEntries: number;
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

    return { agents, totalIterations: maxIteration, totalEntries };
  }
}
