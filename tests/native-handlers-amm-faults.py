from pathlib import Path
import copy,hashlib,json,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
import modular_c as engine
from acyclic_c import mangle
receipt=json.loads(Path('build/native-handler-lowering/fresh-receipt.json').read_text());root=Path(receipt['inputArtifact']).parent;input_path=Path(receipt['inputArtifact']);report_path=Path(receipt['reportArtifact']);raw=input_path.read_bytes();data=json.loads(raw);report_raw=report_path.read_bytes();report=json.loads(report_raw);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert hashlib.sha256(raw).hexdigest()==receipt['inputSha256'] and hashlib.sha256(report_raw).hexdigest()==receipt['reportSha256']
assert report['passed'] and report['inputSha256']==hashlib.sha256(raw).hexdigest()
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
inputs={'sourceProof':report['prerequisite'],'canonicalModelBytes':data['sourceModels']['math'].encode(),'divisionProof':report['divisionPrerequisite'],'divisionModelBytes':data['sourceModels']['division'].encode()};program=next(p for p in data['programs'] if p['source']['source']=='examples/amm/PROOF.bend');original=program['artifact']['c'];rows=[]
def section(name,old,new):
 name=mangle(name);start=original.index(' '+name+'(');start=original.rfind('static ',0,start);end=original.index('\n}',start)+2;part=original[start:end];assert part.count(old)==1;return original[:start]+part.replace(old,new)+original[end:]
for label,fn,old,new in [
 ('authorization','amm.signed','return bend_amm_2e_Rejected_make(1u);','return bend_amm_2e_dispatch(a1, a2);'),
 ('slippage','amm.guard','return bend_amm_2e_Rejected_make(a1);','return a2;'),
 ('reserve-role','amm.base_out','TransferDetails_make(5u, 4u, 6u,','TransferDetails_make(8u, 4u, 6u,'),
]:
 p=copy.deepcopy(program);p['artifact']['c']=section(fn,old,new);p['artifact']['cSha256']=hashlib.sha256(p['artifact']['c'].encode()).hexdigest();result=engine.check(p,inputs)
 assert result['passed'] is False and result['claims'][-1]['function']==fn and result['claims'][-1]['result']=='sat'
 rows.append({'name':label,'cSha256':p['artifact']['cSha256'],'witness':result['claims'][-1]})
p=copy.deepcopy(program);old='(unsigned long long)a0 * (unsigned long long)a1';assert original.count(old)==1;p['artifact']['c']=original.replace(old,'(unsigned long long)a0 + (unsigned long long)a1');p['artifact']['cSha256']=hashlib.sha256(p['artifact']['c'].encode()).hexdigest()
try:engine.check(p,inputs)
except ValueError as e:assert str(e)=='native body mismatch';rows.append({'name':'native-product','cSha256':p['artifact']['cSha256'],'reason':str(e)})
else:raise AssertionError('fault accepted')
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert input_path.read_bytes()==raw and report_path.read_bytes()==report_raw
out={'passed':True,'inputSha256':hashlib.sha256(raw).hexdigest(),'prerequisiteReportSha256':hashlib.sha256(report_raw).hexdigest(),'checkerSha256':sha(Path(__file__)),'faults':rows,'scope':'Three source/C semantic mismatches and one native-template refusal; local modular witnesses are not automatically whole-program witnesses. Separate native replays test concrete complete-handler inputs.'}
(root/'amm-faults.json').write_text(json.dumps(out,indent=2)+'\n');print('Three AMM semantic mismatches and native product fault detected')
