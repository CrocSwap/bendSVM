import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {main,loaderInventory} from '../verification/check-loader.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';
const base='build/loader',receipt=`${base}/fresh-receipt.json`,output='build/loader-test.json';
if(fs.existsSync(output))fs.renameSync(output,`${output}.${Date.now()}.previous`);
await main();const saved=fs.readFileSync(receipt),before=loaderInventory(),processControls=[];
const python=process.env.PYTHON??'python3',location=spawnSync(python,['-c','import sys;print(sys.executable)'],{encoding:'utf8'});assert.equal(location.status,0);
const failed=path.resolve(`${base}/failed-python`);fs.writeFileSync(failed,`#!${location.stdout.trim()}\nprint('injected loader child failure')\nraise SystemExit(42)\n`,{mode:0o755});
for(const [name,env,reason] of [
 ['missing-python',{PYTHON:'/no-such-loader-python'},'/no-such-loader-python'],
 ['empty-report',{PYTHON:'/usr/bin/true'},'missing fresh child report'],
 ['failed-child',{PYTHON:failed},'injected loader child failure'],
 ['optimized-child',{PYTHONOPTIMIZE:'1'},'assertions required'],
] as const){
 fs.writeFileSync(receipt,saved);const old=new Set(fs.readdirSync(`${base}/runs`));
 const r=spawnSync(process.execPath,['verification/check-loader.ts'],{env:{...process.env,...env},encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
 const log=`${base}/${name}.log`;fs.writeFileSync(log,(r.stdout??'')+(r.stderr??''));assert.ifError(r.error);assert.equal(r.signal,null);assert.notEqual(r.status,0);assert.equal(fs.existsSync(receipt),false);
 const added=fs.readdirSync(`${base}/runs`).filter(n=>!old.has(n));assert.equal(added.length,1);const run=`${base}/runs/${added[0]}`,retired=`${run}/previous.json`;assert.deepEqual(fs.readFileSync(retired),saved);
 const logs=fs.readdirSync(run).filter(n=>n.endsWith('.log')).map(n=>`${run}/${n}`);assert.ok((fs.readFileSync(log,'utf8')+logs.map(p=>fs.readFileSync(p,'utf8')).join('\n')).includes(reason),name+' wrong failure');
 assert.deepEqual(loaderInventory(),before);processControls.push({name,exitCode:r.status,retired,retiredSha256:digest(saved),log,logSha256:digest(fs.readFileSync(log)),logs:logs.map(p=>({artifact:p,sha256:digest(fs.readFileSync(p))}))});
}
const accepted=await main(),run=path.dirname(accepted.inputArtifact),evidence=[];
for(const [name,script,arg,artifact] of [
 ['reports','tests/loader-reports.py',run,`${run}/report-controls.json`],
 ['inputs','tests/loader-inputs.py',run,`${run}/input-controls.json`],
 ['native','tests/loader-native.py',`${run}/native.json`,`${run}/native.json`],
 ['semantics','tests/loader-semantics.py',`${run}/semantics.json`,`${run}/semantics.json`],
 ['lemmas','tests/loader-lemmas.py',`${run}/lemmas.json`,`${run}/lemmas.json`],
]){
 const r=spawnSync(python,['-B',script,arg],{encoding:'utf8',timeout:240000,maxBuffer:8*1024*1024}),log=`${run}/${name}.log`;
 fs.writeFileSync(log,(r.stdout??'')+(r.stderr??''));assert.ifError(r.error);assert.equal(r.signal,null);assert.equal(r.status,0,log);
 const bytes=fs.readFileSync(artifact),report=JSON.parse(bytes.toString());assert.equal(report.passed,true);
 if(name!=='reports')assert.equal(report.inputSha256,accepted.inputSha256);if(name!=='inputs')assert.equal(report.reportSha256,accepted.reportSha256);
 evidence.push({artifact,sha256:digest(bytes),log,logSha256:digest(fs.readFileSync(log))});
}
assert.deepEqual(loaderInventory(),before);assert.equal(digest(fs.readFileSync(accepted.inputArtifact)),accepted.inputSha256);assert.equal(digest(fs.readFileSync(accepted.reportArtifact)),accepted.reportSha256);
fs.writeFileSync(output,JSON.stringify({passed:true,endToEndVerified:false,receipt:accepted,processControls,evidence},null,2)+'\n',{flag:'wx'});
console.log('Account decoder proof, process/report/input controls, native comparisons and semantic faults passed');
