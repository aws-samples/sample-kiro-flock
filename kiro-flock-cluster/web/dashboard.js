/* ============================================================================
   Dashboard overlay — fleet overview + per-cluster run drill-down.

   ES module, lazy-loaded by shell.js on the topbar dashboard button.
   Default export: { open(params, shellCtx), close() }.

   Routes (all behind the Cognito authorizer, same /cluster/* dispatch):
     - GET cluster/dashboard/overview           (fleet aggregate)
     - GET cluster/dashboard/runs/{clusterId}   (run selector)
     - GET cluster/dashboard/{clusterId}?run=…  (per-run drill-down)
   All AI costs arrive as raw credits (converted here via costFormat.js);
   infra costs arrive as USD. Series are 1-minute buckets; the 10m/1h
   toggle re-buckets client-side.

   Polling: 15 s while the overlay is open and the view is live (overview
   or a live run). Archived runs are immutable — fetched once, no poll.
   202 {status:"building"} responses are re-polled every 2 s.

   Charts: window.Chart (Chart.js 4 UMD, loaded by index.html). Charts are
   created once per view and updated in place on poll. No date adapter is
   loaded, so time axes are category axes with preformatted HH:MM labels.

   DOM-XSS: static markup via innerHTML, all dynamic text (cluster ids,
   run ids, agent ids…) via textContent. Never interpolate API strings
   into innerHTML.
   ============================================================================ */

import { creditsToUsd } from "./costFormat.js";

const POLL_MS = 15000;
const BUILDING_POLL_MS = 2000;
const BUCKET_KEY = "sh_dash_bucket_v1";

// ---------- Module state -------------------------------------------------------

let root = null;          // overlay root element
let bodyEl = null;        // scrollable content area
let breadcrumbEl = null;
let freshnessEl = null;
let shell = { showError: () => {}, showInfo: () => {} };

let isOpen = false;
let pollTimer = null;
let escHandler = null;
let fetchSeq = 0;         // invalidates in-flight fetches on view switches

// view: { kind: "overview" } | { kind: "cluster", clusterId, runId }
let view = { kind: "overview" };
let bucketSize = 1;       // minutes: 1 | 10 | 60

// Per-view chart registry: key → Chart instance (or custom renderer object).
let charts = new Map();
// Cache of the drill-down runs list per cluster.
let runsCache = new Map();
// Last drill-down payload (for re-bucketing on toggle / tab switch).
let clusterData = null;
let activeTab = "performance";

// ---------- Theme --------------------------------------------------------------

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

const THEME = {
  grid: "rgba(255,255,255,0.06)",
  tick: () => cssVar("--text-muted", "#b6bac9"),
  text: () => cssVar("--text-dim", "#e6e6f0"),
  accent: () => cssVar("--accent", "#9046ff"),
  green: () => cssVar("--green", "#34d399"),
  yellow: () => cssVar("--yellow", "#facc15"),
  red: () => cssVar("--red", "#fb7185"),
  cost: () => cssVar("--cost", "#e8a45c"),
  blue: "#60a5fa",
  gray: "#8a8aa0",
};

const AI_COLOR = () => THEME.cost();          // AI cost — amber
const INFRA_COLOR = () => THEME.blue;         // infra cost — blue

// Categorical palette for per-cluster / per-agent stacked series.
const PALETTE = ["#9046ff", "#34d399", "#60a5fa", "#e8a45c", "#fb7185", "#facc15", "#2dd4bf", "#c084fc", "#f472b6", "#a3e635"];
const OTHERS_COLOR = "rgba(160,160,184,0.5)";

function baseOptions(extra = {}) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    plugins: {
      legend: {
        labels: { color: THEME.tick(), boxWidth: 10, font: { size: 10 } },
        ...(extra.legend || {}),
      },
      tooltip: { intersect: false, mode: "index" },
      ...(extra.plugins || {}),
    },
    scales: extra.scales || {
      x: { grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
      y: { grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
    },
    ...(extra.root || {}),
  };
}

// ---------- Small helpers -------------------------------------------------------

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function hhmm(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "5h 40m", "42m", "3d 4h" — humane duration from minutes. */
function fmtDurationMin(min) {
  if (min == null || !Number.isFinite(min)) return "\u2014";
  const m = Math.round(min);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtMoney(usd) {
  if (usd == null || !Number.isFinite(usd)) return "\u2014";
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`;
  return `$${usd.toFixed(2)}`;
}

function fmtNum(n) {
  if (n == null || !Number.isFinite(n)) return "\u2014";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(1);
}

/** Authenticated GET returning { ok, building, data }. Defensive against
 *  the backend not being deployed yet (404/5xx surface as errors). */
async function getJson(url) {
  const res = await window.fetch(url);
  if (res.status === 202) return { ok: false, building: true, data: null };
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Some proxies flatten 202 bodies into 200s — honor status field too.
  if (data && data.status === "building") return { ok: false, building: true, data: null };
  return { ok: true, building: false, data };
}

// ---------- Re-bucketing ---------------------------------------------------------

/**
 * Group 1-minute buckets into `size`-minute buckets.
 * Sums: iterations, idleIterations, files, aiCredits, infraUsd, actions.*
 * Average: activeNodes (over the minutes actually present in the group).
 * Returns the same shape as the input buckets.
 */
function rebucket(buckets, size) {
  if (!Array.isArray(buckets) || buckets.length === 0) return [];
  if (size <= 1) return buckets;
  const out = [];
  for (let i = 0; i < buckets.length; i += size) {
    const group = buckets.slice(i, i + size);
    const acc = {
      t: group[0].t,
      iterations: 0, idleIterations: 0, files: 0,
      activeNodes: 0, aiCredits: 0, infraUsd: 0,
      actions: { write: 0, read: 0, idle: 0, other: 0 },
    };
    let nodeSum = 0;
    for (const b of group) {
      acc.iterations += b.iterations || 0;
      acc.idleIterations += b.idleIterations || 0;
      acc.files += b.files || 0;
      acc.aiCredits += b.aiCredits || 0;
      acc.infraUsd += b.infraUsd || 0;
      nodeSum += b.activeNodes || 0;
      const a = b.actions || {};
      acc.actions.write += a.write || 0;
      acc.actions.read += a.read || 0;
      acc.actions.idle += a.idle || 0;
      acc.actions.other += a.other || 0;
    }
    acc.activeNodes = nodeSum / group.length;
    out.push(acc);
  }
  return out;
}

/** Re-bucket a per-agent iterations array (sums), aligned to rebucket(). */
function rebucketAgentSeries(series, size) {
  if (!Array.isArray(series) || series.length === 0) return [];
  if (size <= 1) return series;
  const out = [];
  for (let i = 0; i < series.length; i += size) {
    let sum = 0;
    for (let j = i; j < Math.min(i + size, series.length); j++) sum += series[j] || 0;
    out.push(sum);
  }
  return out;
}

// ---------- Chart lifecycle -------------------------------------------------------

/**
 * Create-once/update-in-place chart helper. `make(canvas)` builds the
 * Chart.js config on first call; `apply(chart)` mutates data on every call.
 */
function upsertChart(key, canvas, make, apply) {
  let chart = charts.get(key);
  if (chart && chart.canvas !== canvas) { chart.destroy(); chart = null; charts.delete(key); }
  if (!chart) {
    chart = new window.Chart(canvas, make());
    charts.set(key, chart);
  }
  apply(chart);
  chart.update("none");
  return chart;
}

function destroyCharts() {
  for (const c of charts.values()) {
    if (c && typeof c.destroy === "function") { try { c.destroy(); } catch { /* detached */ } }
  }
  charts.clear();
}

/** Card scaffold: title + one-line explainer + fixed-height body +
 *  empty-state note. Returns { card, body }. Titles/subs are static
 *  strings, safe as textContent. */
function makeCard(title, sub, bodyClass) {
  const card = el("div", "dash-card");
  card.appendChild(el("div", "dash-card-title", title));
  if (sub) card.appendChild(el("div", "dash-card-sub", sub));
  const body = el("div", "dash-card-body" + (bodyClass ? ` ${bodyClass}` : ""));
  const empty = el("div", "dash-empty", "no data yet");
  body.appendChild(empty);
  card.appendChild(body);
  return { card, body };
}

function setCardEmpty(body, isEmpty) {
  const card = body.closest(".dash-card");
  if (card) card.classList.toggle("is-empty", !!isEmpty);
}

/** Get (or create) the canvas inside a card body. */
function cardCanvas(body) {
  let c = body.querySelector("canvas");
  if (!c) {
    c = document.createElement("canvas");
    body.insertBefore(c, body.firstChild);
  }
  return c;
}

// ---------- Overlay skeleton --------------------------------------------------------

function buildOverlay() {
  root = el("div", "dash-overlay");
  // Static markup only — all dynamic text is injected via textContent later.
  root.innerHTML = `
    <header class="dash-header">
      <div class="dash-title">dashboard</div>
      <nav class="dash-breadcrumb" data-dash-breadcrumb></nav>
      <div class="dash-header-spacer"></div>
      <span class="dash-freshness" data-dash-freshness></span>
      <button class="dash-close" data-dash-close title="Close dashboard" aria-label="Close dashboard">&#10005;</button>
    </header>
    <div class="dash-body" data-dash-body></div>
  `;
  document.body.appendChild(root);
  bodyEl = root.querySelector("[data-dash-body]");
  breadcrumbEl = root.querySelector("[data-dash-breadcrumb]");
  freshnessEl = root.querySelector("[data-dash-freshness]");
  root.querySelector("[data-dash-close]").addEventListener("click", () => api.close());
}

function setBreadcrumb(parts) {
  // parts: [{ label, onClick? }] — labels may contain cluster ids → textContent.
  breadcrumbEl.innerHTML = "";
  parts.forEach((p, i) => {
    if (i > 0) breadcrumbEl.appendChild(el("span", "dash-crumb-sep", "/"));
    if (p.onClick) {
      const a = el("a", "dash-crumb-link", p.label);
      a.addEventListener("click", p.onClick);
      breadcrumbEl.appendChild(a);
    } else {
      breadcrumbEl.appendChild(el("span", null, p.label));
    }
  });
}

function setFreshness(text, building) {
  freshnessEl.textContent = text || "";
  freshnessEl.classList.toggle("building", !!building);
}

// ---------- Polling ------------------------------------------------------------------

function stopPolling() {
  if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
}

function schedule(ms) {
  stopPolling();
  if (!isOpen) return;
  pollTimer = setTimeout(refresh, ms);
}

/** Fetch + render the current view; reschedules itself. */
async function refresh() {
  const seq = ++fetchSeq;
  try {
    if (view.kind === "overview") {
      const r = await getJson("cluster/dashboard/overview");
      if (seq !== fetchSeq || !isOpen) return;
      if (r.building) {
        setFreshness("building\u2026", true);
        schedule(BUILDING_POLL_MS);
        return;
      }
      renderOverview(r.data);
      setFreshness(r.data.lastBuilt ? `built ${hhmm(r.data.lastBuilt)}` : "");
      schedule(POLL_MS);
    } else {
      const cid = encodeURIComponent(view.clusterId);
      const rid = encodeURIComponent(view.runId || "current");
      const r = await getJson(`cluster/dashboard/${cid}?run=${rid}`);
      if (seq !== fetchSeq || !isOpen) return;
      if (r.building) {
        setFreshness("building\u2026", true);
        schedule(BUILDING_POLL_MS);
        return;
      }
      clusterData = r.data;
      renderCluster();
      setFreshness(r.data.lastBuilt ? `built ${hhmm(r.data.lastBuilt)}` : "");
      // Archived runs are immutable — no poll.
      if (r.data.live) schedule(POLL_MS);
      else stopPolling();
    }
  } catch (err) {
    if (seq !== fetchSeq || !isOpen) return;
    setFreshness("unavailable", false);
    // First load of a view: show an inline error instead of an empty page.
    if (!bodyEl.hasChildNodes() || bodyEl.querySelector(".dash-loading")) {
      bodyEl.innerHTML = "";
      const box = el("div", "dash-loading");
      box.appendChild(el("div", null, "Dashboard data unavailable"));
      box.appendChild(el("div", null, String(err && err.message || err)));
      bodyEl.appendChild(box);
    }
    schedule(POLL_MS);
  }
}

function showLoading(text) {
  bodyEl.innerHTML = `<div class="dash-loading"><div class="sh-spinner"></div><div></div></div>`;
  bodyEl.querySelector(".dash-loading > div:last-child").textContent = text;
}

// ---------- View switching --------------------------------------------------------------

function gotoOverview() {
  view = { kind: "overview" };
  clusterData = null;
  destroyCharts();
  setBreadcrumb([{ label: "fleet" }]);
  showLoading("Loading fleet overview\u2026");
  setFreshness("");
  refresh();
}

function gotoCluster(clusterId, runId) {
  view = { kind: "cluster", clusterId, runId: runId || "current" };
  clusterData = null;
  destroyCharts();
  setBreadcrumb([
    { label: "fleet", onClick: gotoOverview },
    { label: clusterId },
  ]);
  showLoading(`Loading ${clusterId}\u2026`);
  setFreshness("");
  loadRuns(clusterId); // fire-and-forget; the selector fills in when it lands
  refresh();
}

async function loadRuns(clusterId) {
  try {
    const r = await getJson(`cluster/dashboard/runs/${encodeURIComponent(clusterId)}`);
    if (r.ok && Array.isArray(r.data.runs)) {
      runsCache.set(clusterId, r.data.runs);
      if (view.kind === "cluster" && view.clusterId === clusterId) fillRunSelect();
    }
  } catch { /* run selector stays with what it has */ }
}

// ---------- Fleet overview view ------------------------------------------------------------

let ovRefs = null; // { statsEl, clustersEl, cards: {…} }

function ensureOverviewDom() {
  if (ovRefs && bodyEl.contains(ovRefs.statsEl)) return;
  bodyEl.innerHTML = "";
  destroyCharts();

  const statsEl = el("div", "dash-stats");

  const clustersWrap = el("div", "dash-clusters");
  clustersWrap.appendChild(el("div", "dash-section-title", "Clusters & runs"));
  const clustersEl = el("div", "dash-clusters-table");
  clustersWrap.appendChild(clustersEl);

  const grid = el("div", "dash-grid");
  const cards = {
    runsWeek: makeCard("Runs per week",
      "Completed runs grouped by ISO week, from the run archives."),
    costWeek: makeCard("Cost per week (AI vs infra, USD)",
      "Each week's total spend: AI credits converted at the overage rate, plus EC2/Fargate compute."),
    filesWeek: makeCard("Files per week",
      "Environment files produced by each week's runs."),
    duration: makeCard("Run duration distribution",
      "How long runs lasted, from first activity to archive."),
    nodes: makeCard("Nodes per cluster distribution",
      "Agent counts across archived runs."),
    topRuns: makeCard("Top 10 most expensive runs (click to open)",
      "Ranked by combined AI + infra spend; click a bar to open that run."),
    costByCluster: makeCard("Cost per week by cluster (USD)",
      "Combined AI + infra spend per week, stacked by cluster (top 6, rest as others)."),
    hoursByCluster: makeCard("Run hours per week by cluster",
      "Wall-clock run duration per week, stacked by cluster."),
  };
  for (const c of Object.values(cards)) grid.appendChild(c.card);

  bodyEl.appendChild(statsEl);
  bodyEl.appendChild(clustersWrap);
  bodyEl.appendChild(grid);
  ovRefs = { statsEl, clustersEl, cards };
}

function statCard(value, label, isCost) {
  const box = el("div", "dash-stat");
  const v = el("div", "dash-stat-value" + (isCost ? " cost" : ""), value);
  box.appendChild(v);
  box.appendChild(el("div", "dash-stat-label", label));
  return box;
}

function renderOverview(data) {
  ensureOverviewDom();
  const s = data.stats || {};

  // Stat cards row.
  ovRefs.statsEl.innerHTML = "";
  ovRefs.statsEl.appendChild(statCard(fmtNum(s.totalRuns), "total runs"));
  ovRefs.statsEl.appendChild(statCard(fmtNum(s.runsThisWeek), "runs this week"));
  ovRefs.statsEl.appendChild(statCard(fmtNum(s.liveClusters), "live clusters"));
  ovRefs.statsEl.appendChild(statCard(fmtNum(s.avgNodesPerCluster), "avg nodes / cluster"));
  ovRefs.statsEl.appendChild(statCard(fmtDurationMin(s.avgRunDurationMinutes), "avg run duration"));
  ovRefs.statsEl.appendChild(statCard(
    s.totalAiCredits != null ? fmtMoney(creditsToUsd(s.totalAiCredits)) : "\u2014", "total AI cost", true));
  ovRefs.statsEl.appendChild(statCard(
    s.totalInfraUsd != null ? fmtMoney(s.totalInfraUsd) : "\u2014", "total infra cost", true));
  ovRefs.statsEl.appendChild(statCard(fmtNum(s.totalFiles), "total files"));

  // Clusters & runs table — every known cluster (live or historic), each
  // row a door into the drill-down. All dynamic strings via textContent.
  const clusters = Array.isArray(data.clusters) ? data.clusters : [];
  ovRefs.clustersEl.innerHTML = "";
  if (clusters.length === 0) {
    ovRefs.clustersEl.appendChild(el("div", "dash-running-empty", "no clusters yet"));
  } else {
    const head = el("div", "dash-cluster-row head");
    for (const h of ["cluster", "state", "runs", "last run", "total cost", ""]) {
      head.appendChild(el("span", null, h));
    }
    ovRefs.clustersEl.appendChild(head);
    for (const c of clusters) {
      const row = el("button", "dash-cluster-row");
      row.type = "button";
      const nameCell = el("span", "dash-cluster-row-name", c.name || c.clusterId);
      const stateCell = el("span", `dash-cluster-row-state ${/^(running|starting|paused|stopping)$/.test(c.state) ? c.state : "stopped"}`, c.state);
      const runsCell = el("span", null, fmtNum(c.runCount));
      const lastCell = el("span", "dash-cluster-row-dim",
        c.lastRunAt ? `${new Date(c.lastRunAt).toLocaleDateString()} ${hhmm(c.lastRunAt)}` : "\u2014");
      const cost = creditsToUsd(c.totalAiCredits || 0) + (c.totalInfraUsd || 0);
      const costCell = el("span", "cost-label", fmtMoney(cost));
      const arrow = el("span", "dash-cluster-row-arrow", c.latestRunId ? "\u203a" : "");
      for (const cell of [nameCell, stateCell, runsCell, lastCell, costCell, arrow]) row.appendChild(cell);
      if (c.latestRunId) {
        row.addEventListener("click", () => gotoCluster(c.clusterId, c.latestRunId));
      } else {
        row.disabled = true; // registered but never run — nothing to drill into
      }
      ovRefs.clustersEl.appendChild(row);
    }
  }

  // Weekly charts.
  const weekly = Array.isArray(data.weekly) ? data.weekly : [];
  const weekLabels = weekly.map((w) => w.weekStart);
  const { cards } = ovRefs;

  setCardEmpty(cards.runsWeek.body, weekly.length === 0);
  upsertChart("ov-runs", cardCanvas(cards.runsWeek.body),
    () => ({
      type: "bar",
      data: { labels: [], datasets: [{ label: "runs", data: [], backgroundColor: THEME.accent() }] },
      options: baseOptions({ legend: { display: false } }),
    }),
    (ch) => {
      ch.data.labels = weekLabels;
      ch.data.datasets[0].data = weekly.map((w) => w.runs || 0);
    });

  setCardEmpty(cards.costWeek.body, weekly.length === 0);
  upsertChart("ov-cost", cardCanvas(cards.costWeek.body),
    () => ({
      type: "bar",
      data: {
        labels: [],
        datasets: [
          { label: "AI (USD)", data: [], backgroundColor: AI_COLOR() },
          { label: "infra (USD)", data: [], backgroundColor: INFRA_COLOR() },
        ],
      },
      options: baseOptions({
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, font: { size: 10 } } },
          y: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = weekLabels;
      ch.data.datasets[0].data = weekly.map((w) => creditsToUsd(w.aiCredits || 0));
      ch.data.datasets[1].data = weekly.map((w) => w.infraUsd || 0);
    });

  setCardEmpty(cards.filesWeek.body, weekly.length === 0);
  upsertChart("ov-files", cardCanvas(cards.filesWeek.body),
    () => ({
      type: "bar",
      data: { labels: [], datasets: [{ label: "files", data: [], backgroundColor: THEME.green() }] },
      options: baseOptions({ legend: { display: false } }),
    }),
    (ch) => {
      ch.data.labels = weekLabels;
      ch.data.datasets[0].data = weekly.map((w) => w.files || 0);
    });

  const dur = Array.isArray(data.durationHistogram) ? data.durationHistogram : [];
  setCardEmpty(cards.duration.body, dur.length === 0);
  upsertChart("ov-dur", cardCanvas(cards.duration.body),
    () => ({
      type: "bar",
      data: { labels: [], datasets: [{ label: "runs", data: [], backgroundColor: THEME.yellow() }] },
      options: baseOptions({ legend: { display: false } }),
    }),
    (ch) => {
      ch.data.labels = dur.map((d) => d.bucket);
      ch.data.datasets[0].data = dur.map((d) => d.count || 0);
    });

  const nodes = Array.isArray(data.nodesHistogram) ? data.nodesHistogram : [];
  setCardEmpty(cards.nodes.body, nodes.length === 0);
  upsertChart("ov-nodes", cardCanvas(cards.nodes.body),
    () => ({
      type: "bar",
      data: { labels: [], datasets: [{ label: "clusters", data: [], backgroundColor: THEME.blue }] },
      options: baseOptions({ legend: { display: false } }),
    }),
    (ch) => {
      ch.data.labels = nodes.map((n) => n.bucket);
      ch.data.datasets[0].data = nodes.map((n) => n.count || 0);
    });

  // Top runs — horizontal stacked bar, click → drill-down.
  const topRuns = Array.isArray(data.topRuns) ? data.topRuns : [];
  setCardEmpty(cards.topRuns.body, topRuns.length === 0);
  upsertChart("ov-top", cardCanvas(cards.topRuns.body),
    () => ({
      type: "bar",
      data: {
        labels: [],
        datasets: [
          { label: "AI (USD)", data: [], backgroundColor: AI_COLOR() },
          { label: "infra (USD)", data: [], backgroundColor: INFRA_COLOR() },
        ],
      },
      options: baseOptions({
        root: {
          indexAxis: "y",
          onClick: (evt, elements, ch) => {
            if (!elements || elements.length === 0) return;
            const run = ch._dashTopRuns && ch._dashTopRuns[elements[0].index];
            if (run) gotoCluster(run.clusterId, run.runId);
          },
          onHover: (evt, elements) => {
            evt.native.target.style.cursor = elements && elements.length > 0 ? "pointer" : "default";
          },
        },
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
          y: { stacked: true, grid: { display: false }, ticks: { color: THEME.tick(), font: { size: 10 } } },
        },
      }),
    }),
    (ch) => {
      ch._dashTopRuns = topRuns;
      ch.data.labels = topRuns.map((r) => `${r.clusterId} ${r.runId === "current" ? "(live)" : r.runId}`);
      ch.data.datasets[0].data = topRuns.map((r) => creditsToUsd(r.aiCredits || 0));
      ch.data.datasets[1].data = topRuns.map((r) => r.infraUsd || 0);
    });

  // Per-cluster weekly stacks: cost (AI+infra in USD) and run hours.
  const weeklyByCluster = Array.isArray(data.weeklyByCluster) ? data.weeklyByCluster : [];
  const hasClusterWeeks = weeklyByCluster.some((w) => (w.clusters || []).length > 0);

  setCardEmpty(cards.costByCluster.body, !hasClusterWeeks);
  upsertChart("ov-cost-cluster", cardCanvas(cards.costByCluster.body),
    () => ({ type: "bar", data: { labels: [], datasets: [] }, options: stackedBarOptions() }),
    (ch) => {
      ch.data.labels = weeklyByCluster.map((w) => w.weekStart);
      ch.data.datasets = stackedClusterDatasets(weeklyByCluster,
        (c) => creditsToUsd(c.aiCredits || 0) + (c.infraUsd || 0));
    });

  setCardEmpty(cards.hoursByCluster.body, !hasClusterWeeks);
  upsertChart("ov-hours-cluster", cardCanvas(cards.hoursByCluster.body),
    () => ({ type: "bar", data: { labels: [], datasets: [] }, options: stackedBarOptions() }),
    (ch) => {
      ch.data.labels = weeklyByCluster.map((w) => w.weekStart);
      ch.data.datasets = stackedClusterDatasets(weeklyByCluster,
        (c) => c.hours || 0);
    });
}

/** Shared stacked-bar options (category x, both axes stacked). */
function stackedBarOptions() {
  return baseOptions({
    scales: {
      x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, font: { size: 10 } } },
      y: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
    },
  });
}

/**
 * Turn weeklyByCluster into stacked datasets: one series per cluster,
 * ranked by total value; the top 6 get palette colors, the rest fold
 * into a single "others" series so wide fleets stay readable.
 */
function stackedClusterDatasets(weeklyByCluster, valueFn) {
  const TOP_N = 6;
  const totals = new Map();
  for (const w of weeklyByCluster) {
    for (const c of w.clusters || []) {
      totals.set(c.clusterId, (totals.get(c.clusterId) || 0) + valueFn(c));
    }
  }
  const ranked = Array.from(totals.entries()).sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const top = ranked.slice(0, TOP_N);
  const series = top.map(() => weeklyByCluster.map(() => 0));
  const others = weeklyByCluster.map(() => 0);
  weeklyByCluster.forEach((w, wi) => {
    for (const c of w.clusters || []) {
      const idx = top.indexOf(c.clusterId);
      if (idx >= 0) series[idx][wi] += valueFn(c);
      else others[wi] += valueFn(c);
    }
  });
  const datasets = top.map((id, i) => ({ label: id, data: series[i], backgroundColor: PALETTE[i % PALETTE.length] }));
  if (ranked.length > TOP_N) datasets.push({ label: "others", data: others, backgroundColor: OTHERS_COLOR });
  return datasets;
}

// ---------- Cluster drill-down view -----------------------------------------------------------

let clRefs = null; // { controls, runSelect, livePill, seg, tabs, perfGrid, costGrid, cards }

function ensureClusterDom() {
  if (clRefs && bodyEl.contains(clRefs.controls)) return;
  bodyEl.innerHTML = "";
  destroyCharts();

  // Controls row: back button + name + live pill + run selector + bucket toggle.
  const controls = el("div", "dash-controls");
  const backBtn = el("button", "dash-back", "\u2190 fleet");
  backBtn.type = "button";
  backBtn.title = "Back to fleet overview";
  backBtn.addEventListener("click", gotoOverview);
  const nameEl = el("span", "dash-cluster-name");
  const livePill = el("span", "dash-live-pill");
  const runSelect = el("select", "dash-run-select");
  runSelect.setAttribute("aria-label", "Select run");
  runSelect.addEventListener("change", () => {
    gotoCluster(view.clusterId, runSelect.value);
  });

  const seg = el("div", "dash-seg");
  seg.setAttribute("role", "group");
  seg.setAttribute("aria-label", "Bucket size");
  for (const [label, mins] of [["1m", 1], ["10m", 10], ["1h", 60]]) {
    const b = el("button", null, label);
    b.type = "button";
    b.dataset.mins = String(mins);
    b.classList.toggle("active", mins === bucketSize);
    b.addEventListener("click", () => {
      bucketSize = mins;
      try { localStorage.setItem(BUCKET_KEY, String(mins)); } catch { /* ignore */ }
      for (const bb of seg.querySelectorAll("button")) {
        bb.classList.toggle("active", Number(bb.dataset.mins) === mins);
      }
      if (clusterData) renderCluster();
    });
    seg.appendChild(b);
  }

  controls.appendChild(backBtn);
  controls.appendChild(nameEl);
  controls.appendChild(livePill);
  controls.appendChild(runSelect);
  controls.appendChild(seg);

  // Tabs.
  const tabs = el("div", "dash-tabs");
  for (const [id, label] of [["performance", "Performance"], ["cost", "Cost"]]) {
    const b = el("button", null, label);
    b.type = "button";
    b.dataset.tab = id;
    b.classList.toggle("active", id === activeTab);
    b.addEventListener("click", () => {
      activeTab = id;
      for (const bb of tabs.querySelectorAll("button")) {
        bb.classList.toggle("active", bb.dataset.tab === id);
      }
      clRefs.perfGrid.style.display = id === "performance" ? "" : "none";
      clRefs.costGrid.style.display = id === "cost" ? "" : "none";
      if (clusterData) renderCluster();
    });
    tabs.appendChild(b);
  }

  // Performance grid.
  const perfGrid = el("div", "dash-grid");
  const costGrid = el("div", "dash-grid");
  perfGrid.style.display = activeTab === "performance" ? "" : "none";
  costGrid.style.display = activeTab === "cost" ? "" : "none";

  const cards = {
    // Performance tab
    iterations: makeCard("Iterations over time",
      "Completed agent iterations over the run, totalled per 1m/10m/1h step."),
    files: makeCard("Files created over time",
      "Environment files written over the run, from their S3 timestamps."),
    activeNodes: makeCard("Active nodes over time",
      "Agents active at each point — from their first to their last logged iteration."),
    lifecycle: makeCard("Activity timeline",
      "The run's phases classified from iteration activity; vertical markers are operator actions.", "short"),
    ttfi: makeCard("Time to first iteration per agent (s)",
      "Seconds from run start until each agent completed its first iteration."),
    idleRatio: makeCard("Idle ratio over time (%)",
      "Share of iterations reporting idle — a rising line means the cluster is converging."),
    heatmap: makeCard("Agent activity heatmap",
      "Iterations per agent over time; brighter cells mean a busier agent.", "tall"),
    actionMix: makeCard("Action mix over time",
      "Iterations grouped by reported action: writing, reading, idle, or other."),
    // Cost tab
    costBucket: makeCard("Cost over time (AI vs infra, USD)",
      "Spend accrued at each step: AI credits converted at the overage rate, plus compute."),
    cumulative: makeCard("Cumulative total cost (USD)",
      "Running total of AI + infra spend across the run."),
    costPerAgent: makeCard("Cost per agent over time (USD)",
      "Each agent's AI spend plus its compute share, stacked (top 9, rest as others)."),
    costPerFile: makeCard("Cost per file produced (USD)",
      "Cumulative total cost divided by cumulative files produced."),
    agentCost: makeCard("Per-agent cost ranking (USD)",
      "Whole-run AI + infra spend per agent, most expensive first."),
    share: makeCard("Infra share of total cost (%)",
      "Infra's percentage of the spend at each step — AI is the remainder. Axis auto-scales."),
    burnRate: makeCard("Burn rate ($/h)",
      "Spend at each step scaled to dollars per hour; the dashed line is the flat infra rate."),
  };

  for (const key of ["iterations", "files", "activeNodes", "lifecycle", "ttfi", "idleRatio", "heatmap", "actionMix"]) {
    perfGrid.appendChild(cards[key].card);
  }
  for (const key of ["costBucket", "cumulative", "costPerAgent", "costPerFile", "agentCost", "share", "burnRate"]) {
    costGrid.appendChild(cards[key].card);
  }

  bodyEl.appendChild(controls);
  bodyEl.appendChild(tabs);
  bodyEl.appendChild(perfGrid);
  bodyEl.appendChild(costGrid);

  clRefs = { controls, nameEl, livePill, runSelect, seg, tabs, perfGrid, costGrid, cards };
  fillRunSelect();
}

function fillRunSelect() {
  if (!clRefs || view.kind !== "cluster") return;
  const runs = runsCache.get(view.clusterId) || [];
  const sel = clRefs.runSelect;
  sel.innerHTML = "";
  if (runs.length === 0) {
    // No list yet — keep the current run as the lone option so the control
    // reflects reality while the runs call is in flight.
    const opt = document.createElement("option");
    opt.value = view.runId;
    opt.textContent = view.runId === "current" ? "Current run (live)" : view.runId;
    sel.appendChild(opt);
    return;
  }
  for (const r of runs) {
    const opt = document.createElement("option");
    opt.value = r.runId;
    opt.textContent = r.runId === "current" ? "Current run (live)" : r.runId;
    sel.appendChild(opt);
  }
  sel.value = view.runId;
  if (sel.selectedIndex === -1 && sel.options.length > 0) sel.selectedIndex = 0;
}

function renderCluster() {
  ensureClusterDom();
  const d = clusterData;
  if (!d) return;

  clRefs.nameEl.textContent = d.clusterId || view.clusterId;
  clRefs.livePill.textContent = d.live ? "live" : "archived";
  clRefs.livePill.className = `dash-live-pill ${d.live ? "live" : "archived"}`;
  fillRunSelect();

  const buckets = rebucket(d.buckets || [], bucketSize);
  const labels = buckets.map((b) => hhmm(b.t));
  const agents = Array.isArray(d.agents) ? d.agents : [];
  const { cards } = clRefs;
  const hasBuckets = buckets.length > 0;

  if (activeTab === "performance") {
    renderPerformanceTab(d, buckets, labels, agents, cards, hasBuckets);
  } else {
    renderCostTab(d, buckets, labels, agents, cards, hasBuckets);
  }
}

// ---------- Performance tab -----------------------------------------------------------------

function renderPerformanceTab(d, buckets, labels, agents, cards, hasBuckets) {
  const lineOpts = () => baseOptions({ legend: { display: false } });

  setCardEmpty(cards.iterations.body, !hasBuckets);
  upsertChart("cl-iter", cardCanvas(cards.iterations.body),
    () => ({
      type: "line",
      data: { labels: [], datasets: [{ label: "iterations", data: [], borderColor: THEME.accent(), backgroundColor: THEME.accent(), pointRadius: 0, borderWidth: 1.5, tension: 0.2 }] },
      options: lineOpts(),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = buckets.map((b) => b.iterations || 0);
    });

  setCardEmpty(cards.files.body, !hasBuckets);
  upsertChart("cl-files", cardCanvas(cards.files.body),
    () => ({
      type: "line",
      data: { labels: [], datasets: [{ label: "files", data: [], borderColor: THEME.green(), backgroundColor: THEME.green(), pointRadius: 0, borderWidth: 1.5, tension: 0.2 }] },
      options: lineOpts(),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = buckets.map((b) => b.files || 0);
    });

  setCardEmpty(cards.activeNodes.body, !hasBuckets);
  upsertChart("cl-nodes", cardCanvas(cards.activeNodes.body),
    () => ({
      type: "line",
      data: { labels: [], datasets: [{ label: "active nodes", data: [], borderColor: THEME.blue, backgroundColor: THEME.blue, pointRadius: 0, borderWidth: 1.5, stepped: true }] },
      options: lineOpts(),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = buckets.map((b) => b.activeNodes || 0);
    });

  renderActivityBand(d, buckets, cards.lifecycle.body);

  // Time-to-first-iteration per agent.
  const started = d.startedAt ? new Date(d.startedAt).getTime() : null;
  const ttfi = agents
    .filter((a) => a.firstIterationTs && started != null)
    .map((a) => ({
      agentId: a.agentId,
      seconds: Math.max(0, (new Date(a.firstIterationTs).getTime() - started) / 1000),
    }));
  setCardEmpty(cards.ttfi.body, ttfi.length === 0);
  upsertChart("cl-ttfi", cardCanvas(cards.ttfi.body),
    () => ({
      type: "bar",
      data: { labels: [], datasets: [{ label: "seconds", data: [], backgroundColor: THEME.yellow() }] },
      options: baseOptions({ legend: { display: false } }),
    }),
    (ch) => {
      ch.data.labels = ttfi.map((t) => t.agentId);
      ch.data.datasets[0].data = ttfi.map((t) => Math.round(t.seconds));
    });

  setCardEmpty(cards.idleRatio.body, !hasBuckets);
  upsertChart("cl-idle", cardCanvas(cards.idleRatio.body),
    () => ({
      type: "line",
      data: { labels: [], datasets: [{ label: "idle %", data: [], borderColor: THEME.gray, backgroundColor: THEME.gray, pointRadius: 0, borderWidth: 1.5, tension: 0.2 }] },
      options: baseOptions({
        legend: { display: false },
        scales: {
          x: { grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
          y: { grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true, max: 100 },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = buckets.map((b) =>
        b.iterations > 0 ? Math.round((b.idleIterations / b.iterations) * 1000) / 10 : null);
    });

  renderHeatmap(d, buckets, agents, cards.heatmap.body);

  // Action mix — stacked area.
  setCardEmpty(cards.actionMix.body, !hasBuckets);
  const actionColors = { write: THEME.green(), read: THEME.blue, idle: THEME.gray, other: THEME.accent() };
  upsertChart("cl-actions", cardCanvas(cards.actionMix.body),
    () => ({
      type: "line",
      data: {
        labels: [],
        datasets: ["write", "read", "idle", "other"].map((k) => ({
          label: k, data: [], borderColor: actionColors[k], backgroundColor: actionColors[k] + "66",
          pointRadius: 0, borderWidth: 1, fill: true, tension: 0.2,
        })),
      },
      options: baseOptions({
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
          y: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ["write", "read", "idle", "other"].forEach((k, i) => {
        ch.data.datasets[i].data = buckets.map((b) => (b.actions && b.actions[k]) || 0);
      });
    });
}

/** Activity band — per-bucket classification from data every run has,
 *  so it works for historic runs that predate the transitions log:
 *    starting  (amber) — nodes up, no iterations seen yet
 *    active    (green) — iterations happening
 *    idle-most (gray)  — >50% of the bucket's iterations are "idle"
 *    quiet     (blue)  — nodes active but zero iterations (paused / long iteration)
 *    no nodes  (dark)  — nothing running in the bucket
 *  Operator transitions, when present, are drawn as thin vertical markers
 *  on top so pause/resume/stop clicks stay visible. */
function renderActivityBand(d, buckets, body) {
  let band = body.querySelector(".dash-band");
  if (!band) {
    body.innerHTML = "";
    const empty = el("div", "dash-empty", "no data yet");
    body.appendChild(empty);
    band = el("div", "dash-band");
    const axis = el("div", "dash-band-axis");
    axis.appendChild(el("span", null, ""));
    axis.appendChild(el("span", null, ""));
    const legend = el("div", "dash-band-legend");
    legend.innerHTML = `
      <span><i class="lg-starting"></i>starting</span>
      <span><i class="lg-active"></i>active</span>
      <span><i class="lg-idlemost"></i>mostly idle</span>
      <span><i class="lg-quiet"></i>quiet</span>
      <span><i class="lg-none"></i>no nodes</span>
      <span><i class="lg-marker"></i>operator action</span>
    `;
    body.appendChild(band);
    body.appendChild(axis);
    body.appendChild(legend);
    body.classList.remove("short");
    body.style.height = "auto";
  }

  if (!Array.isArray(buckets) || buckets.length === 0) {
    setCardEmpty(body, true);
    return;
  }
  setCardEmpty(body, false);

  // Classify each displayed bucket.
  const classes = [];
  let seenIterations = false;
  for (const b of buckets) {
    if (!b.activeNodes || b.activeNodes <= 0) {
      classes.push("none");
    } else if ((b.iterations || 0) === 0) {
      classes.push(seenIterations ? "quiet" : "starting");
    } else {
      seenIterations = true;
      classes.push((b.idleIterations || 0) / b.iterations > 0.5 ? "idlemost" : "active");
    }
  }

  // Merge contiguous equal classes into spans (fewer DOM nodes).
  band.innerHTML = "";
  const n = classes.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && classes[j + 1] === classes[i]) j++;
    const span = document.createElement("div");
    span.className = `dash-band-span state-${classes[i]}`;
    span.style.left = `${(i / n) * 100}%`;
    span.style.width = `${((j - i + 1) / n) * 100}%`;
    span.title = `${classes[i] === "idlemost" ? "mostly idle" : classes[i] === "none" ? "no nodes" : classes[i]} ${hhmm(buckets[i].t)}\u2013${hhmm(buckets[j].t)}`;
    band.appendChild(span);
    i = j + 1;
  }

  // Operator transition markers on top (best-effort — sparse for old runs).
  const startMs = new Date(buckets[0].t).getTime();
  const endMs = new Date(buckets[n - 1].t).getTime() + 60_000; // + last bucket
  const total = endMs - startMs;
  const transitions = (Array.isArray(d.transitions) ? d.transitions : [])
    .filter((t) => t && t.ts && t.state);
  for (const t of transitions) {
    const ms = new Date(t.ts).getTime();
    if (!Number.isFinite(ms) || ms < startMs || ms > endMs || total <= 0) continue;
    const marker = document.createElement("div");
    marker.className = "dash-band-marker";
    marker.style.left = `${((ms - startMs) / total) * 100}%`;
    marker.title = `${t.state}${t.reason ? ` (${t.reason})` : ""} by ${t.by || "?"} at ${hhmm(t.ts)}`;
    band.appendChild(marker);
  }

  const axis = body.querySelector(".dash-band-axis");
  axis.children[0].textContent = hhmm(buckets[0].t);
  axis.children[1].textContent = d.live ? "now" : hhmm(buckets[n - 1].t);
}

/** Agent × bucket heatmap — hand-rolled canvas (Chart.js has no heatmap).
 *  Rows = agents, columns = buckets, cell intensity = iteration count. */
function renderHeatmap(d, buckets, agents, body) {
  const rows = agents.filter((a) => Array.isArray(a.iterationsPerBucket));
  setCardEmpty(body, rows.length === 0 || buckets.length === 0);
  if (rows.length === 0 || buckets.length === 0) return;

  let wrap = body.querySelector(".dash-heatmap-wrap");
  if (!wrap) {
    wrap = el("div", "dash-heatmap-wrap");
    wrap.appendChild(document.createElement("canvas"));
    body.insertBefore(wrap, body.firstChild);
  }
  const canvas = wrap.querySelector("canvas");

  const series = rows.map((a) => rebucketAgentSeries(a.iterationsPerBucket, bucketSize));
  const cols = buckets.length;
  let max = 0;
  for (const s of series) for (const v of s) if (v > max) max = v;

  const labelW = 76;
  const rowH = Math.max(14, Math.min(26, Math.floor(220 / rows.length)));
  const axisH = 16;
  const availW = Math.max(120, body.clientWidth - labelW - 4);
  const cellW = Math.max(2, Math.floor(availW / cols));
  const dpr = window.devicePixelRatio || 1;
  const cssW = labelW + cellW * cols;
  const cssH = rowH * rows.length + axisH;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";

  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const accent = THEME.accent();
  g.font = "10px " + cssVar("--mono", "monospace");
  g.textBaseline = "middle";

  for (let r = 0; r < rows.length; r++) {
    // Agent label (canvas text — no DOM interpolation).
    g.fillStyle = cssVar("--text-muted", "#b6bac9");
    g.fillText(rows[r].agentId, 2, r * rowH + rowH / 2, labelW - 6);
    for (let c = 0; c < cols; c++) {
      const v = series[r][c] || 0;
      const alpha = max > 0 ? 0.08 + 0.92 * (v / max) : 0.08;
      g.fillStyle = v > 0 ? hexWithAlpha(accent, alpha) : "rgba(255,255,255,0.04)";
      g.fillRect(labelW + c * cellW, r * rowH + 1, Math.max(1, cellW - 1), rowH - 2);
    }
  }

  // Time axis: first / middle / last bucket labels.
  g.fillStyle = cssVar("--text-muted", "#b6bac9");
  const yAxis = rows.length * rowH + axisH / 2;
  const ticks = [[0, "left"], [Math.floor(cols / 2), "center"], [cols - 1, "right"]];
  for (const [c, align] of ticks) {
    if (c < 0 || c >= cols) continue;
    g.textAlign = align;
    const x = labelW + c * cellW + (align === "left" ? 0 : align === "center" ? cellW / 2 : cellW);
    g.fillText(hhmm(buckets[c].t), x, yAxis);
  }
  g.textAlign = "left";
}

function hexWithAlpha(hex, alpha) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return `rgba(144,70,255,${alpha})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha.toFixed(3)})`;
}

// ---------- Cost tab -----------------------------------------------------------------------

function renderCostTab(d, buckets, labels, agents, cards, hasBuckets) {
  const aiPerBucket = buckets.map((b) => creditsToUsd(b.aiCredits || 0));
  const infraPerBucket = buckets.map((b) => b.infraUsd || 0);

  setCardEmpty(cards.costBucket.body, !hasBuckets);
  upsertChart("cl-costb", cardCanvas(cards.costBucket.body),
    () => ({
      type: "bar",
      data: {
        labels: [],
        datasets: [
          { label: "AI", data: [], backgroundColor: AI_COLOR() },
          { label: "infra", data: [], backgroundColor: INFRA_COLOR() },
        ],
      },
      options: baseOptions({
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
          y: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = aiPerBucket;
      ch.data.datasets[1].data = infraPerBucket;
    });

  // Cumulative stacked area.
  const cumAi = [];
  const cumInfra = [];
  let accAi = 0, accInfra = 0;
  for (let i = 0; i < buckets.length; i++) {
    accAi += aiPerBucket[i];
    accInfra += infraPerBucket[i];
    cumAi.push(accAi);
    cumInfra.push(accInfra);
  }
  setCardEmpty(cards.cumulative.body, !hasBuckets);
  upsertChart("cl-cum", cardCanvas(cards.cumulative.body),
    () => ({
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "AI", data: [], borderColor: AI_COLOR(), backgroundColor: AI_COLOR() + "66", pointRadius: 0, borderWidth: 1, fill: true },
          { label: "infra", data: [], borderColor: INFRA_COLOR(), backgroundColor: INFRA_COLOR() + "66", pointRadius: 0, borderWidth: 1, fill: true },
        ],
      },
      options: baseOptions({
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
          y: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = cumAi;
      ch.data.datasets[1].data = cumInfra;
    });

  // Cost per agent over time — stacked area, top 9 spenders + "others".
  // AI from the per-agent per-bucket credit series; infra approximated as
  // the flat per-agent rate over the agent's active window (first→last
  // iteration), matching how the backend attributes bucket infra cost.
  const bucketStartMs = buckets.map((b) => new Date(b.t).getTime());
  const infraPerAgentBucket = ((d.infraHourlyRatePerAgent || 0) / 60) * bucketSize;
  const perAgentSeries = agents.map((a) => {
    const ai = rebucketAgentSeries(a.aiCreditsPerBucket || [], bucketSize);
    const firstMs = a.firstIterationTs ? new Date(a.firstIterationTs).getTime() : null;
    const lastMs = a.lastIterationTs ? new Date(a.lastIterationTs).getTime() : null;
    const usd = buckets.map((b, i) => {
      const t = bucketStartMs[i];
      const active = firstMs != null && lastMs != null
        && t >= firstMs - bucketSize * 60_000 && t <= lastMs;
      return creditsToUsd(ai[i] || 0) + (active ? infraPerAgentBucket : 0);
    });
    return { agentId: a.agentId, usd, total: usd.reduce((s, v) => s + v, 0) };
  }).sort((a, b) => b.total - a.total);
  const AGENT_TOP_N = 9;
  const topAgents = perAgentSeries.slice(0, AGENT_TOP_N);
  const restAgents = perAgentSeries.slice(AGENT_TOP_N);
  const agentDatasets = topAgents.map((a, i) => ({
    label: a.agentId, data: a.usd,
    borderColor: PALETTE[i % PALETTE.length], backgroundColor: PALETTE[i % PALETTE.length] + "66",
    pointRadius: 0, borderWidth: 1, fill: true, tension: 0.2,
  }));
  if (restAgents.length > 0) {
    const others = buckets.map((_, i) => restAgents.reduce((s, a) => s + a.usd[i], 0));
    agentDatasets.push({
      label: "others", data: others,
      borderColor: OTHERS_COLOR, backgroundColor: OTHERS_COLOR,
      pointRadius: 0, borderWidth: 1, fill: true, tension: 0.2,
    });
  }
  setCardEmpty(cards.costPerAgent.body, !hasBuckets || perAgentSeries.length === 0);
  upsertChart("cl-cpa", cardCanvas(cards.costPerAgent.body),
    () => ({
      type: "line",
      data: { labels: [], datasets: [] },
      options: baseOptions({
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
          y: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets = agentDatasets;
    });

  // Cost per file — cumulative USD / cumulative files.
  setCardEmpty(cards.costPerFile.body, !hasBuckets);
  let cumFiles = 0;
  const costPerFile = buckets.map((b, i) => {
    cumFiles += b.files || 0;
    return cumFiles > 0 ? (cumAi[i] + cumInfra[i]) / cumFiles : null;
  });
  upsertChart("cl-cpf", cardCanvas(cards.costPerFile.body),
    () => ({
      type: "line",
      data: { labels: [], datasets: [{ label: "$/file", data: [], borderColor: THEME.green(), backgroundColor: THEME.green(), pointRadius: 0, borderWidth: 1.5, tension: 0.2, spanGaps: false }] },
      options: baseOptions({ legend: { display: false } }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = costPerFile;
    });

  // Per-agent cost ranking — horizontal stacked, sorted descending.
  const ranked = agents
    .map((a) => ({ agentId: a.agentId, ai: creditsToUsd(a.aiCredits || 0), infra: a.infraUsd || 0 }))
    .sort((a, b) => (b.ai + b.infra) - (a.ai + a.infra));
  setCardEmpty(cards.agentCost.body, ranked.length === 0);
  upsertChart("cl-agents", cardCanvas(cards.agentCost.body),
    () => ({
      type: "bar",
      data: {
        labels: [],
        datasets: [
          { label: "AI", data: [], backgroundColor: AI_COLOR() },
          { label: "infra", data: [], backgroundColor: INFRA_COLOR() },
        ],
      },
      options: baseOptions({
        root: { indexAxis: "y" },
        scales: {
          x: { stacked: true, grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 } }, beginAtZero: true },
          y: { stacked: true, grid: { display: false }, ticks: { color: THEME.tick(), font: { size: 10 } } },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = ranked.map((a) => a.agentId);
      ch.data.datasets[0].data = ranked.map((a) => a.ai);
      ch.data.datasets[1].data = ranked.map((a) => a.infra);
    });

  // Infra share of total cost — a 100% stacked area hides a few-percent
  // infra slice, so this is a single line on an auto-scaled axis instead.
  // The axis ticks keep the real magnitude honest; AI is the remainder.
  setCardEmpty(cards.share.body, !hasBuckets);
  const infraShare = buckets.map((b, i) => {
    const total = aiPerBucket[i] + infraPerBucket[i];
    return total > 0 ? (infraPerBucket[i] / total) * 100 : null;
  });
  upsertChart("cl-share", cardCanvas(cards.share.body),
    () => ({
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "infra %", data: [], borderColor: INFRA_COLOR(), backgroundColor: INFRA_COLOR() + "33", pointRadius: 0, borderWidth: 1.5, tension: 0.2, fill: true, spanGaps: false },
        ],
      },
      options: baseOptions({
        legend: { display: false },
        scales: {
          x: { grid: { color: THEME.grid }, ticks: { color: THEME.tick(), maxRotation: 0, autoSkip: true, font: { size: 10 } } },
          // Auto-scaled: no beginAtZero, no max — the whole point is to
          // let a 1-3% share fill the plot while the ticks say "1-3%".
          y: { grid: { color: THEME.grid }, ticks: { color: THEME.tick(), font: { size: 10 }, callback: (v) => `${v}%` } },
        },
      }),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = infraShare;
    });

  // Burn rate $/h with a dashed flat infra reference line.
  // Bucket USD is a `bucketSize`-minute total → ×(60/bucketSize) = $/h.
  const perHourFactor = 60 / bucketSize;
  const refRate = (d.infraHourlyRatePerAgent || 0) * ((d.config && d.config.concurrency) || 0);
  setCardEmpty(cards.burnRate.body, !hasBuckets);
  upsertChart("cl-burn", cardCanvas(cards.burnRate.body),
    () => ({
      type: "line",
      data: {
        labels: [],
        datasets: [
          { label: "burn rate", data: [], borderColor: THEME.red(), backgroundColor: THEME.red(), pointRadius: 0, borderWidth: 1.5, tension: 0.2 },
          { label: "infra baseline", data: [], borderColor: THEME.gray, borderDash: [5, 4], pointRadius: 0, borderWidth: 1, fill: false },
        ],
      },
      options: baseOptions(),
    }),
    (ch) => {
      ch.data.labels = labels;
      ch.data.datasets[0].data = buckets.map((b, i) => (aiPerBucket[i] + infraPerBucket[i]) * perHourFactor);
      ch.data.datasets[1].data = buckets.map(() => refRate);
    });
}

// ---------- Public API -----------------------------------------------------------------------

const api = {
  /**
   * Open the overlay. params (optional): { cluster, run } deep-enters the
   * drill-down; otherwise the fleet overview is shown.
   * shellCtx: { showError, showInfo } from shell.js.
   */
  open(params, shellCtx) {
    if (shellCtx) shell = shellCtx;
    if (!root) buildOverlay();
    const saved = parseInt(localStorage.getItem(BUCKET_KEY) || "", 10);
    if ([1, 10, 60].includes(saved)) bucketSize = saved;

    root.classList.add("visible");
    isOpen = true;

    escHandler = (e) => { if (e.key === "Escape") api.close(); };
    document.addEventListener("keydown", escHandler);

    if (params && params.cluster) gotoCluster(params.cluster, params.run || "current");
    else gotoOverview();
  },

  close() {
    isOpen = false;
    stopPolling();
    fetchSeq++; // invalidate in-flight fetches
    if (escHandler) {
      document.removeEventListener("keydown", escHandler);
      escHandler = null;
    }
    if (root) root.classList.remove("visible");
  },
};

export default api;
