"""Small-divisor source refinement under the checked math.divmod contract.

The proof composes integer bounds, unsigned limb interpretation, and actual
checked helper terms. Native C/SBF correctness is a separate prerequisite.
"""
if not __debug__:
    raise RuntimeError('Small division refinement requires Python assertions enabled')
import z3 as z
from prove import Evaluator
from multiplication import word,value
from division_loop import obligation

def ctor(e,name,*args):
    t,i=e.constructors[name]
    return t.constructor(i)(*args)

def result(e,q,r):
    return ctor(e,'math.DivOk',ctor(e,'math.Division',word(e,'math.U64',q),word(e,'math.U64',r)))

def arithmetic():
    B=2**32
    h,l1,l0,d,q1,r1,q0,r0=z.Ints('h l1 l0 d q1 r1 q0 r0')
    base=[d>0,d<B,h>=0,h<d,l1>=0,l1<B,l0>=0,l0<B]
    step1=[h*B+l1==q1*d+r1,r1>=0,r1<d,q1>=0]
    step2=[r1*B+l0==q0*d+r0,r0>=0,r0<d,q0>=0]
    rows=[]
    def check(name,premises,claim):
     rows.append(obligation('small-'+name,premises,claim))
    check('first-dividend-fits-u64',base,h*B+l1<B*B)
    check('first-quotient-fits-u32',base+step1,q1<B)
    check('second-dividend-fits-u64',base+step1,r1*B+l0<B*B)
    check('second-quotient-fits-u32',base+step1+step2,q0<B)
    N=h*B*B+l1*B+l0
    Q=q1*B+q0
    check('quotient-remainder-reconstruction',base+step1+step2,N==Q*d+r0)
    check('result-fits-u64',base+step1+step2,z.And(Q>=0,Q<B*B))
    return rows

def interpretation():
    rows=[]
    def check(name,premises,claim):
        row=obligation('small-'+name,premises,claim)
        rows.append(row)
        if row['result']!='unsat':
            raise RuntimeError('Unsigned limb interpretation failed: '+str(row))
    n,d,q,r=z.Ints('numerator divisor quotient remainder')
    check('euclidean-floor-contract',[n>=0,d>0,q>=0,r>=0,r<d,n==q*d+r],z.And(q==n/d,r==n%d))
    # Word interpretation used by checked-source limb assembly.
    a,b=z.BitVecs('limb_a limb_b',32)
    check('concat-u32-to-u64',[],z.BV2Int(z.Concat(a,b))==z.BV2Int(a)*2**32+z.BV2Int(b))
    check('zeroextend-u32',[],z.BV2Int(z.ZeroExt(32,a))==z.BV2Int(a))
    x=z.BitVec('word',64)
    upper=z.Extract(63,32,x);lower=z.Extract(31,0,x)
    rejoined=z.Concat(upper,lower)
    check('u64-bitvector-split-reconstruction',[],x==rejoined)
    # Instantiate the already proved universal concat identity at these extracts.
    concat_instance=z.BV2Int(rejoined)==z.BV2Int(upper)*2**32+z.BV2Int(lower)
    check('u64-split-reconstruction',[concat_instance,x==rejoined],z.BV2Int(x)==z.BV2Int(upper)*2**32+z.BV2Int(lower))
    return rows

def source(program):
    lo,hi,d=z.BitVecs('lo hi d',64)
    q1,r1,q0,r0=z.BitVecs('q1 r1 q0 r0',32)
    w=lambda x:z.ZeroExt(32,x)
    class E(Evaluator):
     def __init__(self,p):super().__init__(p);self.calls=[]
     def call(self,name,args,path):
      if name=='math.divmod':
       i=len(self.calls);assert i<2
       self.calls.append((args,path))
       return result(self,w([q1,q0][i]),w([r1,r0][i]))
      return super().call(name,args,path)
    e=E(program)
    out=e.call('divide_small',[word(e,'math.U64',x) for x in [lo,hi,d]],z.BoolVal(True))
    assert len(e.calls)==2
    expected_n=[z.Concat(z.Extract(31,0,hi),z.Extract(63,32,lo)),z.Concat(r1,z.Extract(31,0,lo))]
    claims=[]
    for i,(args,path) in enumerate(e.calls):
     claims.append((f'native-call-{i}-arguments',z.And(path,value(e,'math.U64',args[0])==expected_n[i],value(e,'math.U64',args[1])==w(z.Extract(31,0,d)))))
    claims.append(('checked-source-quotient-remainder',out==result(e,z.Concat(q1,q0),w(r0))))
    claims.append(('checked-source-no-dead-path',z.And(*[z.Not(x) for x in e.dead])))
    return [obligation('small-'+name,[],claim) for name,claim in claims]

def prove_small(program):
    numbers=arithmetic()
    if len(numbers)!=6 or any(r['result']!='unsat' for r in numbers):
        return numbers
    interpretation_claims=interpretation()
    return numbers+interpretation_claims+source(program)
