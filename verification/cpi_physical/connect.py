"""Fresh actual CPI caller -> U64 physical frame -> commit and failure frames.

This maintained driver uses fresh root/codec/extraction/validator/caller checks.
Physical allocation/runtime write permissions remain explicit assumptions.
"""
import hashlib, importlib.util, json, pathlib, subprocess, sys, uuid
import z3 as z
root=pathlib.Path.cwd();run=pathlib.Path(sys.argv[1])
sys.path.insert(0,str(root/'verification'))
import multi_adapter_contract as m
from adapter_contract_sym import Ptr,Ref,Int,concrete
from cpi_caller.caller import analyse_fixture
from acyclic_c import check as check_root
from cpi_composition import audit_executor
from cpi_physical import frame
from cpi_physical.commit import analyse as physical_commit
from cpi_physical.projections import connect as connect_projections
from cpi_physical import validator_count as count_model
from cpi_physical.typed_dag import Fingerprints, SCHEME
from cpi_physical.witness import specialize, SPECIALIZATION
assert __debug__ and z.get_version_string()=='5.1.0'
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
input_path=run/'fixtures/input.json';profiles_path=run/'native-profiles.json'
data=json.loads(input_path.read_bytes());profiles=json.loads(profiles_path.read_bytes())
inputs=json.loads((run/'inputs.json').read_bytes())['inputs']
inputs.update(data['immutableInputs']);inputs.update(profiles['inputs'])
for p in [input_path,profiles_path,*sorted((root/'verification/cpi_physical').glob('*.py'))]:inputs[str(p)]=sha(p)
def bound():
 for p,h in inputs.items():assert sha(p)==h,p
bound()
base_world=m.MultiWorld;base_exec=m.MultiExec;base_analyse=m.analyse
captured=[]
class Capture(base_exec):
 def call_memcpy(self,name,args,st,g):
  result=super().call_memcpy(name,args,st,g);event=st.events[-1];assert event.kind=='write'
  source=args[1]
  if isinstance(source,Ref):
   assert source.path[0]=='var';event.f['physicalSourceKind']='local';event.f['physicalSourceName']=source.path[1]
  else:
   assert isinstance(source,Ptr) and source.region[0]=='key'
   assert concrete(Int('u64',source.off))==0
   event.f['physicalSourceKind']='key';event.f['physicalSourceName']=str(source.region[1])
  return result
def observe(*args,**kwargs):
 result=base_analyse(*args,**kwargs);captured.append(m.MultiWorld.latest);return result
attempt=run/'connection-attempts'/str(uuid.uuid4());attempt.mkdir(parents=True)
rows=[]
for fixture in data['fixtures']:
 folder=attempt/fixture['name'];folder.mkdir();fingerprint=Fingerprints()
 print(fixture['name'],'fresh full source/C caller starting',flush=True)
 m.MultiExec=Capture;m.analyse=observe
 try:
  root_proof=check_root(fixture['program'])
  caller=analyse_fixture(fixture,profiles)
 finally:m.MultiExec=base_exec;m.analyse=base_analyse
 w=captured[-1];summary=w.m;writing=[(i,p) for i,p in enumerate(w.paths) if any(e.kind=='write' for e in p.events)]
 executing=[(i,p) for i,p in enumerate(w.paths) if any(e.kind=='execute' for e in p.events)]
 for _,path in executing:
  calls=[e for e in path.events if e.kind=='execute']
  assert [e.slot for e in calls] in [[0],[0,1]] and all(e.fn=='bend_invoke_execute' for e in calls)
 invoke_guards=[z.Or(*[p.pc for _,p in executing if any(e.kind=='execute' and e.slot==slot for e in p.events)]) for slot in range(2)]
 assert writing and len(summary['fields'])==int(fixture['name'][-1]) and summary['slots']==2
 print(fixture['name'],'full caller passed; connecting physical frame',flush=True)
 executor=audit_executor(fixture['files'])
 count_dir=folder/'validator-count';count_dir.mkdir()
 count_report,count_bounds=count_model.connect(w,fixture,count_dir)
 def query(name,bad,premises=None,wanted=z.unsat):
  solver=z.Solver();solver.set(timeout=120000)
  # Exact fresh pruning exclusions are independently proved under the checked
  # defining equations. They can reduce the query but cannot replace those
  # equations on a SAT result from the stronger, reduced domain.
  reused=w.pruning.exclusions(w.axioms()) if premises is None else []
  solver.add(*(base_world.axioms(w) if premises is None else premises),*reused,*(count_bounds if premises is None else []),bad)
  file=folder/(name+'.smt2');file.write_text(solver.to_smt2())
  answer=solver.check()
  method='exact fresh pruning lemmas' if premises is None else 'explicit composed premises'
  if answer!=wanted and premises is None:
   solver=z.Solver();solver.set(timeout=120000);solver.add(*w.axioms(),*reused,*count_bounds,bad)
   file=folder/(name+'-full.smt2');file.write_text(solver.to_smt2())
   answer=solver.check();method='full checked defining equations and fresh pruning lemmas'
  if answer!=wanted:
   failure={'name':name,'result':str(answer),'reason':solver.reason_unknown(),'query':str(file),'querySha256':sha(file)}
   if answer==z.sat:failure['witness']=m.complete_model(solver.model())
   (folder/(name+'-failure.json')).write_text(json.dumps(failure,indent=2)+'\n')
   raise RuntimeError((name,str(answer),solver.reason_unknown()))
  row={'name':name,'result':str(answer),'query':str(file),'querySha256':sha(file),'method':method}
  if answer==z.sat:row['witness']=m.complete_model(solver.model())
  return row
 def concrete_witness(name,formula,premises,pins):
  grounded,assignments=specialize(formula,premises,pins)
  row=query(name,grounded,[],z.sat)
  row['specialization']=SPECIALIZATION
  row['groundedInputs']=assignments
  return row
 v=lambda n:z.BitVecVal(n,64);v32=lambda n:z.BitVecVal(n,32)
 count=len(w.KEY);assert count==12
 def capability(slot,k):
  src=(summary['accepted'],1)
  return z.And(invoke_guards[slot],w.eff(src,slot,'active')!=0,z.Or(*[z.And(z.ULT(v32(j),w.eff(src,slot,'count')),w.meta(src,slot,j,'writable')!=0,
             w.meta(src,slot,j,'index')==v32(k),z.ULT(v(k),w.COUNT)) for j in range(8)]))
 gate_bad=[z.And(path.pc,invoke_guards[slot]!=z.BoolVal(any(e.kind=='execute' and e.slot==slot for e in path.events))) for path in w.paths for slot in range(2)]
 gate_proof=query('actual-parsed-execution-gates',z.Or(*gate_bad))
 bad=[capability(slot,field['index']) for slot in range(2) for field in summary['fields']]
 exclusion=query('actual-caller-managed-key-exclusion',z.Or(*bad))
 cuts=[z.Not(capability(slot,field['index'])) for slot in range(2) for field in summary['fields']]
 # Bind the exact reviewed helper return/refresh behavior to parsed call slots.
 status=[z.BitVec('cpi_runtime_status_'+str(i),64) for i in range(2)]
 active=[w.eff((summary['accepted'],1),i,'active')!=0 for i in range(2)]
 enabled=[z.And(active[i],invoke_guards[i]) for i in range(2)]
 helper=[w.EXE[i]==z.If(active[i],status[i],v(0)) for i in range(2)]
 starts=[z.BitVec('cpi_data_start_'+str(i),64) for i in range(12)]
 capacities=[w.SIZE[i]+v(10240) for i in range(12)]
 memory=z.Array('cpi_physical_initial',z.BitVecSort(64),z.BitVecSort(8))
 fresh=[z.Array('cpi_physical_returned_'+str(i),z.BitVecSort(64),z.BitVecSort(8)) for i in range(2)]
 workspace=frame.Span(z.BitVec('cpi_workspace_start',64),z.BitVec('cpi_workspace_size',64))
 descriptor=z.BitVec('cpi_descriptor_start',64);info=z.BitVec('cpi_info_start',64)
 sizes=list(w.SIZE);lengths=[];snapshots=[memory];runtime_snapshots=[];returned_lengths=[];length_bindings=[];metadata=[]
 for slot in range(2):
  lengths.append(list(sizes));returned_lengths.append([z.BitVec('cpi_returned_length_'+str(slot)+'_'+str(i),64) for i in range(12)])
  runtime=frame.runtime_step(memory,fresh[slot],starts,capacities,[capability(slot,i) for i in range(12)],[workspace],enabled[slot])
  runtime_snapshots.append(runtime)
  out=[z.If(capability(slot,i),returned_lengths[slot][i],sizes[i]) for i in range(12)]
  # The readonly output relation follows from truthful serialized lengths,
  # prior descriptor/header synchronization and derived conditional header
  # preservation. The physical byte bridge is recorded explicitly below.
  length_bindings.extend(z.Implies(z.And(enabled[slot],status[slot]==0,z.ULT(v(i),w.COUNT)),frame.read_u64(runtime,info+v(56*i+16))==out[i]) for i in range(12))
  metadata.extend(frame.returned_length_domain(runtime,info,starts,capacities,w.COUNT,enabled[slot],status[slot]))
  memory,actual_lengths=frame.refresh_descriptors(runtime,descriptor,info,enabled[slot],status[slot],w.COUNT)
  sizes=[z.If(z.And(enabled[slot],status[slot]==0,z.ULT(v(i),w.COUNT)),out[i],sizes[i]) for i in range(12)]
  snapshots.append(memory)
 later_success=query('later-helper-requires-prior-success',z.And(enabled[1],z.Or(z.Not(enabled[0]),status[0]!=0)),[*w.axioms(),*helper])
 # Fresh scalar transport proves the readonly output equation used above;
 # allocation and byte-level antecedents are derived by projections.
 previous_size,previous_header,returned_header,returned_info=z.BitVecs('length_previous_size length_previous_header length_returned_header length_returned_info',64)
 writable=z.Bool('length_writable')
 length_transport=query('truthful-readonly-length-transport',z.If(writable,returned_info,previous_size)!=returned_info,
  [previous_size==previous_header,returned_info==returned_header,z.Implies(z.Not(writable),returned_header==previous_header)])
 scalar_transport=z.Implies(z.And(previous_size==previous_header,returned_info==returned_header,z.Implies(z.Not(writable),returned_header==previous_header)),z.If(writable,returned_info,previous_size)==returned_info)
 transport_instances=[]
 for slot in range(2):
  for i in range(12):
   actual_info=frame.read_u64(runtime_snapshots[slot],info+v(56*i+16))
   before_header=frame.read_u64(snapshots[slot],starts[i]-v(8))
   after_header=frame.read_u64(runtime_snapshots[slot],starts[i]-v(8))
   pairs=[(previous_size,lengths[slot][i]),(previous_header,before_header),(returned_header,after_header),(returned_info,actual_info),(writable,capability(slot,i))]
   instance=z.substitute(scalar_transport,*pairs)
   expected=z.Implies(z.And(lengths[slot][i]==before_header,actual_info==after_header,z.Implies(z.Not(capability(slot,i)),after_header==before_header)),z.If(capability(slot,i),actual_info,lengths[slot][i])==actual_info)
   assert z.eq(instance,expected),'exact readonly length scalar transport'
   transport_instances.append({'slot':slot,'account':i,'formulaFingerprint':fingerprint(instance),'precallSynchronizationRequires':'initial loader mapping' if slot==0 else 'prior successful exact refresh and truthful serialized length','readonlyHeaderRequires':'derived conditional physical frame','infoHeaderRequires':'truthful runtime metadata'})
 preserved=[]
 for _,path in writing:
  for field in summary['fields']:
   k=field['index'];preserved.append(z.And(path.pc,sizes[k]!=w.SIZE[k]))
 length_proof=query('post-helper-managed-commit-lengths',z.Or(*preserved),[*base_world.axioms(w),*helper,*cuts])
 bounds=[]
 for _,path in writing:
  for event in path.events:
   if event.kind=='write':bounds.append(z.And(path.pc,z.ULT(sizes[event.account],v(event.offset+len(event.data)))))
 bound_proof=query('actual-commit-writes-fit-refreshed-lengths',z.Or(*bounds),[*base_world.axioms(w),*helper,*cuts])
 local_sources={e.physicalSourceName for _,p in writing for e in p.events if e.kind=='write' and e.physicalSourceKind=='local'}
 expected_sources={f'header{i}' for i in range(len(summary['fields']))}|{f'encoded{i}' for i in range(len(summary['fields']))}
 assert local_sources==expected_sources
 instances=[{'slot':slot,'runtimeMemoryFingerprint':fingerprint(runtime_snapshots[slot]),'refreshedMemoryFingerprint':fingerprint(snapshots[slot+1]),'exactByteFrameInstantiation':True} for slot in range(2)]
 projection_dir=folder/'projections';projection_dir.mkdir()
 projections,physical=connect_projections(w,starts,capacities,snapshots,runtime_snapshots,fresh,[[capability(slot,i) for i in range(12)] for slot in range(2)],enabled,status,workspace,descriptor,info,projection_dir)
 commits=physical_commit(w,starts,snapshots[-1],folder)
 witnesses=[]
 success=z.Or(*[z.And(p.pc,p.ret==0) for _,p in writing])
 for mode in [0,1]:
  for resize_to in [192,32]:
   profile=next(p for p in profiles['rows'] if p['fixture']==fixture['name'])
   wire=[mode,*profile['bytes']]
   pins=[w.COUNT==12,w.IXLEN==len(wire),*[a==b for a,b in zip(w.IXB,wire)],*[key==z.BitVecVal(i+1,256) for i,key in enumerate(w.KEY)],*[owner==z.BitVecVal(100,256) for owner in w.OWNER],w.PROGRAM==100,*w.PARSE_OK,*w.SIGNER,*w.WRITABLE,*[flag if i==2 else z.Not(flag) for i,flag in enumerate(w.EXECUTABLE)],*helper,status[0]==0,status[1]==0,*physical['allocations'],*physical['initial'],*physical['pins'],*length_bindings,*metadata,returned_lengths[0][11]==v(resize_to),returned_lengths[1][11]==v(resize_to)]
   for field in summary['fields']:
    i=field['index'];initial=[0]*field['stateBytes']
    if mode==1:
     initial[:20]=field['header']
     if field['bindingBytes']:initial[20:52]=list((1).to_bytes(32,'little'))
    pins.extend([w.SIZE[i]==len(initial),*[a==b for a,b in zip(w.D[i],initial)]])
   actual_final_length=frame.read_u64(snapshots[-1],descriptor+v(64*11+24))
   witnesses.append(concrete_witness('successful-external-resize-mode-'+str(mode)+'-to-'+str(resize_to),z.And(success,sizes[11]==v(resize_to),actual_final_length==v(resize_to)),w.axioms(),pins))
 failed=[p for p in w.paths if not any(e.kind=='write' for e in p.events)]
 assert failed and all(not any(e.kind in ('write','return_data') for e in p.events) for p in failed)
 rows.append({'fixture':fixture['name'],'rootCorrespondence':root_proof,'caller':caller,'executor':executor,'parsedValidatorCountBridge':count_report,'laterHelperPriorSuccess':later_success,'readonlyLengthTransport':length_transport,'metadataBridge':{'infosContainmentIsPremise':True,'truthfulSerializedLengthsIsPremise':True,'returnedLengthBindingsFingerprints':[fingerprint(x) for x in length_bindings],'runtimeMetadataPremisesFingerprints':[fingerprint(x) for x in metadata],'readonlyTransportInstances':transport_instances},'parsedExecutionGates':gate_proof,'executingPaths':len(executing),'failurePathsWithoutAdapterCommit':len(failed),'managedExclusion':exclusion,'managedLengthPreservation':length_proof,'commitBounds':bound_proof,'pendingSources':sorted(local_sources),'physicalFrameInstances':instances,'derivedPhysicalProjections':projections,'physicalCommit':commits,'resizeWitnesses':witnesses})
 (folder/'report.json').write_text(json.dumps(rows[-1],indent=2)+'\n')
 print(fixture['name'],'physical helper/commit connection passed',flush=True)
bound()
output={'passed':True,'sourcePromoted':True,'endToEndVerified':False,'fingerprintScheme':SCHEME,'inputs':inputs,'rows':rows,
 'scope':'Fresh actual source/C roots, canonical codecs, extraction and parsed validator/caller. Parsed execution gates cover early and helper failures as well as success. Managed writable exclusion, disjoint private workspace, exact descriptor size stores, truthful/capacity-bounded returned metadata and readonly-header transport connect later calls and commit bounds. U64 byte-frame range premises allow high SBF virtual addresses and reject wrapping capacities. Selected actual helper memory flows into parsed finite-store induction; failure paths have no adapter commit and use the same derived managed frame. Pending/key/managed projections require valid disjoint allocations and initial physical byte mapping. Effect-native-byte correspondence, runtime mutation permissions, metadata/key stability, C parser/driver, LLVM/SBF and syscall semantics trusted. No unconditional physical allocation, external-account rollback, SPL accounting or deployed-image theorem.'}
(attempt/'report.json').write_text(json.dumps(output,indent=2)+'\n')
(run/'connection-report.json').write_text(json.dumps({'report':str(attempt/'report.json'),'sha256':sha(attempt/'report.json')},indent=2)+'\n')
print(json.dumps({'passed':True,'fixtures':len(rows),'report':str(attempt/'report.json')}))
