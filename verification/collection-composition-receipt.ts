import assert from 'node:assert/strict';
import crypto from 'node:crypto';

export const expectedContractInterfaceHash = '2da12678fae245f92089c8a241c16c737f69b87e24d4804e7d0696dadd2c6781';

export const runtimeAssumptions = [
  'No range precondition is placed on the modeled u32 collection/window/scalar fields; length > capacity is included and select must refuse it.',
  'Collection, window, and output pointers designate valid, non-null, disjoint objects of the declared types; writable outputs have the required write permission. Pointer validity and bounds are assumed, not proved in this slice.',
  'u8/u32/u64 have widths 8/32/64 as asserted in runtime/solana_min.h; the reusable C parser, this local interpreter and Z3 bridge implement the listed restricted C semantics correctly.',
  'Only normally returning helper control flow is modeled. Clang/LLD/SBF preservation, loader behavior, codecs, roots, open/record/commit, ABI-3 callers and transaction rollback are outside scope.',
];

export const callerAssumptions = [
  'Input pointer and serialized allocation bounds are valid under the pinned loader contract. read_account refuses unsupported duplicate markers and produces truthful Account fields; key equality and little-endian reads have their specified byte semantics.',
  'open, codecs, select, plan and checked Bend roots are free of externally observable effects (including CPI, logging and return-data changes) before commit; each modeled stage is required to execute at most once on a path, and repeated invocations reject as unsupported. Helpers and codecs initialize only their specified outputs; failure preserves managed account data.',
  'The parsed open, select, record, plan and commit calls instantiate the shared bend.collection-helper-contracts/v1 typed AST. Successful open outputs feed select; select outputs feed record and plan; plan outputs and accepted record encoders feed commit. Exact object argument spellings are source grammar facts and are not reported as SMT pointer-equality claims. Run also assumes count=3, mode<=1 and initialize=(mode==0), discharged by the exact checked entry dispatch.',
  'The imported commit contract is no-fail under the accepted plan and writes exactly its specified collection bytes. Distinct local scratch objects, account objects and loaded account allocations are disjoint. Return-data syscall has its declared no-result ABI.',
  'Generated headers must match the fixed reviewed byte allowlist, independently of the candidate manifest. This restriction does not prove their bodies: codecs and Bend roots obey their recorded schema and type layouts by assumption. Context constructors and byte-read primitives have their specified pure semantics.',
  'The restricted parser, symbolic executor, Python interpreter, proof driver and Z3 are trusted. Scalar operations outside the modeled unsigned ABI subset reject rather than receive guessed C semantics.',
];

export const callerRunInventory: Record<string,number> = {
  'all caller paths return':1,'commit consumes an accepted bounded plan':1,
  'commit consumes initialized record 0':1,'commit consumes initialized record 1':1,
  'commit consumes initialized state encoding':1,'ordered refusal and success result':1,
  'outcome field initialized by root':6,'reachability: clock':1,'reachability: commit':1,
  'reachability: context':1,'reachability: instruction_decode':1,'reachability: metadata':1,
  'reachability: open':1,'reachability: plan':1,'reachability: record_decode_0':1,
  'reachability: record_decode_1':1,'reachability: record_encode_0':1,'reachability: record_encode_1':1,
  'reachability: return_data':1,'reachability: root':1,'reachability: select_window':1,
  'reachability: selector':1,'reachability: state_decode_initial':1,'reachability: state_decode_stored':1,
  'reachability: state_encode':1,'reachability: state_header_write':1,'reachability: state_payload_write':1,
  'record 0 active record span follows shared contract':1,'record 0 read within loaded window':1,
  'record 1 active record span follows shared contract':1,'record 1 read within loaded window':1,
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
export const callerEntryInventory: Record<string,number> = {
  'account loader receives live pointer':3,'all caller paths return':1,
  'dispatch canonical instruction bounds':1,'dispatch count exactly three':1,
  'entry loop stays within three slots':4,'instruction length read uses live pointer':1,
  'ordered refusal and success result':1,'reachability: dispatch':1,'reachability: length_read':1,
  'reachability: load_0':1,'reachability: load_1':1,'reachability: load_2':1,
  'reachability: mode_read':1,'stage invoked at most once: dispatch':1,
  'stage invoked at most once: length_read':1,'stage invoked at most once: load_0':1,
  'stage invoked at most once: load_1':1,'stage invoked at most once: load_2':1,
};

export const observationForms = [
  ['bend_collection_open',['&accounts[2]','program','state->key','collection_header','4','initialize','&collection'],'open_error',null],
  ['bend_collection_select',['&collection','selection.as.c1.f0.as.c0.f0','selection.as.c1.f0.as.c0.f1','2','&selected'],'select_ok',null],
  ['bend_collection_record',['&collection','&selected','0'],null,'record_pointer_0'],
  ['bend_collection_record',['&collection','&selected','1'],null,'record_pointer_1'],
  ['bend_collection_plan',['&collection','&selected','written','next'],'plan_ok',null],
  ['bend_collection_commit',['&collection','&selected','written','next','encoded_records','collection_header','state->key'],null,null],
];

export const runtimeClaimHistograms: Record<string,Record<string,number>> = {
  select:{
    'select: source paths cover all u32 inputs':1,'select: exact return and output contract':1,
    'select: evaluated u32 subtraction cannot underflow':5,'select: output fields do not mutate on refusal':1,
    'select: exact start/reserved/loaded outputs on success':1,'select: collection input is unchanged':1,
  },
  plan:{
    'plan: source paths cover all u32 inputs':1,'plan: exact return and output contract':1,
    'plan: evaluated u32 subtraction cannot underflow':34,'plan: collection and window inputs are unchanged':1,
  },
};
export const runtimeRangeNames: Record<string,string[]> = {
  select:['select: start is within old logical length','select: reservation addition does not wrap',
    'select: reserved end is within capacity','select: loaded count does not exceed reservation',
    'select: loaded end addition does not wrap','select: loaded end is within old logical length'],
  plan:['plan: written record count fits selected reservation','plan: written range addition does not wrap',
    'plan: written range fits collection capacity','plan: loaded prefix is retained by count',
    'plan: next logical length is bounded','plan: additions equal logical length growth',
    'plan: appends extend exactly from old tail','plan: loaded end addition does not wrap',
    'plan: old length plus additions does not wrap','plan: old plus appended count equals next length without u32 wrap'],
};

export const lifecycleClaimNames = [
  'open exact ordered error/success contract','open C reads stay within caller-provided objects',
  'open every path returns','open return paths are exclusive','refusal preserves output object',
  'success writes exact collection fields','open Account object remains unchanged on success and refusal',
  'open refusal preserves the Account object','open evaluated signed arithmetic and shifts avoid C undefined behavior',
  'open C short-circuit skips undefined arithmetic in an unevaluated operand',
  'open unsigned division/remainder yields exact capacity payload relation',
  'record size input matches its C bitvector','record length input matches its C bitvector',
  'record capacity input matches its C bitvector','record stride input matches its C bitvector',
  'record start input matches its C bitvector','record reserved input matches its C bitvector',
  'record loaded input matches its C bitvector','record local input matches its C bitvector',
  'record exact null/non-null guard','record address is exact 56 + (start + local) * stride',
  'record u32 index addition does not wrap','record C-width address arithmetic does not wrap',
  'record returned stride lies within opened allocation','record names a logical active record',
  'record intermediate pointer formations and evaluated byte reads stay within caller-provided objects',
  'commit size input matches its C bitvector','commit length input matches its C bitvector',
  'commit capacity input matches its C bitvector','commit stride input matches its C bitvector',
  'commit start input matches its C bitvector','commit reserved input matches its C bitvector',
  'commit loaded input matches its C bitvector','commit written input matches its C bitvector',
  'commit next length input matches its C bitvector','commit scratch extent input matches its C bitvector',
  'commit exact header/length/key/window bytes and unchanged outside','commit writes the planned logical length',
  'commit record range stays disjoint from header',
  'commit parsed pointer formations and byte spans match bounded object ranges',
  'commit C-width count, stride and address calculations do not wrap',
  'commit actual C subscripts match summarized copy addresses',
  'commit copy summaries match C address/count values and terminate',
];

export const compositionQueryNames = [
  'open call status is the shared ordered open contract',
  'successful open outputs feed collection length and capacity',
  'parsed select scalar arguments and status match the shared select contract',
  'successful select establishes the full bounded window precondition',
  'successful open establishes well-formed collection metadata',
  'record 0 call is reachable only for a loaded local index',
  'record 0 returns the contract pointer for the parsed call',
  'record 0 four-byte decode lies inside the active record',
  'record 1 call is reachable only for a loaded local index',
  'record 1 returns the contract pointer for the parsed call',
  'record 1 four-byte decode lies inside the active record',
  'parsed plan status matches the shared plan contract',
  'successful plan establishes every record and append precondition',
  'accepted plan keeps written count, next length and append tail bounded',
  'commit executes only after an accepted plan and successful encoders',
  'commit call satisfies every shared precondition including allocation extent',
  'eight-byte record scratch covers written times four-byte stride',
  'successful commit path reaches both state writes and return data',
  'open, select and plan refusal exits do not reach commit',
];
export const bridgeSensitivityNames = [
  'open call status is the shared ordered open contract',
  'successful open outputs feed collection length and capacity',
  'parsed select scalar arguments and status match the shared select contract',
  'successful select establishes the full bounded window precondition',
  'successful open establishes well-formed collection metadata',
  'record 0 call is reachable only for a loaded local index',
  'record 0 returns the contract pointer for the parsed call',
  'record 0 four-byte decode lies inside the active record',
  'record 1 call is reachable only for a loaded local index',
  'record 1 returns the contract pointer for the parsed call',
  'record 1 four-byte decode lies inside the active record',
  'parsed plan status matches the shared plan contract',
  'successful plan establishes every record and append precondition',
  'accepted plan keeps written count, next length and append tail bounded',
  'commit executes only after an accepted plan and successful encoders',
  'commit call satisfies every shared precondition including allocation extent',
  'eight-byte record scratch covers written times four-byte stride',
  'successful commit path reaches both state writes and return data',
  'open, select and plan refusal exits do not reach commit',
];
export const callerCompositionPreconditionNames = [
  'record 0 read within loaded window','record 1 read within loaded window',
  'commit consumes an accepted bounded plan','commit consumes initialized state encoding',
  'commit consumes initialized record 0','commit consumes initialized record 1',
];
export const mutationNames = [
  'open wrong Account object','open wrong output object','open wrong stride scalar',
  'select wrong collection object','select wrong maximum','record wrong collection object',
  'record wrong window object','plan swapped written and next','commit wrong collection object',
  'commit wrong window object','commit wrong record scratch argument','commit wrong state key',
  'open error check returns success','select refusal check returns success',
  'record zero guard admits inactive slot','plan refusal check returns success',
  'missing active record encoding','state writes reordered','commit call moved before plan',
];
export const observationFaultNames = [
  'observation 0 arguments fault','observation 1 arguments fault',
  'observation 2 arguments fault','observation 3 arguments fault',
  'observation 4 arguments fault','observation 5 arguments fault',
  'observation 0 statusInput fault','observation 1 statusInput fault',
  'observation 4 statusInput fault',
  'observation 0 scalarBindings fault','observation 1 scalarBindings fault',
  'observation 4 scalarBindings fault','observation 5 scalarBindings fault',
  'observation 2 pointerResult fault',
  'observation 5 ordinal fault','observation 0 pathCondition fault',
];

export const grammarRestrictions = [
  'open object identity is the parsed &accounts[2] input and &collection output aggregate',
  'select, record, plan and commit use the same parsed &collection and &selected objects',
  'open stride is the parsed literal 4; select maximum is the parsed literal 2',
  'record call sites are nested in the four-byte U32 decoders and use local literals 0 and 1',
  'commit uses the parsed eight-byte encoded_records scratch object, collection_header and state->key',
  'parsed helper call order is open, select, record(0), record(1), plan, commit; ordinals come from the reparsed emitted C',
  "commit, state-header write, state-payload write and return-data syscall order is checked by the caller's path-sensitive source interpreter",
  'object identity and exact C argument spellings are grammar/source facts, not SMT theorem counts',
];
export const compositionWorldAssumptions = [
  'The generated loader provides valid, aligned and truthful account objects and collection data extent; account allocations, data, keys, headers, stack scratch and local buffers are disjoint and stable for this invocation.',
  'The restricted codec and root contracts, context construction and byte-read semantics are pure before commit and obey their specified schema and ABI behavior; their implementation bodies are trusted by assumption.',
  'The supported C pointer/object representation, target integer ABI, syscall behavior, parser, proof drivers, Python and Z3 are trusted. Runtime abort/rollback and C-to-LLVM/SBF preservation are outside the theorem.',
  'The lifecycle span/bitvector cross-domain conclusion remains the accepted prose-level source-width argument, not one combined SMT pointer-range theorem.',
];

function canonical(value:any):any {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}
export function validateContractInterface(report:any) {
  assert.equal(report.contractInterface?.format,'bend.collection-helper-contracts/v1','contract AST format');
  const computed=crypto.createHash('sha256').update(JSON.stringify(canonical(report.contractInterface))).digest('hex');
  assert.equal(report.contractInterfaceHash,computed,'contract interface hash does not match its AST');
  assert.equal(report.contractInterfaceHash,expectedContractInterfaceHash,
    'shared collection contract changed from the reviewed composition interface');
}
function hist(items:any[], key='name') {
  const result:Record<string,number>={};
  for(const item of items) result[item[key]]=(result[item[key]]??0)+1;
  return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
function normalized(expected:Record<string,number>) {
  return Object.fromEntries(Object.entries(expected).sort(([a],[b])=>a.localeCompare(b)));
}
export function assertExactCaller(report:any) {
  assert.equal(report.format,'bend.collection-caller-paths/v3');
  assert.equal(report.passed,true);
  assert.deepEqual(hist(report.proofs.run),normalized(callerRunInventory),'exact caller run proof inventory');
  assert.deepEqual(hist(report.proofs.entry),normalized(callerEntryInventory),'exact caller entry proof inventory');
  assert.deepEqual(report.assumptions,callerAssumptions,'exact caller assumptions');
  assert.deepEqual(report.callObservations.map((row:any)=>[row.function,row.arguments,row.statusInput??null,row.pointerResult??null]),
    observationForms,'exact parsed helper observation inventory');
  for(const section of Object.values(report.proofs) as any[][])
    assert(section.every(item=>item.result==='unsat'),'caller proof is not UNSAT');
}
export function assertRuntimeInventory(report:any) {
  assert.equal(report.schema,2);assert.equal(report.status,'PASS');assert.equal(report.passed,true);
  assert.deepEqual(report.assumptions,runtimeAssumptions,'exact runtime assumptions');
  assert.deepEqual(Object.keys(report.proofs).sort(),['plan','select']);
  for(const kind of ['select','plan']) {
    assert.deepEqual(hist(report.proofs[kind].obligations,'label'),normalized(runtimeClaimHistograms[kind]),`${kind} exact claim multiplicities`);
    assert(report.proofs[kind].obligations.every((item:any)=>item.result==='UNSAT'),`${kind} has a non-UNSAT obligation`);
    assert.deepEqual(report.proofs[kind].range_and_append_obligations.map((x:any)=>x.label).sort(),
      [...runtimeRangeNames[kind]].sort(),`${kind} exact range inventory`);
    assert(report.proofs[kind].range_and_append_obligations.every((item:any)=>item.result==='UNSAT'));
  }
}
export function assertLifecycleInventory(report:any) {
  assert.equal(report.schema,6);assert.equal(report.passed,true);
  assert.deepEqual(report.claimResults.map((x:any)=>x.name),lifecycleClaimNames,'exact lifecycle claim inventory');
  assert(report.claimResults.every((item:any)=>item.result==='unsat'),'lifecycle claim is not UNSAT');
  const commit=report.contractInterface.contracts.commit;
  const formulas=commit.precondition.args;
  const bindings=commit.preconditionImports;
  assert.equal(bindings.length,formulas.length,'exact shared commit precondition import count');
  assert.deepEqual(report.commit.contractPreconditionImports,formulas.map((contractFormula:any,index:number)=>({
    contractFormula,source:bindings[index].source,sourceClaims:bindings[index].claims,
    disposition:'CHECKED_BY_FRESH_COMPOSITION_PARENT',
  })),'exact scoped commit precondition imports');
}
export function assertFreshBundle(runtime:any,lifecycle:any,caller:any,runId:string) {
  for(const report of [runtime,lifecycle,caller]) assert.equal(report.compositionRunId,runId,'mixed helper/caller run id');
  assertRuntimeInventory(runtime);assertLifecycleInventory(lifecycle);assertExactCaller(caller);
  for(const report of [runtime,lifecycle,caller]) validateContractInterface(report);
  assert.deepEqual(runtime.contractInterface,lifecycle.contractInterface,'helper contract AST mismatch');
  assert.deepEqual(runtime.contractInterface,caller.contractInterface,'caller contract AST mismatch');
  assert.equal(lifecycle.contractInterfaceHash,runtime.contractInterfaceHash);
  assert.equal(caller.contractInterfaceHash,runtime.contractInterfaceHash);
}
export function assertCompositionReceipt(report:any, runtime:any, lifecycle:any, caller:any,
    expectedHashes:Record<string,string>, runId:string) {
  assert.equal(report.format,'bend.collection-helper-caller-composition/v1');
  assert.equal(report.passed,true);assert.equal(report.compositionRunId,runId);
  assert.equal(report.contractInterfaceHash,runtime.contractInterfaceHash);
  validateContractInterface(report);
  assert.deepEqual(report.contractInterface,runtime.contractInterface,'composition contract AST differs from fresh helper AST');
  assert.deepEqual(report.commitPreconditionImports,lifecycle.commit.contractPreconditionImports,
    'composition did not consume the lifecycle precondition imports');
  assert.deepEqual(report.callerCompositionPreconditions.map((x:any)=>x.name),callerCompositionPreconditionNames,
    'exact fresh caller precondition imports');
  assert(report.callerCompositionPreconditions.every((x:any)=>x.result==='UNSAT' &&
    x.disposition==='REPROVED_FROM_FRESH_PARSED_CALLER' && typeof x.formula==='string' && x.formula.length>0),
    'caller precondition is missing its fresh proof binding');
  const callerRunNames=new Set(caller.proofs.run.map((x:any)=>x.name));
  assert(callerCompositionPreconditionNames.every(name=>callerRunNames.has(name)),
    'composition imported a precondition absent from the exact caller receipt');
  assert.deepEqual(report.helperReceiptByteHashes,expectedHashes,'consumed helper receipt byte hashes');
  assert.deepEqual(report.solverObligations.map((x:any)=>x.name),compositionQueryNames,'exact composition solver inventory');
  assert(report.solverObligations.every((x:any)=>x.result==='UNSAT'),'composition solver obligation is not UNSAT');
  assert.deepEqual(report.bridgeQuerySensitivity.map((x:any)=>x.query),bridgeSensitivityNames,'exact bridge sensitivity inventory');
  assert(report.bridgeQuerySensitivity.every((x:any)=>x.enabledQueryResult==='UNSAT' &&
    x.disabledQueryFaultResult==='SAT' && x.disabledQueryAdmitsFault===true &&
    x.polarity==='negated obligation becomes satisfiable when the named link is disabled' &&
    Object.keys(x.counterexample).length>0),'bridge query sensitivity lacks a SAT fault witness');
  assert.deepEqual(report.bridgeQuerySensitivityMethodCounts,{sharedContractLinks:13,parsedControlFlowEvents:6},
    'bridge sensitivity method counts');
  for(const row of report.bridgeQuerySensitivity) {
    assert(Array.isArray(row.disabledLinks) && row.disabledLinks.length>0,
      'bridge sensitivity omitted its disabled link inventory');
    assert(['disabled shared-contract link','disabled parsed-control-flow event'].includes(row.method),
      'bridge sensitivity method changed');
  }
  assert.deepEqual(report.grammarRestrictions,grammarRestrictions,'exact grammar restriction inventory');
  assert.deepEqual(report.emittedCMutations.map((x:any)=>x.name),mutationNames,'exact emitted-C mutation inventory');
  assert(report.emittedCMutations.every((x:any)=>['grammar','semantic'].includes(x.kind)));
  for(const mutation of report.emittedCMutations) {
    if(mutation.kind==='semantic') assert(typeof mutation.claim==='string' && Object.keys(mutation.counterexample??{}).length>0,
      'semantic emitted-C mutation lacks a solver counterexample');
    else assert(typeof mutation.reason==='string' && mutation.reason.length>0,'grammar mutation lacks a parser restriction reason');
  }
  assert.deepEqual(report.parsedObservationSensitivity.map((x:any)=>x.name),observationFaultNames,'exact parsed observation fault inventory');
  assert(report.parsedObservationSensitivity.every((x:any)=>x.result==='REJECTED'));
  assert.deepEqual(report.callerPathObligations,caller.proofs.run,'fresh caller path claims differ from receipt');
  assert.equal(report.callerSolverObligationCount,caller.proofs.run.length,'caller obligation count differs from exact run inventory');
  assert.deepEqual(report.reachability.initializationAndStoredSuccess.map((x:any)=>x.name),[
    'successful complete caller path in initialization mode','successful complete caller path in stored mode',
  ]);
  assert.deepEqual(report.reachability.loadedCounts.map((x:any)=>x.name),[
    'loaded count 0 is reachable from successful select','loaded count 1 is reachable from successful select',
    'loaded count 2 is reachable from successful select',
  ]);
  assert.deepEqual(report.reachability.writtenCounts.map((x:any)=>x.name),[
    'written count 0 is reachable from successful plan','written count 1 is reachable from successful plan',
    'written count 2 is reachable from successful plan',
  ]);
  assert.deepEqual(report.reachability.openRefusals.map((x:any)=>x.name),[
    'open owner refusal returns 3','open executable refusal returns 3',
    'open writable refusal returns 5','open minimum-size refusal returns 4',
    'open payload-divisibility refusal returns 4','open initialization signer refusal returns 7',
    'open initialization allocation refusal returns 4','open stored header refusal returns 4',
    'open stored key refusal returns 4','open stored length refusal returns 4',
  ]);
  assert.deepEqual(report.reachability.callerRefusalExits.map((x:any)=>x.name),[
    'select refusal exits before record decode','loaded record decoder refusal exits before root',
    'plan refusal exits before commit','state encoder refusal exits before commit',
    'active record encoder refusal exits before commit',
  ]);
  const witnesses=[...report.reachability.initializationAndStoredSuccess,...report.reachability.loadedCounts,
    ...report.reachability.writtenCounts,...report.reachability.openRefusals,...report.reachability.callerRefusalExits];
  assert(witnesses.every((x:any)=>x.result==='SAT' && Object.keys(x.values).length>0),
    'reachability witness inventory contains a non-SAT or empty witness');
  assert.equal(report.solverObligationCount,report.solverObligations.length);
  assert.equal(report.bridgeQuerySensitivityCount,report.bridgeQuerySensitivity.length);
  assert.equal(report.grammarRestrictionCount,report.grammarRestrictions.length);
  assert.equal(report.emittedCMutationCount,report.emittedCMutations.length);
  assert.equal(report.parsedObservationSensitivityCount,report.parsedObservationSensitivity.length);
  assert.deepEqual(Object.keys(report.assumptions).sort(),['caller','compositionWorld','lifecycle','runtime']);
  assert.deepEqual(report.assumptions.runtime,runtime.assumptions,'runtime assumption set narrowed or changed');
  assert.deepEqual(report.assumptions.lifecycle,lifecycle.assumptions,'lifecycle assumption set narrowed or changed');
  assert.deepEqual(report.assumptions.caller,caller.assumptions,'caller assumption set narrowed or changed');
  assert.deepEqual(report.assumptions.compositionWorld,compositionWorldAssumptions,'composition world assumptions changed');
  assert.deepEqual(Object.keys(report.artifactHashes).sort(),[
    'collection-store.c','collection-store.h','collection-store.interface.json',
    'collection-store.manifest.json','collection-store.schema.json','collection-store.wire.h',
  ].sort(),'exact generated artifact hash inventory');
  assert.deepEqual(Object.keys(report.includeHashes).sort(),[
    'bend_collection_runtime.h','collection-store.c','collection-store.h','collection-store.wire.h','solana_min.h',
  ].sort(),'exact include hash inventory');
  const artifactKeys:Record<string,string>={
    'collection-store.c':'artifact:adapterPath','collection-store.h':'artifact:headerPath',
    'collection-store.wire.h':'artifact:wirePath','collection-store.schema.json':'artifact:schemaPath',
    'collection-store.interface.json':'artifact:interfacePath','collection-store.manifest.json':'artifact:manifestPath',
  };
  const sourceHashes=caller.inputs.before;
  assert.deepEqual(report.artifactHashes,Object.fromEntries(Object.entries(artifactKeys)
    .map(([name,key])=>[name,sourceHashes[key]]).sort(([a],[b])=>String(a).localeCompare(String(b)))),
    'generated artifact hash values differ from fresh caller child');
  assert.deepEqual(report.includeHashes,Object.fromEntries(Object.keys(report.includeHashes).sort()
    .map(name=>[name,sourceHashes[name]])),'include hash values differ from fresh caller child');
  for(const digest of [...Object.values(report.artifactHashes),...Object.values(report.includeHashes)])
    assert.match(digest,/^[0-9a-f]{64}$/,'artifact/include hash is malformed');
  const names=[...new Set([
    ...Object.keys(runtimeClaimHistograms.select),...Object.keys(runtimeClaimHistograms.plan),
    ...runtimeRangeNames.select,...runtimeRangeNames.plan,
    ...lifecycleClaimNames,
    ...Object.entries(callerRunInventory).flatMap(([name,count])=>
      Array.from({length:count},(_,index)=>`caller:run:${name}#${index+1}`)),
    ...Object.entries(callerEntryInventory).flatMap(([name,count])=>
      Array.from({length:count},(_,index)=>`caller:entry:${name}#${index+1}`)),
    ...compositionQueryNames,
  ])].sort();
  assert.deepEqual(report.claimInventory,{count:names.length,unique:names},'full unique claim inventory');
  const runtimeClaims=[...new Set([
    ...Object.keys(runtimeClaimHistograms.select),...Object.keys(runtimeClaimHistograms.plan),
    ...runtimeRangeNames.select,...runtimeRangeNames.plan,
  ])].sort();
  assert.deepEqual(report.importedHelperClaims,{
    runtime:runtimeClaims,lifecycle:[...lifecycleClaimNames],
    caller:[...new Set([...caller.proofs.run,...caller.proofs.entry].map((x:any)=>x.name))].sort(),
    compositionPremises:['open unsigned division/remainder yields exact capacity payload relation'],
  },'exact imported helper claim inventory');
}
