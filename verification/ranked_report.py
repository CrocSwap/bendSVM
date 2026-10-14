"""Exact fixture, dependency, rank-obligation and artifact inventory for loop checks."""
import hashlib,json,math,pathlib,sys
if not __debug__:raise RuntimeError('ranked report validation requires Python assertions')
from acyclic_c import need,mangle
from modular_c import refs
from tagged_sum_rendering import function_bodies
FIXTURES=[{'file':'examples/batch/PROOF.bend','roots':['batch.process']},
 {'file':'tests/iteration.bend','roots':['count','swaps','toggle','rotate']},{'file':'examples/queue/PROOF.bend','roots':['queue.process','queue.select']}]
SCOPE='Typed pure source/C preservation by dependency order and decreasing unsigned Nat-rank induction. Assumes trusted source/C models, schema, solver and induction driver. Covers bounded Nat<=64 as a subset of the rank domain, not CU bounds, pointers, effects, LLVM or SBF.'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def snapshot(names):return {n:sha(pathlib.Path(n).read_bytes()) for n in names}
def validate_proof(p,result):
 functions=p['source']['functions'];loops={n for n,f in functions.items() if n in set(refs(f.get('body')))}
 order=[];seen=set();active=set();deps={}
 def visit(name):
  need(name in functions and name not in active,'unknown or mutually recursive dependency')
  if name in seen:return
  active.add(name);deps[name]=sorted(set(refs(functions[name].get('body')))-{name})
  for callee in deps[name]:visit(callee)
  active.remove(name);seen.add(name);order.append(name)
 for root in p['source']['roots']:visit(root)
 need(set(functions)==seen,'unreachable function inventory')
 need(set(result)=={'passed','endToEndVerified','claims','roots','loops','scope'},'proof fields')
 need(result['passed'] is True and result['endToEndVerified'] is False and result['scope']==SCOPE,'proof scope')
 need(result['roots']==p['source']['roots'] and result['loops']==sorted(loops),'root/loop inventory')
 need([c['function'] for c in result['claims']]==order,'function inventory/order')
 bodies=function_bodies(p['artifact']['c'])
 for c in result['claims']:
  need(set(c)=={'function','dependencies','loop','fuelArgument','sourceRecursions','CContinues','checks'},'claim fields')
  name=c['function'];loop=name in loops
  need(c['dependencies']==deps[name] and c['loop'] is loop,'claim dependencies/loop')
  fuel=functions[name]['args'].index('Nat') if loop else None
  need(c['fuelArgument']==fuel and (type(c['fuelArgument']) is int if loop else c['fuelArgument'] is None),'fuel argument')
  for key in ['sourceRecursions','CContinues']:need(type(c[key]) is int,'boundary count type')
  need(c['sourceRecursions']==list(refs(functions[name].get('body'))).count(name),'source recursion count')
  need(c['CContinues']==bodies[mangle(name)].count('continue;'),'C continuation count')
  need((c['sourceRecursions']>0 and c['CContinues']>0) if loop else c['sourceRecursions']==c['CContinues']==0,'boundary inventory')
  labels=(['source-rank-decreases','C-rank-decreases'] if loop else [])+['equivalence-and-safety']
  need([q['name'] for q in c['checks']]==labels,'obligation inventory/order')
  for q in c['checks']:
   need(set(q)=={'name','result','seconds'} and q['result']=='unsat','unproved obligation')
   need(type(q['seconds']) in (int,float) and math.isfinite(q['seconds']) and q['seconds']>=0,'timing')
def validate(report,data,raw):
 need(set(report)=={'passed','endToEndVerified','version','z3','runId','inputSha256','sourceHashes','cSyntax','results','scope'},'report fields')
 need(report['passed'] is True and report['endToEndVerified'] is False and report['scope']==SCOPE,'report scope')
 need(type(report['version']) is int and report['version']==1 and report['z3']=='5.1.0','report version')
 need(report['runId']==data['runId'] and report['inputSha256']==sha(raw),'run/input binding')
 need(report['sourceHashes']==data['sourceHashes'],'source binding')
 required={'verification/'+n for n in ['ranked_c.py','ranked_report.py','ranked_lowering.py','ranked-source.ts','check-ranked-lowering.ts','prove.py','model.ts','acyclic_c.py','modular_c.py','tagged_sum_rendering.py','tagged_sum_layout.py','tagged_sum_c.py','adapter_contract_c.py']}
 need(required<=set(data['sourceHashes']),'checker source inventory')
 need(data['fixtures']==FIXTURES and len(data['programs'])==len(FIXTURES),'fixture inventory')
 need([r['fixture'] for r in report['results']]==[f['file'] for f in FIXTURES],'result inventory')
 need(report['cSyntax']==data['cSyntax'],'frontend binding')
 need(isinstance(data['cSyntax']['compiler'],str) and data['cSyntax']['compiler'] and isinstance(data['cSyntax']['version'],str) and data['cSyntax']['version'].strip(),'frontend identity')
 need(data['cSyntax']['units']==[{'fixture':p['artifact']['fixture'],'cSha256':sha(p['artifact']['c'].encode()),'exitCode':0} for p in data['programs']],'frontend inventory')
 for f,p,r in zip(FIXTURES,data['programs'],report['results']):
  need(p['source']['source']==f['file'] and p['source']['roots']==f['roots'] and p['artifact']['fixture']==f['file'],'fixture identity')
  need(p['defaultProductionCMatches'] is True and p['source']['schema']==p['artifact']['schema'],'production/schema binding')
  need(set(r)=={'fixture','cSha256','proof'} and r['cSha256']==p['artifact']['cSha256']==sha(p['artifact']['c'].encode()),'C result binding')
  validate_proof(p,r['proof'])
if __name__=='__main__':
 raw=pathlib.Path(sys.argv[1]).read_bytes();data=json.loads(raw)
 validate(json.loads(pathlib.Path(sys.argv[2]).read_text()),data,raw)
 need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift')
 print('Ranked loop report bindings and complete obligation inventories passed')
