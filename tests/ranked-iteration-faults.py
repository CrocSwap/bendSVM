from pathlib import Path
import copy,hashlib,json,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from ranked_c import check,mangle
from ranked_report import validate
from adapter_contract_c import Grammar
receipt=json.loads(Path('build/ranked-lowering/fresh-receipt.json').read_text())
root=Path(receipt['inputArtifact']).parent
raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw)
report_raw=Path(receipt['reportArtifact']).read_bytes()
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert receipt['passed'] and hashlib.sha256(raw).hexdigest()==receipt['inputSha256'] and hashlib.sha256(report_raw).hexdigest()==receipt['reportSha256']
validate(json.loads(report_raw),data,raw)
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
program=data['programs'][1];original=program['artifact']['c'];rows=[]
for label,name,old,new in [
 ('sequential-swap','rotate','a2 = next8;','a2 = a1;'),
 ('lost-swap','rotate','bend_u32 next7 = a2;','bend_u32 next7 = a1;'),
 ('skip-toggle','../sdk/iteration.repeat~2','a1 = next5;','a1 = a1;'),
 ('noncanonical-bool','../sdk/iteration.repeat~2','a1 = next5;','a1 = 2u;'),
]:
 start=original.index(' '+mangle(name)+'(');start=original.rfind('static ',0,start);end=original.index('\n}',start)+2;part=original[start:end];assert part.count(old)==1
 p=copy.deepcopy(program);c=original[:start]+part.replace(old,new)+original[end:];p['artifact']['c']=c;p['artifact']['cSha256']=hashlib.sha256(c.encode()).hexdigest()
 result=check(p);assert not result['passed'] and result['failedFunction']==name and result['failed']['name']=='equivalence-and-safety' and result['failed']['result']=='sat',result
 (root/(label+'.c')).write_text(c);rows.append({'name':label,'function':name,'cSha256':p['artifact']['cSha256'],'outcome':result['failed']})

for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert Path(receipt['inputArtifact']).read_bytes()==raw and Path(receipt['reportArtifact']).read_bytes()==report_raw
out={'passed':True,'inputSha256':receipt['inputSha256'],'reportSha256':receipt['reportSha256'],'checkerSha256':sha(Path(__file__)),'faults':rows}
(root/'iteration-faults.json').write_text(json.dumps(out,indent=2)+'\n')
print('iteration:',len(rows),'semantic faults detected')
