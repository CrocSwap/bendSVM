"""Process-local reuse of freshly UNSAT branch exclusions with exact premises."""
import z3 as z
class ReuseError(RuntimeError):pass
class PruningProofs:
 def __init__(self):self._proofs=[]
 def check(self,solver,formula):
  assertions=tuple(solver.assertions())
  if not assertions or not z.eq(assertions[-1],formula):raise ReuseError('query assertion differs')
  result=solver.check()
  if result==z.unknown:raise ReuseError('solver UNKNOWN: '+solver.reason_unknown())
  if result==z.unsat:self._proofs.append((formula,assertions[:-1]))
  elif result!=z.sat:raise ReuseError('invalid solver result')
  return result
 def exclusions(self,current):
  # Keep AST references and compare structural identity, never bare node IDs
  # from objects that might have been collected or a serialized success flag.
  current=tuple(current);out=[]
  # Hashes only narrow candidates; exact AST equality decides membership.
  # Buckets retain the AST objects throughout this check.
  buckets={}
  for premise in current:buckets.setdefault(premise.hash(),[]).append(premise)
  for formula,premises in self._proofs:
   if not all(any(z.eq(old,new) for new in buckets.get(old.hash(),())) for old in premises):raise ReuseError('pruning premise drift')
   out.append(z.Not(formula))
  return out
