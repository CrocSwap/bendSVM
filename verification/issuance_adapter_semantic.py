import os,copy,hashlib,json,pathlib,sys
if not __debug__:raise RuntimeError('issuance proof requires Python assertions')
# Keep both the entry directory and helper directory behind the standard library.
_here=os.path.dirname(os.path.abspath(__file__));_helpers=os.path.abspath('verification')
sys.path[:]=[p for p in sys.path if os.path.abspath(p or os.getcwd()) not in {_here,_helpers}]+[_here,_helpers]
import z3 as z
import adapter_contract as contract
from effect_semantics import Extraction
from token_semantics import Validation
from token_executor import Execution
from token_sequence import check as check_sequence
from adapter_contract_sym import World,Exec
from acyclic_c import Source,C,need,wire,check as check_root
from tagged_sum_c import check_artifacts
from tagged_sum_layout import check_layouts
from state_encoding_binding import audit as audit_rows
from codec_semantics import Codecs,PackedDecoder

root=pathlib.Path(os.environ.get('BRIDGE_DIR','build/issuance-adapter'));output=root/'semantic-report.json';output.unlink(missing_ok=True);output.with_suffix('.pending').unlink(missing_ok=True);checker_bytes=pathlib.Path(__file__).read_bytes();raw=(root/'input.json').read_bytes();data=json.loads(raw);need(z.get_version_string()=='5.1.0','Z3 pin')
bindings={**data['sourceHashes'],**data['artifactHashes']}
def bound():
 need(pathlib.Path(__file__).read_bytes()==checker_bytes,'checker changed')
 for p,h in bindings.items():need(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h,p)
bound()
need(data['program']['artifact']['c']==data['fixture']['files']['issuance.h'],'actual native header binding')
need(data['program']['source']['schema']==data['program']['artifact']['schema']==data['fixture']['schema'],'schema binding')
need(data['program']['source']['roots']==[data['fixture']['root']]==[data['fixture']['interface']['root']]==['process'],'root binding')
equivalence=check_root(data['program']);need(len(equivalence)==1 and equivalence[0]['result']=='unsat','actual source/C equivalence')
print('Bound input and source/C equivalence; parsing validator',flush=True)
validation_model=Validation(data['fixture']['files']);reserved=validation_model.verify_reserved()
print('Reserved-account independence passed',flush=True)
execution_model=Execution(data['fixture']['files'])
validation_model.claims.update(execution_model.claims(validation_model.model,validation_model.actual))
def run(program,mutated=False,arithmetic=False):
 source=Source(program['source']);check_artifacts([program['artifact']]);check_layouts([program['artifact']]);c=C(source,program['artifact']);f=copy.deepcopy(data['fixture']);f['files']['issuance.h']=program['artifact']['c'];m=contract.summarize(f['schema'],f['interface'])
 codecs=Codecs(source,{'name':'issuance','headerName':'issuance.h','schema':f['schema'],'native':f['files']['issuance.h'],'codecs':f['files']['issuance.wire.h']})
 extraction_model=Extraction(source,f);extraction_evidence=extraction_model.verify()
 for name,digest in validation_model.runtime_hashes.items():need(hashlib.sha256(f['files'][name].encode()).hexdigest()==digest,'shared validator runtime binding')
 class TypedWorld(World):
  latest=None
  def __init__(self,m):
   super().__init__(m);self.bridge=[];self.root_bridge=[];self.rows=[];self.encodings=[];self.roots=[];self.replay=[];self.effect_values=[];self.validator_values=[];self.SYSCALL=[z.BitVec('token_syscall_result'+str(i),64) for i in range(m['slots'])];TypedWorld.latest=self
   self.state_sort=source.sort(f['interface']['state']);self.ix_sort=source.sort(f['interface']['instruction'])
   self.decoded={'state':PackedDecoder(codecs,f['interface']['state']),'ix':PackedDecoder(codecs,f['interface']['instruction'])};self.decode_ok={name:decoder.ok for name,decoder in self.decoded.items()}
  def axioms(self):return super().axioms()+self.bridge
 class TypedExec(Exec):
  def call_root(self,name,args,st,g):
   context,before,instruction=args;pc=z.And(st.pc,g);words=context.f[0]
   key=c.call(m['key_maker'],list(words[:8]),pc);slot=c.call(m['slot_maker'],list(words[9:]),pc)
   ctx=c.call(m['context_maker'],[key,words[8],slot],pc)
   result=c.call(name,[ctx,before.f[1],instruction.f[1]],pc)
   sort=source.sort(m['result_name']);accepted=sort.recognizer(m['accepted'])(result)
   pairs=[(self.w.ROOT_TAG,z.If(accepted,z.BitVecVal(m['accepted'],32),z.BitVecVal(m['rejected'],32))),(self.w.outf(m['rejected'],0),sort.accessor(m['rejected'],0)(result))]
   equations=[z.Implies(pc,a==b) for a,b in pairs];self.w.root_bridge.extend(equations);self.w.bridge.extend(equations);self.w.rows.append((pc,pairs))
   next_state=sort.accessor(m['accepted'],0)(result);ok,encoded=codecs.encode(f['interface']['state'],next_state)
   guard=z.And(pc,accepted);pairs=[(self.w.enc_ok(m['accepted'],0),ok)]+list(zip(self.w.enc(m['accepted'],0),encoded))
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs));self.w.encodings.append((guard,next_state,encoded))
   effects=sort.accessor(m['accepted'],1)(result)
   extracted,slots=extraction_model.extract(effects)
   pairs=[(self.w.ext_ok(m['accepted'],1),extracted)]+[(self.w.eff((m['accepted'],1),i,'active'),slot[('active',)]) for i,slot in enumerate(slots)]
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs));self.w.effect_values.append((guard,slots))
   validation=[validation_model.bind_world(self.w,slot) for slot in slots]
   self.w.validator_values.append((guard,validation))
   pairs=[(self.w.VAL[i],value[0]) for i,value in enumerate(validation)]
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs))
   pairs=[(self.w.EXE[i],execution_model.result(slot,self.w.SYSCALL[i])[0]) for i,slot in enumerate(slots)]
   self.w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs);self.w.rows.append((guard,pairs))
   self.w.roots.append((pc,key,before.f[1],instruction.f[1],result));self.w.replay.append((pc,[ctx,before.f[1],instruction.f[1]]))
   return super().call_root(name,args,st,g)
 contract.World=TypedWorld;contract.Exec=TypedExec
 print('Checking composed adapter paths',flush=True)
 adapter=contract.analyse(m,f['adapter'],f['files'],False);w=TypedWorld.latest
 allowed=[w.ROOT_TAG,w.outf(m['rejected'],0),w.enc_ok(m['accepted'],0),*w.enc(m['accepted'],0),w.ext_ok(m['accepted'],1),*[w.eff((m['accepted'],1),i,'active') for i in range(m['slots'])]]
 allowed.extend(w.VAL[:m['slots']]);allowed.extend(w.EXE[:m['slots']])
 print('Adapter paths passed; auditing bindings',flush=True)
 binding=audit_rows(w.rows,w.bridge,World.axioms(w),allowed)
 controls=[]
 def equations(rows):return [z.Implies(guard,lhs==rhs) for guard,pairs in rows for lhs,rhs in pairs]
 missing=[(g,[(lhs,rhs) for lhs,rhs in pairs if not lhs.eq(w.enc(m['accepted'],0)[-1])]) for g,pairs in w.rows]
 retarget=[(g,[(w.EXECUTABLE[5] if lhs.eq(w.enc_ok(m['accepted'],0)) else lhs,rhs) for lhs,rhs in pairs]) for g,pairs in w.rows]
 overlap=[(z.BoolVal(True),pairs) for g,pairs in w.rows]
 circular=[(g,[(lhs,lhs if lhs.eq(w.enc(m['accepted'],0)[0]) else rhs) for lhs,rhs in pairs]) for g,pairs in w.rows]
 for label,rows,axioms,reason in [('missing-output',missing,equations(missing),'output inventory'),('input-misclassified-as-output',retarget,equations(retarget),'output inventory'),('missing-equation',w.rows,w.bridge[:-1],'equation inventory'),('overlapping-assignments',overlap,equations(overlap),'assignments-to-shared-outputs-have-disjoint-guards: sat'),('circular-encoding',circular,equations(circular),'circular value')]:
  try:audit_rows(rows,axioms,World.axioms(w),allowed)
  except ValueError as e:need(reason in str(e),'wrong binding refusal '+str(e));controls.append({'name':label,'reason':str(e)})
  else:raise ValueError('binding fault escaped '+label)
 def query(name,formula,expected,base_only=False,lemmas=()):
  solver=z.Solver() if base_only else w.solver();solver.set(timeout=30000);solver.add(World.axioms(w) if base_only else []);solver.add(formula);solver.add(*lemmas)
  fault=expected=='sat' and name in ('committed-counter-increments-modulo-u32','actual-slot-0-matches-instruction')
  if fault:
   # Only existential negative controls are pinned. All positive preservation
   # claims retain their universal domains and complete composed bindings.
   # Require the fault on an actually successful parsed caller path as well.
   ks=source.sort(m['key_name']);ws=source.sort(m['slot_name']);ins=source.sort(f['interface']['instruction'])
   key=lambda n:ks.constructor(0)(z.BitVecVal(n,32),*[z.BitVecVal(0,32) for _ in range(7)])
   zero=ws.constructor(0)(z.BitVecVal(0,32),z.BitVecVal(0,32));one=ws.constructor(0)(z.BitVecVal(1,32),z.BitVecVal(0,32))
   fields=source.types[f['interface']['instruction']]['variants'][0]['fields'];binding=source.sort(fields[6]['type'])
   fixed=ins.constructor(0)(key(6),one,zero,zero,z.BoolVal(False),key(5),binding.constructor(0)())
   ok,encoded=codecs.encode(f['interface']['instruction'],fixed)
   solver.add(w.COUNT==7,w.IXB[0]==1,ok,*[a==b for a,b in zip(w.IXB[1:],encoded)],*[w.key_bytes(i)==z.BitVecVal(i,256) for i in range(7)],z.Or([z.And(p.pc,p.ret==0) for p in w.paths]))
  result=solver.check();need(result!=z.unknown,name+': UNKNOWN: '+solver.reason_unknown());need(str(result)==expected,name+': '+str(result));row={'name':name,'result':str(result)}
  if fault:row['successfulCallerWitness']=True
  if result==z.sat and name in ('committed-counter-increments-modulo-u32','actual-slot-0-matches-instruction'):
   model=solver.model();active=[args for guard,args in w.replay if z.is_true(model.eval(guard,model_completion=True))];need(len(active)==1,'unique fault root');signature=program['source']['functions']['process'];row['wireArgs']=[wire(source,t,model.eval(a,model_completion=True)) for t,a in zip(signature['args'],active[0])];row['stateBytes']=[model.eval(b,model_completion=True).as_long() for b in w.D];row['instructionBytes']=[model.eval(b,model_completion=True).as_long() for b in w.IXB]
  print(name+': '+str(result),flush=True)
  return row
 claims=[query('actual-root-C-safety',z.Or(c.bad),'unsat',True)]
 state_claims=[]
 for label,disagreement in [('committed-state-decodes-to-actual-root-state',lambda ok,value,next_state,bytes_:z.Or(z.Not(ok),value!=next_state)),('committed-state-has-canonical-encoding',lambda ok,value,next_state,bytes_:z.Or([a!=b for a,b in zip(bytes_,codecs.encode(f['interface']['state'],next_state)[1])]))]:
  bad=[]
  for path in w.paths:
   committed=contract.final_data(w,path)
   ok,value=codecs.decode(f['interface']['state'],committed[20:])
   for guard,next_state,encoded in w.encodings:bad.append(z.And(path.pc,path.ret==0,guard,disagreement(ok,value,next_state,committed[20:])))
  state_claims.append(query(label,z.Or(bad),'unsat'))
 state_sort=source.sort(f['interface']['state']);counter=state_sort.accessor(0,0)
 bad=[]
 for path in w.paths:
  ok,new=codecs.decode(f['interface']['state'],contract.final_data(w,path)[20:])
  for guard,key,before,ix,result in w.roots:
   bad.append(z.And(path.pc,path.ret==0,guard,z.Or(z.Not(ok),counter(new)!=counter(before)+1)))
 state_claims.append(query('committed-counter-increments-modulo-u32',z.Or(bad),'sat' if arithmetic else 'unsat'))
 validator_claims=[]
 for label in w.validator_values[0][1][0][1]:
  for path_index,path in enumerate(w.paths):
   called=[e.slot for e in path.events if e.kind=='validate']
   for root_index,(guard,validation) in enumerate(w.validator_values):
    for i in called:
     bad=z.And(path.pc,guard,z.Not(validation[i][1][label]))
     validator_claims.append(query(f'composed-validator-{label}-path{path_index}-root{root_index}-slot{i}',bad,'unsat'))
 bad=[]
 for path in w.paths:
  executed=[e.slot for e in path.events if e.kind=='execute']
  for guard,slots in w.effect_values:
   bad.append(z.And(path.pc,path.ret==0,guard,z.Or(z.BoolVal(executed!=[0,1,2]),*[slot[('active',)]!=opcode for slot,opcode in zip(slots,[3,1,4])])) )
 claims.append(query('successful-helper-order-and-active-slots',z.Or(bad),'unsat'))
 # Independent effect equations refer directly to decoded instruction fields.
 instruction_sort=source.sort(f['interface']['instruction']);word_sort=source.sort(m['slot_name'])
 def amount(value):return z.Concat(word_sort.accessor(0,1)(value),word_sort.accessor(0,0)(value))
 effect_claims=[]
 for i,(opcode,authority) in enumerate(zip([3,1,4],[1,0,0])):
  bad=[]
  for (_,actor,before,ix,result),(guard,slots) in zip(w.roots,w.effect_values):
   slot=slots[i];expected_amount=amount(instruction_sort.accessor(0,i+1)(ix))
   comparisons=[slot[('active',)]==opcode,slot[('authority',)]==authority,slot[('amount',)]==expected_amount,slot[('mint',)]==6]
   comparisons.append(slot[('destination',)]==4 if i==0 else slot[('source',)]==4)
   if i==1:comparisons.append(slot[('destination',)]==5)
   bad.append(z.And(guard,z.Not(z.And(comparisons))))
  # Positive field equalities are pure computations on the actual decoded
  # inputs: omit all caller-output equations to prove a stronger domain.
  # Fault witnesses keep complete bindings and a successful caller path.
  effect_claims.append(query('actual-slot-'+str(i)+'-matches-instruction',z.Or(bad),'sat' if mutated and i==0 else 'unsat',not (mutated and i==0)))
 key_sort=source.sort(m['key_name']);word_sort=source.sort(m['slot_name']);ix_sort=source.sort(f['interface']['instruction'])
 key=lambda n:key_sort.constructor(0)(z.BitVecVal(n,32),*[z.BitVecVal(0,32) for _ in range(7)])
 zero=word_sort.constructor(0)(z.BitVecVal(0,32),z.BitVecVal(0,32))
 fields=source.types[f['interface']['instruction']]['variants'][0]['fields'];binding_sort=source.sort(fields[6]['type'])
 concrete_ix=ix_sort.constructor(0)(key(6),zero,zero,zero,z.BoolVal(False),key(5),binding_sort.constructor(0)())
 ix_ok,ix_bytes=codecs.encode(f['interface']['instruction'],concrete_ix)
 witness_pins=[w.COUNT==7,w.IXB[0]==1,ix_ok,*[a==b for a,b in zip(w.IXB[1:],ix_bytes)],*[w.key_bytes(i)==z.BitVecVal(i,256) for i in range(7)]]
 witnesses=[query('actual-issuance-success-reachable',z.And(*witness_pins,z.Or([z.And(p.pc,p.ret==0) for p in w.paths])),'sat')]
 wrong_ix=ix_sort.constructor(0)(key(6),zero,zero,zero,z.BoolVal(False),key(2),binding_sort.constructor(0)())
 wrong_ok,wrong_bytes=codecs.encode(f['interface']['instruction'],wrong_ix)
 wrong_pins=[w.COUNT==7,w.IXB[0]==1,wrong_ok,*[a==b for a,b in zip(w.IXB[1:],wrong_bytes)],*[w.key_bytes(i)==z.BitVecVal(i,256) for i in range(7)]]
 witnesses.append(query('wrong-destination-binding-cannot-succeed',z.And(*wrong_pins,z.Or([z.And(p.pc,p.ret==0) for p in w.paths])),'unsat'))


 sequence=check_sequence(w,m,validation_model,query,witness_pins)
 return {'sequence':sequence,'effectClaims':effect_claims,'adapter':adapter,'bindingAudit':binding,'bindingFaults':controls,'claims':claims,'stateClaims':state_claims,'validatorClaims':validator_claims,'witnesses':witnesses,'rootCalls':len(w.roots),'extractionEvidence':extraction_evidence,'reservedIndependence':reserved,'executorBody':execution_model.evidence}
positive=run(data['program']);mutations=[]
for mode,old,new in [('mint-amount','(a2).as.c0.f1, (a2).as.c0.f4)','(a2).as.c0.f3, (a2).as.c0.f4)'),('counter-increment','bend_U32_2e_add((a1).as.c0.f0, 1u)','bend_U32_2e_add((a1).as.c0.f0, 2u)')]:
 program=copy.deepcopy(data['program']);need(program['artifact']['c'].count(old)==1,'unique composed fault '+mode)
 program['artifact']['c']=program['artifact']['c'].replace(old,new);program['artifact']['cSha256']=hashlib.sha256(program['artifact']['c'].encode()).hexdigest()
 mismatch=check_root(program);need(len(mismatch)==1 and mismatch[0]['result']=='sat','mutated source/C mismatch '+mode)
 proof=run(program,mutated=mode=='mint-amount',arithmetic=mode=='counter-increment')
 mutations.append({'name':mode,'cSha256':program['artifact']['cSha256'],'sourceMismatch':mismatch,'proof':proof})
bound();need((root/'input.json').read_bytes()==raw,'input changed')
report={'passed':True,'endToEndVerified':False,'z3':z.get_version_string(),'inputSha256':hashlib.sha256(raw).hexdigest(),'checkerSha256':hashlib.sha256(checker_bytes).hexdigest(),'sourceHashes':data['sourceHashes'],'artifactHashes':data['artifactHashes'],'rootEquivalence':equivalence,'positive':positive,'mutations':mutations,'scope':'Actual issuance C root, emitted codec semantics, effect extraction, parsed validator and reviewed executor result summary connected to parsed caller and committed bytes. Caller-controlled probe only, no authorization policy. Sequential token data preservation is conditional on the documented byte frame. CPI frame enforcement, disjoint C objects, loader and toolchain remain assumptions; not an SBF theorem.'}
pending=output.with_suffix('.pending');pending.write_text(json.dumps(report,indent=2)+'\n');pending.replace(output)
print('Issuance adapter composition and two semantic controls passed',flush=True)
