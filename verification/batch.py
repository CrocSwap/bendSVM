"""Full checked batch transitions against independent atomic-settlement outcomes."""
import hashlib
import json
import sys
import z3 as z
from prove import Evaluator
from binding import bind_closure

program=json.load(open(sys.argv[1]));reports=[]
reference=json.load(open('build/batch-arithmetic.model.json'))
M='../../sdk/math.'
binding_report=bind_closure(program,reference,M+'add',{M:''})
# The case split below is exhaustive only for this protocol. Fail closed when
# source evolution introduces a new state, instruction, or outcome branch.
for name,variants in {
    'State':[('Empty',[]),('Funded',['batch']),('Closed',[])],
    'Instruction':[('Initialize',['mint','vault','obligations','fuel']),('Settle',[])],
    'Outcome':[('Accepted',['state','effects']),('Rejected',['code'])],
}.items():
    actual=next(t for t in program['schema']['types'] if t['name']==name)
    assert [(v['name'],v['tag'],[f['name'] for f in v['fields']]) for v in actual['variants']]==[
        (variant,i,fields) for i,(variant,fields) in enumerate(variants)],f'Protocol schema mismatch: {name}'
class BatchEvaluator(Evaluator):
    abstract_updates=False
    out_of_range=False
    def call(self,name,args,path):
        if name=='U32.is_ge' and self.out_of_range:
            result=z.simplify(super().call(name,args,path))
            return z.substitute(result,(z.simplify(z.UGE(z.BitVecVal(4,32),length)),z.BoolVal(False)))
        if name=='add_amount' and self.abstract_updates:
            return update(*args)
        if name==M+'add':
            sort=self.sort(M+'U64')
            values=[z.Concat(sort.accessor(0,1)(a),sort.accessor(0,0)(a)) for a in args]
            total=z.ZeroExt(1,values[0])+z.ZeroExt(1,values[1])
            result=self.sort(M+'Checked')
            word=sort.constructor(0)(z.Extract(31,0,total),z.Extract(63,32,total))
            return z.If(z.Extract(64,64,total)==1,result.constructor(1)(z.BitVecVal(1,32)),result.constructor(0)(word))
        return super().call(name,args,path)
e=BatchEvaluator(program)
types=e.types
checked=e.sort(M+'Checked')
update=z.Function('abstract_checked_update',checked,e.sort(M+'U64'),checked)

def field(name,tag,index):return types[name]['variants'][tag]['fields'][index]['type']
def c(name,tag,*values):return e.sort(name).constructor(tag)(*values)
def w32(n):return z.BitVecVal(n,32)
context,state,instruction=program['functions']['process']['args'];outcome=program['functions']['process']['result']
batch=field(state,1,0);key_type=field(context,0,0);word_type=field(context,0,2)
vector=field(batch,0,3);store=field(vector,0,1);pair=field(store,0,0);item=field(pair,0,0)
effects=field(outcome,0,1);es=field(effects,0,1);ep=field(es,0,0);effect=field(ep,0,0)
detail=field(effect,5,0);binding=field(effect,5,1);recipient=field(detail,0,4);authority=field(detail,0,6)
key=lambda value:c(key_type,0,*[z.Extract(i*32+31,i*32,value) for i in range(8)])
word=lambda value:c(word_type,0,z.Extract(31,0,value),z.Extract(63,32,value))
pack=lambda outer,inner,xs:c(outer,0,c(inner,0,*xs[:2]),c(inner,0,*xs[2:]))
ev=lambda xs:c(effects,0,w32(len(xs)),pack(es,ep,xs+[c(effect,0)]*(4-len(xs))))
reject=lambda code:c(outcome,1,w32(code))
owner,actor,mint,vault=z.BitVecs('owner actor mint vault',256)
recipients=[z.BitVec(f'recipient{i}',256) for i in range(4)]
amounts=[z.BitVec(f'amount{i}',64) for i in range(4)]
length=z.BitVec('length',32);stored=z.BitVec('stored',64);signed=z.Bool('signed');slot=z.BitVec('slot',64)
ctx=c(context,0,key(actor),signed,word(slot))
obligations=c(vector,0,length,pack(store,pair,[c(item,0,key(k),word(a)) for k,a in zip(recipients,amounts)]))

def transfer(funding,index,amount):
    return c(effect,5,c(detail,0,w32(4),w32(5 if funding else 6+index),w32(6 if funding else 5),key(mint),
        c(recipient,1) if funding else c(recipient,2,key(recipients[index])),word(amount),c(authority,0 if funding else 1)),
        c(binding,0) if funding else c(binding,1,key(vault)),
        c(binding,1,key(vault)) if funding else c(binding,0),z.BoolVal(False))

arithmetic_lemmas=[]
def solve(name,bad,assumptions=()):
    solver=z.Then('simplify','propagate-values','solve-eqs','elim-uncnstr','smt').solver()
    solver.set(timeout=15000);solver.add(z.simplify(bad),*assumptions,*arithmetic_lemmas)
    status=solver.check()
    claim={'name':name,'result':str(status)}
    if status==z.sat:
        model=solver.model()
        claim['model']=str(model)
        claim['counterexample']={str(v):str(model.eval(v,model_completion=True)) for v in [owner,actor,mint,vault,length,stored,signed,slot,*recipients,*amounts]}
    reports.append(claim)
    if status!=z.unsat:print(f'{name}: {status}',file=sys.stderr,flush=True)
    if status==z.sat and len(sys.argv)>2 and sys.argv[2]=='counterexample':
        print(json.dumps({'claims':reports}));sys.exit(1)

def carry_lemma(prefix,amount):
    narrow=z.Extract(63,0,prefix)
    carry=z.Extract(64,64,z.ZeroExt(1,narrow)+z.ZeroExt(1,amount))==1
    return z.Implies(z.ULE(prefix,(1<<64)-1),carry==z.UGT(prefix+z.ZeroExt(3,amount),(1<<64)-1))
p,a=z.BitVec('prefix_lemma',67),z.BitVec('amount_lemma',64)
solve('checked-add-wide-prefix-lemma',z.Not(carry_lemma(p,a)))
if reports[-1]['result']!='unsat':
    print(json.dumps({'claims':reports}));sys.exit(1)

# Prove the concrete interpretation used to instantiate the abstract fold.
acc=z.Const('accumulator',checked);amount=z.BitVec('step_amount',64)
word_sort=e.sort(word_type)
previous=checked.accessor(0,0)(acc)
prefix=z.Concat(word_sort.accessor(0,1)(previous),word_sort.accessor(0,0)(previous))
wide=z.ZeroExt(1,prefix)+z.ZeroExt(1,amount)
expected_update=z.If(checked.recognizer(1)(acc),acc,
    z.If(amount==0,checked.constructor(1)(w32(3)),
        z.If(z.Extract(64,64,wide)==1,checked.constructor(1)(w32(4)),
            checked.constructor(0)(word(z.Extract(63,0,wide))))))
e.dead=[]
actual_update=e.call('add_amount',[acc,word(amount)],z.BoolVal(True))
solve('source-checked-update-contract',z.Or(actual_update!=expected_update,*e.dead))
solve('successful-update-preserves-wide-prefix',
    z.Implies(z.Extract(64,64,wide)==0,
        z.ZeroExt(3,prefix+amount)==z.ZeroExt(3,prefix)+z.ZeroExt(3,amount))==False)
if any(r['result']!='unsat' for r in reports):
    print(json.dumps({'claims':reports}));sys.exit(1)

solve('out-of-range-capacity-test',z.And(z.UGT(length,4),z.UGE(w32(4),length)))
if reports[-1]['result']!='unsat':
    print(json.dumps({'claims':reports}));sys.exit(1)

# Structural refinement holds for EVERY function Checked x U64 -> Checked.
# Substituting the verified add_amount definition is therefore sound. This
# separates ordered traversal/effects from carry arithmetic without assuming
# any unproved arithmetic equation about an entire batch.
e.abstract_updates=True

def arithmetic(fuel):
    result=checked.constructor(0)(word(z.BitVecVal(0,64)))
    for amount in amounts[:min(fuel,4)]:result=update(result,word(amount))
    value=checked.accessor(0,0)(result)
    total=z.Concat(word_sort.accessor(0,1)(value),word_sort.accessor(0,0)(value))
    return total,result

assert types['Nat']['kind']=='u32' and types['Nat']['max']==64
for fuel in range(65):
    for logical_length in [0,1,2,3,4,None]:
        e.out_of_range=logical_length is None
        actual_length=length if logical_length is None else w32(logical_length)
        # Every concrete case is in 0..4; the remaining case assumes length>4.
        # Resolve the specification's length guard using that exhaustive split,
        # keeping impossible accepted outcomes out of the solver expression.
        valid_length=z.BoolVal(logical_length is not None and logical_length==fuel)
        obligations=c(vector,0,actual_length,pack(store,pair,[c(item,0,key(k),word(a)) for k,a in zip(recipients,amounts)]))
        total,accumulated=arithmetic(fuel)
        failed=checked.recognizer(1)(accumulated)
        error=checked.accessor(1,0)(accumulated)
        for operation in ['initialize','settle']:
            e.dead=[]
            if operation=='initialize':
                actual=e.call('process',[ctx,c(state,0),c(instruction,0,key(mint),key(vault),obligations,w32(fuel))],z.BoolVal(True))
                accepted=c(outcome,0,c(state,1,c(batch,0,key(actor),key(mint),key(vault),obligations,w32(fuel),word(total))),ev([transfer(True,0,total)]))
                computed=z.If(failed,c(outcome,1,error),z.If(total==0,reject(3),accepted))
                expected=z.If(z.Not(signed),reject(1),z.If(valid_length,computed,reject(3)))
            else:
                actual=e.call('process',[ctx,c(state,1,c(batch,0,key(owner),key(mint),key(vault),obligations,w32(fuel),word(stored))),c(instruction,1)],z.BoolVal(True))
                accepted=c(outcome,0,c(state,2),ev([transfer(False,i,amounts[i]) for i in range(min(fuel,4))]))
                computed=z.If(failed,c(outcome,1,error),z.If(z.And(total!=0,total==stored),accepted,reject(6)))
                expected=z.If(z.Or(z.Not(signed),actor!=owner),reject(1),z.If(valid_length,computed,reject(5)))
            bad=z.Or(actual!=expected,*e.dead)
            solve(f'{operation}-{fuel}-length-{logical_length}',bad,[] if logical_length is not None else [z.UGT(length,4)])

    if fuel%8==0:print(f'Batch fuel {fuel}/64 checked',file=sys.stderr,flush=True)

# The other dispatch branches ignore batch contents and instruction payloads.
e.out_of_range=False
e.dead=[]
funded=c(state,1,z.Const('arbitrary_batch',e.sort(batch)))
initialize=c(instruction,0,z.Const('arbitrary_init_mint',e.sort(key_type)),
    z.Const('arbitrary_init_vault',e.sort(key_type)),z.Const('arbitrary_init_vector',e.sort(vector)),z.BitVec('arbitrary_init_fuel',32))
for label,before,ins in [('empty-settle',c(state,0),c(instruction,1)),('funded-initialize',funded,initialize),
    ('closed-initialize',c(state,2),initialize),('closed-settle',c(state,2),c(instruction,1))]:
    solve(label,e.call('process',[ctx,before,ins],z.BoolVal(True))!=reject(2))
print(json.dumps({'solver':z.get_version_string(),'modelSha256':hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest(),'arithmeticBinding':binding_report,'composition':'universal abstract update instantiated with proved source update; wide-prefix invariant preserved at every successful step','claims':reports}))
sys.exit(0 if all(c['result']=='unsat' for c in reports) else 1)
