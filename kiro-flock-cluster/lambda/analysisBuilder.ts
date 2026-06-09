/**
 * Analysis builder Lambda.
 *
 * Async worker invoked by the API handler when `/cluster/analysis` needs a
 * fresh post-run artifact. Reads every `{clusterId}/store/agent-N.ndjson`
 * in full, prefixes each non-empty line with its agent ID as tab-separated
 * `<agentId>\t<line>`, streams the result through gzip, and writes it to
 * `{clusterId}/store/cluster-analysis-<timestamp>.ndjson.gz`. A small
 * pointer file `{clusterId}/store/cluster-analysis-latest.json` is updated
 * after the upload so the API handler can find the current artifact in
 * O(1) without a list-by-prefix scan.
 *
 * Event payload: `{ clusterId?: string }`. When omitted the builder falls
 * back to the default cluster id so standalone single-cluster installs
 * keep working unchanged.
 *
 * Design notes:
 *  - The canonical line format (`agentId<TAB>json`) matches what the MCP
 *    parser (`kiro-flock-feed-mcp/src/analysisArtifact.ts`) expects.
 *  - Gzip runs as a passthrough stream so the uncompressed content never
 *    has to fit in memory all at once. 1000 agents × long logs is a lot of
 *    bytes; buffering them would OOM a 1 GB Lambda.
 *  - Agent logs are read sequentially (not in parallel) to keep the gzip
 *    input deterministic and to avoid holding many response bodies open at
 *    once. The bottleneck is gzip, not S3.
 *
 * TODO(3.3): The CDK IAM policy for `AnalysisBuilderFn` currently scopes
 *   s3:GetObject to `store/...` and s3:PutObject to `store/cluster-analysis-...`
 *   and `store/cluster-analysis-latest.json`. With multi-cluster key layouts
 *   the actual keys are now `{clusterId}/store/...`, so the existing policy
 *   resource patterns do NOT match and this Lambda will fail with
 *   AccessDenied at runtime until 3.3.2 widens the policy (suggested:
 *   wildcard the cluster prefix, e.g. bucket.arnForObjects("* /store/*")
 *   for reads, and the equivalent for writes). Wave 3 owns the CDK/IAM
 *   change; this file is ready as soon as that lands.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { createGzip } from "node:zlib";
import { PassThrough } from "node:stream";
import type { Readable as NodeReadable } from "node:stream";
import { DEFAULT_CLUSTER_ID, clusterPrefix } from "./s3Store";

const BUCKET = process.env.BUCKET_NAME!;

const s3 = new S3Client({});

// ---------- Agent enumeration ------------------------------------------------

/**
 * Enumerate agent indexes by listing `{clusterId}/store/agent-*.ndjson` in
 * S3. Mirrors the pattern used by snapshotBuilder: the bucket is the source
 * of truth so we build an artifact that matches whatever logs are actually
 * on disk.
 */
async function listAgentIndexes(clusterId: string): Promise<number[]> {
  const prefix = `${clusterPrefix(clusterId)}store/agent-`;
  const keyPattern = new RegExp(`^${clusterPrefix(clusterId)}store/agent-(\\d+)\\.ndjson$`);
  const indexes = new Set<number>();
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
    }));
    for (const obj of res.Contents ?? []) {
      if (!obj.Key) continue;
      const match = obj.Key.match(keyPattern);
      if (match) indexes.add(Number(match[1]));
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return Array.from(indexes).sort((a, b) => a - b);
}

// ---------- Streaming concatenation -----------------------------------------

/**
 * Write every non-empty line of `{clusterId}/store/agent-<index>.ndjson` to
 * `out`, each prefixed with `agent-<index>\t`. Handles chunk boundaries so
 * a log line split across S3 response chunks still emits as a single
 * prefixed line.
 *
 * Returns the number of lines written and the number of uncompressed bytes
 * pushed into the stream (for observability only).
 */
async function streamAgentLog(
  clusterId: string,
  index: number,
  out: PassThrough,
): Promise<{ lines: number; bytes: number }> {
  const key = `${clusterPrefix(clusterId)}store/agent-${index}.ndjson`;
  const prefix = `agent-${index}\t`;
  const prefixBytes = Buffer.byteLength(prefix, "utf-8");

  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = res.Body as NodeReadable | undefined;
  if (!body) return { lines: 0, bytes: 0 };

  let lines = 0;
  let bytes = 0;
  let carry = "";

  for await (const chunk of body) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf-8");
    const combined = carry + text;
    const parts = combined.split("\n");
    carry = parts.pop() ?? "";
    for (const part of parts) {
      if (!part) continue;
      const line = prefix + part + "\n";
      const writeOk = out.write(line);
      lines += 1;
      bytes += prefixBytes + Buffer.byteLength(part, "utf-8") + 1;
      if (!writeOk) {
        await new Promise<void>((resolve) => out.once("drain", resolve));
      }
    }
  }

  // Emit the trailing line if the file did not end with a newline.
  if (carry) {
    const line = prefix + carry + "\n";
    const writeOk = out.write(line);
    lines += 1;
    bytes += prefixBytes + Buffer.byteLength(carry, "utf-8") + 1;
    if (!writeOk) {
      await new Promise<void>((resolve) => out.once("drain", resolve));
    }
  }

  return { lines, bytes };
}

// ---------- Handler ---------------------------------------------------------

/**
 * Format a Date as a file-system safe ISO basic timestamp, e.g.
 * `2026-05-01T15-30-00`. Mirrors the style used by the start-handler when
 * archiving a previous run.
 */
function isoBasicTimestamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

interface AnalysisBuilderEvent {
  clusterId?: string;
}

export async function handler(event: AnalysisBuilderEvent, _context: unknown): Promise<void> {
  const started = Date.now();
  // Default to cluster_0 so a legacy invoke with no payload still lands
  // somewhere sensible. Callers (the API handler) always pass clusterId
  // explicitly, but a one-off test invoke from the console shouldn't
  // silently no-op.
  const clusterId = event?.clusterId ?? DEFAULT_CLUSTER_ID;

  const agentIndexes = await listAgentIndexes(clusterId);
  const builtAt = new Date();
  const timestamp = isoBasicTimestamp(builtAt);
  const artifactKey = `${clusterPrefix(clusterId)}store/cluster-analysis-${timestamp}.ndjson.gz`;
  const latestPointerKey = `${clusterPrefix(clusterId)}store/cluster-analysis-latest.json`;

  // Set up the stream pipeline: raw NDJSON → gzip → multipart S3 upload.
  // PassThrough is the producer side; we write prefixed lines into it.
  // The gzip transform compresses on the fly. `@aws-sdk/lib-storage.Upload`
  // consumes the gzip output and pushes 5 MiB parts to S3 as it receives
  // them, so the uncompressed content never has to fit in memory at once.
  // A plain PutObject with a streaming body would buffer the whole payload
  // because the length is unknown up front.
  const raw = new PassThrough({ highWaterMark: 1 << 20 });
  const gzip = createGzip({ level: 6 });
  const gzipBody = raw.pipe(gzip);

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: artifactKey,
      Body: gzipBody,
      // Content-Type describes the bytes as a gzip payload. We intentionally
      // do NOT set Content-Encoding: gzip, because presigned-URL clients
      // (undici / Node fetch) auto-decompress responses that advertise that
      // encoding. The MCP parser calls `gunzipSync` directly on the fetched
      // bytes, so we need S3 to deliver them without transparent
      // decompression. Treating gzip as the payload format (Content-Type)
      // rather than a transport encoding keeps the round-trip predictable.
      ContentType: "application/gzip",
      CacheControl: "no-store",
    },
  });
  const uploadPromise = upload.done();

  let totalLines = 0;
  let totalBytes = 0;

  try {
    // Sequentially stream every agent log into the pipeline. Parallelising
    // would shuffle the lines and hold multiple response bodies open at
    // once with no throughput benefit; gzip is the bottleneck.
    for (const index of agentIndexes) {
      const { lines, bytes } = await streamAgentLog(clusterId, index, raw);
      totalLines += lines;
      totalBytes += bytes;
    }
    raw.end();
    await uploadPromise;
  } catch (err) {
    // Make sure the writer is closed and the upload promise is either
    // awaited or aborted so we do not leave a dangling promise or an
    // orphaned S3 multipart upload.
    raw.destroy(err instanceof Error ? err : new Error(String(err)));
    await upload.abort().catch(() => undefined);
    await uploadPromise.catch(() => undefined);
    throw err;
  }

  // Write the pointer file last so observers only ever see the pointer move
  // once the artifact is durably in place.
  const pointer = {
    key: artifactKey,
    builtAt: builtAt.toISOString(),
    agents: agentIndexes.length,
    totalBytes,
  };
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: latestPointerKey,
    Body: JSON.stringify(pointer),
    ContentType: "application/json",
    CacheControl: "no-store",
  }));

  console.log(
    `analysis[${clusterId}] built in ${Date.now() - started}ms: ${agentIndexes.length} agents, ${totalLines} lines, ${totalBytes} bytes uncompressed → ${artifactKey}`,
  );
}
