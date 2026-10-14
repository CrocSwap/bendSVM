"""Conditional account-data preservation at actual parsed execution call sites.

Success is established against pre-batch data. Initialize/fresh-destination
checks intentionally remain pre-batch predicates; durable checks are separately
proved after each arbitrary frame. Local native object isolation and enforcement
of the syscall frame remain assumptions.
"""
import copy
import z3 as z
import token_validate as token
from adapter_contract_c import need
from token_frame import data_frame,FRAME_SPEC

def check(world,model,validation_model,query,witness_pins):
 w=world;m=model
 # Exploratory composition: only the current execution's durable checks are
 # evaluated in the account snapshot after all prior framed helper calls.
 tm=validation_model.model
 to=z.BitVec('sequence_call_offset',32)
 sizes=tm.account_size
 for k,size in enumerate(w.SIZE):sizes=z.Store(sizes,z.BitVecVal(k,32),size)
 sequence=[tm.account_data]
 for k in range(m['slots']):sequence.append(data_frame(sequence[-1],sizes,'sequence_call_'+str(k)))
 # Prove the generic theorem before instantiating it through the existing
 # exact slot/account binding function. The count premise is part of the
 # theorem, so substitution adds no constraint to the caller's input domain.
 generic=[tm.account_data];theorems=[];lemma_evidence=[]
 for ordinal in range(m['slots']):
  if ordinal:generic.append(data_frame(generic[-1],tm.account_size,'sequence_call_'+str(ordinal-1)))
  normalized=z.substitute(validation_model.actual,(tm.account_data,generic[ordinal]),(tm.fields['initialize'],z.BitVecVal(0,32)),(tm.fields['fresh_destination'],z.BitVecVal(0,32)))
  theorem=z.Implies(z.And(tm.pre,validation_model.actual==0),normalized==0)
  token.solve(tm,z.Not(theorem),'unsat')
  theorems.append(theorem);lemma_evidence.append({'name':f'generic-sequence-{ordinal}-durable-validation','result':'unsat'})
 def instantiate(theorem,slot):
  binding=copy.copy(validation_model);binding.claims={'sequence-theorem':theorem}
  return binding.bind_world(w,slot)[1]['sequence-theorem']
 # Concrete inputs constrain only existential witnesses, never UNSAT claims.
 sequence_claims=[]
 for ordinal in range(m['slots']):
  durable=[];decimals=[];safe=[];reaches=[];instances=[]
  for path in w.paths:
   events=[e for e in path.events if e.kind=='execute']
   if len(events)<=ordinal:continue
   slot_index=events[ordinal].slot
   for guard,slots in w.effect_values:
    slot=slots[slot_index];call=z.And(path.pc,guard);reaches.append(call)
    instances.append(instantiate(theorems[ordinal],slot))
    normalized=dict(slot);normalized[('initialize',)]=z.BitVecVal(0,32);normalized[('fresh_destination',)]=z.BitVecVal(0,32)
    current=validation_model.bind_world(w,normalized)[0]
    current=z.substitute(current,(tm.account_data,sequence[ordinal]))
    durable.append(z.And(call,current!=0))
    mint=slot[('mint',)];before=tm.data_byte(mint,z.BitVecVal(44,32));after=z.Select(z.Select(sequence[ordinal],mint),z.BitVecVal(44,32))
    decimals.append(z.And(call,before!=after))
    opcode=slot[('active',)]
    bounds=z.And(z.ULT(z.ZeroExt(32,mint),w.COUNT),z.UGT(z.Select(sizes,mint),z.BitVecVal(44,64)),z.Implies(opcode==1,z.And(z.ULT(z.ZeroExt(32,slot[('source',)]),w.COUNT),z.ULT(z.ZeroExt(32,slot[('destination',)]),w.COUNT),z.ULE(slot[('authority',)],z.BitVecVal(1,32)))),z.Implies(opcode==3,z.And(z.ULT(z.ZeroExt(32,slot[('destination',)]),w.COUNT),slot[('authority',)]==1)),z.Implies(opcode==4,z.And(z.ULT(z.ZeroExt(32,slot[('source',)]),w.COUNT),slot[('authority',)]==0)))
    safe.append(z.And(call,z.Not(bounds)))
  need(bool(reaches),'missing actual execution ordinal')
  sequence_claims.append(query(f'sequence-call-{ordinal}-durable-validation',z.Or(durable),'unsat',lemmas=instances))
  sequence_claims.append(query(f'sequence-call-{ordinal}-decimals-preserved',z.Or(decimals),'unsat'))
  sequence_claims.append(query(f'sequence-call-{ordinal}-executor-premises',z.Or(safe),'unsat'))
  sequence_claims.append(query(f'sequence-call-{ordinal}-reachable',z.And(*witness_pins,z.Or(reaches)),'sat'))
 for k in range(1,m['slots']+1):
  before=tm.data_byte(z.BitVecVal(0,32),to);after=z.Select(z.Select(sequence[k],z.BitVecVal(0,32)),to)
  sequence_claims.append(query(f'sequence-after-{k}-managed-state-frame',before!=after,'unsat'))
 # Detect weakening either the managed-state or decimals byte frame.
 for label,index,offset in [('state',z.BitVecVal(0,32),to),('decimals',z.BitVecVal(6,32),z.BitVecVal(44,32))]:
  before=tm.data_byte(index,offset)
  bad=z.Store(sequence[-1],index,z.Store(z.Select(sequence[-1],index),offset,before^z.BitVecVal(1,8)))
  sequence_claims.append(query('sequence-unframed-'+label+'-detected',z.And(*witness_pins,before!=z.Select(z.Select(bad,index),offset)),'sat'))
 return {'frameSpec':FRAME_SPEC,'steps':m['slots'],'lemmas':lemma_evidence,'claims':sequence_claims}
