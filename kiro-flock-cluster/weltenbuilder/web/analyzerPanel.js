/* =========================================================================
   Analyzer/Optimizer bottom panel for WeltenBuilder.

   Provides two actions:
     - Analyze: calls Bedrock to produce an organigram + progress summary
     - Optimize: calls Bedrock to propose direction updates for each cluster

   Results are persisted as tabs in S3 (store/analyzer/) and rendered in
   a tabbed view. Each tab can be closed (deleted from S3).

   This module exports a single `analyzerPanel` object that the main app.js
   mounts after DOM ready.
   ========================================================================= */

(function() {
  "use strict";

  // ---- State ---------------------------------------------------------------
  let _tabs = [];        // Array of tab objects from the API
  let _activeTabId = null;
  let _polling = null;   // interval ID for polling a processing tab
  let _panelHeight = 240; // default height in px

  // ---- DOM refs (set on mount) ---------------------------------------------
  let _container = null;
  let _tabBar = null;
  let _content = null;
  let _actionsBar = null;
  let _resizeHandle = null;

  // ---- Public API ----------------------------------------------------------

  window.analyzerPanel = {
    mount: mount,
    refresh: loadTabs,
  };

  function mount(containerEl) {
    _container = containerEl;
    if (!_container) return;

    _container.innerHTML = "";
    _container.style.height = _panelHeight + "px";

    // Resize handle (top edge)
    _resizeHandle = document.createElement("div");
    _resizeHandle.className = "wb-analyzer-resize";
    _container.appendChild(_resizeHandle);

    // Tab bar (includes tabs on left, buttons on right)
    _tabBar = document.createElement("div");
    _tabBar.className = "wb-analyzer-tabs";
    _container.appendChild(_tabBar);

    // Content area
    _content = document.createElement("div");
    _content.className = "wb-analyzer-content";
    _container.appendChild(_content);

    // Wire events
    wireResize();

    // Load existing tabs
    loadTabs();
  }

  // ---- Resize logic --------------------------------------------------------

  function wireResize() {
    if (!_resizeHandle || !_container) return;
    let resizing = false;
    let startY = 0;
    let startH = 0;

    _resizeHandle.addEventListener("mousedown", function(e) {
      resizing = true;
      startY = e.clientY;
      startH = _container.offsetHeight;
      _resizeHandle.classList.add("dragging");
      e.preventDefault();
    });

    document.addEventListener("mousemove", function(e) {
      if (!resizing) return;
      // Dragging up increases height
      const delta = startY - e.clientY;
      const newH = Math.max(100, Math.min(window.innerHeight * 0.7, startH + delta));
      _container.style.height = newH + "px";
      _panelHeight = newH;
    });

    document.addEventListener("mouseup", function() {
      if (!resizing) return;
      resizing = false;
      _resizeHandle.classList.remove("dragging");
    });
  }

  // ---- Tab management -------------------------------------------------------

  async function loadTabs() {
    try {
      const res = await fetch("cluster/analyzer-tabs");
      if (!res.ok) return;
      const data = await res.json();
      _tabs = Array.isArray(data.tabs) ? data.tabs : [];
      renderTabs();
      // If active tab is processing, start polling
      const active = _tabs.find(t => t.tabId === _activeTabId);
      if (active && active.status === "processing") {
        startPolling(active.tabId);
      }
    } catch { /* silent */ }
  }

  function renderTabs() {
    if (!_tabBar) return;
    _tabBar.innerHTML = "";

    // Top row: map-reduce input + action buttons (always visible)
    var topRow = document.createElement("div");
    topRow.className = "wb-analyzer-toolbar";

    var mrInput = document.createElement("div");
    mrInput.className = "wb-analyzer-mr-input";
    mrInput.innerHTML = '<input type="text" id="az-mr-prompt" class="wb-analyzer-mr-field" placeholder="map: direct agents \u00b7 filter: select agents \u00b7 reduce: query or summarize agent output" />'
      + '<button class="wb-analyzer-btn wb-analyzer-btn--mr" id="az-mr-send" title="Execute map/reduce operation">map/reduce \u25B6</button>';
    topRow.appendChild(mrInput);

    var actions = document.createElement("div");
    actions.className = "wb-analyzer-actions";
    actions.innerHTML = '<button class="wb-analyzer-btn wb-analyzer-btn--analyze" id="az-btn-analyze">Analyze</button>'
      + '<button class="wb-analyzer-btn wb-analyzer-btn--optimize" id="az-btn-optimize">Optimize</button>'
      + '<div class="wb-analyzer-branding"><span class="wb-analyzer-powered">powered by Amazon Bedrock</span><span class="wb-analyzer-model">Claude Sonnet 4.6</span></div>';
    topRow.appendChild(actions);

    _tabBar.appendChild(topRow);

    // Bottom row: tabs (scrollable)
    var tabRow = document.createElement("div");
    tabRow.className = "wb-analyzer-tab-row";

    for (const tab of _tabs) {
      const el = document.createElement("div");
      el.className = "wb-analyzer-tab" + (tab.tabId === _activeTabId ? " active" : "");
      el.setAttribute("data-tab-id", tab.tabId);

      const label = tab.mode === "analyze" ? "Analysis" : (tab.mode === "map/reduce" ? "Map/Reduce" : "Optimize");
      const time = formatTime(tab.createdAt);
      const statusIcon = tab.status === "processing" ? " [~]" : "";

      el.innerHTML = '<span>' + label + ' ' + time + statusIcon + '</span>'
        + '<span class="wb-analyzer-tab-close" data-close="' + tab.tabId + '">\u00D7</span>';

      el.addEventListener("click", function(e) {
        if (e.target.hasAttribute("data-close")) {
          closeTab(e.target.getAttribute("data-close"));
          return;
        }
        _activeTabId = tab.tabId;
        renderTabs();
        renderContent();
      });

      tabRow.appendChild(el);
    }

    _tabBar.appendChild(tabRow);

    // Wire button events
    var analyzeBtn = _tabBar.querySelector("#az-btn-analyze");
    var optimizeBtn = _tabBar.querySelector("#az-btn-optimize");
    if (analyzeBtn) analyzeBtn.addEventListener("click", onAnalyze);
    if (optimizeBtn) optimizeBtn.addEventListener("click", onOptimize);
    _actionsBar = actions;

    // Wire map-reduce input
    var mrField = _tabBar.querySelector("#az-mr-prompt");
    var mrSendBtn = _tabBar.querySelector("#az-mr-send");
    if (mrField) {
      mrField.addEventListener("keydown", function(e) {
        if (e.key === "Enter" && mrField.value.trim()) {
          onMapReduce(mrField.value.trim());
          mrField.value = "";
        }
      });
    }
    if (mrSendBtn) {
      mrSendBtn.addEventListener("click", function() {
        if (mrField && mrField.value.trim()) {
          onMapReduce(mrField.value.trim());
          mrField.value = "";
        }
      });
    }

    renderContent();
  }

  function renderContent() {
    if (!_content) return;

    if (!_activeTabId || _tabs.length === 0) {
      _content.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px">Click Analyze or Optimize to start.</div>';
      return;
    }

    const tab = _tabs.find(t => t.tabId === _activeTabId);
    if (!tab) {
      _content.innerHTML = '';
      return;
    }

    if (tab.status === "processing") {
      _content.innerHTML = '<div class="wb-analyzer-processing"><div class="wb-analyzer-spinner"></div><span>Processing with Bedrock...</span></div>';
      return;
    }

    if (tab.status === "error") {
      _content.innerHTML = '<div style="color:var(--red);font-size:12px;padding:8px">Error: ' + esc(tab.error || "Unknown error") + '</div>';
      return;
    }

    if (tab.mode === "analyze") {
      renderAnalyzeView(tab);
    } else if (tab.mode === "map/reduce") {
      renderMapReduceView(tab);
    } else {
      renderOptimizeView(tab);
    }
  }

  // ---- Analyze view ---------------------------------------------------------

  function renderAnalyzeView(tab) {
    const data = tab.data;
    if (!data) { _content.innerHTML = ''; return; }

    let html = '';

    // Summary row: progress bar on top, description below, diagram on right (compact)
    if (data.summary) {
      const pct = Math.max(0, Math.min(100, data.summary.progressPercent || 0));
      html += '<div class="wb-az-summary-row">';

      // Left: progress + text stacked vertically
      html += '<div class="wb-az-summary">'
        + '<div class="wb-az-progress-line"><span class="wb-az-progress-pct">' + pct + '%</span>'
        + '<div class="wb-az-progress-bar"><div class="wb-az-progress-fill" style="width:' + pct + '%"></div></div></div>'
        + '<div class="wb-az-summary-text">' + esc(data.summary.text || '') + '</div>'
        + '</div>';

      // Right: mini mermaid diagram (compact, click to expand)
      if (Array.isArray(data.organigram) && data.organigram.length > 0) {
        html += '<div class="wb-az-mini-diagram" id="az-mini-diagram" title="Click to expand">'
          + '<pre class="mermaid">' + buildMiniMermaid(data.organigram) + '</pre>'
          + '</div>';
      }

      html += '</div>';
    }

    // Organigram grid
    if (Array.isArray(data.organigram) && data.organigram.length > 0) {
      html += '<div class="wb-az-organigram">';
      for (const c of data.organigram) {
        html += renderOrganigramCard(c);
      }
      html += '</div>';
    }

    _content.innerHTML = html;

    // Render mermaid if available
    if (typeof mermaid !== "undefined" && data.organigram && data.organigram.length > 0) {
      try {
        mermaid.initialize({ startOnLoad: false, theme: 'dark', themeVariables: { primaryColor: '#9046ff', primaryTextColor: '#e0e0ea', lineColor: '#3a3a50', secondaryColor: '#1a1a24' }, flowchart: { curve: 'basis', nodeSpacing: 20, rankSpacing: 20 } });
        mermaid.run({ nodes: _content.querySelectorAll('.mermaid') });
      } catch (e) { /* mermaid not loaded or parse error, diagram stays as text */ }
    }

    // Wire click-to-popup on the mini diagram
    var miniDiagram = _content.querySelector('.wb-az-mini-diagram');
    if (miniDiagram && data.organigram) {
      miniDiagram.addEventListener('click', function() {
        showDiagramPopup(data.organigram);
      });
    }
  }

  function showDiagramPopup(organigram) {
    // Remove existing popup if any
    var existing = document.getElementById('az-diagram-popup');
    if (existing) existing.remove();

    var popup = document.createElement('div');
    popup.id = 'az-diagram-popup';
    popup.className = 'wb-az-diagram-popup visible';
    popup.innerHTML = '<div class="wb-az-diagram-popup-backdrop"></div>'
      + '<div class="wb-az-diagram-popup-content">'
      + '<button class="wb-az-diagram-popup-close">\u00D7</button>'
      + '<pre class="mermaid">' + buildMiniMermaid(organigram) + '</pre>'
      + '</div>';
    document.body.appendChild(popup);

    // Render mermaid in the popup
    if (typeof mermaid !== "undefined") {
      try {
        mermaid.run({ nodes: popup.querySelectorAll('.mermaid') });
      } catch (e) { /* ignore */ }
    }

    // Close handlers
    function closePopup() { popup.remove(); }
    popup.querySelector('.wb-az-diagram-popup-backdrop').addEventListener('click', closePopup);
    popup.querySelector('.wb-az-diagram-popup-close').addEventListener('click', closePopup);
    document.addEventListener('keydown', function onEsc(e) {
      if (e.key === 'Escape') { closePopup(); document.removeEventListener('keydown', onEsc); }
    });
  }

  function buildMiniMermaid(organigram) {
    var lines = ['graph TD'];
    var clusterIds = {};
    // Define all cluster nodes first
    for (var i = 0; i < organigram.length; i++) {
      var c = organigram[i];
      var cId = 'C' + i;
      clusterIds[c.clusterId] = cId;
      lines.push('  ' + cId + '[' + sanitizeMermaid(c.clusterName || c.clusterId) + ']');
    }
    // Draw dependency edges between clusters first (influences layout)
    var linkIndex = 0;
    var depLinks = [];
    for (var i = 0; i < organigram.length; i++) {
      var c = organigram[i];
      var cId = clusterIds[c.clusterId];
      var deps = c.dependsOn || [];
      for (var d = 0; d < deps.length; d++) {
        var targetId = clusterIds[deps[d]];
        if (targetId && targetId !== cId) {
          lines.push('  ' + targetId + ' -.->|feeds| ' + cId);
          depLinks.push(linkIndex);
          linkIndex++;
        }
      }
    }
    // Then artefacts as circles
    for (var i = 0; i < organigram.length; i++) {
      var c = organigram[i];
      var cId = clusterIds[c.clusterId];
      var arts = (c.artefacts || []).slice(0, 3);
      for (var j = 0; j < arts.length; j++) {
        var aId = cId + 'A' + j;
        lines.push('  ' + aId + '((' + sanitizeMermaid(shortName(arts[j].name)) + '))');
        lines.push('  ' + cId + ' --> ' + aId);
        linkIndex++;
      }
    }
    // Style dependency links with accent color
    if (depLinks.length > 0) {
      lines.push('  linkStyle ' + depLinks.join(',') + ' stroke:#9046ff,stroke-width:2px,stroke-dasharray:5');
    }
    return lines.join('\n');
  }

  function sanitizeMermaid(s) {
    if (!s) return '?';
    // Remove characters that break mermaid syntax
    return s.replace(/[[\](){}#&;"`]/g, '').replace(/\n/g, ' ').slice(0, 20);
  }

  function shortName(s) {
    if (!s) return '?';
    // Abbreviate to first 12 chars
    return s.length > 12 ? s.slice(0, 11).trimEnd() + '.' : s;
  }

  function renderOrganigramCard(c) {
    let html = '<div class="wb-az-cluster-card">';

    // Header
    html += '<div class="wb-az-cluster-header">'
      + '<span class="wb-az-cluster-name">' + esc(c.clusterName || c.clusterId) + '</span>'
      + '<span class="wb-az-cluster-role">' + esc(c.role || '') + '</span>'
      + '</div>';

    // Team + meta
    html += '<div class="wb-az-cluster-meta">'
      + '<span>' + esc(c.team || '') + '</span>'
      + '<span>\u00b7</span>'
      + '<span>' + esc(c.algorithm || '') + '</span>'
      + '<span>\u00b7</span>'
      + '<span>' + (c.agentCount || 0) + ' agents</span>'
      + '<span>\u00b7</span>'
      + '<span>' + esc(c.state || '') + '</span>'
      + '</div>';

    // Current focus
    if (c.currentFocus) {
      html += '<div class="wb-az-cluster-focus">' + esc(c.currentFocus) + '</div>';
    }

    // Artefacts
    if (Array.isArray(c.artefacts) && c.artefacts.length > 0) {
      html += '<div class="wb-az-artefacts">';
      for (const a of c.artefacts) {
        const status = (a.status || 'planned').toLowerCase().replace(/\s+/g, '-');
        html += '<div class="wb-az-artefact">'
          + '<span class="wb-az-artefact-dot wb-az-artefact-dot--' + esc(status) + '"></span>'
          + '<span class="wb-az-artefact-name">' + esc(a.name) + '</span>'
          + '</div>';
      }
      html += '</div>';
    }

    // Blockers
    if (Array.isArray(c.blockers) && c.blockers.length > 0) {
      html += '<div style="margin-top:4px;font-size:11px;color:var(--red)">'
        + '\u26A0 ' + c.blockers.map(esc).join(', ')
        + '</div>';
    }

    html += '</div>';
    return html;
  }

  // ---- Optimize view --------------------------------------------------------

  function renderOptimizeView(tab) {
    const data = tab.data;
    if (!data) { _content.innerHTML = ''; return; }

    let html = '';

    // Summary
    if (data.summary) {
      html += '<div class="wb-az-summary">'
        + '<div class="wb-az-summary-text">' + esc(data.summary) + '</div>'
        + '</div>';
    }

    // Proposals
    if (Array.isArray(data.proposals) && data.proposals.length > 0) {
      html += '<div class="wb-opt-proposals">';
      var hasDirectionUpdates = false;
      for (const p of data.proposals) {
        var action = p.action || p.changeType || 'leave-running';
        // Normalize old schema
        if (action === 'unchanged') action = 'leave-running';
        if (action === 'refined' || action === 'refocused' || action === 'expanded' || action === 'reduced') action = 'direction-update';

        var actionClass = 'wb-opt-action--' + action;
        var confidence = p.confidence || 'medium';
        var confidenceClass = 'wb-opt-confidence--' + confidence;

        html += '<div class="wb-opt-proposal wb-opt-proposal--' + action + '" data-cluster-id="' + esc(p.clusterId) + '">'
          + '<div class="wb-opt-proposal-header">'
          + '<span class="wb-opt-proposal-name">' + esc(p.clusterName || p.clusterId) + '</span>'
          + '<span class="wb-opt-proposal-action ' + actionClass + '">' + esc(action.replace('-', ' ')) + '</span>'
          + '<span class="wb-opt-proposal-confidence ' + confidenceClass + '">' + esc(confidence) + '</span>'
          + '</div>'
          + '<div class="wb-opt-rationale">' + esc(p.rationale || p.changeRationale || '') + '</div>';

        if (action === 'direction-update' && p.proposedDirection) {
          hasDirectionUpdates = true;
          html += '<div class="wb-opt-direction-preview">' + esc(truncate(p.proposedDirection, 300)) + '</div>';
          if (!tab.appliedAt) {
            html += '<button class="wb-opt-apply-single-btn" data-cluster-id="' + esc(p.clusterId) + '">Apply to ' + esc(p.clusterName || p.clusterId) + '</button>';
          }
        }

        html += '</div>';
      }
      html += '</div>';

      // Apply All bar (only if there are direction updates and not yet applied)
      if (hasDirectionUpdates && !tab.appliedAt) {
        html += '<div class="wb-opt-apply-bar">'
          + '<button class="wb-opt-apply-btn wb-opt-apply-btn--all" id="az-apply-btn">Apply All Direction Updates</button>'
          + '</div>';
      }
    }

    if (tab.appliedAt) {
      html += '<div class="wb-opt-apply-bar">'
        + '<span class="wb-opt-applied-badge">\u2713 Applied at ' + formatTime(tab.appliedAt) + '</span>'
        + '</div>';
    }

    _content.innerHTML = html;

    // Wire apply-all button
    const applyBtn = _content.querySelector("#az-apply-btn");
    if (applyBtn) {
      applyBtn.addEventListener("click", function() { applyOptimize(tab.tabId); });
    }

    // Wire per-cluster apply buttons
    const singleBtns = _content.querySelectorAll(".wb-opt-apply-single-btn");
    singleBtns.forEach(function(btn) {
      btn.addEventListener("click", function() {
        var clusterId = btn.getAttribute("data-cluster-id");
        applyOptimizeSingle(tab.tabId, clusterId, btn);
      });
    });
  }

  async function applyOptimizeSingle(tabId, clusterId, btn) {
    if (btn) btn.disabled = true;

    try {
      const res = await fetch("cluster/optimize-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: tabId, clusterIds: [clusterId] }),
      });
      if (!res.ok) {
        const text = await res.text().catch(function() { return ""; });
        throw new Error(res.status + " " + text);
      }
      if (typeof showInfo === "function") {
        showInfo("Direction applied to " + clusterId);
      }
      if (typeof _wbDirectionCache !== "undefined") {
        _wbDirectionCache.delete(clusterId);
      }
      if (typeof renderClusterStacks === "function") renderClusterStacks();
      if (btn) {
        btn.textContent = "\u2713 Applied";
        btn.classList.add("wb-opt-applied");
      }
    } catch (err) {
      if (typeof showError === "function") showError("Apply failed: " + (err.message || err));
      if (btn) btn.disabled = false;
    }
  }

  // ---- Actions --------------------------------------------------------------

  async function onAnalyze() {
    await triggerAction("analyze");
  }

  async function onOptimize() {
    await triggerAction("optimize");
  }

  async function triggerAction(mode) {
    const btn = _actionsBar.querySelector(mode === "analyze" ? "#az-btn-analyze" : "#az-btn-optimize");
    if (btn) btn.disabled = true;

    try {
      const res = await fetch("cluster/" + mode, { method: "POST" });
      if (!res.ok) {
        const text = await res.text().catch(function() { return ""; });
        throw new Error(res.status + " " + text);
      }
      const data = await res.json();
      _activeTabId = data.tabId;
      // Add a placeholder tab immediately
      _tabs.unshift({ tabId: data.tabId, mode: mode, status: "processing", createdAt: new Date().toISOString() });
      renderTabs();
      startPolling(data.tabId);
    } catch (err) {
      if (typeof showError === "function") showError(mode + " failed: " + (err.message || err));
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function applyOptimize(tabId) {
    const btn = _content.querySelector("#az-apply-btn");
    if (btn) btn.disabled = true;

    try {
      const res = await fetch("cluster/optimize-apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tabId: tabId }),
      });
      if (!res.ok) {
        const text = await res.text().catch(function() { return ""; });
        throw new Error(res.status + " " + text);
      }
      const data = await res.json();
      if (typeof showInfo === "function") {
        showInfo("Directions applied to " + (data.applied || []).length + " cluster(s).");
      }
      // Invalidate the direction cache so WeltenBuilder cards refresh
      // with the new directions on the next render cycle.
      if (typeof _wbDirectionCache !== "undefined") {
        (data.applied || []).forEach(function(id) { _wbDirectionCache.delete(id); });
      }
      // Trigger a re-render of the cluster cards
      if (typeof renderClusterStacks === "function") renderClusterStacks();
      // Refresh to show the applied badge
      await loadTabs();
    } catch (err) {
      if (typeof showError === "function") showError("Apply failed: " + (err.message || err));
      if (btn) btn.disabled = false;
    }
  }

  async function closeTab(tabId) {
    try {
      await fetch("cluster/analyzer-tab/" + tabId, { method: "DELETE" });
    } catch { /* ignore */ }
    _tabs = _tabs.filter(function(t) { return t.tabId !== tabId; });
    if (_activeTabId === tabId) {
      _activeTabId = _tabs.length > 0 ? _tabs[0].tabId : null;
    }
    renderTabs();
  }

  // ---- Polling for processing tabs ------------------------------------------

  function startPolling(tabId) {
    stopPolling();
    _polling = setInterval(function() { pollTab(tabId); }, 2000);
  }

  function stopPolling() {
    if (_polling) {
      clearInterval(_polling);
      _polling = null;
    }
  }

  async function pollTab(tabId) {
    try {
      const res = await fetch("cluster/analyzer-tab/" + tabId);
      if (!res.ok) return;
      const data = await res.json();
      // Update the tab in our local state
      const idx = _tabs.findIndex(function(t) { return t.tabId === tabId; });
      if (idx >= 0) _tabs[idx] = data;
      if (data.status !== "processing") {
        stopPolling();
      }
      renderTabs();
    } catch { /* silent */ }
  }

  // ---- Map-Reduce action ----------------------------------------------------

  async function onMapReduce(prompt) {
    try {
      const res = await fetch("cluster/mapreduce", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt }),
      });
      if (!res.ok) {
        const text = await res.text().catch(function() { return ""; });
        throw new Error(res.status + " " + text);
      }
      const data = await res.json();
      _activeTabId = data.tabId;
      _tabs.unshift({
        tabId: data.tabId,
        mode: "map/reduce",
        status: "processing",
        createdAt: new Date().toISOString(),
        originalPrompt: prompt,
      });
      renderTabs();
      startPolling(data.tabId);
    } catch (err) {
      if (typeof showError === "function") showError("Map/Reduce failed: " + (err.message || err));
    }
  }

  // ---- Map-Reduce view ------------------------------------------------------

  function renderMapReduceView(tab) {
    var html = '';

    // Original prompt
    if (tab.originalPrompt) {
      html += '<div class="wb-mr-prompt-echo">'
        + '<span class="wb-mr-prompt-label">Prompt:</span> '
        + esc(tab.originalPrompt)
        + '</div>';
    }

    // Operation summary
    if (tab.operation) {
      var op = tab.operation;
      html += '<div class="wb-mr-operation">'
        + '<span class="wb-mr-op-type wb-mr-op-type--' + esc(op.type) + '">' + esc(op.type) + '</span>';
      if (op.filter) {
        var filterParts = [];
        if (op.filter.clusters && op.filter.clusters.length > 0) filterParts.push('clusters: ' + op.filter.clusters.join(', '));
        if (op.filter.agentIndexes && op.filter.agentIndexes.length > 0) filterParts.push('agents: ' + op.filter.agentIndexes.join(', '));
        if (op.filter.actionRegex) filterParts.push('action: /' + op.filter.actionRegex + '/');
        if (op.filter.iterationGte != null) filterParts.push('iter \u2265 ' + op.filter.iterationGte);
        if (op.filter.iterationLte != null) filterParts.push('iter \u2264 ' + op.filter.iterationLte);
        if (op.filter.all) filterParts.push('all agents');
        if (filterParts.length > 0) {
          html += ' <span class="wb-mr-filter">' + esc(filterParts.join(' \u00b7 ')) + '</span>';
        }
      }
      html += '</div>';
    }

    // Result
    if (tab.result) {
      var r = tab.result;
      html += '<div class="wb-mr-result-meta">'
        + '<span>' + (r.agentsTargeted || 0) + ' agent' + (r.agentsTargeted === 1 ? '' : 's') + ' targeted</span>'
        + '<span class="wb-mr-sep">\u00b7</span>'
        + '<span>' + (r.clustersTargeted || []).join(', ') + '</span>'
        + '</div>';

      // Render data based on operation type
      if (tab.operation && tab.operation.type === 'map') {
        html += renderMapResult(r.data);
      } else if (tab.operation && tab.operation.type === 'map-clear') {
        html += renderMapClearResult(r.data);
      } else if (tab.operation && tab.operation.type === 'reduce') {
        html += renderReduceResult(r.data, tab.operation.mode);
      }
    }

    _content.innerHTML = html;
  }

  function renderMapResult(data) {
    if (!data) return '';
    var html = '<div class="wb-mr-map-result">'
      + '<div class="wb-mr-map-action">\u2713 Directives written</div>';
    if (data.directivePreview) {
      html += '<div class="wb-mr-directive-preview">' + esc(truncate(data.directivePreview, 200)) + '</div>';
    }
    if (Array.isArray(data.agents) && data.agents.length > 0) {
      html += '<div class="wb-mr-agent-list">';
      for (var i = 0; i < Math.min(data.agents.length, 20); i++) {
        html += '<span class="wb-mr-agent-tag">' + esc(data.agents[i]) + '</span>';
      }
      if (data.agents.length > 20) {
        html += '<span class="wb-mr-agent-tag wb-mr-agent-tag--more">+' + (data.agents.length - 20) + ' more</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderMapClearResult(data) {
    if (!data) return '';
    var html = '<div class="wb-mr-map-result">'
      + '<div class="wb-mr-map-action">\u2713 Directives cleared</div>';
    if (Array.isArray(data.agents) && data.agents.length > 0) {
      html += '<div class="wb-mr-agent-list">';
      for (var i = 0; i < Math.min(data.agents.length, 20); i++) {
        html += '<span class="wb-mr-agent-tag">' + esc(data.agents[i]) + '</span>';
      }
      if (data.agents.length > 20) {
        html += '<span class="wb-mr-agent-tag wb-mr-agent-tag--more">+' + (data.agents.length - 20) + ' more</span>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderReduceResult(data, mode) {
    if (!data) return '';
    var html = '';

    if (mode === 'summarize') {
      // Bedrock-powered summary
      if (data.summary) {
        html += '<div class="wb-mr-summary">' + esc(data.summary) + '</div>';
      }
      if (Array.isArray(data.findings) && data.findings.length > 0) {
        html += '<div class="wb-mr-findings">';
        for (var i = 0; i < data.findings.length; i++) {
          var f = data.findings[i];
          var statusCls = 'wb-mr-finding-status--' + (f.status || 'active');
          html += '<div class="wb-mr-finding">'
            + '<span class="wb-mr-finding-agent">' + esc(f.agentId) + '</span>'
            + '<span class="wb-mr-finding-status ' + statusCls + '">' + esc(f.status || '') + '</span>'
            + '<span class="wb-mr-finding-obs">' + esc(f.observation || '') + '</span>'
            + '</div>';
        }
        html += '</div>';
      }
      if (Array.isArray(data.patterns) && data.patterns.length > 0) {
        html += '<div class="wb-mr-patterns">';
        for (var i = 0; i < data.patterns.length; i++) {
          html += '<div class="wb-mr-pattern">\u2022 ' + esc(data.patterns[i]) + '</div>';
        }
        html += '</div>';
      }
      if (data.recommendation) {
        html += '<div class="wb-mr-recommendation">' + esc(data.recommendation) + '</div>';
      }
    } else {
      // Extract mode: structured data
      if (data.groups) {
        html += '<div class="wb-mr-extract-groups">';
        var keys = Object.keys(data.groups);
        for (var k = 0; k < keys.length; k++) {
          var group = data.groups[keys[k]];
          html += '<div class="wb-mr-extract-group">'
            + '<div class="wb-mr-extract-group-key">' + esc(keys[k]) + ' (' + group.length + ')</div>'
            + '<pre class="wb-mr-extract-data">' + esc(JSON.stringify(group.slice(0, 5), null, 2)) + '</pre>'
            + '</div>';
        }
        html += '</div>';
      } else if (Array.isArray(data.agents)) {
        html += '<div class="wb-mr-extract-flat">';
        for (var i = 0; i < Math.min(data.agents.length, 10); i++) {
          var a = data.agents[i];
          html += '<div class="wb-mr-extract-agent">'
            + '<span class="wb-mr-extract-agent-id">' + esc(a.agentId) + '</span>'
            + '<span class="wb-mr-extract-agent-count">' + (a.entryCount || 0) + ' entries</span>'
            + '</div>';
          if (Array.isArray(a.entries) && a.entries.length > 0) {
            html += '<pre class="wb-mr-extract-data">' + esc(JSON.stringify(a.entries, null, 2)) + '</pre>';
          }
        }
        if (data.agents.length > 10) {
          html += '<div class="wb-mr-extract-more">+' + (data.agents.length - 10) + ' more agents</div>';
        }
        html += '</div>';
      } else {
        // Fallback: raw JSON
        html += '<pre class="wb-mr-extract-data">' + esc(JSON.stringify(data, null, 2).slice(0, 2000)) + '</pre>';
      }
    }

    return html;
  }

  // ---- Helpers --------------------------------------------------------------

  function esc(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function truncate(s, n) {
    if (!s) return "";
    return s.length > n ? s.slice(0, n - 1).trimEnd() + "\u2026" : s;
  }

  function formatTime(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    var h = String(d.getHours()).padStart(2, "0");
    var m = String(d.getMinutes()).padStart(2, "0");
    return h + ":" + m;
  }

})();
