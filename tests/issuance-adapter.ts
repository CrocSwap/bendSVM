import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
import {checkIssuanceAdapter} from '../verification/check-issuance-adapter.ts';
const receipt='build/issuance-adapter/fresh-receipt.json',output='build/issuance-adapter-test.json';
fs.rmSync(output,{force:true});fs.rmSync(output+'.pending',{force:true});
const reserved=spawnSync(process.env.PYTHON??'python3',['-B','tests/token-reserved-independence.py'],{stdio:'inherit',timeout:180000});
assert.ifError(reserved.error);assert.equal(reserved.signal,null);assert.equal(reserved.status,0);
await checkIssuanceAdapter();
const saved=fs.readFileSync(receipt);fs.writeFileSync('build/issuance-adapter/before-process-controls.json',saved);
const processControls=[];
for(const [name,python] of [['missing-python','/no-such-issuance-python'],['zero-exit-without-report','/usr/bin/true']]) {
 fs.writeFileSync(receipt,saved);
 const result=spawnSync(process.execPath,['verification/check-issuance-adapter.ts'],{env:{...process.env,PYTHON:python},encoding:'utf8',timeout:120000,maxBuffer:1<<22});
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);
 assert.equal(fs.existsSync(receipt),false);assert.equal(fs.existsSync(receipt+'.pending'),false);
 const log=`build/issuance-adapter/process-${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ok(result.stderr.includes(name==='missing-python'?python:'semantic-report.json'),'unexpected failure reason');
 processControls.push({name,log,logSha256:digest(fs.readFileSync(log))});
}
await checkIssuanceAdapter();
for(const [command,args] of [[process.execPath,['verification/check-token-frame.ts']],[process.env.PYTHON??'python3',['-B','tests/token-sequence-native.py']],[process.env.PYTHON??'python3',['-B','tests/issuance-adapter-sequence.py']],[process.env.PYTHON??'python3',['-B','tests/issuance-pending.py']],[process.env.PYTHON??'python3',['-B','tests/issuance-pending-process.py']],[process.env.PYTHON??'python3',['-B','tests/issuance-adapter-reports.py']],[process.execPath,['tests/issuance-adapter-native.ts']]] as const) {
 const result=spawnSync(command,[...args],{stdio:'inherit',timeout:180000});assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0);
}
const finalReceipt=JSON.parse(fs.readFileSync(receipt,'utf8'));
assert.deepEqual(inventory(),finalReceipt.sourceHashes,'source drift during focused tests');
const run=finalReceipt.inputArtifact.slice(0,-'/input.json'.length);
const evidence=[`${run}/report-controls.json`,`${run}/composed-replay-report.json`,'build/token-sequence-native/fresh-receipt.json','build/issuance-adapter-sequence/fresh-receipt.json','build/issuance-pending/fresh-receipt.json','build/issuance-pending/process-controls.json'].map(artifact=>{
 const bytes=fs.readFileSync(artifact),report=JSON.parse(bytes.toString());assert.equal(report.passed,true);
 return {artifact,sha256:digest(bytes)};
});
fs.writeFileSync(output+'.pending',JSON.stringify({passed:true,processControls,evidence,receipt:finalReceipt},null,2)+'\n');fs.renameSync(output+'.pending',output);
console.log('Issuance adapter proofs, report/process controls and native fault replays passed');
