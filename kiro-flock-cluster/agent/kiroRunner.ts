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
  private nextPermId = 0;

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

    const args = ["acp"];
    if (opts.agentProfile) args.push("--agent", opts.agentProfile);
    if (opts.model) args.push("--model", opts.model);

    // Detached + unref so the parent process can exit without waiting for
    // kiro-cli. close() sends SIGTERM for clean shutdown.
    const proc = spawn("kiro-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      cwd: opts.cwd,
      detached: true,
    });
    proc.unref();
    proc.stderr?.on("data", () => {}); // drain stderr to prevent backpressure

    const client = new KiroRunner(proc);
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
        // Auto-approve: prefer allow_once, then allow_always, then first option.
        const approve = options.find((o) => o.kind === "allow_once")
          ?? options.find((o) => o.kind === "allow_always")
          ?? options[0];
        return { outcome: { outcome: "selected", optionId: approve.optionId } };
      },
    };

    client.conn = new acpSdk.ClientSideConnection(() => clientImpl, stream);

    // --- Kiro extension notifications ---
    // The ACP SDK doesn't expose Kiro-specific notifications through a clean
    // API, so we intercept extNotification on the connection. This is coupled
    // to the SDK internals and may need updating on SDK version bumps.
    const origExtNotification = client.conn as unknown as {
      extNotification?: (method: string, params: unknown) => Promise<void>;
    };
    const origFn = origExtNotification.extNotification?.bind(client.conn);
    (client.conn as unknown as Record<string, unknown>).extNotification = async (
      method: string,
      params: unknown
    ) => {
      if (origFn) {
        try { await origFn(method, params); } catch { /* ignore */ }
      }
      if (!params || typeof params !== "object") return;
      const p = params as Record<string, unknown>;
      if (method === "_kiro.dev/session/update" && "update" in p) {
        const upd = p as { sessionId: string; update: acp.SessionUpdate };
        client.updateQueue.push(upd.update);
        client.updateResolve?.();
        client.updateResolve = null;
      } else if (method === "_kiro.dev/commands/available" && Array.isArray(p.tools)) {
        client.onToolsAvailable?.(
          p.tools as Array<{ name: string; source: string; description: string }>
        );
      }
    };

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
      .catch(() => {
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
      });
    }

    // Drain any updates that arrived between the last yield and turnDone.
    while (this.updateQueue.length > 0) {
      yield this.updateQueue.shift()!;
    }

    await promptDone;
  }

  /** Cancel the ACP session and kill the kiro-cli subprocess. */
  async close(): Promise<void> {
    if (this.sessionId && this.proc.exitCode === null) {
      try {
        await this.conn.cancel({ sessionId: this.sessionId });
      } catch { /* connection may already be dead */ }
    }
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
    }
  }
}
