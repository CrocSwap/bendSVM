"""Inductive obligations joining the proved step to the 64-step loop.

Integer arithmetic interprets the unsigned bitvectors from division_step.py.
The composition theorem is valid only together with that step proof and the
checked composition-tree audit on the same exported source model.
"""
import time
import z3 as z
from prove import Evaluator


def obligation(name, assumptions, claim, variables=()):
    solver=z.Solver();solver.set(timeout=30_000)
    solver.add(*assumptions,z.Not(claim))
    started=time.monotonic();status=solver.check()
    result={'claim':name,'result':str(status),'seconds':round(time.monotonic()-started,3)}
    if status==z.sat:
        model=solver.model();result['counterexample']={str(v):str(model.eval(v,model_completion=True).as_long()) for v in variables}
    if status==z.unknown:result['reason']=solver.reason_unknown()
    return result


def induction():
    reports=[]
    # q packs an unconsumed dividend suffix U above i quotient bits V.
    # For each actual iteration count, prove shift/top-bit/packing correspondence
    # and that the processed quotient still fits its i+1-bit allocation.
    u,v,t=z.Ints('suffix prefix take')
    for i in range(64):
        scale=1<<i;remaining=1<<(64-i);half=remaining//2
        packed=u*scale+v
        incoming=packed/(1<<63)
        next_u=u%half;next_v=2*v+t
        next_packed=(2*packed)%(1<<64)+t
        claim=z.And(incoming==u/half,next_packed==next_u*(2*scale)+next_v,
            next_u>=0,next_u<half,next_v>=0,next_v<2*scale,
            u==incoming*half+next_u)
        reports.append(obligation(f'packing-step-{i}',[u>=0,u<remaining,v>=0,v<scale,t>=0,t<=1],claim))
    d,r,bit=z.Ints('divisor remainder incoming')
    numerator=2*r+bit
    take=z.If(numerator>=d,1,0)
    new_r=numerator-take*d
    reports.append(obligation('integer-remainder-bounds',
        [d>0,d<(1<<64),r>=0,r<d,bit>=0,bit<=1],
        z.And(new_r>=0,new_r<d,numerator>=0,numerator<(1<<65))))
    # Invariant: N = (D*V + R)*S + U, S=2^(64-i).
    # The packing lemma supplies U=incoming*(S/2)+next_U.
    k,next_u=z.Ints('half_scale next_suffix')
    # Treat take as an arbitrary integer: cancellation holds for both branches.
    before=(d*v+r)*(2*k)+(bit*k+next_u)
    after=(d*(2*v+t)+(2*r+bit-t*d))*k+next_u
    reports.append(obligation('dividend-invariant-preserved',[],
        z.simplify(before-after,som=True)==0))
    h,low=z.Ints('initial_high initial_low')
    reports.append(obligation('initial-state',
        [d>0,d<(1<<64),h>=0,h<d,low>=0,low<(1<<64)],
        z.And((d*0+h)*(1<<64)+low==h*(1<<64)+low,
            low*(1<<0)+0==low,h*(1<<64)+low<d*(1<<64))))
    # At i=64: the suffix has range [0,1), so it is zero; q is all quotient.
    n=z.Int('dividend')
    reports.append(obligation('final-euclidean-result',
        [d>0,r>=0,r<d,u>=0,u<1,v>=0,v<(1<<64),n==(d*v+r)+u],
        z.And(u==0,n==d*v+r,v>=0,v<(1<<64),r>=0,r<d)))
    return reports


def wrappers(program):
    reports=[]
    for root in ['divmod','div','mod']:
        a,b=z.BitVecs('a b',64)
        class Summary(Evaluator):
            def __init__(self,p):
                super().__init__(p);self.calls=[]
            def call(self,name,args,path):
                if name!='div64':return super().call(name,args,path)
                state=self.sort('DivState');word=self.sort('U64')
                value=lambda n:z.Concat(word.accessor(0,1)(n),word.accessor(0,0)(n))
                low,high,d=[value(state.accessor(0,i)(args[0])) for i in range(3)]
                # The proved loop theorem requires high < d and d > 0. Public
                # u64 wrappers must initialize it with (a,0,b), only if b != 0.
                self.calls.append(z.And(path== (b!=0),z.Implies(path,z.And(low==a,high==0,d==b,b!=0))))
                pack=lambda n:word.constructor(0)(z.Extract(31,0,n),z.Extract(63,32,n))
                # Apply the established loop theorem on the guarded inputs.
                return state.constructor(0)(pack(z.UDiv(a,b)),pack(z.URem(a,b)),pack(b))
        evaluator=Summary(program);word=evaluator.sort('U64')
        pack=lambda n:word.constructor(0)(z.Extract(31,0,n),z.Extract(63,32,n))
        result=evaluator.call(root,[pack(a),pack(b)],z.BoolVal(True))
        assert len(evaluator.calls)==1,f'{root}: expected one guarded div64 application'
        def ctor(name,*fields):
            sort,i=evaluator.constructors[name];return sort.constructor(i)(*fields)
        if root=='divmod':
            success=ctor('DivOk',ctor('Division',pack(z.UDiv(a,b)),pack(z.URem(a,b))))
            failure=ctor('DivErr',z.BitVecVal(3,32))
        else:
            success=ctor('Ok',pack(z.UDiv(a,b) if root=='div' else z.URem(a,b)))
            failure=ctor('Err',z.BitVecVal(3,32))
        correct=z.And(result==z.If(b==0,failure,success),*evaluator.calls,*[z.Not(p) for p in evaluator.dead])
        reports.append(obligation(root,[],correct,[a,b]))
    return reports
