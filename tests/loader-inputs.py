from pathlib import Path
import sys,json,copy
sys.path.insert(0,'verification')
from loader_report import validate,unchanged,sha
root=Path(sys.argv[1]);raw=(root/'input.json').read_bytes();data=json.loads(raw);report=json.loads((root/'report.json').read_bytes());unchanged(data);validate(report,data,raw);rows=[]
def refuse(name,mutation,reason):
 d=copy.deepcopy(data);r=copy.deepcopy(report);mutation(d);r['sourceHashes']=copy.deepcopy(d['sourceHashes']);edited=json.dumps(d).encode();r['inputSha256']=sha(edited)
 try:validate(r,d,edited)
 except ValueError as error:assert reason in str(error),(name,error);rows.append({'name':name,'reason':reason})
 else:raise AssertionError('accepted '+name)
for path in ['runtime/solana_min.h','verification/adapter_contract_c.py','verification/collection_caller_syntax.py','verification/check-loader.ts',*['verification/'+n for n in ['loader_model.py','loader_profile.py','loader_report.py']]]:
 refuse('missing '+path,lambda d,p=path:d['sourceHashes'].pop(p),'required source inventory')
for name,mutation,reason in [
 ('extra input field',lambda d:d.update(extra=True),'input fields'),
 ('boolean input version',lambda d:d.update(version=True),'input identity'),
 ('empty run id',lambda d:d.update(runId=''),'input identity'),
 ('short source hash',lambda d:d['sourceHashes'].update({'runtime/solana_min.h':'abc'}),'source hash format'),
 ('missing frontend unit',lambda d:d['cSyntax'].pop('unit'),'frontend inventory'),
 ('failed frontend',lambda d:d['cSyntax'].update(exitCode=1),'frontend status'),
 ('boolean frontend status',lambda d:d['cSyntax'].update(exitCode=False),'frontend status'),
 ('different header directory',lambda d:d.update(headerArtifact='elsewhere/solana_min.h'),'frontend header directory'),
]:refuse(name,mutation,reason)
unchanged(data)
with (root/'input-controls.json').open('x') as stream:json.dump({'passed':True,'inputSha256':sha(raw),'refusals':rows},stream,indent=2)
print(len(rows),'malformed input/source inventories refused despite resealed input/report hashes')
