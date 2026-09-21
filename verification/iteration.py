"""Source refinement for every admitted fuel value and arbitrary state payloads."""
import json
import sys
import z3 as z
from prove import Evaluator

program = json.load(open(sys.argv[1]))
assert next(t for t in program['schema']['types'] if t['name']=='Nat')['max']==64
e = Evaluator(program)
x, y = z.BitVecs('x y',32)
b = z.Bool('b')
state = e.sort('State').constructor(0)
claims = {name:[] for name in ['count','swaps','rotate','toggle']}
for fuel in range(65):
    n=z.BitVecVal(fuel,32)
    call=lambda name,*args:e.call(name,list(args),z.BoolVal(True))
    claims['count'].append(call('count',n,x)==x+fuel)
    expected=state(y,x) if fuel%2 else state(x,y)
    claims['swaps'].append(call('swaps',n,state(x,y))==expected)
    claims['rotate'].append(call('rotate',n,x,y)==expected)
    claims['toggle'].append(call('toggle',n,b)==(z.Not(b) if fuel%2 else b))
claims['exhaustive matches and fuel bound']=[z.Not(z.Or(*e.dead))]
reports=[]
for name,laws in claims.items():
    solver=z.Solver();solver.set(timeout=10000)
    solver.add(z.Not(z.And(*laws)))
    result=solver.check()
    reports.append({'name':name,'fuel_cases':len(laws),'result':str(result),
        **({'counterexample':str(solver.model())} if result==z.sat else {})})
print(json.dumps({'claims':reports}))
sys.exit(0 if all(r['result']=='unsat' for r in reports) else 1)
