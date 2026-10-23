import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { createContentAddressedSpace } from "../src/content-space.mjs";
import {
  CARRIER_SNAPSHOT_MEDIA_TYPE, admitCarrier, admitCarrierPath, decodeCarrierSnapshot,
  directoryCarrierFiles, readCarrierSnapshot, retainCarrierSnapshot,
} from "../src/carrier-snapshot.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "carrier-space-"));
  const carrier = mkdtempSync(join(tmpdir(), "carrier-files-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(carrier, { recursive: true, force: true }); });
  return { carrier, space: createContentAddressedSpace({ root, durableRoot: root, namespaces: ["repository"] }) };
}
const write = (root, path, text) => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), text);
};
const collect = async iterator => { const all = []; for await (const item of iterator) all.push(item); return all; };

test("a directory carrier is admitted as exact bytes plus an addressed reading of its case-preserving paths", async t => {
  const { carrier, space } = fixture(t);
  write(carrier, "README.md", "# L-Space\n");
  write(carrier, "sections/Science/SKILL.md", "conduct jiancha\n");
  write(carrier, "sections/Science/copy.md", "# L-Space\n");
  write(carrier, "node_modules/dep/index.js", "never carried\n");
  write(carrier, ".git/HEAD", "ref: refs/heads/main\n");
  symlinkSync(join(carrier, "README.md"), join(carrier, "link.md"));
  const admitted = await admitCarrier(space, directoryCarrierFiles(carrier));
  assert.equal(admitted.entries, 3, "symlinks, dependency installs and VCS state are not carried content");
  assert.equal(admitted.skippedCount, 0);
  const entries = await collect(readCarrierSnapshot(space, admitted.ni));
  assert.deepEqual(entries.map(entry => entry.path), ["README.md", "sections/Science/SKILL.md", "sections/Science/copy.md"]);
  const readme = makeNiUri(Buffer.from("# L-Space\n"));
  assert.equal(entries[0].ni, readme);
  assert.equal(entries[2].ni, readme, "two paths holding the same bytes name one body");
  assert.equal(entries[0].mediaType, "text/markdown");
  assert.deepEqual((await space.get(entries[1].ni)).bytes, Buffer.from("conduct jiancha\n"));
  assert.equal((await space.head(admitted.ni)).mediaType, CARRIER_SNAPSHOT_MEDIA_TYPE);
  const bound = await space.bind({ name: "repository", expected: null, ni: admitted.ni });
  assert.equal(bound.ni, admitted.ni);
  assert.deepEqual(space.list(), [{ name: "repository", ni: admitted.ni }]);
});

test("unchanged files are not reread, and an edit changes the snapshot without losing the earlier one", async t => {
  const { carrier, space } = fixture(t);
  write(carrier, "a.md", "alpha\n");
  write(carrier, "b.md", "beta\n");
  const known = new Map();
  const first = await admitCarrier(space, directoryCarrierFiles(carrier), { known });
  const again = await admitCarrier(space, directoryCarrierFiles(carrier), { known });
  assert.equal(again.ni, first.ni, "the same observation is the same snapshot");
  assert.equal(again.reused, 2);
  write(carrier, "b.md", "beta, revised\n");
  const edited = await admitCarrier(space, directoryCarrierFiles(carrier), { known });
  assert.notEqual(edited.ni, first.ni);
  assert.equal((await collect(readCarrierSnapshot(space, first.ni)))[1].ni, makeNiUri(Buffer.from("beta\n")),
    "an earlier snapshot still reads its own bytes after the carrier moved on");
});

test("the same bytes observed under two media types keep one body and both observations", async t => {
  const { carrier, space } = fixture(t);
  write(carrier, "empty.md", "");
  write(carrier, "empty.json", "");
  const admitted = await admitCarrier(space, directoryCarrierFiles(carrier));
  const entries = await collect(readCarrierSnapshot(space, admitted.ni));
  assert.deepEqual(entries.map(entry => [entry.path, entry.mediaType]),
    [["empty.json", "application/json"], ["empty.md", "text/markdown"]]);
  assert.equal(entries[0].ni, entries[1].ni);
});

test("files beyond custody's budget are reported, not silently dropped or truncated", async t => {
  const { carrier, space } = fixture(t);
  write(carrier, "small.txt", "ok\n");
  write(carrier, "big.bin", Buffer.alloc(2048));
  const admitted = await admitCarrier(space, directoryCarrierFiles(carrier), { maximumFileBytes: 1024 });
  assert.equal(admitted.entries, 1);
  assert.deepEqual(admitted.skipped, [{ path: "big.bin", reason: "too-large" }]);
});

test("large carriers are cut into content-defined parts that an edit mostly preserves", async t => {
  const { space } = fixture(t);
  const body = await space.retain(Buffer.from("x"));
  const many = Array.from({ length: 5000 }, (_, i) => ({ path: `notes/${String(i).padStart(5, "0")}.md`, ni: body.ni, mediaType: "text/markdown", byteLength: 1 }));
  const first = await retainCarrierSnapshot(space, many);
  assert.ok(first.parts > 2, "thousands of entries do not form one unbounded object");
  const root = decodeCarrierSnapshot((await space.get(first.ni)).bytes);
  const changed = await retainCarrierSnapshot(space, [...many.slice(0, 2500), ...many.slice(2501)]);
  const after = decodeCarrierSnapshot((await space.get(changed.ni)).bytes);
  const shared = after.parts.filter(ni => root.parts.includes(ni)).length;
  assert.ok(shared >= root.parts.length - 2, "removing one path rewrites only the part around it");
  assert.equal((await collect(readCarrierSnapshot(space, changed.ni))).length, 4999);
});

test("snapshot bytes and paths are canonical and cannot traverse", () => {
  for (const bad of ["", "/abs", "a//b", "a/./b", "a/../b", "a\0b", "x".repeat(4097)])
    assert.throws(() => admitCarrierPath(bad), /relative POSIX path|nonempty/);
  const ni = makeNiUri(Buffer.from("x"));
  const canonical = Buffer.from(JSON.stringify({ kind: "semiotic-content.carrier-snapshot-part", version: 1, entries: [["a", ni, "text/plain", 1]] }) + "\n");
  assert.equal(decodeCarrierSnapshot(canonical).entries.length, 1);
  assert.throws(() => decodeCarrierSnapshot(Buffer.from(canonical.toString().replace("\n", " \n"))), /canonical/);
  assert.throws(() => decodeCarrierSnapshot(Buffer.from(JSON.stringify({ kind: "semiotic-content.carrier-snapshot-part", version: 1,
    entries: [["b", ni, "text/plain", 1], ["a", ni, "text/plain", 1]] }) + "\n")), /sorted/);
});

test("retention can run elsewhere and concurrently, and a long admission is readable at each checkpoint", async t => {
  const { carrier, space } = fixture(t);
  for (let i = 0; i < 40; i++) write(carrier, `notes/${String(i).padStart(2, "0")}.md`, `note ${i % 30}\n`);
  let inFlight = 0, most = 0, calls = 0;
  const retain = async (bytes, mediaType) => {
    calls++; inFlight++; most = Math.max(most, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    try { return await space.retain(bytes, { mediaType }); } finally { inFlight--; }
  };
  const checkpoints = [];
  const admitted = await admitCarrier(space, directoryCarrierFiles(carrier), {
    concurrency: 4, retain, checkpointEvery: 16, onCheckpoint: snapshot => { checkpoints.push(snapshot); },
  });
  assert.equal(calls, 30, "thirty distinct bodies are retained once each");
  assert.ok(most > 1 && most <= 4, "retention is concurrent within its bound");
  assert.deepEqual(checkpoints.map(snapshot => snapshot.entries), [16, 32]);
  assert.equal((await collect(readCarrierSnapshot(space, checkpoints[0].ni))).length, 16,
    "a checkpoint names only entries whose bodies are already held");
  assert.equal(admitted.entries, 40);
  const failing = await admitCarrier(space, directoryCarrierFiles(carrier), {
    known: new Map(), retain: async () => { throw new Error("disk full"); },
  }).then(() => null, error => error);
  assert.equal(failing, null, "bodies already held survive a retention error");
});

test("literal selections never enumerate a directory and retain original incremental NI snapshots", async t => {
  const { carrier, space } = fixture(t);
  write(carrier, "README.md", "bounded orientation\n");
  write(carrier, "notes/empty.md", "");
  write(carrier, "unselected/deep/submodule/large.bin", "not selected\n");
  const original = fs.readdirSync;
  fs.readdirSync = () => { throw new Error("unselected directory enumeration attempted"); };
  syncBuiltinESMExports();
  let first, again;
  try {
    const known = new Map(), options = { paths: ["README.md", "notes/empty.md"], maximumFileBytes: 64, maximumBytes: 128 };
    const files = [...directoryCarrierFiles(carrier, options)];
    assert.deepEqual(files.map(x => x.path), options.paths);
    assert.equal(files[1].read().length, 0);
    first = await admitCarrier(space, files, { known });
    again = await admitCarrier(space, directoryCarrierFiles(carrier, options), { known });
    assert.equal(again.reused, 2);
    assert.equal(again.ni, first.ni);
    write(carrier, "README.md", "bounded orientation revised\n");
    const changed = await admitCarrier(space, directoryCarrierFiles(carrier, options), { known });
    assert.notEqual(changed.ni, first.ni);
  } finally { fs.readdirSync = original; syncBuiltinESMExports(); }
  assert.equal((await collect(readCarrierSnapshot(space, first.ni))).length, 2);
});

test("the entire literal selection refuses before yielding on invalid, missing, excluded or over-budget subjects", t => {
  const { carrier } = fixture(t);
  write(carrier, "a.md", "alpha");
  write(carrier, "b.md", "beta");
  const first = options => directoryCarrierFiles(carrier, options).next();
  for (const paths of [[], ["a.md", "a.md"], ["../escape"], ["a.md", "missing.md"], ["node_modules/no.md"], Array(1025).fill(0).map((_,i) => `${i}.md`), Array(65).fill(0).map((_,i) => `${i}${"x".repeat(1024)}.md`)])
    assert.throws(() => first({ paths }));
  for (const options of [{ maximumFileBytes: 4 }, { maximumBytes: 8 }, { maximumFileBytes: 0 }, { maximumBytes: 64 * 1024 * 1024 + 1 }])
    assert.throws(() => first({ paths: ["a.md", "b.md"], ...options }), /byte bounds|byte budget/);
});

test("literal selection refuses symlink roots/ancestry and file identity drift at its original reader", t => {
  const { carrier } = fixture(t);
  write(carrier, "notes/a.md", "alpha");
  symlinkSync(join(carrier, "notes"), join(carrier, "link"));
  assert.throws(() => [...directoryCarrierFiles(carrier, { paths: ["link/a.md"] })], /unredirected/);
  assert.throws(() => [...directoryCarrierFiles(join(carrier, "link"), { paths: ["a.md"] })], /unredirected|not a directory/);
  const [selected] = directoryCarrierFiles(carrier, { paths: ["notes/a.md"] });
  rmSync(join(carrier, "notes/a.md")); write(carrier, "notes/a.md", "other");
  assert.throws(() => selected.read(), /changed/);
  const [again] = directoryCarrierFiles(carrier, { paths: ["notes/a.md"] });
  rmSync(join(carrier, "notes"), { recursive: true });
  mkdirSync(join(carrier, "elsewhere"));
  symlinkSync(join(carrier, "elsewhere"), join(carrier, "notes"));
  assert.throws(() => again.read(), /unredirected/);
});
