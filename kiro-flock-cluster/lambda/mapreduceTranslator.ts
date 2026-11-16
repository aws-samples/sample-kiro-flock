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

<targets>
Every operation addresses one of two things. Choose "target" FIRST, before anything else.

**target: "agents"** (the default) — the unit is an agent. The data is each agent's
NDJSON activity log (action / result / next_intent / iteration) and its per-agent
directive. Use this when the question is about agent behaviour, progress, state, or
when you need to send instructions.

Signals: "which agents", "who is idle", "are they converging", "how many iterations",
"what directive does each agent have", "tell them to...", "clear directives",
"what have they been doing", "is anyone blocked".

**target: "files"** — the unit is an S3 object. The data is the actual work product the
flock wrote (source code, markdown, configs) under environment/ and optionally
knowledge-base/. READ-ONLY: only type="reduce" is valid. Never emit map or map-clear
with target "files".

Signals: "in the code", "which files", "find X", "search for", "grep", "does anything
use X", "how many files", "what did they write about X", "any TODOs", "show me the
tests", anything naming a language construct, symbol, function, library, or file
extension.

**The crossover case.** When the predicate is about file CONTENT but the grouping asked
for is agents ("show me agents who used while loops", "which agent wrote the retry
logic"), use target "files" with fileQuery.groupBy = "agent". The engine scans content
and then correlates matching files back to agents. Do NOT use target "agents" for
these: agent logs do not contain source code, so the question is unanswerable there.
</targets>

<available_operations>
1. **map** — Write a per-agent directive to targeted agents. target "agents" only.
   Required fields: type="map", filter, directive (the text to send)

2. **map-clear** — Remove per-agent directives, returning agents to cluster-direction-only mode. target "agents" only.
   Required fields: type="map-clear", filter

3. **reduce** with mode="extract" — Structured extraction. Fast, no AI summarization.
   target "agents": reads agent logs and directives.
     Required: type="reduce", mode="extract", filter
     Optional: query (with groupBy, select, where)
   target "files": regex content scan over the flock's output.
     Required: type="reduce", mode="extract", target="files", fileFilter
     Optional: fileQuery (with groupBy)

4. **reduce** with mode="summarize" — AI-powered summarization.
   Required fields: type="reduce", mode="summarize", question, plus the filter
   appropriate to the target (filter for agents, fileFilter for files).
</available_operations>

<file_filter_schema>
Used only when target is "files". All fields optional, AND composed.
{
  "clusters": ["cluster IDs whose environment folder to scan, omit for all clusters"],
  "scope": ["environment", "knowledge-base"],
  "pathGlob": "glob over the object key, supports **, *, ?, and {a,b} braces",
  "contentRegex": "regex matched against file content, case-insensitive",
  "modifiedAfter": "ISO-8601 instant, keep only files modified after this"
}

Guidance:
- "scope" defaults to ["environment"] (the flock's own output). Only add
  "knowledge-base" when the operator explicitly means reference material.
- Omit "contentRegex" when the question is about the shape of the corpus rather than
  its contents ("how many files did they write", "what files exist", "what was
  touched in the last hour"). Without it the scan reads nothing and is very fast.
- Use "pathGlob" to narrow to relevant file types before scanning content. For a code
  construct use: "**/*.{ts,tsx,js,jsx,py,java,go,rs,rb,c,h,cpp,cs,kt,swift,sh}"
- Write "contentRegex" as a real regex, not a plain substring, and anchor on word
  boundaries where it avoids false positives. Escape backslashes correctly for JSON.
  Examples:
    while loops              -> "\\\\bwhile\\\\s*\\\\("
    for loops                -> "\\\\bfor\\\\s*\\\\("
    TODO or FIXME comments   -> "\\\\b(TODO|FIXME|HACK)\\\\b"
    a named function         -> "\\\\bretryWithBackoff\\\\s*\\\\("
    try/catch                -> "\\\\bcatch\\\\s*\\\\("
    console logging          -> "console\\\\.(log|warn|error)"
    a library import         -> "from\\\\s+['\\"]axios['\\"]"
</file_filter_schema>

<file_query_schema>
Used only when target is "files".
{
  "groupBy": "file|cluster|directory|extension|agent"
}
- "file" (default) — one group per matching file.
- "agent" — correlate matched files back to the agents whose logs reference them.
  Use whenever the operator phrased the question in terms of agents.
- "cluster", "directory", "extension" — aggregate views.
</file_query_schema>

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
  "target": "agents|files",
  "type": "map|map-clear|reduce",
  "filter": { ... },
  "fileFilter": { ... },
  "fileQuery": { "groupBy": "file|cluster|directory|extension|agent" },
  "directive": "for map: the full directive text to send to agents",
  "mode": "for reduce: extract|summarize",
  "question": "for reduce/summarize: the question to answer",
  "query": {
    "groupBy": "for agents reduce/extract: agentId|clusterId|action|nextIntent",
    "select": ["fields to include in output"],
    "where": { "actionRegex": "...", "iterationGte": N, "iterationLte": N }
  }
}

Rules:
- Decide "target" first. Emit it explicitly on every operation, even when it is "agents".
- Never emit type "map" or "map-clear" with target "files". File operations are read-only.
- With target "files", put targeting in "fileFilter" and shaping in "fileQuery". Do not
  put file criteria in "filter" or "query".
- Match cluster references to actual cluster IDs from the available_clusters list. "auth cluster" → find the cluster whose name or direction mentions auth.
- "first 3 agents" → agentIndexes: [0, 1, 2]
- "idle agents" → actionRegex: "idle"
- "all agents" or "every agent" or no specific targeting → all: true
- "active agents" or "agents that have started" → active: true
- For map operations (directives), always use "all": true unless the user specifically targets a subset. This ensures rate-limited agents also receive the directive.
- If the user asks a question ("what have they produced?", "are they converging?"), use reduce/summarize.
- If the user asks for raw data ("show me", "list", "which agents"), use reduce/extract.
- If the user asks about per-agent directives ("what directive does each agent have", "show me all individual directions", "list per-agent directions"), use reduce/extract grouped by agentId with select including "directive". The reduce engine reads the directive markdown for every targeted agent and returns it.
- If the user gives an instruction to agents ("focus on X", "pivot to Y", "stop doing Z"), use map with all: true.
- If the user says "clear directives" or "remove directives", use map-clear with all: true.
- For map directives, write clear actionable instructions. Do not include the preamble (it's added automatically).
- Only include fields relevant to the operation type. Do not include null or empty fields.

Worked examples:

"Which agents are idle?"
{"target":"agents","type":"reduce","mode":"extract","filter":{"active":true},"query":{"groupBy":"agentId","select":["agentId","action","next_intent"]}}

"Show me agents who used while loops"
{"target":"files","type":"reduce","mode":"extract","fileFilter":{"scope":["environment"],"pathGlob":"**/*.{ts,tsx,js,jsx,py,java,go,rs}","contentRegex":"\\\\bwhile\\\\s*\\\\("},"fileQuery":{"groupBy":"agent"}}

"Any TODOs left in the code?"
{"target":"files","type":"reduce","mode":"extract","fileFilter":{"contentRegex":"\\\\b(TODO|FIXME)\\\\b"},"fileQuery":{"groupBy":"directory"}}

"How many files has team-auth produced?"
{"target":"files","type":"reduce","mode":"extract","fileFilter":{"clusters":["team-auth"]},"fileQuery":{"groupBy":"extension"}}

"Is the error handling in the generated code any good?"
{"target":"files","type":"reduce","mode":"summarize","question":"Is the error handling in the generated code sound, and where is it weakest?","fileFilter":{"pathGlob":"**/*.{ts,js,py,go}","contentRegex":"\\\\b(catch|except|rescue)\\\\b"}}

"Tell every agent to write tests"
{"target":"agents","type":"map","filter":{"all":true},"directive":"Before adding new features, write unit tests for the code you have already produced. Cover the failure paths, not just the happy path."}`;
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
    if (operation.target && !["agents", "files"].includes(operation.target)) {
      throw new Error(`Invalid target: ${operation.target}`);
    }

    if (operation.target === "files") {
      // Enforce read-only here as well as in the engine. A translator that
      // hallucinates a write should fail with a clear message rather than
      // reach the engine and be rejected there.
      if (operation.type !== "reduce") {
        throw new Error(
          `target "files" is read-only, but the prompt was translated to "${operation.type}". Rephrase as a query, or address agents instead.`,
        );
      }
      if (!operation.fileFilter) operation.fileFilter = {};
    } else if (!operation.filter) {
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
