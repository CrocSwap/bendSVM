"""Conditional emitted ABI2 token composition over parsed codecs and actual roots.

Runtime token byte frames, program/token identity separation, stable metadata and
valid/disjoint native objects remain assumptions. This is not a SBF theorem.
"""
from pathlib import Path
import hashlib,json,sys
from collections import Counter
sys.path.insert(0,'verification')
import multi_adapter_contract as m
from acyclic_c import Source,C
from codec_semantics import Codecs,PackedDecoder
from state_encoding_binding import audit
from effect_semantics import Extraction
from token_semantics import Validation
from token_executor import Execution
from token_custody import outputs as custody_outputs,parse as custody_parse
from multi_token_composition.frame import inventory,advance,writable as writable_key
z=m.z3
if not __debug__:raise RuntimeError('assertions required')
assert z.get_version_string()=='5.1.0'
def analyse_fixture(f, *, fault=None, witness=None):
 """Positive checks admit no witness pins; controls require explicit pins."""
 if fault is None:
  if witness is not None:raise ValueError('positive composition must be unpinned')
 else:
  if fault not in ('managed-byte','decimals') or not witness:raise ValueError('fault control requires named mutation and positive witness')
 witness_values={} if witness is None else {row['name']:row['value'] for row in witness}
 BaseWorld=m.MultiWorld;BaseExec=m.MultiExec
 program=f['program'];source=Source(program['source']);c=C(source,program['artifact'])
 summary=m.summarize(f['schema'],f['interface'])
 # Same extraction-only interface projection as MultiExec.analyse; ABI2
 # account/state rules were independently validated by summarize above.
 extraction_fixture={**f,'interface':{**f['interface'],'version':1}}
 extraction=Extraction(source,extraction_fixture);extraction_evidence=extraction.verify()
 validation=Validation(f['files']);execution=Execution(f['files'])
 roles,frame_evidence=inventory(f['files'])
 codecs=Codecs(source,{'name':f['name'],'headerName':f['name']+'.h','schema':f['schema'],'native':f['files'][f['name']+'.h'],'codecs':f['files'][f['name']+'.wire.h']})
 class World(BaseWorld):
  latest=None
  def __init__(self,*args,**kwargs):
   super().__init__(*args,**kwargs);World.latest=self;self.bridge=[];self.rows=[];self.calls=[];self.effect_calls=[];self.sequences=[]
   self.SYSCALL=[z.BitVec("effect_syscall_"+str(i),64) for i in range(self.m["slots"])]
   # Identity comparisons and byte reads use the same full-width values.
   # No separate key encoding or equality-reflection premise is required.
   self.key_sort=z.BitVecSort(256)
   self.KEY=[z.BitVec(f'account{i}_key_bytes',256) for i in range(self.m['accounts'])]
   self.OWNER=[z.BitVec(f'account{i}_owner_bytes',256) for i in range(self.m['accounts'])]
   self.PROGRAM=z.BitVec('program_id_bytes',256)
   self.SETUP,self.BUMP,self.custody_expected=custody_outputs(custody_parse(f['files']),self)
   self.viewed={}
   self.key_encoding=lambda key:key
   self.account_assumptions=[self.PROGRAM!=self.KEY[2]]
   self.FIELD_VALUE=[PackedDecoder(codecs,t) for t in self.m['field_types']]
   self.FIELD_DECODE_OK=[decoder.ok for decoder in self.FIELD_VALUE]
   self.decoded={'ix':PackedDecoder(codecs,self.m['instruction'])}
   self.decode_ok={'ix':self.decoded['ix'].ok}
  def key_bytes(self,i):return self.KEY[i]
  def axioms(self):return super().axioms()+self.account_assumptions+self.bridge
  def solver(self):
   solver=super().solver()
   if fault is None:return solver
   # Scalar pins apply only to existential fault controls. Visit each shared
   # AST once; recursive tree traversal can explode on the symbolic DAG.
   pending=list(self.axioms());seen=set();variables=[]
   while pending:
    value=pending.pop()
    if value.get_id() in seen:continue
    seen.add(value.get_id())
    if z.is_const(value) and value.decl().kind()==z.Z3_OP_UNINTERPRETED:variables.append(value)
    else:pending.extend(value.children())
   for value in variables:
    encoded=witness_values.get(str(value))
    if encoded is None:continue
    if z.is_bv(value) and encoded.isdecimal():solver.add(value==z.BitVecVal(int(encoded),value.size()))
    elif z.is_bool(value) and encoded in ('True','False'):solver.add(value==z.BoolVal(encoded=='True'))
   return solver
 class Exec(BaseExec):
  obligations=Counter()
  def oblige(self,st,g,label,formula):
   if label.startswith('actual-effects: '):self.obligations[label]+=1
   return super().oblige(st,g,label,formula)
  def call_root(self,name,args,st,g):
   context,before,instruction=args;pc=z.And(st.pc,g);w=self.w;words=context.f[0]
   key=c.call(self.m['key_maker'],list(words[:8]),pc)
   slot=c.call(self.m['slot_maker'],list(words[9:]),pc)
   ctx=c.call(self.m['context_maker'],[key,words[8],slot],pc)
   state=c.call(self.m['state_maker'],list(before.f[0]),pc)
   value=c.call(name,[ctx,state,instruction.f[1]],pc)
   sort=source.sort(self.m['result_name']);accepted=sort.recognizer(self.m['accepted'])(value)
   def bind(guard,pairs):
    w.rows.append((guard,pairs));w.bridge.extend(z.Implies(guard,a==b) for a,b in pairs)
   bind(pc,[(w.ROOT_TAG,z.If(accepted,z.BitVecVal(self.m['accepted'],32),z.BitVecVal(self.m['rejected'],32))),(w.VALUE_ROOT,sort.accessor(self.m['rejected'],0)(value))])
   next_state=sort.accessor(self.m['accepted'],0)(value);ok,encoded=codecs.encode(self.m['state'],next_state)
   guard=z.And(pc,accepted)
   bind(guard,[(w.reply_ok,ok),*zip(w.RPLY,encoded)])
   state_sort=source.sort(self.m['state'])
   for i,typ in enumerate(self.m['field_types']):
    part=state_sort.accessor(0,i)(next_state);ok,encoded=codecs.encode(typ,part)
    bind(guard,[(w.field_ok[i],ok),*zip(w.field_bytes[i],encoded)])
   effects=sort.accessor(self.m['accepted'],1)(value)
   extracted,slots=extraction.extract(effects)
   bind(guard,[(w.EXT_OK,extracted),*[(w.ACTIVE[i],slot[('active',)]) for i,slot in enumerate(slots)]])
   # Account owners and managed bytes are the same observations used by the
   # emitted caller. Other account bytes remain unconstrained snapshot inputs.
   tm=validation.model;owners=tm.account_owners;account_data=tm.account_data
   for i,owner in enumerate(w.OWNER):owners=z.Store(owners,z.BitVecVal(i,32),w.key_encoding(owner))
   for i,bytes_ in enumerate(w.D):
    if not bytes_:continue
    part=z.Select(account_data,z.BitVecVal(i,32))
    for j,byte in enumerate(bytes_):part=z.Store(part,z.BitVecVal(j,32),byte)
    account_data=z.Store(account_data,z.BitVecVal(i,32),part)
   account_pairs=[(tm.account_owners,owners),(tm.account_data,account_data)]
   sizes=tm.account_size;keys=tm.account_keys
   for i in range(len(w.KEY)):
    sizes=z.Store(sizes,z.BitVecVal(i,32),w.SIZE[i])
    keys=z.Store(keys,z.BitVecVal(i,32),w.key_bytes(i))
   sequence=[account_data]
   for i,slot in enumerate(slots):
    next_data=advance(sequence[-1],sizes,keys,slot,roles,'actual_sequence_'+str(len(w.sequences))+'_'+str(i))
    if fault is not None and i==0:
     index=z.BitVecVal(self.m['fields'][-1]['index'],32) if fault=='managed-byte' else slot[('mint',)]
     offset=z.BitVecVal(0 if fault=='managed-byte' else 44,32)
     before_byte=z.Select(z.Select(next_data,index),offset)
     next_data=z.Store(next_data,index,z.Store(z.Select(next_data,index),offset,before_byte^z.BitVecVal(1,8)))
    sequence.append(next_data)
   w.sequences.append((guard,slots,owners,keys,sequence))
   validators=[];claims=[]
   for i,slot in enumerate(slots):
    actual,cs=validation.bind_world(w,slot)
    actual=z.simplify(z.substitute(actual,*account_pairs))
    cs={k:z.simplify(z.substitute(v,*account_pairs)) for k,v in cs.items()}
    validators.append(actual);claims.append(cs)
   bind(guard,[(w.VAL[i],v) for i,v in enumerate(validators)]+[(w.EXE[i],execution.result(slot,w.SYSCALL[i])[0]) for i,slot in enumerate(slots)])
   w.effect_calls.append((guard,slots,validators,claims))
   w.calls.append((pc,accepted,list(before.f[0]),next_state))
   return super().call_root(name,args,st,g)
  def call_execute(self,name,args,st,g):
   result=super().call_execute(name,args,st,g)
   i=self.effect_slot(args[0],st,g)[1]
   for root_guard,slots,validators,claims in self.w.effect_calls:
    for label,claim in claims[i].items():
     self.oblige(st,g,'actual-effects: '+label,z.Implies(root_guard,claim))
    f=slots[i]
    active=f[('active',)]
    for field in self.m['fields']:
     idx=z.BitVecVal(field['index'],32)
     writable=z.Or(z.And(active==1,z.Or(idx==f[('source',)],idx==f[('destination',)])),z.And(active==3,z.Or(idx==f[('mint',)],idx==f[('destination',)])),z.And(active==4,z.Or(idx==f[('source',)],idx==f[('mint',)])))
     self.oblige(st,g,'actual-effects: managed writable-index exclusion',z.Implies(root_guard,z.Not(writable)))
   # The emitted caller validates all slots before executing any. Check the
   # current slot again against the snapshot after earlier arbitrary framed
   # calls, preserving pre-batch freshness as a distinct predicate.
   tm=validation.model
   for root_guard,slots,owners,keys,sequence in self.w.sequences:
    slot=slots[i]
    durable={**slot,('initialize',):z.BitVecVal(0,32),('fresh_destination',):z.BitVecVal(0,32)}
    now,now_claims=validation.bind_world(self.w,durable)
    pairs=[(tm.account_owners,owners),(tm.account_data,sequence[i])]
    now=z.simplify(z.substitute(now,*pairs))
    self.oblige(st,g,'actual-effects: sequential durable validation',z.Implies(root_guard,now==0))
    mint=slot[('mint',)];offset=z.BitVecVal(44,32)
    original=z.Select(z.Select(sequence[0],mint),offset)
    current=z.Select(z.Select(sequence[i],mint),offset)
    self.oblige(st,g,'actual-effects: sequential decimals preserved',z.Implies(root_guard,original==current))
    for field in self.m['fields']:
     idx=z.BitVecVal(field['index'],32)
     byte=z.BitVec('arbitrary_managed_byte',32)
     self.oblige(st,g,'actual-effects: managed writable-key exclusion',z.Implies(root_guard,z.Not(writable_key(slot,idx,keys,roles))))
     prior=z.Select(z.Select(sequence[0],idx),byte)
     later=z.Select(z.Select(sequence[i+1],idx),byte)
     self.oblige(st,g,'actual-effects: sequential managed bytes preserved',z.Implies(root_guard,prior==later))
   return result
 m.MultiWorld=World;m.MultiExec=Exec
 try:result=m.analyse(summary,f,f['files'],require_witnesses=False)
 finally:m.MultiWorld=BaseWorld;m.MultiExec=BaseExec
 if fault is not None:raise RuntimeError('composed checker accepted frame violation '+fault)
 w=World.latest
 assert Exec.obligations["actual-effects: managed writable-index exclusion"]>0
 allowed=[w.EXT_OK,*w.ACTIVE,*w.VAL,*w.EXE,w.ROOT_TAG,w.VALUE_ROOT,w.reply_ok,*w.RPLY,*w.field_ok,*[b for values in w.field_bytes for b in values]]
 binding=audit(w.rows,w.bridge,BaseWorld.axioms(w)+w.account_assumptions,allowed)
 def query(name,condition,wanted):
  solver=w.solver();solver.add(condition);r=solver.check()
  if str(r)!=wanted:raise RuntimeError((name,str(r),solver.reason_unknown() if r==z.unknown else ''))
  return {'name':name,'result':str(r),'witness':m.complete_model(solver.model()) if r==z.sat else None}
 safety=query('actual-root-C-safety',z.Or(*c.bad),'unsat')
 witnesses=[query('reachable-'+str(mode),z.And(w.IXB[0]==mode,*[a==1 for a in w.ACTIVE],z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths])),'sat') for mode in [0,1]]
 properties=[]
 wrong=[]
 for pc,accepted,prior,next_state in w.calls:
  state_sort=source.sort(summary['state'])
  for i,typ in enumerate(summary['field_types']):
   counter=source.sort(typ)
   before_count=counter.accessor(0,0)(prior[i])
   after_count=counter.accessor(0,0)(state_sort.accessor(0,i)(next_state))
   wrong.append(z.And(pc,accepted,after_count!=before_count+1))
 properties.append(query('per-field-increment',z.Or(*wrong),'unsat'))
 properties.append(query('unsigned-cannot-succeed',z.And(z.Not(w.SIGNER[1]),z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths])),'unsat'))
 actual_custody,actual_bump,custody_expected=custody_outputs(custody_parse(f['files']),w)
 properties.append(query('custody-success-contract',z.And(z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths]),z.Not(z.And(custody_expected,w.BUMP==actual_bump))),'unsat'))
 controls=[]
 # These controls change the binding equations, not the source theorem.
 for name,changed_rows,changed_equations,reason in [
  ('missing-output',[(guard,[(lhs,rhs) for lhs,rhs in pairs if not z.eq(lhs,w.field_bytes[0][0])]) for guard,pairs in w.rows],None,'output inventory'),
  ('missing-equation',w.rows,w.bridge[:-1],'equation inventory'),
  ('circular-value',[(guard,[(lhs,lhs if z.eq(lhs,w.field_bytes[0][0]) else rhs) for lhs,rhs in pairs]) for guard,pairs in w.rows],None,'circular value')]:
  if changed_equations is None:changed_equations=[z.Implies(g,a==b) for g,pairs in changed_rows for a,b in pairs]
  try:audit(changed_rows,changed_equations,BaseWorld.axioms(w)+w.account_assumptions,allowed)
  except ValueError as error:
   assert reason in str(error),(name,str(error));controls.append({'name':name,'reason':str(error)})
  else:raise RuntimeError('accepted '+name)
 return {'fixture':f['name'],'adapter':result,'binding':binding,'rootSafety':safety,'properties':properties,'bindingControls':controls,'activeTransferWitnesses':witnesses,'rootCallCount':len(w.calls),'codecEvidence':codecs.evidence,'extractionEvidence':extraction_evidence,'executorEvidence':execution.evidence,'actualEffectObligations':dict(Exec.obligations),'sequenceFrame':frame_evidence}
