from pathlib import Path
import json,copy,sys,hashlib
sys.path.insert(0,str(Path('verification').resolve()))
from native_handler_report import validate
receipt=json.loads(Path('build/native-handler-lowering/fresh-receipt.json').read_text());raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw);report=json.loads(Path(receipt['reportArtifact']).read_text())
assert hashlib.sha256(raw).hexdigest()==receipt['inputSha256'];assert hashlib.sha256(Path(receipt['reportArtifact']).read_bytes()).hexdigest()==receipt['reportSha256']
validate(report,data,raw);controls=[]
def test(name,mutate,reason):
 candidate=copy.deepcopy(report);mutate(candidate)
 try:validate(candidate,data,raw)
 except (ValueError,AssertionError) as e:assert str(e)==reason,(name,str(e),reason)
 else:raise AssertionError(name+' accepted')
 controls.append({'name':name,'reason':reason,'mutatedReportSha256':hashlib.sha256(json.dumps(candidate,sort_keys=True).encode()).hexdigest()})
test('missing division prerequisite',lambda r:r.pop('divisionPrerequisite'),'report fields')
test('old report version',lambda r:r.update(version=1),'version')
test('expanded assurance claim',lambda r:r.update(scope='end-to-end verified'),'scope')
test('wrong division model hash',lambda r:r['divisionPrerequisite'].update(modelSha256='0'*64),'division model binding')
test('missing division source hash',lambda r:r['divisionPrerequisite']['hashes'].pop('sdk/math.bend'),'division prerequisite source binding')
test('missing wrapper',lambda r:r['divisionPrerequisite']['division']['wrappers'].pop(),'division wrappers')
test('unknown division step',lambda r:r['divisionPrerequisite']['division']['step'].update(result='unknown'),'division step')
test('missing induction',lambda r:r['divisionPrerequisite']['division']['induction'].pop(),'division induction')
test('duplicate fast path',lambda r:r['divisionPrerequisite']['division']['fastPaths'].append(copy.deepcopy(r['divisionPrerequisite']['division']['fastPaths'][0])),'division fast paths')
test('unknown native split',lambda r:r['divisionPrerequisite']['native']['claims'][2].update(result='unknown'),'native formula claims')
test('nonreplaying native witness',lambda r:r['divisionPrerequisite']['native']['negative'].update(counterexample={k:'0' for k in ['al','ah','bl','bh']}),'native control witness replay')
test('extra division evidence',lambda r:r['divisionPrerequisite']['division'].update(extra=True),'division report fields')
test('nonfinite division timing',lambda r:r['divisionPrerequisite']['division']['step'].update(seconds=float('nan')),'division claim fields')
test('missing native source binding',lambda r:r['sourceHashes'].pop('verification/native_divmod.py'),'source binding')
for i in range(3):
 def native(r):return next(c for c in r['results'][i]['proof']['claims'] if c['function'].endswith('/sdk/math.divmod'))
 test(f'fixture {i} forged division body certificate',lambda r:native(r)['certificate'].update(nativeBodySha256='0'*64),'native certificate')
 test(f'fixture {i} dropped division certificate kind',lambda r:native(r).update(result='unsat'),'native result')
 test(f'fixture {i} missing division claim',lambda r:r['results'][i]['proof']['claims'].remove(native(r)),'function inventory/order')
 test(f'fixture {i} unbound elision',lambda r:r['results'][i]['proof']['elidedSourceFunctions'].append('phantom'),'elision inventory')
validate(report,data,raw)
from native_divmod import certify as certify_divmod
from acyclic_c import function_bodies,mangle
body_controls=[]
for program in data['programs']:
 certificate=certify_divmod(program,report['divisionPrerequisite'],data['sourceModels']['division'].encode())
 symbol=mangle(certificate['sourceFunction']);body=function_bodies(program['artifact']['c'])[symbol]
 for name,before,after in [
  ('wrong quotient','q = n / d','q = n * d'),
  ('lost remainder','r = n % d','r = 0'),
  ('wrong error','_DivErr_make(3u)','_DivErr_make(0u)'),
  ('wrong numerator high','a0.as.c0.f1 << 32','a0.as.c0.f0 << 32')]:
  assert body.count(before)==1
  candidate=copy.deepcopy(program);candidate['artifact']['c']=candidate['artifact']['c'].replace(body,body.replace(before,after))
  candidate['artifact']['cSha256']=hashlib.sha256(candidate['artifact']['c'].encode()).hexdigest()
  try:certify_divmod(candidate,report['divisionPrerequisite'],data['sourceModels']['division'].encode())
  except ValueError as e:assert str(e)=='native division body mismatch'
  else:raise AssertionError('altered native division accepted')
  body_controls.append({'fixture':program['artifact']['fixture'],'name':name,'reason':'native division body mismatch','cSha256':candidate['artifact']['cSha256']})
output={'passed':True,'bodyControls':body_controls,'controls':controls,'receiptSha256':hashlib.sha256(Path('build/native-handler-lowering/fresh-receipt.json').read_bytes()).hexdigest(),'scope':'Strict report refusal checks for staged dual-native handler integration; no positive semantic proof inferred from report validation alone.'}
(Path(receipt['reportArtifact']).parent/'division-controls.json').write_text(json.dumps(output,indent=2)+'\n');print(len(controls),'strict report controls and',len(body_controls),'native division body controls passed')
