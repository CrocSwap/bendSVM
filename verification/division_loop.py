"""Inductive obligations joining the proved step to the 64-step loop.

Integer arithmetic interprets the unsigned bitvectors from division_step.py.
The composition theorem is valid only together with that step proof and the
checked composition-tree audit on the same exported source model.
"""
import time
import z3 as z
from prove import Evaluator


def obligation(name, assumptions, claim, variables=(), timeout_ms=30_000):
    solver=z.Solver();solver.set(timeout=timeout_ms)
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


def fast_paths():
    reports=[]
    a,b=z.Ints('dividend divisor')
    high,low=z.Ints('high low')
    bounds=[a>=0,a<(1<<64),b>0,b<(1<<64),
        high==a/(1<<32),low==a%(1<<32),high<b]
    reports.append(obligation('high-divisor-initial-state',bounds,
        z.And(high<b,high>=0,high<(1<<32),low>=0,low<(1<<32),
            a==high*(1<<32)+low,
            # At step 32, V=0, R=high, U=low and S=2^32.
            a==(b*0+high)*(1<<32)+low,
            low*(1<<32)+0<(1<<64)),[a,b]))
    # Every skipped prefix is below the divisor. The restoring step
    # therefore takes no subtraction in the first 32 iterations, and leaves
    # quotient prefix zero and remainder equal to the consumed prefix.
    for i in range(1,33):
        prefix=a/(1<<(64-i))
        reports.append(obligation(f'high-divisor-skipped-prefix-{i}',bounds,
            z.And(prefix>=0,prefix<(1<<32),prefix<b),[a,b]))
    return reports


def wide_fast_paths():
    """A zero-high wide dividend can begin its last 32 steps at the prefix.

    These lemmas use the same packing invariant and checked div32 composition
    established by prove_program; the div32 summary is gated on their results.
    """
    base=1<<32;limit=1<<64
    low,d=z.Ints('wide_low wide_divisor')
    prefix=low/base;suffix=low%base
    guard=z.Or(prefix==0,d>=base)
    bounds=[low>=0,low<limit,d>0,d<limit,guard]
    reports=[obligation('wide-div32-transformed-state',bounds,
        z.And(prefix>=0,prefix<d,suffix>=0,suffix<base,
            low==prefix*base+suffix,
            # At step 32: V=0, R=prefix, U=suffix, S=2^32.
            low==(d*0+prefix)*base+suffix,
            suffix*base<limit),[low,d])]
    for i in range(1,33):
        consumed=low/(1<<(64-i))
        previous=low/(1<<(65-i))
        incoming=consumed%2
        reports.append(obligation(f'wide-div32-skipped-prefix-{i}',bounds,
            z.And(incoming>=0,incoming<=1,consumed==2*previous+incoming,
                consumed>=0,consumed<d),[low,d]))
    return reports


def wrappers(program):
    # Establish the rewrites on arbitrary words before using them in the
    # source-wrapper proof. No host examples or cached reports discharge this.
    x,y=z.BitVecs('rewrite_dividend rewrite_divisor',64)
    q=z.If(y==1,x,z.If(z.ULT(x,y),z.BitVecVal(0,64),z.UDiv(x,y)))
    r=z.If(y==1,z.BitVecVal(0,64),z.If(z.ULT(x,y),x,z.URem(x,y)))
    solver=z.Tactic('qfbv').solver();solver.set(timeout=120_000)
    solver.add(z.Or(q!=z.UDiv(x,y),r!=z.URem(x,y)))
    started=time.monotonic();status=solver.check();rewrite_seconds=time.monotonic()-started
    if status!=z.unsat:raise RuntimeError('Unproved division rewrite: '+str(status)+' '+solver.reason_unknown())
    reports=[]
    for root in ['divmod','div','mod']:
        a,b=z.BitVecs('a b',64)
        quotient=z.substitute(q,(x,a),(y,b));remainder=z.substitute(r,(x,a),(y,b))
        class Summary(Evaluator):
            def __init__(self,p):
                super().__init__(p);self.calls=[]
            def call(self,name,args,path):
                if name not in ['div32','div64']:return super().call(name,args,path)
                state=self.sort('DivState');word=self.sort('U64')
                value=lambda n:z.Concat(word.accessor(0,1)(n),word.accessor(0,0)(n))
                low,high,d=[value(state.accessor(0,i)(args[0])) for i in range(3)]
                a_high=z.Extract(63,32,a)
                active=z.And(b!=0,z.UGE(a,b),b!=1)
                allowed=z.ULT(z.ZeroExt(32,a_high),b)
                if name=='div32':
                    guard=z.And(active,allowed)
                    initial=z.And(low==z.Concat(z.Extract(31,0,a),z.BitVecVal(0,32)),
                        high==z.ZeroExt(32,a_high),d==b,z.ULT(high,d))
                else:
                    guard=z.And(active,z.Not(allowed))
                    initial=z.And(low==a,high==0,d==b,z.ULT(high,d))
                self.calls.append(z.And(path==guard,z.Implies(path,initial)))
                pack=lambda n:word.constructor(0)(z.Extract(31,0,n),z.Extract(63,32,n))
                # The 64-step theorem and proved skipped-prefix theorem both
                # yield the public quotient and remainder on these inputs.
                return state.constructor(0)(pack(quotient),pack(remainder),pack(b))
        evaluator=Summary(program);word=evaluator.sort('U64')
        pack=lambda n:word.constructor(0)(z.Extract(31,0,n),z.Extract(63,32,n))
        result=evaluator.call(root,[pack(a),pack(b)],z.BoolVal(True))
        assert len(evaluator.calls)==2,f'{root}: expected guarded div32 and div64 applications'
        def ctor(name,*fields):
            sort,i=evaluator.constructors[name];return sort.constructor(i)(*fields)
        if root=='divmod':
            success=ctor('DivOk',ctor('Division',pack(quotient),pack(remainder)))
            failure=ctor('DivErr',z.BitVecVal(3,32))
        else:
            success=ctor('Ok',pack(quotient if root=='div' else remainder))
            failure=ctor('Err',z.BitVecVal(3,32))
        correct=z.And(result==z.If(b==0,failure,success),*evaluator.calls,*[z.Not(p) for p in evaluator.dead])
        # Full-width division identities need more wall time on loaded hosts.
        # The formula and strict UNSAT requirement are unchanged.
        reports.append(obligation(root,[],correct,[a,b],timeout_ms=120_000))
    reports[0]['seconds']=round(reports[0]['seconds']+rewrite_seconds,3)
    return reports
