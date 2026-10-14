"""Conditional token byte-frame checks over the parsed validator.

Only supply, balance and delegate bookkeeping spans may change. Metadata, other bytes, valid native
objects and runtime enforcement of the frame remain explicit assumptions.
"""
import json,pathlib
import token_validate as t
z=t.z3
INPUTS=['runtime/token.h','runtime/cpi_abi.h','runtime/solana_min.h',
        'verification/token_frame.py','verification/token_validate.py',
        'verification/adapter_contract_c.py','verification/check-token-frame.ts']
OUTPUT=pathlib.Path('build/token-frame-refinement.json')
FRAME_SPEC={'accounts':[4,12],'mint':{'size':82,'spans':[[36,44]]},'token':{'size':165,'spans':[[64,108],[121,129]]},'endExclusive':True}

def data_frame(data,sizes,prefix):
 """Arbitrary token writes under a caller-assumed, size-qualified byte frame.

 Metadata and all other bytes remain fixed. This does not establish that an
 external program enforces the frame or that native pointers are disjoint.
 """
 word=z.BitVecSort(32);byte=z.BitVecSort(8)
 t.need(data.sort()==z.ArraySort(word,z.ArraySort(word,byte)),'frame data sort')
 t.need(sizes.sort()==z.ArraySort(word,z.BitVecSort(64)),'frame sizes sort')
 t.need(type(prefix) is str and bool(prefix),'frame symbol prefix')
 index=z.BitVec(prefix+'_index',32);offset=z.BitVec(prefix+'_offset',32)
 replacement=z.Const(prefix+'_replacement',data.sort());size=z.Select(sizes,index)
 write=z.And(z.UGE(index,t.bv(4)),z.ULT(index,t.bv(12)),z.Or(z.And(size==t.bv(82,64),z.UGE(offset,t.bv(36)),z.ULT(offset,t.bv(44))),z.And(size==t.bv(165,64),z.Or(z.And(z.UGE(offset,t.bv(64)),z.ULT(offset,t.bv(108))),z.And(z.UGE(offset,t.bv(121)),z.ULT(offset,t.bv(129)))))))
 return z.Lambda(index,z.Lambda(offset,z.If(write,z.Select(z.Select(replacement,index),offset),z.Select(z.Select(data,index),offset))))

def check(files):
 model,interpreter,actual,claims=t.evaluate(files);m=model;f=m.fields
 changed=data_frame(m.account_data,m.account_size,'frame')
 replace=lambda v:z.simplify(z.substitute(v,(m.account_data,changed)))
 policy=z.And(z.Implies(f['active']==3,f['initialize']==0),z.Implies(f['active']==1,f['fresh_destination']==0))
 validator_claims=[]
 for name,value in claims.items():
  t.solve(m,z.Not(value),'unsat');validator_claims.append({'name':name,'result':'unsat'})
 results=[]
 for i,(guard,value) in enumerate(interpreter.returns):
  t.solve(m,z.And(policy,guard!=replace(guard)),'unsat')
  t.solve(m,z.And(policy,guard,value!=replace(value)),'unsat')
  results.append({'returnPath':i,'guard':'unsat','value':'unsat'})
 # Concrete one-byte changes correspond to nonzero post-operation supply/balance.
 witnesses=[]
 for label,opcode,flag,index,offset,code in [('mint-initialize',3,'initialize',6,36,24),('fresh-transfer',1,'fresh_destination',5,64,26)]:
  data=z.Store(m.account_data,t.bv(index),z.Store(z.Select(m.account_data,t.bv(index)),t.bv(offset),t.bv(1,8)))
  after=z.substitute(actual,(m.account_data,data))
  predicate=z.And(m.count==7,f['active']==opcode,f[flag]==1,f['source']==4,f['destination']==5,f['mint']==6,f['authority']==(1 if opcode==3 else 0),actual==0,after==code,z.Distinct(*[m.key(t.bv(i)) for i in range(7)]),*[z.ULE(m.size(t.bv(i)),t.bv(165,64)) for i in range(7)])
  def project(sm):
   num=lambda x:sm.eval(x,model_completion=True).as_long()
   return {'keys':{name:str(num(v)) for name,v in m.native_keys.items()},'accounts':[{'key':str(num(m.key(t.bv(i)))),'owner':str(num(m.owner(t.bv(i)))),'size':num(m.size(t.bv(i))),'signer':num(z.Select(m.account_signer,t.bv(i))),'writable':num(z.Select(m.account_writable,t.bv(i))),'executable':num(z.Select(m.account_executable,t.bv(i))),'data':[num(m.data_byte(t.bv(i),t.bv(j))) for j in range(165)]} for i in range(7)]}
  witness=t.solve(m,predicate,'sat',project);witness.pop('smtModel');witness['amount']=str(witness['amount'])
  witnesses.append({'name':label,'result':'sat','before':0,'after':code,'account':index,'offset':offset,'byte':1,'witness':witness})
 frame_claims=[]
 account=z.BitVec('frame_any_account',32);byte=z.BitVec('frame_any_offset',32)
 for name,formula in [('managed-state-data-preserved',m.data_byte(t.bv(0),byte)!=z.Select(z.Select(changed,t.bv(0)),byte)),('executor-decimals-read-preserved',m.data_byte(account,t.bv(44))!=z.Select(z.Select(changed,account),t.bv(44)))]:
  t.solve(m,formula,'unsat');frame_claims.append({'name':name,'result':'unsat'})
 for name,index,offset in [('state-write-detected',0,0),('decimals-write-detected',6,44)]:
  fault=z.Store(changed,t.bv(index),z.Store(z.Select(changed,t.bv(index)),t.bv(offset),t.bv(255,8)))
  formula=m.data_byte(t.bv(index),t.bv(offset))!=z.Select(z.Select(fault,t.bv(index)),t.bv(offset))
  t.solve(m,formula,'sat');frame_claims.append({'name':name,'result':'sat'})
 return {'frameSpec':FRAME_SPEC,'validatorClaims':validator_claims,'stablePaths':results,'mutablePredicates':witnesses,'frameClaims':frame_claims}

def main():
 OUTPUT.parent.mkdir(parents=True,exist_ok=True)
 OUTPUT.unlink(missing_ok=True)
 pending=OUTPUT.with_suffix('.json.pending');pending.unlink(missing_ok=True)
 t.need(z.get_version_string()=='5.1.0','Z3 pin')
 before={name:t.sha(pathlib.Path(name).read_bytes()) for name in INPUTS}
 files={pathlib.Path(name).name:pathlib.Path(name).read_text() for name in INPUTS[:3]}
 result=check(files)
 after={name:t.sha(pathlib.Path(name).read_bytes()) for name in INPUTS}
 t.need(before==after,'token frame source drift')
 report={'passed':True,'endToEndVerified':False,'z3':z.get_version_string(),'inputs':before,**result,
  'scope':'Conditional parsed-validator and data-frame checks for arbitrary size-qualified token supply/balance/delegate writes. Relevant zero-supply/freshness flags must be disabled for return invariance. Two SAT snapshots show enabled pre-batch predicates can change. Metadata, other bytes, native object validity/disjointness and actual runtime frame enforcement remain trusted. No SPL conservation or SBF theorem.'}
 pending.write_text(json.dumps(report,indent=2)+'\n');pending.replace(OUTPUT)
 print('Token frame: 31 invariant return paths, 2 mutable-predicate witnesses and 4 frame checks passed')
if __name__=='__main__':main()
