import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createFileStore, createFileStoreSync } from "../src/file-store.mjs";

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "file-store-"));
  return Promise.resolve(run(root)).finally(() => rmSync(root, { recursive: true, force: true }));
}

test("the synchronous store keeps the first body under putIfAbsent", () => withRoot((root) => {
  const store = createFileStoreSync(root);
  assert.equal(store.get("a/b"), null);
  assert.deepEqual(store.putIfAbsent("a/b", { body: Buffer.from("first"), mediaType: "application/json" }), { conflict: false });
  assert.deepEqual(store.putIfAbsent("a/b", { body: Buffer.from("second") }), { conflict: true });
  const found = store.get("a/b");
  assert.equal(found.body.toString(), "first");
  assert.equal(found.mediaType, "application/json");
  assert.equal(store.head("a/b").size, 5);
  assert.equal(store.read("a/b", { start: 1, end: 2 }).toString(), "ir");
  assert.deepEqual([...store.list("a/").keys], ["a/b"]);
  assert.throws(() => store.get("../escape"), /escapes the store root/);
}));

test("the promise-shaped store answers the same objects as the synchronous one", () => withRoot(async (root) => {
  const store = createFileStore(root);
  assert.equal(store.root, createFileStoreSync(root).root);
  const put = store.putCurrent("k", { body: Buffer.from("bytes") });
  assert.ok(put instanceof Promise);
  assert.deepEqual(await put, { conflict: false });
  assert.equal((await store.get("k")).body.toString(), "bytes");
  assert.equal(createFileStoreSync(root).get("k").body.toString(), "bytes");
  assert.deepEqual(await store.putIfAbsent("k", { body: Buffer.from("other") }), { conflict: true });
}));
