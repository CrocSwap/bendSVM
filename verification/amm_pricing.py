"""Checked AMM quote routing and integer fee/rounding/invariant obligations."""
import json
import sys
import z3 as z
from prove import Evaluator
from multiplication import word, value
from division_loop import obligation
from vesting_process import bind_floor
from wide import prove as wide_proof
M='../../sdk/math.'
W='../../sdk/wide.'


def ctor(e,name,*args):
    sort,index=e.constructors[name]
    return sort.constructor(index)(*args)


def arithmetic_summary(e,name,args):
    assert name in [M+'add',M+'sub']
    a,b=[value(e,M+'U64',arg) for arg in args]
    if name==M+'add':
        failed=z.UGT(z.ZeroExt(1,a)+z.ZeroExt(1,b),(1<<64)-1);answer=a+b;code=1
    else:failed=z.ULT(a,b);answer=a-b;code=2
    return z.If(failed,ctor(e,M+'Err',z.BitVecVal(code,32)),ctor(e,M+'Ok',word(e,M+'U64',answer)))


def checked_arithmetic(program):
    """Prove imported add/sub before using their word-level contracts."""
    reports=[]
    for root in ['add','sub']:
        e=Evaluator(program);a,b=z.BitVecs('left right',64)
        w=lambda n:word(e,M+'U64',n)
        actual=e.call(M+root,[w(a),w(b)],z.BoolVal(True))
        if root=='add':
            failed=z.UGT(z.ZeroExt(1,a)+z.ZeroExt(1,b),(1<<64)-1);answer=a+b;code=1
        else:failed=z.ULT(a,b);answer=a-b;code=2
        expected=z.If(failed,ctor(e,M+'Err',z.BitVecVal(code,32)),ctor(e,M+'Ok',w(answer)))
        reports.append(obligation('amm-checked-'+root,[],z.And(actual==expected,*[z.Not(p) for p in e.dead]),[a,b]))
    return reports


def quotes(program):
    claims=[]
    x,y,g,f,q=z.BitVecs('input output gross fee quote',64)
    nonzero=z.And(x!=0,y!=0,g!=0)
    capacity=z.ULE(z.ZeroExt(1,x)+z.ZeroExt(1,g),(1<<64)-1)
    effective=g-f
    fee_path=z.And(nonzero,capacity)
    output_path=z.And(fee_path,effective!=0)
    class Swap(Evaluator):
        def __init__(self,p):super().__init__(p);self.fees=[];self.outputs=[]
        def call(self,name,args,path):
            if name in [M+'add',M+'sub']:return arithmetic_summary(self,name,args)
            if name==W+'ceil':
                self.fees.append(z.And(path==fee_path,z.Implies(path,z.And(*[value(self,M+'U64',a)==b for a,b in zip(args,[g,z.BitVecVal(30,64),z.BitVecVal(10000,64)])]))))
                return ctor(self,M+'Ok',word(self,M+'U64',f))
            if name==W+'floor':
                self.outputs.append(z.And(path==output_path,z.Implies(path,z.And(*[value(self,M+'U64',a)==b for a,b in zip(args,[y,effective,x+effective])]))))
                return ctor(self,M+'Ok',word(self,M+'U64',q))
            return super().call(name,args,path)
    e=Swap(program);w=lambda n:word(e,M+'U64',n);err=lambda n:ctor(e,M+'Err',z.BitVecVal(n,32))
    actual=e.call('swap',[w(n) for n in [x,y,g]],z.BoolVal(True))
    expected=z.If(z.Not(nonzero),err(4),z.If(z.Not(capacity),err(1),z.If(z.Or(effective==0,q==0),err(4),ctor(e,M+'Ok',w(q)))))
    assert len(e.fees)==1 and len(e.outputs)==1
    claims.append(obligation('amm-swap-routing',[z.ULE(f,g)],z.And(actual==expected,*e.fees,*e.outputs,*[z.Not(p) for p in e.dead]),[x,y,g,f,q]))
    for root in ['deposit','withdraw']:
        r,s,l,q=z.BitVecs('reserve shares supply quote',64);failed=z.Bool('overflow')
        valid=z.And(r!=0,s!=0,l!=0) if root=='deposit' else z.And(r!=0,s!=0,z.ULT(s,l))
        wide_root=W+('ceil' if root=='deposit' else 'floor')
        class Liquidity(Evaluator):
            def __init__(self,p):super().__init__(p);self.calls=[]
            def call(self,name,args,path):
                if name==wide_root:
                    self.calls.append(z.And(path==valid,z.Implies(path,z.And(*[value(self,M+'U64',a)==b for a,b in zip(args,[r,s,l])]))))
                    ok=ctor(self,M+'Ok',word(self,M+'U64',q))
                    return z.If(failed,ctor(self,M+'Err',z.BitVecVal(1,32)),ok) if root=='deposit' else ok
                return super().call(name,args,path)
        e=Liquidity(program);w=lambda n:word(e,M+'U64',n);err=lambda n:ctor(e,M+'Err',z.BitVecVal(n,32))
        actual=e.call(root,[w(n) for n in [r,s,l]],z.BoolVal(True))
        result=z.If(q==0,err(4),ctor(e,M+'Ok',w(q)))
        if root=='deposit':result=z.If(failed,err(1),result)
        expected=z.If(valid,result,err(4))
        assert len(e.calls)==1
        claims.append(obligation('amm-'+root+'-routing',[],z.And(actual==expected,*e.calls,*[z.Not(p) for p in e.dead]),[r,s,l,q]))
    # Independently bind the exported fee function, even outside swap's guards.
    result=z.Const('fee_result',Evaluator(program).sort(M+'Checked'))
    class Fee(Evaluator):
        def __init__(self,p):super().__init__(p);self.calls=[]
        def call(self,name,args,path):
            if name==W+'ceil':
                self.calls.append(z.And(path,*[value(self,M+'U64',a)==b for a,b in zip(args,[g,z.BitVecVal(30,64),z.BitVecVal(10000,64)])]))
                return result
            return super().call(name,args,path)
    e=Fee(program);actual=e.call('fee',[word(e,M+'U64',g)],z.BoolVal(True));assert len(e.calls)==1
    claims.append(obligation('amm-fee-routing',[],z.And(actual==result,*e.calls,*[z.Not(p) for p in e.dead]),[g]))
    return claims


def economics():
    claims=[]
    g=z.Int('gross');fee=(g*30+9999)/10000
    claims.append(obligation('amm-fee-bounds',[g>=0,g<(1<<64)],z.And(fee>=0,fee<=g,fee<(1<<64),z.Implies(g>0,fee>0))))
    x,y,e,g,q=z.Ints('input output effective gross quote')
    assumptions=[x>0,y>0,e>0,g>=e,x+g<(1<<64),y<(1<<64),q>=0,q*(x+e)<=y*e,y*e<(q+1)*(x+e)]
    claims.append(obligation('amm-swap-output-bounds',assumptions,z.And(q<y,x+e>0,x+e<(1<<64),y*e<(1<<128))))
    # The floor lower bound implies x*q <= e*(y-q); retained fees imply
    # g*(y-q) >= e*(y-q). Expanded reserve-product difference is nonnegative.
    claims.append(obligation('amm-swap-product-invariant',assumptions,z.And((x+g)*(y-q)>=x*y)))
    r,s,l,q=z.Ints('reserve shares supply quote')
    claims.append(obligation('amm-deposit-ceiling-positive',[r>0,s>0,l>0,(q-1)*l<r*s,r*s<=q*l],q>0))
    claims.append(obligation('amm-withdraw-floor-bounds',[r>0,s>0,s<l,q*l<=r*s,r*s<(q+1)*l],z.And(q>=0,q<r)))
    # Share issuance/redemption cannot reduce reserve value per remaining share.
    claims.append(obligation('amm-deposit-no-dilution',[r>0,s>0,l>0,r*s<=q*l],(r+q)*l>=r*(l+s)))
    claims.append(obligation('amm-withdraw-no-dilution',[r>0,s>0,s<l,q*l<=r*s],(r-q)*l>=r*(l-s)))
    return claims


def prove(program_path,math_path,wide_path):
    program=json.load(open(program_path));wide=json.load(open(wide_path))
    bindings=[bind_floor(program,wide,root) for root in ['floor','ceil']]
    arithmetic=wide_proof(math_path,wide_path)
    assert len(arithmetic.get('smallDivision',[]))==15 and all(c['result']=='unsat' for c in arithmetic['smallDivision']), 'Small-divisor proof failed'
    assert len(arithmetic['fastPaths'])==33 and all(c['result']=='unsat' for c in arithmetic['fastPaths']), 'Wide fast-path proof failed'
    assert [c['claim'] for c in arithmetic['claims']]==['wide-quotient-overflow-threshold', 'integer-floor-ceiling', 'wide-divide-wrapper', 'wide-zero-precedence', 'wide-overflow-error', 'wide-divisor-one', 'wide-native64-route', 'wide-small32-route', 'wide-div64-route', 'mul-div-composition', 'floor-wrapper', 'ceil-wrapper'] and all(c['result']=='unsat' for c in arithmetic['claims']), 'Wide proof failed: '+str({'count':len(arithmetic['claims']),'failures':[(c['claim'],c['result'],c.get('reason')) for c in arithmetic['claims'] if c['result']!='unsat']})
    helpers=checked_arithmetic(program)
    assert all(c['result']=='unsat' for c in helpers),'Imported add/sub proof failed'
    return {'bindings':bindings,'wide':arithmetic,'checkedArithmetic':helpers,'claims':quotes(program)+economics()}

if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(*sys.argv[1:]);print(json.dumps(report,indent=2))
    sys.exit(0 if len(report['claims'])==11 and all(c['result']=='unsat' for c in report['claims']) else 1)
