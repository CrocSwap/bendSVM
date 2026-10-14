from pathlib import Path
import json,os,subprocess,sys,uuid
import report
if not __debug__:raise RuntimeError('assertions required')
root=report.ROOT;out=report.OUT;out.mkdir(parents=True,exist_ok=True);run=out/('qualified-'+str(uuid.uuid4()));run.mkdir();receipt=out/'fresh-receipt.json'
if receipt.exists():receipt.rename(run/'previous-receipt.json')
try:
 interpreter=list((Path.home()/'.cargo/registry/src').glob('*/solana-sbpf-0.11.1/src/interpreter.rs'));report.need(len(interpreter)==1,'interpreter inventory')
 data={'version':1,'runId':run.name,'runDirectory':str(run),'sources':{str(p):report.sha(p) for p in report.SOURCES},'qualification':report.read(out/'handler-prerequisite.json')['qualification'],'interpreter':{'path':str(interpreter[0]),'sha256':report.sha(interpreter[0])}}
 report.prerequisite(data)
 inp=run/'input.json';inp.write_text(json.dumps(data,indent=2)+'\n')
 env=dict(os.environ,SBF_FRAME_RUN=str(run),SBF_FRAME_INPUT=str(inp))
 python=os.environ.get('SBF_FRAME_PYTHON',sys.executable)
 for script,name in zip(['layout.py','footprint.py','connect.py'],report.NAMES):
  child=subprocess.run([python,'-B',str(root/script)],env=env,capture_output=True,text=True,timeout=120)
  (run/(script+'.log')).write_text(child.stdout+child.stderr)
  report.need(child.returncode==0,'child failed '+script+': '+str(child.returncode))
  report.need((run/name).is_file(),'missing fresh report '+name)
 manifest={n:{'path':str(run/n),'sha256':report.sha(run/n)} for n in report.NAMES};mp=run/'manifest.json';mp.write_text(json.dumps(manifest,indent=2)+'\n')
 child=subprocess.run([sys.executable,'-B',str(root/'qualification/report.py'),str(inp),str(mp)],capture_output=True,text=True,timeout=60)
 (run/'validation.log').write_text(child.stdout+child.stderr);report.need(child.returncode==0,'report validator failed')
 result=json.loads(child.stdout);report.need(result==report.validate(data,manifest),'validator disagreement');accepted=run/'accepted.json';accepted.write_text(json.dumps(result,indent=2)+'\n')
 fresh={'passed':True,'runId':run.name,'input':str(inp),'inputSha256':report.sha(inp),'manifest':str(mp),'manifestSha256':report.sha(mp),'accepted':str(accepted),'acceptedSha256':report.sha(accepted)}
 temp=run/'receipt.tmp';temp.write_text(json.dumps(fresh,indent=2)+'\n');os.replace(temp,receipt);print(json.dumps(fresh))
except BaseException as error:
 if receipt.exists():receipt.rename(run/'failed-receipt.json')
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)},indent=2)+'\n');raise
