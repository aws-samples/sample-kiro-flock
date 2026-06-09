/**
 * Map-Reduce Execution Engine Lambda.
 *
 * Handles three operation types:
 *   - map: write per-agent directive files to S3
 *   - map-clear: delete per-agent directive files
 *   - reduce: extract or summarize agent log data
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
  clusterPrefix,
  type ClusterRegistry,
} from "./s3Store";

const s3 = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const BUCKET = process.env.BUCKET_NAME!;
const MODEL_ID = process.env.ANALYZER_MODEL_ID ?? "eu.anthropic.claude-sonnet-4-6";

/** Max log entries per agent for reduce operations. */
const MAX_ENTRIES_PER_AGENT = 10;

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

export interface MapReduceOperation {
  type: "map" | "map-clear" | "reduce";
  filter: AgentFilter;
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

  // Read log tails for all matched agents
  const agentLogs = await Promise.all(
    agents.map(async (agent) => ({
      agentId: `${agent.clusterId}/agent-${agent.agentIndex}`,
      clusterId: agent.clusterId,
      entries: await readAgentLogTail(
        agent.clusterId,
        agent.agentIndex,
        MAX_ENTRIES_PER_AGENT,
      ),
    })),
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
            else if (field in entry) selected[field] = (entry as unknown as Record<string, unknown>)[field];
          }
          groups[groupKey].push(selected);
        } else {
          groups[groupKey].push({ agentId: al.agentId, ...entry });
        }
      }
    }
    data = { groupBy: query.groupBy, groups };
  } else {
    // Flat list
    data = {
      agents: filteredLogs.map((al) => ({
        agentId: al.agentId,
        clusterId: al.clusterId,
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

  // Read log tails for all matched agents
  const agentLogs = await Promise.all(
    agents.map(async (agent) => ({
      agentId: `${agent.clusterId}/agent-${agent.agentIndex}`,
      clusterId: agent.clusterId,
      entries: await readAgentLogTail(
        agent.clusterId,
        agent.agentIndex,
        MAX_ENTRIES_PER_AGENT,
      ),
    })),
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

// ── Handler ──────────────────────────────────────────────────────────────────

export async function handler(event: MapReduceEvent): Promise<MapReduceResult> {
  const { tabId, operation, originalPrompt } = event;
  const createdAt = new Date().toISOString();
  const resultKey = `store/analyzer/tab-${tabId}.json`;

  try {
    let result: { agentsTargeted: number; clustersTargeted: string[]; data: unknown };

    switch (operation.type) {
      case "map":
        if (!operation.directive) {
          throw new Error("map operation requires a directive");
        }
        result = await executeMap(operation.filter, operation.directive);
        break;

      case "map-clear":
        result = await executeMapClear(operation.filter);
        break;

      case "reduce":
        if (operation.mode === "summarize") {
          if (!operation.question) {
            throw new Error("reduce/summarize requires a question");
          }
          result = await executeReduceSummarize(operation.filter, operation.question);
        } else {
          result = await executeReduceExtract(operation.filter, operation.query);
        }
        break;

      default:
        throw new Error(`unknown operation type: ${(operation as any).type}`);
    }

    const tabResult: MapReduceResult = {
      tabId,
      mode: "map/reduce",
      status: "complete",
      createdAt,
      operation,
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
