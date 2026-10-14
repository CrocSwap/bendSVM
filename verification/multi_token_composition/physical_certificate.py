"""Finite commit projection tied to the supplied actual caller world.

Requires freshly proved store projection lemmas and disjoint parsed account
spans. The caller owns the physical precommit-to-D relation; this function
checks event bounds and the exact finite update/final_data correspondence.
"""
import sys
sys.path.insert(0,'verification')
import multi_adapter_contract as m
z=m.z3

def analyse(w):
 v=lambda n:z.BitVecVal(n,64)
 seen={};certificates=[];bounds=[];bound_cache={};byte_steps=0
 for pathno,path in enumerate(w.paths):
  writes=[e for e in path.events if e.kind=='write']
  # Check guarded parser/extent premises on every path, including paths that
  # happen to share a write sequence. Reuse requires exact formula equality.
  for i in sorted({e.account for e in writes}):
   conclusion=z.And(z.ULT(v(i),w.COUNT),w.PARSE_OK[i],z.UGE(w.SIZE[i],v(len(w.D[i]))))
   formula=z.And(path.pc,z.Not(conclusion));key=formula.sexpr()
   if key not in bound_cache:
    solver=w.solver();solver.set(timeout=30000);solver.add(formula);status=solver.check()
    assert status==z.unsat,(pathno,i,str(status),solver.reason_unknown())
    bound_cache[key]=(pathno,i)
   bounds.append({'path':pathno,'account':i,'managedBytes':len(w.D[i]),'result':'unsat','firstProof':list(bound_cache[key])})
  signature=tuple((e.account,e.offset,tuple(b.sexpr() for b in e.data)) for e in writes)
  if signature in seen:
   certificates.append({'path':pathno,'reuse':seen[signature]});continue
  seen[signature]=pathno
  projected=[list(d) for d in w.D];steps=[]
  for eventno,e in enumerate(writes):
   i=e.account;assert 0<=i<len(projected) and e.offset>=0 and e.offset+len(e.data)<=len(projected[i])
   for k,value in enumerate(e.data):
    offset=e.offset+k;assert value.sort()==z.BitVecSort(8) and 0<=offset<len(w.D[i])<=10*1024*1024
    for j in range(len(projected[i])):
     reduced=z.simplify(z.If(v(j)==v(offset),value,projected[i][j]));expected=value if j==offset else projected[i][j]
     assert z.eq(reduced,z.simplify(expected))
     projected[i][j]=expected
    steps.append({'event':eventno,'account':i,'offset':offset,'value':value.sexpr()});byte_steps+=1
  for i in range(len(projected)):
   final=m.final_data(w,path,i);assert final is not None and len(final)==len(projected[i])
   assert all(z.eq(a,b) for a,b in zip(final,projected[i]))
  certificates.append({'path':pathno,'steps':steps,'emptyWritesPreserveAllMemory':not writes,'finalProjection':'exact-ast-equality'})
 assert byte_steps>0 and bounds
 return {'paths':certificates,'bounds':bounds,'uniqueSequences':len(seen),'byteSteps':byte_steps,'scope':'Actual caller path guards establish active parsed managed prefix bounds. Finite point updates match final_data exactly; physical conclusion additionally requires fresh store lemmas, parsed disjoint spans and precommit projection.'}
