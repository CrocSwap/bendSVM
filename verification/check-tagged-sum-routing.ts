import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';

export const fixtures = [
  {file:'tests/lowering.bend',roots:['swap','select','update','normalize','iterate','identity']},
  {file:'tests/generics.bend',roots:['choose_word','choose_flag','nested','unwrap','present','absent']},
  {file:'examples/queue/PROOF.bend',roots:['queue.run_fold']},
];
export const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const hash = (file:string) => digest(fs.readFileSync(file));
export function canonical(value:any):string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort()
    .map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}

// Capture before importing the compiler, including its checked-source tool.
// This is read-time evidence, not protection against an adversarial filesystem.
export function sourceInventory() {
  const files = ['package.json','package-lock.json','verification/check-tagged-sum-routing.ts',
    'verification/tagged_sum_routing.py','verification/tagged_sum_c.py','verification/tagged_sum_rendering.py','verification/tagged_sum_layout.py'];
  function walk(dir:string) {
    for (const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory()) walk(file);
      else if(/\.(ts|bend|h)$/.test(file)) files.push(file);
    }
  }
  for(const dir of ['compiler','sdk','tests','examples','.deps/bend/bend2']) walk(dir);
  return Object.fromEntries([...new Set(files)].sort().map(file=>[file,hash(file)]));
}

export function validateReport(report:any, input:any, inputBytes:Buffer) {
  assert.equal(report.schema,3);
  assert.equal(report.passed,true);
  assert.equal(report.runId,input.runId,'stale run');
  assert.equal(report.z3,'5.1.0');
  assert.equal(report.checkerSha256,input.sourceHashes['verification/tagged_sum_routing.py']);
  assert.equal(report.inputSha256,digest(inputBytes));
  assert.deepEqual(report.sourceHashes,input.sourceHashes);
  assert.deepEqual(input.fixtures,fixtures);
  assert.ok(input.operations.length>0,'empty operations');
  const unique=[...new Set<string>(input.operations.map(canonical))].sort();
  assert.equal(report.productionInstances,input.operations.length);
  assert.equal(report.uniqueOperations,unique.length);
  const counts={construct:0,case:0};
  for(const op of unique) {
    const kind=JSON.parse(op).ir.kind;
    assert.ok(kind==='construct'||kind==='case'); counts[kind as keyof typeof counts]++;
  }
  assert.ok(counts.construct>0 && counts.case>0);
  assert.deepEqual(report.counts,counts);
  assert.deepEqual(report.proofs,unique.map(op=>({operationSha256:digest(op),result:'UNSAT'})),
    'proof inventory must cover exactly the exported operation shapes');
  assert.deepEqual(report.semanticMutations?.map((m:any)=>m.name),[
    'wrong match tag','swapped constructor arguments','swapped projected fields','dropped fallback scrutinee']);
  for(const mutation of report.semanticMutations) {
    assert.equal(mutation.result,'SAT');
    assert.ok(mutation.witness && typeof mutation.witness==='object');
  }
  assert.deepEqual(report.constructorCProofs,input.artifacts.flatMap((a:any)=>a.schema.types
    .filter((t:any)=>t.kind==='adt').flatMap((t:any)=>t.variants.map((v:any)=>({
      fixture:a.fixture,maker:v.cMaker,cSha256:a.cSha256,result:'UNSAT'})))));
  assert.ok(report.constructorCProofs.length>0);
  assert.deepEqual(report.layoutChecks,input.artifacts.flatMap((a:any)=>a.schema.types
    .filter((t:any)=>t.kind==='adt').map((t:any)=>({fixture:a.fixture,type:t.name,cType:t.cType,cSha256:a.cSha256,result:'MATCH'}))));
  assert.ok(report.layoutChecks.length>0);

  assert.deepEqual(report.renderingChecks,input.artifacts.flatMap((a:any)=>a.renderings.map((r:any)=>({
    fixture:a.fixture,operation:a.operationOffset+r.operation,renderingSha256:digest(canonical(r)),
    cSha256:a.cSha256,result:'MATCH'}))));
  assert.equal(report.renderingChecks.length,input.operations.length);

  assert.deepEqual(report.constructorCMutations?.map((m:any)=>[m.name,m.result]),[
    ['wrong maker tag','SAT'],['wrong maker union member','SAT'],['swapped maker fields','SAT']]);
  for(const mutation of report.constructorCMutations) assert.ok(mutation.witness && typeof mutation.witness==='object');
  assert.deepEqual(report.constructorCGrammarRefusals?.map((m:any)=>[m.name,m.result]),[
    ['extra maker statement','REJECTED'],['octal maker tag','REJECTED'],['incomplete maker fields','REJECTED']]);

  assert.ok(typeof report.scope==='string' && report.scope.includes('does not interpret'));
}

export function acceptChild(result:ReturnType<typeof spawnSync>, output:string) {
  assert.ifError(result.error);
  assert.equal(result.signal,null,'checker terminated by signal');
  assert.equal(result.status,0,'checker exited unsuccessfully');
  assert.ok(fs.existsSync(output),'checker returned zero without a report');
  return JSON.parse(fs.readFileSync(output,'utf8'));
}

export async function main() {
  const receipt='build/tagged-sum-routing-refinement.json';
  const runId=randomUUID();
  const directory=`build/tagged-sum-routing/${runId}`;
  // Retire success before creating the run directory: ENOTDIR/disk failures
  // must not leave yesterday's accepted result at the conventional path.
  const previous=`${receipt}.${runId}.previous`;
  if(fs.existsSync(receipt)) fs.renameSync(receipt,previous);
  fs.mkdirSync(directory,{recursive:true});
  if(fs.existsSync(previous)) fs.renameSync(previous,`${directory}/previous.json`);
  const before=sourceInventory();
  const {Backend,checkedProgram}=await import('../compiler/backend.ts');
  const operations:any[]=[], artifacts:any[]=[];
  for(const fixture of fixtures) {
    const checked=await checkedProgram(fixture.file);
    for(const file of checked.files) {
      const relative=path.relative(process.cwd(),file);
      assert.ok(relative in before,`unchecked source outside inventory: ${file}`);
      assert.equal(hash(file),before[relative]);
    }
    const emitted=new Backend(checked.book).emit(fixture.roots);
    operations.push(...JSON.parse(JSON.stringify(emitted.taggedSumLowering.operations)));
    artifacts.push({fixture:fixture.file,c:emitted.c,cSha256:digest(emitted.c),schema:emitted.schema,
      operationOffset:operations.length-emitted.taggedSumLowering.operations.length,
      renderings:emitted.taggedSumLowering.rendered.operations});
  }
  assert.deepEqual(sourceInventory(),before,'source changed while compiling');
  const input={version:3,runId,fixtures,sourceHashes:before,operations,artifacts};
  const inputPath=`${directory}/input.json`, output=`${directory}/child.json`;
  fs.writeFileSync(inputPath,JSON.stringify(input,null,2)+'\n',{flag:'wx'});
  const inputBytes=fs.readFileSync(inputPath);
  const result=spawnSync(process.env.PYTHON??'python3',[
    '-B','verification/tagged_sum_routing.py',inputPath,output],
    {encoding:'utf8',timeout:180_000,maxBuffer:4*1024*1024});
  if(result.stderr) process.stderr.write(result.stderr);
  const report=acceptChild(result,output);
  validateReport(report,input,inputBytes);
  assert.deepEqual(fs.readFileSync(inputPath),inputBytes,'input changed');
  assert.deepEqual(sourceInventory(),before,'source changed during proof');
  const pending=`${directory}/accepted.json`;
  fs.writeFileSync(pending,JSON.stringify({...report,inputArtifact:inputPath},null,2)+'\n',{flag:'wx'});
  fs.renameSync(pending,receipt);
  console.log(`Tagged-sum routing: ${report.productionInstances} instances, ${report.uniqueOperations} symbolic proofs, ${report.constructorCProofs.length} emitted-C maker proofs, ${report.layoutChecks.length} declaration checks, ${report.renderingChecks.length} renderer checks`);
}
if(import.meta.main) await main();
