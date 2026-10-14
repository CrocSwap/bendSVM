"""Fresh child for the acyclic whole-function translation checker."""
import sys,json,pathlib,hashlib,copy
import z3 as z
from acyclic_c import check,need

def digest(data):return hashlib.sha256(data).hexdigest()
def snapshot(names):return {name:digest(pathlib.Path(name).read_bytes()) for name in names}
FIXTURES=[('tests/lowering.bend',['swap','select','update','normalize','identity']),
          ('tests/generics.bend',['choose_word','choose_flag','nested','unwrap','present','absent']),
          ('examples/vault/vault.bend',['authorize','deposited','withdrawn']),
          ('examples/vesting/vesting.bend',['authorize','initialize','transfer','payout','funded_total','delta','difference','bounded','claim_result','initialize_instruction','empty'])]
MUTATIONS=[
 (1,'assigned wrong return argument','return bend_Present_3c_U32_3e__make(a0);','a0 = 0u; return bend_Present_3c_U32_3e__make(a0);','present'),
 (1,'unused correct call hides wrong return','return bend_Present_3c_U32_3e__make(a0);','(void)bend_Present_3c_U32_3e__make(a0); return bend_Present_3c_U32_3e__make(0u);','present'),
 (0,'wrong arithmetic operation','(a0 + a1)','(a0 - a1)','update'),
 (0,'wrong field returned','return (a1).as.c0.f0;','return (a1).as.c0.f1;','select'),
 (2,'vault authorization bypass','return bend_Rejected_make(1u);','return a1;','authorize'),
 (2,'vault wrong transfer role','_Transfer_make(4u, 5u, 6u, a1,','_Transfer_make(4u, 4u, 6u, a1,','deposited'),
 (3,'vesting wrong beneficiary','_ToOwner_make((a0).as.c0.f0)','_ToOwner_make((a0).as.c0.f1)','transfer'),
 (3, 'vesting subtraction changed to addition', '(a0 - a1)', '(a0 + a1)', 'difference'),
 (3, 'vesting old claimed amount retained', '(a0).as.c0.f4, a1), bend_', '(a0).as.c0.f4, (a0).as.c0.f5), bend_', 'difference'),
 (3, 'vesting initialization signer bypass', 'return bend_authorize(a0, bend_initialize', 'return bend_authorize(1u, bend_initialize', 'initialize_instruction'),

]

def main(input_path,output):
 need(not output.exists(),'output already exists')
 raw=input_path.read_bytes();data=json.loads(raw)
 need(data['version']==1 and isinstance(data['runId'],str) and len(data['runId'])==36,'invalid input header')
 need(z.get_version_string()=='5.1.0','wrong solver version')
 before=data['sourceHashes'];need(before and snapshot(before)==before,'source binding changed')
 need([(f['file'],f['roots']) for f in data['fixtures']]==FIXTURES,'fixture inventory')
 need(len(data['programs'])==len(FIXTURES),'program inventory')
 syntax=data.get('cSyntax');need(isinstance(syntax,dict) and isinstance(syntax.get('compiler'),str) and syntax['compiler'] and isinstance(syntax.get('version'),str) and syntax['version'].strip(),'missing C frontend evidence')
 need(syntax.get('units')==[{'fixture':p['artifact']['fixture'],'cSha256':p['artifact']['cSha256'],'exitCode':0} for p in data['programs']],'C frontend artifact inventory')
 rows=[]
 for p,(file,roots) in zip(data['programs'],FIXTURES):
  need(p['defaultProductionCMatches'] is True,'default production C mismatch')
  need(p['source']['source']==file and p['source']['roots']==roots,'source root inventory')
  need(p['artifact']['fixture']==file,'artifact fixture')
  need(set(p['sourceHashes'])==set(p['source']['files']),'checked-source file inventory')
  for name,h in p['sourceHashes'].items():
   relative=str(pathlib.Path(name).resolve().relative_to(pathlib.Path.cwd()))
   need(before.get(relative)==h and digest(pathlib.Path(name).read_bytes())==h,'checked source outside binding')
  claims=check(p)
  need([r['function'] for r in claims]==roots and all(r['result']=='unsat' for r in claims),'whole-function equivalence failed')
  rows.append({'fixture':file,'cSha256':p['artifact']['cSha256'],'claims':claims})
 mutations=[]
 for index,name,target,replacement,function in MUTATIONS:
  p=copy.deepcopy(data['programs'][index]);a=p['artifact'];need(target in a['c'],'missing mutation target')
  a['c']=a['c'].replace(target,replacement,1);a['cSha256']=digest(a['c'].encode())
  claim=next(r for r in check(p) if r['function']==function)
  need(claim['result']=='sat','semantic mutation did not produce counterexample')
  mutations.append({'name':name,'cSha256':a['cSha256'],'claim':claim})
 need(input_path.read_bytes()==raw,'input changed')
 need(snapshot(before)==before,'source changed during proof')
 report={'version':1,'runId':data['runId'],'passed':True,'z3':z.get_version_string(),
  'inputSha256':digest(raw),'sourceHashes':before,'cSyntax':syntax,'results':rows,'mutations':mutations,
  'scope':'Conditional whole-function equivalence for the exported acyclic typed subset; source exporter, C interpreter, driver and Z3 trusted. No memory ABI, Clang or SBF preservation theorem.'}
 with output.open('x') as handle:handle.write(json.dumps(report,indent=2)+'\n')
 print('25 whole-function queries UNSAT; 10 semantic mutations SAT')

if __name__=='__main__':main(pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]))
