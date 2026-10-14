"""Staged acceptance of byte-connection child reports; not a proof producer."""
from pathlib import Path
import json,hashlib,sys
if not __debug__:raise RuntimeError('entry bundle assertions required')
sys.path.insert(0,'verification')
from loader_report import validate as lv,unchanged as lu
from collection_root_report import validate as cv,unchanged as cu
sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,why):
 if not ok:raise ValueError(why)
NAMES=['report.json','metadata.json','content.json','zero.json','records.json','binding-domain.json','binding-checks.json','metadata-controls.json','native.json']
SCRIPTS=['connect-summary.py','connect-metadata.py','connect-content.py','connect-zero.py','connect-records.py','binding-domain.py','check-summary-bindings.py','metadata-controls.py','qualification/prove-all.py','qualification/native_bundle.py']
ROOT=Path('verification/collection_entry')
# This reviewed schema is fixed independently of the candidate reports. It is
# versioned/hashes bound as validator input, not derived at acceptance time.
SPEC=ROOT/'qualification/report-contract.json'
def source_files():
 return [ROOT/n for n in SCRIPTS]+[ROOT/'qualification'/n for n in ['bundle_report.py','controller.py','fresh_report.py','report-contract.json']]+[Path('tests/collection-entry-native.h'),Path('verification/check-collection-entry.ts')]
def compact(report):
 d=dict(report)
 for k in ('loaderInputSha256','collectionInputSha256','checkerSha256'):d.pop(k,None)
 if 'controls' in d:
  d['controls']=[{k:v for k,v in row.items() if k!='witness'} for row in d['controls']]
 return d

def validate(data):
 need(set(data)=={'version','runId','runDirectory','sources','prerequisites','children','nativeCompiler'},'bundle input fields')
 need(type(data['version']) is int and data['version']==1,'bundle version')
 run=Path(data['runDirectory']);need(run.name==data['runId'],'bundle run identity')
 required={str(p) for p in source_files()}
 need(set(data['sources'])==required,'bundle source inventory')
 for p,h in data['sources'].items():need(sha(Path(p).read_bytes())==h,'bundle source drift: '+p)
 need(set(data['prerequisites'])=={'loader','collection'},'bundle prerequisite inventory')
 inputs={}
 for name,validator,unchanged in [('loader',lv,lu),('collection',cv,cu)]:
  rec=data['prerequisites'][name];need(set(rec)=={'inputArtifact','inputSha256','reportArtifact','reportSha256'},'prerequisite fields')
  raw=Path(rec['inputArtifact']).read_bytes();rep=Path(rec['reportArtifact']).read_bytes()
  need(sha(raw)==rec['inputSha256'] and sha(rep)==rec['reportSha256'],'prerequisite hash')
  child=json.loads(raw);validator(json.loads(rep),child,raw);unchanged(child);inputs[name]=rec['inputSha256']
 spec=json.loads(SPEC.read_text());need(set(spec)==set(NAMES)-{'native.json'},'contract inventory')
 need(set(data['children'])==set(NAMES),'child inventory')
 for name in NAMES:
  item=data['children'][name];need(set(item)=={'path','sha256'},'child fields')
  need(Path(item['path'])==run/name,'child run path')
  raw=Path(item['path']).read_bytes();need(sha(raw)==item['sha256'],'child artifact hash')
  report=json.loads(raw)
  if name=='native.json':
   from native_bundle import validate as nv
   nv(report,data);continue
  if name in ('binding-checks.json','metadata-controls.json'):
   script='check-summary-bindings.py' if name=='binding-checks.json' else 'metadata-controls.py'
   need(report.get('checkerSha256')==data['sources'][str(ROOT/script)],'child checker binding')
  need(report.get('passed') is True,'child success type')
  need(report.get('loaderInputSha256')==inputs['loader'] and report.get('collectionInputSha256')==inputs['collection'],'child prerequisite binding')
  # Witness models are diagnostic text, not accepted as proofs of satisfiability.
  for control in report.get('controls',[]):
   need(set(control) in ({'name','result','witness'},{'name','reason'}),'control fields')
   if 'witness' in control:need(isinstance(control['witness'],str) and bool(control['witness']),'control witness diagnostic')
  need(compact(report)==spec[name],'child claim inventory/results/scope: '+name)
 return {'passed':True,'endToEndVerified':False,'version':1,'runId':data['runId'],'children':len(NAMES),'scope':'Exact report acceptance for the serialized collection fixture; no compiler, full-memory or SBF theorem.'}
if __name__=='__main__':
 p=Path(sys.argv[1]);raw=p.read_bytes();d=json.loads(raw);result=validate(d);need(p.read_bytes()==raw,'input changed');print(json.dumps(result))
