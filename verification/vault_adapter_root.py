import os
import sys,pathlib,json,hashlib
import z3 as z
from vault_adapter_inventory import need,validate_input
sys.path.insert(0,'verification')
from acyclic_c import check as check_root
from vault_c import properties,query
from adapter_contract import work,ASSUMPTIONS,NOT_CLAIMED
root=pathlib.Path(os.environ.get('BRIDGE_DIR','build/vault-adapter-bridge'));raw=(root/'input.json').read_bytes();data=json.loads(raw);validate_input(data);need(z.get_version_string()=='5.1.0','solver pin')
for name,h in {**data['sourceHashes'],**data['artifactHashes']}.items():need(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==h,name)
program=data['program'];fixture=data['fixture'];need(program['artifact']['c']==fixture['files']['vault.h'],'native header')
need(program['artifact']['schema']==fixture['schema']==program['source']['schema'],'schema')
need(program['source']['roots']==[fixture['root']]==[fixture['interface']['root']],'root')
equivalence=check_root(program);need(len(equivalence)==1 and equivalence[0]['result']=='unsat','equivalence')
source,args,result,formulas,domains=properties(program)
claims=[{'name':name,**query(source,args,z.Not(formula))} for name,formula in formulas.items()];need(all(r['result']=='unsat' for r in claims),'invariants')
adapter=work(('fixture',None,fixture))
for name,h in {**data['sourceHashes'],**data['artifactHashes']}.items():need(hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()==h,name)
report={'passed':True,'endToEndVerified':False,'inputSha256':hashlib.sha256(raw).hexdigest(),'sourceHashes':data['sourceHashes'],'artifactHashes':data['artifactHashes'],
 'rootEquivalence':equivalence,'rootInvariants':claims,'adapter':adapter,'adapterAssumptions':ASSUMPTIONS,'adapterNotClaimed':NOT_CLAIMED,
 'scope':'Exact shared-artifact co-validation: PROOF-root decision code and generic ABI1 adapter contract. Root proof covers typed values/purity under the C model. Codec validity, helper semantics/noninterference, loader, C memory/layout, rollback and toolchain assumptions remain; no unconditional composed SBF theorem.'}
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'root':fixture['root'],'rootClaims':len(claims),'adapterClaims':len(adapter['claims']),'adapterObligations':adapter['obligations'],'scope':report['scope']},indent=2))
