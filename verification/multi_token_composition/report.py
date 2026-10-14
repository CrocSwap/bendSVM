"""Strict composition evidence inventory/binding checks, not a proof kernel."""
from pathlib import Path
import hashlib,json,sys
sys.path.insert(0,'verification')
from multi_token_composition.common import NAMES,SCOPE,need,sha,snapshot

def exact(actual,expected):
 need(json.dumps(actual,sort_keys=True)==json.dumps(expected,sort_keys=True),'exact report inventory mismatch')

def hashes(items):
 need(type(items) is dict and items,'empty hash inventory')
 for p,h in items.items():need(type(h) is str and len(h)==64 and sha(p)==h,'source/artifact drift: '+p)

def validate_custody(rows,fixtures):
 from token_custody import parse
 exact([r['name'] for r in rows],NAMES)
 controls=['wrong-program','missing-executable','missing-derived-key-check','missing-syscall-failure','missing-caller-binding-0','missing-caller-binding-1']
 grammar=[('comment-spoof','custody helper template'),('macro-shadow','dependencies: macros unsupported in token.h'),('duplicate-binding','dependencies: ambiguous file-scope binding for bend_token_program'),('wrong-seed-root','custody helper template')]
 for row,fixture in zip(rows,fixtures):
  exact(sorted(row),sorted(['name','parsed','grammarControls','commentEquivalent','successEquivalence','callerBindingEquivalence','successWitness','controls']))
  exact(row['parsed'],parse(fixture['files']))
  exact(row['commentEquivalent'],True)
  exact(row['successEquivalence'],'unsat');exact(row['callerBindingEquivalence'],'unsat');exact(row['successWitness'],'sat')
  exact(row['grammarControls'],[{'name':n,'result':'refused','reason':reason} for n,reason in grammar])
  exact([c['name'] for c in row['controls']],controls)
  for c in row['controls']:
   exact(sorted(c),['name','result','witness']);exact(c['result'],'sat');need(type(c['witness']) is str and bool(c['witness']),'missing custody countermodel')

def validate(run):
 need(__debug__,'assertions required')
 run=Path(run).resolve();manifest=json.loads((run/'manifest.json').read_text())
 exact(sorted(manifest),['children','inputSha256','sourceHashes'])
 exact(manifest['sourceHashes'],snapshot());hashes(manifest['sourceHashes'])
 inp=run/'fixtures/input.json';exact(sha(inp),manifest['inputSha256']);data=json.loads(inp.read_text());hashes(data['immutableInputs'])
 exact([f['name'] for f in data['fixtures']],NAMES)
 binding={'input':str(inp),'inputSha256':sha(inp),'sourceHashes':manifest['sourceHashes']}
 expected_children=['positive','mapping','managed-byte','decimals','custody','custody-caller','snapshot-controls','pda-controls','serialized','native'];exact(sorted(manifest['children']),sorted(expected_children))
 children={}
 for name in expected_children:
  path=run/name/'report.json';entry=manifest['children'][name]
  exact(sorted(entry),['path','sha256']);exact(entry['path'],str(path));exact(entry['sha256'],sha(path))
  child=json.loads(path.read_text());exact(child['passed'],True);children[name]=child
  if name=='native':continue
  exact(sorted(child),['binding','extraInputs','fixtures','kind','passed','scope']);exact(child['scope'],SCOPE);exact(child['binding'],binding)
  exact(child['kind'],{'positive':'positive','mapping':'effect-mapping','managed-byte':'frame-control','decimals':'frame-control','custody':'custody','custody-caller':'custody-caller','snapshot-controls':'snapshot-controls','pda-controls':'pda-controls','serialized':'serialized'}[name])
  if name=='serialized':
   from multi_token_composition.serialized_report import validate as validate_serialized
   validate_serialized(child['fixtures'],data['fixtures'],run/'serialized',child['extraInputs'])
   continue
  extra={} if name in ('positive','mapping','custody','custody-caller','snapshot-controls','pda-controls') else {str(run/'positive/report.json'):sha(run/'positive/report.json')}
  exact(child['extraInputs'],extra)
 validate_custody(children['custody']['fixtures'],data['fixtures'])
 snapshots=children['snapshot-controls']['fixtures'];exact([r['fixture'] for r in snapshots],NAMES)
 import multi_adapter_contract as adapter
 for row,f in zip(snapshots,data['fixtures']):
  exact(sorted(row),['cases','fixture']);managed={field['index'] for field in adapter.summarize(f['schema'],f['interface'])['fields']}
  expected=[(i,name) for i in range(12) for name in (['baseline','missing-managed-byte','shifted-managed-byte'] if i in managed else ['baseline','missing-array-view'])]
  exact([(c['account'],c['case']) for c in row['cases']],expected)
  for c in row['cases']:
   if c['case']=='baseline':exact(sorted(c),['account','case','result']);exact(c['result'],'unsat')
   else:
    exact(sorted(c),['account','actual','case','expected','result']);exact(c['result'],'sat')
    need(type(c['actual']) is int and type(c['expected']) is int and 0<=c['actual']<=255 and 0<=c['expected']<=255 and c['actual']!=c['expected'],'snapshot countermodel bytes')
 exact(children['pda-controls']['fixtures'],[{'name':n,'reason':r} for n,r in [('missing-pin','missing application pin'),('duplicate-pin','application inventory'),('inconsistent-values','inconsistent constant interpretation'),('wrong-sort','PDA output signature')]])

 caller=children['custody-caller']['fixtures'];exact([r['name'] for r in caller],NAMES)
 for row,fixture in zip(caller,data['fixtures']):
  exact(sorted(row),['adapterSha256','cases','name'])
  exact(row['adapterSha256'],hashlib.sha256(fixture['files'][fixture['adapter']].encode()).hexdigest())
  exact([c['fault'] for c in row['cases']],[None,'missing-result','wrong-bump','missing-executable','wrong-program'])
  for c in row['cases']:
   exact(c['paths'],{'token-2':72,'token-3':152,'token-4':320}[row['name']])
   if c['fault'] is None:
    exact(sorted(c),['fault','paths','result','successWitness']);exact(c['result'],'unsat');exact(c['successWitness'],'sat')
   else:
    exact(sorted(c),['countermodel','fault','paths','result']);exact(c['result'],'sat');need(type(c['countermodel']) is list and bool(c['countermodel']),'missing caller custody countermodel')

 positive=children['positive'];contract=json.loads(Path(__file__).with_name('contract.json').read_text())
 exact([r['fixture'] for r in positive['fixtures']],NAMES)
 for row,fixture in [(r,f) for group in (positive['fixtures'],[s['fullRootComposition'] for s in children['serialized']['fixtures']]) for r,f in zip(group,data['fixtures'])]:
  expected=contract[row['fixture']];exact(sorted(row),expected['fixtureKeys'])
  for name,value in expected['exact'].items():exact(row[name],value)
  adapter=row['adapter'];exact(sorted(adapter),expected['adapterKeys'])
  for name,value in expected['adapterExact'].items():exact(adapter[name],value)
  exact(adapter['fixture'],row['fixture']);exact(adapter['files'],{p:hashlib.sha256(v.encode()).hexdigest() for p,v in fixture['files'].items()})
  exact(adapter['adapterSha256'],hashlib.sha256(fixture['files'][fixture['adapter']].encode()).hexdigest())
  extracted=dict(adapter['extraction']);exact(extracted.pop('adapterSha256'),adapter['adapterSha256']);exact(extracted,expected['adapterExtraction'])
  witnesses=row['activeTransferWitnesses'];exact([w['name'] for w in witnesses],['reachable-0','reachable-1'])
  for w in witnesses:
   exact(sorted(w),['name','result','witness']);exact(w['result'],'sat');need(type(w['witness']) is list and w['witness'],'empty active witness')
 for fault,label in [('managed-byte','actual-effects: sequential managed bytes preserved'),('decimals','actual-effects: sequential decimals preserved')]:
  child=children[fault];exact([r['fixture'] for r in child['fixtures']],NAMES)
  for row in child['fixtures']:
   exact(sorted(row),['counterexample','expected','fault','fixture','reason','witnessPins']);exact(row['fault'],fault);exact(row['expected'],label)
   exact(row['witnessPins'],'Positive initialize witness scalars, existential control only')
   need(label in row['counterexample']['failed'] and row['counterexample']['completeModel'],'wrong semantic fault counterexample')
   need(row['reason'].startswith('obligation: '),'wrong fault reason')
 mapping=children['mapping']['fixtures'];exact([(r['fixture'],r['fault']) for r in mapping],[(n,fault) for n in NAMES for fault in (None,'first-amount-from-withdrawal')])
 for row in mapping:
  fixture=next(f for f in data['fixtures'] if f['name']==row['fixture']);fault=row['fault'];n=int(row['fixture'][-1]);status='sat' if fault else 'unsat'
  fields=['fixture','fault','rootChecks','slotMappingResult','headerSha256']+(['wireArgs','firstAmount','mutatedHeader'] if fault else [])
  exact(sorted(row),sorted(fields));exact(row['slotMappingResult'],status);exact(len(row['rootChecks']),1)
  check=row['rootChecks'][0];exact(sorted(check),sorted(['function','result','CGuardObligations','sourceDeadPaths']+(['counterexample','wireArgs'] if fault else [])));exact(check['function'],'process');exact(check['result'],status);exact(check['CGuardObligations'],3*n+6);exact(check['sourceDeadPaths'],1)
  code=fixture['files'][fixture['name']+'.h']
  if fault:
   old='ToCustody_make(), (a2).as.c0.f1,';new='ToCustody_make(), (a2).as.c0.f2,';exact(code.count(old),1);code=code.replace(old,new)
   path=run/'mapping'/(row['fixture']+'-wrong-effect-amount.h');exact(row['mutatedHeader'],str(path));exact(path.read_text(),code)
   need(row['wireArgs'] and check['wireArgs'] and check['counterexample'],'missing amount counterexample')
   amounts=row['firstAmount'];exact(sorted(amounts),['actual','expected']);need(amounts['actual']!=amounts['expected'],'amount mutation not distinguished')
  exact(row['headerSha256'],hashlib.sha256(code.encode()).hexdigest())
 native=children['native'];native_contract=json.loads(Path('verification/multi_token_frame/contract.json').read_text())
 exact(sorted(native),native_contract['topKeys']['native']);exact(native['scope'],native_contract['scope']['native'])
 exact(native['cases'],36);exact(native['controls'],6)
 exact([(r['fixture'],r['variant']) for r in native['runs']],[(n,v) for n in NAMES for v in ('baseline','exposed-pending','helper-write')])
 hashes(native['inputHashes']);snap=run/'native/input.json';exact(json.loads(snap.read_text()),{**data,'originalSha256':sha(inp)})
 base=Path('verification/multi_token_frame').resolve();cc=Path(native['runs'][0]['command'][0]).resolve()
 exact(sorted(native['inputHashes']),sorted(str(p) for p in (base/'native.py',base/'pending-native.c',snap,cc)))
 for row in native['runs']:
  exact(sorted(row),['binarySha256','command','exitCode','files','fixture','logSha256','variant'])
  folder=run/'native'/(row['fixture']+'-'+row['variant']);fixture=next(f for f in data['fixtures'] if f['name']==row['fixture'])
  exact(sorted(row['files']),sorted([*fixture['files'],'native.c','native','build.log','run.log']))
  hashes({str(folder/p):h for p,h in row['files'].items()});exact(sha(folder/'native'),row['binarySha256']);exact(sha(folder/'run.log'),row['logSha256'])
  cmd=row['command'];exact(str(Path(cmd[0]).resolve()),str(cc));exact(cmd,[cmd[0],'-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-sanitize-recover=all','-DN='+row['fixture'][-1],'-I'+str(folder),str(folder/'native.c'),'-o',str(folder/'native')])
  log=(folder/'run.log').read_text()
  if row['variant']=='baseline':exact(row['exitCode'],0);exact(log.count('case '),12);need('12 native pending sequences passed' in log,'incomplete native run')
  else:
   exact(row['exitCode'],43);need(('pending range exposed' if row['variant']=='exposed-pending' else 'pending bytes changed') in log,'wrong native fault reason')
 return {'passed':True,'run':str(run),'inputSha256':sha(inp),'manifestSha256':sha(run/'manifest.json'),'scope':SCOPE}

if __name__=='__main__':print(json.dumps(validate(sys.argv[1])))
