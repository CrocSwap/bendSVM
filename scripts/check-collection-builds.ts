import fs from 'node:fs';
import assert from 'node:assert/strict';
import {buildProgram} from './program.ts';
const fixtures=[
  ['collection-store','tests/collection-store.bend','process','tests/collection-store.json'],
  ['collection-record','tests/collection-record.bend','process','tests/collection-record.json'],
  ['collection-cpi','tests/collection-cpi.bend','process','tests/collection-cpi.json'],
  ['queue','examples/queue/PROOF.bend','queue.process','examples/queue/storage.json'],
];
const dir=fs.mkdtempSync('build/collection-reproduce-');const results=[];
try {
 for(const [name,source,root,layout] of fixtures){
  const first=await buildProgram(source,root,`build/${name}`,layout);
  const second=await buildProgram(source,root,`${dir}/${name}`,layout);
  assert.deepEqual(second,first,`${name}: fresh build differs`);
  results.push({name,artifacts:first.artifacts,elfBytes:first.elfBytes});
 }
}finally{fs.rmSync(dir,{recursive:true,force:true});}
fs.writeFileSync('build/collection-reproducibility.json',JSON.stringify(results,null,2)+'\n');
console.log('Collection and queue public builds reproduce all artifacts, resource reports and manifests');
