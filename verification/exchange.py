"""Exchange entrypoint refinement with a bound, proved ceiling-price summary."""
import json
import sys
import z3 as z
from prove import Evaluator
from multiplication import word, value
from division_loop import obligation
from vesting_process import bind_floor
from wide import prove as wide_proof

M='../../sdk/math.';W='../../sdk/wide.';S='../../sdk/context.';F='../../sdk/effects.'


def transitions(program):
    reports=[]
    for state_name in ['Empty','Open','Closed']:
        for ins in ['Initialize','Fill','Cancel']:
            remaining,amount,numerator,denominator,maximum,payment,slot=z.BitVecs('remaining amount numerator denominator maximum payment slot',64)
            signed,failed=z.BitVecs('signed failed',1);code=z.BitVec('code',32)
            valid=z.And(amount!=0,z.ULE(amount,remaining))
            class Summary(Evaluator):
                def __init__(self,p):super().__init__(p);self.calls=[]
                def call(self,name,args,path):
                    if name!=W+'ceil':return super().call(name,args,path)
                    should=z.And(z.BoolVal(state_name=='Open' and ins=='Fill'),valid)
                    self.calls.append(z.And(path==should,z.Implies(path,z.And(*[value(self,M+'U64',a)==b for a,b in zip(args,[amount,numerator,denominator])]))))
                    return z.If(failed==1,c(M+'Err',code),c(M+'Ok',w(payment)))
            e=Summary(program)
            def c(name,*args):
                sort,i=e.constructors[name];return sort.constructor(i)(*args)
            w=lambda n:word(e,M+'U64',n)
            def key(n):return c(S+'Key',*[z.Extract(i*32+31,i*32,n) for i in range(8)])
            maker,actor,base,quote=z.BitVecs('maker actor base quote',256)
            offer=lambda n,who=maker:c('Offer',key(who),key(base),key(quote),w(n),w(numerator),w(denominator))
            state=c('Open',offer(remaining)) if state_name=='Open' else c(state_name)
            instruction=c(ins,*([key(base),key(quote),w(amount),w(numerator),w(denominator)] if ins=='Initialize' else [w(amount),w(maximum)] if ins=='Fill' else []))
            context=c(S+'Context',key(actor),signed==1,w(slot))
            actual=e.call('process',[context,state,instruction],z.BoolVal(True))
            reject=lambda n:c('Rejected',z.BitVecVal(n,32))
            def transfer(indices,mint,recipient,amount,authority):
                return c(F+'Transfer',*[z.BitVecVal(i,32) for i in indices],key(mint),recipient,w(amount),c(F+authority))
            def accept(state,first,second=None):return c('Accepted',state,c(F+'Effects',first,c(F+'None') if second is None else second))
            if state_name=='Closed':expected=reject(7)
            elif state_name=='Empty':
                if ins!='Initialize':expected=reject(2)
                else:
                    funded=accept(c('Open',offer(amount,actor)),transfer([4,5,6],base,c(F+'ToCustody'),amount,'Actor'),c(F+'CheckMint',z.BitVecVal(7,32),key(quote)))
                    expected=z.If(signed==0,reject(1),z.If(z.Or(base==quote,amount==0,numerator==0,denominator==0),reject(3),funded))
            elif ins=='Initialize':expected=reject(8)
            elif ins=='Cancel':
                refunded=accept(c('Closed'),transfer([4,5,6],base,c(F+'ToActor'),remaining,'Custody'))
                expected=z.If(z.Or(signed==0,actor!=maker),reject(1),refunded)
            else:
                left=remaining-amount
                next_state=z.If(left==0,c('Closed'),c('Open',offer(left)))
                settled=accept(next_state,transfer([4,5,6],quote,c(F+'ToOwner',key(maker)),payment,'Actor'),
                    transfer([7,8,9],base,c(F+'ToActor'),amount,'Custody'))
                expected=z.If(signed==0,reject(1),z.If(z.Not(valid),reject(4),z.If(failed==1,reject(6),
                    z.If(z.Or(payment==0,z.UGT(payment,maximum)),reject(5),settled))))
            # Concrete dispatch branches are pruned before evaluation. Only
            # Open+Fill can reach the price helper; its symbolic amount guard
            # and exact arguments are still proved by the recorded call.
            assert len(e.calls)==int(state_name=='Open' and ins=='Fill')
            reports.append(obligation(f'exchange-{state_name}-{ins}',[],z.And(actual==expected,*e.calls,*[z.Not(p) for p in e.dead]),
                [remaining,amount,numerator,denominator,maximum,payment,signed,failed,code,maker,actor,base,quote]))
    r,a=z.BitVecs('remaining amount',64)
    reports.append(obligation('exchange-base-conservation',[z.ULE(a,r)],z.ZeroExt(1,r-a)+z.ZeroExt(1,a)==z.ZeroExt(1,r),[r,a]))
    a,n,d=z.Ints('amount numerator denominator');p=(a*n+d-1)/d
    reports.append(obligation('exchange-ceiling-price',[a>0,n>0,d>0],z.And(p>0,(p-1)*d<a*n,a*n<=p*d)))
    return reports


def prove(program_path,math_path,wide_path):
    program=json.load(open(program_path));wide=json.load(open(wide_path))
    report={'binding':bind_floor(program,wide,'ceil'),'wide':wide_proof(math_path,wide_path),'claims':[]}
    if len(report['wide']['claims'])==6 and all(c['result']=='unsat' for c in report['wide']['claims']):report['claims']=transitions(program)
    return report


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(*sys.argv[1:]);print(json.dumps(report,indent=2))
    sys.exit(0 if len(report['claims'])==11 and all(c['result']=='unsat' for c in report['claims']) else 1)
