/**
 * Agent loop: observe→decide→act→broadcast cycle via ACP + S3 MCP.
 *
 * Between-iteration controls (state.json driven):
 *
 *   {clusterId}/store/state.json carries the cluster's lifecycle state
 *   ("starting" | "running" | "paused" | "stopping" | "stopped"). Agents
 *   read it once between iterations to decide what to do next:
 *
 *     starting → on first iteration completion, agent flips it to
 *                "running" (read-modify-write with If-Match so an
 *                in-flight operator transition wins on conflict).
 *     running  → keep iterating.
 *     paused   → slow-poll state.json on a 10s interval, do no work,
 *                resume only when state flips back to "running".
 *     stopping → exit the loop gracefully so systemd can reap us.
 *     stopped  → exit the loop gracefully (same as above; this state
 *                normally arrives after stopping is reconciled).
 *
 *   Dynamic reload: the agent also reads config.json each iteration and
 *   applies the latest `loopIntervalSeconds`, `algorithm`, `swarmK`,
 *   `neighbourRadius`, `autopause`, `selfOptimizing`, `browserAutomation`
 *   and `model` to the next iteration. `model` can be dynamic because a
 *   fresh `kiro-cli acp` process is spawned per iteration and the model is
 *   just a `--model` flag on that spawn. The model is resolved per agent:
 *   an entry for our index in the config's `models` map wins over the
 *   cluster-wide `model`, so a flock can run a different model per node.
 *   Other fields (`concurrency`, `computeType`, `instanceType`, `taskSize`)
 *   require a restart because they change the agent-slot topology or are
 *   properties of the runtime resource itself.
 *
 *   Autopause: when `config.autopause` is true (default) and every peer
 *   we can see has reported an idle action (`/^idle\b/i`, loop-written
 *   labels excluded, unreadable journals judged by ledger recency) for three consecutive
 *   iterations (counting our own), the agent flips state.json from
 *   "running" to "paused" with reason "autopause". First agent to
 *   notice wins; the others see "paused" on their next state.json read
 *   and slow-poll like a normal pause. The If-Match precondition aborts
 *   the write silently if the operator transitioned the cluster in
 *   between, so a clicked Stop or Resume always wins.
 *
 * Multi-cluster layout: operational keys (config.json, direction.md,
 * store/) live under `{clusterId}/`. The shared `environment/` folder is
 * not prefixed — each cluster has an `environment/{clusterId}/` primary
 * subfolder but agents may read from (and when directed, write to) any
 * path under `environment/`.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { KiroRunner, summariseTurnFailure, type McpServerEntry } from "./kiroRunner.js";
import { selectNeighbours, type Algorithm } from "./neighbourSelector.js";

export interface AgentLoopConfig {
  agentIndex: number;
  concurrency: number;
  neighbours: number[];
  bucket: string;
  region: string;
  /** Initial interval only. The live value is re-read from config.json
   *  between iterations. */
  loopIntervalSeconds: number;
  /** Initial model only, already resolved for this agent by the launch path
   *  (`models[agentIndex] ?? model` in ec2Manager / ecsManager). The live
   *  value is re-read and re-resolved from config.json between iterations —
   *  each iteration spawns a fresh `kiro-cli acp`, so the `--model` flag is
   *  recomputed every cycle. `null` means "omit the flag and use kiro-cli's
   *  own default". */
  model: string | null;
  /** Initial algorithm. Dynamically reloaded between iterations. */
  algorithm: Algorithm;
  /** Initial swarmK. Dynamically reloaded between iterations. Only used
   *  when algorithm === "swarm". */
  swarmK: number;
  /** Initial neighbour radius. Dynamically reloaded between iterations.
   *  Only used when algorithm === "amorphous". */
  neighbourRadius: number;
  /** Cluster this agent belongs to. Prefixes config/direction/state/store
   *  keys. */
  clusterId: string;
  /** When true (default), the agent participates in autopause: after every
   *  agent reports `action: "idle"` for three consecutive iterations the
   *  cluster is paused with reason "autopause". */
  autopause: boolean;
  /** Pass 8: when true, the agent appends a self-reflection block to its
   *  own per-agent directive after each iteration. Cluster direction is
   *  untouched. Default false. Reloads dynamically between iterations. */
  selfOptimizing: boolean;
  /** When true, agents get a Puppeteer MCP server for headless browser
   *  automation. Reloads dynamically between iterations. */
  browserAutomation: boolean;
  /** Optional Everforge group name. When set, the agent's environment
   *  prefix becomes `environment/<everforgeGroup>/<clusterId>/` and the
   *  deployed/ folder is at `environment/<everforgeGroup>/deployed/`. */
  everforgeGroup?: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ---------- Iteration cost capture -------------------------------------------
//
// kiro-cli persists per-turn metering in the session sidecar
// `~/.kiro/sessions/cli/<sessionId>.json` under
// session_state.conversation_metadata.user_turn_metadatas[].metering_usage
// as `{ value, unit: "credit" }` entries. Each flock iteration is exactly
// one ACP session with one prompt turn, so summing the metering values
// across all turns of the session gives the iteration's credit spend.
//
// After every iteration the loop appends one line to
// `{clusterId}/store/agent-N.costs.ndjson`:
//
//   {"ts":"…","iteration":3,"sessionId":"…","credits":0.32,"totalCredits":4.71,"durationMs":184223}
//
// `durationMs` is the wall time of the whole iteration turn (kiro-cli spawn
// through close), recorded so operators can set loopIntervalSeconds from
// measured iteration cost instead of aspiration — intervals shorter than the
// iteration duration buy nothing and misrepresent the cluster's real cadence.
//
// `totalCredits` is a running lifetime total carried in every line so any
// consumer (snapshot builder, dashboard) can get the agent's total from a
// tail read of the last line only — the file never has to be re-scanned,
// which keeps cost aggregation O(agents), not O(iterations). Best-effort:
// a failed read or write only loses one iteration's cost data, never the
// iteration itself.

/** Sum the credit metering kiro-cli recorded for a session, in whichever
 *  layout the harness wrote: the V3 session folder first (what the runner
 *  starts), then the V2 sidecar. Null when neither holds metering. */
function readSessionCredits(sessionId: string): number | null {
  return readV3Credits(sessionId) ?? readSidecarCredits(sessionId);
}

const SESSIONS_ROOT = resolve(process.env.HOME ?? "/home/ec2-user", ".kiro", "sessions");

/** The V3 harness keeps a session at `~/.kiro/sessions/<workspace hash>/<id>/`
 *  and writes a `usage_summary` record into its `messages.jsonl` per prompt
 *  turn, credits under `promptTurnSummaries[].usage`. The folder is keyed by a
 *  hash of the workspace, so the id is looked for under each one. */
function readV3Credits(sessionId: string): number | null {
  let dirs: string[];
  try {
    dirs = readdirSync(SESSIONS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "cli")
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    let text: string;
    try {
      text = readFileSync(resolve(SESSIONS_ROOT, dir, sessionId, "messages.jsonl"), "utf-8");
    } catch {
      continue;
    }
    let credits = 0;
    let seen = false;
    for (const line of text.split("\n")) {
      if (!line.includes("usage_summary")) continue;
      try {
        const payload = (JSON.parse(line) as { payload?: { type?: unknown; promptTurnSummaries?: unknown } }).payload;
        if (payload?.type !== "usage_summary" || !Array.isArray(payload.promptTurnSummaries)) continue;
        for (const m of payload.promptTurnSummaries as Array<{ usage?: unknown; unit?: unknown }>) {
          const unit = typeof m.unit === "string" ? m.unit.toLowerCase() : "credit";
          if (typeof m.usage === "number" && Number.isFinite(m.usage) && unit.startsWith("credit")) {
            credits += m.usage;
            seen = true;
          }
        }
      } catch {
        // A torn line (the file is appended while we read) is skipped.
      }
    }
    return seen ? credits : null;
  }
  return null;
}

/** The V2 sidecar, `~/.kiro/sessions/cli/<id>.json`. */
function readSidecarCredits(sessionId: string): number | null {
  try {
    const sidecarPath = resolve(SESSIONS_ROOT, "cli", `${sessionId}.json`);
    const doc = JSON.parse(readFileSync(sidecarPath, "utf-8")) as {
      session_state?: {
        conversation_metadata?: {
          user_turn_metadatas?: Array<{
            metering_usage?: Array<{ value?: unknown; unit?: unknown }>;
          }>;
        };
      };
    };
    const turns = doc.session_state?.conversation_metadata?.user_turn_metadatas;
    if (!Array.isArray(turns)) return null;
    let credits = 0;
    let seen = false;
    for (const turn of turns) {
      for (const m of turn.metering_usage ?? []) {
        const unit = typeof m.unit === "string" ? m.unit.toLowerCase() : "credit";
        if (typeof m.value === "number" && Number.isFinite(m.value) && unit.startsWith("credit")) {
          credits += m.value;
          seen = true;
        }
      }
    }
    return seen ? credits : null;
  } catch {
    return null;
  }
}

/** readSessionCredits with retries. kiro-cli flushes the session sidecar
 *  asynchronously around process exit, so a single read immediately after
 *  client.close() races it — the file may be missing or not yet carry the
 *  metering entries. A few short retries close that window; without them
 *  an iteration's cost line is silently lost (observed as agents with
 *  gaps in, or entirely missing, agent-N.costs.ndjson). */
async function readSessionCreditsWithRetry(
  sessionId: string,
  attempts = 4,
  delayMs = 2500,
): Promise<number | null> {
  for (let i = 0; i < attempts; i++) {
    const credits = readSessionCredits(sessionId);
    if (credits !== null) return credits;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

function costsKey(clusterId: string, agentIndex: number): string {
  return `${clusterId}/store/agent-${agentIndex}.costs.ndjson`;
}

/** Read the costs file plus its ETag. The ETag lets the append be made
 *  conditional, so two overlapping writers cannot silently clobber each
 *  other's line (S3 has no append, so every write is a full read-concat-put). */
async function readCostsFile(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<{ body: string; etag: string | null }> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { body: (await res.Body?.transformToString()) ?? "", etag: res.ETag ?? null };
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return { body: "", etag: null };
    throw err;
  }
}

/** Running total carried on the most recent parsable line. */
function lastTotalCredits(existing: string): number {
  const lines = existing.split("\n").filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const last = JSON.parse(lines[i]) as { totalCredits?: unknown };
      if (typeof last.totalCredits === "number" && Number.isFinite(last.totalCredits)) {
        return last.totalCredits;
      }
    } catch { /* malformed trailing line — walk back one more */ }
  }
  return 0;
}

/** Append one NDJSON line, retrying on a lost optimistic-concurrency race.
 *  `build` is called with the current running total on every attempt so a
 *  retry recomputes totalCredits against whatever landed in the meantime. */
async function appendCostLine(
  s3: S3Client,
  bucket: string,
  key: string,
  build: (previousTotal: number) => Record<string, unknown>,
  attempts = 3,
): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const { body: existing, etag } = await readCostsFile(s3, bucket, key);
    const line = JSON.stringify(build(lastTotalCredits(existing)));
    const body = existing.length > 0 && !existing.endsWith("\n")
      ? `${existing}\n${line}\n`
      : `${existing}${line}\n`;
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/x-ndjson",
        // Guard the read-concat-put. IfMatch on an existing object, IfNoneMatch
        // for the first write, so a concurrent creator cannot be overwritten.
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
      }));
      return;
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const raced = name === "PreconditionFailed" || status === 412 || status === 409;
      if (!raced || i === attempts - 1) throw err;
      // Someone else wrote between our GET and PUT — re-read and rebuild.
    }
  }
}

/** Generic CAS append of one NDJSON line to any S3 key. Same discipline as
 *  appendCostLine (If-Match / If-None-Match: *, re-read on a lost race) but
 *  with no running-total logic. Exists because the loop had a second,
 *  UNCONDITIONAL read-modify-write on the agent's journal
 *  (appendInterruptedEntry) racing the MCP's writes on the same key — probed
 *  live: 10/10 races lost one of the two acknowledged records. Every loop
 *  writer routes through here now. Also normalises the newline seam, so a
 *  model write that ended without \n cannot glue this record into a `}{`
 *  line that every tail parser then skips. */
async function casAppendLine(
  s3: S3Client,
  bucket: string,
  key: string,
  line: string,
  attempts = 5,
): Promise<void> {
  for (let i = 0; ; i++) {
    const { body: existing, etag } = await readCostsFile(s3, bucket, key);
    const seam = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    const body = existing + seam + line + (line.endsWith("\n") ? "" : "\n");
    try {
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: "application/x-ndjson",
        ...(etag ? { IfMatch: etag } : { IfNoneMatch: "*" }),
      }));
      return;
    } catch (err: unknown) {
      const name = (err as { name?: string }).name;
      const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const raced = name === "PreconditionFailed" || status === 412 || status === 409;
      if (!raced || i >= attempts - 1) throw err;
    }
  }
}

/** Append an iteration cost line to agent-N.costs.ndjson. The previous last
 *  line supplies the running total, so the total survives process restarts. */
async function appendCostEntry(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
  entry: { iteration: number; sessionId: string; credits: number; durationMs: number },
): Promise<void> {
  await appendCostLine(
    s3, bucket, costsKey(clusterId, agentIndex),
    (previousTotal) => ({
      ts: new Date().toISOString(),
      iteration: entry.iteration,
      sessionId: entry.sessionId,
      credits: entry.credits,
      totalCredits: previousTotal + entry.credits,
      durationMs: entry.durationMs,
    }),
  );
}

/** Record an iteration whose credit spend could not be measured.
 *
 *  Carries no `credits` field at all — the value is unknown, and writing a
 *  zero or a guess would corrupt the measured record that consumers average
 *  over. `totalCredits` is carried forward unchanged so the running total
 *  stays a sum of real readings. Consumers detect `unmetered` and estimate. */
async function appendUnmeteredCostEntry(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
  entry: { iteration: number; sessionId: string; durationMs: number },
): Promise<void> {
  await appendCostLine(
    s3, bucket, costsKey(clusterId, agentIndex),
    (previousTotal) => ({
      ts: new Date().toISOString(),
      iteration: entry.iteration,
      sessionId: entry.sessionId,
      unmetered: true,
      totalCredits: previousTotal,
      durationMs: entry.durationMs,
    }),
  );
}

/** Highest iteration number already recorded for this agent, or -1 when the
 *  file is absent. Used to seed the loop counter after a restart: the counter
 *  is otherwise process-local and resets to 0, which produced duplicate
 *  iteration numbers across both `.iter` markers and the costs file. Duplicate
 *  markers collapse the dashboard's whole iteration list to mtime ordinals and
 *  collide cost attribution, so a restart used to corrupt both. */
async function lastRecordedIteration(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<number> {
  try {
    const { body } = await readCostsFile(s3, bucket, costsKey(clusterId, agentIndex));
    let highest = -1;
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { iteration?: unknown };
        if (typeof e.iteration === "number" && Number.isFinite(e.iteration) && e.iteration > highest) {
          highest = e.iteration;
        }
      } catch { /* skip malformed line */ }
    }
    return highest;
  } catch {
    return -1;
  }
}

/** Sentinel separating the session tail from the turn error in the acp
 *  stream script's output. Must match TURN_ERROR_MARKER in agentStream.ts. */
const TURN_ERROR_MARKER = "---TURNERROR---";

/** Write `<sessionId>.error` beside the session journal so the dashboard can
 *  append the cause to the end of that iteration's transcript. Sibling of the
 *  `.iter` marker and best-effort in the same way: losing it degrades the
 *  display, never the iteration.
 *
 *  The text is stripped of the marker sentinel and control characters because
 *  it is carried back through a shell script's stdout and split on that
 *  marker; a message containing it would corrupt the parse. */
function writeTurnErrorMarker(sessionId: string, reason: string): void {
  try {
    const safe = reason
      .split(TURN_ERROR_MARKER).join("[marker]")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
      .slice(0, 4000);
    writeFileSync(
      resolve(process.env.HOME ?? "/home/ec2-user", ".kiro", "sessions", "cli", `${sessionId}.error`),
      safe,
    );
  } catch (err: unknown) {
    console.error("turn error marker write failed:", err);
  }
}

const PAUSE_POLL_INTERVAL_MS = 10_000;

/** Per-cluster lifecycle state values. Mirrors lambda/s3Store.ts so this
 *  module stays standalone (no shared lambda imports inside the agent
 *  bundle, which is built and shipped separately). */
type ClusterStateValue = "starting" | "running" | "paused" | "stopping" | "stopped";

interface ClusterStateDoc {
  state: ClusterStateValue;
  transitionedAt: string;
  transitionedBy: string;
  reason?: string;
}

interface ClusterStateRead {
  doc: ClusterStateDoc;
  etag: string | null;
}

/** Read state.json. Missing file is treated as "stopped" — same fallback
 *  as the Lambda. The etag is needed for conditional writes (autopause,
 *  Starting → Running). */
async function readState(
  s3: S3Client,
  bucket: string,
  clusterId: string,
): Promise<ClusterStateRead> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/state.json`,
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) {
      return {
        doc: { state: "stopped", transitionedAt: "1970-01-01T00:00:00.000Z", transitionedBy: "system" },
        etag: null,
      };
    }
    return { doc: JSON.parse(body) as ClusterStateDoc, etag: res.ETag ?? null };
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey") {
      return {
        doc: { state: "stopped", transitionedAt: "1970-01-01T00:00:00.000Z", transitionedBy: "system" },
        etag: null,
      };
    }
    throw err;
  }
}

/** Append one line to `{clusterId}/store/transitions.ndjson` — the
 *  append-only lifecycle log the dashboard's timeline band reads.
 *  Mirrors the Lambda-side appendTransition in lambda/s3Store.ts (agent
 *  code shares no modules with Lambda code, so this is a deliberate
 *  copy). Read-modify-write append is fine at this write rate. Best-
 *  effort by design: a failure is logged and swallowed — the state.json
 *  transition (with its If-Match semantics) is the source of truth and
 *  must never fail because of this observability write. */
async function appendTransition(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  entry: { ts: string; state: ClusterStateValue; by: string; reason: string },
): Promise<void> {
  const key = `${clusterId}/store/transitions.ndjson`;
  try {
    let existing = "";
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      existing = (await res.Body?.transformToString()) ?? "";
    } catch (err: unknown) {
      if ((err as { name?: string }).name !== "NoSuchKey") throw err;
    }
    const line = JSON.stringify(entry);
    const body = existing.length > 0 && !existing.endsWith("\n")
      ? `${existing}\n${line}\n`
      : `${existing}${line}\n`;
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: "application/x-ndjson",
      CacheControl: "no-store",
    }));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`appendTransition failed (best-effort, transition not logged): ${message}`);
  }
}

/** Write state.json with optional If-Match precondition. Returns true on
 *  success, false on a 412 (precondition failed) so the caller can drop
 *  the intent gracefully — used by autopause and Starting → Running so
 *  an operator-initiated transition that fires inside the read-modify-
 *  write window always wins. */
async function writeStateConditional(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  next: ClusterStateValue,
  agentIndex: number,
  reason: string,
  ifMatch: string | null,
): Promise<boolean> {
  const doc: ClusterStateDoc = {
    state: next,
    transitionedAt: new Date().toISOString(),
    transitionedBy: `agent-${agentIndex}`,
    reason,
  };
  try {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/state.json`,
      Body: JSON.stringify(doc),
      ContentType: "application/json",
      CacheControl: "no-store",
      ...(ifMatch ? { IfMatch: ifMatch } : {}),
    }));
    // Mirror the committed transition into the append-only transitions
    // log (dashboard timeline). Only on success — a 412 means no
    // transition happened. appendTransition never throws.
    await appendTransition(s3, bucket, clusterId, {
      ts: doc.transitionedAt,
      state: next,
      by: doc.transitionedBy,
      reason,
    });
    return true;
  } catch (err: unknown) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const code = (err as { Code?: string; name?: string }).Code ?? (err as { name?: string }).name;
    if (status === 412 || code === "PreconditionFailed") {
      return false;
    }
    console.error(`state write (${next}) failed for agent-${agentIndex}:`, err);
    return false;
  }
}

/** Subset of config.json that reloads dynamically between iterations. */
interface DynamicConfig {
  loopIntervalSeconds: number | null;
  algorithm: Algorithm | null;
  swarmK: number | null;
  neighbourRadius: number | null;
  autopause: boolean | null;
  selfOptimizing: boolean | null;
  browserAutomation: boolean | null;
  /** Three-state, unlike the fields above. `null` is a meaningful value for
   *  model ("omit `--model`, use kiro-cli's default"), so "couldn't read it,
   *  keep the previous value" has to be `undefined` instead.
   *
   *  Already resolved for this agent: `models[agentIndex]` when the cluster
   *  config carries a per-agent override for us, otherwise the cluster-wide
   *  `model`. The loop never sees the raw map. */
  model: string | null | undefined;
  /** True when the value in `model` came from a per-agent override rather
   *  than the cluster baseline. Only used for log wording — the resolved
   *  value is the same either way. */
  modelIsOverride: boolean;
}

/** Same permissive charset guard the Lambda falls back to when the model
 *  catalog is unavailable. The API validates against the catalog on write,
 *  so this is defence against a hand-edited config.json reaching the spawn
 *  args — not a second round of validation. */
const MODEL_ID_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Parse one model slot from config.json into the three-state shape:
 *  a well-formed id, `null` for "omit `--model`", or `undefined` for
 *  "unusable, caller decides the fallback". Used for both the cluster-wide
 *  `model` and each entry of the per-agent `models` map. */
function parseModelValue(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw === "string" && MODEL_ID_REGEX.test(raw)) return raw;
  return undefined;
}

/**
 * Read {clusterId}/config.json and return the fields that reload
 * dynamically. Any missing / malformed field returns null for that slot
 * so the caller keeps the previous value. A single bad field never
 * poisons the others.
 */
async function readDynamicConfig(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<DynamicConfig> {
  const empty: DynamicConfig = {
    loopIntervalSeconds: null,
    algorithm: null,
    swarmK: null,
    neighbourRadius: null,
    autopause: null,
    selfOptimizing: null,
    browserAutomation: null,
    model: undefined,
    modelIsOverride: false,
  };
  try {
    const resp = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: `${clusterId}/config.json` }),
    );
    const text = (await resp.Body?.transformToString()) ?? "";
    if (!text) return empty;
    const parsed = JSON.parse(text) as {
      loopIntervalSeconds?: unknown;
      algorithm?: unknown;
      swarmK?: unknown;
      neighbourRadius?: unknown;
      autopause?: unknown;
      selfOptimizing?: unknown;
      browserAutomation?: unknown;
      model?: unknown;
      models?: unknown;
    };

    const interval =
      typeof parsed.loopIntervalSeconds === "number" &&
      Number.isFinite(parsed.loopIntervalSeconds) &&
      parsed.loopIntervalSeconds >= 0
        ? Math.floor(parsed.loopIntervalSeconds)
        : null;

    const algo =
      parsed.algorithm === "amorphous" ||
      parsed.algorithm === "mesh" ||
      parsed.algorithm === "swarm" ||
      parsed.algorithm === "single"
        ? (parsed.algorithm as Algorithm)
        : null;

    const k =
      typeof parsed.swarmK === "number" &&
      Number.isFinite(parsed.swarmK) &&
      parsed.swarmK >= 1
        ? Math.floor(parsed.swarmK)
        : null;

    const radius =
      typeof parsed.neighbourRadius === "number" &&
      Number.isFinite(parsed.neighbourRadius) &&
      parsed.neighbourRadius >= 0
        ? Math.floor(parsed.neighbourRadius)
        : null;

    const auto = typeof parsed.autopause === "boolean" ? parsed.autopause : null;
    const selfOpt = typeof parsed.selfOptimizing === "boolean" ? parsed.selfOptimizing : null;
    const browser = typeof parsed.browserAutomation === "boolean" ? parsed.browserAutomation : null;

    // Resolve this agent's model: a per-agent override in `models` wins over
    // the cluster-wide `model`. Both use the same three-state parse — an
    // explicit null means "use kiro-cli's default" and must pass through as
    // null rather than being treated as absent, while anything malformed
    // becomes undefined so the caller keeps its previous value.
    //
    // The override is only consulted when the key is actually present. A
    // missing key is not the same as `null`: absent means "fall back to the
    // cluster model", null means "pinned to kiro-cli's default".
    const clusterModel = parseModelValue(parsed.model);
    const overrides =
      parsed.models !== null &&
      typeof parsed.models === "object" &&
      !Array.isArray(parsed.models)
        ? (parsed.models as Record<string, unknown>)
        : null;
    const ownKey = String(agentIndex);
    const hasOwnOverride =
      overrides !== null && Object.prototype.hasOwnProperty.call(overrides, ownKey);
    // A malformed override falls back to the cluster model rather than
    // freezing the previous value — a garbled entry for one agent shouldn't
    // strand it on a stale model while its peers move.
    const ownOverride = hasOwnOverride ? parseModelValue(overrides![ownKey]) : undefined;
    const overrideUsable = hasOwnOverride && ownOverride !== undefined;

    return {
      loopIntervalSeconds: interval,
      algorithm: algo,
      swarmK: k,
      neighbourRadius: radius,
      autopause: auto,
      selfOptimizing: selfOpt,
      browserAutomation: browser,
      model: overrideUsable ? ownOverride : clusterModel,
      modelIsOverride: overrideUsable,
    };
  } catch (err: unknown) {
    console.error("config reload failed, keeping previous values:", err);
    return empty;
  }
}

/** Actions written by the LOOP rather than the agent. They describe the
 *  turn machinery, not what the agent is working on, so they carry no vote
 *  in the idle consensus: a run of interrupted labels used to read as
 *  "activity" and veto autopause on a cluster that had long since converged. */
const LOOP_WRITTEN_ACTIONS = new Set(["iteration-interrupted", "iteration-failed"]);

/** An agent counts as idle when its action SAYS idle, decorations included.
 *  The old exact-match (`action === "idle"`) failed 69% of observed idle
 *  broadcasts, because agents write things like "idle - diagnosis complete". */
const IDLE_ACTION_RE = /^idle\b/i;

/** A peer whose journal is unreadable is judged by its cost ledger instead:
 *  no metered turn for this long means it is not doing billable work, and it
 *  must not veto autopause forever. (agent-4 ran 55 turns with a permanently
 *  unparseable journal; its null vote alone kept a converged cluster running
 *  — 2,353 of that run's 2,410 credits burned after convergence.) */
const AUTOPAUSE_SILENT_MS = 30 * 60_000;

/**
 * One peer's vote in the autopause consensus: does anything about this agent
 * argue the cluster should stay running?
 *
 * Walks the journal tail newest-first, skipping loop-written labels, and
 * judges the last AGENT-authored entry against IDLE_ACTION_RE. When the
 * journal yields no agent-authored entry at all (missing, empty, or every
 * line unparseable), falls back to ledger recency: a recent metered turn
 * votes active, prolonged silence votes idle.
 */
async function peerIdleVote(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<"idle" | "active"> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/agent-${agentIndex}.ndjson`,
      // Wide tail: interrupted labels now carry full error text, so a run of
      // them can push the last agent-authored entry several KB back.
      Range: "bytes=-16384",
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    const contentRange = res.ContentRange ?? "";
    const startsAtZero = /^bytes 0-/.test(contentRange);
    const lines = body.split("\n");
    if (!startsAtZero && lines.length > 1) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { action?: unknown };
        if (typeof entry.action !== "string") continue;
        if (LOOP_WRITTEN_ACTIONS.has(entry.action)) continue;
        return IDLE_ACTION_RE.test(entry.action) ? "idle" : "active";
      } catch { /* unparseable line — keep walking */ }
    }
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name !== "NoSuchKey" && name !== "InvalidRange") throw err;
  }
  // No usable journal signal. Judge by the ledger: metering only lands on
  // completed turns, so a recent line means real, billable activity.
  try {
    const { body } = await readCostsFile(s3, bucket, costsKey(clusterId, agentIndex));
    const lines = body.split("\n").filter((l) => l.trim().length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]) as { ts?: unknown };
        if (typeof e.ts === "string") {
          const age = Date.now() - Date.parse(e.ts);
          return Number.isFinite(age) && age < AUTOPAUSE_SILENT_MS ? "active" : "idle";
        }
      } catch { /* malformed — keep walking */ }
    }
  } catch { /* ledger unreadable too */ }
  // Nothing anywhere: the agent has never completed a turn. Do not let it
  // hold the whole cluster hostage.
  return "idle";
}

/**
 * Read the last NDJSON entry from one agent's log file. Returns null when
 * the file doesn't exist yet or is empty. Used both for autopause (peeking
 * at peers' last action) and for the agent's own self-check.
 */
async function readLastEntry(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<{ action: string; ts: string; iteration?: number } | null> {
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/agent-${agentIndex}.ndjson`,
      Range: "bytes=-2048",
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    if (!body) return null;
    const contentRange = res.ContentRange ?? "";
    const startsAtZero = /^bytes 0-/.test(contentRange);
    const lines = body.split("\n");
    if (!startsAtZero && lines.length > 1) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const entry = JSON.parse(line) as { action?: unknown; ts?: unknown; iteration?: unknown };
        if (typeof entry.action === "string" && typeof entry.ts === "string") {
          return {
            action: entry.action,
            ts: entry.ts,
            iteration: typeof entry.iteration === "number" ? entry.iteration : undefined,
          };
        }
      } catch {
        // skip malformed line
      }
    }
    return null;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "InvalidRange") return null;
    throw err;
  }
}

/**
 * Append a synthetic `iteration-interrupted` broadcast to the agent's own log.
 *
 * A kiro-cli turn can end without the agent ever broadcasting: context
 * overflow, model throttling, or a crashed session all abort mid-tool-call.
 * Previously the loop swallowed those and moved on, so an agent could burn
 * dozens of iterations while `stream_logs` and the dashboard kept showing a
 * stale entry from its last successful turn — the operator had no signal that
 * anything was wrong (observed on a deployer that lost 60+ iterations in a
 * row to context bloat).
 *
 * Writing a real log line makes it visible everywhere agent activity is
 * already surfaced, including to neighbouring clusters that poll each other's
 * logs. Best-effort: never throw, since this runs on the failure path.
 *
 * "interrupted", not "failed": the iteration usually did substantial work
 * before its turn was cut off (one observed case ran 12 minutes and produced
 * 451KB of conversation). Calling it a failure overstates what happened, and
 * the agent reads this line back on its next iteration.
 */
async function appendInterruptedEntry(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
  iteration: number,
  reason: string,
): Promise<void> {
  const key = `${clusterId}/store/agent-${agentIndex}.ndjson`;
  try {
    // An empty model response (kiro-cli's "Kiro failed to generate a
    // response", JSON-RPC -32603) can land AFTER the turn's broadcast already
    // committed — observed live: a session's final s3_write completed despite
    // the subsequent error. The CLI has also already retried internally by
    // the time this surfaces, so a blind loop-level redo both wastes a turn
    // and risks duplicating side effects. Tell the agent to check first.
    const emptyResponse = /failed to generate a response|-32603/i.test(reason);
    const entry = {
      ts: new Date().toISOString(),
      iteration,
      action: "iteration-interrupted",
      // 2000, not 200: the old cap cut service errors off mid-word, dropping
      // request ids and reason codes that are the only handle support has.
      result: reason.slice(0, 2000),
      next_intent: emptyResponse
        ? "the model returned an empty response; your broadcast may already have committed before the error — read your own log first and only redo what is genuinely missing"
        : "resume the same work next iteration, taking the recorded reason into account",
    };
    // CAS, not unconditional: this writer shares the journal key with the
    // MCP's s3_write. The unconditional version lost one of the two records
    // in every probed race — and the surviving false label then became the
    // newest parseable line, which the agent read back as its own memory.
    await casAppendLine(s3, bucket, key, JSON.stringify(entry));
  } catch (err: unknown) {
    console.error("failure entry write failed:", err);
  }
}

/**
 * Read the per-agent directive file if it exists. Returns null when no
 * directive has been issued to this agent. The directive is written by
 * the map-reduce engine and takes priority over the cluster direction
 * where they conflict (the preamble in the file makes this explicit).
 */
async function readDirective(
  s3Client: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<string | null> {
  try {
    const res = await s3Client.send(new GetObjectCommand({
      Bucket: bucket,
      Key: `${clusterId}/store/agent-${agentIndex}.directive.md`,
    }));
    const body = (await res.Body?.transformToString()) ?? "";
    return body || null;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey") return null;
    // Non-fatal: log and continue without directive
    console.error(`directive read failed for agent-${agentIndex}:`, err);
    return null;
  }
}

/**
 * Load the base agent loop prompt and the algorithm fragment, substitute
 * {{ALGORITHM_GUIDANCE}} and {{SELF_OPTIMIZING}}, and return the composed
 * prompt. Throws loudly if any required file or placeholder is missing. A
 * misspelled algorithm should crash the agent at boot, not run silently
 * with the wrong instructions.
 */
function buildAgentPrompt(
  algorithm: Algorithm,
  selfOptimizing: boolean,
  agentIndex: number,
  clusterId: string,
): string {
  const base = readFileSync(
    resolve(__dirname, "..", "agents", "prompts", "agent-loop.md"),
    "utf-8",
  );
  const fragmentPath = resolve(
    __dirname,
    "..",
    "agents",
    "prompts",
    "algorithms",
    `${algorithm}.md`,
  );
  let fragment: string;
  try {
    fragment = readFileSync(fragmentPath, "utf-8");
  } catch (err: unknown) {
    throw new Error(
      `Missing algorithm fragment for "${algorithm}" at ${fragmentPath}. ` +
      `Check agents/prompts/algorithms/ and the algorithm value in config.json. ` +
      `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!base.includes("{{ALGORITHM_GUIDANCE}}")) {
    throw new Error(
      "agent-loop.md is missing the {{ALGORITHM_GUIDANCE}} placeholder. " +
      "The base prompt and the per-algorithm fragments must be combined " +
      "before sending to the agent.",
    );
  }
  if (!base.includes("{{SELF_OPTIMIZING}}")) {
    throw new Error(
      "agent-loop.md is missing the {{SELF_OPTIMIZING}} placeholder. " +
      "The base prompt must include this anchor so the self-optimizing " +
      "fragment can be inlined when the feature is enabled.",
    );
  }

  let selfOptimizingFragment = "";
  if (selfOptimizing) {
    const selfOptPath = resolve(
      __dirname,
      "..",
      "agents",
      "prompts",
      "self-optimizing-on.md",
    );
    try {
      selfOptimizingFragment = readFileSync(selfOptPath, "utf-8");
    } catch (err: unknown) {
      throw new Error(
        `Missing self-optimizing fragment at ${selfOptPath}. ` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Substitute concrete identifiers so the agent has a fully-formed
    // path to write to without having to interpolate.
    selfOptimizingFragment = selfOptimizingFragment
      .replace(/\{\{AGENT_INDEX\}\}/g, String(agentIndex))
      .replace(/\{\{CLUSTER_ID\}\}/g, clusterId);
  }

  let prompt = base.replace("{{ALGORITHM_GUIDANCE}}", fragment.trim());
  prompt = prompt.replace("{{SELF_OPTIMIZING}}", selfOptimizingFragment);
  return prompt;
}

export async function runLoop(config: AgentLoopConfig): Promise<void> {
  let shutdown = false;
  process.on("SIGTERM", () => { shutdown = true; });

  const n = config.agentIndex;
  const clusterId = config.clusterId;

  // Broadcast marker: touched by the S3 MCP on every successful append to
  // this agent's own journal, deleted by the loop before each turn. Its
  // existence after the turn is the broadcast signal.
  const broadcastMarkerPath = `/tmp/aga-broadcast-agent-${n}.marker`;

  // Standalone S3 MCP server script, bundled alongside this file.
  const s3McpScript = resolve(__dirname, "s3Mcp.js");
  const s3McpServer: McpServerEntry = {
    name: "aga-s3",
    command: "node",
    args: [s3McpScript],
    env: [
      { name: "AGA_BUCKET", value: config.bucket },
      { name: "AGA_REGION", value: config.region },
      { name: "AGA_CLUSTER_PREFIX", value: clusterId },
      // The MCP subprocess gets an explicit env, so anything it needs must
      // be listed here. AGA_WORKSPACE tells s3_sync_local where it may write
      // (EC2 and ECS use different homes); AGA_EVERFORGE_GROUP makes its tool
      // descriptions advertise the correct environment prefix.
      { name: "AGA_WORKSPACE", value: process.env.AGA_WORKSPACE ?? "" },
      { name: "AGA_EVERFORGE_GROUP", value: config.everforgeGroup ?? "" },
      // Own-journal guard + broadcast marker (see s3Mcp.ts). The MCP touches
      // the marker file on every successful append to the agent's own log;
      // the loop deletes it before each turn and checks it afterwards. This
      // is the broadcast signal from the process that actually did the write,
      // replacing the ts-diff over the shared log, which reported false
      // "no broadcast" whenever the log's newest line was unparseable.
      { name: "AGA_OWN_LOG_KEY", value: `${clusterId}/store/agent-${n}.ndjson` },
      { name: "AGA_BROADCAST_MARKER", value: broadcastMarkerPath },
    ],
  };

  // Local S3 client for state polling, config reload, and neighbour selection.
  // Cheap to reuse across iterations.
  const s3 = new S3Client({ region: config.region });

  // Live state for the dynamically-reloadable fields. Starts from the
  // launch-time config and is refreshed every cycle.
  let currentIntervalSeconds = config.loopIntervalSeconds;
  let currentAlgorithm: Algorithm = config.algorithm;
  let currentSwarmK = config.swarmK;
  let currentRadius = config.neighbourRadius;
  let currentAutopause = config.autopause;
  let currentSelfOptimizing = config.selfOptimizing;
  let currentBrowserAutomation = config.browserAutomation;
  let currentModel = config.model;
  let currentNeighbours = config.neighbours;

  // Autopause counter — number of consecutive iterations on which every
  // visible agent (us + currentNeighbours) reported `action: "idle"`.
  // Reset to 0 the moment any agent does anything else. At 3 the agent
  // flips state.json to "paused" (if config.autopause is on).
  let consecutiveAllIdle = 0;
  const AUTOPAUSE_THRESHOLD = 3;

  // Iteration counter, 0-based. Each iteration spawns exactly one kiro-cli
  // ACP session (one `<sessionId>.jsonl` in ~/.kiro/sessions/cli), so we
  // drop a `<sessionId>.iter` sidecar containing this number right after
  // session creation. The dashboard's iteration dropdown reads these
  // markers via SSM; when a marker is missing (older agent code, crashed
  // write) it falls back to mtime ordering.
  //
  // Seeded from the highest iteration already in the costs file rather than
  // starting at 0. The counter is process-local, so a restart used to replay
  // numbers that were already in use: duplicate `.iter` markers collapse the
  // dashboard's entire iteration list to mtime ordinals (which also disables
  // its cost lookup), and duplicate cost lines misattribute spend. Falls back
  // to 0 when there is no prior record, i.e. a genuinely fresh agent.
  let iterationCounter = (await lastRecordedIteration(s3, config.bucket, clusterId, n)) + 1;
  if (iterationCounter > 0) {
    console.log(`resuming at iteration ${iterationCounter} (recovered from cost log)`);
  }

  while (!shutdown) {
    // Rebuild the prompt each iteration so the algorithm fragment and
    // neighbour list always match current state. Log paths are rooted
    // at the agent's cluster prefix so the MCP's s3_read allowlist
    // accepts them.
    const neighbourPaths = currentNeighbours
      .map((i) => `/${clusterId}/store/agent-${i}.ndjson`)
      .join(", ");
    // single algorithm has no peers; render an explicit "(none — solo
    // agent)" so the prompt header is clear rather than ending with an
    // empty list.
    const neighbourLine = currentNeighbours.length === 0
      ? `Your neighbour log files: (none — you are the sole agent in this cluster).`
      : `Your neighbour log files are: ${neighbourPaths}.`;

    const envDir = config.everforgeGroup
      ? `/environment/${config.everforgeGroup}/${clusterId}`
      : `/environment/${clusterId}`;
    const deployedDir = config.everforgeGroup
      ? `/environment/${config.everforgeGroup}/deployed`
      : `/environment/deployed`;

    const promptHeader = [
      `You are agent-${n} in cluster "${clusterId}".`,
      `Your direction file is: /${clusterId}/direction.md.`,
      `Your log file is: /${clusterId}/store/agent-${n}.ndjson.`,
      neighbourLine,
      `Your primary environment directory is: ${envDir}.`,
      `The deployed/ folder for your project is: ${deployedDir}.`,
      `The full /environment/ folder is shared across clusters and readable; other clusters' subfolders sit under /environment/.`,
      `Your knowledge base is: /knowledge-base.`,
      `Follow your agent loop prompt instructions.`,
    ].join("\n");

    // Check for a per-agent directive (written by the map-reduce engine).
    // If present, inject the FULL CONTENT into the prompt so the agent sees
    // it immediately without needing to read it from S3. This ensures idle
    // agents act on directives instead of skipping them.
    const directive = await readDirective(s3, config.bucket, clusterId, n);
    const directiveBlock = directive
      ? `\n\n## Per-Agent Directive (PRIORITY — act on this)\n\nThe following directive was issued to you specifically. It takes precedence over the cluster direction where they conflict. Do NOT ignore this even if you were idle.\n\n${directive}\n`
      : "";

    const agentPrompt = buildAgentPrompt(
      currentAlgorithm,
      currentSelfOptimizing,
      n,
      clusterId,
    );
    const initialPrompt = promptHeader + directiveBlock + "\n\n" + agentPrompt;

    const mcpServers: McpServerEntry[] = [s3McpServer];
    if (currentBrowserAutomation) {
      mcpServers.push({
        name: "puppeteer",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-puppeteer"],
        env: [
          { name: "PUPPETEER_EXECUTABLE_PATH", value: "/usr/local/bin/chromium" },
          { name: "PUPPETEER_LAUNCH_OPTIONS", value: JSON.stringify({ headless: true, executablePath: "/usr/local/bin/chromium", args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }) },
          { name: "ALLOW_DANGEROUS", value: "true" },
        ],
      });
    }

    // Deploy MCP: provides deploy_request, deploy_status, deploy_cancel.
    // Available to all agents but only the observer/deployer should use it.
    const deployMcpScript = resolve(__dirname, "deployMcp.js");
    mcpServers.push({
      name: "aga-deploy",
      command: "node",
      args: [deployMcpScript],
      env: [
        { name: "AGA_BUCKET", value: config.bucket },
        { name: "AGA_REGION", value: config.region },
        { name: "AGA_CLUSTER_PREFIX", value: clusterId },
        { name: "AGA_AGENT_INDEX", value: String(n) },
        // The deploy MCP writes deployment records itself, so it needs to know
        // which deployed/ prefix they belong in. Without this it can only ever
        // write to the ungrouped environment/deployed/, which is wrong for
        // every Everforge group.
        { name: "AGA_EVERFORGE_GROUP", value: config.everforgeGroup ?? "" },
      ],
    });

    // Wall clock for the whole turn (spawn through close), recorded on the
    // cost line as durationMs so intervals can be set from measured cost.
    const iterationStartedAt = Date.now();

    const client = await KiroRunner.create({
      // EC2 default; on ECS the container entrypoint sets AGA_WORKSPACE
      // under the agent user's writable home.
      cwd: process.env.AGA_WORKSPACE ?? "/home/ec2-user/kiro-flock-workspace",
      model: currentModel,
      mcpServers,
    });

    // Correlate this iteration with its session file for the dashboard's
    // iteration dropdown. Best-effort: a failed write only degrades the
    // dropdown label to mtime-ordinal, never the iteration itself.
    // The `.lock` beside it says "this turn is running": the V2 harness wrote
    // one itself, the V3 harness keeps its sessions elsewhere
    // (`~/.kiro/sessions/<workspace hash>/<id>/messages.jsonl`) and writes no
    // lock, so the dashboard and the MCP read ours. Removed after the turn.
    const sessionsCliDir = resolve(process.env.HOME ?? "/home/ec2-user", ".kiro", "sessions", "cli");
    const lockPath = client.currentSessionId ? resolve(sessionsCliDir, `${client.currentSessionId}.lock`) : null;
    if (client.currentSessionId) {
      try {
        mkdirSync(sessionsCliDir, { recursive: true });
        writeFileSync(resolve(sessionsCliDir, `${client.currentSessionId}.iter`), String(iterationCounter));
        if (lockPath) writeFileSync(lockPath, String(process.pid));
      } catch (err: unknown) {
        console.error("iteration marker write failed:", err);
      }
    }

    // Arm the broadcast marker: the S3 MCP touches this file on every
    // successful append to our own journal. Its existence after the turn is
    // the primary broadcast signal — direct from the process that did the
    // write, immune to the journal's parseability.
    try { unlinkSync(broadcastMarkerPath); } catch { /* not present — fine */ }

    // ts-diff over the journal is kept only as a fallback (older MCP bundle
    // mid-rollover). It is known-unsound on its own: one unparseable line at
    // the journal tail made readLastEntry return a stale record, before/after
    // matched, and a completed, billed turn was labelled interrupted — 10 of
    // 11 observed labels in one run were exactly that.
    const entryBefore = await readLastEntry(s3, config.bucket, clusterId, n)
      .catch(() => null);

    // Captured before the turn runs: both the error marker and the cost entry
    // are keyed on it and must survive close().
    const sessionIdForCost = client.currentSessionId;

    let turnError: string | null = null;
    try {
      for await (const _chunk of client.prompt(initialPrompt)) {
        // stream: could log chunks here if needed
      }
      // A rejected `session/prompt` does not throw out of the generator — the
      // runner records it instead so this loop's close()/cost path stays
      // intact. Without reading it back, an errored turn was indistinguishable
      // from a clean one and the cause was lost.
      turnError = client.lastTurnError;
      if (turnError) {
        console.error(`iteration ${iterationCounter} turn failed: ${turnError}`);
      }
    } catch (err: unknown) {
      turnError = err instanceof Error ? err.message : String(err);
      console.error(`iteration ${iterationCounter} turn failed:`, err);
    } finally {
      await client.close();
      if (lockPath) { try { unlinkSync(lockPath); } catch { /* already gone */ } }
    }

    // Measured before the sidecar read below — its retry sleeps are not part
    // of the turn and would inflate the number by up to ~10s.
    const iterationDurationMs = Date.now() - iterationStartedAt;

    // Sidecar first: it is the completion oracle (kiro-cli writes metering at
    // clean turn end, 64–161ms before we can see it), so everything below —
    // the broadcast verdict, the label, the error capture — gets to consult
    // it. The old order fired the interrupted label ~10s before this read.
    const credits = sessionIdForCost
      ? await readSessionCreditsWithRetry(sessionIdForCost)
      : null;

    // Broadcast verdict: marker is authoritative, ts-diff is the fallback.
    const markerBroadcast = existsSync(broadcastMarkerPath);
    const entryAfter = await readLastEntry(s3, config.bucket, clusterId, n)
      .catch(() => null);
    const tsDiffBroadcast = entryAfter !== null && entryAfter.ts !== entryBefore?.ts;
    const broadcast = markerBroadcast || tsDiffBroadcast;

    if (!broadcast) {
      // kiro-cli's own log is where the cause is actually spelled out (the
      // JSON-RPC rejection is often one terse line). Read it on EVERY
      // no-broadcast turn — the old gate on turnError meant the dominant
      // failure class got no log capture at all.
      const cliLogTail = client.readLogTail();
      if (cliLogTail) {
        console.error(`iteration ${iterationCounter} kiro-cli log:\n${cliLogTail}`);
      }

      const rawReason = turnError
        ? `turn interrupted: ${turnError}`
        : credits !== null
          ? "turn completed and was metered, but no broadcast was detected — the agent finished without writing to its log"
          : "turn ended without a broadcast, and the model reported no error — cause unknown (check the agent console for kiro-cli output)";
      const fullReason = cliLogTail ? `${rawReason}\n\nkiro-cli log:\n${cliLogTail}` : rawReason;

      // The journal gets a classified one-liner ahead of the log tail: the
      // entry is read back by this agent, by every peer whose prompt embeds
      // it, and by the dashboard — none of which need the JSON-RPC wrapper.
      // Unclassifiable errors fall back to the raw line; the untruncated
      // record below (errors.ndjson) and the transcript marker keep the
      // original either way.
      const summary = turnError ? summariseTurnFailure(turnError, cliLogTail) : null;
      const journalReason = summary
        ? (cliLogTail
          ? `turn interrupted: ${summary}\n\nkiro-cli log:\n${cliLogTail}`
          : `turn interrupted: ${summary}`)
        : fullReason;

      await appendInterruptedEntry(
        s3, config.bucket, clusterId, n, iterationCounter, journalReason,
      );
      // Full, untruncated record to S3 beside the journal. The .error marker
      // below lives on the instance and is only seen if an operator opens the
      // iteration in the dashboard; this one is durable and greppable.
      try {
        await casAppendLine(
          s3, config.bucket, `${clusterId}/store/agent-${n}.errors.ndjson`,
          JSON.stringify({
            ts: new Date().toISOString(),
            iteration: iterationCounter,
            sessionId: sessionIdForCost ?? "",
            metered: credits !== null,
            error: fullReason.slice(0, 8000),
          }),
        );
      } catch (err: unknown) {
        console.error("error record write failed:", err);
      }
      if (sessionIdForCost) {
        writeTurnErrorMarker(sessionIdForCost, fullReason);
      }
    } else if (turnError && sessionIdForCost) {
      // Turn errored but the broadcast had already landed (observed with
      // empty-response errors arriving after the final write). Record the
      // error for the transcript, but no interrupted label — the work is done.
      writeTurnErrorMarker(sessionIdForCost, turnError);
    }
    client.cleanupLog();

    // Record this iteration's credit spend (read above, from the session
    // sidecar). Best-effort — cost tracking must never break the loop.
    if (sessionIdForCost) {
      try {
        if (credits !== null) {
          await appendCostEntry(s3, config.bucket, clusterId, n, {
            iteration: iterationCounter,
            sessionId: sessionIdForCost,
            credits,
            durationMs: iterationDurationMs,
          });
        } else {
          // An interrupted turn never completes, so kiro-cli records no
          // metering for it — the credits are genuinely unavailable, not
          // merely late. Write the iteration anyway, marked unmetered: it did
          // consume spend, and a silent skip made every total read as though
          // it were complete. Consumers estimate the missing value; nothing
          // fabricated is ever stored here.
          await appendUnmeteredCostEntry(s3, config.bucket, clusterId, n, {
            iteration: iterationCounter,
            sessionId: sessionIdForCost,
            durationMs: iterationDurationMs,
          });
          console.warn(
            `cost entry unmetered: no metering data in sidecar for session ${sessionIdForCost} (iteration ${iterationCounter})`,
          );
        }
      } catch (err: unknown) {
        console.error("cost entry write failed:", err);
      }
    }

    iterationCounter += 1;

    if (shutdown) break;

    // Iteration finished. Walk the unified state machine.

    // 1. Try to flip starting → running. We just produced our first log
    //    line (or did nothing if the direction was empty); either way
    //    the cluster is no longer in its "spinning up" phase from the
    //    operator's perspective. If state is anything else (operator
    //    paused or stopped during the first iteration), the If-Match
    //    write fails silently and we fall through to the normal handling.
    {
      const stateRead = await readState(s3, config.bucket, clusterId);
      if (stateRead.doc.state === "starting") {
        await writeStateConditional(
          s3, config.bucket, clusterId,
          "running", n, "first-iteration", stateRead.etag,
        );
      }
    }

    // 2. Autopause check — only meaningful while running. If every peer
    //    we can see (and ourselves) reported idle, increment the counter.
    //    On reaching the threshold, attempt to flip running → paused.
    //    Disabled when config.autopause is false.
    if (currentAutopause) {
      // Consensus by vote, not by exact string match on the newest line.
      // The old predicate (`everyoneVisible && action === "idle"`) had three
      // independent ways to wedge a converged cluster into running forever:
      // decorated idles ("idle - diagnosis complete") never matched, loop
      // labels counted as activity, and one agent with an unreadable journal
      // vetoed via `everyoneVisible` with no path to recovery. Measured cost
      // of that wedge on one run: 2,353 of 2,410 credits after convergence.
      const visibleIndexes = [n, ...currentNeighbours];
      const votes = await Promise.all(
        visibleIndexes.map((i) => peerIdleVote(s3, config.bucket, clusterId, i)),
      );
      const allIdle = votes.every((v) => v === "idle");
      if (allIdle) {
        consecutiveAllIdle += 1;
        console.log(`autopause: ${consecutiveAllIdle}/${AUTOPAUSE_THRESHOLD} idle iterations`);
        if (consecutiveAllIdle >= AUTOPAUSE_THRESHOLD) {
          const stateRead = await readState(s3, config.bucket, clusterId);
          if (stateRead.doc.state === "running") {
            const ok = await writeStateConditional(
              s3, config.bucket, clusterId,
              "paused", n, "autopause", stateRead.etag,
            );
            if (ok) {
              console.log("autopause: cluster -> paused");
              consecutiveAllIdle = 0;
            }
            // On precondition failure, another agent or operator already
            // changed state.json. Either way we'll see the new state on
            // the next read and behave accordingly.
          }
        }
      } else {
        consecutiveAllIdle = 0;
      }
    } else {
      consecutiveAllIdle = 0;
    }

    // Sleep between iterations using the most recently known interval.
    await sleep(currentIntervalSeconds * 1000);
    if (shutdown) break;

    // 3. Between-iteration state check. The cluster may have transitioned
    //    while we were running or sleeping. Treat each state appropriately:
    //
    //      paused   → slow-poll until it clears (resume / stop / stopped)
    //      stopping → break out so systemd can reap us
    //      stopped  → break out (same reason; reconcile already happened)
    //      running, starting → continue
    {
      let s = (await readState(s3, config.bucket, clusterId)).doc.state;
      if (s === "paused") {
        console.log("paused");
        while (!shutdown) {
          await sleep(PAUSE_POLL_INTERVAL_MS);
          if (shutdown) break;
          s = (await readState(s3, config.bucket, clusterId)).doc.state;
          if (s !== "paused") break;
        }
        if (shutdown) break;
        if (s === "stopping" || s === "stopped") {
          console.log(`exiting: cluster state ${s}`);
          break;
        }
        console.log("resumed");
        // Reset autopause counter so resume gets a fresh runway before
        // any new auto-trigger.
        consecutiveAllIdle = 0;
      } else if (s === "stopping" || s === "stopped") {
        console.log(`exiting: cluster state ${s}`);
        break;
      }
    }

    // 4. Reload the dynamic subset of config.json. Any field that fails
    //    validation keeps its previous value. `concurrency`, `computeType`,
    //    `instanceType` and `taskSize` are start-time-only and ignored here.
    const next = await readDynamicConfig(s3, config.bucket, clusterId, n);
    if (next.loopIntervalSeconds !== null) currentIntervalSeconds = next.loopIntervalSeconds;
    if (next.algorithm !== null) currentAlgorithm = next.algorithm;
    if (next.swarmK !== null) currentSwarmK = next.swarmK;
    if (next.neighbourRadius !== null) currentRadius = next.neighbourRadius;
    if (next.autopause !== null) currentAutopause = next.autopause;
    if (next.selfOptimizing !== null) currentSelfOptimizing = next.selfOptimizing;
    if (next.browserAutomation !== null) currentBrowserAutomation = next.browserAutomation;
    // `undefined` (not null) is the "keep previous" signal for model — see
    // DynamicConfig. The value is already resolved against this agent's
    // entry in the `models` override map. Log a switch so the journal
    // explains a mid-run change in behaviour or cost rate, and say which
    // source it came from so a per-agent pin is distinguishable from a
    // cluster-wide change.
    if (next.model !== undefined && next.model !== currentModel) {
      const label = (m: string | null) => m ?? "(kiro-cli default)";
      const source = next.modelIsOverride ? "per-agent override" : "cluster default";
      console.log(`model switched (${source}): ${label(currentModel)} -> ${label(next.model)}`);
      currentModel = next.model;
    }

    // 5. Re-select neighbours for the next iteration. amorphous + mesh are
    //    pure; swarm hits ListObjectsV2 once. The fall-back to amorphous
    //    when no logs exist is handled inside selectNeighbours.
    try {
      currentNeighbours = await selectNeighbours({
        algorithm: currentAlgorithm,
        agentIndex: config.agentIndex,
        concurrency: config.concurrency,
        neighbourRadius: currentRadius,
        swarmK: currentSwarmK,
        bucket: config.bucket,
        region: config.region,
        clusterId,
      });
    } catch (err: unknown) {
      console.error("neighbour selection failed, keeping previous list:", err);
    }
  }
}
