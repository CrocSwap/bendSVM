"""Real failure processes must retire old success and retain failure evidence."""
from pathlib import Path
import hashlib,json,os,subprocess,sys,uuid
if not __debug__:raise RuntimeError('assertions required')
repo=Path(__file__).resolve().parents[1]
out=Path(os.environ['SBF_HANDLER_TEST_DIR']).resolve()/'process-controls';out.mkdir()
seed=Path(os.environ['SBF_HANDLER_TEST_LATEST']).read_bytes();rows=[]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for name,args,extra,reason in [
 ('missing-python',[str(repo/'node_modules/.bin/bun'),'verification/check-sbf-handler.ts'],{'PYTHON':'/no-sbf-handler-python'},'ENOENT'),
 ('zero-no-result',[str(repo/'node_modules/.bin/bun'),'verification/check-sbf-handler.ts'],{'PYTHON':'/usr/bin/true'},'JSON'),
 ('optimized-python',[sys.executable,'-O','verification/check-sbf-handler.py'],{},'assertions required'),
 ('missing-tools',[sys.executable,'verification/check-sbf-handler.py'],{'SBF_TOOLS':'/no-sbf-tools'},'command failed:'),
]:
 target=out/name;target.mkdir();(target/'latest.json').write_bytes(seed)
 p=subprocess.run(args,cwd=repo,capture_output=True,text=True,timeout=60,env=dict(os.environ,SBF_HANDLER_OUTPUT=str(target),**extra))
 log=target/'process.log';log.write_text(p.stdout+p.stderr)
 if p.returncode==0 or reason not in log.read_text():raise RuntimeError('wrong process refusal '+name)
 if (target/'latest.json').exists():raise RuntimeError('stale success survived '+name)
 previous=list(target.rglob('previous-latest.json'))
 if len(previous)!=1 or previous[0].read_bytes()!=seed:raise RuntimeError('old evidence not retained '+name)
 failures=list(target.rglob('failure.json'))
 if not failures or any(json.loads(f.read_text())['passed'] is not False for f in failures):raise RuntimeError('failure evidence absent '+name)
 if list(target.rglob('accepted.json')) or list(target.glob('runs/*/report.json')):raise RuntimeError('failed attempt published acceptance '+name)
 rows.append({'name':name,'exitCode':p.returncode,'reason':reason,'log':str(log),'logSha256':sha(log),'failureHashes':{str(f):sha(f) for f in failures},'previousSha256':sha(previous[0])})
report={'passed':True,'controls':rows,'controllerSha256':sha(Path(__file__))}
file=out/'report.json';file.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'report':str(file),'sha256':sha(file)}))
