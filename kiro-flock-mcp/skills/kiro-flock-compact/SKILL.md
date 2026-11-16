---
name: kiro-flock-compact
description: Complete kiro-flock orchestration in one skill - single clusters, multi-cluster WeltenBuilder deployments, and continuous deployment (the persistent build/test/deploy/evolve loop). Covers algorithm selection, cluster configuration, direction writing, cross-cluster coordination, deployment, and result retrieval. Use for any kiro-flock task.
---

# Kiro-Flock Orchestration (Compact)

One skill for all kiro-flock work. Routing:

- **Single cluster** (one flock, one direction): read sections 1-4.
- **Multi-cluster / WeltenBuilder** (teams, QA, coordinator): add section 5.
- **Continuous deployment** (persistent build/test/deploy/evolve loop): add sections 6-8.
- **Checklists** for every launch: section 9.

Every rule appears exactly once. Rules marked **HARD RULE** are non-negotiable learnings from real failures.

**Read this before launching anything:** if the work involves more than one cluster, it needs a shared deployment group (1.2, 5.2). That applies to every multi-cluster shape.

**HARD RULE: always pass an explicit, named `cluster_id` on every MCP call. Never use `cluster_0`.** Every cluster tool defaults to `cluster_0` when `cluster_id` is omitted — that default exists only for backward compatibility with ancient single-cluster deployments and must never be relied on. Omitting the parameter silently targets `cluster_0`: directions land on the wrong cluster, starts launch the wrong thing, and its leftover S3 state (`cluster_0/store/`, `environment/cluster_0/`) bleeds into whatever runs there next. Before any work, register or pick a descriptively named cluster (`{role}-{domain}`, e.g. `team-auth`, `qa-integration`, `greenthumb-deployer`) and pass that id on **every** call — including reads like `cluster_status`, `stream_logs`, `store_read_all`, and `env_list`, not just writes.

---

## 1. Core Mechanics

### 1.1 Environment vs knowledge-base

| Area | S3 prefix | Lifetime | Use for |
|------|-----------|----------|---------|
| Environment | `environment/` | Per project; NOT cleaned on `cluster_start` | Almost everything: context files, specs, schemas, templates, all agent output |
| Knowledge-base | `knowledge-base/` | Permanent, global, cross-project | Steering docs only: coding standards, style guides, compliance rules |

- `cluster_start` archives agent logs (`{clusterId}/store/`) to `history/` but **preserves the environment**. Restarting without cleaning means agents see leftover files. To get a fresh slate, clean the environment first (UI "Clean Environment", per-folder clean buttons, or `POST /cluster/clean-env-folder` with `{ folder: "environment/<name>/" }`).
- Never put project-specific context (specs, schemas, requirements) in the knowledge-base. It contaminates every future cluster.

### 1.2 S3 path layout

| Configuration | Cluster workspace | Deployed folder |
|---|---|---|
| Grouped (`everforgeGroup: "my-project"`) | `environment/my-project/<clusterId>/` | `environment/my-project/deployed/` |
| Standalone (no `everforgeGroup`) | `environment/<clusterId>/` | `environment/deployed/` |

The config key is spelled `everforgeGroup` for backward compatibility; the concept is the **deployment group**, and it applies to all multi-cluster work rather than to any one pattern.

**HARD RULE: any deployment of more than one cluster is a group.** If two or more clusters are started as part of the same piece of work — WeltenBuilder teams, a QA cluster next to a dev cluster, a deployer beside a flock, anything that coordinates through the shared environment — every one of them sets the **same** `everforgeGroup`. Groupless is reserved for a genuinely standalone single cluster, and even then a group is the safer default (see 2.0).

Grouping is what keeps concurrent projects from colliding: without it every cluster writes into the same flat `environment/` root and shares one `environment/deployed/`, so two unrelated deployments overwrite each other's `latest.json` and each other's files.

`everforgeGroup` is set with `cluster_config_set` **before** `cluster_start` — it is not among the `cluster_start` config overrides. Pass `null` to clear it. Changing it on a cluster that has already written files does not move those files; the old prefix is simply abandoned, so set it at creation time, not mid-run.

Both layouts coexist in one bucket. `env_upload`, `env_list` and `env_read` resolve the group from the cluster's config automatically, so operator-side calls need no prefix — the manual part is the paths you write into directions (5.2). Cluster IDs become literal S3 folder names, so meaningful IDs make cross-cluster paths readable.

### 1.3 Agent access

Every agent can read and write **all** of `environment/` (every cluster's folder), read `knowledge-base/`, read/write its own `{clusterId}/store/`, and read `store/approvals/` (the trust markers the deploy MCP checks). Cross-cluster coordination works by reading other clusters' environment folders directly. Agents can delete files with `s3_delete`, but only under `environment/`. `s3_sync_local` materialises a whole S3 prefix under `~/kiro-flock-workspace/` without pulling contents into context — use it whenever many files are needed locally.

Delete when: compiled .ts sources duplicate .js output (breaks deployers), renamed files leave stale paths, build intermediates shouldn't ship. Don't delete: other clusters' files (unless directed), anything outside `environment/`, or as a "refresh" (just overwrite).

### 1.4 Picking an algorithm

| Algorithm | Each agent reads | Best for | Comfortable size | Cap reason |
|-----------|-----------------|----------|------------------|------------|
| amorphous | 2R fixed ring neighbours | Parallel map, divergent exploration, large N | 8-500 (1000+ possible) | Infrastructure only |
| mesh | Every other agent's last entry | Consensus, design decisions | 8-30 (max ~50) | Context fills linearly with N |
| swarm | K most recently active peers | Ideation, following activity | 20-100 | Collapses onto hot spots; raise K to mitigate |
| single | Nothing (direction + own log) | Specialised roles (deployer, reviewer); long-running solo workers | 1 | By definition |

Pick the algorithm for the workload first, then size to its comfortable range. Amorphous signals propagate slowly (`ceil(N / 2R)` iterations around the ring) — a feature for independence. Swarm's prompt asks agents to follow, diverge, or anchor, preventing collapse. Single is a role, not a scale-down tier.

A productive combo: start amorphous to explore, flip to swarm when a direction forms, finish mesh to align. Algorithm changes reload on the next agent iteration, no restart.

**HARD RULE: always set `algorithm` and `concurrency` in the same `cluster_config_set` call.** The API validates them together atomically; splitting them causes 400 errors (e.g. `single` requires `concurrency: 1`).

### 1.5 Configuration reference

| Parameter | Default | Notes |
|---|---|---|
| `everforgeGroup` | none | Deployment group / project isolation prefix (1.2). **Mandatory, and identical, on every cluster of any multi-cluster deployment.** Set before first start; not a `cluster_start` override. |
| `concurrency` | - | Match task parallelism. 5-8 typical, 12-16 large maps. Restart-only. |
| `neighbourRadius` | 1 | See ratio table (2.1). Reloads live. |
| `loopIntervalSeconds` | 30 | The GAP between iterations, not a period — iterations themselves take minutes. 15s fast consensus, 60s deep research. Set from measured cost, not aspiration: each cost line in `{cluster}/store/agent-N.costs.ndjson` carries `durationMs` (iteration wall time); if directions demand heavy per-iteration work (full builds, exports), a short interval buys nothing and misstates the cadence. Reloads live. |
| `algorithm` | amorphous | Reloads live. Pair with concurrency in same call. |
| `swarmK` | - | Swarm only, 1..concurrency-1. Reloads live. |
| `selfOptimizing` | false | Reloads live. See 1.6. |
| `browserAutomation` | false | Puppeteer MCP for agents. Reloads live, but on `ec2` Chromium is installed at instance boot — enabling it mid-run only works on `ecs`. |
| `trustDeploy` | false | Whether this cluster may deploy at all. The only deploy gate — there is no runtime approval. Applied on next start. |
| `autopause` | true | Pauses the cluster when all visible agents (self + neighbours; every agent in mesh) idle 3 consecutive iterations. Reloads live. |
| `computeType` | ecs | Restart-only. `ecs` = one Fargate ARM64 task per agent (fast startup, ~1 min); `ec2` = one Graviton instance per agent (slower boot, but per-agent CloudWatch CPU/net metrics). |
| `taskSize` | medium | Restart-only. ECS only: small 2vCPU/4GiB, medium 4/8, large 8/16, xlarge 16/32. The ECS mirror of `instanceType`. |
| `instanceType` | t4g.medium | Restart-only. EC2 only. c8g.large for CPU-heavy roles (deployers). |
| `model` | deployment default | Cluster-wide baseline. Reloads live — a fresh kiro-cli is spawned per iteration. **Call `models_list` for valid ids.** Iterations either side of a switch bill at their own model's rate. |
| `models` | none | Per-agent overrides, `{"0": "id", "3": null}`. Reloads live. See 1.5.1. |

Default concurrency is capped at 64; scaling to 1000+ needs explicit quota and cap bumps. `cluster_start` fails without a prior `cluster_config_set` and `direction_set` — no implicit defaults are created.

#### 1.5.1 Model selection

**Always call `models_list` before setting `model` or `models`.** Model ids are deployment-specific and cannot be guessed — the catalog reflects what the agents' kiro-cli build supports. `models_list` also returns each model's context window and description, which is what makes the choice a decision rather than a coin flip. Do not use a deliberately-failed `cluster_config_set` to discover the valid set.

`model` is the cluster baseline. `models` overrides individual agents, keyed by agent index as a string:

```
cluster_config_set({ config: {
  model: "<cheap-model-id>",
  models: { "0": "<strong-model-id>" }
}})
```

That gives one strong anchor node and a flock of cheaper explorers. Three states, and the difference matters:

- **key absent** — that agent follows the cluster `model`.
- **key set to a model id** — that agent runs that model.
- **key set to `null`** — that agent is pinned to kiro-cli's own default, *ignoring* the cluster model. Not the same as absent.

An object, not an array, precisely because `null` is already meaningful and an array has no way left to say "no override for this agent".

Both fields reload on each agent's next iteration, so you can retarget a single node mid-run without a restart. Keys beyond `concurrency - 1` are accepted and sit unused, so overrides can be staged before scaling up.

**Config updates shallow-merge at the top level, so passing `models` REPLACES the whole map.** To add one override to an existing set, `cluster_config_get` first and send the full map back. Omitting `models` entirely leaves it untouched.

Two consequences of a heterogeneous flock worth weighing. Cluster credit totals become a blend of rates, so `totalCredits` no longer maps to a single price. And in mesh or swarm a weaker node's output enters its peers' context, so quality effects propagate rather than staying local — that is the point if you are deliberately mixing an anchor with explorers, but it means cross-node log comparison stops being apples to apples. Amorphous at low radius and `single` contain the effect best.

Where overrides show up: a muted model pill on each overridden agent's dashboard panel and in the per-node view header, a `+N overridden` note beside the cluster model picker, and an `N mixed models` pill on the WeltenBuilder cluster card. `clusters_list` reports `modelOverrideCount` per cluster.

**Compute choice:** ECS Fargate is the default and right for most flocks (much faster cluster starts). Pick `ec2` when you need per-agent CloudWatch metrics in the dashboard (Fargate panels show empty metrics) or a specific Graviton instance profile. CPU-heavy single-role clusters (deployers running npm install + cdk deploy) want `ec2` + `instanceType: c8g.large` or `ecs` + `taskSize: large`.

**Cost visibility:** `cluster_status` and `cluster_list` carry `totalCredits` (lifetime AI credit spend, dollars at the overage rate) and `infraCostUsd` (current-run EC2/Fargate cost from deploy-time pricing). The dashboard shows both everywhere as `ai[cr, $] / infra[$]`. Stopped clusters report null infra cost; only non-stopped clusters count toward board totals.

**Pause/resume:** `cluster_pause` parks a running flock between iterations (compute stays up — and keeps billing — with no new log entries; check `cluster_status`, don't poll `stream_logs`). Use to inspect state or update direction, then `cluster_resume`. `cluster_stop` terminates the runtimes.

### 1.6 Self-optimization

`selfOptimizing: true` makes each agent append a short reflection to its own per-agent directive (`{cluster}/store/agent-N.directive.md`) after each iteration (capped at 10 entries). Cluster direction untouched. Cost is per-agent constant regardless of cluster size. Use for long runs where agents should develop specialised approaches. **Keep it OFF for mechanical roles (deployers) — it learns "efficiency shortcuts" that break unconditional rules.** Inspect directives via the dashboard directive pill or `mapreduce_prompt("show me all individual directions")`.

### 1.7 Local execution on the agent runtime (secondary, not default)

Agents have `~/kiro-flock-workspace/` for local work. S3 is the working tree; local disk is ONLY for compiling, running tests, or executing code to verify it works. Local files are invisible to other agents and destroyed on stop. Agents must log local operations to `local-ops-log.md` in their S3 environment before executing, and write meaningful results back to S3. The AWS CLI is available and NOT restricted — be careful what directions ask for.

To grant it in a direction, keep it brief:

```markdown
## Verification
You may use ~/kiro-flock-workspace/ to compile or run code locally for verification.
Log every local operation to local-ops-log.md first. Write results back to S3.
```

---

## 2. Single-Cluster Patterns

### 2.0 Grouping a standalone cluster

A single cluster that stands alone is the one case where `everforgeGroup` may be omitted. Set one anyway if the work might grow a second cluster — a QA pass, a deployer, a consolidation flock. Retrofitting a group later relocates every path in every direction and orphans everything already written under the old prefix, whereas starting grouped costs nothing. The moment a second cluster joins the work, the group stops being optional (1.2).

### 2.1 Agent count to radius ratios (amorphous)

Each agent observes 2R neighbours. The r/n ratio trades propagation speed against diversity.

| Strategy | Agents | Radius | r/n | Why |
|----------|--------|--------|-----|-----|
| Parallel map | 8-16 | 1 | 0.06-0.12 | Minimal coordination; agents self-assign slices |
| Self-correcting | 6-10 | 2 | 0.20-0.33 | Overlap catches errors without suppressing novelty |
| Divergent ideation | 8-12 | 1 | 0.08-0.12 | Low radius preserves diversity |
| Context expansion | 10-16 | 2 | 0.12-0.20 | Adjacent agents build on findings without global convergence |
| Consensus | 4-8 | 2-3 | 0.25-0.75 | Near-broadcast for fast agreement |

Rules: r/n < 0.15 = high diversity, slow convergence. 0.15-0.30 = balanced. > 0.30 = fast convergence, low diversity. **Never set radius >= N/2** (destroys locality, causes identical output). Radius 1 is the safe default.

Propagation: information travels R hops per iteration; full ring traversal takes `ceil(N / 2R)` iterations. To guarantee all agents see an update within K iterations: `R >= ceil(N / 2K)`. Idle also propagates at this speed (quorum sensing: agents go idle when visible neighbours are idle).

### 2.2 Running and retrieving

Polling loop: `stream_logs` → break when clusterState is "stopped"/"paused" or all agents idle 2+ consecutive iterations → `cluster_stop`. Poll every 30s (15s consensus, 60s deep research).

Retrieval sequence: `stream_logs` (confirm convergence) → `env_list` (never assume filenames) → `env_read` each artifact → `kb_list`/`kb_read` if relevant → `cluster_stop`.

| Workload | What to read | When |
|---|---|---|
| Parallel map | All environment files, merge | After all agents idle |
| Self-correcting | Latest version only (last write wins) | After convergence |
| Divergent ideation | All unique files | After 2-3 iterations, BEFORE convergence |
| Context expansion | knowledge-base + environment | After idle |
| Consensus | The file 3+ agents reference in logs | After 5-7 iterations |

Consensus detection: 3+ agents performing the same `action` = convergence cluster; their `result` fields point to the authoritative output. Upload templates via `env_upload` for predictable output structure.

### 2.3 Direction-design levers (amorphous computing)

- **Gradient distribution:** enumerate subtasks explicitly in the direction ("process files A-Z"); agents distribute by observing neighbours' claims. Feed context early so gradients form on iteration 1.
- **Phased direction:** start broad ("research X"), converge, then narrow via `direction_set` ("implement Y from the research"). Direction changes propagate instantly (all agents read direction.md every iteration).
- **Redundancy is a feature:** 2-3 agents on the same subtask confirms correctness and self-corrects outliers. Design for idempotent contributions (last-write-wins or additive files); don't demand unique output per agent.
- **Stigmergy:** agents coordinate through shared artifacts, not messages. Seed a plan.md/status.md in fed context; structure directions so intermediate results are buildable-on.
- **Hot-spot fix:** if all agents converge on one subtask, update the direction mid-run ("spread out", enumerate unclaimed work). Self-corrects within 2 iterations.

### 2.4 Workflow examples

Parallel map (review N files):
```
direction_set: "Review each file in environment/context/. Write findings to
environment/review-<filename>.md. Check neighbours to avoid duplicates."
cluster_config_set: { concurrency: 8, neighbourRadius: 1, algorithm: "amorphous" }
env_upload: ./files-to-review -> environment/context/
cluster_start → poll → env_read all reviews → cluster_stop
```

Consensus and ideation follow the same shape; only config (2.1) and the read-timing (2.2) differ.

### 2.5 Quick reference

| Workload | Agents | Radius | Iterations to converge |
|----------|--------|--------|------------------------|
| Parallel map | 8 | 1 | 3-5 |
| Self-correcting | 6 | 2 | 5-7 |
| Ideation | 10 | 1 | 4-6 |
| Research | 10 | 2 | 5-8 |
| Consensus | 8 | 3 | 5-7 |

---

## 3. Post-Run Analysis

After a run, `store_read_all` loads every agent's full NDJSON log. Entry fields: `iteration` (group by this), `action` (repeated across agents = overlap), `result` (convergence on same file), `next_intent` ("idle" = done), `ts` (compute productive duration from first/last).

For mid-run debugging of a single agent's reasoning, `stream_acp` returns the full Kiro session transcript (prompt, tool calls, results) for the current and most recent iteration; `list_acp_sessions` lists available sessions. Call `stream_acp` sequentially, never in parallel (it issues many SSM reads).

Analyse in phases and write a "Work Log" report:

- **Iteration 0 (land grab):** no neighbour context yet. Count task overlap vs unique claims; overlap should match r/n (low radius = more overlap).
- **Iteration 1+ (gap filling):** agents see neighbours. Look for missing tasks picked up, overlappers diverging, unique catches (bugs, edge cases others missed).
- **Convergence:** iteration where 3+ agents share an `action`; note dissenting agents and how long they held out.
- **Idle propagation:** first idle agent → all idle; compare to theoretical `ceil(N / 2R)`. Note any agent breaking idle for a self-correction pass.
- **Standouts:** name agents that caught bugs, uniquely claimed tasks, produced the consensus artifact, or dissented correctly.

Adapt section names to what actually happened (divergence instead of convergence, timeout instead of idle).

---

## 4. Agentic Map-Reduce

Fine-grained control, cross-cluster capable. Two tools:

- **`mapreduce_prompt`** — natural language, Bedrock translates. Use when you don't know exact filter criteria.
- **`mapreduce_exec`** — structured, skips translation, faster. Use when you know the operation.

### 4.1 Pick the target first

`target` decides what the operation addresses. It defaults to `"agents"`.

| `target` | Data | Operations |
|---|---|---|
| `"agents"` (default) | Each agent's NDJSON log (`action`/`result`/`next_intent`/`iteration`) and its per-agent directive | map, map-clear, reduce |
| `"files"` | The work product itself — code, markdown, configs under `environment/`, optionally `knowledge-base/` | **reduce only, read-only** |

Choose by what the question is *about*, not how it's phrased. Agent logs contain no source code, so a question about code is unanswerable with `target: "agents"`, and vice versa.

- Behaviour, progress, state, sending instructions → `agents`. ("who is idle", "are they converging", "tell them to write tests")
- Content of what they produced → `files`. ("any TODOs left", "which files import axios", "how many files did team-auth write")

**Crossover case:** predicate is content, grouping is agents ("show me agents who used while loops"). Use `target: "files"` with `fileQuery.groupBy: "agent"`.

### 4.2 Agents target

Map writes a directive to `{clusterId}/store/agent-{N}.directive.md`. Directives take priority over the cluster direction where they conflict, coexist with it otherwise, and **persist until cleared** (`map-clear`).

`filter` composes with AND: `clusters`, `agentIndexes`, `actionRegex` (matches last action), `iterationGte`/`iterationLte`, `all` (every agent by concurrency, incl. rate-limited ones — use for map), `active` (only agents with log entries — the default, use for reduce).

### 4.3 Files target

Read-only. `map` and `map-clear` are rejected — use `env_upload` to place files in the environment.

`fileFilter` composes with AND:

| Field | Notes |
|---|---|
| `clusters` | Scopes to those clusters' environment folders. Omit for the whole shared `environment/` root. Handles both the ungrouped and grouped layouts. |
| `scope` | `["environment"]` (default) and/or `["knowledge-base"]`. |
| `pathGlob` | `**`, `*`, `?`, `{a,b}`. Matched against the full key and the key relative to the scope prefix, so `**/*.ts` and `final/**` both work. |
| `contentRegex` | Case-insensitive. **The only field that reads objects.** |
| `modifiedAfter` | ISO-8601. Free, comes from the listing. |
| `maxBytesPerFile` | Default 256KB; larger files are flagged `truncated`. |

`fileQuery.groupBy`: `file` (default), `cluster`, `directory`, `extension`, `agent`.

Cost model worth internalising: **listing is uncapped, reads are bounded.** Omitting `contentRegex` gives inventory mode, answered from listing metadata with zero object reads — cheap enough to poll. Adding `contentRegex` triggers a 64-way bounded read pass, still fine across thousands of files. Always narrow with `pathGlob` before a content scan.

Write `contentRegex` as a real regex with word boundaries, not a substring: `\bwhile\s*\(`, `\b(TODO|FIXME)\b`, `console\.(log|warn|error)`.

### 4.4 Agent attribution is best effort

`environment/` is shared: every agent in a cluster writes into it and the agent index appears nowhere in the path. `groupBy: "agent"` therefore joins files to agents via file-path mentions in their logs. A path mention is `high` confidence, a bare basename `low`. Files no log references appear under **`unattributed`** — that means the author never named the file, not that nobody wrote it. Never report an unattributed file as authorless.

For exact attribution: `map` a directive asking agents to self-report, then `reduce` over their logs next iteration. Costs one iteration, needs a running cluster, and is precise.

### 4.5 Choosing an operation

| Situation | Use |
|-----------|-----|
| Whole cluster needs new instructions | `direction_set` (NOT map) |
| Subset of agents needs a nudge | map (agents) |
| What's happening across clusters? | reduce/summarize (agents) — costs a Bedrock call, use sparingly |
| Structured data about agents (frequent checks) | reduce/extract (agents) — free |
| What's in the code they wrote? | reduce/extract (files) with `contentRegex` — free |
| Size/shape of the output so far | reduce/extract (files) without `contentRegex` — free, zero reads |
| Judgement call on the output's quality | reduce/summarize (files) — costs a Bedrock call |
| Config/algorithm change | `cluster_config_set` |
| Which models can agents run? | `models_list` |
| Put one node on a different model | `cluster_config_set` with `models` — never map/reduce |
| Cluster self-organizing correctly | Nothing. Leave it alone. |

Examples:
```
mapreduce_prompt: "Which agents are idle across all clusters?"
mapreduce_prompt: "Show me agents who used while loops"
mapreduce_prompt: "Any TODOs left in the code?"

mapreduce_exec: { operation: { type: "map",
  filter: { clusters: ["team-auth"], actionRegex: "idle" },
  directive: "Contract updated. Re-read environment/shared/api-contract.ts and verify conformance." } }

mapreduce_exec: { operation: { type: "map-clear", filter: { clusters: ["team-auth"] } } }

mapreduce_exec: { operation: { target: "files", type: "reduce", mode: "extract",
  fileFilter: { pathGlob: "**/*.{ts,js,py}", contentRegex: "\\bwhile\\s*\\(" },
  fileQuery: { groupBy: "agent" } } }

mapreduce_exec: { operation: { target: "files", type: "reduce", mode: "extract",
  fileFilter: { clusters: ["team-auth"] }, fileQuery: { groupBy: "extension" } } }
```

Anti-patterns: mapping every iteration (you've built a central orchestrator), leaving directives forever (clear after the nudge lands), map instead of `direction_set` for whole-cluster changes, summarize-polling a running cluster every 30s, content-scanning with no `pathGlob` when you only care about source files, and using `target: "agents"` to ask about code (the logs don't contain it).

### Single-cluster anti-patterns (all workloads)

- Per-agent instructions in the direction (it's shared; let agents self-organise — use map for subsets).
- Expecting deterministic output (same direction → different but equivalent results).
- Radius = concurrency - 1 (destroys locality → identical output).
- Feeding too much context (use the knowledge-base for durable on-demand reference).
- Reading mid-run (partial output is contradictory; wait for convergence — except ideation, read early by design).

---

## 5. Multi-Cluster: WeltenBuilder

The local agent is an **incubator**: it plans topology, writes directions, launches, monitors, and collects results. All productive work happens inside clusters. Clusters never spawn clusters.

### 5.1 The incubator-only rule

The local agent does NOT: write project files locally, create contracts/schemas/specs to upload, generate seed data, or do "prep work" a cluster could do. If something must exist before teams can build (an interface contract), a dedicated contracts cluster produces it (5.6). The only valid `env_upload` is files the user already has (existing code, reference material, mockups). The local agent's only creative output is the directions themselves.

The local agent DOES: plan topology, write directions, set configs, launch, monitor via status sweeps, stop/pause/resume, read output, download deliverables.

### 5.2 Grouping, roles and naming

**HARD RULE: every cluster in the deployment sets the same `everforgeGroup`.** A WeltenBuilder deployment is by definition more than one cluster working on one thing, so it is always a group — teams, contracts, QA, coordinator, consolidation, deployer, all of them, one shared value, set with `cluster_config_set` before any of them starts. There is no such thing as a partially grouped deployment: a cluster left groupless writes to `environment/<clusterId>/` while its peers write to `environment/<group>/<clusterId>/`, so the cross-cluster reads that the whole model depends on silently find nothing.

**HARD RULE: every explicit path in a direction carries the group prefix.** Agents follow direction paths literally. With group `"my-project"`, `environment/dev-frontend/src/` writes outside the group, pollutes the top-level environment, and is invisible to sibling clusters. Correct: `environment/my-project/dev-frontend/src/`. Applies to own write paths, cross-cluster reads, and the shared `deployed/` folder — every path, no exceptions. Operator-side `env_upload`/`env_list`/`env_read` resolve the group themselves; directions do not.

**Cluster IDs get the group prefix too** (`myapp-deployer`, not `deployer`). IDs are global in the registry and collide across projects; matching them to the group name keeps cross-cluster paths self-describing.

| Role | Algorithm | Size | Purpose |
|------|-----------|------|---------|
| Feature team | amorphous | 5-8 | Builds a component |
| Platform/contracts | mesh | 3-5 | Shared patterns, interface contracts |
| QA/integration | mesh or swarm | 3-5 | Cross-cluster consistency |
| Coordinator | mesh | 3-5 | Monitors teams, resolves drift |
| Consolidation | mesh | 3-5 | Merges outputs into one deliverable |
| Deployer / reviewer / dispatcher | single | 1 | Serial responsibility alongside flocks (pair with selfOptimizing if it should evolve) |

**HARD RULE: register a FRESH cluster ID for every new piece of work. Never reuse ANY existing ID from the registry — named or generic, stopped or not.** Registering a new cluster is one config write; it costs nothing. There is no "unused" cluster in the registry: every existing ID owns S3 state (`{id}/store/` history, `environment/{id}/` files, cost logs, dashboard run history) that a new run would inherit and pollute — agents read leftover environment files as context, dashboards blend the runs, and cost attribution merges two unrelated jobs. "It's stopped, so it's free" and "I'll clean it first" are both wrong: cleaning is more work than registering, misses the history/ and cost prefixes, and destroys the old run's record, which is itself data. If a name is taken, suffix it (`team-backend-v2`).

The generic-ID rule is a special case of the above: `cluster_0` and numbered defaults are only ever the accidental target of an omitted `cluster_id` parameter, so their presence in the registry is a symptom, not a workspace. IDs match `^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$` and become S3 folder names referenced in cross-cluster directions. Use `{role}-{domain}` (`team-auth`, `platform-contracts`, `qa-integration`).

The ONLY case where an existing ID is correct: intentionally continuing that same cluster's own work (resume after pause/stop, rerun of the same project with its accumulated environment as context). That is continuation, not reuse.

### 5.3 Launch everything at once

**HARD RULE: no phased launches.** Set all directions, configure all clusters, start all simultaneously. QA/consolidation/contracts clusters handle empty environments gracefully ("waiting for output") and react as artifacts appear. Phasing wastes wall-clock time, fights the stigmergic model (clusters observe the shared environment every iteration), and makes you a synchronization bottleneck.

Consequences for direction writing:
- Every direction must be self-sufficient for the first iterations. Don't write "wait for the spec"; embed a sketch and add "read `environment/<contracts-cluster>/` each iteration for the authoritative version; prefer it once it appears."
- Cross-references are observational, not blocking.
- The fix loop (5.5) handles version skew when early drafts change later.

The only exception: a direction that literally cannot be written without another cluster's output. Rare — contracts clusters converge in 3-4 iterations.

After launch: parallel `cluster_status` sweep to confirm all running. Then monitor, don't manage. Intervene only for genuine deadlock.

### 5.4 Parallel operations

Always batch per-cluster calls into one parallel tool-call block: `cluster_status` sweeps, `stream_logs` sweeps, `env_list`/`env_read` collection, `cluster_stop` teardown. Sweep after launch, every 2-3 minutes during active monitoring, and before coordination decisions. Stop clusters as soon as they converge — idle clusters burn compute (visible as the growing `infraCostUsd`).

Mid-run correction: `cluster_pause` → inspect / `direction_set` → `cluster_resume`.

### 5.5 The fix loop (prevents the #1 deadlock)

Deadlock scenario: team marks CONVERGED and idles → QA writes feedback → team never reads it → coordinator escalates into the void. Prevent it by making convergence conditional, never terminal.

**Include this block in every feature/consolidation/contracts direction:**

```markdown
## Fix loop (do not remove)
After writing CONVERGED to your README.md, do NOT fully stop working. Each iteration:
1. Check if coord-decision.md or qa-feedback.md exists in your environment
2. If either lists unresolved issues targeting your team:
   - Remove "CONVERGED" from README.md
   - Fix every listed issue
   - Re-append "CONVERGED" only after all issues are addressed
3. If no feedback exists or all issues are fixed, remain idle
You are only truly done when CONVERGED is in your README AND no open issues exist.
```

**QA/coordinator idle condition** (their side of the handshake):

```markdown
## Idle condition
Go idle only when: (1) all feature teams have CONVERGED, (2) you ran a final audit
AFTER the most recent CONVERGED marker appeared, (3) no issues remain open.
If a team un-converges and re-converges, run another audit pass.
```

### 5.6 Interface contracts (contracts cluster)

When clusters produce code that must integrate, name-level mismatches (`processInput` vs `handleRequest`) compile fine in isolation and crash at runtime. QA can't reliably catch them. Fix: a small mesh contracts cluster (3-5 agents, converges in 3-4 iterations) produces the canonical contract in its environment folder.

Division of labour:
- **Local agent provides architectural intent in directions:** what the app does, which teams exist, tech choices, top-level structure. NOT type names, endpoint paths, or signatures.
- **Contracts cluster produces the authoritative contract:** conventionally `shared-types.ts`, `api-routes.ts`, `module-exports.md`, `folder-structure.md` in its environment folder. Fully specified (no `any`), verbose names, request/response/error shapes per endpoint, "the contract is the source of truth."
- **Contracts cluster also produces a path-ownership manifest** (`path-ownership.md`): which cluster owns which file paths in the merged tree, one owner per path. Without it, two clusters writing the same path (README.md, package.json, shared configs) get silently resolved by whoever the consolidation merge reads last — observed live: 8 multi-claimed paths, all resolved without anyone deciding. With it, consolidation can flag violations instead of guessing.
- **Feature teams observe it:** direction says "Read `environment/<contracts-cluster>/` each iteration for canonical types and routes. Do NOT invent your own names. Work from the system overview until the contract appears."
- **QA enforces it:** reads contract + team output, flags exact-match violations as CRITICAL via `qa-feedback.md` to the team — or to the contracts cluster itself if the contract is ambiguous (its fix loop updates it).

Launch it alongside everything else (5.3). Skip only for non-integrating clusters (research, docs) or trivially small interfaces.

### 5.7 QA and consolidation

Both launch WITH the feature teams, poll each iteration, and react to whatever appears. QA finds issues at iteration 2-3 when they're cheap; consolidation assembles structure while files land.

**QA direction essentials:** list `environment/` to discover team output → read key files → check: fetch calls match backend routes, request/response shapes match, shared type names identical across teams, auth middleware exports match what the API imports, frontend slugs/links match seed-data format, design tokens consistent → write `qa-report.md` to own folder → write `qa-feedback.md` into the offending team's folder for CRITICAL issues (triggers their fix loop) → idle condition from 5.5.

**Consolidation direction essentials:** read all team environments → assemble into `environment/<consolidation-cluster>/final/` → fix import paths → unified root package.json (merge deps, latest wins) → single canonical types file → README with run instructions → verify no broken references → fix loop. Merge rules: no duplicates (keep the more complete version), last-write-wins on S3 is fine for mesh. When a path-ownership manifest exists (5.6), check every merged file against it and FLAG collisions (write them to a merge-collisions.md and notify the offending teams via their feedback files) rather than silently picking a winner — a silent resolution hides an integration conflict until runtime.

Operator's final step: `env_download_all` (or `env_read`) from the consolidation cluster's `final/`, present to the user, stop all clusters.

Skip QA for single-cluster or research deployments. Skip consolidation when teams write non-overlapping paths or the user wants raw per-team output.

### 5.8 Identifying changed files (refinement runs)

When a cluster refines uploaded code, `env_list` shows originals + modifications with no diff flag. Distinguish by timestamp:

1. The upload batch shares one timestamp (the `env_upload` moment) — passthrough, skip.
2. Anything with a LATER timestamp was written by agents — deliverables.
3. Filter out cluster metadata (README.md, qa-feedback.md), the `context/` input dir, and duplicate variants (mesh agents may write the same logical file to different paths — the canonical one is whichever path the consuming code imports).
4. Copy the rest to the local project at correct relative paths.

Edge cases: identical rewrite (later timestamp, same size — harmless no-op), agent deletions (file just disappears from `s3_list`), multiple rewrites (last-write-wins, take the latest).

### 5.9 Multi-cluster anti-patterns

- Running a multi-cluster deployment groupless because it isn't a continuous deployment loop (5.2) — the group is a multi-cluster rule, not a pattern-specific one.
- Grouping some clusters and not others, or giving them near-miss group names (`myapp` vs `my-app`) — both split the deployment in two invisible halves.
- Unprefixed paths inside directions of a grouped deployment (5.2).
- Local agent writing project files or uploading self-created artifacts (5.1).
- Clusters spawning clusters. Never.
- Two clusters writing the same file (use the coordinator pattern).
- Any reused cluster ID — generic or named, "cleaned" or not (5.2). New work always registers a fresh ID.
- Monolithic directions covering all teams (each cluster gets its own focused one).
- Polling clusters one by one (batch in parallel, 5.4).
- Idle clusters left running.
- Terminal convergence without a fix loop (5.5).
- Launching integrating teams without a contracts cluster (5.6).
- Phased launches (5.3).

---

## 6. Continuous Deployment: the Evolution Loop

A WeltenBuilder deployment that never stops: dev teams keep improving, QA validates with browsers, a deployer ships, a demo cluster gives visual feedback. The deployer self-regulates the system's pace by phase.

### 6.1 The deployment group and paths

Continuous deployment inherits the multi-cluster grouping rules unchanged (5.2): one shared group on every cluster, group-prefixed cluster IDs, group prefix on every path in every direction.

What this pattern adds is what the group buys you beyond isolation. The **Continuous Deployments** view in the dashboard discovers projects by scanning for a group's `deployed/` folder, so the group name is effectively the project's identity in the UI — get it wrong or leave it unset and the project never appears. `environment/<group>/deployed/` is also the single rendezvous point for `latest.json`, the changelog and the live URL that every cluster in the loop reads, which is why a stray unprefixed path here breaks deploy visibility for the whole system rather than just one cluster.

### 6.2 Cluster roles

| Cluster | Algorithm | Size | browserAutomation | Interval (build → evolution) | Purpose |
|---------|-----------|------|-------------------|------------------------------|---------|
| Dev teams (1-N) | amorphous | 3-5 | false | 15-30s → 60-120s | Build and iterate per domain |
| QA/Test | amorphous | 3-4 | **true** | 30-60s → 60-120s | Browser-test deployed endpoints, report issues |
| Deployer | single | 1 | false | 10-15s → 30-60s | Deploy, monitor, manage phases |
| Demo | amorphous | 2-3 | **true** | 60-120s | Screenshots at viewports/themes, visual feedback |
| Research (optional) | amorphous | 2-3 | false | 90-120s | Internet research → feature proposals (no code). Fills its backlog fast — 2-3 agents outpace dev consumption easily; run in bursts and pause it once 20+ open proposals exist |
| Integ/unit test (optional) | amorphous | 3-5 | false | 30-60s | Writes test code + coverage report (no app code) |
| Acceptance test (optional) | amorphous | 3-4 | **true** | 45-90s | Writes reusable Puppeteer e2e suites (QA validates at runtime; this produces committable test code) |

Why amorphous for QA/demo/test: each agent develops a different specialisation (mobile, accessibility, performance; different modules; different user flows). Mesh would force one shared strategy. Low radius keeps them spread out; neighbours' reports prevent duplication.

Why the research cluster: dev teams are heads-down; without a proposal pipeline the evolution phase stalls when the backlog empties. It writes markdown proposals (problem, solution, acceptance criteria, priority) to its folder; dev teams read and pick up ready ones.

`autopause: false` on ALL clusters in the loop — the system runs indefinitely; the deployer stops idle clusters explicitly.

### 6.3 The deployer

- **`algorithm: single`, `instanceType: c8g.large`** — npm install + cdk deploy burn CPU continuously; burstable t4g exhausts credits and throttles to 20%.
- **`loopIntervalSeconds: 10-15`** — it's the single choke point; every team waits on it to detect and ship changes.
- **`selfOptimizing: false`** — it learns "skip deploy when files look unchanged", which breaks the system.

**HARD RULE: deploy every iteration, unconditionally.** No timestamp checks, no file counting, no "nothing changed, skip". CDK content-hashes internally: a no-op deploy exits in seconds with "no changes" (a valid outcome, log it and continue), but a skipped deploy when something DID change stalls every downstream team. The deploy command itself is the change detector. If a self-optimization note says "skip deploy", the direction overrides it. This is the single most common failure mode of the whole pattern.

**HARD RULE: never pipe long commands** (`cdk deploy`, `npm install`, `aws s3 sync`) through grep/head/tail — SIGPIPE kills the deployment mid-run.

**HARD RULE: set `trustDeploy: true` on any cluster that must deploy.** Trust is decided at config time only. Without it `deploy_request` returns a terminal `deploy_disabled` and the cluster can never ship. There is no runtime approval, so a deployer can never stall waiting for an operator click.

**HARD RULE: assemble build trees with `s3_sync_local`, never file-by-file.** `s3_sync_local(source, dest)` copies a whole S3 prefix to `~/kiro-flock-workspace/` server-side and returns only a file count. A deployer that `s3_read`s each source file and rewrites it locally blows its context window and the turn dies before `deploy_request` fires — the single most common way a deployer loses iterations (observed: 60+ consecutive losses on a project of a few dozen files).

**Deploy MCP (mandatory, no shell cdk):** three tools — `deploy_request` (trusted → spawns detached CDK, returns `deploying`; untrusted → returns `deploy_disabled`), `deploy_status` (returns no_deploy/deploying/succeeded/failed/deploy_disabled; includes CDK log tail), `deploy_cancel` (kills process, cancels the CloudFormation update; optional stackName). Operators can query deployment history via the operator-side `deploy_record_list` tool, and tear a deployed stack down with the operator-side `deploy_destroy` tool (two-step: preview first, then `confirm: "goodbye <stackName>"`; allowed even while the deployer cluster runs, but a running deployer may redeploy the stack). The iteration pattern:

```
Call deploy_status FIRST.
- "no_deploy"/"succeeded"/"failed": s3_sync_local each source prefix from the dev
  environment → npm install → deploy_request(cwd, stackName, mode="remote", summary,
  systemname, changelog_entry) → end iteration.
  (changelog_entry is the deploy's narrative — write it at request time; the MCP
  publishes it under the [DEPLOYED] heading when the deploy completes.)
- "deploying": broadcast progress with logTail. Do NOT sync or install. End iteration.
- "deploy_disabled": trustDeploy was not set. Broadcast once, never call deploy tools
  again this run. Not a blocker — this is a config decision.
- "deploying" for 5+ consecutive iterations: deploy_cancel, write failure.
```

**Stay in the cluster's home region.** The deploy MCP runs CDK with the
cluster's region; that region is bootstrapped and the deploy role is scoped to
it. A stack pinned to another region (the classic case: Lambda@Edge forcing
`us-east-1`) dies at bootstrap — the target region has no CDKToolkit stack and
the role is denied `CreateChangeSet` on it. Design around it (regional Lambda
Function URL instead of Lambda@Edge). And when swapping a CloudFront origin to
a new target, grant the invoke/access permission **in the same deploy** as the
origin swap — a two-step rollout serves 403s for the gap between them.

**Deploy log:** after every attempt, append to `environment/<group>/<deployer-id>/deploy-log.md`: timestamp, result (success/failed/timeout), duration, error, action taken. **Every other cluster reads this file each iteration** — it's how teams learn about deploy failures (usually broken CDK custom resources) without waiting to be told.

**Local deploys** (QA/demo preview ports) still go through `deploy_request` with `mode: "local"`, but the MCP only grants permission — the agent binds the port itself, no CDK spawn. The trusted marker files under `store/approvals/` are written by `cluster_start` — never write them manually.

### 6.4 Deployment records (drive the Continuous Deployments view)

**HARD RULE: deployment records are written by the deploy MCP, never by agents.**
`latest.json`, `deployment-<systemname>.md`, and the `[DEPLOYED]` changelog
entry in `environment/<group>/deployed/` are derived from CloudFormation state
by the deploy machinery itself, in the same detached process chain that ran
`cdk deploy` — so the record lands even if the agent's iteration dies mid-turn.
A direction that tells the deployer to maintain these files by hand reintroduces
the failure this design removed: a session dying between "deploy succeeded" and
"record written" leaves a stale record that every other cluster trusts
(observed live: 30 minutes of the whole flock reading old bytes as current).

What the deployer direction DOES specify:

- **`changelog_entry` on every `deploy_request`** — the prose narrative of what
  changed and why. Written at request time (the agent knows what it is shipping
  then), published verbatim under the `[DEPLOYED]` heading when the deploy
  completes.
- **Stack outputs for URLs** — the record's `url`/`apiUrl` come from the
  stack's CloudFormation outputs. Dev teams declare `CfnOutput`s named
  `SiteUrl` (public site) and `ApiUrl` (API). Without them the MCP falls back
  to inspecting CloudFront/API Gateway; if that fails too the record is still
  written but the live preview stays empty and `deploy_status` returns a
  warning saying so — act on it.

Non-deploy prose is still agents' to write: dev teams pre-append plain entries
(no `[DEPLOYED]` marker) to `changelog.md` when they finish features, and a
`releases.md` in the same folder (one `## v{version} — {date}` summary per
version bump) is maintained by whoever the direction assigns. Always use
`append: true` for these — the folder has many writers (see 6.5).

### 6.5 Rules that keep the loop alive

**S3-first file writing (the single most important dev-team rule).** The feedback chain is: dev writes S3 → deployer redeploys → QA tests the live URL → demo screenshots it → dev reads feedback → repeat. If dev edits local disk instead of S3, the whole chain silently dies while looking busy. Every dev direction MUST contain, near the top (buried rules get skipped under context pressure):

```markdown
## File Writing (CRITICAL - the system breaks without this)
Write ALL source files directly to your S3 environment directory using s3_write.
EVERY iteration that changes code MUST update the S3 file.
Local disk (~/kiro-flock-workspace/) is ONLY for npm install/build/test.
Workflow: write to S3 FIRST, copy to local only to run/compile, never the reverse.
```

**The verification contract: prove it in the deployed bytes.** State this in every dev/QA/test direction from iteration zero — left unstated, flocks take hours to invent it themselves while claims and reality drift apart. Include a block like:

```markdown
## Verification contract (do not remove)
- "I wrote the fix" is not "fixed". A fix is DONE only when a deploy record
  postdates it AND the fix is verifiable in the deployed artifact (the served
  bundle, the live endpoint) — e.g. the changed string/behaviour is present in
  what the live URL actually serves.
- QA/test: a PASS only closes an issue against deployed bytes. Never verify a
  fix by reading source. Never file app bugs while the deployment itself is
  known-broken (deploy-log.md tells you).
- When claiming a fix, say what you verified and against which deploy.
```

This is what keeps "claims running ahead of the bytes" — the most corrosive failure mode of a long run — from taking hold.

**DO NOT DEPLOY.** When a deployer cluster exists, every dev and test direction includes an explicit "DO NOT DEPLOY — the deployer handles all deployments" section near the top. Without it, agents see CDK code and deploy it themselves.

**X-Frame-Options.** The live preview embeds the app in a cross-origin iframe. Dev directions for web content must say: do NOT set X-Frame-Options at all (both DENY and SAMEORIGIN block it; ALLOW-FROM is dead). Remove it from API Gateway responses, CDK defaults, and WAF rules.

**S3 request metrics.** The view auto-discovers CloudWatch metrics from stack resources. Lambda, API Gateway, DynamoDB, ALB, ECS, SQS, RDS, CloudFront, Step Functions, Kinesis, SNS all emit automatically. **S3 buckets do not** (daily storage metrics only) — dev teams deploying S3 must add `bucket.addMetric({ id: 'AllRequests' })` in CDK or the data panels stay empty.

**Cross-cluster reads.** Every dev and QA direction includes (with group-prefixed paths):

```markdown
## Cross-Cluster Reads (CHECK EVERY ITERATION)
- environment/<group>/<qa-id>/ for test results and bug reports (fix bugs before new features)
- environment/<group>/<demo-id>/ for screenshots and visual feedback
- environment/<group>/<deployer-id>/deploy-log.md for deployment status and errors
- environment/<group>/deployed/latest.json for the live URL
```

Demo feedback must be actionable ("button contrast too low at 375px in light mode"), not "looks okay". QA writes one file per issue (`{timestamp}-{desc}.md` with URL, expected, actual, screenshot, severity) into `issues/{team-cluster-id}/`, and handles a missing live URL gracefully on early iterations.

### 6.6 Phases and pace

| Phase | Trigger to enter | Dev | QA | Deployer |
|-------|------------------|-----|-----|----------|
| Build | start | 15-30s | 30s | 15s |
| Integration | complete deployable artifact exists; teams refining | 45s | 45s | 15s |
| Evolution (target state, indefinite) | QA all-passing + remote deploy healthy | 90s | 90s | 30s |
| Steady state | convergence ratio > 0.8 for 10 deployer iterations | long-lived teams keep adaptive pace; deployer stops one-off clusters | | |

The interval columns above are starting points. After a few iterations, check real iteration wall time (`durationMs` on the cost lines, surfaced in the dashboard) and adjust: an interval far below the measured duration does nothing but misstate the cadence, and a direction that demands heavy per-iteration work (a full export or build every turn) needs either a lighter demand or a longer interval — mismatches here caused two of the worst stalls observed in the field.

The deployer executes transitions: a map-reduce map directive to all affected clusters announcing the phase, then `cluster_config_set` per cluster with the new `loopIntervalSeconds`. Example:

```json
{ "operation": { "type": "map",
  "filter": { "clusters": ["dev-frontend", "dev-backend", "qa-test"], "all": true },
  "directive": "Phase transition: BUILD -> INTEGRATION. Slow your iterations. Focus on fixing QA issues over new features. Read the QA issues folder every iteration." } }
```

It detects idle clusters via reduce/extract (`select: [agentId, action, next_intent]`); all-idle for 5+ iterations → `cluster_stop`.

### 6.7 Operator flow

Ask before launching (defaults marked *):
1. Who deploys? *Dedicated deployer* / dev teams deploy themselves via deploy MCP.
2. Which test clusters? *QA only* / + integ-test / + accept-test / all.
3. Research cluster? *Yes* / no.

Sequence: kb_upload steering docs → `cluster_config_set` each cluster (ALL mandatory fields, see 9) → `direction_set` each → `env_upload` seeds → `cluster_start` all → `stream_logs` on the deployer for phase transitions → approve/trust the first remote deploy → watch the Continuous Deployments view. From there the system runs itself; intervene only for new requirements (direction updates) or shutdown.

---

## 7. Continuous Deployment Direction Skeletons

Fill in group, cluster IDs, and project specifics. Each skeleton lists the sections a direction MUST contain; the rules referenced live in section 6.

**Dev team:** role + domain → current phase → S3-first file-writing block (6.5, near the top) → DO NOT DEPLOY (6.5) → verification contract (6.5) → docs-first rule: before writing code against a framework or SDK, check the current docs for the pinned version (agents have internet access) — do not write from memory of older APIs; this is the cheapest quality lever available → artifact locations (group-prefixed) → rules (read QA issues first, fix bugs before features, report idle when out of work, pre-append changelog entries on feature completion) → cross-cluster reads (6.5) → X-Frame-Options + S3 metrics notes if deploying web/S3 infra.

**QA:** role → DO NOT DEPLOY → verification contract (6.5) → read `deployed/latest.json` for the live URL (graceful when missing) → Puppeteer scenarios (loads, interactions, forms, API calls) → results to own folder, one-file-per-issue with severity into `issues/{team-id}/` → **finding-ID namespace: every finding ID starts with your agent index (`A0-001`, `A2-014`)** — three lanes numbering findings independently produced duplicate IDs, one collision, and the same defect filed under up to five numbers; the prefix makes IDs collision-free with zero coordination → cross-cluster reads → idle condition (5.5).

**Deployer:** UNCONDITIONAL DEPLOY RULE first, before anything else (6.3) → responsibilities (monitor, deploy, phase transitions, health, lifecycle) → deploy MCP pattern verbatim (6.3) → records are MCP-written, never hand-maintained; supply `changelog_entry` on every request (6.4) → deploy-log.md (6.3) → phase transition conditions and interval table (6.6) → explicit stackName and systemname (never left for the agent to invent) → home-region-only rule (6.3). No file-count or timestamp language anywhere in the direction.

**Demo:** role → DO NOT DEPLOY → read latest.json → local deploy for preview → Puppeteer screenshots (home, key flows, 375px mobile, error states) to own `screenshots/` → actionable visual feedback file, findings ID-prefixed by agent index like QA → maintain a deduplicated findings register (mark withdrawals explicitly so dev teams stop working retracted items) → local deployment record into `deployed/` (`mode: "local"`, url, timestamp).

**Research / integ-test / accept-test:** role and hard scope limit (no app code) → output locations (proposals/, tests/ + coverage.md, e2e/ + report.md) → cross-cluster reads → who consumes their output (dev reads proposals and coverage; QA reads e2e reports).

---

## 8. Single-cluster continuous deployment (alternative to 6)

One large amorphous cluster where every agent does everything: develop, test, deploy, research. Use for hackathons, solo operators, full-stack apps without domain separation. Avoid for large multi-domain systems, deploy-safety-critical work, or role-based access needs.

Config: 1 cluster, amorphous, concurrency 8-16 (32 with radius 3; split into the multi-cluster form of section 6 beyond 64), radius 2, `c8g.large`, `browserAutomation: true`, `selfOptimizing: false` (agents learn "everything works, I can idle" — directly violates the core rule), `autopause: false`, `everforgeGroup` set (it is one cluster, so technically optional — set it anyway: this pattern deploys, and the Continuous Deployments view finds the project through the group's `deployed/` folder), interval ~20s.

**The never-idle rule.** No convergence state exists. The direction forbids idling and gives a priority list that never empties — each iteration the agent does exactly ONE of:
1. Fix bugs found by testing
2. Deploy (only if YOU wrote unshipped code AND `deploy_status` isn't "deploying")
3. Test a DIFFERENT flow with Puppeteer (never curl-only)
4. Implement features (keep a 20+ item backlog in the direction)
5. Research the domain online, then implement findings

**Issue filing (optional):** with no QA cluster, you can route bugs stigmergically through a shared `issues/` folder — one `{timestamp}-{short-desc}.md` per finding (file path, expected, actual, severity), with "fix an open issue" as priority 1 so any agent picks it up next iteration.

Include this block verbatim in the direction:

```markdown
## NEVER DO THIS
- Never broadcast "idle"
- Never say "done" or "ready"
- Never wait for someone else
- Never test with only curl (use Puppeteer)
- Never deploy if deploy_status shows "deploying"
```

**State awareness before acting:** every iteration read `deployed/latest.json`, `deployed/changelog.md`, and neighbour logs. Neighbour just deployed → test instead. Neighbour found a bug → fix it. Radius 2 gives 4 visible neighbours — enough to avoid most collisions.

**Deploy coordination without a deployer:** all agents may deploy; check `deploy_status` first and skip if "deploying". CDK tolerates near-simultaneous attempts (second one sees UPDATE_IN_PROGRESS). Records (latest.json, `[DEPLOYED]` changelog entry) are written by the deploy MCP — supply `changelog_entry` on `deploy_request`, never hand-write the record files (6.4).

Pairs well with `coder_attach`: agents build continuously, the operator fixes gnarly bugs directly, pushes via `coder_push`, and announces changes via `coder_log` so agents don't revert them.

---

## 9. Launch Checklists

### Any cluster
- [ ] Explicit `cluster_id` on EVERY MCP call, reads included — never omit it, never `cluster_0`
- [ ] `algorithm` and `concurrency` in the SAME `cluster_config_set` call
- [ ] Freshly registered role-based cluster ID — never any existing registry entry, generic or named (continuation of that cluster's own work is the only exception)
- [ ] Environment cleaned (or fresh ID) if leftover files would mislead agents
- [ ] Direction self-sufficient for iteration 1; cross-references observational, not blocking

### Multi-cluster
- [ ] `everforgeGroup` set on EVERY cluster, same value, via `cluster_config_set` before any start (5.2)
- [ ] Cluster IDs carry the group prefix
- [ ] Every explicit path in every direction group-prefixed: `environment/<group>/<clusterId>/`, `environment/<group>/deployed/`
- [ ] All clusters launch simultaneously, no phasing
- [ ] Fix loop block in every feature/consolidation/contracts direction (5.5)
- [ ] QA/coordinator idle condition (5.5)
- [ ] Contracts cluster when teams' code must integrate (5.6)
- [ ] No locally-created artifacts uploaded; only user-owned files

### Continuous deployment config (every cluster)
- [ ] Multi-cluster checklist above satisfied first (group, prefixed IDs, prefixed paths)
- [ ] `autopause: false` explicitly (system default is true and WILL pause your loop)
- [ ] Deployer: `single`, `c8g.large`, interval 10-15s, `selfOptimizing: false`, **`trustDeploy: true`** (without it the deployer can never ship)

### Continuous deployment directions
- [ ] Deployer: unconditional-deploy rule at the top; `s3_sync_local` for assembling the build tree (never file-by-file); `changelog_entry` on every deploy_request; no hand-written latest.json/record files (MCP writes them, 6.4); no file-count/timestamp language; 5-iteration cancel rule; explicit stackName + systemname; home-region-only rule
- [ ] Dev (infra): `CfnOutput` named `SiteUrl`/`ApiUrl` on every stack so deployment records get a live URL (6.4)
- [ ] Dev: S3-first block near the top; DO NOT DEPLOY; verification contract (6.5); docs-first rule; cross-cluster reads incl. deploy-log.md; X-Frame-Options removal for web content; `bucket.addMetric` for any S3 bucket
- [ ] QA/demo/test: DO NOT DEPLOY; verification contract (6.5); agent-index finding-ID namespaces; read latest.json with graceful missing-URL handling; actionable feedback formats
- [ ] Intervals sanity-checked against measured iteration duration (`durationMs` on cost lines) after the first few iterations (6.6)
