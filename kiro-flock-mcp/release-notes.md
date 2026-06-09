# kiro-flock-feed-mcp — release notes

Release history for the MCP server that lets Kiro agents control and inspect a running `kiro-flock` cluster. For the cluster itself, see `kiro-flock/release-notes.md`.

Tags in this repo:

- `v3.0-weltenbuilder` — current
- `v2.0tested` — last single-cluster release
- `latest-working` — v2.0 feature-complete before validation

This MCP server was introduced at v1.0 of the main project; there is no v0.5 here (the Python local prototype had no MCP surface).

---

## v3.0 WeltenBuilder — May 2026 (current, UNTESTED)

**Multi-cluster addressing across every tool.** The MCP server now targets any cluster in a multi-cluster deployment, or falls through to `cluster_0` so existing single-cluster workflows keep working unchanged.

### Added

- **`clusters_list` tool.** Lists every registered cluster with its current state. Use this to discover cluster ids before addressing a specific cluster. In a single-cluster deployment it returns one entry for `cluster_0`.
- **Optional `cluster_id` parameter on every cluster-scoped tool.** Covers `cluster_status`, `cluster_start`, `cluster_stop`, `cluster_pause`, `cluster_resume`, `cluster_config_get`, `cluster_config_set`, `direction_get`, `direction_set`, `env_upload_file`, `env_upload_folder`, `env_list`, `env_read`, `stream_logs`, `store_list`, `store_read`, `store_read_all`. Omitted, the backend defaults to `cluster_0`.
- **Shared knowledge-base stays global.** `kb_*` tools ignore `cluster_id` by design — one knowledge-base across all clusters, consistent with the cluster-side S3 layout.

### Changed

- **`flockClient.ts`** appends `/{clusterId}` to API paths when a cluster id is provided. Multi-segment actions like `habitat/file` place the suffix before the query string. Knowledge-base calls remain un-suffixed.
- **`feeder.ts`** prepends `environment/{clusterId}/` to environment upload keys. Knowledge-base uploads stay under the shared `knowledge-base/` prefix.
- **Tool descriptions** updated to document the `cluster_id` parameter with consistent "Defaults to cluster_0 when omitted" wording.
- **`ClusterRegistryEntry` and `ClusterListResult` types** added to `flockClient.ts` matching the cluster's registry shape (`id`, `name`, `algorithm`, `createdAt`, optional `state`).

### Backwards compatibility

Every existing tool call that omits `cluster_id` behaves identically to v2.0. Single-cluster deployments need no MCP reconfiguration.

### Notable files

`src/tools.ts`, `src/flockClient.ts`, `src/feeder.ts`, `src/index.ts`.

---

## v2.0tested — May 2026 (tag `v2.0tested`)

**MCP-side docs aligned with the tested v2.0 cluster.** No code changes.

### Changed

- Vendored kiro-flock skill gained a **scaling-per-algorithm** subsection (`2801148`). Guidance for operators on when each algorithm (amorphous / mesh / swarm) scales well and what breaks first at high concurrency.

### Notable commits

`2801148`

---

## v2.0 — April 2026 (tag `latest-working`, shipped UNTESTED)

**Environment / knowledge-base split, post-run analysis tools, vendored skill, browser-based login.** The MCP surface grew to match the v2.0 cluster features.

### Added

- **Environment / knowledge-base tools (Pass 3).** Replaces the old single-prefix upload path.
  - `env_upload_file`, `env_upload_folder`, `env_list`, `env_read` — per-run working area, archived on every `cluster_start`.
  - `kb_upload_file`, `kb_upload_folder`, `kb_list`, `kb_read` — persistent across runs, durable reference material.
  - Accessed in `dacd6b8` (parallel build) and surfaced to the skill docs.
- **Post-run analysis tools (Pass 5, `6826a7c`).**
  - `store_list` — list per-agent log files in `store/`.
  - `store_read` — full iteration log for a single agent.
  - `store_read_all` — every agent's full history in one call, for convergence analysis and pattern inspection. Backed by the new `/cluster/analysis` endpoint that returns a presigned URL to a gzipped NDJSON artifact.
- **Pause / resume tools (Pass 6).** `cluster_pause` and `cluster_resume` exposed via the MCP surface. Paired with the cluster-side `pause.flag` mechanism.
- **Algorithm configuration (Pass 7).** `cluster_config_set` accepts `algorithm` and `swarmK`. `cluster_status` surfaces the active algorithm so agents can reason about what topology they're running under.
- **Vendored kiro-flock skill** (`c43143f`). Installed on setup, gives Kiro agents a domain-aware skill for orchestrating flock runs without hand-holding on tool choice.
- **Browser-based login with automatic token refresh** (`c2dd8ac`). Replaces the manual token-copy flow. The MCP client opens a browser, completes Cognito OAuth, captures the token, and refreshes it automatically until the refresh token expires (7 days).
- **WAF IP allowlist auto-update** (`b8cf92f`). If a WAF IP set is deployed (optional), every `get-mcp-env.sh` run adds the operator's current egress IP to the allowlist.
- **Setup integration.** `setup.sh` at the workspace root now runs MCP install as step 2 and `get-mcp-env.sh` as step 3. End-to-end bootstrap.
- **README rewrite** (`131be16`) with prerequisites, setup script docs, and workflow.

### Changed

- **`kbUploader` → `feeder`** (`b1e1dbf`). Context now writes to `output/` not `knowledge-base/`; `read-output` instruction appended to direction on start.
- **`stream_logs` includes `clusterState`** in the response (`d11ad40`). Replaces the old `wait_for_completion` pattern — the client decides when to stop polling based on the cluster state rather than a synthetic "done" signal.
- **`get-mcp-env.sh`** updated for Pass 3 env/kb split (`970da8e`). Access checks target the right prefixes.
- Auth flow hardening: preserve Cognito OAuth config when enabling admin auth flow (`5b6597e`). Earlier flow clobbered the OAuth settings when it flipped on admin user-password auth.

### Fixed

- **Object response handling for `habitat/file` endpoint.** MCP's `readOutput` now handles the object shape returned by the cluster (`a281cd9`).
- **Credential provider chain for S3** (`a4a9865`). `AWS_PROFILE` added to MCP config; script output cleaned up.
- **`FLOCK_S3_REGION`** included in generated MCP config (`6ac59be`). Cross-region setups work without manual editing.
- **`ADMIN_USER_PASSWORD_AUTH`** auto-enabled on the Cognito client before auth (`dfb493f`). Fixes the "auth flow not enabled" error on first use.
- **`--output none` → redirect to `/dev/null`** (`9b1d5a7`). Some AWS CLI versions rejected `--output none`.
- **Auto-enable auth flow, WAF IP rotation noted in README** (`9f94674`).
- **Direction JSON unwrap** and upload-response cleanup (`f2b87ca`). `feeder` now appends the read-output instruction at the right point.
- **S3 knowledge-base access grant offer** (`f4a6a79`). Script detects if the local identity can't read `knowledge-base/` and offers to grant.
- **Refresh token support** in `get-mcp-env.sh` (`58c745a`). Token validity note updated to 24h.
- **`mcp.json` auto-update** after successful auth (`f0de3a8`). No manual copy-paste.

### Notable commits

`dacd6b8` (parallel build — env/kb, analysis, pause/resume, algorithms), `6826a7c` (latest-working, analysis tools + skill), `c43143f` (vendored skill), `c2dd8ac` (browser login), `b8cf92f` (WAF auto-update).

---

## v1.0 — April 2026 (first MCP release)

**The MCP server shipped alongside the first public `kiro-flock` release.** Minimal surface: direction set, cluster start/stop/status, log streaming, output reads.

### Added

- **Initial MCP implementation** (`34219ce`). Tools matching the v1.0 cluster API surface.
- **`get-mcp-env.sh`** — script that bootstraps the MCP config from a deployed cluster, resolves the API Gateway URL, writes `mcp.json` (`d024e5f`). End-to-end: clone, deploy cluster, run `get-mcp-env.sh`, add MCP to Kiro.
- **README** with setup instructions (`d024e5f`).

### Notable commits

`e15f193` (initial), `34219ce` (MCP implementation), `d024e5f` (env script + README).
