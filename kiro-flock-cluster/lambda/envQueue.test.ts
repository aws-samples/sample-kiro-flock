/**
 * Unit tests for the scoped environment queue helpers (envQueue.ts).
 * These helpers are the only access control on the env-list / env-put /
 * env-delete routes (the Lambda role is bucket-wide), so the rejection
 * cases here are the security tests. No AWS.
 */
import {
  clampLimit,
  contentTypeFor,
  DEFAULT_LIST_LIMIT,
  MAX_DELETE_KEYS,
  MAX_LIST_LIMIT,
  MAX_PUT_BYTES,
  MAX_REL_KEY_LENGTH,
  parseDeleteBody,
  parseInline,
  parsePutBody,
  relativeKey,
  scopedKey,
} from "./envQueue";

const CID = "kf-3fa9c21d";

describe("scopedKey", () => {
  it("accepts well-formed queue keys", () => {
    expect(scopedKey(CID, "queue/in/a.json", { requireQueuePrefix: true }))
      .toEqual({ ok: true, key: `environment/${CID}/queue/in/a.json` });
    expect(scopedKey(CID, "queue/claimed/out/a.json", { requireQueuePrefix: true }))
      .toEqual({ ok: true, key: `environment/${CID}/queue/claimed/out/a.json` });
  });

  it("accepts an empty prefix only when allowEmpty is set", () => {
    expect(scopedKey(CID, "", { allowEmpty: true })).toEqual({ ok: true, key: `environment/${CID}/` });
    expect(scopedKey(CID, "").ok).toBe(false);
  });

  it("rejects traversal and malformed keys", () => {
    for (const bad of ["../x", "queue/../../x", "/queue/a", "queue//a", "queue\\a", "queue/a\u0000b", "queue/a\nb"]) {
      const r = scopedKey(CID, bad);
      expect(r.ok).toBe(false);
    }
  });

  it("rejects keys over the length limit", () => {
    const long = "queue/" + "a".repeat(MAX_REL_KEY_LENGTH);
    expect(scopedKey(CID, long).ok).toBe(false);
    const fits = "queue/" + "a".repeat(MAX_REL_KEY_LENGTH - "queue/".length);
    expect(scopedKey(CID, fits).ok).toBe(true);
  });

  it("confines put/delete to queue/", () => {
    expect(scopedKey(CID, "store/x", { requireQueuePrefix: true }).ok).toBe(false);
    expect(scopedKey(CID, "loop/agent-0/notes.md", { requireQueuePrefix: true }).ok).toBe(false);
    expect(scopedKey(CID, "queueX/a", { requireQueuePrefix: true }).ok).toBe(false);
    // Reads may go anywhere in the cluster env.
    expect(scopedKey(CID, "loop/agent-0/notes.md").ok).toBe(true);
  });

  it("re-validates the cluster id", () => {
    expect(scopedKey("../other", "queue/a").ok).toBe(false);
    expect(scopedKey("Bad", "queue/a").ok).toBe(false);
    expect(scopedKey("", "queue/a").ok).toBe(false);
  });

  it("never produces a key outside environment/<id>/", () => {
    const samples = ["queue/a", "queue/./a", "queue/a/..b", "queue/a..b/c"];
    for (const s of samples) {
      const r = scopedKey(CID, s);
      if (r.ok) expect(r.key.startsWith(`environment/${CID}/`)).toBe(true);
    }
  });
});

describe("relativeKey", () => {
  it("strips the cluster prefix", () => {
    expect(relativeKey(CID, `environment/${CID}/queue/in/a.json`)).toBe("queue/in/a.json");
  });
  it("returns null for foreign or bare prefixes", () => {
    expect(relativeKey(CID, "environment/other/queue/a")).toBeNull();
    expect(relativeKey(CID, `environment/${CID}/`)).toBeNull();
  });
});

describe("clampLimit / parseInline", () => {
  it("defaults, clamps and ignores garbage", () => {
    expect(clampLimit(undefined)).toBe(DEFAULT_LIST_LIMIT);
    expect(clampLimit("")).toBe(DEFAULT_LIST_LIMIT);
    expect(clampLimit("abc")).toBe(DEFAULT_LIST_LIMIT);
    expect(clampLimit("0")).toBe(DEFAULT_LIST_LIMIT);
    expect(clampLimit("-5")).toBe(DEFAULT_LIST_LIMIT);
    expect(clampLimit("50")).toBe(50);
    expect(clampLimit("99999")).toBe(MAX_LIST_LIMIT);
  });
  it("parses inline flags", () => {
    expect(parseInline("1")).toBe(true);
    expect(parseInline("true")).toBe(true);
    expect(parseInline("0")).toBe(false);
    expect(parseInline(undefined)).toBe(false);
  });
});

describe("parsePutBody", () => {
  it("accepts a valid body", () => {
    const r = parsePutBody(JSON.stringify({ key: "queue/in/a.json", content: "{}", ifNoneMatch: true }));
    expect(r).toEqual({ ok: true, rel: "queue/in/a.json", content: "{}", ifNoneMatch: true, bytes: 2 });
  });
  it("defaults ifNoneMatch to false", () => {
    const r = parsePutBody(JSON.stringify({ key: "queue/in/a.json", content: "x" }));
    expect(r.ok && r.ifNoneMatch).toBe(false);
  });
  it("rejects non-JSON and missing fields with 400", () => {
    expect(parsePutBody("not json")).toMatchObject({ ok: false, status: 400 });
    expect(parsePutBody("[]")).toMatchObject({ ok: false, status: 400 });
    expect(parsePutBody(JSON.stringify({ content: "x" }))).toMatchObject({ ok: false, status: 400 });
    expect(parsePutBody(JSON.stringify({ key: "queue/a" }))).toMatchObject({ ok: false, status: 400 });
    expect(parsePutBody(JSON.stringify({ key: "queue/a", content: 1 }))).toMatchObject({ ok: false, status: 400 });
    expect(parsePutBody(JSON.stringify({ key: "queue/a", content: "x", ifNoneMatch: "yes" }))).toMatchObject({ ok: false, status: 400 });
  });
  it("enforces the byte limit with 413, measured after UTF-8 encoding", () => {
    const atLimit = "a".repeat(MAX_PUT_BYTES);
    expect(parsePutBody(JSON.stringify({ key: "queue/a", content: atLimit })).ok).toBe(true);
    const over = "a".repeat(MAX_PUT_BYTES + 1);
    expect(parsePutBody(JSON.stringify({ key: "queue/a", content: over }))).toMatchObject({ ok: false, status: 413 });
    // Multi-byte characters count by bytes, not by characters.
    const multi = "é".repeat(MAX_PUT_BYTES / 2 + 1); // 2 bytes each
    expect(parsePutBody(JSON.stringify({ key: "queue/a", content: multi }))).toMatchObject({ ok: false, status: 413 });
  });
});

describe("parseDeleteBody", () => {
  it("accepts a list of strings", () => {
    expect(parseDeleteBody(JSON.stringify({ keys: ["queue/a", "queue/b"] }))).toEqual({ ok: true, rels: ["queue/a", "queue/b"] });
  });
  it("rejects bad shapes with 400", () => {
    expect(parseDeleteBody("nope")).toMatchObject({ ok: false, status: 400 });
    expect(parseDeleteBody(JSON.stringify({}))).toMatchObject({ ok: false, status: 400 });
    expect(parseDeleteBody(JSON.stringify({ keys: "queue/a" }))).toMatchObject({ ok: false, status: 400 });
    expect(parseDeleteBody(JSON.stringify({ keys: [] }))).toMatchObject({ ok: false, status: 400 });
    expect(parseDeleteBody(JSON.stringify({ keys: ["queue/a", 1] }))).toMatchObject({ ok: false, status: 400 });
  });
  it("caps the batch size", () => {
    const ok = Array.from({ length: MAX_DELETE_KEYS }, (_, i) => `queue/${i}`);
    expect(parseDeleteBody(JSON.stringify({ keys: ok })).ok).toBe(true);
    const over = [...ok, "queue/extra"];
    expect(parseDeleteBody(JSON.stringify({ keys: over }))).toMatchObject({ ok: false, status: 400 });
  });
});

describe("contentTypeFor", () => {
  it("picks JSON for .json and text otherwise", () => {
    expect(contentTypeFor("queue/in/a.json")).toBe("application/json");
    expect(contentTypeFor("queue/PROTOCOL.md")).toMatch(/^text\/plain/);
  });
});
describe("scopedKey with a deployment group", () => {
  it("nests the cluster folder under the group", () => {
    expect(scopedKey("kf-1a2b3c4d", "queue/in/a.json", { group: "my-factory" }))
      .toEqual({ ok: true, key: "environment/my-factory/kf-1a2b3c4d/queue/in/a.json" });
    expect(scopedKey("kf-1a2b3c4d", "", { allowEmpty: true, group: "my-factory" }))
      .toEqual({ ok: true, key: "environment/my-factory/kf-1a2b3c4d/" });
  });
  it("is the ungrouped prefix when the group is null", () => {
    expect(scopedKey("kf-1a2b3c4d", "queue/in/a.json", { group: null })).toEqual({ ok: true, key: "environment/kf-1a2b3c4d/queue/in/a.json" });
  });
  it("refuses a group that is not a valid id", () => {
    expect(scopedKey("kf-1a2b3c4d", "queue/in/a.json", { group: "../x" }).ok).toBe(false);
  });
  it("relativeKey strips the grouped prefix", () => {
    expect(relativeKey("kf-1a2b3c4d", "environment/my-factory/kf-1a2b3c4d/queue/out/r.json", "my-factory")).toBe("queue/out/r.json");
    expect(relativeKey("kf-1a2b3c4d", "environment/kf-1a2b3c4d/queue/out/r.json", "my-factory")).toBeNull();
  });
});
