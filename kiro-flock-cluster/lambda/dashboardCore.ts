/**
 * Pure logic for the dashboard feature (4.7 dashboarding).
 *
 * Everything in this module is deterministic and AWS-free so it can be
 * unit-tested directly: NDJSON parsing, action categorization, 1-minute
 * bucketing, run.json total derivation, and the overview histograms.
 * S3 I/O lives in dashboardBuilder.ts / handler.ts, which feed raw file
 * contents into these helpers.
 *
 * Contract: docs/dashboard-api.md.
 */
import type { TransitionEntry } from "./s3Store";

// ---------- NDJSON parsing ---------------------------------------------------

/** Parse NDJSON text tolerantly: malformed lines are skipped, never thrown. */
export function parseNdjson<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as T);
    } catch { /* malformed line — skip */ }
  }
  return out;
}

/** One agent log iteration line (subset the dashboard consumes). */
export interface AgentLogLine {
  ts: string;
  iteration: number;
  action: string;
}

/** Parse agent-N.ndjson, keeping only lines with a valid ts. */
export function parseAgentLog(text: string): AgentLogLine[] {
  return parseNdjson<AgentLogLine>(text).filter(
    (e) => typeof e.ts === "string" && Number.isFinite(new Date(e.ts).getTime()),
  );
}

/** One agent-N.costs.ndjson line (subset the dashboard consumes). */
export interface CostLine {
  ts: string;
  credits: number;
  totalCredits: number;
}

/** Parse agent-N.costs.ndjson, keeping only lines with valid ts + credits. */
export function parseCostLog(text: string): CostLine[] {
  return parseNdjson<CostLine>(text).filter(
    (e) => typeof e.ts === "string"
      && Number.isFinite(new Date(e.ts).getTime())
      && typeof e.credits === "number" && Number.isFinite(e.credits),
  );
}

/** Parse transitions.ndjson, keeping only lines with a valid ts + state. */
export function parseTransitions(text: string): TransitionEntry[] {
  return parseNdjson<TransitionEntry>(text).filter(
    (e) => typeof e.ts === "string"
      && Number.isFinite(new Date(e.ts).getTime())
      && typeof e.state === "string",
  );
}

/** Count non-empty lines in an NDJSON body (iterations, cheaply). */
export function countNdjsonLines(text: string): number {
  let count = 0;
  for (const line of text.split("\n")) {
    if (line.trim()) count += 1;
  }
  return count;
}

/** Running lifetime credit total from the LAST parsable line carrying
 *  `totalCredits` (the agent writes it on every line). Null when absent. */
export function lastTotalCredits(text: string): number | null {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed) as { totalCredits?: unknown };
      if (typeof entry.totalCredits === "number" && Number.isFinite(entry.totalCredits)) {
        return entry.totalCredits;
      }
    } catch { /* malformed line — keep walking back */ }
  }
  return null;
}

/** Earliest valid ISO ts across a list of `{ ts }` entries, or null. */
export function earliestTs(entries: Array<{ ts: string }>): string | null {
  let bestMs = Number.POSITIVE_INFINITY;
  let best: string | null = null;
  for (const e of entries) {
    const ms = new Date(e.ts).getTime();
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      best = e.ts;
    }
  }
  return best;
}

// ---------- Action categorization --------------------------------------------

export type ActionCategory = "write" | "read" | "idle" | "other";

// Keyword matching per contract: write (wrote/created/updated/edit),
// read (read/reviewed/inspect/list), idle (exact "idle"), other (rest).
// Case-insensitive substring matching; "idle" is an exact match so an
// action like "idle-adjacent cleanup" still lands in a real category.
const WRITE_RE = /wrote|created|updated|edit/i;
const READ_RE = /read|reviewed|inspect|list/i;

export function categorizeAction(action: string): ActionCategory {
  if (action === "idle") return "idle";
  if (WRITE_RE.test(action)) return "write";
  if (READ_RE.test(action)) return "read";
  return "other";
}

// ---------- Bucketing --------------------------------------------------------

export const BUCKET_MS = 60_000; // 1 minute per contract

/** Floor a millisecond timestamp to its minute boundary. */
export function floorToMinute(ms: number): number {
  return Math.floor(ms / BUCKET_MS) * BUCKET_MS;
}

/** Bucket index for a timestamp given the (already floored) series start.
 *  Returns -1 when the ts falls before the series. */
export function bucketIndexFor(tsMs: number, startFlooredMs: number): number {
  if (!Number.isFinite(tsMs) || tsMs < startFlooredMs) return -1;
  return Math.floor((tsMs - startFlooredMs) / BUCKET_MS);
}

/** One dense 1-minute series bucket (contract JSON shape). */
export interface SeriesBucket {
  t: string;
  iterations: number;
  idleIterations: number;
  files: number;
  activeNodes: number;
  aiCredits: number;
  infraUsd: number;
  actions: { write: number; read: number; idle: number; other: number };
}

/** Per-agent series row (contract JSON shape). */
export interface AgentSeries {
  agentId: string;
  firstIterationTs: string | null;
  lastIterationTs: string | null;
  iterations: number;
  aiCredits: number;
  infraUsd: number;
  iterationsPerBucket: number[];
  /** Per-bucket AI credit spend, aligned to the cluster bucket array.
   *  Feeds the "cost per agent over time" stacked chart. */
  aiCreditsPerBucket: number[];
}

export interface ClusterSeriesInput {
  /** Per-agent iteration log entries, keyed by agent id ("agent-0"). */
  agentLogs: Map<string, AgentLogLine[]>;
  /** Per-agent cost log entries, keyed by agent id. */
  costLogs: Map<string, CostLine[]>;
  /** LastModified epoch ms of every environment file for this run. */
  fileTimestampsMs: number[];
  /** Series start (ISO). Floored to the minute internally. */
  startedAt: string;
  /** Series end (ISO) for archived runs; null for live (uses nowMs). */
  endedAt: string | null;
  /** Injected "now" for determinism in tests. */
  nowMs: number;
  /** True when this is the live current run of a running cluster —
   *  extends each agent's activity window to now per contract. */
  extendToNow: boolean;
  /** Per-agent hourly infra rate in USD, or null when pricing unknown. */
  hourlyRatePerAgent: number | null;
}

export interface ClusterSeries {
  buckets: SeriesBucket[];
  agents: AgentSeries[];
  totals: { iterations: number; files: number; aiCredits: number; infraUsd: number };
}

/**
 * Build the dense 1-minute bucket series + per-agent rows for one run.
 * Pure: all inputs are pre-fetched file contents/timestamps.
 */
export function buildClusterSeries(input: ClusterSeriesInput): ClusterSeries {
  const startMs = floorToMinute(new Date(input.startedAt).getTime());
  const endMs = input.endedAt ? new Date(input.endedAt).getTime() : input.nowMs;
  // Dense series from startedAt to endedAt/now inclusive of the final
  // partial minute. Guard against inverted ranges (clock skew) with a
  // single-bucket floor.
  const bucketCount = Math.max(1, Math.floor((Math.max(endMs, startMs) - startMs) / BUCKET_MS) + 1);

  const buckets: SeriesBucket[] = Array.from({ length: bucketCount }, (_, i) => ({
    t: new Date(startMs + i * BUCKET_MS).toISOString(),
    iterations: 0,
    idleIterations: 0,
    files: 0,
    activeNodes: 0,
    aiCredits: 0,
    infraUsd: 0,
    actions: { write: 0, read: 0, idle: 0, other: 0 },
  }));

  const inRange = (idx: number) => idx >= 0 && idx < bucketCount;

  // Environment file timestamps.
  for (const ms of input.fileTimestampsMs) {
    const idx = bucketIndexFor(ms, startMs);
    if (inRange(idx)) buckets[idx].files += 1;
  }

  const agentIds = Array.from(new Set([...input.agentLogs.keys(), ...input.costLogs.keys()]))
    .sort((a, b) => {
      const na = Number(a.replace(/^agent-/, ""));
      const nb = Number(b.replace(/^agent-/, ""));
      return na - nb;
    });

  const agents: AgentSeries[] = [];
  for (const agentId of agentIds) {
    const log = input.agentLogs.get(agentId) ?? [];
    const costs = input.costLogs.get(agentId) ?? [];

    const iterationsPerBucket = new Array<number>(bucketCount).fill(0);
    let firstMs = Number.POSITIVE_INFINITY;
    let lastMs = Number.NEGATIVE_INFINITY;
    for (const entry of log) {
      const ms = new Date(entry.ts).getTime();
      if (ms < firstMs) firstMs = ms;
      if (ms > lastMs) lastMs = ms;
      const idx = bucketIndexFor(ms, startMs);
      if (!inRange(idx)) continue;
      iterationsPerBucket[idx] += 1;
      buckets[idx].iterations += 1;
      const cat = categorizeAction(entry.action ?? "");
      buckets[idx].actions[cat] += 1;
      if (cat === "idle") buckets[idx].idleIterations += 1;
    }

    let agentCredits = 0;
    const aiCreditsPerBucket = new Array<number>(bucketCount).fill(0);
    for (const c of costs) {
      agentCredits += c.credits;
      const idx = bucketIndexFor(new Date(c.ts).getTime(), startMs);
      if (inRange(idx)) {
        buckets[idx].aiCredits += c.credits;
        aiCreditsPerBucket[idx] += c.credits;
      }
    }

    const hasIterations = log.length > 0;
    // Active window: [firstIterationTs, lastIterationTs], with the tail
    // extended to now for a currently-running live agent per contract.
    const activeFrom = hasIterations ? bucketIndexFor(firstMs, startMs) : -1;
    const activeTo = hasIterations
      ? bucketIndexFor(input.extendToNow ? input.nowMs : lastMs, startMs)
      : -1;
    let activeBuckets = 0;
    if (hasIterations) {
      const from = Math.max(0, activeFrom);
      const to = Math.min(bucketCount - 1, activeTo);
      for (let i = from; i <= to; i++) {
        buckets[i].activeNodes += 1;
        activeBuckets += 1;
      }
    }

    const rate = input.hourlyRatePerAgent ?? 0;
    agents.push({
      agentId,
      firstIterationTs: hasIterations ? new Date(firstMs).toISOString() : null,
      lastIterationTs: hasIterations ? new Date(lastMs).toISOString() : null,
      iterations: log.length,
      aiCredits: agentCredits,
      infraUsd: activeBuckets * (rate / 60),
      iterationsPerBucket,
      aiCreditsPerBucket,
    });
  }

  // Per-bucket infra cost derives from activeNodes (contract).
  const rate = input.hourlyRatePerAgent ?? 0;
  for (const b of buckets) {
    b.infraUsd = b.activeNodes * (rate / 60);
  }

  const totals = {
    iterations: agents.reduce((s, a) => s + a.iterations, 0),
    files: input.fileTimestampsMs.length,
    aiCredits: agents.reduce((s, a) => s + a.aiCredits, 0),
    infraUsd: buckets.reduce((s, b) => s + b.infraUsd, 0),
  };

  return { buckets, agents, totals };
}

// ---------- Run manifest derivation ------------------------------------------

export interface RunTotals {
  iterations: number;
  files: number;
  aiCredits: number;
  infraUsd: number;
}

/**
 * Derive run.json totals + startedAt from raw archived file bodies.
 * `agentLogTexts` / `costLogTexts` are the full NDJSON bodies of every
 * agent-N.ndjson / agent-N.costs.ndjson; `transitionsText` may be null
 * for runs predating the transitions log.
 */
export function deriveRunManifest(params: {
  agentLogTexts: string[];
  costLogTexts: string[];
  transitionsText: string | null;
  fileCount: number;
  endedAt: string;
  hourlyRatePerAgent: number | null;
}): { startedAt: string | null; totals: RunTotals; agents: number } {
  const iterations = params.agentLogTexts.reduce((s, t) => s + countNdjsonLines(t), 0);
  const aiCredits = params.costLogTexts.reduce((s, t) => s + (lastTotalCredits(t) ?? 0), 0);

  // startedAt: earliest transitions entry wins; fall back to the earliest
  // agent log line. The first line of each agent log is the earliest for
  // that agent (append-only), so we only parse those.
  let startedAt: string | null = null;
  if (params.transitionsText) {
    startedAt = earliestTs(parseTransitions(params.transitionsText));
  }
  if (!startedAt) {
    const firstLines: Array<{ ts: string }> = [];
    for (const text of params.agentLogTexts) {
      const firstLine = text.split("\n").find((l) => l.trim());
      if (!firstLine) continue;
      try {
        const parsed = JSON.parse(firstLine) as { ts?: unknown };
        if (typeof parsed.ts === "string") firstLines.push({ ts: parsed.ts });
      } catch { /* malformed — skip */ }
    }
    startedAt = earliestTs(firstLines);
  }

  const agents = params.agentLogTexts.length;
  let infraUsd = 0;
  if (startedAt && params.hourlyRatePerAgent != null && agents > 0) {
    const elapsedHours = (new Date(params.endedAt).getTime() - new Date(startedAt).getTime()) / 3_600_000;
    if (elapsedHours > 0) infraUsd = elapsedHours * params.hourlyRatePerAgent * agents;
  }

  return {
    startedAt,
    totals: { iterations, files: params.fileCount, aiCredits, infraUsd },
    agents,
  };
}

/** Parse an archived runId (history/ folder timestamp like
 *  "2026-07-26T14-03-11", produced by `toISOString().replace(/[:.]/g,"-")
 *  .slice(0,19)`) back into an ISO-8601 UTC string. Null when the runId
 *  doesn't match the expected shape. */
export function parseRunIdTimestamp(runId: string): string | null {
  const m = runId.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const iso = `${m[1]}T${m[2]}:${m[3]}:${m[4]}.000Z`;
  return Number.isFinite(new Date(iso).getTime()) ? iso : null;
}

// ---------- Overview helpers -------------------------------------------------

/** Monday of the ISO week containing `ms`, as YYYY-MM-DD (UTC). */
export function isoWeekStart(ms: number): string {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0 = Sunday
  const diff = day === 0 ? 6 : day - 1; // days since Monday
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diff));
  return monday.toISOString().slice(0, 10);
}

/** Duration histogram bucket label per contract. */
export function durationBucket(minutes: number): "<30m" | "30m-2h" | "2h-8h" | ">8h" {
  if (minutes < 30) return "<30m";
  if (minutes < 120) return "30m-2h";
  if (minutes < 480) return "2h-8h";
  return ">8h";
}

/** Node-count histogram bucket label per contract. */
export function nodesBucket(n: number): "1" | "2-4" | "5-8" | "9-16" | "17+" {
  if (n <= 1) return "1";
  if (n <= 4) return "2-4";
  if (n <= 8) return "5-8";
  if (n <= 16) return "9-16";
  return "17+";
}
