/* ============================================================================
   Single Cluster section — the kiro-flock dashboard, ported into the
   unified shell.

   Owns: cluster controls (start/stop/pause/resume), config form with
   drift detection, direction editor, the agent panel grid with directive
   drill-down, and the 3s status poll.

   Shell-owned (NOT here anymore): auth, env panel, toast,
   confirm modal. The pre-merge global fetch interceptor that rewrote
   cluster URLs is gone — this module scopes its API calls explicitly via
   cfetch()/rewriteClusterUrl() and exposes setCluster() so the Multi
   Cluster board can retarget it in-place (ctx.openSection params).

   New in the shell: a cluster picker + state badge + run timer in the
   topbar context slot, and agent panels are clickable — they open the
   Kiro Node section scoped to that agent.
   ============================================================================ */

import { fmtCredits, fmtUsd } from "../costFormat.js";
import { isInterruptedAction, parseInterruptedResult, renderErrorSummary } from "../errorFormat.js";

let ctx = null;
let rootEl = null;

// Topbar context controls.
let contextEl = null;
let clusterSelectEl = null;
let badgeEl = null;
let runTimerEl = null;
let clusterCostEl = null;

const API = "cluster";
const POLL_MS = 3000;

// Remember the last cluster this section was pointed at, so reopening the
// section (or reloading the page) lands on it instead of cluster_0.
const LAST_CLUSTER_KEY = "sc_last_cluster_v1";

// Multi-cluster's cluster-list cache — read-only here, used to resolve a
// sensible starting cluster synchronously (before any network call).
const WB_CACHE_KEY = "wb_clusters_v1";

function readClusterListCache() {
  try {
    const raw = localStorage.getItem(WB_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && Array.isArray(parsed.clusters) ? parsed.clusters : null;
  } catch {
    return null;
  }
}

/** Starting cluster, in priority order:
 *    1. last-opened cluster (localStorage) — skipped if the cached registry
 *       list is available and no longer contains it (deleted cluster),
 *    2. latest running cluster from the cached registry list,
 *    3. "cluster_0".
 *  Explicit navigation (?cluster= deep link, multi-cluster card click)
 *  still wins: show({cluster}) runs setCluster() on top of this. */
function initialClusterId() {
  const cached = readClusterListCache();

  let last = null;
  try { last = localStorage.getItem(LAST_CLUSTER_KEY); } catch { /* ignore */ }
  if (last) {
    if (!cached || cached.some(c => c && c.id === last)) return last;
  }

  if (cached) {
    const running = cached.filter(c => c && c.id && c.state && c.state !== "stopped");
    if (running.length > 0) {
      // "Latest" = most recently created; list order as tiebreaker.
      running.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
      return running[0].id;
    }
  }

  return "cluster_0";
}

let currentClusterId = initialClusterId();

// Scoped element lookup — ids in this section's pane only.
const $ = (id) => rootEl ? rootEl.querySelector("#" + id) : null;

/* ---------- Cluster-scoped fetch ---------------------------------------------

   The pre-merge dashboard monkeypatched window.fetch to suffix cluster ids
   onto every "cluster/..." URL. In the merged page that would corrupt the
   other sections' calls, so the rewrite is now an explicit local helper. */

// Actions that are NOT per-cluster (bucket/account scope).
const GLOBAL_CLUSTER_ACTIONS = new Set([
  "instance-types",
  "knowledge-base",
  "knowledge-base/file",
]);

function rewriteClusterUrl(url) {
  const queryIdx = url.indexOf("?");
  const pathPart = queryIdx >= 0 ? url.slice(0, queryIdx) : url;
  const queryPart = queryIdx >= 0 ? url.slice(queryIdx) : "";
  if (pathPart === "cluster" || pathPart === "cluster/") return url;
  const segments = pathPart.slice("cluster/".length).split("/").filter(Boolean);

  let action;
  let trailing;
  if (segments[0] === "habitat" && segments[1] === "file") {
    action = "habitat/file";
    trailing = segments.slice(2);
  } else if (segments[0] === "knowledge-base" && segments[1] === "file") {
    action = "knowledge-base/file";
    trailing = segments.slice(2);
  } else {
    action = segments[0];
    trailing = segments.slice(1);
  }

  if (GLOBAL_CLUSTER_ACTIONS.has(action)) return url;
  if (trailing.length > 0) return url; // caller already supplied a cluster id

  return `cluster/${action}/${currentClusterId}${queryPart}`;
}

// All cluster API calls in this module go through cfetch. The shell's
// fetch wrapper attaches the bearer token (URL starts with "cluster").
function cfetch(url, opts) {
  return fetch(rewriteClusterUrl(url), opts);
}

/* ---------- Helpers ------------------------------------------------------------ */

const esc = s => s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : "";
const pct = v => v != null ? `${Math.round(v)}%` : "\u2014";
const fmtBytes = v => {
  if (v == null) return "\u2014";
  if (v < 1024) return v + "B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "K";
  return (v / (1024 * 1024)).toFixed(1) + "M";
};
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "\u2026" : (s || "\u2014");
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString() : "\u2014";

function cssEscape(s) {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`);
}

function showError(msg) { if (ctx) ctx.showError(msg); }
function showInfo(msg)  { if (ctx) ctx.showInfo(msg); }

function statusPillClass(s) {
  if (s === "running") return "status-running";
  if (s === "stopped") return "status-stopped";
  if (s === "stopping") return "status-stopping";
  if (s === "paused") return "status-paused";
  return "status-starting";
}

/* ---------- Run timer ------------------------------------------------------------ */

let runStartTime = null;
let _timerInterval = null;

function updateRunTimer() {
  if (!runTimerEl) return;
  if (!runStartTime) { runTimerEl.style.display = "none"; return; }
  runTimerEl.style.display = "";
  const elapsed = Math.floor((Date.now() - runStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const s = String(elapsed % 60).padStart(2, "0");
  runTimerEl.textContent = `${h}:${m}:${s}`;
}

/* ---------- Direction + config state ------------------------------------------------ */

let savedDirection = "";
let savedConfig = null;
let latestServerConfig = null;
let currentClusterState = null;

/* Per-agent model overrides, straight from the polled config
   (`config.models`). Derived from config rather than from a snapshot field
   so the pill flips on the next 3s poll instead of waiting for a snapshot
   rebuild. Null until the first poll carries a config. */
let latestModelOverrides = null;

/* model_id -> catalog entry, kept from loadModels() so pills can show a
   display name instead of a raw id. The picker builds <option>s from the
   same fetch and used to discard the catalog afterwards. */
let modelsById = new Map();

/* Look up this agent's model override. Returns `undefined` when the agent
   has no override (no pill), `null` when it is explicitly pinned to
   kiro-cli's default, or the model id. The distinction between "absent" and
   "null" is the whole point of the pill, so it can't collapse to a falsy
   check. */
function modelOverrideFor(agentId) {
  if (!latestModelOverrides) return undefined;
  const m = /^agent-(\d+)$/.exec(agentId);
  if (!m) return undefined;
  const key = m[1];
  if (!Object.prototype.hasOwnProperty.call(latestModelOverrides, key)) return undefined;
  const value = latestModelOverrides[key];
  return value === null || typeof value === "string" ? value : undefined;
}

/* Pill label: the catalog's display name when we have it, else the raw id.
   Same `model_name || model_id` convention the picker uses. A null override
   reads as "default" — meaning kiro-cli's own default, not the cluster
   model. */
function modelLabel(model) {
  if (model === null) return "default";
  const entry = modelsById.get(model);
  return trunc(entry && entry.model_name ? entry.model_name : model, 22);
}

/* Tooltip carries the unabbreviated truth: that this is an override, the
   full id, and the catalog description when present. */
function modelTitle(model) {
  if (model === null) {
    return "model override \u2014 pinned to kiro-cli's own default, ignoring the cluster model";
  }
  const entry = modelsById.get(model);
  const parts = [`model override \u2014 ${model}`];
  if (entry && entry.model_name && entry.model_name !== model) parts.push(entry.model_name);
  if (entry && entry.description) parts.push(entry.description);
  return parts.join("\n");
}

/* How many agents differ from the cluster baseline, for the hint next to
   the config form's model label. */
function modelOverrideCount() {
  if (!latestModelOverrides) return 0;
  return Object.keys(latestModelOverrides)
    .filter(k => /^\d+$/.test(k))
    .length;
}

async function loadDirection() {
  try {
    const res = await cfetch(`${API}/direction`);
    if (res.ok) {
      const { direction } = await res.json();
      savedDirection = direction || "";
      const ta = $("in-direction");
      ta.value = savedDirection;
      directionValue = savedDirection;
      updateDirectionPreview();
      syncSaveBtn();
    }
  } catch { /* non-fatal */ }
}

function syncSaveBtn() {
  const ta = $("in-direction");
  const btn = $("btn-save");
  const refreshBtn = $("btn-config-refresh");
  if (!ta || !btn) return;

  const directionChanged = ta.value.trim() !== savedDirection.trim();
  const configChanged = hasConfigDrift();
  const changed = directionChanged || configChanged;
  const blockedByStarting = currentClusterState === "starting";
  const enable = changed && !blockedByStarting;

  btn.disabled = !enable;
  btn.style.opacity = enable ? "1" : "0.4";
  btn.style.cursor = enable ? "pointer" : "default";
  btn.title = blockedByStarting
    ? "cluster is starting, wait for it to finish"
    : changed ? "Push direction and config" : "No unsaved changes";

  if (refreshBtn) {
    const serverDrifted = serverDiffersFromSaved();
    refreshBtn.style.display = (serverDrifted && savedConfig !== null && !blockedByStarting) ? "" : "none";
  }
}

function hasConfigDrift() {
  if (!savedConfig) return false;
  const form = readConfigForm();
  if (form.algorithm !== savedConfig.algorithm) return true;
  if (form.concurrency !== savedConfig.concurrency) return true;
  if (form.loopIntervalSeconds !== savedConfig.loopIntervalSeconds) return true;
  if (form.computeType !== savedConfig.computeType) return true;
  if (form.instanceType !== savedConfig.instanceType) return true;
  if (form.taskSize !== savedConfig.taskSize) return true;
  if (form.model !== savedConfig.model) return true;
  if (form.autopause !== savedConfig.autopause) return true;
  if (form.selfOptimizing !== savedConfig.selfOptimizing) return true;
  if (form.browserAutomation !== savedConfig.browserAutomation) return true;
  if (form.trustDeploy !== savedConfig.trustDeploy) return true;
  if (form.algorithm === "amorphous" && form.neighbourRadius !== savedConfig.neighbourRadius) return true;
  if (form.algorithm === "swarm" && form.swarmK !== savedConfig.swarmK) return true;
  return false;
}

// Fields baked in at launch time — editing them on a running cluster only
// applies on the next Start.
function hasRestartRequiredDrift() {
  if (!savedConfig) return false;
  const form = readConfigForm();
  // `model` is deliberately absent: it reloads on each agent's next
  // iteration, so editing it on a running cluster is not restart-required.
  return form.concurrency !== savedConfig.concurrency
    || form.computeType !== savedConfig.computeType
    || form.instanceType !== savedConfig.instanceType
    || form.taskSize !== savedConfig.taskSize;
}

function serverDiffersFromSaved() {
  if (!savedConfig || !latestServerConfig) return false;
  const baseKeys = ["algorithm", "concurrency", "loopIntervalSeconds", "computeType", "instanceType", "taskSize", "model", "autopause", "selfOptimizing", "browserAutomation", "trustDeploy"];
  if (baseKeys.some(k => latestServerConfig[k] !== savedConfig[k])) return true;
  const algo = latestServerConfig.algorithm;
  if (algo === "amorphous" && latestServerConfig.neighbourRadius !== savedConfig.neighbourRadius) return true;
  if (algo === "swarm" && latestServerConfig.swarmK !== savedConfig.swarmK) return true;
  return false;
}

function readConfigForm() {
  const interval = parseInt($("in-interval").value);
  const modelSel = $("in-model");
  return {
    algorithm: currentAlgorithm,
    concurrency: parseInt($("in-concurrency").value) || 1,
    loopIntervalSeconds: Number.isFinite(interval) ? interval : 30,
    computeType: $("in-compute").value === "ecs" ? "ecs" : "ec2",
    instanceType: $("in-instance").value || "t4g.medium",
    taskSize: $("in-tasksize").value || "medium",
    model: (modelSel && modelSel.value) ? modelSel.value : null,
    neighbourRadius: parseInt($("in-neighbours").value) || 0,
    swarmK: parseInt($("in-swarmk").value) || 4,
    autopause: $("in-autopause").checked,
    selfOptimizing: $("in-self-optimizing").checked,
    browserAutomation: $("in-browser-automation").checked,
    trustDeploy: $("in-trust-deploy").checked,
  };
}

async function loadConfig() {
  try {
    const res = await cfetch(`${API}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    applyServerConfig(cfg);
  } catch { /* non-fatal */ }
}

function applyServerConfig(cfg) {
  if (cfg.loopIntervalSeconds != null) $("in-interval").value = cfg.loopIntervalSeconds;
  if (cfg.concurrency != null) $("in-concurrency").value = cfg.concurrency;
  if (cfg.neighbourRadius != null) $("in-neighbours").value = cfg.neighbourRadius;
  if (cfg.swarmK != null) $("in-swarmk").value = cfg.swarmK;
  $("in-compute").value = cfg.computeType === "ecs" ? "ecs" : "ec2";
  {
    const tsSel = $("in-tasksize");
    const want = cfg.taskSize ?? "medium";
    if (tsSel && [...tsSel.options].some(o => o.value === want)) tsSel.value = want;
  }
  syncComputeUI();
  if (cfg.instanceType) {
    const sel = $("in-instance");
    if ([...sel.options].some(o => o.value === cfg.instanceType)) {
      sel.value = cfg.instanceType;
    }
  }
  {
    const mSel = $("in-model");
    if (mSel) {
      const want = cfg.model ?? "";
      if ([...mSel.options].some(o => o.value === want)) mSel.value = want;
    }
  }
  if (cfg.algorithm) applyAlgorithmUI(cfg.algorithm);
  $("in-autopause").checked = cfg.autopause !== false;
  $("in-self-optimizing").checked = !!cfg.selfOptimizing;
  $("in-browser-automation").checked = !!cfg.browserAutomation;
  $("in-trust-deploy").checked = !!cfg.trustDeploy;
  savedConfig = {
    algorithm: cfg.algorithm ?? "amorphous",
    concurrency: cfg.concurrency ?? 8,
    loopIntervalSeconds: cfg.loopIntervalSeconds ?? 30,
    computeType: cfg.computeType === "ecs" ? "ecs" : "ec2",
    instanceType: cfg.instanceType ?? "t4g.medium",
    taskSize: cfg.taskSize ?? "medium",
    model: cfg.model ?? null,
    neighbourRadius: cfg.neighbourRadius ?? 1,
    swarmK: cfg.swarmK ?? 4,
    autopause: cfg.autopause !== false,
    selfOptimizing: !!cfg.selfOptimizing,
    browserAutomation: !!cfg.browserAutomation,
    trustDeploy: !!cfg.trustDeploy,
  };
  checkCapacity();
  syncSaveBtn();
}

async function refreshConfig() {
  try {
    const res = await cfetch(`${API}/config`);
    if (!res.ok) { showError(`refresh failed: ${res.status}`); return; }
    const cfg = await res.json();
    applyServerConfig(cfg);
  } catch (err) { showError(`refresh failed: ${err.message}`); }
}

/* ---------- Algorithm selector -------------------------------------------------------- */

let currentAlgorithm = "amorphous";

function applyAlgorithmUI(algo) {
  currentAlgorithm = algo;
  // Retint is scoped to this section's root — the shell chrome and the
  // other sections keep the app-wide theme.
  rootEl.dataset.algorithm = algo;

  const sel = $("in-algorithm");
  if (sel) {
    sel.value = algo;
    sel.className = "algo-select " + algo;
  }

  const fNeighbours = $("field-neighbours");
  const fSwarmK = $("field-swarmk");
  const concInput = $("in-concurrency");
  const concField = concInput.closest(".field");

  if (algo === "mesh") {
    fNeighbours.style.display = "none";
    fSwarmK.style.display = "none";
  } else if (algo === "swarm") {
    fNeighbours.style.display = "none";
    fSwarmK.style.display = "";
  } else if (algo === "single") {
    fNeighbours.style.display = "none";
    fSwarmK.style.display = "none";
  } else {
    fNeighbours.style.display = "";
    fSwarmK.style.display = "none";
  }

  // single no longer locks the stepper: each agent works alone, so N agents
  // are N independent runs of the direction. The field just says so.
  concInput.disabled = false;
  concField.style.opacity = "";
  concField.title = algo === "single"
    ? "Number of agents \u2014 in single mode each one works the direction alone, with no peers"
    : "Number of agents in the flock";

  const conc = parseInt(concInput.value) || 1;
  const kInput = $("in-swarmk");
  const maxK = Math.max(1, conc - 1);
  kInput.max = maxK;
  if (parseInt(kInput.value) > maxK) kInput.value = maxK;
}

function selectAlgorithm(algo) {
  if (algo === currentAlgorithm) return;
  applyAlgorithmUI(algo);
  syncSaveBtn();
}

/* ---------- Instance types + models ------------------------------------------------------ */

let instanceSpecs = {};
let vcpuQuota = 0;
let concurrencyCap = 600;

async function loadInstanceTypes() {
  const sel = $("in-instance");
  try {
    const res = await cfetch(`${API}/instance-types`);
    if (!res.ok) return;
    const data = await res.json();
    const { instanceTypes } = data;
    vcpuQuota = data.vcpuQuota || 0;
    concurrencyCap = data.concurrencyCap || 600;

    const concInput = $("in-concurrency");
    concInput.max = concurrencyCap;
    if ((parseInt(concInput.value) || 0) > concurrencyCap) {
      concInput.value = concurrencyCap;
    }

    const capLabel = $("concurrency-cap-label");
    if (capLabel) capLabel.textContent = concurrencyCap;
    if (!instanceTypes || !instanceTypes.length) return;
    instanceSpecs = {};
    instanceTypes.forEach(t => {
      instanceSpecs[t.type] = { vcpus: t.vcpus, memoryGb: t.memoryGb };
    });
    sel.innerHTML = instanceTypes.map(t => {
      const maxAgents = vcpuQuota > 0 ? Math.floor(vcpuQuota / t.vcpus) : null;
      const maxStr = maxAgents !== null ? ` / quota: ${maxAgents} agents` : "";
      const label = `${t.type}  (${t.vcpus} vCPU, ${t.memoryGb} GB${maxStr})`;
      return `<option value="${t.type}"${t.type === "t4g.medium" ? " selected" : ""}>${label}</option>`;
    }).join("");
    if (savedConfig && savedConfig.instanceType) {
      if ([...sel.options].some(o => o.value === savedConfig.instanceType)) {
        sel.value = savedConfig.instanceType;
      }
    }
    checkCapacity();
    syncSaveBtn();
  } catch { /* non-fatal */ }
}

async function loadModels() {
  const sel = $("in-model");
  if (!sel) return;
  const fmtCtx = n => (n >= 1e6 ? `${n / 1e6}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
  try {
    const res = await cfetch(`${API}/models`);
    if (!res.ok) return;
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models : [];
    // Keep the catalog, not just the <option>s: the per-agent model pills
    // need display names and descriptions too.
    modelsById = new Map(models.filter(m => m && m.model_id).map(m => [m.model_id, m]));
    const opts = ['<option value="">default</option>'];
    for (const m of models) {
      const id = m && m.model_id;
      if (!id) continue;
      const name = m.model_name || id;
      const ctxStr = m.context_window_tokens ? `  (${fmtCtx(m.context_window_tokens)} ctx)` : "";
      const title = m.description ? ` title="${esc(m.description)}"` : "";
      opts.push(`<option value="${esc(id)}"${title}>${esc(name)}${ctxStr}</option>`);
    }
    sel.innerHTML = opts.join("");
    if (savedConfig) {
      const want = savedConfig.model ?? "";
      if ([...sel.options].some(o => o.value === want)) sel.value = want;
    }
    syncSaveBtn();
  } catch { /* non-fatal — picker stays at "default" only */ }
}

// Swap the sizing picker with the compute backend: the EC2 instance-type
// dropdown on ec2, the Fargate task-size dropdown on ecs. Both selects
// keep their values while hidden so switching back restores the pick.
// The picker shows the cluster baseline, which becomes a half-truth once
// individual agents are overridden. Say so next to the label rather than
// letting the operator read one model and assume it applies to everything.
function syncModelOverrideHint() {
  const el = $("model-override-hint");
  if (!el) return;
  const n = modelOverrideCount();
  if (n === 0) {
    el.style.display = "none";
    el.textContent = "";
    el.removeAttribute("title");
    return;
  }
  el.textContent = `+${n} overridden`;
  el.title = `${n} agent${n === 1 ? "" : "s"} run a different model than this baseline. See the pills on the agent panels; set them via the models map in cluster config.`;
  el.style.display = "";
}

function syncComputeUI() {
  const isEcs = $("in-compute").value === "ecs";
  const instField = $("field-instance");
  if (instField) instField.style.display = isEcs ? "none" : "";
  const sizeField = $("field-tasksize");
  if (sizeField) sizeField.style.display = isEcs ? "" : "none";
}

function checkCapacity() {
  const concurrency = parseInt($("in-concurrency").value) || 0;
  const isEcs = $("in-compute") && $("in-compute").value === "ecs";
  const val = $("in-instance").value;
  // The EC2 on-demand vCPU quota doesn't govern Fargate tasks (they have
  // their own Fargate quota) — skip the vCPU math on ecs compute.
  const spec = isEcs ? null : instanceSpecs[val];
  const vcpusNeeded = spec ? concurrency * spec.vcpus : 0;
  const maxInstances = spec && vcpuQuota > 0 ? Math.floor(vcpuQuota / spec.vcpus) : null;
  const btn = $("btn-start");
  const warn = $("capacity-warn");

  if (concurrency > concurrencyCap) {
    btn.disabled = true;
    if (warn) {
      warn.textContent = `${concurrency} agents exceeds the configured cap of ${concurrencyCap}.`;
      warn.style.display = "block";
    }
  } else if (vcpuQuota > 0 && vcpusNeeded > vcpuQuota) {
    btn.disabled = true;
    if (warn) {
      warn.textContent = `${concurrency} agents needs ${vcpusNeeded} vCPUs, your limit allows ${maxInstances} agents of this type. Request an increase in Service Quotas.`;
      warn.style.display = "block";
    }
  } else {
    btn.disabled = false;
    if (warn) warn.style.display = "none";
  }

  const agentsLabel = $("agents-usage");
  if (agentsLabel && maxInstances !== null) {
    agentsLabel.textContent = `${concurrency} / ${maxInstances}`;
  } else if (agentsLabel) {
    agentsLabel.textContent = "";
  }

  const kInput = $("in-swarmk");
  if (kInput) {
    const maxK = Math.max(1, concurrency - 1);
    kInput.max = maxK;
    if ((parseInt(kInput.value) || 0) > maxK) kInput.value = maxK;
  }
}

function stepVal(id, delta) {
  const el = $(id);
  const min = parseInt(el.min) || 0;
  const max = parseInt(el.max) || 999;
  const next = Math.max(min, Math.min(max, (parseInt(el.value) || 0) + delta));
  el.value = next;
  checkCapacity();
  syncSaveBtn();
}

/* ---------- Agent panels -------------------------------------------------------------------- */

// Credit → dollar conversion at the overage rate (shared module).

function fmtInfraCost(usd) {
  if (usd == null) return null;
  return fmtUsd(usd);
}

/** Unified cost string: ai[cr, $] / infra[$] in the --cost color. */
function fmtCostLine(totalCredits, infraCostUsd) {
  const parts = [];
  if (typeof totalCredits === "number") {
    parts.push(`ai[${fmtCredits(totalCredits)}]`);
  }
  if (typeof infraCostUsd === "number" && infraCostUsd > 0) {
    parts.push(`infra[${fmtInfraCost(infraCostUsd)}]`);
  }
  if (parts.length === 0) return "";
  return `<span class="cost-label" title="AI = model credits at overage rate; Infra = EC2/Fargate compute cost">${parts.join(" / ")}</span>`;
}

/** One `res` row. Interrupted entries render as a classified one-line
 *  summary (badge + headline, clipped by CSS — deliberately NO unfold:
 *  the panel is a glance surface, the full blob lives in the Kiro Node
 *  transcript). Everything else stays plain text. */
function resultRowHtml(agentId, which, entry) {
  if (isInterruptedAction(entry.action)) {
    const parsed = parseInterruptedResult(entry.result);
    if (parsed) {
      const title = ` title="${esc(parsed.headline)} — full error in the Kiro Node view (click the panel)"`;
      return `<div class="iter-row"><span class="k">res</span><span class="v-result v-result--error"${title}>${renderErrorSummary(parsed)}</span></div>`;
    }
  }
  return `<div class="iter-row"><span class="k">res</span><span class="v-result">${esc(entry.result)}</span></div>`;
}

function renderPanel(a, clusterState, algorithm) {
  const m = a.metrics || {};
  const prev = a.prevEntry;
  const cur = a.lastEntry;
  const paused = clusterState === "paused";
  const pillStatus = paused ? "paused" : a.status;

  let peerLabel;
  if (algorithm === "mesh") {
    peerLabel = "peers: all";
  } else if (algorithm === "swarm") {
    peerLabel = `peers: ${a.neighbours && a.neighbours.length ? esc(a.neighbours.join(", ")) : "none yet"}`;
  } else if (algorithm === "single") {
    peerLabel = "peers: solo";
  } else {
    peerLabel = `neighbours: ${a.neighbours && a.neighbours.length ? esc(a.neighbours.join(", ")) : "none"}`;
  }

  const directivePill = a.hasDirective
    ? `<span class="directive-pill" data-directive-toggle="${esc(a.agentId)}" title="per-agent directive \u2014 click to view">directive</span>`
    : "";

  // Only agents that differ from the cluster baseline get a model pill —
  // showing it on every agent would make the exception invisible.
  const modelOverride = modelOverrideFor(a.agentId);
  const modelPill = modelOverride !== undefined
    ? `<span class="model-pill" title="${esc(modelTitle(modelOverride))}">${esc(modelLabel(modelOverride))}</span>`
    : "";

  let html = `<div class="panel-head">
    <span class="agent-name">${esc(a.agentId)}</span>
    <span class="head-right">
      ${modelPill}
      ${directivePill}
      <span class="status-pill ${statusPillClass(pillStatus)}">${esc(pillStatus)}</span>
    </span>
  </div>
  <div class="panel-meta">
    <span class="mono">${trunc(a.instanceId, 19)} \u00b7 ${esc(a.instanceState || "\u2014")}</span>
    <span>updated ${fmtTime(a.lastUpdatedTs)}${a.elapsedSeconds != null ? ` (${a.elapsedSeconds}s ago)` : ""}</span>
    <span>${peerLabel}</span>
    ${(a.totalCredits != null || a.infraCostUsd != null) ? fmtCostLine(a.totalCredits, a.infraCostUsd) : ""}
  </div>
  <div class="metrics-bar">
    <div class="metric"><span class="metric-val">${pct(m.cpu)}</span><span class="metric-label">cpu</span></div>
    <div class="metric"><span class="metric-val">\u2191${fmtBytes(m.netOut)} \u2193${fmtBytes(m.netIn)}</span><span class="metric-label">net</span></div>
    <div class="metric"><span class="metric-val">${m.status != null ? (m.status === 0 ? '[ok]' : '[x]') : '\u2014'}</span><span class="metric-label">health</span></div>
  </div>
  <div class="directive-body" data-directive-body="${esc(a.agentId)}" hidden></div>`;

  if (prev) {
    // `res` is shown for the previous iteration too, not just the current one.
    // Failure reasons live in this field, and with only the current iteration
    // rendering it a failed iteration's cause was visible for one refresh
    // interval and then gone — on an agent failing often, that is most of them.
    html += `<div class="iter-section">
      <div class="iter-tag">prev \u00b7 iter ${prev.iteration}</div>
      <div class="iter-row"><span class="k">did</span><span class="v-action">${esc(prev.action)}</span></div>
      ${prev.result ? resultRowHtml(a.agentId, "prev", prev) : ""}
    </div>`;
  }
  if (cur) {
    html += `<div class="iter-section">
      <div class="iter-tag">current \u00b7 iter ${cur.iteration}</div>
      <div class="iter-row"><span class="k">did</span><span class="v-action">${esc(cur.action)}</span></div>
      ${resultRowHtml(a.agentId, "cur", cur)}
      <div class="iter-row"><span class="k">next</span><span class="v-next">${esc(cur.next_intent)}</span></div>
    </div>`;
  } else {
    html += `<div class="waiting">waiting for first iteration\u2026</div>`;
  }
  return html;
}

function render(data) {
  const grid = $("grid");
  const cs = data.clusterState || "stopped";

  if (badgeEl) {
    badgeEl.textContent = cs;
    badgeEl.className = `badge badge-${cs}`;
  }

  // Cluster-wide cost display (AI credits + infra), from the snapshot.
  if (clusterCostEl) {
    const hasCredits = typeof data.totalCredits === "number";
    const hasInfra = typeof data.infraCostUsd === "number" && data.infraCostUsd > 0;
    if (hasCredits || hasInfra) {
      const parts = [];
      if (hasCredits) parts.push(`ai[${fmtCredits(data.totalCredits)}]`);
      if (hasInfra) parts.push(`infra[${fmtInfraCost(data.infraCostUsd)}]`);
      clusterCostEl.textContent = parts.join(" / ");
      clusterCostEl.style.display = "";
    } else {
      clusterCostEl.style.display = "none";
    }
  }

  const launchErrEl = $("launch-error");
  if (launchErrEl) {
    const le = data.lastError;
    if (le && le.code) {
      const when = le.at ? new Date(le.at).toLocaleString() : "";
      launchErrEl.textContent =
        `\u26A0 Launch failed (${le.code}): ${le.message}` + (when ? `  \u2014 ${when}` : "");
      launchErrEl.style.display = "block";
    } else {
      launchErrEl.style.display = "none";
      launchErrEl.textContent = "";
    }
  }

  currentClusterState = cs;

  if (data.config) {
    latestServerConfig = {
      algorithm: data.config.algorithm ?? "amorphous",
      concurrency: data.config.concurrency ?? 8,
      loopIntervalSeconds: data.config.loopIntervalSeconds ?? 30,
      computeType: data.config.computeType === "ecs" ? "ecs" : "ec2",
      instanceType: data.config.instanceType ?? "t4g.medium",
      taskSize: data.config.taskSize ?? "medium",
      // serverDiffersFromSaved() compares `model`, so it has to be set here.
      // Without it the comparison was undefined !== null on every poll, which
      // left the refresh affordance permanently visible.
      model: data.config.model ?? null,
      neighbourRadius: data.config.neighbourRadius ?? 1,
      swarmK: data.config.swarmK ?? 4,
      autopause: data.config.autopause !== false,
      selfOptimizing: !!data.config.selfOptimizing,
      browserAutomation: !!data.config.browserAutomation,
      trustDeploy: !!data.config.trustDeploy,
    };
    // Per-agent overrides feed the panel pills. Held separately from
    // latestServerConfig because there is no form control for them, so they
    // take no part in drift detection.
    latestModelOverrides =
      data.config.models && typeof data.config.models === "object" && !Array.isArray(data.config.models)
        ? data.config.models
        : null;
    syncModelOverrideHint();
    syncSaveBtn();
  }

  if (data.clusterStartTime && (cs === "running" || cs === "starting" || cs === "stopping" || cs === "paused")) {
    runStartTime = new Date(data.clusterStartTime).getTime();
    updateRunTimer();
  } else if (cs === "stopped") {
    runStartTime = null;
    updateRunTimer();
  }

  // Primary button cycles Start → Pause → Resume based on cluster state.
  const btnStart = $("btn-start");
  const btnStop = $("btn-stop");
  const agents = data.agents || [];
  const anyLogEntry = agents.some(a => a.lastEntry);

  btnStart.classList.remove("btn-pause", "btn-resume");

  if (cs === "stopped") {
    btnStart.textContent = "Start";
    btnStart.onclick = startCluster;
    btnStart.disabled = false;
    btnStart.style.opacity = "1";
  } else if (cs === "starting") {
    btnStart.textContent = "Start";
    btnStart.onclick = startCluster;
    btnStart.disabled = true;
    btnStart.style.opacity = "0.3";
  } else if (cs === "running" && anyLogEntry) {
    btnStart.textContent = "Pause";
    btnStart.onclick = pauseCluster;
    btnStart.disabled = false;
    btnStart.style.opacity = "1";
    btnStart.classList.add("btn-pause");
  } else if (cs === "running") {
    btnStart.textContent = "Pause";
    btnStart.onclick = pauseCluster;
    btnStart.disabled = true;
    btnStart.style.opacity = "0.3";
    btnStart.classList.add("btn-pause");
  } else if (cs === "paused") {
    btnStart.textContent = "Resume";
    btnStart.onclick = resumeCluster;
    btnStart.disabled = false;
    btnStart.style.opacity = "1";
    btnStart.classList.add("btn-resume");
  } else if (cs === "stopping") {
    btnStart.textContent = "Pause";
    btnStart.onclick = pauseCluster;
    btnStart.disabled = true;
    btnStart.style.opacity = "0.3";
    btnStart.classList.add("btn-pause");
  }

  if (cs === "stopping") {
    btnStop.textContent = "Stopping\u2026";
    btnStop.disabled = true;
    btnStop.style.opacity = "0.3";
  } else {
    btnStop.textContent = "Stop";
    const canStop = cs !== "stopped";
    btnStop.disabled = !canStop;
    btnStop.style.opacity = canStop ? "1" : "0.3";
  }

  if (agents.length === 0) {
    grid.innerHTML = `<div class="empty-state"><div class="icon">\u25CB</div><p>No agents running. Hit Start to spin up the flock.</p></div>`;
    return;
  }

  const firstChild = grid.children[0];
  const needsRebuild = grid.children.length !== agents.length
    || !firstChild
    || !firstChild.classList.contains("panel");
  if (needsRebuild) {
    grid.innerHTML = agents.map(() => '<div class="panel"></div>').join("");
  }
  agents.forEach((a, i) => {
    const panel = grid.children[i];
    const runningAlgorithm = data.config?.algorithm || "amorphous";

    const liveBody = panel.querySelector(
      `[data-directive-body="${cssEscape(a.agentId)}"]`,
    );
    if (liveBody && !liveBody.hidden) {
      const cached = _directiveCache.get(a.agentId);
      if (cached) cached.scrollTop = liveBody.scrollTop;
    }

    panel.innerHTML = renderPanel(a, cs, runningAlgorithm);
    panel.classList.toggle("paused", cs === "paused");
    // Node identity for the Kiro Node drill-down click.
    panel.dataset.agentId = a.agentId;
    panel.title = `${a.agentId} \u2014 click to open console + ACP stream`;
    restoreDirectiveBody(panel, a.agentId);
  });
}

/* ---------- Directive view ---------------------------------------------------------------------- */

const _directiveCache = new Map();

function restoreDirectiveBody(panel, agentId) {
  const entry = _directiveCache.get(agentId);
  if (!entry || !entry.isOpen) return;
  const body = panel.querySelector(`[data-directive-body="${cssEscape(agentId)}"]`);
  if (!body) return;
  if (entry.html) {
    body.innerHTML = entry.html;
    body.hidden = false;
    if (typeof entry.scrollTop === "number") {
      body.scrollTop = entry.scrollTop;
    }
  } else {
    body.innerHTML = `<em class="directive-loading">loading\u2026</em>`;
    body.hidden = false;
    fetchDirectiveInto(agentId, body);
  }
}

async function fetchDirectiveInto(agentId, bodyEl) {
  const m = /^agent-(\d+)$/.exec(agentId);
  if (!m) {
    bodyEl.innerHTML = `<em class="directive-error">unknown agent id: ${esc(agentId)}</em>`;
    return;
  }
  const agentIndex = m[1];
  try {
    const res = await cfetch(`${API}/agent-directive?agentIndex=${encodeURIComponent(agentIndex)}`);
    if (!res.ok) {
      const cached = _directiveCache.get(agentId);
      if (!cached || !cached.html) {
        bodyEl.innerHTML = `<em class="directive-error">fetch failed: ${res.status}</em>`;
      }
      return;
    }
    const { directive } = await res.json();
    let html;
    if (!directive) {
      html = `<em class="directive-empty">no directive</em>`;
    } else if (typeof window.marked !== "undefined") {
      html = window.marked.parse(directive);
    } else {
      html = `<pre>${esc(directive)}</pre>`;
    }
    const prevScroll = bodyEl.scrollTop;
    bodyEl.innerHTML = html;
    bodyEl.scrollTop = prevScroll;
    const cached = _directiveCache.get(agentId) || { isOpen: true };
    cached.html = html;
    cached.isOpen = true;
    cached.scrollTop = prevScroll;
    _directiveCache.set(agentId, cached);
  } catch (err) {
    const cached = _directiveCache.get(agentId);
    if (!cached || !cached.html) {
      bodyEl.innerHTML = `<em class="directive-error">fetch failed: ${esc(err.message)}</em>`;
    }
  }
}

function wireGridEvents() {
  const grid = $("grid");
  grid.addEventListener("click", (e) => {
    // Directive pill toggle takes precedence over the node drill-down.
    const trigger = e.target && e.target.closest && e.target.closest("[data-directive-toggle]");
    if (trigger) {
      const agentId = trigger.dataset.directiveToggle;
      if (!agentId) return;
      const panel = trigger.closest(".panel");
      if (!panel) return;
      const body = panel.querySelector(`[data-directive-body="${cssEscape(agentId)}"]`);
      if (!body) return;

      const cached = _directiveCache.get(agentId) || { isOpen: false, html: null };
      cached.isOpen = !cached.isOpen;
      _directiveCache.set(agentId, cached);

      if (!cached.isOpen) {
        body.hidden = true;
        return;
      }

      if (cached.html) {
        body.innerHTML = cached.html;
        if (typeof cached.scrollTop === "number") {
          body.scrollTop = cached.scrollTop;
        }
      } else {
        body.innerHTML = `<em class="directive-loading">loading\u2026</em>`;
      }
      body.hidden = false;
      fetchDirectiveInto(agentId, body);
      return;
    }

    // Clicks inside an open directive body shouldn't navigate.
    if (e.target.closest && e.target.closest(".directive-body")) return;

    // Node drill-down: clicking an agent panel opens the Kiro Node
    // section (console + ACP stream) scoped to that agent.
    const panel = e.target.closest && e.target.closest(".panel");
    if (!panel || !panel.dataset.agentId) return;
    const idx = /^agent-(\d+)$/.exec(panel.dataset.agentId);
    if (!idx) return;
    ctx.openSection("kiro-node", {
      cluster: currentClusterId,
      agentIndex: parseInt(idx[1], 10),
    });
  });
}

/* ---------- Polling -------------------------------------------------------------------------------- */

let _pollTimer = null;
let unloading = false;
window.addEventListener("beforeunload", () => { unloading = true; });

async function poll() {
  try {
    const res = await cfetch(`${API}/status`);
    if (!res.ok) {
      showError(`status ${res.status}: ${await res.text()}`);
      ctx.topbar.setIndicator("error");
      return;
    }
    render(await res.json());
    ctx.topbar.setIndicator("success");
  } catch (err) {
    if (!unloading) {
      showError(`poll failed: ${err.message}`);
      ctx.topbar.setIndicator("error");
    }
  }
}

function startPolling() {
  if (_pollTimer != null) return;
  poll();
  _pollTimer = setInterval(poll, POLL_MS);
  if (_timerInterval == null) _timerInterval = setInterval(updateRunTimer, 1000);
}

function stopPolling() {
  if (_pollTimer != null) { clearInterval(_pollTimer); _pollTimer = null; }
  if (_timerInterval != null) { clearInterval(_timerInterval); _timerInterval = null; }
}

/* ---------- Save / lifecycle actions ------------------------------------------------------------------ */

async function saveDirection() {
  const ta = $("in-direction");
  const direction = ta.value.trim();
  const directionChanged = direction !== savedDirection.trim();
  const configChanged = hasConfigDrift();

  if (!directionChanged && !configChanged) return;

  if (directionChanged) {
    try {
      const res = await cfetch(`${API}/direction`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ direction }),
      });
      if (!res.ok) { showError(`save direction failed: ${res.status} ${await res.text()}`); return; }
      ta.classList.remove("error");
      savedDirection = direction;
    } catch (err) { showError(`save direction failed: ${err.message}`); return; }
  }

  if (configChanged) {
    const cfg = readConfigForm();
    try {
      const res = await cfetch(`${API}/config`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(cfg),
      });
      if (!res.ok) { showError(`save config failed: ${res.status} ${await res.text()}`); return; }
      savedConfig = readConfigForm();
    } catch (err) { showError(`save config failed: ${err.message}`); return; }
  }

  syncSaveBtn();
}

async function startCluster() {
  const ta = $("in-direction");
  if (!ta.value.trim()) {
    openDirectionPopup();
    showError("Direction is required \u2014 describe what the agents should work on before starting.");
    return;
  }
  ta.classList.remove("error");
  await saveDirection();
  const btn = $("btn-start");
  btn.disabled = true;
  btn.textContent = "Starting\u2026";
  try {
    const cfg = readConfigForm();
    const cfgRes = await cfetch(`${API}/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
    if (!cfgRes.ok) { showError(`config update failed: ${cfgRes.status} ${await cfgRes.text()}`); return; }
    savedConfig = readConfigForm();
    syncSaveBtn();
    const startRes = await cfetch(`${API}/start`, { method: "POST" });
    if (!startRes.ok && startRes.status !== 202) { showError(`start failed: ${startRes.status} ${await startRes.text()}`); return; }
    await poll();
  } catch (err) { showError(`start failed: ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = "Start"; }
}

async function stopCluster() {
  const btn = $("btn-stop");
  btn.disabled = true;
  try {
    const res = await cfetch(`${API}/stop`, { method: "POST" });
    if (!res.ok) { showError(`stop failed: ${res.status} ${await res.text()}`); return; }
    await poll();
  } catch (err) { showError(`stop failed: ${err.message}`); }
  // No finally reset: render() owns the enabled/label state.
}

async function pauseCluster() {
  const btn = $("btn-start");
  btn.disabled = true;
  btn.textContent = "Pausing\u2026";
  try {
    const res = await cfetch(`${API}/pause`, { method: "POST" });
    if (!res.ok) {
      showError(`pause failed: ${res.status} ${await res.text()}`);
      return;
    }
    await poll();
  } catch (err) {
    showError(`pause failed: ${err.message}`);
  } finally { btn.disabled = false; }
}

async function resumeCluster() {
  const btn = $("btn-start");
  btn.disabled = true;
  btn.textContent = "Resuming\u2026";
  try {
    const res = await cfetch(`${API}/resume`, { method: "POST" });
    if (!res.ok) {
      showError(`resume failed: ${res.status} ${await res.text()}`);
      return;
    }
    await poll();
  } catch (err) {
    showError(`resume failed: ${err.message}`);
  } finally { btn.disabled = false; }
}

async function onAutopauseToggle() {
  const cb = $("in-autopause");
  if (!cb) return;
  if (!cb.checked) {
    const ok = await ctx.confirm({
      title: "Disable auto-pause",
      message: "Without auto-pause the cluster keeps iterating once every agent has gone idle. A forgotten cluster will run indefinitely and keep billing.",
      confirmLabel: "Disable",
    });
    if (!ok) {
      cb.checked = true;
    }
  }
  syncSaveBtn();
}

/* ---------- Cluster switching ------------------------------------------------------------------------- */

// Retarget this section to a different cluster in-place. Called by the
// Multi Cluster board (via ctx.openSection params) and the topbar picker.
function setCluster(id) {
  if (!id || id === currentClusterId) return;
  currentClusterId = id;
  try { localStorage.setItem(LAST_CLUSTER_KEY, id); } catch { /* ignore */ }

  // Reset all per-cluster state so drift detection re-bases cleanly.
  savedDirection = "";
  savedConfig = null;
  latestServerConfig = null;
  currentClusterState = null;
  runStartTime = null;
  _directiveCache.clear();

  const ta = $("in-direction");
  if (ta) { ta.value = ""; ta.classList.remove("error"); }
  directionValue = "";
  updateDirectionPreview();
  const grid = $("grid");
  if (grid) grid.innerHTML = "";
  if (badgeEl) {
    badgeEl.textContent = "checking";
    badgeEl.className = "badge badge-starting";
  }
  updateRunTimer();
  syncSaveBtn();
  syncClusterSelect();

  loadDirection();
  loadConfig();
  loadModels();
  if (_pollTimer != null) poll(); // visible right now — refresh immediately
}

// Populate the topbar cluster picker from the registry. Known clusters
// come first; the current id is always present even if unregistered yet
// (e.g. a fresh "+ New cluster" id).
async function refreshClusterSelect() {
  if (!clusterSelectEl) return;
  try {
    const res = await fetch(`${API}/list`); // registry-wide, NOT cluster-scoped
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data && Array.isArray(data.clusters) ? data.clusters : []);

    // Separate into running (running/starting/paused) and stopped.
    const running = list.filter(c => c.state && c.state !== "stopped");
    const stopped = list.filter(c => !c.state || c.state === "stopped");

    // Ensure current cluster is present somewhere.
    const allIds = list.map(c => c.id);
    if (!allIds.includes(currentClusterId)) {
      stopped.unshift({ id: currentClusterId, state: "stopped" });
    }

    const optHtml = (c) => `<option value="${esc(c.id)}"${c.id === currentClusterId ? " selected" : ""}>${esc(c.id)}</option>`;

    let html = "";
    if (running.length) {
      html += `<optgroup label="running">` + running.map(optHtml).join("") + `</optgroup>`;
    }
    if (stopped.length) {
      html += `<optgroup label="stopped">` + stopped.map(optHtml).join("") + `</optgroup>`;
    }
    if (!html) html = `<option value="${esc(currentClusterId)}" selected>${esc(currentClusterId)}</option>`;

    clusterSelectEl.innerHTML = html;
  } catch { /* picker keeps its current options */ }
}

function syncClusterSelect() {
  if (!clusterSelectEl) return;
  if (![...clusterSelectEl.options].some(o => o.value === currentClusterId)) {
    const opt = document.createElement("option");
    opt.value = currentClusterId;
    opt.textContent = currentClusterId;
    clusterSelectEl.insertBefore(opt, clusterSelectEl.firstChild);
  }
  clusterSelectEl.value = currentClusterId;
}

/* ---------- Topbar context ------------------------------------------------------------------------------ */

function buildContextControls() {
  contextEl = document.createElement("div");
  contextEl.style.cssText = "display:flex;align-items:center;gap:10px";
  contextEl.innerHTML = `
    <select class="sc-cluster-select" data-sc-cluster title="Switch cluster"></select>
    <span class="badge badge-starting" data-sc-badge>checking</span>
    <span class="clock" data-sc-timer style="display:none">00:00:00</span>
    <span class="clock cost-label" data-sc-cost style="display:none"></span>
  `;
  clusterSelectEl = contextEl.querySelector("[data-sc-cluster]");
  badgeEl = contextEl.querySelector("[data-sc-badge]");
  runTimerEl = contextEl.querySelector("[data-sc-timer]");
  clusterCostEl = contextEl.querySelector("[data-sc-cost]");
  clusterSelectEl.addEventListener("change", () => setCluster(clusterSelectEl.value));
  syncClusterSelect();
}

/* ---------- Pane template -------------------------------------------------------------------------------- */

const TEMPLATE = `
<div class="sc-root" data-algorithm="amorphous">
  <div class="controls controls-primary">
    <button class="btn btn-start" id="btn-start" disabled style="opacity:0.3">Start</button>
    <button class="btn btn-stop" id="btn-stop" disabled style="opacity:0.3">Stop</button>
    <div class="btn-cluster-divider"></div>
    <div class="send-group">
      <button class="btn btn-send" id="btn-save" disabled title="Push direction and config together \u2014 takes effect on each agent's next iteration">Send</button>
      <button class="btn btn-send" id="btn-config-refresh" title="Pull latest config from server" style="display:none;padding:6px 10px">&#8635;</button>
    </div>
    <div class="field" title="Number of agents in the flock"><label>agents</label><div class="field-row"><div class="stepper-compact"><input id="in-concurrency" type="number" value="8" min="1"><div class="stepper-arrows"><button data-step="in-concurrency" data-delta="1">&#9652;</button><button data-step="in-concurrency" data-delta="-1">&#9662;</button></div></div><span class="instance-spec" id="agents-usage"></span></div></div>
    <div class="field" id="field-algorithm" title="Coordination algorithm \u2014 takes effect on next iteration">
      <label>algorithm</label>
      <select class="algo-select" id="in-algorithm">
        <option value="amorphous">amorphous</option>
        <option value="mesh">mesh</option>
        <option value="swarm">swarm</option>
        <option value="single">single</option>
      </select>
    </div>
    <div class="field direction-field">
      <label>direction</label>
      <div class="direction-inline-row">
        <div class="direction-collapsed" id="direction-collapsed" title="Click to edit direction">
          <span class="direction-preview" id="direction-preview">no direction set</span>
        </div>
      </div>
    </div>
  </div>

  <div class="controls controls-advanced" id="advanced-panel">
    <div class="field" id="field-neighbours" title="Ring radius each side \u2014 takes effect on next iteration"><label>neighbours</label><div class="stepper-compact"><input id="in-neighbours" type="number" value="1" min="0" max="8"><div class="stepper-arrows"><button data-step="in-neighbours" data-delta="1">&#9652;</button><button data-step="in-neighbours" data-delta="-1">&#9662;</button></div></div></div>
    <div class="field" id="field-swarmk" style="display:none" title="Number of most-active peers each agent reads \u2014 takes effect on next iteration"><label>swarm K</label><div class="stepper-compact"><input id="in-swarmk" type="number" value="4" min="1" max="7"><div class="stepper-arrows"><button data-step="in-swarmk" data-delta="1">&#9652;</button><button data-step="in-swarmk" data-delta="-1">&#9662;</button></div></div></div>
    <div class="field" title="Seconds between agent iterations \u2014 applies on next iteration">
      <label>interval</label>
      <div class="stepper-compact"><input id="in-interval" type="number" value="30" min="0" max="600"><div class="stepper-arrows"><button data-step="in-interval" data-delta="5">&#9652;</button><button data-step="in-interval" data-delta="-5">&#9662;</button></div></div>
    </div>
    <div class="field" title="Agent compute backend \u2014 applies on next start">
      <label>compute</label>
      <select id="in-compute" class="sc-select" style="min-width:120px">
        <option value="ec2">ec2</option>
        <option value="ecs" selected>ecs (fargate)</option>
      </select>
    </div>
    <div class="field" id="field-tasksize" style="display:none" title="Fargate CPU/memory per agent \u2014 applies on next start">
      <label>task size</label>
      <select id="in-tasksize" class="sc-select" style="min-width:220px;max-width:320px">
        <option value="small">small \u2014 2 vCPU / 4 GiB</option>
        <option value="medium" selected>medium \u2014 4 vCPU / 8 GiB</option>
        <option value="large">large \u2014 8 vCPU / 16 GiB</option>
        <option value="xlarge">xlarge \u2014 16 vCPU / 32 GiB</option>
      </select>
    </div>
    <div class="field" id="field-instance" title="EC2 instance type per agent \u2014 applies on next start">
      <label>instance <a href="https://console.aws.amazon.com/servicequotas/home/services/ec2/quotas/L-1216C47A" target="_blank" class="sc-info-link" title="To run more agents, increase your EC2 vCPU quota. Config cap: see agents counter.">quota &#8599;</a></label>
      <select id="in-instance" class="sc-select" style="min-width:220px;max-width:320px"><option value="t4g.medium">loading\u2026</option></select>
      <span id="concurrency-cap-label" style="display:none">600</span>
    </div>
    <div class="field" title="Baseline model for the cluster \u2014 takes effect on each agent's next iteration, no restart needed. Individual agents can override it.">
      <label>model <span id="model-override-hint" class="sc-field-hint" style="display:none"></span></label>
      <select id="in-model" class="sc-select" style="min-width:220px;max-width:320px"><option value="">default</option></select>
    </div>
    <div class="field" id="field-toggles" title="Applies on next start">
      <label>options</label>
      <div style="display:flex;gap:16px">
        <div style="display:flex;flex-direction:column;gap:2px">
          <label class="sc-check" title="Agents get a Puppeteer MCP for headless browser automation">
            <input type="checkbox" id="in-browser-automation">
            <span>browser auto</span>
          </label>
          <label class="sc-check" title="Allow this cluster to deploy (decided here, at config time) \u2014 without it deploy_request returns deploy_disabled">
            <input type="checkbox" id="in-trust-deploy">
            <span>trust deploy</span>
          </label>
        </div>
        <div style="display:flex;flex-direction:column;gap:2px">
          <label class="sc-check" title="Pauses cluster after 3 consecutive idle iterations from all agents">
            <input type="checkbox" id="in-autopause" checked>
            <span>idle &rarr; pause</span>
          </label>
          <label class="sc-check" title="Agents append self-reflection learnings to their own directive each iteration">
            <input type="checkbox" id="in-self-optimizing">
            <span>iter &rarr; reflect</span>
          </label>
        </div>
      </div>
    </div>
  </div>

  <button class="adv-toggle" id="btn-advanced" type="button" title="Show advanced settings">&#8963;</button>

  <div id="capacity-warn" class="sc-banner"></div>

  <div id="launch-error" class="sc-banner sc-banner--launch"></div>

  <div class="sc-main">
    <div class="grid-wrap">
      <div id="grid" class="grid"></div>
    </div>
  </div>
</div>
`;

function wireControls() {
  // Stepper +/- buttons.
  rootEl.querySelectorAll("[data-step]").forEach(btn => {
    btn.addEventListener("click", () => {
      stepVal(btn.dataset.step, parseInt(btn.dataset.delta, 10));
    });
  });

  // Inputs that affect capacity + save state.
  ["in-concurrency", "in-interval"].forEach(id => {
    $(id).addEventListener("input", () => { checkCapacity(); syncSaveBtn(); });
  });
  ["in-neighbours", "in-swarmk"].forEach(id => {
    $(id).addEventListener("input", syncSaveBtn);
  });

  $("in-algorithm").addEventListener("change", (e) => selectAlgorithm(e.target.value));
  $("in-compute").addEventListener("change", () => { syncComputeUI(); checkCapacity(); syncSaveBtn(); });
  $("in-instance").addEventListener("change", () => { checkCapacity(); syncSaveBtn(); });
  $("in-tasksize").addEventListener("change", syncSaveBtn);
  $("in-model").addEventListener("change", syncSaveBtn);

  $("in-autopause").addEventListener("change", onAutopauseToggle);
  $("in-self-optimizing").addEventListener("change", syncSaveBtn);
  $("in-browser-automation").addEventListener("change", syncSaveBtn);
  $("in-trust-deploy").addEventListener("change", syncSaveBtn);

  $("btn-start").onclick = startCluster; // render() reassigns per state
  $("btn-stop").addEventListener("click", stopCluster);
  $("btn-save").addEventListener("click", saveDirection);
  $("btn-config-refresh").addEventListener("click", refreshConfig);

  // Advanced settings collapse/expand.
  $("btn-advanced").addEventListener("click", toggleAdvanced);

  // Direction: click the preview text to open the edit/preview popup.
  $("direction-collapsed").addEventListener("click", openDirectionPopup);
}

/* ---------- Collapsible sections --------------------------------------------------------------------------- */

let advancedOpen = false;

function toggleAdvanced() {
  advancedOpen = !advancedOpen;
  const panel = $("advanced-panel");
  const btn = $("btn-advanced");
  const primary = rootEl.querySelector(".controls-primary");
  if (panel) panel.classList.toggle("open", advancedOpen);
  if (primary) primary.classList.toggle("adv-open", advancedOpen);
  if (btn) {
    btn.classList.toggle("open", advancedOpen);
    btn.innerHTML = "&#8963;"; // always use ⌃, rotated via CSS
    btn.title = advancedOpen ? "Hide advanced settings" : "Show advanced settings";
  }
}

function updateDirectionPreview() {
  const preview = $("direction-preview");
  if (!preview) return;
  const text = (directionValue || "").trim().replace(/\s+/g, " ");
  if (!text) {
    preview.textContent = "no direction set";
    preview.classList.add("empty");
  } else {
    preview.textContent = text.length > 120 ? text.slice(0, 120) + "\u2026" : text;
    preview.classList.remove("empty");
  }
}

// A hidden textarea that holds the direction value for form reads.
// It lives off-screen so syncSaveBtn and saveDirection still work.
let directionValue = "";

/** Return a virtual accessor so existing code that does $("in-direction").value still works. */
function getDirectionTextarea() {
  let ta = document.getElementById("in-direction");
  if (!ta) {
    ta = document.createElement("textarea");
    ta.id = "in-direction";
    ta.style.display = "none";
    rootEl.appendChild(ta);
  }
  return ta;
}

/* ---------- Unified direction popup (edit + preview tabs) -------------------------------------------------- */

let _dirPopupRoot = null;
let _dirPopupMode = "preview"; // "preview" or "edit"

function openDirectionPopup() {
  if (!_dirPopupRoot) _dirPopupRoot = buildDirectionPopup();
  const root = _dirPopupRoot;
  const hidden = getDirectionTextarea();
  const text = hidden.value || "";

  // Default to preview if there's content, edit if empty.
  _dirPopupMode = text.trim() ? "preview" : "edit";
  renderDirPopupContent(root, text);

  root.classList.add("visible");
  root.setAttribute("aria-hidden", "false");
  if (_dirPopupMode === "edit") {
    const ta = root.querySelector(".sc-dir-editor-ta");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
}

function closeDirPopup(save) {
  if (!_dirPopupRoot) return;
  if (save) {
    const ta = _dirPopupRoot.querySelector(".sc-dir-editor-ta");
    const hidden = getDirectionTextarea();
    if (ta) {
      hidden.value = ta.value;
      directionValue = ta.value;
      updateDirectionPreview();
      syncSaveBtn();
    }
  }
  _dirPopupRoot.classList.remove("visible");
  _dirPopupRoot.setAttribute("aria-hidden", "true");
}

function renderDirPopupContent(root, text) {
  const body = root.querySelector(".sc-dir-popup-body");
  const tabEdit = root.querySelector("[data-tab=edit]");
  const tabPreview = root.querySelector("[data-tab=preview]");
  const saveBtn = root.querySelector("#sc-dir-save");

  tabEdit.classList.toggle("active", _dirPopupMode === "edit");
  tabPreview.classList.toggle("active", _dirPopupMode === "preview");
  saveBtn.style.display = _dirPopupMode === "edit" ? "" : "none";

  if (_dirPopupMode === "edit") {
    body.innerHTML = `<textarea class="sc-dir-editor-ta">${esc(text)}</textarea>`;
  } else {
    if (typeof marked !== "undefined" && marked.parse && text.trim()) {
      body.innerHTML = `<div class="env-viewer-md">${marked.parse(text)}</div>`;
    } else if (text.trim()) {
      body.innerHTML = `<pre style="white-space:pre-wrap">${esc(text)}</pre>`;
    } else {
      body.innerHTML = `<p style="color:var(--text-muted);font-style:italic">No direction set.</p>`;
    }
  }
}

function buildDirectionPopup() {
  const root = document.createElement("div");
  root.className = "sc-dir-popup";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="sc-dir-popup-backdrop" data-sc-dir-dismiss></div>
    <div class="sc-dir-popup-panel" role="dialog" aria-modal="true">
      <header class="sc-dir-popup-header">
        <button type="button" class="sc-dir-popup-close" data-sc-dir-dismiss aria-label="Cancel" title="Cancel">&times;</button>
        <div class="sc-dir-popup-tabs">
          <button type="button" class="sc-dir-popup-tab" data-tab="preview">preview</button>
          <button type="button" class="sc-dir-popup-tab" data-tab="edit">edit</button>
        </div>
        <button type="button" class="sc-dir-popup-save" id="sc-dir-save" aria-label="Save" title="Save">&#10003;</button>
      </header>
      <div class="sc-dir-popup-body"></div>
    </div>
  `;
  document.body.appendChild(root);

  // Tab switching.
  root.querySelector("[data-tab=edit]").addEventListener("click", () => {
    _dirPopupMode = "edit";
    const hidden = getDirectionTextarea();
    const ta = root.querySelector(".sc-dir-editor-ta");
    const text = ta ? ta.value : hidden.value;
    renderDirPopupContent(root, text);
    const newTa = root.querySelector(".sc-dir-editor-ta");
    if (newTa) { newTa.focus(); newTa.setSelectionRange(newTa.value.length, newTa.value.length); }
  });
  root.querySelector("[data-tab=preview]").addEventListener("click", () => {
    _dirPopupMode = "preview";
    const ta = root.querySelector(".sc-dir-editor-ta");
    const text = ta ? ta.value : getDirectionTextarea().value;
    renderDirPopupContent(root, text);
  });

  // Save / dismiss.
  root.addEventListener("click", (e) => {
    if (e.target.matches("[data-sc-dir-dismiss]")) closeDirPopup(false);
    if (e.target.matches("#sc-dir-save")) closeDirPopup(true);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && _dirPopupRoot && _dirPopupRoot.classList.contains("visible")) {
      closeDirPopup(false);
    }
  });

  return root;
}

/* ---------- Section module interface ------------------------------------------------------------------------ */

export default {
  id: "single-cluster",
  title: "Single Cluster",

  async mount(container, shellCtx) {
    ctx = shellCtx;
    container.innerHTML = TEMPLATE;
    rootEl = container.querySelector(".sc-root");

    buildContextControls();
    wireControls();
    wireGridEvents();
    getDirectionTextarea(); // create the hidden textarea before load

    // Initial data loads. Direction/config/models are cluster-scoped and
    // re-run on setCluster; instance types are deployment-wide.
    loadDirection();
    loadConfig();
    loadInstanceTypes();
    loadModels();
    refreshClusterSelect();
  },

  show(params) {
    if (params && params.cluster) setCluster(params.cluster);
    // Persist whatever we ended up on, including the initially resolved
    // cluster (setCluster early-returns when the id is unchanged, so it
    // alone would never record the first cluster shown).
    try { localStorage.setItem(LAST_CLUSTER_KEY, currentClusterId); } catch { /* ignore */ }
    ctx.topbar.setContext(contextEl);
    refreshClusterSelect();
    startPolling();
  },

  hide() {
    stopPolling();
  },
};
