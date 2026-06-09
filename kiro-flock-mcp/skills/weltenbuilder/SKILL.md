---
name: weltenbuilder
description: Incubate multiple kiro-flock clusters as a self-organizing system using the WeltenBuilder pattern. Covers multi-cluster planning, team distribution, cross-cluster coordination, parallel status retrieval, and naming conventions. Requires the kiro-flock skill to be loaded first.
---

# WeltenBuilder Incubation

Guides the local agent in planning, launching, and releasing multiple kiro-flock clusters as a self-organizing system. Each cluster acts as an autonomous team; the local agent acts as the incubator that seeds them and steps back.

## Prerequisites

**Load the kiro-flock skill first.** This skill builds on top of it. The kiro-flock skill covers single-cluster mechanics (algorithm selection, radius tuning, data retrieval). This skill covers multi-cluster coordination.

**Both CLI and MCP must be authenticated.** The local agent needs:
- The `kiro-flock-feed-mcp` MCP server configured and authenticated (run `get-mcp-env.sh` if not)
- AWS CLI access to the same account (for any direct S3 or EC2 operations)

Both use the same Cognito token. If one works, the other should too. If the MCP returns auth errors, re-run `get-mcp-env.sh`.

---

## 1. The WeltenBuilder Pattern

WeltenBuilder is not a tool. It's a coordination pattern where the local agent (you, running in the user's IDE) acts as an incubator that spawns and manages multiple kiro-flock clusters, each with a distinct role.

The key principle: **the local agent incubates, the clusters execute everything.** The local agent sets directions, launches clusters, monitors progress, and retrieves results. It never creates project files, writes code, generates contracts, or produces any artifact that belongs to the project. All creative and productive work happens inside clusters. Clusters never spawn other clusters. The local agent is always the incubator, never a contributor or a conductor.

### The incubator-only rule

The local agent does NOT:
- Write code files locally (no `fs_write` for project source)
- Create API contracts, schemas, or specs as local files to upload
- Generate seed data, config files, or any project artifact
- Do "prep work" that a cluster could do instead
- Design interface contracts (that's a contracts cluster's job, see section 13)

The local agent DOES:
- Plan the cluster topology (which teams, how many agents, what algorithm)
- Write directions (the directions themselves are the only "creative" output of the local agent)
- Set configs and launch clusters
- Monitor progress via status sweeps and log reads
- Stop/pause/resume clusters
- Read final output and present it to the user
- Download environment files to the user's local machine when the user asks for delivery

If something needs to exist before clusters can start (like an interface contract or shared schema), use a dedicated contracts cluster to produce it. The contracts cluster converges fast (mesh, 3-5 agents) and writes the contract to the shared environment where all teams observe it via stigmergy. The local agent provides architectural intent in directions, not the contract itself. See section 13.

### Roles in a WeltenBuilder deployment

| Role | What it does | Typical algorithm |
|------|-------------|-------------------|
| Feature team | Builds a specific feature or component | amorphous (parallel map) |
| Platform team | Enforces shared patterns, tech stack, integration contracts | mesh (consensus) |
| QA/Integration team | Checks cross-cluster consistency, finds conflicts | mesh or swarm |
| Coordinator cluster | Monitors other clusters, fixes drift, resolves conflicts | mesh (small, 3-5 agents) |
| Planning cluster | Breaks down a large goal into team assignments | mesh (consensus, short-lived) |

Not every deployment needs all roles. A simple two-team split (frontend + backend) might only need two feature clusters and one integration cluster.

---

## 2. Cluster Naming

Cluster IDs must match `^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$`. Use meaningful names that encode the cluster's role. The `name` field in the registry is a display label (shown in the WeltenBuilder UI cards) and can be more descriptive.

### Naming convention

```
{role}-{domain}
```

Examples:
- `team-auth` (feature team building authentication)
- `team-payments` (feature team building payment processing)
- `platform-contracts` (platform team enforcing API contracts)
- `qa-integration` (QA cluster checking cross-team consistency)
- `coord-main` (coordinator cluster monitoring all others)

For the display name (passed as `name` to the create API), use a human-readable label:
- "Auth Team" 
- "Payment Processing"
- "Platform Contracts"
- "Integration QA"
- "Main Coordinator"

### Why naming matters

In a 10-cluster deployment, `cluster_3847` tells you nothing. `team-auth` tells you exactly what that cluster is responsible for. When the local agent reads status across all clusters, meaningful names let it reason about the system without looking up what each cluster does.

### Cluster IDs are S3 folder names

The cluster ID is not just a label. It becomes the literal S3 prefix for that cluster's environment folder: `environment/{cluster_id}/`. Every file an agent writes lands under that path. When other clusters (QA, coordinator, platform) need to read a team's output, they navigate to `environment/{cluster_id}/`.

This means:
- A cluster named `cluster_0` produces files at `environment/cluster_0/packages/backend/src/server.ts`
- A cluster named `team-backend` produces files at `environment/team-backend/packages/backend/src/server.ts`

The second is immediately obvious to any agent (or human) browsing the environment. The first requires looking up what `cluster_0` was assigned to do.

**Cross-cluster directions reference these paths directly.** When you write a QA direction that says "read environment/team-frontend/ and environment/team-backend/", those paths only make sense if the cluster IDs are meaningful. If you used `cluster_0` and `cluster_3219`, the QA direction would need to say "read environment/cluster_0/ and environment/cluster_3219/" which is opaque and error-prone.

**Reusing a cluster ID means inheriting its environment folder.** If a previous run used `team-backend` and you launch a new deployment with the same ID, the new agents see leftover files from the old run in `environment/team-backend/`. This can confuse agents into thinking work is already done, or cause them to build on stale output. Either clean the environment first (dashboard Clean Environment button or `POST /cluster/clean-env/{id}`) or pick a fresh name (e.g. `team-backend-v2`, `team-backend-chat`).

**Never use generic cluster IDs.** Do not use `cluster_0`, numbered IDs, or the default cluster for real deployments. Always create a named cluster with a role-based ID. The default `cluster_0` is for quick single-cluster experiments only. Multi-cluster deployments must use explicit names for every cluster, no exceptions. If you find yourself about to call `cluster_start` without a `cluster_id`, stop and pick a name first.

**Never reuse generic cluster IDs** (like `cluster_0`, `cluster_3219`, `cluster_8512`) from the registry for new deployments. Always create fresh clusters with meaningful names. The generic IDs exist from earlier experiments and should be left alone.

---

## 3. Planning the Deployment

Before launching anything, the local agent must plan the cluster topology. This is the most important step and should not be skipped.

### Planning checklist

1. **Decompose the goal into teams.** What are the independent workstreams? Each becomes a feature cluster.
2. **Identify shared concerns.** Are there cross-cutting patterns (API style, error handling, shared types, deployment config)? These become platform cluster responsibilities.
3. **Decide on coordination needs.** Will teams produce artifacts that must integrate? Add a QA/integration cluster.
4. **Size each cluster.** Use the kiro-flock skill's ratio guidelines. Feature teams are typically 5-8 agents. Platform and QA clusters are smaller (3-5 agents, mesh algorithm).
5. **Write directions for each cluster.** Each direction must be self-contained. A cluster cannot read another cluster's direction. Cross-references go through the environment or knowledge-base.

### Planning is done locally (but produces no files)

The local agent does the planning. It decides the cluster topology, writes directions, and launches. It does NOT produce any project artifacts as part of planning. No contract files, no schema files, no spec documents written to disk. Everything the clusters need is produced by a cluster (contracts cluster for interfaces, feature clusters for code) or already exists on the user's machine.

Do not create a "planning cluster" unless the decomposition itself is genuinely complex (e.g., breaking down a 50-page spec into team assignments). For most cases, the local agent can plan directly and launch immediately.

If a planning cluster is needed, make it short-lived: mesh algorithm, 3-5 agents, consensus workload. Read its output, then stop it and launch the real teams based on its plan.

---

## 4. Launching Multiple Clusters

Use the MCP tools to launch clusters in sequence. Each cluster needs:
1. Direction set (`direction_set` with `cluster_id`)
2. Config set if non-default (`cluster_config_set` with `cluster_id`)
3. Context uploaded if needed (`env_upload_file` / `env_upload_folder` with `cluster_id`)
4. Start (`cluster_start` with `cluster_id`)

### Launch order

Launch everything at once. All clusters, simultaneously. QA and consolidation clusters observe the shared environment and react to whatever appears. They handle empty environments gracefully on early iterations. Feature teams start with the context embedded in their direction and self-correct as upstream artifacts materialize.

1. Set directions for all clusters
2. Configure all clusters
3. Start all clusters simultaneously

Do not phase launches. Do not wait for a "spec" or "platform" cluster to converge before starting feature teams. The shared environment is the coordination plane. Teams observe it every iteration and react when artifacts appear. Phasing inserts the local agent as a synchronization bottleneck in a system designed to have none.

The only exception: if a contract is genuinely too complex for a single contracts cluster to handle (multiple bounded contexts, dozens of services), split it across multiple contracts clusters. But for most projects, one contracts cluster launched alongside everything else is sufficient. See section 13.

### Example: three-team web app

```
# 1. Set directions for all clusters (reference the contracts cluster's output)
direction_set(cluster_id="platform-contracts", direction="Design the interface contract for...\n\n## Output\nWrite to environment/platform-contracts/...")
direction_set(cluster_id="team-frontend", direction="Build the React UI for...\n\n## Interface contract\nRead environment/platform-contracts/ each iteration...")
direction_set(cluster_id="team-backend", direction="Build the API layer for...\n\n## Interface contract\nRead environment/platform-contracts/ each iteration...")
direction_set(cluster_id="qa-integration", direction="Monitor all teams. Check API contract compliance against environment/platform-contracts/...")

# 2. Configure each cluster
cluster_config_set(cluster_id="team-frontend", config={concurrency: 6, neighbourRadius: 1, algorithm: "amorphous"})
cluster_config_set(cluster_id="team-backend", config={concurrency: 6, neighbourRadius: 1, algorithm: "amorphous"})
cluster_config_set(cluster_id="qa-integration", config={concurrency: 3, neighbourRadius: 1, algorithm: "mesh"})

# 3. Start feature teams (no upload step needed — contract is in the direction)
cluster_start(cluster_id="team-frontend")
cluster_start(cluster_id="team-backend")

# 4. Start QA after a few iterations (or immediately if it polls)
cluster_start(cluster_id="qa-integration")
```

### Uploading user files

The only valid use of `env_upload_file` / `env_upload_folder` is when the user has existing files on their machine that they want clusters to work with (existing codebases to refine, reference implementations, design mockups). The local agent never creates files just to upload them.

---

## 5. Parallel Status Retrieval

When managing many clusters, checking them one by one is slow. Use parallel tool calls to retrieve status from all clusters simultaneously.

### Pattern: parallel status sweep

Call `cluster_status` for every active cluster in a single tool-call batch. The MCP supports parallel invocations. Do this:

```
# All in one parallel batch:
cluster_status(cluster_id="team-frontend")
cluster_status(cluster_id="team-backend")
cluster_status(cluster_id="qa-integration")
cluster_status(cluster_id="coord-main")
```

This returns all statuses in one round-trip. Use the results to decide what needs attention.

### Pattern: parallel log sweep

Same approach with `stream_logs`:

```
# All in one parallel batch:
stream_logs(cluster_id="team-frontend")
stream_logs(cluster_id="team-backend")
stream_logs(cluster_id="qa-integration")
```

Read the latest entries from each cluster simultaneously to build a system-wide picture of progress.

### Pattern: parallel environment reads

When collecting outputs from multiple clusters:

```
# All in one parallel batch:
env_list(cluster_id="team-frontend")
env_list(cluster_id="team-backend")
```

Then read specific files in parallel too.

### When to sweep

- After launching all clusters: confirm they all transitioned to "running"
- Periodically during execution: every 2-3 minutes for active monitoring
- Before making coordination decisions: get fresh state from all clusters
- After any cross-cluster action (feeding artifacts from one cluster to another)

---

## 6. Cross-Cluster Coordination

Clusters are NOT isolated. Every agent can read and write to any cluster's environment folder (`environment/{any_cluster_id}/`). They also share the knowledge-base. This is what makes platform teams, QA clusters, and coordinator clusters possible: they read other teams' output directly and can write fixes or feedback into other teams' environments.

### How agents coordinate across clusters

The S3 MCP bridge grants every agent:
- **Read** access to `environment/` (all clusters), `knowledge-base/`, and their own cluster's `store/`
- **Write** access to `environment/` (all clusters) and their own `store/`
- **List** access to `environment/` (all clusters), `knowledge-base/`, and their own `store/`

This means a QA cluster's agents can `fs_list` and `fs_read` from `environment/team-frontend/` and `environment/team-backend/` directly. A platform cluster can write shared types into `environment/team-frontend/shared/` if its direction tells it to.

### Direction patterns for cross-cluster work

**Platform team reading other teams:**
```markdown
# Platform Contracts

Enforce consistent API patterns across all teams.

## Each iteration
1. List environment/ to discover active team folders
2. Read each team's API-related files
3. Check against the standards in knowledge-base/standards/
4. If a team is drifting, write a fix or feedback file to their environment:
   environment/{team}/platform-feedback.md
5. Write your status to environment/platform-contracts/status.md
```

**QA cluster checking integration:**
```markdown
# Integration QA

Monitor cross-team consistency.

## Each iteration
1. Read environment/team-frontend/src/ and environment/team-backend/src/
2. Check that frontend API calls match backend endpoints
3. Check shared type usage is consistent
4. Write issues to environment/qa-integration/issues/
5. If critical: write a warning to the offending team's environment
```

**Coordinator cluster fixing drift:**
```markdown
# Coordinator

Monitor all teams and fix conflicts.

## Each iteration
1. List environment/ to see all active clusters
2. Read each team's latest output
3. If two teams contradict each other, write a resolution to both:
   environment/{team-a}/coord-fix.md
   environment/{team-b}/coord-fix.md
4. Write overall status to environment/coord-main/status.md
```

### When the local agent should intervene

The local agent (you) should only step in for things agents cannot do:
- Changing a cluster's direction mid-run (`direction_set`)
- Pausing or stopping a cluster
- Starting new clusters
- Uploading local files from the user's machine
- Reading results back to present to the user

For cross-cluster data flow, let the agents handle it through their shared environment access. That's the whole point of the platform/QA/coordinator pattern.

### Using the knowledge-base for steering docs

The knowledge-base is read-only for agents but readable by all clusters. It's meant for cross-project steering material that applies regardless of what any specific cluster is working on: coding standards, architectural principles, style guides, compliance rules. Not project-specific context.

```
# Good: steering docs that apply to everything
kb_upload_file(local_path="./coding-standards.md", key="standards/coding-standards.md")
kb_upload_file(local_path="./api-style-guide.md", key="standards/api-style-guide.md")
kb_upload_file(local_path="./security-policy.md", key="standards/security-policy.md")

# Bad: project-specific context (use the environment instead)
# kb_upload_file(local_path="./api-spec.yaml", ...)  ← put this in environment/
# kb_upload_file(local_path="./schema.graphql", ...) ← put this in environment/
```

Project-specific context (specs, schemas, requirements, reference implementations) belongs in the environment. Feed it via `env_upload_file` to the clusters that need it. The knowledge-base persists across runs and across projects, so only put things there that you'd want every future cluster to see regardless of what it's building.

---

## 7. Direction Writing for Multi-Cluster

Each cluster's direction must be self-contained. An agent in `team-frontend` cannot read `team-backend`'s direction. Cross-references must go through artifacts.

### Good direction patterns for teams

```markdown
# Team Frontend

Build the React UI for the dashboard application.

## Constraints
- Use the API types from environment/shared/api-types.ts (fed by the coordinator)
- Follow the style guide in knowledge-base/standards/
- Write components to environment/src/components/

## Integration points
- The backend team is building the API. The contract is in environment/shared/api-spec.yaml.
- Do not invent endpoints. Use only what the spec defines.
```

### Good direction for a coordinator

```markdown
# Integration Coordinator

You monitor the work of multiple teams building a web application.

## Your job
1. Read environment/team-frontend/ and environment/team-backend/ each iteration
2. Check that frontend API calls match the backend's actual endpoints
3. Check that shared types are used consistently
4. Write any issues found to environment/issues/
5. If everything looks consistent, write environment/status.md with a summary

## Do not
- Write code yourself
- Modify other teams' files
- Make design decisions (flag them as issues for the local operator)
```

---

## 8. Non-Blocking Convergence Patterns

A common deadlock: a team marks itself CONVERGED and goes idle, then QA or the coordinator rejects the convergence and writes fix instructions to the team's environment. The team never reads them because its direction said "go idle after CONVERGED." The cluster burns EC2 doing nothing while the coordinator screams into the void.

### The rule

Every team direction must include a **fix loop** that keeps the team responsive to feedback even after it declares convergence. Convergence is conditional, not terminal.

### Required direction pattern

Always include this block (or equivalent) in every feature team direction:

```markdown
## Fix loop (do not remove)

After writing CONVERGED to your README.md, do NOT fully stop working. Each iteration:
1. Check if `coord-decision.md` or `qa-feedback.md` exists in your environment
2. If either file lists unresolved issues targeting your team:
   - Remove "CONVERGED" from README.md
   - Fix every listed issue
   - Re-append "CONVERGED" only after all issues are addressed
3. If no feedback files exist, or all listed issues are already fixed, remain idle

You are only truly done when CONVERGED is in your README AND no open issues
exist in coord-decision.md or qa-feedback.md.
```

### Why this works

- Teams stay responsive to QA and coordinator feedback without operator intervention.
- The idle-timeout still fires if nobody writes feedback (no wasted EC2 on a team that's genuinely done).
- QA and coordinator clusters can trigger fix loops just by writing a file, which they already do naturally.
- The convergence marker becomes a two-way handshake: team says "I'm done," QA says "confirmed" or "rejected."

### What happens without it

1. Team writes CONVERGED, goes idle.
2. QA finds bugs, writes feedback to the team's environment.
3. Team never reads it (direction says idle = stop reading).
4. Coordinator detects stall, writes coord-decision.md.
5. Team still doesn't read it.
6. Coordinator escalates to "OPERATOR INTERVENTION REQUIRED."
7. Operator must manually update the direction mid-run to unblock.

This is the single most common WeltenBuilder deadlock. The fix loop prevents it entirely.

### For QA and coordinator clusters

QA and coordinator directions should also be aware of this pattern. Their idle condition should be:

```markdown
## Idle condition

Go idle only when:
1. All feature teams have "CONVERGED" in their README, AND
2. You have run a final audit AFTER the most recent CONVERGED marker appeared, AND
3. No issues remain open in your summary

If a team removes and re-adds CONVERGED (fix loop triggered), run another audit pass.
```

This prevents QA from signing off on stale state if a team un-converges and re-converges.

---

## 9. Lifecycle Management

### Stopping clusters

When a feature team converges (all agents idle), stop it and collect its output. Don't leave idle clusters running.

```
# Check if team is done
status = cluster_status(cluster_id="team-frontend")
# If state is "running" but all agents show idle in logs → stop it
cluster_stop(cluster_id="team-frontend")
# Collect output
env_list(cluster_id="team-frontend")
env_read(cluster_id="team-frontend", key="...")
```

### Pausing for inspection

If a cluster is producing interesting intermediate results and you want to inspect before it continues:

```
cluster_pause(cluster_id="team-frontend")
# Read current state
env_list(cluster_id="team-frontend")
env_read(cluster_id="team-frontend", key="...")
# Maybe update direction
direction_set(cluster_id="team-frontend", direction="...updated...")
# Resume
cluster_resume(cluster_id="team-frontend")
```

### Teardown

When the full deployment is done:

```
# Parallel stop all
cluster_stop(cluster_id="team-frontend")
cluster_stop(cluster_id="team-backend")
cluster_stop(cluster_id="qa-integration")
cluster_stop(cluster_id="coord-main")
```

Or use the global action if all clusters should stop:
```
# Via the WeltenBuilder UI: "Stop All" button
# Via MCP: stop each cluster individually (no stop-all MCP tool currently)
```

---

## 10. Anti-Patterns

- **Local file creation.** The local agent never writes project files. No `fs_write` for contracts, schemas, specs, or any artifact. Use a contracts cluster for interface definitions (section 13). The local agent is an incubator, not a contributor.
- **Uploading locally-created artifacts.** If you find yourself writing a file locally just to `env_upload_file` it, stop. Create a cluster to produce it instead. The only exception is uploading files the user already has on their machine (existing specs, reference code they want refined).
- **Clusters spawning clusters.** Never. The local agent is always the incubator.
- **Shared mutable state between teams.** Don't have two clusters write to the same file. Use the coordinator pattern instead.
- **Launching without good directions.** Every cluster needs a self-sufficient direction that lets it start productive work from iteration 1, even if upstream clusters haven't produced output yet. Plan the directions, then launch everything simultaneously.
- **Generic cluster names.** `cluster_0`, `cluster_1` tells you nothing at scale. Use role-based names.
- **Reusing old generic cluster IDs.** The registry may contain leftover clusters from previous runs (`cluster_0`, `cluster_3219`, etc.). Never repurpose these for new deployments. Their IDs become folder names in S3, making cross-cluster references unreadable. Always use fresh, meaningful IDs like `team-backend` or `team-agent`.
- **Monolithic directions.** Don't put all teams' work in one direction. Each cluster gets its own focused direction.
- **Polling clusters one by one.** Use parallel tool calls to sweep all clusters at once.
- **Leaving idle clusters running.** Stop them as soon as they converge. EC2 costs money.
- **Skipping the platform/standards step.** If teams need to integrate, establish shared contracts first. Fixing integration issues after the fact is more expensive than preventing them.
- **Terminal convergence without a fix loop.** If a team's direction says "mark CONVERGED and go idle" with no mechanism to un-converge on feedback, QA and coordinator feedback goes unread. Always include the fix loop pattern from section 8.
- **Launching without an interface contract.** If clusters produce code that must integrate, skipping the contract guarantees naming mismatches. Use a contracts cluster (section 13). "The QA cluster will catch it" is not reliable for name-level mismatches that only surface at runtime.
- **The local agent writing the contract.** Designing an API contract is productive work. Productive work belongs in clusters. The local agent provides architectural intent in directions. A contracts cluster turns that intent into a precise, authoritative contract.

---

## 11. Quick Reference

| Task | How |
|------|-----|
| Check all clusters at once | Parallel `cluster_status` calls |
| Feed artifact from cluster A to B | `env_read` from A, write to temp, `env_upload_file` to B |
| Share standards across all clusters | Write to knowledge-base via `kb_upload_file` |
| Create a new cluster with a good name | Use `{role}-{domain}` pattern for ID, descriptive display name |
| Stop everything | Parallel `cluster_stop` calls for each cluster |
| Mid-run course correction | `cluster_pause`, update direction, `cluster_resume` |
| Collect all outputs | Parallel `env_list` then parallel `env_read` for each cluster |
| Produce a single deliverable from multiple teams | Launch QA + consolidation alongside feature teams (section 12) |
| Prevent naming mismatches across teams | Use a contracts cluster to produce the canonical contract (section 13) |
| Identify which files a refinement cluster changed | Compare env_list timestamps: upload batch vs later writes (section 14) |

---

## 12. The Consolidation and QA Pattern

When multiple feature teams produce artifacts that must ship as a single deliverable, add a **QA cluster** and a **consolidation cluster**. Both launch alongside the feature teams (not after them). They poll other teams' environments each iteration and react to whatever output appears.

### Why this works better than sequential

The naive approach: wait for all teams to converge, then launch QA, then launch consolidation. This wastes time. In practice:

- QA finds issues early (iteration 2-3) that would be expensive to fix after convergence
- Consolidation can start assembling the project structure while teams are still filling in files
- The fix loop (section 8) means QA feedback triggers immediate corrections without operator intervention
- Everything converges together rather than in a slow sequential pipeline

### Launch all at once

Launch QA and consolidation at the same time as feature teams. Their directions tell them to poll and react:

```
# Launch everything in parallel — QA and consolidation included
cluster_start(cluster_id="team-frontend")
cluster_start(cluster_id="team-backend")
cluster_start(cluster_id="team-data")
cluster_start(cluster_id="project-qa")
cluster_start(cluster_id="project-consolidate")
```

QA and consolidation will find empty environments on their first iteration and simply note "waiting for output." By iteration 2-3, teams start producing files and QA/consolidation kick into gear.

### QA cluster direction pattern

The QA cluster monitors all teams continuously. It does not wait for CONVERGED markers to start checking. Its direction should follow this structure:

```markdown
# QA Integration

Monitor all teams and verify cross-team consistency.

## Teams to monitor
- `team-frontend` — React UI
- `team-backend` — REST API
- `team-data` — Database schema and seed data

## Each iteration
1. List `environment/` to discover which teams have produced output
2. For each team with output, read their key files
3. Check:
   - API contract consistency (frontend fetch calls match backend routes)
   - Type consistency (same interface names and shapes across teams)
   - Import path validity (imports reference files that exist)
   - Design consistency (same color values, component patterns)
4. Write findings to `environment/project-qa/qa-report.md`
5. For CRITICAL issues, write `qa-feedback.md` to the offending team's environment

## Idle condition
Go idle only when:
1. All feature teams have "CONVERGED" in their README, AND
2. You have run a final audit AFTER the most recent CONVERGED marker, AND
3. No CRITICAL issues remain open

If a team removes and re-adds CONVERGED (fix loop triggered), run another audit pass.
```

### What QA should check

| Check | Why |
|-------|-----|
| Frontend API calls match backend endpoint paths | Prevents 404s at runtime |
| Request/response shapes match | Prevents type errors |
| Shared type names are identical across teams | Prevents import failures |
| Auth middleware export matches what API imports | Prevents auth bypass |
| Product slugs in frontend match seed data format | Prevents broken links |
| Design tokens are consistent | Prevents visual inconsistency |

### QA feedback triggers the fix loop

When QA writes `qa-feedback.md` to a team's environment, the team's fix loop (section 8) picks it up on the next iteration. The team un-converges, fixes the issues, and re-converges. QA then runs another audit pass. This cycle continues until QA finds no more issues.

The local agent does not intervene in this cycle. It happens autonomously through the shared environment.

### Consolidation cluster direction pattern

The consolidation cluster reads all team environments and assembles a single runnable project. It runs continuously, updating its merged output as teams produce more files:

```markdown
# Consolidation

Merge all team outputs into a single runnable project.

## Teams to merge
- `team-frontend` — packages/frontend/
- `team-backend` — packages/backend/
- `team-data` — packages/backend/db/ (schema and seed data)

## Each iteration
1. Read all team environments to check what's available
2. Assemble everything into environment/{consolidation-cluster}/final/
3. Fix import paths to work in the merged structure
4. Ensure a root package.json exists with workspace config and scripts
5. Write a README.md explaining how to install and run
6. Verify no broken references (every import points to a file that exists)

## Output structure
Write the final merged project to: environment/{consolidation-cluster}/final/
This is what the operator will download.

## Merge rules
1. No duplicates: if two teams define the same component, keep the more complete version
2. Fix imports: adjust all import paths to work in the merged structure
3. Unified package.json: merge all dependencies, resolve version conflicts (pick latest)
4. Single types file: the canonical types from the data team are the source of truth

## Fix loop (do not remove)
After writing CONVERGED to your README.md, do NOT fully stop working. Each iteration:
1. Check if `qa-feedback.md` exists in your environment
2. If it lists unresolved issues, fix them and re-converge
3. Also re-check team environments for new files written after your last merge
```

### Consolidation sizing

- **Algorithm**: mesh (agents need to agree on the merged structure)
- **Concurrency**: 3-5 agents (more causes conflicts on the same output files)
- **Radius**: 2 (full visibility for consensus)

Consolidation is a consensus task, not a parallel map. Keep it small.

### The operator's final step

After the consolidation cluster converges and QA has signed off:

1. `env_list(cluster_id="project-consolidate")` to see the merged output
2. `env_download_all(cluster_id="project-consolidate")` or `env_read` each file from the `final/` subfolder
3. Present the result to the user or write to their local filesystem
4. Stop all clusters

### When to skip QA

- Single-cluster deployments (no cross-team integration to verify)
- Research/ideation tasks (no "correct" output to validate)
- Very small deployments (2 clusters, simple interface) where the consolidation cluster can do both jobs

### When to skip consolidation

- The user wants raw output from each team separately
- Teams write to non-overlapping paths and no merge is needed
- A single team produces the entire deliverable

---

## 13. Interface Contracts (Produced by a Contracts Cluster)

When multiple clusters produce code that must integrate, they need a shared interface contract. The local agent does NOT write this contract. A dedicated contracts cluster produces it. This is consistent with the incubator-only rule: all productive work happens inside clusters.

### The problem

Cluster A exports `processInput(message, context)`. Cluster B imports `processInput` from Cluster A's output. But Cluster A's agents decided `handleRequest` was a better name. The code compiles in isolation on both sides. QA can't catch the mismatch without running the code. Result: runtime crash after merge.

### The fix: a contracts cluster

Create a small mesh cluster (3-5 agents) whose sole job is to design and write the interface contract. It converges fast (mesh algorithm, consensus workload, 3-4 iterations). Its output lands in the shared environment where all other clusters can observe it via stigmergy.

### How it works

1. **The local agent provides architectural intent in directions.** Each team's direction describes the system at a high level: what the app does, what this team's role is, what other teams exist. It does NOT prescribe specific type names, endpoint paths, or function signatures. Those are the contracts cluster's job.
2. **The contracts cluster produces the authoritative contract.** It writes files like `environment/platform-contracts/api-contract.ts`, `environment/platform-contracts/shared-types.ts`, etc.
3. **Feature teams observe the contract via the shared environment.** Each team's direction says: "Read `environment/platform-contracts/` each iteration for the canonical interface definitions. Prefer them over your own assumptions once they appear."
4. **QA verifies compliance.** The QA cluster reads both the contract and each team's output, flagging mismatches.

### Launch order

Launch the contracts cluster simultaneously with everything else (per section 16). Feature teams start with the architectural intent in their direction and begin productive work immediately. When the contracts cluster converges (typically iteration 3-4), its output appears in the environment. Feature teams observe it on their next iteration and self-correct. The fix loop (section 8) handles any drift that QA catches.

Do NOT wait for the contracts cluster to converge before launching feature teams. The whole point of stigmergy is that teams react to artifacts as they appear.

### Contracts cluster direction pattern

```markdown
# Platform Contracts

Design the interface contract for a multi-team project.

## System overview
<Describe the application, its teams, and their responsibilities here.>

## Your job
1. Design the shared TypeScript types that all teams will use
2. Define the API endpoint paths, methods, request/response shapes
3. Define exported function signatures at module boundaries
4. Define the file/folder structure convention all teams must follow
5. Write the contract to environment/platform-contracts/

## Output files
- environment/platform-contracts/shared-types.ts — all shared interfaces and enums
- environment/platform-contracts/api-routes.ts — endpoint definitions with request/response types
- environment/platform-contracts/module-exports.md — which modules export what, and from where
- environment/platform-contracts/folder-structure.md — canonical project layout

## Principles
- Use clear, descriptive names. Prefer verbose over ambiguous.
- Every type must be fully specified (no `any`, no implicit shapes).
- Every endpoint must define its method, path, request body, response body, and error shape.
- The contract is the source of truth. If a team deviates, they are wrong.

## Fix loop (do not remove)
After writing CONVERGED to your README.md, do NOT fully stop working. Each iteration:
1. Check if `qa-feedback.md` or `coord-decision.md` exists in your environment
2. If either lists contract issues (ambiguities, missing endpoints, type conflicts):
   - Remove "CONVERGED" from README.md
   - Update the contract files to resolve the issues
   - Re-append "CONVERGED" only after all issues are addressed
3. If no feedback exists, remain idle
```

### Feature team direction pattern (referencing the contract)

```markdown
# Team Frontend

Build the React UI for the application.

## System overview
<High-level description of what the app does and what other teams exist.>

## Interface contract
Read `environment/platform-contracts/` each iteration for the canonical types,
API routes, and module export conventions. Prefer them over your own assumptions
once they appear. If the contract files don't exist yet (early iterations),
work from the system overview above and self-correct when the contract materializes.

Do NOT invent your own type names or endpoint paths. Use exactly what the contract defines.

## Your scope
<What this team builds, constraints, output location, etc.>
```

### What the local agent provides in directions (architectural intent only)

The local agent's directions should describe:
- What the application does (the product vision)
- What teams exist and their responsibilities
- High-level technology choices (React, Node, DynamoDB, etc.)
- The general shape of the system (monorepo, packages, deployment target)

The local agent does NOT specify:
- Specific type names or interface shapes
- API endpoint paths or request/response formats
- Function signatures or export conventions
- File naming conventions beyond the top-level structure

Those details are the contracts cluster's job. The local agent provides the "what" and "why." The contracts cluster provides the "how it connects."

### Why this is better than inline contracts in directions

1. **Truly incubator-only.** The local agent writes zero project artifacts, not even disguised as direction text. Designing an API contract IS productive work, and productive work belongs in clusters.
2. **The contract evolves.** If QA finds issues with the contract (ambiguous types, missing endpoints), the contracts cluster can update it via the fix loop. An inline contract in a direction is frozen unless the operator manually updates it.
3. **Separation of concerns.** The local agent focuses on topology and vision. The contracts cluster focuses on interface design. Feature teams focus on implementation.
4. **Stigmergy in action.** Teams observe the contract as it appears, just like any other artifact in the shared environment. No special mechanism needed.

### Contract enforcement via QA

Add this to QA/integration cluster directions:

```markdown
## Contract verification

The interface contract lives in `environment/platform-contracts/`. Verify compliance by:
1. Reading the contract files (shared-types.ts, api-routes.ts, module-exports.md)
2. Reading each team's output files
3. Checking that type names, endpoint paths, and function signatures match exactly
4. If a team deviates from the contract, write `qa-feedback.md` to their environment
5. If the contract itself is ambiguous or incomplete, write `qa-feedback.md` to
   `environment/platform-contracts/` so the contracts cluster can fix it

Flag any mismatch as a CRITICAL issue.
```

### When to skip the contracts cluster

- Clusters that don't share code (research, documentation, content)
- A single cluster working alone
- Very small projects (2-3 endpoints, handful of types) where the architectural intent in directions is specific enough that teams won't diverge on names. Even then, a contracts cluster is cheap insurance.

### Sizing the contracts cluster

- **Algorithm**: mesh (consensus task, agents must agree on one contract)
- **Concurrency**: 3-5 agents (small, fast-converging)
- **Radius**: 2 (full visibility for fast agreement)
- **Expected convergence**: 3-4 iterations

The contracts cluster is lightweight. It produces a few files and converges quickly. The cost of running it is negligible compared to the cost of fixing naming mismatches across teams after the fact.

---

## 14. Identifying Changed Files from Refinement Clusters

When a cluster refines existing code (rather than building from scratch), its environment contains both the original uploaded files AND the files it modified. The env_list shows everything with no diff or "modified" flag. You need to distinguish the cluster's actual output from the passthrough context.

### The problem

You upload N files to a cluster. The cluster rewrites some and creates a few new ones. When you call env_list, you see N + new files. Nothing tells you which ones are deliverables. Naively copying everything back overwrites files with their own unchanged copies, or worse, with stale versions if the cluster carried forward an older snapshot.

### How to identify changed files

Use timestamp comparison. Files you uploaded share the same timestamp (the moment env_upload_folder ran). Files the cluster wrote have later timestamps.

When reading env_list output:

1. Note the upload timestamp: the earliest cluster of timestamps, usually within the same second
2. Any file with a timestamp AFTER the upload batch was written by an agent
3. Files at the upload timestamp are unchanged passthrough

Upload batch (all at the same time, these are passthrough):

```
src/utils.ts        1200  2026-05-10T10:00:04
src/config.ts        800  2026-05-10T10:00:04
src/index.ts         500  2026-05-10T10:00:04
```

Written by agents (later timestamps, these are deliverables):

```
src/index.ts        1850  2026-05-10T10:08:22  ← REWRITTEN (note: larger size)
src/new-module.ts   3200  2026-05-10T10:07:45  ← NEW FILE
README.md            900  2026-05-10T10:09:01  ← CLUSTER METADATA
```

### Handling duplicates from mesh clusters

In mesh clusters, multiple agents see the same task and may write the same logical file to different paths. For example, three agents all create a helper module but at:

- `src/helper.ts` (agent-0)
- `src/helpers/helper.ts` (agent-1)
- `src/utils/helper.ts` (agent-2)

To resolve:

1. Check which path the consuming code actually imports
2. That import target is the canonical file. The others are duplicates.
3. Only copy the canonical one to the local project.

### What to copy back

After identifying the changed files:

1. Skip cluster metadata (README.md, qa-feedback.md, CONVERGED markers)
2. Skip the context/ directory (that was your input)
3. Skip duplicate variants (keep only the one referenced by imports)
4. Copy the remaining changed files into the local project at their correct relative paths

### The pattern

```
env_list(cluster_id="...")
Sort by lastModified
Identify the upload batch (earliest timestamp cluster)
Everything with a later timestamp = cluster output
Filter out: README.md, qa-feedback.md, context/*, duplicate variants
Read and apply the remaining files to the local project
```

### Edge cases

- **Cluster rewrites a file to identical content**: timestamp is later but content unchanged. Harmless to copy back (it's a no-op). Compare file sizes as a quick heuristic: same size as the upload version likely means unchanged.
- **Cluster deletes a file conceptually**: S3 doesn't support deletes through the agent's fs tools. If the cluster's direction says "remove X", it will note this in README.md or a status file. Check for deletion instructions in cluster metadata.
- **Multiple agents rewrite the same file**: last-write-wins on S3. The file at the later timestamp is the final version. This is fine for mesh clusters where convergence is the goal.


---

## 15. Map-Reduce at WeltenBuilder Scale

Map-reduce operates across clusters. A single operation can target agents in multiple clusters simultaneously. This makes it the tactical complement to the strategic analyze/optimize feature.

### Cross-cluster map

Send a directive to specific agents across multiple clusters:

```
mapreduce_exec: {
  operation: {
    type: "map",
    filter: { clusters: ["team-frontend", "team-backend"], actionRegex: "idle" },
    directive: "The integration contract has been updated. Re-read environment/shared/api-contract.ts and verify your output still conforms."
  }
}
```

This targets only idle agents in both teams, nudging them to re-check the contract without disturbing agents that are mid-task.

### Cross-cluster reduce

Query agent state across the entire deployment:

```
mapreduce_prompt: "Which agents across all clusters have produced files in the last 3 iterations?"
```

Or structured:

```
mapreduce_exec: {
  operation: {
    type: "reduce",
    mode: "extract",
    filter: { iterationGte: 3 },
    query: { groupBy: "clusterId", select: ["agentId", "action", "iteration"] }
  }
}
```

### When to use map-reduce vs other WeltenBuilder patterns

| Situation | Use |
|-----------|-----|
| All agents in a cluster need new instructions | `direction_set` |
| A subset of agents need a nudge | `mapreduce_exec` (map) |
| You want to know what's happening across all clusters | `mapreduce_prompt` (reduce/summarize) |
| You want structured data about specific agents | `mapreduce_exec` (reduce/extract) |
| The whole system needs strategic assessment | Analyze button (organigram) |
| The whole system needs direction proposals | Optimize button |
| A specific cluster's idle agents should pivot | `mapreduce_exec` (map with actionRegex: "idle") |

### Combining with the coordinator pattern

A coordinator cluster can't call map-reduce (it's an MCP tool, not an agent tool). But the local agent can use map-reduce to do what a coordinator would do, faster:

1. `mapreduce_prompt: "Summarize what each team has produced"` (reduce/summarize)
2. Read the result, decide which teams need a nudge
3. `mapreduce_exec` with a map directive to the specific agents that need it

This replaces the coordinator cluster for simple deployments. For complex ones (10+ clusters, continuous monitoring), keep the coordinator cluster for autonomous cross-cluster coordination and use map-reduce for operator-initiated interventions.

### Clearing directives after a phase

When a phase of work completes and you want all agents back to pure self-organization:

```
mapreduce_exec: {
  operation: {
    type: "map-clear",
    filter: { all: true }
  }
}
```

This removes every per-agent directive across all clusters in one call.


---

## 16. Trust the Self-Organization

The most common mistake when operating a WeltenBuilder deployment is over-orchestrating. The local agent is an incubator, not a conductor. The system coordinates through stigmergy: agents observe the shared environment, react to what they find, and leave traces that other agents react to in turn. No central controller is needed once the clusters are running.

### The phased-launch anti-pattern

The instinct is to sequence launches: "spec team first, wait for convergence, then compiler team, then stdlib, then QA." This treats the flock like a build pipeline with explicit dependencies. It is wrong for three reasons:

1. **It wastes wall-clock time.** Every minute spent waiting for a "prerequisite" cluster to converge is a minute the downstream clusters could have been exploring, writing scaffolding, or producing output based on what's already in the direction.

2. **It fights the coordination model.** The whole point of the shared environment is that clusters observe each other in real time. A compiler cluster doesn't need the spec to be "done" before it starts. It reads `environment/babel-spec/` every iteration. If nothing is there yet on iteration 1, it works from the embedded context in its direction. When the spec materializes on iteration 3, the compiler agents observe it and self-correct. That's not a workaround. That's the design.

3. **It makes the local agent a bottleneck.** If you phase launches, you must monitor the first phase, decide when it's "ready," then launch the next phase. You've inserted yourself as a synchronization point in a system designed to have none.

### What to do instead: launch everything at once

Set directions for all clusters. Configure them. Start them all simultaneously. The system handles the rest:

- Clusters that produce foundational artifacts (spec, platform contracts) use mesh algorithm and converge fast (3-4 iterations). Their output appears in the shared environment within minutes.
- Clusters that consume those artifacts (compiler, stdlib, playground) read the shared environment every iteration. They start with whatever context is in their direction, then incorporate the real spec/contracts as they appear.
- QA clusters observe all teams from iteration 1. They catch drift early, not after the fact.
- The fix loop in every direction means QA feedback triggers corrections without operator intervention.

The only thing the local agent needs to provide upfront is enough context in each direction for teams to start working before their dependencies materialize. Embed the vision, the concurrency model, the key design decisions. Teams begin with that and refine as the authoritative spec appears in the environment.

### Why this works (the stigmergy argument)

The README states it plainly: "Agents never talk to each other. They coordinate entirely through traces left in a shared environment. This is stigmergy."

In a stigmergic system, coordination emerges from the environment, not from a schedule. When babel-spec writes `grammar.ebnf` to its environment, every agent in every other cluster can observe it on their next iteration. They don't need to be "told" it's ready. They see it. They react. If it changes later (spec refines the grammar on iteration 5), they see the change and adapt.

Phased launching is the equivalent of telling termites "don't start building the east wall until the west wall is done." Termites don't work that way. They deposit pheromones, other termites detect them, and the structure emerges. The shared S3 environment is the pheromone trail. Let it work.

### When phasing IS appropriate

There is exactly one case where phasing makes sense: when a cluster's direction literally cannot be written without output from another cluster. This is rare. In practice, the contracts cluster converges in 3-4 iterations (minutes), and feature teams can start productive work from the architectural intent in their direction while the contract materializes.

Launch the contracts cluster alongside everything else. It converges fast (mesh, 3-4 iterations). Feature teams start from the architectural intent in their direction and adopt the authoritative contract once it appears in the environment. Perfect is the enemy of launched.

### The incubator mindset (revised)

The local agent's job is:

1. **Write good directions.** Each direction should contain enough context for the team to begin productive work immediately, even if upstream clusters haven't produced anything yet. Embed the vision, the shared model, the key constraints.
2. **Launch everything.** All clusters, simultaneously. No phasing unless physically impossible.
3. **Step back.** The system self-organizes. Agents observe, react, correct. QA catches drift. The fix loop resolves it.
4. **Monitor, don't manage.** Check status periodically. Read the chronicle. Intervene only if something is genuinely stuck (all agents idle with no output, or a circular dependency the fix loop can't resolve).
5. **Collect results.** When clusters converge, download the output.

You are not conducting an orchestra. You are seeding a petri dish and watching what grows. The growth is the coordination. The traces in the environment are the communication. Trust it.

### Practical implications for direction writing

Because all clusters launch simultaneously and must be productive from iteration 1:

- **Every direction must be self-sufficient for the first few iterations.** Don't write "wait for babel-spec to produce the grammar." Write the grammar sketch inline (from whatever context you have) and add "Read environment/babel-spec/ each iteration for the authoritative grammar. Prefer it over the sketch below once it appears."
- **Cross-references are observational, not blocking.** "Read environment/babel-spec/grammar.ebnf" means "look for it, use it if it's there." Not "block until it exists."
- **The fix loop handles version skew.** If a team builds against an early draft of the spec and the spec later changes, QA catches the mismatch and the fix loop corrects it. This is cheaper than waiting for the spec to be "final" (it never is).

### The chronicle as proof

In a phased deployment, the chronicle would show: "Phase 1 ran. Phase 2 started. Phase 3 started." Boring. Sequential. Could have been a script.

In a simultaneous launch, the chronicle shows: "At iteration 2, babel-spec produced a draft grammar. babel-compiler hadn't seen it yet and was working from the embedded sketch. By iteration 4, compiler agents observed the real grammar and pivoted. Meanwhile babel-stdlib agent-7 noticed agent-4 had already claimed the math module and shifted to strings. babel-qa flagged a type mismatch between stdlib and the spec on iteration 5, and the fix loop resolved it by iteration 7."

That's stigmergy in action. That's the story. That's what proves the system works. You only get that story if you let the chaos happen.
