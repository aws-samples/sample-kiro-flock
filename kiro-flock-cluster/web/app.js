/* kiro-flock dashboard */

// ---------- Cluster scoping --------------------------------------------------
// The dashboard used to be single-cluster. WeltenBuilder now lands the
// operator here with ?cluster=<id>. Parse it once and thread it through
// every cluster-scoped API call so this code stays callable from both the
// default ${API_URL} URL (cluster_0) and from ${API_URL}?cluster=<other>.
let currentClusterId = "cluster_0";
(function parseClusterParam() {
  const params = new URLSearchParams(location.search);
  const fromUrl = params.get("cluster");
  // Same regex the backend's validateClusterId uses. Underscore is
  // allowed because the default cluster id convention is cluster_0,
  // cluster_1234, etc. A malformed param is ignored (silently falls
  // back to cluster_0) rather than breaking the whole page.
  if (fromUrl && /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/.test(fromUrl)) {
    currentClusterId = fromUrl;
  }
})();

// Actions that are NOT per-cluster. These live at bucket/account scope and
// must not get a /{clusterId} suffix. Anything else that starts with
// "cluster/" is rewritten by the fetch interceptor below.
const GLOBAL_CLUSTER_ACTIONS = new Set([
  "instance-types",
  "knowledge-base",
  "knowledge-base/file",
]);

// Rewrite a "cluster/..." URL to include the current cluster id suffix.
// Preserves any query string, leaves global actions alone, and is a no-op
// if a cluster id is already present in the path (idempotent for anyone
// who already wrote cluster/foo/my-id).
function rewriteClusterUrl(url) {
  const queryIdx = url.indexOf("?");
  const pathPart = queryIdx >= 0 ? url.slice(0, queryIdx) : url;
  const queryPart = queryIdx >= 0 ? url.slice(queryIdx) : "";
  if (pathPart === "cluster" || pathPart === "cluster/") return url;
  const segments = pathPart.slice("cluster/".length).split("/").filter(Boolean);

  // Multi-segment actions. parseRoute on the backend treats these as one
  // action; keep the segments paired here too.
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
  // Caller already supplied a cluster id suffix. Leave it alone.
  if (trailing.length > 0) return url;

  return `cluster/${action}/${currentClusterId}${queryPart}`;
}

// ---------- Auth layer -------------------------------------------------------
let authConfig = null;
let idToken = null;

async function initAuth() {
  // Load auth config written by install.sh
  try {
    const base = location.origin + location.pathname.replace(/\/?$/, "/");
    const res = await fetch(base + "auth-config.json");
    if (res.ok) authConfig = await res.json();
  } catch { /* auth-config.json missing — auth disabled */ }

  if (!authConfig) return; // No Cognito configured, run without auth

  // Show logout button when auth is configured
  document.getElementById("btn-logout").style.display = "block";

  // Check for id_token in URL hash (Cognito implicit flow callback)
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  if (params.has("id_token")) {
    idToken = params.get("id_token");
    sessionStorage.setItem("flock_id_token", idToken);
    // Clean the URL
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Check sessionStorage for existing token
  idToken = sessionStorage.getItem("flock_id_token");
  if (idToken) {
    // Validate token hasn't expired
    try {
      const payload = JSON.parse(atob(idToken.split(".")[1]));
      if (payload.exp * 1000 > Date.now()) return; // Still valid
    } catch { /* invalid token, re-auth */ }
    sessionStorage.removeItem("flock_id_token");
    idToken = null;
  }

  // No valid token — redirect to Cognito hosted UI
  const redirectUri = authConfig.apiUrl;
  const loginUrl = `https://${authConfig.cognitoDomain}/login?client_id=${authConfig.clientId}&response_type=token&scope=openid&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.location.href = loginUrl;
}

// Wrap fetch to attach Authorization header and rewrite cluster URLs so
// every cluster-scoped call lands on the current cluster's API path.
const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
  if (typeof url === "string" && url.startsWith("cluster")) {
    url = rewriteClusterUrl(url);
    if (idToken) {
      opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${idToken}` };
    }
  }
  return _origFetch.call(this, url, opts);
};

function logout() {
  sessionStorage.removeItem("flock_id_token");
  if (authConfig) {
    const logoutUrl = `https://${authConfig.cognitoDomain}/logout?client_id=${authConfig.clientId}&logout_uri=${encodeURIComponent(authConfig.apiUrl)}`;
    window.location.href = logoutUrl;
  } else {
    window.location.reload();
  }
}

// Run auth before anything else
initAuth().then(() => {
  // Auth complete, start the dashboard
  initDashboard();
});

function initDashboard() {

const API = "cluster";
const POLL_MS = 3000;
const grid = document.getElementById("grid");
const badge = document.getElementById("cluster-badge");
const toast = document.getElementById("toast");

// Render the cluster id into the logo so operators always know which
// cluster this dashboard view is scoped to, even on the default
// ${API_URL} entry point.
(function wireLogo() {
  const logoEl = document.getElementById("logo");
  if (!logoEl) return;
  const safeId = currentClusterId.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  }[c]));
  logoEl.innerHTML = `kiro<span>-flock:</span> <span class="logo-cluster">${safeId}</span>`;
})();

// Wire the WeltenBuilder link in the topbar. Computes the /welten URL
// the same way the app.js loader derives its base — agnostic to whether
// the API Gateway stage has a trailing slash.
(function wireWeltenLink() {
  const btn = document.getElementById("btn-welten");
  if (!btn) return;
  const base = location.origin + location.pathname.replace(/\/?$/, "/");
  btn.href = base + "welten";
  btn.style.display = "";
})();

// Run timer
let runStartTime = null;
const runTimerEl = document.getElementById("run-timer");

function updateRunTimer() {
  if (!runStartTime) { runTimerEl.style.display = "none"; return; }
  runTimerEl.style.display = "";
  const elapsed = Math.floor((Date.now() - runStartTime) / 1000);
  const h = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const s = String(elapsed % 60).padStart(2, "0");
  runTimerEl.textContent = `${h}:${m}:${s}`;
}
setInterval(updateRunTimer, 1000);

// Load saved direction on page load
let savedDirection = "";
// Snapshot of what the server currently has for config. Form values are
// compared against this to detect local edits vs drift. Populated by
// loadConfig() on initial load and refreshConfig() on explicit refresh.
let savedConfig = null;

async function loadDirection() {
  try {
    const res = await fetch(`${API}/direction`);
    if (res.ok) {
      const { direction } = await res.json();
      savedDirection = direction || "";
      const ta = document.getElementById("in-direction");
      ta.value = savedDirection;
      syncSaveBtn();
    }
  } catch { /* non-fatal */ }
}

function syncSaveBtn() {
  const ta = document.getElementById("in-direction");
  const btn = document.getElementById("btn-save");
  const hint = document.getElementById("config-stale-hint");
  const refreshBtn = document.getElementById("btn-config-refresh");

  const directionChanged = ta.value.trim() !== savedDirection.trim();
  const configChanged = hasConfigDrift();
  const changed = directionChanged || configChanged;
  // While the cluster is booting, the launch loop has already baked
  // concurrency and instanceType into userData — writing new values to
  // config.json now would only confuse the operator (form says 16, cluster
  // is still launching 8). Block Send entirely until the cluster settles.
  const blockedByStarting = currentClusterState === "starting";
  const enable = changed && !blockedByStarting;

  btn.disabled = !enable;
  btn.style.opacity = enable ? "1" : "0.4";
  btn.style.cursor = enable ? "pointer" : "default";
  btn.title = blockedByStarting ? "cluster is starting, wait for it to finish" : "";

  // Stale hint: shown under the Send button in the same muted style as
  // other .field-hint text. Several states, driven off savedConfig and
  // the latest server snapshot:
  //   - null                           → haven't loaded yet; "loading"
  //   - drifted + local edits          → "server changed · refresh overwrites local edits"
  //   - drifted, clean                 → "server changed · refresh to pull"
  //   - clean, restart-required dirty  → "restart-required fields apply on next Start"
  //                                      (only when cluster isn't stopped)
  //   - clean + synced                 → hidden
  if (hint && refreshBtn) {
    const serverDrifted = serverDiffersFromSaved();
    const restartRequiredDirty = configChanged && hasRestartRequiredDrift();
    if (savedConfig === null) {
      hint.textContent = "loading config\u2026";
      hint.style.display = "";
      refreshBtn.style.display = "none";
    } else if (blockedByStarting && (configChanged || directionChanged)) {
      hint.textContent = "cluster is starting \u00b7 wait to send";
      hint.style.display = "";
      refreshBtn.style.display = "none";
    } else if (serverDrifted && configChanged) {
      hint.textContent = "server changed \u00b7 refresh overwrites local edits";
      hint.style.display = "";
      refreshBtn.style.display = "";
    } else if (serverDrifted) {
      hint.textContent = "server changed \u00b7 refresh to pull";
      hint.style.display = "";
      refreshBtn.style.display = "";
    } else if (restartRequiredDirty && currentClusterState && currentClusterState !== "stopped") {
      hint.textContent = "restart-required fields apply on next Start";
      hint.style.display = "";
      refreshBtn.style.display = "none";
    } else {
      hint.style.display = "none";
      refreshBtn.style.display = "none";
    }
  }
}

// Back-compat alias for the legacy name; HTML still references it via
// oninput on the direction textarea.
const syncDirectionBtn = syncSaveBtn;

// Does the form differ from savedConfig? Compared per-field so we can
// ignore fields that are hidden for the current algorithm (mesh hides
// both neighbourRadius and swarmK; swarm hides neighbourRadius).
function hasConfigDrift() {
  if (!savedConfig) return false;
  const form = readConfigForm();
  if (form.algorithm !== savedConfig.algorithm) return true;
  if (form.concurrency !== savedConfig.concurrency) return true;
  if (form.loopIntervalSeconds !== savedConfig.loopIntervalSeconds) return true;
  if (form.instanceType !== savedConfig.instanceType) return true;
  if (form.internetAccess !== savedConfig.internetAccess) return true;
  if (form.autopause !== savedConfig.autopause) return true;
  if (form.algorithm === "amorphous" && form.neighbourRadius !== savedConfig.neighbourRadius) return true;
  if (form.algorithm === "swarm" && form.swarmK !== savedConfig.swarmK) return true;
  return false;
}

// Fields that require a full restart to take effect. Agents re-read config
// each iteration for the dynamic fields (algorithm, swarmK, neighbourRadius,
// loopIntervalSeconds), but concurrency and instanceType are baked in at
// launch time. Editing them on a running cluster is allowed — the value is
// persisted for next Start — but the user should know nothing happens right
// now. That's what the "restart-required fields apply on next Start" hint
// is for.
function hasRestartRequiredDrift() {
  if (!savedConfig) return false;
  const form = readConfigForm();
  return form.concurrency !== savedConfig.concurrency
    || form.instanceType !== savedConfig.instanceType;
}

// Does the latest server snapshot differ from savedConfig? Used by the
// stale hint. Fed by render() on every poll. Algorithm-aware: when the
// active algorithm doesn't use a given field (neighbourRadius for
// non-amorphous, swarmK for non-swarm), drift on that field is ignored
// because the value isn't exercised anyway.
let latestServerConfig = null;
function serverDiffersFromSaved() {
  if (!savedConfig || !latestServerConfig) return false;
  const baseKeys = ["algorithm", "concurrency", "loopIntervalSeconds", "instanceType", "autopause"];
  if (baseKeys.some(k => latestServerConfig[k] !== savedConfig[k])) return true;
  const algo = latestServerConfig.algorithm;
  if (algo === "amorphous" && latestServerConfig.neighbourRadius !== savedConfig.neighbourRadius) return true;
  if (algo === "swarm" && latestServerConfig.swarmK !== savedConfig.swarmK) return true;
  return false;
}

// Read the current form values into a config object. Only fields the
// user can edit; does not include fields like `model` that the dashboard
// doesn't surface. Always returns all keys so comparisons are simple.
function readConfigForm() {
  return {
    algorithm: currentAlgorithm,
    concurrency: parseInt(document.getElementById("in-concurrency").value) || 1,
    loopIntervalSeconds: parseInt(document.getElementById("in-interval").value) || 30,
    instanceType: document.getElementById("in-instance").value || "t4g.medium",
    neighbourRadius: parseInt(document.getElementById("in-neighbours").value) || 0,
    swarmK: parseInt(document.getElementById("in-swarmk").value) || 4,
    internetAccess: document.getElementById("in-internet").checked,
    autopause: document.getElementById("in-autopause").checked,
  };
}

loadDirection();

// Load current config values. Called once on initial load; after that the
// form is owned by the user — poll responses no longer overwrite the form
// (the old flip-flopping behaviour). The user can pull fresh server
// values on demand via refreshConfig().
async function loadConfig() {
  try {
    const res = await fetch(`${API}/config`);
    if (!res.ok) return;
    const cfg = await res.json();
    applyServerConfig(cfg);
  } catch { /* non-fatal */ }
}

// Apply a server config payload to the form. Used by both initial load
// and the explicit refresh button. Updates savedConfig so drift detection
// is re-based to the latest server state.
function applyServerConfig(cfg) {
  if (cfg.loopIntervalSeconds != null) document.getElementById("in-interval").value = cfg.loopIntervalSeconds;
  if (cfg.concurrency != null) document.getElementById("in-concurrency").value = cfg.concurrency;
  if (cfg.neighbourRadius != null) document.getElementById("in-neighbours").value = cfg.neighbourRadius;
  if (cfg.swarmK != null) document.getElementById("in-swarmk").value = cfg.swarmK;
  if (cfg.instanceType) {
    const sel = document.getElementById("in-instance");
    // Only set if the option exists; otherwise loadInstanceTypes() will
    // catch up and pick the right default.
    if ([...sel.options].some(o => o.value === cfg.instanceType)) {
      sel.value = cfg.instanceType;
    }
  }
  if (cfg.algorithm) applyAlgorithmUI(cfg.algorithm);
  document.getElementById("in-internet").checked = !!cfg.internetAccess;
  // autopause defaults on for older configs that predate the field.
  document.getElementById("in-autopause").checked = cfg.autopause !== false;
  savedConfig = {
    algorithm: cfg.algorithm ?? "amorphous",
    concurrency: cfg.concurrency ?? 8,
    loopIntervalSeconds: cfg.loopIntervalSeconds ?? 30,
    instanceType: cfg.instanceType ?? "t4g.medium",
    neighbourRadius: cfg.neighbourRadius ?? 1,
    swarmK: cfg.swarmK ?? 4,
    internetAccess: !!cfg.internetAccess,
    autopause: cfg.autopause !== false,
  };
  checkCapacity();
  syncSaveBtn();
}

// User-triggered: pull server config into the form, replacing any local
// edits. Called from the refresh button next to the save button.
async function refreshConfig() {
  try {
    const res = await fetch(`${API}/config`);
    if (!res.ok) { showError(`refresh failed: ${res.status}`); return; }
    const cfg = await res.json();
    applyServerConfig(cfg);
  } catch (err) { showError(`refresh failed: ${err.message}`); }
}

loadConfig();

// ---------- Algorithm selector ---------------------------------------------
// Drives two things: field visibility (neighbourRadius vs swarmK vs neither)
// and the body data-algorithm attribute that retints the whole dashboard.
// Selection is local state only — the server is not notified until the user
// hits Save or Start. This avoids the flip-flop the old PUT-on-click flow
// had when a status poll fired before the server had caught up.
let currentAlgorithm = "amorphous";

function applyAlgorithmUI(algo) {
  currentAlgorithm = algo;
  document.body.dataset.algorithm = algo;

  // Segmented control active state
  document.querySelectorAll('.seg button[data-algo]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.algo === algo);
  });

  // Field visibility per algorithm. Mesh hides both configurable fields
  // (it just reads every other agent). Swarm shows swarmK and hides radius.
  // Amorphous keeps radius, hides swarmK.
  const fNeighbours = document.getElementById('field-neighbours');
  const fSwarmK = document.getElementById('field-swarmk');
  if (algo === 'mesh') {
    fNeighbours.style.display = 'none';
    fSwarmK.style.display = 'none';
  } else if (algo === 'swarm') {
    fNeighbours.style.display = 'none';
    fSwarmK.style.display = '';
  } else {
    fNeighbours.style.display = '';
    fSwarmK.style.display = 'none';
  }

  // swarmK max = concurrency - 1. Clamp if the user lowered concurrency.
  const conc = parseInt(document.getElementById('in-concurrency').value) || 1;
  const kInput = document.getElementById('in-swarmk');
  const maxK = Math.max(1, conc - 1);
  kInput.max = maxK;
  if (parseInt(kInput.value) > maxK) kInput.value = maxK;
}

// Pure UI update — no server call. The change is pushed to the server
// via Save or Start, not on click. This is the fix for the old race where
// a fast second click could be overwritten by a poll mid-PUT.
function selectAlgorithm(algo) {
  if (algo === currentAlgorithm) return;
  applyAlgorithmUI(algo);
  syncSaveBtn();
}

// Load instance types — curated list, smallest to largest
let instanceSpecs = {};
let vcpuQuota = 0;
let concurrencyCap = 600;

async function loadInstanceTypes() {
  const sel = document.getElementById("in-instance");
  try {
    const res = await fetch(`${API}/instance-types`);
    if (!res.ok) return;
    const data = await res.json();
    const { instanceTypes } = data;
    vcpuQuota = data.vcpuQuota || 0;
    concurrencyCap = data.concurrencyCap || 600;

    // Apply cap to the concurrency input
    const concInput = document.getElementById("in-concurrency");
    concInput.max = concurrencyCap;
    if ((parseInt(concInput.value) || 0) > concurrencyCap) {
      concInput.value = concurrencyCap;
    }

    // Update the cap label in the hint
    const capLabel = document.getElementById("concurrency-cap-label");
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
    // If savedConfig loaded before the type list (the common case — loadConfig
    // runs first), the server's instanceType couldn't be applied yet because
    // the options didn't exist. Re-apply now so the dropdown matches the
    // stored value and the stale hint isn't raised spuriously.
    if (savedConfig && savedConfig.instanceType) {
      if ([...sel.options].some(o => o.value === savedConfig.instanceType)) {
        sel.value = savedConfig.instanceType;
      }
    }
    checkCapacity();
    syncSaveBtn();
  } catch { /* non-fatal */ }
}

function updateInstanceSpec() {
  checkCapacity();
}

function checkCapacity() {
  const concurrency = parseInt(document.getElementById("in-concurrency").value) || 0;
  const val = document.getElementById("in-instance").value;
  const spec = instanceSpecs[val];
  const vcpusNeeded = spec ? concurrency * spec.vcpus : 0;
  const maxInstances = spec && vcpuQuota > 0 ? Math.floor(vcpuQuota / spec.vcpus) : null;
  const btn = document.getElementById("btn-start");
  const warn = document.getElementById("capacity-warn");

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

  const agentsLabel = document.getElementById("agents-usage");
  if (agentsLabel && maxInstances !== null) {
    agentsLabel.textContent = `${concurrency} / ${maxInstances}`;
  } else if (agentsLabel) {
    agentsLabel.textContent = "";
  }

  // Pass 7: swarmK max tracks concurrency - 1. Re-clamp when concurrency
  // changes so the stepper can never exceed the valid range.
  const kInput = document.getElementById("in-swarmk");
  if (kInput) {
    const maxK = Math.max(1, concurrency - 1);
    kInput.max = maxK;
    if ((parseInt(kInput.value) || 0) > maxK) kInput.value = maxK;
  }
}

function stepVal(id, delta) {
  const el = document.getElementById(id);
  const min = parseInt(el.min) || 0;
  const max = parseInt(el.max) || 999;
  const next = Math.max(min, Math.min(max, (parseInt(el.value) || 0) + delta));
  el.value = next;
  checkCapacity();
  syncSaveBtn();
}

loadInstanceTypes();

// Track changes to direction textarea and config inputs so the Save
// button lights up as the user types. The stepper +/- buttons go
// through stepVal() which already calls syncSaveBtn; direct keyboard
// entry and instance-select change need their own listeners here.
document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("in-direction").addEventListener("input", syncSaveBtn);
  ["in-concurrency", "in-interval", "in-neighbours", "in-swarmk"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", syncSaveBtn);
  });
  const inst = document.getElementById("in-instance");
  if (inst) inst.addEventListener("change", syncSaveBtn);
  const internet = document.getElementById("in-internet");
  if (internet) internet.addEventListener("change", syncSaveBtn);
  // autopause has its own onchange that may revert the value via a
  // confirm dialog; syncSaveBtn fires inside onAutopauseToggle().
});

// ---------- Helpers ----------------------------------------------------------
const esc = s => s ? String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : "";
const pct = v => v != null ? `${Math.round(v)}%` : "—";
const fmtBytes = v => {
  if (v == null) return "—";
  if (v < 1024) return v + "B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + "K";
  return (v / (1024 * 1024)).toFixed(1) + "M";
};
const trunc = (s, n) => s && s.length > n ? s.slice(0, n) + "\u2026" : (s || "—");
const fmtTime = ts => ts ? new Date(ts).toLocaleTimeString() : "—";

function showError(msg) {
  toast.textContent = msg;
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 8000);
}

function statusPillClass(s) {
  if (s === "running") return "status-running";
  if (s === "stopped") return "status-stopped";
  if (s === "stopping") return "status-stopping";
  if (s === "paused") return "status-paused";
  return "status-starting";
}

// ---------- Habitat panel ----------------------------------------------------
// The environment tree, file viewer, and polling loop live in
// web-shared/envPanel.js so this dashboard and WeltenBuilder can share one
// implementation. We mount it into the side panel and wire the "clean"
// button through to cleanEnvironment() below.
const _envPanelContainer = document.getElementById("habitat-container");
const _envPanel = (typeof window.envPanel !== "undefined" && _envPanelContainer)
  ? window.envPanel.mount({
      container: _envPanelContainer,
      apiBase: API,
      // Auto-open the current cluster's folder on first load so the
      // operator's own files are immediately visible without a click.
      autoOpenPath: `environment/${currentClusterId}/`,
      // Scope download-all to this cluster only.
      downloadScope: `environment/${currentClusterId}/`,
      onError: (msg) => showError(msg),
      onCleanRequested: () => cleanEnvironment(),
    })
  : null;

// ---------- Resize handle ----------------------------------------------------
const resizeHandle = document.getElementById("resize-handle");
const habitatPanel = document.getElementById("habitat-container");
let resizing = false;

resizeHandle.addEventListener("mousedown", e => {
  resizing = true;
  resizeHandle.classList.add("dragging");
  e.preventDefault();
});

document.addEventListener("mousemove", e => {
  if (!resizing) return;
  const mainRect = document.querySelector(".main").getBoundingClientRect();
  const newWidth = mainRect.right - e.clientX;
  if (newWidth >= 160 && newWidth <= mainRect.width * 0.7) {
    habitatPanel.style.width = newWidth + "px";
  }
});

document.addEventListener("mouseup", () => {
  resizing = false;
  resizeHandle.classList.remove("dragging");
});

// ---------- Agent panels -----------------------------------------------------
function renderPanel(a, clusterState, algorithm) {
  const m = a.metrics || {};
  const prev = a.prevEntry;
  const cur = a.lastEntry;
  // During a cluster-wide pause, show a "paused" chip on every panel instead
  // of the agent's own running/starting status — the underlying instance is
  // still alive, the loop is just parked between iterations.
  const paused = clusterState === "paused";
  const pillStatus = paused ? "paused" : a.status;

  // Pass 7: label varies by algorithm.
  //   amorphous → "neighbours: 0, 7" (fixed ring)
  //   mesh      → "peers: all"       (every other agent)
  //   swarm     → "peers: 2, 5, 7, 9" (dynamic list from snapshot)
  let peerLabel;
  if (algorithm === "mesh") {
    peerLabel = "peers: all";
  } else if (algorithm === "swarm") {
    peerLabel = `peers: ${a.neighbours && a.neighbours.length ? esc(a.neighbours.join(", ")) : "none yet"}`;
  } else {
    peerLabel = `neighbours: ${a.neighbours && a.neighbours.length ? esc(a.neighbours.join(", ")) : "none"}`;
  }

  let html = `<div class="panel-head">
    <span class="agent-name">${esc(a.agentId)}</span>
    <span class="status-pill ${statusPillClass(pillStatus)}">${esc(pillStatus)}</span>
  </div>
  <div class="panel-meta">
    <span class="mono">${trunc(a.instanceId, 19)} · ${esc(a.instanceState || "—")}</span>
    <span>updated ${fmtTime(a.lastUpdatedTs)}${a.elapsedSeconds != null ? ` (${a.elapsedSeconds}s ago)` : ""}</span>
    <span>${peerLabel}</span>
  </div>
  <div class="metrics-bar">
    <div class="metric"><span class="metric-val">${pct(m.cpu)}</span><span class="metric-label">cpu</span></div>
    <div class="metric"><span class="metric-val">\u2191${fmtBytes(m.netOut)} \u2193${fmtBytes(m.netIn)}</span><span class="metric-label">net</span></div>
    <div class="metric"><span class="metric-val">${m.status != null ? (m.status === 0 ? '[ok]' : '[x]') : '—'}</span><span class="metric-label">health</span></div>
  </div>`;

  if (prev) {
    html += `<div class="iter-section">
      <div class="iter-tag">prev · iter ${prev.iteration}</div>
      <div class="iter-row"><span class="k">did</span><span class="v-action">${esc(prev.action)}</span></div>
    </div>`;
  }
  if (cur) {
    html += `<div class="iter-section">
      <div class="iter-tag">current · iter ${cur.iteration}</div>
      <div class="iter-row"><span class="k">did</span><span class="v-action">${esc(cur.action)}</span></div>
      <div class="iter-row"><span class="k">res</span><span class="v-result">${esc(cur.result)}</span></div>
      <div class="iter-row"><span class="k">next</span><span class="v-next">${esc(cur.next_intent)}</span></div>
    </div>`;
  } else {
    html += `<div class="waiting">waiting for first iteration\u2026</div>`;
  }
  return html;
}

// Last observed cluster state. Read by syncSaveBtn to decide whether
// the "restart-required fields apply on next Start" hint is relevant.
//
// Note: prior versions of this dashboard kept `pendingStart` and
// `pendingPauseState` overrides because the state field was derived
// asynchronously by the snapshot builder, so the dashboard would briefly
// flicker back to the old state on the next poll after a click. State is
// now driven by `{clusterId}/store/state.json`, written synchronously by
// the Lambda on every operator action, so the click is reflected on the
// very next poll without grace windows.
let currentClusterState = null;

function render(data) {
  const cs = data.clusterState || "stopped";

  badge.textContent = cs;
  badge.className = `badge badge-${cs}`;

  // Track effective cluster state for consumers like syncSaveBtn that
  // need to know whether we're running/paused vs stopped.
  currentClusterState = cs;

  // Track the latest server config for the stale-hint comparison. The
  // form itself is NOT updated from polls — that was the old flip-flop
  // behaviour. Drift is shown under the Save button; the user pulls with
  // the refresh glyph when they want to sync.
  if (data.config) {
    latestServerConfig = {
      algorithm: data.config.algorithm ?? "amorphous",
      concurrency: data.config.concurrency ?? 8,
      loopIntervalSeconds: data.config.loopIntervalSeconds ?? 30,
      instanceType: data.config.instanceType ?? "t4g.medium",
      neighbourRadius: data.config.neighbourRadius ?? 1,
      swarmK: data.config.swarmK ?? 4,
      autopause: data.config.autopause !== false,
    };
    syncSaveBtn();
  }

  // Run timer: use server-provided cluster start time
  if (data.clusterStartTime && (cs === "running" || cs === "starting" || cs === "stopping" || cs === "paused")) {
    runStartTime = new Date(data.clusterStartTime).getTime();
    updateRunTimer();
  } else if (cs === "stopped") {
    runStartTime = null;
    updateRunTimer();
  }

  // Primary button cycles Start → Pause → Resume based on cluster state.
  // Stop is a separate button, always available once the cluster isn't stopped.
  //   stopped                       → Start (enabled if direction is set)
  //   starting                      → Start, disabled (launch in flight)
  //   running + ≥1 log entry        → Pause (can actually stop iterations)
  //   running, no log entries yet   → Pause, disabled (waiting for first iteration)
  //   paused                        → Resume
  //   stopping                      → Pause, disabled (cluster is going away)
  const btnStart = document.getElementById("btn-start");
  const btnStop = document.getElementById("btn-stop");
  const agents = data.agents || [];
  const anyLogEntry = agents.some(a => a.lastEntry);

  // Clear per-mode styling each render so we don't leak accent colours.
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
    // Running but no agent has written yet — pausing now would just stop
    // them at the same no-work state. Show "Pause" disabled so the label
    // is honest about what the button will do when it enables.
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
    // Mirror the running case: show "Pause" disabled rather than "Start"
    // disabled. The cluster is running-ish; there's just nothing useful
    // to do while it tears down.
    btnStart.textContent = "Pause";
    btnStart.onclick = pauseCluster;
    btnStart.disabled = true;
    btnStart.style.opacity = "0.3";
    btnStart.classList.add("btn-pause");
  }

  // Stop: enabled whenever there's something to stop AND we're not
  // already mid-stop (label becomes "Stopping…" for feedback). Re-clicking
  // Stop during stopping would be a wasted Lambda invoke.
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
  if (grid.children.length !== agents.length) {
    grid.innerHTML = agents.map(() => '<div class="panel"></div>').join("");
  }
  agents.forEach((a, i) => {
    const panel = grid.children[i];
    // Label uses the server's algorithm, not the form's. The form can be
    // in an unsaved edited state; what the agents are actually doing is
    // what the snapshot reports. data.config.algorithm falls back to
    // "amorphous" when the snapshot predates Pass 7.
    const runningAlgorithm = data.config?.algorithm || "amorphous";
    panel.innerHTML = renderPanel(a, cs, runningAlgorithm);
    panel.classList.toggle("paused", cs === "paused");
  });
}

// Suppress fetch errors caused by page unload (browser refresh / navigation).
let unloading = false;
window.addEventListener("beforeunload", () => { unloading = true; });

// ---------- Polling ----------------------------------------------------------
async function poll() {
  try {
    const res = await fetch(`${API}/status`);
    if (!res.ok) { showError(`status ${res.status}: ${await res.text()}`); return; }
    render(await res.json());
  } catch (err) {
    if (!unloading) showError(`poll failed: ${err.message}`);
  }
}

// ---------- Save / Refresh --------------------------------------------------
// Save pushes any local direction and/or config changes to the server in one
// click. Both are conditional — unchanged fields are skipped — so clicking
// Save when nothing is dirty is a no-op.
async function saveDirection() {
  const ta = document.getElementById("in-direction");
  const direction = ta.value.trim();
  const directionChanged = direction !== savedDirection.trim();
  const configChanged = hasConfigDrift();

  if (!directionChanged && !configChanged) return;

  if (directionChanged) {
    try {
      const res = await fetch(`${API}/direction`, {
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
    const cfg = {
      ...readConfigForm(),
      model: null,
    };
    try {
      const res = await fetch(`${API}/config`, {
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

// ---------- Cluster controls -------------------------------------------------
async function startCluster() {
  const ta = document.getElementById("in-direction");
  if (!ta.value.trim()) {
    ta.classList.add("error");
    showError("Direction is required — describe what the agents should work on before starting.");
    ta.focus();
    return;
  }
  ta.classList.remove("error");
  await saveDirection();
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "Starting\u2026";
  try {
    // Push the current form to config. saveDirection() may have already
    // done this if the user had edits; pushing again is harmless (merge
    // is idempotent on identical fields) and covers the case where the
    // user opened the page, didn't touch anything, and clicked Start —
    // the server still needs the latest form values before launch.
    const cfg = { ...readConfigForm(), model: null };
    const cfgRes = await fetch(`${API}/config`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) });
    if (!cfgRes.ok) { showError(`config update failed: ${cfgRes.status} ${await cfgRes.text()}`); return; }
    savedConfig = readConfigForm();
    syncSaveBtn();
    const startRes = await fetch(`${API}/start`, { method: "POST" });
    if (!startRes.ok && startRes.status !== 202) { showError(`start failed: ${startRes.status} ${await startRes.text()}`); return; }
    await poll();
  } catch (err) { showError(`start failed: ${err.message}`); }
  finally { btn.disabled = false; btn.textContent = "Start"; }
}

async function stopCluster() {
  const btn = document.getElementById("btn-stop");
  // Disable immediately for click feedback; label is owned by render(),
  // which sets "Stopping…" as long as the cluster state is "stopping".
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/stop`, { method: "POST" });
    if (!res.ok) { showError(`stop failed: ${res.status} ${await res.text()}`); return; }
    await poll();
  } catch (err) { showError(`stop failed: ${err.message}`); }
  // No finally reset: the next render pass owns the enabled/label state
  // based on cluster state. If the stop request failed, the next poll will
  // see the real state (still running, etc.) and re-enable the button.
}

async function pauseCluster() {
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "Pausing\u2026";
  try {
    const res = await fetch(`${API}/pause`, { method: "POST" });
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
  const btn = document.getElementById("btn-start");
  btn.disabled = true;
  btn.textContent = "Resuming\u2026";
  try {
    const res = await fetch(`${API}/resume`, { method: "POST" });
    if (!res.ok) {
      showError(`resume failed: ${res.status} ${await res.text()}`);
      return;
    }
    await poll();
  } catch (err) {
    showError(`resume failed: ${err.message}`);
  } finally { btn.disabled = false; }
}

// User toggled the autopause checkbox in the controls bar. Going off
// triggers a confirm with the same widget the Clear Environment action
// uses; cancelling reverts the checkbox so the form stays in sync.
// Going on is silent. Either way the change is local until Send.
async function onAutopauseToggle() {
  const cb = document.getElementById("in-autopause");
  if (!cb) return;
  if (!cb.checked) {
    const ok = await _confirmClean(
      "Disable auto-pause",
      "",
      "Without auto-pause the cluster keeps iterating once every agent has gone idle. A forgotten cluster will run indefinitely and keep billing.",
      "Disable",
    );
    if (!ok) {
      cb.checked = true;
    }
  }
  syncSaveBtn();
}

// Wipe environment/{currentClusterId}/ after an explicit confirmation.
// The backend enforces the cluster-must-be-stopped guard and returns 409
// with an error if it isn't — surface that verbatim in the toast.
async function cleanEnvironment() {
  const ok = await _confirmClean(
    "Archive environment",
    `environment/${currentClusterId}/`,
    "Contents will be moved to history/."
  );
  if (!ok) return;
  const btn = document.getElementById("btn-clean-env");
  const wasDisabled = btn ? btn.disabled : false;
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${API}/clean-env`, { method: "POST" });
    if (!res.ok) {
      const text = await res.text();
      let detail = text;
      try { detail = JSON.parse(text).error || text; } catch { /* plain text */ }
      showError(`clean environment failed: ${res.status} ${detail}`);
      return;
    }
    const { archived, deleted } = await res.json().catch(() => ({}));
    const count = archived ?? deleted ?? null;
    toast.textContent = count != null
      ? `Archived to history/: ${count} file${count === 1 ? "" : "s"}.`
      : "Environment archived.";
    toast.classList.add("visible");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove("visible"), 4000);
    if (_envPanel) _envPanel.refresh();
  } catch (err) {
    showError(`clean environment failed: ${err.message}`);
  } finally {
    if (btn) btn.disabled = wasDisabled;
  }
}

// Minimal styled confirm dialog. Matches the WeltenBuilder confirm
// pattern: title in mono accent, optional bold mono "path" line for
// emphasis, short message, action button. Returns a promise resolving
// to true (confirm) or false (cancel/escape/backdrop).
let _confirmCleanRoot = null;
function _confirmClean(title, path, message, confirmLabel) {
  return new Promise((resolve) => {
    if (!_confirmCleanRoot) {
      const root = document.createElement("div");
      root.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:950";
      root.innerHTML = `
        <div style="position:absolute;inset:0;background:rgba(0,0,0,0.6)" data-dismiss></div>
        <div style="position:relative;background:var(--surface);border:1px solid var(--border);border-radius:8px;width:min(420px,90vw);box-shadow:0 12px 40px rgba(0,0,0,0.5);display:flex;flex-direction:column">
          <div style="padding:12px 16px;border-bottom:1px solid var(--border);font-family:var(--mono);font-size:13px;color:var(--accent);font-weight:600" data-title></div>
          <div style="padding:16px;color:var(--text-dim);font-size:13px;line-height:1.5">
            <div style="font-family:var(--mono);font-weight:700;font-size:14px;margin-bottom:8px;color:var(--text)" data-path></div>
            <div data-msg></div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border)">
            <button type="button" style="padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text-muted);font-size:13px;cursor:pointer" data-cancel>Cancel</button>
            <button type="button" style="padding:6px 14px;border:1px solid var(--border);border-radius:6px;background:var(--surface-2);color:var(--text);font-size:13px;font-weight:500;cursor:pointer" data-ok>Archive</button>
          </div>
        </div>
      `;
      document.body.appendChild(root);
      _confirmCleanRoot = root;
    }
    const root = _confirmCleanRoot;
    root.querySelector("[data-title]").textContent = title;
    const pathEl = root.querySelector("[data-path]");
    if (path) {
      pathEl.textContent = path;
      pathEl.style.display = "";
    } else {
      pathEl.style.display = "none";
    }
    root.querySelector("[data-msg]").textContent = message;
    root.querySelector("[data-ok]").textContent = confirmLabel || "Archive";
    root.style.display = "flex";

    function dismiss(result) {
      root.style.display = "none";
      root.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKey);
      resolve(result);
    }
    function onClick(e) {
      if (e.target.matches("[data-dismiss]") || e.target.matches("[data-cancel]")) dismiss(false);
      if (e.target.matches("[data-ok]")) dismiss(true);
    }
    function onKey(e) { if (e.key === "Escape") dismiss(false); }
    root.addEventListener("click", onClick);
    document.addEventListener("keydown", onKey);
    queueMicrotask(() => root.querySelector("[data-cancel]").focus());
  });
}

poll();
setInterval(poll, POLL_MS);

// Expose functions called from HTML onclick attributes
window.startCluster = startCluster;
window.stopCluster = stopCluster;
window.pauseCluster = pauseCluster;
window.resumeCluster = resumeCluster;
window.saveDirection = saveDirection;
window.refreshConfig = refreshConfig;
window.syncDirectionBtn = syncDirectionBtn;
window.syncSaveBtn = syncSaveBtn;
window.stepVal = stepVal;
window.updateInstanceSpec = updateInstanceSpec;
window.checkCapacity = checkCapacity;
window.selectAlgorithm = selectAlgorithm;
window.cleanEnvironment = cleanEnvironment;
window.onAutopauseToggle = onAutopauseToggle;

} // end initDashboard
