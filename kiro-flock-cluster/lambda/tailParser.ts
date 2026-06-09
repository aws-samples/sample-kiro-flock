/**
 * Parse the tail of an NDJSON file fetched via S3 `Range: bytes=-N`.
 *
 * When a Range request is used, the returned buffer may begin mid-line
 * (the Range started inside a record). This helper strips any leading
 * partial line, splits on newlines, parses each complete JSON record,
 * and returns the last and previous entries along with the last
 * timestamp if one is present.
 *
 * Handles partial leading lines, empty files, single-line files, and
 * records with trailing whitespace. Malformed JSON lines are skipped.
 */

export interface AgentLogEntry {
  ts: string;
  iteration: number;
  action: string;
  result: string;
  next_intent: string;
}

export interface TailParseResult {
  lastEntry: AgentLogEntry | null;
  prevEntry: AgentLogEntry | null;
  lastUpdatedTs: string | null;
}

/**
 * Parse an NDJSON tail. If `isPartial` is true, the leading partial line
 * is dropped because a ranged read may have started mid-record.
 */
export function parseTail(text: string, isPartial: boolean = true): TailParseResult {
  if (!text) {
    return { lastEntry: null, prevEntry: null, lastUpdatedTs: null };
  }

  const lines = text.split("\n");

  // Drop the leading partial line only when the buffer was produced by a
  // ranged read AND there is more than one line. A file smaller than the
  // range is returned whole and the first line is complete.
  if (isPartial && lines.length > 1) {
    lines.shift();
  }

  const entries: AgentLogEntry[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as AgentLogEntry);
    } catch {
      // Malformed line — skip. In practice only the last (still being written)
      // line is at risk, and the range is sized so we get plenty of complete
      // lines before it.
    }
  }

  const lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  const prevEntry = entries.length > 1 ? entries[entries.length - 2] : null;
  return {
    lastEntry,
    prevEntry,
    lastUpdatedTs: lastEntry?.ts ?? null,
  };
}
