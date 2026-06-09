---
name: kiro-flock
description: Orchestrate kiro-flock clusters for parallel AI agent workloads. Covers agent/radius configuration, data retrieval strategies, and amorphous computing principles. Use when starting a flock cluster, deciding concurrency and neighbourRadius, or retrieving and synthesizing flock output.
---

# Kiro-Flock Orchestration

Guides optimal configuration, execution, and result retrieval from a kiro-flock cluster via the feed-mcp tools.

## 0. Environment vs knowledge-base

A cluster has two distinct shared areas. Knowing which one to use is the single most important operator decision before feeding context or reading results.

### Environment (backed by `environment/`)

- The default working area for agent artifacts within a single run.
- Scratch space for plans, intermediate results, drafts, and final outputs that belong to this cluster run only.
- **NOT automatically cleaned on `cluster_start`.** Restarting a cluster preserves the environment so uploaded context files survive. This also means leftover output from a previous run stays unless you explicitly clean it.
- **To get a fresh environment:** call "Clean Environment" from the UI or use the `clean-env` API endpoint before starting. This archives the environment to history/ and gives the new run a clean slate.
- Use this for almost everything you feed in or read out. Context files, templates, worked examples, the direction's supporting material, whatever the agents produce.

### Knowledge-base (backed by `knowledge-base/`)

- Durable steering material that survives across runs and across projects.
- Persists through `cluster_start` and `cluster_stop`. Nothing here gets archived automatically.
- Use this only for cross-cutting steering docs: coding standards, architectural principles, style guides, compliance rules, tech stack decisions.
- Do NOT put project-specific context here (specs, schemas, requirements, reference implementations). Those belong in the environment.

### Operator guidance

- **Prefer the environment for almost everything.** Project context, specs, schemas, templates, worked examples, direction supporting material, and all agent output goes in the environment.
- **The knowledge-base is for steering docs only.** Things you'd want every future cluster to see regardless of what it's building. Think of it as org-wide coding standards, not project-specific reference material.
- **Only write to the knowledge-base deliberately.** It persists across runs and projects. Stale or wrong material there will contaminate every future cluster that reads it.
- Agents read the knowledge-base each turn to inform their decisions, so treat it as shared long-term memory for standards and principles. Treat the environment as the working area for everything else.

### What `cluster_start` does and does not clean

| What | Cleaned on start? | How to clean manually |
|------|-------------------|----------------------|
| Agent logs (`{clusterId}/store/agent-*.ndjson`) | Yes (archived to history/) | Automatic |
| Environment (`environment/{clusterId}/`) | **No** (preserved for context reuse) | "Clean Environment" in UI or `clean-env` API |
| Knowledge-base (`knowledge-base/`) | No (global, persists always) | Manual S3 delete |

If you restart a cluster expecting a fresh environment, you must clean it first. Restarting without cleaning means agents see leftover files from the previous run. This is intentional (allows context reuse) but catches people off guard.

---

## 0a. Picking an algorithm

Three coordination algorithms ship with kiro-flock. They all use the same EC2 topology and S3 layout. Only the neighbour-selection rule and the prompt fragment differ. See the README "Coordination algorithms" section for the full comparison.

| Algorithm | What each agent reads | Best for |
|-----------|----------------------|----------|
| amorphous | Fixed ring neighbours (R hops) | Parallel map, divergent exploration, large N |
| mesh | Every other agent's last entry | Consensus, design decisions, small-to-medium N |
| swarm | K most recently active peers (by S3 LastModified) | Ideation, theme discovery, following activity |

### Rules of thumb

- **Divergent exploration, parallel map, large N → amorphous.** The ring keeps diversity intact. Signals propagate slowly (`ceil(N / 2R)` iterations to traverse the ring), which is a feature when you want agents to stay independent.
- **Consensus, design decisions, small-to-medium N → mesh.** Every agent sees every other agent's last entry, so alignment happens fast. Mesh scales badly past ~50 agents: each agent's context fills up with neighbour entries, and there's no cap on per-neighbour reads. That's a documented trade-off of the algorithm, not a bug.
- **Ideation, theme discovery, following activity → swarm.** The K most recently active peers are visible, so agents naturally gravitate toward whoever is producing the most. Good when the interesting signal is wherever the energy is clustering. The prompt fragment asks agents to consider whether to follow, diverge, or anchor a new direction, otherwise the swarm collapses onto one hot spot.

Switch algorithms via `cluster_config_set` with `algorithm: "amorphous" | "mesh" | "swarm"` (and `swarmK` for swarm). Changes reload on the next agent iteration, so no restart is needed.

### Scaling per algorithm

Each algorithm has a different ceiling, and for a different reason:

| Algorithm | Comfortable | Possible | What caps it |
|-----------|-------------|----------|--------------|
| mesh | 8–30 agents | up to ~50 | Per-agent context grows linearly with N. LLM context window fills before the run ends. |
| swarm | 20–100 agents | a few hundred (with K tuned up) | Behavioural collapse onto hot spots when N grows and K stays small. Raising K mitigates but trends toward mesh. |
| amorphous | 8–500 agents | 1000+ | Infrastructure limits only (EC2 vCPU quota, S3 request rate). No algorithmic ceiling — neighbour count is always `2R`, independent of N. |

Rule of thumb: pick the algorithm that fits the workload first, then size the cluster to the algorithm's comfortable range. Don't force mesh to handle 200 agents because "more is better" — the output quality degrades before you see the benefit.

---

## 1. Agent Count to Neighbour Radius Ratios

The `neighbourRadius` controls how many neighbours each agent reads. In a ring of N agents with radius R, each agent observes 2R neighbours. The ratio determines information propagation speed vs. diversity.

### Ratio Guidelines by Application

| Strategy | Agents | Radius | Ratio (N:R) | r/n | Why |
|----------|--------|--------|-------------|-----|-----|
| Parallel map | 8-16 | 1 | 8:1-16:1 | 0.06-0.12 | Minimal coordination. Agents self-assign slices by observing immediate neighbours. |
| Self-correcting | 6-10 | 2 | 3:1-5:1 | 0.20-0.33 | Moderate overlap catches errors within 2-3 iterations without suppressing novel paths. |
| Divergent ideation | 8-12 | 1 | 8:1-12:1 | 0.08-0.12 | Low radius preserves diversity. Agents explore independently. |
| Context expansion | 10-16 | 2 | 5:1-8:1 | 0.12-0.20 | Adjacent agents build on each other's findings without global convergence. |
| Consensus building | 4-8 | 2-3 | 2:1-3:1 | 0.25-0.75 | High visibility accelerates agreement. Near-broadcast for fast convergence. |

### Rules of Thumb

- r/n < 0.15: High diversity, slow convergence. Best for exploration and parallel work.
- 0.15 <= r/n <= 0.30: Balanced. Self-correction without losing independence.
- r/n > 0.30: Fast convergence, low diversity. Best for consensus or small clusters.
- Never set radius >= N/2: Full connectivity eliminates locality benefits.
- Radius = 1 is the safe default for most parallel workloads.

### Information Propagation Speed

Information propagates at R hops per iteration. Full propagation across a ring of N agents takes `ceil(N / (2R))` iterations.

| N | R | Iterations to full propagation |
|---|---|-------------------------------|
| 8 | 1 | 4 |
| 8 | 2 | 2 |
| 16 | 2 | 4 |
| 5 | 2 | 2 (fully connected) |

To ensure all agents see a critical update within K iterations: set `R >= ceil(N / (2K))`.

---

## 2. Data Retrieval Strategies

### 2.1 Polling for Completion

```
loop:
  response = stream_logs()
  if response.clusterState == "stopped" -> break
  if all_agents_idle_for(2+_consecutive_iterations) -> cluster_stop(); break
  wait 30s  (15s for consensus tasks, 60s for deep research)
```

### 2.2 Reading Results

```
1. stream_logs      - confirm convergence
2. env_list         - enumerate produced files in the environment
3. env_read         - read each relevant artifact from the environment
4. kb_list / kb_read- check the durable knowledge-base for reference material (persists across runs)
5. cluster_stop     - terminate instances
```

### 2.3 Retrieval Patterns by Application

| Application | What to Read | When | Strategy |
|---|---|---|---|
| Parallel map | All environment files | After all agents idle | Each agent produces one artifact in the environment. Read all, merge. |
| Self-correcting | Latest version only | After convergence | Last write wins. Discard early drafts. |
| Divergent ideation | All unique environment files | After 2-3 iterations (before convergence) | Collect all for diversity. Stop early. |
| Context expansion | knowledge-base + environment | After agents idle | Agents write durable findings to the knowledge-base. Check both. |
| Consensus | The converged artifact | After 5-7 iterations | Find the file multiple agents reference in logs. |

### 2.4 Log Mining for Consensus

To determine which outputs represent consensus:
1. Read all agent logs via `stream_logs`
2. Look for repeated `action` verbs across adjacent agents, 3+ agents performing the same action = convergence cluster
3. The `result` field of converged agents points to the authoritative output

### 2.5 Tips

- Use `env_list` before reading, don't assume filenames.
- Check agent `result` fields for file paths they wrote.
- For divergence tasks, stop early (2-3 iterations) to capture diverse perspectives.
- For consensus tasks, let the flock run to full convergence (5-7 iterations).
- Upload templates via `env_upload_file` so agents produce predictably-structured output.

---

## 3. Amorphous Computing Optimizations

### 3.1 Gradient-Based Task Distribution

In a ring topology, tasks distribute like a gradient, agent 0 starts something, agent 1 sees it and picks the next piece. Design directions that allow sequential decomposition along the ring. Feed context files early so gradient formation begins on iteration 1.

### 3.2 Growing-Point Strategy (Phased Direction)

Set direction in phases. Start broad ("research X"), let agents converge, then narrow ("implement Y based on the research"). The direction acts as a morphogen signal that shapes behaviour. The first agent to act becomes a de-facto growing point; neighbours avoid duplicating it.

### 3.3 Redundancy as Error Correction

Multiple agents producing similar output is a feature:
- Confirms correctness (consensus signal)
- Provides alternatives to choose from
- Self-corrects errors (outlier detection)

For correctness-critical tasks, allow 2-3 agents to work on the same subtask independently, then have remaining agents compare and merge.

### 3.4 Quorum Sensing (Idle Detection)

Agents detect cluster-wide state by reading neighbours. When most visible neighbours are idle, an agent goes idle too. Completion time after last productive agent: `ceil(N / (2R))` iterations.

| N | R | Idle propagation time |
|---|---|----------------------|
| 8 | 1 | ~4 iterations |
| 8 | 2 | ~2 iterations |
| 16 | 2 | ~4 iterations |

### 3.5 Spatial Decomposition

Enumerate subtasks explicitly in the direction (e.g., "Process files A through Z"). Agents naturally distribute across the list by observing which items neighbours have claimed. Ring position creates implicit spatial assignment.

### 3.6 Stigmergy (Indirect Coordination)

Agents coordinate through shared artifacts, not messaging:
- Feed reference files into the environment before starting to establish a shared baseline for this run
- Use the knowledge-base for durable coordination artifacts that should persist across runs
- Include a "plan.md" or "status.md" in fed context to bootstrap coordination
- Structure direction to encourage intermediate results others can build on

### 3.7 Idempotent Contributions

Design directions so duplicate work is harmless: last-write-wins semantics, or additive contributions to different files. Don't demand unique output from each agent, let deduplication emerge through observation.

### 3.8 Hot-Spot Avoidance

If all agents converge on the same subtask, update direction mid-run via `direction_set` (mention "spread out" or enumerate unclaimed work). Agents self-correct within 2 iterations. Mid-run direction changes propagate instantly since all agents read direction.md each iteration.

---

## 4. Configuration Reference

| Parameter | Default | Optimization |
|---|---|---|
| `concurrency` | - | Match to task parallelism. 5-8 for most tasks. 12-16 for large map workloads. |
| `neighbourRadius` | 1 | See ratio table above. |
| `loopIntervalSeconds` | 30 | 15s for fast consensus. 60s for deep research. Reloads live on each running agent's next iteration — safe to tweak via `cluster_config_set` mid-run. |
| `autopause` | true | When every agent has been idle for three consecutive iterations, the cluster pauses itself. Leave on unless you want a cluster that will keep billing if forgotten. |
| `instanceType` | t4g.medium | Upgrade to t4g.large only for large context processing. |

Other fields (`concurrency`, `instanceType`, `model`) are start-time only. Changes persist in `config.json` but don't apply until the next `cluster_start`.

### Pause and resume

Use `cluster_pause` to park a running flock between iterations without terminating it. EC2 instances stay alive, logs and environment stay in place, agents simply stop spawning new work until `cluster_resume` is called. The primary use case is an idling cluster that converged on something interesting: pause it, inspect the environment, maybe update the direction, then resume. A paused cluster does not generate new log entries, so `stream_logs` stops being useful until you resume — check `cluster_status` for the `paused` state instead of polling. If you want to terminate rather than park, use `cluster_stop` as before.

---

## 4a. Local Execution on EC2 (Secondary, Not Default)

Agents have access to the local filesystem and CLI tools on their EC2 instance at `~/kiro-flock-workspace/`. This is a secondary capability, not the primary workflow. Agents write to S3 by default. Local execution is only for tasks that genuinely require it: compiling to verify correctness, running a test suite, or executing generated code to check output.

### When agents use local execution

- Verifying that code they wrote actually compiles
- Running a test to confirm behavior before writing results to S3
- Executing a generated program to capture its output
- Any task where "does this actually work?" can only be answered by running it

### When agents should NOT use local execution

- Writing source files (write to S3 environment instead)
- Storing results (write to S3)
- Anything that another agent or the operator needs to see (S3)
- Installing large dependencies just to check syntax (unnecessary)

### Visibility

- Local files are NOT visible to other agents, neighbours, or the operator
- Local files are destroyed when the cluster stops
- Agents are required to log every local operation to `local-ops-log.md` in their S3 environment BEFORE executing it
- If a local execution produces a meaningful result, agents write it back to S3

### How to reference this in directions

Only mention local execution if the task benefits from it. Keep it brief:

```markdown
## Verification

You may use ~/kiro-flock-workspace/ to compile or run code locally for
verification. Log every local operation to local-ops-log.md first. Write
results back to S3.
```

The agent loop prompt already enforces these rules, but repeating them in the direction reinforces the behavior.

### Checking local-ops logs

```
env_read(cluster_id="...", key="environment/.../local-ops-log.md")
```

Shows timestamped entries of local operations. Useful for debugging.

### Limitations

- The AWS CLI is available but NOT restricted. Be careful what you prompt for.
- Local disk is ephemeral. Anything not written back to S3 is lost on cluster stop.
- Agents share no local state. Each runs on its own EC2 instance.

---

## 5. Anti-Patterns

- Per-agent instructions in direction. Direction is shared, let agents self-organise.
- Expecting deterministic output. Amorphous systems are probabilistic. Same direction produces different but equivalent results.
- Radius = concurrency - 1. Destroys locality, causes identical output from all agents.
- Feeding too much context. Each agent has a context window. Feed only what's needed; use the knowledge-base for durable on-demand reference material that survives across runs.
- Reading mid-run. Partial output may be incomplete or contradictory. Wait for convergence.

---

## 6. Quick Reference

| Workload | Agents | Radius | Ratio | Iterations to converge |
|----------|--------|--------|-------|----------------------|
| Parallel map | 8 | 1 | 8:1 | 3-5 |
| Self-correcting | 6 | 2 | 3:1 | 5-7 |
| Ideation | 10 | 1 | 10:1 | 4-6 |
| Research | 10 | 2 | 5:1 | 5-8 |
| Consensus | 8 | 3 | 2.7:1 | 5-7 |

---

## 7. Workflow Examples

### Parallel map (review 8 files)
```
direction_set: "Review each file in environment/context/. Write findings to environment/review-<filename>.md. Check neighbours to avoid reviewing the same file."
cluster_config_set: { concurrency: 8, neighbourRadius: 1 }
env_upload_folder: ./files-to-review -> environment/context/
cluster_start
# Poll stream_logs every 30s until all agents idle for 2 iterations
# env_list + env_read each review file
# cluster_stop
```

### Consensus (design decision)
```
direction_set: "Design the API for X. Write your proposal to environment/. Read neighbours and converge on a single design."
cluster_config_set: { concurrency: 5, neighbourRadius: 2 }
env_upload_file: ./requirements.md -> environment/context/requirements.md
cluster_start
# Poll stream_logs every 15s until convergence (agents referencing same design)
# env_read the converged design
# cluster_stop
```

### Divergent ideation
```
direction_set: "Generate 10 distinct approaches to solving X. Each agent should explore a unique angle. Do not converge."
cluster_config_set: { concurrency: 10, neighbourRadius: 1 }
env_upload_file: ./problem-statement.md -> environment/context/problem.md
cluster_start
# Poll stream_logs -- stop after 2-3 iterations (before convergence)
# env_list + env_read all files for diverse perspectives
# cluster_stop
```

---

## 8. Post-Run Analysis

After a cluster run completes, use `store_read_all` to load every agent's full iteration log and produce a structured analysis of how the cluster behaved. This is the most valuable diagnostic for understanding emergent coordination.

### 8.1 How to Run the Analysis

```
1. store_read_all     — get all agent logs from the last run
2. Analyze the data   — apply the patterns below
3. Write the report   — use the format in 8.3
```

### 8.2 What to Look For

**Iteration 0 (the land grab).** In the first iteration, agents have no neighbour context. Look for:
- How many agents picked the same task (overlap count)
- Which agents uniquely claimed a task (no overlap)
- Whether the overlap pattern matches the expected r/n ratio: low radius = more overlap, high radius = less

**Iteration 1+ (gap filling).** Agents now see neighbours. Look for:
- Tasks that were missing after iteration 0 and got picked up
- Whether agents that overlapped in iteration 0 diverged in iteration 1
- Unique contributions: agents that noticed something others missed (missing dependencies, edge cases, bugs)

**Convergence iterations.** For consensus tasks, look for:
- When agents start referencing the same output files in their `result` field
- The iteration where 3+ agents perform the same `action` (convergence signal)
- Whether any agent held a dissenting position and for how long

**Idle propagation.** Once productive work stops:
- Which agent went idle first
- How many iterations until all agents were idle (compare to theoretical `ceil(N / (2R))`)
- Whether any agent broke idle to do one more pass (self-correction signal)

**Standouts.** Identify agents that:
- Caught bugs or missing pieces others missed
- Were the only one to claim a specific task without overlap
- Produced the output that became the consensus artifact
- Went against the group and turned out to be right

### 8.3 Report Format

Structure the analysis as a "Work Log" with these sections:

```markdown
## Kiro-Flock Work Log

<One paragraph summary: agent count, radius, total productive time, direction.>

### Iteration 0 (the land grab)
<Which agents picked what. Overlap analysis. Unique claims.>

### Iteration 1 (gap filling)
<How agents reacted to neighbours. New tasks picked up. Unique catches.>

### Iteration N (convergence / cleanup)
<When agents started agreeing. What the converged output looks like.>

### Iterations N+1 to end (idle)
<When idle propagation started. How long it took. Whether it matched theory.>

### Standouts
<Name specific agents and what they did that was notable.>
```

Adapt the section names to what actually happened. If the cluster diverged instead of converging, say so. If agents never went idle (timeout), note that too.

### 8.4 Reading the Log Data

Each agent's log is an array of NDJSON entries:

```json
{
  "ts": "2026-04-29T12:51:23.456Z",
  "iteration": 0,
  "action": "Wrote environment/server.ts — MCP server skeleton with tool definitions",
  "result": "environment/server.ts",
  "next_intent": "Check neighbours and fill gaps"
}
```

Key fields for analysis:
- `action`: what the agent did (look for repeated actions across agents = overlap)
- `result`: what file it wrote (look for convergence on the same file)
- `next_intent`: what it plans to do next (look for "idle" = done)
- `iteration`: the iteration number (group by this for timeline analysis)
- `ts`: wall clock time (use first and last ts to compute productive duration)


---

## 9. Agentic Map-Reduce

Map-reduce is a precision tool for fine-grained agent control. It operates at the agent level (not just cluster level) and supports cross-cluster targeting. Use it when the self-organizing cluster needs a nudge, or when you need to observe specific agents without reading the entire store.

### 9.1 When to Use Map-Reduce

**Use reduce (observation) as the primary use case:**
- "What have agents with >5 iterations produced?"
- "Which agents are idle in team-auth?"
- "Summarize the auth team's progress"

**Use map (intervention) sparingly:**
- Agents are stuck on the wrong subtask
- You need a subset of agents to pivot without changing the cluster direction
- A specific agent needs a one-off instruction that doesn't apply to the whole cluster

**Don't use map when:**
- The whole cluster needs to change direction (use `direction_set` instead)
- You want to change the algorithm or config (use `cluster_config_set`)
- The cluster is self-organizing correctly (leave it alone)

### 9.2 The Two Tools

**`mapreduce_prompt`** — natural language. Type what you want in English. A Bedrock call translates it into a structured operation, then the engine executes it. Use this from the WeltenBuilder UI text field or when you don't know the exact filter criteria.

**`mapreduce_exec`** — structured. Skip the translation layer. Pass the operation directly. Faster (one fewer Bedrock call). Use this when you already know the exact filter and operation.

### 9.3 Per-Agent Directives

Map operations write a directive file to each targeted agent: `{clusterId}/store/agent-{N}.directive.md`. On the next iteration, the agent sees it and follows it alongside the cluster direction.

Key properties:
- Directives take priority over the cluster direction where they conflict
- Both are loaded (directive + direction). They coexist.
- Directives persist until explicitly cleared (`map-clear`)
- Clearing a directive returns the agent to pure self-organization

### 9.4 Filter Criteria

Filters compose with AND logic:

| Field | What it does |
|-------|-------------|
| `clusters` | Target specific cluster IDs |
| `agentIndexes` | Target specific agent indexes |
| `actionRegex` | Match against the agent's last action |
| `iterationGte` | Only agents with N+ iterations |
| `iterationLte` | Only agents with N or fewer iterations |
| `all` | Every agent in every non-stopped cluster |

A single-cluster operation is just `{clusters: ["team-auth"]}`. No special case.

### 9.5 Examples

**Observe idle agents:**
```
mapreduce_prompt: "Which agents are idle across all clusters?"
```

**Pivot a subset:**
```
mapreduce_exec: {
  operation: {
    type: "map",
    filter: { clusters: ["team-auth"], agentIndexes: [0, 1, 2] },
    directive: "Focus exclusively on token refresh. Ignore session management."
  }
}
```

**Summarize progress:**
```
mapreduce_prompt: "Summarize what team-backend has produced after 3 iterations"
```

**Clear directives after the nudge worked:**
```
mapreduce_exec: {
  operation: {
    type: "map-clear",
    filter: { clusters: ["team-auth"] }
  }
}
```

### 9.6 Results

All map-reduce operations produce a tab in the analyzer panel (titled "map/reduce"). Results include:
- The original prompt (if natural language was used)
- The resolved operation (what filter matched)
- The result data (for reduce) or confirmation (for map)

### 9.7 Anti-Patterns

- **Using map on every iteration.** You've built a central orchestrator. Let agents self-organize.
- **Leaving directives forever.** Clear them once the nudge has taken effect. Stale directives confuse agents.
- **Using map instead of direction_set.** If all agents need the same change, update the direction. Map is for subsets.
- **Reduce/summarize on a running cluster every 30 seconds.** Each summarize call costs a Bedrock invocation. Use extract for frequent checks, summarize for periodic deep dives.
