from pathlib import Path
import sys,json,hashlib,copy
sys.path.insert(0,'verification')
from ranked_c import check,mangle
from ranked_report import validate
receipt=json.loads(Path('build/ranked-lowering/fresh-receipt.json').read_text());root=Path(receipt['inputArtifact']).parent
raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw);report_raw=Path(receipt['reportArtifact']).read_bytes()
assert hashlib.sha256(raw).hexdigest()==receipt['inputSha256'] and hashlib.sha256(report_raw).hexdigest()==receipt['reportSha256']
validate(json.loads(report_raw),data,raw)
program=next(p for p in data['programs'] if p['source']['source']=='examples/queue/PROOF.bend');original=program['artifact']['c'];rows=[]
sha=lambda b:hashlib.sha256(b).hexdigest()
def trial(label,function,old,new,claim):
 start=original.rfind('static ',0,original.index(' '+mangle(function)+'('));end=original.index('\n}',start)+2;part=original[start:end];assert part.count(old)==1
 p=copy.deepcopy(program);p['artifact']['c']=original[:start]+part.replace(old,new)+original[end:];p['artifact']['cSha256']=sha(p['artifact']['c'].encode())
 result=check(p)
 assert not result['passed'] and result['failedFunction']==function and result['failed']['name']==claim and result['failed']['result']=='sat',(label,result)
 (root/(label+'.c')).write_text(p['artifact']['c'])
 rows.append({'name':label,'function':function,'cSha256':p['artifact']['cSha256'],'failure':result['failed']})
loop='../../sdk/iteration.repeat~0'
trial('unchanged-fuel',loop,'(a0 - 1u)','a0','C-rank-decreases')
trial('underflow-fuel',loop,'(a0 - 1u)','(a0 - 2u)','C-rank-decreases')
trial('skip-state-update',loop,'a1 = next4;','a1 = a1;','equivalence-and-safety')
trial('omit-signer','queue.allowed','bend_Bool_2e_and((a0).as.c0.f1,','bend_Bool_2e_and(1u,','equivalence-and-safety')
trial('wrong-owner','queue.allowed','(a1).as.c0.f0','(a0).as.c0.f0','equivalence-and-safety')
trial('append-two','queue.append_ok','bend_U32_2e_add((a0).as.c0.f4, 1u)','bend_U32_2e_add((a0).as.c0.f4, 2u)','equivalence-and-safety')
trial('selection-wrong-cursor','queue.position','return ((a0).as.c2.f0).as.c0.f5;','return 0u;','equivalence-and-safety')
trial('selection-wrap-range','../../sdk/collection.fits','bend_U32_2e_is_5f_ge(a2, a0)','1u','equivalence-and-safety')
trial('selection-wrong-page','queue.select','(a2).as.c3.f0, 2u','1u, 2u','equivalence-and-safety')
assert (root/'input.json').read_bytes()==raw
for name,h in program['sourceHashes'].items():assert sha(Path(name).read_bytes())==h
(root/'queue-faults.json').write_text(json.dumps({'passed':True,'inputSha256':sha(raw),'reportSha256':receipt['reportSha256'],'checkerSha256':sha(Path(__file__).read_bytes()),'controls':rows,'scope':'Exact-function SAT controls; abstract summaries are not concrete whole-handler witnesses.'},indent=2)+'\n')
print('Nine queue generated-C faults detected')
