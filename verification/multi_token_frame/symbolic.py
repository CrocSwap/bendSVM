"""Observe managed ownership and distinct-key facts at actual ABI2 helper calls."""
from pathlib import Path
import hashlib,json,sys,uuid,copy,re,os
from collections import Counter
sys.path.insert(0,'verification')
import multi_adapter_contract as m
import token_validate as token
import token_executor as executor
z=m.z3
if not __debug__:raise RuntimeError('assertions required')
assert z.get_version_string()=='5.1.0'
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
root=Path(os.environ['TOKEN_FRAME_CHILD']);root.mkdir()
source=Path(os.environ['TOKEN_FRAME_INPUT']);original=json.loads(source.read_text())
data={'originalSha256':sha(source),'immutableInputs':original['immutableInputs'],'fixtures':[f for f in original['fixtures'] if f['name'].startswith('token-')]}
for p,h in data['immutableInputs'].items():assert sha(p)==h,p
snapshot=root/'input.json';snapshot.write_text(json.dumps(data,indent=2)+'\n')
worlds=[]
World=m.MultiWorld
class ParsedWorld(World):
 def __init__(self,*args,**kwargs):
  super().__init__(*args,**kwargs)
  worlds.append(self)
  self.key_sort=z.BitVecSort(256)
  self.KEY=[z.BitVec(f'account{i}_key_bytes',256) for i in range(self.m['accounts'])]
  self.OWNER=[z.BitVec(f'account{i}_owner_bytes',256) for i in range(self.m['accounts'])]
  self.PROGRAM=z.BitVec('program_id_bytes',256)
  self.viewed={}
  tm,actual=parsed
  self.token_models=[]
  for slot in range(self.m['slots']):
   clone=copy.copy(tm);pairs=[]
   def fresh(value):
    new=z.Const('slot'+str(slot)+'_'+str(value),value.sort());pairs.append((value,new));return new
   clone.fields={k:fresh(v) for k,v in tm.fields.items()}
   clone.native_keys={k:fresh(v) for k,v in tm.native_keys.items()}
   clone.amount=fresh(tm.amount)
   result=z.substitute(actual,*pairs)
   self.token_models.append((clone,result))
  # Both actual call_validate and the ordered-return contract use this exact
  # parsed result. There is no additional helper-return equality premise.
  self.VAL=[result for _,result in self.token_models]
  self.EXE=[execution.result({('active',):tm.fields['active']},z.BitVec('syscall_return_'+str(i),64))[0] for i,(tm,_) in enumerate(self.token_models)]
 def solver(self):
  # Generic preprocessing for every query in this world, including the original
  # combined obligations. Caller formulas, axioms, contexts and caps are intact.
  original=super().solver();assertions=list(original.assertions())
  prepared=z.Then(z.Tactic('simplify',ctx=original.ctx),z.Tactic('cofactor-term-ite',ctx=original.ctx),z.Tactic('smt',ctx=original.ctx)).solver()
  prepared.set(timeout=120000);prepared.add(assertions)
  if len(prepared.assertions())!=len(assertions) or not all(z.eq(a,b) for a,b in zip(prepared.assertions(),assertions)):
   raise RuntimeError('world preprocessing changed initial assertions')
  check=prepared.check
  def capture_unknown(*args,**kwargs):
   answer=check(*args,**kwargs)
   if answer==z.unknown:
    raw=prepared.sexpr()+'\n(check-sat)\n';digest=hashlib.sha256(raw.encode()).hexdigest()
    query=root/('world-unknown-'+digest+'.smt2');query.write_text(raw)
    metadata={'diagnosticOnly':True,'fixture':f['name'],'queryPath':str(query),'querySha256':digest,'assertionCount':len(prepared.assertions()),'timeoutMs':120000,'inputSha256':sha(snapshot),'checkerSha256':sha(Path(__file__)),'result':'unknown','reasonUnknown':prepared.reason_unknown(),'assumptionArguments':[str(arg) for arg in args],'keywordArguments':kwargs}
    (root/('world-unknown-'+digest+'.json')).write_text(json.dumps(metadata,indent=2)+'\n')
   return answer
  prepared.check=capture_unknown
  return prepared
 def key_bytes(self,i):return self.KEY[i]
m.MultiWorld=ParsedWorld
Base=m.MultiExec;observed=[];obligations=Counter()
class Observer(Base):
 def oblige(self,st,g,label,formula):
  if label.startswith(('bridge:','connection:','executor-frame:')):obligations[label]+=1
  return super().oblige(st,g,label,formula)
 def premises(self,phase,st,g,slot):
  w=self.w
  # Identity and byte views share full256-bit values; no encoding/reflection premise.
  tm,actual=w.token_models[slot]
  representation=z.And(tm.count==z.Extract(31,0,w.COUNT),*[tm.key(token.bv(i))==w.KEY[i] for i in range(self.m['accounts'])],*[tm.owner(token.bv(i))==w.OWNER[i] for i in range(self.m['accounts'])])
  identity=w.PROGRAM!=w.KEY[2]
  w.frame_relation=z.And(representation,identity)
  token_distinct=z.And(*[z.Implies(z.And(z.ULT(token.bv(a),tm.count),z.ULT(token.bv(b),tm.count)),tm.key(token.bv(a))!=tm.key(token.bv(b))) for a in range(12) for b in range(a+1,12)])
  self.oblige(st,g,'bridge: token count and key premises',z.Implies(representation,z.And(tm.pre,token_distinct)))
  for field in self.m['fields']:
   idx=token.bv(field['index'])
   self.oblige(st,g,'bridge: managed token owner exclusion',z.Implies(z.And(representation,identity),z.And(z.ULT(idx,tm.count),tm.owner(idx)!=tm.key(token.bv(2)))))
  if phase=='execute':
   assert z.eq(actual,w.VAL[slot])
   f=tm.fields
   for field in self.m['fields']:
    idx=token.bv(field['index'])
    writable=z.Or(z.And(f['active']==1,z.Or(idx==f['source'],idx==f['destination'])),z.And(f['active']==3,z.Or(idx==f['mint'],idx==f['destination'])),z.And(f['active']==4,z.Or(idx==f['source'],idx==f['mint'])))
    self.oblige(st,g,'connection: validator excludes managed writable roles',z.Implies(z.And(representation,identity),z.Not(writable)))
   # Writable keys come from the actual full-body-audited meta initializers.
   def writable_key(key):
    return z.Or(*[z.And(f['active']==opcode,key==tm.key(f[row['role']])) for opcode,rows in inventory.items() for row in rows if row['writable']])
   before=z.Array('arbitrary_data_before',z.BitVecSort(32),z.ArraySort(z.BitVecSort(32),z.BitVecSort(8)))
   replacement=z.Array('arbitrary_cpi_data',z.BitVecSort(32),z.ArraySort(z.BitVecSort(32),z.BitVecSort(8)))
   byte=z.BitVec('arbitrary_managed_byte',32)
   for field in self.m['fields']:
    idx=token.bv(field['index']);allowed=writable_key(tm.key(idx))
    self.oblige(st,g,'executor-frame: writable keys exclude managed accounts',z.Implies(z.And(representation,identity),z.Not(allowed)))
    after=z.If(allowed,z.Select(z.Select(replacement,idx),byte),z.Select(z.Select(before,idx),byte))
    self.oblige(st,g,'executor-frame: arbitrary managed bytes preserved',z.Implies(z.And(representation,identity),after==z.Select(z.Select(before,idx),byte)))
  observed.append(phase)
 def call_validate(self,name,args,st,g):
  value=super().call_validate(name,args,st,g);self.premises('validate',st,g,self.effect_slot(args[0],st,g)[1]);return value
 def call_execute(self,name,args,st,g):
  value=super().call_execute(name,args,st,g);self.premises('execute',st,g,self.effect_slot(args[0],st,g)[1]);return value
m.MultiExec=Observer
rows=[];controls=[]
for f in data['fixtures']:
 runtime={n:f['files'][n] for n in ('token.h','cpi_abi.h','solana_min.h')}
 execution=executor.Execution(runtime)
 body=runtime['token.h'].split(executor.SIGNATURE,1)[1]
 transfer=body.split('if (t->active == 1) {',1)[1]
 mint=transfer.split('} else if (t->active == 3) {',1)[1]
 burn=mint.split('} else {',1)[1]
 branches={1:transfer.split('} else if',1)[0],3:mint.split('} else {',1)[0],4:burn.split('write_le(',1)[0]}
 inventory={}
 for opcode,branch in branches.items():
  matches=re.findall(r'metas\[(\d+)\]\s*=\s*\(BendAccountMeta\)\{a\[([^]]+)\]\.key,([01]),([01])\}',branch)
  assert len(matches)==(4 if opcode==1 else 3)
  assert [int(row[0]) for row in matches]==list(range(len(matches)))
  inventory[opcode]=[]
  for pos,expression,writable,signer in matches:
   if writable=='1':assert expression in ('t->source','t->mint','t->destination')
   inventory[opcode].append({'slot':int(pos),'expression':expression,'role':expression[3:] if writable=='1' else None,'writable':writable=='1','signer':signer=='1'})
 tm,_,actual,_=token.evaluate(f['files']);parsed=(tm,actual)
 observed.clear();obligations.clear();summary=m.summarize(f['schema'],f['interface'])
 def observe_partition(w,what,formula):
  # Equivalent preprocessing of all partition queries; retain the actual partition
  # query before checking so a timeout or a later successful diagnostic run
  # leaves inspectable input. No extra assumptions or altered expected answer.
  solver=w.solver();solver.add(formula)
  original_assertions=list(solver.assertions())
  prepared=z.Then(z.Tactic('simplify',ctx=solver.ctx),z.Tactic('cofactor-term-ite',ctx=solver.ctx),z.Tactic('smt',ctx=solver.ctx)).solver()
  prepared.set(timeout=120000);prepared.add(original_assertions)
  if len(prepared.assertions())!=len(original_assertions) or not all(z.eq(a,b) for a,b in zip(prepared.assertions(),original_assertions)):
   raise RuntimeError('partition preprocessing changed assertion inventory')
  solver=prepared
  raw=solver.sexpr()+'\n(check-sat)\n';digest=hashlib.sha256(raw.encode()).hexdigest()
  query_file=root/('partition-query-'+digest+'.smt2');query_file.write_text(raw)
  metadata={'diagnosticOnly':True,'fixture':f['name'],'query':what,'expected':'unsat','querySha256':digest,'queryPath':str(query_file),'assertionCount':len(solver.assertions()),'timeoutMs':120000,'inputSha256':sha(snapshot),'checkerSha256':sha(Path(__file__)),'result':'pending'}
  try:
   answer=w.check(solver,'path feasibility');metadata['result']='sat' if answer else 'unsat'
   return answer,solver
  except Exception as error:
   metadata['result']='unknown' if solver.reason_unknown() else 'failed';metadata['reasonUnknown']=solver.reason_unknown();metadata['error']=str(error)
   raise
  finally:
   (root/('partition-query-'+digest+'.json')).write_text(json.dumps(metadata,indent=2)+'\n')
 result=m.analyse(summary,f,f['files'],require_witnesses=False,partition_check=observe_partition)
 assert set(observed)=={'validate','execute'}
 w=worlds[-1];contract=m.mk_contract(w,summary)
 witnesses=[]
 for mode in [0,1]:
  solver=w.solver();solver.add(w.frame_relation,contract['success'],w.IXB[0]==mode,z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths]))
  # Both effect slots perform transfers. This excludes success solely through
  # inactive effects, while enforcing all representation/identity premises.
  solver.add(*[tm.fields['active']==1 for tm,_ in w.token_models])
  answer=solver.check()
  if answer!=z.sat:raise RuntimeError((f['name'],mode,str(answer),solver.reason_unknown() if answer==z.unknown else 'unreachable'))
  witnesses.append({'mode':mode,'result':str(answer),'model':m.complete_model(solver.model())})
 result['activeCallerWitnesses']=witnesses
 rows.append({'name':f['name'],'managedIndices':[x['index'] for x in summary['fields']],'observedPhases':list(observed),'addedObligations':dict(obligations),'executorAudit':execution.evidence,'metaInventory':inventory,'result':result})
 print(f['name']+' caller premises passed',flush=True)
paths=[Path(__file__),snapshot]
paths += [Path(mod.__file__).resolve() for mod in list(sys.modules.values()) if getattr(mod,'__file__',None) and Path(mod.__file__).resolve().is_relative_to(Path('verification').resolve())]
report={'passed':True,'endToEndVerified':False,'fixtures':rows,'controls':controls,'inputHashes':{str(p.resolve()):sha(p) for p in paths},'scope':'Six full-caller init/update SAT witnesses require both transfer slots active and all representation/identity premises. Parsed per-slot validation plus reviewed executor result semantics and actual audited writable metas establish managed-data byte preservation at every emitted executor call, for arbitrary before/replacement bytes under a writable-key CPI frame. Full256-bit keys share identity and byte values; distinct program identities, stable metadata and native objects/local buffers remain assumed. Arbitrary before-data supports repeated-step composition but this is not a complete dynamic CPI or native-memory theorem.'}
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'fixtures':len(rows),'controls':len(controls),'report':str(root/'report.json')}))
