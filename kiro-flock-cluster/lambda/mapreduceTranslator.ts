/**
 * Map-Reduce Translation Lambda.
 *
 * Converts a natural language prompt into a structured MapReduceOperation
 * by calling Bedrock. Then invokes the execution engine Lambda with the
 * structured operation.
 *
 * This is the "agentic interpreter" layer. It knows the cluster registry,
 * current cluster states, and the available operation types. It translates
 * human intent into machine-executable operations.
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import {
  readRegistry,
  readState,
  readConfig,
  clusterPrefix,
  type ClusterConfig,
} from "./s3Store";
import type { MapReduceOperation, MapReduceEvent } from "./mapreduceEngine";

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});
const lambdaClient = new LambdaClient({});

const BUCKET = process.env.BUCKET_NAME!;
const MODEL_ID = process.env.ANALYZER_MODEL_ID ?? "eu.anthropic.claude-sonnet-4-6";
const ENGINE_FN = process.env.MAPREDUCE_ENGINE_FN!;

export interface TranslatorEvent {
  tabId: string;
  prompt: string;
}

export interface TranslatorResult {
  tabId: string;
  status: "dispatched" | "error";
  operation?: MapReduceOperation;
  error?: string;
}

/**
 * Gather context about the current cluster state so the translation model
 * can resolve references like "the auth cluster" or "idle agents".
 */
async function gatherContext(): Promise<string> {
  const registry = await readRegistry(BUCKET);

  const clusterSummaries = await Promise.all(
    registry.clusters.map(async (entry) => {
      const { doc } = await readState(BUCKET, entry.id);
      let config: ClusterConfig | null = null;
      try {
        config = await readConfig(BUCKET, entry.id);
      } catch { /* no config */ }

      let direction = "";
      try {
        const dirKey = `${clusterPrefix(entry.id)}direction.md`;
        const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: dirKey }));
        direction = ((await res.Body?.transformToString()) ?? "").slice(0, 500);
      } catch { /* no direction */ }

      return {
        id: entry.id,
        name: entry.name,
        state: doc.state,
        algorithm: config?.algorithm ?? entry.algorithm,
        concurrency: config?.concurrency ?? 0,
        directionPreview: direction,
      };
    }),
  );

  return JSON.stringify(clusterSummaries, null, 2);
}

function buildTranslationPrompt(userPrompt: string, context: string): string {
  return `You are a translation layer for a kiro-flock map-reduce system. Your job is to convert a natural language instruction or question into a structured JSON operation.

<available_clusters>
${context}
</available_clusters>

<available_operations>
1. **map** — Write a per-agent directive to targeted agents.
   Required fields: type="map", filter, directive (the text to send)

2. **map-clear** — Remove per-agent directives, returning agents to cluster-direction-only mode.
   Required fields: type="map-clear", filter

3. **reduce** with mode="extract" — Structured data extraction from agent logs. Fast, no AI summarization.
   Required fields: type="reduce", mode="extract", filter
   Optional: query (with groupBy, select, where)

4. **reduce** with mode="summarize" — AI-powered summarization of targeted agents' activity.
   Required fields: type="reduce", mode="summarize", filter, question
</available_operations>

<filter_schema>
{
  "clusters": ["array of cluster IDs to target, omit for all non-stopped clusters"],
  "agentIndexes": [0, 1, 2, "specific agent indexes, omit for all"],
  "actionRegex": "regex to match against agent's last action",
  "iterationGte": "minimum iteration count",
  "iterationLte": "maximum iteration count",
  "all": true,
  "active": true
}
All filter fields are optional. They compose with AND logic.

IMPORTANT distinction between "all" and "active":
- "all": true — targets EVERY agent by config concurrency (0 through N-1), INCLUDING agents that haven't produced output yet (e.g. rate-limited, still booting). Use this for map operations when you want to reach every agent.
- "active": true — targets only agents that have written at least one log entry. Use this for reduce operations where you want to query what agents have actually done.
- If neither is specified, defaults to "active" behavior (log-file discovery).
- For map operations (sending directives), prefer "all": true so no agent is missed.
- For reduce operations (querying logs), prefer "active": true since there's nothing to read from agents that haven't started.
</filter_schema>

<user_prompt>
${userPrompt}
</user_prompt>

Convert the user's prompt into a structured operation. Respond with ONLY valid JSON (no markdown fences, no explanation):

{
  "type": "map|map-clear|reduce",
  "filter": { ... },
  "directive": "for map: the full directive text to send to agents",
  "mode": "for reduce: extract|summarize",
  "question": "for reduce/summarize: the question to answer about the agents",
  "query": {
    "groupBy": "for reduce/extract: agentId|clusterId|action|nextIntent",
    "select": ["fields to include in output"],
    "where": { "actionRegex": "...", "iterationGte": N, "iterationLte": N }
  }
}

Rules:
- Match cluster references to actual cluster IDs from the available_clusters list. "auth cluster" → find the cluster whose name or direction mentions auth.
- "first 3 agents" → agentIndexes: [0, 1, 2]
- "idle agents" → actionRegex: "idle"
- "all agents" or "every agent" or no specific targeting → all: true
- "active agents" or "agents that have started" → active: true
- For map operations (directives), always use "all": true unless the user specifically targets a subset. This ensures rate-limited agents also receive the directive.
- If the user asks a question ("what have they produced?", "are they converging?"), use reduce/summarize.
- If the user asks for raw data ("show me", "list", "which agents"), use reduce/extract.
- If the user gives an instruction to agents ("focus on X", "pivot to Y", "stop doing Z"), use map with all: true.
- If the user says "clear directives" or "remove directives", use map-clear with all: true.
- For map directives, write clear actionable instructions. Do not include the preamble (it's added automatically).
- Only include fields relevant to the operation type. Do not include null or empty fields.`;
}

export async function handler(event: TranslatorEvent): Promise<TranslatorResult> {
  const { tabId, prompt } = event;

  try {
    // Gather cluster context for the translation model
    const context = await gatherContext();
    const translationPrompt = buildTranslationPrompt(prompt, context);

    // Call Bedrock to translate
    const response = await bedrock.send(
      new ConverseCommand({
        modelId: MODEL_ID,
        messages: [{ role: "user", content: [{ text: translationPrompt }] }],
        inferenceConfig: { maxTokens: 2048, temperature: 0.1 },
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

    if (!responseText) {
      throw new Error("Bedrock returned no text content");
    }

    // Parse the structured operation
    let operation: MapReduceOperation;
    try {
      operation = JSON.parse(responseText) as MapReduceOperation;
    } catch {
      throw new Error(
        `Translation model returned invalid JSON: ${responseText.slice(0, 200)}`,
      );
    }

    // Validate minimum fields
    if (!operation.type || !["map", "map-clear", "reduce"].includes(operation.type)) {
      throw new Error(`Invalid operation type: ${operation.type}`);
    }
    if (!operation.filter) {
      operation.filter = { all: true };
    }

    // Write a "processing" placeholder so the UI can show progress
    const placeholder = {
      tabId,
      mode: "map/reduce",
      status: "processing",
      createdAt: new Date().toISOString(),
      operation,
      originalPrompt: prompt,
    };
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `store/analyzer/tab-${tabId}.json`,
        Body: JSON.stringify(placeholder),
        ContentType: "application/json",
      }),
    );

    // Invoke the execution engine asynchronously
    const engineEvent: MapReduceEvent = {
      tabId,
      operation,
      originalPrompt: prompt,
    };

    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: ENGINE_FN,
        InvocationType: "Event",
        Payload: Buffer.from(JSON.stringify(engineEvent)),
      }),
    );

    return { tabId, status: "dispatched", operation };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`mapreduceTranslator[${tabId}] failed:`, errorMsg);

    // Write error to the tab so the UI can display it
    const errorResult = {
      tabId,
      mode: "map/reduce",
      status: "error",
      createdAt: new Date().toISOString(),
      originalPrompt: prompt,
      error: errorMsg,
    };
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: `store/analyzer/tab-${tabId}.json`,
        Body: JSON.stringify(errorResult),
        ContentType: "application/json",
      }),
    );

    return { tabId, status: "error", error: errorMsg };
  }
}
