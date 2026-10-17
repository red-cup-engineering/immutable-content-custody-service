import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContentAddressedSpace } from "../src/content-space.mjs";
import { createContentSpacePublicationMcpTools } from "../src/content-space-publication.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(),"source-owned-agent-ni-"));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const namespaces=["science/l-space","engineering/source"];
  const contentSpace=createContentAddressedSpace({root,durableRoot:root,namespaces});
  const tools=createContentSpacePublicationMcpTools({
    contentSpace,
    canLinkSource:(context,ni)=>context?.mayLink===true && typeof ni==="string",
    canPublish:(context,coordinate)=>context?.principal==="member" &&
      context.allowed?.includes(coordinate.name) &&
      coordinate.path.every(part=>part!=="private"),
  });
  return {root,contentSpace,tools};
}
const actor={principal:"member",allowed:["science/l-space","engineering/source"],mayLink:true};
const tool=(tools,name)=>tools.find(x=>x.name===name);

test("an admitted agent creates a real durable Wang NI and a second client reads that same immutable content",async t=>{
  const {root,contentSpace,tools}=fixture(t);
  const put=tool(tools,"content_space_put_path");
  const content=Buffer.from("north=blue;east=red\n","utf8");
  const created=await put.handler({
    name:"science/l-space",expected:null,path:["tilings","wang"],
    base64url:content.toString("base64url"),mediaType:"text/plain",
  },actor);
  assert.equal(created.action,"put");
  assert.equal(created.durable,true);
  assert.notEqual(created.ni,created.rootNi);
  assert.equal(created.byteLength,content.length);
  assert.equal(contentSpace.resolve("science/l-space"),created.rootNi);
  const other=createContentAddressedSpace({root,durableRoot:root,
    namespaces:["science/l-space","engineering/source"]});
  const observed=await other.atPath("science/l-space",["tilings","wang"]);
  assert.deepEqual(observed.bytes,content);
  assert.equal(observed.ni,created.ni);
  const link=tool(tools,"content_space_link_path");
  const shared=await link.handler({
    name:"engineering/source",expected:null,path:["patterns","wang"],
    ni:created.ni,
  },actor);
  assert.equal(shared.action,"link");
  assert.equal((await other.atPath("engineering/source",["patterns","wang"])).ni,created.ni);
  assert.notEqual(shared.rootNi,created.rootNi);
});

test("stale CAS cannot overwrite a winning named frontier",async t=>{
  const {contentSpace,tools}=fixture(t);
  const put=tool(tools,"content_space_put_path");
  const first=await put.handler({
    name:"science/l-space",expected:null,path:["beads"],
    base64url:Buffer.from([0,1,1,0]).toString("base64url"),
  },actor);
  await assert.rejects(put.handler({
    name:"science/l-space",expected:null,path:["other"],
    base64url:Buffer.from([2]).toString("base64url"),
  },actor),/changed before publication/);
  assert.equal(contentSpace.resolve("science/l-space"),first.rootNi);
  assert.equal(await contentSpace.atPath("science/l-space",["other"]),null);
  const updated=await put.handler({
    name:"science/l-space",expected:first.rootNi,path:["weaving","beads"],
    base64url:"",
  },actor);
  assert.notEqual(updated.rootNi,first.rootNi);
  assert.equal((await contentSpace.atPath("science/l-space",["weaving","beads"])).bytes.length,0);
});

test("unauthorized actors and caller-supplied credentials never write",async t=>{
  const {contentSpace,tools}=fixture(t);
  const put=tool(tools,"content_space_put_path");
  const base={name:"science/l-space",expected:null,path:["wang"],base64url:"AQ"};
  for(const [candidate,context] of [
    [base,{}],[base,{principal:"stranger",allowed:["science/l-space"]}],
    [{...base,path:["private"]},actor],
    [{...base,root:"/home/private"},actor],
    [{...base,credential:"forged"},actor],
    [{...base,name:"unlisted/scope"},actor],
  ]) await assert.rejects(put.handler(candidate,context));
  assert.equal(contentSpace.resolve("science/l-space"),null);
  assert.equal(contentSpace.resolve("engineering/source"),null);
  // A writable destination is not permission to expose an independently
  // retained source whose NI belongs to another principal.
  const retained=await contentSpace.retain(Buffer.from("private material"));
  const link=tool(tools,"content_space_link_path");
  await assert.rejects(link.handler({name:"engineering/source",expected:null,
    path:["shared"],ni:retained.ni},{...actor,mayLink:false}),/source NI not admitted/);
  assert.equal(contentSpace.resolve("engineering/source"),null);
});

test("noncanonical base64url, invalid tree slots and an absent original NI refuse",async t=>{
  const {contentSpace,tools}=fixture(t);
  const put=tool(tools,"content_space_put_path");
  for(const bad of ["YQ==","Y Q","YQ/","YQ+","Y","_"]) {
    await assert.rejects(put.handler({
      name:"science/l-space",expected:null,path:["tiles"],base64url:bad,
    },actor),/base64url|noncanonical/);
  }
  await assert.rejects(put.handler({
    name:"science/l-space",expected:null,path:["UPPER"],base64url:"AQ",
  },actor),/content tree path/);
  const link=tool(tools,"content_space_link_path");
  await assert.rejects(link.handler({
    name:"science/l-space",expected:null,path:["tiles"],ni:"ni:///sha-256;wrong",
  },actor),/content identity|ni|canonical/i);
  assert.equal(contentSpace.resolve("science/l-space"),null);
});

test("native operation descriptors do not imply authority and require host-provided grants",async()=>{
  assert.throws(()=>createContentSpacePublicationMcpTools(),/original installed space/);
  assert.throws(()=>createContentSpacePublicationMcpTools({
    contentSpace:{kind:"semiotic-content.addressed-space.v1",namespaces:[]},canPublish:()=>true,
  }),/original installed space/);
  const space={kind:"semiotic-content.addressed-space.v1",namespaces:["science/l-space"],
    putPath:async()=>{throw Error("must not run");},linkPath:async()=>{throw Error("must not run");}};
  const tools=createContentSpacePublicationMcpTools({contentSpace:space,canPublish:()=>false,
    canLinkSource:()=>false});
  assert.deepEqual(tools.map(x=>x.name),["content_space_put_path","content_space_link_path"]);
  assert.ok(tools.every(x=>x.annotations.readOnlyHint===false));
  await assert.rejects(tool(tools,"content_space_put_path").handler({
    name:"science/l-space",expected:null,path:["tiles"],base64url:"AQ",
  },{}),/coordinate not admitted/);
});
