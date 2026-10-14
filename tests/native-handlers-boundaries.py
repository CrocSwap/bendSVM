import copy,hashlib,json,pathlib,sys
sys.path[:0]=[str(pathlib.Path(__file__).resolve().parent.parent/'verification'),'verification']
import modular_c as engine
from acyclic_c import mangle
receipt=json.loads(pathlib.Path('build/native-handler-lowering/fresh-receipt.json').read_text())
raw=pathlib.Path(receipt['inputArtifact']).read_bytes();assert hashlib.sha256(raw).hexdigest()==receipt['inputSha256'];data=json.loads(raw)
report_raw=pathlib.Path(receipt['reportArtifact']).read_bytes();assert hashlib.sha256(report_raw).hexdigest()==receipt['reportSha256'];report=json.loads(report_raw)
base=pathlib.Path(receipt['reportArtifact']).parent;p=data['programs'][0]
inputs={'sourceProof':report['prerequisite'],'canonicalModelBytes':data['sourceModels']['math'].encode(),'divisionProof':report['divisionPrerequisite'],'divisionModelBytes':data['sourceModels']['division'].encode()}
rows=[]
for name,edit,reason in [
 ('missing-native-certificate',lambda q,i:None,'not default production C'),
 ('missing-proof-source-hashes',lambda q,i:i['sourceProof'].update(hashes={}),'source proof hash inventory'),
 ('missing-handler-source-hashes',lambda q,i:q.update(sourceHashes={}),'handler source hash inventory'),
 ('unknown-source-proof',lambda q,i:i['sourceProof']['positive']['claims'][0].update(result='unknown'),'source proof inventory'),
 ('wrong-canonical-model',lambda q,i:i.update(canonicalModelBytes=b'{}'),'canonical model binding'),
 ('source-cycle',lambda q,i:q['source']['functions'][q['source']['roots'][0]].update(body={'$':'Ref','k':q['source']['roots'][0]}),'recursive source closure'),
 ('unaccounted-function',lambda q,i:q['source']['functions'].update(unreachable=copy.deepcopy(q['source']['functions'][q['source']['roots'][0]])),'unreachable function inventory'),
 ('unproved-C-self-call',lambda q,i:q['artifact'].update(c=q['artifact']['c'].replace('return a1;','return '+mangle('vesting.authorize')+'(a0, a1);',1)),'unproved C callee vesting.authorize'),
 ('extra-C-function',lambda q,i:q['artifact'].update(c=q['artifact']['c']+'\nstatic inline bend_u32 injected(bend_u32 a0) { return a0; }\n'),'unexpected/duplicate function definition'),
]:
 q=copy.deepcopy(p);i=copy.deepcopy(inputs);edit(q,i)
 q['artifact']['cSha256']=hashlib.sha256(q['artifact']['c'].encode()).hexdigest()
 try:engine.check(q,None if name=='missing-native-certificate' else i)
 except ValueError as e:assert str(e)==reason,(name,str(e));rows.append({'name':name,'reason':str(e)})
 else:raise AssertionError('accepted '+name)
semantic_faults=[]
# The AMM-specific controls exercise signed dispatch and reserve roles separately.
assert [p['source']['source'] for p in data['programs']]==['examples/vesting/PROOF.bend','examples/exchange/PROOF.bend','examples/amm/PROOF.bend']
for program in data['programs'][:2]:
 q=copy.deepcopy(program);c=q['artifact']['c']
 auths=[n for n in q['source']['functions'] if n.endswith('.authorize')];assert len(auths)==1;auth=auths[0]
 outcome=q['source']['functions'][auth]['result'];types=q['source']['schema']['types'];t=next(t for t in types if t['name']==outcome)
 rejected=next(v['cMaker'] for v in t['variants'] if v['name'].endswith('.Rejected'));refusal='return '+rejected+'(1u);'
 start=c.index('static inline '+t['cType']+' '+mangle(auth)+'(');end=c.index('\n}',start)+2
 body=c[start:end];assert body.count(refusal)==1
 q['artifact']['c']=c[:start]+body.replace(refusal,'return a1;')+c[end:]
 q['artifact']['cSha256']=hashlib.sha256(q['artifact']['c'].encode()).hexdigest()
 result=engine.check(q,inputs)
 assert result['passed'] is False and result['claims'][-1]['function']==auth and result['claims'][-1]['result']=='sat'
 semantic_faults.append({'fixture':q['artifact']['fixture'],'mutation':'authorization','cSha256':q['artifact']['cSha256'],'witness':result['claims'][-1]})
 q=copy.deepcopy(program);old='(unsigned long long)a0 * (unsigned long long)a1';assert q['artifact']['c'].count(old)==1
 q['artifact']['c']=q['artifact']['c'].replace(old,'(unsigned long long)a0 + (unsigned long long)a1')
 q['artifact']['cSha256']=hashlib.sha256(q['artifact']['c'].encode()).hexdigest()
 try:engine.check(q,inputs)
 except ValueError as e:assert str(e)=='native body mismatch'
 else:raise AssertionError('native product fault accepted')
 semantic_faults.append({'fixture':q['artifact']['fixture'],'mutation':'native-product','cSha256':q['artifact']['cSha256'],'reason':'native body mismatch'})
# Force an inconclusive function solver after validating artifact/layout checks.
engine.check_artifacts([p['artifact']]);engine.check_layouts([p['artifact']])
original=(engine.z.Solver,engine.check_artifacts,engine.check_layouts)
class Unknown:
 def set(self,**kwargs):pass
 def add(self,*args):pass
 def check(self):return engine.z.unknown
 def reason_unknown(self):return 'injected UNKNOWN'
try:
 engine.z.Solver=Unknown;engine.check_artifacts=lambda a:None;engine.check_layouts=lambda a:None
 result=engine.check(p,inputs)
 assert result['passed'] is False and result['claims'][-1]['result']=='unknown'
finally:engine.z.Solver,engine.check_artifacts,engine.check_layouts=original
(base/'boundary-controls.json').write_text(json.dumps({'passed':True,'refusals':rows,'solverUnknownRefused':True,'semanticFaults':semantic_faults,'candidateHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in [pathlib.Path(engine.__file__),pathlib.Path(__file__)]}},indent=2)+'\n')
print('Nine boundaries, four semantic faults and function solver UNKNOWN rejected')
