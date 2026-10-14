"""Fresh composition qualification; stale receipts retire before any checks."""
from pathlib import Path
import json,math,os,subprocess,sys,uuid,shutil
sys.path.insert(0,'verification')
base=Path(__file__).resolve().parent
output=Path(os.environ.get('TOKEN_COMPOSITION_OUTPUT','build/multi-token-composition')).resolve();output.mkdir(parents=True,exist_ok=True)
run=output/('run-'+str(uuid.uuid4()));run.mkdir();print(run,flush=True)
receipt=output/'fresh-receipt.json';pending=output/'fresh-receipt.pending.json'
if receipt.exists():receipt.replace(run/'retired-receipt.json')
if pending.exists():pending.replace(run/'retired-pending.json')
def command(args,name,env):
 with (run/(name+'.log')).open('w') as log:
  result=subprocess.run(args,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1200 if name=='fixtures' else timeout_seconds)
 if result.returncode:raise RuntimeError(name+' failed: '+str(result.returncode))
try:
 if not __debug__:raise RuntimeError('assertions required')
 from multi_token_composition.common import sha,snapshot
 timeout_seconds=float(os.environ.get('TOKEN_COMPOSITION_TIMEOUT_SECONDS','1200'))
 if not math.isfinite(timeout_seconds) or not 1<=timeout_seconds<=1200:raise ValueError('child timeout must be 1..1200 seconds')
 before=snapshot();manifest={'sourceHashes':before,'children':{}}
 python=os.environ.get('TOKEN_COMPOSITION_PYTHON',sys.executable)
 command(['npm','exec','--','bun',str(base/'fixtures.ts')],'fixtures',dict(os.environ,TOKEN_COMPOSITION_FIXTURES=str(run/'fixtures')))
 inp=run/'fixtures/input.json';manifest['inputSha256']=sha(inp)
 for name in ['positive','mapping','managed-byte','decimals','custody','custody-caller','snapshot-controls','pda-controls','serialized','native']:
  child=run/name;artifact=child/'report.json';env=dict(os.environ)
  if name=='native':
   env.update(TOKEN_FRAME_INPUT=str(inp),TOKEN_FRAME_CHILD=str(child))
   args=[python,'-B',str(Path('verification/multi_token_frame/native.py').resolve())]
  else:
   child.mkdir()
   if name=='serialized':
    command(['npm','exec','--','bun',str(base/'loader.ts'),str(child/'loader')],'serialized-loader',env)
    shutil.copyfile(child/'loader/fresh-receipt.json',child/'loader-receipt.json')
    command([python,'-B',str(base/'physical_shared.py'),str(inp),str(child/'shared/report.json'),str(child/'loader-receipt.json')],'serialized-shared',env)
    for fixture in ('token-2','token-3','token-4'):
     command([python,'-B',str(base/'physical_handler.py'),str(inp),str(child/fixture/'report.json'),str(child/'loader-receipt.json'),str(child/'shared/report.json'),fixture],'serialized-'+fixture,env)
    args=[python,'-B',str(base/'physical_assemble.py'),str(inp),str(artifact),str(child/'loader-receipt.json')]
   elif name in ('custody','custody-caller','snapshot-controls','pda-controls'):args=[python,'-B',str(base/(name+'.py')),str(inp),str(artifact)]
   elif name in ('positive','mapping'):args=[python,'-B',str(base/('symbolic.py' if name=='positive' else 'mapping.py')),str(inp),str(artifact)]
   else:args=[python,'-B',str(base/'controls.py'),str(inp),str(run/'positive/report.json'),name,str(artifact)]
  command(args,name,env)
  manifest['children'][name]={'path':str(artifact),'sha256':sha(artifact)}
 if snapshot()!=before:raise RuntimeError('qualification source drift')
 (run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 command([python,'-B',str(base/'report.py'),str(run)],'validation',dict(os.environ))
 accepted=json.loads((run/'validation.log').read_text())
 if accepted.get('passed') is not True:raise RuntimeError('validation did not pass')
 from multi_token_composition.report import validate
 if validate(run)!=accepted:raise RuntimeError('subprocess/in-process report mismatch')
 accepted_path=run/'accepted.json';accepted_path.write_text(json.dumps(accepted,indent=2)+'\n')
 result={'passed':True,'run':str(run),'accepted':str(accepted_path),'acceptedSha256':sha(accepted_path),'manifestSha256':sha(run/'manifest.json'),'inputSha256':sha(inp)}
 pending.write_text(json.dumps(result,indent=2)+'\n');pending.replace(receipt);print(json.dumps(result))
except Exception as error:
 pending.unlink(missing_ok=True);receipt.unlink(missing_ok=True)
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)})+'\n')
 raise
