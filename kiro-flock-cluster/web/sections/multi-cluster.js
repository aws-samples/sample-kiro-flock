/* ============================================================================
   Multi Cluster section — the WeltenBuilder board, ported into the
   unified shell.

   Owns: cluster cards, deployment group frames, Packery bin-packing,
   direction popup, per-card lifecycle actions, and the 3s cluster-list
   poll with localStorage caching.

   Shell-owned (NOT here anymore): auth, env panel, analyzer panel,
   toast, confirm modal, poll indicator element.

   Navigation: clicking a cluster card opens the Single Cluster section
   in-place via ctx.openSection("single-cluster", { cluster }) — the old
   ?cluster= page reload is gone.
   ============================================================================ */

import { fmtCredits, fmtUsd } from "../costFormat.js";

let ctx = null;
let contextEl = null;      // topbar contextual controls (Resume All / Pause All / Stop All)
let btnStopAll = null;
let btnPauseAll = null;
let btnResumeAll = null;

const API = "cluster";

/* ---------- API client ------------------------------------------------------ */

const apiClient = {
  _path(action, clusterId) {
    return clusterId ? `${API}/${action}/${clusterId}` : `${API}/${action}`;
  },

  async _json(method, action, clusterId, body) {
    const opts = { method };
    if (body !== undefined) {
      opts.headers = { "Content-Type": "application/json" };
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(this._path(action, clusterId), opts);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${method} ${action} failed: ${res.status} ${text}`);
    }
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  },

  listClusters()        { return this._json("GET",    "list"); },
  deleteCluster(id)     { return this._json("DELETE", "delete", id); },
  start(id)             { return this._json("POST", "start",  id); },
  stop(id)              { return this._json("POST", "stop",   id); },
  pause(id)             { return this._json("POST", "pause",  id); },
  resume(id)            { return this._json("POST", "resume", id); },
  status(id)            { return this._json("GET",  "status", id); },
  getConfig(id)         { return this._json("GET", "config",    id); },
  putConfig(id, cfg)    { return this._json("PUT", "config",    id, cfg); },
  getDirection(id)      { return this._json("GET", "direction", id); },
  putDirection(id, txt) { return this._json("PUT", "direction", id, { direction: txt }); },
  stopAll()             { return this._json("POST", "stop-all"); },
  pauseAll()            { return this._json("POST", "pause-all"); },
  resumeAll()           { return this._json("POST", "resume-all"); },
};

/* ---------- State + helpers --------------------------------------------------- */

const state = {
  clusters: [],
  clustersLoading: false,
  _clusterErrorShown: false,
};

const _wbEsc = (s) => s == null ? "" : String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function _wbAgo(iso) {
  if (!iso) return "\u2014";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "\u2014";
  const diff = Math.max(0, Date.now() - t);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function _wbTruncate(s, n) {
  if (!s) return "\u2014";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
}

function showError(msg) { if (ctx) ctx.showError(msg); }
function showInfo(msg)  { if (ctx) ctx.showInfo(msg); }

/* ---------- Topbar context (global controls) ----------------------------------- */

function buildContextControls() {
  contextEl = document.createElement("div");
  contextEl.style.cssText = "display:flex;align-items:center;gap:8px";
  contextEl.innerHTML = `
    <span data-wb-total-cost class="cost-label" style="display:none"></span>
    <button type="button" class="sh-topbtn" data-wb-resume-all disabled>Resume All</button>
    <button type="button" class="sh-topbtn" data-wb-pause-all disabled>Pause All</button>
    <button type="button" class="sh-topbtn sh-topbtn--danger" data-wb-stop-all disabled>Stop All</button>
  `;
  btnResumeAll = contextEl.querySelector("[data-wb-resume-all]");
  btnPauseAll = contextEl.querySelector("[data-wb-pause-all]");
  btnStopAll = contextEl.querySelector("[data-wb-stop-all]");
  btnResumeAll.addEventListener("click", onClickResumeAll);
  btnPauseAll.addEventListener("click", onClickPauseAll);
  btnStopAll.addEventListener("click", onClickStopAll);
}

/** Count successes / failures in a bulk response array of
 *  `{ id, ok }` / `{ id, ok: false, error }` entries. The bulk routes
 *  return a single array per action (`stopped`, `paused`, `resumed`)
 *  that mixes both outcomes — there is no separate `failed` array — so
 *  the split has to happen here or failures get counted as successes. */
function _wbTallyBulk(results) {
  const list = Array.isArray(results) ? results : [];
  let ok = 0;
  let failed = 0;
  for (const r of list) {
    if (r && r.ok === false) failed++;
    else ok++;
  }
  return { ok, failed, total: list.length, known: Array.isArray(results) };
}

/** Shared reporting for the three topbar bulk actions. */
function _wbReportBulk(label, verb, results) {
  const { ok, failed, known } = _wbTallyBulk(results);
  if (!known) {
    showInfo(`${label}: requested.`);
    return;
  }
  if (failed > 0) {
    showError(`${label}: ${ok} ${verb}, ${failed} failed.`);
  } else {
    showInfo(`${label}: ${ok} cluster${ok === 1 ? "" : "s"} ${verb}.`);
  }
}

function renderHeader() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const anyNotStopped = clusters.some(c => c && c.state && c.state !== "stopped");
  const anyRunning    = clusters.some(c => c && c.state === "running");
  const anyPaused     = clusters.some(c => c && c.state === "paused");
  if (btnStopAll)   btnStopAll.disabled   = !anyNotStopped;
  if (btnPauseAll)  btnPauseAll.disabled  = !anyRunning;
  if (btnResumeAll) btnResumeAll.disabled = !anyPaused;

  // Grand total credit spend across every registered cluster (groups and
  // ungrouped alike) — the top of the cost hierarchy. Sourced from
  // /cluster/list, which carries each cluster's snapshot total.
  const totalCostEl = contextEl ? contextEl.querySelector("[data-wb-total-cost]") : null;
  if (totalCostEl) {
    const total = _wbSumCredits(clusters);
    const infraTotal = _wbSumInfra(clusters);
    const costStr = _wbFmtCostLine(total, infraTotal);
    if (costStr) {
      totalCostEl.textContent = costStr;
      totalCostEl.style.display = "";
    } else {
      totalCostEl.style.display = "none";
    }
  }
}

async function onClickStopAll() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const running = clusters.filter(c => c && c.state && c.state !== "stopped");
  if (running.length === 0) return;

  const names = running.map(c => c.name || c.id).filter(Boolean).join(", ");
  const ok = await ctx.confirm({
    title: "Stop all clusters",
    message: `This will terminate all running clusters (${running.length}):\n${names}`,
    confirmLabel: "Stop All",
    destructive: true,
  });
  if (!ok) return;

  try {
    const res = await apiClient.stopAll();
    _wbReportBulk("Stop All", "stopped", res && res.stopped);
    pollClusters();
  } catch (err) {
    showError(`Stop All failed: ${err.message || err}`);
  }
}

async function onClickPauseAll() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const running = clusters.filter(c => c && c.state === "running");
  if (running.length === 0) return;

  const names = running.map(c => c.name || c.id).filter(Boolean).join(", ");
  const ok = await ctx.confirm({
    title: "Pause all clusters",
    message: `This will pause agent work on all running clusters (${running.length}):\n${names}\n\nInstances keep running. Use Resume on each cluster to continue.`,
    confirmLabel: "Pause All",
    destructive: false,
  });
  if (!ok) return;

  try {
    const res = await apiClient.pauseAll();
    _wbReportBulk("Pause All", "paused", res && res.paused);
    pollClusters();
  } catch (err) {
    showError(`Pause All failed: ${err.message || err}`);
  }
}

async function onClickResumeAll() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const paused = clusters.filter(c => c && c.state === "paused");
  if (paused.length === 0) return;

  const names = paused.map(c => c.name || c.id).filter(Boolean).join(", ");
  const ok = await ctx.confirm({
    title: "Resume all paused clusters",
    message: `This will resume agent work on all paused clusters (${paused.length}):\n${names}\n\nAgents pick up their loop on the next poll cycle.`,
    confirmLabel: "Resume All",
    destructive: false,
  });
  if (!ok) return;

  try {
    const res = await apiClient.resumeAll();
    _wbReportBulk("Resume All", "resumed", res && res.resumed);
    pollClusters();
  } catch (err) {
    showError(`Resume All failed: ${err.message || err}`);
  }
}

/* ---------- Cluster stack cards -------------------------------------------------- */

const _wbDirectionCache = new Map();   // clusterId → { text, fetching }
const _wbConfigCache    = new Map();   // clusterId → { config, fetching }
let _wbGroupCostTotals  = new Map();   // groupName → credits (incl. hidden stopped clusters)

function _wbStateBadge(s) {
  switch (s) {
    case "running":  return { label: "running",  cls: "wb-state--running" };
    case "starting": return { label: "starting", cls: "wb-state--starting" };
    case "stopping": return { label: "stopping", cls: "wb-state--stopping" };
    case "paused":   return { label: "paused",   cls: "wb-state--paused" };
    case "stopped":  return { label: "stopped",  cls: "wb-state--stopped" };
    default:         return { label: s || "unknown", cls: "wb-state--unknown" };
  }
}

function _wbTruncateDirection(text) {
  if (!text) return "";
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 3);
  let out = lines.join(" ").trim();
  if (out.length > 140) out = out.slice(0, 137).trimEnd() + "\u2026";
  return out;
}

// In-place section switch. Replaces the pre-merge full-page navigation to
// /?cluster=<id>.
function _wbOpenCluster(clusterId) {
  ctx.openSection("single-cluster", { cluster: clusterId });
}

function _wbButtonDisabled(action, clusterState) {
  const s = clusterState;
  switch (action) {
    case "start":  return !(s === "stopped");
    case "stop":   return !(s === "running" || s === "paused" || s === "starting");
    case "pause":  return !(s === "running" || s === "starting");
    case "resume": return !(s === "paused");
    case "open":   return false;
    default: return true;
  }
}

// Credit → dollar conversion at the overage rate (shared module). Every
// rendered cost carries title="overage cost" so the hover explains the number.

function _wbFmtCredits(credits) {
  return `ai[${fmtCredits(credits)}]`;
}

function _wbFmtInfra(usd) {
  if (usd == null || usd <= 0) return null;
  return `infra[${fmtUsd(usd)}]`;
}

function _wbFmtCostLine(totalCredits, infraCostUsd) {
  const parts = [];
  if (typeof totalCredits === "number") parts.push(_wbFmtCredits(totalCredits));
  const infra = _wbFmtInfra(infraCostUsd);
  if (infra) parts.push(infra);
  return parts.length > 0 ? parts.join(" / ") : null;
}

/** Sum infraCostUsd across running clusters. */
function _wbSumInfra(clusters) {
  let total = 0;
  let seen = false;
  for (const c of clusters) {
    if (!c || c.state === "stopped") continue;
    if (typeof c.infraCostUsd === "number" && Number.isFinite(c.infraCostUsd)) {
      total += c.infraCostUsd;
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Sum totalCredits across running clusters only. Returns null when no
 *  running cluster has cost data (or all are stopped), so callers can
 *  hide the chip instead of showing a misleading stale total. */
function _wbSumCredits(clusters) {
  let total = 0;
  let seen = false;
  for (const c of clusters) {
    if (!c || c.state === "stopped") continue;
    if (typeof c.totalCredits === "number" && Number.isFinite(c.totalCredits)) {
      total += c.totalCredits;
      seen = true;
    }
  }
  return seen ? total : null;
}

function _wbAlgoClass(algo) {
  const a = (algo || "").toLowerCase();
  if (a === "mesh" || a === "swarm" || a === "amorphous" || a === "single") return `wb-algo--${a}`;
  return "wb-algo--amorphous";
}

function renderClusterStacks() {
  const container = document.getElementById("cluster-stacks");
  if (!container) return;

  // Hide fully-stopped clusters, except ones whose last start FAILED —
  // those stay visible so the operator sees the failure.
  const raw = Array.isArray(state.clusters) ? state.clusters : [];
  const clusters = raw.filter(c => c && c.state && (c.state !== "stopped" || c.lastError));

  // Group cost totals only count non-stopped clusters. A stopped cluster's
  // credits are stale (from a past run) and shouldn't inflate the live total.
  _wbGroupCostTotals = new Map();
  for (const c of raw) {
    if (!c || c.state === "stopped") continue;
    const g = _wbGroupKeyFor(c);
    if (!g || typeof c.totalCredits !== "number" || !Number.isFinite(c.totalCredits)) continue;
    _wbGroupCostTotals.set(g, (_wbGroupCostTotals.get(g) ?? 0) + c.totalCredits);
  }

  container.innerHTML = "";

  // Group clusters sharing a deployment group (`everforgeGroup`) into a folder frame.
  const groupMembers = new Map();
  const items = [];
  const seenGroups = new Set();

  for (const c of clusters) {
    const gname = _wbGroupKeyFor(c);
    if (!gname) {
      items.push({ type: "cluster", cluster: c });
      continue;
    }
    if (!seenGroups.has(gname)) {
      seenGroups.add(gname);
      groupMembers.set(gname, []);
      items.push({ type: "group", name: gname });
    }
    groupMembers.get(gname).push(c);
  }

  for (const item of items) {
    if (item.type === "cluster") {
      const el = _wbBuildClusterCard(item.cluster);
      el.classList.add("wb-masonry-item");
      container.appendChild(el);
    } else {
      container.appendChild(_wbBuildGroupFrame(item.name, groupMembers.get(item.name)));
    }
  }

  // Trailing "+" new-cluster tile.
  const addCard = document.createElement("div");
  addCard.className = "wb-masonry-item wb-cluster-stack wb-cluster-stack-new";
  addCard.setAttribute("data-wb-new", "");
  addCard.setAttribute("role", "button");
  addCard.setAttribute("tabindex", "0");
  addCard.setAttribute("aria-label", "Create new cluster");
  addCard.innerHTML = `<span class="wb-cluster-stack-new-plus">+</span>
    <span class="wb-cluster-stack-new-label">New cluster</span>`;
  container.appendChild(addCard);

  _wbLayoutMasonry();
}

/* ---------- Packery masonry layout ------------------------------------------------ */

let _wbPackery = null;

function _wbLayoutMasonry() {
  const container = document.getElementById("cluster-stacks");
  if (!container) return;
  if (typeof Packery === "undefined") return; // CDN not loaded yet — flex fallback

  if (!_wbPackery) {
    _wbPackery = new Packery(container, {
      itemSelector: ".wb-masonry-item",
      gutter: 20,
      transitionDuration: 0,
      percentPosition: false,
    });
  } else {
    _wbPackery.reloadItems();
    _wbPackery.layout();
  }
}

function _wbBuildClusterCard(c) {
  const id = c.id;
  const name = c.name || c.id;
  const cfgEntry = _wbConfigCache.get(id);
  const cfg = cfgEntry && cfgEntry.config ? cfgEntry.config : null;
  const algo = ((cfg && cfg.algorithm) || c.algorithm || "amorphous").toLowerCase();
  const algoClass = _wbAlgoClass(algo);
  const stateInfo = _wbStateBadge(c.state);

  const card = document.createElement("article");
  // NOTE: no `wb-masonry-item` here — cards inside an expanded group body
  // must NOT be Packery items. The top-level render loop adds the marker.
  card.className = `wb-cluster-stack ${algoClass}${_wbFirstPollDone ? "" : " wb-stale"}`;
  card.setAttribute("data-wb-cluster-id", id);
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `Cluster ${name}`);

  const dirEntry = _wbDirectionCache.get(id);
  if (!dirEntry || !dirEntry.fetching) {
    _wbFetchDirection(id);
  }
  const dirPreview = dirEntry && dirEntry.text != null
    ? (_wbTruncateDirection(dirEntry.text) || "(no direction set)")
    : "(loading\u2026)";

  if (!cfgEntry || (!cfgEntry.fetching && !cfgEntry.config)) {
    _wbFetchConfig(id);
  }
  const concurrency = cfg && cfg.concurrency != null ? cfg.concurrency : "\u2014";
  const isEcs = cfg && cfg.computeType === "ecs";
  // The compute slot carries no label word: on ec2 it is the instance type,
  // on ecs it is ecs:<taskSize>. Both are one short token, so the config line
  // stays a single row either way.
  const computeLabel = isEcs
    ? `ecs:${cfg.taskSize || "medium"}`
    : (cfg && cfg.instanceType ? cfg.instanceType : "\u2014");
  const model = cfg ? (cfg.model ? cfg.model : "default") : "\u2014";

  const isPaused = c.state === "paused";
  const pauseAction = isPaused ? "resume" : "pause";
  const pauseLabel = isPaused ? "Resume" : "Pause";

  const stopDisabled   = _wbButtonDisabled("stop",       c.state) ? "disabled" : "";
  const pauseDisabled  = _wbButtonDisabled(pauseAction,  c.state) ? "disabled" : "";

  const lastUpdate = c.lastUpdate || null;
  const lastUpdateHtml = lastUpdate
    ? `<div class="wb-stack-last" title="${_wbEsc(lastUpdate.action)}">
         <span class="wb-stack-last-agent">${_wbEsc(lastUpdate.agentId)}</span>
         <span class="wb-stack-last-sep">\u00b7</span>
         <span class="wb-stack-last-ago" data-ts="${_wbEsc(lastUpdate.ts)}">${_wbEsc(_wbAgo(lastUpdate.ts))}</span>
         <span class="wb-stack-last-sep">\u00b7</span>
         <span class="wb-stack-last-action">${_wbEsc(_wbTruncate(lastUpdate.action, 60))}</span>
       </div>`
    : `<div class="wb-stack-last wb-stack-last--empty">no agent activity yet</div>`;

  const le = c.lastError;
  const lastErrorHtml = le && le.code
    ? `<div class="wb-stack-error" title="${_wbEsc(le.message || "")}" style="margin-top:6px;padding:5px 8px;border-radius:5px;background:rgba(251,113,133,0.15);color:#fb7185;font-size:11px;font-family:'SF Mono',Menlo,monospace">\u26A0 launch failed: ${_wbEsc(le.code)}</div>`
    : "";

  card.innerHTML = `
    <header class="wb-stack-header">
      <div class="wb-stack-header-main">
        <div class="wb-stack-name" title="${_wbEsc(name)}">${_wbEsc(name)}</div>
        <span class="wb-stack-algo">${_wbEsc(algo)}</span>
        ${c.hasAnyDirective ? `<span class="wb-stack-directive-pill" title="one or more agents have a per-agent directive — click Open to drill in">directive</span>` : ""}
        ${typeof c.modelOverrideCount === "number" && c.modelOverrideCount > 0
          ? `<span class="wb-stack-model-pill" title="${c.modelOverrideCount} agent${c.modelOverrideCount === 1 ? "" : "s"} run a model other than this cluster's baseline — click Open to see which">${c.modelOverrideCount} mixed model${c.modelOverrideCount === 1 ? "" : "s"}</span>`
          : ""}
      </div>
      <span class="wb-stack-state ${stateInfo.cls}">${_wbEsc(stateInfo.label)}</span>
    </header>

    <div class="wb-stack-direction" title="${_wbEsc(dirPreview)}">
      ${_wbEsc(dirPreview)}${dirEntry && dirEntry.text && dirEntry.text.length > 140 ? ` <a href="#" class="wb-stack-direction-more" data-wb-dir-show="${_wbEsc(id)}">show all</a>` : ""}
    </div>

    ${lastUpdateHtml}

    ${lastErrorHtml}

    <div class="wb-stack-config">
      <span class="wb-stack-config-item"><span class="wb-stack-config-label">agents</span> ${_wbEsc(String(concurrency))}</span>
      <span class="wb-stack-config-sep">\u00b7</span>
      <span class="wb-stack-config-item" title="${isEcs ? "Fargate task size" : "EC2 instance type"}">${_wbEsc(String(computeLabel))}</span>
      <span class="wb-stack-config-sep">\u00b7</span>
      <span class="wb-stack-config-item"><span class="wb-stack-config-label">model</span> ${_wbEsc(String(model))}</span>
      ${_wbFmtCostLine(c.totalCredits, c.infraCostUsd) ? `<span class="wb-stack-config-sep">\u00b7</span>
      <span class="wb-stack-config-item cost-label">${_wbFmtCostLine(c.totalCredits, c.infraCostUsd)}</span>` : ""}
    </div>

    <footer class="wb-stack-actions">
      <button type="button" class="wb-stack-btn wb-stack-btn--stop"   data-wb-action="stop"   ${stopDisabled}>Stop</button>
      <button type="button" class="wb-stack-btn wb-stack-btn--pause"  data-wb-action="${pauseAction}" ${pauseDisabled}>${pauseLabel}</button>
      <button type="button" class="wb-stack-btn wb-stack-btn--open"   data-wb-action="open">Open</button>
    </footer>
  `;

  return card;
}

/* ---------- Deployment group folders ----------------------------------------------- */

const WB_GROUP_COLLAPSE_KEY = "wb_group_collapsed_v1";
const WB_GROUP_COLLAPSED_MAX_ROWS = 8;

function _wbEnsureConfigFetch(id) {
  const cfgEntry = _wbConfigCache.get(id);
  if (!cfgEntry || (!cfgEntry.fetching && !cfgEntry.config)) {
    _wbFetchConfig(id);
  }
}

function _wbGroupKeyFor(c) {
  _wbEnsureConfigFetch(c.id);
  const cfgEntry = _wbConfigCache.get(c.id);
  const cfg = cfgEntry && cfgEntry.config ? cfgEntry.config : null;
  const g = cfg && cfg.everforgeGroup;
  return typeof g === "string" && g.length > 0 ? g : null;
}

function _wbReadCollapsedGroups() {
  try {
    const raw = localStorage.getItem(WB_GROUP_COLLAPSE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function _wbSetGroupCollapsed(name, collapsed) {
  const map = _wbReadCollapsedGroups();
  if (collapsed) map[name] = true;
  else delete map[name];
  try {
    localStorage.setItem(WB_GROUP_COLLAPSE_KEY, JSON.stringify(map));
  } catch { /* toggle still works for this render */ }
}

function _wbIsGroupCollapsed(name) {
  return !!_wbReadCollapsedGroups()[name];
}

function _wbBuildGroupFrame(name, members) {
  const collapsed = _wbIsGroupCollapsed(name);

  const frame = document.createElement("section");
  frame.className = `wb-masonry-item wb-group-frame${collapsed ? " wb-group-frame--collapsed" : ""}`;
  frame.setAttribute("data-wb-group", name);

  const anyRunning = members.some(c => c && c.state === "running");
  const anyError = members.some(c => c && c.lastError && c.lastError.code);
  // Group-scoped bulk eligibility, computed from the same per-action rules
  // the individual cards use. A group button is live when at least one
  // member could accept the action on its own.
  const canPause  = members.some(c => c && !_wbButtonDisabled("pause",  c.state));
  const canResume = members.some(c => c && !_wbButtonDisabled("resume", c.state));
  const canStop   = members.some(c => c && !_wbButtonDisabled("stop",   c.state));
  // Prefer the unfiltered total (includes hidden stopped clusters); fall
  // back to summing the visible members.
  const groupCredits = _wbGroupCostTotals.has(name)
    ? _wbGroupCostTotals.get(name)
    : _wbSumCredits(members);

  // The header is a plain flex row, not the toggle itself: the collapse
  // affordance lives on the inner .wb-group-toggle so the group action
  // buttons aren't nested inside an interactive element (invalid ARIA and
  // an awkward tab order).
  const header = document.createElement("header");
  header.className = "wb-group-header";
  header.innerHTML = `
    <span class="wb-group-toggle" role="button" tabindex="0"
          aria-expanded="${String(!collapsed)}"
          aria-label="Group ${_wbEsc(name)}, ${members.length} cluster${members.length === 1 ? "" : "s"}, click to ${collapsed ? "expand" : "collapse"}">
      <span class="wb-group-chevron">${collapsed ? "\u25B8" : "\u25BE"}</span>
      <span class="wb-group-name" title="${_wbEsc(name)}">${_wbEsc(name)}</span>
      <span class="wb-group-count">${members.length} cluster${members.length === 1 ? "" : "s"}</span>
      ${groupCredits != null ? `<span class="wb-group-count cost-label">${_wbEsc(_wbFmtCredits(groupCredits))}</span>` : ""}
      ${anyError ? `<span class="wb-group-flag wb-group-flag--error" title="a cluster in this group failed to launch">\u26A0</span>` : ""}
      ${anyRunning ? `<span class="wb-group-flag wb-group-flag--running" title="at least one cluster in this group is running"></span>` : ""}
    </span>
    <span class="wb-group-actions">
      <button type="button" class="wb-group-btn wb-group-btn--pause" data-wb-group-action="pause" title="Pause every running cluster in this group" ${canPause ? "" : "disabled"}>Pause</button>
      <button type="button" class="wb-group-btn wb-group-btn--resume" data-wb-group-action="resume" title="Resume every paused cluster in this group" ${canResume ? "" : "disabled"}>Resume</button>
      <button type="button" class="wb-group-btn wb-group-btn--stop" data-wb-group-action="stop" title="Stop every active cluster in this group" ${canStop ? "" : "disabled"}>Stop</button>
    </span>
  `;
  frame.appendChild(header);

  if (collapsed) {
    const list = document.createElement("div");
    list.className = "wb-group-members";
    const shown = members.slice(0, WB_GROUP_COLLAPSED_MAX_ROWS);
    const hidden = members.slice(WB_GROUP_COLLAPSED_MAX_ROWS);

    for (const c of shown) {
      const cfgEntry = _wbConfigCache.get(c.id);
      const cfg = cfgEntry && cfgEntry.config ? cfgEntry.config : null;
      const algo = ((cfg && cfg.algorithm) || c.algorithm || "amorphous").toLowerCase();
      const stateInfo = _wbStateBadge(c.state);
      const nodeCount = cfg && cfg.concurrency != null ? cfg.concurrency : null;
      const freshness = c.lastUpdate ? _wbAgo(c.lastUpdate.ts) : stateInfo.label;

      const mini = document.createElement("div");
      mini.className = `wb-group-member ${_wbAlgoClass(algo)}`;
      mini.setAttribute("data-wb-cluster-id", c.id);
      mini.setAttribute("role", "button");
      mini.setAttribute("tabindex", "0");
      mini.setAttribute("aria-label", `Open cluster ${c.name || c.id}`);
      mini.title = c.lastUpdate
        ? `${c.name || c.id} \u2014 ${stateInfo.label} \u2014 ${c.lastUpdate.action || ""} \u2014 click to open`
        : `${c.name || c.id} \u2014 ${stateInfo.label} \u2014 click to open`;
      mini.innerHTML = `
        <div class="wb-group-member-top">
          <span class="wb-group-member-dot ${stateInfo.cls}"></span>
          <span class="wb-group-member-name">${_wbEsc(c.name || c.id)}</span>
        </div>
        <div class="wb-group-member-meta">
          ${nodeCount != null ? `<span class="wb-group-member-nodes">${_wbEsc(String(nodeCount))} node${nodeCount === 1 ? "" : "s"}</span><span class="wb-group-member-metasep">\u00b7</span>` : ""}
          <span class="wb-group-member-fresh">${_wbEsc(freshness)}</span>
        </div>
      `;
      list.appendChild(mini);
    }

    if (hidden.length > 0) {
      const runningCount = hidden.filter(c => c && c.state === "running").length;
      const more = document.createElement("div");
      more.className = "wb-group-member wb-group-member--more";
      more.textContent = runningCount > 0
        ? `+${hidden.length} more \u00b7 ${runningCount} running`
        : `+${hidden.length} more`;
      list.appendChild(more);
    }

    frame.appendChild(list);
  } else {
    const body = document.createElement("div");
    body.className = "wb-group-body";
    const cols = Math.min(Math.max(members.length, 1), 3);
    body.style.width = (cols * 280 + (cols - 1) * 20) + "px";
    for (const c of members) {
      body.appendChild(_wbBuildClusterCard(c));
    }
    frame.appendChild(body);
  }

  return frame;
}

/* ---------- Lazy fetches ------------------------------------------------------------ */

async function _wbFetchDirection(clusterId) {
  const existing = _wbDirectionCache.get(clusterId);
  if (existing && existing.fetching) return;
  _wbDirectionCache.set(clusterId, { text: existing ? existing.text : null, fetching: true });
  try {
    const res = await apiClient.getDirection(clusterId);
    const text = typeof res === "string"
      ? res
      : (res && typeof res.direction === "string" ? res.direction : "");
    const prev = existing ? existing.text : null;
    _wbDirectionCache.set(clusterId, { text, fetching: false });
    if (text !== prev) renderClusterStacks();
  } catch {
    _wbDirectionCache.set(clusterId, { text: existing ? existing.text : "", fetching: false });
  }
}

async function _wbFetchConfig(clusterId) {
  const existing = _wbConfigCache.get(clusterId);
  if (existing && existing.fetching) return;
  _wbConfigCache.set(clusterId, { config: existing ? existing.config : null, fetching: true });
  try {
    const cfg = await apiClient.getConfig(clusterId);
    const prev = existing ? JSON.stringify(existing.config) : null;
    _wbConfigCache.set(clusterId, { config: cfg || null, fetching: false });
    if (JSON.stringify(cfg) !== prev) renderClusterStacks();
  } catch {
    _wbConfigCache.set(clusterId, { config: existing ? existing.config : null, fetching: false });
  }
}

/* ---------- Direction popup ----------------------------------------------------------- */

let _wbDirPopupRoot = null;

function _wbShowDirectionPopup(clusterId) {
  const entry = _wbDirectionCache.get(clusterId);
  const text = entry && entry.text ? entry.text : "";
  if (!text) return;

  if (!_wbDirPopupRoot) _wbDirPopupRoot = _wbBuildDirPopupDom();
  const root = _wbDirPopupRoot;

  const cluster = (state.clusters || []).find(c => c.id === clusterId);
  const name = cluster ? (cluster.name || cluster.id) : clusterId;
  root.querySelector(".wb-dir-popup-title").textContent = `Direction: ${name}`;

  const bodyEl = root.querySelector(".wb-dir-popup-body");
  if (typeof marked !== "undefined" && marked.parse) {
    bodyEl.innerHTML = `<div class="env-viewer-md">${marked.parse(text)}</div>`;
  } else {
    bodyEl.innerHTML = `<pre>${_wbEsc(text)}</pre>`;
  }

  root.classList.add("visible");
  root.setAttribute("aria-hidden", "false");
}

function _wbCloseDirPopup() {
  if (!_wbDirPopupRoot) return;
  _wbDirPopupRoot.classList.remove("visible");
  _wbDirPopupRoot.setAttribute("aria-hidden", "true");
}

function _wbBuildDirPopupDom() {
  const root = document.createElement("div");
  root.className = "wb-dir-popup";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="wb-confirm-backdrop" data-wb-dir-dismiss></div>
    <div class="wb-dir-popup-panel" role="dialog" aria-modal="true" aria-labelledby="wb-dir-popup-title">
      <header class="wb-confirm-header">
        <div class="wb-dir-popup-title wb-confirm-title" id="wb-dir-popup-title">Direction</div>
        <button type="button" class="wb-dir-popup-close" aria-label="Close">&times;</button>
      </header>
      <div class="wb-dir-popup-body wb-confirm-body"></div>
    </div>
  `;
  document.body.appendChild(root);

  root.addEventListener("click", (e) => {
    if (e.target.matches("[data-wb-dir-dismiss]") || e.target.matches(".wb-dir-popup-close")) {
      _wbCloseDirPopup();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _wbDirPopupRoot && _wbDirPopupRoot.classList.contains("visible")) {
      _wbCloseDirPopup();
    }
  });

  return root;
}

/* ---------- Events ----------------------------------------------------------------------- */

function wireClusterStackEvents() {
  const container = document.getElementById("cluster-stacks");
  if (!container || container._wbWired) return;
  container._wbWired = true;

  container.addEventListener("click", (e) => {
    // Group action buttons are siblings of the collapse toggle inside the
    // group header. This branch runs first so a click on Pause never also
    // reaches the toggle.
    const groupActionEl = e.target.closest("[data-wb-group-action]");
    if (groupActionEl) {
      e.preventDefault();
      e.stopPropagation();
      const frame = groupActionEl.closest(".wb-group-frame");
      const name = frame && frame.getAttribute("data-wb-group");
      const action = groupActionEl.getAttribute("data-wb-group-action");
      if (name && action) _wbHandleGroupAction(name, action, groupActionEl);
      return;
    }

    const groupToggle = e.target.closest(".wb-group-toggle");
    if (groupToggle) {
      const frame = groupToggle.closest(".wb-group-frame");
      const name = frame && frame.getAttribute("data-wb-group");
      if (name) {
        _wbSetGroupCollapsed(name, !_wbIsGroupCollapsed(name));
        renderClusterStacks();
      }
      return;
    }

    const memberRow = e.target.closest(".wb-group-member[data-wb-cluster-id]");
    if (memberRow) {
      const clusterId = memberRow.getAttribute("data-wb-cluster-id");
      if (clusterId) _wbOpenCluster(clusterId);
      return;
    }

    const newCard = e.target.closest("[data-wb-new]");
    if (newCard) {
      _wbCreateNewCluster();
      return;
    }

    const dirLink = e.target.closest("[data-wb-dir-show]");
    if (dirLink) {
      e.preventDefault();
      e.stopPropagation();
      const cid = dirLink.getAttribute("data-wb-dir-show");
      _wbShowDirectionPopup(cid);
      return;
    }

    const card = e.target.closest(".wb-cluster-stack");
    if (!card) return;
    const clusterId = card.getAttribute("data-wb-cluster-id");
    if (!clusterId) return;

    const actionEl = e.target.closest("[data-wb-action]");
    if (actionEl && card.contains(actionEl)) {
      const action = actionEl.getAttribute("data-wb-action");
      e.stopPropagation();
      _wbHandleCardAction(clusterId, action, actionEl);
      return;
    }

    _wbOpenCluster(clusterId);
  });

  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    // A focused group button fires its own click on Enter/Space; let that
    // happen and keep the header's collapse toggle out of it.
    if (e.target.closest("[data-wb-group-action]")) {
      e.stopPropagation();
      return;
    }
    const groupToggle = e.target.closest(".wb-group-toggle");
    if (groupToggle) {
      e.preventDefault();
      const frame = groupToggle.closest(".wb-group-frame");
      const name = frame && frame.getAttribute("data-wb-group");
      if (name) {
        _wbSetGroupCollapsed(name, !_wbIsGroupCollapsed(name));
        renderClusterStacks();
      }
      return;
    }
    const memberRow = e.target.closest(".wb-group-member[data-wb-cluster-id]");
    if (memberRow) {
      e.preventDefault();
      const clusterId = memberRow.getAttribute("data-wb-cluster-id");
      if (clusterId) _wbOpenCluster(clusterId);
      return;
    }
    const newCard = e.target.closest("[data-wb-new]");
    if (newCard) {
      e.preventDefault();
      _wbCreateNewCluster();
      return;
    }
    const card = e.target.closest(".wb-cluster-stack");
    if (!card) return;
    if (e.target.tagName === "BUTTON") return;
    const clusterId = card.getAttribute("data-wb-cluster-id");
    if (!clusterId) return;
    e.preventDefault();
    _wbOpenCluster(clusterId);
  });
}

// New-cluster flow: pick a fresh id client-side and open the Single
// Cluster section on it. The backend auto-registers the cluster on the
// first PUT/Start.
function _wbCreateNewCluster() {
  let suffix = Date.now() % 10000;
  if (suffix === 0) suffix = 1;
  const padded = String(suffix).padStart(4, "0");
  const id = `cluster_${padded}`;
  _wbOpenCluster(id);
}

// Group-scoped bulk lifecycle action (pause / resume / stop) for one
// Deployment group folder.
//
// Fans out the existing per-cluster routes over the group's members rather
// than calling a group-scoped backend route: the frontend already knows
// group membership (from each cluster's cached config `everforgeGroup`) and
// each member's live state, so no second config read pass in the Lambda is
// needed. Trade-off: N requests instead of 1, and a partial failure leaves
// the group in a mixed state — which is why every outcome is reported and
// the poll fires regardless.
const WB_GROUP_ACTION_LABELS = {
  pause:  { title: "Pause group",  verb: "paused",  confirm: "Pause",  destructive: false },
  resume: { title: "Resume group", verb: "resumed", confirm: "Resume", destructive: false },
  stop:   { title: "Stop group",   verb: "stopped", confirm: "Stop",   destructive: true },
};

function _wbGroupMembers(groupName) {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  return clusters.filter(c => c && _wbGroupKeyFor(c) === groupName);
}

async function _wbHandleGroupAction(groupName, action, btnEl) {
  const meta = WB_GROUP_ACTION_LABELS[action];
  if (!meta) return;

  const targets = _wbGroupMembers(groupName)
    .filter(c => !_wbButtonDisabled(action, c.state));
  if (targets.length === 0) {
    showInfo(`${meta.title}: no cluster in "${groupName}" can be ${meta.verb} right now.`);
    return;
  }

  const names = targets.map(c => c.name || c.id).filter(Boolean).join(", ");
  const detail = action === "stop"
    ? "\n\nInstances are terminated. S3 logs, environment and knowledge-base are preserved."
    : action === "pause"
      ? "\n\nInstances keep running. Use Resume to continue."
      : "\n\nAgents pick up their loop on the next poll cycle.";
  const ok = await ctx.confirm({
    title: `${meta.title} \u201c${groupName}\u201d`,
    message: `This will ${action} ${targets.length} cluster${targets.length === 1 ? "" : "s"} in "${groupName}":\n${names}${detail}`,
    confirmLabel: meta.confirm,
    destructive: meta.destructive,
  });
  if (!ok) return;

  if (btnEl) btnEl.disabled = true;
  const settled = await Promise.allSettled(
    targets.map(c => apiClient[action](c.id)),
  );
  const failures = settled
    .map((r, i) => ({ r, c: targets[i] }))
    .filter(({ r }) => r.status === "rejected");
  const succeeded = settled.length - failures.length;

  if (failures.length > 0) {
    const first = failures[0];
    const reason = first.r.reason;
    const msg = reason && reason.message ? reason.message : String(reason);
    showError(`${meta.title} "${groupName}": ${succeeded} ${meta.verb}, ${failures.length} failed (${first.c.name || first.c.id}: ${msg}).`);
  } else {
    showInfo(`${meta.title} "${groupName}": ${succeeded} cluster${succeeded === 1 ? "" : "s"} ${meta.verb}.`);
  }

  // The next poll re-renders the frame and recomputes button state, so the
  // manual re-enable only matters if the poll is slow to land.
  if (btnEl) btnEl.disabled = false;
  pollClusters();
}

async function _wbHandleCardAction(clusterId, action, btnEl) {
  if (!action) return;

  if (action === "open") {
    _wbOpenCluster(clusterId);
    return;
  }

  if (btnEl) btnEl.disabled = true;
  try {
    switch (action) {
      case "start":  await apiClient.start(clusterId);  break;
      case "stop":   await apiClient.stop(clusterId);   break;
      case "pause":  await apiClient.pause(clusterId);  break;
      case "resume": await apiClient.resume(clusterId); break;
      default: return;
    }
    pollClusters();
  } catch (err) {
    showError(`${action} ${clusterId} failed: ${err.message || err}`);
    if (btnEl) btnEl.disabled = false;
  }
}

/* ---------- Polling -------------------------------------------------------------------------- */

let _wbClusterPollTimer = null;

const WB_CACHE_KEY = "wb_clusters_v1";

function _wbWriteCache(list) {
  try {
    localStorage.setItem(WB_CACHE_KEY, JSON.stringify({ at: Date.now(), clusters: list }));
  } catch { /* cache is a perf hint, not a correctness requirement */ }
}

function _wbReadCache() {
  try {
    const raw = localStorage.getItem(WB_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.clusters)) return null;
    return parsed.clusters;
  } catch {
    return null;
  }
}

// Freshness readout goes to the shell's shared indicator.
function _wbSetPollIndicator(mode, ts) {
  if (ctx) ctx.topbar.setIndicator(mode, ts);
}

let _wbFirstPollDone = false;

async function pollClusters() {
  try {
    const res = await apiClient.listClusters();
    const list = Array.isArray(res) ? res : (res && Array.isArray(res.clusters) ? res.clusters : []);
    state.clusters = list;
    state.clustersLoading = false;
    state._clusterErrorShown = false;
    _wbFirstPollDone = true;
    _wbWriteCache(list);

    const live = new Set(list.map(c => c.id));
    for (const key of Array.from(_wbDirectionCache.keys())) {
      if (!live.has(key)) _wbDirectionCache.delete(key);
    }
    for (const key of Array.from(_wbConfigCache.keys())) {
      if (!live.has(key)) _wbConfigCache.delete(key);
    }

    renderClusterStacks();
    renderHeader();
    _wbSetPollIndicator("success");
  } catch (err) {
    state.clustersLoading = false;
    _wbSetPollIndicator("error");
    if (!state._clusterErrorShown) {
      state._clusterErrorShown = true;
      showError(`Cluster list poll failed: ${err.message || err}`);
    }
  }
}

function startClusterPolling() {
  if (_wbClusterPollTimer != null) return;
  state.clustersLoading = true;

  // Render from localStorage cache before kicking the network so cards
  // are on screen instantly; .wb-stale dims them until the first poll.
  const cached = _wbReadCache();
  if (cached && cached.length > 0 && !_wbFirstPollDone) {
    state.clusters = cached;
    renderClusterStacks();
    renderHeader();
    let cacheTs = 0;
    try {
      const raw = localStorage.getItem(WB_CACHE_KEY);
      cacheTs = raw ? (JSON.parse(raw).at || 0) : 0;
    } catch { /* ignore */ }
    _wbSetPollIndicator("cached", cacheTs);
  } else if (!_wbFirstPollDone) {
    _wbSetPollIndicator("cached", 0);
  }

  pollClusters();
  _wbClusterPollTimer = setInterval(pollClusters, 3000);
}

function stopClusterPolling() {
  if (_wbClusterPollTimer != null) {
    clearInterval(_wbClusterPollTimer);
    _wbClusterPollTimer = null;
  }
}

/* ---------- Section module interface --------------------------------------------------------- */

export default {
  id: "multi-cluster",
  title: "Multi Cluster",

  async mount(container, shellCtx) {
    ctx = shellCtx;
    container.innerHTML = `
      <div class="wb-pane">
        <div id="cluster-stacks" class="wb-cluster-stacks"></div>
      </div>
    `;
    buildContextControls();
    wireClusterStackEvents();
  },

  show() {
    ctx.topbar.setContext(contextEl);
    startClusterPolling();
    // Re-pack on re-show: the pane was display:none while hidden, so any
    // render that happened just before hide() measured zero-width items.
    _wbLayoutMasonry();
  },

  hide() {
    stopClusterPolling();
  },
};
