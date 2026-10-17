import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {writeFileTextSync} from '@red-cup-engineering/computer-file-engineering-services-section/write-file';
import {immutableContentKey} from './immutable-content-custody.mjs';
const KIND='content-reference.frontier.v1';
const address=id=>{if(id!==null)immutableContentKey(id);return id;};
const missing=error=>error?.code==='ENOENT';
const parse=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch(error){if(missing(error))return null;throw error;}};

/** A durable compare-and-publish content reference.
 * An exclusive immutable transition is the commit point. The current-reference file
 * is a disposable acceleration of that chain: a stale or missing cache cannot erase
 * a successful publication. There is no process lock or abandoned lock to reclaim. */
export function createFileContentReference(path,{transitions=path+'.transitions',durableRoot}={}){
 if(typeof path!=='string'||!path)throw new TypeError('a content reference needs its host-owned path');
 const stepPath=id=>join(transitions,(id===null?'empty':immutableContentKey(id).split('/').at(-1))+'.json');
 function read(){
  const cache=parse(path);
  if(cache!==null&&(cache.kind!==KIND||cache.content!==null&&typeof cache.content!=='string'))throw new TypeError('Invalid content reference frontier');
  let current=address(cache?.content??null);const seen=new Set();
  while(true){
   if(seen.has(current))throw new TypeError('Content reference has a publication cycle');seen.add(current);
   const step=parse(stepPath(current));if(step===null)return current;
   if(step.kind!==KIND||step.previous!==current||typeof step.content!=='string')throw new TypeError('Invalid content reference transition');
   current=address(step.content);
  }
 }
 function publish(expected,next){
  address(expected);address(next);if(next===null&&expected!==null)throw new TypeError('An admitted frontier cannot be cleared');
  if(read()!==expected)throw new TypeError('Persisted content reference changed before publication');
  if(expected===next){
   // Refreshing the disposable cache also makes completed admission renames durable.
   // A null reference marks empty custody without inventing a world.
   writeFileTextSync(path,JSON.stringify({kind:KIND,content:next})+'\n',{mode:0o600,...(durableRoot===undefined?{}:{durableRoot})});
   return Object.freeze({published:false,cacheUpdated:true});
  }
  try{writeFileTextSync(stepPath(expected),JSON.stringify({kind:KIND,previous:expected,content:next})+'\n',{flag:'wx',mode:0o600,...(durableRoot===undefined?{}:{durableRoot})});}
  catch(error){if(error?.code==='EEXIST')throw new TypeError('Persisted content reference changed before publication');throw error;}
  // Publication is already durable. A failed cache write leaves the same committed
  // result reachable from the prior reference and must not turn it into a refusal.
  let cacheUpdated=true;
  try{writeFileTextSync(path,JSON.stringify({kind:KIND,content:next})+'\n',{mode:0o600,...(durableRoot===undefined?{}:{durableRoot})});}catch{cacheUpdated=false;}
  return Object.freeze({published:true,cacheUpdated});
 }
 return Object.freeze({read,publish});
}

