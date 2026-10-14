"""Probe strict report rejection using a private relocated evidence copy."""
from pathlib import Path
import copy,hashlib,json,shutil,sys,uuid
sys.path.insert(0,str(Path(__file__).resolve().parent));import report
if not __debug__:raise RuntimeError('assertions required')
source=Path(sys.argv[1]).resolve();base=source.parent/('report-controls-'+str(uuid.uuid4()));base.mkdir();run=base/'evidence';shutil.copytree(source,run)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
manifest=json.loads((run/'manifest.json').read_text())
for name,row in manifest['children'].items():row['path']=str(run/name/'report.json')
(run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');report.validate(run)
original={name:json.loads((run/name/'report.json').read_text()) for name in manifest['children']};rows=[]
def check(name,child,mutate):
 value=copy.deepcopy(original[child]);mutate(value);p=run/child/'report.json';p.write_text(json.dumps(value,indent=2)+'\n');manifest['children'][child]['sha256']=sha(p);(run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 try:report.validate(run)
 except (RuntimeError,AssertionError,KeyError,TypeError,ValueError) as error:accepted=False;reason=str(error)
 else:accepted=True;reason='altered report accepted'
 (base/(name+'.json')).write_text(json.dumps({'child':child,'report':value},indent=2)+'\n')
 rows.append({'name':name,'accepted':accepted,'reason':reason});print(name+': '+('ACCEPTED' if accepted else 'rejected'),flush=True)
 p.write_text(json.dumps(original[child],indent=2)+'\n');manifest['children'][child]['sha256']=sha(p);(run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
check('missing-active-witness','symbolic',lambda r:r['fixtures'][0]['result']['activeCallerWitnesses'].pop())
check('missing-frame-obligation','symbolic',lambda r:r['fixtures'][0]['addedObligations'].pop('executor-frame: arbitrary managed bytes preserved'))
check('float-obligation-count','symbolic',lambda r:r['fixtures'][0]['addedObligations'].__setitem__('executor-frame: arbitrary managed bytes preserved',16.0))
check('unknown-result','symbolic',lambda r:r['fixtures'][0]['result']['claims']['ordered-return-contract'].__setitem__('result','unknown'))
check('scope-overclaim','symbolic',lambda r:r.__setitem__('scope','End-to-end verified compiler'))
check('missing-key-role','symbolic',lambda r:r['fixtures'][0]['metaInventory']['1'].pop())
check('extra-top-level','symbolic',lambda r:r.__setitem__('unreviewedClaim',True))
check('missing-source-binding','symbolic',lambda r:r['inputHashes'].pop(str(Path('verification/token_validate.py').resolve())))
check('missing-native-compiler-flag','native',lambda r:r['runs'][0]['command'].remove('-fsanitize=address,undefined'))
check('missing-native-file','native',lambda r:r['runs'][0]['files'].pop('token.h'))
check('native-scope-overclaim','native',lambda r:r.__setitem__('scope','Formal runtime memory theorem'))
check('frame-control-missing-failure','frame_control',lambda r:r['fixtures'][0]['result']['witness'].__setitem__('failed',[]))
check('missing-native-run','native',lambda r:r['runs'].pop())
for name,mutate in [
 ('manifest-source-omission',lambda value:value['sourceHashes'].pop(str(Path('verification/token_validate.py').resolve()))),
 ('manifest-extra-field',lambda value:value.__setitem__('unreviewedClaim',True)),
 ('manifest-child-path',lambda value:value['children']['symbolic'].__setitem__('path',str(source/'symbolic/report.json')))]:
 changed=copy.deepcopy(manifest);mutate(changed);(run/'manifest.json').write_text(json.dumps(changed,indent=2)+'\n')
 try:report.validate(run)
 except (RuntimeError,AssertionError,KeyError,TypeError,ValueError) as error:accepted=False;reason=str(error)
 else:accepted=True;reason='altered manifest accepted'
 (base/(name+'.json')).write_text(json.dumps(changed,indent=2)+'\n');rows.append({'name':name,'accepted':accepted,'reason':reason});print(name+': '+('ACCEPTED' if accepted else 'rejected'),flush=True)
 (run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
report.validate(run)
result={'passed':not any(x['accepted'] for x in rows),'probes':rows,'inputReportSha256':sha(source/'accepted.json'),'checkerSha256':sha(Path(report.__file__)),'testSha256':sha(Path(__file__)),'contractSha256':sha(Path(report.__file__).with_name('contract.json'))}
(base/'report.json').write_text(json.dumps(result,indent=2)+'\n');print(str(base/'report.json'))
