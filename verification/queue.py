"""Checked queue source versus independent funding and paged-payment outcomes."""
import hashlib
import json
import sys
import z3 as z
from prove import Evaluator
from binding import bind_closure

program=json.load(open(sys.argv[1]));reports=[]
reference=json.load(open('build/queue-arithmetic.model.json'));M='../../sdk/math.'
bindings=[bind_closure(program,reference,M+name,{M:''}) for name in ['add','sub']]
for name,variants in {
 'State':[('Empty',[]),('Collecting',['queue']),('Paying',['queue']),('Closed',[])],
 'Instruction':[('Initialize',['mint','vault']),('Append',['recipient','amount']),('Seal',[]),('Settle',['count','fuel'])],
 'Outcome':[('Accepted',['state','window','length','effects']),('Rejected',['code'])],
}.items():
 t=next(t for t in program['schema']['types'] if t['name']==name)
 assert [(v['name'],v['tag'],[f['name'] for f in v['fields']]) for v in t['variants']]==[(n,i,fs) for i,(n,fs) in enumerate(variants)],f'Protocol schema mismatch: {name}'

class QueueEvaluator(Evaluator):
 invalid_append_loaded=False
 abstract_fold=False
 large_page=False
 mismatched_page=None
 def call(self,name,args,path):
  if name=='../../sdk/context.equal':
   ks=self.sort('../../sdk/context.Key')
   return z.Concat(*[ks.accessor(0,i)(args[0]) for i in reversed(range(8))])==z.Concat(*[ks.accessor(0,i)(args[1]) for i in reversed(range(8))])
  if self.invalid_append_loaded and name=='U32.is_zero':
   return z.substitute(z.simplify(super().call(name,args,path)),(z.simplify(loaded==0),z.BoolVal(False)))
  if self.large_page and name=='U32.is_ge':
   return z.substitute(z.simplify(super().call(name,args,path)),(z.simplify(z.UGE(z.BitVecVal(2,32),page)),z.BoolVal(False)))
  if self.mismatched_page is not None and name=='U32.is_eq':
   return z.substitute(z.simplify(super().call(name,args,path)),(z.simplify(loaded==self.mismatched_page),z.BoolVal(False)))
  if self.abstract_fold and name.startswith('../../sdk/fold.fold'):
   return z.Const('arbitrary_fold',self.sort(self.program['functions'][name]['result']))
  if name in [M+'add',M+'sub']:
   return arithmetic[name](*args)
  return super().call(name,args,path)
e=QueueEvaluator(program);types=e.types
checked=e.sort(M+'Checked');word_sort=e.sort(M+'U64')
arithmetic={M+n:z.Function('arbitrary_'+n,word_sort,word_sort,checked) for n in ['add','sub']}
unword=lambda v:z.Concat(word_sort.accessor(0,1)(v),word_sort.accessor(0,0)(v))
is_error=lambda v:checked.recognizer(1)(v)
checked_value=lambda v:unword(checked.accessor(0,0)(v))
f=program['functions']['process'];context,state,instruction,metadata,window=f['args'];outcome=f['result']
def field(t,i,tag=0):return types[t]['variants'][tag]['fields'][i]['type']
def c(t,tag,*xs):return e.sort(t).constructor(tag)(*xs)
def u(n):return z.BitVecVal(n,32)
queue=field(state,0,1);key_type=field(context,0);word_type=field(context,2)
vector=field(window,1);storage=field(vector,1);item=field(storage,0)
effects=field(outcome,3);es=field(effects,1);effect=field(es,0)
detail=field(effect,0,5);binding=field(effect,1,5);recipient=field(detail,4);authority=field(detail,6)
key=lambda v:c(key_type,0,*[z.Extract(i*32+31,i*32,v) for i in range(8)])
word=lambda v:c(word_type,0,z.Extract(31,0,v),z.Extract(63,32,v))
owner,actor,mint,vault,collection,actual_collection=z.BitVecs('owner actor mint vault collection actual_collection',256)
r0,r1,new_recipient=z.BitVecs('recipient0 recipient1 new_recipient',256)
a0,a1,amount,remaining,slot=z.BitVecs('amount0 amount1 amount remaining slot',64)
count,cursor,length,capacity,start,loaded,page=z.BitVecs('count cursor length capacity start loaded page',32)
signed=z.Bool('signed');other_fuel=z.BitVec('other_fuel',32)
ctx=c(context,0,key(actor),signed,word(slot),key(actual_collection))
q=lambda rem=remaining,cur=cursor,n=count:c(queue,0,key(owner),key(mint),key(vault),key(collection),n,cur,word(rem))
items=[c(item,0,key(r0),word(a0)),c(item,0,key(r1),word(a1))]
win=lambda n=loaded,xs=items:c(window,0,start,c(vector,0,n,c(storage,0,*xs)))
meta=c(metadata,0,length,capacity)
ev=lambda xs:c(effects,0,u(len(xs)),c(es,0,*(xs+[c(effect,0)]*(2-len(xs)))))
reject=lambda code:c(outcome,1,u(code))
accept=lambda st,w,n,fx:c(outcome,0,st,w,n,ev(fx))
authorized=z.And(signed,actor==owner,actual_collection==collection)
variables=[owner,actor,mint,vault,collection,actual_collection,r0,r1,new_recipient,a0,a1,amount,remaining,slot,count,cursor,length,capacity,start,loaded,page,signed,other_fuel]

def solve(name,bad,assumptions=()):
 s=z.Then('simplify','propagate-values','solve-eqs','elim-uncnstr','smt').solver();s.set(timeout=15000)
 s.add(z.simplify(bad),*assumptions);status=s.check()
 claim={'name':name,'result':str(status)}
 if status==z.sat:claim['counterexample']={str(v):str(s.model().eval(v,model_completion=True)) for v in variables}
 reports.append(claim)
 if status!=z.unsat:print(name+': '+str(status),file=sys.stderr,flush=True)
 if status==z.unknown:
  print(json.dumps({'claims':reports}));sys.exit(2)
 if status==z.sat and len(sys.argv)>2:
  print(json.dumps({'claims':reports}));sys.exit(1)

def same(left,right):
 # Expand constructor/conditional equality explicitly before SMT. This is exact
 # datatype equality, not an abstraction; it avoids a large datatype split.
 cache={}
 def eq(a,b):
  if z.eq(a,b):return z.BoolVal(True)
  k=(a.get_id(),b.get_id())
  if k in cache:return cache[k]
  if z.is_app(a) and z.is_app(b) and a.decl().kind()==z.Z3_OP_DT_CONSTRUCTOR and b.decl().kind()==z.Z3_OP_DT_CONSTRUCTOR:
   result=z.BoolVal(False) if a.decl()!=b.decl() else z.And(*[eq(x,y) for x,y in zip(a.children(),b.children())])
  elif (z.is_app(a) and a.decl().kind()==z.Z3_OP_ITE) and (z.is_app(b) and b.decl().kind()==z.Z3_OP_ITE) and z.eq(a.arg(0),b.arg(0)):
   result=z.If(a.arg(0),eq(a.arg(1),b.arg(1)),eq(a.arg(2),b.arg(2)))
  elif (z.is_app(a) and a.decl().kind()==z.Z3_OP_ITE):result=z.If(a.arg(0),eq(a.arg(1),b),eq(a.arg(2),b))
  elif (z.is_app(b) and b.decl().kind()==z.Z3_OP_ITE):result=z.If(b.arg(0),eq(a,b.arg(1)),eq(a,b.arg(2)))
  else:result=a==b
  cache[k]=result
  return result
 return eq(z.simplify(left),z.simplify(right))

def check(name,st,ins,expected,assumptions=(),actual_window=None):
 e.dead=[];actual=e.call('process',[ctx,st,ins,meta,win() if actual_window is None else actual_window],z.BoolVal(True))
 solve(name,z.Or(z.Not(same(actual,expected)),*e.dead),assumptions)

def transfer(funding,index,quantity):
 return c(effect,5,c(detail,0,u(5),u(6 if funding else 7+index),u(7 if funding else 6),key(mint),
  c(recipient,1) if funding else c(recipient,2,key([r0,r1][index])),word(quantity),c(authority,0 if funding else 1)),
  c(binding,0) if funding else c(binding,1,key(vault)),c(binding,1,key(vault)) if funding else c(binding,0),z.BoolVal(False))

e.dead=[]
key_equality=Evaluator.call(e,'../../sdk/context.equal',[key(owner),key(actor)],z.BoolVal(True))
solve('source key equality summary',z.Or(key_equality!=(owner==actor),*e.dead))

initialize=c(instruction,0,key(mint),key(vault));append=c(instruction,1,key(new_recipient),word(amount));seal=c(instruction,2)
initial=c(queue,0,key(actor),key(mint),key(vault),key(actual_collection),u(0),u(0),word(z.BitVecVal(0,64)))
check('initialize exact state binding',c(state,0),initialize,z.If(z.And(signed,length==0),accept(c(state,1,initial),win(),u(0),[]),reject(1)))
valid_append=z.And(amount!=0,count==length,z.ULT(length,capacity),start==length)
addition=arithmetic[M+'add'](word(remaining),word(amount))
total=checked_value(addition)
new_item=c(item,0,key(new_recipient),word(amount))
funded=accept(c(state,1,q(total,cursor,count+1)),win(u(1),[new_item,items[1]]),count+1,[transfer(True,0,amount)])
check('append exact funding and prefix',c(state,1,q()),append,z.If(z.Not(authorized),reject(1),z.If(z.Not(valid_append),reject(3),z.If(is_error(addition),reject(4),funded))),actual_window=win(u(0)))
e.invalid_append_loaded=True
check('append rejects nonempty window',c(state,1,q()),append,z.If(authorized,reject(3),reject(1)),[loaded!=0])
e.invalid_append_loaded=False
check('seal exact phase and guards',c(state,1,q()),seal,z.If(z.Not(authorized),reject(1),z.If(z.And(count==length,count!=0),accept(c(state,2,q()),win(),length,[]),reject(3))))

# All fuel values are explicit and all keys/amounts/accounting fields symbolic.
# Pages 1/2 are the admitted domain. Other page values are separately rejected.
for fuel in range(65):
 for p in [1,2]:
  valid=z.And(count==length,start==cursor,z.ULE(z.ZeroExt(1,cursor)+p,z.ZeroExt(1,count)))
  amounts=[a0,a1][:p];wide_sum=sum([z.ZeroExt(1,a) for a in amounts],z.BitVecVal(0,65))
  accumulator=c(M+'Checked',0,word(remaining))
  for a in amounts:
   accumulator=z.If(is_error(accumulator),accumulator,arithmetic[M+'sub'](word(checked_value(accumulator)),word(a)))
  remainder=checked_value(accumulator);next_cursor=cursor+p;last=next_cursor==count
  accepted=accept(z.If(last,c(state,3),c(state,2,q(remainder,next_cursor))),win(u(p)),count,[transfer(False,i,a) for i,a in enumerate(amounts)])
  result=z.If(is_error(accumulator),reject(4),z.If(last==(remainder==0),accepted,reject(6))) if fuel==p else reject(5)
  check(f'settle page {p} fuel {fuel}',c(state,2,q()),c(instruction,3,u(p),u(fuel)),z.If(z.Not(authorized),reject(1),z.If(valid,result,reject(3))),actual_window=win(u(p)))
 if fuel%8==0:print(f'Queue fuel {fuel}/64 checked',file=sys.stderr,flush=True)

# Exact guard contract proves exclusion independent of the iteration body/fuel.
# Inspect settle's guard by covering every fuel for an arbitrary invalid page.
e.abstract_fold=True
solve('large page excludes source bound',z.Not(z.Implies(z.UGT(page,2),z.Not(z.UGE(u(2),page)))))
for fuel in range(65):
 check(f'zero page fuel {fuel}',c(state,2,q()),c(instruction,3,u(0),u(fuel)),z.If(authorized,reject(3),reject(1)))
 e.large_page=True
 check(f'large page fuel {fuel}',c(state,2,q()),c(instruction,3,page,u(fuel)),z.If(authorized,reject(3),reject(1)),[z.UGT(page,2)])
 e.large_page=False

# An arbitrary loaded-length mismatch is rejected for either admitted page,
# regardless of what the fold might return. This closes the window partition.
for p in [1,2]:
 e.mismatched_page=p
 for fuel in range(65):
  check(f'mismatched loaded length page {p} fuel {fuel}',c(state,2,q()),c(instruction,3,u(p),u(fuel)),z.If(authorized,reject(3),reject(1)),[loaded!=p])
e.abstract_fold=False
e.mismatched_page=None

# Remaining dispatch combinations cover every state/instruction constructor.
for tag in range(4):
 st=c(state,tag,q()) if tag in [1,2] else c(state,tag)
 for itag,ins in enumerate([initialize,append,seal,c(instruction,3,page,other_fuel)]):
  if (tag,itag) in [(0,0),(1,1),(1,2),(2,3)]:continue
  expected=z.If(authorized,reject(2),reject(1)) if tag in [1,2] else reject(2)
  check(f'phase {tag} instruction {itag}',st,ins,expected)

# Selection itself is source checked: capacity and windows use mathematical
# interval arithmetic rather than the implementation's subtraction predicate.
selection=program['functions']['select']['result'];range_type=field(selection,0,1)
for tag in range(4):
 st=c(state,tag,q()) if tag in [1,2] else c(state,tag)
 for itag,ins in enumerate([initialize,append,seal,c(instruction,3,page,other_fuel)]):
  offset=length if itag==1 else cursor if itag==3 and tag==2 else u(0)
  requested=u(1) if itag==1 else page if itag==3 else u(0)
  limit=capacity if itag==1 else length
  fits=z.And(z.ULE(length,capacity),z.ULE(requested,2),z.ULE(offset,length),z.ULE(z.ZeroExt(1,offset)+z.ZeroExt(1,requested),z.ZeroExt(1,limit)))
  expected=z.If(fits,c(selection,1,c(range_type,0,offset,requested)),c(selection,0))
  e.dead=[];actual=e.call('select',[ctx,st,ins,meta],z.BoolVal(True))
  solve(f'selection state {tag} instruction {itag}',z.Or(z.Not(same(actual,expected)),*e.dead))

solve('cursor progress cannot wrap',z.Implies(z.And(z.UGT(page,0),z.ULE(z.ZeroExt(1,cursor)+z.ZeroExt(1,page),z.ZeroExt(1,count))),
 z.And(z.UGT(cursor+page,cursor),z.ZeroExt(1,cursor+page)==z.ZeroExt(1,cursor)+z.ZeroExt(1,page)))==False)
solve('append count cannot wrap',z.Implies(z.ULT(count,capacity),z.And(z.UGT(count+1,count),z.ZeroExt(1,count+1)==z.ZeroExt(1,count)+1))==False)

# Arithmetic conservation is stated in a wider domain, so no modular equality
# can disguise loss. These lemmas compose with exact accepted outcomes above.
x,y,balance=z.BitVecs('lemma_x lemma_y lemma_balance',64)
wide=lambda v:z.ZeroExt(2,v)
solve('append mathematical conservation',z.Implies(z.ULE(wide(balance)+wide(x),(1<<64)-1),wide(balance+x)==wide(balance)+wide(x))==False)
solve('page mathematical conservation',z.Implies(z.ULE(wide(x)+wide(y),wide(balance)),wide(balance-x-y)+wide(x)+wide(y)==wide(balance))==False)
print(json.dumps({'solver':z.get_version_string(),'modelSha256':hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest(),'arithmeticBindings':bindings,'composition':'Full outcomes for arbitrary add/sub functions, instantiated with separately proved and exactly bound checked arithmetic; mathematical conservation/progress lemmas. Rejected-window proofs universally abstract the unused fold result and normalize only guard predicates known false under explicit domain assumptions.','claims':reports}))
sys.exit(0 if all(r['result']=='unsat' for r in reports) else 1)
