if not __debug__:raise RuntimeError('memory test assertions required')
from pathlib import Path
import sys,json,copy,uuid,shutil
sys.path.insert(0,'verification/collection_memory/qualification')
import report as v
root=Path('build/collection-memory');receipt=json.loads((root/'fresh-receipt.json').read_bytes());src=Path(receipt['inputArtifact']).parent;run=root/('report-controls-'+str(uuid.uuid4()));shutil.copytree(src,run)
data=json.loads((run/'input.json').read_bytes());data.update(runId=run.name,runDirectory=str(run));manifest={n:{'path':str(run/n),'sha256':v.sha(run/n)} for n in v.NAMES}
for name in v.NATIVES:
 p=run/name;d=json.loads(p.read_bytes())
 for row in d['replays']:row['files']={str(run/Path(f).relative_to(src)):h for f,h in row['files'].items()}
 p.write_text(json.dumps(d));manifest[name]['sha256']=v.sha(p)
assert v.validate(data,manifest)['passed'];controls=[]
def refuse(label,di,ma,reason):
 try:v.validate(di,ma)
 except ValueError as error:assert str(error)==reason,(label,str(error),reason);controls.append({'name':label,'reason':reason})
 else:raise AssertionError('accepted '+label)
for name in v.NAMES:
 p=run/name;raw=p.read_bytes();original=json.loads(raw);variants=[]
 d=copy.deepcopy(original);d['passed']=1;variants.append(('numeric-success',d,'memory child success'))
 if name in v.PROOFS:
  key='controls' if name=='controls.json' else 'claims'
  d=copy.deepcopy(original);d[key]=d[key][:-1];variants.append(('missing-claim',d,'memory claim inventory/results/scope: '+name))
  d=copy.deepcopy(original);d[key][0]['result']='unknown';variants.append(('unknown-result',d,'memory claim inventory/results/scope: '+name))
  d=copy.deepcopy(original);d['scope']='fully verified';variants.append(('scope-overclaim',d,'memory claim inventory/results/scope: '+name))
 else:
  d=copy.deepcopy(original);d['scope']='fully verified';variants.append(('scope-overclaim',d,'memory native scope'))
  d=copy.deepcopy(original);d['cases']=0;variants.append(('zero-cases',d,'memory native cases'))
  d=copy.deepcopy(original);d['replays'].pop();variants.append(('missing-replay',d,'memory native replay inventory'))
  d=copy.deepcopy(original);d['replays'][1]['exitCode']=0;variants.append(('wrong-status',d,'memory native status'))
  d=copy.deepcopy(original);d['replays'][0]['files'].pop(next(iter(d['replays'][0]['files'])));variants.append(('missing-native-file',d,'memory native file inventory'))
 for label,d,reason in variants:
  p.write_text(json.dumps(d));ma=copy.deepcopy(manifest);ma[name]['sha256']=v.sha(p);refuse(name+':'+label,data,ma,reason)
 p.write_bytes(raw)
# Corrupt actual compiled-source evidence and reseal BOTH source-file and report hashes.
for name,filename in [('native-commit/report.json','bend_collection_runtime.h'),('native-state/report.json','collection-store.c')]:
 p=run/name;raw=p.read_bytes();d=json.loads(raw);file=run/Path(name).parent/'baseline'/filename;source=file.read_bytes();file.write_bytes(source+b'\n/* deliberately changed evidence */\n');d['replays'][0]['files'][str(file)]=v.sha(file);p.write_text(json.dumps(d));ma=copy.deepcopy(manifest);ma[name]['sha256']=v.sha(p);refuse(name+':resealed-source',data,ma,'memory native source mismatch');file.write_bytes(source);p.write_bytes(raw)
di=copy.deepcopy(data);di['sources'].pop(next(iter(di['sources'])));refuse('missing-input-source',di,manifest,'memory source inventory')
ma=copy.deepcopy(manifest);ma.pop(next(iter(ma)));refuse('missing-child',data,ma,'memory child inventory')
ma=copy.deepcopy(manifest);ma['layout-frame.json']['path']=str(src/'layout-frame.json');refuse('stale-child-path',data,ma,'memory child run path')
assert v.validate(data,manifest)['passed'];(run/'control-input.json').write_text(json.dumps(data,indent=2)+'\n');(run/'control-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n');(run/'report-controls.json').write_text(json.dumps({'passed':True,'controls':controls},indent=2)+'\n');print(run);print(len(controls),'memory report controls passed')
