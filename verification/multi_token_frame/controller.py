"""Stage fresh token-frame checks, retiring any previous receipt first."""
from pathlib import Path
import os,json,hashlib,subprocess,sys,uuid,re
base=Path(__file__).resolve().parent
output=Path(os.environ.get('TOKEN_FRAME_OUTPUT',str(Path('build/multi-token-frame')))).resolve();output.mkdir(parents=True,exist_ok=True)
run=output/('run-'+str(uuid.uuid4()));run.mkdir();print(run,flush=True)
receipt=output/'fresh-receipt.json';pending=output/'fresh-receipt.pending.json'
if receipt.exists():
 (run/'retired-receipt.json').write_bytes(receipt.read_bytes());receipt.unlink()
pending.unlink(missing_ok=True)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def command(args,name,env):
 with (run/(name+'.log')).open('w') as log:
  result=subprocess.run(args,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=1200)
 if result.returncode:raise RuntimeError(name+' failed: '+str(result.returncode))
try:
 if not __debug__:raise RuntimeError('assertions required')
 files=[base/n for n in ['fixtures.ts','symbolic.py','frame_control.py','native.py','pending-native.c','report.py','contract.json']]+[Path(__file__),Path('package.json'),Path('package-lock.json'),Path('tests/multi-token-frame.ts')]
 files += [Path(name) for name in subprocess.check_output(['git','ls-files','--cached','--others','--exclude-standard','-z'],text=True).split('\0') if name and not re.fullmatch(r'sdk/\.sqrt-negative-[0-9]+\.bend',name) and name.startswith(('compiler/','runtime/','verification/','sdk/')) and Path(name).is_file() and Path(name).suffix in ['.py','.ts','.h','.bend','.json']]
 before={str(p.resolve()):sha(p) for p in files};manifest={'sourceHashes':before,'children':{}}
 child_python=os.environ.get('TOKEN_FRAME_PYTHON',sys.executable)
 command(['npm','exec','--','bun',str(base/'fixtures.ts')],'fixtures',dict(os.environ,TOKEN_FRAME_FIXTURES=str(run/'fixtures')))
 manifest['inputSha256']=sha(run/'fixtures/input.json')
 for name in ['symbolic','frame_control','native']:
  command([child_python,'-B',str(base/(name+'.py'))],name,dict(os.environ,TOKEN_FRAME_INPUT=str(run/'fixtures/input.json'),TOKEN_FRAME_CHILD=str(run/name)))
  artifact=run/name/'report.json';manifest['children'][name]={'path':str(artifact),'sha256':sha(artifact)}
 for p,h in before.items():
  if sha(p)!=h:raise RuntimeError('source drift: '+p)
 (run/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
 command([child_python,'-B',str(base/'report.py'),str(run)],'validation',dict(os.environ))
 accepted=json.loads((run/'validation.log').read_text())
 if accepted.get('passed') is not True:raise RuntimeError('independent validation failed')
 import report
 if report.validate(run)!=accepted:raise RuntimeError('in-process validation mismatch')
 accepted_file=run/'accepted.json';accepted_file.write_text(json.dumps(accepted,indent=2)+'\n')
 result={'passed':True,'run':str(run),'accepted':str(accepted_file),'acceptedSha256':sha(accepted_file),'manifestSha256':sha(run/'manifest.json'),'inputSha256':sha(run/'fixtures/input.json')}
 pending.write_text(json.dumps(result,indent=2)+'\n');pending.replace(receipt);print(json.dumps(result))
except Exception as error:
 pending.unlink(missing_ok=True);receipt.unlink(missing_ok=True)
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)})+'\n');raise
