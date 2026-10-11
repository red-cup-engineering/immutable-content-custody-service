import assert from "node:assert/strict";
import test from "node:test";
import { createVerifiedContentReader } from "../src/immutable-content-custody.mjs";

test("cold and warm reads share verification across locations while reading every time", () => {
  let reads = 0;
  let verifications = 0;
  const read = createVerifiedContentReader({
    read: () => { reads += 1; return Buffer.from('{"nested":{"valid":true}}'); },
    verify: (bytes) => { verifications += 1; return JSON.parse(bytes.toString()); },
  });
  const first = read("a");
  assert.equal(read("b"), first);
  assert.equal(reads, 2);
  assert.equal(verifications, 1);
  assert.throws(() => { first.nested.valid = false; }, TypeError);
});

test("changed and corrupt bytes are verified, and failures never become valid cached reads", () => {
  let source = Buffer.from("1");
  let verifications = 0;
  const read = createVerifiedContentReader({ read: () => source, verify: (bytes) => {
    verifications += 1;
    return JSON.parse(bytes.toString());
  } });
  assert.equal(read("a"), 1);
  source[0] = 50;
  assert.equal(read("a"), 2);
  source[0] = 123;
  assert.throws(() => read("a"), SyntaxError);
  assert.throws(() => read("a"), SyntaxError);
  assert.equal(verifications, 4);
  source[0] = 49;
  assert.equal(read("a"), 1);
});

test("verifier identity is isolated by reader instance", () => {
  const read = () => Buffer.from("same");
  const first = createVerifiedContentReader({ read, verify: () => "accepted" });
  const second = createVerifiedContentReader({ read, verify: () => { throw new Error("refused"); } });
  assert.equal(first("a"), "accepted");
  assert.throws(() => second("a"), /refused/);
});

test("entry and byte limits evict least-recently read content", () => {
  for (const limits of [{ maximumEntries: 2 }, { maximumBytes: 2 }]) {
    const calls = [];
    const read = createVerifiedContentReader({ ...limits, read: (key) => Buffer.from(key), verify: (bytes) => {
      calls.push(bytes.toString());
      return bytes.toString();
    } });
    for (const key of ["a", "b", "a", "c", "a", "b"]) read(key);
    assert.deepEqual(calls, ["a", "b", "c", "b"]);
  }
});

test("oversized content is verified without evicting retained small content", () => {
  let calls = 0;
  const read = createVerifiedContentReader({ maximumBytes: 1, read: (key) => Buffer.from(key), verify: () => ++calls });
  assert.equal(read("a"), 1);
  assert.equal(read("large"), 2);
  assert.equal(read("large"), 3);
  assert.equal(read("a"), 1);
});

test("invalid boundaries fail before cache admission and verifier input mutation cannot poison the key", () => {
  assert.throws(() => createVerifiedContentReader({ read: () => null, verify: () => true, maximumEntries: 0 }), RangeError);
  assert.throws(() => createVerifiedContentReader({ read: () => null, verify: () => true })("a"), TypeError);
  const read = createVerifiedContentReader({ read: () => Buffer.from("a"), verify: (bytes) => {
    bytes[0] = 98;
    return bytes.toString();
  } });
  assert.equal(read("a"), "b");
  assert.equal(read("a"), "b");
});
