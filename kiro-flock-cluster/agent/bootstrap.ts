/**
 * EC2 agent bootstrap — reads config from /etc/aga/agent.json, computes
 * neighbours, and starts the agent loop.
 *
 * Authentication is handled by the KIRO_API_KEY environment variable,
 * set by the systemd unit from SSM Parameter Store at boot.
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
  algorithm: "amorphous" | "mesh" | "swarm";
  /** Only consulted when algorithm === "swarm". */
  swarmK: number;
  /** Cluster this agent belongs to. Determines the S3 key prefix for
   *  config/direction/state/store. Defaults to "cluster_0" on configs
   *  written before multi-cluster support. */
  clusterId?: string;
  /** When true, agents get a fetch MCP tool for web research. */
  internetAccess?: boolean;
  /** When true (default), the agent participates in autopause: cluster
   *  pauses itself after every agent reports idle for three iterations. */
  autopause?: boolean;
}

export default async function bootstrap(): Promise<void> {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const cfg: AgentConfig = JSON.parse(raw);

  const clusterId = cfg.clusterId || "cluster_0";

  // Export AGA_CLUSTER_PREFIX so the S3 MCP subprocess (spawned later via
  // kiroRunner with its own forwarded env) and any other child of this
  // process picks up the right cluster. Must be set before anything reads
  // it, which is why we do it here rather than inside runLoop.
  process.env.AGA_CLUSTER_PREFIX = clusterId;

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

  console.log(`agent-${cfg.agentIndex} started — cluster: ${clusterId}, algorithm: ${cfg.algorithm}, neighbours: [${neighbours.join(", ")}]`);

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
    internetAccess: cfg.internetAccess ?? false,
    autopause: cfg.autopause ?? true,
  });
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
