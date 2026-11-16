/**
 * ECS Exec one-shot command capture.
 *
 * Fargate tasks are not SSM managed instances, so SSM RunCommand can't
 * reach them. ECS Exec can: it embeds an SSM Session Manager agent in the
 * task, and `ExecuteCommand` opens a Session Manager session whose output
 * flows over an ssmmessages websocket. This module speaks just enough of
 * the Session Manager binary protocol to run ONE non-interactive command
 * and capture its stdout/stderr — the ECS equivalent of agentStream's
 * `ssmExec` (SendCommand + GetCommandInvocation).
 *
 * Protocol (verified against aws/session-manager-plugin mainline):
 *   1. ExecuteCommand returns { streamUrl, tokenValue }.
 *   2. Client connects to streamUrl and sends the token as a JSON text
 *      frame: { MessageSchemaVersion:"1.0", RequestId:<uuid>, TokenValue }.
 *   3. Binary AgentMessages flow both ways. 120-byte header:
 *        HL(4) | MessageType(32, space-padded) | Ver(4) | CreatedDate(8) |
 *        Seq(8) | Flags(8) | MessageId(16, halves swapped) | Digest(32) |
 *        PayloadType(4) | PayloadLength(4) | Payload
 *   4. The agent opens with a handshake_request (output_stream_data,
 *      PayloadType 5). The client MUST reply with a handshake response
 *      (input_stream_data, PayloadType 6) or the agent never starts the
 *      command. The agent then sends handshake_complete (PayloadType 7).
 *   5. Command output arrives as output_stream_data with PayloadType 1
 *      (stdout) / 11 (stderr). Every stream message must be acknowledged
 *      ("acknowledge" message, Flags 3) or the agent re-sends it.
 *   6. When the command exits, the session ends with channel_closed.
 *
 * Shared between lambda/agentStream.ts (dashboard live tails) and the
 * operator-side kiro-flock-mcp acpReader (full session reads). Keep the
 * two copies in sync — see kiro-flock-mcp/src/ecsExec.ts.
 */
import { randomUUID, createHash } from "node:crypto";
import { ECSClient, ExecuteCommandCommand } from "@aws-sdk/client-ecs";
import WebSocket from "ws";

// ---- AgentMessage constants (session-manager-plugin clientmessage.go) ----
const HL_OFFSET = 0;
const MSG_TYPE_OFFSET = 4;
const MSG_TYPE_LENGTH = 32;
const SCHEMA_VERSION_OFFSET = 36;
const CREATED_DATE_OFFSET = 40;
const SEQUENCE_OFFSET = 48;
const FLAGS_OFFSET = 56;
const MESSAGE_ID_OFFSET = 64;
const DIGEST_OFFSET = 80;
const PAYLOAD_TYPE_OFFSET = 112;
const PAYLOAD_LENGTH_OFFSET = 116;
const PAYLOAD_OFFSET = 120;
const HEADER_LENGTH = 116; // = PAYLOAD_LENGTH_OFFSET, per SerializeClientMessage

const OUTPUT_STREAM = "output_stream_data";
const INPUT_STREAM = "input_stream_data";
const ACKNOWLEDGE = "acknowledge";
const CHANNEL_CLOSED = "channel_closed";

const PAYLOAD_OUTPUT = 1;
const PAYLOAD_HANDSHAKE_REQUEST = 5;
const PAYLOAD_HANDSHAKE_RESPONSE = 6;
const PAYLOAD_HANDSHAKE_COMPLETE = 7;
const PAYLOAD_STDERR = 11;
const PAYLOAD_EXIT_CODE = 12;

interface ParsedMessage {
  messageType: string;
  sequenceNumber: bigint;
  /** Hyphenated UUID string, byte order already unswapped. */
  messageId: string;
  payloadType: number;
  payload: Buffer;
}

function parseAgentMessage(buf: Buffer): ParsedMessage | null {
  if (buf.length < PAYLOAD_OFFSET) return null;
  const headerLength = buf.readUInt32BE(HL_OFFSET);
  const messageType = buf
    .subarray(MSG_TYPE_OFFSET, MSG_TYPE_OFFSET + MSG_TYPE_LENGTH)
    .toString("utf8")
    .replace(/\0/g, "")
    .trim();
  const sequenceNumber = buf.readBigInt64BE(SEQUENCE_OFFSET);
  // MessageId wire order: least-significant 8 bytes first, then
  // most-significant 8 (putUuid in the plugin). Unswap for the ack JSON.
  const msb = buf.subarray(MESSAGE_ID_OFFSET + 8, MESSAGE_ID_OFFSET + 16);
  const lsb = buf.subarray(MESSAGE_ID_OFFSET, MESSAGE_ID_OFFSET + 8);
  const uuidHex = Buffer.concat([msb, lsb]).toString("hex");
  const messageId = `${uuidHex.slice(0, 8)}-${uuidHex.slice(8, 12)}-${uuidHex.slice(12, 16)}-${uuidHex.slice(16, 20)}-${uuidHex.slice(20)}`;
  const payloadType = buf.readUInt32BE(PAYLOAD_TYPE_OFFSET);
  // Payload begins after headerLength + the 4-byte payload-length field
  // (DeserializeClientMessage: input[headerLength+PayloadLengthLength:]).
  const payload = buf.subarray(headerLength + 4);
  return { messageType, sequenceNumber, messageId, payloadType, payload };
}

function buildAgentMessage(
  messageType: string,
  payloadType: number,
  payload: Buffer,
  sequenceNumber: bigint,
  flags: bigint,
): Buffer {
  const buf = Buffer.alloc(PAYLOAD_OFFSET + payload.length);
  buf.writeUInt32BE(HEADER_LENGTH, HL_OFFSET);
  buf.fill(" ", MSG_TYPE_OFFSET, MSG_TYPE_OFFSET + MSG_TYPE_LENGTH);
  buf.write(messageType, MSG_TYPE_OFFSET, "utf8");
  buf.writeUInt32BE(1, SCHEMA_VERSION_OFFSET);
  buf.writeBigUInt64BE(BigInt(Date.now()), CREATED_DATE_OFFSET);
  buf.writeBigInt64BE(sequenceNumber, SEQUENCE_OFFSET);
  buf.writeBigUInt64BE(flags, FLAGS_OFFSET);
  // MessageId halves swapped on the wire, mirroring putUuid.
  const uuidBytes = uuidToBytes(randomUUID());
  uuidBytes.subarray(8, 16).copy(buf, MESSAGE_ID_OFFSET);
  uuidBytes.subarray(0, 8).copy(buf, MESSAGE_ID_OFFSET + 8);
  createHash("sha256").update(payload).digest().copy(buf, DIGEST_OFFSET);
  buf.writeUInt32BE(payloadType, PAYLOAD_TYPE_OFFSET);
  buf.writeUInt32BE(payload.length, PAYLOAD_LENGTH_OFFSET);
  payload.copy(buf, PAYLOAD_OFFSET);
  return buf;
}

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ""), "hex");
}

export interface EcsExecTarget {
  clusterArn: string;
  taskArn: string;
  containerName: string;
}

/**
 * Run one shell command inside a task container via ECS Exec and return
 * its combined stdout+stderr. Rejects on session failure or timeout.
 * Command templates are fixed server-side — same security posture as
 * ssmExec (operator input never reaches the shell unvalidated).
 */
export async function ecsExecCapture(
  ecs: ECSClient,
  target: EcsExecTarget,
  command: string,
  timeoutMs = 20000,
): Promise<string> {
  const res = await ecs.send(new ExecuteCommandCommand({
    cluster: target.clusterArn,
    task: target.taskArn,
    container: target.containerName,
    interactive: true, // the only supported mode
    command: `/bin/sh -c ${shellQuote(command)}`,
  }));
  const streamUrl = res.session?.streamUrl;
  const tokenValue = res.session?.tokenValue;
  if (!streamUrl || !tokenValue) {
    throw new Error("ExecuteCommand returned no session stream");
  }

  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const seenSequences = new Set<string>();
    let settled = false;
    const ws = new WebSocket(streamUrl);

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      // ECS Exec runs the command under a PTY, which translates \n to
      // \r\n on output (ONLCR). Normalize back so callers' line-based
      // parsing (META lines, ---STREAM--- markers, S: records) behaves
      // identically to SSM RunCommand's verbatim pipe capture.
      else resolve(Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n"));
    };

    const timer = setTimeout(() => {
      // Return what we have on timeout if any output arrived — a slow
      // tail is more useful than an error for a live view.
      if (chunks.length > 0) finish();
      else finish(new Error(`ECS Exec session timed out after ${timeoutMs / 1000}s with no output`));
    }, timeoutMs);

    ws.on("open", () => {
      ws.send(JSON.stringify({
        MessageSchemaVersion: "1.0",
        RequestId: randomUUID(),
        TokenValue: tokenValue,
      }));
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      const msg = parseAgentMessage(buf);
      if (!msg) return;

      if (msg.messageType === OUTPUT_STREAM) {
        // Ack everything (agent re-sends unacked messages).
        ws.send(buildAgentMessage(
          ACKNOWLEDGE,
          0,
          Buffer.from(JSON.stringify({
            AcknowledgedMessageType: OUTPUT_STREAM,
            AcknowledgedMessageId: msg.messageId,
            AcknowledgedMessageSequenceNumber: Number(msg.sequenceNumber),
            IsSequentialMessage: true,
          })),
          0n,
          3n,
        ));

        if (msg.payloadType === PAYLOAD_HANDSHAKE_REQUEST) {
          // Agree to everything the agent asked for — for ECS Exec
          // command sessions the only action is SessionType.
          let actions: Array<{ ActionType: string }> = [];
          try {
            const req = JSON.parse(msg.payload.toString("utf8")) as {
              RequestedClientActions?: Array<{ ActionType: string }>;
            };
            actions = req.RequestedClientActions ?? [];
          } catch { /* malformed handshake — respond with no actions */ }
          const response = {
            ClientVersion: "1.2.0.0",
            ProcessedClientActions: actions.map(a => ({
              ActionType: a.ActionType,
              ActionStatus: 1, // Success
            })),
            Errors: [],
          };
          ws.send(buildAgentMessage(
            INPUT_STREAM,
            PAYLOAD_HANDSHAKE_RESPONSE,
            Buffer.from(JSON.stringify(response)),
            0n,
            3n,
          ));
          return;
        }
        if (msg.payloadType === PAYLOAD_HANDSHAKE_COMPLETE) return;
        if (msg.payloadType === PAYLOAD_OUTPUT || msg.payloadType === PAYLOAD_STDERR) {
          // De-dupe on sequence number: the agent re-sends messages whose
          // ack it hasn't processed yet.
          const seqKey = `${msg.payloadType}:${msg.sequenceNumber}`;
          if (seenSequences.has(seqKey)) return;
          seenSequences.add(seqKey);
          chunks.push(msg.payload);
          return;
        }
        if (msg.payloadType === PAYLOAD_EXIT_CODE) return;
        return;
      }

      if (msg.messageType === CHANNEL_CLOSED) {
        finish();
        return;
      }
      // acknowledge / start_publication / pause_publication — ignore.
    });

    ws.on("close", () => finish());
    ws.on("error", (err: Error) => finish(new Error(`ECS Exec stream error: ${err.message}`)));
  });
}

/** Single-quote a string for /bin/sh -c. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
