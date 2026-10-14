"""Alter private evidence copies, repairing hashes to exercise strict inventories."""
from pathlib import Path
import copy,json,shutil,sys,uuid
sys.path.insert(0,'verification')
from multi_token_composition import report
from multi_token_composition.common import sha
if not __debug__:raise RuntimeError('assertions required')
source=Path(sys.argv[1]).resolve();report.validate(source)
base=source.parent/('report-controls-'+str(uuid.uuid4()));base.mkdir();run=base/'evidence';shutil.copytree(source,run)
manifest=json.loads((run/'manifest.json').read_text());original={name:json.loads((run/name/'report.json').read_text()) for name in manifest['children']}
for name,value in original.items():
 if name=='native':
  value['inputHashes']={str(run/'native/input.json') if p==str(source/'native/input.json') else p:h for p,h in value['inputHashes'].items()}
  for row in value['runs']:row['command']=[arg.replace(str(source),str(run)) for arg in row['command']]
 else:
  value['binding']['input']=str(run/'fixtures/input.json')
  if name=='serialized':
   for row in value['fixtures']:
    for witness in row['activeWitnesses']:witness['queryArtifact']=str(run/'serialized'/Path(witness['queryArtifact']).name)
  if name=='mapping':
   for row in value['fixtures']:
    if row['fault']:row['mutatedHeader']=str(run/'mapping'/Path(row['mutatedHeader']).name)
from multi_token_composition.physical_copy import relocate
original['serialized']=relocate(source/'serialized',run/'serialized',original['serialized'])
for name,item in manifest['children'].items():item['path']=str(run/name/'report.json')
def write(values,metadata=None):
 m=copy.deepcopy(manifest if metadata is None else metadata)
 for name in ['positive','mapping','managed-byte','decimals','custody','custody-caller','snapshot-controls','pda-controls','serialized','native']:
  value=copy.deepcopy(values[name])
  if name in ('managed-byte','decimals'):value['extraInputs']={str(run/'positive/report.json'):sha(run/'positive/report.json')}
  if name=='serialized':
   value['extraInputs']={str(run/'serialized'/Path(p).name) if p in (str(source/'serialized/loader-receipt.json'),str(source/'serialized/loader-replay.json')) else p:h for p,h in value['extraInputs'].items()}
  path=run/name/'report.json';path.write_text(json.dumps(value,indent=2)+'\n');m['children'][name]['sha256']=sha(path)
 (run/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
write(original);report.validate(run);rows=[]
def check(name,child,mutation):
 changed=copy.deepcopy(original);mutation(changed[child]);write(changed)
 try:report.validate(run)
 except (RuntimeError,AssertionError,KeyError,TypeError,ValueError) as error:reason=str(error)
 else:raise RuntimeError('accepted report mutation: '+name)
 (base/(name+'.json')).write_text(json.dumps({'child':child,'report':changed[child],'reason':reason},indent=2)+'\n');rows.append({'name':name,'reason':reason});print(name+' rejected',flush=True)
 write(original)
check('missing-active-witness','positive',lambda r:r['fixtures'][0]['activeTransferWitnesses'].pop())
check('missing-sequential-obligation','positive',lambda r:r['fixtures'][0]['actualEffectObligations'].pop('actual-effects: sequential durable validation'))
check('float-obligation','positive',lambda r:r['fixtures'][0]['actualEffectObligations'].__setitem__('actual-effects: sequential durable validation',32.0))
check('unknown-adapter-result','positive',lambda r:r['fixtures'][0]['adapter']['claims']['ordered-return-contract'].__setitem__('result','unknown'))
check('missing-codec-claim','positive',lambda r:r['fixtures'][0]['codecEvidence']['claims'].pop())
check('missing-extraction-claim','positive',lambda r:r['fixtures'][0]['extractionEvidence']['claims'].pop())
check('broadened-byte-frame','positive',lambda r:r['fixtures'][0]['sequenceFrame']['byteFrame']['token']['spans'][0].__setitem__(0,44))
check('missing-writable-role','positive',lambda r:r['fixtures'][0]['sequenceFrame']['writableRoles']['1'].pop())
check('missing-binding-output','positive',lambda r:r['fixtures'][0]['binding'].__setitem__('outputs',32))
check('scope-overclaim','positive',lambda r:r.__setitem__('scope','End-to-end verified compiler'))
check('numeric-pass','positive',lambda r:r.__setitem__('passed',1))
check('extra-top-key','positive',lambda r:r.__setitem__('unreviewed',True))
check('missing-source-binding','positive',lambda r:r['binding']['sourceHashes'].pop(str(Path('verification/token_validate.py').resolve())))
check('missing-mapping','mapping',lambda r:r['fixtures'].pop())
check('wrong-mapping-result','mapping',lambda r:r['fixtures'][0].__setitem__('slotMappingResult','sat'))
check('equal-mutated-amounts','mapping',lambda r:r['fixtures'][1]['firstAmount'].__setitem__('actual',r['fixtures'][1]['firstAmount']['expected']))
check('missing-root-equivalence','mapping',lambda r:r['fixtures'][0]['rootChecks'].clear())
check('missing-root-counterexample','mapping',lambda r:r['fixtures'][1]['rootChecks'][0].__setitem__('wireArgs',[]))
check('missing-managed-failure','managed-byte',lambda r:r['fixtures'][0]['counterexample'].__setitem__('failed',[]))
check('missing-decimals-failure','decimals',lambda r:r['fixtures'][0]['counterexample'].__setitem__('failed',[]))
check('missing-custody-binding-control','custody',lambda r:r['fixtures'][0]['controls'].pop())
check('unknown-custody-equivalence','custody',lambda r:r['fixtures'][0].__setitem__('callerBindingEquivalence','unknown'))
check('wrong-custody-seed','custody',lambda r:r['fixtures'][0]['parsed'].__setitem__('seedAccount',1))
check('missing-custody-grammar-control','custody',lambda r:r['fixtures'][0]['grammarControls'].pop())
check('missing-custody-success-property','positive',lambda r:r['fixtures'][0]['properties'].pop())
check('missing-caller-custody-fault','custody-caller',lambda r:r['fixtures'][0]['cases'].pop())
check('unknown-caller-custody','custody-caller',lambda r:r['fixtures'][0]['cases'][0].__setitem__('result','unknown'))
check('missing-initial-view','serialized',lambda r:r['fixtures'][0]['initialViews'].pop())
check('forward-initial-reuse','serialized',lambda r:r['fixtures'][0]['initialViews'][0].__setitem__('reusedFrom',[0,1]))
check('missing-precommit','serialized',lambda r:r['fixtures'][0]['precommit'].pop())
check('wrong-serialized-query-hash','serialized',lambda r:r['fixtures'][0]['activeWitnesses'][0].__setitem__('querySha256','0'*64))
check('missing-pda-pin','serialized',lambda r:r['fixtures'][0]['activeWitnesses'][0]['pdaApplicationPins'].pop())
check('missing-snapshot-counterexample','snapshot-controls',lambda r:r['fixtures'][0]['cases'].pop())
check('missing-pda-guard-control','pda-controls',lambda r:r['fixtures'].pop())
check('missing-native-run','native',lambda r:r['runs'].pop())
check('missing-native-artifact','native',lambda r:r['runs'][0]['files'].pop('token.h'))
check('missing-sanitizer','native',lambda r:r['runs'][0]['command'].remove('-fsanitize=address,undefined'))
check('wrong-native-fault-exit','native',lambda r:r['runs'][1].__setitem__('exitCode',0))
check('native-scope-overclaim','native',lambda r:r.__setitem__('scope','Formal memory proof'))
for name,mutation in [
 ('manifest-extra',lambda m:m.__setitem__('extra',True)),
 ('manifest-source-omission',lambda m:m['sourceHashes'].pop(str(Path('verification/token_validate.py').resolve()))),
 ('manifest-child-path',lambda m:m['children']['mapping'].__setitem__('path',str(source/'mapping/report.json')))]:
 altered=copy.deepcopy(manifest);mutation(altered);write(original,altered)
 try:report.validate(run)
 except (RuntimeError,AssertionError,KeyError,TypeError,ValueError) as error:reason=str(error)
 else:raise RuntimeError('accepted manifest mutation: '+name)
 (base/(name+'.json')).write_text(json.dumps({'manifest':altered,'reason':reason},indent=2)+'\n');rows.append({'name':name,'reason':reason});print(name+' rejected',flush=True)
 write(original)
from multi_token_composition.physical_controls import check as physical_controls
physical_rows=physical_controls(original['serialized']['fixtures'],json.loads((run/'fixtures/input.json').read_text())['fixtures'])
rows.extend(physical_rows)
report.validate(run);report.validate(source)
result={'sourceRun':str(source),'passed':True,'controls':rows,'sourceAcceptedSha256':sha(source/'accepted.json'),'checkerSha256':sha(Path(report.__file__)),'testSha256':sha(Path(__file__)),'contractSha256':sha(Path(report.__file__).with_name('contract.json'))}
(base/'report.json').write_text(json.dumps(result,indent=2)+'\n');print(str(base/'report.json'))
