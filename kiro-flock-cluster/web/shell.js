/* ============================================================================
   Unified shell — ES module entry point.

   Owns everything shared across the four accordion sections:
     - Cognito auth (single copy; sections never touch auth)
     - the fetch wrapper attaching the bearer token to cluster/forge calls
     - the shared top bar (logo, section-contextual slot, poll indicator,
       sign out)
     - the horizontal accordion controller + lazy section loading
     - the right environment column (envPanel) with
       fold/resize
     - the bottom analyzer drawer with fold
     - toast + confirm modal, exposed to sections via ctx

   Section modules live in sections/<id>.js and export:
     { id, title, async mount(container, ctx), show(params), hide() }

   mount() runs once on first open (build DOM, initial fetches).
   show()/hide() gate the section's polling — only the open section polls.
   ============================================================================ */

// ---------- Section registry -------------------------------------------------

const SECTIONS = [
  { id: "multi-cluster",  title: "Multi Cluster" },
  { id: "single-cluster", title: "Single Cluster" },
  { id: "kiro-node",      title: "Kiro Node" },
  { id: "continuous",     title: "Continuous Deployments" },
];

const OPEN_SECTION_KEY   = "sh_open_section_v1";
const ENV_COLLAPSED_KEY  = "sh_env_collapsed_v1";
const ENV_WIDTH_KEY      = "sh_env_width_v1";
const DRAWER_COLLAPSED_KEY = "sh_drawer_collapsed_v1";
/** The query string a deep link arrived with, parked across the Cognito sign-in. */
const RETURN_TO_KEY = "sh_return_to_v1";

// ---------- Auth ---------------------------------------------------------------

let authConfig = null;
let idToken = null;

async function initAuth() {
  try {
    const base = location.origin + location.pathname.replace(/\/?$/, "/");
    const res = await window.fetch(base + "auth-config.json");
    if (res.ok) authConfig = await res.json();
  } catch { /* auth-config.json missing — auth disabled */ }

  if (!authConfig) return;

  const logoutBtn = document.getElementById("btn-logout");
  if (logoutBtn) {
    logoutBtn.style.display = "";
    logoutBtn.addEventListener("click", logout);
  }

  // Migrate: the three pre-merge apps kept tokens under separate keys.
  // Drop the legacy ones so stale tokens don't linger in sessionStorage.
  sessionStorage.removeItem("welten_id_token");
  sessionStorage.removeItem("forge_id_token");

  // Cognito implicit-flow callback: token arrives in the URL hash.
  const hashParams = new URLSearchParams(window.location.hash.substring(1));
  if (hashParams.has("id_token")) {
    idToken = hashParams.get("id_token");
    sessionStorage.setItem("flock_id_token", idToken);
    // Put the deep link back. Cognito only returns to the registered
    // redirect URI (the bare stage root), so a `?cluster=` or `?section=`
    // the operator arrived with was parked in sessionStorage below and is
    // restored here, before initialSection() reads location.search. Without
    // this, "Open Kiro Flock" from the factory landed on whichever cluster
    // was looked at last whenever the dashboard had to sign in first.
    let search = window.location.search;
    const parked = sessionStorage.getItem(RETURN_TO_KEY);
    sessionStorage.removeItem(RETURN_TO_KEY);
    if (parked && /^\?[A-Za-z0-9_=&%.-]*$/.test(parked)) search = parked;
    history.replaceState(null, "", window.location.pathname + search);
    return;
  }

  // Still-valid token from a previous visit?
  idToken = sessionStorage.getItem("flock_id_token");
  if (idToken) {
    try {
      const payload = JSON.parse(atob(idToken.split(".")[1]));
      if (payload.exp * 1000 > Date.now()) return;
    } catch { /* invalid token, fall through to re-auth */ }
    sessionStorage.removeItem("flock_id_token");
    idToken = null;
  }

  // No valid token — redirect to the Cognito hosted UI. Park the query first
  // so the deep link survives the round trip (see the callback branch above).
  if (window.location.search.length > 1) {
    sessionStorage.setItem(RETURN_TO_KEY, window.location.search);
  }
  const redirectUri = authConfig.apiUrl;
  window.location.href = `https://${authConfig.cognitoDomain}/login`
    + `?client_id=${authConfig.clientId}`
    + `&response_type=token`
    + `&scope=openid`
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`;
}

function logout() {
  sessionStorage.removeItem("flock_id_token");
  if (authConfig) {
    window.location.href = `https://${authConfig.cognitoDomain}/logout`
      + `?client_id=${authConfig.clientId}`
      + `&logout_uri=${encodeURIComponent(authConfig.apiUrl)}`;
  } else {
    window.location.reload();
  }
}

// Attach the bearer token to every relative cluster/forge API call. This is
// the ONLY global fetch interception in the app — URL rewriting (cluster id
// suffixes) is section-local, never global.
const _origFetch = window.fetch.bind(window);
window.fetch = function (url, opts = {}) {
  if (idToken && typeof url === "string" && (url.startsWith("cluster") || url.startsWith("forge"))) {
    opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${idToken}` };
  }
  return _origFetch(url, opts);
};

// ---------- Toast --------------------------------------------------------------

function showError(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.remove("sh-toast-info");
  toast.classList.add("visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove("visible"), 8000);
}

function showInfo(msg) {
  const toast = document.getElementById("toast");
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add("visible", "sh-toast-info");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove("visible", "sh-toast-info");
  }, 4000);
}

// analyzerPanel.js (classic script) calls these when present.
window.showError = showError;
window.showInfo = showInfo;

// ---------- Confirm modal ------------------------------------------------------

let _confirmRoot = null;
let _confirmResolve = null;
let _confirmEscHandler = null;

function _buildConfirmDom() {
  const root = document.createElement("div");
  root.className = "sh-confirm";
  root.setAttribute("aria-hidden", "true");
  root.innerHTML = `
    <div class="sh-confirm-backdrop" data-sh-confirm-dismiss></div>
    <div class="sh-confirm-panel" role="alertdialog" aria-modal="true" aria-labelledby="sh-confirm-title">
      <header class="sh-confirm-header">
        <div class="sh-confirm-title" id="sh-confirm-title">Are you sure?</div>
      </header>
      <div class="sh-confirm-body">
        <div class="sh-confirm-path" data-sh-path></div>
        <div data-sh-msg></div>
        <div class="sh-confirm-typed" data-sh-typed-wrap style="display:none">
          <label class="sh-confirm-typed-label" data-sh-typed-label for="sh-confirm-typed-input"></label>
          <input type="text" id="sh-confirm-typed-input" class="sh-confirm-typed-input" data-sh-typed-input autocomplete="off" spellcheck="false" />
        </div>
      </div>
      <footer class="sh-confirm-footer">
        <button type="button" class="sh-btn sh-btn-ghost" data-sh-cancel>Cancel</button>
        <button type="button" class="sh-btn" data-sh-ok>Confirm</button>
      </footer>
    </div>
  `;
  document.body.appendChild(root);
  root.addEventListener("click", (e) => {
    if (e.target.matches("[data-sh-confirm-dismiss]") || e.target.matches("[data-sh-cancel]")) _resolveConfirm(false);
    if (e.target.matches("[data-sh-ok]")) _resolveConfirm(true);
  });
  return root;
}

function _resolveConfirm(result) {
  if (!_confirmResolve) return;
  const resolve = _confirmResolve;
  _confirmResolve = null;
  _confirmRoot.classList.remove("visible");
  _confirmRoot.setAttribute("aria-hidden", "true");
  if (_confirmEscHandler) {
    document.removeEventListener("keydown", _confirmEscHandler);
    _confirmEscHandler = null;
  }
  resolve(!!result);
}

/**
 * Shared confirmation modal.
 *   confirmAction({ title, message, confirmLabel, destructive, highlightPath, typedPhrase })
 *     → Promise<boolean>
 *
 * When `typedPhrase` is set, a text input is shown and the confirm button
 * stays disabled until the user types the phrase exactly. Used for
 * irreversible operations (environment deletes) and bulk archives.
 */
function confirmAction({ title, message, confirmLabel, destructive, highlightPath, typedPhrase } = {}) {
  if (_confirmResolve) _resolveConfirm(false);
  if (!_confirmRoot) _confirmRoot = _buildConfirmDom();
  const root = _confirmRoot;

  root.querySelector(".sh-confirm-title").textContent = title || "Are you sure?";
  const pathEl = root.querySelector("[data-sh-path]");
  if (highlightPath) {
    pathEl.textContent = highlightPath;
    pathEl.style.display = "";
  } else {
    pathEl.style.display = "none";
  }
  const msgEl = root.querySelector("[data-sh-msg]");
  msgEl.innerHTML = "";
  String(message || "").split("\n").forEach((line, i) => {
    if (i > 0) msgEl.appendChild(document.createElement("br"));
    msgEl.appendChild(document.createTextNode(line));
  });
  const okBtn = root.querySelector("[data-sh-ok]");
  okBtn.textContent = confirmLabel || "Confirm";
  okBtn.classList.toggle("sh-btn-danger-solid", !!destructive);

  // Typed-phrase gate. The input handler is re-assigned on every open
  // (oninput/onkeydown properties, not addEventListener) so stale phrases
  // from a previous dialog can't leak into this one.
  const typedWrap = root.querySelector("[data-sh-typed-wrap]");
  const typedLabel = root.querySelector("[data-sh-typed-label]");
  const typedInput = root.querySelector("[data-sh-typed-input]");
  typedInput.value = "";
  if (typedPhrase) {
    typedWrap.style.display = "";
    typedLabel.textContent = `Type "${typedPhrase}" to confirm:`;
    okBtn.disabled = true;
    typedInput.oninput = () => { okBtn.disabled = typedInput.value !== typedPhrase; };
    typedInput.onkeydown = (e) => {
      if (e.key === "Enter" && typedInput.value === typedPhrase) _resolveConfirm(true);
    };
  } else {
    typedWrap.style.display = "none";
    okBtn.disabled = false;
    typedInput.oninput = null;
    typedInput.onkeydown = null;
  }

  root.classList.add("visible");
  root.setAttribute("aria-hidden", "false");

  return new Promise((resolve) => {
    _confirmResolve = resolve;
    _confirmEscHandler = (e) => { if (e.key === "Escape") _resolveConfirm(false); };
    document.addEventListener("keydown", _confirmEscHandler);
    queueMicrotask(() => {
      if (typedPhrase) {
        typedInput.focus();
      } else {
        const cancelBtn = root.querySelector("[data-sh-cancel]");
        if (cancelBtn) cancelBtn.focus();
      }
    });
  });
}

// ---------- Top bar -------------------------------------------------------------

const topbar = {
  // The active section's contextual controls. Pass an element to place it
  // in the slot (it is NOT cloned — the section keeps updating it), or
  // null to clear.
  setContext(el) {
    const slot = document.getElementById("sh-topbar-context");
    if (!slot) return;
    slot.innerHTML = "";
    if (el) slot.appendChild(el);
  },

  // Poll freshness indicator, WeltenBuilder-style.
  //   setIndicator("success")        → "updated HH:MM:SS"
  //   setIndicator("cached", ts)     → "cached HH:MM:SS" or "loading…"
  //   setIndicator("error")          → "stale since HH:MM:SS" (red)
  _lastTime: 0,
  setIndicator(mode, ts) {
    const el = document.getElementById("sh-poll-indicator");
    if (!el) return;
    const text = el.querySelector(".sh-poll-text");
    el.classList.remove("error");
    if (mode === "success") {
      this._lastTime = ts || Date.now();
      if (text) text.textContent = "updated " + _fmtClock(this._lastTime);
    } else if (mode === "cached") {
      this._lastTime = ts || 0;
      if (text) text.textContent = this._lastTime ? "cached " + _fmtClock(this._lastTime) : "loading\u2026";
    } else if (mode === "error") {
      el.classList.add("error");
      if (text) text.textContent = this._lastTime ? "stale since " + _fmtClock(this._lastTime) : "connection lost";
    }
  },
};

function _fmtClock(ms) {
  if (!ms) return "\u2014";
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// ---------- Environment column ---------------------------------------------------

let _envHandle = null;

function mountEnvPanel() {
  const container = document.getElementById("env-container");
  if (!container || typeof window.envPanel === "undefined") return;
  _envHandle = window.envPanel.mount({
    container,
    apiBase: "cluster",
    onError: (msg) => showError(msg),
  });
  if (_envHandle && typeof _envHandle.setCleanHandler === "function") {
    _envHandle.setCleanHandler(onCleanEnvAll);
  }
  if (_envHandle && typeof _envHandle.setFolderCleanHandler === "function") {
    _envHandle.setFolderCleanHandler(onCleanEnvFolder);
  }
  if (_envHandle && typeof _envHandle.setDeleteAllHandler === "function") {
    _envHandle.setDeleteAllHandler(onDeleteEnvAll);
  }
  if (_envHandle && typeof _envHandle.setFolderDeleteHandler === "function") {
    _envHandle.setFolderDeleteHandler(onDeleteEnvFolder);
  }
}

async function onCleanEnvAll() {
  const ok = await confirmAction({
    title: "Archive environment",
    message: "Archives stopped clusters' environment folders to history/. Running clusters are skipped.",
    confirmLabel: "Archive all",
    destructive: false,
    highlightPath: "environment/",
    typedPhrase: "all will be archived",
  });
  if (!ok) return;
  try {
    const res = await window.fetch("cluster/clean-env-all", { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.running) && parsed.running.length > 0) detail = ` Running: ${parsed.running.join(", ")}.`;
        else if (parsed.error) detail = ` ${parsed.error}`;
      } catch { /* plain text */ }
      if (res.status === 409) showError(`Cannot clean environment while clusters are running.${detail}`);
      else showError(`Clean environment failed: ${res.status}${detail}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    const parts = [];
    if (typeof data.archived === "number") parts.push(`${data.archived} archived to history/`);
    if (typeof data.deleted === "number" && data.deleted > 0) parts.push(`${data.deleted} swept`);
    showInfo(parts.length > 0 ? `Environment cleaned: ${parts.join(", ")}.` : "Environment cleaned.");
    if (_envHandle) _envHandle.refresh();
  } catch (err) {
    showError(`Clean environment failed: ${err.message || err}`);
  }
}

async function onCleanEnvFolder(folder) {
  const ok = await confirmAction({
    title: "Archive folder",
    message: "This folder will be moved to history/.",
    confirmLabel: "Archive",
    destructive: false,
    highlightPath: folder,
  });
  if (!ok) return;
  try {
    const res = await window.fetch("cluster/clean-env-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError(err.error || `Failed to archive ${folder}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    showInfo(`Archived ${data.archived ?? 0} files from ${folder}`);
    if (_envHandle) _envHandle.refresh();
  } catch (err) {
    showError(`Archive failed: ${err.message || err}`);
  }
}

async function onDeleteEnvFolder(folder) {
  const ok = await confirmAction({
    title: "Delete folder",
    message: "This folder will be permanently deleted. No copy is kept in history/ — this cannot be undone.",
    confirmLabel: "Delete",
    destructive: true,
    highlightPath: folder,
    typedPhrase: "delete",
  });
  if (!ok) return;
  try {
    const res = await window.fetch("cluster/delete-env-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError(err.error || `Failed to delete ${folder}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    showInfo(`Deleted ${data.deleted ?? 0} files from ${folder}`);
    if (_envHandle) _envHandle.refresh();
  } catch (err) {
    showError(`Delete failed: ${err.message || err}`);
  }
}

async function onDeleteEnvAll() {
  const ok = await confirmAction({
    title: "Delete environment",
    message: "Permanently deletes everything under environment/. No copy is kept in history/ — this cannot be undone. All clusters must be stopped.",
    confirmLabel: "Delete all",
    destructive: true,
    highlightPath: "environment/",
    typedPhrase: "all will be gone",
  });
  if (!ok) return;
  try {
    const res = await window.fetch("cluster/delete-env-all", { method: "POST" });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let detail = "";
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed.running) && parsed.running.length > 0) detail = ` Running: ${parsed.running.join(", ")}.`;
        else if (parsed.error) detail = ` ${parsed.error}`;
      } catch { /* plain text */ }
      if (res.status === 409) showError(`Cannot delete environment while clusters are running.${detail}`);
      else showError(`Delete environment failed: ${res.status}${detail}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    showInfo(typeof data.deleted === "number" ? `Environment deleted: ${data.deleted} files removed.` : "Environment deleted.");
    if (_envHandle) _envHandle.refresh();
  } catch (err) {
    showError(`Delete environment failed: ${err.message || err}`);
  }
}

function wireEnvColumn() {
  const right = document.getElementById("sh-right");
  const handle = document.getElementById("sh-resize-handle");
  const main = document.querySelector(".sh-main");
  const toggle = document.getElementById("sh-env-toggle");
  if (!right || !handle || !main) return;

  // Restore persisted width + collapsed state.
  const savedWidth = parseInt(localStorage.getItem(ENV_WIDTH_KEY) || "", 10);
  if (Number.isFinite(savedWidth) && savedWidth >= 160) right.style.width = savedWidth + "px";
  if (localStorage.getItem(ENV_COLLAPSED_KEY) === "1") {
    right.classList.add("collapsed");
    main.classList.add("env-collapsed");
  }

  function setCollapsed(collapsed) {
    right.classList.toggle("collapsed", collapsed);
    main.classList.toggle("env-collapsed", collapsed);
    try { localStorage.setItem(ENV_COLLAPSED_KEY, collapsed ? "1" : "0"); } catch { /* ignore */ }
    if (toggle) toggle.title = collapsed ? "Expand environment panel" : "Collapse environment panel";
  }

  if (toggle) {
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setCollapsed(!right.classList.contains("collapsed"));
    });
  }
  // Clicking anywhere on the collapsed strip re-expands it.
  right.addEventListener("click", () => {
    if (right.classList.contains("collapsed")) setCollapsed(false);
  });

  // Drag-resize (disabled while collapsed — the handle is hidden then).
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
      right.style.width = newWidth + "px";
    }
  });
  document.addEventListener("mouseup", () => {
    if (!resizing) return;
    resizing = false;
    handle.classList.remove("dragging");
    const w = parseInt(right.style.width, 10);
    if (Number.isFinite(w)) {
      try { localStorage.setItem(ENV_WIDTH_KEY, String(w)); } catch { /* ignore */ }
    }
  });
}

// ---------- Analyzer drawer -------------------------------------------------------

function mountAnalyzerDrawer() {
  const drawer = document.getElementById("sh-drawer");
  const bar = document.getElementById("sh-drawer-bar");
  const chevron = document.getElementById("sh-drawer-chevron");
  const container = document.getElementById("analyzer-container");
  if (!drawer || !bar) return;

  if (localStorage.getItem(DRAWER_COLLAPSED_KEY) === "1") drawer.classList.add("collapsed");

  function syncChevron() {
    if (chevron) chevron.innerHTML = drawer.classList.contains("collapsed") ? "&#9652;" : "&#9662;";
  }
  syncChevron();

  function toggle() {
    drawer.classList.toggle("collapsed");
    try {
      localStorage.setItem(DRAWER_COLLAPSED_KEY, drawer.classList.contains("collapsed") ? "1" : "0");
    } catch { /* ignore */ }
    syncChevron();
  }
  bar.addEventListener("click", toggle);
  bar.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  });

  if (container && typeof window.analyzerPanel !== "undefined") {
    window.analyzerPanel.mount(container);
  }
}

// ---------- Accordion controller ----------------------------------------------------

// id → { module, mounted, item, pane }
const _sections = new Map();
let _openId = null;

function buildAccordion() {
  const acc = document.getElementById("sh-accordion");
  if (!acc) return;
  for (const def of SECTIONS) {
    const item = document.createElement("div");
    item.className = "sh-acc-item";
    item.setAttribute("data-section", def.id);

    const rail = document.createElement("div");
    rail.className = "sh-acc-rail";
    rail.setAttribute("role", "button");
    rail.setAttribute("tabindex", "0");
    rail.setAttribute("aria-label", `Open ${def.title}`);
    rail.innerHTML = `<span class="sh-acc-title">${def.title}</span>`;
    rail.addEventListener("click", () => openSection(def.id));
    rail.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openSection(def.id); }
    });

    const pane = document.createElement("div");
    pane.className = "sh-acc-pane";
    pane.id = `pane-${def.id}`;

    item.appendChild(rail);
    item.appendChild(pane);
    acc.appendChild(item);

    _sections.set(def.id, { def, module: null, mounted: false, mounting: null, item, pane });
  }
}

// The ctx object handed to every section at mount time.
const ctx = {
  topbar,
  openSection: (id, params) => openSection(id, params),
  showError,
  showInfo,
  confirm: confirmAction,
  envPanel: () => _envHandle,
};

// Static markup via innerHTML, dynamic text via textContent (DOM-XSS safe).
function paneNotice(pane, text, spinner) {
  pane.innerHTML = `<div class="sh-pane-loading">${spinner ? '<div class="sh-spinner"></div>' : ""}<div></div></div>`;
  pane.querySelector(".sh-pane-loading > div:last-child").textContent = text;
}

async function openSection(id, params) {
  const entry = _sections.get(id);
  if (!entry) return;

  // Re-open of the already-open section: just forward params (e.g. a
  // multi-cluster card click while single-cluster is already open).
  if (_openId === id) {
    if (entry.module && typeof entry.module.show === "function") entry.module.show(params);
    return;
  }

  // Hide the currently open section (pauses its polling).
  if (_openId) {
    const cur = _sections.get(_openId);
    if (cur) {
      cur.item.classList.remove("open");
      if (cur.module && typeof cur.module.hide === "function") {
        try { cur.module.hide(); } catch (err) { console.error(`hide(${_openId}) failed`, err); }
      }
    }
    topbar.setContext(null);
  }

  _openId = id;
  entry.item.classList.add("open");
  topbar.setIndicator("cached", 0); // "loading…" until the section's first poll
  try { localStorage.setItem(OPEN_SECTION_KEY, id); } catch { /* ignore */ }

  // Lazy-load the section module on first open.
  if (!entry.mounted) {
    if (!entry.mounting) {
      paneNotice(entry.pane, `Loading ${entry.def.title}\u2026`, true);
      entry.mounting = (async () => {
        // Section CSS loads lazily alongside the module. Resolved against
        // the module URL so it works from any stage path.
        const cssHref = new URL(`./sections/${id}.css`, import.meta.url).href;
        if (!document.querySelector(`link[href="${cssHref}"]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = cssHref;
          document.head.appendChild(link);
        }
        const mod = (await import(`./sections/${id}.js`)).default;
        entry.pane.innerHTML = "";
        await mod.mount(entry.pane, ctx);
        entry.module = mod;
        entry.mounted = true;
      })();
    }
    try {
      await entry.mounting;
    } catch (err) {
      entry.mounting = null;
      paneNotice(entry.pane, `Failed to load ${entry.def.title}: ${String(err && err.message || err)}`);
      console.error(`mount(${id}) failed`, err);
      return;
    }
  }

  // The user may have switched away while the module loaded.
  if (_openId !== id) return;
  if (entry.module && typeof entry.module.show === "function") {
    try { entry.module.show(params); } catch (err) { console.error(`show(${id}) failed`, err); }
  }
}

// ---------- Boot ----------------------------------------------------------------------

function initialSection() {
  // Deep-link compat: ?cluster=<id> opens Single Cluster scoped to it.
  // ?section=kiro-node&cluster=<id>&agent=<n> opens the Kiro Node pane
  // for one agent (used by Kiro Factory's remote loop panel).
  const qs = new URLSearchParams(location.search);
  const cluster = qs.get("cluster");
  if (cluster && /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/.test(cluster)) {
    if (qs.get("section") === "kiro-node") {
      const agent = qs.get("agent");
      const agentIndex = agent !== null && /^\d{1,3}$/.test(agent) ? parseInt(agent, 10) : 0;
      return { id: "kiro-node", params: { cluster, agentIndex } };
    }
    return { id: "single-cluster", params: { cluster } };
  }
  // Hash hint (also used by the /welten and /forge redirect pages).
  const hash = location.hash.replace(/^#/, "");
  if (_sections.has(hash)) return { id: hash, params: undefined };
  // Last-open section, else default to the leftmost.
  const saved = localStorage.getItem(OPEN_SECTION_KEY);
  if (saved && _sections.has(saved)) return { id: saved, params: undefined };
  return { id: SECTIONS[0].id, params: undefined };
}

// ---------- Dashboard overlay ----------------------------------------------------

// Lazy-loaded on first click, same CSS-link + dynamic-import pattern as
// sections. dashboard.js default-exports { open, close }.
let _dashboardModule = null;
let _dashboardLoading = null;

async function openDashboard(params) {
  if (!_dashboardModule) {
    if (!_dashboardLoading) {
      _dashboardLoading = (async () => {
        const cssHref = new URL("./dashboard.css", import.meta.url).href;
        if (!document.querySelector(`link[href="${cssHref}"]`)) {
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = cssHref;
          document.head.appendChild(link);
        }
        _dashboardModule = (await import("./dashboard.js")).default;
      })();
    }
    try {
      await _dashboardLoading;
    } catch (err) {
      _dashboardLoading = null;
      showError(`Failed to load dashboard: ${String(err && err.message || err)}`);
      console.error("dashboard load failed", err);
      return;
    }
  }
  _dashboardModule.open(params, { showError, showInfo });
}

function wireDashboardButton() {
  const btn = document.getElementById("btn-dashboard");
  if (btn) btn.addEventListener("click", () => openDashboard());
}

function boot() {
  buildAccordion();
  wireEnvColumn();
  mountEnvPanel();
  mountAnalyzerDrawer();
  wireDashboardButton();
  const { id, params } = initialSection();
  openSection(id, params);
}

initAuth().then(() => {
  // Classic-script panels (envPanel/analyzerPanel) are
  // injected with async=false, so they've run by the load event. Boot
  // after load to guarantee window.envPanel & friends exist.
  if (document.readyState === "complete") boot();
  else window.addEventListener("load", boot, { once: true });
});
