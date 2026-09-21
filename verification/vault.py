"""Full vault source transition refinement without arithmetic summaries."""
import hashlib
import json
import sys
import z3 as z
from prove import Evaluator
from division_loop import obligation
from multiplication import word


def prove(filename):
    raw=open(filename,'rb').read();program=json.loads(raw);reports=[]
    for live in [False,True]:
        for instruction in ['Initialize','Deposit','Withdraw']:
            e=Evaluator(program);M='../../sdk/math.';S='../../sdk/context.';F='../../sdk/effects.'
            def c(name,*args):
                sort,i=e.constructors[name];return sort.constructor(i)(*args)
            def key(n):return c(S+'Key',*[z.Extract(i*32+31,i*32,n) for i in range(8)])
            w=lambda n:word(e,M+'U64',n)
            owner,actor,mint,init_mint=z.BitVecs('owner actor mint init_mint',256)
            balance,amount,slot=z.BitVecs('balance amount slot',64);signed=z.BitVec('signed',1)
            context=c(S+'Context',key(actor),signed==1,w(slot))
            state=c('Live',key(owner),key(mint),w(balance)) if live else c('Empty')
            ins=c(instruction,key(init_mint) if instruction=='Initialize' else w(amount))
            actual=e.call('process',[context,state,ins],z.BoolVal(True))
            reject=lambda code:c('Rejected',z.BitVecVal(code,32))
            def accepted(who,which,new_balance,effect):
                return c('Accepted',c('Live',key(who),key(which),w(new_balance)),c(F+'Effects',effect,c(F+'None')))
            if not live:
                if instruction=='Initialize':
                    expected=z.If(signed==0,reject(1),accepted(actor,init_mint,z.BitVecVal(0,64),c(F+'CheckMint',z.BitVecVal(4,32),key(init_mint))))
                else:expected=reject(2)
            else:
                if instruction=='Initialize':outcome=reject(3)
                else:
                    deposit=instruction=='Deposit'
                    mathematical=z.ZeroExt(1,balance)+z.ZeroExt(1,amount)
                    fails=z.Extract(64,64,mathematical)==1 if deposit else z.ULT(balance,amount)
                    updated=z.Extract(63,0,mathematical) if deposit else balance-amount
                    effect=c(F+'Transfer',*[z.BitVecVal(n,32) for n in [4,5,6]],key(mint),
                        c(F+('ToCustody' if deposit else 'ToActor')),w(amount),c(F+('Actor' if deposit else 'Custody')))
                    outcome=z.If(fails,reject(4 if deposit else 5),accepted(owner,mint,updated,effect))
                expected=z.If(z.Or(signed==0,actor!=owner),reject(1),outcome)
            reports.append(obligation(f'vault-{int(live)}-{instruction}',[],
                z.And(actual==expected,*[z.Not(p) for p in e.dead]),[owner,actor,mint,init_mint,balance,amount,slot,signed]))
    # These integer identities connect exact effects to cumulative accounting.
    balance,amount=z.BitVecs('balance amount',64)
    addition=z.ZeroExt(1,balance)+z.ZeroExt(1,amount)
    reports.append(obligation('vault-deposit-conservation',[z.Extract(64,64,addition)==0],
        z.ZeroExt(1,balance+amount)==addition,[balance,amount]))
    reports.append(obligation('vault-withdraw-conservation',[z.ULE(amount,balance)],
        z.ZeroExt(1,balance-amount)+z.ZeroExt(1,amount)==z.ZeroExt(1,balance),[balance,amount]))
    return {'solver':z.get_version_string(),'modelSha256':hashlib.sha256(raw).hexdigest(),'claims':reports}


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(sys.argv[1]);print(json.dumps(report,indent=2))
    sys.exit(0 if all(c['result']=='unsat' for c in report['claims']) else 1)
