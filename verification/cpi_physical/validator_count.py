"""Fresh parsed-validator count theorem with exact checked caller bindings."""
import hashlib,pathlib,sys
import z3 as z
sys.path.insert(0,'verification')
from cpi_caller.binding import Validation
from cpi_physical.typed_dag import Fingerprints

def connect(w,fixture,folder):
 fingerprint=Fingerprints()
 validation=Validation(fixture['files']);model=validation.model
 active=model.fields['active'];count=model.fields['meta_count']
 theorem=z.Implies(z.And(active!=0,validation.actual==0),z.ULE(count,z.BitVecVal(8,32)))
 claims=[]
 def prove(name,premises,claim):
  solver=z.Solver();solver.set(timeout=30000);solver.add(*premises,z.Not(claim))
  path=folder/(name+'.smt2');path.write_text(solver.to_smt2());answer=solver.check()
  assert answer==z.unsat,(name,str(answer),solver.reason_unknown())
  claims.append({'name':name,'result':'unsat','query':str(path),'querySha256':hashlib.sha256(path.read_bytes()).hexdigest()})
 prove('parsed-active-success-count', [model.pre],theorem)
 # Independent scalar equality transport, subsequently instantiated at the
 # exact three caller defining equations. No new count bound is assumed.
 a,c,aa,cc=z.BitVecs('count_a count_c count_aa count_cc',32)
 r,rr=z.BitVecs('count_r count_rr',64)
 transport=z.Implies(z.And(a==aa,c==cc,r==rr,z.Implies(z.And(a!=0,r==0),z.ULE(c,z.BitVecVal(8,32)))),z.Implies(z.And(aa!=0,rr==0),z.ULE(cc,z.BitVecVal(8,32))))
 prove('scalar-bound-transport',[],transport)
 rows=[];premises=[]
 source=(w.m['accepted'],1)
 for guard,slots in w.root_slots:
  for i,slot in enumerate(slots):
   scalar=lambda flags:[z.If(flag,z.BitVecVal(1,32),z.BitVecVal(0,32)) for flag in flags]
   actual,_,pairs=validation.bind(slot,w.COUNT,{'account_key':w.KEY,'executable':scalar(w.EXECUTABLE),'writable':scalar(w.WRITABLE),'signer':scalar(w.SIGNER)})
   expected=[z.Implies(guard,w.VAL[i]==actual),z.Implies(guard,w.eff(source,i,'active')==slot[('active',)]),z.Implies(guard,w.eff(source,i,'count')==slot[('count',)])]
   assert all(any(z.eq(formula,existing) for existing in w.bridge) for formula in expected),'count theorem must use actual existing caller bindings'
   pre=z.simplify(z.substitute(model.pre,*pairs))
   # Root guard follows the actual parsed count gate. Full account-count
   # width is already checked by maintained caller obligations.
   prove('root-count-domain-'+str(len(rows)),[guard],pre)
   inst=z.simplify(z.substitute(theorem,*pairs))
   expected_inst=z.Implies(z.And(slot[('active',)]!=0,actual==0),z.ULE(slot[('count',)],z.BitVecVal(8,32)))
   if not z.eq(inst,z.simplify(expected_inst)):
    prove('exact-parsed-theorem-instantiation-'+str(len(rows)),[],inst==expected_inst)
   value=z.Implies(guard,z.Implies(z.And(w.eff(source,i,'active')!=0,w.VAL[i]==0),z.ULE(w.eff(source,i,'count'),z.BitVecVal(8,32))))
   premises.append(value)
   rows.append({'slot':i,'guardFingerprint':fingerprint(guard),
    'exactDefiningEquationsFingerprints':[fingerprint(x) for x in expected],
    'exactParsedTheoremInstantiationFingerprint':fingerprint(inst),
    'derivedCountBoundFingerprint':fingerprint(value)})
 assert rows and {r['slot'] for r in rows}=={0,1}
 return {'passed':True,'claims':claims,'instances':rows,'scope':__doc__+' Fresh parsed helper implication, checked domain, existing source/output/validator defining equations and scalar transport. No caller root rule or meta-count assumption is substituted.'},premises
