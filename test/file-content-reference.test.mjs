import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFileContentReference } from "../src/file-content-reference.mjs";

const ni = (text) => "ni:///sha-256;" + createHash("sha256").update(text).digest("base64url");

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "content-reference-"));
  try { return run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("an absent reference reads as empty and publishes through a compare-and-publish chain", () => withRoot((root) => {
  const reference = createFileContentReference(join(root, "current.json"));
  assert.equal(reference.read(), null);
  assert.deepEqual(reference.publish(null, ni("one")), { published: true, cacheUpdated: true });
  assert.equal(reference.read(), ni("one"));
  assert.deepEqual(reference.publish(ni("one"), ni("two")), { published: true, cacheUpdated: true });
  assert.equal(reference.read(), ni("two"));
  assert.deepEqual(reference.publish(ni("two"), ni("two")), { published: false, cacheUpdated: true });
}));

test("a stale expectation and clearing an admitted frontier are refused", () => withRoot((root) => {
  const reference = createFileContentReference(join(root, "current.json"));
  reference.publish(null, ni("one"));
  assert.throws(() => reference.publish(null, ni("two")), /changed before publication/);
  assert.throws(() => reference.publish(ni("one"), null), /cannot be cleared/);
  assert.throws(() => reference.publish(ni("one"), "not-an-ni"));
  assert.equal(reference.read(), ni("one"));
}));

test("a stale or missing cache cannot erase a committed transition", () => withRoot((root) => {
  const path = join(root, "current.json");
  const reference = createFileContentReference(path);
  reference.publish(null, ni("one"));
  reference.publish(ni("one"), ni("two"));
  writeFileSync(path, JSON.stringify({ kind: "content-reference.frontier.v1", content: ni("one") }) + "\n");
  assert.equal(reference.read(), ni("two"));
  rmSync(path);
  assert.equal(createFileContentReference(path).read(), ni("two"));
}));

test("a malformed cache is refused", () => withRoot((root) => {
  const path = join(root, "current.json");
  writeFileSync(path, JSON.stringify({ kind: "other", content: null }));
  assert.throws(() => createFileContentReference(path).read(), /Invalid content reference frontier/);
  assert.throws(() => createFileContentReference(""), /host-owned path/);
}));
