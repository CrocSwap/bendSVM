"""Control actual semantic_check fallback routing with solver test doubles."""
if not __debug__:raise RuntimeError('assertions required')
import ast,types,json,hashlib,sys
from pathlib import Path
import z3
p=Path('verification/cpi_caller/caller.py')
node=next(n for n in ast.walk(ast.parse(p.read_text())) if isinstance(n,ast.FunctionDef) and n.name=='semantic_check')
code=compile(ast.fix_missing_locations(ast.Module(body=[node],type_ignores=[])),str(p),'exec')
class Failure(RuntimeError):pass
cases=[]
for reduced,full in [(z3.unsat,None),(z3.sat,True),(z3.sat,False),(z3.unknown,True),(z3.unknown,False),(z3.unknown,'error')]:
 events=[]; proofs=[]; premises=object(); lemmas=[object()]; formula=object(); solver_token=object()
 class Solver:
  def set(self,**kwargs):assert kwargs=={'timeout':120000}
  def add(self,value):events.append(('add',value))
  def check(self):return reduced
 def fallback(world,label,bad):
  assert bad is formula and label=='control';events.append(('fallback',None))
  if full=='error':raise Failure('full solver unknown')
  return full,solver_token
 class Pruning:
  def exclusions(self,actual):assert actual=='full axioms';return lemmas
 world=types.SimpleNamespace(pruning=Pruning(),axioms=lambda:'full axioms')
 env={'z':types.SimpleNamespace(Solver=Solver,unsat=z3.unsat),'BaseWorld':types.SimpleNamespace(axioms=lambda w:premises),'m':types.SimpleNamespace(check_unsat=fallback),'semantic_proofs':proofs,'f':{'name':'control'}}
 exec(code,env)
 try:result=env['semantic_check'](world,'control',formula)
 except Failure:
  assert full=='error' and not proofs
 else:
  assert full!='error'
  assert result[0] is (True if reduced==z3.unsat else full)
  assert len(proofs)==1
  if reduced!=z3.unsat:assert result[1] is solver_token
 assert events[:3]==[('add',premises),('add',lemmas),('add',formula)]
 assert len(events)==(3 if reduced==z3.unsat else 4)
 cases.append({'reduced':str(reduced),'full':full,'passed':True})
output=Path(sys.argv[1]);output.unlink(missing_ok=True)
output.write_text(json.dumps({'passed':True,'scope':__doc__,'cases':cases,'inputs':{str(x):hashlib.sha256(x.read_bytes()).hexdigest() for x in [p,Path(__file__)]}},indent=2)+'\n')
print('All six actual-function fallback routing controls passed')
