"""Independent vault decision/plan specifications over interpreted actual C.
No Source.call is used to state expected behavior. Typed facts, C interpreter,
schema bridge and Z3 remain assumptions; effects are values, not executed.
"""
import sys,json,pathlib,hashlib,copy,time
import z3 as z
sys.path.insert(0,'verification')
from acyclic_c import Source,C,wire,need,mangle
from tagged_sum_c import check_artifacts
from tagged_sum_layout import check_layouts

def properties(program):
 source=Source(program['source']);check_artifacts([program['artifact']]);check_layouts([program['artifact']])
 c=C(source,program['artifact']);types=source.types
 def type_name(short):
  matches=[name for name in types if name==short or name.endswith('.'+short)]
  need(len(matches)==1,'ambiguous schema type: '+short)
  return matches[0]
 def variant(type_,name):
  t=type_name(type_);matches=[i for i,v in enumerate(types[t]['variants']) if v['name']==name or v['name'].endswith('.'+name)]
  need(len(matches)==1,'ambiguous schema variant: '+name);return t,matches[0]
 def is_(type_,name,value):
  t,i=variant(type_,name);return source.sort(t).recognizer(i)(value)
 def field(type_,name,value,key):
  t,i=variant(type_,name);fields=types[t]['variants'][i]['fields'];j=next(i for i,f in enumerate(fields) if f['name']==key)
  return source.sort(t).accessor(i,j)(value)
 def u64(value):return z.Concat(field('U64','U64',value,'hi'),field('U64','U64',value,'lo'))
 root_name=program['source']['roots'][0];signature=program['source']['functions'][root_name];args=[z.Const('arg'+str(i),source.sort(t)) for i,t in enumerate(signature['args'])]
 context,state,instruction=args;actual=c.call(mangle(root_name),args,z.BoolVal(True))
 actor=field('Context','Context',context,'actor');signed=field('Context','Context',context,'signed')
 empty=is_('State','Empty',state);live=is_('State','Live',state)
 owner=field('State','Live',state,'owner');mint=field('State','Live',state,'mint');balance=u64(field('State','Live',state,'balance'))
 init=is_('Instruction','Initialize',instruction);deposit=is_('Instruction','Deposit',instruction);withdraw=is_('Instruction','Withdraw',instruction)
 deposit_amount=u64(field('Instruction','Deposit',instruction,'amount'));withdraw_amount=u64(field('Instruction','Withdraw',instruction,'amount'))
 total=z.ZeroExt(1,balance)+z.ZeroExt(1,deposit_amount);fits=z.ULE(total,z.BitVecVal(2**64-1,65))
 valid_init=z.And(signed,empty,init)
 valid_deposit=z.And(signed,live,actor==owner,deposit,fits)
 valid_withdraw=z.And(signed,live,actor==owner,withdraw,z.ULE(withdraw_amount,balance))
 allowed=z.Or(valid_init,valid_deposit,valid_withdraw);accepted=is_('Outcome','Accepted',actual)
 new_state=field('Outcome','Accepted',actual,'state');new_owner=field('State','Live',new_state,'owner');new_mint=field('State','Live',new_state,'mint');new_balance=u64(field('State','Live',new_state,'balance'))
 effects=field('Outcome','Accepted',actual,'effects');first=field('Effects','Effects',effects,'first');second=field('Effects','Effects',effects,'second')
 def transfer(direction,authority,amount):
  return z.And(is_('Effect','Transfer',first),field('Effect','Transfer',first,'source')==4,
   field('Effect','Transfer',first,'destination')==5,field('Effect','Transfer',first,'mint')==6,
   field('Effect','Transfer',first,'mint_key')==mint,is_('Recipient',direction,field('Effect','Transfer',first,'recipient')),
   is_('Authority',authority,field('Effect','Transfer',first,'authority')),u64(field('Effect','Transfer',first,'amount'))==amount)
 formulas={
  'exact-success-domain':accepted==allowed,
  'unsigned-never-accepted':z.Implies(z.Not(signed),z.Not(accepted)),
  'wrong-owner-never-accepted':z.Implies(z.And(live,actor!=owner),z.Not(accepted)),
  'accepted-state-live':z.Implies(accepted,is_('State','Live',new_state)),
  'owner-binding':z.Implies(accepted,new_owner==z.If(empty,actor,owner)),
  'mint-binding':z.Implies(accepted,new_mint==z.If(empty,field('Instruction','Initialize',instruction,'mint'),mint)),
  'initial-balance-zero':z.Implies(valid_init,z.And(accepted,new_balance==0)),
  'deposit-exact-without-overflow':z.Implies(valid_deposit,z.And(accepted,z.ZeroExt(1,new_balance)==total)),
  'withdraw-exact-without-underflow':z.Implies(valid_withdraw,z.And(accepted,new_balance==balance-withdraw_amount)),
  'one-effect-only':z.Implies(accepted,is_('Effect','None',second)),
  'initialize-mint-check':z.Implies(valid_init,z.And(accepted,is_('Effect','CheckMint',first),field('Effect','CheckMint',first,'mint')==4,field('Effect','CheckMint',first,'mint_key')==field('Instruction','Initialize',instruction,'mint'))),
  'deposit-plan-roles-authority-amount':z.Implies(valid_deposit,z.And(accepted,transfer('ToCustody','Actor',deposit_amount))),
  'withdraw-plan-roles-authority-amount':z.Implies(valid_withdraw,z.And(accepted,transfer('ToActor','Custody',withdraw_amount))),
  'modeled-C-safety':z.Not(z.Or(*c.bad)),
 }
 domains={'initialize':valid_init,'positive-deposit':z.And(valid_deposit,deposit_amount!=0),'positive-withdraw':z.And(valid_withdraw,withdraw_amount!=0)}
 return source,args,actual,formulas,domains

def query(source,args,formula):
 solver=z.Solver();solver.set(timeout=10000);solver.add(formula);result=solver.check();need(result!=z.unknown,'UNKNOWN is not proof: '+solver.reason_unknown())
 row={'result':str(result)}
 if result==z.sat:
  signature=source.program['functions'][source.program['roots'][0]];model=solver.model()
  row['wireArgs']=[wire(source,t,model.eval(a,model_completion=True)) for a,t in zip(args,signature['args'])]
 return row
