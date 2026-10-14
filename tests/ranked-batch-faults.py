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
program=data['programs'][0];original=program['artifact']['c'];rows=[]
original=program['artifact']['c']; name='../../sdk/iteration.repeat~0'
start=original.index(' '+mangle(name)+'('); start=original.rfind('static ',0,start); end=original.index('\n}',start)+2
part=original[start:end]; rows=[]
def trial(label,old,new,expected):
 assert part.count(old)==1,(label,old)
 p=copy.deepcopy(program); p['artifact']['c']=original[:start]+part.replace(old,new)+original[end:]
 p['artifact']['cSha256']=hashlib.sha256(p['artifact']['c'].encode()).hexdigest()
 try:
  result=check(p)
 except (ValueError, Grammar) as exc:
  assert expected in str(exc),(label,str(exc)); outcome={'refusal':str(exc)}
 else:
  assert expected in ('C-rank-decreases','equivalence-and-safety'),(label,result)
  assert not result['passed'] and result['failedFunction']==name and result['failed']['name']==expected and result['failed']['result']=='sat',(label,result)
  outcome=result['failed']
 rows.append({'name':label,'cSha256':p['artifact']['cSha256'],'outcome':outcome})
trial('unchanged-fuel','(a0 - 1u)','a0','C-rank-decreases')
trial('fuel-increment','(a0 - 1u)','(a0 + 1u)','C-rank-decreases')
trial('fuel-underflow','(a0 - 1u)','(a0 - 2u)','C-rank-decreases')
trial('skipped-state-update','a1 = next4;','a1 = a1;','equivalence-and-safety')
trial('premature-continue','a0 = next3;','continue;\n        a0 = next3;','C-rank-decreases')
trial('missing-continue','continue;','','missing recursive/continue boundary')
trial('conditional-fallthrough','continue;','if (a0 != 0u) { continue; }','equivalence-and-safety')
trial('wrong-base-result','return a1;','return '+mangle('../../sdk/fold.advance~0')+'(a1);','equivalence-and-safety')
trial('nested-loop','continue;','for (;;) { continue; }','unadmitted or nested loop')
trial('self-call','continue;','return '+mangle(name)+'(a0, a1);','unproved C callee')
trial('unsupported-while','for (;;)','while (1u)',"syntax: expected identifier, found 'while'")
p=copy.deepcopy(program)
call=p['source']['functions'][name]['body']['m']['h']['f']['f']['f']
assert call['$']=='App' and call['f']=={'$':'Ref','k':name}
call['x']={'$':'Nat','value':1}
result=check(p)
assert not result['passed'] and result['failedFunction']==name and result['failed']['name']=='source-rank-decreases' and result['failed']['result']=='sat'
rows.append({'name':'nondecreasing-source-recursion','outcome':result['failed']})

for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert Path(receipt['inputArtifact']).read_bytes()==raw and Path(receipt['reportArtifact']).read_bytes()==report_raw
out={'passed':True,'inputSha256':receipt['inputSha256'],'reportSha256':receipt['reportSha256'],'checkerSha256':sha(Path(__file__)),'faults':rows}
(root/'batch-faults.json').write_text(json.dumps(out,indent=2)+'\n')
print('batch:',len(rows),'semantic faults detected')
