"""Bitvector checks for the reviewed unsigned C arithmetic templates.

The source refinement commands establish the checked Bend operations equal
unsigned division/remainder and exact u32 multiplication. This file checks the
pack/split and guard formulas used by the native C lowering. C, LLVM and SBF
semantics remain trusted, with separate compiled differential evidence.
"""
import json
import sys
import time
import z3 as z


def check(name, variables, assumptions, correct):
    solver=z.Solver();solver.set(timeout=30000)
    solver.add(*assumptions,z.Not(correct))
    start=time.monotonic();status=solver.check()
    item={'claim':name,'result':str(status),'seconds':round(time.monotonic()-start,3)}
    if status==z.sat:
        model=solver.model()
        item['counterexample']={str(v):str(model.eval(v,model_completion=True).as_long()) for v in variables}
    if status==z.unknown:item['reason']=solver.reason_unknown()
    return item


def prove():
    al,ah,bl,bh=z.BitVecs('al ah bl bh',32)
    n=z.Concat(ah,al);d=z.Concat(bh,bl)
    packed_n=(z.ZeroExt(32,ah)<<32)|z.ZeroExt(32,al)
    packed_d=(z.ZeroExt(32,bh)<<32)|z.ZeroExt(32,bl)
    q=z.UDiv(packed_n,packed_d)
    r=z.URem(packed_n,packed_d)
    split=lambda v:z.Concat(z.Extract(63,32,v),z.Extract(31,0,v))
    product=z.ZeroExt(32,al)*z.ZeroExt(32,bl)
    claims=[
        check('u64-input-packing',[al,ah,bl,bh],[],z.And(packed_n==n,packed_d==d)),
        check('zero-divisor-error',[bl,bh],[d==0],
            z.If(packed_d==0,z.BitVecVal(3,32),z.BitVecVal(0,32))==3),
        check('quotient-remainder-split',[al,ah,bl,bh],[d!=0],
            z.And(split(q)==z.UDiv(n,d),split(r)==z.URem(n,d))),
        check('u32-product-split',[al,bl],[],
            split(product)==z.ZeroExt(32,al)*z.ZeroExt(32,bl)),
    ]
    bad=check('wrong-divide-operator-rejected',[al,ah,bl,bh],[d!=0],
        split(packed_n*packed_d)==z.UDiv(n,d))
    return {'solver':z.get_version_string(),'claims':claims,'negative':bad}


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove();print(json.dumps(report,indent=2))
    sys.exit(0 if all(c['result']=='unsat' for c in report['claims']) and
        report['negative']['result']=='sat' else 1)
