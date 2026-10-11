import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createFileContentCustody,identifyContentFile} from '../src/file-content-custody.mjs';
import {createFileStore,createPathContent} from '../src/file-store.mjs';
import {createImmutableContentCustody} from '../src/immutable-content-custody.mjs';
const identity=bytes=>'ni:///sha-256;'+createHash('sha256').update(bytes).digest('base64url');
test('large raw bodies survive source replacement and return exact verified Unicode windows',()=>{
 const root=mkdtempSync(join(tmpdir(),'file-custody-'));
 try{
  const source=join(root,'source.md'),text='ab😀é\n'.repeat(100000);writeFileSync(source,text);
  const custody=createFileContentCustody({root:join(root,'held')});
  const reference=custody.retainFile(source,{mediaType:'text/plain'});
  assert.equal(reference.ni,identity(Buffer.from(text)));
  assert.equal(identifyContentFile(source).ni,reference.ni);
  const characters=Array.from(text),window=custody.window(reference.ni,{offset:65533,limit:31});
  assert.equal(window.text,characters.slice(65533,65564).join(''));assert.equal(window.total,characters.length);
  writeFileSync(source,'new edition');
  assert.equal(custody.window(reference.ni,{offset:65533,limit:31}).text,window.text);
  assert.throws(()=>custody.retainFile(source,{expectedNi:reference.ni}),/admitted content identity/);
  const body=join(root,'held','objects',reference.key);writeFileSync(body,Buffer.from(text.replace(/b/u,'c')));
  assert.throws(()=>custody.window(reference.ni,{offset:65533,limit:31}),/declared ni identity/);
  const empty=join(root,'empty.txt');writeFileSync(empty,'');const held=custody.retainFile(empty);
  assert.equal(held.ni,identity(Buffer.alloc(0)));assert.equal(custody.window(held.ni).total,0);
  const link=join(root,'link');symlinkSync(source,link);assert.throws(()=>custody.retainFile(link),/regular file/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('current body verification precedes public metadata and range exposure',async()=>{
 const root=mkdtempSync(join(tmpdir(),'verified-ranges-'));
 try{
  const text=Buffer.from('unchanged prefix '+ 'a'.repeat(180000)),ni=identity(text);
  const store=createFileStore(root),custody=createImmutableContentCustody({store});
  const reference=await custody.put({ni,bytes:text,mediaType:'text/plain'});
  assert.deepEqual(await custody.read(ni,{start:0,end:15}),text.subarray(0,16));
  const file=join(root,'objects',reference.key),pathContent=createPathContent(value=>value===ni?file:undefined);
  assert.equal((await pathContent.head(ni)).size,text.length);
  const corrupt=Buffer.from(text);corrupt[corrupt.length-1]=98;writeFileSync(file,corrupt);
  await assert.rejects(custody.head(ni),/declared ni identity/);
  await assert.rejects(custody.read(ni,{start:0,end:15}),/declared ni identity/);
  await assert.rejects(pathContent.head(ni),/declared ni identity/);
  await assert.rejects(pathContent.read(ni,{start:0,end:15}),/declared ni identity/);
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('copyOut streams verified bytes to a new file and refuses corrupt or clobbering copies',()=>{
 const root=mkdtempSync(join(tmpdir(),'copy-out-'));
 try{
  const source=join(root,'source.bin'),body=Buffer.alloc(200000,7);writeFileSync(source,body);
  const custody=createFileContentCustody({root:join(root,'held')});
  const reference=custody.retainFile(source);
  const out=join(root,'out.bin');
  assert.equal(custody.copyOut(reference.ni,out).byteLength,body.length);
  assert.deepEqual(readFileSync(out),body);
  assert.throws(()=>custody.copyOut(reference.ni,out),/EEXIST/);
  const held=join(root,'held','objects',reference.key);writeFileSync(held,Buffer.alloc(200000,8));
  const bad=join(root,'bad.bin');
  assert.throws(()=>custody.copyOut(reference.ni,bad),/declared ni identity/);
  assert.throws(()=>readFileSync(bad),/ENOENT/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
