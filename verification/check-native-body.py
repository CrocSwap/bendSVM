"""Staged fresh source → handler proof → typed SBF-C native body gate."""
import hashlib,json,os,pathlib,subprocess,sys,uuid
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def execute(run,logs,root,label,command,env,timeout):
 log=run/(label+'.log')
 try:
  result=subprocess.run(command,cwd=root,env=env,capture_output=True,text=True,timeout=timeout)
 except (subprocess.TimeoutExpired,OSError) as error:
  def decoded(value):return value.decode(errors='replace') if isinstance(value,bytes) else (value or '')
  log.write_text(decoded(getattr(error,'stdout',None))+decoded(getattr(error,'stderr',None))+'\n'+type(error).__name__+': '+str(error)+'\n')
  logs.append({'artifact':str(log),'sha256':sha(log),'failure':type(error).__name__})
  raise RuntimeError(label+' process failed: '+str(log)) from error
 log.write_text(result.stdout+result.stderr)
 logs.append({'artifact':str(log),'sha256':sha(log),'exitCode':result.returncode})
 if result.returncode!=0:raise RuntimeError(label+' failed: '+str(log))
 return result.stdout

def main():
 base=pathlib.Path(__file__).resolve().parent;root=pathlib.Path.cwd()
 directory=pathlib.Path(os.environ.get('NATIVE_BODY_DIR',str(root/'build/native-body-lowering'))).resolve()
 run_id=str(uuid.uuid4());receipt=directory/'fresh-receipt.json'
 if receipt.exists():receipt.rename(directory/('previous-'+run_id+'.json'))
 if not __debug__:raise RuntimeError('fresh native body gate requires assertions')
 run=directory/'runs'/run_id;run.mkdir(parents=True)
 bound_sources={str(base/n):sha(base/n) for n in ['check-native-body.py','check-native-body.ts','native_body.py','native_c64_ast.py','native_divmod_ast.py','native_divmod.py','native_body_report.py']}
 logs=[]
 native_dir=run/'native-handler';env=dict(os.environ);env['NATIVE_HANDLER_DIR']=str(native_dir)
 execute(run,logs,root,'fresh-native',[str(root/'node_modules/.bin/bun'),'verification/check-native-handlers.ts'],env,300)
 native_receipt=native_dir/'fresh-receipt.json';raw=native_receipt.read_bytes();native=json.loads(raw)
 assert native['passed'] is True and native['endToEndVerified'] is False
 for key in ['input','report']:assert sha(root/native[key+'Artifact'])==native[key+'Sha256']
 body_root=run/'bodies'
 stdout=execute(run,logs,root,'native-body',[sys.executable,'-B',str(base/'native_body.py'),'--receipt',str(native_receipt),'--output-root',str(body_root)],dict(os.environ),120)
 result=json.loads(stdout);assert result['passed'] is True
 report_path=pathlib.Path(result['report']);assert report_path.parent.parent==body_root and report_path.name=='report.json'
 assert sha(report_path)==result['sha256'];report=json.loads(report_path.read_text());assert report['passed'] is True and report['endToEndVerified'] is False
 assert native_receipt.read_bytes()==raw
 for p,h in {**bound_sources,**report['sourceHashes']}.items():assert sha(pathlib.Path(p))==h,p
 output={'passed':True,'endToEndVerified':False,'runId':run_id,'nativeReceipt':str(native_receipt),'nativeReceiptSha256':sha(native_receipt),'bodyReport':str(report_path),'bodyReportSha256':sha(report_path),'sourceHashes':report['sourceHashes'],'logs':logs,'scope':report['scope']}
 pending=run/'accepted.json';pending.write_text(json.dumps(output,indent=2)+'\n');pending.rename(receipt)
 print(json.dumps({'passed':True,'receipt':str(receipt),'sha256':sha(receipt)}))

if __name__=='__main__':main()
