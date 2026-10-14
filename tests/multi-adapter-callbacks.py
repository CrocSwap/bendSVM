"""Explicit proof callback interface; default/delegated equivalence."""
from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
import multi_adapter_contract as m
assert __debug__
if len(sys.argv)!=3:raise SystemExit('usage: tests/multi-adapter-callbacks.py INPUT REPORT')
p=Path(sys.argv[1]);output=Path(sys.argv[2]);f=json.loads(p.read_text())['fixtures'][0];summary=m.summarize(f['schema'],f['interface'])
base=m.analyse(summary,f,f['files'],require_witnesses=False);print('default passed',flush=True)
partitions=[];claims=[]
def partition(world,name,formula):
 partitions.append(name);return world.feasible(formula)
def claim(world,name,formula):
 claims.append(name);return m.check_unsat(world,name,formula)
delegated=m.analyse(summary,f,f['files'],require_witnesses=False,partition_check=partition,claim_check=claim)
assert partitions==['path totality','path disjointness'];assert claims==list(base['claims'])
for key in base:
 if key!='seconds':assert base[key]==delegated[key],key
print('delegated callbacks preserve all report fields except elapsed time',flush=True)
class InjectedFailure(RuntimeError):pass
def refuse(*args):raise InjectedFailure('injected partition refusal')
try:m.analyse(summary,f,f['files'],require_witnesses=False,partition_check=refuse)
except InjectedFailure:pass
else:raise AssertionError('swallowed callback failure')
files=[p,Path(__file__),Path('verification/multi_adapter_contract.py')]
output.write_text(json.dumps({'passed':True,'partitionCalls':partitions,'claimCalls':claims,'callbackFailurePropagates':True,'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}},indent=2)+'\n')
