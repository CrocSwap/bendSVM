import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const directory='build/acyclic-lowering';
export const fixtures=[{file:'tests/lowering.bend',roots:['swap','select','update','normalize','identity']},
 {file:'tests/generics.bend',roots:['choose_word','choose_flag','nested','unwrap','present','absent']},
 {file:'examples/vault/vault.bend',roots:['authorize','deposited','withdrawn']},
 {file:'examples/vesting/vesting.bend',roots:['authorize','initialize','transfer','payout','funded_total','delta','difference','bounded','claim_result','initialize_instruction','empty']}];
export const mutations=[['assigned wrong return argument','present'],['unused correct call hides wrong return','present'],
 ['wrong arithmetic operation','update'],['wrong field returned','select'],
 ['vault authorization bypass','authorize'],['vault wrong transfer role','deposited'],['vesting wrong beneficiary','transfer'],['vesting subtraction changed to addition', 'difference'],['vesting old claimed amount retained', 'difference'],['vesting initialization signer bypass', 'initialize_instruction']];
const mutationRecipes=[
 [1,'return bend_Present_3c_U32_3e__make(a0);','a0 = 0u; return bend_Present_3c_U32_3e__make(a0);'],
 [1,'return bend_Present_3c_U32_3e__make(a0);','(void)bend_Present_3c_U32_3e__make(a0); return bend_Present_3c_U32_3e__make(0u);'],
 [0,'(a0 + a1)','(a0 - a1)'],[0,'return (a1).as.c0.f0;','return (a1).as.c0.f1;'],
 [2,'return bend_Rejected_make(1u);','return a1;'],
 [2,'_Transfer_make(4u, 5u, 6u, a1,','_Transfer_make(4u, 4u, 6u, a1,'],
 [3,'_ToOwner_make((a0).as.c0.f0)','_ToOwner_make((a0).as.c0.f1)'],
 [3, '(a0 - a1)', '(a0 + a1)'],
 [3, '(a0).as.c0.f4, a1), bend_', '(a0).as.c0.f4, (a0).as.c0.f5), bend_'],
 [3, 'return bend_authorize(a0, bend_initialize', 'return bend_authorize(1u, bend_initialize'],

] as const;
export const digest=(bytes:string|Buffer)=>createHash('sha256').update(bytes).digest('hex');
export function inventory() {
 const files=['package.json','package-lock.json','verification/check-acyclic-lowering.ts','verification/acyclic-source.ts','verification/acyclic_lowering.py','verification/acyclic_c.py'];
 function walk(dir:string) {for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
  const name=path.join(dir,entry.name);if(entry.isDirectory())walk(name);else if(/\.(ts|py|bend|h)$/.test(name))files.push(name);
 }}
 for(const dir of ['compiler','sdk','tests','examples','verification','.deps/bend/bend2'])walk(dir);
 return Object.fromEntries([...new Set(files)].sort().map(file=>[file,digest(fs.readFileSync(file))]));
}
export function syntaxCheck(programs:any[],run:string) {
 const compiler=process.env.CC??'clang';
 const version=spawnSync(compiler,['--version'],{encoding:'utf8',timeout:10000,maxBuffer:1024*1024});
 assert.ifError(version.error);assert.equal(version.signal,null);assert.equal(version.status,0,'C frontend version failed');
 assert.ok(version.stdout.trim(),'empty C frontend version');
 const units=programs.map((p,i)=>{
  const file=`${run}/fixture-${i}.c`;fs.writeFileSync(file,p.artifact.c,{flag:'wx'});
  const args=['-std=c11','-fsyntax-only','-Wno-pragma-once-outside-header',file];
  const result=spawnSync(compiler,args,{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
  fs.writeFileSync(`${file}.syntax.log`,(result.stdout??'')+(result.stderr??''));
  assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,0,`C frontend rejected ${p.artifact.fixture}`);
  return {fixture:p.artifact.fixture,cSha256:digest(fs.readFileSync(file)),exitCode:0};
 });
 return {compiler,version:version.stdout,units};
}
export function acceptProcess(result:ReturnType<typeof spawnSync>,output:string) {
 assert.ifError(result.error);assert.equal(result.signal,null,'child signal');assert.equal(result.status,0,'child exit');
 assert.ok(fs.existsSync(output),'missing fresh child report');return JSON.parse(fs.readFileSync(output,'utf8'));
}
export function validate(report:any,input:any,raw:Buffer) {
 assert.equal(report.version,1);assert.equal(report.passed,true);assert.equal(report.runId,input.runId,'stale run');
 assert.equal(report.z3,'5.1.0');assert.equal(report.inputSha256,digest(raw));
 assert.deepEqual(report.sourceHashes,input.sourceHashes);assert.deepEqual(input.fixtures,fixtures);
 assert.deepEqual(report.cSyntax,input.cSyntax);
 assert.ok(typeof report.cSyntax.compiler==='string' && report.cSyntax.compiler.length>0);
 assert.ok(typeof report.cSyntax.version==='string' && report.cSyntax.version.trim().length>0);
 assert.deepEqual(report.cSyntax.units,input.programs.map((p:any)=>({fixture:p.artifact.fixture,cSha256:digest(p.artifact.c),exitCode:0})));
 assert.equal(input.programs.length,fixtures.length);assert.equal(report.results.length,fixtures.length);
 for(const [i,f] of fixtures.entries()) {
  const p=input.programs[i],r=report.results[i];assert.equal(p.source.source,f.file);assert.deepEqual(p.source.roots,f.roots);
  assert.equal(p.defaultProductionCMatches,true);assert.equal(p.artifact.fixture,f.file);
  assert.equal(p.artifact.cSha256,digest(p.artifact.c));assert.equal(r.fixture,f.file);assert.equal(r.cSha256,p.artifact.cSha256);
  assert.deepEqual(r.claims.map((c:any)=>[c.function,c.result]),f.roots.map(name=>[name,'unsat']));
  for(const c of r.claims) {
   assert.deepEqual(Object.keys(c).sort(),['CGuardObligations','function','result','sourceDeadPaths'].sort());
   for(const key of ['CGuardObligations','sourceDeadPaths'])assert.ok(Number.isSafeInteger(c[key]) && c[key]>=0);
  }
 }
 assert.deepEqual(report.mutations.map((m:any)=>[m.name,m.claim.function,m.claim.result]),mutations.map(([n,f])=>[n,f,'sat']));
 for(const [i,m] of report.mutations.entries()) {
  const [index,target,replacement]=mutationRecipes[i];const c=input.programs[index].artifact.c;
  assert.ok(c.includes(target));assert.equal(m.cSha256,digest(c.replace(target,replacement)));
 assert.ok(m.claim.counterexample && Object.keys(m.claim.counterexample).length>0);
  assert.ok(Array.isArray(m.claim.wireArgs) && m.claim.wireArgs.length>0);
 }
 assert.equal(report.scope,'Conditional whole-function equivalence for the exported acyclic typed subset; source exporter, C interpreter, driver and Z3 trusted. No memory ABI, Clang or SBF preservation theorem.');
}
export async function main() {
 const receipt=`${directory}/fresh-receipt.json`,id=randomUUID(),run=`${directory}/runs/${id}`;
 const previous=`${receipt}.${id}.previous`;
 if(fs.existsSync(receipt))fs.renameSync(receipt,previous);
 fs.mkdirSync(run,{recursive:true});if(fs.existsSync(previous))fs.renameSync(previous,`${run}/previous.json`);
 const before=inventory();
 const {exportPrograms}=await import('./acyclic-source.ts');
 const programs=await exportPrograms();
 for(const p of programs)for(const [file,h] of Object.entries(p.sourceHashes)) {
  const relative=path.relative(process.cwd(),file);assert.equal(before[relative],h,`unbound source ${file}`);
 }
 assert.deepEqual(inventory(),before,'source changed while exporting');
 const cSyntax=syntaxCheck(programs,run);
 const input={version:1,runId:id,fixtures,sourceHashes:before,programs,cSyntax};
 const inputPath=`${run}/input.json`,output=`${run}/child.json`;
 fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});const raw=fs.readFileSync(inputPath);
 const result=spawnSync(process.env.PYTHON??'python3',['-B','verification/acyclic_lowering.py',inputPath,output],{encoding:'utf8',timeout:180000,maxBuffer:4*1024*1024});
 fs.writeFileSync(`${run}/child.log`,(result.stdout??'')+(result.stderr??''));
 const report=acceptProcess(result,output);validate(report,input,raw);
 assert.deepEqual(fs.readFileSync(inputPath),raw,'input changed');assert.deepEqual(inventory(),before,'source changed during proof');
 const pending=`${run}/accepted.json`;fs.writeFileSync(pending,JSON.stringify({...report,inputArtifact:inputPath},null,2)+'\n',{flag:'wx'});fs.renameSync(pending,receipt);
 console.log('Fresh whole-function gate accepted: 25 equivalence queries, 10 semantic counterexamples');
}
if(import.meta.main)await main();
