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
      "List all registered kiro-flock clusters and their current states. Use this to discover cluster_ids before targeting a specific cluster with the other tools. Returns the cluster registry (ids, names, algorithms, states, hasAnyDirective, modelOverrideCount \u2014 how many agents run a model other than the cluster baseline). In a single-cluster deployment, this returns one entry for cluster_0.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },

  // ── Cluster lifecycle ────────────────────────────────────────────────────
  {
    name: "cluster_status",
    description:
      "Get the current cluster state (stopped/starting/running/stopping/paused), per-agent last log entry, and CloudWatch metrics. Call this to check if the cluster is running before starting it. The active coordination algorithm is surfaced via the returned `config.algorithm` field (amorphous / mesh / swarm / single). A paused cluster has instances alive but agents parked between iterations — stop polling stream_logs while paused, nothing new will arrive until someone calls cluster_resume. If a start FAILED to launch instances (e.g. InsufficientInstanceCapacity, or any non-throttle RunInstances error), the cluster reads as `stopped` and the failure cause is surfaced here as `lastError` ({ code, message, at }) with `stateReason: \"launch-failed\"`; it is null on a healthy cluster and cleared on the next start. Switching to a different instance type or letting the multi-AZ fallback try another zone usually resolves a capacity failure.",
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
      "Start the kiro-flock cluster. Launches the agent runtimes on the configured compute backend (computeType: Fargate tasks by default, or EC2 instances when \"ec2\"). A direction must be set first (use direction_set). Automatically appends 'Read the environment/ directory first.' to the direction so agents pick up any context files uploaded there. cluster_start does NOT touch environment/ — it only rotates this cluster's agent logs ({cluster_id}/store/) into history/. Environment files persist across restarts, so you can upload context with env_upload before OR after start; they will not be wiped. The launch runs asynchronously: this call returns 202 { status: \"starting\" } immediately and CANNOT report the launch outcome. If the launch fails (e.g. InsufficientInstanceCapacity), the cluster is rolled back to `stopped` with the cause recorded — poll cluster_status and check its `lastError` field to detect a failed launch. A capacity failure is usually fixed by choosing a different instanceType (a different capacity pool); the cluster also falls back across availability zones automatically before giving up.",
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
            computeType: { type: "string", enum: ["ec2", "ecs"], description: "Agent compute backend: \"ecs\" (default, one Fargate ARM64 task per agent, sized via taskSize) or \"ec2\" (one Graviton instance per agent)." },
            instanceType: { type: "string", description: "EC2 instance type (Graviton only, e.g. t4g.medium). Only consulted when computeType is \"ec2\"." },
            taskSize: { type: "string", enum: ["small", "medium", "large", "xlarge"], description: "Fargate task size, only consulted when computeType is \"ecs\": small = 2 vCPU/4 GiB, medium = 4/8 (default), large = 8/16, xlarge = 16/32." },
            loopIntervalSeconds: { type: "number", description: "Seconds between agent iterations" },
            model: {
              type: ["string", "null"],
              description:
                "Cluster-wide baseline model for this start. Omit or set null to use the deployment default. Call models_list for valid ids — they are deployment-specific and an unrecognised value is rejected with the valid set.",
            },
            models: {
              type: "object",
              description:
                "Per-agent model overrides for this start, keyed by agent index as a string: {\"0\": \"some-model-id\", \"3\": null}. Sparse — an agent with no key follows `model`; an explicit null pins that agent to kiro-cli's own default. Resolved at launch so each agent's first iteration already runs its own model. Call models_list first for valid ids.",
            },
          },
        },
      },
      required: [],
    },
  },
  {
    name: "cluster_stop",
    description:
      "Stop the cluster by terminating all agent runtimes (EC2 instances or ECS tasks, per the cluster's computeType). Logs, environment, and knowledge-base remain in S3. Safe to call even if the cluster is already stopped. If you just want to preserve context for a later continuation — without burning EC2 while you inspect state or update the direction — use cluster_pause instead.",
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
      "Get the current cluster configuration (concurrency, neighbourRadius, computeType, instanceType, taskSize, loopIntervalSeconds, model, algorithm, swarmK, autopause, selfOptimizing).",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },
  {
    name: "models_list",
    description:
      "List the models this deployment's agents can run, with display name, description, and context window. Global, not per-cluster — the catalog reflects what the agents' kiro-cli build supports.\n\nCall this BEFORE setting `model` or `models` via cluster_config_set or cluster_start. Model ids are deployment-specific and cannot be guessed; a wrong id is rejected with a 400. Do not use a deliberately-failed config call as a way to discover the valid set.\n\nContext window is worth checking when assigning models per agent: mesh puts every peer's last entry in each agent's prompt, so per-agent context grows with cluster size and a small-context model will overflow on a large mesh flock sooner than on amorphous or single.\n\nReturns `models[]` (each with `model_id`, and usually `model_name`, `description`, `context_window_tokens`) plus `default_model` — the model a null selection resolves to. An empty list means the catalog was never baked (older deployment); model choices are then validated permissively and the agent's own kiro-cli is the final arbiter.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "cluster_config_set",
    description:
      "Update cluster configuration. Nine fields reload dynamically on each running agent's next iteration, no restart needed: `loopIntervalSeconds`, `algorithm`, `swarmK`, `neighbourRadius`, `autopause`, `selfOptimizing`, `browserAutomation`, `model`, `models`. Only `concurrency`, `computeType`, `instanceType` and `taskSize` still require a restart, because they change the agent-slot topology or are properties of the runtime resource itself. Note that `browserAutomation` reloads but a running EC2 agent has no Chromium installed (it is provisioned at boot), so enabling it mid-run only takes effect on Fargate or after a restart on EC2. `algorithm` picks the coordination strategy: \"amorphous\" (ring neighbours at radius R, good for divergent exploration and parallel map at large N), \"mesh\" (every other agent, good for consensus and design decisions, scales badly past ~50 agents because per-agent context fills up), \"swarm\" (K most recently active agents via S3 LastModified, good for ideation and following activity hot spots), \"single\" (lone-agent mode, primarily for specialised roles in WeltenBuilder multi-cluster setups — deployer, reviewer, integration coordinator — alongside flocks running other algorithms; concurrency must be 1, neighbourRadius and swarmK are ignored). `swarmK` is only consulted when algorithm is \"swarm\"; must be 1..concurrency-1. `neighbourRadius` is only consulted when algorithm is \"amorphous\". `selfOptimizing` (default false) is independent of `algorithm` and works identically across all four algorithms and any cluster size: when true, after each iteration every agent appends a self-reflection block to its own per-agent directive file capturing what it learned and how it intends to adjust; the cluster direction is untouched.",
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
            computeType: {
              type: "string",
              enum: ["ec2", "ecs"],
              description: "Agent compute backend: \"ecs\" (default, one Fargate ARM64 task per agent, sized via taskSize) or \"ec2\" (one Graviton instance per agent). Requires a restart.",
            },
            instanceType: { type: "string" },
            taskSize: {
              type: "string",
              enum: ["small", "medium", "large", "xlarge"],
              description: "Fargate task size, only consulted when computeType is \"ecs\": small = 2 vCPU/4 GiB, medium = 4/8 (default), large = 8/16, xlarge = 16/32. Requires a restart.",
            },
            loopIntervalSeconds: { type: "number" },
            model: {
              type: ["string", "null"],
              description:
                "Cluster-wide baseline model. Omit or set null to use the deployment default. Call models_list for valid ids — they are deployment-specific and an unrecognised value is rejected with the valid set. Reloads dynamically between iterations: each iteration spawns a fresh kiro-cli, so a switch takes effect on every agent's next iteration without a restart. Iterations before and after the switch are billed at their own model's rate, so a cluster's running cost total can span two rates. Override individual agents with `models`.",
            },
            models: {
              type: "object",
              description:
                "Per-agent model overrides, keyed by agent index as a string: {\"0\": \"some-model-id\", \"3\": null}. Sparse — an agent with no key follows the cluster-wide `model`; an explicit null pins that agent to kiro-cli's own default, which is a different thing from having no key. Use it to mix a strong anchor node with cheaper explorers. Call models_list first for valid ids; every bad id in the map is reported in one response so you can fix them all at once. Keys beyond concurrency-1 are accepted and sit unused, so overrides can be staged before scaling up. Reloads dynamically between iterations, like `model`.\n\nIMPORTANT: config updates shallow-merge at the top level, so passing `models` REPLACES the whole map rather than adding a key to it. Read the current config first and send the full map when editing.\n\nNote that mixing models makes a cluster's credit total a blend of rates, and in mesh or swarm a weaker node's output enters its peers' context, so quality effects propagate rather than staying local.",
            },
            algorithm: {
              type: "string",
              enum: ["amorphous", "mesh", "swarm", "single"],
              description:
                "Coordination algorithm. amorphous = ring neighbours at radius R. mesh = every other agent. swarm = K most recently active agents. single = lone agent with no peers, primarily for specialised roles in WeltenBuilder multi-cluster setups (deployer, reviewer, integration coordinator) — concurrency must be 1.",
            },
            swarmK: {
              type: "number",
              description: "Peer count for swarm algorithm. 1..concurrency-1. Ignored for other algorithms.",
            },
            selfOptimizing: {
              type: "boolean",
              description: "When true, after each iteration every agent appends a self-reflection block to its own per-agent directive. Cluster direction is untouched. Independent of algorithm — works identically across amorphous, mesh, swarm, and single, and at any cluster size (each agent only writes to its own file). Reloads dynamically between iterations.",
            },
            browserAutomation: {
              type: "boolean",
              description: "When true, agents get a Puppeteer MCP server for headless browser automation. Reloads dynamically between iterations, but on EC2 Chromium is installed at instance boot, so enabling it on a running EC2 cluster needs a restart to be usable. On Fargate it takes effect on the next iteration.",
            },
            everforgeGroup: {
              type: "string",
              description: "Deployment group: the project isolation prefix. When set, the cluster's environment prefix becomes environment/<group>/<clusterId>/ and the deployed/ folder is shared at environment/<group>/deployed/. REQUIRED whenever two or more clusters are started as part of the same piece of work — any multi-cluster deployment (WeltenBuilder teams, a QA or deployer cluster alongside a flock, a continuous deployment loop). Every cluster in such a deployment must carry the SAME value, otherwise the ungrouped ones write to a different prefix and the cross-cluster reads they depend on find nothing. Omitting it is only correct for a genuinely standalone single cluster. Set it before the first cluster_start (it is not a cluster_start override); changing it later does not move files already written under the old prefix. Directions must spell out group-prefixed paths explicitly — agents follow direction paths literally — while env_upload/env_list/env_read resolve the group automatically. Pass null to clear it. (The field name retains a legacy spelling; it is the deployment group for any multi-cluster work.)",
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
    name: "kb_upload",
    description:
      "Upload a local file or folder into the shared knowledge-base/ directory on S3. Auto-detects whether the path is a file or directory. The knowledge-base is PERSISTENT and SHARED across all clusters — it survives cluster restarts and every cluster reads from it. Use this ONLY for durable reference material the direction explicitly calls for (schemas, style guides, long-lived specs). For per-run context, use env_upload instead.",
    inputSchema: {
      type: "object",
      properties: {
        local_path: { type: "string", description: "Absolute or relative path to a local file or folder. Folders are uploaded recursively." },
        key: {
          type: "string",
          description: "Destination key/prefix within knowledge-base/. For a file: defaults to the filename. For a folder: files are nested under this prefix (defaults to root of knowledge-base/).",
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
    name: "env_upload",
    description:
      "Upload a local file or folder into the cluster's environment/ directory on S3. Auto-detects whether the path is a file or directory. Uploads land under environment/{cluster_id}/ (defaulting to environment/cluster_0/ when cluster_id is omitted). This is the per-run working area. Environment files are NOT wiped by cluster_start (only agent logs under {cluster_id}/store/ are rotated), so you can upload before OR after start — uploads persist across restarts. They are only cleared by an explicit clean-env action. Appends 'Read the environment/ directory first.' to the direction so agents pick it up. Use this for per-run context; use kb_upload for durable reference material.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        local_path: { type: "string", description: "Absolute or relative path to a local file or folder. Folders are uploaded recursively." },
        key: {
          type: "string",
          description:
            "Destination key/prefix within environment/{cluster_id}/. For a file: defaults to the filename. For a folder: files are nested under this prefix (defaults to root of environment/{cluster_id}/).",
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
  {
    name: "env_delete",
    description:
      "PERMANENTLY delete a cluster's environment folder from S3. Unlike the dashboard's archive action there is NO copy to history/ — deleted files are gone for good. Deletes are pure metadata operations (batched DeleteObjects), so even large trees clear in seconds. Targets environment/{cluster_id}/ (group-aware when the cluster has an everforgeGroup), or an explicit `folder` prefix when provided. The bare environment/ root is rejected by the backend — there is deliberately no delete-all tool; to clear everything, list clusters with clusters_list and delete their environments one by one. Consider env_download_all first if the contents might still be needed.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        folder: {
          type: "string",
          description:
            "Optional explicit folder prefix to delete instead of the cluster's own env folder (e.g. environment/my-group/dev-fe/ or environment/deployed/). Must start with environment/ and must not be the bare root.",
        },
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
      "List agent log files in the store/ directory. Each agent writes an append-only NDJSON file (store/agent-N.ndjson) with one entry per iteration. Use this to discover which agents ran, then use store_read or store_read_all to analyze their behaviour. When the live store is empty (the cluster was stopped or restarted, which rotates logs into history/), the listing falls back to the newest history/ archive automatically — such entries carry an `archivedRun` field and their keys point into history/, and they work with store_read unchanged.",
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
      "Read all agent logs from the last run in one call. Returns every agent's full iteration history plus summary stats (total iterations, total entries) and a `source` field. Use this to analyze convergence patterns, divergence, agent coordination, and how the cluster behaved overall. Works after the run has ended: when the live store is empty (stop/restart rotates logs into history/), it reads the newest history/ archive instead and `source` names that archive — post-run analysis does not require a running cluster.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
      },
      required: [],
    },
  },

  // ── ACP session streaming ──────────────────────────────────────────────────
  {
    name: "list_acp_sessions",
    description:
      "List available ACP session files on an agent's EC2 instance. Returns session IDs, sizes, and whether each is active (in-progress) or completed, ordered newest first. Use this to discover which iterations are available before calling stream_acp with an offset.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        agent_index: {
          type: "number",
          description: "Which agent in the cluster (default: 0).",
        },
      },
      required: [],
    },
  },
  {
    name: "stream_acp",
    description:
      "Retrieve the full ACP session transcript from a running or recently-completed agent iteration. Returns the agent's conversation formatted as readable markdown, showing the prompt, assistant responses, tool calls, and tool results. Retrieves both the current in-progress iteration (if any) and the most recent completed iteration. Uses SSM RunCommand to read session files directly from the EC2 instance.\n\nIMPORTANT: Do NOT call stream_acp multiple times in parallel. Each call issues many concurrent SSM commands to read the full session (~20+ chunked reads). Running multiple stream_acp calls simultaneously will overwhelm SSM rate limits and cause timeouts. Call them sequentially, one at a time.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        agent_index: {
          type: "number",
          description: "Which agent in the cluster (default: 0).",
        },
        offset: {
          type: "number",
          description: "How many completed iterations to skip back (default: 0 = most recent completed). Use 1 for the one before that, 2 for two back, etc. The active in-progress session is always shown regardless of offset.",
        },
      },
      required: [],
    },
  },

  // ── Map-Reduce ─────────────────────────────────────────────────────────────
  {
    name: "mapreduce_prompt",
    description:
      "Execute a map-reduce operation on kiro-flock agents or on the files they produced, using natural language. The prompt is interpreted by Bedrock and translated into a structured operation. Results appear in the analyzer tab panel as a 'map/reduce' tab, and the resolved `target` is echoed so you can spot a misroute.\n\nTwo things can be addressed, and the translator picks based on the prompt. Agent questions read activity logs and per-agent directives, and can also write instructions: 'Tell idle agents in team-auth to pivot to testing', 'What have agents with >5 iterations produced?', 'Clear all directives in team-platform', 'Show me all individual directions across the running clusters'. File questions scan the flock's actual output in S3 (source code, markdown, configs) and are read-only: 'Are there any TODOs left in the code?', 'Which files import axios?', 'How many files has team-auth written?', 'Is the error handling in the generated code sound?'.\n\nQuestions whose predicate is file content but whose grouping is agents also work: 'Show me agents who used while loops' scans the code and then correlates matching files back to agents. That correlation is best effort, because environment/ is a shared prefix with no agent index in the path, so files whose author never named them in a log come back under 'unattributed'. For exact attribution, map a directive asking agents to self-report, then reduce over their logs.",
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
      "Execute a structured map-reduce operation directly, bypassing the natural language translation layer. Use when you already know the exact operation, filter, and parameters. Faster than mapreduce_prompt (skips one Bedrock call). Results appear in the analyzer tab panel as a 'map/reduce' tab.\n\nSet `target` to choose what the operation addresses. `\"agents\"` (default) works on agent activity logs and per-agent directives, and supports map/map-clear/reduce. `\"files\"` scans the flock's actual work product in S3 (source code, markdown, configs under environment/, optionally knowledge-base/) and is READ-ONLY: only reduce is accepted, with targeting in `fileFilter` and shaping in `fileQuery`. Listing is uncapped and paginated, so scans over thousands of files are fine; omitting `contentRegex` answers corpus-shape questions from LIST metadata alone with zero object reads. Use `fileQuery.groupBy: \"agent\"` for questions whose predicate is file content but whose grouping is agents (\"which agents used while loops\") — the engine correlates matched files back to agents via file-path mentions in their logs, which is best effort because environment/ is a shared prefix with no agent index in the path.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "object",
          description: "The structured operation to execute.",
          properties: {
            target: {
              type: "string",
              enum: ["agents", "files"],
              description:
                "What the operation addresses. \"agents\" (default) = agent logs and directives, supports all operation types. \"files\" = content scan over the flock's S3 output, read-only (reduce only).",
            },
            type: {
              type: "string",
              enum: ["map", "map-clear", "reduce"],
              description:
                "map = write per-agent directives. map-clear = remove directives. reduce = query/summarize. With target \"files\", only reduce is valid.",
            },
            filter: {
              type: "object",
              description: "Agent targeting filter, used when target is \"agents\". All fields optional, compose with AND logic. When target is \"files\", only `clusters` is honoured (inherited by fileFilter if it omits its own).",
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
            fileFilter: {
              type: "object",
              description:
                "File targeting, used when target is \"files\". All fields optional, compose with AND logic. Every field except contentRegex is satisfied from S3 LIST metadata, so a filter without contentRegex performs zero object reads.",
              properties: {
                clusters: {
                  type: "array",
                  items: { type: "string" },
                  description: "Restrict to these clusters' environment folders. Omit to scan the whole shared environment/ root across all clusters. Handles both the ungrouped and grouped (deployment group) layouts.",
                },
                scope: {
                  type: "array",
                  items: { type: "string", enum: ["environment", "knowledge-base"] },
                  description: "Top-level prefixes to scan. Defaults to [\"environment\"] (the flock's own output). Add \"knowledge-base\" only when you mean the shared durable reference material.",
                },
                pathGlob: {
                  type: "string",
                  description: "Glob over the object key. Supports **, *, ?, and {a,b} braces. Matched against both the full key and the key relative to the scope prefix, so \"**/*.ts\" and \"final/**\" both behave as expected. Use it to narrow file types before a content scan.",
                },
                contentRegex: {
                  type: "string",
                  description: "Regex matched against file content, case-insensitive. The only field that triggers object reads. Example for while loops: \"\\\\bwhile\\\\s*\\\\(\".",
                },
                modifiedAfter: {
                  type: "string",
                  description: "ISO-8601 instant. Keep only objects modified strictly after this. Free — comes from the LIST response.",
                },
                maxBytesPerFile: {
                  type: "number",
                  description: "Per-file read cap in bytes (default 262144). Larger files are scanned up to the cap and flagged `truncated` in the result rather than silently half-scanned.",
                },
              },
            },
            fileQuery: {
              type: "object",
              description: "Output shaping for a file reduce. Used only when target is \"files\".",
              properties: {
                groupBy: {
                  type: "string",
                  enum: ["file", "cluster", "directory", "extension", "agent"],
                  description:
                    "How to group matched files. \"file\" (default) = one group per file. \"agent\" additionally correlates each matched file back to the agents whose logs reference it, adding an `unattributed` group for files no log mentions — use this when the question is phrased in terms of agents. \"cluster\"/\"directory\"/\"extension\" are aggregate views.",
                },
              },
            },
            directive: {
              type: "string",
              description: "For map: the directive text to write to targeted agents. Not valid with target \"files\".",
            },
            mode: {
              type: "string",
              enum: ["extract", "summarize"],
              description:
                "For reduce: 'extract' returns structured data (fast, no Bedrock). 'summarize' uses Bedrock to answer a question. With target \"files\", summarize consumes the match set rather than raw file contents, so it stays within context even on large scans.",
            },
            question: {
              type: "string",
              description: "For reduce/summarize: the question to answer about the targeted agents or files.",
            },
            query: {
              type: "object",
              description: "For reduce/extract: structured query predicates.",
              properties: {
                groupBy: {
                  type: "string",
                  enum: ["agentId", "clusterId", "action", "nextIntent"],
                  description: "Grouping for an agents reduce/extract. For file scans use fileQuery.groupBy instead.",
                },
                select: {
                  type: "array",
                  items: { type: "string" },
                  description: "Fields to include in output. Supported names: \"agentId\", \"clusterId\", \"directive\" (per-agent directive markdown, null when none), plus any field on a log entry (\"action\", \"result\", \"next_intent\", \"iteration\", \"ts\").",
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
          required: ["type"],
        },
      },
      required: ["operation"],
    },
  },

  // ── Deployment flow (operator-side) ─────────────────────────────────────
  // Trust is decided at cluster config time via `trustDeploy` — there is no
  // runtime approval flow. Clusters started with trustDeploy deploy
  // immediately; clusters without it get a terminal deploy_disabled from the
  // agent-side deploy MCP. These tools browse and write deployment records.
  {
    name: "deploy_record_list",
    description:
      "List deployment records filtered by systemname. Returns records from environment/deployed/ whose systemname matches. If no systemname is provided and the cluster has no configured systemname, returns an empty list.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        systemname: {
          type: "string",
          description: "System name to filter by. If omitted, uses the cluster's configured systemname.",
        },
      },
      required: [],
    },
  },

  {
    name: "deploy_record_write",
    description:
      "Record a deployment performed by the local user. Writes deployed/latest.json and appends to deployed/changelog.md using the same structure remote cluster agents use. Also writes a deployment-{systemname}.md record file. Use after a successful local cdk deploy or s3 sync to keep the Continuous Deployments view and other clusters informed.",
    inputSchema: {
      type: "object",
      properties: {
        cluster_id: { type: "string", description: CLUSTER_ID_DESCRIPTION },
        systemname: {
          type: "string",
          description: "System name for the deployment (e.g. 'my-app'). Used in file paths and record metadata.",
        },
        stackName: {
          type: "string",
          description: "CloudFormation stack name that was deployed.",
        },
        url: {
          type: "string",
          description: "Primary URL of the deployed application (e.g. API Gateway or CloudFront URL).",
        },
        changelog_entry: {
          type: "string",
          description: "Human-readable description of what changed in this deployment. Appended to changelog.md.",
        },
        status: {
          type: "string",
          description: "Deployment status (default: 'UPDATE_COMPLETE').",
        },
        region: {
          type: "string",
          description: "AWS region of the deployment.",
        },
        deploymentTime: {
          type: "string",
          description: "How long the deployment took (e.g. '42.5s').",
        },
        outputs: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "CloudFormation stack outputs as key-value pairs.",
        },
      },
      required: ["systemname", "stackName", "url", "changelog_entry"],
    },
  },

  {
    name: "deploy_destroy",
    description:
      "Destroy the CloudFormation stack backing a deployment group — the same action as the Destroy button on the Continuous Deployments screen. Irreversible: the stack and all its resources are deleted. Two-step guard: call WITHOUT `confirm` first to get the stack name, its current status, and whether any deployer cluster for the group is still running (a running deployer may simply redeploy the stack afterwards — destruction is allowed regardless, but you should know). Then call again with confirm set to the exact phrase \"goodbye <stackName>\" to execute. Deployment records under environment/ (latest.json, changelog) are kept as the audit trail; remove them separately with env_delete if wanted.",
    inputSchema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          description:
            "Deployment group name (the cluster config's everforgeGroup). Omit for the ungrouped default deployment (environment/deployed/).",
        },
        confirm: {
          type: "string",
          description:
            "Confirmation phrase, exactly \"goodbye <stackName>\" (stack name as returned by the first call). Omit to preview what would be destroyed without deleting anything.",
        },
      },
      required: [],
    },
  },

  // ── Coder (local IDE sync with cluster environment) ────────────────────────
  {
    name: "coder_attach",
    description:
      "Attach to a group's entire environment on S3. Downloads environment/<group>/ (all clusters, deployed folder, everything) into the specified local path. Open that folder in your IDE to code alongside the clusters.",
    inputSchema: {
      type: "object",
      properties: {
        group: {
          type: "string",
          description: "Deployment group name (the cluster config's everforgeGroup). The S3 prefix will be environment/<group>/.",
        },
        path: {
          type: "string",
          description: "Local directory to download into. The group's files will be placed directly inside this folder.",
        },
      },
      required: ["group", "path"],
    },
  },
  {
    name: "coder_pull",
    description:
      "Pull latest changes from S3 into the local working copy. Downloads new/changed remote files, deletes locally files that were removed remotely. Refuses to overwrite local files that have unsaved changes (reports conflicts).",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "coder_push",
    description:
      "Push local changes to S3. Uploads new/modified local files, deletes remote files that were removed locally. Refuses to overwrite remote files that changed since last sync (reports conflicts with diffs). Optionally writes a changelog entry so agents know what you changed.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "Optional changelog message describing what you changed and why. Written to coder-log.md so agents can read it.",
        },
      },
      required: [],
    },
  },
  {
    name: "coder_status",
    description:
      "Show sync status: local changes not yet pushed, remote changes not yet pulled, and conflicts where both sides changed the same file.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "coder_log",
    description:
      "Write a message to the shared coder-log.md on S3. Agents read this to understand what the human developer is working on. Use this to announce intent, describe ongoing work, or flag things agents should be aware of. Does not require a push.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "What you want the agents to know. Be specific about files, intent, and any constraints.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "coder_detach",
    description:
      "Detach from the current cluster. Clears sync state but leaves local files intact so you can keep editing or re-attach later.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
];
