import { constants, openSync, closeSync, readSync, writeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, renameSync, unlinkSync, existsSync, writeFileSync, linkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { immutableContentKey, IMMUTABLE_CONTENT_REFERENCE_PROFILE } from './immutable-content-custody.mjs';

const BLOCK = 64 * 1024;
const sameFile = (a,b) => a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs;
function regularFile(file) {
 const before=lstatSync(file,{bigint:true});
 if(!before.isFile())throw new TypeError('content custody requires a regular file');
 const descriptor=openSync(file,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
 try{
  const opened=fstatSync(descriptor,{bigint:true});
  if(!sameFile(before,opened))throw new TypeError('content changed before custody opened it');
  if(opened.size>BigInt(Number.MAX_SAFE_INTEGER))throw new RangeError('content size exceeds exact byte addressing');
  return {descriptor,before:opened,size:Number(opened.size)};
 }catch(error){closeSync(descriptor);throw error;}
}
function unchanged(file,opened) {
 if(!sameFile(opened.before,fstatSync(opened.descriptor,{bigint:true}))||!sameFile(opened.before,lstatSync(file,{bigint:true})))
  throw new TypeError('content changed while custody read it');
}
function rangeOf(range,size) {
 if(range===undefined)return undefined;
 if(!Number.isSafeInteger(range.start)||range.start<0||!Number.isSafeInteger(range.end)||range.end<range.start||range.start>=size)
  throw new RangeError('content range must address held bytes');
 return {start:range.start,end:Math.min(range.end,size-1)};
}

/** Verify the complete current body before exposing metadata, bytes or a Unicode window.
 * Retain only one I/O block and the explicitly requested output, never the full body.
 */
function scanContentFile(file,ni,{range,window}={}) {
 if(ni!==undefined)immutableContentKey(ni);
 const opened=regularFile(file),hash=createHash('sha256'),block=Buffer.alloc(BLOCK);
 try{
  const selected=rangeOf(range,opened.size);
  if(window!==undefined&&(!Number.isSafeInteger(window.offset)||window.offset<0||!Number.isSafeInteger(window.limit)||window.limit<1||window.limit>16384))
   throw new RangeError('text window must be bounded Unicode codepoints');
  const decoder=window===undefined?undefined:new TextDecoder('utf-8',{fatal:true});
  const bytes=selected===undefined?undefined:Buffer.alloc(selected.end-selected.start+1);
  let position=0,characters=0,text='',containsNul=false;
  const consume=value=>{
   for(const character of value){
    if(character==='\0')containsNul=true;
    if(characters>=window.offset&&characters-window.offset<window.limit)text+=character;
    characters++;
   }
  };
  while(position<opened.size){
   const count=readSync(opened.descriptor,block,0,Math.min(BLOCK,opened.size-position),position);
   if(!count)throw new TypeError('content ended before its declared bytes');
   const chunk=block.subarray(0,count);hash.update(chunk);
   if(bytes!==undefined){
    const start=Math.max(position,selected.start),end=Math.min(position+count,selected.end+1);
    if(start<end)chunk.copy(bytes,start-selected.start,start-position,end-position);
   }
   if(decoder)consume(decoder.decode(chunk,{stream:true}));
   position+=count;
  }
  if(decoder)consume(decoder.decode());
  unchanged(file,opened);
  const actual='ni:///sha-256;'+hash.digest('base64url');
  if(ni!==undefined&&actual!==ni)throw new TypeError('content bytes do not match their declared ni identity');
  return Object.freeze({ni:actual,size:opened.size,lastModified:new Date(Number(opened.before.mtimeNs/1000000n)),
   ...(bytes===undefined?{}:{bytes}),...(window===undefined?{}:{encoding:'unicode-codepoints',offset:window.offset,total:characters,text,containsNul})});
 }finally{closeSync(opened.descriptor);}
}

export const identifyContentFile=file=>scanContentFile(file);
export function verifyContentFile(file,ni,options){immutableContentKey(ni);return scanContentFile(file,ni,options);}

/** Native flatfile custody for existing large source/resource bodies, with raw RFC ni identity. */
export function createFileContentCustody({root,maximumBytes}={}) {
 if(typeof root!=='string'||!root.trim())throw new TypeError('file custody needs its host-owned root');
 if(maximumBytes!==undefined&&(!Number.isSafeInteger(maximumBytes)||maximumBytes<0))throw new RangeError('file custody byte budget must be exact and nonnegative');
 const base=resolve(root,'objects');mkdirSync(base,{recursive:true,mode:0o700});
 const fileOf=ni=>join(base,...immutableContentKey(ni).split('/'));
 return Object.freeze({
  retainFile(file,{expectedNi,mediaType='application/octet-stream'}={}){
   if(expectedNi!==undefined)immutableContentKey(expectedNi);
   const opened=regularFile(file),pending=join(base,'.pending-'+randomUUID()),hash=createHash('sha256'),block=Buffer.alloc(BLOCK);
   let output;
   try{
    if(maximumBytes!==undefined&&opened.size>maximumBytes)throw new RangeError('content exceeds the host-owned custody byte budget');
    output=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    let position=0;
    while(position<opened.size){
     const count=readSync(opened.descriptor,block,0,Math.min(BLOCK,opened.size-position),position);
     if(!count)throw new TypeError('content ended before its declared bytes');
     const chunk=block.subarray(0,count);hash.update(chunk);
     let written=0;while(written<count){const n=writeSync(output,chunk,written,count-written);if(!n)throw new Error('content custody write made no progress');written+=n;}
     position+=count;
    }
    unchanged(file,opened);
    const ni='ni:///sha-256;'+hash.digest('base64url');
    if(expectedNi!==undefined&&ni!==expectedNi)throw new TypeError('source differs from its admitted content identity');
    fsyncSync(output);closeSync(output);output=undefined;
    const target=fileOf(ni);mkdirSync(dirname(target),{recursive:true,mode:0o700});
    if(existsSync(target)){verifyContentFile(target,ni);unlinkSync(pending);}else renameSync(pending,target);
    writeFileSync(target+'.media-type',mediaType+'\n',{mode:0o600});
    verifyContentFile(target,ni);
    return Object.freeze({profile:IMMUTABLE_CONTENT_REFERENCE_PROFILE,ni,key:immutableContentKey(ni),byteLength:opened.size,mediaType});
   }finally{
    closeSync(opened.descriptor);if(output!==undefined)closeSync(output);
    try{unlinkSync(pending);}catch(error){if(error.code!=='ENOENT')throw error;}
   }
  },
  window(ni,{offset=0,limit=8192}={}){return verifyContentFile(fileOf(ni),ni,{window:{offset,limit}});},
  /** Stream the held body to a new file, hashing as it goes; a body that does not match its ni leaves nothing at `destination`. */
  copyOut(ni,destination){
   const source=fileOf(ni),opened=regularFile(source),pending=destination+'.pending-'+randomUUID(),hash=createHash('sha256'),block=Buffer.alloc(BLOCK);
   let output;
   try{
    output=openSync(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL,0o600);
    let position=0;
    while(position<opened.size){
     const count=readSync(opened.descriptor,block,0,Math.min(BLOCK,opened.size-position),position);
     if(!count)throw new TypeError('content ended before its declared bytes');
     const chunk=block.subarray(0,count);hash.update(chunk);
     let written=0;while(written<count){const n=writeSync(output,chunk,written,count-written);if(!n)throw new Error('content custody write made no progress');written+=n;}
     position+=count;
    }
    unchanged(source,opened);
    if('ni:///sha-256;'+hash.digest('base64url')!==ni)throw new TypeError('content bytes do not match their declared ni identity');
    fsyncSync(output);closeSync(output);output=undefined;
    linkSync(pending,destination);
    return Object.freeze({ni,byteLength:opened.size,destination});
   }finally{
    closeSync(opened.descriptor);if(output!==undefined)closeSync(output);
    try{unlinkSync(pending);}catch(error){if(error.code!=='ENOENT')throw error;}
   }
  },
  head(ni){return verifyContentFile(fileOf(ni),ni);},
  read(ni,range){return verifyContentFile(fileOf(ni),ni,{range}).bytes;},
 });
}

