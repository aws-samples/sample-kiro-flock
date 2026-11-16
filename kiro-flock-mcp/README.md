# kiro-flock-feed-mcp

A local MCP server that lets a Kiro agent drive a remote [kiro-flock](https://github.com/aws-samples/sample-kiro-flock) cluster.

[kiro-flock](https://github.com/aws-samples/sample-kiro-flock) is a distributed multi-agent system that runs a configurable cluster of Kiro agents on EC2. Each agent operates independently, reads its neighbours' logs, and coordinates through an append-only shared workspace in S3. You give the cluster a direction (a goal), and agents converge on it through local interaction over several iterations.

This MCP is the interface between a local Kiro agent and a running kiro-flock cluster. It lets you upload context files into the cluster, set the direction, start and stop it, stream agent logs, and read what agents produced, all through MCP tool calls.

## Prerequisites

You need a deployed kiro-flock cluster in your own AWS account. Deploy it first by following the instructions in the [kiro-flock repo](https://github.com/aws-samples/sample-kiro-flock), then come back here.

## What it does

Once your cluster is deployed, this MCP lets a local Kiro agent:

- Upload local files into the cluster's per-run environment or persistent knowledge-base
- Set the direction (the goal agents work toward each iteration)
- Start and stop the cluster
- Stream agent iteration logs
- Read files agents produced

## Architecture

```
Local Kiro Agent
      │
      │  MCP tool calls (stdio)
      ▼
kiro-flock-feed-mcp (this project)
      │
      │  HTTPS + Cognito auth (browser login / auto-refresh)
      ▼
API Gateway → Lambda (kiro-flock cluster API)
      │
      └── S3 bucket
            ├── environment/   ← per-run context files you upload, agent artifacts
            ├── knowledge-base/← durable reference material (persists across runs)
            ├── direction.md   ← the goal
            └── store/         ← agent iteration logs (NDJSON)
```

## Authentication

The MCP server manages Cognito tokens automatically. No manual token handling required.

**On first use**, the server opens your browser to the Cognito hosted UI login page. After you sign in, the token is captured via a localhost callback and cached locally.

**On subsequent starts**, the server silently refreshes the token using the cached refresh token (valid 7 days). If the refresh token has expired, the browser login opens again.

Token cache location: `~/.kiro-flock-feed/token-cache.json` (mode 600).

To see auth debug output, set `FLOCK_DEBUG=1` in the MCP server's env config.

## Tools

The S3 bucket has two distinct shared areas:

- **environment/** — per-run working area. Archived on every `cluster_start`. Use this for almost everything.
- **knowledge-base/** — durable reference material. Persists across runs. Use only when the direction calls for persistent material.

| Tool | Description |
|------|-------------|
| `cluster_status` | Current state, per-agent logs, metrics |
| `cluster_start` | Launch EC2 agents. Appends "Read the environment/ directory first." to the direction automatically. |
| `cluster_stop` | Terminate all instances |
| `cluster_config_get` | Read current config (concurrency, instance type, etc.) |
| `cluster_config_set` | Update config for the next start |
| `direction_get` | Read the current direction |
| `direction_set` | Set the direction. Must be called before `cluster_start`. |
| `env_upload` | Upload a local file or folder into `environment/` after cluster start. Auto-detects file vs directory. Agents read it on their next iteration. |
| `env_list` | List files in the per-run environment |
| `env_read` | Read a single file from the environment |
| `kb_upload` | Upload a local file or folder into `knowledge-base/`. Persists across runs. Auto-detects file vs directory. Use only when the direction calls for durable reference material. |
| `kb_list` | List files in the persistent knowledge-base |
| `kb_read` | Read a single file from the knowledge-base |
| `stream_logs` | Fetch latest agent log entries. Returns immediately. Call in a loop, stop when `clusterState` is `stopped` or all agents show `idle` as `next_intent`. |
| `store_list` | List agent log files in `store/`. Each agent writes an append-only NDJSON file per run. |
| `store_read` | Read the full iteration log for a single agent. Returns all entries as structured JSON. |
| `store_read_all` | Read all agent logs from the last run. Returns every agent's full history plus summary stats. Use for post-run convergence/divergence analysis. |
| `list_acp_sessions` | List available ACP session files on an agent's EC2 instance. Returns session IDs, sizes, and whether each is active (in-progress) or completed. Use to discover which iterations are available before calling `stream_acp` with an offset. |
| `stream_acp` | Retrieve the full ACP session transcript for an agent iteration. Returns the complete conversation (prompt, tool calls, results, responses) formatted as readable markdown. Use `offset` to go back through previous iterations. **Do not call in parallel** — each call issues ~20 concurrent SSM commands and parallel calls will hit rate limits. |
| `clusters_list` | List all registered clusters with live state. Use to discover cluster IDs before targeting them. |
| `cluster_pause` | Pause a running cluster between iterations. Instances stay alive, agents stop working until resumed. |
| `cluster_resume` | Resume a paused cluster. Agents pick up on the next poll cycle. |
| `deploy_record_list` | List deployment records filtered by systemname. Returns records from `environment/deployed/` whose systemname matches. |
| `deploy_destroy` | Destroy the CloudFormation stack backing a deployment group. Two-step: call without `confirm` for a preview (stack name, status, deployer cluster states), then again with `confirm: "goodbye <stackName>"` to execute. |

All tools that accept a `cluster_id` parameter default to `cluster_0` when omitted, so single-cluster workflows work without specifying an ID.

### Configuration flags

The `cluster_config_set` tool accepts these fields (all dynamically reloadable between iterations unless noted):

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `concurrency` | number | 4 | Number of agents (requires restart) |
| `instanceType` | string | `t4g.medium` | EC2 instance type (requires restart) |
| `algorithm` | string | `amorphous` | Coordination algorithm: amorphous, mesh, swarm, single |
| `neighbourRadius` | number | 2 | Ring radius (amorphous only) |
| `swarmK` | number | 4 | Peer count (swarm only) |
| `loopIntervalSeconds` | number | 10 | Seconds between agent iterations |
| `browserAutomation` | boolean | false | Agents get a Puppeteer MCP server for headless browser automation |
| `selfOptimizing` | boolean | false | Agents append self-reflections to their per-agent directive |
| `autopause` | boolean | true | Cluster pauses itself after 3 consecutive all-idle iterations |

### Multi-cluster usage

For WeltenBuilder (multi-cluster) workflows, pass `cluster_id` to target specific clusters. Use parallel tool calls to sweep status or logs across all clusters simultaneously:

```
# Parallel status sweep
cluster_status(cluster_id="team-frontend")
cluster_status(cluster_id="team-backend")
cluster_status(cluster_id="qa-integration")
```

## Setup

### 1. Build

```bash
npm install
npm run build
```

### 2. Configure

Run the setup script. It reads everything it needs from your deployed CloudFormation stack and writes the MCP config to `~/.kiro/settings/mcp.json`.

```bash
./scripts/get-mcp-env.sh --region <your-region>
```

The script will:
1. Pull `ApiUrl`, `BucketName`, `UserPoolId`, `UserPoolClientId`, and `CognitoDomain` from the `AgaStack` CloudFormation outputs
2. Detect your active AWS profile automatically
3. Write the MCP server config to `~/.kiro/settings/mcp.json`
4. Install the **kiro-flock-compact** orchestration skill to `~/.kiro/skills/`, removing the superseded `kiro-flock`, `weltenbuilder` and `everforge` skills if present
5. Check that your local AWS identity has `s3:PutObject` access to the bucket, and offer to attach an inline policy if not

**Options:**

| Flag | Default | Description |
|------|---------|-------------|
| `--stack` | `AgaStack` | CDK stack name |
| `--region` | `$AWS_DEFAULT_REGION` or `us-east-1` | AWS region |
| `--profile` | (auto-detected) | AWS CLI profile |

### 3. Reconnect

After the script runs, reconnect the `kiro-flock-feed` MCP server in Kiro (MCP panel, reconnect). The first tool call will open your browser for login.

## Typical workflow

### Single cluster

```
1. direction_set        — tell the cluster what to do
2. cluster_start        — launch EC2 agents (archives environment/, appends read instruction to direction)
3. env_upload            — upload context files into environment/ after start
4. stream_logs          — poll until clusterState is stopped or agents are idle
5. env_list             — see what agents produced
6. env_read             — read the results
7. cluster_stop         — shut down
```

### Multi-cluster (WeltenBuilder)

```
1. direction_set(cluster_id="team-frontend", ...)   — set each cluster's direction
   direction_set(cluster_id="team-backend", ...)
   direction_set(cluster_id="qa-integration", ...)
2. cluster_config_set(cluster_id=..., config={...}) — configure each cluster
3. cluster_start(cluster_id="team-frontend")        — launch teams
   cluster_start(cluster_id="team-backend")
   cluster_start(cluster_id="qa-integration")
4. env_upload(cluster_id=..., ...)                  — feed shared context
5. Parallel stream_logs / cluster_status sweeps     — monitor all clusters
6. env_list + env_read per cluster                  — collect results
7. cluster_stop per cluster                         — shut down
```

### Deployment

```
1. cluster_config_set(cluster_id=..., config={      — decide once, at config time
     trustDeploy: true, ... })
2. deploy_record_list                               — browse deployment history
```

Trust is decided when the cluster is configured. `cluster_start` pre-writes a trusted marker for every agent in a `trustDeploy` cluster, so agents deploy from their first iteration. Clusters without it get a terminal `deploy_disabled` from `deploy_request` — there is no runtime approval step and nothing for an agent to wait on.

Agents in different clusters can read and write to each other's environment folders directly (the S3 MCP bridge allows cross-cluster access). Platform and QA clusters use this to enforce standards and check consistency without the local agent shuttling files.

Context files uploaded via `env_upload` land in `environment/` after the archive step, so agents find them in the fresh workspace on their first iteration. The direction is automatically appended with "Read the environment/ directory first." when you call `env_upload`, so agents know to look there.

For durable reference material that should survive across runs, use `kb_upload`. Treat the knowledge-base as shared long-term memory — stale or wrong material there will contaminate every future run.

## Notes

- `cluster_start` config overrides (concurrency, neighbourRadius, etc.) are persisted to S3 before launching, so the dashboard and status endpoint always reflect the actual running config.
- Agent logs are NDJSON, one JSON object per line: `{ts, iteration, action, result, next_intent}`.
- `environment/` and `store/` are archived to `history/<datetime>/` on each new start. `knowledge-base/` is not archived — it is durable reference material intended to survive across runs.

## Debugging agent behavior with ACP sessions

When `stream_logs` and `store_read` only show you the one-line summary each agent broadcasts, and you need to understand *why* an agent did something, use the ACP session tools to read the full conversation transcript directly from the running EC2 instance.

### Quick workflow

```
1. list_acp_sessions(cluster_id="my-cluster", agent_index=0)
   → See all available sessions: IDs, sizes, active/completed status, offsets

2. stream_acp(cluster_id="my-cluster", agent_index=0)
   → Read the most recent completed iteration (full transcript)

3. stream_acp(cluster_id="my-cluster", agent_index=0, offset=2)
   → Go back to an earlier iteration
```

### What you get

The formatted transcript shows the complete agent conversation:
- The full system prompt (direction, agent loop, self-optimization directive)
- Every tool call the agent made (with parameters)
- Every tool result it received
- Every reasoning step and decision

This is invaluable for diagnosing:
- Why an agent is stuck in a loop (e.g. deploy requests never getting approved)
- What data it read that led to a decision
- Whether it's following its direction correctly
- Token/context issues where the agent loses track of its intent

### Performance notes

Each `stream_acp` call reads a full session (300-550KB) via chunked SSM commands (10 parallel reads of 22KB each). A single call takes 5-15 seconds depending on session size. **Never call `stream_acp` multiple times in parallel** — the concurrent SSM commands will hit AWS rate limits and cause timeouts. Always call sequentially.
