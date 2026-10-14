from pathlib import Path
import hashlib,json,os,subprocess,sys,uuid
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;sys.path.insert(0,'verification');from multi_token_composition import report
source=Path(sys.argv[1]).resolve();accepted=report.validate(source)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
root=source.parent/('process-controls-'+str(uuid.uuid4()));root.mkdir();print(root,flush=True)
prior=json.dumps({'passed':True,'run':str(source),'accepted':str(source/'accepted.json'),'acceptedSha256':sha(source/'accepted.json'),'manifestSha256':sha(source/'manifest.json'),'inputSha256':sha(source/'fixtures/input.json')},indent=2)+'\n'
wrapper=root/'exit42-child';wrapper.write_text('#!/bin/sh\nexit 42\n');wrapper.chmod(0o755)
sleeper=root/'slow-child';sleeper.write_text('#!/bin/sh\nexec /bin/sleep 30\n');sleeper.chmod(0o755)
rows=[]
for name,python,opt,reason in [('missing-python',str(root/'absent-python'),False,'No such file'),('zero-no-report','/usr/bin/true',False,'No such file'),('exit42',str(wrapper),False,'positive failed: 42'),('assertions-disabled',sys.executable,True,'assertions required'),('timeout',str(sleeper),False,'timed out')]:
 out=root/name;out.mkdir();receipt=out/'fresh-receipt.json';receipt.write_text(prior)
 command=[sys.executable,*(['-O'] if opt else ['-B']),str(base/'controller.py')]
 result=subprocess.run(command,env=dict(os.environ,TOKEN_COMPOSITION_OUTPUT=str(out),TOKEN_COMPOSITION_PYTHON=python,TOKEN_COMPOSITION_TIMEOUT_SECONDS='1' if name=='timeout' else '1200'),capture_output=True,text=True,timeout=120)
 (out/'process.log').write_text(result.stdout+result.stderr)
 assert result.returncode!=0,(name,result.stdout)
 assert not receipt.exists() and not (out/'fresh-receipt.pending.json').exists(),name
 runs=list(out.glob('run-*'));assert len(runs)==1;run=runs[0]
 assert (run/'retired-receipt.json').read_text()==prior
 failure=json.loads((run/'failure.json').read_text());assert failure['passed'] is False and reason in failure['error'],failure
 assert not (run/'accepted.json').exists()
 rows.append({'name':name,'exitCode':result.returncode,'failure':failure,'run':str(run),'logSha256':sha(out/'process.log'),'retiredSha256':sha(run/'retired-receipt.json')})
 print(name+' refused without receipt',flush=True)
report_value={'passed':True,'controls':rows,'sourceAcceptedSha256':sha(source/'accepted.json'),'inputHashes':{str(p):sha(p) for p in [Path(__file__),base/'controller.py',base/'report.py',base/'contract.json']},'sourceRun':str(source),'scope':'Five process failures must retire the prior genuine receipt byte-for-byte and publish no accepted result. Fresh successful restoration is a separate required gate.'}
(root/'report.json').write_text(json.dumps(report_value,indent=2)+'\n');print(str(root/'report.json'))
