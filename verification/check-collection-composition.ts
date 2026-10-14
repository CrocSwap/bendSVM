import assert from 'node:assert/strict';
import crypto, {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {assertCompositionReceipt,assertFreshBundle} from './collection-composition-receipt.ts';

const root = process.cwd();
const runId = randomUUID();
const runDirectory = path.resolve('build/collection-composition-runs', runId);
const output = path.resolve('build/collection-composition-refinement.json');
const pending = output + '.pending.' + runId;
const python = process.env.PYTHON ?? 'python3';
const timeout = Number(process.env.COLLECTION_COMPOSITION_CHILD_TIMEOUT_MS ?? 900_000);
assert(Number.isSafeInteger(timeout) && timeout > 0, 'composition child timeout must be a positive integer');
const sha = (file:string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const runtimeSourceFiles = [
  'runtime/bend_collection_runtime.h','runtime/solana_min.h','verification/adapter_contract_c.py',
  'verification/collection_contracts.py','verification/collection_runtime.py',
  'verification/check-collection-runtime.ts','tests/collection-runtime.c',
];
const lifecycleSourceFiles = [
  'runtime/bend_collection_runtime.h','runtime/solana_min.h','verification/collection_lifecycle.py',
  'verification/check-collection-lifecycle.ts','verification/collection_runtime.py',
  'verification/adapter_contract_c.py','verification/collection_contracts.py',
];
const callerCheckerFiles = [
  'verification/collection_adapter_contract.py','verification/collection_caller_syntax.py',
  'verification/collection_caller_paths.py','verification/collection_caller_cases.py',
  'verification/collection_contracts.py','verification/check-collection-adapter-contract.ts',
];
const allPinnedFiles = [...new Set([
  ...runtimeSourceFiles,...lifecycleSourceFiles,...callerCheckerFiles,
  'verification/collection_composition.py','verification/check-collection-composition.ts',
  'verification/collection-composition-receipt.ts',
  'tests/collection-composition-receipt.ts','tests/collection-runtime-receipt.ts',
  'tests/collection-lifecycle-receipt.ts','tests/collection-caller-receipt.ts',
  'tests/collection-caller-receipt.py',
  'tests/collection-store.bend','tests/collection-store.json','package.json','package-lock.json',
])].sort();

const expectedCallerAssumptions = [
  'Input pointer and serialized allocation bounds are valid under the pinned loader contract. read_account refuses unsupported duplicate markers and produces truthful Account fields; key equality and little-endian reads have their specified byte semantics.',
  'open, codecs, select, plan and checked Bend roots are free of externally observable effects (including CPI, logging and return-data changes) before commit; each modeled stage is required to execute at most once on a path, and repeated invocations reject as unsupported. Helpers and codecs initialize only their specified outputs; failure preserves managed account data.',
  'The parsed open, select, record, plan and commit calls instantiate the shared bend.collection-helper-contracts/v1 typed AST. Successful open outputs feed select; select outputs feed record and plan; plan outputs and accepted record encoders feed commit. Exact object argument spellings are source grammar facts and are not reported as SMT pointer-equality claims. Run also assumes count=3, mode<=1 and initialize=(mode==0), discharged by the exact checked entry dispatch.',
  'The imported commit contract is no-fail under the accepted plan and writes exactly its specified collection bytes. Distinct local scratch objects, account objects and loaded account allocations are disjoint. Return-data syscall has its declared no-result ABI.',
  'Generated headers must match the fixed reviewed byte allowlist, independently of the candidate manifest. This restriction does not prove their bodies: codecs and Bend roots obey their recorded schema and type layouts by assumption. Context constructors and byte-read primitives have their specified pure semantics.',
  'The restricted parser, symbolic executor, Python interpreter, proof driver and Z3 are trusted. Scalar operations outside the modeled unsigned ABI subset reject rather than receive guessed C semantics.',
];
const expectedRuntimeAssumptions = [
  'No range precondition is placed on the modeled u32 collection/window/scalar fields; length > capacity is included and select must refuse it.',
  'Collection, window, and output pointers designate valid, non-null, disjoint objects of the declared types; writable outputs have the required write permission. Pointer validity and bounds are assumed, not proved in this slice.',
  'u8/u32/u64 have widths 8/32/64 as asserted in runtime/solana_min.h; the reusable C parser, this local interpreter and Z3 bridge implement the listed restricted C semantics correctly.',
  'Only normally returning helper control flow is modeled. Clang/LLD/SBF preservation, loader behavior, codecs, roots, open/record/commit, ABI-3 callers and transaction rollback are outside scope.',
];

const callerRunInventory:Record<string,number> = {
  'all caller paths return':1,'commit consumes an accepted bounded plan':1,
  'commit consumes initialized record 0':1,'commit consumes initialized record 1':1,
  'commit consumes initialized state encoding':1,'ordered refusal and success result':1,
  'record 0 active record span follows shared contract':1,
  'record 1 active record span follows shared contract':1,
  'outcome field initialized by root':6,'reachability: clock':1,'reachability: commit':1,
  'reachability: context':1,'reachability: instruction_decode':1,'reachability: metadata':1,
  'reachability: open':1,'reachability: plan':1,'reachability: record_decode_0':1,
  'reachability: record_decode_1':1,'reachability: record_encode_0':1,'reachability: record_encode_1':1,
  'reachability: return_data':1,'reachability: root':1,'reachability: select_window':1,
  'reachability: selector':1,'reachability: state_decode_initial':1,'reachability: state_decode_stored':1,
  'reachability: state_encode':1,'reachability: state_header_write':1,'reachability: state_payload_write':1,
  'record 0 read within loaded window':1,'record 1 read within loaded window':1,
  'root receives selected length':1,'root receives selected start':1,
  'selected field initialized by accepted select':3,'selection field initialized by selector':5,
  'stage invoked at most once: clock':1,'stage invoked at most once: commit':1,
  'stage invoked at most once: context':1,'stage invoked at most once: instruction_decode':1,
  'stage invoked at most once: metadata':1,'stage invoked at most once: open':1,
  'stage invoked at most once: plan':1,'stage invoked at most once: record_decode_0':1,
  'stage invoked at most once: record_decode_1':1,'stage invoked at most once: record_encode_0':1,
  'stage invoked at most once: record_encode_1':1,'stage invoked at most once: return_data':1,
  'stage invoked at most once: root':1,'stage invoked at most once: select_window':1,
  'stage invoked at most once: selector':1,'stage invoked at most once: state_decode_initial':1,
  'stage invoked at most once: state_decode_stored':1,'stage invoked at most once: state_encode':1,
  'stage invoked at most once: state_header_write':1,'stage invoked at most once: state_payload_write':1,
  'state byte read inside allocation':45,'state byte read precedes all mutations':45,
  'state header byte read inside constant array':20,'write occurs at most once: commit':1,
  'write occurs at most once: return_data':1,'write occurs at most once: state_header_write':1,
  'write occurs at most once: state_payload_write':1,'write order: return_data':1,
  'write order: state_header_write':1,'write order: state_payload_write':1,
};
const callerEntryInventory:Record<string,number> = {
  'account loader receives live pointer':3,'all caller paths return':1,
  'dispatch canonical instruction bounds':1,'dispatch count exactly three':1,
  'entry loop stays within three slots':4,'instruction length read uses live pointer':1,
  'ordered refusal and success result':1,'reachability: dispatch':1,'reachability: length_read':1,
  'reachability: load_0':1,'reachability: load_1':1,'reachability: load_2':1,
  'reachability: mode_read':1,'stage invoked at most once: dispatch':1,
  'stage invoked at most once: length_read':1,'stage invoked at most once: load_0':1,
  'stage invoked at most once: load_1':1,'stage invoked at most once: load_2':1,
};
const expectedObservationForms = [
  ['bend_collection_open',['&accounts[2]','program','state->key','collection_header','4','initialize','&collection'],'open_error',null],
  ['bend_collection_select',['&collection','selection.as.c1.f0.as.c0.f0','selection.as.c1.f0.as.c0.f1','2','&selected'],'select_ok',null],
  ['bend_collection_record',['&collection','&selected','0'],null,'record_pointer_0'],
  ['bend_collection_record',['&collection','&selected','1'],null,'record_pointer_1'],
  ['bend_collection_plan',['&collection','&selected','written','next'],'plan_ok',null],
  ['bend_collection_commit',['&collection','&selected','written','next','encoded_records','collection_header','state->key'],null,null],
];

function canonical(value:any):any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
function validateContractInterface(report:any) {
  assert.equal(report.contractInterface?.format,'bend.collection-helper-contracts/v1','contract AST format');
  const computed=crypto.createHash('sha256').update(JSON.stringify(canonical(report.contractInterface))).digest('hex');
  assert.equal(report.contractInterfaceHash,computed,'contract interface hash does not match its AST');
}
function labelInventory(proofs:any[]) {
  const out:Record<string,number>={};
  for(const proof of proofs) out[proof.name]=(out[proof.name]??0)+1;
  return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));
}
function assertExactCaller(report:any) {
  assert.equal(report.format,'bend.collection-caller-paths/v3');
  assert.deepEqual(labelInventory(report.proofs.run),callerRunInventory,'exact caller run proof inventory');
  assert.deepEqual(labelInventory(report.proofs.entry),callerEntryInventory,'exact caller entry proof inventory');
  assert.deepEqual(report.assumptions,expectedCallerAssumptions,'exact caller assumptions');
  assert.deepEqual(report.callObservations.map((row:any)=>[row.function,row.arguments,row.statusInput??null,row.pointerResult??null]),
    expectedObservationForms,'exact parsed helper observation inventory');
  for(const section of Object.values(report.proofs) as any[][])
    assert(section.every(item=>item.result==='unsat'),'caller proof is not UNSAT');
}
function assertRuntimeInventory(report:any) {
  assert.equal(report.schema,2);
  assert.equal(report.status,'PASS');assert.equal(report.passed,true);
  assert.deepEqual(report.assumptions,expectedRuntimeAssumptions,'exact runtime assumptions');
  assert.deepEqual(Object.keys(report.proofs).sort(),['plan','select']);
  const expected:Record<string,Record<string,number>>={
    select:{'select: source paths cover all u32 inputs':1,'select: exact return and output contract':1,
      'select: evaluated u32 subtraction cannot underflow':5,'select: output fields do not mutate on refusal':1,
      'select: exact start/reserved/loaded outputs on success':1,'select: collection input is unchanged':1},
    plan:{'plan: source paths cover all u32 inputs':1,'plan: exact return and output contract':1,
      'plan: evaluated u32 subtraction cannot underflow':34,'plan: collection and window inputs are unchanged':1},
  };
  const ranges:Record<string,string[]>={
    select:['select: start is within old logical length','select: reservation addition does not wrap','select: reserved end is within capacity','select: loaded count does not exceed reservation','select: loaded end addition does not wrap','select: loaded end is within old logical length'],
    plan:['plan: written record count fits selected reservation','plan: written range addition does not wrap','plan: written range fits collection capacity','plan: loaded prefix is retained by count','plan: next logical length is bounded','plan: additions equal logical length growth','plan: appends extend exactly from old tail','plan: loaded end addition does not wrap','plan: old length plus additions does not wrap','plan: old plus appended count equals next length without u32 wrap'],
  };
  for(const kind of ['select','plan']) {
    const hist=(items:any[])=>{const x:Record<string,number>={};for(const y of items)x[y.label]=(x[y.label]??0)+1;return Object.fromEntries(Object.entries(x).sort(([a],[b])=>a.localeCompare(b)));};
    assert.deepEqual(hist(report.proofs[kind].obligations),Object.fromEntries(Object.entries(expected[kind]).sort(([a],[b])=>a.localeCompare(b))),`${kind} exact claim multiplicities`);
    assert(report.proofs[kind].obligations.every((x:any)=>x.result==='UNSAT'),`${kind} child contains non-UNSAT proof`);
    assert.deepEqual(report.proofs[kind].range_and_append_obligations.map((x:any)=>x.label).sort(),[...ranges[kind]].sort(),`${kind} exact range inventory`);
    assert(report.proofs[kind].range_and_append_obligations.every((x:any)=>x.result==='UNSAT'));
  }
}

function snapshot() {
  const names = [...allPinnedFiles];
  const walk=(directory:string)=>{
    for(const entry of fs.readdirSync(path.join(root,directory),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory() && !['build','target','node_modules','.deps','.git','.fadeno','__pycache__'].includes(entry.name))walk(file);
      else if(/\.(?:ts|bend|json|c|h|ld)$/.test(entry.name))names.push(file);
    }
  };
  for(const directory of ['compiler','runtime','sdk','scripts'])walk(directory);
  return Object.fromEntries([...new Set(names)].sort().map(name=>[name,sha(path.join(root,name))]));
}
function quarantine(file:string,label:string) {
  if(!fs.existsSync(file))return null;
  const safe=file+'.'+label+'.'+Date.now()+'.'+process.pid+'.'+randomUUID()+'.quarantine';
  const bytes=fs.readFileSync(file);fs.renameSync(file,safe);assert(!fs.existsSync(file));
  assert.deepEqual(fs.readFileSync(safe),bytes);return safe;
}
function archivePrior() {
  const safe=quarantine(output,'previous');if(!safe)return null;
  const bytes=fs.readFileSync(safe);const digest=crypto.createHash('sha256').update(bytes).digest('hex');
  const directory=path.resolve('build/refinement-reports');fs.mkdirSync(directory,{recursive:true});
  const archived=path.join(directory,digest+'.json');
  if(fs.existsSync(archived))assert.deepEqual(fs.readFileSync(archived),bytes,'prior composition archive conflict');
  else fs.writeFileSync(archived,bytes,{flag:'wx'});
  assert.deepEqual(fs.readFileSync(archived),bytes);fs.rmSync(safe);return archived;
}
function atomicPublish(bytes:Buffer) {
  const fd=fs.openSync(pending,'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  assert.deepEqual(fs.readFileSync(pending),bytes);fs.linkSync(pending,output);fs.rmSync(pending);
  assert.deepEqual(fs.readFileSync(output),bytes);const d=fs.openSync(path.dirname(output),'r');try{fs.fsyncSync(d);}finally{fs.closeSync(d);}
}
function compareSubset(actual:Record<string,string>, expected:Record<string,string>, label:string) {
  for(const [name,digest] of Object.entries(expected)) {
    if(Object.prototype.hasOwnProperty.call(actual,name))assert.equal(actual[name],digest,`${label} drift: ${name}`);
  }
}
function runChild(label:string,script:string,env:Record<string,string>) {
  if(process.env.COLLECTION_COMPOSITION_TEST_CHILD_FAILURE===label) {
    const fail=spawnSync(python,['-c','raise SystemExit(29)'],{cwd:root,encoding:'utf8',timeout:30_000});
    assert.notEqual(fail.status,0,'injected child failure unexpectedly passed');
    throw new Error(`${label} proof child exited ${fail.status}`);
  }
  if(process.env.COLLECTION_COMPOSITION_TEST_CHILD_TIMEOUT===label) {
    const timeoutProbe=spawnSync(python,['-c','import time; time.sleep(5)'],{cwd:root,encoding:'utf8',timeout:10});
    assert.equal(timeoutProbe.error?.code,'ETIMEDOUT','injected timeout child did not time out');
    throw new Error(`${label} proof child timed out (injected ETIMEDOUT)`);
  }
  const result=spawnSync(process.execPath,[script],{cwd:root,encoding:'utf8',env:{...process.env,...env},timeout:timeout+30_000,maxBuffer:32*1024*1024});
  fs.writeFileSync(path.join(runDirectory,label+'.log'),(result.stdout??'')+(result.stderr??'')+(result.error?`\n${result.error.stack}`:''));
  if(result.error)throw new Error(`${label} child spawn/timeout failed: ${result.error.message}`);
  if(result.signal)throw new Error(`${label} child terminated by ${result.signal}`);
  if(result.status!==0)throw new Error(`${label} proof child exited ${result.status}; see ${path.join(runDirectory,label+'.log')}`);
}

const priorArchive=archivePrior();
const stalePending=quarantine(pending,'stale-pending');
fs.mkdirSync(runDirectory,{recursive:true});
const before=snapshot();
const runtimeReceipt=path.relative(root,path.join(runDirectory,'runtime.json'));
const lifecycleReceipt=path.relative(root,path.join(runDirectory,'lifecycle.json'));
const callerReceipt=path.relative(root,path.join(runDirectory,'caller.json'));
const callerArtifactDirectory=path.relative(root,path.join(runDirectory,'caller-artifacts'));
for(const relative of [runtimeReceipt,lifecycleReceipt,callerReceipt])assert(!fs.existsSync(path.join(root,relative)),`run receipt path already exists: ${relative}`);
try {
  const runEnv={COLLECTION_COMPOSITION_RUN_ID:runId};
  runChild('runtime','verification/check-collection-runtime.ts',{
    ...runEnv,COLLECTION_RUNTIME_RECEIPT_PATH:runtimeReceipt,
    COLLECTION_RUNTIME_CHILD_TIMEOUT_MS:String(timeout),
  });
  runChild('lifecycle','verification/check-collection-lifecycle.ts',{
    ...runEnv,COLLECTION_LIFECYCLE_RECEIPT_PATH:lifecycleReceipt,
  });
  runChild('caller','verification/check-collection-adapter-contract.ts',{
    ...runEnv,COLLECTION_CALLER_RECEIPT_PATH:callerReceipt,
    COLLECTION_CALLER_ARTIFACT_DIR:callerArtifactDirectory,
    COLLECTION_CALLER_CHILD_TIMEOUT_MS:String(timeout),
  });
  const runtimeBytes=fs.readFileSync(path.join(root,runtimeReceipt));
  const lifecycleBytes=fs.readFileSync(path.join(root,lifecycleReceipt));
  const callerBytes=fs.readFileSync(path.join(root,callerReceipt));
  const runtime=JSON.parse(runtimeBytes.toString('utf8'));
  const lifecycle=JSON.parse(lifecycleBytes.toString('utf8'));
  const caller=JSON.parse(callerBytes.toString('utf8'));
  assertFreshBundle(runtime,lifecycle,caller,runId);
  for(const report of [runtime,lifecycle,caller])assert.equal(report.compositionRunId,runId,'mixed helper/caller run id');
  validateContractInterface(runtime);validateContractInterface(lifecycle);validateContractInterface(caller);
  assert.deepEqual(runtime.contractInterface,lifecycle.contractInterface,'helper contract AST mismatch');
  assert.deepEqual(runtime.contractInterface,caller.contractInterface,'caller contract AST mismatch');
  assertRuntimeInventory(runtime);assertExactCaller(caller);
  compareSubset(runtime.source_hashes_at_start,before,'runtime helper source');
  compareSubset(runtime.source_hashes_at_end,before,'runtime helper end source');
  compareSubset(runtime.source_hashes_at_publication,before,'runtime helper publication source');
  compareSubset(lifecycle.inputs,before,'lifecycle helper source');
  compareSubset(lifecycle.source_hashes_at_start,before,'lifecycle lifecycle start source');
  compareSubset(caller.inputs.before,before,'caller source');
  assert.deepEqual(caller.inputs.before,caller.inputs.after,'caller child source/artifact drift');
  assert.equal(caller.inputs.before['verification/collection_contracts.py'],before['verification/collection_contracts.py']);
  const afterChildren=snapshot();assert.deepEqual(afterChildren,before,'source snapshot drift during child checks');

  const payloadPath=path.join(runDirectory,'composition-input.json');
  const childOutput=path.join(runDirectory,'composition-result.pending.json');
  const payload={version:1,runId,
    runtimeReceiptPath:path.resolve(root,runtimeReceipt),
    lifecycleReceiptPath:path.resolve(root,lifecycleReceipt),
    callerReceiptPath:path.resolve(root,callerReceipt),
    callerArtifactDirectory:path.resolve(root,callerArtifactDirectory),
    sourceSnapshotBefore:before,sourceSnapshotAfter:afterChildren,
    runtimeReceiptSha256:crypto.createHash('sha256').update(runtimeBytes).digest('hex'),
    lifecycleReceiptSha256:crypto.createHash('sha256').update(lifecycleBytes).digest('hex'),
    callerReceiptSha256:crypto.createHash('sha256').update(callerBytes).digest('hex'),
  };
  fs.writeFileSync(payloadPath,JSON.stringify(payload,null,2)+'\n',{flag:'wx'});
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
  const py=spawnSync(python,['-I','-B','-c',bootstrap,path.resolve('verification'),payloadPath,childOutput],{
    cwd:root,encoding:'utf8',env:{...process.env,COLLECTION_COMPOSITION_RUN_ID:runId},timeout:timeout,maxBuffer:32*1024*1024,
  });
  if(py.stdout)process.stdout.write(py.stdout);if(py.stderr)process.stderr.write(py.stderr);
  if(py.error)throw new Error(`composition Python spawn/timeout failed: ${py.error.message}`);
  if(py.signal)throw new Error(`composition Python terminated by ${py.signal}`);
  if(py.status!==0)throw new Error(`composition Python exited ${py.status}`);
  assert(fs.existsSync(childOutput),'composition Python returned zero without a result');
  const reportBytes=fs.readFileSync(childOutput);const report=JSON.parse(reportBytes.toString('utf8'));
  assert.equal(report.passed,true);assert.equal(report.compositionRunId,runId);
  assert.equal(report.format,'bend.collection-helper-caller-composition/v1');
  assertCompositionReceipt(report,runtime,lifecycle,caller,{
    runtime:crypto.createHash('sha256').update(runtimeBytes).digest('hex'),
    lifecycle:crypto.createHash('sha256').update(lifecycleBytes).digest('hex'),
    caller:crypto.createHash('sha256').update(callerBytes).digest('hex'),
  },runId);
  assert.equal(report.contractInterfaceHash,runtime.contractInterfaceHash);
  assert.deepEqual(report.helperReceiptByteHashes,{
    runtime:crypto.createHash('sha256').update(runtimeBytes).digest('hex'),
    lifecycle:crypto.createHash('sha256').update(lifecycleBytes).digest('hex'),
    caller:crypto.createHash('sha256').update(callerBytes).digest('hex'),
  },'composition consumed receipt bytes differ from fresh child receipts');
  assert.equal(report.solverObligationCount,report.solverObligations.length);
  assert(report.solverObligations.length>0 && report.solverObligations.every((q:any)=>q.result==='UNSAT'));
  assert.equal(report.grammarRestrictionCount,report.grammarRestrictions.length);
  assert.equal(report.emittedCMutationCount,report.emittedCMutations.length);
  assert.equal(report.parsedObservationSensitivityCount,report.parsedObservationSensitivity.length);
  assert(report.claimInventory.unique.length===report.claimInventory.count);
  assert.deepEqual(snapshot(),before,'source drift during composition');
  report.parentRunEvidence={priorSuccessfulArchive:priorArchive,stalePendingQuarantine:stalePending};
  const publicationBytes=Buffer.from(JSON.stringify(report,null,2)+'\n');
  atomicPublish(publicationBytes);
  assert.deepEqual(fs.readFileSync(output),publicationBytes,'published composition receipt changed bytes');
  process.stdout.write(`Composition report: ${output}\n`);
} catch(error) {
  const fresh=quarantine(pending,'unaccepted');
  const partiallyPublished=quarantine(output,'unaccepted-published');
  assert.equal(fs.existsSync(output),false,'failed composition left a canonical success receipt');
  process.stderr.write(`collection composition failed: ${String(error)}${fresh?`; preserved pending ${fresh}`:''}${partiallyPublished?`; preserved partial publication ${partiallyPublished}`:''}; run evidence ${runDirectory}; prior archive ${priorArchive??'none'}\n`);
  process.exitCode=1;
}
