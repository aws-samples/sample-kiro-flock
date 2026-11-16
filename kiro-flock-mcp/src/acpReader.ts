/**
 * Reads ACP session transcripts from running agent EC2 instances via SSM.
 *
 * Session files live under ~/.kiro/sessions on each runtime: `cli/<id>.jsonl`
 * (kiro-cli 2.x) or `<workspace hash>/<id>/messages.jsonl` (kiro-cli 3.x). The
 * agent loop writes `cli/<id>.lock` while a turn runs, in both cases.
 *
 * JSONL format per line:
 *   { version: "v1", kind: "Prompt"|"AssistantMessage"|"ToolResults", data: {...} }
 *
 * Strategy:
 *   1. Read cluster snapshot from S3 to get instance ID for the agent index
 *   2. SSM RunCommand to find session files (active .lock + most recent completed)
 *   3. Read full session content via chunked parallel SSM calls
 *   4. Parse and format as readable markdown
 *
 * SSM stdout is capped at 24KB per GetCommandInvocation. To read full
 * sessions (300-550KB), we issue parallel SSM commands each reading a
 * 22KB chunk via `dd`, then concatenate the results.
 */

import {
  SSMClient,
  SendCommandCommand,
  GetCommandInvocationCommand,
} from "@aws-sdk/client-ssm";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { ECSClient } from "@aws-sdk/client-ecs";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { ecsExecCapture } from "./ecsExec.js";

/** Session dirs per compute backend: EC2 agents run as ec2-user, ECS
 *  containers as the `agent` user (docker/Dockerfile.agent). */
const SESSIONS_DIR_EC2 = "/home/ec2-user/.kiro/sessions";
const SESSIONS_DIR_ECS = "/home/agent/.kiro/sessions";
/** Two layouts: the V2 harness wrote `cli/<id>.jsonl`, the V3 harness writes
 *  `<workspace hash>/<id>/messages.jsonl`. The agent loop keeps the `.lock`,
 *  `.iter` and `.error` markers under `cli/` for both. Same functions as in
 *  kiro-flock-cluster/lambda/agentStream.ts. */
const SESSION_SHELL_LIB = `
locate() { if [ -f "cli/$1.jsonl" ]; then echo "cli/$1.jsonl"; else for d in */; do [ "$d" = "cli/" ] && continue; [ -f "$d$1/messages.jsonl" ] && { echo "$d$1/messages.jsonl"; return; }; done; fi; }
idof() { case "$1" in */messages.jsonl) b="\${1%/messages.jsonl}"; echo "\${b##*/}";; *) b="\${1%.jsonl}"; echo "\${b##*/}";; esac; }
`.trim();

/** The snapshot's instanceId is a task ARN on ecs compute. */
function isEcsRuntime(instanceId: string): boolean {
  return /^arn:aws[a-z-]*:ecs:.*:task\//.test(instanceId);
}

function sessionsDirFor(instanceId: string): string {
  return isEcsRuntime(instanceId) ? SESSIONS_DIR_ECS : SESSIONS_DIR_EC2;
}

/**
 * Bytes per chunk. SSM returns up to 24000 chars of stdout via
 * GetCommandInvocation. We use raw byte reads so 22000 is safe.
 */
const CHUNK_SIZE = 22000;

/** Max concurrent SSM commands when chunking a large file. */
const MAX_PARALLEL = 10;

interface SessionInfo {
  sessionId: string;
  isActive: boolean;
  sizeBytes: number;
  /** Transcript path relative to the sessions root, in whichever layout it was found. */
  file: string;
}

export class AcpReader {
  private ssm: SSMClient | null = null;
  private ecs: ECSClient | null = null;
  private s3: S3Client | null = null;
  private bucket: string | null = null;
  private region: string;

  constructor() {
    this.region = process.env.FLOCK_S3_REGION ?? process.env.AWS_DEFAULT_REGION ?? "eu-central-1";
  }

  private getS3(): { s3: S3Client; bucket: string } {
    if (this.s3 && this.bucket) return { s3: this.s3, bucket: this.bucket };
    const bucket = process.env.FLOCK_S3_BUCKET;
    if (!bucket) throw new Error("FLOCK_S3_BUCKET must be set.");
    this.bucket = bucket;
    this.s3 = new S3Client({ region: this.region, credentials: fromNodeProviderChain() });
    return { s3: this.s3, bucket: this.bucket };
  }

  private getSSM(): SSMClient {
    if (this.ssm) return this.ssm;
    this.ssm = new SSMClient({ region: this.region, credentials: fromNodeProviderChain() });
    return this.ssm;
  }

  private getECS(): ECSClient {
    if (this.ecs) return this.ecs;
    this.ecs = new ECSClient({ region: this.region, credentials: fromNodeProviderChain() });
    return this.ecs;
  }

  /**
   * Run a shell command on the agent's runtime and return its output.
   * EC2 instance ids go over SSM RunCommand; ECS task ARNs go over an
   * ECS Exec session (Fargate tasks aren't SSM managed instances).
   */
  private async remoteExec(instanceId: string, command: string): Promise<string> {
    if (!isEcsRuntime(instanceId)) return this.ssmExec(instanceId, command);
    const clusterArn = process.env.FLOCK_ECS_CLUSTER_ARN;
    if (!clusterArn) {
      throw new Error(
        "FLOCK_ECS_CLUSTER_ARN is not set — re-run setup.sh to refresh the MCP env with the ECS cluster ARN.",
      );
    }
    return ecsExecCapture(this.getECS(), {
      clusterArn,
      taskArn: instanceId,
      containerName: process.env.FLOCK_ECS_CONTAINER ?? "agent",
    }, command);
  }

  /**
   * Get the instance ID for a given agent index from the cluster snapshot.
   */
  private async getInstanceId(clusterId: string, agentIndex: number): Promise<string> {
    const { s3, bucket } = this.getS3();
    const key = `${clusterId}/store/cluster-snapshot.json`;
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString("utf-8");
    if (!body) throw new Error(`Cluster snapshot not found at ${key}`);

    const snapshot = JSON.parse(body);
    const agents = snapshot.agents as Array<{ agentId: string; instanceId: string | null }>;
    if (!agents || agents.length === 0) {
      throw new Error("Cluster snapshot has no agents. Is the cluster running?");
    }

    const targetId = `agent-${agentIndex}`;
    const agent = agents.find(a => a.agentId === targetId);
    if (!agent) {
      throw new Error(
        `Agent ${targetId} not found in snapshot. Available: ${agents.map(a => a.agentId).join(", ")}`
      );
    }
    if (!agent.instanceId) {
      throw new Error(`Agent ${targetId} has no instance ID. It may be stopped or not yet launched.`);
    }
    return agent.instanceId;
  }

  /**
   * Run a shell command on an instance via SSM and return stdout.
   */
  private async ssmExec(instanceId: string, command: string): Promise<string> {
    const ssm = this.getSSM();

    const sendRes = await ssm.send(new SendCommandCommand({
      InstanceIds: [instanceId],
      DocumentName: "AWS-RunShellScript",
      Parameters: { commands: [command] },
      TimeoutSeconds: 30,
    }));

    const commandId = sendRes.Command?.CommandId;
    if (!commandId) throw new Error("SSM SendCommand returned no CommandId");

    // Poll for completion
    let attempts = 0;
    const maxAttempts = 15;
    while (attempts < maxAttempts) {
      attempts++;
      await new Promise<void>(r => setTimeout(r, 1000));

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
          throw new Error(`SSM command ${status}: ${stderr}`);
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "InvocationDoesNotExist") continue;
        throw err;
      }
    }

    throw new Error(`SSM command timed out after ${maxAttempts}s`);
  }

  /**
   * Find session files on the instance: active (has .lock) and all completed,
   * sorted newest first.
   */
  private async findSessions(instanceId: string): Promise<SessionInfo[]> {
    const script = `
cd ${sessionsDirFor(instanceId)} 2>/dev/null || { echo "NO_DIR"; exit 0; }
${SESSION_SHELL_LIB}
ACTIVE=""
for lock in cli/*.lock; do
  [ -f "$lock" ] || continue
  ACTIVE=$(idof "\${lock%.lock}.jsonl")
  break
done
echo "ACTIVE=$ACTIVE"
ls -t cli/*.jsonl */*/messages.jsonl 2>/dev/null | grep -v '^cli/.*/messages.jsonl$' | while read -r f; do
  SID=$(idof "$f")
  SIZE=$(stat -c%s "$f" 2>/dev/null || echo 0)
  if [ "$SID" = "$ACTIVE" ]; then
    echo "SESSION:$SID:active:$SIZE:$f"
  else
    echo "SESSION:$SID:completed:$SIZE:$f"
  fi
done
`.trim();

    const output = await this.remoteExec(instanceId, script);
    if (output.trim() === "NO_DIR") return [];

    const sessions: SessionInfo[] = [];

    for (const line of output.split("\n")) {
      if (line.startsWith("SESSION:")) {
        const parts = line.split(":");
        if (parts.length >= 5) {
          sessions.push({
            sessionId: parts[1],
            isActive: parts[2] === "active",
            sizeBytes: parseInt(parts[3], 10) || 0,
            file: parts.slice(4).join(":"),
          });
        }
      }
    }

    return sessions;
  }

  /**
   * Read a full session file by issuing parallel chunked SSM reads.
   * Each chunk reads CHUNK_SIZE bytes via `dd`.
   */
  private async readSessionFull(instanceId: string, session: SessionInfo): Promise<string> {
    const sizeBytes = session.sizeBytes;
    // `file` came from our own listing script (an `ls` under the sessions
    // root), not from the operator; still, only plain relative paths are used.
    if (!/^[A-Za-z0-9_./-]+$/.test(session.file) || session.file.includes("..")) return "";
    const filePath = `${sessionsDirFor(instanceId)}/${session.file}`;

    // If file fits in one chunk, read directly
    if (sizeBytes <= CHUNK_SIZE) {
      return this.remoteExec(instanceId, `cat "${filePath}"`);
    }

    // Calculate chunks needed
    const numChunks = Math.ceil(sizeBytes / CHUNK_SIZE);
    const chunks: (string | null)[] = new Array(numChunks).fill(null);

    // Read chunks in parallel batches
    for (let batchStart = 0; batchStart < numChunks; batchStart += MAX_PARALLEL) {
      const batchEnd = Math.min(batchStart + MAX_PARALLEL, numChunks);
      const promises: Promise<void>[] = [];

      for (let i = batchStart; i < batchEnd; i++) {
        const offset = i * CHUNK_SIZE;
        // dd: skip=offset bytes, read count bytes
        const cmd = `dd if="${filePath}" bs=1 skip=${offset} count=${CHUNK_SIZE} 2>/dev/null`;
        const idx = i;
        promises.push(
          this.remoteExec(instanceId, cmd).then(output => {
            chunks[idx] = output;
          })
        );
      }

      await Promise.all(promises);
    }

    return chunks.join("");
  }

  /**
   * List available sessions for an agent (lightweight, no content read).
   */
  async listSessions(clusterId: string, agentIndex: number): Promise<{
    instanceId: string;
    sessions: Array<{ sessionId: string; status: string; sizeBytes: number; sizeHuman: string; offset: number }>;
  }> {
    const cid = clusterId || "cluster_0";
    const instanceId = await this.getInstanceId(cid, agentIndex);
    const allSessions = await this.findSessions(instanceId);

    const active = allSessions.find(s => s.isActive);
    const completed = allSessions.filter(s => !s.isActive);

    const sessions = allSessions.map(s => {
      const offset = s.isActive ? -1 : completed.indexOf(s);
      return {
        sessionId: s.sessionId,
        status: s.isActive ? "active (in-progress)" : "completed",
        sizeBytes: s.sizeBytes,
        sizeHuman: formatBytes(s.sizeBytes),
        offset,
      };
    });

    return { instanceId, sessions };
  }

  /**
   * Main entry point: read ACP sessions for a given agent.
   * @param offset How many completed sessions to skip back (0 = most recent)
   */
  async readAgentSessions(clusterId: string, agentIndex: number, offset: number = 0): Promise<string> {
    const cid = clusterId || "cluster_0";
    const instanceId = await this.getInstanceId(cid, agentIndex);

    const allSessions = await this.findSessions(instanceId);
    if (allSessions.length === 0) {
      return `No ACP sessions found on agent-${agentIndex} (instance ${instanceId}). The agent may not have started its first iteration yet.`;
    }

    const active = allSessions.find(s => s.isActive);
    const completed = allSessions.filter(s => !s.isActive);

    // Pick the completed session at the requested offset
    if (offset >= completed.length) {
      return `Offset ${offset} exceeds available completed sessions (${completed.length} available, indices 0-${completed.length - 1}).`;
    }

    const parts: string[] = [];

    // Always show active if present and offset is 0
    if (active && offset === 0) {
      const raw = await this.readSessionFull(instanceId, active);
      const formatted = formatSession(raw);
      parts.push(`## Current Iteration (in progress)\n\n_Session: ${active.sessionId} (${formatBytes(active.sizeBytes)})_\n\n${formatted}`);
    }

    // Show the completed session at the requested offset
    const target = completed[offset];
    if (target) {
      const iterLabel = offset === 0 ? "Previous Iteration (completed)" : `Iteration at offset -${offset + 1} (completed)`;
      const raw = await this.readSessionFull(instanceId, target);
      const formatted = formatSession(raw);
      parts.push(`## ${iterLabel}\n\n_Session: ${target.sessionId} (${formatBytes(target.sizeBytes)})_\n\n${formatted}`);
    }

    return parts.join("\n\n---\n\n");
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

const MAX_PROMPT_LINES = 200;
const MAX_TOOL_RESULT_LINES = 50;

interface JournalEntry {
  version: string;
  kind: string;
  data: Record<string, unknown>;
}

function formatSession(raw: string): string {
  const entries = parseJsonl(raw);
  return formatEntries(entries).join("\n");
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
      // Skip malformed lines (can happen at chunk boundaries)
    }
  }
  return entries;
}
/** V3 `messages.jsonl` records mapped onto the V2 journal shapes, as in agentStream.ts. */
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
      return { version: "v3", kind: "AssistantMessage", data: { content: [{ kind: "toolUse", data: { name: payload.toolName ?? "unknown", input: payload.args ?? {} } }] } };
    case "tool_result":
      return { version: "v3", kind: "ToolResults", data: { content: [{ kind: "toolResult", data: { content: [{ kind: "text", data: text(payload.content) }] } }] } };
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
            const toolName = tool.name as string ?? "unknown";
            const input = tool.input as Record<string, unknown> ?? {};
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
                text = item.data as string ?? "";
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
    .filter(c => c.kind === "text")
    .map(c => c.data as string)
    .join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
