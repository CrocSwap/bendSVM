import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  assertCompositionReceipt,assertExactCaller,assertFreshBundle,assertLifecycleInventory,
  assertRuntimeInventory,validateContractInterface,
} from '../verification/collection-composition-receipt.ts';

const root=process.cwd();
const output=path.resolve('build/collection-composition-refinement.json');
const python=process.env.PYTHON??'python3';
const hashBytes=(bytes:Buffer)=>crypto.createHash('sha256').update(bytes).digest('hex');
const hashFile=(file:string)=>hashBytes(fs.readFileSync(file));
const testDirectory=path.resolve('build/collection-composition-receipt-tests',crypto.randomUUID());
fs.mkdirSync(testDirectory,{recursive:true});

function run(command:string,args:string[],env:NodeJS.ProcessEnv,timeout:number) {
  const result=spawnSync(command,args,{cwd:root,env,encoding:'utf8',timeout,maxBuffer:32*1024*1024});
  const log=(result.stdout??'')+(result.stderr??'')+(result.error?`\n${result.error.stack}`:'');
  return {result,log};
}
function rejected(label:string,runCheck:()=>unknown) {
  assert.throws(runCheck,undefined,`${label} must reject`);
}
function copy<T>(value:T):T { return structuredClone(value); }
function canonical(value:any):any {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}

const positive=run(process.execPath,['verification/check-collection-composition.ts'],process.env,
  Number(process.env.COLLECTION_COMPOSITION_TEST_TIMEOUT_MS??1_200_000));
fs.writeFileSync(path.join(testDirectory,'positive.log'),positive.log);
assert.ifError(positive.result.error);
assert.equal(positive.result.status,0,`fresh composition parent failed; see ${path.join(testDirectory,'positive.log')}`);
assert(fs.existsSync(output),'fresh composition parent did not publish a report');
const publishedBytes=fs.readFileSync(output);
const composition=JSON.parse(publishedBytes.toString('utf8'));
const runId=composition.compositionRunId;
const runDirectory=path.resolve('build/collection-composition-runs',runId);
const runtimeBytes=fs.readFileSync(path.join(runDirectory,'runtime.json'));
const lifecycleBytes=fs.readFileSync(path.join(runDirectory,'lifecycle.json'));
const callerBytes=fs.readFileSync(path.join(runDirectory,'caller.json'));
const runtime=JSON.parse(runtimeBytes.toString('utf8'));
const lifecycle=JSON.parse(lifecycleBytes.toString('utf8'));
const caller=JSON.parse(callerBytes.toString('utf8'));
const receiptHashes={runtime:hashBytes(runtimeBytes),lifecycle:hashBytes(lifecycleBytes),caller:hashBytes(callerBytes)};

assertFreshBundle(runtime,lifecycle,caller,runId);
assertCompositionReceipt(composition,runtime,lifecycle,caller,receiptHashes,runId);
assert(composition.parentRunEvidence &&
  (composition.parentRunEvidence.priorSuccessfulArchive===null || typeof composition.parentRunEvidence.priorSuccessfulArchive==='string'),
  'fresh parent must explicitly account for any archived historical success bytes');

// Mutate the just-produced reports in memory. None of these mutations can be
// accepted as proof input: this is receipt-validator negative coverage only.
for(const [label,mutate] of [
  ['runtime missing claim',(r:any)=>r.proofs.select.obligations.pop()],
  ['runtime duplicate claim',(r:any)=>r.proofs.select.obligations.push(copy(r.proofs.select.obligations[0]))],
  ['runtime extra claim',(r:any)=>r.proofs.select.obligations.push({label:'forged extra',result:'UNSAT'})],
  ['runtime narrowed assumptions',(r:any)=>r.assumptions.pop()],
] as Array<[string,(report:any)=>void]>) {
  const changed=copy(runtime);mutate(changed);
  rejected(label,()=>assertRuntimeInventory(changed));
}
for(const [label,mutate] of [
  ['lifecycle missing claim',(r:any)=>r.claimResults.pop()],
  ['lifecycle duplicate claim',(r:any)=>r.claimResults.push(copy(r.claimResults[0]))],
  ['lifecycle extra claim',(r:any)=>r.claimResults.push({name:'forged extra',result:'unsat'})],
  ['lifecycle missing shared precondition import',(r:any)=>r.commit.contractPreconditionImports.pop()],
  ['lifecycle forged shared precondition import',(r:any)=>r.commit.contractPreconditionImports[12].sourceClaims=['forged scratch theorem']],
] as Array<[string,(report:any)=>void]>) {
  const changed=copy(lifecycle);mutate(changed);rejected(label,()=>assertLifecycleInventory(changed));
}
for(const [label,mutate] of [
  ['caller missing claim',(r:any)=>r.proofs.run.pop()],
  ['caller duplicate claim',(r:any)=>r.proofs.run.push(copy(r.proofs.run[0]))],
  ['caller extra claim',(r:any)=>r.proofs.run.push({name:'forged extra',result:'unsat'})],
  ['caller narrowed assumptions',(r:any)=>r.assumptions.pop()],
] as Array<[string,(report:any)=>void]>) {
  const changed=copy(caller);mutate(changed);rejected(label,()=>assertExactCaller(changed));
}
for(const [label,mutate] of [
  ['stale composition run id',(r:any)=>r.compositionRunId='stale-run-id'],
  ['composition missing claim',(r:any)=>r.solverObligations.pop()],
  ['composition duplicate claim',(r:any)=>r.solverObligations.push(copy(r.solverObligations[0]))],
  ['composition extra claim',(r:any)=>r.solverObligations.push({name:'forged extra',result:'UNSAT'})],
  ['composition missing caller precondition',(r:any)=>r.callerCompositionPreconditions.pop()],
  ['composition duplicate caller precondition',(r:any)=>r.callerCompositionPreconditions.push(copy(r.callerCompositionPreconditions[0]))],
  ['composition extra caller precondition',(r:any)=>r.callerCompositionPreconditions.push({name:'forged precondition',result:'UNSAT',formula:'true',disposition:'REPROVED_FROM_FRESH_PARSED_CALLER'})],
  ['composition missing sensitivity',(r:any)=>r.bridgeQuerySensitivity.pop()],
  ['composition narrowed world assumptions',(r:any)=>r.assumptions.compositionWorld.pop()],
  ['composition altered contract',(r:any)=>r.contractInterface.contracts.open.frame.pop()],
  ['composition altered artifact bytes',(r:any)=>r.artifactHashes['collection-store.c']='0'.repeat(64)],
  ['composition altered receipt hash',(r:any)=>r.helperReceiptByteHashes.runtime='0'.repeat(64)],
] as Array<[string,(report:any)=>void]>) {
  const changed=copy(composition);mutate(changed);
  rejected(label,()=>assertCompositionReceipt(changed,runtime,lifecycle,caller,receiptHashes,runId));
}
const changedContract=copy(runtime);changedContract.contractInterface.contracts.open.frame.pop();
rejected('helper changed contract AST',()=>validateContractInterface(changedContract));
changedContract.contractInterfaceHash=hashBytes(Buffer.from(JSON.stringify(canonical(changedContract.contractInterface))));
rejected('helper changed contract AST with a matching forged digest',()=>validateContractInterface(changedContract));
const mixedCaller=copy(caller);mixedCaller.compositionRunId='different-run';
rejected('mixed caller run id',()=>assertFreshBundle(runtime,lifecycle,mixedCaller,runId));
const narrowedLifecycle=copy(lifecycle);narrowedLifecycle.assumptions['span/BV composition']='narrowed';
rejected('narrowed lifecycle assumptions',()=>assertCompositionReceipt(composition,runtime,narrowedLifecycle,caller,receiptHashes,runId));

// UNKNOWN is injected into the real Python composition driver while consuming
// this same just-created run's artifacts and child receipts. It must not write
// any result file or replace the successful parent report.
const payload=path.join(runDirectory,'composition-input.json');
const unknownOutput=path.join(runDirectory,'unknown-result.pending.json');
const bootstrap=`import pathlib,sys,types
base=pathlib.Path(sys.argv[1])
sys.argv=[str(base/'collection_composition.py'),*sys.argv[2:]]
for name in ('adapter_contract_c','collection_contracts','collection_runtime','collection_caller_syntax','collection_caller_paths','collection_lifecycle','collection_composition'):
    file=base/(name+'.py')
    module=types.ModuleType(name if name!='collection_composition' else '__main__')
    module.__file__=str(file)
    sys.modules[name]=module
    exec(compile(file.read_bytes(),str(file),'exec'),module.__dict__)
`;
const unknown=run(python,['-I','-B','-c',bootstrap,path.resolve('verification'),payload,unknownOutput],
  {...process.env,COLLECTION_COMPOSITION_RUN_ID:runId,COLLECTION_COMPOSITION_TEST_UNKNOWN:'1'},180_000);
fs.writeFileSync(path.join(testDirectory,'unknown.log'),unknown.log);
assert.notEqual(unknown.result.status,0,'injected UNKNOWN unexpectedly passed');
assert.match(unknown.log,/UNKNOWN is not a proof/);
assert(!fs.existsSync(unknownOutput),'UNKNOWN produced a composition result');
assert.deepEqual(fs.readFileSync(output),publishedBytes,'UNKNOWN changed the successful published bytes');

function parentFailure(envName:string,value:string,diagnostic:RegExp,label:string) {
  const result=run(process.execPath,['verification/check-collection-composition.ts'],
    {...process.env,[envName]:value},60_000);
  fs.writeFileSync(path.join(testDirectory,label+'.log'),result.log);
  assert.ifError(result.result.error);
  assert.notEqual(result.result.status,0,`${label} unexpectedly passed`);
  assert.match(result.log,diagnostic,`${label} diagnostic changed`);
  assert(!fs.existsSync(output),`${label} left a canonical success report`);
}
parentFailure('COLLECTION_COMPOSITION_TEST_CHILD_FAILURE','runtime',/runtime proof child exited 29/,'child-nonzero');
const archived=path.resolve('build/refinement-reports',hashBytes(publishedBytes)+'.json');
assert.deepEqual(fs.readFileSync(archived),publishedBytes,'failed child did not preserve the prior success bytes');
parentFailure('COLLECTION_COMPOSITION_TEST_CHILD_TIMEOUT','runtime',/runtime proof child timed out/,'child-timeout');
assert.deepEqual(fs.readFileSync(archived),publishedBytes,'timeout probe changed the preserved success archive');

fs.writeFileSync(path.join(testDirectory,'report.json'),JSON.stringify({
  passed:true,runId,compositionReportSha256:hashBytes(publishedBytes),receiptHashes,
  counts:{solver:composition.solverObligationCount,grammar:composition.grammarRestrictionCount,
    emittedCMutations:composition.emittedCMutationCount,bridgeSensitivity:composition.bridgeQuerySensitivityCount,
    observationSensitivity:composition.parsedObservationSensitivityCount},
  receiptNegativeCases:29,unknownRejected:true,childNonzeroRejected:true,childTimeoutRejected:true,
  preservedSuccessArchive:archived,
},null,2)+'\n');
console.log(`Collection composition receipt regression passed: ${runId}; evidence ${testDirectory}`);
