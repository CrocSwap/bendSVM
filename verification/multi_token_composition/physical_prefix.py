"""Necessary parsed-record premises of an actual caller's successful return."""
import sys
sys.path.insert(0,'verification')
import z3 as z

def analyse(w):
 v=lambda n:z.BitVecVal(n,64)
 success=z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths])
 minimum=max(field['index'] for field in w.m['fields'])+1
 claim=z.And(z.UGE(w.COUNT,v(minimum)),z.ULE(w.COUNT,v(12)),*[z.Implies(z.ULT(v(i),w.COUNT),w.PARSE_OK[i]) for i in range(12)])
 # Pure path semantics suffice: no successful helper/root axioms are added.
 solver=z.Solver();solver.set(timeout=30000);solver.add(success,z.Not(claim));result=solver.check()
 assert result==z.unsat,(str(result),solver.reason_unknown())
 return {'result':'unsat','minimumAccounts':minimum,'maximumAccounts':12,'activeParses':list(range(12)),'scope':'Actual parsed caller success requires bounded count and successful parsing of every active record; no root/helper axioms used.'}
