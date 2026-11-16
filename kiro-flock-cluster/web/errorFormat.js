/* ============================================================================
   Shared error formatting — turns an `iteration-interrupted` result blob
   into a classified, readable headline.

   The agent loop writes interrupted entries as:

     turn interrupted: <JSON-RPC error line>
     \n\nkiro-cli log:\n<ranked kiro-cli log lines>

   plus two fixed no-broadcast literals ("turn completed and was metered…",
   "turn ended without a broadcast…"). The useful signal is tiny — category,
   status code, service message, request id — and the rest is SDK debug
   noise. This module extracts the signal; the raw blob stays available so
   callers can offer a "more" unfold.

   Parsing is deliberately client-side so that HISTORICAL entries (whole
   runs of them exist in archived journals) render nicely too, not just
   entries written after the agent bundle learned to summarise.

   Imported by sections/single-cluster.js (agent panels) and
   sections/kiro-node.js (transcript turn-error block). Plain ES module,
   no bundler — same convention as costFormat.js.
   ============================================================================ */

/** Journal actions written by the loop's failure path (current + legacy name). */
export function isInterruptedAction(action) {
  return action === "iteration-interrupted" || action === "iteration-failed";
}

const LOG_SPLIT = "\n\nkiro-cli log:\n";

/** Categories, most specific first. `no-broadcast` is matched separately on
 *  the loop's fixed literals because those describe the machinery, not a
 *  service failure. "failed to generate a response" must NOT be keyed on
 *  -32603 — that generic JSON-RPC code wraps throttles too. */
const CATEGORIES = [
  { id: "throttled", label: "throttled", re: /throttl|too many requests|rate ?limit|quota|USER_REQUEST_RATE_EXCEEDED|\b429\b|overloaded/i },
  { id: "context", label: "context overflow", re: /context (window|length)|token limit|input is too long|too many (input )?tokens|maximum context/i },
  { id: "empty", label: "empty response", re: /failed to generate a response|empty response/i },
  { id: "transport", label: "transport", re: /timed? ?out|connection|transport|stream closed|ECONN|EPIPE|dns|socket/i },
];

const NO_BROADCAST_RE = /^turn (completed and was metered|ended without a broadcast)/i;

/** First `message: Some("…")` in an SDK debug dump — the service's own
 *  human-readable error message, the single best line in the whole blob. */
const SERVICE_MSG_RE = /message:\s*Some\("((?:[^"\\]|\\.)*)"\)/;
const STATUS_CODE_RE = /status_code:\s*Some\((\d{3})\)/;
const REQUEST_ID_RE = /request_id:?\s*"?([0-9a-f]{8})[0-9a-f-]{28}/i;

/**
 * Parse an interrupted-iteration `result` blob.
 *
 * Returns null when the text is empty; otherwise:
 *   { category, label, headline, requestId, detail }
 * where `headline` is the one-line cause, and `detail` is the full raw
 * text for the "more" unfold (null when the headline already IS the
 * full text, i.e. there is nothing further to show).
 */
export function parseInterruptedResult(text) {
  if (!text || typeof text !== "string") return null;
  const raw = text;

  const splitIdx = raw.indexOf(LOG_SPLIT);
  const head = (splitIdx >= 0 ? raw.slice(0, splitIdx) : raw).trim();
  const logTail = splitIdx >= 0 ? raw.slice(splitIdx + LOG_SPLIT.length) : "";

  // The loop's fixed no-broadcast literals are already concise.
  if (NO_BROADCAST_RE.test(head)) {
    return {
      category: "no-broadcast",
      label: "no broadcast",
      headline: head,
      requestId: null,
      detail: logTail ? raw : null,
    };
  }

  // Headline candidates, best first: the service's own message out of the
  // log dump, then the JSON-RPC `data=` payload, then the bare head line.
  let headline = head.replace(/^turn interrupted:\s*/i, "");
  const dataIdx = headline.indexOf("data=");
  if (dataIdx >= 0) {
    headline = headline
      .slice(dataIdx + 5)
      .replace(/^Encountered an error in the response stream:\s*/i, "");
  }
  const svcMsg = SERVICE_MSG_RE.exec(logTail);
  if (svcMsg && svcMsg[1]) {
    headline = svcMsg[1].replace(/\\"/g, '"');
  }
  // The full request id is in the detail; eight chars identify it in a
  // conversation without swallowing the line.
  const reqId = REQUEST_ID_RE.exec(raw);
  headline = headline.replace(/\s*\(request_id:?\s*[0-9a-f-]+\)\s*/i, " ").trim();

  const status = STATUS_CODE_RE.exec(logTail);
  let category = "unknown";
  let label = "interrupted";
  for (const c of CATEGORIES) {
    if (c.re.test(raw)) {
      category = c.id;
      label = c.label;
      break;
    }
  }
  if (status && status[1]) label += ` ${status[1]}`;

  return {
    category,
    label,
    headline: headline || head,
    requestId: reqId ? reqId[1] : null,
    // Anything beyond the headline is worth an unfold; a headline that is
    // the whole story gets no "more" link.
    detail: raw.trim() !== headline ? raw : null,
  };
}

/* ---------- Shared inline renderer ----------------------------------------

   Both call sites render the same inner structure: a category badge, the
   headline, an optional short request id, and a "more" link that unfolds
   the raw blob. Callers own the surrounding layout and the click wiring
   (delegated on [data-ef-toggle]); `expanded` re-applies unfold state
   across re-renders. */

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/**
 * Render just the one-line summary: badge + headline + short request id.
 * Used where the raw blob should never appear (the Single Cluster agent
 * panels — the res row is a glance surface; the Kiro Node transcript is
 * where an operator digs into the full error).
 */
export function renderErrorSummary(parsed) {
  const reqId = parsed.requestId
    ? `<span class="ef-reqid" title="request id (first 8 chars)">req ${escHtml(parsed.requestId)}</span>`
    : "";
  return `<span class="ef-badge ef-badge--${escHtml(parsed.category)}">${escHtml(parsed.label)}</span>`
    + `<span class="ef-headline">${escHtml(parsed.headline)}</span>`
    + reqId;
}

/**
 * Render a parsed error as an HTML fragment string, including the "more"
 * unfold of the raw blob.
 * `key` uniquely identifies this error instance for toggle-state carry-over
 * (e.g. "kn|session-id"); `expanded` unfolds the detail immediately.
 */
export function renderErrorInline(parsed, key, expanded) {
  const more = parsed.detail
    ? `<a class="ef-more" data-ef-toggle="${escHtml(key)}" role="button" tabindex="0">${expanded ? "less" : "more…"}</a>`
    : "";
  const detail = parsed.detail
    ? `<pre class="ef-detail" data-ef-detail="${escHtml(key)}"${expanded ? "" : " hidden"}>${escHtml(parsed.detail)}</pre>`
    : "";
  return renderErrorSummary(parsed) + more + detail;
}
