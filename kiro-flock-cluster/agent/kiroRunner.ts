/**
 * ACP client — spawns `kiro-cli acp` as a subprocess and communicates over
 * NDJSON/stdio using the Agent Client Protocol SDK.
 *
 * The main flow:
 *   1. create()  — spawn kiro-cli, wire up streams, establish an ACP session
 *   2. prompt()  — send a prompt, yield streaming updates as an async generator
 *   3. close()   — cancel the session and kill the subprocess
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import type * as acp from "@agentclientprotocol/sdk";

// Re-export the chunk type for consumers.
export type SessionUpdateChunk = acp.SessionUpdate;

/** MCP server entry — matches the ACP SDK McpServerStdio shape. */
export interface McpServerEntry {
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

export class KiroRunner {
  private proc: ChildProcess;
  private conn!: import("@agentclientprotocol/sdk").ClientSideConnection;
  private sessionId: string | null = null;

  // Async channel: sessionUpdate callbacks push here, prompt() yields from here.
  // updateResolve is a wakeup signal — set by prompt()'s wait loop, called by
  // sessionUpdate to unblock the generator when new data arrives.
  private updateQueue: acp.SessionUpdate[] = [];
  private updateResolve: (() => void) | null = null;
  private turnDone = false;
  /** Reason the last turn ended abnormally, or null when it completed.
   *  Set from the `session/prompt` rejection, which used to be swallowed:
   *  prompt() then returned as if the turn had finished, close() cancelled
   *  a session whose turn was still live, and the operator saw only
   *  "Tool uses were interrupted" with no cause recorded anywhere. */
  private turnError: string | null = null;
  /** Path kiro-cli was told to write its chat log to (KIRO_CHAT_LOG_FILE). */
  private logPath: string | null = null;
  private nextPermId = 0;

  /** Resolves when the kiro-cli child process exits, whenever that happens.
   *
   *  A turn is only ever woken by a `sessionUpdate` notification or by the
   *  `session/prompt` promise settling. Neither occurs when the CLI dies or
   *  wedges mid-turn, so the generator's wait had no way to learn the process
   *  behind it was gone and the agent's iteration blocked indefinitely —
   *  observed live: an MCP server crashed mid-tool-call, kiro-cli sat waiting
   *  on a tool result that could never arrive, and two agents stalled for over
   *  an hour with no error recorded anywhere the operator could see it.
   *
   *  This is a second wakeup source, event-driven rather than timed: it fires
   *  on actual process exit, so it cannot cut a healthy long-running turn
   *  short no matter how long that turn legitimately takes. */
  private childExited!: Promise<void>;
  private resolveChildExited!: () => void;
  /** Set when the child exited with a turn still in flight (or with a turn
   *  error already recorded). Kept separate from `turnError` so the two are
   *  order-independent: the ACP SDK's transport-close rejection and the
   *  process `exit` event race, and each on its own tells only half the story
   *  — "ACP connection closed" names the symptom without saying the CLI died,
   *  while the exit code alone omits what the connection reported. */
  private childExitDetail: string | null = null;

  /**
   * Called when the agent requests tool permission.
   * If unset, permissions are auto-approved (allow_once preferred).
   */
  onPermissionRequest?: (
    permissionId: string,
    toolCall: Record<string, unknown>,
    options: Array<{ optionId: string; kind: string }>
  ) => Promise<string>;

  /** Called when the agent advertises available tools. */
  onToolsAvailable?: (
    tools: Array<{ name: string; source: string; description: string }>
  ) => void;

  private constructor(proc: ChildProcess) {
    this.proc = proc;
    this.childExited = new Promise<void>((resolve) => { this.resolveChildExited = resolve; });
  }

  /** Child process exited. Ends any turn still believed to be in flight and
   *  wakes its waiter, so the caller's `for await` drains and the agent loop
   *  reaches its existing failure handling (interrupted journal entry,
   *  errors.ndjson record, unmetered cost line) instead of hanging.
   *
   *  A reason is only recorded when the turn had not already ended: a CLI that
   *  exits normally after a completed turn is not a failure, and labelling it
   *  one would put a false `iteration-interrupted` on a turn whose work landed. */
  private noteChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.resolveChildExited();

    // A turn that had already ended cleanly is not a failure: close() SIGTERMs
    // the CLI on every normal iteration, and recording that as an error would
    // put a false `iteration-interrupted` on work that landed. Only an exit
    // that interrupted a live turn, or one accompanying an error already
    // recorded, is worth reporting.
    if (this.turnDone && !this.turnError) return;
    if (this.childExitDetail) return; // exit/close both fired — idempotent

    const how = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
    this.childExitDetail =
      `kiro-cli exited before the turn completed (${how}), so this turn produced ` +
      `no result. A crashed MCP server is the usual cause; check the [kiro-cli] ` +
      `stderr lines in the agent console.`;

    if (!this.turnDone) {
      this.turnDone = true;
      this.updateResolve?.();
      this.updateResolve = null;
    }
  }

  /**
   * The ACP session id assigned by kiro-cli at newSession time. The CLI
   * names its session journal `<sessionId>.jsonl`, so this is the handle
   * the agent loop uses to correlate iterations with session files.
   */
  get currentSessionId(): string | null {
    return this.sessionId;
  }

  // ---------------------------------------------------------------------------
  // Factory — spawns kiro-cli and sets up the ACP connection
  // ---------------------------------------------------------------------------

  static async create(opts: {
    agentProfile?: string;
    model?: string | null;
    cwd: string;
    mcpServers?: McpServerEntry[];
  }): Promise<KiroRunner> {
    // Dynamic import because the ACP SDK is ESM-only and this project
    // compiles to CommonJS. A top-level import would fail at runtime.
    const acpSdk = await import("@agentclientprotocol/sdk");

    // Only forward a known set of env vars to the subprocess.
    // AWS_* vars are forwarded for credential chain, KIRO_API_KEY for auth.
    const env: Record<string, string> = {};
    for (const key of [
      "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "NODE_ENV", "SSH_AUTH_SOCK",
    ]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    env.NO_COLOR = "1";
    env.FORCE_COLOR = "0";
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AWS_")) env[key] = process.env[key]!;
    }
    if (process.env.KIRO_API_KEY) env.KIRO_API_KEY = process.env.KIRO_API_KEY;

    // kiro-cli writes its own diagnostics to a LOG FILE, not stderr
    // (docs: kiro.dev/docs/cli/acp — $XDG_RUNTIME_DIR/kiro-log/kiro-chat.log on
    // Linux, overridable via KIRO_CHAT_LOG_FILE). XDG_RUNTIME_DIR is not in the
    // env allowlist above and is unset in the agent container, so by default
    // that log had nowhere to go — the CLI's account of why a turn died was
    // being discarded before anyone could read it. Pin it to a known path per
    // runner so the loop can attach the tail to a failed iteration.
    const logPath = `/tmp/kiro-chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.log`;
    env.KIRO_CHAT_LOG_FILE = logPath;
    // info, not debug: debug on a 12-minute turn produces tens of MB and we
    // only need the error-level lines that explain a failure.
    env.KIRO_LOG_LEVEL = process.env.KIRO_LOG_LEVEL ?? "info";

    // The V3 harness, named explicitly. On kiro-cli 3.x a bare `acp` picks
    // V3 unless a V2-only flag (`--model`, `--agent`) is on the line, which
    // made the harness depend on whether a model was pinned. V3 rejects those
    // flags: the model is set after `session/new` with set_config_option, and
    // the agent profile (unused by the flock, kept for the type) would be a
    // session mode. V2 is frozen and receives no fixes.
    const args = ["acp", "--agent-engine=v3"];
    if (opts.agentProfile) {
      console.error(`[kiro-cli] agentProfile "${opts.agentProfile}" ignored: V3 selects agents per session, not on the launch line`);
    }

    // Detached + unref so the parent process can exit without waiting for
    // kiro-cli. close() sends SIGTERM for clean shutdown.
    const proc = spawn("kiro-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: opts.cwd,
      detached: true,
    });
    proc.unref();
    // Forward kiro-cli's stderr to our own, which lands in journald (EC2) or
    // CloudWatch Logs (ECS) and so reaches the Kiro Node console pane. This
    // channel carries the CLI's own retry/backoff/throttle messages: draining
    // it into a no-op (as this did previously) also has to be avoided purely
    // for backpressure, but discarding it left interrupted iterations with no
    // recorded cause anywhere. Line-buffered so a chunk split mid-line does
    // not produce interleaved garbage.
    {
      let errBuf = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        errBuf += chunk.toString("utf-8");
        const lines = errBuf.split("\n");
        errBuf = lines.pop() ?? "";
        for (const line of lines) {
          if (line.trim()) console.error(`[kiro-cli] ${line}`);
        }
        // Guard against a pathological single line growing without bound.
        if (errBuf.length > 64_000) {
          console.error(`[kiro-cli] ${errBuf}`);
          errBuf = "";
        }
      });
      proc.stderr?.on("end", () => {
        if (errBuf.trim()) console.error(`[kiro-cli] ${errBuf}`);
        errBuf = "";
      });
    }

    const client = new KiroRunner(proc);
    client.logPath = logPath;
    // Both events are wired: `exit` fires when the process ends, `close` when
    // its stdio streams are all released. Whichever lands first ends the turn;
    // noteChildExit is idempotent, so the second is a no-op.
    proc.on("exit", (code, signal) => client.noteChildExit(code, signal));
    proc.on("close", (code, signal) => client.noteChildExit(code, signal));
    const stdin = proc.stdin!;
    const stdout = proc.stdout!;

    // --- Writable side: serialize outgoing ACP messages to kiro-cli stdin ---
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        return new Promise<void>((resolve, reject) => {
          if (stdin.destroyed) return reject(new Error("stdin destroyed"));
          stdin.write(chunk, (err) => (err ? reject(err) : resolve()));
        });
      },
      close() { stdin.end(); },
    });

    // --- Readable side: parse incoming NDJSON from kiro-cli stdout ---
    // Accumulates a buffer and splits on newlines. Partial lines are held
    // until the next chunk arrives. Non-JSON lines are silently skipped.
    let buffer = "";
    const decoder = new TextDecoder();
    let ctrl!: ReadableStreamDefaultController<acp.AnyMessage>;
    const readable = new ReadableStream<acp.AnyMessage>({
      start(c) { ctrl = c; },
      cancel() { stdout.destroy(); },
    });

    stdout.on("data", (chunk: Buffer) => {
      buffer += decoder.decode(new Uint8Array(chunk), { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { ctrl.enqueue(JSON.parse(trimmed)); } catch { /* skip non-JSON */ }
      }
    });
    stdout.on("end", () => {
      if (buffer.trim()) {
        try { ctrl.enqueue(JSON.parse(buffer.trim())); } catch { /* skip */ }
      }
      try { ctrl.close(); } catch { /* already closed */ }
    });
    stdout.on("error", (err) => { try { ctrl.error(err); } catch { /* ignore */ } });

    // Combine into an ACP stream. ndJsonStream handles serialization on the
    // writable side; we use our manual readable for deserialization.
    const dummyReadable = new ReadableStream<Uint8Array>({ start() {} });
    const ndJson = acpSdk.ndJsonStream(writable, dummyReadable);
    const stream: acp.Stream = { readable, writable: ndJson.writable };

    // --- ACP Client implementation ---
    // sessionUpdate: pushes into the async channel for prompt() to yield.
    // requestPermission: auto-approves unless onPermissionRequest is set.
    const clientImpl: acp.Client = {
      async sessionUpdate(params: acp.SessionNotification): Promise<void> {
        client.updateQueue.push(params.update);
        client.updateResolve?.();
        client.updateResolve = null;
      },

      // Kiro extension notifications (_kiro.dev/*). The SDK's inbound
      // notification dispatch falls through to `extNotification` ON THE
      // CLIENT IMPLEMENTATION for any non-standard method — implementing
      // it here is the supported hook. (An earlier version patched
      // extNotification on the ClientSideConnection instance, but that's
      // the OUTBOUND sender: inbound _kiro.dev/* notifications never hit
      // it and fell through to the SDK's -32601 "Method not found"
      // default, flooding journald with "Error handling notification".)
      // Unknown extension methods (e.g. _kiro.dev/metadata) are accepted
      // and ignored — never throw, or the SDK logs the error.
      async extNotification(method: string, params: unknown): Promise<void> {
        if (!params || typeof params !== "object") return;
        const p = params as Record<string, unknown>;
        if (method === "_kiro.dev/session/update" && "update" in p) {
          const upd = p as unknown as { sessionId: string; update: acp.SessionUpdate };
          client.updateQueue.push(upd.update);
          client.updateResolve?.();
          client.updateResolve = null;
        } else if (method === "_kiro.dev/commands/available" && Array.isArray(p.tools)) {
          client.onToolsAvailable?.(
            p.tools as Array<{ name: string; source: string; description: string }>
          );
        }
        // Everything else is accepted and ignored. The `_kiro.dev/*` names
        // above are the V2 server's; V3 sends standard `session/update` types
        // (handled in sessionUpdate) and `_kiro/*` snapshots such as
        // `_kiro/mcp/status`, none of which the loop needs.
      },

      async requestPermission(
        params: acp.RequestPermissionRequest
      ): Promise<acp.RequestPermissionResponse> {
        const toolCall = params.toolCall as Record<string, unknown>;
        const options = params.options;

        if (client.onPermissionRequest) {
          const mappedOptions = options.map((o) => ({
            optionId: o.optionId,
            kind: o.kind,
          }));
          try {
            const chosenId = await client.onPermissionRequest(
              `perm-${++client.nextPermId}`, toolCall, mappedOptions
            );
            return { outcome: { outcome: "selected", optionId: chosenId } };
          } catch {
            // Fallback to auto-approve below
          }
        }
        // Auto-approve: prefer allow_once, then allow_always. The old third
        // fallback was `options[0]` — blind, and ACP option kinds include
        // reject_once/reject_always, so when the CLI offered no allow option
        // we could actively answer "reject". And with an empty options array
        // it crashed on `.optionId`, which the SDK surfaces to the CLI as a
        // JSON-RPC error on its permission request. Both read on the CLI side
        // as "Tool use was cancelled by the user" followed by an interrupted
        // turn — a self-inflicted cancellation with no trace of why.
        const approve = options.find((o) => o.kind === "allow_once")
          ?? options.find((o) => o.kind === "allow_always");
        if (approve) {
          return { outcome: { outcome: "selected", optionId: approve.optionId } };
        }
        // No allow option offered. Answer "cancelled" (valid per the protocol)
        // rather than crashing or silently picking a reject, and say so loudly
        // — this lands in the console pane and names the tool.
        const toolName = typeof toolCall.title === "string" ? toolCall.title
          : typeof toolCall.kind === "string" ? toolCall.kind : "unknown tool";
        console.error(
          `permission request for ${toolName} offered no allow option `
          + `(options: ${options.map((o) => o.kind).join(", ") || "none"}) — responding cancelled`,
        );
        return { outcome: { outcome: "cancelled" } };
      },
    };

    client.conn = new acpSdk.ClientSideConnection(() => clientImpl, stream);

    // Handshake: initialize the ACP protocol, then create a session with
    // the requested MCP servers attached.
    await client.conn.initialize({
      protocolVersion: acpSdk.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    const result = await client.conn.newSession({
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []) as unknown as acp.McpServerStdio[],
    });
    client.sessionId = result.sessionId;
    // Model pin, V3 style: a config option on the open session. `null` and
    // undefined both mean "kiro-cli's default", so nothing is sent. A model id
    // the harness does not know is rejected here, before the first turn, with
    // the CLI's own message rather than a silent fallback.
    if (opts.model) {
      await client.conn.setSessionConfigOption({
        sessionId: result.sessionId,
        configId: "model",
        value: opts.model,
      });
    }

    return client;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Send a prompt and yield streaming updates as they arrive.
   * Returns when the agent's turn is complete.
   */
  async *prompt(text: string): AsyncGenerator<SessionUpdateChunk> {
    if (!this.sessionId) throw new Error("No active session");

    this.turnDone = false;
    this.turnError = null;
    this.updateQueue = [];

    // Fire the prompt. The promise resolves when the turn ends.
    const promptDone = this.conn
      .prompt({
        sessionId: this.sessionId,
        prompt: [{ type: "text" as const, text }],
      })
      .then(() => {
        this.turnDone = true;
        this.updateResolve?.();
      })
      .catch((err: unknown) => {
        // Record the reason rather than discarding it. We deliberately do
        // NOT rethrow: the caller's `for await` loop and its finally/close()
        // path stay exactly as they were, and the loop reads lastTurnError
        // afterwards. Rethrowing here would work too, but would change the
        // control flow of every consumer for no benefit.
        this.turnError = describeTurnError(err);
        this.turnDone = true;
        this.updateResolve?.();
      });

    // Yield updates as they arrive, sleeping when the queue is empty.
    while (true) {
      while (this.updateQueue.length > 0) {
        yield this.updateQueue.shift()!;
      }
      if (this.turnDone) break;
      await new Promise<void>((resolve) => {
        this.updateResolve = resolve;
        // Re-check AFTER registering the resolver. A wakeup that fires between
        // the check above and this assignment would call a null resolver and be
        // lost, parking the generator forever on state that had already
        // changed — the exact failure this child-exit path exists to prevent.
        if (this.turnDone || this.updateQueue.length > 0) {
          this.updateResolve = null;
          resolve();
        }
      });
    }

    // Drain any updates that arrived between the last yield and turnDone.
    while (this.updateQueue.length > 0) {
      yield this.updateQueue.shift()!;
    }

    // Raced against child exit, not awaited outright. `promptDone` settles
    // only when `session/prompt` resolves or rejects; if the CLI died with the
    // request in flight, whether the ACP connection rejects it depends on the
    // SDK's transport-close behaviour. Awaiting it unconditionally would have
    // moved the hang here instead of removing it.
    await Promise.race([promptDone, this.childExited]);
  }

  /** Reason the last turn ended abnormally, or null when it completed
   *  normally. Read by the agent loop after the prompt generator drains. */
  get lastTurnError(): string | null {
    // Composed rather than either-or: the connection rejection and the process
    // exit are two views of one failure and arrive in a nondeterministic
    // order, so the operator gets both facts whichever won the race.
    if (this.turnError && this.childExitDetail) {
      return `${this.turnError} — ${this.childExitDetail}`;
    }
    return this.turnError ?? this.childExitDetail;
  }

  /** Diagnostic lines from kiro-cli's own chat log, newest last.
   *
   *  This is where the CLI records throttling, retries and transport failures —
   *  a rejected `session/prompt` often carries only a terse JSON-RPC message
   *  ("Internal error") while the cause is spelled out here.
   *
   *  The raw log needs real processing before it is worth showing:
   *
   *  - It is ANSI-coloured even with NO_COLOR set, and the escapes render as
   *    literal garbage in the dashboard's HTML.
   *  - It is dominated by benign warnings (absent optional mcp.json files, one
   *    "permission eval for unknown tool use" per tool call). A plain tail is
   *    almost entirely noise, and worse, the noise pushes the actual ERROR out
   *    of the window.
   *  - The same warning repeats dozens of times per turn.
   *
   *  So: strip escapes, drop known-benign lines, rank by significance rather
   *  than recency (an ERROR is always kept, whatever else is competing for the
   *  window), and collapse duplicates. Best-effort: returns null when the log
   *  is absent, unreadable, or holds nothing of interest. */
  readLogTail(maxLines = 25): string | null {
    if (!this.logPath) return null;
    try {
      const raw = readFileSync(this.logPath, "utf-8");
      const ranked: Array<{ rank: number; line: string }> = [];

      for (const rawLine of raw.split("\n")) {
        const line = normaliseLogLine(rawLine);
        if (!line || isBenignLogLine(line)) continue;
        const rank = logLineRank(line);
        if (rank === 0) continue;
        ranked.push({ rank, line });
      }
      if (ranked.length === 0) return null;

      // Collapse repeats, keeping first occurrence order and a count.
      const seen = new Map<string, { rank: number; line: string; count: number }>();
      for (const { rank, line } of ranked) {
        const existing = seen.get(line);
        if (existing) existing.count += 1;
        else seen.set(line, { rank, line, count: 1 });
      }
      const unique = [...seen.values()];

      // Highest rank first, so an ERROR can never be crowded out by warnings.
      // Within a rank the log's own order is preserved.
      unique.sort((a, b) => b.rank - a.rank);
      const kept = unique.slice(0, maxLines);
      const omitted = unique.length - kept.length;

      const out = kept.map(({ line, count }) => (count > 1 ? `${line} (x${count})` : line));
      if (omitted > 0) out.push(`… ${omitted} further log line${omitted === 1 ? "" : "s"} omitted`);
      return out.join("\n");
    } catch {
      return null;
    }
  }

  /** Remove this runner's chat log. One file per iteration accumulates in /tmp
   *  otherwise, and a long-lived agent runs hundreds of iterations. */
  cleanupLog(): void {
    if (!this.logPath) return;
    try { unlinkSync(this.logPath); } catch { /* already gone */ }
  }

  /** Cancel the ACP session and kill the kiro-cli subprocess.
   *
   *  The cancel is only sent when the turn is still believed to be running.
   *  Sending it after a turn has already ended is what made every failure
   *  mode look identical: kiro-cli marks pending tool uses "Cancelled",
   *  writes "Tool uses were interrupted, waiting for the next user prompt",
   *  and skips its closing session-state persist — which is also why the
   *  metering sidecar stayed a stub and the iteration recorded no cost. On a
   *  turn that completed cleanly there is nothing to cancel; on one that
   *  errored the reason is already captured, so we let the CLI shut down via
   *  SIGTERM instead of overwriting its session state with a cancellation. */
  async close(): Promise<void> {
    const turnStillRunning = !this.turnDone;
    if (turnStillRunning && this.sessionId && this.proc.exitCode === null) {
      try {
        await this.conn.cancel({ sessionId: this.sessionId });
      } catch { /* connection may already be dead */ }
    }
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
    }
  }
}

/** Render an ACP/JSON-RPC rejection into a single readable line.
 *
 *  JSON-RPC errors arrive as `{ code, message, data }` rather than as Error
 *  instances, so `String(err)` would yield "[object Object]" — which is how a
 *  swallowed failure looked indistinguishable from a clean turn.
 *
 *  `message` alone is often useless: kiro-cli returns the generic -32603
 *  "Internal error" for most turn failures, which names the transport rather
 *  than the cause. So `code` and `data` are always included when present, and
 *  the whole object is serialised when the message adds nothing — a verbose
 *  line beats a wrong one, and the CLI log tail is appended alongside it. */
function describeTurnError(err: unknown): string {
  if (err instanceof Error) {
    // A JSON-RPC error can arrive wrapped in an Error with the payload hung
    // off it; don't lose that detail.
    const extra = (err as unknown as { code?: unknown; data?: unknown });
    const parts = [err.message || err.name || "Error"];
    if (typeof extra.code === "number" || typeof extra.code === "string") parts.push(`(code ${extra.code})`);
    if (extra.data !== undefined) {
      const d = stringifyCompact(extra.data);
      if (d) parts.push(`data=${d}`);
    }
    return parts.join(" ");
  }
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown; data?: unknown };
    const parts: string[] = [];
    if (typeof e.message === "string" && e.message) parts.push(e.message);
    if (typeof e.code === "number" || typeof e.code === "string") parts.push(`(code ${e.code})`);
    if (e.data !== undefined) {
      const d = stringifyCompact(e.data);
      if (d) parts.push(`data=${d}`);
    }
    if (parts.length > 0) return parts.join(" ");
    return stringifyCompact(err) ?? "unserialisable error";
  }
  const s = String(err);
  return s && s !== "undefined" ? s : "unknown error";
}

/** Distil a failed turn into one classified line for the journal entry.
 *
 *  The raw material is noisy: `describeTurnError` output wraps the cause in
 *  JSON-RPC boilerplate ("Internal error (code -32603) data=Encountered an
 *  error in the response stream: …"), and the log tail's best line is a
 *  full SDK debug dump of which only the service's `message` matters. Every
 *  consumer of the journal — the dashboard, stream_logs, and every PEER
 *  whose prompt embeds this entry next iteration — was carrying up to 2000
 *  chars of that noise for a one-line cause.
 *
 *  Output shape: `<service message> (<kind>, <status>) [request_id <id>]`,
 *  e.g. `Too many requests, please wait before trying again. (throttled,
 *  429) [request_id aa49f80c-…]`. Returns null when no message can be
 *  extracted — the caller falls back to the raw error, a verbose line
 *  beating a missing one. The full raw text still goes to errors.ndjson
 *  and the transcript's .error marker, so nothing is lost. */
export function summariseTurnFailure(turnError: string, cliLogTail: string | null): string | null {
  const tail = cliLogTail ?? "";
  const combined = `${turnError}\n${tail}`;

  // The service's own human-readable message, out of the SDK debug dump:
  // first `message: Some("…")`. Falls back to the JSON-RPC `data=` payload.
  const msgMatch = /message:\s*Some\("((?:[^"\\]|\\.)*)"\)/.exec(tail);
  let dataMsg: string | null = null;
  const dataIdx = turnError.indexOf("data=");
  if (dataIdx >= 0) {
    dataMsg = turnError
      .slice(dataIdx + 5)
      .replace(/^Encountered an error in the response stream:\s*/i, "")
      .trim() || null;
  }
  const message = msgMatch ? msgMatch[1].replace(/\\"/g, '"') : dataMsg;
  if (!message) return null;

  // Same significance vocabulary as logLineRank, collapsed to a category.
  let kind: string | null = null;
  if (/throttl|too many requests|rate ?limit|quota|USER_REQUEST_RATE_EXCEEDED|\b429\b|overloaded/i.test(combined)) kind = "throttled";
  else if (/context (window|length)|token limit|input is too long|too many (input )?tokens|maximum context/i.test(combined)) kind = "context overflow";
  else if (/failed to generate a response|empty response/i.test(combined)) kind = "empty response";
  else if (/timed? ?out|connection|transport|stream closed/i.test(combined)) kind = "transport";

  const status = /status_code:\s*Some\((\d{3})\)/.exec(tail);
  const reqId = /request_id:?\s*"?([0-9a-f-]{36})/i.exec(combined);

  const parts = [message.replace(/\s*\(request_id:?\s*[0-9a-f-]+\)\s*/i, " ").trim()];
  const tag = [kind, status ? status[1] : null].filter(Boolean).join(", ");
  if (tag) parts.push(`(${tag})`);
  if (reqId) parts.push(`[request_id ${reqId[1]}]`);
  return parts.join(" ");
}

function stringifyCompact(value: unknown, max = 800): string | null {
  try {
    const s = typeof value === "string" ? value : JSON.stringify(value);
    if (!s) return null;
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return null;
  }
}

/* ---------- kiro-cli log line processing ------------------------------------- */

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** Strip ANSI escapes and collapse the tracing formatter's whitespace.
 *  kiro-cli colours its log file even with NO_COLOR/FORCE_COLOR set, and those
 *  escapes reach the dashboard as literal `[2m`/`[33m` noise because the pane
 *  renders text, not a terminal. */
function normaliseLogLine(line: string): string {
  return line
    .replace(ANSI_RE, "")
    // The tracing formatter emits `key =` / `: :` fragments that become ragged
    // once the colour codes framing them are gone.
    .replace(/\s+/g, " ")
    .replace(/\s+:\s+:\s+/g, ": ")
    .trim();
}

/** Warnings kiro-cli emits routinely, which say nothing about a failure.
 *  Absent optional MCP config files are expected (the flock passes its servers
 *  in-process), and "permission eval for unknown tool use" fires once per tool
 *  call under auto-approval. Left in, they crowd out the real error. */
const BENIGN_LOG_PATTERNS: RegExp[] = [
  /failed to load (workspace|global) mcp configs/i,
  /Failed to read MCP config from path/i,
  /permission eval for unknown tool use/i,
  /telemetry/i,
];

function isBenignLogLine(line: string): boolean {
  return BENIGN_LOG_PATTERNS.some((re) => re.test(line));
}

/** Head of a genuine kiro-cli (tracing-formatter) log line after
 *  normalisation: an optional ISO timestamp, then the level token. Anchoring
 *  on this is what separates the CLI's own diagnostics from *echoes* of the
 *  agent's activity embedded in the log — a tool call running `grep ERROR
 *  build.log` used to rank as an error itself, filling the captured tail with
 *  the agent's shell input instead of the CLI's failure. */
const LOG_LEVEL_HEAD_RE = /^(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+)?(ERROR|WARN|INFO|DEBUG|TRACE)\b/;

/** Significance of a log line: higher is kept first. Ranking rather than
 *  tailing matters because a turn emits far more warnings than errors, so a
 *  plain tail reliably discards the one line that explains the failure.
 *  Only structurally leveled lines rank at all; keyword matching runs on the
 *  message segment after the level token, never on arbitrary line content. */
function logLineRank(line: string): number {
  const m = LOG_LEVEL_HEAD_RE.exec(line);
  if (!m) return 0; // continuation line or echoed tool output — not a CLI diagnostic
  const level = m[1];
  const message = line.slice(m.index + m[0].length);
  if (/(throttl|too many requests|rate ?limit|quota|429|exceeded|overloaded)/i.test(message)) return 5;
  if (level === "ERROR" || /\b(panic|fatal)\b/i.test(message)) return 4;
  if (/(context window|context length|token limit|compact)/i.test(message)) return 3;
  if (/(timeout|timed out|connection|transport|stream closed|retry|retrying)/i.test(message)) return 2;
  if (level === "WARN") return 1;
  return 0;
}
