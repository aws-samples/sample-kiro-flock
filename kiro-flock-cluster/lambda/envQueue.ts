/**
 * Pure helpers for the scoped environment queue routes
 * (GET env-list, PUT env-put, POST env-delete).
 *
 * These routes let an external operator (Kiro Factory) move queue items
 * in and out of one cluster's `environment/<clusterId>/queue/` prefix over
 * the authenticated REST API, without AWS credentials. The Lambda role has
 * bucket-wide read/write, so the *only* thing standing between a caller and
 * the rest of the bucket is the key validation in this file. Keep it strict
 * and keep it tested.
 *
 * No AWS imports here on purpose: everything is unit-testable with jest and
 * nothing else.
 */

/** Same shape the handler enforces for cluster ids. Re-validated here so
 *  `scopedKey` is safe even if a caller bypasses the route-level check. */
export const CLUSTER_ID_REGEX = /^[a-z0-9][a-z0-9_-]{0,30}[a-z0-9]$/;

/** Writes and deletes are confined to this sub-prefix of the cluster env. */
export const QUEUE_PREFIX = "queue/";

/** Longest relative key accepted. S3 allows 1024 bytes; we leave headroom
 *  for the `environment/<id>/` prefix and reject anything silly. */
export const MAX_REL_KEY_LENGTH = 512;

/** Hard cap on a single put body, in bytes, after UTF-8 encoding. */
export const MAX_PUT_BYTES = 262_144;

/** Keys per env-delete call. DeleteObjects allows 1000; we keep it small. */
export const MAX_DELETE_KEYS = 100;

/** Default and maximum page size for env-list. */
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;

/** Objects at or below this size get their body inlined in env-list when
 *  `inline=1`. */
export const INLINE_MAX_BYTES = 16_384;

/** Total inlined bytes allowed in a single env-list response. */
export const INLINE_TOTAL_BYTES = 2_097_152;

export type ScopedKeyResult =
  | { ok: true; key: string }
  | { ok: false; error: string };

export interface ScopedKeyOptions {
  /** When true, `rel` must start with `queue/`. Used by put and delete. */
  requireQueuePrefix?: boolean;
  /** When true, an empty `rel` is allowed (lists the whole cluster env). */
  allowEmpty?: boolean;
  /** The cluster's deployment group (`everforgeGroup`), which nests its folder. */
  group?: string | null;
}

/**
 * Build the absolute S3 key `environment/<clusterId>/<rel>` after
 * validating both parts. Returns an error string instead of throwing so
 * the handler can map it straight to a 403.
 *
 * Rejected `rel` values: empty (unless allowEmpty), leading `/`, any `..`
 * path segment, `//`, backslash, NUL or other control characters, and
 * anything over MAX_REL_KEY_LENGTH. With requireQueuePrefix, `rel` must
 * also start with `queue/`.
 */
/** Where a cluster's files live: `environment/<clusterId>/`, or
 *  `environment/<group>/<clusterId>/` when the cluster has a deployment group.
 *  Mirrors s3Store.envPrefix; kept here so the queue routes and their tests
 *  share one definition with the key checks. */
export function clusterEnvPrefix(clusterId: string, group?: string | null): string {
  return group ? `environment/${group}/${clusterId}/` : `environment/${clusterId}/`;
}
export function scopedKey(clusterId: string, rel: string, opts: ScopedKeyOptions = {}): ScopedKeyResult {
  if (typeof clusterId !== "string" || !CLUSTER_ID_REGEX.test(clusterId)) {
    return { ok: false, error: "invalid cluster id" };
  }
  if (opts.group !== undefined && opts.group !== null && !CLUSTER_ID_REGEX.test(opts.group)) {
    return { ok: false, error: "invalid deployment group" };
  }
  const base = clusterEnvPrefix(clusterId, opts.group);
  if (typeof rel !== "string") return { ok: false, error: "key must be a string" };
  if (rel.length === 0) {
    if (opts.allowEmpty) return { ok: true, key: base };
    return { ok: false, error: "key must not be empty" };
  }
  if (rel.length > MAX_REL_KEY_LENGTH) return { ok: false, error: `key longer than ${MAX_REL_KEY_LENGTH} characters` };
  if (rel.startsWith("/")) return { ok: false, error: "key must be relative" };
  if (rel.includes("\\")) return { ok: false, error: "key must not contain backslashes" };
  if (rel.includes("//")) return { ok: false, error: "key must not contain empty segments" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rel)) return { ok: false, error: "key must not contain control characters" };
  if (rel.split("/").some((seg) => seg === "..")) return { ok: false, error: "key must not contain .. segments" };
  if (opts.requireQueuePrefix && !rel.startsWith(QUEUE_PREFIX)) {
    return { ok: false, error: `key must start with ${QUEUE_PREFIX}` };
  }
  return { ok: true, key: `${base}${rel}` };
}

/** Strip `environment/<clusterId>/` from an absolute key. Returns null if the
 *  key is not under that prefix (defensive; S3 should never hand us one). */
export function relativeKey(clusterId: string, absoluteKey: string, group?: string | null): string | null {
  const prefix = clusterEnvPrefix(clusterId, group);
  if (!absoluteKey.startsWith(prefix)) return null;
  const rel = absoluteKey.slice(prefix.length);
  return rel.length > 0 ? rel : null;
}

/** Parse the `limit` query parameter: default DEFAULT_LIST_LIMIT, clamp to
 *  1..MAX_LIST_LIMIT, ignore garbage. */
export function clampLimit(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIST_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_LIST_LIMIT;
  return Math.min(n, MAX_LIST_LIMIT);
}

/** `inline=1` or `inline=true` turns on body inlining for small objects. */
export function parseInline(raw: string | undefined | null): boolean {
  return raw === "1" || raw === "true";
}

export type PutBodyResult =
  | { ok: true; rel: string; content: string; ifNoneMatch: boolean; bytes: number }
  | { ok: false; status: 400 | 413; error: string };

/** Validate the JSON body of PUT env-put. Does not validate the key
 *  itself; call `scopedKey` on `rel` afterwards. */
export function parsePutBody(raw: string | null | undefined): PutBodyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return { ok: false, status: 400, error: "body must be JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, status: 400, error: "body must be an object" };
  const { key, content, ifNoneMatch } = parsed as Record<string, unknown>;
  if (typeof key !== "string") return { ok: false, status: 400, error: "key must be a string" };
  if (typeof content !== "string") return { ok: false, status: 400, error: "content must be a string" };
  if (ifNoneMatch !== undefined && typeof ifNoneMatch !== "boolean") {
    return { ok: false, status: 400, error: "ifNoneMatch must be a boolean" };
  }
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_PUT_BYTES) {
    return { ok: false, status: 413, error: `content is ${bytes} bytes; limit is ${MAX_PUT_BYTES}` };
  }
  return { ok: true, rel: key, content, ifNoneMatch: ifNoneMatch === true, bytes };
}

export type DeleteBodyResult =
  | { ok: true; rels: string[] }
  | { ok: false; status: 400; error: string };

/** Validate the JSON body of POST env-delete. Does not validate the keys
 *  themselves; call `scopedKey` on each afterwards. */
export function parseDeleteBody(raw: string | null | undefined): DeleteBodyResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "");
  } catch {
    return { ok: false, status: 400, error: "body must be JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, status: 400, error: "body must be an object" };
  const { keys } = parsed as Record<string, unknown>;
  if (!Array.isArray(keys)) return { ok: false, status: 400, error: "keys must be an array" };
  if (keys.length === 0) return { ok: false, status: 400, error: "keys must not be empty" };
  if (keys.length > MAX_DELETE_KEYS) return { ok: false, status: 400, error: `at most ${MAX_DELETE_KEYS} keys per call` };
  if (!keys.every((k) => typeof k === "string")) return { ok: false, status: 400, error: "keys must be strings" };
  return { ok: true, rels: keys as string[] };
}

/** Content type for a put, by extension. */
export function contentTypeFor(rel: string): string {
  return rel.endsWith(".json") ? "application/json" : "text/plain; charset=utf-8";
}
