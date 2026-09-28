"""Compose step refinement, checked iteration count, induction and wrappers.

All obligations must pass before the public u64 division result is accepted.
"""
import hashlib
import json
import sys
import time
import z3 as z
from prove import Evaluator
from division_loop import induction, fast_paths, wrappers


def audit_composition(program,prefix=''):
    reports=[]
    for n in [2,4,8,16,32,64]:
        name=prefix+f'div{n}';callee=prefix+('div_step' if n==2 else f'div{n//2}')
        body=program['functions'][name]['body']
        assert body['$']=='Lam'
        expected={'$':'Var','i':body['i']}
        for _ in range(2): expected={'$':'App','f':{'$':'Ref','k':callee},'x':expected}
        assert body['f']==expected, f'{name} must apply {callee} twice to its input'
        reports.append({'function':name,'step_count':n,'result':'checked'})
    return reports


def prove(filename):
    raw=open(filename,'rb').read();program=json.loads(raw)
    report=prove_program(program)
    report['modelSha256']=hashlib.sha256(raw).hexdigest()
    return report


def prove_program(program,prefix='',public=True):
    assert program['version']==1
    evaluator=Evaluator(program)
    state_name=program['functions'][prefix+'div_step']['args'][0]
    state=evaluator.sort(state_name)
    fields=evaluator.types[state_name]['variants'][0]['fields']
    assert [f['name'] for f in fields]==['quotient','remainder','divisor']
    assert len(set(f['type'] for f in fields))==1
    u64=fields[0]['type'];word=evaluator.sort(u64)
    assert [f['type'] for f in evaluator.types[u64]['variants'][0]['fields']]==['U32','U32']
    pack=lambda v:word.constructor(0)(z.Extract(31,0,v),z.Extract(63,32,v))
    unpack=lambda v:z.Concat(word.accessor(0,1)(v),word.accessor(0,0)(v))
    q,r,d=z.BitVecs('q r d',64)
    actual=evaluator.call(prefix+'div_step',[state.constructor(0)(pack(q),pack(r),pack(d))],z.BoolVal(True))
    oq,orr,od=[unpack(state.accessor(0,i)(actual)) for i in range(3)]
    # Carry participates at bit 64; a 64-bit intermediate would lose it.
    incoming=z.ZeroExt(64,z.Extract(63,63,q))
    numerator=(z.ZeroExt(1,r)<<1)+incoming
    take=z.UGE(numerator,z.ZeroExt(1,d))
    expected_r=z.If(take,numerator-z.ZeroExt(1,d),numerator)
    expected_q=(q<<1)|z.If(take,z.BitVecVal(1,64),z.BitVecVal(0,64))
    valid=z.And(d!=0,z.ULT(r,d))
    correct=z.And(od==d,oq==expected_q,z.ZeroExt(1,orr)==expected_r,z.ULT(orr,d))
    solver=z.Solver();solver.set(timeout=30_000)
    solver.add(valid,z.Or(z.Not(correct),*evaluator.dead))
    start=time.monotonic();status=solver.check()
    result={'claim':'restoring-step','result':str(status),'seconds':round(time.monotonic()-start,3)}
    if status==z.sat:
        model=solver.model();result['counterexample']={str(v):str(model.eval(v,model_completion=True).as_long()) for v in [q,r,d]}
    if status==z.unknown:result['reason']=solver.reason_unknown()
    report={'solver':z.get_version_string(),
        'step':result,'composition':audit_composition(program,prefix)}
    # Summaries may only be used after their step and induction obligations pass.
    if status==z.unsat:
        report['induction']=induction()
        if public and all(c['result']=='unsat' for c in report['induction']):
            report['fastPaths']=fast_paths()
            if all(c['result']=='unsat' for c in report['fastPaths']):report['wrappers']=wrappers(program)
    return report


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(sys.argv[1]);print(json.dumps(report,indent=2))
    claims=[report['step'],*report.get('induction',[]),*report.get('fastPaths',[]),*report.get('wrappers',[])]
    sys.exit(0 if 'wrappers' in report and all(c['result']=='unsat' for c in claims) else 1)
