import sys,pathlib,json,hashlib,copy
sys.path.insert(0,'verification')
from token_executor import audit,Execution
r=pathlib.Path('build/vault-adapter-bridge');fresh=json.loads((r/'fresh-receipt.json').read_text());root=pathlib.Path(fresh['input']).parent
for name,h in fresh['sourceHashes'].items():
 if hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()!=h:raise RuntimeError('source drift '+name)
files={n:pathlib.Path('runtime',n).read_text() for n in ['token.h','cpi_abi.h','solana_min.h']};positive=audit(files);controls=[]
mutations=[
 ('infos-capacity','token.h','infos[12]','infos[11]'),
 ('loop-inclusive','token.h','i < count; ++i) infos','i <= count; ++i) infos'),
 ('metas-capacity','token.h','metas[4]','metas[3]'),
 ('wrong-opcode','token.h','data[10] = {12}','data[10] = {13}'),
 ('wrong-decimals-offset','token.h','data[44]','data[45]'),
 ('wrong-authority-index','token.h','a[t->authority ? 3 : 1].key,0,1','a[t->authority ? 2 : 1].key,0,1'),
 ('lost-amount','token.h','write_le(data+1,t->amount,8)','write_le(data+1,0,8)'),
 ('oversized-amount-write','token.h','write_le(data+1,t->amount,8)','write_le(data+1,t->amount,9)'),
 ('wrong-signer-count','token.h','&signer,t->authority ? 1 : 0','&signer,0'),
 ('wrong-state-seed','token.h','{a[0].key,32},{&bump,1}','{a[1].key,32},{&bump,1}'),
 ('wrong-abi-field','cpi_abi.h','u64 count;','u32 count;'),
 ('wrong-write-shift','solana_min.h','v >> (8 * i)','v >> (4 * i)'),
]
for name,file,old,new in mutations:
 changed=dict(files);assert old in changed[file],name;changed[file]=changed[file].replace(old,new,1)
 try:audit(changed)
 except Exception as error:
  # Only declared grammar failures count; crashes must fail this script.
  from adapter_contract_c import Grammar
  assert isinstance(error,Grammar),(name,type(error),str(error));controls.append({'name':name,'reason':str(error)})
 else:raise RuntimeError('escaped '+name)
variant=dict(files);variant['token.h']=variant['token.h'].replace('BendAccountMeta metas[4];','/* whitespace variant */ BendAccountMeta  metas [ 4 ] ;');audit(variant)
import token_validate as t
z=t.z3;e=Execution(files);active=z.BitVec('executor_opcode',32);rc=z.BitVec('syscall_result',64)
result,invokes=e.result({('active',):active},rc);claims=[]
for name,formula in [('noninvoking-helper-returns-zero',z.Implies(z.Not(z.Or(active==1,active==3,active==4)),result==0)),('invoking-helper-preserves-full-syscall-result',z.Implies(z.Or(active==1,active==3,active==4),result==rc))]:
 solver=z.Solver();solver.set(timeout=30000);solver.add(z.Not(formula));answer=solver.check();t.need(answer==z.unsat,name+': '+str(answer));claims.append({'name':name,'result':'unsat'})
for slot,value in [({('active',):t.bv(0,8)},rc),({('active',):active},t.bv(0,32))]:
 try:e.result(slot,value)
 except t.Grammar:pass
 else:raise RuntimeError('wrong sort escaped')
for name,h in fresh['sourceHashes'].items():
 if hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()!=h:raise RuntimeError('source drift '+name)
report={'passed':True,'audit':positive,'refusals':controls,'equivalentVariants':1,'summaryClaims':claims,'sortRefusals':2,'receiptSha256':hashlib.sha256((r/'fresh-receipt.json').read_bytes()).hexdigest(),'runtimeHashes':e.runtime_hashes,'checkerHashes':{p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest() for p in ['verification/token_executor.py','tests/token-executor-controls.py']}}
(root/'token-executor-controls.json').write_text(json.dumps(report,indent=2)+'\n');print('12 executor body/dependency refusals, equivalent whitespace, 2 summary claims and 2 sort refusals passed')
