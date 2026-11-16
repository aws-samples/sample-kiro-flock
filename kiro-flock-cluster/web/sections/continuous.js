/* ============================================================================
   Continuous Deployments section — the split-panel deployment monitoring
   dashboard, ported into the unified shell.

   Left panel (2/3): live iframe + changelog + architecture diagram +
   team status. Right panel (1/3): CloudWatch metric graphs
   (Bedrock-selected layout).

   Keeps its own internal deployment-group tabs exactly as before; the
   accordion rail is the only entry point (no cross-section navigation
   targets this section). Shell-owned: auth, env column (new for this
   view!), analyzer drawer, toast. Clear Cache moved to the topbar
   context slot. The 60s metrics/changelog/preview refresh and the 30s
   team-status refresh are gated by show()/hide().
   ============================================================================ */

let ctx = null;
let contextEl = null;
let tabsEl = null;
let contentEl = null;

// ---- State ----
let deployments = [];
let activeTab = null;
let timeRange = "1h";
let layoutCache = {};
let _discovered = false;

// ---- Discovery ----

async function discoverDeployments() {
  const resp = await fetch("cluster/habitat");
  if (!resp || !resp.ok) {
    contentEl.innerHTML = `<div class="forge-empty">Failed to load environment. Check authentication.</div>`;
    ctx.topbar.setIndicator("error");
    return;
  }
  const data = await resp.json();
  const files = data.files || [];
  deployments = [];
  _discovered = true;

  const ungroupedDeployed = files.some(f => f.key.startsWith("environment/deployed/"));
  if (ungroupedDeployed) {
    deployments.push({ group: null, path: "environment/deployed/", label: "Default" });
  }

  const groupedPattern = /^environment\/([^/]+)\/deployed\//;
  const groups = new Set();
  for (const f of files) {
    const match = f.key.match(groupedPattern);
    if (match && match[1] !== "deployed") groups.add(match[1]);
  }
  for (const group of groups) {
    deployments.push({ group, path: `environment/${group}/deployed/`, label: group });
  }

  renderTabs();
  ctx.topbar.setIndicator("success");
  if (deployments.length > 0) {
    activeTab = deployments[0].group;
    renderActiveTab();
  } else {
    contentEl.innerHTML = `<div class="forge-empty">No deployments found.<br>Deploy something with a continuous deployment cluster and it will appear here.</div>`;
  }
}

// ---- Tabs ----

function renderTabs() {
  tabsEl.innerHTML = deployments.map(d => `
    <div class="forge-tab${d.group === activeTab ? ' active' : ''}" data-group="${d.group ?? '__default__'}">${d.label}</div>
  `).join("");
  tabsEl.querySelectorAll(".forge-tab").forEach(tab => {
    tab.addEventListener("click", async () => {
      const g = tab.dataset.group;
      activeTab = g === "__default__" ? null : g;
      tabsEl.querySelectorAll(".forge-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      await renderActiveTab();
    });
  });
}

// ---- Data fetching ----

/** True when a layout is worth remembering for the rest of the session.
 *
 *  `handleLayout` returns HTTP 200 with `{ panels: [], summary: "No stack
 *  found" }` when `deployed/latest.json` is missing — a successful response
 *  carrying an empty payload, not an HTTP error. Caching that froze the whole
 *  session: no monitoring grid, no graphs, no stack badge, while live preview
 *  and changelog kept rendering from their own independent fetches.
 *
 *  Worse, `layoutCache` is JS heap state rather than browser cache, so neither
 *  tab-switching nor an ordinary refresh (which can restore from bfcache)
 *  evicted it — only the topbar Clear Cache button or a hard reload. That is
 *  why refreshing appeared to do nothing.
 *
 *  The server never persisted the empty layout (it only writes its S3 cache
 *  after a successful Bedrock generation), so declining to cache it here means
 *  a transient backend gap self-heals on the next render. */
function isCacheableLayout(data) {
  if (!data || typeof data !== "object") return false;
  if (data.error) return false;
  if (Array.isArray(data.panels) && data.panels.length > 0) return true;
  // A layout with a fingerprint came from a real generation, so honour it even
  // if this stack legitimately has no panels.
  return Boolean(data._fingerprint);
}

async function fetchLayout(deployment) {
  const cacheKey = deployment.group ?? "__default__";
  if (layoutCache[cacheKey]) return layoutCache[cacheKey];
  const resp = await fetch("forge/layout", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: deployment.group }),
  });
  if (!resp || !resp.ok) return { panels: [], summary: "", mermaid: "", _resources: [] };
  const data = await resp.json();
  if (isCacheableLayout(data)) layoutCache[cacheKey] = data;
  return data;
}

async function fetchMetrics(deployment) {
  const resp = await fetch("forge/metrics", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: deployment.group, timeRange }),
  });
  if (!resp || !resp.ok) return { panels: {} };
  return await resp.json();
}

async function fetchChangelog(deployment) {
  const path = deployment.path + "changelog.md";
  const resp = await fetch(`cluster/habitat/file?key=${encodeURIComponent(path)}`);
  if (!resp || !resp.ok) return null;
  const data = await resp.json();
  return data.content || null;
}

async function fetchDeployedUrl(deployment) {
  const path = deployment.path + "latest.json";
  const resp = await fetch(`cluster/habitat/file?key=${encodeURIComponent(path)}`);
  if (!resp || !resp.ok) return null;
  try {
    const data = await resp.json();
    const content = data.content ? JSON.parse(data.content) : data;
    return content.url || null;
  } catch { return null; }
}

// ---- Main render ----

async function renderActiveTab() {
  const deployment = deployments.find(d => d.group === activeTab);
  if (!deployment) return;

  contentEl.innerHTML = `<div class="forge-loading"><div class="spinner"></div><div>Loading...</div></div>`;

  const [deployedUrl, changelog] = await Promise.all([
    fetchDeployedUrl(deployment),
    fetchChangelog(deployment),
  ]);

  const layout = await fetchLayout(deployment);
  const metrics = await fetchMetrics(deployment);

  renderSplitDashboard(layout, metrics, changelog, deployedUrl, deployment);
}

// ---- Split dashboard render ----

function renderSplitDashboard(layout, metrics, changelog, deployedUrl, deployment) {
  const panels = layout?.panels || [];
  const resources = layout?._resources || [];
  const mermaidCode = layout?.mermaid || "";
  const timeButtons = ["1h", "6h", "24h"].map(t =>
    `<button class="${t === timeRange ? 'active' : ''}" data-range="${t}">${t}</button>`
  ).join("");

  const resourceBadge = resources.length > 0
    ? `<span class="forge-resource-badge" id="resource-badge">${resources.length} resources</span>`
    : "";

  const livePreviewHtml = deployedUrl
    ? `<div class="forge-iframe-wrap"><iframe id="forge-preview-iframe" src="${esc(deployedUrl)}" class="forge-iframe"></iframe></div>
       <div class="forge-preview-actions"><a href="${esc(deployedUrl)}" target="_blank" rel="noopener" class="forge-open-link">Open in new tab &#x2197;</a><button id="btn-refresh-iframe" class="forge-open-link" style="background:none;border:none;cursor:pointer">&#x21bb; Refresh</button></div>`
    : `<div class="forge-iframe-empty">No deployed URL</div>`;

  const changelogHtml = changelog
    ? safeMarkdown(changelog)
    : `<p class="forge-muted">No changelog yet.</p>`;

  const metricPanelsHtml = (() => {
    if (!panels.length) return `<div class="forge-muted">No metrics available.</div>`;
    const categoryOrder = ["traffic", "compute", "data"];
    const categoryLabels = { traffic: "Traffic", compute: "Compute", data: "Data", other: "Other" };
    // Anything the metric catalog tags with a category outside the known three
    // used to be dropped from the grid silently — a new resource type would
    // just vanish with no indication. Bucket the strays into "Other" instead.
    const known = new Set(categoryOrder);
    const groups = categoryOrder.map(cat => [cat, panels.filter(p => p.category === cat)]);
    groups.push(["other", panels.filter(p => !known.has(p.category))]);
    let html = "";
    for (const [cat, catPanels] of groups) {
      if (catPanels.length === 0) continue;
      html += `<div class="forge-category-header">${categoryLabels[cat] || cat}</div>`;
      for (const p of catPanels) {
        const idx = panels.indexOf(p);
        html += `<div class="forge-metric-panel"><h3>${esc(p.title)}</h3><div style="position:relative;height:140px"><canvas id="chart-${idx}"></canvas></div></div>`;
      }
    }
    return html;
  })();

  contentEl.innerHTML = `
    <div class="forge-split">
      <div class="forge-left">
        <div class="forge-title-row">
          <div class="forge-label forge-app-title">${esc(deployment?.label || "Deployment")} ${layout?.summary ? `<span class="forge-app-desc">${esc(layout.summary)}</span>` : ""}</div>
          <button type="button" class="forge-destroy-btn" id="btn-destroy-deployment" title="Destroy the CloudFormation stack behind this deployment">Destroy</button>
        </div>
        <div class="forge-left-top">
          <div class="forge-live-panel">
            <div class="forge-label">Live Preview <span class="forge-refreshed" id="preview-refreshed"></span></div>
            ${livePreviewHtml}
          </div>
          <div class="forge-changelog-panel">
            <div class="forge-label">Changelog <span class="forge-refreshed" id="changelog-refreshed"></span>${resourceBadge}</div>
            <div class="forge-changelog-body">${changelogHtml}</div>
            <div class="forge-diagram" id="mermaid-diagram"></div>
          </div>
        </div>
        <div class="forge-status-panel">
          <div class="forge-status-panel-header">
            <span class="forge-label">Team Status <span class="forge-refreshed" id="status-refreshed"></span></span>
            <label class="forge-status-toggle"><input type="checkbox" id="status-auto-refresh" checked> auto refresh</label>
          </div>
          <div class="forge-status-body" id="status-body"><div class="forge-muted">Loading status...</div></div>
        </div>
      </div>
      <div class="forge-handle" id="split-handle"></div>
      <div class="forge-right">
        <div class="forge-label" style="display:flex;justify-content:space-between">
          Monitoring <div class="time-range">${timeButtons}</div>
        </div>
        <div class="forge-metrics-stack" id="metrics-grid">${metricPanelsHtml}</div>
      </div>
    </div>
    <div class="forge-popup" id="resource-popup" style="display:none">
      <div class="forge-popup-backdrop" data-dismiss></div>
      <div class="forge-popup-panel">
        <div class="forge-popup-header"><span>Stack Resources (${resources.length})</span><button class="forge-popup-close" data-dismiss>&times;</button></div>
        <div class="forge-popup-body">${resources.map(r => `<div class="forge-resource-row"><span class="forge-resource-type">${esc(r.type)}</span><span class="forge-resource-id">${esc(r.logicalId)}</span></div>`).join("")}</div>
      </div>
    </div>
    <div class="forge-popup" id="diagram-popup" style="display:none">
      <div class="forge-popup-backdrop" data-dismiss></div>
      <div class="forge-popup-panel" style="width:min(900px,95vw);max-height:85vh">
        <div class="forge-popup-header"><span>Architecture</span><button class="forge-popup-close" data-dismiss>&times;</button></div>
        <div class="forge-popup-body" id="diagram-popup-body" style="overflow:auto;padding:24px"></div>
      </div>
    </div>
  `;

  wireInteractions(mermaidCode, panels, metrics, resources, deployment);
  wireStatusAutoRefresh();
}

// ---- Destroy deployment ----

/**
 * Destroy the CloudFormation stack backing a deployment group. Same
 * typed-phrase guard as the environment delete-all flow — the user types
 * "goodbye <stackName>" before the Destroy button arms. Allowed regardless
 * of whether the deployer cluster is still running; the dialog notes a
 * running deployer because it may simply redeploy the stack afterwards.
 */
async function onDestroyDeployment(deployment) {
  let info;
  try {
    const resp = await fetch("forge/stack-info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: deployment.group }),
    });
    if (!resp || !resp.ok) {
      const err = await resp?.json().catch(() => ({}));
      ctx.showError(err?.error || "No stack found for this deployment.");
      return;
    }
    info = await resp.json();
  } catch (err) {
    ctx.showError(`Could not load stack info: ${err.message || err}`);
    return;
  }

  const stackName = info.stackName;
  const lines = [
    "Deletes the CloudFormation stack and all its resources. This cannot be undone.",
    `Current stack status: ${info.stackStatus || "unknown"}.`,
    "Deployment records under environment/ are kept as the audit trail.",
  ];
  const running = (info.clusters || []).filter(c => c.state !== "stopped");
  if (running.length > 0) {
    const names = running.map(c => `${c.name} (${c.state})`).join(", ");
    lines.push(`Note: deployer cluster${running.length > 1 ? "s" : ""} ${names} for this group ${running.length > 1 ? "are" : "is"} still active and may redeploy the stack after destruction.`);
  }

  const ok = await ctx.confirm({
    title: "Destroy deployment",
    message: lines.join("\n"),
    confirmLabel: "Destroy",
    destructive: true,
    highlightPath: stackName,
    typedPhrase: `goodbye ${stackName}`,
  });
  if (!ok) return;

  try {
    const res = await fetch("forge/destroy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ group: deployment.group }),
    });
    if (!res || !res.ok) {
      const err = await res?.json().catch(() => ({}));
      ctx.showError(err?.error || `Destroy failed: ${res?.status}`);
      return;
    }
    const data = await res.json().catch(() => ({}));
    ctx.showInfo(`Stack ${data.stackName || stackName} deletion started.`);
    // The cached layout describes resources that are now being deleted.
    delete layoutCache[deployment.group ?? "__default__"];
    await renderActiveTab();
  } catch (err) {
    ctx.showError(`Destroy failed: ${err.message || err}`);
  }
}

// ---- Interactions ----

function wireInteractions(mermaidCode, panels, metrics, resources, deployment) {
  const destroyBtn = contentEl.querySelector("#btn-destroy-deployment");
  if (destroyBtn && deployment) {
    destroyBtn.addEventListener("click", () => onDestroyDeployment(deployment));
  }

  contentEl.querySelectorAll(".time-range button").forEach(btn => {
    btn.addEventListener("click", async () => {
      timeRange = btn.dataset.range;
      await renderActiveTab();
    });
  });

  const refreshBtn = contentEl.querySelector("#btn-refresh-iframe");
  const iframe = contentEl.querySelector("#forge-preview-iframe");
  if (refreshBtn && iframe) {
    refreshBtn.addEventListener("click", () => { iframe.src = iframe.src; });
  }

  const badge = contentEl.querySelector("#resource-badge");
  const popup = contentEl.querySelector("#resource-popup");
  if (badge && popup) {
    badge.addEventListener("click", () => popup.style.display = "flex");
    popup.querySelectorAll("[data-dismiss]").forEach(el =>
      el.addEventListener("click", () => popup.style.display = "none"));
  }

  const diagramPopup = contentEl.querySelector("#diagram-popup");
  if (diagramPopup) {
    diagramPopup.querySelectorAll("[data-dismiss]").forEach(el =>
      el.addEventListener("click", () => diagramPopup.style.display = "none"));
  }

  // Resizable split handle
  const handle = contentEl.querySelector("#split-handle");
  if (handle) {
    let dragging = false;
    handle.addEventListener("mousedown", () => { dragging = true; document.body.style.cursor = "col-resize"; });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const split = handle.parentElement;
      const rect = split.getBoundingClientRect();
      const pctVal = ((e.clientX - rect.left) / rect.width) * 100;
      const clamped = Math.max(30, Math.min(80, pctVal));
      split.style.gridTemplateColumns = clamped + "% 4px 1fr";
    });
    document.addEventListener("mouseup", () => { dragging = false; document.body.style.cursor = ""; });
  }

  // Mermaid diagram (small, click to enlarge)
  if (mermaidCode && typeof mermaid !== "undefined") {
    const el = contentEl.querySelector("#mermaid-diagram");
    if (el) {
      const code = mermaidCode.replace(/\\n/g, "\n").trim();
      try {
        mermaid.initialize({ startOnLoad: false, theme: "dark", themeVariables: { primaryColor: "#e94560", background: "#1a1a24", primaryTextColor: "#ffffff" } });
        const id = "mermaid-svg-" + Date.now();
        mermaid.render(id, code).then(({ svg }) => {
          el.innerHTML = svg;
          el.style.cursor = "pointer";
          el.addEventListener("click", () => {
            const body = contentEl.querySelector("#diagram-popup-body");
            if (body && diagramPopup) { body.innerHTML = svg; diagramPopup.style.display = "flex"; }
          });
        }).catch(err => {
          el.innerHTML = `<pre style="font-size:10px;color:#e94560;white-space:pre-wrap">${esc(String(err))}</pre>`;
        });
      } catch (err) {
        el.innerHTML = `<pre style="font-size:10px;color:#e94560">${esc(String(err))}</pre>`;
      }
    }
  }

  // Charts
  if (metrics) {
    const metricData = metrics.panels || {};
    panels.forEach((panel, i) => {
      const canvas = contentEl.querySelector(`#chart-${i}`);
      if (!canvas) return;
      const panelMetrics = [];
      for (const key of (panel.metrics || [])) {
        const series = metricData[key];
        if (series) panelMetrics.push(...series);
      }
      renderChart(canvas, panelMetrics);
    });
  }
}

// ---- Chart rendering ----

const COLORS = ["rgba(233,69,96,0.8)", "rgba(78,205,196,0.8)", "rgba(245,166,35,0.8)", "rgba(124,92,191,0.8)"];

function shortenLabel(label) {
  return label.replace(/[A-F0-9]{8,}/g, "...").replace(/\s+/g, " ").slice(0, 35);
}

function renderChart(canvas, metricsData) {
  if (!metricsData || metricsData.length === 0) {
    const c = canvas.getContext("2d");
    c.fillStyle = "#9aa4b8";
    c.font = "12px sans-serif";
    c.textAlign = "center";
    c.fillText("No data", canvas.width / 2, 70);
    return;
  }
  const first = metricsData[0];
  const labels = first.datapoints.map(dp => {
    const d = new Date(dp.timestamp);
    return d.getHours().toString().padStart(2, "0") + ":" + d.getMinutes().toString().padStart(2, "0");
  });
  const datasets = metricsData.map((m, idx) => ({
    label: shortenLabel(m.label || ""),
    data: m.datapoints.map(dp => dp.value),
    borderColor: COLORS[idx % COLORS.length],
    backgroundColor: COLORS[idx % COLORS.length].replace("0.8", "0.1"),
    borderWidth: 1.5,
    pointRadius: 0,
    tension: 0.3,
    fill: true,
  }));
  new Chart(canvas, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: "index" },
      plugins: { legend: { display: datasets.length > 1, labels: { color: "#b6bac9", font: { size: 9 } } } },
      scales: {
        x: { grid: { color: "rgba(58,58,80,0.5)" }, ticks: { color: "#9aa4b8", font: { size: 8 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 8 } },
        y: { beginAtZero: true, grid: { color: "rgba(58,58,80,0.5)" }, ticks: { color: "#9aa4b8", font: { size: 9 } } },
      },
    },
  });
}

// ---- Utilities ----

function esc(s) { return (s || "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c])); }

// Render changelog markdown to safe HTML. The changelog is agent-authored and
// routinely contains bare tags in prose (e.g. "injects its own <style>"). marked
// passes raw HTML through, and a raw <style>/<script> injected via innerHTML is a
// "raw text element": the parser swallows every following sibling as its text
// content until a matching close tag — which silently ate the entire Monitoring
// column (forge-right, the 2x2 grid, graphs) and both popups. Sanitize by parsing
// the marked output into a detached <template> and stripping any element that can
// hijack parsing or execute, plus inline event handlers and javascript: URLs.
function safeMarkdown(md) {
  let html;
  try {
    html = marked.parse(md || "");
  } catch {
    return esc(md || "");
  }
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const STRIP = ["style", "script", "link", "iframe", "object", "embed", "template", "noscript", "base"];
  tpl.content.querySelectorAll(STRIP.join(",")).forEach(el => el.remove());
  tpl.content.querySelectorAll("*").forEach(el => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const val = (attr.value || "").trim().toLowerCase();
      if (name.startsWith("on") || ((name === "href" || name === "src") && val.startsWith("javascript:"))) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

// ---- Status report ----

let statusRefreshTimer = null;

async function fetchStatusReport(deployment) {
  const resp = await fetch("forge/status-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ group: deployment.group }),
  });
  if (!resp || !resp.ok) return { teams: [] };
  return await resp.json();
}

function renderStatusCards(teams, matrix) {
  if (!teams || teams.length === 0) return `<div class="forge-muted">No team activity yet.</div>`;
  const cardsHtml = `<div class="forge-status-grid">${teams.map(t => {
    const healthColors = { green: "#4ade80", amber: "#f5a623", red: "#e94560" };
    const healthColor = healthColors[t.health] || "#a8aec0";
    return `<div class="forge-status-box">
      <div class="forge-status-box-header">
        <span class="forge-status-light" style="background:${healthColor}"></span>
        <span class="forge-status-box-name">${esc(t.id || t.name)}</span>
      </div>
      <div class="forge-status-box-text">${esc(t.status)}</div>
      <div class="forge-status-box-state">${esc(t.state)}</div>
    </div>`;
  }).join("")}</div>`;

  const matrixHtml = renderMatrix(matrix || [], teams);

  return `<div class="forge-status-split"><div class="forge-status-left">${cardsHtml}</div><div class="forge-status-right">${matrixHtml}</div></div>`;
}

function renderMatrix(points, teams) {
  if (!points || points.length === 0) return `<div class="forge-muted">No matrix data.</div>`;
  const size = 300;
  const healthColors = { green: "#4ade80", amber: "#f5a623", red: "#e94560" };
  const teamHealthMap = {};
  if (teams) teams.forEach(t => { teamHealthMap[t.id] = t.health; });

  const positions = points.map(p => ({
    cx: Math.round(p.x * (size - 40) + 20),
    cy: Math.round((1 - p.y) * (size - 40) + 20),
  }));

  const dots = points.map((p, i) => {
    const { cx, cy } = positions[i];
    const label = (p.id || "").replace(/^skillshare-/, "");
    const color = healthColors[teamHealthMap[p.id]] || "#a8aec0";
    const labelY = (i % 2 === 0) ? cy - 10 : cy + 16;
    return `<circle cx="${cx}" cy="${cy}" r="7" fill="${color}" stroke="#111118" stroke-width="2"><title>${esc(p.id)}</title></circle>
            <text x="${cx}" y="${labelY}" text-anchor="middle" fill="#dcdfe8" font-size="9" font-weight="500">${esc(label)}</text>`;
  }).join("");

  return `<div class="forge-matrix">
    <div class="forge-matrix-labels">
      <span class="forge-matrix-label-tl">Needs attention</span>
      <span class="forge-matrix-label-tr">Watch closely</span>
      <span class="forge-matrix-label-bl">Just started</span>
      <span class="forge-matrix-label-br">On track</span>
    </div>
    <svg viewBox="0 0 ${size} ${size}" class="forge-matrix-svg">
      <line x1="${size/2}" y1="0" x2="${size/2}" y2="${size}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4"/>
      <line x1="0" y1="${size/2}" x2="${size}" y2="${size/2}" stroke="var(--border)" stroke-width="1" stroke-dasharray="4,4"/>
      ${dots}
    </svg>
    <div class="forge-matrix-axes">
      <span class="forge-matrix-x">Progress &rarr;</span>
      <span class="forge-matrix-y">Risk &uarr;</span>
    </div>
  </div>`;
}

async function refreshStatus() {
  const deployment = deployments.find(d => d.group === activeTab);
  if (!deployment) return;
  const body = contentEl.querySelector("#status-body");
  if (!body) return;
  const data = await fetchStatusReport(deployment);
  body.innerHTML = renderStatusCards(data.teams || [], data.matrix || []);
  const ts = contentEl.querySelector("#status-refreshed");
  if (ts) ts.textContent = "refreshed " + new Date().toLocaleTimeString();
  const checkbox = contentEl.querySelector("#status-auto-refresh");
  if (checkbox && checkbox.checked) {
    if (statusRefreshTimer) clearTimeout(statusRefreshTimer);
    statusRefreshTimer = setTimeout(refreshStatus, 30000);
  }
}

function stopStatusRefresh() {
  if (statusRefreshTimer) { clearTimeout(statusRefreshTimer); statusRefreshTimer = null; }
}

function wireStatusAutoRefresh() {
  const checkbox = contentEl.querySelector("#status-auto-refresh");
  if (!checkbox) return;
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      refreshStatus();
    } else {
      stopStatusRefresh();
    }
  });
  refreshStatus();
}

// ---- Auto-refresh (60s) — refresh metrics, changelog, and preview in-place ----

let refreshInterval = null;

function startAutoRefresh() {
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(async () => {
    if (deployments.length === 0) return;
    const deployment = deployments.find(d => d.group === activeTab);
    if (!deployment) return;
    const layout = layoutCache[deployment.group ?? "__default__"];
    if (!layout) {
      // No usable layout cached — either the first render is still in flight,
      // or the last one came back empty (no stack found) and we declined to
      // cache it. Re-render fully rather than patching charts that do not
      // exist, so a view that went blank recovers on its own once the
      // deployment record lands, instead of staying blank for the session.
      await renderActiveTab();
      return;
    }

    const metrics = await fetchMetrics(deployment);
    const panels = layout.panels || [];
    const metricData = metrics.panels || {};
    panels.forEach((panel, i) => {
      const canvas = contentEl.querySelector(`#chart-${i}`);
      if (!canvas) return;
      const existing = Chart.getChart(canvas);
      if (existing) existing.destroy();
      const panelMetrics = [];
      for (const key of (panel.metrics || [])) {
        const series = metricData[key];
        if (series) panelMetrics.push(...series);
      }
      renderChart(canvas, panelMetrics);
    });

    const changelog = await fetchChangelog(deployment);
    if (changelog) {
      const changelogEl = contentEl.querySelector(".forge-changelog-body");
      if (changelogEl) changelogEl.innerHTML = safeMarkdown(changelog);
    }
    const clTs = contentEl.querySelector("#changelog-refreshed");
    if (clTs) clTs.textContent = "refreshed " + new Date().toLocaleTimeString();

    const newUrl = await fetchDeployedUrl(deployment);
    const iframe = contentEl.querySelector("#forge-preview-iframe");
    if (iframe && newUrl && iframe.src !== newUrl) {
      iframe.src = newUrl;
    }
    const pvTs = contentEl.querySelector("#preview-refreshed");
    if (pvTs) pvTs.textContent = "refreshed " + new Date().toLocaleTimeString();

    ctx.topbar.setIndicator("success");
  }, 60000);
}

function stopAutoRefresh() {
  if (refreshInterval) { clearInterval(refreshInterval); refreshInterval = null; }
}

// ---- Topbar context ----

function buildContextControls() {
  contextEl = document.createElement("div");
  contextEl.style.cssText = "display:flex;align-items:center;gap:8px";
  contextEl.innerHTML = `<button type="button" class="sh-topbtn" data-forge-clear-cache title="Clear layout cache (forces Bedrock regeneration)">Clear Cache</button>`;
  contextEl.querySelector("[data-forge-clear-cache]").addEventListener("click", async () => {
    layoutCache = {};
    const d = deployments.find(d => d.group === activeTab);
    if (d) await fetch("forge/cache-clear", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ group: d.group }) });
    await renderActiveTab();
  });
}

/* ---------- Section module interface ---------------------------------------- */

export default {
  id: "continuous",
  title: "Continuous Deployments",

  async mount(container, shellCtx) {
    ctx = shellCtx;
    container.innerHTML = `
      <div class="forge-root">
        <div class="forge-tabs" id="forge-tabs"></div>
        <main class="forge-content" id="forge-content">
          <div class="forge-loading">
            <div class="spinner"></div>
            <div>Discovering deployments...</div>
          </div>
        </main>
      </div>
    `;
    tabsEl = container.querySelector("#forge-tabs");
    contentEl = container.querySelector("#forge-content");
    buildContextControls();
  },

  show() {
    ctx.topbar.setContext(contextEl);
    if (!_discovered) {
      discoverDeployments();
    } else {
      ctx.topbar.setIndicator("success");
      // Data refreshes on re-open rather than in the background.
      const checkbox = contentEl.querySelector("#status-auto-refresh");
      if (checkbox && checkbox.checked) refreshStatus();
    }
    startAutoRefresh();
  },

  hide() {
    stopAutoRefresh();
    stopStatusRefresh();
  },
};
