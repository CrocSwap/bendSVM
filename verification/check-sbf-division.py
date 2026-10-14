"""Fresh-build division leaf qualification; not whole-division verification."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,uuid
repo=Path(__file__).resolve().parents[1];base=repo/'verification/sbf_division'
sys.path.insert(0,str(base))
output=Path(os.environ.get('SBF_DIVISION_OUTPUT',repo/'build/sbf-division')).resolve()
run=output/'runs'/str(uuid.uuid4());run.mkdir(parents=True);latest=output/'latest.json'
if latest.exists():os.replace(latest,run/'previous-latest.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(condition,message):
 if not condition:raise RuntimeError(message)
def bindings(values):
 for p,h in values.items():need(sha(p)==h,'binding drift: '+p)
def command(args,log,cwd,env=None,timeout=900):
 child=subprocess.run(args,cwd=cwd,env=env,capture_output=True,text=True,timeout=timeout)
 log.write_text(child.stdout+child.stderr)
 need(child.returncode==0,'command failed: '+str(log))
 return child.stdout
try:
 need(__debug__,'assertions required')
 import validate as division_validator
 templates=json.loads((base/'templates.json').read_text())
 inputs=[Path(__file__),base/'validate.py',base/'report-schema.json',base/'templates.json',repo/'verification/sbf_leaf.py',repo/'verification/check-sbf-product.py']+[base/p for p in templates]
 source={str(p):sha(p) for p in inputs}
 env=dict(os.environ,SBF_PRODUCT_OUTPUT=str(run/'product'))
 result=json.loads(command([sys.executable,'-B',str(repo/'verification/check-sbf-product.py')],run/'product.log',repo,env))
 product_root=Path(result['runRoot']);product_file=product_root/'report.json'
 need(result['passed'] is True and sha(product_file)==result['reportSha256'],'product result')
 product=json.loads(product_file.read_text());need(product['passed'] is True and product['endToEndVerified'] is False,'product status')
 for key in ['sourceHashes','stagedSourceHashes','externalHashes','logs']:bindings(product[key])
 need(sha(product['terminal'])==product['terminalSha256'],'product terminal')
 need(sha(product['initialManifest'])==product['initialManifestSha256'],'product manifest')
 # Fresh product stage already contains a proof-gated build and tool symlinks.
 # Only add files; never rewrite its qualified inputs or existing evidence.
 stage=product_root/'source';staged={}
 for src,dst in templates.items():
  p=stage/dst;need(not p.exists(),'stage collision');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((base/src).read_bytes());staged[str(p)]=sha(base/src)
 p=stage/'verification/sbf_leaf.py';need(not p.exists(),'leaf stage collision');p.write_bytes((repo/'verification/sbf_leaf.py').read_bytes());staged[str(p)]=sha(p)
 scout=stage/'build/sbf-division-scout'
 command([sys.executable,'-B',str(scout/'compose-div4.py')],run/'composition.log',stage)
 composition_file=scout/'div4-composition-report.json';composition=json.loads(composition_file.read_text())
 division_validator.composition(composition,scout)
 replay_result=json.loads(command([sys.executable,'-B',str(scout/'replay-div4.py')],run/'replay.log',stage,timeout=120))
 replay_file=Path(replay_result['runRoot'])/'report.json';replay=json.loads(replay_file.read_text())
 need(replay_result['passed'] is True,'replay driver status')
 division_validator.replay(replay,replay_file.parent,stage,Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin'))))
 bindings(source);bindings(staged)
 for key in ['sourceHashes','stagedSourceHashes','externalHashes','logs']:bindings(product[key])
 need(sha(product_file)==result['reportSha256'],'product report drift')
 report={'passed':True,'endToEndVerified':False,'sourceHashes':source,'stagedSourceHashes':staged,'reports':{str(p):sha(p) for p in [product_file,composition_file,replay_file]},'logs':{str(p):sha(p) for p in run.glob('*.log')},'modeledInstructions':229,'baselineCases':70,'executions':73,'scope':'Fresh proof-gated vesting artifact; emitted div4 body equals four independent restoring steps under valid disjoint ABI memory and trusted restricted SBF/Z3 model. Real isolated call/return replay includes EXIT. Not source extraction, div16/caller composition, full quotient, whole handler or verified compiler.'}
 (run/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 pointer={'runRoot':str(run),'reportSha256':sha(run/'report.json')};temp=run/'latest.tmp';temp.write_text(json.dumps(pointer,indent=2)+'\n');os.replace(temp,latest)
 print(json.dumps({'passed':True,**pointer}))
except BaseException as e:
 if latest.exists():os.replace(latest,run/'failed-latest.json')
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(e)},indent=2)+'\n');raise
