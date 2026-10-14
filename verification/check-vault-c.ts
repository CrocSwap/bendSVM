import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {digest,inventory,syntaxCheck,acceptProcess} from './check-acyclic-lowering.ts';
export const sourceFile='examples/vault/vault.bend';
export const claims=['exact-success-domain','unsigned-never-accepted','wrong-owner-never-accepted','accepted-state-live',
 'owner-binding','mint-binding','initial-balance-zero','deposit-exact-without-overflow','withdraw-exact-without-underflow',
 'one-effect-only','initialize-mint-check','deposit-plan-roles-authority-amount','withdraw-plan-roles-authority-amount','modeled-C-safety'];
export const domains=['initialize','positive-deposit','positive-withdraw'];
export const mutations=[
 ['authorization bypass','return bend_Rejected_make(1u);','return a1;','unsigned-never-accepted'],
 ['wrong transfer role','_Transfer_make(4u, 5u, 6u, a1,','_Transfer_make(4u, 4u, 6u, a1,','deposit-plan-roles-authority-amount'],
 ['wrong arithmetic operation','(a0 + a1)','(a0 - a1)','deposit-exact-without-overflow'],
] as const;
export const scope='Typed vault decision and effect-plan values only; source exporter, C interpreter, schema bridge, driver and Z3 trusted. No account adapter, effect execution, rollback, Clang/LLVM or SBF theorem.';
export function typedWitness(schema:any,args:any) {
 const signature=schema.exports.find((f:any)=>f.name==='process');assert.ok(signature);
 assert.ok(Array.isArray(args));assert.equal(args.length,signature.args.length);
 const types=new Map<string,any>(schema.types.map((t:any)=>[t.name,t]));
 function value(type:string,item:any,depth:number) {
  assert.ok(depth<64,'witness nesting limit');const t=types.get(type);assert.ok(t);
  if(t.kind==='u32') {assert.ok(Number.isSafeInteger(item)&&item>=0&&item<2**32);return;}
  if(t.kind==='bool') {assert.equal(typeof item,'boolean');return;}
  assert.equal(t.kind,'adt');assert.ok(item && typeof item==='object' && !Array.isArray(item));
  assert.deepEqual(Object.keys(item).sort(),['constructor','fields']);
  const v=t.variants.find((v:any)=>v.name===item.constructor);assert.ok(v,'unknown witness constructor');
  assert.ok(item.fields && typeof item.fields==='object' && !Array.isArray(item.fields));
  assert.deepEqual(Object.keys(item.fields).sort(),v.fields.map((f:any)=>f.name).sort());
  for(const f of v.fields)value(f.type,item.fields[f.name],depth+1);
 }
 args.forEach((item:any,i:number)=>value(signature.args[i],item,0));
}
export function validate(report:any,input:any,raw:Buffer) {
 assert.equal(report.version,1);assert.equal(report.passed,true);assert.equal(report.runId,input.runId);
 assert.equal(report.z3,'5.1.0');assert.equal(report.inputSha256,digest(raw));assert.deepEqual(report.sourceHashes,input.sourceHashes);
 const p=input.program;assert.equal(p.source.source,sourceFile);assert.deepEqual(p.source.roots,['process']);
 assert.equal(p.artifact.fixture,sourceFile);assert.equal(input.defaultProductionCMatches,true);
 assert.equal(p.artifact.cSha256,digest(p.artifact.c));assert.equal(report.cSha256,p.artifact.cSha256);
 assert.deepEqual(report.cSyntax,input.cSyntax);assert.ok(typeof report.cSyntax.compiler==='string' && report.cSyntax.compiler.length);
 assert.ok(typeof report.cSyntax.version==='string' && report.cSyntax.version.trim().length);
 assert.deepEqual(report.cSyntax.units,[{fixture:sourceFile,cSha256:report.cSha256,exitCode:0}]);
 assert.equal(report.equivalence.length,1);const e=report.equivalence[0];
 assert.deepEqual(Object.keys(e).sort(),['CGuardObligations','function','result','sourceDeadPaths'].sort());
 assert.equal(e.function,'process');assert.equal(e.result,'unsat');
 for(const key of ['CGuardObligations','sourceDeadPaths'])assert.ok(Number.isSafeInteger(e[key])&&e[key]>=0);
 assert.deepEqual(report.claims,claims.map(name=>({name,result:'unsat'})));
 assert.deepEqual(report.reachability.map((r:any)=>[r.name,r.result]),domains.map(n=>[n,'sat']));
 for(const r of report.reachability)typedWitness(p.artifact.schema,r.wireArgs);
 assert.deepEqual(report.mutations.map((m:any)=>[m.name,m.property,m.result]),mutations.map(([name,,,property])=>[name,property,'sat']));
 for(const [i,m] of report.mutations.entries()) {
  const [,target,replacement]=mutations[i];assert.ok(p.artifact.c.includes(target));
  assert.equal(m.cSha256,digest(p.artifact.c.replace(target,replacement)));typedWitness(p.artifact.schema,m.wireArgs);
  if(i===0)assert.equal(m.wireArgs[0].fields.signed,false);
  else {assert.equal(m.wireArgs[2].constructor,'Deposit');const amount=m.wireArgs[2].fields.amount.fields;assert.ok(amount.lo||amount.hi);}
 }
 assert.equal(report.scope,scope);
}
export async function main() {
 const id=randomUUID(),receipt='build/vault-c-refinement.json',directory=`build/vault-c/${id}`;
 const previous=`${receipt}.${id}.previous`;
 if(fs.existsSync(receipt))fs.renameSync(receipt,previous);
 fs.mkdirSync(directory,{recursive:true});if(fs.existsSync(previous))fs.renameSync(previous,`${directory}/previous.json`);
 const before=inventory();
 const {Backend,checkedProgram}=await import('../compiler/backend.ts');const {model}=await import('./model.ts');
 const checked=await checkedProgram(sourceFile),source=await model(sourceFile,['process']);
 for(const file of checked.files)assert.equal(digest(fs.readFileSync(file)),before[path.relative(process.cwd(),file)],'unbound checked file');
 const actual=new Backend(checked.book).emit(['process']),ordinary=new Backend(checked.book,{nativeArithmetic:false}).emit(['process']);
 assert.equal(actual.c,ordinary.c,'native helper not covered by this gate');assert.deepEqual(inventory(),before);
 const program={source,artifact:{fixture:sourceFile,c:actual.c,cSha256:digest(actual.c),schema:actual.schema}};
 const cSyntax=syntaxCheck([program],directory);
 const input={version:1,runId:id,sourceHashes:before,checkedFiles:checked.files,defaultProductionCMatches:true,program,cSyntax};
 const inputPath=`${directory}/input.json`,output=`${directory}/child.json`;
 fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});const raw=fs.readFileSync(inputPath);
 const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/vault_c_child.py',inputPath,output],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${directory}/child.log`,(result.stdout??'')+(result.stderr??''));
 const report=acceptProcess(result,output);validate(report,input,raw);
 assert.deepEqual(fs.readFileSync(inputPath),raw,'input drift');assert.deepEqual(inventory(),before,'source drift');
 const pending=`${directory}/accepted.json`;fs.writeFileSync(pending,JSON.stringify({...report,inputArtifact:inputPath},null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
 console.log('Vault C gate: full process equivalence, 14 independent invariants, 3 reachable domains, 3 faulty-C witnesses');
}
if(import.meta.main)await main();
