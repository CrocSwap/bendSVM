import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {main,validate} from '../verification/check-vault-c.ts';
import {acceptProcess} from '../verification/check-acyclic-lowering.ts';
const receipt='build/vault-c-refinement.json',runs='build/vault-c';
await main();const base=JSON.parse(fs.readFileSync(receipt,'utf8')),raw=fs.readFileSync(base.inputArtifact),input=JSON.parse(raw.toString());
const rows=[];
for(const [name,change] of [
 ['stale run',(r:any)=>r.runId='old'],['wrong solver',(r:any)=>r.z3='old'],['false passed',(r:any)=>r.passed=false],
 ['input hash',(r:any)=>r.inputSha256='0'.repeat(64)],['source omission',(r:any)=>delete r.sourceHashes[Object.keys(r.sourceHashes)[0]]],
 ['C hash',(r:any)=>r.cSha256='0'.repeat(64)],['C syntax omission',(r:any)=>delete r.cSyntax],
 ['equivalence omission',(r:any)=>r.equivalence=[]],['equivalence UNKNOWN',(r:any)=>r.equivalence[0].result='unknown'],
 ['bad guard count',(r:any)=>r.equivalence[0].CGuardObligations=-1],
 ['missing invariant',(r:any)=>r.claims.pop()],['duplicated invariant',(r:any)=>r.claims.push(r.claims[0])],
 ['invariant UNKNOWN',(r:any)=>r.claims[0].result='unknown'],['invariant SAT',(r:any)=>r.claims[0].result='sat'],
 ['missing success witness',(r:any)=>r.reachability.pop()],['unreachable success',(r:any)=>r.reachability[0].result='unsat'],
 ['missing mutation',(r:any)=>r.mutations.pop()],['mutation UNKNOWN',(r:any)=>r.mutations[0].result='unknown'],
 ['mutation hash',(r:any)=>r.mutations[0].cSha256='0'.repeat(64)],
 ['non-Boolean signer',(r:any)=>r.mutations[0].wireArgs[0].fields.signed=0],
 ['negative key limb',(r:any)=>r.mutations[0].wireArgs[0].fields.actor.fields.a=-1],
 ['wide key limb',(r:any)=>r.mutations[0].wireArgs[0].fields.actor.fields.a=2**32],
 ['unknown constructor',(r:any)=>r.mutations[0].wireArgs[1].constructor='missing'],
 ['extra witness field',(r:any)=>r.mutations[0].wireArgs[0].fields.extra=0],
 ['missing witness argument',(r:any)=>r.mutations[0].wireArgs.pop()],
 ['signed bypass witness',(r:any)=>r.mutations[0].wireArgs[0].fields.signed=true],
 ['zero deposit witness',(r:any)=>{const a=r.mutations[1].wireArgs[2].fields.amount.fields;a.lo=0;a.hi=0;}],
 ['overstated scope',(r:any)=>r.scope='verified SBF'],
] as const) {const r=structuredClone(base);change(r);assert.throws(()=>validate(r,input,raw),undefined,name);rows.push(name);}
const processRows=[];const output='build/vault-c-process-fault.json';fs.writeFileSync(output,JSON.stringify(base));
for(const [name,script,timeout] of [['nonzero','import sys;sys.exit(7)',1000],['signal','import os,signal;os.kill(os.getpid(),signal.SIGTERM)',1000],['timeout','import time;time.sleep(10)',30]] as const) {
 const result=spawnSync(process.env.PYTHON??'python3',['-c',script],{encoding:'utf8',timeout});assert.throws(()=>acceptProcess(result,output),undefined,name);processRows.push(name);
}
const zero=spawnSync(process.env.PYTHON??'python3',['-c','pass'],{encoding:'utf8',timeout:1000});
fs.unlinkSync(output);assert.throws(()=>acceptProcess(zero,output));processRows.push('missing output');
fs.writeFileSync(output,'{');assert.throws(()=>acceptProcess(zero,output));processRows.push('malformed output');fs.unlinkSync(output);
for(const variable of ['PYTHON','CC']) {
 const previous=fs.readFileSync(receipt),before=new Set(fs.readdirSync(runs));
 const failed=spawnSync(process.execPath,['verification/check-vault-c.ts'],{encoding:'utf8',env:{...process.env,[variable]:'/usr/bin/false'},timeout:30000});
 assert.notEqual(failed.status,0);assert.ok(!fs.existsSync(receipt));
 const created=fs.readdirSync(runs).filter(p=>!before.has(p));assert.equal(created.length,1);assert.deepEqual(fs.readFileSync(`${runs}/${created[0]}/previous.json`),previous);
 processRows.push(`${variable} failure retires previous success`);await main();
}
const previous=fs.readFileSync(receipt),parked='build/vault-c-parked';assert.ok(!fs.existsSync(parked));fs.renameSync(runs,parked);fs.writeFileSync(runs,'obstruction');
try {
 const failed=spawnSync(process.execPath,['verification/check-vault-c.ts'],{encoding:'utf8',timeout:30000});assert.notEqual(failed.status,0);assert.ok(!fs.existsSync(receipt));
 const archive=fs.readdirSync('build').filter(p=>p.startsWith('vault-c-refinement.json.')&&p.endsWith('.previous'));assert.equal(archive.length,1);assert.deepEqual(fs.readFileSync(`build/${archive[0]}`),previous);
 fs.renameSync(`build/${archive[0]}`,'build/vault-c-setup-preserved.json');processRows.push('setup failure retires previous success');
} finally {fs.unlinkSync(runs);fs.renameSync(parked,runs);}
await main();
fs.writeFileSync('build/vault-c-controls.json',JSON.stringify({passed:true,reportRefusals:rows,processControls:processRows},null,2)+'\n');
console.log(`${rows.length} report refusals and ${processRows.length} process/setup controls passed`);
