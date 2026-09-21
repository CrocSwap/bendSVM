"""Checked trial-bit square-root step plus integer induction.

The product summary is available only after its imported source closure matches
and the existing full-width multiplication proof passes. Integer induction
connects that bitvector step to floor square root; it does not prove the backend.
"""
import json
import sys
import z3 as z
from prove import Evaluator
from multiplication import word, value, wide_word, wide_value, prove as products
from division_loop import obligation
from vesting_process import bind_floor


def composition(program):
    reports=[]
    for n in [2,4,8,16,32,64]:
        name=f'step{n}';callee='step' if n==2 else f'step{n//2}'
        body=program['functions'][name]['body'];assert body['$']=='Lam'
        expected={'$':'Var','i':body['i']}
        for _ in range(2):expected={'$':'App','f':{'$':'Ref','k':callee},'x':expected}
        assert body['f']==expected,f'{name} must apply {callee} twice'
        reports.append({'function':name,'steps':n,'result':'checked'})
    return reports


def helper_summary(e,name,args):
    if name=='math.add_wrap':
        a,b=[value(e,'math.U64',arg) for arg in args]
        return word(e,'math.U64',a+b)
    if name=='half':
        return word(e,'math.U64',z.LShR(value(e,'math.U64',args[0]),1))
    assert name=='less'
    a,b=[wide_value(e,'wide.U128',arg) for arg in args]
    return z.ULT(a,b)


def checked_helpers(program):
    """Prove each word-level summary from this model's actual helper body."""
    reports=[]
    for name in ['math.add_wrap','half','less']:
        # A mutation may remove the final reference to a helper. No summary of
        # that helper is then used, and the step still must satisfy its contract.
        if name not in program['functions']:continue
        e=Evaluator(program);bits=128 if name=='less' else 64
        a,b=z.BitVecs('helper_left helper_right',bits)
        wrap=(lambda n:wide_word(e,'wide.U128',n)) if bits==128 else (lambda n:word(e,'math.U64',n))
        args=[wrap(a)] if name=='half' else [wrap(a),wrap(b)]
        actual=e.call(name,args,z.BoolVal(True))
        reports.append(obligation('sqrt-helper-'+name,[],
            z.And(actual==helper_summary(e,name,args),*[z.Not(p) for p in e.dead]),[a,b]))
    return reports


def source_claims(program):
    target=z.BitVec('target',128);root,bit=z.BitVecs('root bit',64)
    square=z.Function('proved_product',z.BitVecSort(64),z.BitVecSort(64),z.BitVecSort(128))
    class Summary(Evaluator):
        def call(self,name,args,path):
            if name in ['math.add_wrap','half','less']:
                return helper_summary(self,name,args)
            if name=='wide.product':
                return wide_word(self,'wide.U128',square(*[value(self,'math.U64',a) for a in args]))
            return super().call(name,args,path)
    candidate=root+bit
    product=z.BitVec('candidate_square',128)
    class Step(Summary):
        def __init__(self,p):super().__init__(p);self.calls=[]
        def call(self,name,args,path):
            if name=='wide.product':
                self.calls.append(z.And(path,*[value(self,'math.U64',a)==candidate for a in args]))
                return wide_word(self,'wide.U128',product)
            return super().call(name,args,path)
    e=Step(program);s=e.sort('Search');w=lambda n:word(e,'math.U64',n)
    actual=e.call('step',[s.constructor(0)(wide_word(e,'wide.U128',target),w(root),w(bit))],z.BoolVal(True))
    assert len(e.calls)==1,'The step must square its candidate exactly once'
    # Check both product arguments independently, and prove routing for every
    # possible product result. This avoids mixed UF/bitvector congruence search.
    expected=s.constructor(0)(wide_word(e,'wide.U128',target),w(z.If(z.ULE(product,target),candidate,root)),w(z.LShR(bit,1)))
    claims=[obligation('sqrt-checked-step',[],z.And(actual==expected,*e.calls,*[z.Not(p) for p in e.dead]),[target,root,bit,product])]
    # Check initialization and extraction against an arbitrary loop result.
    q=z.BitVec('root_result',64)
    class Loop(Summary):
        def __init__(self,p):super().__init__(p);self.calls=[]
        def call(self,name,args,path):
            if name=='step64':
                self.calls.append(z.And(path,args[0]==self.sort('Search').constructor(0)(wide_word(self,'wide.U128',target),word(self,'math.U64',z.BitVecVal(0,64)),word(self,'math.U64',z.BitVecVal(1<<63,64)))))
                return self.sort('Search').constructor(0)(wide_word(self,'wide.U128',target),word(self,'math.U64',q),word(self,'math.U64',z.BitVecVal(0,64)))
            return super().call(name,args,path)
    e=Loop(program);actual=e.call('floor',[wide_word(e,'wide.U128',target)],z.BoolVal(True));assert len(e.calls)==1
    claims.append(obligation('sqrt-floor-wrapper',[],z.And(value(e,'math.U64',actual)==q,*e.calls,*[z.Not(p) for p in e.dead]),[target,q]))
    a,b=z.BitVecs('a b',64)
    class Mean(Summary):
        def __init__(self,p):super().__init__(p);self.calls=[]
        def call(self,name,args,path):
            if name=='floor':
                self.calls.append(z.And(path,wide_value(self,'wide.U128',args[0])==square(a,b)))
                return word(self,'math.U64',q)
            return super().call(name,args,path)
    e=Mean(program);actual=e.call('geometric_mean',[word(e,'math.U64',n) for n in [a,b]],z.BoolVal(True));assert len(e.calls)==1
    claims.append(obligation('sqrt-geometric-mean-wrapper',[],z.And(value(e,'math.U64',actual)==q,*e.calls,*[z.Not(p) for p in e.dead]),[a,b,q]))
    return claims


def induction():
    t,r=z.Ints('target root');claims=[]
    claims.append(obligation('sqrt-initial-interval',[t>=0,t<(1<<128)],z.And(0<=t,t<(1<<64)**2)))
    for i in range(64):
        b=1<<(63-i);candidate=r+b
        after=z.If(candidate*candidate<=t,candidate,r)
        assumptions=[r>=0,r+2*b<=1<<64,r*r<=t,t<(r+2*b)*(r+2*b)]
        claim=z.And(candidate>=0,candidate<(1<<64),after*after<=t,t<(after+b)*(after+b),after+b<=1<<64)
        claims.append(obligation(f'sqrt-interval-step-{i}',assumptions,claim,[t,r]))
    claims.append(obligation('sqrt-final-floor',[r>=0,r<(1<<64),r*r<=t,t<(r+1)*(r+1)],z.And(r*r<=t,(r+1)*(r+1)>t)))
    return claims


def prove(program_path,math_path,wide_path):
    program=json.load(open(program_path));wide=json.load(open(wide_path))
    binding=bind_floor(program,wide,'product','wide.','math.')
    multiplication=products(math_path,wide_path)
    assert len(multiplication['claims'])==14 and all(c['result']=='unsat' for c in multiplication['claims']), 'Product proof failed'
    helpers=checked_helpers(program)
    assert all(c['result']=='unsat' for c in helpers), 'Square-root helper proof failed: '+str(helpers)
    return {'binding':binding,'multiplication':multiplication,'checkedHelpers':helpers,'composition':composition(program),'claims':source_claims(program)+induction()}

if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(*sys.argv[1:]);print(json.dumps(report,indent=2))
    sys.exit(0 if len(report['claims'])==69 and all(c['result']=='unsat' for c in report['claims']) else 1)
