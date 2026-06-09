# kiro-flock-feed-mcp

A local MCP server that lets a Kiro agent drive a remote kiro-flock cluster.

kiro-flock is a distributed multi-agent system that runs a configurable cluster of Kiro agents on EC2. Each agent operates independently, reads its neighbours' logs, and coordinates through an append-only shared workspace in S3. You give the cluster a direction (a goal), and agents converge on it through local interaction over several iterations.

This MCP is the interface between a local Kiro agent and a running kiro-flock cluster. It lets you upload context files into the cluster, set the direction, start and stop it, stream agent logs, and read what agents produced, all through MCP tool calls.

## Prerequisites

You need a deployed kiro-flock cluster in your own AWS account. Deploy it first by following the instructions in the [kiro-flock-cluster README](../kiro-flock-cluster/README.md), then come back here.

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

- **environment/**: per-run working area. Preserved across runs; use Clean Environment to archive it. Use this for almost everything.
- **knowledge-base/**: durable reference material. Persists across runs. Use only when the direction calls for persistent material.

| Tool | Description |
|------|-------------|
| `cluster_status` | Current state, per-agent logs, metrics |
| `cluster_start` | Launch EC2 agents. Appends "Read the environment/ directory first." to the direction automatically. |
| `cluster_stop` | Terminate all instances |
| `cluster_config_get` | Read current config (concurrency, instance type, etc.) |
| `cluster_config_set` | Update config for the next start |
| `direction_get` | Read the current direction |
| `direction_set` | Set the direction. Must be called before `cluster_start`. |
| `env_upload_file` | Upload a local file into `environment/` after cluster start. Agents read it on their next iteration. |
| `env_upload_folder` | Recursively upload a local folder into `environment/` |
| `env_list` | List files in the per-run environment |
| `env_read` | Read a single file from the environment |
| `kb_upload_file` | Upload a local file into `knowledge-base/`. Persists across runs. Use only when the direction calls for durable reference material. |
| `kb_upload_folder` | Recursively upload a folder into `knowledge-base/` |
| `kb_list` | List files in the persistent knowledge-base |
| `kb_read` | Read a single file from the knowledge-base |
| `stream_logs` | Fetch latest agent log entries. Returns immediately. Call in a loop, stop when `clusterState` is `stopped` or all agents show `idle` as `next_intent`. |
| `store_list` | List agent log files in `store/`. Each agent writes an append-only NDJSON file per run. |
| `store_read` | Read the full iteration log for a single agent. Returns all entries as structured JSON. |
| `store_read_all` | Read all agent logs from the last run. Returns every agent's full history plus summary stats. Use for post-run convergence/divergence analysis. |
| `env_download_all` | Download environment files as a zip to a local path. Useful for pulling agent output to your local machine. |
| `clusters_list` | List all registered clusters with live state. Use to discover cluster IDs before targeting them. |
| `cluster_pause` | Pause a running cluster between iterations. Instances stay alive, agents stop working until resumed. |
| `cluster_resume` | Resume a paused cluster. Agents pick up on the next poll cycle. |
| `mapreduce_prompt` | Execute a map-reduce operation using natural language. Bedrock translates to structured operations targeting specific agents. |
| `mapreduce_exec` | Execute a structured map-reduce operation directly, bypassing the natural language layer. Faster than `mapreduce_prompt`. |

All tools that accept a `cluster_id` parameter default to `cluster_0` when omitted, so single-cluster workflows work without specifying an ID.

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
4. Install the **kiro-flock** and **weltenbuilder** orchestration skills to `~/.kiro/skills/`
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
2. cluster_start        — launch EC2 agents (archives store/, appends read instruction to direction)
3. env_upload_file      — upload context files into environment/ after start
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
4. env_upload_file(cluster_id=..., ...)             — feed shared context
5. Parallel stream_logs / cluster_status sweeps     — monitor all clusters
6. env_list + env_read per cluster                  — collect results
7. cluster_stop per cluster                         — shut down
```

Agents in different clusters can read and write to each other's environment folders directly (the S3 MCP bridge allows cross-cluster access). Platform and QA clusters use this to enforce standards and check consistency without the local agent shuttling files.

Context files uploaded via `env_upload_file` land in `environment/` and agents find them on their next iteration. The direction is automatically appended with "Read the environment/ directory first." when you call `env_upload_file`, so agents know to look there.

For durable reference material that should survive across runs, use `kb_upload_file` / `kb_upload_folder`. Treat the knowledge-base as shared long-term memory. Stale or wrong material there will contaminate every future run.

## Notes

- `cluster_start` config overrides (concurrency, neighbourRadius, etc.) are persisted to S3 before launching, so the dashboard and status endpoint always reflect the actual running config.
- Agent logs are NDJSON, one JSON object per line: `{ts, iteration, action, result, next_intent}`.
- `store/` is archived to `history/<datetime>/` on each new start so agent logs begin clean. `environment/` is preserved across runs (use Clean Environment to archive it). `knowledge-base/` is never archived, it is durable reference material intended to survive across runs.

## License

Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.

Apache License 2.0 with attribution. See [LICENSE](../LICENSE).

**Author:** Ivo Kammerath<br>
**Reviewer:** Martin Karrer, Ben Freiberg
