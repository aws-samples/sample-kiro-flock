# kiro-flock — Release Notes

Release history for the kiro-flock cluster: CDK stack, Lambda API, EC2 agents, web dashboard, and WeltenBuilder multi-cluster frontend. For the MCP server, see [`kiro-flock-mcp/release-notes.md`](../kiro-flock-mcp/release-notes.md).

---

## v3.8 — Agentic Map/Reduce — May 2026 (current)

A natural-language interface for fine-grained control over individual agents. Operates at the agent level (not just cluster level), supports cross-cluster targeting, and renders results in the existing analyzer tab system.

### Added

- **Per-agent directives.** Map operations write a directive file (`{clusterId}/store/agent-{N}.directive.md`) for targeted agents. The agent loop picks it up on the next iteration and prepends it to the prompt alongside the cluster direction. Directives persist until explicitly cleared.
- **Translation layer.** A Bedrock-powered Lambda converts natural language prompts into structured map/reduce operations. Understands cluster names, agent references, and operation types from plain English.
- **Execution engine (`lambda/mapreduceEngine.ts`).** Handles filter resolution, S3 reads/writes for directives, and log extraction for reduce queries. Pure logic, no Bedrock dependency.
- **Two MCP tools:**
  - `mapreduce_prompt` — natural language interface (goes through translation)
  - `mapreduce_exec` — structured interface (skips translation, for programmatic use)
- **Filter system.** Target agents by cluster, index, last action (regex), iteration count, or idle state. Filters compose with AND logic and work across clusters.
- **Reduce modes:**
  - `extract` — structured filtering/grouping of log entries. No Bedrock call, fast.
  - `summarize` — Bedrock-powered scoped analysis of targeted agents' logs and output.
- **WeltenBuilder UI integration.** Text input above the analyzer panel. Results appear as closeable tabs alongside analyze/optimize results.
- **Active-only filter.** Map operations can target only agents in non-stopped clusters, useful when some clusters have hit rate limits.

### API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/cluster/mapreduce` | Natural language map/reduce (async, returns tab ID) |
| POST | `/cluster/mapreduce-exec` | Structured map/reduce (async, returns tab ID) |

### Design principles

- Directives are additive: the cluster direction stays, a directive adds context.
- Filter/reduce operations are read-only and don't change agent behaviour.
- Agents don't know about map-reduce as a concept. They just see an optional directive file.
- Clearing directives returns agents to pure self-organization instantly.

---

## v3.5 — Bedrock-Powered Analyzer and Optimizer — May 2026

An AI-powered analysis and optimization layer for WeltenBuilder. A bottom panel lets operators understand what their clusters are doing and refine directions mid-run. Powered by Amazon Bedrock (Claude Sonnet 4.6) via the Converse API.

### Analyzer

Click **Analyze** to get a structured breakdown of the running deployment. The Lambda gathers all active cluster state from S3 (agent log tails, directions, configs, environment file listings), sends it to Bedrock, and returns:

- Progress bar with estimated overall completion percentage
- Summary of accomplishments and remaining work
- Organigram of cluster cards: team role, current focus, artefacts with status indicators
- Mermaid relation diagram (clusters as squares, artefacts as circles, click to expand)

Only non-stopped clusters are included.

### Optimizer

Click **Optimize** to get proposed direction updates for every active cluster. If a prior analysis exists, it's fed into the prompt so the optimizer has the full picture. Proposals appear as cards with change type badges (refined, refocused, expanded, reduced) and a rationale. Click **Apply Directions** to write all proposed directions in one action.

### Added

- **`lambda/analyzerHandler.ts`** — Lambda (Node.js 20, 512MB, 120s timeout). Reads cluster data, calls Bedrock Converse, persists structured JSON.
- **`lambda/analyzerPrompts.ts`** — templated prompts for analyze and optimize modes.
- **Analyzer panel UI** with tabs, polling, organigram rendering, optimize diff view, apply flow, mermaid diagram.
- **Tabbed persistence.** Every result becomes a closeable tab stored in `store/analyzer/`. Tabs survive page reloads and get archived with agent logs on the next cluster start.
- **Registry auto-prune.** Clusters stopped for more than 7 days are automatically removed from `clusters.json` on the next poll.
- **Kiro Ghost mascot.** Animated SVG in the WeltenBuilder header with cursor-tracking eyes. Pure CSS/SVG, no dependencies.

### API routes

| Method | Path | Description |
|--------|------|-------------|
| POST | `/cluster/analyze` | Trigger analysis (async, returns tab ID) |
| POST | `/cluster/optimize` | Trigger optimization (async, returns tab ID) |
| GET | `/cluster/analyzer-tabs` | List all persisted tabs |
| GET | `/cluster/analyzer-tab/{tabId}` | Poll a specific tab result |
| DELETE | `/cluster/analyzer-tab/{tabId}` | Close/delete a tab |
| POST | `/cluster/optimize-apply` | Apply proposed directions |

### CDK / IAM

- New `AnalyzerFn` Lambda with `bedrock:InvokeModel` on Claude Sonnet 4.6 inference profiles.
- S3 read scoped to `*/store/*`, `*/config.json`, `*/direction.md`, `clusters.json`, `environment/*`, `knowledge-base/*`, `store/analyzer/*`.
- S3 write scoped to `store/analyzer/*`.

---

## v3.0 — WeltenBuilder (Multi-Cluster Orchestration) — May 2026

A single kiro-flock deployment now hosts any number of independent clusters, each with its own direction, config, algorithm, and lifecycle. WeltenBuilder, a new light-themed multi-cluster frontend, ships alongside the existing dashboard. Standalone single-cluster installs keep working: the old API, MCP tools, and agent code all default to `cluster_0`.

### Added

#### Multi-cluster foundation

- **Cluster registry at `s3://bucket/clusters.json`.** Lists every registered cluster with id, name, algorithm, createdAt. Seeded on fresh deploys with a default `cluster_0` entry.
- **Per-cluster S3 layout.** Operational data lives under `{clusterId}/` (`config.json`, `direction.md`, `store/`). The shared `environment/` folder has per-cluster subfolders at `environment/{clusterId}/` but agents can read from any path under `environment/`.
- **`AGA_CLUSTER_PREFIX` environment variable** on agent EC2 instances. Bootstrap reads `clusterId` from `/etc/aga/agent.json` and threads it through the S3 MCP subprocess, the agent loop, and neighbour selection.

#### API surface

- `GET /cluster/list` — registry plus live state per entry.
- `POST /cluster/create` — validates cluster id, rejects duplicates, writes initial config.
- `DELETE /cluster/delete/{id}` — removes the registry entry. Refuses non-stopped clusters and `cluster_0`.
- `POST /cluster/stop-all` — terminates every non-stopped cluster in parallel.
- `POST /cluster/pause-all` — pauses each running cluster.
- `POST /cluster/clean-env/{id}` — wipes `environment/{id}/`. 409 if cluster is not stopped.
- `POST /cluster/clean-env-all` — wipes the whole `environment/` folder.
- **Backwards compatibility.** Every existing endpoint accepts `/{cluster_id}` or omits it (defaults to `cluster_0`).

#### WeltenBuilder frontend (`weltenbuilder/web/`)

- Standalone vanilla HTML/CSS/JS app served at `${API_URL}welten`. Same Cognito pool as the existing dashboard.
- Cluster stack grid with one card per cluster plus a `+` card for creation. Each card shows name, algorithm badge, state badge, direction preview, config summary, and action buttons.
- Direction popout modal with markdown rendering and edit toggle.
- Foldable environment tree on the right. File click opens a modal viewer with markdown rendering.
- Create cluster modal with form validation, algorithm picker, concurrency slider.
- Global controls: Stop All, Pause All, Clean Environment, each with confirm dialogs.
- Drill-down view: click a cluster card to see the full single-cluster dashboard scoped to that cluster.

#### MCP server extensions

- Every cluster-scoped tool accepts an optional `cluster_id` parameter.
- New `clusters_list` tool for discovering registered clusters.
- `flockClient.ts` appends `/{clusterId}` to API paths when provided.
- `feeder.ts` prepends `environment/{clusterId}/` to environment upload keys.
- Full backwards compatibility: calls without `cluster_id` target `cluster_0`.

#### Infrastructure

- API Gateway routes for WeltenBuilder (`GET /welten`, `GET /welten/{proxy+}`).
- `WeltenUrl` CloudFormation output.
- Agent IAM widened for multi-cluster prefixes with explicit deny on control files and registry.
- EC2 instances carry a `ClusterId` tag. `stopCluster()` filters by it so one cluster's stop never terminates another's agents.
- `install.sh` writes auth config for both dashboards and registers both callback URLs on Cognito.

### Changed

- `handler.ts` refactored to `parseRoute()` dispatch for multi-segment paths.
- `snapshotBuilder.ts` and `analysisBuilder.ts` accept `clusterId` in their event payloads.
- `ec2Manager.ts` takes an optional `clusterId` parameter on start/stop/describe.
- Seed config writes to `cluster_0/config.json` instead of bucket-root.

### Security

- Agent role explicitly denies writes to `clusters.json`. Only the Lambda can modify the registry.
- Pause flag deny propagates across all clusters.

---

## v2.0 — Pluggable Algorithms, Pause/Resume, Dynamic Config — April 2026

Three coordination algorithms, pause/resume, dynamic config reload, post-run analysis, and the environment/knowledge-base split.

### Added

- **Pluggable coordination algorithms.**
  - `amorphous` — ring neighbours at radius R. The v1.0 behaviour, now one of three options.
  - `mesh` — every other agent visible to every agent. Good for consensus, bounded by context window at high concurrency.
  - `swarm` — each agent reads the K most recently active peers via S3 `LastModified`. Good for ideation and activity hotspots.
- **`swarmK` config field.** Only consulted when `algorithm === "swarm"`, must be `1..concurrency-1`.
- **Per-algorithm dashboard colour scheme.** Body `data-algorithm` attribute retints the whole UI. The operator can't miss which mode is running.
- **Segmented algorithm selector** in the controls bar with field visibility per algorithm.
- **Pause / resume.** `POST /cluster/pause` writes `pause.flag`; agents park in a slow-poll loop while present. `POST /cluster/resume` deletes it. Primary button cycles Start → Pause → Resume.
- **Dynamic config reload.** `loopIntervalSeconds`, `algorithm`, `swarmK`, `neighbourRadius` take effect on each agent's next iteration without a restart.
- **Post-run analysis artifact.** `/cluster/analysis` returns a presigned URL to a gzipped NDJSON concat of every agent log. Built asynchronously on `/cluster/stop`.
- **Environment / knowledge-base split.** `environment/` is per-run, archived on `cluster_start`. `knowledge-base/` is persistent across runs.
- **Run archival.** `cluster_start` moves `environment/` and `store/` to `history/<datetime>/` before launching.
- **Parallel status endpoint.** `describeCluster` and `readAgentLogs` run concurrently, cutting status round-trip time roughly in half.
- **Pause-flag IAM hardening.** Agents get `s3:GetObject` on `pause.flag` but are denied write/delete.

### Changed

- Config endpoints backfill algorithm defaults when reading older config files.
- `POST /cluster/start` validates the full merged config before launching and persists it to S3 before any EC2 call.
- Cognito app client recreated with `authFlows.adminUserPassword` enabled. Token validity extended to 24h id/access, 7d refresh.
- Default concurrency cap set to 64.
- `install.sh` rewrites Cognito callback URL and `auth-config.json` on every run.

### Fixed

- Start path fully async. Lambda self-invokes for the `RunInstances` loop so the API Gateway 29s timeout doesn't bite on large clusters.
- Snapshot builder writes `clusterState` and `clusterStartTime` so the dashboard run timer survives page refresh.
- Pause cleanup on start/stop. Leftover `pause.flag` is deleted so you never inherit a paused state.

---

## v1.0 — Amorphous Computing on EC2 — April 2026

The first release. Single algorithm (amorphous ring-topology), web dashboard, Cognito auth.

### Added

#### Infrastructure

- CDK stack with VPC, S3 bucket, Lambda handler, REST API Gateway, snapshot builder Lambda.
- AMI-less deploy with `install.sh` end-to-end setup. Re-running `setup.sh` is the canonical fix for config drift.
- Cognito hosted UI with implicit-flow id_token.
- API key auth for headless EC2 agents via SSM Parameter Store.
- Standalone S3 MCP server on each agent.

#### Dashboard

- Web dashboard served from S3 via API Gateway. Agent grid, habitat file viewer with markdown rendering, direction bar, Cognito login, live metrics from CloudWatch.
- Direction field surfaced in dashboard and agent loop.
- Instance-type selector with vCPU quota awareness.
- Environment file viewer with per-file and bulk zip download.
- Run timer based on earliest EC2 launch time, survives page refresh.
- Status discrimination: shutting-down state shown per instance, buttons disabled appropriately.

#### Agents

- EC2 Graviton instances running kiro-cli in headless mode with an S3 MCP bridge.
- Ring-topology neighbour reads, append-only NDJSON logs to `store/agent-N.ndjson`.
- Auto-approve MCP tool calls in ACP permission handler.

### Security

- S3 access logs, `enforceSSL`, scoped IAM on agents with deny-list on control files.
- `direction.md` write deny on agents.
- IAM condition fixes for `RunInstances` (instance type scoped to instance resource only).

---

## v0.5 — Local Prototype — Early 2026

The prototype. No AWS, no Lambda, no CDK. A Python CLI that ran the whole flock locally: incubator spawning kiro-cli subprocesses, a terminal UI, ring neighbours via local log files. Retired when the AWS implementation caught up.

### Added

- Incubator spawning N kiro-cli subprocesses with killpg-based shutdown.
- Terminal UI with N-column layout, live stdout panes, per-agent iteration view.
- Agent loop in kiro-cli headless mode with trusted tools (`fs_read`, `fs_write`, `fetch`).
- `kiro-flock` CLI with global config, short flags, smart defaults.
- Dynamic knowledge-base paths and configurable model.
- `--direction-file` flag.
