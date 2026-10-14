from pathlib import Path
import sys,json,copy,hashlib
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from loader_report import validate,unchanged
root=Path(sys.argv[1]);raw=(root/'input.json').read_bytes();data=json.loads(raw);report=json.loads((root/'report.json').read_bytes());unchanged(data);validate(report,data,raw);rows=[]
def refuse(name,mutate,reason):
 r=copy.deepcopy(report);mutate(r)
 try:validate(r,data,raw)
 except ValueError as error:assert reason in str(error),(name,error);rows.append({'name':name,'reason':reason})
 else:raise AssertionError('accepted '+name)
for name,mutate,reason in [
 ('false-success',lambda r:r.update(passed=False),'report scope'),('scope-inflation',lambda r:r.update(endToEndVerified=True),'report scope'),
 ('wrong-scope',lambda r:r.update(scope='all compiled SBF verified'),'report scope'),('extra-field',lambda r:r.update(extra=True),'report fields'),
 ('boolean-version',lambda r:r.update(version=True),'report version'),('solver-version',lambda r:r.update(z3='other'),'report version'),
 ('stale-run',lambda r:r.update(runId='other'),'run/input binding'),('stale-input',lambda r:r.update(inputSha256='other'),'run/input binding'),
 ('missing-source',lambda r:r.update(sourceHashes={}),'source binding'),('wrong-header',lambda r:r.update(headerSha256='other'),'header binding'),
 ('missing-claim',lambda r:r['claims'].pop(),'claim inventory/results'),('duplicate-claim',lambda r:r['claims'].append(copy.deepcopy(r['claims'][0])),'claim inventory/results'),
 ('reordered-claims',lambda r:r['claims'].reverse(),'claim inventory/results'),('unknown-claim',lambda r:r['claims'][0].update(result='unknown'),'claim inventory/results'),
 ('sat-claim',lambda r:r['claims'][0].update(result='sat'),'claim inventory/results'),('extra-claim-field',lambda r:r['claims'][0].update(extra=True),'claim inventory/results'),
 ('vacuous-success',lambda r:r.update(successWitness='unsat'),'success witness'),('unknown-success',lambda r:r.update(successWitness='unknown'),'success witness'),
]:refuse(name,mutate,reason)
unchanged(data)
with (root/'report-controls.json').open('x') as stream:json.dump({'passed':True,'reportSha256':hashlib.sha256((root/'report.json').read_bytes()).hexdigest(),'refusals':rows},stream,indent=2)
print(len(rows),'report corruptions refused for exact reasons')
