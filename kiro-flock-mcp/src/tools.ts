/**
 * MCP tool definitions for kiro-flock-feed-mcp.
 *
 * Every tool that targets a kiro-flock cluster accepts an optional
 * `cluster_id` parameter. When omitted, the backend defaults to
 * `cluster_0` for backwards compatibility with single-cluster deployments.
 * Shared resources (knowledge-base) ignore the parameter.
 */

// Common description for the cluster_id parameter, reused across tools.
const CLUSTER_ID_DESCRIPTION =
  "Target cluster ID. Defaults to cluster_0 when omitted (backwards compat for single-cluster deployments).";

export const TOOLS = [
  // ── Cluster registry ─────────────────────────────────────────────────────
  {
    name: "clusters_list",
    description:
      "List all registered kiro-flock clusters and their current states. Use this to discover cluster_ids before targeting a specific cluster with the other tools. Returns the cluster registry (ids, names, algorithms, states). In a single-cluster deployment, this returns one entry for cluster_0.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── Cluster lifecycle ────────────────────────────────────────────────────
  {
    name: "cluster_status",
    description:
      "Get the current cluster state (stopped/starting/running/stopping/paused), per-agent last log entry, and CloudWatch metrics. Call this to check if the cluster is running before starting it. The active coordination algorithm is surfaced via the returned `config.algorithm` field (amorphous / mesh / swarm). A paused cluster has instances alive but agents parked between iterations — stop polling stream_logs while paused, nothing new will arrive until someone calls cluster_resume.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "cluster_start",
    description:
      "Start the kiro-flock cluster. Launches EC2 instances. A direction must be set first (use direction_set). Automatically appends 'Read the environment/ directory first.' to the direction so agents pick up any context files uploaded there. Upload context files with env_upload_file or env_upload_folder AFTER calling this tool — cluster_start archives store/ first (environment/ is preserved), then agents boot, so uploads land in the environment/ directory before agents start their first iteration.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        config: {
          type: "object",
          description: "Optional config overrides. All fields are optional.",
          properties: {
            concurrency: { type: "number", description: "Number of agents (1–64)" },
            neighbourRadius: { type: "number", description: "How many neighbours each agent reads" },
            instanceType: { type: "string", description: "EC2 instance type (Graviton only, e.g. t4g.medium)" },
            loopIntervalSeconds: { type: "number", description: "Seconds between agent iterations" },
            internetAccess: { type: "boolean", description: "When true, agents get a fetch tool for web research" },
          },
        },
      },
      required: [],
    },
  },
  {
    name: "cluster_stop",
    description:
      "Stop the cluster by terminating all EC2 instances. Logs, environment, and knowledge-base remain in S3. Safe to call even if the cluster is already stopped. If you just want to preserve context for a later continuation — without burning EC2 while you inspect state or update the direction — use cluster_pause instead.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "cluster_pause",
    description:
      "Pause a running cluster between iterations. Instances keep running but agents stop spawning new work until cluster_resume is called. Use this when the cluster is idling or converged and you want to inspect state, update the direction, or feed new context without losing the current run. Only valid when the cluster is running; rejects with 409 otherwise. Pair with cluster_resume.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "cluster_resume",
    description:
      "Resume a paused cluster. Agents pick up their loop on the next 10 s poll cycle. Only valid when the cluster is paused; rejects with 409 otherwise. Use after cluster_pause and any inspection or direction updates you wanted to make.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "cluster_config_get",
    description:
      "Get the current cluster configuration (concurrency, neighbourRadius, instanceType, loopIntervalSeconds, algorithm, swarmK, internetAccess, autopause).",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "cluster_config_set",
    description:
      "Update cluster configuration. Four fields reload dynamically on each running agent's next iteration, no restart needed: `loopIntervalSeconds`, `algorithm`, `swarmK`, `neighbourRadius`. Other fields (`concurrency`, `instanceType`, `model`) still require a restart because they change topology or process identity. `algorithm` picks the coordination strategy: \"amorphous\" (ring neighbours at radius R, good for divergent exploration and parallel map at large N), \"mesh\" (every other agent, good for consensus and design decisions, scales badly past ~50 agents because per-agent context fills up), \"swarm\" (K most recently active agents via S3 LastModified, good for ideation and following activity hot spots). `swarmK` is only consulted when algorithm is \"swarm\"; must be 1..concurrency-1. `neighbourRadius` is only consulted when algorithm is \"amorphous\".",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        config: {
          type: "object",
          description: "Fields to update. Only provided fields are changed.",
          properties: {
            concurrency: { type: "number" },
            neighbourRadius: { type: "number" },
            instanceType: { type: "string" },
            loopIntervalSeconds: { type: "number" },
            algorithm: {
              type: "string",
              enum: ["amorphous", "mesh", "swarm"],
              description:
                "Coordination algorithm. amorphous = ring neighbours at radius R. mesh = every other agent. swarm = K most recently active agents.",
            },
            swarmK: {
              type: "number",
              description: "Peer count for swarm algorithm. 1..concurrency-1. Ignored for other algorithms.",
            },
            internetAccess: {
              type: "boolean",
              description: "When true, agents get a fetch MCP tool for web research (read-only HTTP GET, returns pages as markdown). Applies on next cluster start.",
            },
          },
        },
      },
      required: ["config"],
    },
  },

  // ── Direction ────────────────────────────────────────────────────────────
  {
    name: "direction_get",
    description: "Read the current direction document — the goal the cluster is working toward.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "direction_set",
    description:
      "Set the cluster direction (goal document). Agents read this at the start of each iteration. Must be set before calling cluster_start.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        direction: {
          type: "string",
          description: "Markdown text describing what the cluster should do.",
        },
      },
      required: ["direction"],
    },
  },

  // ── Knowledge-base (persistent, shared across all clusters) ──────────────
  // The knowledge-base is a single shared resource. It is NOT scoped by
  // cluster_id — every cluster reads the same knowledge-base. Writes here are
  // a deliberate act; stale or wrong material contaminates every future run
  // across every cluster.
  {
    name: "kb_upload_file",
    description:
      "Upload a single local file into the shared knowledge-base/ directory on S3. The knowledge-base is PERSISTENT and SHARED across all clusters — it survives cluster restarts and every cluster reads from it. Use this ONLY for durable reference material the direction explicitly calls for (schemas, style guides, long-lived specs). For per-run context, use env_upload_file instead.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string", description: "Absolute or relative path to the local file." },
        key: {
          type: "string",
          description: "Destination key within knowledge-base/ (e.g. docs/readme.md). Defaults to the filename.",
        },
      },
      required: ["local_path"],
    },
  },
  {
    name: "kb_upload_folder",
    description:
      "Recursively upload all files in a local folder into the shared knowledge-base/ directory. The knowledge-base is PERSISTENT and SHARED across all clusters. Use this ONLY for durable reference material. For per-run context, use env_upload_folder instead.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string", description: "Absolute or relative path to the local folder." },
        prefix: {
          type: "string",
          description:
            "Optional prefix within knowledge-base/ to nest files under (e.g. project/). Defaults to empty (files go directly under knowledge-base/).",
        },
      },
      required: ["local_path"],
    },
  },
  {
    name: "kb_list",
    description: "List all files currently in the shared knowledge-base (persistent across runs, shared across clusters).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "kb_read",
    description: "Read a single file from the shared knowledge-base (persistent across runs, shared across clusters).",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Key within knowledge-base/ (e.g. docs/readme.md)." },
      },
      required: ["key"],
    },
  },

  // ── Environment (per-run working area, archived on start) ────────────────
  // Default area for agent artifacts and per-run context. Archived to
  // history/<datetime>/ on every cluster_start, so each run begins clean.
  // Per-cluster subfolder layout: environment/{cluster_id}/ is each cluster's
  // primary workspace. Agents may read from or write to any path under
  // environment/ when their direction requires it.
  {
    name: "env_upload_file",
    description:
      "Upload a single local file into the cluster's environment/ directory on S3. Uploads land under environment/{cluster_id}/ (defaulting to environment/cluster_0/ when cluster_id is omitted). This is the per-run working area, preserved across runs (use Clean Environment to archive it). Call AFTER cluster_start so the file lands in the environment before agents boot. Also appends 'Read the environment/ directory first.' to the direction so agents pick it up. Use this for per-run context; use kb_upload_file for durable reference material.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        local_path: { type: "string", description: "Absolute or relative path to the local file." },
        key: {
          type: "string",
          description:
            "Destination key within environment/{cluster_id}/ (e.g. docs/readme.md). Defaults to the filename.",
        },
      },
      required: ["local_path"],
    },
  },
  {
    name: "env_upload_folder",
    description:
      "Recursively upload all files in a local folder into the cluster's environment/ directory. Uploads land under environment/{cluster_id}/ (defaulting to environment/cluster_0/ when cluster_id is omitted). Preserves relative directory structure. environment/ is preserved across runs (use Clean Environment to archive it). Use this for per-run context bundles; use kb_upload_folder for durable reference material.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        local_path: { type: "string", description: "Absolute or relative path to the local folder." },
        prefix: {
          type: "string",
          description:
            "Optional prefix within environment/{cluster_id}/ to nest files under (e.g. project/). Defaults to empty (files go directly under environment/{cluster_id}/).",
        },
      },
      required: ["local_path"],
    },
  },
  {
    name: "env_list",
    description:
      "List files the agents have written to the environment/ directory during the current run. Scoped to the target cluster.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "env_read",
    description:
      "Read a single file from environment/ — either something agents wrote or a context file you uploaded this run.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        key: { type: "string", description: "Full S3 key of the environment file (e.g. environment/cluster_0/summary.md)." },
      },
      required: ["key"],
    },
  },
  {
    name: "env_download_all",
    description:
      "Download environment files as a zip to a local path. When cluster_id is provided, downloads only that cluster's files (environment/{cluster_id}/). When cluster_id is omitted, downloads files from ALL clusters. Returns the path to the written zip file. Useful for pulling agent output to your local machine for review or further processing.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        output_path: { type: "string", description: "Local path to write the zip file. Defaults to ./environment-<cluster_id>.zip in the current directory." },
      },
      required: [],
    },
  },

  // ── Log streaming ────────────────────────────────────────────────────────
  {
    name: "stream_logs",
    description:
      "Fetch the latest agent log entries. Returns immediately with whatever is available. Pass the 'since' timestamp from the previous call to get only new entries. If the cluster state is 'running' or 'starting', call this again after a short wait to continue monitoring. Stop polling when clusterState is 'stopped', 'paused' (no new entries arrive while paused), or all agents show 'idle' as their next_intent.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        since: {
          type: "string",
          description: "ISO timestamp. Only return log entries newer than this. Omit to get the latest entry per agent.",
        },
      },
      required: [],
    },
  },

  // ── Store (post-run analysis) ────────────────────────────────────────────
  {
    name: "store_list",
    description:
      "List agent log files in the store/ directory. Each agent writes an append-only NDJSON file (store/agent-N.ndjson) with one entry per iteration. Use this to discover which agents ran, then use store_read or store_read_all to analyze their behaviour.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "store_read",
    description:
      "Read the full iteration log for a single agent. Returns all NDJSON entries parsed as an array of {ts, iteration, action, result, next_intent} objects. Use this for detailed analysis of one agent's behaviour across iterations.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        key: {
          type: "string",
          description: "S3 key of the agent log file (e.g. store/agent-0.ndjson). Get keys from store_list.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "store_read_all",
    description:
      "Read all agent logs from the last run in one call. Returns every agent's full iteration history plus summary stats (total iterations, total entries). Use this to analyze convergence patterns, divergence, agent coordination, and how the cluster behaved overall.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },

  // ── Map-Reduce ─────────────────────────────────────────────────────────────
  {
    name: "mapreduce_prompt",
    description:
      "Execute a map-reduce operation on kiro-flock agents using natural language. The prompt is interpreted by Bedrock and translated into a structured operation (map directive, clear directive, or reduce query). Results appear in the analyzer tab panel as a 'map/reduce' tab. Use this when you want to target specific agents with instructions, clear per-agent directives, or query/summarize agent activity. Examples: 'Tell idle agents in team-auth to pivot to testing', 'What have agents with >5 iterations produced?', 'Clear all directives in team-platform'.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Natural language instruction or question targeting specific agents. The translation layer resolves cluster names, agent references, and operation type automatically.",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "mapreduce_exec",
    description:
      "Execute a structured map-reduce operation directly, bypassing the natural language translation layer. Use when you already know the exact operation, filter, and parameters. Faster than mapreduce_prompt (skips one Bedrock call). Results appear in the analyzer tab panel as a 'map/reduce' tab.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "object",
          description: "The structured operation to execute.",
          properties: {
            type: {
              type: "string",
              enum: ["map", "map-clear", "reduce"],
              description:
                "map = write per-agent directives. map-clear = remove directives. reduce = query/summarize agent logs.",
            },
            filter: {
              type: "object",
              description: "Agent targeting filter. All fields optional, compose with AND logic.",
              properties: {
                clusters: {
                  type: "array",
                  items: { type: "string" },
                  description: "Cluster IDs to target. Omit for all non-stopped clusters.",
                },
                agentIndexes: {
                  type: "array",
                  items: { type: "number" },
                  description: "Specific agent indexes. Omit for all agents in targeted clusters.",
                },
                actionRegex: {
                  type: "string",
                  description: "Regex to match against agent's last action (e.g. 'idle', 'wrote file').",
                },
                iterationGte: {
                  type: "number",
                  description: "Only agents with iteration count >= this value.",
                },
                iterationLte: {
                  type: "number",
                  description: "Only agents with iteration count <= this value.",
                },
                all: {
                  type: "boolean",
                  description: "Target ALL agents by config concurrency (0 through N-1), including rate-limited agents that haven't produced output yet. Use for map operations to ensure no agent is missed.",
                },
                active: {
                  type: "boolean",
                  description: "Target only agents that have written at least one log entry. Use for reduce operations where you query what agents have done. This is the default behavior when neither all nor active is specified.",
                },
              },
            },
            directive: {
              type: "string",
              description: "For map: the directive text to write to targeted agents.",
            },
            mode: {
              type: "string",
              enum: ["extract", "summarize"],
              description:
                "For reduce: 'extract' returns structured log data (fast, no Bedrock). 'summarize' uses Bedrock to answer a question about the agents.",
            },
            question: {
              type: "string",
              description: "For reduce/summarize: the question to answer about the targeted agents.",
            },
            query: {
              type: "object",
              description: "For reduce/extract: structured query predicates.",
              properties: {
                groupBy: {
                  type: "string",
                  enum: ["agentId", "clusterId", "action", "nextIntent"],
                },
                select: {
                  type: "array",
                  items: { type: "string" },
                  description: "Fields to include in output.",
                },
                where: {
                  type: "object",
                  properties: {
                    actionRegex: { type: "string" },
                    iterationGte: { type: "number" },
                    iterationLte: { type: "number" },
                  },
                },
              },
            },
          },
          required: ["type", "filter"],
        },
      },
      required: ["operation"],
    },
  },
];
