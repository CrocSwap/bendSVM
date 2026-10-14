"""Exact inputs, prerequisites and complete closure inventory for native handlers."""
import hashlib,json,math,pathlib,sys
from native_mul32 import certify,refs,need,CLAIMS,PROOF_INPUTS
from native_divmod import certify as certify_divmod,PROOF_INPUTS as DIVISION_INPUTS,ROOTS as DIVISION_ROOTS
SCOPE='Typed pure handler source/C equivalence with freshly checked multiplication and division prerequisites and exact native template binding. Exporter, interpreters, schemas, driver, Z3 and standard C semantics remain trusted. No adapter, CPI, Clang or SBF theorem.'
FIXTURES=['examples/vesting/PROOF.bend','examples/exchange/PROOF.bend','examples/amm/PROOF.bend']
ROOTS=['vesting.process','exchange.process','amm.process']
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def snapshot(names):return {n:sha(pathlib.Path(n).read_bytes()) for n in names}
def finite(value):return type(value) in (int,float) and math.isfinite(value) and value>=0
def closure(source,native):
 native={native} if isinstance(native,str) else set(native)
 f=source['functions'];done=set();active=set();order=[];dependencies={}
 def visit(name):
  need(name in f and name not in active,'unknown/cyclic dependency')
  if name in done:return
  active.add(name);dependencies[name]=[] if name in native else sorted(set(refs(f[name].get('body'))))
  for child in dependencies[name]:visit(child)
  active.remove(name);done.add(name);order.append(name)
 for root in source['roots']:visit(root)
 return order,dependencies,sorted(set(f)-done)
def validate(report,data,raw):
 need(set(report)=={'passed','endToEndVerified','version','z3','runId','inputSha256','sourceHashes','cSyntax','prerequisite','divisionPrerequisite','results','scope'},'report fields')
 need(report['passed'] is True and report['endToEndVerified'] is False,'success/scope flags')
 need(type(report['version']) is int and report['version']==2 and report['z3']=='5.1.0','version')
 need(report['scope']==SCOPE,'scope')
 need(report['runId']==data['runId'] and report['inputSha256']==sha(raw),'run/input binding')
 need(report['sourceHashes']==data['sourceHashes'],'source binding')
 folder=pathlib.Path(__file__).resolve().parent
 required={str((folder/n).relative_to(pathlib.Path.cwd())) for n in ['native_handler_report.py','native_handler_child.py','native_mul32.py','modular_c.py','acyclic_c.py']}
 need(required|PROOF_INPUTS|DIVISION_INPUTS<=set(data['sourceHashes']),'checker source inventory')
 need(report['cSyntax']==data['cSyntax'],'frontend binding')
 need(isinstance(data['cSyntax']['compiler'],str) and data['cSyntax']['compiler'],'frontend compiler')
 need(isinstance(data['cSyntax']['version'],str) and data['cSyntax']['version'].strip(),'frontend version')
 need(set(data['sourceModels'])=={'math','wide','division'},'arithmetic model inventory')
 expected_roots={'math':['mul32_parts','mul32','mul_parts','mul'],'wide':['add','product_parts','product']}
 for name in ['math','wide']:
  model=json.loads(data['sourceModels'][name]);need(model['source']=='sdk/'+name+'.bend' and model['roots']==expected_roots[name],'arithmetic model identity')
 division_model=json.loads(data['sourceModels']['division']);need(division_model['source']=='sdk/math.bend' and division_model['roots']==DIVISION_ROOTS,'division model identity')
 division_proof=report['divisionPrerequisite'];need(division_proof['hashes']=={n:data['sourceHashes'][n] for n in DIVISION_INPUTS},'division prerequisite source binding')
 proof=report['prerequisite'];need(set(proof)=={'bendCommit','positive','hashes'},'prerequisite fields')
 need(proof['bendCommit']==data['bendCommit']=='7561656155a4285c1e4ccfcb3505ab59524de973','Bend pin')
 need(proof['hashes']=={n:data['sourceHashes'][n] for n in PROOF_INPUTS},'prerequisite source binding')
 positive=proof['positive'];need(set(positive)=={'solver','models','claims'},'arithmetic report fields')
 need(positive['solver']=='5.1.0','arithmetic solver')
 need(positive['models']=={n:sha(data['sourceModels'][n].encode()) for n in ['math','wide']},'arithmetic model binding')
 need([(c['claim'],c['result']) for c in positive['claims']]==[(n,'unsat') for n in CLAIMS],'arithmetic claim inventory')
 for c in positive['claims']:need(set(c)=={'claim','result','seconds'} and finite(c['seconds']),'arithmetic claim fields')
 need([p['source']['source'] for p in data['programs']]==FIXTURES,'program inventory')
 need([r['fixture'] for r in report['results']]==FIXTURES,'result inventory')
 need(data['cSyntax']['units']==[{'fixture':p['artifact']['fixture'],'cSha256':sha(p['artifact']['c'].encode()),'exitCode':0} for p in data['programs']],'frontend inventory')
 for file,root,p,r in zip(FIXTURES,ROOTS,data['programs'],report['results']):
  need(p['source']['roots']==[root] and p['artifact']['fixture']==file,'program identity')
  need(p['source']['schema']==p['artifact']['schema'],'schema binding')
  need(set(r)=={'fixture','cSha256','proof'} and r['cSha256']==p['artifact']['cSha256']==sha(p['artifact']['c'].encode()),'C result binding')
  certificates=[certify(p,proof,data['sourceModels']['math'].encode()),certify_divmod(p,division_proof,data['sourceModels']['division'].encode())]
  native={c['sourceFunction']:c for c in certificates};need(len(native)==2,'native certificate inventory')
  order,deps,elided=closure(p['source'],native)
  allowed=set().union(*(set(c['sourceClosure'])-{name} for name,c in native.items()))
  need(set(elided)<=allowed,'unaccounted source functions')
  result=r['proof'];need(set(result)=={'passed','claims','roots','elidedSourceFunctions'},'proof fields')
  need(result['passed'] is True and result['roots']==[root],'root result')
  need(result['elidedSourceFunctions']==elided,'elision inventory')
  need([c['function'] for c in result['claims']]==order,'function inventory/order')
  seen=set()
  for c in result['claims']:
   name=c['function']
   if name in native:
    need(set(c)=={'function','result','certificate'} and c['result']=='certified-native','native result')
    need(c['certificate']==native[name],'native certificate')
   else:
    need(set(c)=={'function','result','dependencies','CGuardObligations','sourceDeadPaths','seconds'},'claim fields')
    need(c['result']=='unsat','unproved claim')
    need(c['dependencies']==deps[name] and set(deps[name])<=seen,'dependency inventory')
    for key in ['CGuardObligations','sourceDeadPaths']:need(type(c[key]) is int and c[key]>=0,'obligation count')
    need(finite(c['seconds']),'timing')
   seen.add(name)
if __name__=='__main__':
 if not __debug__:raise RuntimeError('native handler report validation requires Python assertions')
 raw=pathlib.Path(sys.argv[1]).read_bytes();data=json.loads(raw)
 validate(json.loads(pathlib.Path(sys.argv[2]).read_text()),data,raw)
 need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift')
 print('Native handler prerequisite, closure and artifact bindings passed')
