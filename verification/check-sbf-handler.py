"""Fresh conditional native handler qualification, with whole-output VM tests.

The public focused gate adds report-corruption and process-failure controls.
This does not establish a whole-handler/source/adapter/commit/compiler theorem.
"""
from pathlib import Path
import hashlib,json,os,subprocess,sys,uuid
repo=Path(__file__).resolve().parents[1];base=repo/'verification/sbf_handler'
output=Path(os.environ.get('SBF_HANDLER_OUTPUT',repo/'build/sbf-handler')).resolve();run=output/'runs'/str(uuid.uuid4());run.mkdir(parents=True);latest=output/'latest.json'
if latest.exists():os.replace(latest,run/'previous-latest.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,msg):
 if not ok:raise RuntimeError(msg)
def bindings(mapping):
 need(type(mapping) is dict and bool(mapping),'empty bindings')
 for p,h in mapping.items():need(type(h) is str and sha(p)==h,'binding drift: '+p)
def command(args,log,cwd,env=None,timeout=900):
 child=subprocess.run(args,cwd=cwd,env=env,capture_output=True,text=True,timeout=timeout);log.write_text(child.stdout+child.stderr)
 need(child.returncode==0,'command failed: '+str(log));return child.stdout
try:
 need(__debug__,'assertions required')
 sys.path.insert(0,str(base))
 import validate as handler_validator
 from sbf_zero_fill_report import validate as validate_zero_fill
 from sbf_zero_fill_connection import connect as connect_zero_fill
 templates=json.loads((base/'templates.json').read_text());phases=json.loads((base/'phases.json').read_text())
 inputs=[Path(__file__),base/'templates.json',base/'phases.json',base/'validate.py',base/'report-schema.json',repo/'verification/sbf_elf.py',repo/'verification/check-sbf-quotient.py',repo/'verification/sbf_output.py',repo/'tests/sbf-output.py',repo/'verification/check-sbf-zero-fill.py',repo/'verification/sbf_zero_fill_report.py',repo/'verification/sbf_zero_fill_connection.py']+[base/p for p in templates]
 source={str(p):sha(p) for p in inputs}
 zero_fill=json.loads(command([sys.executable,'-B',str(repo/'verification/check-sbf-zero-fill.py')],run/'zero-fill.log',repo))
 validate_zero_fill(zero_fill);(run/'zero-fill.json').write_text(json.dumps(zero_fill,indent=2)+'\n')
 model=json.loads(command([sys.executable,'-B',str(repo/'tests/sbf-output.py')],run/'model.log',repo))
 need(model['passed'] is True and model['endToEndVerified'] is False,'model status');need(len(model['claims'])==6 and len(model['refusals'])==37 and model['integerOraclePrograms']==200 and model['optimizedPythonRefused'] is True and model['callerInputsPreserved'] is True,'model inventory');bindings(model['inputHashes']);(run/'model.json').write_text(json.dumps(model,indent=2)+'\n')
 result=json.loads(command([sys.executable,'-B',str(repo/'verification/check-sbf-quotient.py')],run/'quotient.log',repo,dict(os.environ,SBF_QUOTIENT_OUTPUT=str(run/'quotient'))))
 quotient_file=Path(result['runRoot'])/'report.json';need(result['passed'] is True and sha(quotient_file)==result['reportSha256'],'quotient result');quotient=json.loads(quotient_file.read_text());need(quotient['passed'] is True and quotient['endToEndVerified'] is False,'quotient status')
 leaf_file=Path(quotient['leafReport']);need(sha(leaf_file)==quotient['leafReportSha256'],'leaf binding');leaf=json.loads(leaf_file.read_text())
 product_file=next(Path(p) for p in leaf['reports'] if '/product/runs/' in p and p.endswith('/report.json') and '/source/' not in p);product=json.loads(product_file.read_text());stage=product_file.parent/'source'
 def prerequisites():
  need(sha(quotient_file)==result['reportSha256'] and sha(leaf_file)==quotient['leafReportSha256'],'prerequisite report drift')
  for doc in [quotient,leaf]:
   for key in ['sourceHashes','stagedSourceHashes','reports','logs']:bindings(doc[key])
  for key in ['sourceHashes','stagedSourceHashes','externalHashes','logs']:bindings(product[key])
 prerequisites()
 staged={}
 for src,dst in templates.items():
  p=stage/dst;need(not p.exists(),'staging collision');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((base/src).read_bytes());staged[str(p)]=sha(base/src)
 model_path=stage/'verification/sbf_output.py';need(not model_path.exists(),'model staging collision');model_path.write_bytes((repo/'verification/sbf_output.py').read_bytes());staged[str(model_path)]=sha(model_path)
 tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))
 external={str(p):sha(p) for p in [tools/'clang',tools/'ld.lld',tools/'llvm-readelf',stage/'target/debug/bend-test-runner']}
 reports=[];results=[]
 for phase in phases:
  script=stage/phase['script'];value=json.loads(command([sys.executable,'-B',str(script)],run/(script.parent.name+'-'+script.name+'.log'),stage,timeout=180));need(value['passed'] is True,'phase status')
  p=stage/phase['report'] if phase['report'] is not None else Path(value['report']);need(p.is_relative_to(stage),'phase report outside stage');doc=json.loads(p.read_text());need(doc['passed'] is True,'report status')
  for key in ['inputHashes','reports','evidenceHashes']:
   if key in doc:bindings(doc[key])
  if 'relocationEvidence' in doc:need(sha(doc['relocationEvidence'])==doc['relocationEvidenceSha256'],'relocation evidence')
  for artifact in doc.get('artifacts',{}).values():bindings(artifact['files'])
  reports.append(p);results.append({'script':phase['script'],'report':str(p),'result':value})
 need(len(reports)==17 and len(set(reports))==17,'handler report inventory')
 ctx=handler_validator.context(quotient_file,tools)
 need(set(map(handler_validator.role,reports))==set(handler_validator.SCHEMA),'handler role inventory')
 for p in reports:handler_validator.validate(json.loads(p.read_text()),p,ctx)
 clear_reports={p.name:json.loads(p.read_text()) for p in reports if p.name in ['claim-output-report.json','initialize-output-report.json','rejection-output-report.json','memset-wrapper-report.json']}
 clear_connection=connect_zero_fill(zero_fill,clear_reports);(run/'zero-fill-connection.json').write_text(json.dumps(clear_connection,indent=2)+'\n')
 vm=json.loads(reports[-1].read_text());need(vm['baselineCases']==520 and vm['smallRouteCases']==72 and vm['executions']==536 and len(vm['rows'])==536 and len(vm['artifacts'])==9,'native VM inventory')
 for row in vm['rows']:
  ok=row['kind']!='fault';need(row['result']['ok'] is ok,'VM outcome')
  if not ok:need(row['result'].get('code')==42,'VM fault refusal')
 prerequisites();bindings(source);bindings(staged);bindings(external);bindings(model['inputHashes'])
 report={'passed':True,'endToEndVerified':False,'sourceHashes':source,'stagedSourceHashes':staged,'externalHashes':external,'quotientReport':str(quotient_file),'quotientReportSha256':sha(quotient_file),'zeroFillReport':str(run/'zero-fill.json'),'zeroFillReportSha256':sha(run/'zero-fill.json'),'zeroFillConnection':str(run/'zero-fill-connection.json'),'zeroFillConnectionSha256':sha(run/'zero-fill-connection.json'),'modelReport':str(run/'model.json'),'modelReportSha256':sha(run/'model.json'),'reports':{str(p):sha(p) for p in reports},'logs':{str(p):sha(p) for p in run.glob('*.log')},'phases':results,'scope':'Fresh maintained-source conditional native dispatch/payout/authorization/frame/output/memset-wrapper checks, with520full-native-handler output cases (72 nonzero-high small-divisor cases) and16fault comparisons. Trusted restricted models, Z3, source/native layout, valid disjoint ABI memory, CALL and syscall contracts remain. Strict report validation applied; no end-to-end source/compiler or account-adapter/transaction-commit theorem.'}
 (run/'report.json').write_text(json.dumps(report,indent=2)+'\n');pointer={'runRoot':str(run),'reportSha256':sha(run/'report.json')};temp=run/'latest.tmp';temp.write_text(json.dumps(pointer,indent=2)+'\n');os.replace(temp,latest);print(json.dumps({'passed':True,**pointer}))
except BaseException as error:
 if latest.exists():os.replace(latest,run/'failed-latest.json')
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)},indent=2)+'\n');raise
