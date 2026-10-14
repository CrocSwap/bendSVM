"""Staged bounded shared-lemma producer for per-handler physical qualification."""
from pathlib import Path
import sys,json,runpy,hashlib
sys.path.insert(0,'verification')
from multi_token_composition.common import begin,finish,sha,snapshot
from loader_report import validate,unchanged
base=Path(__file__).resolve().parent
source_paths=[base/n for n in ('physical_shared.py','physical_handler.py','physical_cache.py','physical_primitives.py','physical_snapshot.py','physical_queries.json')]
component_sources={str(p.resolve()):sha(p) for p in source_paths}
data,binding,out=begin(sys.argv[1],sys.argv[2]);root=out.parent
receipt=Path(sys.argv[3]).resolve();receipt_hash=sha(receipt);r=json.loads(receipt.read_text())
raw=Path(r['inputArtifact']).read_bytes();loader_input=json.loads(raw)
assert hashlib.sha256(raw).hexdigest()==r['inputSha256'] and sha(r['reportArtifact'])==r['reportSha256']
validate(json.loads(Path(r['reportArtifact']).read_text()),loader_input,raw);unchanged(loader_input)
saved=sys.argv
try:
 sys.argv=['verification/loader_model.py',r['inputArtifact'],str(root/'loader-replay.json')];ld=runpy.run_path('verification/loader_model.py',run_name='__main__')
finally:sys.argv=saved
api=runpy.run_path(str(base/'physical_cache.py'));primitives=runpy.run_path(str(base/'physical_primitives.py'));snapshots=runpy.run_path(str(base/'physical_snapshot.py'))
names=json.loads((base/'physical_queries.json').read_text());sources={**binding['sourceHashes'],**component_sources};qualification=str(root.resolve())
caches={};receipts={}
for name in names:caches[name]=api['Producer'](root/('cache-'+name),qualification,sources,names[name])
folder=root/'primitives';folder.mkdir();primitive_report=primitives['prove'](ld,folder,caches)
folder=root/'snapshots';folder.mkdir();snapshot_report,_=snapshots['prove'](folder,caches['snapshots'])
for name,cache in caches.items():receipts[name]=cache.finish()
assert sha(receipt)==receipt_hash;unchanged(loader_input)
extra={**component_sources,str(receipt):receipt_hash,r['inputArtifact']:r['inputSha256'],r['reportArtifact']:r['reportSha256'],str(root/'loader-replay.json'):sha(root/'loader-replay.json')}
for cache in receipts.values():
 folder=Path(cache['folder']);extra[str(folder/'manifest.json')]=cache['manifestSha256']
 for query in folder.glob('*.smt2'):extra[str(query)]=sha(query)
rows=[{'qualification':qualification,'sourceHashes':sources,'receipts':receipts,'primitives':primitive_report,'snapshots':snapshot_report}]
finish(data,binding,out,'staged-physical-shared',rows,extra)
