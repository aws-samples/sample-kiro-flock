/* ============================================================================
   Kiro Node section — per-agent console + ACP stream drill-down. LIVE.

   Opened by clicking an agent panel in Single Cluster
   (ctx.openSection("kiro-node", { cluster, agentIndex })), or directly
   via its accordion rail (then the cluster/agent selectors pick the
   target).

   Layout: top half = Directions (left: cluster direction + per-agent
   directive previews with show-all popups) beside the journald console
   tail (right); bottom half = Kiro CLI ACP session tail (markdown) with
   an iteration dropdown (live follow, or any past iteration's session).
   Draggable divider between top and bottom.

   Data sources:
     GET cluster/agent-stream/{cluster}?agentIndex=N&kind=console|acp
       [&sessionId=ID] — one SSM tail command per fetch. sessionId pins
       the ACP pane to a specific past iteration's session.
     GET cluster/agent-stream/{cluster}?agentIndex=N&kind=acp-list
       — iteration/session list for the dropdown (also one SSM command,
       so it's fetched on retarget and lazily on session rollover, never
       on the 10s tick).
     GET cluster/direction/{cluster} + cluster/agent-directive — cheap
       S3 reads, refreshed on the tick.

   This module keeps the SSM fan-out honest: each stream pane refreshes
   every 10s, ONLY while this section is the open accordion item, and
   never issues a fetch while the previous one for that pane is still in
   flight. Pause buttons per pane. A pinned (non-live) ACP pane does not
   auto-refresh at all — completed sessions don't change.
   ============================================================================ */

import { parseInterruptedResult, renderErrorInline } from "../errorFormat.js";

let ctx = null;
let rootEl = null;
let contextEl = null;

let currentCluster = null;   // null until scoped
let currentAgentIndex = 0;
let visible = false;

// Bumped on every retarget so in-flight responses for the old agent are
// discarded instead of rendered into the new agent's panes.
let generation = 0;

const REFRESH_MS = 10000;

const esc = (s) => s == null ? "" : String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/* Turn-error unfold state, keyed by session id so an expanded "more" survives
   the 10s auto-refresh that replaces the pane's innerHTML. */
const _knErrExpanded = new Set();

const cssEscape = (s) =>
  (typeof CSS !== "undefined" && typeof CSS.escape === "function")
    ? CSS.escape(s)
    : String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);

/* ---------- Per-pane stream state --------------------------------------------- */

function makePane(kind) {
  return {
    kind,
    bodyEl: null,       // scroll container
    metaEl: null,       // pane-bar meta text
    pauseBtn: null,
    refreshBtn: null,
    timer: null,
    inFlight: false,
    paused: false,
    hasContent: false,
  };
}

const panes = {
  console: makePane("console"),
  acp: makePane("acp"),
};

/* ---------- Iteration (session) selection state -------------------------------
   "live" follows the active session (original behaviour). A session id
   pins the ACP pane to that iteration; pinned panes fetch once and skip
   the auto-refresh tick. The list itself costs one SSM round trip, so it
   refreshes only on retarget and when the live tail reports a session id
   we haven't seen (iteration rollover). */

const iterState = {
  sessions: [],        // AcpSessionInfo[], sorted iteration ascending
  selected: "live",    // "live" | sessionId
  fetching: false,
  unavailable: null,
};

/* ---------- Iteration cost state -----------------------------------------------
   Per-iteration credit spend, from GET cluster/agent-costs (one cheap S3
   read, fetched on retarget and lazily on iteration rollover — never on
   the 10s tick). Dollars are credits × the overage rate; the hover title
   on every cost chip says "overage cost". */

const OVERAGE_RATE = 0.04; // $ per credit

const costState = {
  bySession: new Map(),   // sessionId → credits (measured only)
  byIteration: new Map(), // iteration → credits (fallback when session ids drift)
  unmeteredSessions: new Set(), // sessionId of iterations that recorded no credits
  unmeteredIterations: new Set(),
  total: null,            // agent lifetime MEASURED credits, or null when unknown
  fetching: false,
  lastAcpSessionId: null, // session currently shown in the ACP pane
};

function fmtCost(credits) {
  const dollars = credits * OVERAGE_RATE;
  return `ai[${credits.toFixed(2)} cr, $${dollars.toFixed(2)}]`;
}

function costForSession(sessionId) {
  if (sessionId && costState.bySession.has(sessionId)) {
    return costState.bySession.get(sessionId);
  }
  return null;
}

/* ---------- Estimating unmetered iterations -------------------------------------
   An interrupted turn never completes, so kiro-cli records no metering for it
   and the credits are permanently unknowable — not merely late. They were
   nonetheless spent, so showing nothing understates the agent's cost.

   We estimate from the iterations we DID measure. A flat per-iteration average
   is badly biased here: interrupted iterations die early and so are much smaller
   than successful ones, and applying the mean of the large to the small
   overshoots (measured ~4x high on the greenthumb data). Scaling by session
   size is both unbiased in that respect and tighter — on the same sample,
   credits-per-iteration spread 5.4x while credits-per-byte spread 1.9x.

   Session sizes come from the iteration list, which we already hold, so this
   costs no extra request. Estimates are computed here and never persisted:
   S3 keeps measurements only. */

function sizeForSession(sessionId) {
  const s = iterState.sessions.find((x) => x.sessionId === sessionId);
  return s && typeof s.sizeBytes === "number" ? s.sizeBytes : null;
}

/** Credits per byte across measured iterations, or null when there is nothing
 *  to learn from (no measurements yet, or no sizes for them). */
function creditsPerByte() {
  let credits = 0;
  let bytes = 0;
  for (const [sessionId, c] of costState.bySession) {
    const size = sizeForSession(sessionId);
    if (size != null && size > 0 && typeof c === "number") {
      credits += c;
      bytes += size;
    }
  }
  return bytes > 0 ? credits / bytes : null;
}

/** Flat mean credits per measured iteration — fallback when sizes are absent. */
function meanCreditsPerIteration() {
  const values = [...costState.bySession.values()].filter((c) => typeof c === "number");
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Estimated credits for an unmetered session, or null when inestimable. */
function estimateForSession(sessionId) {
  const rate = creditsPerByte();
  const size = sizeForSession(sessionId);
  if (rate != null && size != null && size > 0) return rate * size;
  return meanCreditsPerIteration();
}

/** Is this session known to have run without producing a cost reading? */
function isUnmetered(session) {
  if (costState.unmeteredSessions.has(session.sessionId)) return true;
  if (session.exact && costState.unmeteredIterations.has(session.iteration)) return true;
  return false;
}

/** Sum of estimates for every unmetered iteration in the current list. */
function totalEstimatedCredits() {
  let sum = 0;
  for (const s of iterState.sessions) {
    if (!isUnmetered(s)) continue;
    const est = estimateForSession(s.sessionId);
    if (est != null) sum += est;
  }
  return sum;
}

function renderAcpCost() {
  const el = rootEl ? rootEl.querySelector("[data-kn-cost]") : null;
  if (!el) return;
  const sessionId = costState.lastAcpSessionId;
  const credits = costForSession(sessionId);
  if (credits != null) {
    el.textContent = fmtCost(credits);
    el.title = "AI overage cost for this iteration (measured)";
    el.style.display = "";
    return;
  }
  // No reading. Either the iteration was interrupted (permanently unmetered,
  // so estimate) or it is still running / predates cost tracking (say nothing).
  const session = iterState.sessions.find((x) => x.sessionId === sessionId);
  if (session && isUnmetered(session)) {
    const est = estimateForSession(sessionId);
    el.textContent = est != null
      ? `ai[~${est.toFixed(2)} cr, ~$${(est * OVERAGE_RATE).toFixed(2)} est]`
      : "ai[interrupted, unmetered]";
    el.title = est != null
      ? "This iteration's turn was interrupted before completing, so kiro-cli recorded no credits. The work it did still cost credits; this figure is estimated from measured iterations, scaled by session size."
      : "This iteration's turn was interrupted before completing, so kiro-cli recorded no credits. No measured iterations yet to estimate from.";
    el.style.display = "";
    return;
  }
  el.textContent = "";
  el.style.display = "none";
}

async function refreshCosts() {
  if (!currentCluster || costState.fetching) return;
  costState.fetching = true;
  const gen = generation;
  try {
    const url = `cluster/agent-costs/${encodeURIComponent(currentCluster)}`
      + `?agentIndex=${encodeURIComponent(currentAgentIndex)}`;
    const res = await fetch(url);
    if (gen !== generation || !res.ok) return;
    const data = await res.json();
    if (gen !== generation) return;
    costState.bySession = new Map();
    costState.byIteration = new Map();
    costState.unmeteredSessions = new Set();
    costState.unmeteredIterations = new Set();
    for (const e of (Array.isArray(data.entries) ? data.entries : [])) {
      // Unmetered entries carry no credits — record them separately so the
      // display can distinguish "interrupted, cost unknowable" from "no record
      // at all", which used to look identical (a blank label).
      if (e.unmetered || typeof e.credits !== "number") {
        if (e.sessionId) costState.unmeteredSessions.add(e.sessionId);
        costState.unmeteredIterations.add(e.iteration);
        continue;
      }
      if (e.sessionId) costState.bySession.set(e.sessionId, e.credits);
      costState.byIteration.set(e.iteration, e.credits);
    }
    costState.total = typeof data.totalCredits === "number" ? data.totalCredits : null;
    renderAcpCost();
    renderIterOptions();
    renderNodeCost();
  } catch { /* keep the current map */ } finally {
    costState.fetching = false;
  }
  refreshNodeInfra();
}

/* ---------- Node-level cost (header chip) --------------------------------------
   This agent's lifetime AI credits (costState.total) plus its current-run
   infra cost, plucked from the cluster snapshot's per-agent infraCostUsd.
   Rendered next to the cluster · agent identity in the header. */

const nodeCostState = { infra: null, fetching: false };

/* ---------- Per-agent model override ------------------------------------------
   This node's model when it differs from the cluster baseline. Read from the
   same cluster/status response that feeds the infra cost — the snapshot
   embeds the whole config, so `config.models` arrives with no extra request.

   `override` is three-state, matching the config semantics: undefined means
   this agent has no override and follows the cluster model (no pill), null
   means it is explicitly pinned to kiro-cli's own default, and a string is a
   model id. Absent and null are different settings, so the render can't use
   a falsy check. */

const nodeModelState = { override: undefined, catalog: new Map(), fetching: false };

/** Pull the model catalog once per mount so the pill can show a display name
 *  rather than a raw id. Cached 5 minutes server-side; failure just means the
 *  pill falls back to the id. */
async function loadNodeModelCatalog() {
  if (nodeModelState.fetching || nodeModelState.catalog.size > 0) return;
  nodeModelState.fetching = true;
  try {
    const res = await fetch("cluster/models");
    if (!res.ok) return;
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    nodeModelState.catalog = new Map(
      models.filter((m) => m && m.model_id).map((m) => [m.model_id, m]),
    );
    renderNodeModel();
  } catch { /* pill falls back to the raw id */ } finally {
    nodeModelState.fetching = false;
  }
}

function readModelOverride(config, agentIndex) {
  const overrides = config && config.models;
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) return undefined;
  const key = String(agentIndex);
  if (!Object.prototype.hasOwnProperty.call(overrides, key)) return undefined;
  const value = overrides[key];
  return value === null || typeof value === "string" ? value : undefined;
}

function renderNodeModel() {
  const el = rootEl ? rootEl.querySelector("[data-kn-node-model]") : null;
  if (!el) return;
  const model = nodeModelState.override;
  if (model === undefined) {
    el.style.display = "none";
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  if (model === null) {
    el.textContent = "default";
    el.title = "model override \u2014 this agent is pinned to kiro-cli's own default, ignoring the cluster model";
  } else {
    const entry = nodeModelState.catalog.get(model);
    const name = entry && entry.model_name ? entry.model_name : model;
    el.textContent = name;
    const parts = [`model override \u2014 ${model}`];
    if (entry && entry.model_name && entry.model_name !== model) parts.push(entry.model_name);
    if (entry && entry.description) parts.push(entry.description);
    el.title = parts.join("\n");
  }
  el.style.display = "";
}

async function refreshNodeInfra() {
  if (!currentCluster || nodeCostState.fetching) return;
  nodeCostState.fetching = true;
  const gen = generation;
  try {
    const res = await fetch(`cluster/status/${encodeURIComponent(currentCluster)}`);
    if (gen !== generation || !res.ok) return;
    const snap = await res.json();
    if (gen !== generation) return;
    const agent = Array.isArray(snap.agents)
      ? snap.agents.find((a) => a && a.agentId === `agent-${currentAgentIndex}`)
      : null;
    nodeCostState.infra = agent && typeof agent.infraCostUsd === "number" ? agent.infraCostUsd : null;
    renderNodeCost();
    // Same response, no extra request: the snapshot carries the cluster config.
    nodeModelState.override = readModelOverride(snap.config, currentAgentIndex);
    renderNodeModel();
  } catch { /* keep the current value */ } finally {
    nodeCostState.fetching = false;
  }
}

function renderNodeCost() {
  const el = rootEl ? rootEl.querySelector("[data-kn-node-cost]") : null;
  if (!el) return;
  const parts = [];
  if (typeof costState.total === "number") {
    // The measured total is shown unchanged. Any unmetered iterations are added
    // as a separate, clearly-marked estimate rather than folded in, so the
    // authoritative number stays legible — but the total no longer reads as
    // complete when it is only a floor.
    const estimated = totalEstimatedCredits();
    if (estimated > 0) {
      const unmeteredCount = iterState.sessions.filter((s) => isUnmetered(s)).length;
      parts.push(`${fmtCost(costState.total)} +~${estimated.toFixed(2)} cr est`);
      el.title = `${costState.total.toFixed(2)} credits measured. `
        + `${unmeteredCount} iteration${unmeteredCount === 1 ? " was" : "s were"} interrupted before completing, so `
        + `${unmeteredCount === 1 ? "it recorded" : "they recorded"} no credits; `
        + `~${estimated.toFixed(2)} credits estimated from measured iterations, scaled by session size.`;
    } else {
      parts.push(fmtCost(costState.total));
      el.title = "AI overage cost for this agent (measured)";
    }
  }
  if (typeof nodeCostState.infra === "number" && nodeCostState.infra > 0) {
    parts.push(`infra[$${nodeCostState.infra < 0.01 ? nodeCostState.infra.toFixed(4) : nodeCostState.infra.toFixed(2)}]`);
  }
  if (parts.length === 0) {
    el.style.display = "none";
    return;
  }
  el.textContent = parts.join(" / ");
  el.style.display = "";
}

/* ---------- Directions state --------------------------------------------------
   Cluster direction + per-agent directive, previewed in the top-left
   pane with show-all popups. Cheap S3 GETs — refreshed on the tick. */

const dirState = {
  direction: null,      // string | null (null = not loaded yet)
  directive: undefined, // string | null | undefined (undefined = not loaded, null = none set)
  fetching: false,
};

function paneEmptyState(pane, message, tone) {
  pane.hasContent = false;
  pane.bodyEl.innerHTML = `
    <div class="kn-placeholder">
      <div class="kn-placeholder-icon">${pane.kind === "console" ? "&#9636;" : "&#10148;"}</div>
      <div${tone === "error" ? ' style="color:var(--red)"' : ""}>${esc(message)}</div>
    </div>`;
}

// Tail semantics: keep the view pinned to the newest output unless the
// operator has scrolled up to read something.
function isAtBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
}

/* ---------- Console formatting ------------------------------------------------ */

// journald short-iso: "2026-07-15T19:33:37+0000 host unit[pid]: message"
const CONSOLE_LINE_RE = /^(\S+)\s+(\S+)\s+([^\s:[]+)(?:\[(\d+)\])?:\s?(.*)$/;

// First match wins — order by urgency.
const CONSOLE_SEV_RULES = [
  ["err",  /\b(error|errors|fail|failed|failure|fatal|exception|denied|panic|timed?\s?out)\b/i],
  ["warn", /\b(warn|warning|deprecat\w*|retry(?:ing)?|rate.?limit\w*|throttl\w*)\b/i],
  ["ok",   /\b(started|success|succeeded|deployed|completed?|listening|ready|healthy)\b/i],
  ["info", /\b(iteration|autopause|direction)\b/i],
];

function classifyConsoleLine(msg) {
  for (const [sev, re] of CONSOLE_SEV_RULES) {
    if (re.test(msg)) return sev;
  }
  return "";
}

function renderConsoleHtml(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const m = CONSOLE_LINE_RE.exec(line);
    if (!m) {
      // Continuation / unparseable line: keep it, dimmed and indented.
      out.push(`<div class="kn-cline"><span class="kn-cline-msg kn-cline-msg--cont">${esc(line)}</span></div>`);
      continue;
    }
    const ts = m[1], unit = m[3], msg = m[5];
    const tMatch = /T(\d\d:\d\d:\d\d)/.exec(ts);
    const shortTs = tMatch ? tMatch[1] : ts;
    const sev = classifyConsoleLine(msg);
    out.push(
      `<div class="kn-cline${sev ? ` kn-cline--${sev}` : ""}">`
      + `<span class="kn-cline-ts">${esc(shortTs)}</span>`
      + `<span class="kn-cline-src">${esc(unit)}</span>`
      + `<span class="kn-cline-msg">${esc(msg)}</span>`
      + `</div>`,
    );
  }
  return `<div class="kn-console">${out.join("")}</div>`;
}

/* ---------- ACP compact rendering ---------------------------------------------
   The Lambda formatter emits markdown with "### Prompt", "### Agent
   Response", "### Tool Call: <name>" and "### Tool Result" headings. We
   re-shape that into: emphasized response prose, and one collapsed
   <details> row per tool call paired with its following result. Falls
   back to plain markdown when the structure isn't recognisable. */

function mdToHtml(mdText) {
  if (typeof marked !== "undefined" && marked.parse) return marked.parse(mdText);
  return `<pre class="kn-console-pre">${esc(mdText)}</pre>`;
}

function clip(s, n) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
}

function parseAcpBlocks(md) {
  const blocks = [];
  let current = { type: "leading", toolName: null, lines: [] };
  for (const line of md.split("\n")) {
    const h = /^###\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(current);
      const title = h[1].trim();
      const tool = /^Tool Call:\s*(.+)$/i.exec(title);
      current = {
        type: tool ? "toolCall"
          : /^Tool Result$/i.test(title) ? "toolResult"
          : /^Agent Response$/i.test(title) ? "response"
          : /^Prompt$/i.test(title) ? "prompt"
          : "other",
        toolName: tool ? tool[1].trim() : null,
        lines: [],
      };
    } else {
      current.lines.push(line);
    }
  }
  blocks.push(current);
  return blocks.filter((b) => b.type !== "leading" || b.lines.join("").trim());
}

/** Pull the contents of the first fenced code block, or the raw text. */
function extractFenced(lines) {
  const text = lines.join("\n");
  const m = /```(?:json)?\n([\s\S]*?)\n?```/.exec(text);
  return m ? m[1] : text.trim();
}

const TOOL_HINT_KEYS = [
  "path", "key", "file", "url", "command", "stackName", "name",
  "summary", "__tool_use_purpose", "query", "prompt",
];

function toolInputHint(raw) {
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return "";
    for (const k of TOOL_HINT_KEYS) {
      if (typeof obj[k] === "string" && obj[k].trim()) return `${k}: ${obj[k]}`;
    }
    const keys = Object.keys(obj);
    if (keys.length === 0) return "";
    const v = typeof obj[keys[0]] === "string" ? obj[keys[0]] : JSON.stringify(obj[keys[0]]);
    return `${keys[0]}: ${v}`;
  } catch {
    return raw;
  }
}

function toolResultPreview(raw) {
  let isError = /"isError"\s*:\s*true/.test(raw);
  let text = raw;
  try {
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.content)) {
      text = obj.content
        .map((c) => (typeof c.text === "string" ? c.text : (typeof c.data === "string" ? c.data : "")))
        .filter(Boolean)
        .join(" ");
    }
    if (obj && obj.isError === true) isError = true;
  } catch { /* keep raw text */ }
  return { preview: text, isError };
}

function renderAcpHtml(md) {
  const blocks = parseAcpBlocks(md);
  if (!blocks.some((b) => b.type !== "leading" && b.type !== "other")) return null;

  const parts = [];
  const keyCounts = {};
  const nextKey = (base) => {
    keyCounts[base] = (keyCounts[base] || 0) + 1;
    return `${base}#${keyCounts[base]}`;
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];

    if (b.type === "toolCall") {
      let result = null;
      if (blocks[i + 1] && blocks[i + 1].type === "toolResult") {
        result = blocks[i + 1];
        i++;
      }
      const hint = clip(toolInputHint(extractFenced(b.lines)), 90);
      let preview = "";
      let isError = false;
      if (result) {
        const r = toolResultPreview(extractFenced(result.lines));
        preview = clip(r.preview, 120);
        isError = r.isError;
      }
      const key = nextKey(`${b.toolName}|${hint.slice(0, 40)}`);
      const status = result
        ? (preview ? `<span class="kn-tool-preview${isError ? " kn-tool-preview--error" : ""}">${isError ? "&#10007;" : "&#8594;"} ${esc(preview)}</span>` : "")
        : `<span class="kn-tool-preview kn-tool-preview--pending">&#8230; running</span>`;
      parts.push(
        `<details class="kn-tool${isError ? " kn-tool--error" : ""}" data-key="${esc(key)}">`
        + `<summary class="kn-tool-summary">`
        + `<span class="kn-tool-chev">&#9656;</span>`
        + `<span class="kn-tool-name">${esc(b.toolName)}</span>`
        + (hint ? `<span class="kn-tool-hint">${esc(hint)}</span>` : "")
        + status
        + `</summary>`
        + `<div class="kn-tool-body kn-md">`
        + `<div class="kn-tool-body-label">input</div>${mdToHtml(b.lines.join("\n"))}`
        + (result ? `<div class="kn-tool-body-label">result</div>${mdToHtml(result.lines.join("\n"))}` : "")
        + `</div></details>`,
      );
    } else if (b.type === "toolResult") {
      // Orphan result — its call fell outside the tail window.
      const r = toolResultPreview(extractFenced(b.lines));
      const key = nextKey("orphan-result");
      parts.push(
        `<details class="kn-tool${r.isError ? " kn-tool--error" : ""}" data-key="${esc(key)}">`
        + `<summary class="kn-tool-summary">`
        + `<span class="kn-tool-chev">&#9656;</span>`
        + `<span class="kn-tool-name">tool result</span>`
        + `<span class="kn-tool-preview${r.isError ? " kn-tool-preview--error" : ""}">${r.isError ? "&#10007;" : "&#8594;"} ${esc(clip(r.preview, 120))}</span>`
        + `</summary>`
        + `<div class="kn-tool-body kn-md">${mdToHtml(b.lines.join("\n"))}</div>`
        + `</details>`,
      );
    } else if (b.type === "response") {
      parts.push(`<div class="kn-acp-response"><div class="kn-md">${mdToHtml(b.lines.join("\n"))}</div></div>`);
    } else if (b.type === "prompt") {
      const n = b.lines.filter((l) => l.trim()).length;
      parts.push(
        `<details class="kn-tool kn-tool--prompt" data-key="${esc(nextKey("prompt"))}">`
        + `<summary class="kn-tool-summary">`
        + `<span class="kn-tool-chev">&#9656;</span>`
        + `<span class="kn-tool-name">prompt</span>`
        + `<span class="kn-tool-hint">${n} lines</span>`
        + `</summary>`
        + `<div class="kn-tool-body kn-md">${mdToHtml(b.lines.join("\n"))}</div>`
        + `</details>`,
      );
    } else {
      // leading / other: partial text at the tail cut boundary.
      parts.push(`<div class="kn-acp-leading">&#8230; ${esc(clip(b.lines.join(" "), 160))}</div>`);
    }
  }
  return `<div class="kn-acp">${parts.join("")}</div>`;
}

/* ---------- Pane rendering ----------------------------------------------------- */

// Iteration-boundary hint: shown while the new session file exists but
// has no formattable entries yet (see agentStream.ts "empty so far").
function setAcpBanner(pane, text) {
  let banner = pane.bodyEl.querySelector(".kn-acp-banner");
  if (!text) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.className = "kn-acp-banner";
    pane.bodyEl.prepend(banner);
  }
  banner.textContent = text;
}

function updatePaneMeta(pane, result) {
  const t = result.fetchedAt ? new Date(result.fetchedAt) : new Date();
  const hh = String(t.getHours()).padStart(2, "0");
  const mm = String(t.getMinutes()).padStart(2, "0");
  const ss = String(t.getSeconds()).padStart(2, "0");
  let meta = `fetched ${hh}:${mm}:${ss}`;
  if (pane.kind === "acp" && result.sessionId) {
    const kb = result.sessionSizeBytes != null ? ` \u00b7 ${(result.sessionSizeBytes / 1024).toFixed(1)}KB` : "";
    let label = result.sessionStatus === "active" ? "live session" : "last session";
    if (iterState.selected !== "live") {
      const s = iterState.sessions.find((x) => x.sessionId === result.sessionId);
      label = s ? `iteration ${s.iteration}` : "pinned session";
    }
    meta = `${label}${kb} \u00b7 ${meta}`;
  }
  pane.metaEl.textContent = meta;
  if (pane.kind === "acp") {
    costState.lastAcpSessionId = result.sessionId || null;
    renderAcpCost();
  }
}

function renderPaneContent(pane, result) {
  const stick = pane.hasContent ? isAtBottom(pane.bodyEl) : true;
  const prevScroll = pane.bodyEl.scrollTop;

  if (!result.content) {
    // Active-but-empty ACP session: kiro-cli just created the next
    // iteration's .jsonl but hasn't flushed the prompt yet. Keep the
    // previous session's content on screen with a hint instead of
    // blanking the pane at every iteration boundary.
    if (pane.kind === "acp" && pane.hasContent && result.sessionStatus === "active") {
      setAcpBanner(pane, "new iteration starting\u2026");
      updatePaneMeta(pane, result);
      return;
    }
    paneEmptyState(pane, result.unavailable || "No output yet.");
  } else if (pane.kind === "console") {
    pane.bodyEl.innerHTML = renderConsoleHtml(result.content);
    pane.hasContent = true;
  } else {
    // ACP tail arrives as markdown from the Lambda formatter. Compact
    // it into collapsible tool rows; carry expanded rows across the
    // refresh; fall back to plain markdown if the structure changed.
    const openKeys = new Set(
      [...pane.bodyEl.querySelectorAll("details[open][data-key]")].map((d) => d.dataset.key),
    );
    // The Lambda appends the raw turn error to the transcript markdown AND
    // exposes it as result.turnError. Strip the appended block and render
    // the error classified instead: badge + one-line cause, raw blob
    // behind a "more" unfold. Falls back to leaving the markdown intact
    // when the parse yields nothing.
    let content = result.content;
    let turnErrHtml = "";
    if (result.turnError) {
      const parsed = parseInterruptedResult(result.turnError);
      if (parsed) {
        const blockIdx = content.lastIndexOf("\n\n---\n\n**Iteration interrupted**");
        if (blockIdx >= 0) content = content.slice(0, blockIdx);
        else if (content.startsWith("---\n\n**Iteration interrupted**")) content = "";
        const key = `kn|${result.sessionId || "live"}`;
        turnErrHtml = `<div class="kn-turn-error">`
          + `<div class="kn-turn-error-head">Iteration interrupted</div>`
          + renderErrorInline(parsed, key, _knErrExpanded.has(key))
          + `</div>`;
      }
    }
    const compact = renderAcpHtml(content);
    if (compact) {
      pane.bodyEl.innerHTML = compact + turnErrHtml;
      if (openKeys.size) {
        for (const d of pane.bodyEl.querySelectorAll("details[data-key]")) {
          if (openKeys.has(d.dataset.key)) d.open = true;
        }
      }
    } else if (typeof marked !== "undefined" && marked.parse) {
      pane.bodyEl.innerHTML = `<div class="kn-md">${marked.parse(content)}</div>` + turnErrHtml;
    } else {
      pane.bodyEl.innerHTML = `<pre class="kn-console-pre">${esc(content)}</pre>` + turnErrHtml;
    }
    pane.hasContent = true;
  }

  if (pane.hasContent) {
    pane.bodyEl.scrollTop = stick ? pane.bodyEl.scrollHeight : prevScroll;
  }
  updatePaneMeta(pane, result);
}

async function fetchPane(pane, opts) {
  // force: an explicit operator action (iteration switch) still fetches
  // once while auto-refresh is paused.
  const force = opts && opts.force;
  if (!visible || pane.inFlight || (pane.paused && !force) || !currentCluster) return;
  pane.inFlight = true;
  pane.refreshBtn.classList.add("kn-btn--busy");
  const gen = generation;
  try {
    const pinned = pane.kind === "acp" && iterState.selected !== "live";
    let url = `cluster/agent-stream/${encodeURIComponent(currentCluster)}`
      + `?agentIndex=${encodeURIComponent(currentAgentIndex)}&kind=${pane.kind}`;
    if (pinned) url += `&sessionId=${encodeURIComponent(iterState.selected)}`;
    const res = await fetch(url);
    if (gen !== generation) return; // retargeted mid-flight — drop it
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({}));
      paneEmptyState(pane, errBody.error || `fetch failed: ${res.status}`, "error");
      pane.metaEl.textContent = "error";
      ctx.topbar.setIndicator("error");
      return;
    }
    const result = await res.json();
    if (gen !== generation) return;
    renderPaneContent(pane, result);
    ctx.topbar.setIndicator("success");
    // Iteration rollover: the live tail moved to a session the dropdown
    // doesn't know about yet — refresh the list lazily.
    if (pane.kind === "acp" && !pinned && result.sessionId
        && !iterState.sessions.some((s) => s.sessionId === result.sessionId)) {
      refreshIterations();
      // A new session means the previous iteration just completed — its
      // cost line is in S3 now. Refresh lazily, same cadence as the list.
      refreshCosts();
    }
  } catch (err) {
    if (gen !== generation) return;
    paneEmptyState(pane, `fetch failed: ${err.message || err}`, "error");
    pane.metaEl.textContent = "error";
    ctx.topbar.setIndicator("error");
  } finally {
    pane.inFlight = false;
    pane.refreshBtn.classList.remove("kn-btn--busy");
    // The operator retargeted while this fetch was in flight: the
    // response above was discarded, and the retarget's own fetch was
    // skipped by the inFlight guard. Fire the follow-up now instead of
    // leaving "loading…" on screen until the next 10s tick. Rapid
    // switching stays serialized — at most one trailing refetch.
    if (gen !== generation && visible && !pane.paused && currentCluster) {
      fetchPane(pane);
    }
  }
}

let dirTimer = null;

function startPaneTimers() {
  for (const pane of Object.values(panes)) {
    if (pane.timer == null) {
      pane.timer = setInterval(() => {
        // A pinned ACP pane is a completed session — nothing to poll.
        if (pane.kind === "acp" && iterState.selected !== "live") return;
        fetchPane(pane);
      }, REFRESH_MS);
    }
  }
  if (dirTimer == null) {
    dirTimer = setInterval(() => refreshDirections(), REFRESH_MS);
  }
}

function stopPaneTimers() {
  for (const pane of Object.values(panes)) {
    if (pane.timer != null) {
      clearInterval(pane.timer);
      pane.timer = null;
    }
  }
  if (dirTimer != null) {
    clearInterval(dirTimer);
    dirTimer = null;
  }
}

function fetchBoth() {
  fetchPane(panes.console);
  fetchPane(panes.acp);
}

/* ---------- Iteration dropdown ------------------------------------------------- */

function iterSelectEl() {
  return rootEl ? rootEl.querySelector("[data-kn-iter]") : null;
}

function renderIterOptions() {
  const sel = iterSelectEl();
  if (!sel) return;
  const opts = [`<option value="live"${iterState.selected === "live" ? " selected" : ""}>live (follow)</option>`];
  // Newest first in the dropdown — the recent past is what operators reach for.
  const sessions = [...iterState.sessions].sort((a, b) => b.iteration - a.iteration);
  for (const s of sessions) {
    const t = new Date(s.mtime * 1000);
    const hh = String(t.getHours()).padStart(2, "0");
    const mm = String(t.getMinutes()).padStart(2, "0");
    const approx = s.exact ? "" : "~";
    // Prefer the session-id match; fall back to the iteration number only
    // when the marker is exact (approximate ordinals can misattribute).
    let credits = costForSession(s.sessionId);
    if (credits == null && s.exact && costState.byIteration.has(s.iteration)) {
      credits = costState.byIteration.get(s.iteration);
    }
    // Three distinct states, where there used to be two (a figure, or a blank
    // that meant any of interrupted / unrecorded / still-running):
    //   measured    → $0.36
    //   unmetered   → interrupted ~$0.03 est
    //   unknown     → nothing (live iteration, or predates cost tracking)
    //
    // "interrupted", not "failed": these iterations did real work — one of them
    // ran for 12 minutes and produced 451KB of conversation before its turn was
    // cut off. What they lack is a completed turn, and so a cost reading.
    let costLabel = "";
    if (credits != null) {
      costLabel = ` \u00b7 $${(credits * OVERAGE_RATE).toFixed(2)}`;
    } else if (isUnmetered(s)) {
      const est = estimateForSession(s.sessionId);
      costLabel = est != null
        ? ` \u00b7 interrupted \u00b7 ~$${(est * OVERAGE_RATE).toFixed(2)} est`
        : " \u00b7 interrupted \u00b7 unmetered";
    }
    const label = `${approx}iteration ${s.iteration}${s.active ? " (current)" : ""} \u00b7 ${hh}:${mm}${costLabel}`;
    opts.push(`<option value="${esc(s.sessionId)}"${iterState.selected === s.sessionId ? " selected" : ""}>${esc(label)}</option>`);
  }
  sel.innerHTML = opts.join("");
  sel.disabled = iterState.sessions.length === 0 && iterState.selected === "live";
  const hints = [];
  if (iterState.sessions.some((s) => !s.exact)) {
    hints.push("~ = iteration number inferred from file order (marker file missing)");
  }
  if (iterState.sessions.some((s) => isUnmetered(s))) {
    hints.push("interrupted = the iteration ran but its turn was cut off before completing, so kiro-cli recorded no credits; the cost is estimated from measured iterations");
  }
  sel.title = iterState.unavailable
    || (hints.length > 0 ? hints.join("\n") : "Switch between iterations");
}

async function refreshIterations() {
  if (!currentCluster || iterState.fetching) return;
  iterState.fetching = true;
  const gen = generation;
  try {
    const url = `cluster/agent-stream/${encodeURIComponent(currentCluster)}`
      + `?agentIndex=${encodeURIComponent(currentAgentIndex)}&kind=acp-list`;
    const res = await fetch(url);
    if (gen !== generation || !res.ok) return;
    const data = await res.json();
    if (gen !== generation) return;
    iterState.sessions = Array.isArray(data.sessions) ? data.sessions : [];
    iterState.unavailable = data.unavailable || null;
    // The pinned session can vanish (instance replaced). Fall back to live.
    if (iterState.selected !== "live"
        && !iterState.sessions.some((s) => s.sessionId === iterState.selected)) {
      iterState.selected = "live";
    }
    renderIterOptions();
    // Cost estimates are derived from these session sizes, so the header total
    // and the ACP chip both change when the list does.
    renderAcpCost();
    renderNodeCost();
  } catch { /* keep the current list */ } finally {
    iterState.fetching = false;
  }
}

function selectIteration(value) {
  if (value === iterState.selected) return;
  iterState.selected = value;
  renderIterOptions();
  const pane = panes.acp;
  pane.hasContent = false;
  paneEmptyState(pane, value === "live" ? "loading live session\u2026" : "loading iteration\u2026");
  pane.metaEl.textContent = "";
  fetchPane(pane, { force: true });
}

/* ---------- Directions (top-left pane) ------------------------------------------ */

function truncateDirText(text) {
  if (!text) return "";
  const lines = text.split("\n").filter((l) => l.trim().length > 0).slice(0, 3);
  let out = lines.join(" ").trim();
  if (out.length > 160) out = out.slice(0, 157).trimEnd() + "\u2026";
  return out;
}

function renderDirections() {
  const body = rootEl ? rootEl.querySelector("[data-kn-directions]") : null;
  if (!body) return;

  const block = (kind, title, text, loaded, emptyMsg) => {
    let inner;
    if (!loaded) {
      inner = `<div class="kn-dir-empty">loading\u2026</div>`;
    } else if (!text) {
      inner = `<div class="kn-dir-empty">${esc(emptyMsg)}</div>`;
    } else {
      const preview = truncateDirText(text);
      const more = text.length > preview.length || text.split("\n").filter((l) => l.trim()).length > 3;
      inner = `<div class="kn-dir-preview">${esc(preview)}${more ? ` <a href="#" class="kn-dir-more" data-kn-dir-show="${kind}">show all</a>` : ""}</div>`;
    }
    return `
      <div class="kn-dir-block" data-kn-dir-block="${kind}">
        <div class="kn-dir-block-title">${esc(title)}</div>
        ${inner}
      </div>`;
  };

  body.innerHTML =
    block("direction", "Cluster direction", dirState.direction, dirState.direction !== null, "(no direction set)")
    + block("directive", `agent-${currentAgentIndex} directive`, dirState.directive, dirState.directive !== undefined, "no directive");
}

async function refreshDirections() {
  if (!visible || !currentCluster || dirState.fetching) return;
  dirState.fetching = true;
  const gen = generation;
  try {
    const base = encodeURIComponent(currentCluster);
    const [dirRes, dvRes] = await Promise.all([
      fetch(`cluster/direction/${base}`),
      fetch(`cluster/agent-directive/${base}?agentIndex=${encodeURIComponent(currentAgentIndex)}`),
    ]);
    if (gen !== generation) return;
    if (dirRes.ok) {
      const d = await dirRes.json().catch(() => null);
      dirState.direction = d && typeof d.direction === "string" ? d.direction : "";
    }
    if (dvRes.ok) {
      const d = await dvRes.json().catch(() => null);
      dirState.directive = d ? d.directive : null;
    }
    if (gen !== generation) return;
    renderDirections();
  } catch { /* keep what we have */ } finally {
    dirState.fetching = false;
  }
}

/* ---------- Direction popup (same interaction as the WeltenBuilder one) --------- */

let dirPopupRoot = null;

function buildDirPopupDom() {
  const root = document.createElement("div");
  root.className = "kn-popup";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="kn-popup-backdrop" data-kn-popup-dismiss></div>
    <div class="kn-popup-panel" role="dialog" aria-modal="true" aria-labelledby="kn-popup-title">
      <header class="kn-popup-header">
        <div class="kn-popup-title" id="kn-popup-title">Direction</div>
        <button type="button" class="kn-popup-close" aria-label="Close">&times;</button>
      </header>
      <div class="kn-popup-body"></div>
    </div>
  `;
  document.body.appendChild(root);
  root.addEventListener("click", (e) => {
    if (e.target.matches("[data-kn-popup-dismiss]") || e.target.matches(".kn-popup-close")) {
      closeDirPopup();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && dirPopupRoot && dirPopupRoot.classList.contains("visible")) {
      closeDirPopup();
    }
  });
  return root;
}

function showDirPopup(kind) {
  const text = kind === "direction" ? dirState.direction : dirState.directive;
  if (!text) return;
  if (!dirPopupRoot) dirPopupRoot = buildDirPopupDom();
  const title = kind === "direction"
    ? `Direction: ${currentCluster || ""}`
    : `Directive: ${currentCluster || ""} \u00b7 agent-${currentAgentIndex}`;
  dirPopupRoot.querySelector(".kn-popup-title").textContent = title;
  const bodyEl = dirPopupRoot.querySelector(".kn-popup-body");
  if (typeof marked !== "undefined" && marked.parse) {
    bodyEl.innerHTML = `<div class="kn-md">${marked.parse(text)}</div>`;
  } else {
    bodyEl.innerHTML = `<pre class="kn-console-pre">${esc(text)}</pre>`;
  }
  dirPopupRoot.classList.add("visible");
  dirPopupRoot.setAttribute("aria-hidden", "false");
}

function closeDirPopup() {
  if (!dirPopupRoot) return;
  dirPopupRoot.classList.remove("visible");
  dirPopupRoot.setAttribute("aria-hidden", "true");
}

/* ---------- Selectors -------------------------------------------------------- */

async function refreshClusterOptions() {
  const sel = rootEl.querySelector("[data-kn-cluster]");
  try {
    const res = await fetch("cluster/list");
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.clusters) ? data.clusters : []);
    const ids = list.map(c => c.id).filter(Boolean);
    if (currentCluster && !ids.includes(currentCluster)) ids.unshift(currentCluster);
    if (ids.length === 0) {
      sel.innerHTML = `<option value="">no clusters</option>`;
      return;
    }
    sel.innerHTML = ids
      .map(id => `<option value="${esc(id)}"${id === currentCluster ? " selected" : ""}>${esc(id)}</option>`)
      .join("");
    if (!currentCluster) {
      // Rail-opened with no scope yet: adopt the first cluster.
      setTarget(ids[0], null);
    }
  } catch { /* keep current options */ }
}

async function refreshAgentOptions() {
  const sel = rootEl.querySelector("[data-kn-agent]");
  if (!currentCluster) {
    sel.innerHTML = `<option value="0">agent-0</option>`;
    return;
  }
  let concurrency = 1;
  try {
    const res = await fetch(`cluster/config/${encodeURIComponent(currentCluster)}`);
    if (res.ok) {
      const cfg = await res.json();
      if (cfg && Number.isFinite(cfg.concurrency)) concurrency = cfg.concurrency;
    }
  } catch { /* default to 1 */ }
  if (currentAgentIndex >= concurrency) currentAgentIndex = 0;
  sel.innerHTML = Array.from({ length: concurrency }, (_, i) =>
    `<option value="${i}"${i === currentAgentIndex ? " selected" : ""}>agent-${i}</option>`
  ).join("");
}

function renderIdentity() {
  const el = rootEl.querySelector("[data-kn-identity]");
  if (!el) return;
  el.innerHTML = currentCluster
    ? `${esc(currentCluster)}<span class="kn-identity-sep">\u00b7</span>agent-${currentAgentIndex}`
    : `<span style="color:var(--text-muted);font-weight:400">select a cluster</span>`;
}

function setTarget(cluster, agentIndex) {
  const clusterChanged = cluster && cluster !== currentCluster;
  const indexChanged = agentIndex != null && Number.isFinite(agentIndex) && agentIndex !== currentAgentIndex;
  if (cluster) currentCluster = cluster;
  if (agentIndex != null && Number.isFinite(agentIndex)) currentAgentIndex = agentIndex;

  renderIdentity();
  const clusterSel = rootEl.querySelector("[data-kn-cluster]");
  if (clusterSel && currentCluster) {
    if (![...clusterSel.options].some(o => o.value === currentCluster)) {
      const opt = document.createElement("option");
      opt.value = currentCluster;
      opt.textContent = currentCluster;
      clusterSel.insertBefore(opt, clusterSel.firstChild);
    }
    clusterSel.value = currentCluster;
  }
  if (clusterChanged || agentIndex != null) refreshAgentOptions();

  if (clusterChanged || indexChanged) {
    // Retarget the streams: discard in-flight responses, reset panes,
    // fetch fresh immediately.
    generation++;
    for (const pane of Object.values(panes)) {
      pane.hasContent = false;
      paneEmptyState(pane, "loading\u2026");
      pane.metaEl.textContent = "";
    }
    // New target, new iteration history + directions + costs.
    iterState.sessions = [];
    iterState.selected = "live";
    iterState.unavailable = null;
    renderIterOptions();
    costState.bySession = new Map();
    costState.byIteration = new Map();
    costState.total = null;
    costState.lastAcpSessionId = null;
    nodeCostState.infra = null;
    // Clear the override too, otherwise switching agents briefly shows the
    // previous node's model until refreshNodeInfra lands.
    nodeModelState.override = undefined;
    renderAcpCost();
    renderNodeCost();
    renderNodeModel();
    dirState.direction = null;
    dirState.directive = undefined;
    renderDirections();
    fetchBoth();
    refreshIterations();
    refreshCosts();
    refreshDirections();
  }
}

/* ---------- Split divider ------------------------------------------------------ */

function wireDivider() {
  const divider = rootEl.querySelector(".kn-divider");
  const topPane = rootEl.querySelector(".kn-top");
  const split = rootEl.querySelector(".kn-split");
  if (!divider || !topPane || !split) return;

  let dragging = false;
  divider.addEventListener("mousedown", (e) => {
    dragging = true;
    divider.classList.add("dragging");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = split.getBoundingClientRect();
    const pct = ((e.clientY - rect.top) / rect.height) * 100;
    const clamped = Math.max(15, Math.min(85, pct));
    topPane.style.flex = `0 0 ${clamped}%`;
  });
  document.addEventListener("mouseup", () => {
    dragging = false;
    divider.classList.remove("dragging");
  });
}

/* ---------- Pane wiring ---------------------------------------------------------- */

function wirePane(pane, paneEl) {
  pane.bodyEl = paneEl.querySelector(".kn-pane-body");
  pane.metaEl = paneEl.querySelector("[data-kn-meta]");
  pane.pauseBtn = paneEl.querySelector("[data-kn-pause]");
  pane.refreshBtn = paneEl.querySelector("[data-kn-refresh]");

  pane.refreshBtn.addEventListener("click", () => fetchPane(pane));
  // Turn-error "more"/"less" unfold (delegated — the body is re-rendered
  // wholesale on every refresh).
  pane.bodyEl.addEventListener("click", (e) => {
    const t = e.target && e.target.closest && e.target.closest("[data-ef-toggle]");
    if (!t) return;
    const key = t.dataset.efToggle;
    const detail = pane.bodyEl.querySelector(`[data-ef-detail="${cssEscape(key)}"]`);
    const expand = !_knErrExpanded.has(key);
    if (expand) _knErrExpanded.add(key);
    else _knErrExpanded.delete(key);
    if (detail) detail.hidden = !expand;
    t.textContent = expand ? "less" : "more\u2026";
  });
  pane.pauseBtn.addEventListener("click", () => {
    pane.paused = !pane.paused;
    pane.pauseBtn.textContent = pane.paused ? "\u25B6" : "\u23F8";
    pane.pauseBtn.title = pane.paused ? "Resume auto-refresh" : "Pause auto-refresh";
    pane.pauseBtn.classList.toggle("kn-btn--paused", pane.paused);
    if (!pane.paused) fetchPane(pane);
  });
}

/* ---------- Section module interface --------------------------------------------- */

export default {
  id: "kiro-node",
  title: "Kiro Node",

  async mount(container, shellCtx) {
    ctx = shellCtx;
    container.innerHTML = `
      <div class="kn-root">
        <div class="kn-header">
          <span class="kn-identity" data-kn-identity></span>
          <span class="kn-node-model" data-kn-node-model style="display:none"></span>
          <span class="kn-node-cost cost-label" data-kn-node-cost style="display:none" title="This agent's lifetime AI credits and current-run infra cost"></span>
          <span style="flex:1"></span>
          <span class="kn-header-label">cluster</span>
          <select class="kn-select" data-kn-cluster><option value="">loading\u2026</option></select>
          <span class="kn-header-label">agent</span>
          <select class="kn-select" data-kn-agent><option value="0">agent-0</option></select>
        </div>
        <div class="kn-split">
          <div class="kn-top">
            <div class="kn-pane kn-pane--directions">
              <div class="kn-pane-bar">
                <span class="kn-pane-title">Directions</span>
                <span class="kn-pane-hint">cluster + per-agent</span>
              </div>
              <div class="kn-pane-body kn-pane-body--directions" data-kn-directions></div>
            </div>
            <div class="kn-pane kn-pane--console">
              <div class="kn-pane-bar">
                <span class="kn-pane-title">Console</span>
                <span class="kn-pane-hint">journald tail via SSM</span>
                <span class="kn-pane-meta" data-kn-meta></span>
                <span style="flex:1"></span>
                <button type="button" class="kn-btn" data-kn-pause title="Pause auto-refresh">\u23F8</button>
                <button type="button" class="kn-btn" data-kn-refresh title="Refresh now">&#8635;</button>
              </div>
              <div class="kn-pane-body"></div>
            </div>
          </div>
          <div class="kn-divider" title="Drag to resize"></div>
          <div class="kn-pane kn-pane--acp">
            <div class="kn-pane-bar">
              <span class="kn-pane-title">Kiro CLI (ACP)</span>
              <select class="kn-select kn-select--iter" data-kn-iter title="Switch between iterations">
                <option value="live">live (follow)</option>
              </select>
              <span class="kn-pane-cost cost-label" data-kn-cost style="display:none"></span>
              <span class="kn-pane-meta" data-kn-meta></span>
              <span style="flex:1"></span>
              <button type="button" class="kn-btn" data-kn-pause title="Pause auto-refresh">\u23F8</button>
              <button type="button" class="kn-btn" data-kn-refresh title="Refresh now">&#8635;</button>
            </div>
            <div class="kn-pane-body"></div>
          </div>
        </div>
      </div>
    `;
    rootEl = container.querySelector(".kn-root");

    contextEl = document.createElement("div");
    contextEl.style.cssText = "display:flex;align-items:center;gap:8px";

    wirePane(panes.console, rootEl.querySelector(".kn-pane--console"));
    wirePane(panes.acp, rootEl.querySelector(".kn-pane--acp"));
    paneEmptyState(panes.console, "Open an agent to stream its console.");
    paneEmptyState(panes.acp, "Open an agent to stream its ACP session.");

    // Model display names for the header pill. Fire and forget — the pill
    // renders the raw id until (or unless) this lands.
    void loadNodeModelCatalog();

    rootEl.querySelector("[data-kn-cluster]").addEventListener("change", (e) => {
      if (e.target.value) setTarget(e.target.value, null);
    });
    rootEl.querySelector("[data-kn-agent]").addEventListener("change", (e) => {
      setTarget(null, parseInt(e.target.value, 10));
    });
    rootEl.querySelector("[data-kn-iter]").addEventListener("change", (e) => {
      selectIteration(e.target.value);
    });
    rootEl.querySelector("[data-kn-directions]").addEventListener("click", (e) => {
      const link = e.target.closest("[data-kn-dir-show]");
      if (!link) return;
      e.preventDefault();
      showDirPopup(link.getAttribute("data-kn-dir-show"));
    });

    wireDivider();
    renderIdentity();
    renderDirections();
    refreshClusterOptions();
  },

  show(params) {
    visible = true;
    ctx.topbar.setContext(contextEl);
    ctx.topbar.setIndicator("cached", 0);
    if (params && (params.cluster || params.agentIndex != null)) {
      setTarget(params.cluster || null,
        params.agentIndex != null ? parseInt(params.agentIndex, 10) : null);
    }
    // Refresh whatever is on screen. No-ops per pane while a fetch from
    // setTarget is already in flight (inFlight guard).
    if (currentCluster) {
      fetchBoth();
      refreshDirections();
      if (iterState.sessions.length === 0) refreshIterations();
      // Unconditional: this used to fire only when the map was empty, so
      // reopening the section with stale cost data never refreshed it and
      // iterations completed since the last look showed no cost at all.
      refreshCosts();
    }
    refreshClusterOptions();
    startPaneTimers();
  },

  hide() {
    visible = false;
    stopPaneTimers();
    closeDirPopup();
  },
};
