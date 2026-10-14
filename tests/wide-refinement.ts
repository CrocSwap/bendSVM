import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

const digest=(file:string)=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const run=`build/wide-refinement-tests/${randomUUID()}`;
const output='build/wide-refinement-test.json';
fs.mkdirSync(run,{recursive:true});
if(fs.existsSync(output))fs.renameSync(output,`${run}/previous.json`);
const tests=['tests/wide-refinement.ts','tests/wide-process.py'];
const before=Object.fromEntries(tests.map(file=>[file,digest(file)]));
const logs=[];
for(const [name,command,args] of [
  ['positive',process.execPath,['verification/check-wide.ts']],
  ['process',process.env.PYTHON??'python3',['-B','tests/wide-process.py']],
] as const) {
  const result=spawnSync(command,[...args],{encoding:'utf8',timeout:1500000,maxBuffer:8*1024*1024});
  const log=`${run}/${name}.log`;
  fs.writeFileSync(log,(result.stdout??'')+(result.stderr??'')+(result.error?'\n'+String(result.error):''));
  assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,`${name} failed; ${log}`);
  logs.push({name,artifact:log,sha256:digest(log)});
}
const proof='build/wide-refinement.json',positive=JSON.parse(fs.readFileSync(proof,'utf8'));
for(const [file,hash] of Object.entries(positive.hashes))assert.equal(digest(file),hash);
assert.equal(positive.mutations.length,15);
const controls=JSON.parse(fs.readFileSync(`${run}/process.log`,'utf8'));
assert.equal(controls.passed,true);assert.equal(digest(controls.report),controls.sha256);
const report=JSON.parse(fs.readFileSync(controls.report,'utf8'));
assert.deepEqual(report.controls.map((row:any)=>row.name),['assertions-disabled','missing-python','empty-output','source-drift']);
assert.deepEqual(Object.fromEntries(tests.map(file=>[file,digest(file)])),before,'test source drift');
const accepted={passed:true,endToEndVerified:false,proof:{artifact:proof,sha256:digest(proof)},processControls:controls,testSourceHashes:before,logs};
const pending=path.join(run,'accepted.json');fs.writeFileSync(pending,JSON.stringify(accepted,null,2)+'\n');fs.renameSync(pending,output);
console.log('Wide source proofs, fifteen concrete source faults and four isolated process controls passed');
