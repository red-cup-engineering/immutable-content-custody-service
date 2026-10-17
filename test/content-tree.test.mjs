import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CONTENT_TREE_MEDIA_TYPE, encodeContentTree, decodeContentTree } from "../src/content-tree.mjs";
import { immutableContentKey } from "../src/immutable-content-custody.mjs";

const ni = value => "ni:///sha-256;" + createHash("sha256").update(value).digest("base64url");

test("different entry order produces one immutable, sorted raw tree carrier", () => {
  const entries = [{name:"science",ni:ni("L-space")},{name:"engineering",ni:ni("SignCraft")}];
  const a = encodeContentTree(entries, immutableContentKey);
  const b = encodeContentTree([...entries].reverse(), immutableContentKey);
  assert.deepEqual(a,b);
  assert.deepEqual(decodeContentTree(a, immutableContentKey).entries.map(x => x.name), ["engineering","science"]);
  assert.match(a.toString(), /"kind":"semiotic-content.content-tree"/);
  assert.equal(CONTENT_TREE_MEDIA_TYPE, "application/vnd.561.content-tree+json");
  assert.notEqual(ni(a), entries[0].ni);
});

test("empty trees and nested references use exact content identity", () => {
  const empty = encodeContentTree([], immutableContentKey);
  assert.deepEqual(decodeContentTree(empty, immutableContentKey).entries, []);
  const next = encodeContentTree([{name:"subtree",ni:ni(empty)}], immutableContentKey);
  assert.equal(decodeContentTree(next, immutableContentKey).entries[0].ni, ni(empty));
});

test("refuse ambiguous names, keys, duplicate slots and malformed addresses", () => {
  const good = {name:"a",ni:ni("a")};
  for (const value of [
    [good,good], [{...good,name:"../outside"}], [{...good,name:"ABC"}],
    [{...good,name:"a/b"}], [{...good,name:"."}],
    [{...good,other:true}], [{...good,ni:"sha256:hex"}], Array(257).fill(good),
  ]) assert.throws(() => encodeContentTree(value, immutableContentKey));
  assert.throws(() => encodeContentTree([good], null));
});

test("decode refuses additional fields, ordering variants and noncanonical UTF-8 JSON", () => {
  const entries = [{name:"z",ni:ni("z")},{name:"a",ni:ni("a")}];
  const valid = encodeContentTree(entries, immutableContentKey);
  const base = JSON.parse(valid.toString());
  for (const forged of [
    JSON.stringify({...base,extra:true})+"\n",
    JSON.stringify({...base,entries:[...base.entries].reverse()})+"\n",
    JSON.stringify(base),
    JSON.stringify({...base,kind:"other"})+"\n",
    JSON.stringify({...base,entries:[{name:"a",ni:"fake"}]})+"\n",
  ]) assert.throws(() => decodeContentTree(Buffer.from(forged),immutableContentKey));
  assert.throws(() => decodeContentTree(Buffer.from([255,0]), immutableContentKey));
});
