"""Connect checked entitlement and entrypoint to verified arithmetic/payouts."""
import json
import sys
import z3 as z
from prove import Evaluator
from multiplication import word, value
from division_loop import obligation
from vesting import prove as payout
from wide import prove as wide_proof

M='../../sdk/math.'
W='../../sdk/wide.'
S='../../sdk/context.'
F='../../sdk/effects.'


def bind_floor(program,wide,root='floor',wide_prefix=W,math_prefix=M):
    """Require identical checked definitions/types throughout the floor closure."""
    def rename(x):
        if isinstance(x,str):return x.replace(wide_prefix,'').replace(math_prefix,'math.')
        if isinstance(x,list):return [rename(v) for v in x]
        if isinstance(x,dict):return {rename(k):rename(v) for k,v in x.items() if k not in ['cType','cMaker']}
        return x
    names=set()
    def visit(name):
        if name in names:return
        names.add(name);f=program['functions'][name]
        assert rename(f)==wide['functions'][rename(name)],f'Imported {root} definition mismatch: {name}'
        def walk(t):
            if isinstance(t,dict):
                if t.get('$')=='Ref':visit(t['k'])
                for v in t.values():walk(v)
            elif isinstance(t,list):
                for v in t:walk(v)
        walk(f['body'])
    visit(wide_prefix+root)
    types={t['name']:t for t in program['schema']['types']}
    reference={t['name']:t for t in wide['schema']['types']};seen=set()
    def typecheck(name):
        if name in seen:return
        seen.add(name);t=types[name]
        assert rename(t)==rename(reference[rename(name)]),f'Imported {root} type mismatch: {name}'
        for v in t.get('variants',[]):
            for field in v['fields']:typecheck(field['type'])
    for name in names:
        f=program['functions'][name]
        for t in [*f['args'],f['result']]:typecheck(t)
    return {'result':'checked','functions':sorted(names),'types':sorted(seen)}


def c(e,name,*args):
    s,i=e.constructors[name];return s.constructor(i)(*args)


def entitlement(program):
    total,start,end,now,q=z.BitVecs('total start end now q',64)
    middle=z.And(z.ULT(start,now),z.ULT(now,end))
    class Summary(Evaluator):
        def __init__(self,p):super().__init__(p);self.calls=[]
        def call(self,name,args,path):
            if name!=W+'floor':return super().call(name,args,path)
            self.calls.append(z.And(path==middle,*[value(self,M+'U64',a)==b for a,b in zip(args,[total,now-start,end-start])]))
            return c(self,M+'Ok',word(self,M+'U64',q))
    e=Summary(program);pack=lambda n:word(e,M+'U64',n)
    actual=e.call('entitlement',[pack(n) for n in [total,start,end,now]],z.BoolVal(True))
    amount=z.If(z.ULE(now,start),z.BitVecVal(0,64),z.If(z.UGE(now,end),total,q))
    expected=c(e,M+'Ok',pack(amount))
    assert len(e.calls)==1
    routing=obligation('vesting-entitlement-routing',[z.ULT(start,end)],
        z.And(actual==expected,*e.calls,*[z.Not(p) for p in e.dead],
            z.Implies(middle,z.And(z.ULT(now-start,end-start),end-start!=0,
                z.ZeroExt(1,now-start)==z.ZeroExt(1,now)-z.ZeroExt(1,start),
                z.ZeroExt(1,end-start)==z.ZeroExt(1,end)-z.ZeroExt(1,start)))),[total,start,end,now,q])
    t,x,d=z.Ints('total elapsed duration')
    bounds=obligation('vesting-entitlement-bounds',[t>=0,t<(1<<64),d>0,d<(1<<64),x>=0,x<=d],
        z.And(t*x>=0,t*x<(1<<128),(t*x)/d>=0,(t*x)/d<=t))
    return [routing,bounds]


def entrypoint(program):
    reports=[]
    for live,claim in [(False,False),(False,True),(True,False),(True,True)]:
        total,start,end,claimed,now,vested=z.BitVecs('total start end claimed now vested',64)
        signed,failed=z.BitVecs('signed failed',1);code=z.BitVec('code',32)
        class Summary(Evaluator):
            def __init__(self,p):super().__init__(p);self.calls=[]
            def call(self,name,args,path):
                if name!='entitlement':return super().call(name,args,path)
                self.calls.append(z.And(path==z.BoolVal(live and claim),z.Implies(path,z.And(*[value(self,M+'U64',a)==b for a,b in zip(args,[total,start,end,now])]))))
                return z.If(failed==1,c(self,M+'Err',code),c(self,M+'Ok',word(self,M+'U64',vested)))
        e=Summary(program);pack=lambda n:word(e,M+'U64',n);ctor=lambda name,*args:c(e,name,*args)
        beneficiary=z.Const('beneficiary',e.sort(S+'Key'));actor=z.Const('actor',e.sort(S+'Key'));mint=z.Const('mint',e.sort(S+'Key'))
        schedule=lambda n:ctor('Schedule',beneficiary,mint,pack(total),pack(start),pack(end),pack(n))
        reject=lambda n:ctor('Rejected',z.BitVecVal(n,32))
        def accepted(amount,updated,initial=False):
            effect=ctor(F+'Transfer',*[z.BitVecVal(n,32) for n in [4,5,6]],mint,
                ctor(F+'ToCustody') if initial else ctor(F+'ToOwner',beneficiary),pack(amount),ctor(F+('Actor' if initial else 'Custody')))
            return ctor('Accepted',ctor('Live',schedule(updated)),ctor(F+'Effects',effect,ctor(F+'None')))
        context=ctor(S+'Context',actor,signed==1,pack(now))
        state=ctor('Live',schedule(claimed)) if live else ctor('Empty')
        instruction=ctor('Claim') if claim else ctor('Initialize',beneficiary,mint,pack(total),pack(start),pack(end))
        actual=e.call('process',[context,state,instruction],z.BoolVal(True))
        if live and claim:
            expected=z.If(z.Or(signed==0,actor!=beneficiary),reject(1),z.If(z.Or(failed==1,z.UGT(vested,total)),reject(4),
                z.If(z.ULT(vested,claimed),reject(5),z.If(vested==claimed,reject(6),accepted(vested-claimed,vested)))))
        elif live:expected=reject(7)
        elif claim:expected=reject(2)
        else:expected=z.If(signed==0,reject(1),z.If(z.Or(z.UGE(start,end),total==0),reject(3),accepted(total,z.BitVecVal(0,64),True)))
        # Concrete State/Instruction matches are simplified by the evaluator.
        # Only Live+Claim reaches entitlement; the other dispatch cases must
        # contain no summarized call. The recorded path/arguments still have
        # to satisfy the exact routing obligation below.
        assert len(e.calls)==int(live and claim)
        reports.append(obligation(f'vesting-process-{int(live)}-{int(claim)}',[],
            z.And(actual==expected,*e.calls,*[z.Not(p) for p in e.dead]),[total,start,end,claimed,now,vested,signed,failed,code]))
    return reports


def prove(program_path,math_path,wide_path):
    program=json.load(open(program_path));wide=json.load(open(wide_path))
    report={'binding':bind_floor(program,wide),'payout':payout(program_path),'wide':wide_proof(math_path,wide_path),'claims':[]}
    if len(report['wide'].get('smallDivision',[]))!=15 or not all(c['result']=='unsat' for c in report['wide']['smallDivision']):return report
    if not all(v['result']=='unsat' for v in report['payout']['claims']):return report
    if len(report['wide']['fastPaths'])!=33 or not all(v['result']=='unsat' for v in report['wide']['fastPaths']):return report
    if [c['claim'] for c in report['wide']['claims']]!=['wide-quotient-overflow-threshold', 'integer-floor-ceiling', 'wide-divide-wrapper', 'wide-zero-precedence', 'wide-overflow-error', 'wide-divisor-one', 'wide-native64-route', 'wide-small32-route', 'wide-div64-route', 'mul-div-composition', 'floor-wrapper', 'ceil-wrapper'] or not all(v['result']=='unsat' for v in report['wide']['claims']):return report
    report['claims']=entitlement(program)
    if all(v['result']=='unsat' for v in report['claims']):report['claims']+=entrypoint(program)
    return report


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(*sys.argv[1:]);print(json.dumps(report,indent=2))
    sys.exit(0 if len(report['claims'])==6 and all(c['result']=='unsat' for c in report['claims']) else 1)
