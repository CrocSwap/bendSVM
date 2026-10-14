import os
"""Isolated fresh-run qualification with explicit success retirement."""
from pathlib import Path
import datetime,hashlib,importlib.util,json,os,shutil,subprocess,sys,uuid
base=Path(__file__).resolve().parent
repo=Path(os.environ.get('SBF_CHAIN_SOURCE_ROOT',str(base.parents[1]))).resolve()
output_root=Path(os.environ.get('SBF_CHAIN_OUTPUT_ROOT',str(base))).resolve()
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
run=output_root/'runs'/str(uuid.uuid4());run.mkdir(parents=True)
latest=output_root/'latest.json'
if latest.exists():os.replace(latest,run/'previous-latest.json')
try:
 if not __debug__:raise RuntimeError('assertions required')
 selected=['verification/sbf_elf.py','verification/sbf_paths.py','verification/sbf_cfg.py','verification/sbf_machine.py','build/sbf-product-chain/validate.py','build/sbf-product-chain/report-schema.json','build/sbf-slice-probe/check.py','build/sbf-slice-probe/vesting.so','build/sbf-carry-probe/check.py','build/sbf-carry-probe/compose.py','build/sbf-carry-probe/product.py','build/sbf-operand-probe/layout.py','build/sbf-operand-probe/paths.py','build/sbf-operand-probe/controls.py','build/sbf-operand-probe/link-product.py','build/sbf-product-tail/check.py','build/sbf-entry-product-replay/replay.py','build/vesting.h','examples/vesting/vesting.bend','sdk/context.bend','runtime/sbf.ld']
 manifest=json.loads((repo/'build/vesting.manifest.json').read_text())
 selected += ['build/sbf-product-chain/artifact.py','build/sbf-product-chain/fresh_source.py','build/vesting.manifest.json']+['build/vesting'+suffix for suffix in ['.h','.c','.wire.h','.dispatch.h','.so']]+list(manifest['inputs'])
 selected=list(dict.fromkeys(selected))
 source={}
 for relative in selected:
  p=repo/relative;raw=p.read_bytes();source[relative]=hashlib.sha256(raw).hexdigest();dest=run/relative;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(raw)
 for relative,h in source.items():
  if sha(repo/relative)!=h:raise RuntimeError('source changed during snapshot')
 runner=repo/'target/debug/bend-test-runner';link=run/'target/debug/bend-test-runner';link.parent.mkdir(parents=True);link.symlink_to(runner)
 tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')))
 external={str(p):sha(p) for p in [runner,tools/'clang',tools/'ld.lld',Path(sys.executable),repo/'node_modules/.bin/bun']}
 version=subprocess.check_output([str(tools/'clang'),'--version'],text=True)
 if '20.1.7' not in version or 'anza-xyz' not in version:raise RuntimeError('compiler pin')
 (run/'snapshot.json').write_text(json.dumps({'sourceHashes':source,'externalHashes':external,'controllerSha256':sha(Path(__file__)),'created':datetime.datetime.now(datetime.timezone.utc).isoformat()},indent=2)+'\n')
 phases=[('artifact','build/sbf-product-chain/artifact.py','build/sbf-product-chain/artifact-report.json'),('layout','build/sbf-operand-probe/layout.py','build/sbf-operand-probe/layout-report.json'),('paths','build/sbf-operand-probe/paths.py','build/sbf-operand-probe/paths-report.json'),('controls','build/sbf-operand-probe/controls.py','build/sbf-operand-probe/controls-report.json'),('linked-product','build/sbf-operand-probe/link-product.py','build/sbf-operand-probe/linked-product-report.json'),('tail','build/sbf-product-tail/check.py','build/sbf-product-tail/report.json'),('runtime','build/sbf-entry-product-replay/replay.py','build/sbf-entry-product-replay/replay-report.json')]
 results=[]
 def need(ok,why):
  if not ok:raise RuntimeError(why)
 def check_files(obj):
  if isinstance(obj,dict):
   for key,value in obj.items():
    if key in ['inputHashes','evidenceHashes','outputHashes','files'] and isinstance(value,dict):
     for p,h in value.items():need(Path(p).is_file() and sha(Path(p))==h,'report file binding '+p)
    else:check_files(value)
  elif isinstance(obj,list):
   for value in obj:check_files(value)
 def validate(name,d):
  need(d.get('passed') is True,name+' success')
  need(d.get('exploratory') is True,name+' exploratory scope')
  need(d.get('endToEndVerified',False) is False,name+' overclaim')
  check_files(d)
  if name=='layout':need(len(d['fields'])==8 and d['wrongOffsetRefused'] is True,'layout controls')
  if name=='paths':need(d['baseline']=={'result':'unsat','coneInstructions':153,'mergedNodes':17,'inputs':29,'properties':6,'reachability':'sat'} and d['wrongTotalLimb']['result']=='sat','path claims')
  if name=='controls':need(len(d['controls'])==15 and len({r['name'] for r in d['controls']})==15 and d['positiveRecovery']['result']=='unsat' and d['positiveRecovery']['reachability']=='sat','path refusals')
  if name=='linked-product':
   need(d['freshPath']['result']=='unsat' and d['freshPath']['reachability']=='sat' and d['freshPrefix']['result']=='unsat','linked prerequisites')
   need(d['boundary']=={'result':'unsat','registers':11,'stackSlots':[-264,-216,-192,-184],'carryExtraStackSlots':[-0xd8,-0x108]} and d['boundaryFault']['result']=='sat','linked boundary')
   need(sha(run/'build/sbf-carry-probe/product-report.json')==d['productReportSha256'],'product receipt hash')
  if name=='tail':need(d['range']==[0x21a8,0x2248] and d['instructions']==20 and d['freshPath']['result']=='unsat' and d['freshCarry']['result']=='unsat' and d['extraStackBoundary']['result']=='unsat' and d['tail']['result']=='unsat' and len(d['faults'])==2 and all(x['result']=='sat' for x in d['faults']),'tail claims')
  if name=='runtime':
   need(d['baselineCases']==68 and d['executions']==78 and len(d['rows'])==78,'runtime inventory')
   need(d['artifacts']['baseline']['unchangedConeInstructions']==251,'runtime code coverage')
   baseline=[r for r in d['rows'] if r['kind']=='baseline'];need(len(baseline)==68 and all(r['result']['ok'] is True for r in baseline),'runtime baselines')
   need(len([r for r in d['rows'] if not r['result']['ok'] and r['result'].get('code')==42])==6,'runtime negative outcomes')
 try:
  for name,script,report in phases:
   print('Starting '+name,flush=True)
   command=[sys.executable,str(run/script)];log=run/(name+'.log')
   with log.open('w') as output:
    p=subprocess.run(command,cwd=run,env=dict(os.environ,SBF_CHAIN_DEPENDENCY_ROOT=str(repo)),stdout=output,stderr=subprocess.STDOUT,timeout=240)
   need(p.returncode==0,name+' child exit '+str(p.returncode))
   d=json.loads((run/report).read_text());validate(name,d)
   results.append({'phase':name,'command':command,'exitCode':p.returncode,'report':str(run/report),'reportSha256':sha(run/report),'log':str(log),'logSha256':sha(log)})
   print(name+' passed',flush=True)
  # Recheck the complete final report/dependency closure after all child processes.
  reports={}
  for p in sorted(run.rglob('*report.json')):
   d=json.loads(p.read_text());need(d.get('passed') is True,'dependent report success');check_files(d);reports[str(p)]=sha(p)
  product=json.loads((run/'build/sbf-carry-probe/product-report.json').read_text())
  need(len(product['claims'])==9 and [x['result'] for x in product['claims']]==['unsat']*8+['sat'],'arithmetic prerequisites')
  for relative,h in source.items():need(sha(run/relative)==h,'staged source drift '+relative)
  for p,h in external.items():need(sha(Path(p))==h,'external tool drift '+p)
  validator_path=run/'build/sbf-product-chain/validate.py'
  validator_spec=importlib.util.spec_from_file_location('qualified_validator',validator_path)
  validator=importlib.util.module_from_spec(validator_spec);validator_spec.loader.exec_module(validator)
  strict_validation=validator.validate_run(run)
  terminal={'passed':True,'exploratory':True,'endToEndVerified':False,'runRoot':str(run),'controllerSha256':sha(Path(__file__)),'snapshotSha256':sha(run/'snapshot.json'),'strictValidation':strict_validation,'phases':results,'reports':reports,'scope':'Fresh isolated qualification of conditional native-entry operand/product/tail proofs plus instrumented251instruction LiteSVM replay. Native ABI, C-field layout interpretation, valid disjoint memory and restricted machine semantics remain trusted. Division, final output, account adapter and commit are outside scope; this conditional fixture gate does not establish whole-handler or compiler correctness.'}
  (run/'terminal.json').write_text(json.dumps(terminal,indent=2)+'\n')
  # Publish a pointer only after every qualification phase passes; old runs remain intact.
  temporary=output_root/'latest.tmp';temporary.write_text(json.dumps({'runRoot':str(run),'terminalSha256':sha(run/'terminal.json')},indent=2)+'\n');os.replace(temporary,output_root/'latest.json')
  print(json.dumps({'passed':True,'runRoot':str(run),'phases':len(results),'reports':len(reports)}),flush=True)
 except BaseException as e:
  (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(e),'completedPhases':results},indent=2)+'\n')
  raise
except BaseException as error:
 if not (run/'failure.json').exists():
  (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error),'completedPhases':globals().get('results',[])},indent=2)+'\n')
 raise
