"""Conditional actual ABI2 CPI caller/root/codecs/extraction/validator connection.
Custody uses a reviewed-template model with trusted deterministic PDA calls.
Account loader, external CPI effects and runtime contracts remain abstract.
No physical-memory, callee accounting, SBF or rollback theorem is claimed.
"""
if not __debug__:raise RuntimeError('assertions required')
from pathlib import Path
from collections import Counter
import sys,json,hashlib
sys.path.insert(0,'verification')
from cpi_caller import custody as custody_model
import multi_adapter_contract as m
from cpi_caller.pruning import PruningProofs
from acyclic_c import Source,C,check as check_root
from codec_semantics import Codecs,PackedDecoder
from cpi_caller.binding import Validation
from cpi_caller.domain import audit
z=m.z3
assert __debug__ and z.get_version_string()=='5.1.0'
from effect_semantics import Extraction
from cpi_caller.report import validate
def analyse_fixture(f, profiles):
 """Positive checks admit no witness pins; controls require explicit pins."""
 BaseWorld=m.MultiWorld;BaseExec=m.MultiExec
 program=f['program'];source=Source(program['source']);c=C(source,program['artifact'])
 summary=m.summarize(f['schema'],f['interface'])
 # Same extraction-only interface projection as MultiExec.analyse; ABI2
 # account/state rules were independently validated by summarize above.
 extraction_fixture={**f,'interface':{**f['interface'],'version':1}}
 extraction=Extraction(source,extraction_fixture);extraction_evidence=extraction.verify()
 validation=Validation(f['files'])
 codecs=Codecs(source,{'name':f['name'],'headerName':f['name']+'.h','schema':f['schema'],'native':f['files'][f['name']+'.h'],'codecs':f['files'][f['name']+'.wire.h']})
 class World(BaseWorld):
  latest=None
  def __init__(self,*args,**kwargs):
   super().__init__(*args,**kwargs);World.latest=self;self.bridge=[];self.rows=[];self.calls=[];self.effect_calls=[];self.sequences=[];self.root_slots=[];self.pruned=[];self.pruning=PruningProofs()
   self.SYSCALL=[z.BitVec("effect_syscall_"+str(i),64) for i in range(self.m["slots"])]
   # Identity comparisons and byte reads use the same full-width values.
   # No separate key encoding or equality-reflection premise is required.
   self.key_sort=z.BitVecSort(256)
   self.KEY=[z.BitVec(f'account{i}_key_bytes',256) for i in range(self.m['accounts'])]
   self.OWNER=[z.BitVec(f'account{i}_owner_bytes',256) for i in range(self.m['accounts'])]
   self.PROGRAM=z.BitVec('program_id_bytes',256)
   self.SETUP,self.BUMP,self.custody_expected=custody_model.outputs(custody_model.parse(f['files']),self.KEY,self.PROGRAM)
   self.viewed={}
   self.key_encoding=lambda key:key
   self.account_assumptions=[]
   self.FIELD_VALUE=[PackedDecoder(codecs,t) for t in self.m['field_types']]
   self.FIELD_DECODE_OK=[decoder.ok for decoder in self.FIELD_VALUE]
   self.decoded={'ix':PackedDecoder(codecs,self.m['instruction'])}
   self.decode_ok={'ix':self.decoded['ix'].ok}
  def feasible(self,formula):
   solver=self.solver();solver.add(formula);self.checks+=1
   answer=self.pruning.check(solver,formula)
   if answer==z.unsat:self.pruned.append((formula,tuple(solver.assertions())))
   return answer==z.sat,solver
  def key_bytes(self,i):return self.KEY[i]
  def axioms(self):return super().axioms()+self.account_assumptions+self.bridge
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
   # Connect exactly the effect observations used by generated caller loops.
   src=(self.m['accepted'],1)
   for i,slot in enumerate(slots):
    observations=[(w.eff(src,i,n),slot[(n,)]) for n in ('active','count')]
    observations += [(w.meta(src,i,j,n),slot[('metas',j,n)]) for j in range(8) for n in ('index','writable')]
    scalar=lambda vals:[z.If(v,z.BitVecVal(1,32),z.BitVecVal(0,32)) for v in vals]
    actual,claims,pairs=validation.bind(slot,w.COUNT,{'account_key':w.KEY,'executable':scalar(w.EXECUTABLE),'writable':scalar(w.WRITABLE),'signer':scalar(w.SIGNER)})
    bind(guard,observations+[(w.VAL[i],actual)])
    w.effect_calls.append((guard,i,claims))
   w.root_slots.append((guard,slots))
   w.calls.append((pc,accepted,list(before.f[0]),next_state))
   return super().call_root(name,args,st,g)
  def call_validate(self,name,args,st,g):
   result=super().call_validate(name,args,st,g)
   i=self.effect_slot(args[0],st,g)[1]
   for root_guard,slot,claims in self.w.effect_calls:
    if slot==i:self.oblige(st,g,'actual-effects: full-width helper count',z.Implies(root_guard,claims['caller-count']))
   return result
 m.MultiWorld=World;m.MultiExec=Exec
 partitions=[];semantic_proofs=[];obligation_proofs=[]
 def partition_check(world,label,formula):
  # Every discarded branch was already proved impossible under a subset
  # of the current defining equations. Compose those exact results here.
  reused=world.pruning.exclusions(world.axioms())
  solver=z.Solver();solver.set(timeout=120000)
  solver.add(BaseWorld.axioms(world));solver.add(reused);solver.add(formula)
  answer=solver.check()
  if answer==z.unknown:raise RuntimeError(('composed path partition',solver.reason_unknown()))
  partitions.append({'query':len(partitions),'result':str(answer),'freshPrunedBranchLemmas':len(reused),'method':'exact UNSAT branch reuse with premise inclusion'})
  print(f['name'],'composed path partition',len(partitions),answer,flush=True)
  return answer==z.sat,solver
 def semantic_check(world,label,formula):
  reused=world.pruning.exclusions(world.axioms())
  solver=z.Solver();solver.set(timeout=120000)
  solver.add(BaseWorld.axioms(world));solver.add(reused);solver.add(formula)
  answer=solver.check()
  print(f['name'],label,'reduced',answer,flush=True)
  if answer==z.unsat:
   semantic_proofs.append({'name':label,'result':'unsat','method':'stronger query over exact fresh pruning lemmas','lemmas':len(reused)})
   return True,solver
  # A SAT/UNKNOWN result on the stronger query is not a counterexample to
  # the actual composition. Fall back to all current defining equations.
  passed,full=m.check_unsat(world,label,formula)
  semantic_proofs.append({'name':label,'result':'unsat' if passed else 'sat','method':'full binding query','reducedResult':str(answer)})
  return passed,full
 def obligation_check(world,label,formula):
  result=semantic_check(world,'obligation: '+label,formula)
  obligation_proofs.append(semantic_proofs.pop())
  return result
 try:result=m.analyse(summary,f,f['files'],require_witnesses=False,include_cpi_validation_assumptions=False,partition_check=partition_check,claim_check=semantic_check,obligation_check=obligation_check)
 finally:m.MultiWorld=BaseWorld;m.MultiExec=BaseExec
 w=World.latest
 success=z.Or(*[z.And(path.pc,path.ret==0) for path in w.paths])
 solver=w.solver();solver.add(success,z.Not(w.custody_expected));custody_status=solver.check()
 if custody_status!=z.unsat:raise RuntimeError(('custody success contract',str(custody_status),solver.reason_unknown()))
 src=(summary['accepted'],1)
 allowed=[w.ROOT_TAG,w.VALUE_ROOT,w.reply_ok,*w.RPLY,*w.field_ok,*[v for field in w.field_bytes for v in field],w.EXT_OK,*w.ACTIVE,*w.VAL]
 allowed += [w.eff(src,i,n) for i in range(summary['slots']) for n in ('active','count')]
 allowed += [w.meta(src,i,j,n) for i in range(summary['slots']) for j in range(8) for n in ('index','writable')]
 binding=audit(w.rows,w.bridge,BaseWorld.axioms(w),allowed)
 solver=w.solver();solver.add(z.Or(*c.bad));answer=solver.check()
 if answer!=z.unsat:raise RuntimeError(('actual C root safety',str(answer),solver.reason_unknown()))
 witnesses=[]
 contract=m.mk_contract(w,summary)
 complete=z.Or(*[z.And(path.pc,contract['success'],m.event_claims(w,summary,contract,path)['all']) for path in w.paths])
 for mode in (0,1):
  # Concrete profiles establish existence only. Universal claims above receive
  # none of these input constraints. Meta11 is external to all three fixtures.
  profile=next(x for x in profiles['rows'] if x['fixture']==f['name'])
  payloads=profile.get('expectedDataBytes',[42,42])
  assert len(payloads)==2 and all(type(value) is int and 0<=value<256 for value in payloads),'expected two one-byte witness payloads'
  instruction=[mode,*profile['bytes']]
  assert len(instruction)==len(w.IXB)
  pins=[w.COUNT==12,w.IXLEN==len(instruction),w.SETUP==0,w.CLOCK_RC==0,w.SLOT==0,w.BUMP==0,w.PROGRAM==100,*w.PARSE_OK]
  pins += [a==b for a,b in zip(w.IXB,instruction)]
  pins += [owner==100 for owner in w.OWNER]
  pins += [result==0 for result in w.EXE]
  for field in summary['fields']:
   index=field['index'];data=[0]*field['stateBytes']
   if mode==1:
    data[:20]=field['header']
    if field['bindingBytes']:data[20:52]=list((1).to_bytes(32,'little'))
   pins += [w.SIZE[index]==len(data),*[a==b for a,b in zip(w.D[index],data)]]
  pins += [key==z.BitVecVal(j+1,256) for j,key in enumerate(w.KEY)]
  pins += [*w.SIGNER,*w.WRITABLE,*[flag if i==2 else z.Not(flag) for i,flag in enumerate(w.EXECUTABLE)]]
  for root_guard,slots in w.root_slots:
   terms=[]
   for slot_number,slot in enumerate(slots):
    for loc,expr in slot.items():
     if loc==('active',):value=1
     elif loc==('program',):value=2
     elif loc in [('length',),('count',)]:value=1
     elif loc==(('program_key',),0):value=3
     elif loc==(('data',),0):value=payloads[slot_number]
     elif loc==('metas',0,'index'):value=11
     elif loc==('metas',0,'writable'):value=1
     elif loc==(('metas',0,'key'),0):value=12
     else:value=0
     terms.append(expr==z.BitVecVal(value,expr.size()))
   pins.append(z.Implies(root_guard,z.And(*terms)))
  solver=w.solver();solver.add(complete,*pins);answer=solver.check()
  if answer!=z.sat:raise RuntimeError(('complete caller witness',mode,str(answer),solver.reason_unknown()))
  witnesses.append({'mode':mode,'result':'sat','profile':'one writable nonsigner meta at external account11; count12; keys1..12','instructionBytes':instruction,'model':m.complete_model(solver.model())})
 return {'fixture':f['name'],'custodySuccessContract':'unsat','obligationProofs':obligation_proofs,'adapter':result,'actualRootSafety':'unsat','typedExtraction':extraction_evidence,'rootCalls':len(w.calls),'bridgeEqualities':len(w.bridge),'domainBinding':binding,'prunedBranchQueries':[{'result':'unsat','formulaSha256':hashlib.sha256(x.sexpr().encode()).hexdigest(),'assertionsSha256':hashlib.sha256(z.And(*a).sexpr().encode()).hexdigest()} for x,a in w.pruned],'composedPathPartitions':partitions,'semanticProofs':semantic_proofs,'completeCallerWitnesses':witnesses}

def main():
 if len(sys.argv)!=4:raise SystemExit('usage: caller.py INPUT PROFILES REPORT')
 p,profile_path,output=map(Path,sys.argv[1:])
 output.unlink(missing_ok=True)
 pending=output.with_suffix(output.suffix+'.pending');pending.unlink(missing_ok=True)
 payload=json.loads(p.read_text());profiles=json.loads(profile_path.read_text())
 files=[p,profile_path,Path(__file__),*Path('verification').rglob('*.py')]
 sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
 inputs={str(p.resolve()):sha(p) for p in files}
 for path,digest in payload['immutableInputs'].items():
  if sha(Path(path))!=digest:raise ValueError('fixture artifact drift: '+path)
 for path,digest in profiles['inputs'].items():
  if sha(Path(path))!=digest:raise ValueError('profile input drift: '+path)
 rows=[]
 for fixture in payload['fixtures']:
  print('Checking',fixture['name'],flush=True)
  correspondence=check_root(fixture['program'])
  row=analyse_fixture(fixture,profiles)
  row['rootCorrespondence']=correspondence
  rows.append(row)
  print('Passed',fixture['name'],flush=True)
 report={'passed':True,'scope':__doc__,'rows':rows,'inputs':inputs}
 validate(report,payload['fixtures'])
 if not all(sha(Path(p))==h for p,h in inputs.items()):raise ValueError('source drift')
 for path,digest in payload['immutableInputs'].items():
  if sha(Path(path))!=digest:raise ValueError('fixture artifact drift: '+path)
 pending.write_text(json.dumps(report,indent=2)+'\n');pending.replace(output)

if __name__=='__main__':main()
