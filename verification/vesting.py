"""Exact funding/payout transitions from checked source, without arithmetic summaries."""
import hashlib
import json
import sys
import z3 as z
from prove import Evaluator
from division_loop import obligation
from multiplication import word


def prove(filename):
    raw=open(filename,'rb').read();program=json.loads(raw);e=Evaluator(program)
    math='../../sdk/math.';fx='../../sdk/effects.'
    def c(name,*args):
        sort,i=e.constructors[name];return sort.constructor(i)(*args)
    w=lambda n:word(e,math+'U64',n)
    beneficiary=z.Const('beneficiary',e.sort('../../sdk/context.Key'))
    mint=z.Const('mint',e.sort('../../sdk/context.Key'))
    total,start,end,claimed,vested=z.BitVecs('total start end claimed vested',64)
    schedule=lambda amount:c('Schedule',beneficiary,mint,w(total),w(start),w(end),w(amount))
    def accepted(amount,record,recipient,authority):
        effect=c(fx+'Transfer',*[z.BitVecVal(n,32) for n in [4,5,6]],mint,recipient,w(amount),c(fx+authority))
        return c('Accepted',c('Live',record),c(fx+'Effects',effect,c(fx+'None')))
    reject=lambda n:c('Rejected',z.BitVecVal(n,32))
    reports=[]
    actual=e.call('claim_result',[schedule(claimed),c(math+'Ok',w(vested))],z.BoolVal(True))
    expected=z.If(z.UGT(vested,total),reject(4),z.If(z.ULT(vested,claimed),reject(5),z.If(vested==claimed,reject(6),
        accepted(vested-claimed,schedule(vested),c(fx+'ToOwner',beneficiary),'Custody'))))
    reports.append(obligation('vesting-exact-payout',[],z.And(actual==expected,*[z.Not(p) for p in e.dead]),[total,claimed,vested]))
    # A 65-bit equation establishes integer conservation rather than modular
    # conservation, and includes the funding cap for every accepted transition.
    reports.append(obligation('vesting-payout-conservation',[z.ULT(claimed,vested),z.ULE(vested,total)],
        z.And(z.ZeroExt(1,claimed)+z.ZeroExt(1,vested-claimed)==z.ZeroExt(1,vested),z.ULE(vested,total)),[total,claimed,vested]))
    e.dead=[];code=z.BitVec('code',32)
    actual=e.call('claim_result',[schedule(claimed),c(math+'Err',code)],z.BoolVal(True))
    reports.append(obligation('vesting-arithmetic-error',[],z.And(actual==reject(4),*[z.Not(p) for p in e.dead]),[code]))
    e.dead=[];signed=z.BitVec('signed',1)
    instruction=c('Initialize',beneficiary,mint,w(total),w(start),w(end))
    actual=e.call('initialize_instruction',[signed==1,instruction],z.BoolVal(True))
    expected=z.If(signed==0,reject(1),z.If(z.Or(z.UGE(start,end),total==0),reject(3),
        accepted(total,schedule(z.BitVecVal(0,64)),c(fx+'ToCustody'),'Actor')))
    reports.append(obligation('vesting-exact-funding',[],z.And(actual==expected,*[z.Not(p) for p in e.dead]),[total,start,end,signed]))
    return {'solver':z.get_version_string(),'modelSha256':hashlib.sha256(raw).hexdigest(),'claims':reports}


if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(sys.argv[1]);print(json.dumps(report,indent=2))
    sys.exit(0 if all(c['result']=='unsat' for c in report['claims']) else 1)
