"""Serialized initial views and helper precommit projection for actual callers.

Fresh loader proof and actual root/codec/effect/helper proofs remain conditional
on the documented runtime allocation, frame, and syscall contracts.
"""
from pathlib import Path
import sys,json,hashlib,uuid,runpy
sys.path.insert(0,'verification')
import multi_adapter_contract as m
import multi_token_composition.model as model
from loader_report import validate,unchanged
from multi_token_composition.common import begin,finish,sha
from multi_token_composition.pda_witness import rewrite
z=m.z3
data,binding,out=begin(sys.argv[1],sys.argv[2]);run=out.parent
receipt=Path(sys.argv[3]).resolve();receipt_hash=sha(receipt)
r=json.loads(receipt.read_text());raw=Path(r['inputArtifact']).read_bytes();ldinput=json.loads(raw);proof=Path(r['reportArtifact']).read_bytes()
assert hashlib.sha256(raw).hexdigest()==r['inputSha256'] and hashlib.sha256(proof).hexdigest()==r['reportSha256']
validate(json.loads(proof),ldinput,raw);unchanged(ldinput)
saved=sys.argv
try:
 sys.argv=['verification/loader_model.py',r['inputArtifact'],str(run/'loader-replay.json')]
 ld=runpy.run_path('verification/loader_model.py',run_name='__main__')
finally:sys.argv=saved
custody=runpy.run_path('verification/token_custody.py',run_name='custody_model')
original=m.analyse;original_validation=model.Validation;captured=[];validators=[]
def observe(*args,**kwargs):
 result=original(*args,**kwargs);captured.append(m.MultiWorld.latest);return result
def capture_validation(*args,**kwargs):
 result=original_validation(*args,**kwargs);validators.append(result);return result
m.analyse=observe;model.Validation=capture_validation;rows=[];v=lambda n:z.BitVecVal(n,64);v32=lambda n:z.BitVecVal(n,32)
try:
 for f in data['fixtures']:
  print(f['name'],'full root analysis starting',flush=True)
  full=model.analyse_fixture(f);w=captured[-1];tm=validators[-1].model;s=w.m
  print(f['name'],'full root analysis passed',flush=True)
  custody_constraints,custody_expected=custody['bind'](custody['parse'](f['files']),w)
  wire=z.Array(f['name']+'_wire',z.BitVecSort(64),z.BitVecSort(8));byte=lambda at:z.Select(wire,at)
  key=lambda at:z.Concat(*[byte(at+v(k)) for k in range(31,-1,-1)])
  le=lambda at:z.Concat(*[byte(at+v(k)) for k in range(7,-1,-1)])
  positions=[z.BitVec(f['name']+'_record_'+str(i),64) for i in range(13)]
  def inst(expr,at):
   offset=z.BitVec('relative_record_byte',64)
   return z.simplify(z.substitute(expr,(ld['b'],z.Lambda(offset,byte(at+offset))),(ld['base'],v(0x100000000)+at)))
  bindings=[w.COUNT==le(v(0)),positions[0]==v(8)];domain=[];data_bindings=[]
  bindings += custody_constraints
  for i in range(12):
   at=positions[i];active=z.ULT(v(i),w.COUNT)
   desc=[w.PARSE_OK[i]==z.Not(inst(ld['reject'],at)),w.KEY[i]==key(at+inst(ld['actual']['key'],at)),w.OWNER[i]==key(at+inst(ld['actual']['owner'],at)),w.SIZE[i]==inst(ld['actual']['size'],at)]
   for name,values in [('signer',w.SIGNER),('writable',w.WRITABLE),('executable',w.EXECUTABLE)]:desc.append(values[i]==inst(ld['actual'][name],at))
   bindings += [z.Implies(active,b) for b in desc]
   bindings.append(z.Implies(active,positions[i+1]==at+inst(ld['end_offset'],at)))
   domain += [z.Implies(active,inst(p,at)) for p in ld['premises']]
   offset=z.BitVec(f['name']+'_data_offset_'+str(i),32)
   view=z.Lambda(offset,byte(at+inst(ld['actual']['data'],at)+z.ZeroExt(32,offset)))
   data_bindings.append(z.Implies(active,z.Select(tm.account_data,v32(i))==view))
   bindings += [z.Implies(active,b==byte(at+inst(ld['actual']['data'],at)+v(j))) for j,b in enumerate(w.D[i])]
  ix=positions[-1]
  for i in reversed(range(12)):ix=z.If(w.COUNT==v(i),positions[i],ix)
  bindings += [w.IXLEN==le(ix),w.PROGRAM==key(ix+v(8)+w.IXLEN)]
  bindings += [b==byte(ix+v(8+j)) for j,b in enumerate(w.IXB)]
  # Universal initial-view theorem uses binding equations only, not success or root axioms.
  claims=[];proved_initial=[]
  for seqno,(_,slots,owners,keys,sequence) in enumerate(w.sequences):
   offset=z.BitVec('arbitrary_initial_offset',32)
   for i in range(12):
    solver=z.Solver();solver.set(timeout=120000)
    # Prove a stronger local statement: all initial bytes agree using only
    # this account's initial-array and managed-byte bindings. Metadata/cursor
    # constraints for unrelated records are unnecessary for this equality.
    local=[data_bindings[i],z.ULT(v(i),w.COUNT)]
    local += [b==byte(positions[i]+inst(ld['actual']['data'],positions[i])+v(j)) for j,b in enumerate(w.D[i])]
    solver.add(*local)
    solver.add(z.Select(z.Select(sequence[0],v32(i)),offset)!=byte(positions[i]+v(88)+z.ZeroExt(32,offset)))
    formula=z.And(*solver.assertions())
    reused=next((j for j,(prior,_) in enumerate(proved_initial) if z.eq(prior,formula)),None)
    if reused is None:
     answer=solver.check();assert answer==z.unsat,(f['name'],'initial',seqno,i,str(answer),solver.reason_unknown())
     proved_initial.append((formula,(seqno,i)))
    else:
     # Exact AST equality includes every premise and the negated conclusion.
     # This same formula was proved UNSAT earlier in this fresh fixture run.
     assert z.eq(proved_initial[reused][0],formula)
     answer=z.unsat
    claims.append({'sequence':seqno,'account':i,'result':str(answer),'reusedFrom':None if reused is None else list(proved_initial[reused][1])})
  print(f['name'],'initial snapshot connection passed',flush=True)
  success=z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths]);witnesses=[]
  # m.analyse has freshly discharged every guarded obligation in this world.
  # Compose only its actual helper-preservation obligations, with their guards
  # intact, to reach the final snapshot on successful caller paths.
  preserved=[z.Implies(pc,claim) for label,pc,claim in w.obligations if label=='actual-effects: sequential managed bytes preserved']
  assert preserved
  precommit=[]
  for seqno,(guard,slots,owners,keys,sequence) in enumerate(w.sequences):
   offset=z.BitVec('arbitrary_managed_byte',32)
   for field in w.m['fields']:
    i=field['index'];index=v32(i)
    initial=z.Select(z.Select(sequence[0],index),offset)
    final=z.Select(z.Select(sequence[-1],index),offset)
    solver=w.solver();solver.set(timeout=120000);solver.add(*preserved,success,guard,initial!=final)
    answer=solver.check();assert answer==z.unsat,(f['name'],'precommit',seqno,i,str(answer),solver.reason_unknown())
    # Initial snapshot constructors contain each exact managed D byte.
    for j,b in enumerate(w.D[i]):assert z.eq(z.simplify(z.Select(z.Select(sequence[0],index),v32(j))),b)
    precommit.append({'sequence':seqno,'account':i,'result':str(answer),'managedBytes':len(w.D[i])})
  print(f['name'],'successful precommit managed projection passed',flush=True)

  entry_check=z.Solver();entry_check.set(timeout=120000);entry_check.add(success,w.SETUP!=0);assert entry_check.check()==z.unsat
  custody_check=z.Solver();custody_check.add(*custody_constraints,w.SETUP==0,z.Not(custody_expected));assert custody_check.check()==z.unsat
  for mode in (0,1):
   # Construct the initial array from wire views. Eliminates extensional array
   # equalities only in the existential query; universal claims above unchanged.
   constructed=z.Array(f['name']+'_inactive_snapshot_'+str(mode),tm.account_data.sort().domain(),tm.account_data.sort().range())
   for i in range(12):
    offset=z.BitVec('witness_byte_offset',32)
    view=z.Lambda(offset,byte(positions[i]+inst(ld['actual']['data'],positions[i])+z.ZeroExt(32,offset)))
    constructed=z.Store(constructed,v32(i),z.If(z.ULT(v(i),w.COUNT),view,z.Select(constructed,v32(i))))
   seed=w.solver();seed.set(timeout=120000);seed.add(*custody_constraints,success,w.IXB[0]==mode,*[a==1 for a in w.ACTIVE],*[z.ULE(size,v(10*1024*1024)) for size in w.SIZE])
   status=seed.check();assert status==z.sat,(f['name'],'bounded scalar seed',mode,str(status),seed.reason_unknown())
   seed_model=seed.model();pins=[]
   for declaration in seed_model.decls():
    if declaration.arity()==0 and declaration.range().kind() in (z.Z3_BV_SORT,z.Z3_BOOL_SORT):
     term=declaration();pins.append((term,seed_model.eval(term,model_completion=True)))
   solver=z.Solver();solver.set(timeout=120000)
   conditions=[*w.axioms(),*bindings,*domain,success,w.IXB[0]==mode,*[a==1 for a in w.ACTIVE]]
   # A concrete existential witness includes syscall UF applications as well
   # as scalar variables. Evaluate the exact applications from this fresh SAT
   # seed; do not constrain the universal initial/precommit proof above.
   applications={};pending=list(conditions);visited=set()
   while pending:
    term=pending.pop()
    if term.get_id() in visited:continue
    visited.add(term.get_id())
    if z.is_app(term) and term.decl().kind()==z.Z3_OP_UNINTERPRETED and str(term.decl().name()) in ('custody_pda_result','custody_pda_key','custody_pda_bump'):
     applications[term.sexpr()]=term
    pending.extend(term.children())
   assert applications
   pda_pins=[(term,seed_model.eval(term,model_completion=True)) for term in applications.values()]
   assert all(z.is_bv_value(value) for _,value in pda_pins)

   concrete_conditions=rewrite(conditions,pda_pins)
   solver.add(*[z.simplify(z.substitute(z.substitute(c,(tm.account_data,constructed)),*pins)) for c in concrete_conditions])
   (run/(f['name']+'-mode'+str(mode)+'.smt2')).write_text(solver.to_smt2())
   answer=solver.check();assert answer==z.sat,(f['name'],'combined witness',mode,str(answer),solver.reason_unknown())
   witnesses.append({'queryArtifact':str(run/(f['name']+'-mode'+str(mode)+'.smt2')),'querySha256':sha(run/(f['name']+'-mode'+str(mode)+'.smt2')),'mode':mode,'result':str(answer),'model':m.complete_model(solver.model()),'scalarPins':[{'name':str(a),'value':str(b)} for a,b in pins],'pdaApplicationPins':[{'term':a.sexpr(),'value':b.sexpr()} for a,b in pda_pins]})
   print(f['name'],'combined active witness',mode,'passed',flush=True)
  rows.append({'name':f['name'],'fullRootComposition':full,'initialViews':claims,'precommit':precommit,'helperPreservationCuts':len(preserved),'activeWitnesses':witnesses})
finally:m.analyse=original;model.Validation=original_validation
unchanged(ldinput)
assert sha(receipt)==receipt_hash
extra={str(receipt):receipt_hash,r['inputArtifact']:r['inputSha256'],r['reportArtifact']:r['reportSha256'],str(run/'loader-replay.json'):sha(run/'loader-replay.json')}
finish(data,binding,out,'serialized',rows,extra)
