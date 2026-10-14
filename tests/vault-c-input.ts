import fs from 'node:fs';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {main} from '../verification/check-vault-c.ts';
import {digest} from '../verification/check-acyclic-lowering.ts';
await main();const receipt=JSON.parse(fs.readFileSync('build/vault-c-refinement.json','utf8'));
const baseline=JSON.parse(fs.readFileSync(receipt.inputArtifact,'utf8')),rows=[];
for(const [name,change,reason] of [
 ['input version',(x:any)=>x.version=2,'input header'],
 ['source omission',(x:any)=>x.sourceHashes={},'source binding changed'],
 ['source drift',(x:any)=>x.sourceHashes['verification/vault_c.py']='0'.repeat(64),'source binding changed'],
 ['wrong source',(x:any)=>x.program.source.source='other','source root inventory'],
 ['missing root',(x:any)=>x.program.source.roots=[],'source root inventory'],
 ['wrong artifact',(x:any)=>x.program.artifact.fixture='other','production artifact mismatch'],
 ['production mismatch',(x:any)=>x.defaultProductionCMatches=false,'production artifact mismatch'],
 ['missing checked file',(x:any)=>x.checkedFiles.pop(),'checked-file inventory'],
 ['missing frontend',(x:any)=>delete x.cSyntax,'C syntax evidence'],
 ['failed frontend',(x:any)=>x.cSyntax.units[0].exitCode=1,'C syntax inventory'],
 ['artifact drift',(x:any)=>x.program.artifact.c+='\n','artifact hash mismatch'],
 ['schema mismatch',(x:any)=>x.program.artifact.schema.exports[0].result='U32','source and C schema mismatch'],
 ['wrong authorization',(x:any)=>{const a=x.program.artifact;a.c=a.c.replace('return bend_Rejected_make(1u);','return a1;');a.cSha256=digest(a.c);x.cSyntax.units[0].cSha256=a.cSha256;},'process equivalence failed'],
] as const) {
 const x=structuredClone(baseline);x.runId=randomUUID();change(x);const dir=`build/vault-c-inputs/${x.runId}`;fs.mkdirSync(dir,{recursive:true});
 const input=`${dir}/input.json`,output=`${dir}/child.json`;fs.writeFileSync(input,JSON.stringify(x));
 const r=spawnSync(process.env.PYTHON??'python3',['-B','verification/vault_c_child.py',input,output],{encoding:'utf8',timeout:15000});
 assert.ifError(r.error);assert.equal(r.signal,null);assert.notEqual(r.status,0,name);assert.ok(r.stderr.includes(reason),`${name}: ${r.stderr}`);assert.ok(!fs.existsSync(output));rows.push({name,reason});
}
const forced=`import sys\nsys.path.insert(0,'verification')\nimport vault_c\nimport z3 as z\nclass Unknown:\n def set(self,**kwargs):pass\n def add(self,*args):pass\n def check(self):return z.unknown\n def reason_unknown(self):return 'forced invariant UNKNOWN'\nz.Solver=Unknown\ntry: vault_c.query(None,[],z.BoolVal(True))\nexcept ValueError as error:\n if 'UNKNOWN is not proof: forced invariant UNKNOWN' not in str(error):raise\n print('UNKNOWN correctly rejected')\nelse:raise RuntimeError('UNKNOWN accepted')\n`;
const unknown=spawnSync(process.env.PYTHON??'python3',['-B','-c',forced],{encoding:'utf8',timeout:10000});
assert.ifError(unknown.error);assert.equal(unknown.status,0,unknown.stderr);assert.ok(unknown.stdout.includes('UNKNOWN correctly rejected'));
fs.writeFileSync('build/vault-c-input-controls.json',JSON.stringify({passed:true,refusals:rows,unknownInvariantSolver:'rejected'},null,2)+'\n');
console.log(`${rows.length} input refusals and forced invariant UNKNOWN passed`);
