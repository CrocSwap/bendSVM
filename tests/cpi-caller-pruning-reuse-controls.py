from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
from cpi_caller.pruning import PruningProofs,ReuseError
import z3 as z
assert __debug__
x=z.BitVec('pruning_x',32);p=x==7;bad=x!=7
ledger=PruningProofs();solver=z.Solver();solver.add(p,bad)
assert ledger.check(solver,bad)==z.unsat
assert len(ledger.exclusions([p]))==1 and len(ledger.exclusions([p,x<10]))==1
sat=z.Solver();sat.add(p);assert ledger.check(sat,p)==z.sat;assert len(ledger.exclusions([p]))==1
refusals=[]
def reject(name,fn):
 try:fn()
 except ReuseError as e:refusals.append({'name':name,'reason':str(e)})
 else:raise AssertionError(name)
reject('missing-premise',lambda:ledger.exclusions([]))
reject('changed-premise',lambda:ledger.exclusions([x==8]))
reject('changed-query',lambda:ledger.check(solver,x==8))
reject('missing-query',lambda:ledger.check(z.Solver(),bad))
class Unknown:
 def assertions(self):return [p,bad]
 def check(self):return z.unknown
 def reason_unknown(self):return 'injected control'
reject('unknown-result',lambda:ledger.check(Unknown(),bad))
assert len(ledger.exclusions([p]))==1
# A hash collision must never substitute for structural AST equality.
original_hash=z.AstRef.hash
try:
 z.AstRef.hash=lambda self:0
 assert len(ledger.exclusions([x==8,p]))==1
 reject('hash-collision-changed-premise',lambda:ledger.exclusions([x==8]))
finally:z.AstRef.hash=original_hash
# The actual exclusion must imply the previously negated formula.
check=z.Solver();check.add(*ledger.exclusions([p]),bad);assert check.check()==z.unsat
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
paths=[Path(__file__),Path('verification/cpi_caller/pruning.py')]
(root/'pruning-reuse-controls.json').write_text(json.dumps({'passed':True,'positive':'fresh UNSAT reused under identical or stronger premises; SAT and UNKNOWN add no exclusion','refusals':refusals,'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}},indent=2)+'\n')
print('fresh pruning reuse positive and six refusal controls passed')
