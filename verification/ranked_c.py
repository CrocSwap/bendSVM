"""Nat-ranked self-tail-loop source/C induction.

Only a single outer for(;;) and tail continue are admitted. Recursive source
calls and C continuations share a smaller-rank summary after rank obligations.
Mutual recursion, nested loops and C self calls remain outside the subset.
"""
import time
import z3 as z
from modular_c import C as ScalarC,DivisionParser,refs
from acyclic_c import Source,need,mangle,wire,check_artifacts,check_layouts
if not __debug__:
 raise RuntimeError('ranked loop verification requires Python assertions')

class Parser(DivisionParser):
 def statement(self):
  if self.peek()=='for':
   self.take('for','(',';',';',')');body=self.statement();need(body[0]=='block','loop block required');return ('ranked-loop',body)
  if self.peek()=='continue':self.take('continue',';');return ('tail-continue',)
  return super().statement()
class LoopC(ScalarC):
 parser_class=Parser
 def exec(self,node,states,result_type):
  kind=node[0]
  if self.loop and self.depth==0 and kind=='block':
   children=node[1]
   need(len(children)==len(self.signature['args'])+1 and children[-1][0]=='ranked-loop','single outer loop shape')
   need(children[:-1]==[('discard',('id','a'+str(i))) for i in range(len(self.signature['args']))],'outer loop prelude')
   # C Bool parameters are stored as bend_u32 and may be assigned from temporaries.
   states=[(path,{key:(z.If(value,z.BitVecVal(1,32),z.BitVecVal(0,32)) if key.startswith('a') and z.is_bool(value) else value) for key,value in env.items()}) for path,env in states]
  if kind=='ranked-loop':
   need(self.loop and self.depth==0,'unadmitted or nested loop');self.depth+=1
   try:pending,returns=super().exec(node[1],states,result_type)
   finally:self.depth-=1
   # Falling off the body would repeat with an unverified continuation.
   self.bad.extend(path for path,_ in pending)
   return [],returns
  if kind=='tail-continue':
   need(self.loop and self.depth==1,'continue outside admitted loop')
   returns=[]
   for path,env in states:
    if z.is_false(z.simplify(path)):continue
    args=[self.coerce(env['a'+str(i)],t,path) for i,t in enumerate(self.signature['args'])]
    self.rank_bad.append(z.And(path,z.Not(z.ULT(args[self.fuel],self.initial_fuel))))
    self.continues.append({'path':path,'args':args})
    returns.append((path,self.recurrence(*args)))
   return [],returns
  return super().exec(node,states,result_type)
def check(program):
 need(program['defaultProductionCMatches'] is True,'not default production C')
 source=Source(program['source']);artifact=program['artifact'];need(program['source']['schema']==artifact['schema'],'schema mismatch')
 check_artifacts([artifact]);check_layouts([artifact]);functions=source.program['functions']
 loops={n for n,f in functions.items() if n in set(refs(f.get('body')))}
 fuels={n:functions[n]['args'].index('Nat') for n in loops if 'Nat' in functions[n]['args']}
 need(set(fuels)==loops,'recursive function lacks Nat rank')
 done=set();active=set();order=[];dependencies={}
 def visit(name):
  need(name in functions,'unknown source call');need(name not in active,'mutual recursion outside subset')
  if name in done:return
  active.add(name);dependencies[name]=sorted(set(refs(functions[name].get('body')))-({name} if name in loops else set()))
  for child in dependencies[name]:visit(child)
  active.remove(name);done.add(name);order.append(name)
 for root in source.program['roots']:visit(root)
 need(set(functions)==set(order),'unreachable source function inventory')
 proven={};claims=[]
 class ModularSource(Source):
  def call(self,name,args,path):
   if name==self.current and name in loops:
    need(len(args)==len(self.signature['args']),'recursive source arity')
    self.rank_bad.append(z.And(path,z.Not(z.ULT(args[self.fuel],self.initial_fuel))))
    self.recursions.append({'path':path,'args':args});return self.recurrence(*args)
   need(name in proven,'unproved source callee '+name);return proven[name](*args)
 class ModularC(LoopC):
  def call(self,name,args,path):
   if name in self.makers:return super().call(name,args,path)
   need(name in self.functions,'unknown C function');target=self.functions[name]
   need(target in proven,'unproved C callee '+target);f=functions[target];need(len(args)==len(f['args']),'summary arity')
   return proven[target](*[self.coerce(a,t,path) for a,t in zip(args,f['args'])])
 for name in order:
  src=ModularSource(program['source']);c=ModularC(src,artifact);f=functions[name]
  args=[z.Const('loop_argument_'+str(i),src.sort(t)) for i,t in enumerate(f['args'])]
  recurrence=z.Function('smaller_rank_'+mangle(name),*[src.sort(t) for t in f['args']],src.sort(f['result']))
  src.current=name;src.signature=f;src.rank_bad=[];src.recursions=[];src.recurrence=recurrence
  c.loop=name in loops;c.signature=f;c.depth=0;c.rank_bad=[];c.continues=[];c.recurrence=recurrence
  if name in loops:
   src.fuel=c.fuel=fuels[name];src.initial_fuel=c.initial_fuel=args[fuels[name]]
  expected=Source.call(src,name,args,z.BoolVal(True));actual=LoopC.call(c,mangle(name),args,z.BoolVal(True))
  obligations=[('equivalence-and-safety',z.Or(actual!=expected,*src.dead,*c.bad))]
  if name in loops:
   need(bool(src.recursions) and bool(c.continues),'missing recursive/continue boundary')
   obligations=[('source-rank-decreases',z.Or(src.rank_bad)),('C-rank-decreases',z.Or(c.rank_bad))]+obligations
  rows=[]
  for label,bad in obligations:
   solver=z.Solver();solver.set(timeout=10000);solver.add(bad);began=time.monotonic();status=solver.check();row={'name':label,'result':str(status),'seconds':time.monotonic()-began}
   if status==z.sat:row['wireArgs']=[wire(src,t,solver.model().eval(a,model_completion=True)) for a,t in zip(args,f['args'])]
   if status==z.unknown:row['reason']=solver.reason_unknown()
   rows.append(row);print(name+' '+label+': '+str(status),flush=True)
   if status!=z.unsat:return {'passed':False,'claims':claims,'failedFunction':name,'failed':row}
  claims.append({'function':name,'dependencies':dependencies[name],'loop':name in loops,'fuelArgument':fuels.get(name),'sourceRecursions':len(src.recursions),'CContinues':len(c.continues),'checks':rows})
  proven[name]=z.Function('proved_'+mangle(name),*[src.sort(t) for t in f['args']],src.sort(f['result']))
 return {'passed':True,'endToEndVerified':False,'claims':claims,'roots':source.program['roots'],'loops':sorted(loops),'scope':'Typed pure source/C preservation by dependency order and decreasing unsigned Nat-rank induction. Assumes trusted source/C models, schema, solver and induction driver. Covers bounded Nat<=64 as a subset of the rank domain, not CU bounds, pointers, effects, LLVM or SBF.'}
