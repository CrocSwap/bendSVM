"""Exact fixture, closure, dependency and mutation inventory for modular checks."""
import hashlib,math,pathlib
from modular_c import refs,need
FIXTURES=[('sdk/sqrt.bend',['floor','geometric_mean']),('tests/lowering.bend',['swap','select','update','normalize','identity']),('tests/generics.bend',['choose_word','choose_flag','nested','unwrap','present','absent']),('examples/vault/vault.bend',['authorize','deposited','withdrawn']),('examples/vesting/vesting.bend',['authorize','initialize','transfer','payout','funded_total','delta','difference','bounded','claim_result','initialize_instruction','empty'])]
RECIPES=[
 (0,'wrong-add','(a0 + a1)','(a0 - a1)','U32.add'),
 (0,'unguarded-divide','a1 == 0u ? 0u : a0 / a1','a0 / a1','U32.div'),
 (0,'missing-step-half','return bend_step16(bend_step16(a0));','return bend_step16(a0);','step32'),
 (0,'wrong-width-step','bend_finish(bend_step32(bend_Search_make','bend_finish(bend_step16(bend_Search_make','floor_low_width'),
 (3,'vault-authorization','return bend_Rejected_make(1u);','return a1;','authorize'),
 (4,'vesting-beneficiary','_ToOwner_make((a0).as.c0.f0)','_ToOwner_make((a0).as.c0.f1)','transfer'),
]
SCOPE='Conditional modular source/C equivalence for valid typed values; exporter, interpreters, schema, driver and Z3 trusted. Summary SAT models need not be concrete execution witnesses. No memory ABI, Clang or SBF theorem.'
def sha(raw):return hashlib.sha256(raw).hexdigest()
def snapshot(names):return {n:sha(pathlib.Path(n).read_bytes()) for n in names}
def order(source):
 functions=source['functions'];done=set();active=set();result=[]
 def visit(name):
  need(name in functions and name not in active,'unknown/recursive dependency')
  if name in done:return
  active.add(name)
  for child in sorted(set(refs(functions[name].get('body')))):visit(child)
  active.remove(name);done.add(name);result.append(name)
 for name in source['roots']:visit(name)
 need(done==set(functions),'unreachable inventory');return result

def claims(rows,p,fault=None):
 expected=order(p['source']);need(isinstance(rows,list) and bool(rows),'empty claims')
 if fault:expected=expected[:expected.index(fault)+1]
 need([r['function'] for r in rows]==expected,'function inventory/order')
 seen=set()
 for row in rows:
  name=row['function'];sat=name==fault
  keys={'function','result','dependencies','CGuardObligations','sourceDeadPaths','seconds'}|({'wireArgs'} if sat else set())
  need(set(row)==keys,'claim fields');need(row['result']==('sat' if sat else 'unsat'),'unproved claim')
  deps=sorted(set(refs(p['source']['functions'][name].get('body'))))
  need(row['dependencies']==deps and set(deps)<=seen,'dependency inventory');seen.add(name)
  for key in ['CGuardObligations','sourceDeadPaths']:need(type(row[key]) is int and row[key]>=0,'obligation count')
  need(type(row['seconds']) in (int,float) and math.isfinite(row['seconds']) and row['seconds']>=0,'timing')
  if sat:need(isinstance(row['wireArgs'],list) and len(row['wireArgs'])==len(p['source']['functions'][name]['args']),'witness arity')

def validate(report,data,raw):
 need(set(report)=={'passed','endToEndVerified','version','z3','runId','inputSha256','sourceHashes','cSyntax','scope','results','mutations'},'report fields')
 need(report.get('passed') is True and report.get('endToEndVerified') is False,'success/scope flag')
 need(report.get('version')==1 and report.get('z3')=='5.1.0','version')
 need(report.get('runId')==data['runId'] and report.get('inputSha256')==sha(raw),'run/input binding')
 need(report.get('sourceHashes')==data['sourceHashes'],'source binding')
 need(report.get('scope')==SCOPE,'scope')
 need(data['fixtures']==[{'file':f,'roots':roots} for f,roots in FIXTURES],'fixture inventory')
 need(len(data['programs'])==len(FIXTURES) and len(report['results'])==len(FIXTURES),'program inventory')
 need(report.get('cSyntax')==data['cSyntax'],'frontend binding')
 need(isinstance(data['cSyntax']['version'],str) and data['cSyntax']['version'].strip(),'frontend version')
 need(data['cSyntax']['units']==[{'fixture':p['artifact']['fixture'],'cSha256':sha(p['artifact']['c'].encode()),'exitCode':0} for p in data['programs']],'frontend inventory')
 for (file,roots),p,r in zip(FIXTURES,data['programs'],report['results']):
  need(p['source']['source']==file and p['source']['roots']==roots and p['artifact']['fixture']==file,'fixture identity')
  need(p['defaultProductionCMatches'] is True,'nondefault C');need(p['artifact']['cSha256']==sha(p['artifact']['c'].encode()),'C hash')
  need(r['fixture']==file and r['cSha256']==p['artifact']['cSha256'],'result identity')
  need(set(r)=={'fixture','cSha256','proof'} and set(r['proof'])=={'passed','roots','claims'},'result fields')
  need(r['proof']['passed'] is True and r['proof']['roots']==roots,'root result')
  claims(r['proof']['claims'],p)
 need([m['name'] for m in report['mutations']]==[r[1] for r in RECIPES],'mutation inventory')
 for m,(i,name,old,new,target) in zip(report['mutations'],RECIPES):
  p=data['programs'][i];c=p['artifact']['c'];need(c.count(old)==1,'mutation target count')
  need(m['cSha256']==sha(c.replace(old,new).encode()) and m['programIndex']==i,'mutation artifact')
  need(set(m)=={'name','programIndex','cSha256','proof'} and set(m['proof'])=={'passed','claims'},'mutation fields')
  need(m['proof']['passed'] is False,'mutation passed');claims(m['proof']['claims'],p,target)

if __name__=='__main__':
 import sys,json
 if not __debug__:raise RuntimeError('modular report validation requires Python assertions')
 raw=pathlib.Path(sys.argv[1]).read_bytes();data=json.loads(raw)
 validate(json.loads(pathlib.Path(sys.argv[2]).read_text()),data,raw)
 need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift')
 print('Modular report inventory and bindings passed')
