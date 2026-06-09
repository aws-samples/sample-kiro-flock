/**
 * Neighbour selection for the three coordination algorithms.
 *
 * Pure logic for amorphous and mesh. Swarm performs a single ListObjectsV2
 * to rank agents by last-modified timestamp. Kept in its own module so
 * bootstrap and the agent loop share the same selection rules.
 *
 * Multi-cluster: the swarm listing scans `{clusterId}/store/agent-*` so
 * it only ranks agents within the caller's cluster. Other clusters'
 * stores live under different prefixes and are ignored.
 */
import { S3Client, ListObjectsV2Command } from "@aws-sdk/client-s3";

export type Algorithm = "amorphous" | "mesh" | "swarm";

export interface SelectNeighboursOpts {
  algorithm: Algorithm;
  agentIndex: number;
  concurrency: number;
  neighbourRadius: number;
  swarmK: number;
  bucket: string;
  region: string;
  /** Cluster this agent belongs to. Defaults to "cluster_0" for
   *  backwards compatibility with any caller that hasn't been updated. */
  clusterId?: string;
}

/**
 * Ring-topology neighbours at radius R. Excludes self. Deterministic.
 * Pulled out of the old bootstrap.ts copy so snapshot builder + agents
 * share the same source of truth.
 */
export function amorphousNeighbours(
  agentIndex: number,
  concurrency: number,
  radius: number,
): number[] {
  if (radius <= 0 || concurrency <= 1) return [];
  const neighbours: number[] = [];
  for (let d = 1; d <= radius; d++) {
    neighbours.push((agentIndex - d + concurrency) % concurrency);
    neighbours.push((agentIndex + d) % concurrency);
  }
  return Array.from(new Set(neighbours))
    .filter((idx) => idx !== agentIndex)
    .sort((a, b) => a - b);
}

/** All agents except self. */
export function meshNeighbours(agentIndex: number, concurrency: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < concurrency; i++) {
    if (i !== agentIndex) out.push(i);
  }
  return out;
}

/**
 * K most recently active agents based on S3 LastModified of
 * {clusterId}/store/agent-N.ndjson. Ties broken by ascending index for
 * determinism. Excludes self. Returns fewer than K entries if fewer
 * logs exist.
 *
 * Edge case: iteration 0 will find zero logs (no agent has written yet).
 * Caller falls back to the amorphous ring so the first iteration has
 * something to read. The swarm only kicks in once activity exists.
 */
export async function swarmNeighbours(
  agentIndex: number,
  swarmK: number,
  bucket: string,
  region: string,
  clusterId: string,
): Promise<number[]> {
  const s3 = new S3Client({ region });
  const entries: Array<{ index: number; lastModified: Date }> = [];
  const prefix = `${clusterId}/store/agent-`;
  // Cluster IDs are constrained to /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/ by
  // the API validator, so no regex-special characters need escaping here.
  const keyPattern = new RegExp(`^${clusterId}/store/agent-(\\d+)\\.ndjson$`);
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const match = obj.Key.match(keyPattern);
      if (!match) continue;
      const idx = Number(match[1]);
      if (idx === agentIndex) continue;
      if (!obj.LastModified) continue;
      entries.push({ index: idx, lastModified: obj.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);

  entries.sort((a, b) => {
    const diff = b.lastModified.getTime() - a.lastModified.getTime();
    if (diff !== 0) return diff;
    return a.index - b.index;
  });
  return entries.slice(0, swarmK).map((e) => e.index);
}

/**
 * Top-level dispatch. Pure for amorphous + mesh; swarm hits S3 once.
 * Returns a sorted list of indexes for stable ordering in logs/prompts.
 */
export async function selectNeighbours(
  opts: SelectNeighboursOpts,
): Promise<number[]> {
  const { algorithm, agentIndex, concurrency, neighbourRadius, swarmK, bucket, region } = opts;
  const clusterId = opts.clusterId ?? "cluster_0";

  if (algorithm === "amorphous") {
    return amorphousNeighbours(agentIndex, concurrency, neighbourRadius);
  }
  if (algorithm === "mesh") {
    return meshNeighbours(agentIndex, concurrency);
  }
  if (algorithm === "swarm") {
    const picked = await swarmNeighbours(agentIndex, swarmK, bucket, region, clusterId);
    // Iteration 0 has no logs yet: fall back to amorphous ring so the
    // first turn still sees something. The swarm only kicks in once
    // activity exists.
    if (picked.length === 0) {
      return amorphousNeighbours(agentIndex, concurrency, neighbourRadius);
    }
    return picked.slice().sort((a, b) => a - b);
  }
  // Exhaustive check: TypeScript will flag any missed union member.
  const _exhaustive: never = algorithm;
  throw new Error(`unknown algorithm: ${String(_exhaustive)}`);
}
