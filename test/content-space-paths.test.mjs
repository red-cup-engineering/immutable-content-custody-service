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


test("a receiver uses the source-owned canonical tree inspector without publishing unreceived parent bytes", async t => {
  const { space } = fixture(t);
  const leaf = Buffer.from("tile north=blue", "utf8");
  const ni = makeNiUri(leaf);
  const raw = Buffer.from(JSON.stringify({
    kind: "semiotic-content.content-tree", version: 1,
    entries: [{ name: "wang", ni }],
  }) + "\n");
  const original = space.inspectTreeBytes(raw);
  assert.equal(original.kind, "semiotic-content.content-tree");
  assert.deepEqual(original.entries, [{ name: "wang", ni }]);
  assert.equal(Object.isFrozen(original.entries), true);
  assert.equal(await space.get(makeNiUri(raw)), null,
    "a raw advertised tree cannot become a retained root just by being inspected");
  assert.equal(await space.get(ni), null);

  for (const candidate of [
    Buffer.from(raw.toString("utf8").trim()),
    Buffer.from(raw.toString("utf8") + "\n"),
    Buffer.from(JSON.stringify({ ...JSON.parse(raw), extra: "unadmitted" }) + "\n"),
    Buffer.from("{bad json}\n"),
    Buffer.from(JSON.stringify({ kind: "semiotic-content.content-tree", version: 1,
      entries: [{ name: "../parent", ni }] }) + "\n"),
  ]) {
    assert.throws(() => space.inspectTreeBytes(candidate), /content tree/);
  }
  assert.equal(await space.get(makeNiUri(raw)), null,
    "malformed remote metadata cannot create a Merkle tree");
  await space.retain(leaf);
  const composed = await space.retainTree(original.entries);
  assert.equal(composed.ni, makeNiUri(raw),
    "canonical source-owned materialization produces exactly the announced Merkle NI");
});


test("one source-owned immutable walk serves raw-content and admitted agent readers", async t => {
  const { space } = fixture(t);
  const created = await space.putPath({
    name: "science/l-space", expected: null, path: ["tilings", "wang"],
    bytes: Buffer.from("north=blue;east=red"), mediaType: "text/plain",
  });
  const traced = await space.tracePath(created.rootNi, ["tilings", "wang"]);
  assert.deepEqual(traced.path, ["tilings", "wang"]);
  assert.deepEqual(traced.steps.map(step => step.via), ["tilings", "wang"]);
  assert.equal(traced.steps[0].from, created.rootNi);
  assert.equal(traced.steps[1].to, created.ni);
  assert.equal(traced.ni, created.ni);
  assert.deepEqual((await space.tracePath(created.rootNi, [])).steps, []);
  assert.equal(await space.tracePath(created.rootNi, ["tilings", "missing"]), null);

  let reads = 0, grants = 0;
  await assert.rejects(space.tracePath(created.rootNi, ["tilings", "wang"], {
    readTree: async ni => { reads++; return space.readTree(ni); },
    admitChild: ni => { grants++; return ni !== created.ni; },
  }), /addressed child not admitted/);
  assert.equal(reads, 2);
  assert.equal(grants, 2);
  await assert.rejects(space.tracePath(created.rootNi, ["tilings"], {
    readTree: () => { throw new RangeError("source reader denied"); },
  }), /source reader denied/);
  for (const bad of [[".."], ["UPPER"], ["a/b"], Array(17).fill("a")])
    await assert.rejects(space.tracePath(created.rootNi, bad), /path/);
});


test("atomic Wang and ported-bead fabrication creates one coherent root consumed from a second configuration", async t => {
  const { root, space } = fixture(t);
  // Exact bytes are admitted; their different mathematical laws are NOT inferred by this store.
  const wangBytes = Buffer.from(JSON.stringify({
    kind: "wang-tile", north: "blue", east: "red", south: "blue", west: "red",
  }));
  const beadBytes = Buffer.from(JSON.stringify({
    kind: "ported-bead", bead: "a", hole: ["minus", "plus"], threadWalk: ["minus", "plus"],
  }));
  const wang = await space.retain(wangBytes, { mediaType: "application/json" });
  const bead = await space.retain(beadBytes, { mediaType: "application/json" });
  const original = await space.linkPaths({
    name: "science/l-space", expected: null,
    links: [
      { path: ["tilings", "wang"], ni: wang.ni },
      { path: ["beadwork", "ported"], ni: bead.ni },
    ],
  });
  assert.equal(original.published, true);
  assert.equal(original.links.length, 2);
  assert.equal(space.resolve("science/l-space"), original.rootNi);
  const other = createContentAddressedSpace({
    root, durableRoot: root, namespaces: ["science/l-space"],
  });
  assert.deepEqual((await other.atPath("science/l-space", ["tilings", "wang"])).bytes, wangBytes);
  assert.deepEqual((await other.atPath("science/l-space", ["beadwork", "ported"])).bytes, beadBytes);
  const inventory = await other.walkTree(original.rootNi);
  assert.equal(inventory.count, 5);
  assert.deepEqual(inventory.nodes.map(node => node.path.join("/")), [
    "", "beadwork", "beadwork/ported", "tilings", "tilings/wang",
  ]);
  assert.equal(inventory.nodes[2].ni, bead.ni);
  assert.equal(inventory.nodes[4].ni, wang.ni);
  assert.equal(inventory.nodes[0].kind, "tree");
  assert.equal(inventory.nodes[4].kind, "object");
  assert.equal(inventory.nodes[4].byteLength, wangBytes.byteLength);
  assert.equal(JSON.stringify(inventory).includes("north"), false,
    "metadata never silently publishes the retained source body");
});

test("multi-link update preserves unrelated source, repeated NI appearances, and prior immutable snapshots", async t => {
  const { root, space } = fixture(t);
  const retained = await space.retain(Buffer.from("same source, two locations"));
  const first = await space.linkPath({
    name: "engineering/source", expected: null, path: ["provenance", "original"], ni: retained.ni,
  });
  const updated = await space.linkPaths({
    name: "engineering/source", expected: first.rootNi,
    links: [
      { path: ["science", "source"], ni: retained.ni },
      { path: ["applications", "source"], ni: retained.ni },
    ],
  });
  assert.equal(updated.published, true);
  assert.notEqual(updated.rootNi, first.rootNi);
  assert.deepEqual((await space.atPath("engineering/source", ["provenance", "original"])).bytes,
    Buffer.from("same source, two locations"));
  assert.deepEqual((await space.readTree(first.rootNi)).entries.map(x => x.name), ["provenance"]);
  const another = createContentAddressedSpace({ root, durableRoot: root, namespaces: ["engineering/source"] });
  const inventory = await another.walkTree(updated.rootNi);
  assert.deepEqual(inventory.nodes.filter(x => x.kind === "object").map(x => x.ni),
    [retained.ni, retained.ni, retained.ni],
    "a repeated child has three distinct path occurrences, not three fake identities");
});

test("batch construction refuses overlaps, unreceived targets, and stale writers before publishing", async t => {
  const { space } = fixture(t);
  const existing = await space.retain(Buffer.from("held"));
  const missing = makeNiUri(Buffer.from("not retained"));
  const attempt = links => space.linkPaths({
    name: "science/l-space", expected: null, links,
  });
  for (const links of [
    [],
    [{ path: ["a"], ni: existing.ni }, { path: ["a"], ni: existing.ni }],
    [{ path: ["a"], ni: existing.ni }, { path: ["a", "b"], ni: existing.ni }],
    [{ path: ["a", "b"], ni: existing.ni }, { path: ["a"], ni: existing.ni }],
    [{ path: ["not-owned"], ni: missing }],
    [{ path: ["bad/slot"], ni: existing.ni }],
    [{ path: ["x"], ni: existing.ni, grant: true }],
  ]) await assert.rejects(() => attempt(links));
  assert.equal(space.resolve("science/l-space"), null, "no incomplete name was announced");
  const accepted = await attempt([{ path: ["ok"], ni: existing.ni }]);
  await assert.rejects(() => space.linkPaths({
    name: "science/l-space", expected: null, links: [{ path: ["late"], ni: existing.ni }],
  }), /changed before publication/);
  assert.equal(space.resolve("science/l-space"), accepted.rootNi);
  assert.equal(await space.atPath("science/l-space", ["late"]), null);
});

test("recursive NI inventory refuses unauthorised children, runaway size/depth, and missing objects", async t => {
  const { root, space } = fixture(t);
  const held = await space.retain(Buffer.from("private child"));
  const rootEntry = await space.linkPath({
    name: "science/l-space", expected: null, path: ["a", "b"], ni: held.ni,
  });
  await assert.rejects(space.walkTree(rootEntry.rootNi, {
    admitChild: ni => ni !== held.ni,
  }), /addressed child not admitted/);
  await assert.rejects(space.walkTree(rootEntry.rootNi, { maximumNodes: 2 }),
    /exceeds node budget/);
  await assert.rejects(space.walkTree(rootEntry.rootNi, { maximumDepth: 0 }),
    /exceeds depth budget/);
  await assert.rejects(space.walkTree(rootEntry.rootNi, { maximumDepth: 1 }),
    /exceeds depth budget/);
  await assert.rejects(space.walkTree(rootEntry.rootNi, { maximumNodes: 2049 }),
    /bounded walk budgets/);
  const names = [];
  const good = await space.walkTree(rootEntry.rootNi, {
    admitChild: (ni, context) => { names.push(context.path.join("/")); return true; },
  });
  assert.equal(good.count, 3);
  assert.deepEqual(names, ["a", "a/b"]);
  assert.equal(space.resolve("science/l-space"), rootEntry.rootNi);
  // An interrupted sidecar cannot be concealed by a listing.
  const broken = join(root, "objects", ...immutableContentKey(held.ni).split("/")) + ".media-type";
  unlinkSync(broken);
  await assert.rejects(space.walkTree(rootEntry.rootNi), { code: "ERR_CUSTODY_INCOMPLETE" });
});
