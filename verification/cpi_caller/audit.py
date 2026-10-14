"""Validate a complete maintained CPI caller report and its exact input bindings."""
from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
from cpi_caller.report import validate
if not __debug__:raise RuntimeError('assertions required')
input_path,profiles_path,report_path,output=map(Path,sys.argv[1:])
output.unlink(missing_ok=True)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report=json.loads(report_path.read_text());payload=json.loads(input_path.read_text());profiles=json.loads(profiles_path.read_text())
validate(report,payload['fixtures'])
expected={str(p.resolve()) for p in [input_path,profiles_path,*Path('verification').rglob('*.py')]}
if set(report['inputs'])!=expected:raise ValueError('incomplete source/input inventory')
for collection in [report['inputs'],payload['immutableInputs'],profiles['inputs']]:
 for path,digest in collection.items():
  if sha(path)!=digest:raise ValueError('input drift: '+path)
result={'passed':True,'scope':__doc__,'inputSha256':sha(input_path),'profileSha256':sha(profiles_path),'reportSha256':sha(report_path),'auditorSha256':sha(__file__),'fixtures':3,'callerClaims':18,'rootClaims':3,'custodyClaims':3,'successWitnesses':6}
output.write_text(json.dumps(result,indent=2)+'\n')
print('Exact maintained CPI report and source/artifact bindings passed')
