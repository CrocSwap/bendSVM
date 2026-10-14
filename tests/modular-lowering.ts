import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {main} from '../verification/check-modular-lowering.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const receipt='build/modular-lowering/fresh-receipt.json',output='build/modular-lowering-test.json';
fs.rmSync(output,{force:true});fs.rmSync(output+'.pending',{force:true});
await main();const saved=fs.readFileSync(receipt),processControls=[];
for(const [name,python] of [['missing-python','/no-such-modular-python'],['zero-without-report','/usr/bin/true']]) {
 fs.writeFileSync(receipt,saved);
 const result=spawnSync(process.execPath,['verification/check-modular-lowering.ts'],{env:{...process.env,PYTHON:python},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);assert.equal(fs.existsSync(receipt),false);
 const log=`build/modular-lowering/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));processControls.push({name,log,logSha256:digest(fs.readFileSync(log))});
 assert.ok(result.stderr.includes(name==='missing-python'?python:'missing fresh child report'),'unexpected process failure; '+log);
}
await main();const accepted=JSON.parse(fs.readFileSync(receipt,'utf8')),run=accepted.reportArtifact.slice(0,-'/child.json'.length),evidence=[];
for(const [name,executable,script,artifact] of [
 ['controls',process.env.PYTHON??'python3','tests/modular-lowering-controls.py','controls.json'],
 ['native-arithmetic',process.env.PYTHON??'python3','tests/modular-native.py','native-arithmetic.json'],
 ['native-applications',process.execPath,'tests/modular-native-applications.ts','native-applications.json'],
]) {
 const result=spawnSync(executable,script.endsWith('.py')?['-B',script]:[script],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 const log=`${run}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,`${name} failed; ${log}`);
 const file=`${run}/${artifact}`,bytes=fs.readFileSync(file);assert.equal(JSON.parse(bytes.toString()).passed,true);evidence.push({artifact:file,sha256:digest(bytes),log,logSha256:digest(fs.readFileSync(log))});
}
assert.deepEqual(inventory(),accepted.sourceHashes,'source drift during focused tests');assert.equal(digest(fs.readFileSync(accepted.inputArtifact)),accepted.inputSha256);assert.equal(digest(fs.readFileSync(accepted.reportArtifact)),accepted.reportSha256);
fs.writeFileSync(output+'.pending',JSON.stringify({passed:true,receipt:accepted,processControls,evidence},null,2)+'\n');fs.renameSync(output+'.pending',output);
console.log('Modular proofs, report/process controls and native replays passed');
