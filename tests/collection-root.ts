import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest} from '../verification/check-acyclic-lowering.ts';
import {collectionInventory} from '../verification/export-collection-root.ts';
const output='build/collection-root-test.json';
if(fs.existsSync(output))fs.renameSync(output,`${output}.${Date.now()}.previous`);
await import('./collection-root-process.ts');
const controlsPath='build/collection-root/process-controls.json',controlsRaw=fs.readFileSync(controlsPath),controls=JSON.parse(controlsRaw.toString());
assert.equal(controls.passed,true);
const receipt=controls.receipt,run=path.dirname(receipt.inputArtifact),evidence=[];
assert.equal(digest(fs.readFileSync(receipt.inputArtifact)),receipt.inputSha256);
assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
for(const [name,script,cases] of [
 ['native-caller','tests/collection-root-native.py',160],
 ['native-bytes','tests/collection-root-bytes.py',61440],
 ['bindings','tests/collection-root-bindings.py',undefined],
] as const){
 const artifact=`${run}/${name}.json`,log=`${run}/${name}.log`;
 const result=spawnSync(process.env.PYTHON??'python3',['-B',script,receipt.inputArtifact,receipt.reportArtifact,artifact],{encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,log);
 const raw=fs.readFileSync(artifact),report=JSON.parse(raw.toString());assert.equal(report.passed,true);assert.equal(report.inputSha256,receipt.inputSha256);assert.equal(report.reportSha256,receipt.reportSha256);
 if(cases!==undefined){assert.equal(report.cases,cases);assert.equal(report.replays.length,4);}
 else {assert.equal(report.controls.length,29);assert.equal(report.inactive.length,7);}
 evidence.push({artifact,sha256:digest(raw),log,logSha256:digest(fs.readFileSync(log))});
}
assert.deepEqual(collectionInventory(),receipt.sourceHashes);assert.deepEqual(fs.readFileSync(controlsPath),controlsRaw);
assert.equal(digest(fs.readFileSync(receipt.inputArtifact)),receipt.inputSha256);assert.equal(digest(fs.readFileSync(receipt.reportArtifact)),receipt.reportSha256);
fs.writeFileSync(output,JSON.stringify({passed:true,endToEndVerified:false,receipt,processReport:{artifact:controlsPath,sha256:digest(controlsRaw)},evidence},null,2)+'\n',{flag:'wx'});
console.log('Collection root proof, process/report/binding controls and native comparisons passed');
