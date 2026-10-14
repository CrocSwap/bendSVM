import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {main as exportInput,collectionInventory} from './export-collection-root.ts';
import {acceptProcess,digest} from './check-acyclic-lowering.ts';
export async function main(){
 const base='build/collection-root',receipt=`${base}/fresh-receipt.json`,run=`${base}/runs/${randomUUID()}`;
 fs.mkdirSync(run,{recursive:true});
 if(fs.existsSync(receipt))fs.renameSync(receipt,`${run}/previous.json`);
 const before=collectionInventory(),inputPath=await exportInput(run),raw=fs.readFileSync(inputPath),input=JSON.parse(raw.toString());
 assert.deepEqual(input.sourceHashes,before);assert.equal(input.runId,path.basename(run));
 const python=process.env.PYTHON??'python3',output=`${run}/semantic.json`;
 const child=spawnSync(python,['-B','verification/collection_root_semantic.py',inputPath,output],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 fs.writeFileSync(`${run}/proof.log`,(child.stdout??'')+(child.stderr??''));
 const report=acceptProcess(child,output);assert.equal(report.passed,true);assert.equal(report.endToEndVerified,false);
 assert.equal(report.runId,input.runId);assert.equal(report.inputSha256,digest(raw));assert.deepEqual(report.sourceHashes,before);
 const checked=spawnSync(python,['-B','verification/collection_root_report.py',inputPath,output],{encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/inventory.log`,(checked.stdout??'')+(checked.stderr??''));
 assert.ifError(checked.error);assert.equal(checked.signal,null);assert.equal(checked.status,0,'collection root report validation failed');
 assert.deepEqual(fs.readFileSync(inputPath),raw,'input drift');assert.deepEqual(collectionInventory(),before,'source drift');
 for(const [file,hash] of Object.entries({...input.artifactHashes,...input.program.sourceHashes}))assert.equal(digest(fs.readFileSync(file)),hash,'artifact/source drift');
 for(const item of Object.values(input.prerequisites) as {artifact:string,sha256:string}[])assert.equal(digest(fs.readFileSync(item.artifact)),item.sha256,'prerequisite drift');
 const accepted={passed:true,endToEndVerified:false,runId:input.runId,inputArtifact:inputPath,inputSha256:digest(raw),reportArtifact:output,
  reportSha256:digest(fs.readFileSync(output)),sourceHashes:before,logs:['composition.log','proof.log','inventory.log'].map(name=>({artifact:`${run}/${name}`,sha256:digest(fs.readFileSync(`${run}/${name}`))}))};
 const pending=`${run}/accepted.json`;fs.writeFileSync(pending,JSON.stringify(accepted,null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
 console.log('Fresh collection root composition accepted');return accepted;
}
if(import.meta.main)await main();
