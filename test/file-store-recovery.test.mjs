import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {createFileStoreSync} from '../src/file-store.mjs';
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'file-store-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store:createFileStoreSync(root),body:path.join(root,'objects','one','key')};}
function publishBody(f,body='held'){fs.mkdirSync(path.dirname(f.body),{recursive:true});fs.writeFileSync(f.body,body);}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function concurrent(f,inputs,{sidecar=false,releaseOrder}={}){
 const release=path.join(f.root,'release'),children=[];
 for(const [index,input] of inputs.entries()){
  const ready=path.join(f.root,'ready-'+index),config=path.join(f.root,'writer-'+index+'.json'),gate=releaseOrder?release+'-'+index:release;
  fs.writeFileSync(config,JSON.stringify({root:f.root,key:'one/key',ready,release:gate,barrier:f.body+(sidecar?'.media-type':''),...input}));
  const child=spawn(process.execPath,[new URL('./fixtures/file-store-writer.mjs',import.meta.url).pathname,config],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',data=>{stdout+=data;});child.stderr.on('data',data=>{stderr+=data;});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
  children.push({child,done,ready,gate});
  if(releaseOrder&&index===0){const deadline=Date.now()+15000;while(!fs.existsSync(ready)){if(Date.now()>deadline)throw new Error('first writer did not publish body');await pause(5);}}
 }
 try{
  const deadline=Date.now()+15000;
  while(children.some(child=>!fs.existsSync(child.ready))){if(Date.now()>deadline)throw new Error('writers did not reach native publication boundary');await pause(5);}
  if(releaseOrder){for(const index of releaseOrder){fs.writeFileSync(children[index].gate,'release\n');await children[index].done;}}
  else fs.writeFileSync(release,'release\n');
  return await Promise.all(children.map(async child=>{const result=await child.done;assert.equal(result.code,0,result.stderr+result.stdout);const value=JSON.parse(result.stdout);assert.equal(value.waited,true);return value;}));
 }finally{for(const {child} of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}

test('same exact body heals an absent sidecar without replacing body custody',t=>{
 const f=fixture(t);publishBody(f);const before=fs.statSync(f.body);
 assert.deepEqual(f.store.putIfAbsent('one/key',{body:Buffer.from('held'),mediaType:'application/json'}),{conflict:true});
 assert.equal(fs.statSync(f.body).ino,before.ino);assert.equal(fs.statSync(f.body).mtimeMs,before.mtimeMs);
 assert.equal(f.store.get('one/key').mediaType,'application/json');assert.equal(f.store.get('one/key').body.toString(),'held');
});

test('different bytes preserve first-body conflict and cannot manufacture missing metadata',t=>{
 const f=fixture(t);publishBody(f);
 assert.deepEqual(f.store.putIfAbsent('one/key',{body:Buffer.from('different'),mediaType:'text/plain'}),{conflict:true});
 assert.equal(fs.existsSync(f.body+'.media-type'),false);assert.equal(fs.readFileSync(f.body,'utf8'),'held');
});

test('identical bytes report conflict without replacing an incompatible retained media type',t=>{
 const f=fixture(t);f.store.putIfAbsent('one/key',{body:Buffer.from('held'),mediaType:'application/json'});
 const body=fs.readFileSync(f.body),sidecar=fs.readFileSync(f.body+'.media-type');
 assert.deepEqual(f.store.putIfAbsent('one/key',{body,mediaType:'text/plain'}),{conflict:true});
 assert.deepEqual(fs.readFileSync(f.body),body);assert.deepEqual(fs.readFileSync(f.body+'.media-type'),sidecar);
 assert.deepEqual(f.store.putIfAbsent('one/key',{body,mediaType:'application/json'}),{conflict:true});
});

test('two matching writers race at atomic sidecar publication and preserve the same bytes and media',async t=>{
 const f=fixture(t),values=await concurrent(f,[{body:'held',mediaType:'application/json'},{body:'held',mediaType:'application/json'}],{sidecar:true});
 assert.ok(values.every(value=>value.ok));assert.deepEqual(values.map(value=>value.value.conflict).sort(),[false,true]);
 assert.equal(f.store.get('one/key').body.toString(),'held');assert.equal(f.store.get('one/key').mediaType,'application/json');
});

test('concurrent incompatible sidecars preserve the first metadata and report ordinary conflicts',async t=>{
 const f=fixture(t),values=await concurrent(f,[{body:'held',mediaType:'application/json'},{body:'held',mediaType:'text/plain'}],{sidecar:true});
 assert.ok(values.every(value=>value.ok));
 const held=f.store.get('one/key'),winner=['application/json','text/plain'].indexOf(held.mediaType);
 assert.notEqual(winner,-1);assert.equal(values[1-winner].value.conflict,true);
 assert.equal(held.body.toString(),'held');
});

test('the body winner reports conflict when another writer wins incompatible metadata',async t=>{
 const f=fixture(t),values=await concurrent(f,[{body:'held',mediaType:'application/json'},{body:'held',mediaType:'text/plain'}],{sidecar:true,releaseOrder:[1,0]});
 assert.ok(values.every(value=>value.ok));assert.deepEqual(values.map(value=>value.value),[{conflict:true},{conflict:true}]);
 assert.equal(f.store.get('one/key').body.toString(),'held');assert.equal(f.store.get('one/key').mediaType,'text/plain');
});

test('concurrent different bodies retain the first body and only its own media type',async t=>{
 const f=fixture(t),values=await concurrent(f,[{body:'first candidate',mediaType:'application/json'},{body:'second candidate',mediaType:'text/plain'}]);
 assert.ok(values.every(value=>value.ok));assert.deepEqual(values.map(value=>value.value.conflict).sort(),[false,true]);
 const winner=values.findIndex(value=>value.value.conflict===false),held=f.store.get('one/key');
 assert.equal(held.body.toString(),['first candidate','second candidate'][winner]);assert.equal(held.mediaType,['application/json','text/plain'][winner]);
});

test('matching retained media is read under its existing semantics without rewriting its sidecar',t=>{
 const f=fixture(t);publishBody(f);fs.writeFileSync(f.body+'.media-type',' application/json \n');
 const bytes=fs.readFileSync(f.body+'.media-type'),before=fs.statSync(f.body+'.media-type');
 assert.deepEqual(f.store.putIfAbsent('one/key',{body:Buffer.from('held'),mediaType:'application/json'}),{conflict:true});
 assert.deepEqual(fs.readFileSync(f.body+'.media-type'),bytes);
 assert.equal(fs.statSync(f.body+'.media-type').ino,before.ino);assert.equal(fs.statSync(f.body+'.media-type').mtimeMs,before.mtimeMs);
 assert.equal(f.store.get('one/key').mediaType,'application/json');
});
