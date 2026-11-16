/**
 * S3 sync logic: pull, push, status, diff.
 *
 * Operates on an entire group's environment: environment/<group>/
 * which contains all cluster subdirs, deployed/, coder-log.md, etc.
 *
 * The local checkout lives in ./<group>/ relative to the current
 * working directory (where the MCP process was launched from).
 */
import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { fromIni } from "@aws-sdk/credential-providers";
import { readFile, writeFile, mkdir, unlink, readdir } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import { structuredPatch, type StructuredPatchHunk } from "diff";
import {
  CoderState,
  FileState,
  hashContent,
  hashFile,
  loadState,
  saveState,
} from "./coderState.js";

// ---------------------------------------------------------------------------
// S3 client
// ---------------------------------------------------------------------------

let s3: S3Client | null = null;

function getS3(region: string, profile?: string): S3Client {
  if (!s3) {
    const opts: ConstructorParameters<typeof S3Client>[0] = { region };
    if (profile) {
      opts.credentials = fromIni({ profile });
    }
    s3 = new S3Client(opts);
  }
  return s3;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface S3Object {
  key: string;
  lastModified: string;
  etag: string;
}

async function listAllObjects(
  client: S3Client,
  bucket: string,
  prefix: string
): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let token: string | undefined;

  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const obj of resp.Contents ?? []) {
      if (!obj.Key || obj.Key === prefix) continue;
      if (obj.Key.endsWith("/")) continue;
      objects.push({
        key: obj.Key,
        lastModified: obj.LastModified?.toISOString() ?? "",
        etag: obj.ETag ?? "",
      });
    }
    token = resp.NextContinuationToken;
  } while (token);

  return objects;
}

async function downloadFile(
  client: S3Client,
  bucket: string,
  key: string
): Promise<Buffer> {
  const resp = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  const bytes = await resp.Body?.transformToByteArray();
  return Buffer.from(bytes ?? []);
}

async function uploadFile(
  client: S3Client,
  bucket: string,
  key: string,
  content: Buffer | string
): Promise<void> {
  await client.send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: content })
  );
}

async function deleteRemoteFile(
  client: S3Client,
  bucket: string,
  key: string
): Promise<void> {
  await client.send(
    new DeleteObjectCommand({ Bucket: bucket, Key: key })
  );
}

/** Recursively find all files in a directory, returning paths relative to root. */
async function walkDir(dir: string, root?: string): Promise<string[]> {
  root = root ?? dir;
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      files.push(...(await walkDir(full, root)));
    } else {
      if (entry.name.startsWith(".") && dir === root) continue;
      files.push(relative(root, full));
    }
  }

  return files;
}

function relKey(prefix: string, key: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key;
}

/**
 * Is this S3 key suffix one that may become a path under the local root?
 *
 * Every agent on the flock can write anywhere under `environment/`, so the keys
 * listed from the bucket are untrusted. A key such as `../../.zshrc` would, joined
 * onto the local folder, write outside it. Only plain relative paths pass: no
 * empty, `.` or `..` segments, no leading slash, no backslash, no NUL.
 */
export function isSafeRelPath(rel: string): boolean {
  if (rel.length === 0 || rel.startsWith("/") || /[\\\0]/.test(rel)) return false;
  return rel.split("/").every((seg) => seg.length > 0 && seg !== "." && seg !== "..");
}

/**
 * The local path for a remote key suffix, or null when it must not be touched.
 *
 * Checks the segments first, then the resolved path, then the real path: a
 * safe-looking string whose parent is a symlink pointing out of the root would
 * pass `path.resolve` (which does not follow links) and still land elsewhere, so
 * the nearest existing ancestor is resolved with `realpath` and compared against
 * the root's real path too. Every read, write, mkdir and unlink of a remote-named
 * file goes through here.
 */
export function localPathFor(root: string, rel: string): string | null {
  if (!isSafeRelPath(rel)) return null;
  const base = resolve(root);
  const full = resolve(base, rel);
  if (!full.startsWith(base + sep)) return null;
  // Folders that do not exist yet are created by this tool and cannot be links,
  // so only the closest existing ancestor can redirect the write. If even the
  // root is missing, there is nothing to follow.
  const nearest = nearestExisting(dirname(full));
  if (nearest !== base && !nearest.startsWith(base + sep)) return full;
  const realBase = realpathOrSelf(base);
  const realNearest = realpathOrSelf(nearest);
  if (realNearest !== realBase && !realNearest.startsWith(realBase + sep)) return null;
  return full;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur;
    cur = parent;
  }
}

// ---------------------------------------------------------------------------
// Attach — downloads entire environment/<group>/ to ./<group>/ in cwd
// ---------------------------------------------------------------------------

export interface AttachResult {
  localPath: string;
  fileCount: number;
  files: string[];
  /** Remote keys left alone because their path would not stay under localPath. */
  skipped: string[];
}

export async function attach(
  bucket: string,
  region: string,
  profile: string | undefined,
  group: string,
  localDir: string
): Promise<AttachResult> {
  const client = getS3(region, profile);
  const prefix = `environment/${group}/`;

  await mkdir(localDir, { recursive: true });

  // List remote objects
  const objects = await listAllObjects(client, bucket, prefix);

  // Download everything
  const fileStates: Record<string, FileState> = {};
  const fileNames: string[] = [];
  const skipped: string[] = [];

  for (const obj of objects) {
    const rel = relKey(prefix, obj.key);
    const localPath = localPathFor(localDir, rel);
    if (localPath === null) {
      skipped.push(obj.key);
      continue;
    }
    await mkdir(dirname(localPath), { recursive: true });

    const content = await downloadFile(client, bucket, obj.key);
    await writeFile(localPath, content);

    fileStates[rel] = {
      lastModified: obj.lastModified,
      etag: obj.etag,
      localHash: hashContent(content),
    };
    fileNames.push(rel);
  }

  // Save state
  const state: CoderState = {
    bucket,
    prefix,
    region,
    clusterId: "",
    group,
    attachedAt: new Date().toISOString(),
    localRoot: localDir,
    files: fileStates,
  };
  await saveState(state);

  return { localPath: localDir, fileCount: fileNames.length, files: fileNames, skipped };
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface PullResult {
  downloaded: string[];
  deleted: string[];
  conflicts: string[];
  unchanged: number;
  /** Remote keys left alone because their path would not stay under the local root. */
  skipped: string[];
}

export async function pull(localRoot: string): Promise<PullResult> {
  const state = await loadState(localRoot);
  if (!state) throw new Error("Not attached. Run coder_attach first.");

  const client = getS3(state.region);
  const objects = await listAllObjects(client, state.bucket, state.prefix);

  const result: PullResult = { downloaded: [], deleted: [], conflicts: [], unchanged: 0, skipped: [] };

  const remoteFiles = new Set<string>();

  for (const obj of objects) {
    const rel = relKey(state.prefix, obj.key);
    const localPath = localPathFor(localRoot, rel);
    if (localPath === null) {
      result.skipped.push(obj.key);
      continue;
    }
    remoteFiles.add(rel);

    const recorded = state.files[rel];

    if (!recorded) {
      // New remote file, download
      await mkdir(dirname(localPath), { recursive: true });
      const content = await downloadFile(client, state.bucket, obj.key);
      await writeFile(localPath, content);
      state.files[rel] = {
        lastModified: obj.lastModified,
        etag: obj.etag,
        localHash: hashContent(content),
      };
      result.downloaded.push(rel);
      continue;
    }

    // Did remote change?
    const remoteChanged = recorded.etag !== obj.etag;
    if (!remoteChanged) {
      result.unchanged++;
      continue;
    }

    // Remote changed. Did local also change?
    const currentLocalHash = await hashFile(localPath);
    const localChanged = currentLocalHash !== null && currentLocalHash !== recorded.localHash;

    if (localChanged) {
      result.conflicts.push(rel);
      continue;
    }

    // Only remote changed, safe to download
    await mkdir(dirname(localPath), { recursive: true });
    const content = await downloadFile(client, state.bucket, obj.key);
    await writeFile(localPath, content);
    state.files[rel] = {
      lastModified: obj.lastModified,
      etag: obj.etag,
      localHash: hashContent(content),
    };
    result.downloaded.push(rel);
  }

  // Files deleted remotely
  for (const rel of Object.keys(state.files)) {
    if (!remoteFiles.has(rel)) {
      const localPath = localPathFor(localRoot, rel);
      if (localPath === null) {
        // A state file is ours, but it is still a file: do not act on a bad entry.
        delete state.files[rel];
        continue;
      }
      const currentLocalHash = await hashFile(localPath);
      const localChanged = currentLocalHash !== null && currentLocalHash !== state.files[rel].localHash;

      if (localChanged) {
        result.conflicts.push(rel + " (deleted remotely, modified locally)");
      } else {
        try {
          await unlink(localPath);
        } catch { /* already gone */ }
        delete state.files[rel];
        result.deleted.push(rel);
      }
    }
  }

  await saveState(state);
  return result;
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

export interface ConflictInfo {
  file: string;
  diff: string;
}

export interface PushResult {
  pushed: string[];
  deleted: string[];
  conflicts: ConflictInfo[];
}

export async function push(
  localRoot: string,
  message?: string
): Promise<PushResult> {
  const state = await loadState(localRoot);
  if (!state) throw new Error("Not attached. Run coder_attach first.");

  const client = getS3(state.region);
  const result: PushResult = { pushed: [], deleted: [], conflicts: [] };

  // Find local changes
  const localFiles = await walkDir(localRoot);
  const localFileSet = new Set(localFiles);

  // Get current remote state for conflict detection
  const remoteObjects = await listAllObjects(client, state.bucket, state.prefix);
  const remoteMap = new Map<string, S3Object>();
  for (const obj of remoteObjects) {
    remoteMap.set(relKey(state.prefix, obj.key), obj);
  }

  // Check each local file
  for (const rel of localFiles) {
    const localPath = join(localRoot, rel);
    const currentLocalHash = await hashFile(localPath);
    if (!currentLocalHash) continue;

    const recorded = state.files[rel];

    if (!recorded) {
      // New local file. Check if it also appeared remotely.
      const remote = remoteMap.get(rel);
      if (remote) {
        const remoteContent = await downloadFile(client, state.bucket, remote.key);
        const localContent = await readFile(localPath, "utf-8");
        const patch = structuredPatch(
          rel, rel,
          remoteContent.toString("utf-8"), localContent,
          "remote", "local"
        );
        const diffText = patch.hunks.map((h: StructuredPatchHunk) =>
          `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
          h.lines.join("\n")
        ).join("\n");
        result.conflicts.push({ file: rel, diff: diffText });
      } else {
        // Only local, safe to push
        const content = await readFile(localPath);
        const key = state.prefix + rel;
        await uploadFile(client, state.bucket, key, content);
        state.files[rel] = {
          lastModified: new Date().toISOString(),
          etag: "",
          localHash: currentLocalHash,
        };
        result.pushed.push(rel);
      }
      continue;
    }

    // Existing file: did local change?
    if (currentLocalHash === recorded.localHash) continue;

    // Local changed. Did remote also change?
    const remote = remoteMap.get(rel);
    const remoteChanged = remote && remote.etag !== recorded.etag;

    if (remoteChanged && remote) {
      const remoteContent = await downloadFile(client, state.bucket, remote.key);
      const localContent = await readFile(localPath, "utf-8");
      const patch = structuredPatch(
        rel, rel,
        remoteContent.toString("utf-8"), localContent,
        "remote", "local"
      );
      const diffText = patch.hunks.map((h: StructuredPatchHunk) =>
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@\n` +
        h.lines.join("\n")
      ).join("\n");
      result.conflicts.push({ file: rel, diff: diffText });
    } else {
      // Only local changed, push it
      const content = await readFile(localPath);
      const key = state.prefix + rel;
      await uploadFile(client, state.bucket, key, content);
      state.files[rel] = {
        lastModified: new Date().toISOString(),
        etag: "",
        localHash: currentLocalHash,
      };
      result.pushed.push(rel);
    }
  }

  // Check for local deletions
  for (const rel of Object.keys(state.files)) {
    if (!localFileSet.has(rel)) {
      const remote = remoteMap.get(rel);
      const remoteChanged = remote && remote.etag !== state.files[rel].etag;

      if (remoteChanged) {
        result.conflicts.push({
          file: rel,
          diff: "(file deleted locally but modified remotely since last sync)",
        });
      } else {
        const key = state.prefix + rel;
        await deleteRemoteFile(client, state.bucket, key);
        delete state.files[rel];
        result.deleted.push(rel);
      }
    }
  }

  // Write changelog if message provided
  if (message && (result.pushed.length > 0 || result.deleted.length > 0)) {
    await writeCoderLog(client, state, message, result.pushed, result.deleted);
  }

  // Refresh ETags for pushed files
  if (result.pushed.length > 0 || result.deleted.length > 0) {
    const freshObjects = await listAllObjects(client, state.bucket, state.prefix);
    for (const obj of freshObjects) {
      const rel = relKey(state.prefix, obj.key);
      if (state.files[rel]) {
        state.files[rel].lastModified = obj.lastModified;
        state.files[rel].etag = obj.etag;
      }
    }
  }

  await saveState(state);
  return result;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface StatusResult {
  localChanges: string[];
  remoteChanges: string[];
  conflicts: string[];
  localDeleted: string[];
  remoteDeleted: string[];
}

export async function status(localRoot: string): Promise<StatusResult> {
  const state = await loadState(localRoot);
  if (!state) throw new Error("Not attached. Run coder_attach first.");

  const client = getS3(state.region);
  const result: StatusResult = {
    localChanges: [],
    remoteChanges: [],
    conflicts: [],
    localDeleted: [],
    remoteDeleted: [],
  };

  const remoteObjects = await listAllObjects(client, state.bucket, state.prefix);
  const remoteMap = new Map<string, S3Object>();
  for (const obj of remoteObjects) {
    remoteMap.set(relKey(state.prefix, obj.key), obj);
  }

  const localFiles = await walkDir(localRoot);
  const localFileSet = new Set(localFiles);

  // Check tracked files
  for (const rel of Object.keys(state.files)) {
    const recorded = state.files[rel];
    const remote = remoteMap.get(rel);
    const localPath = join(localRoot, rel);
    const currentLocalHash = await hashFile(localPath);

    const localChanged = currentLocalHash !== null && currentLocalHash !== recorded.localHash;
    const localDeleted = currentLocalHash === null;
    const remoteChanged = remote ? remote.etag !== recorded.etag : false;
    const remoteDeleted = !remote;

    if (localDeleted && remoteDeleted) continue;
    if (localDeleted && !remoteDeleted) { result.localDeleted.push(rel); continue; }
    if (remoteDeleted && !localDeleted) { result.remoteDeleted.push(rel); continue; }

    if (localChanged && remoteChanged) result.conflicts.push(rel);
    else if (localChanged) result.localChanges.push(rel);
    else if (remoteChanged) result.remoteChanges.push(rel);
  }

  // New local files (untracked)
  for (const rel of localFiles) {
    if (!state.files[rel]) {
      result.localChanges.push(rel + " (new)");
    }
  }

  // New remote files (not yet pulled)
  for (const [rel] of remoteMap) {
    if (!state.files[rel] && !localFileSet.has(rel)) {
      result.remoteChanges.push(rel + " (new)");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Coder log
// ---------------------------------------------------------------------------

async function writeCoderLog(
  client: S3Client,
  state: CoderState,
  message: string,
  pushed: string[],
  deleted: string[]
): Promise<void> {
  const logKey = `environment/${state.group}/coder-log.md`;

  let existing = "";
  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: state.bucket, Key: logKey })
    );
    existing = (await resp.Body?.transformToString()) ?? "";
  } catch { /* file doesn't exist yet */ }

  const timestamp = new Date().toISOString();
  const fileList = [...pushed.map(f => `  + ${f}`), ...deleted.map(f => `  - ${f}`)].join("\n");
  const entry = `\n## ${timestamp}\n${message}\n\nFiles:\n${fileList}\n`;

  await uploadFile(client, state.bucket, logKey, existing + entry);
}

export async function logMessage(
  localRoot: string,
  message: string
): Promise<string> {
  const state = await loadState(localRoot);
  if (!state) throw new Error("Not attached. Run coder_attach first.");

  const client = getS3(state.region);
  const logKey = `environment/${state.group}/coder-log.md`;

  let existing = "";
  try {
    const resp = await client.send(
      new GetObjectCommand({ Bucket: state.bucket, Key: logKey })
    );
    existing = (await resp.Body?.transformToString()) ?? "";
  } catch { /* doesn't exist yet */ }

  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n${message}\n`;
  await uploadFile(client, state.bucket, logKey, existing + entry);

  return `Logged to ${logKey}`;
}
