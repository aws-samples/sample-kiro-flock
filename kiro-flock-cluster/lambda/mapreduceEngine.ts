/**
 * Map-Reduce Execution Engine Lambda.
 *
 * Two addressing modes, selected by `operation.target`:
 *
 *   target: "agents" (default) — the unit of granularity is an agent.
 *     - map: write per-agent directive files to S3
 *     - map-clear: delete per-agent directive files
 *     - reduce: extract or summarize agent log data
 *
 *   target: "files" — the unit of granularity is an S3 object. READ-ONLY;
 *     map and map-clear are rejected. Scans the agents' actual work product
 *     (environment/, optionally knowledge-base/) rather than their logs.
 *     - reduce/extract: regex content scan, grouped by file/cluster/
 *       directory/extension/agent
 *     - reduce/summarize: Bedrock answers a question over the match set
 *
 * The file path deliberately separates listing from reading. ListObjectsV2 is
 * paginated and uncapped (Key/Size/LastModified for the whole corpus costs no
 * GetObject calls), while reads run through a bounded worker pool with a
 * per-file byte cap and streaming match extraction. Peak memory is therefore
 * READ_CONCURRENCY * maxBytesPerFile regardless of corpus size, so thousands
 * of files are fine.
 *
 * This Lambda performs the actual work. It does NOT interpret natural
 * language. The translation layer (mapreduceTranslator.ts) calls Bedrock
 * to convert a human prompt into the structured operation format this
 * engine expects.
 *
 * Results are persisted to the analyzer tab system at
 * store/analyzer/tab-{tabId}.json with mode "map/reduce".
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  readRegistry,
  readState,
  readConfig,
  clusterPrefix,
  envPrefix,
  type ClusterRegistry,
} from "./s3Store";

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const BUCKET = process.env.BUCKET_NAME!;
const MODEL_ID = process.env.ANALYZER_MODEL_ID ?? "eu.anthropic.claude-sonnet-4-6";

/** Max log entries per agent for reduce operations. */
const MAX_ENTRIES_PER_AGENT = 10;

// ── File-target tuning ───────────────────────────────────────────────────────

/** S3 hard maximum per ListObjectsV2 page. Listing loops on the continuation
 *  token, so the number of objects we enumerate is unbounded. */
const LIST_PAGE_SIZE = 1000;

/** Concurrent GetObject calls during a content scan. Bounds both socket
 *  pressure and peak memory. Do not fan out one read per file. */
const READ_CONCURRENCY = 64;

/** Per-file Range cap. Files larger than this are read up to the cap and
 *  flagged `truncated` in the result rather than silently half-scanned. */
const DEFAULT_MAX_BYTES_PER_FILE = 256 * 1024;

/** Lines of context returned either side of a match line. */
const DEFAULT_CONTEXT_LINES = 1;

/** Match lines returned per file. The *count* is always complete; this only
 *  caps how many are quoted back. */
const DEFAULT_MAX_MATCH_LINES = 5;

/** Individual quoted lines are clipped so one minified bundle cannot dominate
 *  the payload. */
const MAX_LINE_CHARS = 300;

/** Character budget for the match set handed to Bedrock in summarize mode.
 *  Summarize consumes the extract output, never the raw corpus, so this is
 *  far less likely to bite than a file-content budget would be. */
const SUMMARIZE_BUDGET_CHARS = 350_000;

/** Basenames shorter than this are too ambiguous to attribute an agent by. */
const MIN_BASENAME_FOR_ATTRIBUTION = 4;

/** Extensions never worth a GetObject during a text/content scan. Filtered
 *  from LIST metadata, so skipping them costs nothing. */
const BINARY_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "webp", "svgz", "tif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "wav", "ogg", "webm", "mov", "avi", "mkv",
  "wasm", "so", "dylib", "dll", "exe", "bin", "class", "pyc", "o", "a",
  "db", "sqlite", "parquet", "avro", "lock",
]);

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentFilter {
  clusters?: string[];
  agentIndexes?: number[];
  actionRegex?: string;
  iterationGte?: number;
  iterationLte?: number;
  /** Target only agents that have produced at least one log entry. */
  active?: boolean;
  /** Target ALL agents by config concurrency (0 through concurrency-1),
   *  including those that haven't produced output yet (e.g. rate-limited). */
  all?: boolean;
}

export interface ExtractQuery {
  groupBy?: "agentId" | "clusterId" | "action" | "nextIntent";
  select?: string[];
  where?: {
    actionRegex?: string;
    iterationGte?: number;
    iterationLte?: number;
  };
}

/** What the operation addresses. Defaults to "agents" so every pre-existing
 *  operation keeps working unchanged. */
export type MapReduceTarget = "agents" | "files";

/** Targeting filter for the file scan. All fields optional, AND composed.
 *  Everything except `contentRegex` is satisfiable from ListObjectsV2
 *  metadata alone, so a filter without it performs zero object reads. */
export interface FileFilter {
  /** Restrict to these clusters' environment subfolders. Omit to scan the
   *  whole shared environment/ root (all clusters, grouped and ungrouped). */
  clusters?: string[];
  /** Top-level prefixes to scan. Defaults to ["environment"]. */
  scope?: ("environment" | "knowledge-base")[];
  /** Glob over the object key. Supports **, *, ?, and {a,b} braces. Matched
   *  against both the full key and the key relative to the scope prefix. */
  pathGlob?: string;
  /** Regex matched against file content (case-insensitive). The only field
   *  that triggers GetObject calls. */
  contentRegex?: string;
  /** ISO-8601. Keep only objects modified strictly after this instant. */
  modifiedAfter?: string;
  /** Per-file read cap in bytes. Default 256KB. */
  maxBytesPerFile?: number;
}

/** Output shaping for a file reduce. */
export interface FileQuery {
  /** How to group matched files. "agent" additionally correlates each file
   *  back to the agent whose log references it (best effort, see
   *  correlateFilesToAgents). */
  groupBy?: "file" | "cluster" | "directory" | "extension" | "agent";
  /** Lines of context either side of each quoted match line. Default 1. */
  contextLines?: number;
  /** Match lines quoted per file. Counts are always complete. Default 5. */
  maxMatchLines?: number;
}

export interface MapReduceOperation {
  /** "agents" (default) or "files". Files are read-only. */
  target?: MapReduceTarget;
  type: "map" | "map-clear" | "reduce";
  /** Agent targeting. Required for target "agents", ignored for "files"
   *  except that `clusters` is inherited when fileFilter omits it. */
  filter?: AgentFilter;
  /** File targeting. Used only when target is "files". */
  fileFilter?: FileFilter;
  /** Output shaping for a file reduce. Used only when target is "files". */
  fileQuery?: FileQuery;
  /** For map: the directive text. */
  directive?: string;
  /** For reduce: extract or summarize. */
  mode?: "extract" | "summarize";
  /** For reduce/summarize: the question to answer. */
  question?: string;
  /** For reduce/extract: structured query. */
  query?: ExtractQuery;
}

export interface MapReduceEvent {
  tabId: string;
  operation: MapReduceOperation;
  /** Original natural language prompt (if came through translation layer). */
  originalPrompt?: string;
}

export interface MapReduceResult {
  tabId: string;
  mode: "map/reduce";
  status: "complete" | "error";
  createdAt: string;
  operation: MapReduceOperation;
  /** Echoed so the operator can see which addressing mode the translator
   *  resolved to, and spot a misroute without reading the operation JSON. */
  target: MapReduceTarget;
  originalPrompt?: string;
  result?: {
    agentsTargeted: number;
    clustersTargeted: string[];
    data: unknown;
  };
  error?: string;
}

// ── Agent resolution ─────────────────────────────────────────────────────────

interface ResolvedAgent {
  clusterId: string;
  agentIndex: number;
}

interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

/**
 * Resolve a filter into a concrete list of (clusterId, agentIndex) pairs.
 * Reads the cluster registry and per-cluster snapshots to determine which
 * agents exist and match the filter criteria.
 */
async function resolveFilter(filter: AgentFilter): Promise<ResolvedAgent[]> {
  const registry = await readRegistry(BUCKET);

  // Determine which clusters to scan
  let targetClusters: string[];
  if (filter.clusters && filter.clusters.length > 0) {
    targetClusters = filter.clusters;
  } else {
    // All running/starting/paused clusters
    const states = await Promise.all(
      registry.clusters.map(async (c) => ({
        id: c.id,
        state: (await readState(BUCKET, c.id)).doc.state,
      })),
    );
    targetClusters = states
      .filter((s) => s.state !== "stopped")
      .map((s) => s.id);
  }

  const agents: ResolvedAgent[] = [];

  // When `all: true`, enumerate agents from config concurrency (includes
  // rate-limited agents that haven't written a log entry yet).
  // When `active: true` (or neither flag), discover from log files only.
  const useConfigEnumeration = filter.all === true;

  await Promise.all(
    targetClusters.map(async (clusterId) => {
      if (useConfigEnumeration) {
        // Read config.json to get concurrency, enumerate 0..concurrency-1
        try {
          const configResp = await s3.send(
            new GetObjectCommand({ Bucket: BUCKET, Key: `${clusterPrefix(clusterId)}config.json` }),
          );
          const configText = (await configResp.Body?.transformToString()) ?? "";
          const config = JSON.parse(configText) as { concurrency?: number };
          const concurrency = config.concurrency ?? 0;
          for (let i = 0; i < concurrency; i++) {
            if (
              filter.agentIndexes &&
              filter.agentIndexes.length > 0 &&
              !filter.agentIndexes.includes(i)
            ) {
              continue;
            }
            agents.push({ clusterId, agentIndex: i });
          }
        } catch {
          // If config can't be read, fall back to log-file discovery
          await discoverFromLogs(clusterId, filter, agents);
        }
      } else {
        await discoverFromLogs(clusterId, filter, agents);
      }
    }),
  );

  // If action/iteration filters are specified, we need to read last entries
  if (filter.actionRegex || filter.iterationGte !== undefined || filter.iterationLte !== undefined) {
    const filtered: ResolvedAgent[] = [];
    const actionRe = filter.actionRegex ? new RegExp(filter.actionRegex, "i") : null;

    await Promise.all(
      agents.map(async (agent) => {
        const entry = await readLastLogEntry(agent.clusterId, agent.agentIndex);
        if (!entry) return;

        if (actionRe && !actionRe.test(entry.action)) return;
        if (filter.iterationGte !== undefined && entry.iteration < filter.iterationGte) return;
        if (filter.iterationLte !== undefined && entry.iteration > filter.iterationLte) return;

        filtered.push(agent);
      }),
    );

    return filtered.sort((a, b) =>
      a.clusterId === b.clusterId
        ? a.agentIndex - b.agentIndex
        : a.clusterId.localeCompare(b.clusterId),
    );
  }

  return agents.sort((a, b) =>
    a.clusterId === b.clusterId
      ? a.agentIndex - b.agentIndex
      : a.clusterId.localeCompare(b.clusterId),
  );
}

/** Discover agents from their log files in S3 (original behavior). */
async function discoverFromLogs(
  clusterId: string,
  filter: AgentFilter,
  agents: ResolvedAgent[],
): Promise<void> {
  const prefix = `${clusterPrefix(clusterId)}store/agent-`;
  const pattern = new RegExp(
    `^${clusterPrefix(clusterId)}store/agent-(\\d+)\\.ndjson$`,
  );

  const listed = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }),
  );

  for (const obj of listed.Contents ?? []) {
    if (!obj.Key) continue;
    const match = obj.Key.match(pattern);
    if (!match) continue;
    const index = Number(match[1]);

    if (
      filter.agentIndexes &&
      filter.agentIndexes.length > 0 &&
      !filter.agentIndexes.includes(index)
    ) {
      continue;
    }

    agents.push({ clusterId, agentIndex: index });
  }
}

// ── S3 helpers ───────────────────────────────────────────────────────────────

/** Directive file key for a specific agent. */
function directiveKey(clusterId: string, agentIndex: number): string {
  return `${clusterPrefix(clusterId)}store/agent-${agentIndex}.directive.md`;
}

/** Read a per-agent directive. Returns null when no directive has been
 *  issued, or when the read fails for any reason — directives are
 *  optional context for reduce, never a blocker. */
async function readDirective(
  clusterId: string,
  agentIndex: number,
): Promise<string | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: BUCKET,
      Key: directiveKey(clusterId, agentIndex),
    }));
    const body = (await resp.Body?.transformToString()) ?? "";
    return body || null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    return null;
  }
}

/** Read the last log entry for an agent (tail of NDJSON). */
async function readLastLogEntry(
  clusterId: string,
  agentIndex: number,
): Promise<AgentLogEntry | null> {
  const key = `${clusterPrefix(clusterId)}store/agent-${agentIndex}.ndjson`;
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: BUCKET, Key: key, Range: "bytes=-4096" }),
    );
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) return null;

    const contentRange = res.ContentRange ?? "";
    const startsAtZero = /^bytes 0-/.test(contentRange);
    const lines = body.split("\n");
    if (!startsAtZero && lines.length > 1) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        return JSON.parse(line) as AgentLogEntry;
      } catch {
        continue;
      }
    }
    return null;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "InvalidRange") return null;
    throw err;
  }
}

/** Read the last N log entries for an agent. */
async function readAgentLogTail(
  clusterId: string,
  agentIndex: number,
  maxEntries: number,
): Promise<AgentLogEntry[]> {
  const key = `${clusterPrefix(clusterId)}store/agent-${agentIndex}.ndjson`;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) return [];

    const lines = body.split("\n").filter((l) => l.trim());
    const tail = lines.slice(-maxEntries);
    return tail
      .map((l) => {
        try {
          return JSON.parse(l) as AgentLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AgentLogEntry => e !== null);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return [];
    throw err;
  }
}

/** Read an agent's complete log. Used only by file→agent correlation, which
 *  needs every entry ever written (a file may have been authored 40
 *  iterations ago), unlike reduce which works off a tail. */
async function readAgentLogFull(
  clusterId: string,
  agentIndex: number,
): Promise<AgentLogEntry[]> {
  const key = `${clusterPrefix(clusterId)}store/agent-${agentIndex}.ndjson`;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) return [];
    return body
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as AgentLogEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is AgentLogEntry => e !== null);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return [];
    return [];
  }
}

// ── File target: listing ─────────────────────────────────────────────────────

interface S3ObjectMeta {
  key: string;
  size: number;
  lastModified: string | null;
  /** Cluster this object belongs to, when it can be derived from the key. */
  clusterId: string | null;
  /** Which scope prefix the object was found under. */
  scope: "environment" | "knowledge-base";
}

/**
 * Translate a glob into an anchored RegExp.
 *
 * Supported: `**` (any depth, `**\/` also matches zero directories), `*`
 * (within one path segment), `?` (one non-separator char), and `{a,b,c}`
 * alternation. Everything else is escaped literally.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // `**/` spans zero or more directories.
          re += "(?:[^/]*/)*";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i += 1;
      continue;
    }
    if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) {
        re += "\\{";
        i += 1;
        continue;
      }
      const opts = glob
        .slice(i + 1, end)
        .split(",")
        .map((o) => o.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      re += `(?:${opts.join("|")})`;
      i = end + 1;
      continue;
    }
    if (".+^$()|[]\\".includes(c)) {
      re += `\\${c}`;
      i += 1;
      continue;
    }
    re += c;
    i += 1;
  }
  return new RegExp(`^${re}$`);
}

function extensionOf(key: string): string {
  const base = key.slice(key.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Paginated, uncapped listing. Loops the continuation token to the end of
 *  the prefix. Directory placeholder keys are dropped. */
async function listAllObjects(
  prefix: string,
  scope: "environment" | "knowledge-base",
): Promise<S3ObjectMeta[]> {
  const out: S3ObjectMeta[] = [];
  let token: string | undefined;
  do {
    const resp = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        MaxKeys: LIST_PAGE_SIZE,
        ContinuationToken: token,
      }),
    );
    for (const o of resp.Contents ?? []) {
      if (!o.Key || o.Key.endsWith("/")) continue;
      out.push({
        key: o.Key,
        size: o.Size ?? 0,
        lastModified: o.LastModified?.toISOString() ?? null,
        clusterId: null,
        scope,
      });
    }
    token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/**
 * Derive the owning cluster from an environment key.
 *
 * Both layouts coexist in one bucket (`environment/<cluster>/...` and
 * `environment/<group>/<cluster>/...`), so rather than guessing by depth we
 * match path segments against the registered cluster ids. Returns null for
 * keys that belong to no cluster (e.g. `environment/deployed/`).
 */
function deriveClusterId(key: string, knownClusters: Set<string>): string | null {
  if (!key.startsWith("environment/")) return null;
  const segments = key.slice("environment/".length).split("/");
  for (let i = 0; i < Math.min(2, segments.length); i++) {
    if (knownClusters.has(segments[i])) return segments[i];
  }
  return null;
}

/** Resolve a FileFilter into the candidate object set, using LIST metadata
 *  only. No object bodies are read here. */
async function resolveFiles(
  filter: FileFilter,
): Promise<{ candidates: S3ObjectMeta[]; listed: number; scopes: string[] }> {
  const registry = await readRegistry(BUCKET);
  const knownClusters = new Set(registry.clusters.map((c) => c.id));

  const scopes = filter.scope && filter.scope.length > 0 ? filter.scope : ["environment"];

  // Build the prefixes to enumerate.
  const prefixes: Array<{ prefix: string; scope: "environment" | "knowledge-base" }> = [];
  if (scopes.includes("environment")) {
    if (filter.clusters && filter.clusters.length > 0) {
      // Per-cluster prefixes need the deployment group to land in the right
      // place. A missing/unreadable config just means the ungrouped layout.
      const resolved = await Promise.all(
        filter.clusters.map(async (clusterId) => {
          let group: string | null = null;
          try {
            const cfg = await readConfig(BUCKET, clusterId);
            group = (cfg as unknown as Record<string, unknown>).everforgeGroup as string | null ?? null;
          } catch { /* ungrouped */ }
          return envPrefix(clusterId, group);
        }),
      );
      for (const prefix of resolved) prefixes.push({ prefix, scope: "environment" });
    } else {
      prefixes.push({ prefix: "environment/", scope: "environment" });
    }
  }
  if (scopes.includes("knowledge-base")) {
    // The knowledge-base is global and shared, so cluster scoping never
    // applies to it.
    prefixes.push({ prefix: "knowledge-base/", scope: "knowledge-base" });
  }

  const pages = await Promise.all(prefixes.map((p) => listAllObjects(p.prefix, p.scope)));

  // Dedupe: overlapping prefixes (e.g. two clusters in the same group) can
  // surface the same key twice.
  const byKey = new Map<string, S3ObjectMeta>();
  for (const page of pages) {
    for (const obj of page) {
      if (!byKey.has(obj.key)) byKey.set(obj.key, obj);
    }
  }
  const listed = byKey.size;

  const globRe = filter.pathGlob ? globToRegExp(filter.pathGlob) : null;
  const modifiedAfter = filter.modifiedAfter ? Date.parse(filter.modifiedAfter) : NaN;

  const candidates: S3ObjectMeta[] = [];
  for (const obj of byKey.values()) {
    if (obj.size === 0) continue;
    if (BINARY_EXTENSIONS.has(extensionOf(obj.key))) continue;

    if (!Number.isNaN(modifiedAfter)) {
      if (!obj.lastModified || Date.parse(obj.lastModified) <= modifiedAfter) continue;
    }

    if (globRe) {
      // Match the full key or the key relative to its scope prefix, so both
      // `**/*.ts` and `final/**` behave the way an operator expects.
      const scopeRoot = obj.scope === "environment" ? "environment/" : "knowledge-base/";
      const relative = obj.key.startsWith(scopeRoot) ? obj.key.slice(scopeRoot.length) : obj.key;
      if (!globRe.test(obj.key) && !globRe.test(relative)) continue;
    }

    obj.clusterId = deriveClusterId(obj.key, knownClusters);
    candidates.push(obj);
  }

  candidates.sort((a, b) => a.key.localeCompare(b.key));
  return { candidates, listed, scopes };
}

// ── File target: content scan ────────────────────────────────────────────────

interface MatchLine {
  n: number;
  text: string;
  /** Context lines above/below, when contextLines > 0. */
  before?: string[];
  after?: string[];
}

interface FileMatch {
  key: string;
  size: number;
  lastModified: string | null;
  clusterId: string | null;
  scope: string;
  /** Total match occurrences in the scanned region. Always complete. */
  matches: number;
  /** Number of distinct lines that matched. */
  matchLines: number;
  /** Quoted subset of match lines, capped by maxMatchLines. */
  lines: MatchLine[];
  /** True when the file exceeded maxBytesPerFile and was only partly scanned. */
  truncated: boolean;
}

/** Bounded-concurrency map. Keeps at most `limit` promises in flight so a
 *  10,000-file scan does not open 10,000 sockets. */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

function clipLine(text: string): string {
  const trimmed = text.replace(/\r$/, "");
  return trimmed.length > MAX_LINE_CHARS
    ? `${trimmed.slice(0, MAX_LINE_CHARS - 1)}\u2026`
    : trimmed;
}

/**
 * Read one object (Range-capped) and extract regex matches. The body is
 * discarded before returning, so only matches accumulate across the scan.
 */
async function scanObject(
  obj: S3ObjectMeta,
  contentRe: RegExp,
  maxBytes: number,
  contextLines: number,
  maxMatchLines: number,
): Promise<FileMatch | null> {
  let body: string;
  const truncated = obj.size > maxBytes;
  try {
    const res = await s3.send(
      new GetObjectCommand({
        Bucket: BUCKET,
        Key: obj.key,
        ...(truncated ? { Range: `bytes=0-${maxBytes - 1}` } : {}),
      }),
    );
    body = (await res.Body?.transformToString()) ?? "";
  } catch {
    // A file that vanished mid-scan or is unreadable is not a scan failure.
    return null;
  }
  if (!body) return null;

  // Cheap reject before splitting: no match anywhere, no work to do.
  if (!contentRe.test(body)) return null;

  const lines = body.split("\n");
  const globalRe = new RegExp(contentRe.source, "gi");
  const quoted: MatchLine[] = [];
  let occurrences = 0;
  let matchLineCount = 0;

  for (let i = 0; i < lines.length; i++) {
    globalRe.lastIndex = 0;
    const found = lines[i].match(globalRe);
    if (!found) continue;
    occurrences += found.length;
    matchLineCount++;
    if (quoted.length < maxMatchLines) {
      const entry: MatchLine = { n: i + 1, text: clipLine(lines[i]) };
      if (contextLines > 0) {
        const before = lines.slice(Math.max(0, i - contextLines), i).map(clipLine);
        const after = lines.slice(i + 1, i + 1 + contextLines).map(clipLine);
        if (before.length > 0) entry.before = before;
        if (after.length > 0) entry.after = after;
      }
      quoted.push(entry);
    }
  }

  if (occurrences === 0) return null;

  return {
    key: obj.key,
    size: obj.size,
    lastModified: obj.lastModified,
    clusterId: obj.clusterId,
    scope: obj.scope,
    matches: occurrences,
    matchLines: matchLineCount,
    lines: quoted,
    truncated,
  };
}

// ── File target: agent correlation ───────────────────────────────────────────

interface Attribution {
  agentId: string;
  clusterId: string;
  iteration: number | null;
  /** Which signal produced the attribution. */
  via: string;
  confidence: "high" | "low";
}

/**
 * Best-effort join from matched files back to the agents that authored them.
 *
 * `environment/` is a shared prefix: every agent in a cluster writes into it
 * and the agent index appears nowhere in the path. The only available join key
 * is the free-form `action`/`result` prose in each agent's NDJSON log, where
 * agents typically name the files they touched.
 *
 * A path mention is treated as high confidence; a bare basename mention as
 * low, since names like `index.ts` recur across agents. Files that no log
 * references at all are returned unattributed rather than dropped, because
 * silently discarding them would misrepresent scan coverage.
 */
async function correlateFilesToAgents(
  matches: FileMatch[],
  clusterIds: string[],
): Promise<Map<string, Attribution[]>> {
  // Discover agents per cluster, then load their full logs once. Uses the
  // paginated lister rather than discoverFromLogs, which reads a single
  // ListObjectsV2 page.
  const perCluster = await Promise.all(
    clusterIds.map(async (clusterId) => {
      const logPattern = new RegExp(`^${clusterPrefix(clusterId)}store/agent-(\\d+)\\.ndjson$`);
      const objects = await listAllObjects(`${clusterPrefix(clusterId)}store/agent-`, "environment");
      const indexes = objects
        .map((o) => o.key.match(logPattern))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => Number(m[1]));

      return Promise.all(
        indexes.map(async (agentIndex) => ({
          agentId: `${clusterId}/agent-${agentIndex}`,
          clusterId,
          entries: await readAgentLogFull(clusterId, agentIndex),
        })),
      );
    }),
  );
  const agentLogs = perCluster.flat();

  const attribution = new Map<string, Attribution[]>();

  for (const match of matches) {
    // Agents refer to their own files in several forms. They most often use
    // the path relative to their own environment folder ("src/poller.ts"),
    // because that is what they see as their working directory, so try
    // progressively shorter path forms and keep the longest that hits.
    const withoutScope = match.key.replace(/^(?:environment|knowledge-base)\//, "");
    const pathNeedles = [match.key, withoutScope];
    if (match.clusterId) {
      // Also strips any deployment group segment, since the cluster id is the
      // last prefix segment before the agent's own working paths.
      const marker = `${match.clusterId}/`;
      const at = withoutScope.indexOf(marker);
      if (at !== -1) pathNeedles.push(withoutScope.slice(at + marker.length));
    }
    const needles = [...new Set(pathNeedles)]
      .filter((n) => n.includes("/"))
      .sort((a, b) => b.length - a.length)
      .map((n) => n.toLowerCase());

    const basename = match.key.slice(match.key.lastIndexOf("/") + 1);
    const basenameNeedle = basename.toLowerCase();
    const hits: Attribution[] = [];

    for (const agent of agentLogs) {
      // A file under environment/<clusterA>/ was not written by an agent in
      // clusterB, so skip cross-cluster candidates when we know the cluster.
      if (match.clusterId && agent.clusterId !== match.clusterId) continue;

      let best: Attribution | null = null;
      for (const entry of agent.entries) {
        const haystack = `${entry.action}\n${entry.result}\n${entry.next_intent}`.toLowerCase();

        const pathHit = needles.find((n) => haystack.includes(n));
        if (pathHit) {
          best = {
            agentId: agent.agentId,
            clusterId: agent.clusterId,
            iteration: entry.iteration ?? null,
            via: `log references path "${pathHit}" at iteration ${entry.iteration}`,
            confidence: "high",
          };
          break; // a path match is as good as it gets
        }

        // Basename-only is kept but flagged low: names like "index.ts" recur
        // across agents, so this can over-attribute.
        if (
          !best &&
          basename.length >= MIN_BASENAME_FOR_ATTRIBUTION &&
          haystack.includes(basenameNeedle)
        ) {
          best = {
            agentId: agent.agentId,
            clusterId: agent.clusterId,
            iteration: entry.iteration ?? null,
            via: `log mentions "${basename}" at iteration ${entry.iteration}`,
            confidence: "low",
          };
        }
      }
      if (best) hits.push(best);
    }

    attribution.set(match.key, hits);
  }

  return attribution;
}

// ── Directive preamble ───────────────────────────────────────────────────────

const DIRECTIVE_PREAMBLE = `> **Per-agent directive** — This directive was issued to you specifically by the operator.
> It takes precedence over the cluster direction where they conflict.
> Follow both where they are compatible. If in doubt, prioritise this directive.

---

`;

// ── Operation handlers ───────────────────────────────────────────────────────

async function executeMap(
  filter: AgentFilter,
  directive: string,
): Promise<{ agentsTargeted: number; clustersTargeted: string[]; data: unknown }> {
  const agents = await resolveFilter(filter);
  const fullDirective = DIRECTIVE_PREAMBLE + directive;

  await Promise.all(
    agents.map((agent) =>
      s3.send(
        new PutObjectCommand({
          Bucket: BUCKET,
          Key: directiveKey(agent.clusterId, agent.agentIndex),
          Body: fullDirective,
          ContentType: "text/markdown",
          CacheControl: "no-store",
        }),
      ),
    ),
  );

  const clusters = [...new Set(agents.map((a) => a.clusterId))];
  return {
    agentsTargeted: agents.length,
    clustersTargeted: clusters,
    data: {
      action: "directives-written",
      agents: agents.map((a) => `${a.clusterId}/agent-${a.agentIndex}`),
      directivePreview: directive.slice(0, 200),
    },
  };
}

async function executeMapClear(
  filter: AgentFilter,
): Promise<{ agentsTargeted: number; clustersTargeted: string[]; data: unknown }> {
  const agents = await resolveFilter(filter);

  await Promise.all(
    agents.map((agent) =>
      s3
        .send(
          new DeleteObjectCommand({
            Bucket: BUCKET,
            Key: directiveKey(agent.clusterId, agent.agentIndex),
          }),
        )
        .catch(() => undefined), // ignore if already gone
    ),
  );

  const clusters = [...new Set(agents.map((a) => a.clusterId))];
  return {
    agentsTargeted: agents.length,
    clustersTargeted: clusters,
    data: {
      action: "directives-cleared",
      agents: agents.map((a) => `${a.clusterId}/agent-${a.agentIndex}`),
    },
  };
}

async function executeReduceExtract(
  filter: AgentFilter,
  query?: ExtractQuery,
): Promise<{ agentsTargeted: number; clustersTargeted: string[]; data: unknown }> {
  const agents = await resolveFilter(filter);

  // Read log tails AND directives for all matched agents in parallel.
  // Directives are visible to reduce so questions like "show me all
  // individual directions" can be answered without a separate API call.
  const agentLogs = await Promise.all(
    agents.map(async (agent) => {
      const [entries, directive] = await Promise.all([
        readAgentLogTail(agent.clusterId, agent.agentIndex, MAX_ENTRIES_PER_AGENT),
        readDirective(agent.clusterId, agent.agentIndex),
      ]);
      return {
        agentId: `${agent.clusterId}/agent-${agent.agentIndex}`,
        clusterId: agent.clusterId,
        entries,
        directive,
      };
    }),
  );

  // Apply where clause if present
  let filteredLogs = agentLogs;
  if (query?.where) {
    const whereActionRe = query.where.actionRegex
      ? new RegExp(query.where.actionRegex, "i")
      : null;

    filteredLogs = agentLogs.map((al) => ({
      ...al,
      entries: al.entries.filter((e) => {
        if (whereActionRe && !whereActionRe.test(e.action)) return false;
        if (query.where!.iterationGte !== undefined && e.iteration < query.where!.iterationGte) return false;
        if (query.where!.iterationLte !== undefined && e.iteration > query.where!.iterationLte) return false;
        return true;
      }),
    }));
  }

  // Apply groupBy if present
  let data: unknown;
  if (query?.groupBy) {
    const groups: Record<string, unknown[]> = {};
    for (const al of filteredLogs) {
      for (const entry of al.entries) {
        let groupKey: string;
        switch (query.groupBy) {
          case "agentId":
            groupKey = al.agentId;
            break;
          case "clusterId":
            groupKey = al.clusterId;
            break;
          case "action":
            groupKey = entry.action;
            break;
          case "nextIntent":
            groupKey = entry.next_intent;
            break;
          default:
            groupKey = "ungrouped";
        }
        if (!groups[groupKey]) groups[groupKey] = [];

        // Select specific fields if requested
        if (query.select && query.select.length > 0) {
          const selected: Record<string, unknown> = {};
          for (const field of query.select) {
            if (field === "agentId") selected.agentId = al.agentId;
            else if (field === "clusterId") selected.clusterId = al.clusterId;
            else if (field === "directive") selected.directive = al.directive;
            else if (field in entry) selected[field] = (entry as unknown as Record<string, unknown>)[field];
          }
          groups[groupKey].push(selected);
        } else {
          groups[groupKey].push({ agentId: al.agentId, directive: al.directive, ...entry });
        }
      }
    }
    data = { groupBy: query.groupBy, groups };
  } else {
    // Flat list — directive included alongside entries so
    // "show me all individual directions" returns useful data even when
    // an agent has no log entries yet.
    data = {
      agents: filteredLogs.map((al) => ({
        agentId: al.agentId,
        clusterId: al.clusterId,
        directive: al.directive,
        entryCount: al.entries.length,
        entries: al.entries,
      })),
    };
  }

  const clusters = [...new Set(agents.map((a) => a.clusterId))];
  return {
    agentsTargeted: agents.length,
    clustersTargeted: clusters,
    data,
  };
}

async function executeReduceSummarize(
  filter: AgentFilter,
  question: string,
): Promise<{ agentsTargeted: number; clustersTargeted: string[]; data: unknown }> {
  const agents = await resolveFilter(filter);

  // Read log tails AND directives in parallel for all matched agents.
  // Directives are passed to Bedrock alongside log tails so questions
  // like "summarise the per-agent directives" can be answered.
  const agentLogs = await Promise.all(
    agents.map(async (agent) => {
      const [entries, directive] = await Promise.all([
        readAgentLogTail(agent.clusterId, agent.agentIndex, MAX_ENTRIES_PER_AGENT),
        readDirective(agent.clusterId, agent.agentIndex),
      ]);
      return {
        agentId: `${agent.clusterId}/agent-${agent.agentIndex}`,
        clusterId: agent.clusterId,
        entries,
        directive,
      };
    }),
  );

  // Read environment file listings for targeted clusters
  const targetClusters = [...new Set(agents.map((a) => a.clusterId))];
  const envFiles: Record<string, string[]> = {};
  await Promise.all(
    targetClusters.map(async (clusterId) => {
      const prefix = `environment/${clusterId}/`;
      const listed = await s3.send(
        new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, MaxKeys: 100 }),
      );
      envFiles[clusterId] = (listed.Contents ?? [])
        .map((o) => o.Key!)
        .filter(Boolean);
    }),
  );

  // Build the Bedrock prompt
  const dataBlock = JSON.stringify({ agentLogs, envFiles }, null, 2);
  const prompt = `You are analyzing a subset of agents in a kiro-flock deployment. The operator has asked a specific question about these agents.

Each entry in agent_data.agentLogs has these fields:
- agentId: the cluster-qualified agent identifier
- clusterId: the cluster the agent belongs to
- entries: the agent's recent NDJSON log entries (action / result / next_intent / iteration / ts)
- directive: the agent's per-agent directive markdown if one has been issued (operator preamble plus any self-optimization log), or null if no directive

When the operator asks about per-agent directives or "individual directions", base your answer on the directive field. When they ask about activity or behaviour, use entries. Use both when the question crosses both.

<agent_data>
${dataBlock}
</agent_data>

<operator_question>
${question}
</operator_question>

Respond with ONLY valid JSON matching this schema (no markdown fences):

{
  "summary": "<direct answer to the operator's question, 2-5 sentences>",
  "findings": [
    {
      "agentId": "<agent identifier>",
      "observation": "<what this agent is doing or has produced>",
      "status": "<active|idle|blocked|complete>"
    }
  ],
  "patterns": ["<any coordination or divergence patterns you notice>"],
  "recommendation": "<optional: what the operator might do next, or null if no action needed>"
}

Rules:
- Answer the operator's question directly and specifically.
- Base findings only on the data provided, do not invent activity.
- If an agent has no entries, mark it as status "idle" with observation "no activity recorded".
- Keep the summary concrete and actionable.`;

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
    }),
  );

  let responseText = "";
  const output = response.output;
  if (output && "message" in output && output.message?.content) {
    for (const block of output.message.content) {
      if ("text" in block && block.text) {
        responseText = block.text;
        break;
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { raw: responseText, parseError: "Model did not return valid JSON" };
  }

  return {
    agentsTargeted: agents.length,
    clustersTargeted: targetClusters,
    data: parsed,
  };
}

// ── File target: reduce ──────────────────────────────────────────────────────

/** Quoted-file ceiling in the result payload. Counts stay complete; this only
 *  stops a 10,000-match scan from producing an unreadable tab. */
const MAX_FILES_IN_RESULT = 500;

function directoryOf(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash === -1 ? "/" : key.slice(0, slash);
}

interface FileScanOutcome {
  scopes: string[];
  filesListed: number;
  filesScanned: number;
  filesMatched: number;
  matchesTotal: number;
  truncatedFiles: number;
  matches: FileMatch[];
  clusters: string[];
  inventoryOnly: boolean;
}

/** Shared listing + scanning pass. Both extract and summarize build on this. */
async function runFileScan(filter: FileFilter): Promise<FileScanOutcome> {
  const { candidates, listed, scopes } = await resolveFiles(filter);

  const clusters = [
    ...new Set(candidates.map((c) => c.clusterId).filter((c): c is string => c !== null)),
  ].sort();

  // No contentRegex means the operator asked about the shape of the corpus,
  // not its contents. Answerable from LIST metadata alone — zero reads.
  if (!filter.contentRegex) {
    const inventory: FileMatch[] = candidates.map((c) => ({
      key: c.key,
      size: c.size,
      lastModified: c.lastModified,
      clusterId: c.clusterId,
      scope: c.scope,
      matches: 0,
      matchLines: 0,
      lines: [],
      truncated: false,
    }));
    return {
      scopes,
      filesListed: listed,
      filesScanned: candidates.length,
      filesMatched: candidates.length,
      matchesTotal: 0,
      truncatedFiles: 0,
      matches: inventory,
      clusters,
      inventoryOnly: true,
    };
  }

  let contentRe: RegExp;
  try {
    contentRe = new RegExp(filter.contentRegex, "i");
  } catch (err: unknown) {
    throw new Error(
      `invalid contentRegex ${JSON.stringify(filter.contentRegex)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const maxBytes = filter.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const scanned = await mapPool(candidates, READ_CONCURRENCY, (obj) =>
    scanObject(obj, contentRe, maxBytes, DEFAULT_CONTEXT_LINES, DEFAULT_MAX_MATCH_LINES),
  );

  const matches = scanned
    .filter((m): m is FileMatch => m !== null)
    .sort((a, b) => b.matches - a.matches || a.key.localeCompare(b.key));

  return {
    scopes,
    filesListed: listed,
    filesScanned: candidates.length,
    filesMatched: matches.length,
    matchesTotal: matches.reduce((sum, m) => sum + m.matches, 0),
    truncatedFiles: matches.filter((m) => m.truncated).length,
    matches,
    clusters,
    inventoryOnly: false,
  };
}

async function executeFileReduceExtract(
  filter: FileFilter,
  query?: FileQuery,
): Promise<{ agentsTargeted: number; clustersTargeted: string[]; data: unknown }> {
  const scan = await runFileScan(filter);
  const groupBy = query?.groupBy ?? "file";

  const quoted = scan.matches.slice(0, MAX_FILES_IN_RESULT);
  const filesOmitted = scan.matches.length - quoted.length;

  const meta = {
    target: "files" as const,
    scopes: scan.scopes,
    contentRegex: filter.contentRegex ?? null,
    pathGlob: filter.pathGlob ?? null,
    mode: scan.inventoryOnly ? ("inventory" as const) : ("content-scan" as const),
    filesListed: scan.filesListed,
    filesScanned: scan.filesScanned,
    filesMatched: scan.filesMatched,
    matchesTotal: scan.matchesTotal,
    truncatedFiles: scan.truncatedFiles,
    filesOmitted,
    groupBy,
  };

  // Agent grouping needs the correlation join; every other grouping is a pure
  // function of the file key.
  if (groupBy === "agent") {
    const attribution = await correlateFilesToAgents(quoted, scan.clusters);
    const groups: Record<
      string,
      { confidence: string; fileCount: number; matchCount: number; files: unknown[] }
    > = {};

    for (const match of quoted) {
      const hits = attribution.get(match.key) ?? [];
      if (hits.length === 0) {
        const bucket = (groups.unattributed ??= {
          confidence: "none",
          fileCount: 0,
          matchCount: 0,
          files: [],
        });
        bucket.fileCount++;
        bucket.matchCount += match.matches;
        bucket.files.push({ ...match, attributedVia: null });
        continue;
      }
      for (const hit of hits) {
        const bucket = (groups[hit.agentId] ??= {
          confidence: hit.confidence,
          fileCount: 0,
          matchCount: 0,
          files: [],
        });
        // A single low-confidence hit should not upgrade the group, but any
        // high-confidence hit should.
        if (hit.confidence === "high") bucket.confidence = "high";
        bucket.fileCount++;
        bucket.matchCount += match.matches;
        bucket.files.push({ ...match, attributedVia: hit.via, confidence: hit.confidence });
      }
    }

    const attributedAgents = Object.keys(groups).filter((k) => k !== "unattributed");
    return {
      agentsTargeted: attributedAgents.length,
      clustersTargeted: scan.clusters,
      data: {
        ...meta,
        attributionNote:
          "environment/ is a shared prefix with no agent index in the path. Agents are inferred from file-path mentions in their NDJSON logs, so attribution is best effort. Files whose authoring agent never named them appear under \"unattributed\". For exact attribution, map a directive asking agents to self-report, then reduce over the logs.",
        groups,
      },
    };
  }

  const groups: Record<string, { fileCount: number; matchCount: number; files: unknown[] }> = {};
  for (const match of quoted) {
    let key: string;
    switch (groupBy) {
      case "cluster":
        key = match.clusterId ?? match.scope;
        break;
      case "directory":
        key = directoryOf(match.key);
        break;
      case "extension":
        key = extensionOf(match.key) || "(none)";
        break;
      default:
        key = match.key;
    }
    const bucket = (groups[key] ??= { fileCount: 0, matchCount: 0, files: [] });
    bucket.fileCount++;
    bucket.matchCount += match.matches;
    bucket.files.push(match);
  }

  return {
    agentsTargeted: 0,
    clustersTargeted: scan.clusters,
    data: { ...meta, groups },
  };
}

async function executeFileReduceSummarize(
  filter: FileFilter,
  question: string,
  query?: FileQuery,
): Promise<{ agentsTargeted: number; clustersTargeted: string[]; data: unknown }> {
  const scan = await runFileScan(filter);

  // Summarize consumes the match set, never the raw corpus. Trim to the
  // character budget by dropping the lowest-scoring files first, so the model
  // always sees the strongest evidence.
  const budgeted: FileMatch[] = [];
  let used = 0;
  let droppedForBudget = 0;
  for (const match of scan.matches) {
    const cost = JSON.stringify(match).length;
    if (used + cost > SUMMARIZE_BUDGET_CHARS) {
      droppedForBudget = scan.matches.length - budgeted.length;
      break;
    }
    budgeted.push(match);
    used += cost;
  }

  let attributionBlock: Record<string, Attribution[]> = {};
  if (query?.groupBy === "agent") {
    const map = await correlateFilesToAgents(budgeted, scan.clusters);
    attributionBlock = Object.fromEntries(map);
  }

  const dataBlock = JSON.stringify(
    {
      scanStats: {
        filesListed: scan.filesListed,
        filesScanned: scan.filesScanned,
        filesMatched: scan.filesMatched,
        matchesTotal: scan.matchesTotal,
        filesInThisSample: budgeted.length,
        filesDroppedForBudget: droppedForBudget,
      },
      contentRegex: filter.contentRegex ?? null,
      matches: budgeted,
      agentAttribution: attributionBlock,
    },
    null,
    2,
  );

  const prompt = `You are analyzing files produced by a kiro-flock deployment. The operator has asked a question about the contents of those files.

The data below is the result of a content scan over the flock's shared output in S3, not the agents' logs.

- scanStats describes coverage. filesInThisSample may be smaller than filesMatched when the match set exceeded the context budget; say so in your answer if files were dropped.
- matches lists each file that matched, with total occurrence count and a quoted sample of matching lines (with surrounding context). Line samples are capped, so "matches" is the authoritative count, not the number of quoted lines.
- agentAttribution, when present, maps a file key to the agents whose logs reference it. Attribution is best effort: environment/ is a shared prefix with no agent index in the path, so an empty array means the authoring agent never named the file in its log, NOT that no agent wrote it. Never claim a file has no author.

<scan_data>
${dataBlock}
</scan_data>

<operator_question>
${question}
</operator_question>

Respond with ONLY valid JSON matching this schema (no markdown fences):

{
  "summary": "<direct answer to the operator's question, 2-5 sentences>",
  "findings": [
    {
      "agentId": "<file key, or agent id when attribution is available>",
      "observation": "<what was found in this file>",
      "status": "<active|idle|blocked|complete>"
    }
  ],
  "patterns": ["<recurring idioms, duplication, or divergence across files>"],
  "recommendation": "<optional: what the operator might do next, or null>"
}

Rules:
- Answer the operator's question directly and specifically.
- Base findings only on the quoted lines provided. Do not infer code you cannot see.
- State coverage limits plainly when files were dropped for budget or truncated.
- Keep the summary concrete and actionable.`;

  const response = await bedrock.send(
    new ConverseCommand({
      modelId: MODEL_ID,
      messages: [{ role: "user", content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
    }),
  );

  let responseText = "";
  const output = response.output;
  if (output && "message" in output && output.message?.content) {
    for (const block of output.message.content) {
      if ("text" in block && block.text) {
        responseText = block.text;
        break;
      }
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    parsed = { raw: responseText, parseError: "Model did not return valid JSON" };
  }

  return {
    agentsTargeted: Object.keys(attributionBlock).length,
    clustersTargeted: scan.clusters,
    data: {
      target: "files",
      scopes: scan.scopes,
      contentRegex: filter.contentRegex ?? null,
      filesListed: scan.filesListed,
      filesScanned: scan.filesScanned,
      filesMatched: scan.filesMatched,
      matchesTotal: scan.matchesTotal,
      truncatedFiles: scan.truncatedFiles,
      filesDroppedForBudget: droppedForBudget,
      ...(parsed as Record<string, unknown>),
    },
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handler(event: MapReduceEvent): Promise<MapReduceResult> {
  const { tabId, operation, originalPrompt } = event;
  const createdAt = new Date().toISOString();
  const resultKey = `store/analyzer/tab-${tabId}.json`;
  const target: MapReduceTarget = operation.target === "files" ? "files" : "agents";

  try {
    let result: { agentsTargeted: number; clustersTargeted: string[]; data: unknown };

    if (target === "files") {
      // File operations are read-only by design. Writing into the agents'
      // shared work product from the operator side would race the agents
      // mid-iteration; env_upload is the supported path for seeding content.
      if (operation.type !== "reduce") {
        throw new Error(
          `target "files" is read-only: ${operation.type} is not supported. Use target "agents" to write directives, or env_upload to place files in the environment.`,
        );
      }

      // Inherit cluster scoping from the agent filter when the file filter
      // omits it, so "in team-auth" works wherever the translator put it.
      const fileFilter: FileFilter = { ...(operation.fileFilter ?? {}) };
      if (!fileFilter.clusters && operation.filter?.clusters) {
        fileFilter.clusters = operation.filter.clusters;
      }

      if (operation.mode === "summarize") {
        if (!operation.question) {
          throw new Error("reduce/summarize requires a question");
        }
        result = await executeFileReduceSummarize(
          fileFilter,
          operation.question,
          operation.fileQuery,
        );
      } else {
        result = await executeFileReduceExtract(fileFilter, operation.fileQuery);
      }
    } else {
      const agentFilter: AgentFilter = operation.filter ?? {};

      switch (operation.type) {
        case "map":
          if (!operation.directive) {
            throw new Error("map operation requires a directive");
          }
          result = await executeMap(agentFilter, operation.directive);
          break;

        case "map-clear":
          result = await executeMapClear(agentFilter);
          break;

        case "reduce":
          if (operation.mode === "summarize") {
            if (!operation.question) {
              throw new Error("reduce/summarize requires a question");
            }
            result = await executeReduceSummarize(agentFilter, operation.question);
          } else {
            result = await executeReduceExtract(agentFilter, operation.query);
          }
          break;

        default:
          throw new Error(`unknown operation type: ${(operation as any).type}`);
      }
    }

    const tabResult: MapReduceResult = {
      tabId,
      mode: "map/reduce",
      status: "complete",
      createdAt,
      operation,
      target,
      originalPrompt,
      result,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: resultKey,
        Body: JSON.stringify(tabResult),
        ContentType: "application/json",
      }),
    );

    return tabResult;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`mapreduceEngine[${tabId}] failed:`, errorMsg);

    const tabResult: MapReduceResult = {
      tabId,
      mode: "map/reduce",
      status: "error",
      createdAt,
      operation,
      target,
      originalPrompt,
      error: errorMsg,
    };

    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: resultKey,
        Body: JSON.stringify(tabResult),
        ContentType: "application/json",
      }),
    );

    return tabResult;
  }
}
