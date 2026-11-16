/**
 * Agent bootstrap — reads config, computes neighbours, and starts the
 * agent loop.
 *
 * Config sources, in priority order:
 *   1. AGA_AGENT_CONFIG env var (JSON) — used on ECS, where RunTask
 *      container overrides inject the per-agent config directly.
 *   2. /etc/aga/agent.json (or AGA_CONFIG_PATH) — used on EC2, written
 *      by cloud-init (lambda/userData.ts).
 *
 * Authentication is handled by the KIRO_API_KEY environment variable —
 * set by the systemd unit from SSM Parameter Store on EC2, or injected
 * as an ECS container secret on Fargate.
 *
 * Cluster identity:
 *   The agent config includes a `clusterId` set by the Lambda userData.
 *   Bootstrap sets AGA_CLUSTER_PREFIX in the process env so the S3 MCP
 *   subprocess inherits it, and passes the id through to the agent loop
 *   for config/direction/pause/store key prefixing. Older configs that
 *   pre-date the multi-cluster split default to "cluster_0" for
 *   backwards compatibility.
 */
import fs from "node:fs";
import { runLoop } from "./agentLoop.js";
import { selectNeighbours } from "./neighbourSelector.js";

const CONFIG_PATH = process.env.AGA_CONFIG_PATH ?? "/etc/aga/agent.json";

interface AgentConfig {
  agentIndex: number;
  concurrency: number;
  neighbourRadius: number;
  bucket: string;
  region: string;
  loopIntervalSeconds: number;
  model: string | null;
  /** Coordination algorithm. See selectNeighbours(). */
  algorithm: "amorphous" | "mesh" | "swarm" | "single";
  /** Only consulted when algorithm === "swarm". */
  swarmK: number;
  /** Cluster this agent belongs to. Determines the S3 key prefix for
   *  config/direction/state/store. Defaults to "cluster_0" on configs
   *  written before multi-cluster support. */
  clusterId?: string;
  /** When true (default), the agent participates in autopause: cluster
   *  pauses itself after every agent reports idle for three iterations. */
  autopause?: boolean;
  /** Pass 8: when true, the agent appends a self-reflection block to its
   *  own per-agent directive after each iteration. */
  selfOptimizing?: boolean;
  /** When true, agents get a Puppeteer MCP server for headless browser
   *  automation. */
  browserAutomation?: boolean;
  /** Optional Everforge group. Changes the environment prefix to
   *  environment/<everforgeGroup>/<clusterId>/ and deployed/ to
   *  environment/<everforgeGroup>/deployed/. */
  everforgeGroup?: string | null;
}

/** Resolve the agent config: env var first (ECS), file second (EC2). */
function loadConfig(): AgentConfig {
  const fromEnv = process.env.AGA_AGENT_CONFIG;
  if (fromEnv && fromEnv.trim()) {
    try {
      return JSON.parse(fromEnv) as AgentConfig;
    } catch (err) {
      throw new Error(
        `AGA_AGENT_CONFIG is set but is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as AgentConfig;
}

export default async function bootstrap(): Promise<void> {
  const cfg: AgentConfig = loadConfig();

  const clusterId = cfg.clusterId || "cluster_0";

  // Export AGA_CLUSTER_PREFIX so the S3 MCP subprocess (spawned later via
  // kiroRunner with its own forwarded env) and any other child of this
  // process picks up the right cluster. Must be set before anything reads
  // it, which is why we do it here rather than inside runLoop.
  process.env.AGA_CLUSTER_PREFIX = clusterId;

  // Export AGA_EVERFORGE_GROUP so the S3 MCP subprocess adjusts its
  // environment path prefix. Empty string means "no group" (backwards compat).
  const everforgeGroup = cfg.everforgeGroup || "";
  process.env.AGA_EVERFORGE_GROUP = everforgeGroup;

  // Starting-iteration neighbour selection. The agent loop re-selects each
  // iteration so dynamic config changes (algorithm, swarmK, neighbourRadius)
  // take effect on the next turn.
  const neighbours = await selectNeighbours({
    algorithm: cfg.algorithm,
    agentIndex: cfg.agentIndex,
    concurrency: cfg.concurrency,
    neighbourRadius: cfg.neighbourRadius,
    swarmK: cfg.swarmK,
    bucket: cfg.bucket,
    region: cfg.region,
    clusterId,
  });

  if (!process.env.KIRO_API_KEY) {
    console.warn("⚠ KIRO_API_KEY not set — kiro-cli acp will fail to authenticate");
  }

  console.log(`agent-${cfg.agentIndex} started — cluster: ${clusterId}, algorithm: ${cfg.algorithm}, neighbours: [${neighbours.join(", ")}]${everforgeGroup ? `, everforgeGroup: ${everforgeGroup}` : ""}`);

  await runLoop({
    agentIndex: cfg.agentIndex,
    concurrency: cfg.concurrency,
    neighbours,
    bucket: cfg.bucket,
    region: cfg.region,
    loopIntervalSeconds: cfg.loopIntervalSeconds,
    model: cfg.model,
    algorithm: cfg.algorithm,
    swarmK: cfg.swarmK,
    neighbourRadius: cfg.neighbourRadius,
    clusterId,
    autopause: cfg.autopause ?? true,
    selfOptimizing: cfg.selfOptimizing ?? false,
    browserAutomation: cfg.browserAutomation ?? false,
    everforgeGroup: everforgeGroup || null,
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
