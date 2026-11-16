#!/usr/bin/env node
/**
 * Standalone S3 MCP server — speaks MCP JSON-RPC 2.0 over stdio.
 *
 * Launched by kiro-cli as a subprocess via the McpServerStdio entry in
 * ACP newSession(). Bucket, region, and cluster prefix come from
 * environment variables:
 *   AGA_BUCKET          — S3 bucket name
 *   AGA_REGION          — AWS region
 *   AGA_CLUSTER_PREFIX  — cluster id this agent belongs to (default: cluster_0)
 *
 * Tools: s3_read, s3_write (with append), s3_list, s3_delete, s3_sync_local
 *
 * Access rules (multi-cluster layout):
 *   - Reads: the agent's own cluster prefix (`{prefix}/*` — covers
 *     config.json, direction.md, pause.flag, and its own store/), plus
 *     the shared `environment/` folder (any path, for cross-cluster
 *     reads) and the shared `knowledge-base/`.
 *   - Writes: the agent's own `{prefix}/store/` and anywhere under
 *     `environment/`. Writes default by prompt convention to
 *     `environment/{prefix}/...` but cross-cluster writes are permitted
 *     when the agent's direction calls for them.
 *   - Lists: `environment/`, `knowledge-base/`, and the agent's own
 *     `{prefix}/store/`.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { createInterface } from "node:readline";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath, sep } from "node:path";

const bucket = process.env.AGA_BUCKET ?? "";
const region = process.env.AGA_REGION ?? "us-east-1";
const CLUSTER_PREFIX = process.env.AGA_CLUSTER_PREFIX || "cluster_0";
const EVERFORGE_GROUP = process.env.AGA_EVERFORGE_GROUP || "";

if (!bucket) {
  process.stderr.write("AGA_BUCKET is not set\n");
  process.exit(1);
}

const s3 = new S3Client({ region });

// ---------------------------------------------------------------------------
// Environment prefix logic
// ---------------------------------------------------------------------------

/** The agent's environment workspace. With an everforge group, it nests
 *  under environment/<group>/<clusterId>/. Without, environment/<clusterId>/. */
const ENV_PREFIX = EVERFORGE_GROUP
  ? `environment/${EVERFORGE_GROUP}/${CLUSTER_PREFIX}/`
  : `environment/${CLUSTER_PREFIX}/`;

/** The deployed/ folder for this agent's project. Shared across all clusters
 *  in the same everforge group. */
const DEPLOYED_PREFIX = EVERFORGE_GROUP
  ? `environment/${EVERFORGE_GROUP}/deployed/`
  : `environment/deployed/`;

// ---------------------------------------------------------------------------
// Prefix allowlists
// ---------------------------------------------------------------------------

// Agents read their own cluster prefix (config.json, direction.md,
// pause.flag, store/) and the shared environment/ + knowledge-base/.
// The environment/ allowlist deliberately covers the full shared folder
// so agents can read cross-cluster files when directed to. Write access
// to store/ is restricted to the agent's own cluster; knowledge-base/ is
// deliberately read-only because earlier builds let agents dump debate
// there and subsequent runs cited it back as authoritative.
const READ_PREFIXES  = [`${CLUSTER_PREFIX}/`, "environment/", "knowledge-base/", "store/approvals/", "deploy-src/"];
// store/approvals/ is read-only here as well as in IAM: the trust markers in
// it are written by the Lambda on cluster start and decide whether this agent
// may deploy, so an agent must not be able to write its own.
// deploy-src/ is read-only too: the Deploy MCP writes the source snapshot of
// every remote deploy there under DeployerRole, and IAM denies AgentRole.
const WRITE_PREFIXES = [`${CLUSTER_PREFIX}/store/`, "environment/"];
const DELETE_PREFIXES = ["environment/"];
const LIST_PREFIXES  = ["environment/", "knowledge-base/", `${CLUSTER_PREFIX}/store/`, "store/approvals/", "deploy-src/"];

function toKey(path: string): string {
  return path.replace(/^\/+/, "");
}

/** Local scratch root. Agents may only materialise files inside it.
 *
 *  Resolution order matters: ECS sets AGA_WORKSPACE (/home/agent/...), EC2
 *  agents run as ec2-user. Deriving from HOME before falling back to a
 *  hardcoded path keeps this correct on both — an earlier version hardcoded
 *  the EC2 path and every sync on ECS failed with EACCES trying to create a
 *  root-owned /home/ec2-user. */
function workspaceRoot(): string {
  const explicit = process.env.AGA_WORKSPACE?.trim();
  if (explicit) return resolvePath(explicit);
  const home = process.env.HOME?.trim();
  if (home) return resolvePath(home, "kiro-flock-workspace");
  return resolvePath("/home/ec2-user/kiro-flock-workspace");
}

const WORKSPACE_ROOT = workspaceRoot();

/** Resolve a caller-supplied destination against the workspace root and
 *  refuse anything that escapes it (../, absolute paths outside, symlink-ish
 *  tricks). Returns null when the destination is not allowed. */
function resolveDest(dest: string): string | null {
  const cleaned = dest.replace(/^\/+/, "");
  const full = resolvePath(WORKSPACE_ROOT, cleaned);
  if (full !== WORKSPACE_ROOT && !full.startsWith(WORKSPACE_ROOT + sep)) return null;
  return full;
}

function isReadAllowed(key: string): boolean {
  return READ_PREFIXES.some(p => key === p || key.startsWith(p));
}

function isWriteAllowed(key: string): boolean {
  return WRITE_PREFIXES.some(p => key.startsWith(p));
}

function isListAllowed(key: string): boolean {
  return LIST_PREFIXES.some(p => key.startsWith(p));
}

function isDeleteAllowed(key: string): boolean {
  return DELETE_PREFIXES.some(p => key.startsWith(p));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "s3_read",
    description: `Read a file from the shared store. Paths in your own cluster live under /${CLUSTER_PREFIX}/ (e.g. /${CLUSTER_PREFIX}/store/agent-0.ndjson). The shared /environment/ folder is readable across all clusters. Your primary workspace is ${ENV_PREFIX}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: `Virtual path (e.g. /${CLUSTER_PREFIX}/store/agent-0.ndjson, /${ENV_PREFIX}src/index.ts, /${DEPLOYED_PREFIX}latest.json)` },
      },
      required: ["path"],
    },
  },
  {
    name: "s3_write",
    description: `Write or append to a file in the shared store. Writes are allowed under /${CLUSTER_PREFIX}/store/ (your own log) and anywhere under /environment/. Use /${ENV_PREFIX} as your primary workspace. The deployed/ folder is at /${DEPLOYED_PREFIX}. Write elsewhere in /environment/ only when your direction requires cross-cluster collaboration. SHARED FILES: any file that more than one agent writes to (feedback files, issue registers, shared changelogs, deploy logs) MUST be written with append: true — appends are made atomic with conditional writes and retries, whereas a whole-file write silently destroys whatever a concurrent writer just added. Whole-file writes are only safe on files you alone own.`,
    inputSchema: {
      type: "object",
      properties: {
        path:    { type: "string",  description: "Virtual path" },
        content: { type: "string",  description: "Content to write" },
        append:  { type: "boolean", description: "Append to existing content (default: false)" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "s3_list",
    description: `List files under a directory in the shared store. Works for /environment/ (any subfolder, cross-cluster), /knowledge-base/, and /${CLUSTER_PREFIX}/store/. Your workspace: /${ENV_PREFIX}`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: `Directory path to list (e.g. /environment/, /${ENV_PREFIX}, /${DEPLOYED_PREFIX}, /knowledge-base/)` },
      },
      required: ["path"],
    },
  },
  {
    name: "s3_sync_local",
    description: `Download an entire S3 prefix over the network from the flock bucket onto local disk under ~/kiro-flock-workspace/ WITHOUT returning file contents. Use this whenever you need many files locally (compiling, npm install, running tests, assembling a CDK app for the deploy MCP). Returns only a file count and the local destination path, so it costs you almost no context. Reading files one by one with s3_read and rewriting them with fs_write is the most common way an iteration runs out of context and dies — use this instead. Source must be readable (/environment/ any subfolder, /knowledge-base/, /${CLUSTER_PREFIX}/); destination is always relative to the workspace root.`,
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: `S3 prefix to copy from (e.g. /${ENV_PREFIX}src/, /environment/<group>/<other-cluster>/infra/)` },
        dest:   { type: "string", description: "Destination path relative to ~/kiro-flock-workspace/ (e.g. \"myapp/src\"). Created if missing." },
      },
      required: ["source", "dest"],
    },
  },
  {
    name: "s3_delete",
    description: `Delete a file from the environment. Only works under /environment/. Use this to clean up stale build artifacts, remove source files after compilation (e.g. .ts files after producing .js), or delete files that should not be deployed. Cannot delete files in store/ or knowledge-base/.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: `Path of the file to delete (must be under /environment/, e.g. /${ENV_PREFIX}src/old-file.ts)` },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

function respond(id: string | number | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolResult(id: string | number | null, text: string, isError = false): void {
  respond(id, { content: [{ type: "text", text }], isError });
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleFsRead(id: string | number | null, path: string): Promise<void> {
  const key = toKey(path);
  if (!isReadAllowed(key)) { toolResult(id, `Read denied: ${path}`, true); return; }
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = (await resp.Body?.transformToString()) ?? "";
    toolResult(id, body);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") {
      toolResult(id, "", true);
    } else {
      toolResult(id, `S3 read error: ${err}`, true);
    }
  }
}

/** The agent's own activity journal. Guarded specially below: it is the one
 *  key where a lost or glued record corrupts every downstream consumer
 *  (broadcast detection, autopause, neighbour reads, the dashboard). */
const OWN_LOG_KEY = process.env.AGA_OWN_LOG_KEY ?? "";

/** Local marker file touched on every successful write to OWN_LOG_KEY.
 *  The agent loop deletes it before the turn and checks it afterwards —
 *  a direct "did this turn broadcast?" signal from the process that did the
 *  writing, replacing the loop's ts-diff over the shared log, which reported
 *  false negatives whenever the log's newest line was unparseable. */
const BROADCAST_MARKER = process.env.AGA_BROADCAST_MARKER ?? "";

function touchBroadcastMarker(): void {
  if (!BROADCAST_MARKER) return;
  try { writeFileSync(BROADCAST_MARKER, new Date().toISOString()); } catch { /* best-effort */ }
}

/** How many times a CAS append re-reads and retries after losing the race.
 *  Live probing on the shipping handler measured 6 parallel unconditional
 *  appends leaving ONE survivor; with If-Match + retry, 8/8 were durable. */
const CAS_ATTEMPTS = 5;

async function handleFsWrite(id: string | number | null, path: string, content: string, append: boolean): Promise<void> {
  const key = toKey(path);
  if (!isWriteAllowed(key)) { toolResult(id, `Write denied: ${path}`, true); return; }

  // The agent's own journal is append-only. A whole-file overwrite (append
  // omitted or false) used to truncate the entire history and answer OK —
  // one forgetful model call could erase everything the dashboard, autopause,
  // and neighbouring agents rely on.
  if (!append && key === OWN_LOG_KEY) {
    toolResult(
      id,
      `Write denied: ${path} is your append-only activity log. Re-run with append: true — overwriting it would erase your own history.`,
      true,
    );
    return;
  }

  try {
    if (!append) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: content }));
      toolResult(id, "OK");
      return;
    }

    // Append = read-concat-put, made safe on two axes that were both bitten
    // in production:
    //
    // Atomicity. Unconditional PUTs from concurrent writers (parallel tool
    // calls in one turn, or the loop's own bookkeeping racing a model write)
    // silently destroyed acknowledged records — last writer wins, everyone
    // was told OK. The PUT is now conditional on the ETag we read (If-Match;
    // If-None-Match: * for the first write) and re-reads on a lost race.
    //
    // Framing. `prev + content` with no newline guarantee glued NDJSON
    // records into `}{` lines. Those lines are unparseable, so every tail
    // reader (readLastEntry, dashboards, neighbours) skipped them and saw a
    // stale record — the direct cause of turns being labelled interrupted
    // while their broadcast sat right there in S3. Both sides of the seam
    // are normalised: previous content gets a terminating newline, appended
    // content gets one too.
    for (let attempt = 0; ; attempt++) {
      let prev = "";
      let etag: string | null = null;
      try {
        const existing = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        prev = (await existing.Body?.transformToString()) ?? "";
        etag = existing.ETag ?? null;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== "NoSuchKey") throw err;
      }
      const seam = prev.length > 0 && !prev.endsWith("\n") ? "\n" : "";
      const tail = content.endsWith("\n") ? "" : "\n";
      const body = prev + seam + content + tail;
      try {
        await s3.send(new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
        }));
        break;
      } catch (err: unknown) {
        const name = (err as { name?: string }).name;
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        const raced = name === "PreconditionFailed" || status === 412 || status === 409;
        if (!raced || attempt >= CAS_ATTEMPTS - 1) throw err;
        // Lost the race: someone else's append landed between our GET and
        // PUT. Re-read and rebuild on top of their record instead of over it.
      }
    }

    if (key === OWN_LOG_KEY) touchBroadcastMarker();
    toolResult(id, "OK");
  } catch (err: unknown) {
    toolResult(id, `S3 write error: ${err}`, true);
  }
}

async function handleFsList(id: string | number | null, path: string): Promise<void> {
  const prefix = toKey(path).replace(/\/?$/, "/");
  if (!isListAllowed(prefix)) { toolResult(id, `List denied: ${path}`, true); return; }
  try {
    const resp = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const keys = (resp.Contents ?? [])
      .map(o => o.Key)
      .filter((k): k is string => !!k && k !== prefix)
      .map(k => "/" + k);
    toolResult(id, keys.length > 0 ? keys.join("\n") : "(empty)");
  } catch (err: unknown) {
    toolResult(id, `S3 list error: ${err}`, true);
  }
}

/**
 * Materialise an S3 prefix on local disk. Deliberately returns only counts:
 * the whole point is to keep file contents out of the agent's context. A
 * deployer assembling a project tree used to s3_read every file and fs_write
 * it back, which blew the context window and killed the iteration before it
 * could deploy.
 */
async function handleSyncLocal(id: string | number | null, source: string, dest: string): Promise<void> {
  const prefix = toKey(source).replace(/\/?$/, "/");
  if (!isReadAllowed(prefix)) { toolResult(id, `Sync denied: ${source} is not readable`, true); return; }

  const destRoot = resolveDest(dest);
  if (!destRoot) {
    toolResult(id, `Sync denied: dest must stay inside ${WORKSPACE_ROOT}`, true);
    return;
  }

  // Ensure the workspace root itself exists before writing into it. If this
  // fails the path is wrong for this runtime, so say so explicitly rather
  // than surfacing a bare EACCES the agent cannot act on.
  try {
    mkdirSync(WORKSPACE_ROOT, { recursive: true });
  } catch (err: unknown) {
    toolResult(
      id,
      `Sync failed: cannot use workspace root ${WORKSPACE_ROOT} (${err}). ` +
      `AGA_WORKSPACE=${process.env.AGA_WORKSPACE ?? "(unset)"}, HOME=${process.env.HOME ?? "(unset)"}.`,
      true,
    );
    return;
  }

  try {
    let continuationToken: string | undefined;
    let files = 0;
    let bytes = 0;

    do {
      const listed = await s3.send(new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }));

      for (const obj of listed.Contents ?? []) {
        const key = obj.Key;
        if (!key || key.endsWith("/")) continue; // skip folder markers

        const relative = key.slice(prefix.length);
        if (!relative) continue;

        const target = resolveDest(join(dest.replace(/^\/+/, ""), relative));
        if (!target) continue; // paranoid: key contained path traversal

        const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const body = await resp.Body?.transformToByteArray();
        if (!body) continue;

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body);
        files += 1;
        bytes += body.byteLength;
      }

      continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (continuationToken);

    if (files === 0) {
      toolResult(id, `Synced 0 files: nothing found under /${prefix}`);
      return;
    }

    toolResult(id, `Synced ${files} file(s), ${bytes} bytes from /${prefix} to ${destRoot}`);
  } catch (err: unknown) {
    toolResult(id, `S3 sync error: ${err}`, true);
  }
}

async function handleFsDelete(id: string | number | null, path: string): Promise<void> {
  const key = toKey(path);
  if (!isDeleteAllowed(key)) { toolResult(id, `Delete denied: ${path} (only environment/ files can be deleted)`, true); return; }
  try {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    toolResult(id, "Deleted");
  } catch (err: unknown) {
    toolResult(id, `S3 delete error: ${err}`, true);
  }
}

// ---------------------------------------------------------------------------
// Main stdio loop
// ---------------------------------------------------------------------------

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { jsonrpc: string; id?: string | number | null; method: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    respondError(null, -32700, "Parse error");
    return;
  }

  const { method, id = null } = msg;

  if (method === "initialize") {
    respond(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "aga-s3-mcp", version: "1.0.0" },
    });
    return;
  }

  if (method === "notifications/initialized") return;

  if (method === "tools/list") {
    respond(id, { tools: TOOLS });
    return;
  }

  if (method === "tools/call") {
    const params = msg.params ?? {};
    const toolName = params.name as string;
    const args = (params.arguments ?? {}) as Record<string, unknown>;

    // Validate arguments BEFORE a handler runs. Every handler starts with
    // toKey(path) / resolveDest(dest), outside its try block, so a call that
    // omitted the argument reached `undefined.replace(...)` and threw a
    // TypeError out of a promise nobody awaited. Node treats that as a fatal
    // unhandled rejection: the server died with the request unanswered, and
    // kiro-cli — still waiting on that JSON-RPC id — blocked the agent's turn
    // forever. Two agents were observed stalled 70+ minutes each on a single
    // `s3_write` the model emitted without `path`, with no error anywhere the
    // operator could see it. A malformed call must be an ordinary tool error
    // the model can read and retry, never a process death.
    const REQUIRED_ARGS: Record<string, string[]> = {
      s3_read: ["path"],
      s3_write: ["path"],
      s3_list: ["path"],
      s3_delete: ["path"],
      s3_sync_local: ["source", "dest"],
    };
    const required = REQUIRED_ARGS[toolName] ?? [];
    const missing = required.filter(
      (k) => typeof args[k] !== "string" || (args[k] as string).trim().length === 0,
    );
    // `content` is checked separately: an empty string is a legitimate body
    // (truncating a file), so only its absence or wrong type is an error.
    if (toolName === "s3_write" && typeof args.content !== "string") {
      missing.push("content");
    }
    if (missing.length > 0) {
      toolResult(
        id,
        `${toolName} is missing required argument(s): ${missing.join(", ")}. ` +
        `Received: ${Object.keys(args).length > 0 ? Object.keys(args).sort().join(", ") : "(none)"}. ` +
        `Re-issue the call with every required argument set to a non-empty string.`,
        true,
      );
      return;
    }

    // Terminal error response for anything that escapes a handler. Same
    // reasoning as the validation above and as deployMcp's failTool: an
    // unanswered request id hangs the agent indefinitely, so every async
    // path ends in a response even when it fails unexpectedly.
    const failTool = (err: unknown) => {
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`tool ${toolName} failed: ${detail}\n`);
      toolResult(
        id,
        `Internal error in ${toolName}: ${err instanceof Error ? err.message : String(err)}`,
        true,
      );
    };

    if (toolName === "s3_read") {
      handleFsRead(id, args.path as string).catch(failTool);
    } else if (toolName === "s3_write") {
      handleFsWrite(id, args.path as string, args.content as string, (args.append as boolean) ?? false).catch(failTool);
    } else if (toolName === "s3_list") {
      handleFsList(id, args.path as string).catch(failTool);
    } else if (toolName === "s3_sync_local") {
      handleSyncLocal(id, args.source as string, args.dest as string).catch(failTool);
    } else if (toolName === "s3_delete") {
      handleFsDelete(id, args.path as string).catch(failTool);
    } else {
      respondError(id, -32601, `Unknown tool: ${toolName}`);
    }
    return;
  }

  if (id != null) respondError(id, -32601, `Method not found: ${method}`);
});

rl.on("close", () => process.exit(0));

// Last-resort guards. Node's default for an unhandled rejection or uncaught
// exception is to terminate, which is the worst possible outcome for a stdio
// MCP server: the pending request dies with the process, kiro-cli keeps
// waiting on an id that can never be answered, and the agent's iteration
// hangs until an operator notices. Staying alive after an unexpected throw
// leaves this server no worse off — it holds no state between requests
// beyond an S3 client — and the next call gets a real answer instead of
// silence. Both paths log to stderr, which lands in the agent console.
process.on("unhandledRejection", (reason: unknown) => {
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
  process.stderr.write(`unhandled rejection (server kept alive): ${detail}\n`);
});
process.on("uncaughtException", (err: unknown) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  process.stderr.write(`uncaught exception (server kept alive): ${detail}\n`);
});
