import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createContentAddressedSpace } from "../src/content-space.mjs";
import { runCustodySpace } from "../scripts/custody-space.mjs";

const cli = fileURLToPath(new URL("../scripts/custody-space.mjs", import.meta.url));
function fixture(t) {
  const tmp = mkdtempSync(join(tmpdir(), "ni-space-cli-"));
  t.after(() => rmSync(tmp, { force: true, recursive: true }));
  const root = join(tmp, "shared");
  mkdirSync(root);
  const config = join(tmp, "host.json");
  const namespaces = ["science/l-space", "engineering/source"];
  writeFileSync(config, JSON.stringify({ root, durableRoot: root, namespaces }));
  const source = join(tmp, "wang.txt");
  writeFileSync(source, "north=blue;east=red\n");
  const args = (command, fields = {}) => [command, "--config", config,
    ...Object.entries(fields).flatMap(([key, value]) => ["--" + key, String(value)])];
  return { tmp, root, config, source, args };
}

test("two independent CLI calls create and navigate one real immutable named NI tree", async t => {
  const { root, source, args } = fixture(t);
  const wang = await runCustodySpace(args("put", {
    name: "science/l-space", expected: "none",
    path: JSON.stringify(["tilings", "wang"]), file: source, "media-type": "text/plain",
  }));
  assert.equal(wang.published, true);
  assert.equal(wang.retained.durable, true);
  assert.ok(wang.ni.startsWith("ni:///sha-256;"));
  assert.notEqual(wang.ni, wang.rootNi);

  const head = await runCustodySpace(args("resolve", {name: "science/l-space"}));
  assert.equal(head.ni, wang.rootNi);
  const reading = await runCustodySpace(args("at", {
    name: "science/l-space", path: JSON.stringify(["tilings", "wang"]),
  }));
  assert.deepEqual(reading, {
    found: true, name: "science/l-space", ni: wang.ni, rootNi: wang.rootNi,
    path: ["tilings", "wang"], mediaType: "text/plain",
    byteLength: Buffer.byteLength("north=blue;east=red\n"),
  });
  const science = createContentAddressedSpace({ root, durableRoot: root, namespaces: ["science/l-space"] });
  assert.deepEqual((await science.atPath("science/l-space", ["tilings", "wang"])).bytes,
    readFileSync(source), "another installed client receives the exact original bytes");
  const rootTree = await runCustodySpace(args("tree", {ni: wang.rootNi}));
  assert.equal(rootTree.found, true);
  assert.deepEqual(rootTree.tree.entries.map(x=>x.name), ["tilings"]);

  const link = await runCustodySpace(args("link", {
    name: "engineering/source", expected: "none",
    path: JSON.stringify(["references", "wang"]), ni: wang.ni,
  }));
  assert.equal(link.published, true);
  assert.equal((await runCustodySpace(args("at", {
    name: "engineering/source", path: JSON.stringify(["references", "wang"]),
  }))).ni, wang.ni, "two independent namespaces share the original exact bytes");
  assert.notEqual(link.rootNi, wang.rootNi, "different path structure retains distinct tree identity");
  assert.equal((await runCustodySpace(args("list"))).namespaces.length, 2);
});

test("bounded named-root CAS change retains prior snapshot and refuses stale writers", async t => {
  const { tmp, source, args } = fixture(t);
  const first = await runCustodySpace(args("put", {
    name: "science/l-space", expected: "none", path: '["a"]', file: source,
  }));
  const nextSource = join(tmp, "beads.bin");
  writeFileSync(nextSource, Buffer.from([0,1,1,0]));
  const next = await runCustodySpace(args("put", {
    name: "science/l-space", expected: first.rootNi,
    path: '["beads"]', file: nextSource,
  }));
  assert.equal(next.published, true);
  assert.notEqual(next.rootNi, first.rootNi);
  assert.equal((await runCustodySpace(args("tree",{ni:first.rootNi}))).tree.entries.length, 1,
    "older immutable tree remains independently readable");
  await assert.rejects(runCustodySpace(args("put", {
    name: "science/l-space", expected: first.rootNi,
    path: '["wrong"]', file: nextSource,
  })), /changed before publication/);
  assert.equal((await runCustodySpace(args("resolve",{name:"science/l-space"}))).ni, next.rootNi);
  assert.equal((await runCustodySpace(args("at",{
    name:"science/l-space",path:'["wrong"]',
  }))).found, false);
});

test("the actual CLI is a JSON process boundary for non-JavaScript consumers", t => {
  const { args } = fixture(t);
  const result = spawnSync(process.execPath, [cli, ...args("list")], { encoding:"utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).namespaces.length, 2);
  assert.equal(result.stderr, "");
  const refused = spawnSync(process.execPath, [cli, ...args("at", {
    name: "../../secret", path:'["x"]',
  })], {encoding:"utf8"});
  assert.equal(refused.status, 1);
  assert.equal(JSON.parse(refused.stderr).kind, "immutable-content-custody-refusal");
  assert.equal(refused.stdout, "", "a refusal cannot spill content on the wire");
});

test("host configuration, local source and explicit tree slots fail closed", async t => {
  const { tmp, config, source, args } = fixture(t);
  const link = join(tmp, "symlink");
  symlinkSync(source, link);
  await assert.rejects(runCustodySpace(args("retain", {file:link})), /regular file/);
  await assert.rejects(runCustodySpace(args("put", {
    name:"unknown/root",expected:"none",path:'["x"]',file:source,
  })), /namespace is not admitted/);
  await assert.rejects(runCustodySpace(args("put", {
    name:"science/l-space",expected:"none",path:'[".."]',file:source,
  })), /content tree path/);
  await assert.rejects(runCustodySpace(args("put", {
    name:"science/l-space",expected:"none",path:"[malformed",file:source,
  })), /JSON array/);
  await assert.rejects(runCustodySpace([...args("list"),"--root","/tmp/private"]),
    /Unknown option|Unknown/);
  await assert.rejects(runCustodySpace(args("retain", {file:"relative.txt"})), /absolute host-selected/);
  writeFileSync(config, JSON.stringify({
    root:"/tmp/not-installed",durableRoot:"/tmp/not-installed",
    namespaces:["science/l-space"],credential:"do-not-echo",
  }));
  await assert.rejects(runCustodySpace(args("list")), /only root, durableRoot/);
});
