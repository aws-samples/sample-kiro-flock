/**
 * Unit tests for the dashboard's pure logic (dashboardCore.ts):
 * action categorization, NDJSON/transitions parsing, 1-minute bucketing,
 * run.json derivation, and the overview histogram helpers. No AWS.
 */
import {
  buildClusterSeries,
  categorizeAction,
  countNdjsonLines,
  deriveRunManifest,
  durationBucket,
  earliestTs,
  isoWeekStart,
  lastTotalCredits,
  nodesBucket,
  parseAgentLog,
  parseCostLog,
  parseRunIdTimestamp,
  parseTransitions,
  type AgentLogLine,
  type CostLine,
} from "./dashboardCore";

// ---------- categorizeAction -------------------------------------------------

describe("categorizeAction", () => {
  it("matches write keywords case-insensitively", () => {
    expect(categorizeAction("wrote summary.md")).toBe("write");
    expect(categorizeAction("Created new module")).toBe("write");
    expect(categorizeAction("UPDATED the config")).toBe("write");
    expect(categorizeAction("editing docs")).toBe("write");
  });

  it("matches read keywords", () => {
    expect(categorizeAction("read neighbour logs")).toBe("read");
    expect(categorizeAction("Reviewed the plan")).toBe("read");
    expect(categorizeAction("inspecting environment")).toBe("read");
    expect(categorizeAction("listed files")).toBe("read");
  });

  it("idle is an exact match only", () => {
    expect(categorizeAction("idle")).toBe("idle");
    expect(categorizeAction("idled around")).toBe("other");
  });

  it("write wins over read when both keywords appear", () => {
    expect(categorizeAction("read plan then wrote code")).toBe("write");
  });

  it("everything else is other", () => {
    expect(categorizeAction("thinking")).toBe("other");
    expect(categorizeAction("")).toBe("other");
  });
});

// ---------- NDJSON parsing ---------------------------------------------------

describe("parseAgentLog / parseCostLog / parseTransitions", () => {
  it("skips malformed lines and blank lines", () => {
    const text = [
      '{"ts":"2026-07-27T09:00:10Z","iteration":1,"action":"wrote a file"}',
      "not json",
      "",
      '{"ts":"2026-07-27T09:01:10Z","iteration":2,"action":"idle"}',
    ].join("\n");
    const entries = parseAgentLog(text);
    expect(entries).toHaveLength(2);
    expect(entries[1].action).toBe("idle");
  });

  it("drops agent log lines without a valid ts", () => {
    const text = '{"iteration":1,"action":"x"}\n{"ts":"garbage","action":"y"}\n';
    expect(parseAgentLog(text)).toHaveLength(0);
  });

  it("parses cost lines and drops ones without numeric credits", () => {
    const text = [
      '{"ts":"2026-07-27T09:00:30Z","credits":0.5,"totalCredits":0.5}',
      '{"ts":"2026-07-27T09:01:30Z","credits":"oops","totalCredits":1}',
    ].join("\n");
    const entries = parseCostLog(text);
    expect(entries).toHaveLength(1);
    expect(entries[0].credits).toBe(0.5);
  });

  it("parses transitions", () => {
    const text = [
      '{"ts":"2026-07-27T09:00:00Z","state":"starting","by":"operator","reason":"manual"}',
      '{"ts":"2026-07-27T09:02:10Z","state":"running","by":"agent-0","reason":"first-iteration"}',
    ].join("\n");
    const entries = parseTransitions(text);
    expect(entries).toHaveLength(2);
    expect(entries[0].state).toBe("starting");
    expect(entries[1].by).toBe("agent-0");
  });
});

describe("countNdjsonLines / lastTotalCredits / earliestTs", () => {
  it("counts non-empty lines", () => {
    expect(countNdjsonLines("a\n\nb\nc\n")).toBe(3);
    expect(countNdjsonLines("")).toBe(0);
  });

  it("finds the last parsable totalCredits, walking past malformed tails", () => {
    const text = '{"totalCredits":1.5}\n{"totalCredits":4.2}\ngarbage\n';
    expect(lastTotalCredits(text)).toBe(4.2);
  });

  it("returns null when no line carries totalCredits", () => {
    expect(lastTotalCredits('{"credits":1}\n')).toBeNull();
    expect(lastTotalCredits("")).toBeNull();
  });

  it("earliestTs picks the minimum valid ts", () => {
    expect(earliestTs([
      { ts: "2026-07-27T09:05:00Z" },
      { ts: "2026-07-27T09:00:00Z" },
      { ts: "invalid" },
    ])).toBe("2026-07-27T09:00:00Z");
    expect(earliestTs([])).toBeNull();
  });
});

// ---------- parseRunIdTimestamp ----------------------------------------------

describe("parseRunIdTimestamp", () => {
  it("round-trips the archive folder format", () => {
    // Format produced by `toISOString().replace(/[:.]/g,"-").slice(0,19)`.
    expect(parseRunIdTimestamp("2026-07-26T14-03-11")).toBe("2026-07-26T14:03:11.000Z");
  });

  it("rejects other shapes", () => {
    expect(parseRunIdTimestamp("current")).toBeNull();
    expect(parseRunIdTimestamp("2026-07-26")).toBeNull();
    expect(parseRunIdTimestamp("")).toBeNull();
  });
});

// ---------- buildClusterSeries -----------------------------------------------

describe("buildClusterSeries", () => {
  const T0 = "2026-07-27T09:00:00.000Z";
  const t0ms = new Date(T0).getTime();

  function makeInput(overrides: Partial<Parameters<typeof buildClusterSeries>[0]> = {}) {
    const agentLogs = new Map<string, AgentLogLine[]>([
      ["agent-0", [
        { ts: "2026-07-27T09:00:10.000Z", iteration: 1, action: "wrote a file" },
        { ts: "2026-07-27T09:02:20.000Z", iteration: 2, action: "idle" },
      ]],
      ["agent-1", [
        { ts: "2026-07-27T09:01:05.000Z", iteration: 1, action: "read neighbour logs" },
      ]],
    ]);
    const costLogs = new Map<string, CostLine[]>([
      ["agent-0", [
        { ts: "2026-07-27T09:00:40.000Z", credits: 0.5, totalCredits: 0.5 },
        { ts: "2026-07-27T09:02:30.000Z", credits: 0.25, totalCredits: 0.75 },
      ]],
    ]);
    return {
      agentLogs,
      costLogs,
      fileTimestampsMs: [t0ms + 90_000], // one file in bucket 1
      startedAt: T0,
      endedAt: "2026-07-27T09:03:00.000Z",
      nowMs: new Date("2026-07-27T09:03:00.000Z").getTime(),
      extendToNow: false,
      hourlyRatePerAgent: 0.06, // → 0.001 USD per active node-minute
      ...overrides,
    };
  }

  it("builds a dense zero-filled series from startedAt to endedAt", () => {
    const series = buildClusterSeries(makeInput());
    // 09:00 .. 09:03 inclusive → 4 buckets.
    expect(series.buckets).toHaveLength(4);
    expect(series.buckets[0].t).toBe(T0);
    expect(series.buckets[3].t).toBe("2026-07-27T09:03:00.000Z");
  });

  it("assigns iterations, actions, idle counts, files, and credits per bucket", () => {
    const series = buildClusterSeries(makeInput());
    const [b0, b1, b2, b3] = series.buckets;
    expect(b0.iterations).toBe(1); // agent-0 iter 1
    expect(b0.actions.write).toBe(1);
    expect(b0.aiCredits).toBeCloseTo(0.5);
    expect(b1.iterations).toBe(1); // agent-1 iter 1
    expect(b1.actions.read).toBe(1);
    expect(b1.files).toBe(1);
    expect(b2.iterations).toBe(1); // agent-0 iter 2 (idle)
    expect(b2.idleIterations).toBe(1);
    expect(b2.actions.idle).toBe(1);
    expect(b2.aiCredits).toBeCloseTo(0.25);
    expect(b3.iterations).toBe(0);
  });

  it("computes activeNodes from agent first/last windows", () => {
    const series = buildClusterSeries(makeInput());
    const active = series.buckets.map(b => b.activeNodes);
    // agent-0 active buckets 0..2; agent-1 active bucket 1 only.
    expect(active).toEqual([1, 2, 1, 0]);
  });

  it("derives per-bucket infraUsd from activeNodes and the hourly rate", () => {
    const series = buildClusterSeries(makeInput());
    // rate/60 = 0.001 per node-minute
    expect(series.buckets[1].infraUsd).toBeCloseTo(0.002);
    expect(series.buckets[3].infraUsd).toBe(0);
    expect(series.totals.infraUsd).toBeCloseTo(0.004);
  });

  it("extends agent activity to now for live running clusters", () => {
    const series = buildClusterSeries(makeInput({ endedAt: null, extendToNow: true }));
    // Both agents extend to now (09:03) → every bucket from their first
    // iteration onward counts them.
    expect(series.buckets.map(b => b.activeNodes)).toEqual([1, 2, 2, 2]);
  });

  it("aligns iterationsPerBucket with the bucket array and totals add up", () => {
    const series = buildClusterSeries(makeInput());
    const agent0 = series.agents.find(a => a.agentId === "agent-0")!;
    expect(agent0.iterationsPerBucket).toEqual([1, 0, 1, 0]);
    expect(agent0.firstIterationTs).toBe("2026-07-27T09:00:10.000Z");
    expect(agent0.lastIterationTs).toBe("2026-07-27T09:02:20.000Z");
    expect(agent0.aiCredits).toBeCloseTo(0.75);
    expect(series.totals.iterations).toBe(3);
    expect(series.totals.files).toBe(1);
    expect(series.totals.aiCredits).toBeCloseTo(0.75);
  });

  it("handles an empty run without throwing", () => {
    const series = buildClusterSeries(makeInput({
      agentLogs: new Map(),
      costLogs: new Map(),
      fileTimestampsMs: [],
      endedAt: T0,
    }));
    expect(series.buckets).toHaveLength(1);
    expect(series.agents).toHaveLength(0);
    expect(series.totals).toEqual({ iterations: 0, files: 0, aiCredits: 0, infraUsd: 0 });
  });
});

// ---------- deriveRunManifest ------------------------------------------------

describe("deriveRunManifest", () => {
  const agentLog0 = [
    '{"ts":"2026-07-27T09:00:10Z","iteration":1,"action":"wrote"}',
    '{"ts":"2026-07-27T09:01:10Z","iteration":2,"action":"idle"}',
  ].join("\n") + "\n";
  const agentLog1 = '{"ts":"2026-07-27T09:00:30Z","iteration":1,"action":"read"}\n';
  const costs0 = [
    '{"ts":"2026-07-27T09:00:40Z","credits":0.5,"totalCredits":0.5}',
    '{"ts":"2026-07-27T09:01:40Z","credits":0.25,"totalCredits":0.75}',
  ].join("\n") + "\n";
  const transitions = '{"ts":"2026-07-27T09:00:00Z","state":"starting","by":"operator","reason":"manual"}\n';

  it("derives startedAt from the transitions log and totals from the files", () => {
    const result = deriveRunManifest({
      agentLogTexts: [agentLog0, agentLog1],
      costLogTexts: [costs0],
      transitionsText: transitions,
      fileCount: 7,
      endedAt: "2026-07-27T10:00:00.000Z",
      hourlyRatePerAgent: 0.1,
    });
    expect(result.startedAt).toBe("2026-07-27T09:00:00Z");
    expect(result.agents).toBe(2);
    expect(result.totals.iterations).toBe(3);
    expect(result.totals.files).toBe(7);
    expect(result.totals.aiCredits).toBeCloseTo(0.75);
    // 1 h elapsed × 0.1 $/h × 2 agents
    expect(result.totals.infraUsd).toBeCloseTo(0.2);
  });

  it("falls back to the earliest agent log line when transitions are absent", () => {
    const result = deriveRunManifest({
      agentLogTexts: [agentLog0, agentLog1],
      costLogTexts: [],
      transitionsText: null,
      fileCount: 0,
      endedAt: "2026-07-27T10:00:00.000Z",
      hourlyRatePerAgent: null,
    });
    expect(result.startedAt).toBe("2026-07-27T09:00:10Z");
    expect(result.totals.aiCredits).toBe(0);
    expect(result.totals.infraUsd).toBe(0); // rate unknown → 0
  });

  it("handles a fully empty archive", () => {
    const result = deriveRunManifest({
      agentLogTexts: [],
      costLogTexts: [],
      transitionsText: null,
      fileCount: 0,
      endedAt: "2026-07-27T10:00:00.000Z",
      hourlyRatePerAgent: 0.1,
    });
    expect(result.startedAt).toBeNull();
    expect(result.agents).toBe(0);
    expect(result.totals).toEqual({ iterations: 0, files: 0, aiCredits: 0, infraUsd: 0 });
  });
});

// ---------- Overview helpers -------------------------------------------------

describe("isoWeekStart", () => {
  it("returns the Monday of the ISO week (UTC)", () => {
    // 2026-07-27 is a Monday.
    expect(isoWeekStart(new Date("2026-07-27T10:00:00Z").getTime())).toBe("2026-07-27");
    expect(isoWeekStart(new Date("2026-07-30T10:00:00Z").getTime())).toBe("2026-07-27"); // Thursday
    expect(isoWeekStart(new Date("2026-08-02T23:59:59Z").getTime())).toBe("2026-07-27"); // Sunday
    expect(isoWeekStart(new Date("2026-08-03T00:00:00Z").getTime())).toBe("2026-08-03"); // next Monday
  });
});

describe("durationBucket / nodesBucket", () => {
  it("buckets run durations per contract", () => {
    expect(durationBucket(0)).toBe("<30m");
    expect(durationBucket(29.9)).toBe("<30m");
    expect(durationBucket(30)).toBe("30m-2h");
    expect(durationBucket(119)).toBe("30m-2h");
    expect(durationBucket(120)).toBe("2h-8h");
    expect(durationBucket(479)).toBe("2h-8h");
    expect(durationBucket(480)).toBe(">8h");
  });

  it("buckets node counts per contract", () => {
    expect(nodesBucket(1)).toBe("1");
    expect(nodesBucket(2)).toBe("2-4");
    expect(nodesBucket(4)).toBe("2-4");
    expect(nodesBucket(5)).toBe("5-8");
    expect(nodesBucket(8)).toBe("5-8");
    expect(nodesBucket(9)).toBe("9-16");
    expect(nodesBucket(16)).toBe("9-16");
    expect(nodesBucket(17)).toBe("17+");
    expect(nodesBucket(64)).toBe("17+");
  });
});
