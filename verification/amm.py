"""Full checked AMM transition refinement with source-bound quote summaries."""
import json
import sys
import z3 as z
from prove import Evaluator
from multiplication import word, value
from division_loop import obligation
from binding import bind_closure
from amm_pricing import prove as pricing_proof, arithmetic_summary
from sqrt import prove as sqrt_proof
M='../../sdk/math.';S='../../sdk/context.';F='../../sdk/effects.';T='../../sdk/issuance.'
Q='pricing.';R='../../sdk/sqrt.'
MAX=(1<<64)-1
LOCKED=1000


def audit_schema(program):
    """Fail closed if the protocol gains a constructor our cases do not cover."""
    assert program['version']==1
    types={t['name']:t for t in program['schema']['types']}
    def record(name,fields):return [(name,fields)]
    expected={
        S+'Key':record(S+'Key',[(k,'U32') for k in 'abcdefgh']),
        S+'Context':record(S+'Context',[('actor',S+'Key'),('signed','Bool'),('slot',M+'U64')]),
        M+'U64':record(M+'U64',[('lo','U32'),('hi','U32')]),
        M+'Checked':[(M+'Ok',[('value',M+'U64')]),(M+'Err',[('code','U32')])],
        'Config':record('Config',[(k,S+'Key') for k in ['base','quote','lp','base_vault','quote_vault']]),
        'Balances':record('Balances',[(k,M+'U64') for k in ['base','quote','shares']]),
        'Pool':record('Pool',[('config','Config'),('balances','Balances')]),
        'State':[('Empty',[]),('Open',[('pool','Pool')])],
        'Instruction':[
            ('Initialize',[('config','Config'),('base',M+'U64'),('quote',M+'U64'),('min_shares',M+'U64')]),
            ('Deposit',[(k,M+'U64') for k in ['shares','max_base','max_quote']]),
            ('Withdraw',[(k,M+'U64') for k in ['shares','min_base','min_quote']]),
            ('Swap',[('base_in','Bool'),('amount',M+'U64'),('min_output',M+'U64')])],
        'Outcome':[('Accepted',[('state','State'),('effects',T+'Effects')]),('Rejected',[('code','U32')])],
        T+'Effects':record(T+'Effects',[(k,T+'Effect') for k in ['first','second','third']]),
        T+'Binding':[(T+'Any',[]),(T+'Exact',[('key',S+'Key')])],
        F+'Authority':[(F+'Actor',[]),(F+'Custody',[])],
        F+'Recipient':[(F+'ToActor',[]),(F+'ToCustody',[]),(F+'ToOwner',[('key',S+'Key')])],
    }
    transfer=[('source','U32'),('destination','U32'),('mint','U32'),('mint_key',S+'Key'),('recipient',F+'Recipient'),('amount',M+'U64'),('authority',F+'Authority')]
    expected[T+'TransferDetails']=record(T+'TransferDetails',transfer)
    expected[T+'Effect']=[(T+'None',[]),(T+'Transfer',transfer),(T+'CheckMint',[('mint','U32'),('mint_key',S+'Key')]),
        (T+'Mint',[('destination','U32'),('mint','U32'),('mint_key',S+'Key'),('recipient',F+'Recipient'),('amount',M+'U64'),('initialize','Bool')]),
        (T+'Burn',[('source','U32'),('mint','U32'),('mint_key',S+'Key'),('amount',M+'U64')]),
        (T+'BoundTransfer',[('transfer',T+'TransferDetails'),('source',T+'Binding'),('destination',T+'Binding'),('fresh_destination','Bool')])]
    assert types['U32']['kind']=='u32' and types['Bool']['kind']=='bool'
    for name,variants in expected.items():
        t=types[name]
        assert t['kind']=='adt' and [(v['name'],[(f['name'],f['type']) for f in v['fields']]) for v in t['variants']]==variants,f'Protocol schema mismatch: {name}'
    assert program['functions']['process']['args']==[S+'Context','State','Instruction']
    assert program['functions']['process']['result']=='Outcome'
    return {'result':'checked','types':sorted(expected),'state_cases':2,'instruction_cases':4}


def key_equality(program):
    e=Evaluator(program);sort=e.sort(S+'Key')
    assert [f['name'] for f in e.types[S+'Key']['variants'][0]['fields']]==list('abcdefgh')
    a,b=z.BitVecs('key_a key_b',256)
    key=lambda n:sort.constructor(0)(*[z.Extract(i*32+31,i*32,n) for i in range(8)])
    actual=e.call(S+'equal',[key(a),key(b)],z.BoolVal(True))
    return obligation('amm-checked-key-equality',[],z.And(actual==(a==b),*[z.Not(p) for p in e.dead]),[a,b])


def transitions(program):
    reports=[]
    for state_name in ['Empty','Open']:
        for operation in ['Initialize','Deposit','Withdraw','SwapBase','SwapQuote']:
            class Summary(Evaluator):
                def __init__(self,p):
                    super().__init__(p)
                    checked=self.sort(M+'Checked')
                    self.quotes={name:z.Function('quote_'+name,*([z.BitVecSort(64)]*3),checked) for name in ['deposit','withdraw','swap']}
                    self.mean=z.Function('proved_geometric_mean',z.BitVecSort(64),z.BitVecSort(64),z.BitVecSort(64))
                def call(self,name,args,path):
                    if name in [M+'add',M+'sub']:return arithmetic_summary(self,name,args)
                    if name==S+'equal':
                        sort=self.sort(S+'Key')
                        packed=[z.Concat(*[sort.accessor(0,i)(arg) for i in reversed(range(8))]) for arg in args]
                        return z.simplify(packed[0]==packed[1])
                    if name in [Q+k for k in self.quotes]:
                        return self.quotes[name[len(Q):]](*[value(self,M+'U64',a) for a in args])
                    if name==R+'geometric_mean':return word(self,M+'U64',self.mean(*[value(self,M+'U64',a) for a in args]))
                    return super().call(name,args,path)
            e=Summary(program)
            def c(name,*args):
                sort,index=e.constructors[name];return sort.constructor(index)(*args)
            w=lambda n:word(e,M+'U64',n)
            u=lambda n:z.BitVecVal(n,32)
            def key(n):return c(S+'Key',*[z.Extract(i*32+31,i*32,n) for i in range(8)])
            old_keys=z.BitVecs('old_base old_quote old_lp old_base_vault old_quote_vault',256)
            new_keys=z.BitVecs('new_base new_quote new_lp new_base_vault new_quote_vault',256)
            x,y,l,n,m,a,b,slot=z.BitVecs('base quote supply amount second_amount limit_a limit_b slot',64)
            actor=z.BitVec('actor',256);signed=z.BitVec('signed',1)
            config=lambda keys:c('Config',*[key(k) for k in keys])
            pool=lambda keys,x,y,l:c('Pool',config(keys),c('Balances',w(x),w(y),w(l)))
            state=c('Empty') if state_name=='Empty' else c('Open',pool(old_keys,x,y,l))
            if operation=='Initialize':ins=c('Initialize',config(new_keys),w(n),w(m),w(a))
            elif operation in ['Deposit','Withdraw']:ins=c(operation,w(n),w(a),w(b))
            else:ins=c('Swap',z.BoolVal(operation=='SwapBase'),w(n),w(a))
            context=c(S+'Context',key(actor),signed==1,w(slot))
            actual=e.call('process',[context,state,ins],z.BoolVal(True))
            reject=lambda code:c('Rejected',u(code))
            def transfer(keys,base,incoming,amount,fresh=False):
                mint=keys[0 if base else 1];vault=keys[3 if base else 4]
                user,reserve,index=([4,5,6] if base else [7,8,9])
                source,destination=(user,reserve) if incoming else (reserve,user)
                details=c(T+'TransferDetails',u(source),u(destination),u(index),key(mint),
                    c(F+('ToCustody' if incoming else 'ToActor')),w(amount),c(F+('Actor' if incoming else 'Custody')))
                return c(T+'BoundTransfer',details,c(T+'Any') if incoming else c(T+'Exact',key(vault)),
                    c(T+'Exact',key(vault)) if incoming else c(T+'Any'),z.BoolVal(fresh))
            def mint(keys,amount,fresh):return c(T+'Mint',u(10),u(11),key(keys[2]),c(F+'ToActor'),w(amount),z.BoolVal(fresh))
            def burn(keys,amount):return c(T+'Burn',u(10),u(11),key(keys[2]),w(amount))
            def accept(keys,x,y,l,effects):return c('Accepted',c('Open',pool(keys,x,y,l)),c(T+'Effects',*effects))
            checked=e.sort(M+'Checked');variants=e.types[M+'Checked']['variants']
            ok=next(i for i,v in enumerate(variants) if v['name'].endswith('.Ok'))
            is_ok=lambda result:checked.recognizer(ok)(result)
            quote=lambda result:value(e,M+'U64',checked.accessor(ok,0)(result))
            grows=lambda before,amount:z.ULE(z.ZeroExt(1,before)+z.ZeroExt(1,amount),MAX)
            if state_name=='Empty':
                if operation!='Initialize':expected=reject(2)
                else:
                    k=new_keys;total=e.mean(n,m);issued=total-1000
                    valid=z.And(k[0]!=k[1],k[0]!=k[2],k[1]!=k[2],k[3]!=k[4],n!=0,m!=0)
                    settled=accept(k,n,m,total,[transfer(k,True,True,n,True),transfer(k,False,True,m,True),mint(k,issued,True)])
                    expected=z.If(z.Not(valid),reject(3),z.If(z.ULE(total,1000),reject(4),z.If(z.ULT(issued,a),reject(5),settled)))
            elif operation=='Initialize':expected=reject(2)
            elif operation in ['Deposit','Withdraw']:
                adding=operation=='Deposit';fn=e.quotes['deposit' if adding else 'withdraw']
                rx,ry=fn(x,n,l),fn(y,n,l);dx,dy=quote(rx),quote(ry)
                prices=z.And(is_ok(rx),is_ok(ry))
                limits=z.And(z.ULE(dx,a),z.ULE(dy,b)) if adding else z.And(z.UGE(dx,a),z.UGE(dy,b))
                fits=z.And(grows(x,dx),grows(y,dy),grows(l,n)) if adding else z.And(z.UGE(x,dx),z.UGE(y,dy),z.UGE(l,n))
                if adding:
                    settled=accept(old_keys,x+dx,y+dy,l+n,[transfer(old_keys,True,True,dx),transfer(old_keys,False,True,dy),mint(old_keys,n,False)])
                else:
                    settled=accept(old_keys,x-dx,y-dy,l-n,[burn(old_keys,n),transfer(old_keys,True,False,dx),transfer(old_keys,False,False,dy)])
                expected=z.If(z.Not(prices),reject(4),z.If(z.Not(limits),reject(5),z.If(z.Not(fits),reject(4),settled)))
                if not adding:
                    available=z.And(z.UGE(l,1000),n!=0,z.ULE(n,l-1000))
                    expected=z.If(available,expected,reject(6))
            else:
                base=operation=='SwapBase';rx,ry=(x,y) if base else (y,x)
                result=e.quotes['swap'](rx,ry,n);amount=quote(result)
                first=transfer(old_keys,base,True,n);second=transfer(old_keys,not base,False,amount)
                nx,ny=(x+n,y-amount) if base else (x-amount,y+n)
                settled=accept(old_keys,nx,ny,l,[first,second,c(T+'None')])
                expected=z.If(z.Not(is_ok(result)),reject(4),z.If(z.ULT(amount,a),reject(5),
                    z.If(z.And(grows(rx,n),z.UGE(ry,amount)),settled,reject(4))))
            expected=z.If(signed==1,expected,reject(1))
            claim=z.simplify(z.And(actual==expected,*[z.Not(p) for p in e.dead]))
            variables=[x,y,l,n,m,a,b,signed,actor,*old_keys,*new_keys]
            if state_name=='Empty' and operation=='Initialize':
                partitions=[
                    ('unsigned',signed==0),
                    ('invalid',z.And(signed==1,z.Not(valid))),
                    ('insufficient',z.And(signed==1,valid,z.ULE(total,1000))),
                    ('slippage',z.And(signed==1,valid,z.UGT(total,1000),z.ULT(issued,a))),
                    ('accepted',z.And(signed==1,valid,z.UGT(total,1000),z.UGE(issued,a))),
                ]
                reports.append(obligation('amm-initialize-partition-coverage',[],z.Or(*[p for _,p in partitions])))
                for name,assumption in partitions:
                    reports.append(obligation('amm-Empty-Initialize-'+name,[assumption],claim,variables))
            else:
                reports.append(obligation(f'amm-{state_name}-{operation}',[],claim,variables))
    return reports


def accounting():
    """Prove the global reserve/share invariant around the exact transition.

    Actual token balances and LP supply follow original SPL semantics, and
    successful effects are atomic with state updates. The source transition
    binds those effects; runtime execution remains a separate assumption/test.
    """
    reports=[]
    a,b=z.BitVecs('before amount',64)
    reports.append(obligation('amm-u64-credit-conservation',
        [z.ULE(z.ZeroExt(1,a)+z.ZeroExt(1,b),MAX)],
        z.ZeroExt(1,a+b)==z.ZeroExt(1,a)+z.ZeroExt(1,b),[a,b]))
    reports.append(obligation('amm-u64-debit-conservation',[z.UGE(a,b)],
        z.ZeroExt(1,a-b)+z.ZeroExt(1,b)==z.ZeroExt(1,a),[a,b]))
    x,y,l,s,dx,dy=z.Ints('base quote supply shares base_amount quote_amount')
    common=[x>0,y>0,l>=LOCKED,l<=MAX,x<=MAX,y<=MAX]
    reports.append(obligation('amm-deposit-reachable-state',common+
        [s>0,dx>0,dy>0,x+dx<=MAX,y+dy<=MAX,l+s<=MAX],
        z.And(x+dx>0,y+dy>0,l+s>=LOCKED)))
    reports.append(obligation('amm-withdraw-reachable-state',common+
        [s>0,s<=l-LOCKED,dx>0,dx<x,dy>0,dy<y],
        z.And(x-dx>0,y-dy>0,l-s>=LOCKED)))
    reports.append(obligation('amm-swap-reachable-state',common+
        [s>0,dx>0,dx<y,x+s<=MAX],z.And(x+s>0,y-dx>0,l>=1000)))
    total=z.Int('initial_total')
    reports.append(obligation('amm-initial-locked-supply',[total>LOCKED,total<=MAX],
        z.And(total-LOCKED>0,(total-LOCKED)+LOCKED==total)))
    outstanding=z.Int('outstanding')
    reports.append(obligation('amm-issued-share-backing',
        [l>=LOCKED,outstanding>=0,outstanding<=l-LOCKED,s>0,l+s<=MAX],
        z.And(outstanding+s<=l+s-LOCKED,outstanding+s<=MAX)))
    reports.append(obligation('amm-redeemed-share-backing',
        [l>=LOCKED,outstanding>=s,s>0,outstanding<=l-LOCKED,s<=l-LOCKED],
        z.And(outstanding-s>=0,outstanding-s<=l-s-LOCKED,l-s>=LOCKED)))
    reports.append(obligation('amm-external-burn-preserves-backing',
        [l>=LOCKED,outstanding>=s,s>=0,outstanding<=l-LOCKED],
        z.And(outstanding-s>=0,outstanding-s<=l-LOCKED)))

    # Global LP claim bound. For any finite set of holders, each floor quote
    # satisfies L*q_i <= R*h_i; summing gives L*C <= R*S. Since S<L due to
    # locked shares, aggregate integer payouts C are strictly below R.
    reserve,total_shares,lp_supply,claims=z.Ints('claim_reserve total_shares lp_supply aggregate_claims')
    reports.append(obligation('amm-global-aggregate-claim-backing',
        [reserve>0,total_shares>=LOCKED,lp_supply>=0,
         lp_supply<=total_shares-LOCKED,claims>=0,
         total_shares*claims<=reserve*lp_supply],
        claims<reserve,[reserve,total_shares,lp_supply,claims]))

    # The following are one-step preservation obligations for the global
    # invariant: actual vault balance >= recorded reserve > 0, total accounting
    # shares >= LOCKED, and outstanding SPL LP supply <= total shares - LOCKED.
    ab,rb,aq,rq,l,s=z.Ints('actual_base recorded_base actual_quote recorded_quote total_shares outstanding_lp')
    inv=[ab>=rb,rb>0,aq>=rq,rq>0,l>=LOCKED,l<=MAX,s>=0,s<=l-LOCKED]

    init_base,init_quote,init_total=z.Ints('init_base init_quote init_total')
    (init_actual_base,init_recorded_base,init_actual_quote,init_recorded_quote,
     init_lp_supply)=z.Ints('init_actual_base init_recorded_base init_actual_quote init_recorded_quote init_lp_supply')
    minted=init_total-LOCKED
    # These equalities are the ghost-state interpretation of the initialization
    # effects/state checked by transitions(): fresh vaults receive the exact
    # recorded amounts and the LP mint receives total_shares - LOCKED.
    reports.append(obligation('amm-global-initialize-establishes',
        [init_base>0,init_quote>0,init_total>LOCKED,init_total<=MAX,
         init_actual_base==init_base,init_recorded_base==init_base,
         init_actual_quote==init_quote,init_recorded_quote==init_quote,
         init_lp_supply==minted],
        z.And(init_actual_base>=init_recorded_base,
              init_actual_quote>=init_recorded_quote,
              init_lp_supply>=0,init_lp_supply<=init_total-LOCKED,
              init_total>=LOCKED),
        [init_base,init_quote,init_total,minted,init_actual_base,
         init_recorded_base,init_actual_quote,init_recorded_quote,init_lp_supply]))

    dep_base,dep_quote,dep_shares=z.Ints('deposit_base_in deposit_quote_in deposit_shares')
    reports.append(obligation('amm-global-deposit-preserves',inv+
        [dep_base>0,dep_quote>0,dep_shares>0,
         ab+dep_base<=MAX,aq+dep_quote<=MAX,
         rb+dep_base<=MAX,rq+dep_quote<=MAX,l+dep_shares<=MAX],
        z.And(ab+dep_base>=rb+dep_base,aq+dep_quote>=rq+dep_quote,
              rb+dep_base>0,rq+dep_quote>0,l+dep_shares>=LOCKED,
              s+dep_shares<=l+dep_shares-LOCKED),
        [ab,rb,aq,rq,l,s,dep_base,dep_quote,dep_shares]))

    out_base,out_quote,burned=z.Ints('withdraw_base_out withdraw_quote_out shares_burned')
    reports.append(obligation('amm-global-withdraw-preserves',inv+
        [out_base>0,out_quote>0,out_base<rb,out_quote<rq,
         burned>0,burned<=s,burned<=l-LOCKED],
        z.And(ab-out_base>=rb-out_base,aq-out_quote>=rq-out_quote,
              rb-out_base>0,rq-out_quote>0,l-burned>=LOCKED,
              s-burned>=0,s-burned<=l-burned-LOCKED),
        [ab,rb,aq,rq,l,s,out_base,out_quote,burned]))

    gross,swap_out=z.Ints('swap_gross_in swap_token_out')
    reports.append(obligation('amm-global-base-in-swap-preserves',inv+
        [gross>0,swap_out>0,swap_out<rq,
         ab+gross<=MAX,rb+gross<=MAX],
        z.And(ab+gross>=rb+gross,aq-swap_out>=rq-swap_out,
              rq-swap_out>0,l>=LOCKED,s<=l-LOCKED),
        [ab,rb,aq,rq,l,s,gross,swap_out]))

    reports.append(obligation('amm-global-quote-in-swap-preserves',inv+
        [gross>0,swap_out>0,swap_out<rb,
         aq+gross<=MAX,rq+gross<=MAX],
        z.And(aq+gross>=rq+gross,ab-swap_out>=rb-swap_out,
              rb-swap_out>0,l>=LOCKED,s<=l-LOCKED),
        [ab,rb,aq,rq,l,s,gross,swap_out]))

    donation_base,donation_quote=z.Ints('donation_base donation_quote')
    reports.append(obligation('amm-global-donation-preserves',inv+
        [donation_base>=0,donation_quote>=0,
         ab+donation_base<=MAX,aq+donation_quote<=MAX],
        z.And(ab+donation_base>=rb,aq+donation_quote>=rq,
              rb>0,rq>0,l>=LOCKED,s<=l-LOCKED),
        [ab,rb,aq,rq,l,s,donation_base,donation_quote]))
    return reports


def prove(program_path,pricing_path,sqrt_path,math_path,wide_path,sqrt_math_path,sqrt_wide_path):
    program=json.load(open(program_path));pricing=json.load(open(pricing_path));square=json.load(open(sqrt_path))
    schema=audit_schema(program)
    bindings=[bind_closure(program,pricing,Q+root,{Q:''}) for root in ['deposit','withdraw','swap']]
    bindings.append(bind_closure(program,square,R+'geometric_mean',{R:'',M:'math.','../../sdk/wide.':'wide.'}))
    prices=pricing_proof(pricing_path,math_path,wide_path)
    assert len(prices['claims'])==11 and all(c['result']=='unsat' for c in prices['claims']), 'Pricing proof failed: '+str([(c['claim'],c['result'],c.get('reason')) for c in prices['claims'] if c['result']!='unsat'])
    roots=sqrt_proof(sqrt_path,sqrt_math_path,sqrt_wide_path)
    assert len(roots['claims'])==71 and all(c['result']=='unsat' for c in roots['claims']), 'Square-root proof failed: '+str([(c['claim'],c['result'],c.get('reason')) for c in roots['claims'] if c['result']!='unsat'])
    keys=key_equality(program)
    assert keys['result']=='unsat','Key equality proof failed'
    return {'schema':schema,'bindings':bindings,'pricing':prices,'sqrt':roots,'claims':[keys]+transitions(program)+accounting()}

if __name__=='__main__':
    if z.get_version_string()!='5.1.0':raise RuntimeError('Requires Z3 5.1.0')
    report=prove(*sys.argv[1:]);print(json.dumps(report,indent=2))
    sys.exit(0 if len(report['claims'])==32 and all(c['result']=='unsat' for c in report['claims']) else 1)
