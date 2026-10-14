import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {main} from '../verification/check-signed-lowering.ts';
import {digest,inventory} from '../verification/check-acyclic-lowering.ts';
const directory='build/signed-lowering',receipt=`${directory}/fresh-receipt.json`,output='build/signed-lowering-test.json';
if(fs.existsSync(output))fs.renameSync(output,`${output}.${Date.now()}.previous`);
await main();
const saved=fs.readFileSync(receipt),before=inventory(),processControls=[];
for(const [name,env,reason] of [
 ['missing-python',{PYTHON:'/no-such-signed-python'},'/no-such-signed-python'],
 ['zero-without-report',{PYTHON:'/usr/bin/true'},'missing fresh child report'],
 ['disabled-assertions',{PYTHONOPTIMIZE:'1'},'signed proof requires Python assertions'],
 ['missing-frontend',{CC:'/no-such-signed-clang'},'/no-such-signed-clang'],
] as const){
 fs.writeFileSync(receipt,saved);
 const old=new Set(fs.readdirSync(`${directory}/runs`));
 const result=spawnSync(process.execPath,['verification/check-signed-lowering.ts'],{env:{...process.env,...env},encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024});
 const log=`${directory}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0);assert.equal(fs.existsSync(receipt),false);
 const runs=fs.readdirSync(`${directory}/runs`).filter(n=>!old.has(n));assert.equal(runs.length,1);
 const run=`${directory}/runs/${runs[0]}`,retired=`${run}/previous.json`;assert.deepEqual(fs.readFileSync(retired),saved);
 const logs=fs.readdirSync(run).filter(n=>n.endsWith('.log')).map(n=>`${run}/${n}`);
 const combined=fs.readFileSync(log,'utf8')+logs.map(p=>fs.readFileSync(p,'utf8')).join('\n');assert.ok(combined.includes(reason),name+' wrong failure');
 assert.deepEqual(inventory(),before);
 processControls.push({name,exitCode:result.status,retired,retiredSha256:digest(fs.readFileSync(retired)),log,logSha256:digest(fs.readFileSync(log)),logs:logs.map(p=>({artifact:p,sha256:digest(fs.readFileSync(p))}))});
}
await main();
const accepted=JSON.parse(fs.readFileSync(receipt,'utf8')),run=path.dirname(accepted.reportArtifact),evidence=[];
for(const [name,script,artifact] of [
 ['reports','tests/signed-reports.py',`${run}/report-controls.json`],
 ['source-faults','tests/signed-semantics.py',`${run}/source-controls.json`],
 ['C-faults','tests/signed-c-faults.py',`${run}/c-faults.json`],
 ['native','tests/signed-native.py','build/signed-native/fresh-receipt.json'],
]){
 const result=spawnSync(script.endsWith('.py')?(process.env.PYTHON??'python3'):process.execPath,script.endsWith('.py')?['-B',script]:[script],{env:{...process.env,SIGNED_INPUT:accepted.inputArtifact,SIGNED_SEMANTICS_REPORT:`${run}/source-controls.json`},encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 const log=`${run}/${name}.log`;fs.writeFileSync(log,(result.stdout??'')+(result.stderr??''));assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,log);
 const bytes=fs.readFileSync(artifact),report=JSON.parse(bytes.toString());assert.equal(report.passed,true);assert.equal(report.inputSha256,accepted.inputSha256);if(name==='reports')assert.equal(report.reportSha256,accepted.reportSha256);
 evidence.push({artifact,sha256:digest(bytes),log,logSha256:digest(fs.readFileSync(log))});
}
assert.deepEqual(inventory(),accepted.sourceHashes);assert.equal(digest(fs.readFileSync(accepted.inputArtifact)),accepted.inputSha256);assert.equal(digest(fs.readFileSync(accepted.reportArtifact)),accepted.reportSha256);
fs.writeFileSync(output+'.pending',JSON.stringify({passed:true,endToEndVerified:false,receipt:accepted,processControls,evidence},null,2)+'\n');fs.renameSync(output+'.pending',output);
console.log('Signed semantics/C proofs, report/process controls and native comparisons passed');
