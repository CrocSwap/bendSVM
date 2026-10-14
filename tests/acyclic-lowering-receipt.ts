import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {main,validate,acceptProcess,syntaxCheck} from '../verification/check-acyclic-lowering.ts';
const dir='build/acyclic-lowering',receipt=`${dir}/fresh-receipt.json`;
await main();
const base=JSON.parse(fs.readFileSync(receipt,'utf8')),raw=fs.readFileSync(base.inputArtifact),input=JSON.parse(raw.toString());
const rows:string[]=[];
for(const [name,mutate] of [
 ['C frontend evidence',(r:any)=>delete r.cSyntax],
 ['C frontend result',(r:any)=>r.cSyntax.units[0].exitCode=1],
 ['stale run',(r:any)=>r.runId='old'],['wrong solver',(r:any)=>r.z3='0'],
 ['false passed',(r:any)=>r.passed=false],['input hash',(r:any)=>r.inputSha256='0'.repeat(64)],
 ['missing source',(r:any)=>delete r.sourceHashes[Object.keys(r.sourceHashes)[0]]],
 ['missing fixture',(r:any)=>r.results.pop()],['extra fixture',(r:any)=>r.results.push(r.results[0])],
 ['wrong artifact',(r:any)=>r.results[0].cSha256='0'.repeat(64)],
 ['omitted claim',(r:any)=>r.results[0].claims.pop()],['duplicate claim',(r:any)=>r.results[0].claims.push(r.results[0].claims[0])],
 ['wrong root',(r:any)=>r.results[0].claims[0].function='not_root'],
 ['UNKNOWN claim',(r:any)=>r.results[0].claims[0].result='unknown'],
 ['SAT claim',(r:any)=>r.results[0].claims[0].result='sat'],
 ['negative guard count',(r:any)=>r.results[0].claims[0].CGuardObligations=-1],
 ['missing mutation',(r:any)=>r.mutations.pop()],['wrong mutation hash',(r:any)=>r.mutations[0].cSha256='0'.repeat(64)],
 ['UNKNOWN mutation',(r:any)=>r.mutations[0].claim.result='unknown'],
 ['empty witness',(r:any)=>r.mutations[0].claim.counterexample={}],
 ['empty replay args',(r:any)=>r.mutations[0].claim.wireArgs=[]],
 ['overstated scope',(r:any)=>r.scope='fully verified compiler'],
] as const) {
 const r=structuredClone(base);mutate(r);assert.throws(()=>validate(r,input,raw),undefined,name);rows.push(name);
}
const invalid=structuredClone(input.programs);
invalid[1].artifact.c=invalid[1].artifact.c.replace('return bend_Present_3c_U32_3e__make(a0);','bend_u32 bend_Present_3c_U32_3e__make = 0u; return bend_Present_3c_U32_3e__make(a0);');
const syntaxRun=fs.mkdtempSync(`${dir}/syntax-control-`);
assert.throws(()=>syntaxCheck(invalid,syntaxRun),/C frontend rejected/);
const output=`${dir}/process-fault.json`;fs.writeFileSync(output,JSON.stringify(base));
const processRows:string[]=['C frontend rejects hidden maker'];
for(const [name,script,timeout] of [
 ['nonzero','import sys;sys.exit(7)',1000],
 ['signal','import os,signal;os.kill(os.getpid(),signal.SIGTERM)',1000],
 ['timeout','import time;time.sleep(10)',50],
] as const) {
 const result=spawnSync(process.env.PYTHON??'python3',['-c',script],{encoding:'utf8',timeout});
 assert.throws(()=>acceptProcess(result,output),undefined,name);processRows.push(name);
}
const zero=spawnSync(process.env.PYTHON??'python3',['-c','pass'],{encoding:'utf8',timeout:1000});
fs.unlinkSync(output);assert.throws(()=>acceptProcess(zero,output));processRows.push('missing output');
fs.writeFileSync(output,'{');assert.throws(()=>acceptProcess(zero,output));processRows.push('malformed output');fs.unlinkSync(output);
// Exercise actual parent failure, including retirement of prior accepted evidence.
const old=fs.readFileSync(receipt),runs=`${dir}/runs`,before=new Set(fs.readdirSync(runs));
const failed=spawnSync(process.execPath,['verification/check-acyclic-lowering.ts'],{encoding:'utf8',env:{...process.env,PYTHON:'/usr/bin/false'},timeout:30000});
assert.notEqual(failed.status,0);assert.ok(!fs.existsSync(receipt));
const created=fs.readdirSync(runs).filter(r=>!before.has(r));assert.equal(created.length,1);
assert.deepEqual(fs.readFileSync(`${runs}/${created[0]}/previous.json`),old);processRows.push('parent nonzero retires prior receipt');
await main();
const frontendPrior=fs.readFileSync(receipt),frontendRuns=new Set(fs.readdirSync(runs));
const frontendFailure=spawnSync(process.execPath,['verification/check-acyclic-lowering.ts'],{encoding:'utf8',env:{...process.env,CC:'/usr/bin/false'},timeout:30000});
assert.notEqual(frontendFailure.status,0);assert.ok(!fs.existsSync(receipt));
const frontendCreated=fs.readdirSync(runs).filter(r=>!frontendRuns.has(r));assert.equal(frontendCreated.length,1);
assert.deepEqual(fs.readFileSync(`${runs}/${frontendCreated[0]}/previous.json`),frontendPrior);
processRows.push('frontend failure retires prior receipt');
await main();
const saved=fs.readFileSync(receipt),parked=`${dir}/runs-parked`;
assert.ok(!fs.existsSync(parked));fs.renameSync(runs,parked);fs.writeFileSync(runs,'obstruction');
try {
 const result=spawnSync(process.execPath,['verification/check-acyclic-lowering.ts'],{encoding:'utf8',timeout:30000});
 assert.notEqual(result.status,0);assert.ok(!fs.existsSync(receipt));
 const previous=fs.readdirSync(dir).filter(n=>n.startsWith('fresh-receipt.json.')&&n.endsWith('.previous'));
 assert.equal(previous.length,1);assert.deepEqual(fs.readFileSync(`${dir}/${previous[0]}`),saved);
 fs.renameSync(`${dir}/${previous[0]}`,`${dir}/setup-failure-preserved.json`);processRows.push('setup failure retires prior receipt');
} finally {fs.unlinkSync(runs);fs.renameSync(parked,runs);}
await main();
fs.writeFileSync(`${dir}/receipt-controls.json`,JSON.stringify({passed:true,reportRefusals:rows,processControls:processRows},null,2)+'\n');
console.log(`${rows.length} report refusals and ${processRows.length} process/setup controls passed`);
