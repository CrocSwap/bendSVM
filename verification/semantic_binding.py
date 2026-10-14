"""Check that semantic bindings do not eliminate modeled adapter inputs."""
import z3 as z

def need(ok,message):
 if not ok:raise ValueError(message)
def references_output(expression,outputs):
 pending=[expression];seen=set()
 while pending:
  node=pending.pop();key=node.get_id()
  if key in seen:continue
  seen.add(key)
  if key in outputs:return True
  pending.extend(node.children())
 return False

def check(roots,bridge,tag,code,outsort,accepted,rejected,base):
 need(roots and len(bridge)==2*len(roots),'binding inventory')
 outputs={tag.get_id(),code.get_id()}
 choices=[]
 for pc,key,before,ix,result in roots:
  value_tag=z.If(outsort.recognizer(accepted)(result),z.BitVecVal(accepted,32),z.BitVecVal(rejected,32))
  value_code=outsort.accessor(rejected,0)(result)
  for expression in [pc,value_tag,value_code]:
   need(not references_output(expression,outputs),'circular root-output dependency')
  choices.append((pc,value_tag,value_code))
 def query(name,bad):
  solver=z.Solver();solver.set(timeout=30000);solver.add(base);solver.add(bad);result=solver.check()
  need(result!=z.unknown,name+': UNKNOWN');need(result==z.unsat,name+': '+str(result));return {'name':name,'result':'unsat'}
 disjoint=query('root-call-guards-disjoint-without-bindings',z.Not(z.AtMost(*[r[0] for r in roots],1)))
 selected_tag=z.BitVecVal(0,32);selected_code=z.BitVecVal(0,32)
 for pc,t,c in choices:
  selected_tag=z.If(pc,t,selected_tag);selected_code=z.If(pc,c,selected_code)
 instantiated=z.substitute(z.And(bridge),(tag,selected_tag),(code,selected_code))
 extension=query('every-base-input-has-consistent-root-outputs',z.Not(instantiated))
 return {'acyclic':True,'bindingCount':len(bridge),'claims':[disjoint,extension]}
