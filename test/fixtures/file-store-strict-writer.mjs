import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const link=fs.linkSync,pause=new Int32Array(new SharedArrayBuffer(4));let waited=false;
fs.linkSync=function(from,to){
 if(String(to)===config.barrier&&!waited){
  waited=true;fs.writeFileSync(config.ready,'ready\n');const deadline=Date.now()+15000;
  while(!fs.existsSync(config.release)){
   if(Date.now()>deadline)throw new Error('file-store test barrier timed out');
   Atomics.wait(pause,0,0,5);
  }
 }
 return link.call(fs,from,to);
};
syncBuiltinESMExports();
const {createFileStoreSync}=await import('../../src/file-store.mjs');
try{
 const value=createFileStoreSync(config.root,{durableRoot:config.durableRoot}).putIfAbsent(config.key,{body:Buffer.from(config.body),mediaType:config.mediaType});
 process.stdout.write(JSON.stringify({ok:true,value,waited})+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code,message:error.message,waited})+'\n');}
