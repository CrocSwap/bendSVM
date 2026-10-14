"""Actual wide division routing, callee identity, and integer composition.

The source/C native division gate is separate. Here unsigned word interpretation,
checked-source export, the proof driver and Z3 are trusted, as in the existing
multiplication/division refinements.
"""
if not __debug__:
    raise RuntimeError('Wide refinement requires Python assertions enabled')

import z3 as z
from prove import Evaluator
from multiplication import word,value,wide_word
from division_loop import obligation

def references(node):
 if isinstance(node,dict):
  if node.get('$')=='Ref':yield node['k']
  for v in node.values():yield from references(v)
 elif isinstance(node,list):
  for v in node:yield from references(v)

def bind_callees(program,canonical):
 def normalize(x):
  if isinstance(x,str):return x.removeprefix('math.')
  if isinstance(x,list):return [normalize(v) for v in x]
  if isinstance(x,dict):return {k:normalize(v) for k,v in x.items() if k not in ['cType','cMaker','cName']}
  return x
 todo=['math.divmod','math.div64'];seen=set()
 while todo:
  name=todo.pop()
  if name in seen:continue
  seen.add(name);assert name in program['functions'],'missing division dependency'
  body=program['functions'][name];short=name.removeprefix('math.')
  assert short in canonical['functions'] and normalize(body)==normalize(canonical['functions'][short]),'division callee identity'
  todo.extend(references(body))
 types={t['name']:t for t in canonical['schema']['types']}
 for t in program['schema']['types']:
  if t['name'].startswith('math.'):
   assert normalize(t)==normalize(types[t['name'].removeprefix('math.')]),'division type identity'
 return sorted(seen)

def integer_bridge():
 base=1<<64;k,d,r0,r1=z.Ints('delta divisor r0 r1');bounds=[d>0,r0>=0,r0<d,r1>=0,r1<d]
 pos=z.Implies(k>=1,k*d>r0-r1);neg=z.Implies(k<=-1,k*d<r0-r1)
 reports=[obligation('positive-quotient-difference',bounds,pos,[k,d,r0,r1]),obligation('negative-quotient-difference',bounds,neg,[k,d,r0,r1])]
 if not all(c['result']=='unsat' for c in reports):return reports
 reports.append(obligation('euclidean-uniqueness',bounds+[pos,neg,k*d==r0-r1],z.And(k==0,r0==r1),[k,d,r0,r1]))
 low,high,qn,qf=z.Ints('low high narrow_q full_q')
 reports.append(obligation('euclidean-difference-factor',[],z.simplify((d*qf+r1)-(d*qn+r0)-((qf-qn)*d-(r0-r1)),som=True)==0))
 reports.append(obligation('narrow-numerator-equality',[high==0],high*base+low==low,[high,low]))
 reports.append(obligation('narrow-result-bounds',[low>=0,low<base,d>0,d<base],z.And(low/d>=0,low/d<base,low%d>=0,low%d<d,low%d<base),[low,d]))
 reports.append(obligation('native-euclidean-identity',[low>=0,low<base,d>0,d<base],low==d*(low/d)+low%d,[low,d]))
 reports.append(obligation('divisor-one-fit',[high>=0,high<d,d==1,low>=0,low<base],z.And(high==0,high*base+low==low,low==d*low+0),[high,low,d]))
 if not all(c['result']=='unsat' for c in reports):return reports
 delta=qf-qn
 hyp=[low>=0,low<base,high==0,d>0,d<base,qn>=0,qn<base,qf>=0,qf<base,r0>=0,r0<d,r1>=0,r1<d,low==d*qn+r0,high*base+low==d*qf+r1]
 lemmas=[z.Implies(delta>=1,delta*d>r0-r1),z.Implies(delta<=-1,delta*d<r0-r1)]
 reports.append(obligation('native-full-result-connection',hyp+lemmas,z.And(qn==qf,r0==r1),[low,high,d,qn,qf,r0,r1]))
 return reports

def divide(program):
 def ctor(e,n,*args):
  t,i=e.constructors[n];return t.constructor(i)(*args)
 def result(e,q,r):return ctor(e,'math.DivOk',ctor(e,'math.Division',word(e,'math.U64',q),word(e,'math.U64',r)))
 l,h,d,qn,rn,qs,rs,qf,rf=z.BitVecs('low high divisor narrow_q narrow_r small_q small_r full_q full_r',64)
 valid=z.And(d!=0,z.ULT(h,d));direct=z.And(valid,d==1)
 narrow=z.And(valid,d!=1,h==0)
 small=z.And(valid,d!=1,h!=0,z.ULE(d,0xffffffff))
 full=z.And(valid,d!=1,h!=0,z.UGT(d,0xffffffff))
 class E(Evaluator):
  def __init__(self,p):super().__init__(p);self.calls=[]
  def call(self,name,args,path):
   if name=='math.divmod':
    actual=[value(self,'math.U64',a) for a in args]
    self.calls.append((name,z.And(path==narrow,z.Implies(path,z.And(actual[0]==l,actual[1]==d)))))
    return result(self,qn,rn)
   if name=='divide_small':
    actual=[value(self,'math.U64',a) for a in args]
    self.calls.append((name,z.And(path==small,z.Implies(path,z.And(actual[0]==l,actual[1]==h,actual[2]==d,z.Extract(63,32,h)==0)))))
    return result(self,qs,rs)
   if name=='math.div64':
    t=self.sort('math.DivState');actual=[value(self,'math.U64',t.accessor(0,i)(args[0])) for i in range(3)]
    self.calls.append((name,z.And(path==full,z.Implies(path,z.And(actual[0]==l,actual[1]==h,actual[2]==d,z.ULT(h,d))))))
    return ctor(self,'math.DivState',word(self,'math.U64',qf),word(self,'math.U64',rf),word(self,'math.U64',d))
   return super().call(name,args,path)
 e=E(program)
 out=e.call('divide',[wide_word(e,'U128',z.Concat(h,l)),word(e,'math.U64',d)],z.BoolVal(True))
 assert sorted(n for n,_ in e.calls)==['divide_small','math.div64','math.divmod']
 expected=z.If(d==0,ctor(e,'math.DivErr',z.BitVecVal(3,32)),z.If(z.UGE(h,d),ctor(e,'math.DivErr',z.BitVecVal(1,32)),z.If(d==1,result(e,l,z.BitVecVal(0,64)),z.If(h==0,result(e,qn,rn),z.If(z.ULE(d,0xffffffff),result(e,qs,rs),result(e,qf,rf))))))
 claim=z.And(out==expected,*[v for _,v in e.calls],*[z.Not(v) for v in e.dead])
 domains=[d==0,z.And(d!=0,z.UGE(h,d)),direct,narrow,small,full]
 names=['wide-zero-precedence','wide-overflow-error','wide-divisor-one','wide-native64-route','wide-small32-route','wide-div64-route']
 reports=[obligation(name,[domain],claim,[l,h,d,qn,rn,qs,rs,qf,rf]) for name,domain in zip(names,domains)]
 partition=obligation('wide-divide-domain-partition',[],z.And(z.Or(*domains),*[z.Not(z.And(a,b)) for i,a in enumerate(domains) for b in domains[i+1:]]))
 failed=next((r for r in [partition,*reports] if r['result']=='sat'),None)
 if failed is None:failed=next((r for r in [partition,*reports] if r['result']!='unsat'),None)
 wrapper={'claim':'wide-divide-wrapper','result':failed['result'] if failed else 'unsat','seconds':sum(r['seconds'] for r in [partition,*reports]),'partition':partition,'caseClaims':names}
 if failed:
  wrapper['failedPrerequisite']=failed['claim']
  for field in ['reason','counterexample']:
   if field in failed:wrapper[field]=failed[field]
 return [wrapper,*reports]
