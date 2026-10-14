"""Domain-preservation audit for disjoint assignments to symbolic outputs."""
import z3 as z
from semantic_binding import references_output

def need(v,m):
 if not v:raise ValueError(m)
def audit(rows,axioms,base,allowed_outputs):
 outputs={lhs for guard,pairs in rows for lhs,rhs in pairs};ids={lhs.get_id() for lhs in outputs}
 need(rows and all(pairs for guard,pairs in rows),'empty assignment rows')
 need(outputs==set(allowed_outputs),'output inventory')
 expected=[z.Implies(guard,lhs==rhs) for guard,pairs in rows for lhs,rhs in pairs]
 need(len(axioms)==len(expected) and all(a.eq(b) for a,b in zip(axioms,expected)),'equation inventory')
 for guard,pairs in rows:
  need(not references_output(guard,ids),'circular guard')
  need(len({a.get_id() for a,b in pairs})==len(pairs),'duplicate target in row')
  for lhs,rhs in pairs:
   need(z.is_const(lhs) and lhs.sort()==rhs.sort(),'assignment shape')
   need(not references_output(rhs,ids),'circular value')
 def query(name,bad):
  solver=z.Solver();solver.set(timeout=30000);solver.add(base);solver.add(bad);result=solver.check();need(result!=z.unknown,name+': UNKNOWN');need(result==z.unsat,name+': '+str(result));return {'name':name,'result':str(result)}
 overlaps=[]
 for i,(guard,pairs) in enumerate(rows):
  targets={a.get_id() for a,b in pairs}
  for other,more in rows[i+1:]:
   if targets & {a.get_id() for a,b in more}:overlaps.append(z.And(guard,other))
 disjoint=query('assignments-to-shared-outputs-have-disjoint-guards',z.Or(overlaps))
 choices={lhs:z.BoolVal(False) if z.is_bool(lhs) else z.BitVecVal(0,lhs.size()) for lhs in outputs}
 for guard,pairs in rows:
  for lhs,rhs in pairs:choices[lhs]=z.If(guard,rhs,choices[lhs])
 extension=query('every-base-input-extends-to-output-and-encoding-bindings',z.Not(z.substitute(z.And(axioms),*choices.items())))
 return {'outputs':len(outputs),'rows':len(rows),'claims':[disjoint,extension]}
