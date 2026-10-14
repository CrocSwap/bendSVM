"""Disjoint output assignment audit with generic constructive extension lemmas."""
import z3 as z
from semantic_binding import references_output

def need(ok,msg):
 if not ok:raise ValueError(msg)
def audit(rows,axioms,base,allowed_outputs):
 outputs={lhs for guard,pairs in rows for lhs,rhs in pairs};ids={lhs.get_id() for lhs in outputs}
 need(rows and all(pairs for guard,pairs in rows),'empty assignment rows')
 need(outputs==set(allowed_outputs),'output inventory')
 expected=[z.Implies(g,a==b) for g,pairs in rows for a,b in pairs]
 need(len(axioms)==len(expected) and all(z.eq(a,b) for a,b in zip(axioms,expected)),'equation inventory')
 for guard,pairs in rows:
  need(not references_output(guard,ids),'circular guard')
  need(len({a.get_id() for a,b in pairs})==len(pairs),'duplicate target in row')
  for lhs,rhs in pairs:
   need(z.is_const(lhs) and lhs.sort()==rhs.sort(),'assignment shape')
   need(not references_output(rhs,ids),'circular value')
 def query(label,bad,premises=()):
  solver=z.Solver();solver.set(timeout=30000);solver.add(premises);solver.add(bad);result=solver.check()
  need(result==z.unsat,label+': '+str(result))
  return {'name':label,'result':'unsat'}
 by_output={lhs:[] for lhs in outputs}
 for guard,pairs in rows:
  for lhs,rhs in pairs:by_output[lhs].append((guard,rhs))
 overlaps=[z.And(entries[i][0],entries[j][0]) for entries in by_output.values() for i in range(len(entries)) for j in range(i)]
 disjoint=query('assignments-to-shared-outputs-have-disjoint-guards',z.Or(overlaps),base)
 choices={};lemmas={};instances=[]
 for lhs,entries in by_output.items():
  default=z.BoolVal(False) if z.is_bool(lhs) else z.BitVecVal(0,lhs.size())
  choice=default
  for guard,rhs in entries:choice=z.If(guard,rhs,choice)
  choices[lhs]=choice
  key=(str(lhs.sort()),len(entries))
  if key not in lemmas:
   guards=[z.FreshBool('assignment_guard') for _ in entries]
   values=[z.FreshConst(lhs.sort(),'assignment_value') for _ in entries]
   generic=default
   for guard,value in zip(guards,values):generic=z.If(guard,value,generic)
   property_=z.And(*[z.Implies(g,generic==v) for g,v in zip(guards,values)])
   premise=z.AtMost(*guards,1)
   proof=query('generic-disjoint-choice-'+str(key),z.And(premise,z.Not(property_)))
   lemmas[key]=(guards,values,generic,property_,proof)
  gs,vs,generic,property_,proof=lemmas[key]
  substitutions=list(zip(gs,[g for g,v in entries]))+list(zip(vs,[v for g,v in entries]))
  need(z.eq(z.substitute(generic,*substitutions),choice),'constructed choice mismatch')
  need(z.eq(z.simplify(z.substitute(property_,*substitutions)),z.simplify(z.And(*[z.Implies(g,choice==v) for g,v in entries]))),'extension instance mismatch')
  instances.append({'output':str(lhs),'assignments':len(entries),'lemma':str(key)})
 # No guard or RHS refers to outputs; all simultaneous substitutions therefore
 # produce exactly the instantiated clauses established above.
 for guard,pairs in rows:
  for lhs,rhs in pairs:
   actual=z.substitute(z.Implies(guard,lhs==rhs),*choices.items())
   need(z.eq(z.simplify(actual),z.simplify(z.Implies(guard,choices[lhs]==rhs))),'simultaneous extension mismatch')
 return {'outputs':len(outputs),'rows':len(rows),'claims':[disjoint,{'name':'every-base-input-extends-to-output-and-encoding-bindings','result':'unsat','method':'fresh generic disjoint-choice lemmas with exact instances'}],'genericLemmas':[v[-1] for v in lemmas.values()],'instances':instances}
