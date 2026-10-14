"""Strict token-frame evidence validation; not a semantic proof checker."""
from pathlib import Path
import hashlib,json,sys,subprocess,re
if not __debug__:raise RuntimeError('assertions required')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def exact(a,b):
 if json.dumps(a,sort_keys=True)!=json.dumps(b,sort_keys=True):raise RuntimeError('exact report inventory mismatch')
def hashes(items):
 if not isinstance(items,dict) or not items:raise RuntimeError('empty hash inventory')
 for p,h in items.items():
  if type(h) is not str or len(h)!=64 or sha(p)!=h:raise RuntimeError('source/artifact drift: '+p)
def validate(run):
 run=Path(run).resolve();contract=json.loads(Path(__file__).with_name('contract.json').read_text());manifest=json.loads((run/'manifest.json').read_text());hashes(manifest['sourceHashes'])
 exact(sorted(manifest),['children','inputSha256','sourceHashes'])
 base=Path(__file__).resolve().parent
 expected_sources=[base/n for n in ['fixtures.ts','symbolic.py','frame_control.py','native.py','pending-native.c','report.py','contract.json','controller.py']]+[Path('package.json'),Path('package-lock.json'),Path('tests/multi-token-frame.ts')]
 expected_sources += [Path(name) for name in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],text=True).split('\0') if name and not re.fullmatch(r'sdk/\.sqrt-negative-[0-9]+\.bend',name) and name.startswith(('compiler/','runtime/','verification/','sdk/')) and Path(name).is_file() and Path(name).suffix in ['.py','.ts','.h','.bend','.json']]
 exact(sorted(manifest['sourceHashes']),sorted(set(str(p.resolve()) for p in expected_sources)))
 inp=run/'fixtures/input.json';exact(sha(inp),manifest['inputSha256']);data=json.loads(inp.read_text());hashes(data['immutableInputs'])
 exact([f['name'] for f in data['fixtures']],['token-2','token-3','token-4'])
 exact(sorted(manifest['children']),['frame_control','native','symbolic'])
 children={}
 for name,item in manifest['children'].items():
  expected=run/name/'report.json';exact(item['path'],str(expected));exact(sha(expected),item['sha256']);r=json.loads(expected.read_text());exact(r['passed'],True);hashes(r['inputHashes']);children[name]=r
  if str(Path(__file__).with_name(name+'.py').resolve()) not in r['inputHashes']:raise RuntimeError('missing child source binding')
 for name,r in children.items():
  exact(sorted(r),contract['topKeys'][name]);exact(r['scope'],contract['scope'][name])
  snapshots=[Path(p) for p in r['inputHashes'] if Path(p).name=='input.json'];exact(len(snapshots),1)
  snapshot=json.loads(snapshots[0].read_text());exact(snapshot,{'originalSha256':manifest['inputSha256'],'immutableInputs':data['immutableInputs'],'fixtures':data['fixtures']})
  expected=[Path(__file__).with_name(name+'.py').resolve(),snapshots[0].resolve()]
  if name=='native':expected += [Path(__file__).with_name('pending-native.c').resolve(),Path(r['runs'][0]['command'][0]).resolve()]
  else:expected += [Path('verification',p).resolve() for p in contract['verificationModules']]
  exact(sorted(r['inputHashes']),sorted(str(p) for p in expected))
 s=children['symbolic'];exact(s['endToEndVerified'],False);exact(s['controls'],[])
 exact([f['name'] for f in s['fixtures']],['token-2','token-3','token-4'])
 claims=['ordered-return-contract','root-context-before-instruction','all-encodes-validation-execution-before-commit','no-adapter-writes-on-explicit-failure','exact-per-account-header-binding-payload-and-reply','encode-source-field-binding']
 for f,source in zip(s['fixtures'],data['fixtures']):
  exact(sorted(f),contract['fixtureKeys']);exact(f['executorAudit'],contract['executorAudit']);exact(f['metaInventory'],contract['metaInventory']);n=int(f['name'][-1]);calls=2**(n+1);exact(f['managedIndices'],[0,*range(4,n+3)]);exact(f['observedPhases'],['validate']*calls+['execute']*calls)
  exact(f['addedObligations'],{'bridge: token count and key premises':2*calls,'bridge: managed token owner exclusion':2*calls*n,'connection: validator excludes managed writable roles':calls*n,'executor-frame: writable keys exclude managed accounts':calls*n,'executor-frame: arbitrary managed bytes preserved':calls*n})
  result=f['result'];witnesses=result['activeCallerWitnesses'];exact([w['mode'] for w in witnesses],[0,1]);exact([w['result'] for w in witnesses],['sat','sat']);exact([bool(w['model']) for w in witnesses],[True,True]);exact(result['claims'],{k:{'result':'unsat','counterexamples':0} for k in claims});exact(result['fixture'],f['name']);exact(result['adapterSha256'],hashlib.sha256(source['files'][source['adapter']].encode()).hexdigest())
  exact(result['files'],{p:hashlib.sha256(v.encode()).hexdigest() for p,v in source['files'].items()});exact(result['extraction']['passed'],True)
 c=children['frame_control'];exact(len(c['fixtures']),1);failure=c['fixtures'][0]['result'];exact(failure['expectedFrameFailure'],True)
 if 'executor-frame: arbitrary managed bytes preserved' not in failure['witness']['failed']:raise RuntimeError('wrong frame control failure')
 n=children['native'];exact(n['cases'],36);exact(n['controls'],6);exact([(r['fixture'],r['variant']) for r in n['runs']],[(f'token-{i}',v) for i in [2,3,4] for v in ['baseline','exposed-pending','helper-write']])
 for row in n['runs']:
  d=run/'native'/(row['fixture']+'-'+row['variant']);fixture=next(f for f in data['fixtures'] if f['name']==row['fixture']);exact(sorted(row['files']),sorted([*fixture['files'],'native.c','native','build.log','run.log']));cmd=row['command'];exact(cmd[1:7],['-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-sanitize-recover=all','-DN='+row['fixture'][-1]]);exact(len(cmd),11);exact(cmd[-2],'-o');hashes({str(d/p):h for p,h in row['files'].items()});exact(sha(d/'native'),row['binarySha256']);exact(sha(d/'run.log'),row['logSha256'])
  text=(d/'run.log').read_text()
  if row['variant']=='baseline':exact(row['exitCode'],0);exact(text.count('case '),12)
  else:
   exact(row['exitCode'],43);reason='pending range exposed' if row['variant']=='exposed-pending' else 'pending bytes changed'
   if reason not in text:raise RuntimeError('wrong native control failure')
 return {'passed':True,'run':str(run),'inputSha256':sha(inp),'manifestSha256':sha(run/'manifest.json'),'scope':'Conditional multi-account token qualification; shared full256-bit identities; native-object/runtime frame assumptions remain explicit.'}
if __name__=='__main__':print(json.dumps(validate(sys.argv[1])))
