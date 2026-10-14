"""Assemble completed bounded physical phases into the serialized child report."""
if not __debug__:raise RuntimeError('assertions required')
from pathlib import Path
import sys,json,copy,shutil,runpy
sys.path.insert(0,'verification')
from multi_token_composition.common import begin,finish,sha,NAMES,SCOPE,need
from multi_token_composition.report import exact
import multi_adapter_contract as adapter
base=Path(__file__).resolve().parent;driver_hash=sha(__file__);validator=base/'physical_report.py';validator_hash=sha(validator)
data,binding,out=begin(sys.argv[1],sys.argv[2]);folder=out.parent
receipt=Path(sys.argv[3]).resolve();receipt_hash=sha(receipt)
validate=runpy.run_path(str(validator))['physical'];phases={};extra={str(Path(__file__).resolve()):driver_hash,str(validator):validator_hash}
for name in ['shared',*NAMES]:
 path=folder/name/'report.json';phase=json.loads(path.read_text())
 exact(sorted(phase),['binding','extraInputs','fixtures','kind','passed','scope'])
 exact(phase['passed'],True);exact(phase['scope'],SCOPE);exact(phase['binding'],binding)
 exact(phase['kind'],'staged-physical-shared' if name=='shared' else 'staged-physical-handler')
 exact(len(phase['fixtures']),1)
 for p,h in phase['extraInputs'].items():
  exact(sha(p),h)
  if p in extra:exact(extra[p],h)
  extra[p]=h
 extra[str(path)]=sha(path);phases[name]=phase
shared=phases['shared']['fixtures'][0];exact(shared['qualification'],str(folder/'shared'))
rows=[]
for name,f in zip(NAMES,data['fixtures']):
 row=copy.deepcopy(phases[name]['fixtures'][0]);exact(row['name'],name)
 summary=adapter.summarize(f['schema'],f['interface']);managed=[x['index'] for x in summary['fields']];lengths={x['index']:x['stateBytes'] for x in summary['fields']}
 validate(row['physical'],int(name[-1]),managed,lengths)
 reuse_path=folder/name/'cache-reuse.json';reuse=json.loads(reuse_path.read_text());exact(sorted(reuse),sorted(shared['receipts']))
 for group,entry in reuse.items():exact(entry['manifestSha256'],shared['receipts'][group]['manifestSha256'])
 for witness in row['activeWitnesses']:
  original=folder/name/(name+'-mode'+str(witness['mode'])+'.smt2');exact(witness['queryArtifact'],str(original));exact(sha(original),witness['querySha256'])
  public=folder/original.name;shutil.copyfile(original,public);exact(sha(public),witness['querySha256']);witness['queryArtifact']=str(public);extra[str(public)]=sha(public)
 rows.append(row)
public_receipt=folder/'loader-receipt.json'
if receipt!=public_receipt:shutil.copyfile(receipt,public_receipt)
exact(sha(public_receipt),receipt_hash);extra[str(public_receipt)]=receipt_hash
replay=folder/'loader-replay.json';shutil.copyfile(folder/'shared/loader-replay.json',replay);extra[str(replay)]=sha(replay)
exact(sha(receipt),receipt_hash);exact(sha(__file__),driver_hash);exact(sha(validator),validator_hash)
# Full phase/cache/query inventory validation remains the serialized report
# validator's responsibility; assembly cannot by itself publish a receipt.
finish(data,binding,out,'serialized',rows,extra)
