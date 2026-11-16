/**
 * Path containment for coder_attach / coder_pull.
 *
 * Every agent on a flock can write any key under `environment/`, and these tools
 * turn keys into files on the operator's machine. A key must never land outside
 * the folder the operator attached.
 *
 *   node --test dist/coderSync.test.js   (after `npm run build`)
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { isSafeRelPath, localPathFor } from "./coderSync.js";

test("isSafeRelPath accepts plain relative paths", () => {
  for (const ok of ["a", "a/b.txt", "src/deep/er/file.md", "with space.txt", "a.b/c"]) {
    assert.equal(isSafeRelPath(ok), true, ok);
  }
});

test("isSafeRelPath refuses traversal, absolute and malformed paths", () => {
  for (const bad of [
    "", "..", "../x", "a/../../x", "a/..", "./a", "a/./b", "/etc/passwd", "//x",
    "a//b", "a/", "a\\..\\b", "a\0b", "..%2F..%2Fx".replace(/%2F/g, "/"),
  ]) {
    assert.equal(isSafeRelPath(bad), false, JSON.stringify(bad));
  }
});

test("localPathFor resolves under the root or refuses", () => {
  const root = "/work/group";
  assert.equal(localPathFor(root, "real/a.txt"), resolve(root, "real/a.txt"));
  assert.equal(localPathFor(root, "../a.txt"), null);
  assert.equal(localPathFor(root, "/a.txt"), null);
  assert.equal(localPathFor(root, "real/../../a.txt"), null);
  // A relative root is resolved before the test, so the answer is still absolute.
  assert.ok(localPathFor("rel", "a")!.startsWith(resolve("rel")));
});
test("localPathFor refuses a path whose parent is a symlink out of the root", () => {
  const base = mkdtempSync(join(tmpdir(), "coder-sync-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  symlinkSync(outside, join(root, "link"));
  mkdirSync(join(root, "real"));
  try {
    assert.equal(localPathFor(root, "link/a.txt"), null);
    assert.equal(localPathFor(root, "link/deeper/a.txt"), null);
    assert.equal(localPathFor(root, "real/a.txt"), resolve(root, "real/a.txt"));
    // Folders that do not exist yet cannot be links; the nearest existing ancestor decides.
    assert.equal(localPathFor(root, "new/dir/a.txt"), resolve(root, "new/dir/a.txt"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
