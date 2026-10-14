"""Fresh full-vault C equivalence and independent decision/plan laws."""
import sys,pathlib,json,hashlib,copy
import z3 as z
from acyclic_c import check,need
from vault_c import properties,query
SOURCE='examples/vault/vault.bend'
MUTATIONS=[
 ('authorization bypass','return bend_Rejected_make(1u);','return a1;','unsigned-never-accepted'),
 ('wrong transfer role','_Transfer_make(4u, 5u, 6u, a1,','_Transfer_make(4u, 4u, 6u, a1,','deposit-plan-roles-authority-amount'),
 ('wrong arithmetic operation','(a0 + a1)','(a0 - a1)','deposit-exact-without-overflow'),
]
SCOPE='Typed vault decision and effect-plan values only; source exporter, C interpreter, schema bridge, driver and Z3 trusted. No account adapter, effect execution, rollback, Clang/LLVM or SBF theorem.'
def digest(data):return hashlib.sha256(data).hexdigest()
def snapshot(names):return {name:digest(pathlib.Path(name).read_bytes()) for name in names}
def main(input_path,output):
 need(not output.exists(),'output already exists');raw=input_path.read_bytes();data=json.loads(raw)
 need(data['version']==1 and isinstance(data['runId'],str) and len(data['runId'])==36,'input header')
 need(z.get_version_string()=='5.1.0','wrong solver');before=data['sourceHashes']
 need(before and snapshot(before)==before,'source binding changed')
 p=data['program'];need(p['source']['source']==SOURCE and p['source']['roots']==['process'],'source root inventory')
 need(p['artifact']['fixture']==SOURCE and data['defaultProductionCMatches'] is True,'production artifact mismatch')
 need(set(data['checkedFiles'])==set(p['source']['files']),'checked-file inventory')
 for file in data['checkedFiles']:
  relative=str(pathlib.Path(file).resolve().relative_to(pathlib.Path.cwd()));need(relative in before,'unchecked source outside inventory')
 syntax=data.get('cSyntax');need(isinstance(syntax,dict) and isinstance(syntax.get('compiler'),str) and syntax['compiler'] and isinstance(syntax.get('version'),str) and syntax['version'].strip(),'C syntax evidence')
 need(syntax['units']==[{'fixture':SOURCE,'cSha256':p['artifact']['cSha256'],'exitCode':0}],'C syntax inventory')
 equivalence=check(p);need(len(equivalence)==1 and equivalence[0]['function']=='process' and equivalence[0]['result']=='unsat','process equivalence failed')
 source,args,actual,formulas,domains=properties(p)
 claims=[{'name':name,**query(source,args,z.Not(formula))} for name,formula in formulas.items()];need(all(r['result']=='unsat' for r in claims),'C invariant failed')
 reachability=[{'name':name,**query(source,args,domain)} for name,domain in domains.items()];need(all(r['result']=='sat' for r in reachability),'vacuous success domain')
 mutations=[]
 for name,target,replacement,property_ in MUTATIONS:
  mutant=copy.deepcopy(p);a=mutant['artifact'];need(target in a['c'],'missing mutation target');a['c']=a['c'].replace(target,replacement,1);a['cSha256']=digest(a['c'].encode())
  model,arguments,result,props,domain=properties(mutant);fault=z.Not(props[property_])
  if property_.startswith('deposit'):fault=z.And(fault,domain['positive-deposit'])
  witness=query(model,arguments,fault);need(witness['result']=='sat','mutation did not fail invariant')
  mutations.append({'name':name,'property':property_,'cSha256':a['cSha256'],**witness})
 need(input_path.read_bytes()==raw and snapshot(before)==before,'source/input changed during proof')
 report={'version':1,'runId':data['runId'],'passed':True,'z3':z.get_version_string(),'inputSha256':digest(raw),'sourceHashes':before,'cSyntax':syntax,'cSha256':p['artifact']['cSha256'],'equivalence':equivalence,'claims':claims,'reachability':reachability,'mutations':mutations,'scope':SCOPE}
 with output.open('x') as handle:handle.write(json.dumps(report,indent=2)+'\n')
 print('Full vault C: process equivalence, 14 invariants, 3 success witnesses and 3 semantic faults passed')
if __name__=='__main__':main(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
