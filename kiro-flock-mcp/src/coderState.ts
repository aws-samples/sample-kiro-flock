/**
 * Local state tracking for the coder sync.
 * Persisted as .coder-state.json in the local checkout root.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface FileState {
  /** S3 LastModified ISO string at last sync */
  lastModified: string;
  /** S3 ETag at last sync */
  etag: string;
  /** SHA-256 of local file content at last sync */
  localHash: string;
}

export interface CoderState {
  bucket: string;
  prefix: string;
  region: string;
  clusterId: string;
  group: string;
  attachedAt: string;
  localRoot: string;
  files: Record<string, FileState>;
}

const STATE_FILE = ".coder-state.json";

export function stateFilePath(localRoot: string): string {
  return join(localRoot, STATE_FILE);
}

export async function loadState(localRoot: string): Promise<CoderState | null> {
  try {
    const raw = await readFile(stateFilePath(localRoot), "utf-8");
    return JSON.parse(raw) as CoderState;
  } catch {
    return null;
  }
}

export async function saveState(state: CoderState): Promise<void> {
  await writeFile(
    stateFilePath(state.localRoot),
    JSON.stringify(state, null, 2),
    "utf-8"
  );
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function hashFile(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath);
    return hashContent(content);
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
