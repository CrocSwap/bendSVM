from pathlib import Path
import sys,json,hashlib,copy,uuid,shutil
sys.path.insert(0,'verification/collection_entry/qualification')
import bundle_report as b
root=Path('build/collection-entry');src=Path(json.loads((root/'fresh-receipt.json').read_bytes())['inputArtifact']).parent;run=root/('report-controls-'+str(uuid.uuid4()));run.mkdir()
children={}
for name in b.NAMES:
 p=run/name;p.write_bytes((src/name).read_bytes());children[name]={'path':str(p),'sha256':b.sha(p.read_bytes())}
shutil.copytree(src/'native',run/'native')
native=json.loads((run/'native.json').read_bytes())
for row in native['replays']:row['files']={str(run/Path(p).relative_to(src)):h for p,h in row['files'].items()}
(run/'native.json').write_text(json.dumps(native));children['native.json']['sha256']=b.sha((run/'native.json').read_bytes())
prerequisites={}
for name,receipt in [('loader','build/loader/fresh-receipt.json'),('collection','build/collection-root/fresh-receipt.json')]:
 r=json.loads(Path(receipt).read_text());prerequisites[name]={k:r[k] for k in ['inputArtifact','inputSha256','reportArtifact','reportSha256']}
files=b.source_files()
data={'nativeCompiler':json.loads((src/'before.json').read_bytes())['nativeCompiler'],'version':1,'runId':run.name,'runDirectory':str(run),'sources':{str(p):b.sha(p.read_bytes()) for p in files},'prerequisites':prerequisites,'children':children}
assert b.validate(data)['passed'];results=[]
def refuse(name,d,reason):
 try:b.validate(d)
 except ValueError as error:assert str(error)==reason,(name,error,reason);results.append({'name':name,'reason':reason})
 else:raise AssertionError('accepted '+name)
# Reseal candidate hashes so rejection must come from semantic report inventory.
for name in [n for n in b.NAMES if n!='native.json']:
 p=run/name;raw=p.read_bytes();original=json.loads(raw)
 candidates=[]
 if 'checkerSha256' in original:
  d=copy.deepcopy(original);d['checkerSha256']='0'*64;candidates.append(('wrong-checker',d,'child checker binding'))
 d=copy.deepcopy(original);d['passed']=1;candidates.append(('numeric-success',d,'child success type'))
 d=copy.deepcopy(original);d['scope']='end-to-end verified';candidates.append(('overclaim',d,'child claim inventory/results/scope: '+name))
 d=copy.deepcopy(original);d['loaderInputSha256']='0'*64;candidates.append(('wrong-input',d,'child prerequisite binding'))
 claimkey='entryClaims' if name=='report.json' else 'extensionClaims' if name=='binding-domain.json' else 'controls' if name in ('binding-checks.json','metadata-controls.json') else 'claims'
 d=copy.deepcopy(original);d[claimkey]=d[claimkey][:-1];candidates.append(('missing-claim',d,'child claim inventory/results/scope: '+name))
 d=copy.deepcopy(original)
 if claimkey=='extensionClaims':d[claimkey][0]='invented-output'
 else:d[claimkey][0]['result']='unknown'
 candidates.append(('altered-result',d,'child claim inventory/results/scope: '+name))
 for label,report,reason in candidates:
  p.write_text(json.dumps(report));mut=copy.deepcopy(data);mut['children'][name]['sha256']=b.sha(p.read_bytes());refuse(name+':'+label,mut,reason)
 p.write_bytes(raw)
# Native result and source binding controls also reseal the child hash.
p=run/'native.json';raw=p.read_bytes();original=json.loads(raw)
for label,mutate,reason in [
 ('missing-replay',lambda d:d['replays'].pop(),'native replay inventory'),
 ('wrong-status',lambda d:d['replays'][1].update(exitCode=0),'native replay status'),
 ('wrong-case-count',lambda d:d.update(cases=170),'native case count'),
 ('wrong-compiler',lambda d:d['compiler'].update(sha256='0'*64),'native compiler binding'),
 ('wrong-input',lambda d:d.update(collectionInputSha256='0'*64),'native input binding'),
 ('missing-file',lambda d:d['replays'][0]['files'].pop(next(iter(d['replays'][0]['files']))),'native file inventory')]:
 d=copy.deepcopy(original);mutate(d);p.write_text(json.dumps(d));mut=copy.deepcopy(data);mut['children']['native.json']['sha256']=b.sha(p.read_bytes());refuse('native:'+label,mut,reason)
p.write_bytes(raw)
for label,key,reason in [('missing-child','children','child inventory'),('missing-source','sources','bundle source inventory'),('missing-prerequisite','prerequisites','bundle prerequisite inventory')]:
 d=copy.deepcopy(data);d[key].pop(next(iter(d[key])));refuse(label,d,reason)
d=copy.deepcopy(data);d['children']['records.json']['path']=str(src/'records.json');refuse('stale-child-path',d,'child run path')
assert b.validate(data)['passed'];(run/'input.json').write_text(json.dumps(data,indent=2)+'\n');(run/'controls.json').write_text(json.dumps({'passed':True,'controls':results,'scope':'Report corruption controls on staged validator using preserved proof outputs; not a new proof run.'},indent=2)+'\n');print(run);print(len(results),'report controls passed')
