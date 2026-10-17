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

test("copy-out through the shared host configuration recovers exact NI bytes by direct address and path", async t => {
  const { tmp, root, source, args } = fixture(t);
  const created = await runCustodySpace(args("put", {
    name:"science/l-space", expected:"none", path:'["weave","wang"]',
    file:source, "media-type":"text/plain",
  }));
  const outNi = join(tmp, "received-ni.txt");
  const byNi = await runCustodySpace(args("get", { ni:created.ni, out:outNi }));
  assert.equal(byNi.ni, created.ni);
  assert.equal(byNi.destination, outNi);
  assert.equal(byNi.mediaType, "text/plain");
  assert.equal(byNi.byteLength, readFileSync(source).byteLength);
  assert.deepEqual(readFileSync(outNi), readFileSync(source));
  assert.equal(JSON.stringify(byNi).includes("north=blue"), false,
    "the CLI prints metadata, never unbounded source bytes");

  const outName = join(tmp, "received-by-name.txt");
  const byName = await runCustodySpace(args("get", {
    name:"science/l-space", path:'["weave","wang"]', out:outName,
  }));
  assert.deepEqual(readFileSync(outName), readFileSync(source));
  assert.deepEqual({
    name:byName.name, rootNi:byName.rootNi, ni:byName.ni, path:byName.path,
  }, {
    name:"science/l-space",rootNi:created.rootNi,ni:created.ni,path:["weave","wang"],
  });
  assert.equal(byName.mediaType,"text/plain");
  const another = createContentAddressedSpace({
    root, durableRoot:root, namespaces:["science/l-space"],
  });
  assert.deepEqual((await another.atPath("science/l-space", ["weave","wang"])).bytes,
    readFileSync(outName), "another JS reader and a non-JS process receive identical bytes");
});

test("the actual installed-style CLI creates a reusable file for a second process", t => {
  const { tmp, source, args } = fixture(t);
  const put = spawnSync(process.execPath, [cli,...args("put", {
    name:"science/l-space", expected:"none", path:'["models","beads"]',
    file:source, "media-type":"text/plain",
  })], { encoding:"utf8" });
  assert.equal(put.status,0,put.stderr);
  const authored = JSON.parse(put.stdout);
  const out = join(tmp,"other-program.bin");
  const get = spawnSync(process.execPath, [cli,...args("get", {
    name:"science/l-space",path:'["models","beads"]',out,
  })], { encoding:"utf8" });
  assert.equal(get.status,0,get.stderr);
  assert.deepEqual(readFileSync(out),readFileSync(source));
  assert.equal(JSON.parse(get.stdout).ni,authored.ni);
  assert.equal(get.stderr,"");
});

test("shared copy-out retains sidecar and writer custody; refuses forged roots and output collisions", async t => {
  const { tmp, root, config, source, args } = fixture(t);
  const created = await runCustodySpace(args("put", {
    name:"science/l-space",expected:"none",path:'["models","beads"]',file:source,
  }));
  const output = join(tmp,"does-not-exist.bin");
  await assert.rejects(runCustodySpace(args("get", { ni:created.rootNi,
    name:"science/l-space",path:'["models","beads"]',out:output,
  })), /either --ni or --name with --path/);
  await assert.rejects(runCustodySpace(args("get", {
    name:"science/l-space",out:output,
  })), /either --ni or --name with --path/);
  await assert.rejects(runCustodySpace(args("get", {
    ni:created.ni,out:"relative.out",
  })), /absolute path/);
  await assert.rejects(runCustodySpace(args("get", {
    ni:created.ni,out:join(root,"objects","new-file"),
  })), /cannot materialize into shared custody/);
  await assert.rejects(runCustodySpace(args("get", {
    name:"science/l-space",path:'["models","missing"]',out:output,
  })), /selected content is not retained/);
  assert.equal(readFileSync(source).length>0,true);
  await assert.rejects(runCustodySpace(args("get", {
    ni:"ni:///sha-256;WRONG",out:output,
  })));
  assert.throws(()=>readFileSync(output),{code:"ENOENT"},"refusals leave no output");

  writeFileSync(output,"protected-original");
  await assert.rejects(runCustodySpace(args("get",{
    ni:created.ni,out:output,
  })),/EEXIST|exist|original/);
  assert.equal(readFileSync(output,"utf8"),"protected-original",
    "copy-out never replaces an existing downstream artifact");

  const metadata = join(root,"objects",...created.retained.key.split("/"))+".media-type";
  rmSync(metadata);
  const pending = join(tmp,"sidecar-must-not-bypass.bin");
  await assert.rejects(runCustodySpace(args("get",{ni:created.ni,out:pending})),
    { code:"ERR_CUSTODY_INCOMPLETE" });
  assert.throws(()=>readFileSync(pending),{code:"ENOENT"});
  writeFileSync(config, JSON.stringify({
    root,durableRoot:root,namespaces:["science/l-space"],maximumBytes:1,
  }));
  // Restore media type before checking the original bounded-read effect.
  writeFileSync(metadata,"application/octet-stream\n");
  const overBudget = join(tmp,"too-big.bin");
  await assert.rejects(runCustodySpace(args("get",{ni:created.ni,out:overBudget})),
    /exceeds installed byte budget/);
  assert.throws(()=>readFileSync(overBudget),{code:"ENOENT"});
});

test("installed npm-style bin symlink actually enters the CLI and retrieves original bytes", t => {
  const { tmp, source, args } = fixture(t);
  const alias = join(tmp,"custody-space-installed");
  symlinkSync(cli,alias);
  const put = spawnSync(alias,args("put",{
    name:"science/l-space",expected:"none",path:'["craft","bead"]',
    file:source,"media-type":"text/plain",
  }),{encoding:"utf8"});
  assert.equal(put.status,0,put.error?.message ?? put.stderr);
  const receipt = JSON.parse(put.stdout);
  const destination = join(tmp,"external-reader.bin");
  const get = spawnSync(alias,args("get",{
    name:"science/l-space",path:'["craft","bead"]',out:destination,
  }),{encoding:"utf8"});
  assert.equal(get.status,0,get.error?.message ?? get.stderr);
  assert.equal(JSON.parse(get.stdout).ni,receipt.ni);
  assert.deepEqual(readFileSync(destination),readFileSync(source));
});


test("host CLI atomically publishes Wang and bead material through one manifest and exposes a bounded tree view", async t => {
  const { tmp, root, source, args } = fixture(t);
  const beadFile = join(tmp, "ported-bead.json");
  writeFileSync(beadFile, JSON.stringify({ kind:"ported-bead", ports:["entry","exit"] }));
  const wang = await runCustodySpace(args("retain", { file: source, "media-type":"text/plain" }));
  const bead = await runCustodySpace(args("retain", { file: beadFile, "media-type":"application/json" }));
  const manifest = join(tmp, "batch.json");
  writeFileSync(manifest, JSON.stringify({ links: [
    { path: ["tilings", "wang"], ni: wang.ni },
    { path: ["weaves", "bead"], ni: bead.ni },
  ] }));
  const published = await runCustodySpace(args("link-batch", {
    name:"science/l-space", expected:"none", manifest,
  }));
  assert.equal(published.published, true);
  assert.equal(published.links.length, 2);
  const cliWalk = spawnSync(process.execPath, [cli, ...args("walk", {
    name:"science/l-space", "maximum-nodes":"5", "maximum-depth":"2",
  })], { encoding:"utf8" });
  assert.equal(cliWalk.status, 0, cliWalk.stderr);
  const inventory = JSON.parse(cliWalk.stdout);
  assert.equal(inventory.count, 5);
  assert.deepEqual(inventory.nodes.filter(row => row.kind === "object").map(row => row.ni),
    [wang.ni, bead.ni], "canonical sorting applies to immediate tree slots");
  assert.equal(cliWalk.stdout.includes("north=blue"), false);
  const consumer = createContentAddressedSpace({
    root, durableRoot:root, namespaces:["science/l-space"],
  });
  assert.deepEqual((await consumer.atPath("science/l-space", ["weaves", "bead"])).bytes,
    readFileSync(beadFile));
  assert.deepEqual((await consumer.atPath("science/l-space", ["tilings", "wang"])).bytes,
    readFileSync(source));
});

test("CLI batch and walk refuse forged, overlapping, stale and over-budget instructions without announcing names", async t => {
  const { tmp, source, args } = fixture(t);
  const held = await runCustodySpace(args("retain", {file: source}));
  const manifest = join(tmp,"batch.json");
  const run = links => {
    writeFileSync(manifest, JSON.stringify({links}));
    return runCustodySpace(args("link-batch", {
      name:"engineering/source", expected:"none", manifest,
    }));
  };
  await assert.rejects(run([
    {path:["same"],ni:held.ni},
    {path:["same","nested"],ni:held.ni},
  ]), /overlapping|contain another/);
  await assert.rejects(run([{path:["a"],ni:"ni:///sha-256;forged"}]));
  await assert.rejects(run([{path:["absent"],ni:held.ni}, {path:["bad/slot"],ni:held.ni}]));
  assert.equal((await runCustodySpace(args("resolve",{name:"engineering/source"}))).ni,null);
  const committed = await run([{path:["ok"],ni:held.ni}]);
  await assert.rejects(run([{path:["late"],ni:held.ni}]), /changed before publication/);
  assert.equal((await runCustodySpace(args("resolve",{name:"engineering/source"}))).ni,committed.rootNi);
  await assert.rejects(runCustodySpace(args("walk", {
    name:"engineering/source", "maximum-nodes":"1",
  })), /exceeds node budget/);
  await assert.rejects(runCustodySpace(args("walk", {
    name:"engineering/source", "maximum-depth":"0",
  })), /exceeds depth budget/);
  await assert.rejects(runCustodySpace(args("walk", {
    ni:held.ni, name:"engineering/source",
  })), /exactly one/);
  await assert.rejects(runCustodySpace(args("walk", {
    ni:held.ni, "maximum-nodes":"00",
  })), /canonical nonnegative/);
  writeFileSync(manifest, JSON.stringify({links:[{path:["new"],ni:held.ni}],root:"/etc"}));
  await assert.rejects(runCustodySpace(args("link-batch", {
    name:"science/l-space",expected:"none",manifest,
  })), /manifest must contain only links/);
  assert.equal((await runCustodySpace(args("resolve",{name:"science/l-space"}))).ni,null);
});
