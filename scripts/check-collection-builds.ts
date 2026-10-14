import fs from 'node:fs';
import {buildProgram} from './program.ts';
import { assertReproducibleProgramBuilds, programBuildSnapshot } from '../tests/program-build-reproducibility.ts';
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
  const secondStem=`${dir}/${name}`;
  const second=await buildProgram(source,root,secondStem,layout);
  assertReproducibleProgramBuilds(programBuildSnapshot(first,`build/${name}`),programBuildSnapshot(second,secondStem),`${name}: fresh build differs`);
  results.push({name,artifacts:first.artifacts,elfBytes:first.elfBytes});
 }
}finally{fs.rmSync(dir,{recursive:true,force:true});}
fs.writeFileSync('build/collection-reproducibility.json',JSON.stringify(results,null,2)+'\n');
console.log('Collection and queue public builds reproduce all artifacts, resource reports and manifests');
