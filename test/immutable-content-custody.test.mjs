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
