import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";
import { immutableContentKey } from "../src/immutable-content-custody.mjs";
import { createContentAddressedSpace } from "../src/content-space.mjs";

function fixture(t, names = ["code/source", "science/theory"]) {
  const root = mkdtempSync(join(tmpdir(), "shared-ni-space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, space: createContentAddressedSpace({
    root, durableRoot: root, namespaces: names,
  }) };
}

test("one shared NI space actually retains empty/code/media bytes and supports independent readers", async t => {
  const { root, space } = fixture(t);
  const empty = await space.retain(Buffer.alloc(0));
  assert.equal(empty.ni, makeNiUri(Buffer.alloc(0)));
  assert.equal(empty.byteLength, 0, "empty Git/file blobs have an address");
  assert.equal(empty.durable, true, "the existing strict physical writer completed its barriers");
  assert.deepEqual((await space.get(empty.ni)).bytes, Buffer.alloc(0));
  const source = Buffer.from("export const theorem = 1;\n", "utf8");
  const content = await space.retain(source, { mediaType: "text/javascript" });
  const second = await space.retain(Buffer.from(source), { mediaType: "text/javascript" });
  assert.equal(content.ni, second.ni);
  assert.equal(second.durable, true);
  const key = immutableContentKey(content.ni);
  const target = join(root, "objects", ...key.split("/"));
  assert.equal(readFileSync(target).toString("utf8"), source.toString("utf8"));
  assert.equal(readFileSync(target + ".media-type", "utf8"), "text/javascript\n");
  const other = createContentAddressedSpace({ root, durableRoot: root, namespaces: ["code/source"] });
  assert.deepEqual((await other.get(content.ni)).bytes, source, "two independent code consumers read one original content body");
  assert.equal((await other.head(content.ni)).ni, content.ni);
  assert.deepEqual(await other.range(content.ni, { start: 0, end: 5 }), source.subarray(0, 6));
  assert.equal(readdirSync(root).includes("names"), false, "retrieving bytes creates no name binding");
});

test("Plan-9-like admitted names are versioned references, never alternate content identity", async t => {
  const { root, space } = fixture(t);
  const one = await space.retain(Buffer.from("Wang tiles"));
  const two = await space.retain(Buffer.from("Chu(FOUR)"));
  const first = await space.bind({ name: "science/theory", expected: null, ni: one.ni });
  assert.equal(first.published, true);
  assert.equal(space.resolve("science/theory"), one.ni);
  await space.bind({ name: "code/source", expected: null, ni: one.ni });
  assert.equal((await space.at("science/theory")).ni, one.ni);
  assert.equal((await space.at("code/source")).ni, one.ni,
    "different names select exactly one shared byte object");
  const advanced = await space.bind({ name: "science/theory", expected: one.ni, ni: two.ni });
  assert.equal(advanced.before, one.ni);
  assert.equal(space.resolve("science/theory"), two.ni);
  assert.equal(space.resolve("code/source"), one.ni, "another consumer's namespace is unaffected");
  assert.deepEqual((await space.get(one.ni)).bytes, Buffer.from("Wang tiles"),
    "moving a name cannot mutate historical content");
  await assert.rejects(() => space.bind({ name: "science/theory", expected: null, ni: one.ni }),
    /reference changed before publication/);
  assert.deepEqual(space.list(), [
    { name: "code/source", ni: one.ni },
    { name: "science/theory", ni: two.ni },
  ], "enumeration only reveals host-admitted namespaces");
  const second = createContentAddressedSpace({ root, durableRoot: root, namespaces: ["science/theory"] });
  assert.equal(second.resolve("science/theory"), two.ni, "bindings persist across independent processes");
});

test("unheld addresses, foreign names, malformed roots and path traversal have no effects", async t => {
  const { root, space } = fixture(t);
  const missing = makeNiUri(Buffer.from("not admitted"));
  await assert.rejects(() => space.bind({ name: "code/source", expected: null, ni: missing }),
    /unreceived content/);
  assert.equal(space.resolve("code/source"), null);
  await assert.rejects(() => space.bind({ name: "unlisted/secret", expected: null, ni: missing }),
    /namespace is not admitted/);
  assert.throws(() => space.resolve("../../etc/passwd"), /namespace is not admitted/);
  assert.equal(await space.get(missing), null);
  assert.throws(() => createContentAddressedSpace({
    root, durableRoot: root, namespaces: ["code/../private"],
  }), /namespace segments/);
  assert.throws(() => createContentAddressedSpace({
    root, durableRoot: root, namespaces: ["code/source", "code/source"],
  }), /duplicate namespace/);
  assert.throws(() => createContentAddressedSpace({
    root, durableRoot: root, namespaces: ["code/source"], maximumBytes: 0,
  }), /positive safe integer/);
  const outside = mkdtempSync(join(tmpdir(), "shared-ni-external-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => createContentAddressedSpace({
    root: outside, durableRoot: root,
  }), /belong to its existing durable anchor/);
  symlinkSync(root, join(outside, "alias"));
  assert.throws(() => createContentAddressedSpace({
    root: join(outside, "alias"), durableRoot: outside,
  }), /non-redirected directory/);
});

test("retained content corruption and competing media cannot be mistaken for agreement", async t => {
  const { root, space } = fixture(t);
  const bytes = Buffer.from([0, 255, 1, 254]);
  const original = await space.retain(bytes, { mediaType: "application/octet-stream" });
  await assert.rejects(() => space.retain(bytes, { mediaType: "image/png" }),
    /different|conflict|media type/u);
  assert.equal((await space.get(original.ni)).mediaType, "application/octet-stream");
  const path = join(root, "objects", ...immutableContentKey(original.ni).split("/"));
  // Mutation here is synthetic corrupt external storage, not an authorized
  // operation of the immutable store. The next read must refuse.
  writeFileSync(path, Buffer.from("corrupt"));
  await assert.rejects(() => space.get(original.ni), /do not match|content bytes/u);
  await assert.rejects(() => space.bind({ name: "code/source", expected: null, ni: original.ni }),
    /do not match|content bytes/u);
  assert.equal(space.resolve("code/source"), null);
});

test("interrupted body-only custody is not a named or readable shared object until repaired", async t => {
  const { root, space } = fixture(t);
  const bytes = Buffer.from("recover the admitted representation");
  const { ni } = await space.retain(bytes, { mediaType: "text/plain" });
  const path = join(root, "objects", ...immutableContentKey(ni).split("/"));
  rmSync(path + ".media-type"); // simulate a lost publication sidecar
  for (const read of [
    () => space.get(ni),
    () => space.head(ni),
    () => space.range(ni, { start: 0, end: 2 }),
    () => space.bind({ name: "code/source", expected: null, ni }),
  ]) await assert.rejects(read, { code: "ERR_CUSTODY_INCOMPLETE" });
  assert.equal(space.resolve("code/source"), null, "refusal cannot publish a name");
  const repaired = await space.retain(bytes, { mediaType: "text/plain" });
  assert.equal(repaired.ni, ni);
  assert.equal(repaired.durable, true, "the original strict publisher reestablished barriers");
  assert.equal((await space.bind({ name: "code/source", expected: null, ni })).published, true);
  assert.deepEqual((await space.at("code/source")).bytes, bytes);
});

test("shared space refuses invalid MIME sidecars without changing ordinary file-store observations", async t => {
  const { root, space } = fixture(t);
  const { ni } = await space.retain(Buffer.from("held"), { mediaType: "text/plain" });
  const path = join(root, "objects", ...immutableContentKey(ni).split("/")) + ".media-type";
  for (const metadata of [
    Buffer.alloc(0), Buffer.from("Text/Plain\n"), Buffer.from("text/plain"),
    Buffer.from("text/plain\nextra\n"), Buffer.from("text/plain\r\n"),
    Buffer.from([0xff, 0x0a]),
  ]) {
    writeFileSync(path, metadata);
    await assert.rejects(() => space.get(ni), { code: "ERR_CUSTODY_INCOMPLETE" });
    await assert.rejects(() => space.bind({ name: "science/theory", expected: null, ni }),
      { code: "ERR_CUSTODY_INCOMPLETE" });
    assert.equal(space.resolve("science/theory"), null);
  }
});
