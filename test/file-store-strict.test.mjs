import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import test from 'node:test';
import {spawn} from 'node:child_process';
import {createFileStoreSync, createFileStore} from '../src/file-store.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(join(tmpdir(),'strict-custody-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {root, path:join(root,'store/objects/a/key'), store:createFileStoreSync(join(root,'store'),{durableRoot:root})};
}
const input={body:Buffer.from('exact body'),mediaType:'application/json'};
function seed(f,{body=input.body,type=Buffer.from(input.mediaType+'\n')}={}) {
  fs.mkdirSync(dirname(f.path),{recursive:true});
  if(body!==null)fs.writeFileSync(f.path,body);
  if(type!==null)fs.writeFileSync(f.path+'.media-type',type);
}
function patched(changes,run) {
  const originals=[];
  for(const [object,name,fn] of changes){originals.push([object,name,object[name]]);object[name]=fn(object[name]);}
  syncBuiltinESMExports();
  try{return run();}finally{for(const [object,name,fn] of originals)object[name]=fn;syncBuiltinESMExports();}
}
function barriers(run,{fail}={}) {
  const paths=new Map(),events=[];
  const result=patched([
    [fs,'openSync',original=>function(path,...args){const fd=original.call(this,path,...args);paths.set(fd,String(path));return fd;}],
    [fs,'fsyncSync',original=>function(fd){const path=paths.get(fd);events.push(path);if(fail?.(path,events))throw Object.assign(new Error('injected sync refusal'),{code:'EIO'});return original.call(this,fd);}]
  ],()=>run(events));
  return {result,events};
}

for(const asyncShape of [false,true])test(`strict ${asyncShape?'async':'sync'} publication and duplicate return exact durability receipts`,async t=>{
  const f=fixture(t),store=asyncShape?createFileStore(join(f.root,'store'),{durableRoot:f.root}):f.store;
  assert.deepEqual(await store.putIfAbsent('a/key',input),{conflict:false,durable:true});
  const before=fs.statSync(f.path);
  assert.deepEqual(await store.putIfAbsent('a/key',input),{conflict:true,durable:true});
  assert.equal(fs.statSync(f.path).ino,before.ino);
  assert.deepEqual((await store.get('a/key')).body,input.body);
  assert.equal((await store.head('a/key')).mediaType,input.mediaType);
});

test('both existing files and every ancestor are synced again on duplicate',t=>{
  const f=fixture(t);seed(f);
  const {events}=barriers(()=>f.store.putIfAbsent('a/key',input));
  const ancestry=[dirname(f.path),dirname(dirname(f.path)),join(f.root,'store'),f.root];
  assert.deepEqual(events,[f.path,...ancestry,f.path+'.media-type',...ancestry]);
});

test('new absent representation admits default media and empty body',t=>{
  const f=fixture(t);
  assert.deepEqual(f.store.putIfAbsent('a/key',{body:Buffer.alloc(0)}),{conflict:false,durable:true});
  assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),'application/octet-stream\n');
});

for(const type of [null,Buffer.from('text/plain\n'),Buffer.from(' application/json \n')])test(`different body preserves metadata ${String(type)}`,t=>{
  const f=fixture(t);seed(f,{body:Buffer.from('different'),type});
  assert.throws(()=>f.store.putIfAbsent('a/key',input),{code:'ERR_CUSTODY_CONFLICT'});
  assert.equal(fs.readFileSync(f.path,'utf8'),'different');
  assert.equal(fs.existsSync(f.path+'.media-type'),type!==null);
});
for(const body of [null,input.body])for(const type of ['text/plain\n',' application/json \n','application/json'])test(`exact sidecar conflict refuses before body mutation: ${body===null}/${JSON.stringify(type)}`,t=>{
  const f=fixture(t);seed(f,{body,type:Buffer.from(type)});
  assert.throws(()=>f.store.putIfAbsent('a/key',input),{code:'ERR_CUSTODY_CONFLICT'});
  assert.equal(fs.existsSync(f.path),body!==null);
  assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),type);
});
test('matching sidecar-only representation can acquire missing body',t=>{
  const f=fixture(t);seed(f,{body:null});
  assert.deepEqual(f.store.putIfAbsent('a/key',input),{conflict:false,durable:true});
});
test('body-only recovery requires explicit expected type then reestablishes barriers',t=>{
  const f=fixture(t);seed(f,{type:null});const ino=fs.statSync(f.path).ino;
  assert.throws(()=>f.store.putIfAbsent('a/key',{body:input.body}),{code:'ERR_CUSTODY_MEDIA_TYPE_REQUIRED'});
  assert.equal(fs.existsSync(f.path+'.media-type'),false);
  assert.deepEqual(f.store.putIfAbsent('a/key',input),{conflict:true,durable:true});
  assert.equal(fs.statSync(f.path).ino,ino);
});
for(const mediaType of ['','Text/Plain',' text/plain','text/plain\r\nx:y','broken','text/plain; bad','text/plain;'+ 'a'.repeat(4096),null])test(`invalid media refuses before directory creation: ${String(mediaType).slice(0,50)}`,t=>{
  const f=fixture(t);assert.throws(()=>f.store.putIfAbsent('a/key',{body:input.body,mediaType}));assert.equal(fs.existsSync(join(f.root,'store')),false);
});
for(const key of ['.','a/..','../escape','a//key','a/./key','a/key.media-type'])test(`invalid strict key ${key}`,t=>{
  const f=fixture(t);assert.throws(()=>f.store.putIfAbsent(key,input));assert.equal(fs.existsSync(join(f.root,'store')),false);
});
test('strict putCurrent rejects before any filesystem call',t=>{
  const f=fixture(t);
  patched([[fs,'openSync',()=>()=>{throw new Error('must not open');}]],()=>assert.throws(()=>f.store.putCurrent('a/key',input),{code:'ERR_CUSTODY_REPLACEMENT_UNSUPPORTED'}));
  assert.equal(fs.existsSync(join(f.root,'store')),false);
});

test('root containment and missing anchor refuse before mutation',t=>{
  const f=fixture(t);
  for(const durableRoot of [join(f.root,'missing'),'relative',join(f.root,'other')]){
    if(durableRoot.endsWith('other'))fs.mkdirSync(durableRoot);
    assert.throws(()=>createFileStoreSync(join(f.root,'store'),{durableRoot}).putIfAbsent('a/key',input));
  }
  assert.equal(fs.existsSync(join(f.root,'store')),false);
});
for(const where of ['ancestor','body','sidecar'])test(`symlink ${where} rejected before publication`,t=>{
  const f=fixture(t);fs.mkdirSync(join(f.root,'target'));fs.writeFileSync(join(f.root,'target/file'),'unchanged');
  if(where==='ancestor')fs.symlinkSync(join(f.root,'target'),join(f.root,'store'));
  else{fs.mkdirSync(dirname(f.path),{recursive:true});fs.symlinkSync(join(f.root,'target/file'),f.path+(where==='sidecar'?'.media-type':''));}
  assert.throws(()=>f.store.putIfAbsent('a/key',input));
  assert.equal(fs.readFileSync(join(f.root,'target/file'),'utf8'),'unchanged');
  if(where==='sidecar')assert.equal(fs.existsSync(f.path),false);
});
for(const where of ['body','sidecar'])test(`nonregular ${where} refused`,t=>{
  const f=fixture(t);fs.mkdirSync(f.path+(where==='sidecar'?'.media-type':''),{recursive:true});
  assert.throws(()=>f.store.putIfAbsent('a/key',input));if(where==='sidecar')assert.equal(fs.existsSync(f.path),false);
});
test('sidecar different-device admission refuses before body publication',t=>{
  const f=fixture(t);seed(f,{body:null});
  patched([[fs,'lstatSync',original=>function(path,...args){const stat=original.call(this,path,...args);if(String(path)===f.path+'.media-type')stat.dev+=1;return stat;}]],()=>assert.throws(()=>f.store.putIfAbsent('a/key',input),/anchor filesystem/));
  assert.equal(fs.existsSync(f.path),false);
});

for(const phase of ['body-write','sidecar-write','body-file-sync','sidecar-file-sync','body-ancestry','sidecar-ancestry'])test(`uncertain ${phase} failure refuses and exact retry succeeds`,t=>{
  const f=fixture(t),fault=Object.assign(new Error('injected '+phase),{code:'EIO'}),paths=new Map();let fired=false;
  const maybe=(path)=>{
    if(fired)return false;
    const temp=path?.includes('/.key.'),sideTemp=path?.includes('/.key.media-type.');
    const hit=phase==='body-write'&&temp || phase==='sidecar-write'&&sideTemp || phase==='body-file-sync'&&temp || phase==='sidecar-file-sync'&&sideTemp || phase==='body-ancestry'&&path===f.root || phase==='sidecar-ancestry'&&path===f.root&&fs.existsSync(f.path+'.media-type');
    if(hit)fired=true;return hit;
  };
  patched([
    [fs,'openSync',original=>function(path,...args){const fd=original.call(this,path,...args);paths.set(fd,String(path));return fd;}],
    [fs,'writeFileSync',original=>function(fd,...args){if(phase.endsWith('write')&&maybe(paths.get(fd)))throw fault;return original.call(this,fd,...args);} ],
    [fs,'fsyncSync',original=>function(fd){if(!phase.endsWith('write')&&maybe(paths.get(fd)))throw fault;return original.call(this,fd);}]
  ],()=>assert.throws(()=>f.store.putIfAbsent('a/key',input),error=>error===fault));
  assert.equal(fired,true);const bodyWasPresent=fs.existsSync(f.path);
  assert.deepEqual(f.store.putIfAbsent('a/key',input),{conflict:bodyWasPresent,durable:true});
  assert.deepEqual(fs.readFileSync(f.path),input.body);assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),input.mediaType+'\n');
});
for(const sidecar of [false,true])test(`EEXIST ${sidecar?'sidecar':'body'} race compares exact bytes and repeats barriers`,t=>{
  const f=fixture(t),target=f.path+(sidecar?'.media-type':'');let raced=false;
  patched([[fs,'linkSync',original=>function(from,to){if(String(to)===target&&!raced){raced=true;fs.writeFileSync(target,sidecar?input.mediaType+'\n':input.body);}return original.call(this,from,to);}]],()=>{
    assert.deepEqual(f.store.putIfAbsent('a/key',input),{conflict:!sidecar,durable:true});
  });assert.equal(raced,true);
});
test('incompatible EEXIST metadata race never yields success',t=>{
  const f=fixture(t);let raced=false;
  patched([[fs,'linkSync',original=>function(from,to){if(String(to)===f.path+'.media-type'&&!raced){raced=true;fs.writeFileSync(to,'text/plain\n');}return original.call(this,from,to);}]],()=>assert.throws(()=>f.store.putIfAbsent('a/key',input),{code:'ERR_CUSTODY_CONFLICT'}));
  assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),'text/plain\n');
});
test('foreign temporary collision preserves foreign inode and refuses',t=>{
  const f=fixture(t);fs.mkdirSync(dirname(f.path),{recursive:true});const temp=join(dirname(f.path),`.key.${process.pid}.fixed.tmp`);fs.writeFileSync(temp,'foreign');const ino=fs.statSync(temp).ino;
  patched([[crypto,'randomUUID',()=>()=> 'fixed']],()=>assert.throws(()=>f.store.putIfAbsent('a/key',input),{code:'EEXIST'}));
  assert.equal(fs.readFileSync(temp,'utf8'),'foreign');assert.equal(fs.statSync(temp).ino,ino);assert.equal(fs.existsSync(f.path),false);
});
test('duplicate readable files cannot bypass a barrier failure',t=>{
  const f=fixture(t);seed(f);
  assert.throws(()=>barriers(()=>f.store.putIfAbsent('a/key',input),{fail:path=>path===f.path+'.media-type'}),{code:'EIO'});
  assert.deepEqual(f.store.putIfAbsent('a/key',input),{conflict:true,durable:true});
});

test('async errors remain promise rejections for conflicts and unsupported replacement',async t=>{
  const f=fixture(t);seed(f);const store=createFileStore(join(f.root,'store'),{durableRoot:f.root});
  await assert.rejects(store.putIfAbsent('a/key',{...input,body:Buffer.from('different')}),{code:'ERR_CUSTODY_CONFLICT'});
  await assert.rejects(store.putCurrent('a/key',input),{code:'ERR_CUSTODY_REPLACEMENT_UNSUPPORTED'});
  assert.deepEqual(fs.readFileSync(f.path),input.body);
});
test('strict unsupported directory sync never downgrades to default behavior',t=>{
  const f=fixture(t);seed(f);const paths=new Map();
  patched([
    [fs,'openSync',original=>function(path,...args){const fd=original.call(this,path,...args);paths.set(fd,String(path));return fd;}],
    [fs,'fsyncSync',original=>function(fd){if(paths.get(fd)===f.root)throw Object.assign(new Error('unsupported'),{code:'ENOTSUP'});return original.call(this,fd);}]
  ],()=>assert.throws(()=>f.store.putIfAbsent('a/key',input),{code:'ENOTSUP'}));
});
test('opened descriptor device is checked before any sidecar bytes are read',t=>{
  const f=fixture(t);seed(f,{body:null});const paths=new Map();let sidecarRead=false;
  patched([
    [fs,'openSync',original=>function(path,...args){const fd=original.call(this,path,...args);paths.set(fd,String(path));return fd;}],
    [fs,'fstatSync',original=>function(fd,...args){const stat=original.call(this,fd,...args);if(paths.get(fd)===f.path+'.media-type')stat.dev+=1;return stat;}],
    [fs,'readFileSync',original=>function(fd,...args){if(paths.get(fd)===f.path+'.media-type')sidecarRead=true;return original.call(this,fd,...args);}]
  ],()=>assert.throws(()=>f.store.putIfAbsent('a/key',input),/anchor filesystem/));
  assert.equal(sidecarRead,false);assert.equal(fs.existsSync(f.path),false);
});
test('real durable body without metadata is recoverable only with explicit type',t=>{
  const f=fixture(t);f.store.putIfAbsent('a/key',input);fs.unlinkSync(f.path+'.media-type');
  assert.throws(()=>f.store.putIfAbsent('a/key',{body:input.body}),{code:'ERR_CUSTODY_MEDIA_TYPE_REQUIRED'});
  assert.deepEqual(f.store.putIfAbsent('a/key',input),{conflict:true,durable:true});
});

async function competingWriters(f,inputs,{sidecar=false,releaseOrder}={}) {
  const children=[],pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const waitReady=async child=>{const deadline=Date.now()+15000;while(!fs.existsSync(child.ready)){if(child.child.exitCode!==null||Date.now()>deadline)throw new Error('strict writer failed to reach publication boundary');await pause(5);}};
  try {
    for(const [index,input] of inputs.entries()) {
      const ready=join(f.root,'ready-'+index),gate=join(f.root,'release-'+(releaseOrder?index:'all')),config=join(f.root,'input-'+index+'.json');
      fs.writeFileSync(config,JSON.stringify({root:join(f.root,'store'),durableRoot:f.root,key:'a/key',ready,release:gate,barrier:f.path+(sidecar?'.media-type':''),...input}));
      const child=spawn(process.execPath,[new URL('./fixtures/file-store-strict-writer.mjs',import.meta.url).pathname,config],{stdio:['ignore','pipe','pipe']});
      let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
      const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
      const current={child,done,ready,gate};children.push(current);
      if(releaseOrder&&index===0)await waitReady(current);
    }
    await Promise.all(children.map(waitReady));
    if(releaseOrder){for(const index of releaseOrder){fs.writeFileSync(children[index].gate,'release\n');await children[index].done;}}
    else fs.writeFileSync(children[0].gate,'release\n');
    return await Promise.all(children.map(async child=>{const r=await child.done;assert.equal(r.code,0,r.stderr+r.stdout);const value=JSON.parse(r.stdout);assert.equal(value.waited,true);return value;}));
  }finally{for(const {child} of children)if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
test('independent strict processes competing for identical bytes/type both receive durable custody',async t=>{
  const f=fixture(t),values=await competingWriters(f,[{body:'held',mediaType:'application/json'},{body:'held',mediaType:'application/json'}]);
  t.diagnostic(JSON.stringify({outcomes:values,body:fs.readFileSync(f.path,'utf8'),sidecar:fs.readFileSync(f.path+'.media-type','utf8')}));
  assert.ok(values.every(v=>v.ok&&v.value.durable===true));assert.deepEqual(values.map(v=>v.value.conflict).sort(),[false,true]);
  assert.equal(fs.readFileSync(f.path,'utf8'),'held');assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),'application/json\n');
});
test('independent strict processes with incompatible bodies preserve exactly one representation',async t=>{
  const f=fixture(t),inputs=[{body:'first',mediaType:'application/json'},{body:'second',mediaType:'text/plain'}],values=await competingWriters(f,inputs);
  t.diagnostic(JSON.stringify({outcomes:values,body:fs.readFileSync(f.path,'utf8'),sidecar:fs.readFileSync(f.path+'.media-type','utf8')}));
  assert.equal(values.filter(v=>v.ok).length,1);const winner=values.findIndex(v=>v.ok);
  assert.deepEqual(values[winner].value,{conflict:false,durable:true});assert.equal(values[1-winner].code,'ERR_CUSTODY_CONFLICT');
  assert.equal(fs.readFileSync(f.path,'utf8'),inputs[winner].body);assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),inputs[winner].mediaType+'\n');
});
test('independent strict processes with incompatible types preserve first sidecar and reject its contender',async t=>{
  const f=fixture(t),inputs=[{body:'held',mediaType:'application/json'},{body:'held',mediaType:'text/plain'}],values=await competingWriters(f,inputs,{sidecar:true});
  t.diagnostic(JSON.stringify({outcomes:values,body:fs.readFileSync(f.path,'utf8'),sidecar:fs.readFileSync(f.path+'.media-type','utf8')}));
  assert.equal(values.filter(v=>v.ok).length,1);const winner=values.findIndex(v=>v.ok);
  assert.equal(values[winner].value.durable,true);assert.equal(values[1-winner].code,'ERR_CUSTODY_CONFLICT');
  assert.equal(fs.readFileSync(f.path,'utf8'),'held');assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),inputs[winner].mediaType+'\n');
});
test('strict body publisher refuses when a competing process retains incompatible metadata first',async t=>{
  const f=fixture(t),values=await competingWriters(f,[{body:'held',mediaType:'application/json'},{body:'held',mediaType:'text/plain'}],{sidecar:true,releaseOrder:[1,0]});
  t.diagnostic(JSON.stringify({outcomes:values,body:fs.readFileSync(f.path,'utf8'),sidecar:fs.readFileSync(f.path+'.media-type','utf8')}));
  assert.equal(values[0].ok,false);assert.equal(values[0].code,'ERR_CUSTODY_CONFLICT');assert.deepEqual(values[1].value,{conflict:true,durable:true});
  assert.equal(fs.readFileSync(f.path,'utf8'),'held');assert.equal(fs.readFileSync(f.path+'.media-type','utf8'),'text/plain\n');
});
