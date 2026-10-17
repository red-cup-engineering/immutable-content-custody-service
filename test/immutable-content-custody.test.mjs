import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { makeNiUri } from "@red-cup-engineering/uri-services-section/ni-uri";

import {
  createImmutableContentCustody,
  IMMUTABLE_CONTENT_REFERENCE_PROFILE,
  immutableContentKey,
} from "../src/immutable-content-custody.mjs";

function memoryStore() {
  const objects = new Map();
  return Object.freeze({
    async putCurrent(key, { body, byteLength, mediaType, sha256 }) {
      assert.equal(byteLength, body.length);
      assert.equal(sha256, createHash("sha256").update(body).digest("hex"));
      objects.set(key, { body: Buffer.from(body), mediaType, etag: "memory-etag" });
    },
    async get(key) {
      return objects.get(key) ?? null;
    },
  });
}

test("put then get round-trips exact bytes through an injected store", async () => {
  const bytes = Buffer.from("semiotic foam");
  const ni = makeNiUri(bytes);
  const custody = createImmutableContentCustody({ store: memoryStore() });
  const reference = await custody.put({ ni, bytes, mediaType: "text/plain" });
  assert.equal(reference.profile, IMMUTABLE_CONTENT_REFERENCE_PROFILE);
  assert.equal(reference.key, immutableContentKey(ni));
  assert.ok((await custody.get(reference)).bytes.equals(bytes));
});

test("put rejects bytes that do not match their declared identity", async () => {
  const custody = createImmutableContentCustody({ store: memoryStore() });
  await assert.rejects(() => custody.put({
    ni: makeNiUri(Buffer.from("different")),
    bytes: Buffer.from("semiotic foam"),
  }));
});

test("a backing store is required instead of silently selecting a provider", () => {
  assert.throws(() => createImmutableContentCustody(), /requires a store/u);
});

test("maximumBytes is explicit while the historical 8 MiB default remains intact", async () => {
  const bytes = Buffer.alloc(9 * 1024 * 1024, 7);
  const ni = makeNiUri(bytes);
  await assert.rejects(() => createImmutableContentCustody({ store: memoryStore() }).put({ ni, bytes }), /through 8388608 bytes/u);
  const custody = createImmutableContentCustody({ store: memoryStore(), maximumBytes: bytes.length });
  assert.equal((await custody.put({ ni, bytes })).byteLength, bytes.length);
  assert.throws(() => createImmutableContentCustody({ store: memoryStore(), maximumBytes: 0 }), /positive safe integer/u);
});


test("first-write custody composes with the original strict file-store shape", async () => {
  const retained = new Map();
  let currentWrites = 0, firstWrites = 0;
  const store = {
    async get(key) { return retained.get(key) ?? null; },
    async putIfAbsent(key, { body, mediaType }) {
      firstWrites += 1;
      if (retained.has(key)) {
        const existing = retained.get(key);
        if (!existing.body.equals(body) || existing.mediaType !== mediaType)
          throw Object.assign(new Error("retained representation differs"), { code: "ERR_CUSTODY_CONFLICT" });
        return { conflict: true, durable: true };
      }
      retained.set(key, { body: Buffer.from(body), mediaType });
      return { conflict: false, durable: true };
    },
    async putCurrent() { currentWrites++; throw new Error("mutable fallback must not be called"); },
  };
  const custody = createImmutableContentCustody({ store });
  const empty = Buffer.alloc(0), id = makeNiUri(empty);
  const first = await custody.put({ ni: id, bytes: empty });
  assert.equal(first.byteLength, 0, "empty Git blobs are legitimate source bytes");
  assert.equal(first.durable, true);
  const replay = await custody.put({ ni: id, bytes: Buffer.alloc(0) });
  assert.equal(replay.ni, first.ni);
  assert.equal(firstWrites, 2);
  assert.equal(currentWrites, 0);
  assert.deepEqual((await custody.get(id)).bytes, empty);
  await assert.rejects(() => custody.put({ ni: id, bytes: empty, mediaType: "text/plain" }),
    { code: "ERR_CUSTODY_CONFLICT" });
  assert.equal((await custody.get(id)).mediaType, "application/octet-stream");
  assert.equal(currentWrites, 0);
  await assert.rejects(() => custody.put({ ni: id }), /explicit bytes/);
});

test("an occupied first-write key must contain both the requested bytes and declared media", async () => {
  const bytes = Buffer.from("same");
  const ni = makeNiUri(bytes);
  const custody = createImmutableContentCustody({ store: {
    async get() { return { body: bytes, mediaType: "text/plain" }; },
    async putIfAbsent() { return { conflict: true }; },
  } });
  await assert.rejects(() => custody.put({ ni, bytes, mediaType: "application/json" }),
    /different media type/);
});
