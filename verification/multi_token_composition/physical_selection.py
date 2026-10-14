"""Connect write paths to exactly one actual-root helper snapshot sequence."""
import sys
sys.path.insert(0,'verification')
import z3 as z

def analyse(w):
 guards=[entry[0] for entry in w.sequences];assert guards
 exactly_one=z.PbEq([(guard,1) for guard in guards],1)
 writing=[(i,p) for i,p in enumerate(w.paths) if any(e.kind=='write' for e in p.events)];assert writing
 solver=w.solver();solver.set(timeout=120000)
 solver.add(z.Or(*[z.And(path.pc,z.Not(exactly_one)) for _,path in writing]))
 result=solver.check();assert result==z.unsat,(str(result),solver.reason_unknown())
 # Every emitted write path must have one root event before all state writes.
 for _,path in writing:
  root=[i for i,e in enumerate(path.events) if e.kind=='root'];assert len(root)==1
  assert all(root[0]<i for i,e in enumerate(path.events) if e.kind=='write')
 # Pick an actually reachable sequence before constructing omission/duplication
 # controls; syntactic root branches can be unreachable.
 live=z.Or(*[path.pc for _,path in writing]);chosen=None
 for index,guard in enumerate(guards):
  probe=w.solver();probe.set(timeout=120000);probe.add(live,guard);status=probe.check()
  assert status in (z.sat,z.unsat),(index,str(status),probe.reason_unknown())
  if status==z.sat:chosen=index;break
 assert chosen is not None
 controls=[]
 for name,changed in [('omitted-live-sequence',[g for i,g in enumerate(guards) if i!=chosen]),('duplicated-live-sequence',[*guards,guards[chosen]])]:
  probe=w.solver();probe.set(timeout=120000);probe.add(live,guards[chosen],z.Not(z.PbEq([(g,1) for g in changed],1)));status=probe.check()
  assert status==z.sat,(name,str(status),probe.reason_unknown())
  controls.append({'name':name,'result':'sat','selectedSequence':chosen,'countermodel':str(probe.model())})
 return {'result':'unsat','controls':controls,'sequences':len(guards),'writePaths':[i for i,_ in writing],'rootBeforeAllWrites':True,'scope':'Each actual writing path selects exactly one source-root/helper sequence. Selection connects the correct precommit snapshot; physical projection must still be composed.'}
