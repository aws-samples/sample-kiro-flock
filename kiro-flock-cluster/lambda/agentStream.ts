/**
 * Per-agent live stream tails via SSM — backend for the Kiro Node view.
 *
 * Serves GET /cluster/agent-stream/{clusterId}?agentIndex=N&kind=console|acp
 *
 * Ported from the MCP-side kiro-flock-mcp/src/acpReader.ts with the one
 * change that makes it dashboard-shaped (see stream-console-plan.md):
 * this TAILS, it never reads whole sessions. Every fetch is exactly ONE
 * SSM RunCommand:
 *
 *   kind=console → journalctl tail of the aga-agent systemd unit
 *                  (the agent loop's own logging: iteration boundaries,
 *                  autopause decisions, errors)
 *   kind=acp     → one shell script that locates the active session
 *                  (.lock sibling; falls back to the newest completed)
 *                  and tails the last ~22KB of its .jsonl, which the
 *                  Lambda formats to markdown
 *
 * 22000 bytes fits under SSM's 24000-char GetCommandInvocation stdout
 * cap, and a single command completes in 1–15s — comfortably inside the
 * 29s API Gateway budget. Full-session reads stay MCP-only.
 *
 * Security posture: commands are fixed templates built server-side.
 * Operator input (clusterId, agentIndex) is validated upstream and used
 * ONLY to resolve the instance id from the S3 snapshot — it is never
 * interpolated into the shell.
 */

import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { DescribeTasksCommand, ECSClient } from "@aws-sdk/client-ecs";
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from "@aws-sdk/client-cloudwatch-logs";
import { ecsExecCapture } from "./ecsExec";

/**
 * Where kiro-cli session files live per compute backend. EC2 agents run
 * as ec2-user (systemd unit); ECS containers run as the `agent` user
 * (docker/Dockerfile.agent).
 *
 * Two layouts are read. The V2 harness (kiro-cli 2.x) wrote
 * `sessions/cli/<id>.jsonl` with a `<id>.lock` while the turn ran. The V3
 * harness (kiro-cli 3.x) writes `sessions/<workspace hash>/<id>/messages.jsonl`
 * and no lock. The agent loop writes `cli/<id>.iter`, `cli/<id>.lock` and
 * `cli/<id>.error` in both cases, so the markers are always under `cli/` and
 * only the transcript moves. The shell below defines `locate ID` and `newest`
 * so the two layouts stay in one place.
 */
const SESSIONS_DIR_EC2 = "/home/ec2-user/.kiro/sessions";
const SESSIONS_DIR_ECS = "/home/agent/.kiro/sessions";
/** Shell functions shared by the session scripts. `locate ID` prints the
 *  transcript path for a session in either layout; `newest` prints the most
 *  recently modified transcript; `idof PATH` turns a path back into the id. */
const SESSION_SHELL_LIB = `
locate() { if [ -f "cli/$1.jsonl" ]; then echo "cli/$1.jsonl"; else for d in */; do [ "$d" = "cli/" ] && continue; [ -f "$d$1/messages.jsonl" ] && { echo "$d$1/messages.jsonl"; return; }; done; fi; }
newest() { ls -t cli/*.jsonl */*/messages.jsonl 2>/dev/null | grep -v '^cli/.*/messages.jsonl$' | head -n1; }
idof() { case "$1" in */messages.jsonl) b="\${1%/messages.jsonl}"; echo "\${b##*/}";; *) b="\${1%.jsonl}"; echo "\${b##*/}";; esac; }
`.trim();

/** Tail size for ACP session reads. Under SSM's 24000-char stdout cap. */
const ACP_TAIL_BYTES = 22000;

/** Console tail line count. ~300 lines of journal fits the same cap. */
const CONSOLE_TAIL_LINES = 300;

/** Total budget for one SSM command (send + poll). Well under APIGW 29s. */
const SSM_POLL_STEP_MS = 500;
const SSM_MAX_WAIT_MS = 20000;

const ssm = new SSMClient({});
const ecsClient = new ECSClient({});
const cwLogs = new CloudWatchLogsClient({});

export type StreamKind = "console" | "acp";

// ---- Runtime abstraction ---------------------------------------------------
// The snapshot's per-agent `instanceId` is an EC2 instance id on ec2
// compute and a task ARN on ecs compute. Everything below routes on that
// shape: shell reads go over SSM RunCommand (EC2) or ECS Exec (Fargate),
// and the console tail comes from journald (EC2) or CloudWatch Logs (ECS,
// where container stdout lands via the awslogs driver).

interface AgentRuntime {
  /** EC2 instance id or ECS task ARN, verbatim from the snapshot. */
  instanceId: string;
  isEcs: boolean;
}

function toRuntime(instanceId: string): AgentRuntime {
  return { instanceId, isEcs: /^arn:aws[a-z-]*:ecs:.*:task\//.test(instanceId) };
}

function sessionsDir(rt: AgentRuntime): string {
  return rt.isEcs ? SESSIONS_DIR_ECS : SESSIONS_DIR_EC2;
}

/** Run one fixed-template shell command on the agent's runtime and return
 *  its output. SSM RunCommand on EC2; ECS Exec on Fargate. */
/**
 * The runtime cannot be reached right now, for a reason the operator should
 * read as a state rather than a fault: the node is off, or its task is still
 * booting. The two public entry points turn it into `unavailable`.
 */
class RuntimeNotReady extends Error {}
/**
 * Before an ECS Exec call, ask ECS whether the task can take one. A stopped or
 * paused node still has its last task ARN in the snapshot, and ExecuteCommand
 * against it fails with "execute command was not enabled when the task was run
 * or the execute command agent isn't running", which reads like a broken
 * deployment. The same text comes back for the first 30-60 s of a new task,
 * until its ExecuteCommandAgent reports RUNNING.
 */
async function assertEcsExecReady(clusterArn: string, taskArn: string, containerName: string): Promise<void> {
  let task;
  try {
    task = (await ecsClient.send(new DescribeTasksCommand({ cluster: clusterArn, tasks: [taskArn] }))).tasks?.[0];
  } catch {
    return; // cannot tell: let the exec itself report
  }
  if (task === undefined) throw new RuntimeNotReady("This node is not running (its task no longer exists). Start or resume the cluster to see its stream.");
  const status = task.lastStatus ?? "UNKNOWN";
  if (status === "STOPPED" || status === "DEPROVISIONING" || status === "STOPPING" || task.desiredStatus === "STOPPED") {
    throw new RuntimeNotReady("This node is not running (its task has stopped). Start or resume the cluster to see its stream.");
  }
  if (status !== "RUNNING") {
    throw new RuntimeNotReady(`This node's task is still starting (${status.toLowerCase()}). The stream appears a minute or so after it boots.`);
  }
  const container = task.containers?.find((c) => c.name === containerName) ?? task.containers?.[0];
  const agent = container?.managedAgents?.find((a) => a.name === "ExecuteCommandAgent");
  if (agent !== undefined && agent.lastStatus !== "RUNNING") {
    throw new RuntimeNotReady("This node has just started; its console agent is not up yet. The stream appears in a few seconds.");
  }
}
async function remoteExec(rt: AgentRuntime, command: string): Promise<string> {
  if (!rt.isEcs) return ssmExec(rt.instanceId, command);
  const clusterArn = process.env.ECS_CLUSTER_ARN ?? "";
  const containerName = process.env.ECS_CONTAINER_NAME ?? "agent";
  if (!clusterArn) throw new Error("ECS_CLUSTER_ARN not configured — redeploy the stack");
  await assertEcsExecReady(clusterArn, rt.instanceId, containerName);
  return ecsExecCapture(ecsClient, {
    clusterArn,
    taskArn: rt.instanceId,
    containerName,
  }, command, SSM_MAX_WAIT_MS);
}

/**
 * Session id allowlist. kiro-cli names sessions with UUID-style ids; the
 * marker files reuse them. This is the ONE place operator input reaches a
 * shell template (quoted), so the pattern is deliberately strict:
 * alphanumerics, dash, underscore only — no dots, slashes, spaces, or
 * shell metacharacters.
 */
export const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** One entry in the iteration/session list for an agent. */
export interface AcpSessionInfo {
  sessionId: string;
  /** 0-based iteration number. From the `<sessionId>.iter` marker written
   *  by the agent loop when available; otherwise the mtime-ascending
   *  ordinal position (same thing unless an iteration crashed mid-way). */
  iteration: number;
  /** Whether the iteration number came from a marker file. */
  exact: boolean;
  mtime: number;          // epoch seconds
  sizeBytes: number;
  active: boolean;        // has a .lock sibling (in-progress iteration)
}

export interface SessionListResult {
  agentIndex: number;
  sessions: AcpSessionInfo[];   // sorted oldest → newest (iteration order)
  unavailable?: string;
  instanceId?: string;
  fetchedAt: string;
}

export interface StreamResult {
  agentIndex: number;
  kind: StreamKind;
  /** Markdown (acp) or plain text (console). Null when unavailable. */
  content: string | null;
  /** Populated instead of content when the tail can't be produced for a
   *  normal operational reason (stopped cluster, no session yet, …). */
  unavailable?: string;
  instanceId?: string;
  /** acp only */
  sessionId?: string;
  sessionStatus?: "active" | "completed";
  sessionSizeBytes?: number;
  /** acp only. Reason this iteration's turn ended abnormally, from the
   *  `<sessionId>.error` sidecar the agent loop writes. Also appended to
   *  `content`, so the operator sees it at the end of the transcript; exposed
   *  separately so the UI can style or badge it without re-parsing. */
  turnError?: string;
  fetchedAt: string;
}

/** Sentinel separating the session tail from the turn error in the acp
 *  script's stdout. Must match TURN_ERROR_MARKER in agent/agentLoop.ts, which
 *  strips it from the message before writing so it cannot appear in the text. */
const TURN_ERROR_MARKER = "---TURNERROR---";

/** Split the acp script's stream section into the raw session tail and the
 *  turn error. Emitted after the `tail`, so the tail's byte cap cannot eat it. */
function splitTurnError(streamSection: string): { raw: string; turnError?: string } {
  const idx = streamSection.lastIndexOf(`\n${TURN_ERROR_MARKER}\n`);
  if (idx < 0) return { raw: streamSection };
  const err = streamSection.slice(idx + TURN_ERROR_MARKER.length + 2).trim();
  return {
    raw: streamSection.slice(0, idx),
    turnError: err.length > 0 ? err : undefined,
  };
}

/** Append the cause to the end of the rendered transcript. An interrupted
 *  iteration otherwise ends on kiro-cli's bare "Tool uses were interrupted,
 *  waiting for the next user prompt", which states that the turn stopped but
 *  never why.
 *
 *  Headed "interrupted" rather than "failed": the iteration did real work
 *  before being cut off — the transcript above this block is that work. What
 *  is missing is a completed turn. */
function appendTurnError(markdown: string, turnError?: string): string {
  if (!turnError) return markdown;
  const block = `\n\n---\n\n**Iteration interrupted**\n\n${turnError}\n`;
  return markdown.length > 0 ? `${markdown}${block}` : block.trimStart();
}

/**
 * Resolve the EC2 instance id for an agent from the cluster snapshot.
 * Returns a string error message instead of throwing for the "normal"
 * cases (stopped cluster, agent not launched) so the route can answer
 * 200 + unavailable rather than a 5xx.
 */
async function resolveInstanceId(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<{ instanceId: string } | { unavailable: string }> {
  const key = `${clusterId}/store/cluster-snapshot.json`;
  let body: string | undefined;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    body = await res.Body?.transformToString("utf-8");
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") {
      return { unavailable: "No cluster snapshot yet — has this cluster ever been started?" };
    }
    throw err;
  }
  if (!body) return { unavailable: "Cluster snapshot is empty." };

  const snapshot = JSON.parse(body) as {
    agents?: Array<{ agentId: string; instanceId: string | null; instanceState?: string }>;
  };
  const agents = snapshot.agents ?? [];
  if (agents.length === 0) {
    return { unavailable: "Cluster snapshot has no agents. Is the cluster running?" };
  }

  const targetId = `agent-${agentIndex}`;
  const agent = agents.find((a) => a.agentId === targetId);
  if (!agent) {
    return {
      unavailable: `${targetId} not found in the snapshot. Available: ${agents.map((a) => a.agentId).join(", ")}`,
    };
  }
  if (!agent.instanceId) {
    return { unavailable: `${targetId} has no instance — it may be stopped or not yet launched.` };
  }
  return { instanceId: agent.instanceId };
}

/**
 * Run one shell command on an instance via SSM and return stdout.
 * Fixed command templates only — never interpolate operator input.
 */
async function ssmExec(instanceId: string, command: string): Promise<string> {
  const sendRes = await ssm.send(new SendCommandCommand({
    InstanceIds: [instanceId],
    DocumentName: "AWS-RunShellScript",
    Parameters: { commands: [command] },
    TimeoutSeconds: 30,
  }));

  const commandId = sendRes.Command?.CommandId;
  if (!commandId) throw new Error("SSM SendCommand returned no CommandId");

  const deadline = Date.now() + SSM_MAX_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, SSM_POLL_STEP_MS));
    try {
      const invocation = await ssm.send(new GetCommandInvocationCommand({
        CommandId: commandId,
        InstanceId: instanceId,
      }));
      const status = invocation.Status;
      if (status === "Success") {
        return invocation.StandardOutputContent ?? "";
      }
      if (status === "Failed" || status === "Cancelled" || status === "TimedOut") {
        const stderr = invocation.StandardErrorContent ?? "";
        throw new Error(`SSM command ${status}: ${stderr.slice(0, 500)}`);
      }
      // Pending / InProgress / Delayed — keep polling.
    } catch (err: unknown) {
      // The invocation record can lag SendCommand by a moment.
      if (err instanceof Error && err.name === "InvocationDoesNotExist") continue;
      throw err;
    }
  }
  throw new Error(`SSM command timed out after ${SSM_MAX_WAIT_MS / 1000}s`);
}

/**
 * Console tail for an ECS agent: read the task's awslogs stream from
 * CloudWatch Logs. Stream name is `{streamPrefix}/{containerName}/{taskId}`
 * per the awslogs driver convention; prefix and container are fixed by
 * the CDK task definition, the task id is the ARN's last path segment.
 */
async function fetchEcsConsoleTail(taskArn: string): Promise<string> {
  const logGroup = process.env.AGENT_LOG_GROUP ?? "";
  if (!logGroup) throw new Error("AGENT_LOG_GROUP not configured — redeploy the stack");
  const containerName = process.env.ECS_CONTAINER_NAME ?? "agent";
  const taskId = taskArn.split("/").pop() ?? "";
  const streamName = `aga-agent/${containerName}/${taskId}`;
  try {
    const res = await cwLogs.send(new GetLogEventsCommand({
      logGroupName: logGroup,
      logStreamName: streamName,
      limit: CONSOLE_TAIL_LINES,
      startFromHead: false,
    }));
    const lines = (res.events ?? []).map((e) => {
      const ts = e.timestamp ? new Date(e.timestamp).toISOString().replace(/\.\d{3}Z$/, "") : "";
      return ts ? `${ts} ${e.message ?? ""}` : (e.message ?? "");
    });
    return lines.join("\n").slice(-ACP_TAIL_BYTES);
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "ResourceNotFoundException") return "";
    throw err;
  }
}

/**
 * List an agent's ACP session files as iterations — backend for the
 * Kiro Node iteration dropdown. One SSM RunCommand: enumerate *.jsonl
 * in the sessions dir (mtime ascending = iteration order, since the dir
 * starts empty at instance launch and each iteration creates exactly one
 * session), join each with its `<sessionId>.iter` marker when present.
 *
 * Iteration numbering: markers win when they're complete and unique
 * (they survive out-of-order mtimes); any gap or duplicate (older agent
 * code, mid-iteration crash + systemd restart resetting the counter)
 * degrades the WHOLE list to mtime ordinals rather than mixing schemes.
 */
export async function listAgentSessions(...args: Parameters<typeof listAgentSessionsInner>): ReturnType<typeof listAgentSessionsInner> {
  try {
    return await listAgentSessionsInner(...args);
  } catch (err: unknown) {
    if (err instanceof RuntimeNotReady) {
      return { agentIndex: args[3], sessions: [], fetchedAt: new Date().toISOString(), unavailable: err.message };
    }
    throw err;
  }
}
async function listAgentSessionsInner(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
): Promise<SessionListResult> {
  const base: SessionListResult = {
    agentIndex,
    sessions: [],
    fetchedAt: new Date().toISOString(),
  };

  const resolved = await resolveInstanceId(s3, bucket, clusterId, agentIndex);
  if ("unavailable" in resolved) {
    return { ...base, unavailable: resolved.unavailable };
  }
  const { instanceId } = resolved;
  const rt = toRuntime(instanceId);

  // Oldest-first so the `| tail -c` overflow guard drops the OLDEST
  // iterations, never the newest. ~60 bytes/line keeps hundreds of
  // iterations under the SSM stdout cap anyway.
  const script = `
cd ${sessionsDir(rt)} 2>/dev/null || { echo "META:NO_DIR"; exit 0; }
${SESSION_SHELL_LIB}
ACTIVE=""
for lock in cli/*.lock; do
  [ -f "$lock" ] || continue
  ACTIVE=$(idof "\${lock%.lock}.jsonl")
  break
done
ls -tr cli/*.jsonl */*/messages.jsonl 2>/dev/null | grep -v '^cli/.*/messages.jsonl$' | while read -r f; do
  ID=$(idof "$f")
  SIZE=$(stat -c%s "$f" 2>/dev/null || echo 0)
  MTIME=$(stat -c%Y "$f" 2>/dev/null || echo 0)
  ITER=""
  [ -f "cli/$ID.iter" ] && ITER=$(cat "cli/$ID.iter" 2>/dev/null)
  ACT=0
  [ "$ID" = "$ACTIVE" ] && ACT=1
  echo "S:$ID:$ITER:$MTIME:$SIZE:$ACT"
done | tail -c ${ACP_TAIL_BYTES}
`.trim();

  const out = await remoteExec(rt, script);
  if (out.startsWith("META:NO_DIR")) {
    return { ...base, instanceId, unavailable: "No sessions directory on the agent runtime yet — the agent may not have started its first iteration." };
  }

  const parsed: Array<Omit<AcpSessionInfo, "iteration" | "exact"> & { marker: number | null }> = [];
  for (const line of out.split("\n")) {
    const m = /^S:([A-Za-z0-9_-]+):(\d*):(\d+):(\d+):([01])$/.exec(line.trim());
    if (!m) continue; // partial line at the tail cut, or noise
    parsed.push({
      sessionId: m[1],
      marker: m[2] === "" ? null : parseInt(m[2], 10),
      mtime: parseInt(m[3], 10),
      sizeBytes: parseInt(m[4], 10),
      active: m[5] === "1",
    });
  }
  if (parsed.length === 0) {
    return { ...base, instanceId, unavailable: "No ACP session files yet — the agent may not have started its first iteration." };
  }

  // Iteration numbering is decided PER ROW. This used to be all-or-nothing:
  // one missing or duplicated marker anywhere demoted the entire list to mtime
  // ordinals, and because the dashboard gates its cost lookup on `exact`, a
  // single bad marker also hid the recorded cost of every other iteration in
  // the list. A row keeps its marker when that marker is present and unique;
  // only the ambiguous rows fall back to their ordinal position.
  const markerCounts = new Map<number, number>();
  for (const p of parsed) {
    if (p.marker !== null) markerCounts.set(p.marker, (markerCounts.get(p.marker) ?? 0) + 1);
  }

  const sessions: AcpSessionInfo[] = parsed.map((p, i) => {
    const usable = p.marker !== null && markerCounts.get(p.marker) === 1;
    return {
      sessionId: p.sessionId,
      iteration: usable ? (p.marker as number) : i,
      exact: usable,
      mtime: p.mtime,
      sizeBytes: p.sizeBytes,
      active: p.active,
    };
  });
  sessions.sort((a, b) => a.iteration - b.iteration);

  return { ...base, instanceId, sessions };
}

/**
 * Fetch the tail for one agent. The single public entry point.
 *
 * `sessionId` (acp only): tail that specific session instead of the
 * active/newest one — the iteration dropdown's "view a past iteration".
 * Must already match SESSION_ID_RE (the route validates; we re-check
 * here because the value is quoted into the shell template).
 */
export async function fetchAgentStream(...args: Parameters<typeof fetchAgentStreamInner>): ReturnType<typeof fetchAgentStreamInner> {
  try {
    return await fetchAgentStreamInner(...args);
  } catch (err: unknown) {
    if (err instanceof RuntimeNotReady) {
      return { agentIndex: args[3], kind: args[4], content: null, fetchedAt: new Date().toISOString(), unavailable: err.message };
    }
    throw err;
  }
}
async function fetchAgentStreamInner(
  s3: S3Client,
  bucket: string,
  clusterId: string,
  agentIndex: number,
  kind: StreamKind,
  sessionId?: string,
): Promise<StreamResult> {
  const base: StreamResult = {
    agentIndex,
    kind,
    content: null,
    fetchedAt: new Date().toISOString(),
  };

  const resolved = await resolveInstanceId(s3, bucket, clusterId, agentIndex);
  if ("unavailable" in resolved) {
    return { ...base, unavailable: resolved.unavailable };
  }
  const { instanceId } = resolved;
  const rt = toRuntime(instanceId);

  if (kind === "console") {
    // EC2: the agent loop logs to journald via the systemd unit.
    // ECS: container stdout/stderr lands in CloudWatch Logs through the
    // awslogs driver — same content, different transport.
    if (rt.isEcs) {
      const out = await fetchEcsConsoleTail(rt.instanceId);
      return {
        ...base,
        instanceId,
        content: out.length > 0 ? out : null,
        unavailable: out.length > 0 ? undefined : "No container logs yet — the agent task may still be starting.",
      };
    }
    const out = await ssmExec(
      instanceId,
      `journalctl -u aga-agent.service -n ${CONSOLE_TAIL_LINES} --no-pager --output=short-iso 2>&1 | tail -c ${ACP_TAIL_BYTES}`,
    );
    return {
      ...base,
      instanceId,
      content: out.length > 0 ? out : null,
      unavailable: out.length > 0 ? undefined : "journal is empty — the agent service may not have started yet.",
    };
  }

  // kind === "acp" with an explicit sessionId: tail exactly that session
  // file. sessionId is allowlist-validated (route + here) before being
  // quoted into the fixed template — the only sanctioned exception to
  // the "never interpolate operator input" rule in this module.
  if (sessionId !== undefined) {
    if (!SESSION_ID_RE.test(sessionId)) {
      return { ...base, instanceId, unavailable: "Invalid session id." };
    }
    const targetScript = `
cd ${sessionsDir(rt)} 2>/dev/null || { echo "META:NO_DIR"; exit 0; }
${SESSION_SHELL_LIB}
TARGET="${sessionId}"
FILE=$(locate "$TARGET")
if [ -z "$FILE" ]; then echo "META:NO_SESSION"; exit 0; fi
STATUS="completed"
[ -f "cli/$TARGET.lock" ] && STATUS="active"
SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
echo "META:$TARGET:$STATUS:$SIZE"
echo "---STREAM---"
tail -c ${ACP_TAIL_BYTES} "$FILE"
printf '\\n%s\\n' "${TURN_ERROR_MARKER}"
[ -f "cli/$TARGET.error" ] && cat "cli/$TARGET.error"
exit 0
`.trim();

    const out = await remoteExec(rt, targetScript);
    const firstLine = out.split("\n", 1)[0] ?? "";
    if (firstLine.startsWith("META:NO_DIR")) {
      return { ...base, instanceId, unavailable: "No sessions directory on the agent runtime yet." };
    }
    if (firstLine.startsWith("META:NO_SESSION")) {
      return { ...base, instanceId, unavailable: `Session ${sessionId} no longer exists on the agent runtime.` };
    }
    const metaMatch = /^META:(.+):(active|completed):(\d+)$/.exec(firstLine);
    const marker = "\n---STREAM---\n";
    const markerIdx = out.indexOf(marker);
    const streamSection = markerIdx >= 0 ? out.slice(markerIdx + marker.length) : "";
    const { raw, turnError } = splitTurnError(streamSection);
    const formatted = appendTurnError(formatSessionTail(raw), turnError);
    return {
      ...base,
      instanceId,
      content: formatted.length > 0 ? formatted : null,
      unavailable: formatted.length > 0 ? undefined : "Session file is empty.",
      sessionId: metaMatch ? metaMatch[1] : sessionId,
      sessionStatus: metaMatch ? (metaMatch[2] as "active" | "completed") : undefined,
      sessionSizeBytes: metaMatch ? parseInt(metaMatch[3], 10) : undefined,
      turnError,
    };
  }

  // kind === "acp": one script locates the session AND tails it, so the
  // whole fetch stays a single SSM round trip. Active session = the one
  // with a .lock sibling; fall back to the newest .jsonl when the agent
  // is between iterations.
  const script = `
cd ${sessionsDir(rt)} 2>/dev/null || { echo "META:NO_DIR"; exit 0; }
${SESSION_SHELL_LIB}
ACTIVE=""
for lock in cli/*.lock; do
  [ -f "$lock" ] || continue
  ACTIVE=$(idof "\${lock%.lock}.jsonl")
  break
done
TARGET=""
FILE=""
STATUS=""
if [ -n "$ACTIVE" ]; then FILE=$(locate "$ACTIVE"); fi
if [ -n "$FILE" ]; then
  TARGET="$ACTIVE"
  STATUS="active"
else
  FILE=$(newest)
  [ -n "$FILE" ] && TARGET=$(idof "$FILE")
  STATUS="completed"
fi
if [ -z "$TARGET" ]; then echo "META:NO_SESSION"; exit 0; fi
SIZE=$(stat -c%s "$FILE" 2>/dev/null || echo 0)
echo "META:$TARGET:$STATUS:$SIZE"
echo "---STREAM---"
tail -c ${ACP_TAIL_BYTES} "$FILE"
printf '\\n%s\\n' "${TURN_ERROR_MARKER}"
[ -f "cli/$TARGET.error" ] && cat "cli/$TARGET.error"
exit 0
`.trim();

  const out = await remoteExec(rt, script);

  const firstLine = out.split("\n", 1)[0] ?? "";
  if (firstLine.startsWith("META:NO_DIR")) {
    return { ...base, instanceId, unavailable: "No sessions directory on the agent runtime yet — the agent may not have started its first iteration." };
  }
  if (firstLine.startsWith("META:NO_SESSION")) {
    return { ...base, instanceId, unavailable: "No ACP session files yet — the agent may not have started its first iteration." };
  }

  const metaMatch = /^META:(.+):(active|completed):(\d+)$/.exec(firstLine);
  const marker = "\n---STREAM---\n";
  const markerIdx = out.indexOf(marker);
  const streamSection = markerIdx >= 0 ? out.slice(markerIdx + marker.length) : "";
  // Same split as the pinned-session branch above. Missing it here meant the
  // marker and error text were handed to formatSessionTail, which drops
  // non-JSON lines — so an interruption was visible only after pinning the
  // iteration, never while following live.
  const { raw, turnError } = splitTurnError(streamSection);

  const formatted = appendTurnError(formatSessionTail(raw), turnError);
  return {
    ...base,
    instanceId,
    content: formatted.length > 0 ? formatted : null,
    unavailable: formatted.length > 0 ? undefined : "Session file is empty so far.",
    sessionId: metaMatch ? metaMatch[1] : undefined,
    sessionStatus: metaMatch ? (metaMatch[2] as "active" | "completed") : undefined,
    sessionSizeBytes: metaMatch ? parseInt(metaMatch[3], 10) : undefined,
    turnError,
  };
}

// ── ACP JSONL → markdown formatting ──────────────────────────────────────────
// Ported from kiro-flock-mcp/src/acpReader.ts. Because this formats a
// byte tail, the first line is usually a partial JSON object —
// parseJsonl silently drops malformed lines, which is exactly the
// behaviour we want at the cut point.

const MAX_PROMPT_LINES = 120;
const MAX_TOOL_RESULT_LINES = 50;

interface JournalEntry {
  version: string;
  kind: string;
  data: Record<string, unknown>;
}

function formatSessionTail(raw: string): string {
  const entries = parseJsonl(raw);
  return formatEntries(entries).join("\n").trim();
}

function parseJsonl(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.kind && parsed.data) entries.push(parsed);
      else if (parsed.payload && typeof parsed.payload.type === "string") {
        const mapped = fromV3Record(parsed.payload as Record<string, unknown>);
        if (mapped) entries.push(mapped);
      }
    } catch {
      // Skip malformed lines (expected at the tail cut boundary).
    }
  }
  return entries;
}
/**
 * The V3 harness writes `{id, timestamp, payload: {type, ...}}` records into
 * `messages.jsonl`. The four that carry the conversation are mapped onto the
 * V2 journal shapes so one formatter serves both; the rest (session metadata,
 * turn boundaries, pending interactions, usage) say nothing an operator reads.
 */
function fromV3Record(payload: Record<string, unknown>): JournalEntry | null {
  const text = (v: unknown): string =>
    typeof v === "string" ? v
      : Array.isArray(v) ? v.map((c) => (typeof c === "string" ? c : typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("")
        : v === undefined || v === null ? "" : JSON.stringify(v, null, 2);
  switch (payload.type) {
    case "user":
      return { version: "v3", kind: "Prompt", data: { content: [{ kind: "text", data: text(payload.content) }] } };
    case "assistant": {
      const body = text(payload.content);
      if (!body.trim()) return null;
      const reasoning = payload.operationType === "Reasoning";
      return { version: "v3", kind: "AssistantMessage", data: { content: [{ kind: "text", data: reasoning ? `_${body.trim()}_` : body }] } };
    }
    case "tool_call":
      return {
        version: "v3",
        kind: "AssistantMessage",
        data: { content: [{ kind: "toolUse", data: { name: payload.toolName ?? "unknown", input: payload.args ?? {} } }] },
      };
    case "tool_result":
      return {
        version: "v3",
        kind: "ToolResults",
        data: { content: [{ kind: "toolResult", data: { content: [{ kind: "text", data: text(payload.content) }] } }] },
      };
    default:
      return null;
  }
}

function formatEntries(entries: JournalEntry[]): string[] {
  const lines: string[] = [];

  for (const entry of entries) {
    switch (entry.kind) {
      case "Prompt": {
        lines.push("### Prompt\n");
        const content = extractTextContent(entry.data);
        const promptLines = content.split("\n");
        if (promptLines.length > MAX_PROMPT_LINES) {
          lines.push(promptLines.slice(0, MAX_PROMPT_LINES).join("\n"));
          lines.push(`\n> ... prompt truncated (${promptLines.length - MAX_PROMPT_LINES} more lines) ...\n`);
        } else {
          lines.push(content);
        }
        lines.push("");
        break;
      }

      case "AssistantMessage": {
        const content = entry.data.content as Array<Record<string, unknown>> | undefined;
        if (!content) break;

        for (const block of content) {
          if (block.kind === "text") {
            const text = (block.data as string) ?? "";
            if (text.trim()) {
              lines.push("### Agent Response\n");
              lines.push(text.trim());
              lines.push("");
            }
          } else if (block.kind === "toolUse") {
            const tool = block.data as Record<string, unknown>;
            const toolName = (tool.name as string) ?? "unknown";
            const input = (tool.input as Record<string, unknown>) ?? {};
            lines.push(`### Tool Call: ${toolName}\n`);
            lines.push("```json");
            const inputStr = JSON.stringify(input, null, 2);
            if (inputStr.length > 2000) {
              lines.push(inputStr.slice(0, 2000) + "\n... (truncated)");
            } else {
              lines.push(inputStr);
            }
            lines.push("```\n");
          }
        }
        break;
      }

      case "ToolResults": {
        const content = entry.data.content as Array<Record<string, unknown>> | undefined;
        if (!content) break;

        for (const block of content) {
          if (block.kind === "toolResult") {
            const resultData = block.data as Record<string, unknown>;
            const innerContent = resultData.content as Array<Record<string, unknown>> | undefined;
            if (!innerContent) continue;

            lines.push("### Tool Result\n");
            for (const item of innerContent) {
              let text = "";
              if (item.kind === "text") {
                text = (item.data as string) ?? "";
              } else if (item.kind === "json") {
                text = JSON.stringify(item.data, null, 2);
              }
              const resultLines = text.split("\n");
              if (resultLines.length > MAX_TOOL_RESULT_LINES) {
                lines.push("```");
                lines.push(resultLines.slice(0, MAX_TOOL_RESULT_LINES).join("\n"));
                lines.push(`... (${resultLines.length - MAX_TOOL_RESULT_LINES} more lines)`);
                lines.push("```\n");
              } else if (text.length > 3000) {
                lines.push("```");
                lines.push(text.slice(0, 3000) + "\n... (truncated)");
                lines.push("```\n");
              } else {
                lines.push("```");
                lines.push(text);
                lines.push("```\n");
              }
            }
          }
        }
        break;
      }
    }
  }

  return lines;
}

function extractTextContent(data: Record<string, unknown>): string {
  const content = data.content as Array<Record<string, unknown>> | undefined;
  if (!content) return "";
  return content
    .filter((c) => c.kind === "text")
    .map((c) => c.data as string)
    .join("\n");
}
