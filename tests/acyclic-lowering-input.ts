import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,main} from '../verification/check-acyclic-lowering.ts';
const dir='build/acyclic-lowering';
await main();const report=JSON.parse(fs.readFileSync(`${dir}/fresh-receipt.json`,'utf8'));
const baseline=JSON.parse(fs.readFileSync(report.inputArtifact,'utf8'));
const rows=[];
for(const [name,change,reason] of [
 ['missing C frontend evidence',(x:any)=>delete x.cSyntax,'missing C frontend evidence'],
 ['wrong version',(x:any)=>x.version=2,'invalid input header'],
 ['missing source binding',(x:any)=>x.sourceHashes={},'source binding changed'],
 ['changed source hash',(x:any)=>x.sourceHashes['verification/prove.py']='0'.repeat(64),'source binding changed'],
 ['wrong fixture list',(x:any)=>x.fixtures.pop(),'fixture inventory'],
 ['missing program',(x:any)=>x.programs.pop(),'program inventory'],
 ['extra program',(x:any)=>x.programs.push(x.programs[0]),'program inventory'],
 ['wrong root list',(x:any)=>x.programs[0].source.roots.pop(),'source root inventory'],
 ['production mismatch',(x:any)=>x.programs[0].defaultProductionCMatches=false,'default production C mismatch'],
 ['wrong artifact fixture',(x:any)=>x.programs[0].artifact.fixture='other','C frontend artifact inventory'],
 ['missing checked file',(x:any)=>delete x.programs[0].sourceHashes[Object.keys(x.programs[0].sourceHashes)[0]],'checked-source file inventory'],
 ['changed C bytes',(x:any)=>x.programs[0].artifact.c+='\n','artifact hash mismatch'],
 ['mismatched schema',(x:any)=>x.programs[0].artifact.schema.exports[0].result='U32','source and C schema mismatch'],
 ['unmodeled C declaration',(x:any)=>{const a=x.programs[0].artifact;a.c+='\nstatic bend_u32 extra = 0u;\n';a.cSha256=digest(a.c);x.cSyntax.units[0].cSha256=a.cSha256;},'unsupported translation-unit tokens'],
] as const) {
 const x=structuredClone(baseline);x.runId=randomUUID();change(x);
 const run=`${dir}/input-controls/${x.runId}`;fs.mkdirSync(run,{recursive:true});const input=`${run}/input.json`,output=`${run}/child.json`;
 fs.writeFileSync(input,JSON.stringify(x));
 const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/acyclic_lowering.py',input,output],{encoding:'utf8',timeout:10000});
 assert.ifError(result.error);assert.equal(result.signal,null);assert.notEqual(result.status,0,name);assert.ok(result.stderr.includes(reason),`${name}: ${result.stderr}`);
 assert.ok(!fs.existsSync(output),name);rows.push({name,reason,exit:result.status});
}
fs.writeFileSync(`${dir}/input-controls.json`,JSON.stringify({passed:true,rows},null,2)+'\n');
console.log(`${rows.length} child input refusals passed without publishing a result`);
