"""Establish every managed projection's bounds on every actual writing path."""
import z3 as z

def analyse(w):
 v=lambda n:z.BitVecVal(n,64)
 managed=[i for i,d in enumerate(w.D) if d]
 assert managed==[f['index'] for f in w.m['fields']]
 rows=[];cache={}
 for pathno,path in enumerate(w.paths):
  if not any(e.kind=='write' for e in path.events):continue
  for i in managed:
   claim=z.And(z.ULT(v(i),w.COUNT),w.PARSE_OK[i],z.UGE(w.SIZE[i],v(len(w.D[i]))))
   formula=z.And(path.pc,z.Not(claim));key=formula.sexpr()
   if key not in cache:
    solver=w.solver();solver.set(timeout=30000);solver.add(formula);status=solver.check()
    assert status==z.unsat,(pathno,i,str(status),solver.reason_unknown());cache[key]=[pathno,i]
   rows.append({'path':pathno,'account':i,'managedBytes':len(w.D[i]),'result':'unsat','firstProof':cache[key]})
 # Full decoded spans imply the exact shorter-span domain required by commit
 # Store induction; offsets remain explicit bounded inputs of that theorem.
 a,b,alen,blen,aw,bw,read,write=z.BitVecs('shrink_a shrink_b shrink_alen shrink_blen shrink_aw shrink_bw shrink_read shrink_write',64)
 limits=[z.ULE(a,v(1<<32)),z.ULE(b,v(1<<32)),z.ULE(alen,v(10*1024*1024)),z.ULE(blen,v(10*1024*1024)),z.ULE(aw,alen),z.ULE(bw,blen)]
 separate=z.Or(z.ULE(a+alen,b),z.ULE(b+blen,a))
 target=z.And(z.ULE(aw,v(10*1024*1024)),z.ULE(bw,v(10*1024*1024)),z.Or(z.ULE(a+aw,b),z.ULE(b+bw,a)))
 solver=z.Solver();solver.set(timeout=30000);solver.add(*limits,separate,z.Not(target));status=solver.check();assert status==z.unsat
 # Omitting width <= allocation length admits overlap of the claimed prefixes.
 control=z.Solver();control.set(timeout=30000);control.add(*limits[:4],separate,z.ULE(aw,v(10*1024*1024)),z.ULE(bw,v(10*1024*1024)),z.UGT(a+aw,b),z.UGT(b+bw,a));bad=control.check();assert bad==z.sat
 assert rows
 return {'managedAccounts':managed,'bounds':rows,'prefixShrink':'unsat','missingWidthBound':{'result':'sat','countermodel':str(control.model())},'scope':'Every managed projection is active, parsed and sufficiently sized on each actual writing path. Fresh shrink theorem connects full decoded disjoint spans to managed-prefix store premises.'}
