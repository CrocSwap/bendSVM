"""Failure logging and stale-success controls for the staged fresh gate."""
import hashlib,importlib.util,json,os,pathlib,subprocess,sys,uuid
base=pathlib.Path(__file__).resolve().parents[1]/'verification';root=pathlib.Path.cwd();directory=root/'build/native-body-lowering'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
spec=importlib.util.spec_from_file_location('fresh_gate',base/'check-native-body.py');driver=importlib.util.module_from_spec(spec);spec.loader.exec_module(driver)
run=root/'build/native-body-process-controls'/str(uuid.uuid4());run.mkdir(parents=True);rows=[]
for name,command,timeout,reason in [('spawn',['/no-such-native-body-driver'],1,'FileNotFoundError'),('timeout',[sys.executable,'-u','-c','import time; print("child-started",flush=True); time.sleep(10)'],0.5,'TimeoutExpired')]:
 logs=[]
 try:driver.execute(run,logs,root,name,command,dict(os.environ),timeout)
 except RuntimeError:pass
 else:raise AssertionError('process failure accepted')
 assert len(logs)==1 and logs[0]['failure']==reason
 log=pathlib.Path(logs[0]['artifact']);assert sha(log)==logs[0]['sha256'] and reason in log.read_text()
 if name=='timeout':assert 'child-started' in log.read_text()
 rows.append({'name':name,**logs[0]})
receipt=directory/'fresh-receipt.json';positive=receipt.read_bytes();saved=run/'positive-before-controls.json';saved.write_bytes(positive)
for name,python,opt,reason in [('missing-python','/no-such-fresh-body-python',False,'/no-such-fresh-body-python'),('zero-without-report','/usr/bin/true',False,'missing fresh child report'),('disabled-assertions',None,True,'fresh native body gate requires assertions')]:
 receipt.write_bytes(positive);old=set(directory.glob('previous-*.json'));before=set((directory/'runs').iterdir())
 env=dict(os.environ)
 if python is not None:env['PYTHON']=python
 command=[sys.executable]+(['-O'] if opt else [])+['-B',str(base/'check-native-body.py')]
 result=subprocess.run(command,cwd=root,env=env,capture_output=True,text=True,timeout=120)
 log=run/(name+'.log');log.write_text(result.stdout+result.stderr)
 assert result.returncode>0 and not receipt.exists(),name
 archives=set(directory.glob('previous-*.json'))-old;assert len(archives)==1
 archive=archives.pop();assert archive.read_bytes()==positive
 artifacts=[]
 for new in set((directory/'runs').iterdir())-before:
  artifacts.extend(new.glob('*.log'))
 combined=log.read_text()+''.join(p.read_text() for p in artifacts);assert reason in combined,(name,combined)
 rows.append({'name':name,'exitCode':result.returncode,'log':str(log),'logSha256':sha(log),'retiredReceipt':str(archive),'retiredSha256':sha(archive),'logs':{str(p):sha(p) for p in artifacts}})
d={'passed':True,'integrated':False,'rows':rows,'positiveEvidence':str(saved),'positiveSha256':sha(saved),'sourceHashes':{str(base/n):sha(base/n) for n in ['check-native-body.py','native_body.py','native_c64_ast.py','native_body_report.py']}}
d['sourceHashes'][str(pathlib.Path(__file__).resolve())]=sha(pathlib.Path(__file__).resolve())
p=run/'report.json';p.write_text(json.dumps(d,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(p),'sha256':sha(p)}))
