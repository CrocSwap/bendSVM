from pathlib import Path
import runpy,json
import z3 as z
c=runpy.run_path('verification/collection_entry/connect-content.py',run_name='__main__')
m=c['m'];entry=c['entry'];paths=c['paths'];v=c['v'];byte=c['byte'];field=c['field'];base=c['base'];mode=c['mode'];run=c['run']
size=field(2,'size');index=z.BitVec('allocation_zero_index',64)
all_zero=z.ForAll([index],z.Implies(z.ULT(index,size),byte(base+index)==0))
guard=z.And(c['dispatch'],paths.events['open'],mode==0,z.UGE(size,v(56)))
lhs=paths.input('collection_allocation_zero',1)!=0
binding=z.Implies(guard,lhs==all_zero)
constraints=c['constraints']+[binding];initial=z.And(c['commits'],mode==0)
rows=[]
def check(name,extra,expected,cs=constraints):
 s=z.Solver();s.set(timeout=60000);s.add(*cs,*extra);r=s.check();print(name,r,flush=True);assert r==expected,(name,r,s.reason_unknown());rows.append({'name':name,'result':str(r)});return s
# Arbitrary in-range byte, without fixing account length or position.
bad=z.And(z.ULT(index,size),byte(base+index)!=0)
check('initialization-reaches-zero-check',[initial,z.Not(z.And(guard,lhs))],z.unsat,c['constraints'])
check('zero-predicate-excludes-arbitrary-nonzero-byte',[guard,lhs,bad],z.unsat,[binding])
# Existential feasibility at a supported size; not a premise of the universal claim.
witness=[field(i,'size')==v(n) for i,n in enumerate([25,7,68])]
# Produce a concrete model using a finite existential allocation, then replay
# the original quantified binding on the complete model (including its array).
finite=[byte(base+v(i))==0 for i in range(68)]
seed=check('initializing-commit-finite-witness',[initial,*witness,*finite,lhs],z.sat,c['constraints'])
model=seed.model()
replayed=z.And(*[model.eval(q,model_completion=True) for q in constraints+[initial]])
check('concrete-witness-satisfies-quantified-binding',[z.Not(replayed)],z.unsat,[])
check('update-commit-disables-zero-guard',[c['update'],guard],z.unsat,c['constraints'])
check('update-commit-still-possible',[c['update'],*witness],z.sat,c['constraints'])
# Fault control deliberately uses the last payload byte, beyond the header.
check('missing-allocation-zero-binding',[initial,*witness,index==v(67),bad],z.sat,c['constraints'])
# A header-only predicate must fail: the last payload byte remains unchecked.
header_only=z.And(*[byte(base+v(i))==0 for i in range(56)])
wrong=z.Implies(guard,lhs==header_only)
check('header-only-zero-binding',[initial,*witness,index==v(67),bad],z.sat,c['constraints']+[wrong])
entry['loader_unchanged'](entry['ld']);entry['collection_unchanged'](entry['cd'])
(run/'zero.json').write_text(json.dumps({'passed':True,'claims':rows,'loaderInputSha256':entry['lr']['inputSha256'],'collectionInputSha256':entry['cr']['inputSha256'],'scope':'Exploratory full-allocation quantified byte predicate bound to qualified open helper contract. All supported lengths remain symbolic in universal claim. Does not itself establish loop termination, memory provenance, record payload binding or SBF correctness.'},indent=2)+'\n');print(run,flush=True)
