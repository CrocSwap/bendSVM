"""Corrupt report copies; never change the accepted build or its artifacts."""
from pathlib import Path
import copy,hashlib,json,os,sys
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'verification/sbf_division'));import validate as v
pointer_path=Path(os.environ['SBF_DIVISION_TEST_LATEST']);pointer=json.loads(pointer_path.read_text());root=Path(pointer['runRoot']);top_path=root/'report.json'
if v.sha(top_path)!=pointer['reportSha256']:raise RuntimeError('top binding')
top=json.loads(top_path.read_text());composition_file=next(Path(p) for p in top['reports'] if p.endswith('div4-composition-report.json'));scout=composition_file.parent;stage=scout.parents[1]
replay_file=next(Path(p) for p in top['reports'] if '/div4-replays/' in p);tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))
protected={str(p):v.sha(p) for p in [pointer_path,top_path,composition_file,replay_file]}
composition=json.loads(composition_file.read_text());replay=json.loads(replay_file.read_text())
cases=[('composition',composition,lambda d:v.composition(d,scout))]
for name in v.SCHEMA:
 if name!='div4-composition-report.json':cases.append((name,json.loads((scout/name).read_text()),lambda d,n=name:v.proof(d,n,stage)))
cases.append(('replay',replay,lambda d:v.replay(d,replay_file.parent,stage,tools)))
rows=[]
def refuse(name,original,check,mutate,reason):
 data=copy.deepcopy(original);mutate(data)
 try:check(data)
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((name,str(e),reason))
 else:raise RuntimeError('accepted '+name)
 rows.append({'name':name,'reason':reason})
for name,data,check in cases:
 check(data)
 for key in data:
  refuse(name+' missing '+key,data,check,lambda d,k=key:d.pop(k),'replay fields' if name=='replay' else 'proof field inventory')
 refuse(name+' false success',data,check,lambda d:d.update(passed=False),'replay status' if name=='replay' else 'proof status')
 refuse(name+' overclaim',data,check,lambda d:d.update(endToEndVerified=True),'replay status' if name=='replay' else 'proof status')
 refuse(name+' empty input bindings',data,check,lambda d:d.update(inputHashes={}),'binding inventory')
 refuse(name+' stale input binding',data,check,lambda d:d['inputHashes'].update({next(iter(d['inputHashes'])):'0'*64}),'binding drift')
 if name!='replay':
  refuse(name+' missing claim',data,check,lambda d:d['claims'].pop(),'claim inventory')
  refuse(name+' duplicate claim',data,check,lambda d:d['claims'].__setitem__(1,d['claims'][0]),'claim result or identity')
  refuse(name+' unknown solver',data,check,lambda d:d['claims'][0].update(result='unknown'),'claim result or identity')
  refuse(name+' wrong label',data,check,lambda d:d['claims'][0].update(name='other'),'claim result or identity')
check=lambda d:v.composition(d,scout)
for name,fn,reason in [
 ('missing prerequisite',lambda d:d['prerequisites'].pop(next(iter(d['prerequisites']))),'binding inventory'),
 ('missing fault',lambda d:d['boundaryFault'].update(result='unsat'),'boundary fault'),
 ('missing interface',lambda d:d['interfaces'].pop(),'proof structure interfaces'),
 ('wrong instruction count',lambda d:d.update(modeledInstructions=228),'proof structure modeledInstructions'),
 ('stale prerequisite log',lambda d:d.update(logSha256='0'*64),'composition log')]:refuse(name,composition,check,fn,reason)
check=lambda d:v.replay(d,replay_file.parent,stage,tools)
for name,fn,reason in [
 ('missing VM row',lambda d:d['rows'].pop(),'replay rows'),
 ('duplicate baseline',lambda d:d['rows'].__setitem__(1,d['rows'][0]),'duplicate baseline'),
 ('wrong VM inventory',lambda d:d.update(executions=72),'replay counts'),
 ('baseline failure',lambda d:d['rows'][0]['result'].update(ok=False),'replay outcome'),
 ('mutant accepted',lambda d:d['rows'][70]['result'].update(ok=True),'replay outcome'),
 ('wrong refusal code',lambda d:d['rows'][70]['result'].update(code=1),'replay refusal'),
 ('absent VM logs',lambda d:d['rows'][0]['result'].update(logs=[]),'replay logs'),
 ('wrong mutant input',lambda d:d['rows'][70].update(input=[0,0,0]),'mutant input'),
 ('missing artifact',lambda d:d['artifacts'].pop('baseline'),'replay artifacts'),
 ('empty artifact hashes',lambda d:d['artifacts']['baseline'].update(files={}),'binding inventory'),
 ('wrong body size',lambda d:d['artifacts']['baseline'].update(bodyBytes=1),'replay body structure'),
 ('stale body hash',lambda d:d['artifacts']['baseline'].update(bodySha256='0'*64),'replay body hash')]:refuse(name,replay,check,fn,reason)
for p,h in protected.items():
 if v.sha(p)!=h:raise RuntimeError('controls changed evidence')
report={'passed':True,'refusals':rows,'protectedHashes':protected,'sourceHashes':{str(p):v.sha(p) for p in [Path(__file__).resolve(),Path(v.__file__),Path(v.__file__).with_name('report-schema.json')]}}
output=Path(os.environ['SBF_DIVISION_TEST_DIR'])/'report-controls.json';output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'refusals':len(rows),'report':str(output),'sha256':v.sha(output)}))
