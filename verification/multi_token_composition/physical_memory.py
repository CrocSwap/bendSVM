"""Fresh selection theorem for helper-poststate physical memories."""
import z3 as z
import hashlib

def analyse(guards,memories,fallback):
 assert guards and len(guards)==len(memories)
 assert fallback.sort()==z.ArraySort(z.BitVecSort(64),z.BitVecSort(8))
 assert all(m.sort()==fallback.sort() for m in memories)
 count=len(guards);g=[z.Bool('selected_guard_'+str(i)) for i in range(count)]
 arrays=[z.Array('selected_memory_'+str(i),z.BitVecSort(64),z.BitVecSort(8)) for i in range(count)]
 rest=z.Array('unselected_memory',z.BitVecSort(64),z.BitVecSort(8));at=z.BitVec('selected_read',64);value=z.BitVec('selected_expected',8)
 def select(gs,ms,default):
  result=default
  for guard,memory in reversed(list(zip(gs,ms))):result=z.If(guard,memory,result)
  return result
 selected=select(g,arrays,rest)
 exactly_one=z.PbEq([(guard,1) for guard in g],1)
 projections=[z.Implies(guard,z.Select(memory,at)==value) for guard,memory in zip(g,arrays)]
 solver=z.Solver();solver.set(timeout=30000);solver.add(exactly_one,*projections,z.Select(selected,at)!=value)
 result=solver.check();assert result==z.unsat
 controls=[]
 for name,conditions in [('missing-selection',[*projections]),('missing-selected-projection',[exactly_one,*projections[1:],g[0]])]:
  solver=z.Solver();solver.set(timeout=30000);solver.add(*conditions,z.Select(selected,at)!=value);status=solver.check();assert status==z.sat
  controls.append({'name':name,'result':'sat','countermodel':str(solver.model())})
 # Instantiate the actual memory expression and require exact construction
 # agreement with the same formula proved above.
 pairs=[(rest,fallback),*zip(g,guards),*zip(arrays,memories)]
 actual=z.substitute(selected,*pairs);assert z.eq(actual,select(guards,memories,fallback))
 return actual,{'result':'unsat','sequences':count,'controls':controls,'selectedMemorySha256':hashlib.sha256(actual.sexpr().encode()).hexdigest(),'scope':'Exactly-one selected helper memory preserves every guarded projection; actual projection premises must come from fresh snapshot/precommit proofs.'}
