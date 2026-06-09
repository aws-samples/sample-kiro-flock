/* =========================================================================
   Shared environment panel.

   Renders a foldable tree of environment/ files, the knowledge-base and
   archived-runs counts, a file viewer modal, and drives polling against
   GET /cluster/habitat. Used by both the single-cluster dashboard and
   WeltenBuilder so the two UIs show identical environment state.

   Consumed via `window.envPanel.mount({...})`. The caller provides the
   container element, the API base path, auth-aware fetch, plus optional
   hooks (autoOpenPath, onError). The module owns its own DOM once
   mounted: cluster.html and welten.html just drop a single div and let
   this do the rest.

   The shared CSS lives alongside at web-shared/envPanel.css — include
   once in the host page.
   ========================================================================= */

(function (global) {
  const esc = (s) => s == null ? "" : String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

  const fmtBytes = (n) => {
    if (n == null) return "";
    if (n < 1024) return n + "B";
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "K";
    return (n / (1024 * 1024)).toFixed(1) + "M";
  };

  const fmtTime = (ts) => {
    if (!ts) return "";
    const d = new Date(ts);
    return isNaN(d.getTime()) ? "" : d.toLocaleTimeString();
  };

  // Minimal markdown renderer. Uses the `marked` library if available
  // (loaded via CDN in the host page), falls back to a basic hand-rolled
  // parser for headings, bold, code blocks, and lists.
  function renderMarkdown(text) {
    if (typeof marked !== "undefined" && marked.parse) {
      return marked.parse(text);
    }
    // Fallback: basic parsing without table support.
    let html = text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) =>
      `<pre><code>${code.trim()}</code></pre>`);
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
    html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
    html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
    html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/^---+$/gm, "<hr>");
    html = html.replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>");
    html = html.replace(/^[-*] (.+)$/gm, "<li>$1</li>");
    html = html.replace(/(<li>.*<\/li>\n?)+/g, (m) => `<ul>${m}</ul>`);
    html = html.replace(/^\d+\. (.+)$/gm, "<li>$1</li>");
    html = html.split("\n").map((line) => {
      if (!line.trim()) return "";
      if (/^<(h[1-3]|ul|ol|li|pre|blockquote|hr)/.test(line)) return line;
      return `<p>${line}</p>`;
    }).join("\n");
    return html;
  }

  // Extension → highlight.js language map for source files. If a file
  // matches one of these, we syntax-highlight it instead of showing
  // plain text. Only common extensions are listed; anything else falls
  // back to plain <pre>.
  const SOURCE_EXT_MAP = {
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".jsx": "javascript",
    ".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust",
    ".java": "java", ".kt": "kotlin", ".scala": "scala",
    ".c": "c", ".h": "c", ".cpp": "cpp", ".cc": "cpp", ".hpp": "cpp",
    ".cs": "csharp", ".swift": "swift", ".m": "objectivec",
    ".sh": "bash", ".bash": "bash", ".zsh": "bash",
    ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "ini",
    ".xml": "xml", ".html": "xml", ".htm": "xml", ".svg": "xml",
    ".css": "css", ".scss": "scss", ".less": "less",
    ".sql": "sql", ".graphql": "graphql", ".gql": "graphql",
    ".dockerfile": "dockerfile", ".tf": "hcl", ".hcl": "hcl",
    ".lua": "lua", ".r": "r", ".php": "php", ".pl": "perl",
  };

  function getSourceLang(filename) {
    if (!filename) return null;
    const lower = filename.toLowerCase();
    // Handle Dockerfile, Makefile, etc. (no extension)
    if (lower === "dockerfile") return "dockerfile";
    if (lower === "makefile") return "makefile";
    const dot = lower.lastIndexOf(".");
    if (dot < 0) return null;
    return SOURCE_EXT_MAP[lower.slice(dot)] || null;
  }

  // Build a nested folder tree from a flat list of habitat files. Each
  // folder node: { type:"folder", name, path, children: Map }. Each file
  // node: { type:"file", name, path, key, size, lastModified }. Returns
  // a synthetic root whose only top-level child is the "environment"
  // folder, because every key arriving from GET /cluster/habitat sits
  // under that prefix.
  function buildTree(files) {
    const root = { type: "folder", name: "", path: "", children: new Map() };
    for (const f of files) {
      if (!f || !f.key) continue;
      const raw = f.key.replace(/^\/+/, "");
      if (!raw) continue;
      const isFolderPlaceholder = raw.endsWith("/");
      const key = raw.replace(/\/+$/, "");
      if (!key) continue;
      const parts = key.split("/");
      let node = root;
      let pathSoFar = "";
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        pathSoFar = pathSoFar ? pathSoFar + "/" + part : part;
        if (isLast && !isFolderPlaceholder) {
          if (!node.children.has(part)) {
            node.children.set(part, {
              type: "file",
              name: part,
              path: pathSoFar,
              key: f.key,
              size: f.size,
              lastModified: f.lastModified,
            });
          }
        } else {
          let child = node.children.get(part);
          if (!child || child.type !== "folder") {
            child = {
              type: "folder",
              name: part,
              path: pathSoFar + "/",
              children: new Map(),
            };
            node.children.set(part, child);
          }
          node = child;
        }
      }
    }
    return root;
  }

  function sortChildren(node) {
    const entries = Array.from(node.children.values());
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  function mount(options) {
    const {
      container,        // HTMLElement that will hold the panel
      apiBase,          // "cluster" on both apps
      pollIntervalMs = 3000,
      autoOpenPath = null, // e.g. "environment/cluster_0/" — opened on first load
      downloadScope = null, // e.g. "environment/cluster_0/" — limits download-all to this prefix; null = all
      onError = () => {},  // called with a string when a fetch fails
    } = options;

    if (!container) throw new Error("envPanel.mount: container is required");

    container.innerHTML = `
      <div class="env-panel">
        <div class="env-panel-header">
          <span class="env-panel-title">environment</span>
          <div class="env-panel-actions">
            <button class="env-btn env-btn--danger" data-env-action="clean" title="Archive this cluster's environment and store to history/">clean</button>
            <button class="env-btn" data-env-action="dl-all" style="display:none" title="Download all files as a zip">&#8595; all</button>
            <button class="env-btn" data-env-action="refresh-file" style="display:none" title="Reload the current file">&#8635;</button>
            <button class="env-btn" data-env-action="dl-file" style="display:none" title="Download this file">&#8595; download</button>
            <button class="env-btn" data-env-action="back" style="display:none" title="Back to file list">&#8592; back</button>
          </div>
        </div>
        <div class="env-panel-body" data-env-body></div>
        <div class="env-panel-viewer" data-env-viewer style="display:none"></div>
      </div>
    `;

    const bodyEl = container.querySelector("[data-env-body]");
    const viewerEl = container.querySelector("[data-env-viewer]");
    const dlAllBtn = container.querySelector('[data-env-action="dl-all"]');
    const refreshBtn = container.querySelector('[data-env-action="refresh-file"]');
    const dlFileBtn = container.querySelector('[data-env-action="dl-file"]');
    const backBtn = container.querySelector('[data-env-action="back"]');
    const cleanBtn = container.querySelector('[data-env-action="clean"]');

    // Local state.
    let files = [];
    let kbFileCount = 0;
    let archivedRuns = 0;
    let activeKey = null;
    const openFolders = new Set();
    let initialOpenApplied = false;
    let pollTimer = null;
    let cleanHandler = options.onCleanRequested || null;

    // Auth-aware fetch: the host page already wraps window.fetch to
    // attach the bearer token and to suffix cluster URLs. We just call
    // window.fetch directly.
    async function apiGet(path) {
      const res = await fetch(path);
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`${res.status} ${text}`);
      }
      const ct = res.headers.get("content-type") || "";
      return ct.includes("application/json") ? res.json() : res.text();
    }

    // ---- Fetch + poll ----------------------------------------------------

    async function loadHabitat() {
      try {
        const data = await apiGet(`${apiBase}/habitat`);
        files = data.files || [];
        kbFileCount = data.kbFileCount || 0;
        archivedRuns = data.archivedRuns || 0;
        if (!initialOpenApplied) {
          initialOpenApplied = true;
          // Always open the environment/ root so the first paint shows
          // at least the cluster folders. Additional auto-open path
          // comes from the caller.
          openFolders.add("environment/");
          if (autoOpenPath) openFolders.add(autoOpenPath);
        }
        renderList();
      } catch (err) {
        onError(`environment poll failed: ${err.message || err}`);
      }
    }

    function startPolling() {
      if (pollTimer != null) return;
      loadHabitat();
      pollTimer = setInterval(loadHabitat, pollIntervalMs);
    }

    // ---- List rendering --------------------------------------------------

    function renderList() {
      let header = "";
      if (kbFileCount > 0) {
        header += `<div class="env-note env-note--kb">knowledge-base: ${kbFileCount} file${kbFileCount > 1 ? "s" : ""} (read-only reference)</div>`;
      }
      if (archivedRuns > 0) {
        header += `<div class="env-note">Previous run archived. ${archivedRuns} run${archivedRuns > 1 ? "s" : ""} in history.</div>`;
      }

      if (files.length === 0) {
        bodyEl.innerHTML = header + '<div class="env-empty">No environment files yet.</div>';
        dlAllBtn.style.display = "none";
        return;
      }
      dlAllBtn.style.display = "";

      const root = buildTree(files);
      const envNode = root.children.get("environment");
      if (!envNode) {
        bodyEl.innerHTML = header + '<div class="env-empty">No environment files yet.</div>';
        dlAllBtn.style.display = "none";
        return;
      }

      let tree = `<ul class="env-tree">`;
      for (const child of sortChildren(envNode)) {
        tree += renderNode(child, 0, true);
      }
      tree += `</ul>`;
      bodyEl.innerHTML = header + tree;

      // Event delegation for folders, files, and inline download buttons.
      bodyEl.querySelectorAll(".env-row--folder").forEach((el) => {
        el.addEventListener("click", () => {
          const path = el.dataset.folder;
          if (!path) return;
          if (openFolders.has(path)) openFolders.delete(path);
          else openFolders.add(path);
          renderList();
        });
      });
      bodyEl.querySelectorAll(".env-row--file").forEach((el) => {
        el.addEventListener("click", () => {
          const key = el.dataset.key;
          if (key) openFile(key);
        });
      });
      bodyEl.querySelectorAll(".env-dl-inline").forEach((el) => {
        el.addEventListener("click", (e) => {
          e.stopPropagation();
          downloadFile(el.dataset.dlKey, el.dataset.dlName);
        });
      });
    }

    function renderNode(node, depth, isEnvRoot) {
      if (node.type === "file") {
        const indent = depth * 16;
        const size = fmtBytes(node.size);
        const time = fmtTime(node.lastModified);
        const meta = [size, time].filter(Boolean).join(" \u00b7 ");
        const active = activeKey === node.key ? " active" : "";
        return `<li>
          <div class="env-row env-row--file${active}" data-key="${esc(node.key)}" data-name="${esc(node.name)}" style="padding-left:${indent + 12}px">
            <span class="env-toggle">\u00b7</span>
            <span class="env-label">${esc(node.name)}</span>
            <span class="env-meta">${esc(meta)}</span>
            <button class="env-dl-inline" data-dl-key="${esc(node.key)}" data-dl-name="${esc(node.name)}">&#8595;</button>
          </div>
        </li>`;
      }
      const isOpen = openFolders.has(node.path);
      // "+" click-to-open, "-" click-to-close. Same affordance as OS
      // file managers.
      const toggle = isOpen ? "\u2212" : "+";
      const indent = depth * 16;
      const classes = ["env-row", "env-row--folder"];
      if (isEnvRoot && depth > 0) classes.push("env-row--cluster");
      let html = `<li>
        <div class="${classes.join(" ")}" data-folder="${esc(node.path)}" style="padding-left:${indent + 4}px">
          <span class="env-toggle">${toggle}</span>
          <span class="env-label">${esc(node.name)}/</span>
        </div>`;
      if (isOpen && node.children.size > 0) {
        html += `<ul>`;
        for (const child of sortChildren(node)) {
          html += renderNode(child, depth + 1, isEnvRoot);
        }
        html += `</ul>`;
      }
      html += `</li>`;
      return html;
    }

    // ---- File viewer -----------------------------------------------------

    async function openFile(key) {
      activeKey = key;
      renderList();
      bodyEl.style.display = "none";
      viewerEl.style.display = "";
      viewerEl.innerHTML = `<pre>Loading\u2026</pre>`;
      refreshBtn.style.display = "";
      dlFileBtn.style.display = "";
      backBtn.style.display = "";
      dlAllBtn.style.display = "none";
      try {
        const data = await apiGet(`${apiBase}/habitat/file?key=${encodeURIComponent(key)}`);
        const content = data.content || "";
        const isMarkdown = key.endsWith(".md") || key.endsWith(".markdown");
        const filename = key.split("/").pop();
        const sourceLang = getSourceLang(filename);
        if (isMarkdown) {
          viewerEl.innerHTML = `<div class="env-viewer-md">${renderMarkdown(content)}</div>`;
        } else if (sourceLang && typeof hljs !== "undefined") {
          try {
            const highlighted = hljs.highlight(content, { language: sourceLang, ignoreIllegals: true });
            viewerEl.innerHTML = `<pre class="env-viewer-code"><code class="hljs">${highlighted.value}</code></pre>`;
          } catch {
            // Language not registered in the hljs bundle, fall back to plain text.
            viewerEl.innerHTML = `<pre>${esc(content)}</pre>`;
          }
        } else {
          viewerEl.innerHTML = `<pre>${esc(content)}</pre>`;
        }
      } catch (err) {
        viewerEl.innerHTML = `<pre>Failed to load file: ${esc(err.message || err)}</pre>`;
      }
    }

    function closeFile() {
      activeKey = null;
      viewerEl.style.display = "none";
      viewerEl.innerHTML = "";
      bodyEl.style.display = "";
      refreshBtn.style.display = "none";
      dlFileBtn.style.display = "none";
      backBtn.style.display = "none";
      dlAllBtn.style.display = files.length > 0 ? "" : "none";
      renderList();
    }

    async function downloadFile(key, filename) {
      try {
        const data = await apiGet(`${apiBase}/habitat/file?key=${encodeURIComponent(key)}`);
        const content = data.content || "";
        const blob = new Blob([content], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        onError(`download failed: ${err.message || err}`);
      }
    }

    // ZIP all visible environment files into one download. Keeps the
    // dashboard's behaviour (minimal STORE-compressed zip with CRC-32).
    // When downloadScope is set (single-cluster view), only files under
    // that prefix are included. When null (weltenbuilder), all files.
    async function downloadAll() {
      if (!files.length) return;
      const scopedFiles = downloadScope
        ? files.filter(f => f.key.startsWith(downloadScope))
        : files;
      if (!scopedFiles.length) {
        onError("No files to download");
        return;
      }
      const entries = [];
      for (const f of scopedFiles) {
        try {
          const data = await apiGet(`${apiBase}/habitat/file?key=${encodeURIComponent(f.key)}`);
          entries.push({ name: f.key.replace("environment/", ""), content: data.content || "" });
        } catch { /* skip failed files */ }
      }
      if (!entries.length) {
        onError("No files to download");
        return;
      }
      const crcTable = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        crcTable[i] = c;
      }
      function crc32(bytes) {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
      }
      const enc = new TextEncoder();
      const parts = [];
      const centralDir = [];
      let offset = 0;
      for (const { name, content } of entries) {
        const nameBytes = enc.encode(name);
        const dataBytes = enc.encode(content);
        const checksum = crc32(dataBytes);
        const header = new Uint8Array(30 + nameBytes.length);
        const hv = new DataView(header.buffer);
        hv.setUint32(0, 0x04034b50, true);
        hv.setUint16(4, 20, true);
        hv.setUint16(6, 0, true);
        hv.setUint16(8, 0, true);
        hv.setUint16(10, 0, true);
        hv.setUint16(12, 0, true);
        hv.setUint32(14, checksum, true);
        hv.setUint32(18, dataBytes.length, true);
        hv.setUint32(22, dataBytes.length, true);
        hv.setUint16(26, nameBytes.length, true);
        hv.setUint16(28, 0, true);
        header.set(nameBytes, 30);
        parts.push(header, dataBytes);
        const cd = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        cv.setUint16(6, 20, true);
        cv.setUint16(8, 0, true);
        cv.setUint16(10, 0, true);
        cv.setUint16(12, 0, true);
        cv.setUint16(14, 0, true);
        cv.setUint32(16, checksum, true);
        cv.setUint32(20, dataBytes.length, true);
        cv.setUint32(24, dataBytes.length, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true);
        cv.setUint16(32, 0, true);
        cv.setUint16(34, 0, true);
        cv.setUint16(36, 0, true);
        cv.setUint32(38, 0, true);
        cv.setUint32(42, offset, true);
        cd.set(nameBytes, 46);
        centralDir.push(cd);
        offset += header.length + dataBytes.length;
      }
      const cdStart = offset;
      let cdSize = 0;
      for (const cd of centralDir) { parts.push(cd); cdSize += cd.length; }
      const eocd = new Uint8Array(22);
      const ev = new DataView(eocd.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(4, 0, true);
      ev.setUint16(6, 0, true);
      ev.setUint16(8, entries.length, true);
      ev.setUint16(10, entries.length, true);
      ev.setUint32(12, cdSize, true);
      ev.setUint32(16, cdStart, true);
      ev.setUint16(20, 0, true);
      parts.push(eocd);
      const blob = new Blob(parts, { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = downloadScope
        ? `environment-${downloadScope.replace("environment/", "").replace(/\/$/, "")}.zip`
        : "environment.zip";
      a.click();
      URL.revokeObjectURL(url);
    }

    // ---- Header button wiring --------------------------------------------

    refreshBtn.addEventListener("click", () => { if (activeKey) openFile(activeKey); });
    dlFileBtn.addEventListener("click", () => {
      if (!activeKey) return;
      downloadFile(activeKey, activeKey.replace("environment/", ""));
    });
    backBtn.addEventListener("click", closeFile);
    dlAllBtn.addEventListener("click", downloadAll);
    cleanBtn.addEventListener("click", () => {
      if (typeof cleanHandler === "function") cleanHandler();
    });

    // ---- Public API ------------------------------------------------------

    startPolling();

    return {
      refresh: loadHabitat,
      setCleanHandler(fn) { cleanHandler = fn; },
      setCleanVisible(visible) { cleanBtn.style.display = visible ? "" : "none"; },
    };
  }

  global.envPanel = { mount };
})(window);
