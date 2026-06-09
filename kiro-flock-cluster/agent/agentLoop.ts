/**
 * Agent loop: observe→decide→act→broadcast cycle via ACP + S3 MCP.
 *
 * Between-iteration controls (state.json driven):
 *
 *   {clusterId}/store/state.json carries the cluster's lifecycle state
 *   ("starting" | "running" | "paused" | "stopping" | "stopped"). Agents
 *   read it once between iterations to decide what to do next:
 *
 *     starting → on first iteration completion, agent flips it to
 *                "running" (read-modify-write with If-Match so an
 *                in-flight operator transition wins on conflict).
 *     running  → keep iterating.
 *     paused   → slow-poll state.json on a 10s interval, do no work,
 *                resume only when state flips back to "running".
 *     stopping → exit the loop gracefully so systemd can reap us.
 *     stopped  → exit the loop gracefully (same as above; this state
 *                normally arrives after stopping is reconciled).
 *
 *   Dynamic reload: the agent also reads config.json each iteration and
 *   applies the latest `loopIntervalSeconds`, `algorithm`, `swarmK`,
 *   `neighbourRadius`, and `internetAccess` to the next iteration.
 *   Other fields (`concurrency`, `instanceType`, `model`) require a
 *   restart because they change topology or process identity.
 *
 *   Autopause: when `config.autopause` is true (default) and every peer
 *   we can see has reported `action: "idle"` for three consecutive
 *   iterations (counting our own), the agent flips state.json from
 *   "running" to "paused" with reason "autopause". First agent to
 *   notice wins; the others see "paused" on their next state.json read
 *   and slow-poll like a normal pause. The If-Match precondition aborts
 *   the write silently if the operator transitioned the cluster in
 *   between, so a clicked Stop or Resume always wins.
 *
 * Multi-cluster layout: operational keys (config.json, direction.md,
 * store/) live under `{clusterId}/`. The shared `environment/` folder is
 * not prefixed — each cluster has an `environment/{clusterId}/` primary
 * subfolder but agents may read from (and when directed, write to) any
 * path under `environment/`.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { KiroRunner, type McpServerEntry } from "./kiroRunner.js";
import { selectNeighbours, type Algorithm } from "./neighbourSelector.js";

export interface AgentLoopConfig {
  agentIndex: number;
  concurrency: number;
  neighbours: number[];
  bucket: string;
  region: string;
  /** Initial interval only. The live value is re-read from config.json
   *  between iterations. */
  loopIntervalSeconds: number;
  model: string | null;
  /** Initial algorithm. Dynamically reloaded between iterations. */
  algorithm: Algorithm;
  /** Initial swarmK. Dynamically reloaded between iterations. Only used
   *  when algorithm === "swarm". */
  swarmK: number;
  /** Initial neighbour radius. Dynamically reloaded between iterations.
   *  Only used when algorithm === "amorphous". */
  neighbourRadius: number;
  /** Cluster this agent belongs to. Prefixes config/direction/state/store
   *  keys. */
  clusterId: string;
  /** When true, agents get a fetch MCP tool for web research. */
  internetAccess: boolean;
  /** When true (default), the agent participates in autopause: after every
   *  agent reports `action: "idle"` for three consecutive iterations the
   *  cluster is paused with reason "autopause". */
  autopause: boolean;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const PAUSE_POLL_INTERVAL_MS = 10_000;

/** Per-cluster lifecycle state values. Mirrors lambda/s3Store.ts so this
 *  module stays standalone (no shared lambda imports inside the agent
 *  bundle, which is built and shipped separately). */
type ClusterStateValue = "starting" | "running" | "paused" | "stopping" | "stopped";

interface ClusterStateDoc {
  state: ClusterStateValue;
  transitionedAt: string;
  transitionedBy: string;
  reason?: string;
}

interface ClusterStateRead {
  doc: ClusterStateDoc;
  etag: string | null;
}

/** Read state.json. Missing file is treated as "stopped" — same fallback
 *  as the Lambda. The etag is needed for conditional writes (autopause,
 *  Starting → Running). */
async function readState(
  s3: S3Client,
  bucket: string,
  clusterId: string,
): Promise<ClusterStateRead> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/state.json`,
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) {
      return {
        doc: { state: "stopped", transitionedAt: "1970-01-01T00:00:00.000Z", transitionedBy: "system" },
        etag: null,
      };
    }
    return { doc: JSON.parse(body) as ClusterStateDoc, etag: res.ETag ?? null };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey") {
      return {
        doc: { state: "stopped", transitionedAt: "1970-01-01T00:00:00.000Z", transitionedBy: "system" },
        etag: null,
      };
    }
    throw err;
  }
}

/** Write state.json with optional If-Match precondition. Returns true on
 *  success, false on a 412 (precondition failed) so the caller can drop
 *  the intent gracefully — used by autopause and Starting → Running so
 *  an operator-initiated transition that fires inside the read-modify-
 *  write window always wins. */
async function writeStateConditional(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  next: ClusterStateValue,
  agentIndex: number,
  reason: string,
  ifMatch: string | null,
): Promise<boolean> {
  const doc: ClusterStateDoc = {
    state: next,
    transitionedAt: new Date().toISOString(),
    transitionedBy: `agent-${agentIndex}`,
    reason,
  };
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/state.json`,
      Body: JSON.stringify(doc),
      ContentType: "application/json",
      CacheControl: "no-store",
      ...(ifMatch ? { IfMatch: ifMatch } : {}),
    }));
    return true;
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (status === 412 || code === "PreconditionFailed") {
      return false;
    }
    console.error(`state write (${next}) failed for agent-${agentIndex}:`, err);
    return false;
  }
}

/** Subset of config.json that reloads dynamically between iterations. */
interface DynamicConfig {
  loopIntervalSeconds: number | null;
  algorithm: Algorithm | null;
  swarmK: number | null;
  neighbourRadius: number | null;
  internetAccess: boolean | null;
  autopause: boolean | null;
}

/**
 * Read {clusterId}/config.json and return the fields that reload
 * dynamically. Any missing / malformed field returns null for that slot
 * so the caller keeps the previous value. A single bad field never
 * poisons the others.
 */
async function readDynamicConfig(
  s3: S3Client,
  bucket: string,
  clusterId: string,
): Promise<DynamicConfig> {
  const empty: DynamicConfig = {
    loopIntervalSeconds: null,
    algorithm: null,
    swarmK: null,
    neighbourRadius: null,
    internetAccess: null,
    autopause: null,
  };
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: `${clusterId}/config.json` }),
    );
    const text = (await resp.Body?.transformToString()) ?? "";
    if (!text) return empty;
    const parsed = JSON.parse(text) as {
      loopIntervalSeconds?: unknown;
      algorithm?: unknown;
      swarmK?: unknown;
      neighbourRadius?: unknown;
      internetAccess?: unknown;
      autopause?: unknown;
    };

    const interval =
      typeof parsed.loopIntervalSeconds === "number" &&
      Number.isFinite(parsed.loopIntervalSeconds) &&
      parsed.loopIntervalSeconds >= 0
        ? Math.floor(parsed.loopIntervalSeconds)
        : null;

    const algo =
      parsed.algorithm === "amorphous" ||
      parsed.algorithm === "mesh" ||
      parsed.algorithm === "swarm"
        ? (parsed.algorithm as Algorithm)
        : null;

    const k =
      typeof parsed.swarmK === "number" &&
      Number.isFinite(parsed.swarmK) &&
      parsed.swarmK >= 1
        ? Math.floor(parsed.swarmK)
        : null;

    const radius =
      typeof parsed.neighbourRadius === "number" &&
      Number.isFinite(parsed.neighbourRadius) &&
      parsed.neighbourRadius >= 0
        ? Math.floor(parsed.neighbourRadius)
        : null;

    const internet = typeof parsed.internetAccess === "boolean" ? parsed.internetAccess : null;
    const auto = typeof parsed.autopause === "boolean" ? parsed.autopause : null;

    return {
      loopIntervalSeconds: interval,
      algorithm: algo,
      swarmK: k,
      neighbourRadius: radius,
      internetAccess: internet,
      autopause: auto,
    };
  } catch (err: unknown) {
    console.error("config reload failed, keeping previous values:", err);
    return empty;
  }
}

/**
 * Read the last NDJSON entry from one agent's log file. Returns null when
 * the file doesn't exist yet or is empty. Used both for autopause (peeking
 * at peers' last action) and for the agent's own self-check.
 */
async function readLastEntry(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<{ action: string; ts: string } | null> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/agent-${agentIndex}.ndjson`,
      Range: "bytes=-2048",
    }));
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
        const entry = JSON.parse(line) as { action?: unknown; ts?: unknown };
        if (typeof entry.action === "string" && typeof entry.ts === "string") {
          return { action: entry.action, ts: entry.ts };
        }
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "InvalidRange") return null;
    throw err;
  }
}

/**
 * Read the per-agent directive file if it exists. Returns null when no
 * directive has been issued to this agent. The directive is written by
 * the map-reduce engine and takes priority over the cluster direction
 * where they conflict (the preamble in the file makes this explicit).
 */
async function readDirective(
  s3Client: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<string | null> {
  try {
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/agent-${agentIndex}.directive.md`,
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    return body || null;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey") return null;
    // Non-fatal: log and continue without directive
    console.error(`directive read failed for agent-${agentIndex}:`, err);
    return null;
  }
}

/**
 * Load the base agent loop prompt and the algorithm fragment, substitute
 * {{ALGORITHM_GUIDANCE}} and {{INTERNET_ACCESS}}, and return the composed
 * prompt. Throws loudly if either file is missing. A misspelled algorithm
 * should crash the agent at boot, not run silently with the wrong
 * instructions.
 */
function buildAgentPrompt(algorithm: Algorithm, internetAccess: boolean): string {
  const base = readFileSync(
    resolve(__dirname, "..", "agents", "prompts", "agent-loop.md"),
    "utf-8",
  );
  const fragmentPath = resolve(
    __dirname,
    "..",
    "agents",
    "prompts",
    "algorithms",
    `${algorithm}.md`,
  );
  let fragment: string;
  try {
    fragment = readFileSync(fragmentPath, "utf-8");
  } catch (err: unknown) {
    throw new Error(
      `Missing algorithm fragment for "${algorithm}" at ${fragmentPath}. ` +
      `Check agents/prompts/algorithms/ and the algorithm value in config.json. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!base.includes("{{ALGORITHM_GUIDANCE}}")) {
    throw new Error(
      "agent-loop.md is missing the {{ALGORITHM_GUIDANCE}} placeholder. " +
      "The base prompt and the per-algorithm fragments must be combined " +
      "before sending to the agent.",
    );
  }

  const internetFragment = internetAccess
    ? [
        "",
        "## Internet research",
        "",
        "You have a `fetch` tool that retrieves web pages and returns their content as markdown.",
        "Use it when your current task requires external information: documentation lookups,",
        "API references, checking current library versions, reading specs or standards.",
        "",
        "Guidelines:",
        "- Only fetch when the direction or your current subtask requires external information.",
        "- Do not fetch speculatively on every iteration.",
        "- Fetched content is ephemeral (not cached across iterations). If you find something",
        "  useful, write a summary or the relevant excerpt to your environment directory so",
        "  you and your neighbours can reference it on future iterations.",
        "- Prefer authoritative sources (official docs, RFCs, GitHub repos) over blog posts.",
        "",
      ].join("\n")
    : "";

  let prompt = base.replace("{{ALGORITHM_GUIDANCE}}", fragment.trim());
  prompt = prompt.replace("{{INTERNET_ACCESS}}", internetFragment);
  return prompt;
}

export async function runLoop(config: AgentLoopConfig): Promise<void> {
  let shutdown = false;
  process.on("SIGTERM", () => { shutdown = true; });

  const n = config.agentIndex;
  const clusterId = config.clusterId;

  // Standalone S3 MCP server script, bundled alongside this file.
  const s3McpScript = resolve(__dirname, "s3Mcp.js");
  const s3McpServer: McpServerEntry = {
    name: "aga-s3",
    command: "node",
    args: [s3McpScript],
    env: [
      { name: "AGA_BUCKET", value: config.bucket },
      { name: "AGA_REGION", value: config.region },
      { name: "AGA_CLUSTER_PREFIX", value: clusterId },
    ],
  };

  // Local S3 client for state polling, config reload, and neighbour selection.
  // Cheap to reuse across iterations.
  const s3 = new S3Client({ region: config.region });

  // Live state for the dynamically-reloadable fields. Starts from the
  // launch-time config and is refreshed every cycle.
  let currentIntervalSeconds = config.loopIntervalSeconds;
  let currentAlgorithm: Algorithm = config.algorithm;
  let currentSwarmK = config.swarmK;
  let currentRadius = config.neighbourRadius;
  let currentInternetAccess = config.internetAccess;
  let currentAutopause = config.autopause;
  let currentNeighbours = config.neighbours;

  // Autopause counter — number of consecutive iterations on which every
  // visible agent (us + currentNeighbours) reported `action: "idle"`.
  // Reset to 0 the moment any agent does anything else. At 3 the agent
  // flips state.json to "paused" (if config.autopause is on).
  let consecutiveAllIdle = 0;
  const AUTOPAUSE_THRESHOLD = 3;

  while (!shutdown) {
    // Rebuild the prompt each iteration so the algorithm fragment and
    // neighbour list always match current state. Log paths are rooted
    // at the agent's cluster prefix so the MCP's fs_read allowlist
    // accepts them.
    const neighbourPaths = currentNeighbours
      .map((i) => `/${clusterId}/store/agent-${i}.ndjson`)
      .join(", ");

    const promptHeader = [
      `You are agent-${n} in cluster "${clusterId}".`,
      `Your direction file is: /${clusterId}/direction.md.`,
      `Your log file is: /${clusterId}/store/agent-${n}.ndjson.`,
      `Your neighbour log files are: ${neighbourPaths}.`,
      `Your primary environment directory is: /environment/${clusterId}.`,
      `The full /environment/ folder is shared across clusters and readable; other clusters' subfolders sit under /environment/.`,
      `Your knowledge base is: /knowledge-base.`,
      `Follow your agent loop prompt instructions.`,
    ].join("\n");

    // Check for a per-agent directive (written by the map-reduce engine).
    // If present, inject the FULL CONTENT into the prompt so the agent sees
    // it immediately without needing to read it from S3. This ensures idle
    // agents act on directives instead of skipping them.
    const directive = await readDirective(s3, config.bucket, clusterId, n);
    const directiveBlock = directive
      ? `\n\n## Per-Agent Directive (PRIORITY — act on this)\n\nThe following directive was issued to you specifically. It takes precedence over the cluster direction where they conflict. Do NOT ignore this even if you were idle.\n\n${directive}\n`
      : "";

    const agentPrompt = buildAgentPrompt(currentAlgorithm, currentInternetAccess);
    const initialPrompt = promptHeader + directiveBlock + "\n\n" + agentPrompt;

    const mcpServers: McpServerEntry[] = [s3McpServer];
    if (currentInternetAccess) {
      mcpServers.push({
        name: "fetch",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-fetch"],
        env: [],
      });
    }

    const client = await KiroRunner.create({
      cwd: "/home/ec2-user/kiro-flock-workspace",
      model: config.model,
      mcpServers,
    });

    try {
      for await (const _chunk of client.prompt(initialPrompt)) {
        // stream: could log chunks here if needed
      }
    } finally {
      await client.close();
    }

    if (shutdown) break;

    // Iteration finished. Walk the unified state machine.

    // 1. Try to flip starting → running. We just produced our first log
    //    line (or did nothing if the direction was empty); either way
    //    the cluster is no longer in its "spinning up" phase from the
    //    operator's perspective. If state is anything else (operator
    //    paused or stopped during the first iteration), the If-Match
    //    write fails silently and we fall through to the normal handling.
    {
      const stateRead = await readState(s3, config.bucket, clusterId);
      if (stateRead.doc.state === "starting") {
        await writeStateConditional(
          s3, config.bucket, clusterId,
          "running", n, "first-iteration", stateRead.etag,
        );
      }
    }

    // 2. Autopause check — only meaningful while running. If every peer
    //    we can see (and ourselves) reported idle, increment the counter.
    //    On reaching the threshold, attempt to flip running → paused.
    //    Disabled when config.autopause is false.
    if (currentAutopause) {
      const visibleIndexes = [n, ...currentNeighbours];
      const lastEntries = await Promise.all(
        visibleIndexes.map((i) => readLastEntry(s3, config.bucket, clusterId, i)),
      );
      const everyoneVisible = lastEntries.every((e) => e !== null);
      const allIdle = everyoneVisible && lastEntries.every((e) => e!.action === "idle");
      if (allIdle) {
        consecutiveAllIdle += 1;
        console.log(`autopause: ${consecutiveAllIdle}/${AUTOPAUSE_THRESHOLD} idle iterations`);
        if (consecutiveAllIdle >= AUTOPAUSE_THRESHOLD) {
          const stateRead = await readState(s3, config.bucket, clusterId);
          if (stateRead.doc.state === "running") {
            const ok = await writeStateConditional(
              s3, config.bucket, clusterId,
              "paused", n, "autopause", stateRead.etag,
            );
            if (ok) {
              console.log("autopause: cluster -> paused");
              consecutiveAllIdle = 0;
            }
            // On precondition failure, another agent or operator already
            // changed state.json. Either way we'll see the new state on
            // the next read and behave accordingly.
          }
        }
      } else {
        consecutiveAllIdle = 0;
      }
    } else {
      consecutiveAllIdle = 0;
    }

    // Sleep between iterations using the most recently known interval.
    await sleep(currentIntervalSeconds * 1000);
    if (shutdown) break;

    // 3. Between-iteration state check. The cluster may have transitioned
    //    while we were running or sleeping. Treat each state appropriately:
    //
    //      paused   → slow-poll until it clears (resume / stop / stopped)
    //      stopping → break out so systemd can reap us
    //      stopped  → break out (same reason; reconcile already happened)
    //      running, starting → continue
    {
      let s = (await readState(s3, config.bucket, clusterId)).doc.state;
      if (s === "paused") {
        console.log("paused");
        while (!shutdown) {
          await sleep(PAUSE_POLL_INTERVAL_MS);
          if (shutdown) break;
          s = (await readState(s3, config.bucket, clusterId)).doc.state;
          if (s !== "paused") break;
        }
        if (shutdown) break;
        if (s === "stopping" || s === "stopped") {
          console.log(`exiting: cluster state ${s}`);
          break;
        }
        console.log("resumed");
        // Reset autopause counter so resume gets a fresh runway before
        // any new auto-trigger.
        consecutiveAllIdle = 0;
      } else if (s === "stopping" || s === "stopped") {
        console.log(`exiting: cluster state ${s}`);
        break;
      }
    }

    // 4. Reload the dynamic subset of config.json. Any field that fails
    //    validation keeps its previous value. `concurrency`, `instanceType`,
    //    `model` are start-time-only and ignored here.
    const next = await readDynamicConfig(s3, config.bucket, clusterId);
    if (next.loopIntervalSeconds !== null) currentIntervalSeconds = next.loopIntervalSeconds;
    if (next.algorithm !== null) currentAlgorithm = next.algorithm;
    if (next.swarmK !== null) currentSwarmK = next.swarmK;
    if (next.neighbourRadius !== null) currentRadius = next.neighbourRadius;
    if (next.internetAccess !== null) currentInternetAccess = next.internetAccess;
    if (next.autopause !== null) currentAutopause = next.autopause;

    // 5. Re-select neighbours for the next iteration. amorphous + mesh are
    //    pure; swarm hits ListObjectsV2 once. The fall-back to amorphous
    //    when no logs exist is handled inside selectNeighbours.
    try {
      currentNeighbours = await selectNeighbours({
        algorithm: currentAlgorithm,
        agentIndex: config.agentIndex,
        concurrency: config.concurrency,
        neighbourRadius: currentRadius,
        swarmK: currentSwarmK,
        bucket: config.bucket,
        region: config.region,
        clusterId,
      });
    } catch (err: unknown) {
      console.error("neighbour selection failed, keeping previous list:", err);
    }
  }
}
