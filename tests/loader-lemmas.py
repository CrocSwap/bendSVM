"""Fail closed when a fresh rent-value proof dependency is missing or inconclusive."""
from pathlib import Path
import sys,json,subprocess,uuid
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from loader_report import validate,unchanged,sha
receipt=json.loads(Path('build/loader/fresh-receipt.json').read_bytes());raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw);report=json.loads(Path(receipt['reportArtifact']).read_bytes());validate(report,data,raw);unchanged(data)
source=Path('verification/loader_model.py');original=source.read_text();root=Path(receipt['inputArtifact']).parent/('lemma-controls-'+str(uuid.uuid4()));root.mkdir();rows=[]
variants=[
 ('missing-reader-proof',' proven[name]=condition'," if name!='read-le8':proven[name]=condition","KeyError: 'read-le8'"),
 ('missing-address-proof',' proven[name]=condition'," if name!='rent-address':proven[name]=condition","KeyError: 'rent-address'"),
 ('unknown-reader-proof','status=solver.check();',"status=z.unknown if name=='read-le8' else solver.check();",'read-le8 unknown'),
 ('wrong-rent-value','le(rent_offset)==specification_le(expected_rent),True,lemmas=rent_lemmas','le(rent_offset)==specification_le(expected_rent+v(1)),True,lemmas=rent_lemmas','rent-value sat'),
]
for name,old,new,reason in variants:
 assert original.count(old)==1,(name,'mutation anchor')
 run=root/name;run.mkdir();mutant=run/'model.py';mutant.write_text(original.replace(old,new));output=run/'unexpected.json'
 result=subprocess.run([sys.executable,'-B',str(mutant),receipt['inputArtifact'],str(output)],capture_output=True,text=True,timeout=90)
 log=run/'proof.log';log.write_text(result.stdout+result.stderr)
 assert result.returncode==1 and reason in log.read_text() and not output.exists(),(name,result.returncode,log.read_text())
 rows.append({'name':name,'reason':reason,'exitCode':result.returncode,'files':{str(p):sha(p.read_bytes()) for p in run.iterdir()}})
unchanged(data)
with Path(sys.argv[1]).open('x') as stream:json.dump({'passed':True,'inputSha256':receipt['inputSha256'],'reportSha256':receipt['reportSha256'],'modelSha256':sha(source.read_bytes()),'controls':rows},stream,indent=2)
print('Four loader lemma dependency/failure controls passed')
