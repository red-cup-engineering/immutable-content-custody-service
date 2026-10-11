import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCustodyFile} from '../scripts/custody-file.mjs';
test('a tree is one deterministic address and reads back byte for byte',()=>{
 const root=mkdtempSync(join(tmpdir(),'custody-script-'));
 try{
  const tree=join(root,'tree');mkdirSync(join(tree,'b'),{recursive:true});
  writeFileSync(join(tree,'a.txt'),'alpha');writeFileSync(join(tree,'b','c.txt'),'gamma');
  const held=join(root,'held');
  const first=runCustodyFile(['retain-tree','--root',held,'--dir',tree]);
  writeFileSync(join(tree,'a.txt'),'alpha');
  const second=runCustodyFile(['retain-tree','--root',held,'--dir',tree]);
  assert.equal(first.ni,second.ni);
  assert.equal(runCustodyFile(['verify','--root',held,'--ni',first.ni]).verified,true);
  const out=join(root,'out');runCustodyFile(['get-tree','--root',held,'--ni',first.ni,'--out',out]);
  assert.equal(readFileSync(join(out,'b','c.txt'),'utf8'),'gamma');
  const file=join(root,'f.bin');writeFileSync(file,'bytes');
  const reference=runCustodyFile(['retain','--root',held,'--file',file]);
  const copy=join(root,'copy.bin');runCustodyFile(['get','--root',held,'--ni',reference.ni,'--out',copy]);
  assert.equal(readFileSync(copy,'utf8'),'bytes');
 }finally{rmSync(root,{recursive:true,force:true});}
});
