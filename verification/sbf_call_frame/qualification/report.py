from pathlib import Path
import json,hashlib,sys,os,importlib.util
if not __debug__:raise RuntimeError('assertions required')
ROOT=Path('verification/sbf_call_frame').resolve()
OUT=Path(os.environ.get('SBF_FRAME_OUTPUT','build/sbf-call-frame')).resolve()
NAMES=['layout-report.json','footprint-report.json','connection-report.json']
SOURCES=[ROOT/n for n in ['model.py','layout.py','footprint.py','connect.py','qualification/report.py','qualification/controller.py','qualification/contract.json']]+[Path(p).resolve() for p in ['verification/sbf_elf.py','verification/sbf_handler/validate.py','verification/sbf_handler/report-schema.json','scripts/test-runner/Cargo.lock','verification/check-sbf-call-frame.ts','tests/sbf-call-frame.ts','tests/sbf-call-frame-reports.py','tests/sbf-call-frame-process.py','tests/sbf-call-frame-model.py']]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
read=lambda p:json.loads(Path(p).read_bytes())
def need(ok,why):
 if not ok:raise ValueError(why)
def normalized(d):
 d=dict(d);d.pop('inputs',None);d.pop('inputHashes',None)
 if 'controls' in d:d['controls']=[{k:v for k,v in row.items() if k!='witness'} for row in d['controls']]
 if 'control' in d:d['control']={k:v for k,v in d['control'].items() if k!='witness'}
 return d
def prerequisite(data):
 q=data['qualification'];need(set(q)=={'report','sha256'} and sha(q['report'])==q['sha256'],'handler receipt')
 h=read(q['report']);need(h['passed'] is True and h['endToEndVerified'] is False,'handler status')
 for key in ['sourceHashes','stagedSourceHashes','externalHashes','reports','logs']:
  for p,digest in h[key].items():need(sha(p)==digest,'handler binding drift')
 need(sha(h['quotientReport'])==h['quotientReportSha256'],'quotient binding')
 spec=importlib.util.spec_from_file_location('frame_handler_validator','verification/sbf_handler/validate.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
 ctx=module.context(h['quotientReport'],Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin'))))
 for p in h['reports']:module.validate(read(p),Path(p),ctx)
 quotient=read(h['quotientReport'])
 caller=next(p for p in quotient['reports'] if p.endswith('/caller-calls-report.json'))
 need(sha(caller)==quotient['reports'][caller],'caller binding')
 frames=[next(p for p in h['reports'] if p.endswith('/'+role+'-frame-report.json')) for role in ['claim-output','payout','authorization']]
 wrapper=next(p for p in h['reports'] if p.endswith('/memset-wrapper-report.json'))
 elf=next(p for p in read(wrapper)['inputHashes'] if p.endswith('/vesting.so'))
 return caller,frames,elf
def validate(data,manifest):
 need(set(data)=={'version','runId','runDirectory','sources','qualification','interpreter'},'input fields')
 need(type(data['version']) is int and data['version']==1,'input version')
 run=Path(data['runDirectory']);need(run.name==data['runId'],'run identity')
 need(set(data['sources'])==set(map(str,SOURCES)),'source inventory')
 for p,h in data['sources'].items():need(sha(p)==h,'source drift')
 need(set(data['interpreter'])=={'path','sha256'} and sha(data['interpreter']['path'])==data['interpreter']['sha256'],'interpreter identity')
 caller,frames,elf=prerequisite(data)
 need(set(manifest)==set(NAMES),'child inventory')
 schema=read(ROOT/'qualification/contract.json')
 expected={
  NAMES[0]:[ROOT/'layout.py',Path('scripts/test-runner/Cargo.lock').resolve(),Path(data['interpreter']['path'])],
  NAMES[1]:[ROOT/'footprint.py',Path(elf),Path('verification/sbf_elf.py').resolve(),ROOT/'model.py'],
  NAMES[2]:[run/NAMES[1],run/NAMES[0],ROOT/'connect.py',Path(caller),*map(Path,frames)]}
 for name in NAMES:
  item=manifest[name];need(set(item)=={'path','sha256'} and Path(item['path'])==run/name,'child path')
  need(sha(item['path'])==item['sha256'],'child hash')
  d=read(item['path']);need(d.get('passed') is True and d.get('endToEndVerified') is False,'child status')
  need(json.dumps(normalized(d),sort_keys=True)==json.dumps(schema[name],sort_keys=True),'claim/footprint/scope inventory '+name)
  maps=[k for k in ['inputs','inputHashes'] if k in d];need(len(maps)==1,'binding field inventory')
  bindings=d[maps[0]];need(type(bindings) is dict,'bindings type')
  need(len(bindings)==len(expected[name]) and {str(Path(p).resolve()) for p in bindings}==set(map(str,expected[name])),'child source inventory')
  for p,h in bindings.items():need(type(h) is str and sha(p)==h,'child source drift')
  controls=d.get('controls',[])+([d['control']] if 'control' in d else [])
  for control in controls:
   if control.get('result')=='sat':need(type(control.get('witness')) is str and bool(control['witness']),'counterexample witness')
 return {'passed':True,'endToEndVerified':False,'runId':data['runId'],'children':3,'scope':'Conditional call-frame layout, actual callee footprint and four caller-frame connections; trusted models, valid memory and VM CALL semantics remain.'}
if __name__=='__main__':print(json.dumps(validate(read(sys.argv[1]),read(sys.argv[2]))))
