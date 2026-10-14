from pathlib import Path
import copy,json,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from collection_root_report import validate,unchanged,sha
root=Path(sys.argv[1]);raw=(root/'input.json').read_bytes();data=json.loads(raw);report_raw=(root/'semantic.json').read_bytes();report=json.loads(report_raw)
unchanged(data);validate(report,data,raw);rows=[]
def refuse(name,mutate,reason):
 r=copy.deepcopy(report);mutate(r)
 try:validate(r,data,raw)
 except ValueError as e:
  assert reason in str(e),(name,str(e),reason)
  rows.append({'name':name,'reason':reason})
 else:raise AssertionError('accepted '+name)
for name,mutate,reason in [
 ('false-success',lambda r:r.update(passed=False),'report scope'),
 ('end-to-end',lambda r:r.update(endToEndVerified=True),'report scope'),
 ('scope',lambda r:r.update(scope='verified'),'report scope'),
 ('extra-field',lambda r:r.update(extra=1),'report fields'),
 ('boolean-version',lambda r:r.update(version=True),'report version'),
 ('solver-version',lambda r:r.update(z3='other'),'report version'),
 ('stale-run',lambda r:r.update(runId='stale'),'run/input binding'),
 ('stale-input',lambda r:r.update(inputSha256='stale'),'run/input binding'),
 ('stale-checker',lambda r:r.update(checkerSha256='stale'),'checker binding'),
 ('missing-source',lambda r:r.update(sourceHashes={}),'source binding'),
 ('boolean-caller-count',lambda r:r.update(callerClaims=True),'caller count'),
 ('boolean-binding-count',lambda r:r.update(bindingOutputs=True),'binding inventory'),
 ('missing-function',lambda r:r['lowering']['claims'].pop(),'function inventory/order'),
 ('unknown-function-proof',lambda r:r['lowering']['claims'][0]['checks'][0].update(result='unknown'),'unproved obligation'),
]:refuse(name,mutate,reason)
for field,reason in [('callerProofs','caller obligation inventory/results'),('claims','connected obligation inventory/results'),
 ('witnesses','reachability witnesses'),('semanticClaims','semantic claim inventory/results'),('bindingNames','binding inventory')]:
 refuse(field+'-missing',lambda r,f=field:r[f].pop(),reason)
 refuse(field+'-duplicate',lambda r,f=field:r[f].append(copy.deepcopy(r[f][0])),reason)
 refuse(field+'-reorder',lambda r,f=field:r[f].reverse(),reason)
 if field!='bindingNames':
  refuse(field+'-unknown',lambda r,f=field:r[f][0].update(result='unknown'),reason)
  refuse(field+'-extra',lambda r,f=field:r[f][0].update(extra=True),reason)
unchanged(data);assert (root/'semantic.json').read_bytes()==report_raw
out=root/'strict-report-controls.json'
with out.open('x') as f:json.dump({'passed':True,'inputSha256':sha(raw),'reportSha256':sha(report_raw),'refusals':rows},f,indent=2)
print(len(rows),'report corruptions refused for exact expected reasons')
