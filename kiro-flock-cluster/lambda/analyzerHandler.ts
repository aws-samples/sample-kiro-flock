/**
 * Analyzer Lambda — Bedrock-powered cluster analysis and direction optimization.
 *
 * Invoked asynchronously by the API handler. Reads all cluster state from S3,
 * builds a templated prompt, calls Bedrock Converse (Claude Sonnet 4.6), and
 * persists the structured result back to S3 under store/analyzer/.
 *
 * Two modes:
 *   - "analyze": produces an organigram + progress summary
 *   - "optimize": produces proposed direction updates for each cluster
 *
 * The result is written to S3 at a deterministic key so the API handler can
 * return it to the UI. The key includes a timestamp so each invocation
 * produces a new tab in the UI.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import {
  readRegistry,
  readConfig,
  clusterPrefix,
  envPrefix,
  readState,
  type ClusterConfig,
} from "./s3Store";
import {
  buildAnalyzePrompt,
  buildOptimizePrompt,
  type AnalyzerInput,
} from "./analyzerPrompts";

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const BUCKET = process.env.BUCKET_NAME!;
const MODEL_ID = process.env.ANALYZER_MODEL_ID ?? "eu.anthropic.claude-sonnet-4-6";

// Max log entries per agent to keep the prompt within context limits.
// At 500 agents x 5 entries x ~200 chars each ≈ 500KB, well within 200k tokens.
const MAX_ENTRIES_PER_AGENT = 5;

export interface AnalyzerEvent {
  mode: "analyze" | "optimize";
  /** Unique tab ID assigned by the API handler. Used as the S3 key suffix. */
  tabId: string;
}

export interface AnalyzerResult {
  tabId: string;
  mode: "analyze" | "optimize";
  status: "complete" | "error";
  createdAt: string;
  /** The parsed JSON response from Bedrock. Shape depends on mode. */
  data?: unknown;
  error?: string;
}

export async function handler(event: AnalyzerEvent): Promise<AnalyzerResult> {
  const { mode, tabId } = event;
  const createdAt = new Date().toISOString();
  const resultKey = `store/analyzer/tab-${tabId}.json`;

  try {
    // 1. Gather all cluster data from S3
    const input = await gatherClusterData();

    // 2. If optimizing, look for the most recent completed analysis to
    //    give the optimizer richer context about the current state.
    let latestAnalysis: unknown = null;
    if (mode === "optimize") {
      latestAnalysis = await findLatestAnalysis();
    }

    // 3. Build the prompt
    const prompt = mode === "analyze"
      ? buildAnalyzePrompt(input)
      : buildOptimizePrompt(input, latestAnalysis);

    // 4. Call Bedrock
    const response = await callBedrock(prompt);

    // 4. Parse the JSON response
    let data: unknown;
    try {
      data = JSON.parse(response);
    } catch {
      // Model returned non-JSON; wrap it as an error
      data = { raw: response, parseError: "Model did not return valid JSON" };
    }

    // 5. Persist result to S3
    const result: AnalyzerResult = { tabId, mode, status: "complete", createdAt, data };
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: resultKey,
      Body: JSON.stringify(result),
      ContentType: "application/json",
    }));

    return result;
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`analyzerHandler[${mode}/${tabId}] failed:`, errorMsg);

    const result: AnalyzerResult = { tabId, mode, status: "error", createdAt, error: errorMsg };
    await s3.send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: resultKey,
      Body: JSON.stringify(result),
      ContentType: "application/json",
    }));

    return result;
  }
}

// ---- Data gathering --------------------------------------------------------

async function gatherClusterData(): Promise<AnalyzerInput> {
  const registry = await readRegistry(BUCKET);
  const clusters: AnalyzerInput["clusters"] = [];

  // Gather data for each registered cluster in parallel
  const clusterResults = await Promise.all(
    registry.clusters.map(async (entry) => {
      const clusterId = entry.id;

      // Config (may not exist for freshly registered clusters)
      let config: ClusterConfig | null = null;
      try {
        config = await readConfig(BUCKET, clusterId);
      } catch { /* no config yet */ }

      // State
      const { doc: stateDoc } = await readState(BUCKET, clusterId);

      // Skip stopped clusters — only analyze active ones
      if (stateDoc.state === "stopped") return null;

      // Direction
      let direction = "";
      try {
        const dirKey = `${clusterPrefix(clusterId)}direction.md`;
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: dirKey }));
        direction = (await res.Body?.transformToString()) ?? "";
      } catch { /* no direction set */ }

      // Agent logs (last N entries per agent)
      const agentLogs = await gatherAgentLogs(clusterId, config?.concurrency ?? 0);

      // Environment file listing
      const envFiles = await listEnvFiles(clusterId);

      return {
        id: clusterId,
        name: entry.name || clusterId,
        algorithm: (config?.algorithm || entry.algorithm || "amorphous"),
        state: stateDoc.state,
        concurrency: config?.concurrency ?? 0,
        direction,
        agentLogs,
        envFiles,
      };
    }),
  );

  // Filter out nulls (stopped clusters)
  for (const r of clusterResults) {
    if (r) clusters.push(r);
  }

  // Knowledge-base file listing
  const knowledgeBaseFiles = await listPrefix("knowledge-base/");

  return { clusters, knowledgeBaseFiles };
}

async function gatherAgentLogs(
  clusterId: string,
  concurrency: number,
): Promise<AnalyzerInput["clusters"][0]["agentLogs"]> {
  if (concurrency === 0) return [];

  const storePrefix = `${clusterPrefix(clusterId)}store/`;

  // List agent log files
  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: BUCKET,
    Prefix: storePrefix,
  }));

  const logFiles = (listed.Contents ?? [])
    .filter(o => o.Key && /agent-\d+\.ndjson$/.test(o.Key))
    .map(o => o.Key!);

  // Read last N entries from each log file in parallel
  const results = await Promise.all(
    logFiles.map(async (key) => {
      const agentId = key.match(/agent-(\d+)\.ndjson$/)?.[0]?.replace(".ndjson", "") ?? "unknown";
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const body = (await res.Body?.transformToString()) ?? "";
        const lines = body.split("\n").filter(l => l.trim());
        // Take last N entries
        const tail = lines.slice(-MAX_ENTRIES_PER_AGENT);
        const entries = tail.map(l => {
          try { return JSON.parse(l); } catch { return null; }
        }).filter(Boolean);
        return { agentId, entries };
      } catch {
        return { agentId, entries: [] };
      }
    }),
  );

  return results;
}

async function listEnvFiles(clusterId: string): Promise<string[]> {
  const prefix = envPrefix(clusterId);
  return listPrefix(prefix);
}

async function listPrefix(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
      ContinuationToken: token,
      MaxKeys: 500, // cap to avoid unbounded reads
    }));
    for (const obj of res.Contents ?? []) {
      if (obj.Key) keys.push(obj.Key);
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
    // Only one page for scale safety
    if (keys.length >= 500) break;
  } while (token);
  return keys;
}

// ---- Find latest analysis for optimize context ----------------------------

async function findLatestAnalysis(): Promise<unknown> {
  const prefix = "store/analyzer/";
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix }));
  const analyzeFiles = (listed.Contents ?? [])
    .filter(o => o.Key && o.Key.includes("-analyze"))
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0));

  if (analyzeFiles.length === 0) return null;

  // Read the most recent one
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: analyzeFiles[0].Key! }));
    const text = (await res.Body?.transformToString()) ?? "";
    const parsed = JSON.parse(text);
    if (parsed.status === "complete" && parsed.data) {
      return parsed.data;
    }
  } catch { /* ignore read errors */ }

  return null;
}

// ---- Bedrock call ----------------------------------------------------------

async function callBedrock(prompt: string): Promise<string> {
  const response = await bedrock.send(new ConverseCommand({
    modelId: MODEL_ID,
    messages: [
      {
        role: "user",
        content: [{ text: prompt }],
      },
    ],
    inferenceConfig: {
      maxTokens: 8192,
      temperature: 0.3, // low temperature for structured output
    },
  }));

  // Extract text from the response
  const output = response.output;
  if (output && "message" in output && output.message?.content) {
    for (const block of output.message.content) {
      if ("text" in block && block.text) {
        return block.text;
      }
    }
  }

  throw new Error("Bedrock returned no text content");
}
