"""Connect actual emitted write-path guards to successful caller return."""
import z3 as z

def analyse(w):
 writing=[(i,p) for i,p in enumerate(w.paths) if any(e.kind=='write' for e in p.events)]
 assert writing
 rows=[]
 for i,p in writing:
  solver=z.Solver();solver.set(timeout=30000);solver.add(p.pc,p.ret!=0)
  status=solver.check();assert status==z.unsat,(i,str(status),solver.reason_unknown())
  rows.append({'path':i,'result':str(status)})
 return {'writePaths':rows,'scope':'Actual parsed write paths return success, without root/helper axioms. This permits using successful precommit preservation on every actual commit path.'}
