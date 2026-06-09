/* =========================================================================
   WeltenBuilder front-end scaffold.

   This file is intentionally a skeleton. Later waves fill in real behaviour:
     - Wave 2.3: direction popout + renderMarkdown
     - Wave 2.4: foldable environment tree
     - Wave 3.1: cluster stack cards + polling
     - Wave 3.2: global controls (Stop All, Pause All, Clean Env)
     - Wave 4.1: drill-down view

   The structure below is split into three logical modules kept in one file
   (matches kiro-flock/web/app.js — no build step, no framework):
     1. Auth layer        — Cognito implicit-flow login, mirrors kiro-flock
     2. API client        — thin wrapper around fetch, handles cluster suffix
     3. State management  — single in-memory store + render bootstrap
   ========================================================================= */


/* =========================================================================
   1. Auth layer

   Identical pattern to kiro-flock/web/app.js. The API Gateway and Cognito
   pool are shared, so auth-config.json written by install.sh works for
   both apps. When auth-config.json is missing we run without auth.
   ========================================================================= */

let authConfig = null;
let idToken = null;

async function initAuth() {
  try {
    const base = location.origin + location.pathname.replace(/\/?$/, "/");
    const res = await fetch(base + "auth-config.json");
    if (res.ok) authConfig = await res.json();
  } catch { /* auth-config.json missing — auth disabled */ }

  if (!authConfig) return;

  // Show logout button once auth is configured.
  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) logoutBtn.style.display = "";

  // Capture id_token returned via Cognito implicit-flow redirect.
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  if (params.has("id_token")) {
    idToken = params.get("id_token");
    sessionStorage.setItem("welten_id_token", idToken);
    history.replaceState(null, "", window.location.pathname);
    return;
  }

  // Check sessionStorage for a still-valid token from a previous visit.
  idToken = sessionStorage.getItem("welten_id_token");
  if (idToken) {
    try {
      const payload = JSON.parse(atob(idToken.split(".")[1]));
      if (payload.exp * 1000 > Date.now()) return;
    } catch { /* invalid token, fall through to re-auth */ }
    sessionStorage.removeItem("welten_id_token");
    idToken = null;
  }

  // No valid token — redirect to Cognito hosted UI.
  const redirectUri = authConfig.apiUrl;
  const loginUrl = `https://${authConfig.cognitoDomain}/login`
    + `?client_id=${authConfig.clientId}`
    + `&response_type=token`
    + `&scope=openid`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`;
  window.location.href = loginUrl;
}

// Wrap fetch to attach the bearer token on cluster API calls. Matches the
// kiro-flock pattern. The string "cluster" prefix check covers all
// `/cluster/...` endpoints (start, stop, list, create, etc.).
const _origFetch = window.fetch;
window.fetch = function(url, opts = {}) {
  if (idToken && typeof url === "string" && url.startsWith("cluster")) {
    opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${idToken}` };
  }
  return _origFetch.call(this, url, opts);
};

function logout() {
  sessionStorage.removeItem("welten_id_token");
  if (authConfig) {
    const logoutUrl = `https://${authConfig.cognitoDomain}/logout`
      + `?client_id=${authConfig.clientId}`
      + `&logout_uri=${encodeURIComponent(authConfig.apiUrl)}`;
    window.location.href = logoutUrl;
  } else {
    window.location.reload();
  }
}


/* =========================================================================
   2. API client

   Suffix-style routes per requirement 2.1: `/cluster/{action}/{cluster_id}`.
   When clusterId is omitted the API defaults to cluster_0 (req 2.2), so
   callers never have to special-case the single-cluster fallback.

   Only the method shells exist in this wave. Later waves fill in the
   specifics — but the shape is stable so callers can depend on it.
   ========================================================================= */

const API = "cluster"; // base path, relative to the current page

const apiClient = {
  // Build a path like "cluster/start/my-cluster" or "cluster/start".
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

  // Cluster registry
  listClusters()        { return this._json("GET",    "list"); },
  deleteCluster(id)     { return this._json("DELETE", "delete", id); },

  // Per-cluster lifecycle
  start(id)             { return this._json("POST", "start",  id); },
  stop(id)              { return this._json("POST", "stop",   id); },
  pause(id)             { return this._json("POST", "pause",  id); },
  resume(id)            { return this._json("POST", "resume", id); },
  status(id)            { return this._json("GET",  "status", id); },

  // Per-cluster config + direction
  getConfig(id)         { return this._json("GET", "config",    id); },
  putConfig(id, cfg)    { return this._json("PUT", "config",    id, cfg); },
  getDirection(id)      { return this._json("GET", "direction", id); },
  putDirection(id, txt) { return this._json("PUT", "direction", id, { direction: txt }); },

  // Global actions
  stopAll()             { return this._json("POST", "stop-all"); },
  pauseAll()            { return this._json("POST", "pause-all"); },
  cleanEnvAll()         { return this._json("POST", "clean-env-all"); },
  cleanEnv(id)          { return this._json("POST", "clean-env", id); },
};


/* =========================================================================
   3. State management

   Single global store. Views subscribe by calling render() directly after
   a mutation. No reactive framework — keeps us in vanilla JS per req 7.
   ========================================================================= */

const state = {
  // Cluster list from GET /cluster/list. Populated by the cluster poll.
  clusters: [],

  // Confirmation dialog state. `null` when no dialog is open. Otherwise
  // holds { title, message, confirmLabel, destructive, resolve }.
  confirmDialog: null,
};

// Small shared helpers used across card rendering and toasts. The
// full environment tree logic lives in web-shared/envPanel.js, but
// the cluster cards still need a tiny escape function and a byte
// formatter here.
const _wbEsc = (s) => s == null ? "" : String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Compact relative-time formatter for cluster card "last update" lines.
// Outputs strings like "3s", "2m", "1h", "4d". For very recent timestamps
// returns "just now". Returns "—" on parse failure.
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

// Trim a string with an ellipsis. Used for the truncated last-action
// text on cluster cards.
function _wbTruncate(s, n) {
  if (!s) return "\u2014";
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
}

function showError(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("wb-toast-error", "wb-toast-info");
  toast.classList.add("visible", "wb-toast-error");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 6000);
}

function showInfo(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("wb-toast-error", "wb-toast-info");
  toast.classList.add("visible", "wb-toast-info");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 4000);
}


/* =========================================================================
   Render shells

   Later waves replace these bodies with real DOM rendering. For now they
   just make sure the placeholder DOM stays consistent with state.
   ========================================================================= */

function renderClusters() {
  renderClusterStacks();
}

function renderHeader() {
  // Enable/disable the global control buttons based on the current
  // cluster roster. Stop All is live when any cluster is not stopped;
  // Pause All when any is actively running.
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const anyNotStopped = clusters.some(c => c && c.state && c.state !== "stopped");
  const anyRunning    = clusters.some(c => c && c.state === "running");

  const btnStopAll  = document.getElementById("btn-stop-all");
  const btnPauseAll = document.getElementById("btn-pause-all");

  if (btnStopAll)  btnStopAll.disabled  = !anyNotStopped;
  if (btnPauseAll) btnPauseAll.disabled = !anyRunning;
}

function render() {
  renderHeader();
  renderClusters();
}


/* =========================================================================

/* =========================================================================
   Boot

   Mirrors the kiro-flock pattern: auth first, then wire up and render.
   The environment poll starts here (Wave 2.4). Wave 3.1 adds the
   cluster poll alongside it.
   ========================================================================= */

function init() {
  // Wire up global-control buttons.
  const btnStopAll  = document.getElementById("btn-stop-all");
  const btnPauseAll = document.getElementById("btn-pause-all");
  const btnLogout   = document.getElementById("btn-logout");

  if (btnStopAll)  btnStopAll.addEventListener("click",  onClickStopAll);
  if (btnPauseAll) btnPauseAll.addEventListener("click", onClickPauseAll);
  if (btnLogout)   btnLogout.addEventListener("click",   logout);

  render();

  // Resize handle for the environment panel. Matches the dashboard's
  // col-resize pattern (min 160px, max 70vw).
  wireResizeHandle();

  // Shared environment panel (same module the dashboard uses). Hides
  // the per-cluster "clean" button because WeltenBuilder's topbar
  // Clean Environment handles the cross-cluster case.
  mountEnvPanel();

  // Analyzer/Optimizer bottom panel (Bedrock-powered).
  mountAnalyzerPanel();

  // Cluster grid polling.
  wireClusterStackEvents();
  startClusterPolling();
}

let _envPanelHandle = null;

function mountEnvPanel() {
  const container = document.getElementById("env-container");
  if (!container || typeof window.envPanel === "undefined") return;
  _envPanelHandle = window.envPanel.mount({
    container,
    apiBase: "cluster",
    onError: (msg) => showError(msg),
  });
  // Wire the panel's clean button to the cross-cluster clean-all flow.
  if (_envPanelHandle && typeof _envPanelHandle.setCleanHandler === "function") {
    _envPanelHandle.setCleanHandler(onClickCleanEnv);
  }
}

function mountAnalyzerPanel() {
  const container = document.getElementById("analyzer-container");
  if (!container || typeof window.analyzerPanel === "undefined") return;
  window.analyzerPanel.mount(container);
}

// Resize handle for the environment panel. Ported from the dashboard's
// web/app.js so the two apps behave the same. Clamp limits are identical.
function wireResizeHandle() {
  const handle = document.getElementById("resize-handle");
  const panel = document.querySelector(".wb-main-right");
  const main = document.querySelector(".wb-main");
  if (!handle || !panel || !main) return;

  let resizing = false;
  handle.addEventListener("mousedown", (e) => {
    resizing = true;
    handle.classList.add("dragging");
    e.preventDefault();
  });
  document.addEventListener("mousemove", (e) => {
    if (!resizing) return;
    const rect = main.getBoundingClientRect();
    const newWidth = rect.right - e.clientX;
    if (newWidth >= 160 && newWidth <= rect.width * 0.7) {
      panel.style.width = newWidth + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    resizing = false;
    handle.classList.remove("dragging");
  });
}

/* =========================================================================
   Global controls + confirm dialog (Wave 3.2)

   Header buttons "Stop All", "Pause All", and "Clean Environment" are
   the cluster-wide destructive actions. Each goes through a confirm
   dialog before firing the API call.

   The confirm dialog is a reusable helper:
     confirmAction({ title, message, confirmLabel, destructive })
       → Promise<boolean>

   It lazily builds a modal in <body>, dismisses on Escape or backdrop
   click, and resolves the promise based on the user's choice. Destructive
   dialogs get a red confirm button; the default is orange (AWS accent).
   The modal sits at z-index 950 — above cluster cards (no z-index set on
   them) and above the direction popout (z-index 900) so confirms raised
   from inside the popout still appear on top.
   ========================================================================= */

let _confirmDialogRoot = null;
let _confirmDialogEscHandler = null;

function _buildConfirmDialogDom() {
  const root = document.createElement("div");
  root.id = "wb-confirm";
  root.className = "wb-confirm";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="wb-confirm-backdrop" data-wb-confirm-dismiss></div>
    <div class="wb-confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="wb-confirm-title" aria-describedby="wb-confirm-message">
      <header class="wb-confirm-header">
        <div class="wb-confirm-title" id="wb-confirm-title">Are you sure?</div>
      </header>
      <div class="wb-confirm-body" id="wb-confirm-message"></div>
      <footer class="wb-confirm-footer">
        <button type="button" class="wb-btn wb-btn-ghost wb-confirm-cancel">Cancel</button>
        <button type="button" class="wb-btn wb-confirm-ok">Confirm</button>
      </footer>
    </div>
  `;
  document.body.appendChild(root);

  // Backdrop click or Cancel button → resolve false.
  root.addEventListener("click", (e) => {
    if (e.target && e.target.matches && e.target.matches("[data-wb-confirm-dismiss]")) {
      _resolveConfirm(false);
    }
  });
  root.querySelector(".wb-confirm-cancel").addEventListener("click", () => _resolveConfirm(false));
  root.querySelector(".wb-confirm-ok").addEventListener("click", () => _resolveConfirm(true));

  return root;
}

function _resolveConfirm(result) {
  const d = state.confirmDialog;
  if (!d) return;
  const resolve = d.resolve;
  state.confirmDialog = null;
  _renderConfirmDialog();
  if (_confirmDialogEscHandler) {
    document.removeEventListener("keydown", _confirmDialogEscHandler);
    _confirmDialogEscHandler = null;
  }
  if (typeof resolve === "function") resolve(!!result);
}

function _renderConfirmDialog() {
  const d = state.confirmDialog;
  if (!d) {
    if (_confirmDialogRoot) {
      _confirmDialogRoot.classList.remove("visible");
      _confirmDialogRoot.setAttribute("aria-hidden", "true");
    }
    return;
  }
  if (!_confirmDialogRoot) _confirmDialogRoot = _buildConfirmDialogDom();
  const root = _confirmDialogRoot;
  root.classList.add("visible");
  root.setAttribute("aria-hidden", "false");

  root.querySelector(".wb-confirm-title").textContent = d.title || "Are you sure?";
  const msgEl = root.querySelector(".wb-confirm-body");
  msgEl.innerHTML = "";

  // Show the path being archived in bold monospace if provided.
  if (d.highlightPath) {
    const pathEl = document.createElement("div");
    pathEl.style.cssText = "font-family:var(--mono);font-weight:700;font-size:14px;margin-bottom:8px;color:var(--text)";
    pathEl.textContent = d.highlightPath;
    msgEl.appendChild(pathEl);
  }

  const lines = (d.message || "").split("\n");
  lines.forEach((line, i) => {
    if (i > 0) msgEl.appendChild(document.createElement("br"));
    msgEl.appendChild(document.createTextNode(line));
  });

  const okBtn = root.querySelector(".wb-confirm-ok");
  okBtn.textContent = d.confirmLabel || "Confirm";
  okBtn.classList.toggle("wb-btn-danger-solid", !!d.destructive);
  // Focus the cancel button by default so Enter-to-confirm requires
  // an explicit tab; reduces the chance of an accidental destructive action.
  queueMicrotask(() => {
    const cancelBtn = root.querySelector(".wb-confirm-cancel");
    if (cancelBtn) cancelBtn.focus();
  });
}

/**
 * Show a confirmation modal. Returns a promise that resolves to `true`
 * if the user confirmed, `false` if they cancelled or dismissed.
 *
 * Example:
 *   const ok = await confirmAction({
 *     title: "Stop all clusters",
 *     message: "This will terminate all running clusters.",
 *     confirmLabel: "Stop All",
 *     destructive: true,
 *   });
 *   if (!ok) return;
 */
function confirmAction({ title, message, confirmLabel, destructive, highlightPath } = {}) {
  // If a previous dialog is somehow still open, resolve it as cancelled
  // to avoid leaking its promise. New prompt takes precedence.
  if (state.confirmDialog) _resolveConfirm(false);

  return new Promise((resolve) => {
    state.confirmDialog = {
      title: title || "Are you sure?",
      message: message || "",
      confirmLabel: confirmLabel || "Confirm",
      destructive: !!destructive,
      highlightPath: highlightPath || null,
      resolve,
    };
    _renderConfirmDialog();
    _confirmDialogEscHandler = (e) => {
      if (e.key === "Escape") _resolveConfirm(false);
    };
    document.addEventListener("keydown", _confirmDialogEscHandler);
  });
}

// ---- Button handlers -------------------------------------------------------

async function onClickStopAll() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const running = clusters.filter(c => c && c.state && c.state !== "stopped");
  if (running.length === 0) return; // button is disabled in this case

  const names = running.map(c => c.name || c.id).filter(Boolean).join(", ");
  const ok = await confirmAction({
    title: "Stop all clusters",
    message: `This will terminate all running clusters (${running.length}):\n${names}`,
    confirmLabel: "Stop All",
    destructive: true,
  });
  if (!ok) return;

  try {
    const res = await apiClient.stopAll();
    const stopped = Array.isArray(res && res.stopped) ? res.stopped.length : null;
    const failed  = Array.isArray(res && res.failed)  ? res.failed.length  : 0;
    if (failed > 0) {
      showError(`Stop All: ${stopped != null ? stopped + " stopped, " : ""}${failed} failed.`);
    } else {
      showInfo(stopped != null
        ? `Stop All: ${stopped} cluster${stopped === 1 ? "" : "s"} stopped.`
        : "Stop All: requested.");
    }
    pollClusters();
  } catch (err) {
    showError(`Stop All failed: ${err.message || err}`);
  }
}

async function onClickPauseAll() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const running = clusters.filter(c => c && c.state === "running");
  if (running.length === 0) return; // button is disabled in this case

  const names = running.map(c => c.name || c.id).filter(Boolean).join(", ");
  const ok = await confirmAction({
    title: "Pause all clusters",
    message: `This will pause agent work on all running clusters (${running.length}):\n${names}\n\nInstances keep running. Use Resume on each cluster to continue.`,
    confirmLabel: "Pause All",
    destructive: false,
  });
  if (!ok) return;

  try {
    const res = await apiClient.pauseAll();
    const paused = Array.isArray(res && res.paused) ? res.paused.length : null;
    const failed = Array.isArray(res && res.failed) ? res.failed.length : 0;
    if (failed > 0) {
      showError(`Pause All: ${paused != null ? paused + " paused, " : ""}${failed} failed.`);
    } else {
      showInfo(paused != null
        ? `Pause All: ${paused} cluster${paused === 1 ? "" : "s"} paused.`
        : "Pause All: requested.");
    }
    pollClusters();
  } catch (err) {
    showError(`Pause All failed: ${err.message || err}`);
  }
}

async function onClickCleanEnv() {
  const clusters = Array.isArray(state.clusters) ? state.clusters : [];
  const active = clusters.filter(c => c && c.state && c.state !== "stopped");
  const message = active.length > 0
    ? `${active.length} cluster${active.length === 1 ? " is" : "s are"} not stopped. The server will refuse unless all clusters are stopped first.`
    : "Agent output, uploads, and intermediate state will be moved to history/.";

  const ok = await confirmAction({
    title: "Archive environment",
    message,
    confirmLabel: "Archive",
    destructive: false,
    highlightPath: "environment/",
  });
  if (!ok) return;

  try {
    const res = await apiClient.cleanEnvAll();
    const archived = typeof (res && res.archived) === "number" ? res.archived : null;
    const deleted = typeof (res && res.deleted) === "number" ? res.deleted : null;
    const parts = [];
    if (archived != null) parts.push(`${archived} archived to history/`);
    if (deleted != null && deleted > 0) parts.push(`${deleted} swept`);
    showInfo(parts.length > 0
      ? `Environment cleaned: ${parts.join(", ")}.`
      : "Environment cleaned.");
    if (_envPanelHandle && typeof _envPanelHandle.refresh === "function") {
      _envPanelHandle.refresh();
    }
  } catch (err) {
    // The API returns 409 with a list of running clusters. apiClient._json
    // wraps non-ok responses in an Error whose message includes the body.
    const raw = String(err && err.message || err);
    // Try to extract the running cluster list from a JSON body in the error.
    let detail = "";
    const jsonMatch = raw.match(/\{.*\}/s);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed.running) && parsed.running.length > 0) {
          detail = ` Running: ${parsed.running.join(", ")}.`;
        } else if (parsed.error) {
          detail = ` ${parsed.error}`;
        }
      } catch { /* ignore parse errors */ }
    }
    if (/\b409\b/.test(raw)) {
      showError(`Cannot clean environment while clusters are running.${detail}`);
    } else {
      showError(`Clean Environment failed: ${raw}`);
    }
  }
}


/* =========================================================================
   Cluster stack cards

   Polls GET /cluster/list on a short interval and renders one card per
   non-stopped cluster plus a trailing "+" tile. Cards carry the cluster's
   algorithm accent, a truncated direction preview, a compact config
   summary, and Stop/Pause/Open buttons.

   Clicking a card body (anywhere but a button) opens the full
   single-cluster dashboard for that cluster. Same destination as the
   Open button, larger click target.

   Direction and config are lazy-fetched per cluster and cached in
   _wbDirectionCache / _wbConfigCache so the card preview doesn't refetch
   on every poll.
   ========================================================================= */

// ---- caches ---------------------------------------------------------------

const _wbDirectionCache = new Map();   // clusterId → { text, fetching }
const _wbConfigCache    = new Map();   // clusterId → { config, fetching }

// ---- rendering ------------------------------------------------------------

// Map cluster state → {label, class} for the state badge.
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

// Truncate direction text for the card preview — first ~120 chars or 3
// lines, whichever hits first. The full doc opens in the popout on click.
function _wbTruncateDirection(text) {
  if (!text) return "";
  const lines = text.split("\n").filter(l => l.trim().length > 0).slice(0, 3);
  let out = lines.join(" ").trim();
  if (out.length > 140) out = out.slice(0, 137).trimEnd() + "\u2026";
  return out;
}

// Build the URL for the single-cluster dashboard pointing at a specific
// cluster. Derives the base the same way app.js' inline loader does so
// trailing-slash differences between stages don't matter.
function _wbDashboardUrl(clusterId) {
  // Strip /welten off the end to get the API root, then append
  // ?cluster=<id>. Works for both /prod/welten and /prod/welten/.
  const base = location.origin + location.pathname
    .replace(/\/$/, "")
    .replace(/\/welten$/, "")
    + "/";
  return `${base}?cluster=${encodeURIComponent(clusterId)}`;
}

// Which buttons are valid for which state.
function _wbButtonDisabled(action, clusterState) {
  const s = clusterState;
  switch (action) {
    case "start":  return !(s === "stopped");
    case "stop":   return !(s === "running" || s === "paused" || s === "starting");
    case "pause":  return !(s === "running" || s === "starting");
    case "resume": return !(s === "paused");
    case "open":   return false; // always allowed, navigates to full dashboard
    default: return true;
  }
}

// Algorithm → CSS modifier class. Card and drill-down header/body get
// this class so they retint to the active algorithm's accent colour.
// Unknown algorithms fall back to amorphous so the card always has a
// visible accent.
function _wbAlgoClass(algo) {
  const a = (algo || "").toLowerCase();
  if (a === "mesh" || a === "swarm" || a === "amorphous") return `wb-algo--${a}`;
  return "wb-algo--amorphous";
}

function renderClusterStacks() {
  const container = document.getElementById("cluster-stacks");
  if (!container) return;

  // Hide fully-stopped clusters: the registry remembers them forever but
  // the overview should only show what's alive. A stopped cluster is
  // still accessible via the dashboard URL, and it can come back once
  // something writes to it (Start, config save, direction save), at
  // which point the backend bumps its state past "stopped" and it
  // reappears here.
  const raw = Array.isArray(state.clusters) ? state.clusters : [];
  const clusters = raw.filter(c => c && c.state && c.state !== "stopped");

  // Wipe anything from a previous render; rebuild from scratch each time.
  container.innerHTML = "";

  for (const c of clusters) {
    container.appendChild(_wbBuildClusterCard(c));
  }

  // Trailing "+" new-cluster tile. Always present, always last. Clicking
  // it picks a fresh cluster id client-side and navigates to the
  // single-cluster dashboard — nothing is created server-side until the
  // operator clicks Start there.
  const addCard = document.createElement("div");
  addCard.className = "wb-cluster-stack wb-cluster-stack-new";
  addCard.setAttribute("data-wb-new", "");
  addCard.setAttribute("role", "button");
  addCard.setAttribute("tabindex", "0");
  addCard.setAttribute("aria-label", "Create new cluster");
  addCard.innerHTML = `<span class="wb-cluster-stack-new-plus">+</span>
    <span class="wb-cluster-stack-new-label">New cluster</span>`;
  container.appendChild(addCard);
}

function _wbBuildClusterCard(c) {
  const id = c.id;
  const name = c.name || c.id;
  // Prefer the live config's algorithm over the stale registry entry.
  const cfgEntry = _wbConfigCache.get(id);
  const cfg = cfgEntry && cfgEntry.config ? cfgEntry.config : null;
  const algo = ((cfg && cfg.algorithm) || c.algorithm || "amorphous").toLowerCase();
  const algoClass = _wbAlgoClass(algo);
  const stateInfo = _wbStateBadge(c.state);

  const card = document.createElement("article");
  card.className = `wb-cluster-stack ${algoClass}${_wbFirstPollDone ? "" : " wb-stale"}`;
  card.setAttribute("data-wb-cluster-id", id);
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", `Cluster ${name}`);

  // Direction preview — refetch every render cycle so MCP or optimizer
  // changes show up within one poll interval. The fetching flag prevents
  // concurrent requests for the same cluster.
  const dirEntry = _wbDirectionCache.get(id);
  if (!dirEntry || !dirEntry.fetching) {
    _wbFetchDirection(id);
  }
  const dirPreview = dirEntry && dirEntry.text != null
    ? (_wbTruncateDirection(dirEntry.text) || "(no direction set)")
    : "(loading\u2026)";

  // Config summary — same lazy-fetch pattern. Show em dashes on miss.
  if (!cfgEntry || (!cfgEntry.fetching && !cfgEntry.config)) {
    _wbFetchConfig(id);
  }
  const concurrency = cfg && cfg.concurrency != null ? cfg.concurrency : "\u2014";
  const instanceType = cfg && cfg.instanceType ? cfg.instanceType : "\u2014";

  // Pause button swaps to Resume when the cluster is paused.
  const isPaused = c.state === "paused";
  const pauseAction = isPaused ? "resume" : "pause";
  const pauseLabel = isPaused ? "Resume" : "Pause";

  const stopDisabled   = _wbButtonDisabled("stop",       c.state) ? "disabled" : "";
  const pauseDisabled  = _wbButtonDisabled(pauseAction,  c.state) ? "disabled" : "";

  // Last update line: agent-N · 12s ago · short action. Comes from
  // /cluster/list which does a single ListObjectsV2 + ranged GetObject
  // per cluster and includes the parsed entry as `lastUpdate`. We render
  // a short "—" placeholder when nothing has been logged yet.
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

  card.innerHTML = `
    <header class="wb-stack-header">
      <div class="wb-stack-header-main">
        <div class="wb-stack-name" title="${_wbEsc(name)}">${_wbEsc(name)}</div>
        <span class="wb-stack-algo">${_wbEsc(algo)}</span>
      </div>
      <span class="wb-stack-state ${stateInfo.cls}">${_wbEsc(stateInfo.label)}</span>
    </header>

    <div class="wb-stack-direction" title="${_wbEsc(dirPreview)}">
      ${_wbEsc(dirPreview)}${dirEntry && dirEntry.text && dirEntry.text.length > 140 ? ` <a href="#" class="wb-stack-direction-more" data-wb-dir-show="${_wbEsc(id)}">show all</a>` : ""}
    </div>

    ${lastUpdateHtml}

    <div class="wb-stack-config">
      <span class="wb-stack-config-item"><span class="wb-stack-config-label">agents</span> ${_wbEsc(String(concurrency))}</span>
      <span class="wb-stack-config-sep">\u00b7</span>
      <span class="wb-stack-config-item"><span class="wb-stack-config-label">instance</span> ${_wbEsc(String(instanceType))}</span>${cfg && cfg.internetAccess ? `\n      <span class="wb-stack-config-sep">\u00b7</span>\n      <span class="wb-stack-config-item"><span class="wb-stack-config-label">\u{1F310}</span> web</span>` : ""}
    </div>

    <footer class="wb-stack-actions">
      <button type="button" class="wb-stack-btn wb-stack-btn--stop"   data-wb-action="stop"   ${stopDisabled}>Stop</button>
      <button type="button" class="wb-stack-btn wb-stack-btn--pause"  data-wb-action="${pauseAction}" ${pauseDisabled}>${pauseLabel}</button>
      <button type="button" class="wb-stack-btn wb-stack-btn--open"   data-wb-action="open">Open</button>
    </footer>
  `;

  return card;
}

// ---- lazy fetches ---------------------------------------------------------

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
    // Only re-render if the direction actually changed. Avoids a DOM
    // rebuild loop that resets hover state and makes buttons unclickable.
    if (text !== prev) renderClusterStacks();
  } catch {
    // Keep the entry in place but clear the fetching flag so the next
    // render cycle can retry. Fail silently per the design — a stale
    // preview is better than a noisy toast for every poll.
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

// ---- direction popup ------------------------------------------------------

let _wbDirPopupRoot = null;

function _wbShowDirectionPopup(clusterId) {
  const entry = _wbDirectionCache.get(clusterId);
  const text = entry && entry.text ? entry.text : "";
  if (!text) return;

  if (!_wbDirPopupRoot) _wbDirPopupRoot = _wbBuildDirPopupDom();
  const root = _wbDirPopupRoot;

  // Set title to cluster name.
  const cluster = (state.clusters || []).find(c => c.id === clusterId);
  const name = cluster ? (cluster.name || cluster.id) : clusterId;
  root.querySelector(".wb-dir-popup-title").textContent = `Direction: ${name}`;

  // Render direction as markdown (sanitized to prevent XSS from
  // Bedrock-generated proposals that may echo agent log content).
  const bodyEl = root.querySelector(".wb-dir-popup-body");
  if (typeof marked !== "undefined" && marked.parse) {
    const rawHtml = marked.parse(text);
    const safeHtml = typeof DOMPurify !== "undefined" ? DOMPurify.sanitize(rawHtml) : _wbEsc(text);
    bodyEl.innerHTML = `<div class="env-viewer-md">${safeHtml}</div>`;
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

  // Dismiss on backdrop click, close button, or Escape.
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

// ---- events ---------------------------------------------------------------

function wireClusterStackEvents() {
  const container = document.getElementById("cluster-stacks");
  if (!container || container._wbWired) return;
  container._wbWired = true;

  container.addEventListener("click", (e) => {
    // "+" new-cluster card.
    const newCard = e.target.closest("[data-wb-new]");
    if (newCard) {
      _wbCreateNewCluster();
      return;
    }

    // "show all" direction link — opens the direction popup.
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

    // Button clicks handle their own action and stop propagation.
    const actionEl = e.target.closest("[data-wb-action]");
    if (actionEl && card.contains(actionEl)) {
      const action = actionEl.getAttribute("data-wb-action");
      e.stopPropagation();
      _wbHandleCardAction(clusterId, action, actionEl);
      return;
    }

    // Click anywhere else on the card opens the full single-cluster
    // dashboard for this cluster. Same destination as the Open button,
    // just with a much larger click target.
    window.location.href = _wbDashboardUrl(clusterId);
  });

  // Keyboard activation on the "+" card and regular cards.
  container.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const newCard = e.target.closest("[data-wb-new]");
    if (newCard) {
      e.preventDefault();
      _wbCreateNewCluster();
      return;
    }
    const card = e.target.closest(".wb-cluster-stack");
    if (!card) return;
    // Don't hijack the space key inside a button.
    if (e.target.tagName === "BUTTON") return;
    const clusterId = card.getAttribute("data-wb-cluster-id");
    if (!clusterId) return;
    e.preventDefault();
    window.location.href = _wbDashboardUrl(clusterId);
  });
}

// New-cluster flow: no API call, no prompt. Pick a fresh id using the
// last four digits of the epoch-ms timestamp (zero-padded) and navigate
// to the single-cluster dashboard. If the roll lands on 0000 — which
// would collide with the reserved default cluster_0 — bump to 0001.
// The backend auto-registers the cluster on the first PUT/Start, so the
// card shows up in WeltenBuilder the moment the operator does something
// real on the dashboard.
function _wbCreateNewCluster() {
  let suffix = Date.now() % 10000;
  if (suffix === 0) suffix = 1;
  const padded = String(suffix).padStart(4, "0");
  const id = `cluster_${padded}`;
  window.location.href = _wbDashboardUrl(id);
}

async function _wbHandleCardAction(clusterId, action, btnEl) {
  if (!action) return;

  if (action === "open") {
    window.location.href = _wbDashboardUrl(clusterId);
    return;
  }

  // Lifecycle actions: start, stop, pause, resume.
  if (btnEl) btnEl.disabled = true;
  try {
    switch (action) {
      case "start":  await apiClient.start(clusterId);  break;
      case "stop":   await apiClient.stop(clusterId);   break;
      case "pause":  await apiClient.pause(clusterId);  break;
      case "resume": await apiClient.resume(clusterId); break;
      default: return;
    }
    // Refresh the list immediately so the state badge updates without
    // waiting for the next poll tick.
    pollClusters();
  } catch (err) {
    showError(`${action} ${clusterId} failed: ${err.message || err}`);
    if (btnEl) btnEl.disabled = false;
  }
}

// ---- polling --------------------------------------------------------------

let _wbClusterPollTimer = null;

// Cluster list is cached to localStorage on every successful poll so the
// page renders instantly on next load. Cards rendered from cache get a
// .wb-stale class that dims them; the .wb-poll-indicator in the header
// stays visible until the first real poll lands and clears the dim. The
// cache version key bumps if the shape ever changes incompatibly.
const WB_CACHE_KEY = "wb_clusters_v1";

function _wbWriteCache(list) {
  try {
    localStorage.setItem(WB_CACHE_KEY, JSON.stringify({ at: Date.now(), clusters: list }));
  } catch {
    // localStorage may be unavailable (private mode, quota). Cache is
    // a perf hint, not a correctness requirement, so silently skip.
  }
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

// Top-bar timestamp. Shows when the cluster list was last successfully
// fetched. Always visible. On error, flips red and shows "stale" so the
// operator knows the view is frozen. On page load from cache, shows the
// cached timestamp so the operator can see how old the data is.
let _wbLastPollTime = 0;

function _wbSetPollIndicator(mode, ts) {
  const el = document.getElementById("wb-poll-indicator");
  if (!el) return;
  const text = el.querySelector(".wb-poll-text");
  el.classList.remove("error");

  if (mode === "success") {
    _wbLastPollTime = ts || Date.now();
    if (text) text.textContent = "updated " + _wbFormatTime(_wbLastPollTime);
  } else if (mode === "cached") {
    _wbLastPollTime = ts || 0;
    if (text) text.textContent = _wbLastPollTime
      ? "cached " + _wbFormatTime(_wbLastPollTime)
      : "loading\u2026";
  } else if (mode === "error") {
    el.classList.add("error");
    if (text) text.textContent = _wbLastPollTime
      ? "stale since " + _wbFormatTime(_wbLastPollTime)
      : "connection lost";
  }
}

function _wbFormatTime(ms) {
  if (!ms) return "\u2014";
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

// Has the first successful poll happened yet? Drives the .wb-stale
// class on cards rendered from cache.
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

    // Prune caches for clusters that no longer exist.
    const live = new Set(list.map(c => c.id));
    for (const key of Array.from(_wbDirectionCache.keys())) {
      if (!live.has(key)) _wbDirectionCache.delete(key);
    }
    for (const key of Array.from(_wbConfigCache.keys())) {
      if (!live.has(key)) _wbConfigCache.delete(key);
    }

    renderClusterStacks();
    // Let the global-controls render refresh its enabled/disabled state.
    if (typeof renderHeader === "function") renderHeader();
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

  // Render from localStorage cache before kicking the network. Pages
  // open with cards already on screen instead of an empty list while
  // the API round-trip lands; the .wb-stale class on each card and the
  // header timestamp showing "cached HH:MM:SS" make it clear the data
  // is provisional.
  const cached = _wbReadCache();
  if (cached && cached.length > 0) {
    state.clusters = cached;
    renderClusterStacks();
    if (typeof renderHeader === "function") renderHeader();
    // Show the cache timestamp so the operator knows how old the data is.
    const raw = localStorage.getItem(WB_CACHE_KEY);
    const cacheTs = raw ? (JSON.parse(raw).at || 0) : 0;
    _wbSetPollIndicator("cached", cacheTs);
  } else {
    _wbSetPollIndicator("cached", 0);
  }

  pollClusters();
  _wbClusterPollTimer = setInterval(pollClusters, 3000);
}


initAuth().then(init);
