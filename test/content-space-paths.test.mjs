import assert from "node:assert/strict";
import { mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createContentAddressedSpace } from "../src/content-space.mjs";
import { admitContentTreePath } from "../src/content-tree.mjs";
import { immutableContentKey } from "../src/immutable-content-custody.mjs";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shared-merkle-path-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const namespaces = ["science/l-space", "engineering/source"];
  return { root, space: createContentAddressedSpace({ root, durableRoot: root, namespaces }) };
}

test("author nested Merkle snapshots once and read them from another process using the same root", async t => {
  const { root, space } = fixture(t);
  const bytes = Buffer.from("tile { north: blue, east: red }", "utf8");
  const first = await space.putPath({
    name: "science/l-space", expected: null, path: ["tilings", "wang"],
    bytes, mediaType: "text/plain",
  });
  assert.equal(first.published, true);
  assert.equal(first.retained.durable, true);
  assert.equal(space.resolve("science/l-space"), first.rootNi);
  assert.notEqual(first.rootNi, first.ni, "directory identity must not impersonate byte identity");

  const secondProcess = createContentAddressedSpace({
    root, durableRoot: root, namespaces: ["science/l-space"],
  });
  const reading = await secondProcess.atPath("science/l-space", ["tilings", "wang"]);
  assert.deepEqual(reading.bytes, bytes);
  assert.equal(reading.ni, first.ni);
  assert.equal(reading.rootNi, first.rootNi);
  assert.deepEqual(reading.path, ["tilings", "wang"]);
  assert.equal(await space.atPath("science/l-space", ["tilings", "missing"]), null);
  assert.equal(await space.atPath("engineering/source", ["tilings", "wang"]), null);

  const sibling = await secondProcess.putPath({
    name: "science/l-space", expected: first.rootNi, path: ["tilings", "beads"],
    bytes: Buffer.from([0, 1, 1, 0]),
  });
  assert.equal(sibling.published, true);
  assert.notEqual(sibling.rootNi, first.rootNi);
  assert.equal(space.resolve("science/l-space"), sibling.rootNi);
  assert.deepEqual((await space.atPath("science/l-space", ["tilings", "wang"])).bytes, bytes);
  assert.deepEqual((await space.atPath("science/l-space", ["tilings", "beads"])).bytes, Buffer.from([0, 1, 1, 0]));

  const previousRoot = await space.readTree(first.rootNi);
  assert.deepEqual(previousRoot.entries.map(e => e.name), ["tilings"]);
  const previousChild = await space.readTree(previousRoot.entries[0].ni);
  assert.deepEqual(previousChild.entries.map(e => e.name), ["wang"],
    "a later mutable binding never rewrites the former Merkle snapshot");
  assert.equal((await space.get(first.ni)).ni, makeNiUri(bytes));
});

test("link an already-retained NI without copying it, preserving independent namespaces", async t => {
  const { root, space } = fixture(t);
  const source = Buffer.from("export const cell = 1;\n");
  const retained = await space.retain(source, { mediaType: "text/javascript" });
  const linked = await space.linkPath({
    name: "engineering/source", expected: null, path: ["packages", "cell"], ni: retained.ni,
  });
  assert.equal(linked.published, true);
  assert.equal(linked.ni, retained.ni);
  assert.deepEqual((await space.atPath("engineering/source", ["packages", "cell"])).bytes, source);
  const again = createContentAddressedSpace({
    root, durableRoot: root, namespaces: ["engineering/source", "science/l-space"],
  });
  assert.equal((await again.atPath("engineering/source", ["packages", "cell"])).ni, retained.ni);
  const alias = await again.linkPath({
    name: "science/l-space", expected: null, path: ["source", "cell"], ni: retained.ni,
  });
  assert.equal((await space.atPath("science/l-space", ["source", "cell"])).ni, retained.ni);
  assert.notEqual(alias.rootNi, linked.rootNi, "distinct paths generate distinct immutable trees");
  assert.equal(space.resolve("engineering/source"), linked.rootNi);
});

test("stale writers cannot overwrite roots; malformed paths and unheld links never publish", async t => {
  const { space } = fixture(t);
  const first = await space.putPath({
    name: "science/l-space", expected: null, path: ["a"],
    bytes: Buffer.from("first"),
  });
  const next = await space.putPath({
    name: "science/l-space", expected: first.rootNi, path: ["b"],
    bytes: Buffer.from("second"),
  });
  await assert.rejects(() => space.putPath({
    name: "science/l-space", expected: first.rootNi, path: ["c"],
    bytes: Buffer.from("losing writer"),
  }), /changed before publication/);
  assert.equal(space.resolve("science/l-space"), next.rootNi);
  assert.equal(await space.atPath("science/l-space", ["c"]), null);

  for (const path of [
    "", "a/b", [], [".."], ["UPPER"], ["a/b"], ["a", "../secret"],
    Array(17).fill("a"), ["a", 99],
  ]) {
    await assert.rejects(() => space.linkPath({
      name: "science/l-space", expected: next.rootNi, path, ni: first.ni,
    }), /path/);
  }
  await assert.rejects(() => space.linkPath({
    name: "unadmitted/name", expected: null, path: ["a"], ni: first.ni,
  }), /namespace is not admitted/);
  await assert.rejects(() => space.linkPath({
    name: "science/l-space", expected: next.rootNi,
    path: ["c"], ni: makeNiUri(Buffer.from("never retained")),
  }), /unreceived/);
  await assert.rejects(() => space.linkPath({
    name: "science/l-space", expected: next.rootNi,
    path: ["a", "child"], ni: first.ni,
  }), /does not name a content tree/);
  assert.equal(space.resolve("science/l-space"), next.rootNi);
  assert.deepEqual((await space.atPath("science/l-space", ["a"])).bytes, Buffer.from("first"));
});

test("content-tree path admission uses exactly entry names, without URL or disk path parsing", () => {
  assert.deepEqual(admitContentTreePath(["foo", "bar.json", "0"]), ["foo", "bar.json", "0"]);
  for (const path of [
    [], ["."], [".."], ["a/b"], ["A"], ["a%2fb"], [""], ["a".repeat(129)],
    Array(17).fill("foo"), [undefined], "foo/bar",
  ]) assert.throws(() => admitContentTreePath(path), /content tree path/);
  assert.equal(Object.isFrozen(admitContentTreePath(["foo"])), true);
});

test("a referenced but now-incomplete physical tree refuses traversal, not silent absence", async t => {
  const { root, space } = fixture(t);
  const result = await space.putPath({
    name: "science/l-space", expected: null, path: ["formal", "claim"],
    bytes: Buffer.from("known"),
  });
  const treeKey = immutableContentKey(result.rootNi);
  unlinkSync(join(root, "objects", ...treeKey.split("/")) + ".media-type");
  await assert.rejects(() => space.atPath("science/l-space", ["formal", "claim"]),
    { code: "ERR_CUSTODY_INCOMPLETE" });
  assert.equal(space.resolve("science/l-space"), result.rootNi,
    "corrupt storage must not rewrite the referenced immutable root");
});
