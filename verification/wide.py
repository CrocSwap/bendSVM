"""Wide API refinement, conditional on checked product and division-loop proofs."""
if not __debug__:
    raise RuntimeError('Wide refinement requires Python assertions enabled')

import json
import sys
import z3 as z
from prove import Evaluator
from division_step import prove_program
from division_loop import obligation
from wide_division import divide, bind_callees, integer_bridge
from small_division import prove_small
from multiplication import prove as multiplication, word, value, wide_word, wide_value


def ctor(e,name,*args):
    sort,i=e.constructors[name]
    return sort.constructor(i)(*args)


def division_result(e,q,r):
    return ctor(e,'math.DivOk',ctor(e,'math.Division',word(e,'math.U64',q),word(e,'math.U64',r)))


def overflow_threshold():
    h,l,d=z.Ints('high low divisor');base=1<<64;n=h*base+l
    # Euclidean division over nonnegative inputs gives floor(n/d)>=base iff
    # n>=d*base. Check the digit comparison and division characterization.
    return obligation('wide-quotient-overflow-threshold',
        [h>=0,h<base,l>=0,l<base,d>0,d<base],
        z.And((n>=d*base)==(h>=d),(n/d>=base)==(n>=d*base)))


def rounding_identity():
    q,r,d=z.Ints('quotient remainder divisor');n=d*q+r
    return obligation('integer-floor-ceiling', [q>=0,d>0,r>=0,r<d],
        z.And(n/d==q,(n+d-1)/d==q+z.If(r==0,0,1)))


def composition(program):
    e=Evaluator(program)
    product=z.Function('exact_product',e.sort('math.U64'),e.sort('math.U64'),e.sort('U128'))
    quotient=z.Function('wide_divide',e.sort('U128'),e.sort('math.U64'),e.sort('math.DivResult'))
    class Summary(Evaluator):
        def __init__(self,p):super().__init__(p);self.calls=[]
        def call(self,name,args,path):
            if name in ['product','divide']:
                self.calls.append((name,path))
                return (product if name=='product' else quotient)(*args)
            return super().call(name,args,path)
    e=Summary(program);a,b,d=z.BitVecs('a b d',64)
    args=[word(e,'math.U64',n) for n in [a,b,d]]
    actual=e.call('mul_div',args,z.BoolVal(True))
    assert sorted(n for n,_ in e.calls)==['divide','product']
    return obligation('mul-div-composition',[],z.And(actual==quotient(product(*args[:2]),args[2]),*[p for _,p in e.calls],*[z.Not(p) for p in e.dead]))


def rounding(program):
    reports=[]
    for root in ['floor','ceil']:
        q,r,a,b,d=z.BitVecs('q r a b d',64);code=z.BitVec('code',32);failed=z.BitVec('failed',1)
        class Summary(Evaluator):
            def __init__(self,p):super().__init__(p);self.calls=[]
            def call(self,name,args,path):
                if name!='mul_div':return super().call(name,args,path)
                self.calls.append(z.And(path,*[value(self,'math.U64',arg)==n for arg,n in zip(args,[a,b,d])]))
                return z.If(failed==1,ctor(self,'math.DivErr',code),division_result(self,q,r))
        e=Summary(program)
        actual=e.call(root,[word(e,'math.U64',n) for n in [a,b,d]],z.BoolVal(True))
        increment=z.If(r==0,z.BitVecVal(0,65),z.BitVecVal(1,65)) if root=='ceil' else z.BitVecVal(0,65)
        total=z.ZeroExt(1,q)+increment
        success=z.If(z.Extract(64,64,total)==1,ctor(e,'math.Err',z.BitVecVal(1,32)),ctor(e,'math.Ok',word(e,'math.U64',z.Extract(63,0,total))))
        expected=z.If(failed==1,ctor(e,'math.Err',code),success)
        assert len(e.calls)==1
        reports.append(obligation(root+'-wrapper',[],z.And(actual==expected,*e.calls,*[z.Not(p) for p in e.dead]),[q,r,code,failed]))
    return reports


def prove(math_path,wide_path):
    products=multiplication(math_path,wide_path)
    program=json.load(open(wide_path))
    report={'multiplication':products,'claims':[]}
    if not all(c['result']=='unsat' for c in products['claims']):return report
    math_program=json.load(open(math_path))
    report['calleeBindings']=bind_callees(program,math_program)
    loop=prove_program(math_program);report['loop']=loop
    if loop['step']['result']!='unsat' or not all(c['result']=='unsat' for c in loop.get('induction',[])):return report
    report['fastPaths']=loop.get('fastPaths',[])
    if len(report['fastPaths'])!=33 or not all(c['result']=='unsat' for c in report['fastPaths']):return report
    if [(c['claim'],c['result']) for c in loop.get('wrappers',[])]!=[(n,'unsat') for n in ['divmod','div','mod']]:return report
    report['divisionBridge']=integer_bridge()
    if len(report['divisionBridge'])!=9 or not all(c['result']=='unsat' for c in report['divisionBridge']):return report
    report['smallDivision']=prove_small(program)
    report['claims']=[overflow_threshold(),rounding_identity()]
    if not all(c['result']=='unsat' for c in report['claims']):return report
    report['claims']+=divide(program)
    if all(c['result']=='unsat' for c in report['claims']):
        report['claims']+=[composition(program),*rounding(program)]
    return report


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(sys.argv[1],sys.argv[2]);print(json.dumps(report,indent=2))
    sys.exit(0 if len(report['claims'])==12 and len(report.get('smallDivision',[]))==15 and all(c['result']=='unsat' for c in report['claims']+report['smallDivision']) else 1)
