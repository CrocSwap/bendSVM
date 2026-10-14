from pathlib import Path
import json,os,subprocess,sys,uuid
import sys
sys.path.insert(0,'verification/sbf_call_frame/qualification')
import report as v
if not __debug__:raise RuntimeError('assertions required')
receipt=v.OUT/'fresh-receipt.json';original=receipt.read_bytes();prior=json.loads(original);v.validate(v.read(prior['input']),v.read(prior['manifest']))
root=v.OUT/('process-controls-'+str(uuid.uuid4()));root.mkdir();rows=[]
for name,body in [('no-report','import sys\nsys.exit(0)\n'),('failed','import sys\nsys.exit(42)\n'),('optimized','import os,sys\nos.execv(sys.executable,[sys.executable,"-O",*sys.argv[1:]])\n')]:
 p=root/name;p.write_text('#!'+sys.executable+'\n'+body);p.chmod(0o700)
for name in ['missing','no-report','failed','optimized']:
 receipt.write_bytes(original);before=set(v.OUT.glob('qualified-*'))
 p=subprocess.run([sys.executable,'-B',str(v.ROOT/'qualification/controller.py')],env=dict(os.environ,SBF_FRAME_PYTHON=str(root/name)),capture_output=True,text=True,timeout=120)
 (root/(name+'.log')).write_text(p.stdout+p.stderr)
 assert p.returncode!=0 and not receipt.exists()
 created=set(v.OUT.glob('qualified-*'))-before;assert len(created)==1;run=created.pop()
 assert (run/'previous-receipt.json').read_bytes()==original
 assert not (run/'accepted.json').exists()
 failure=v.read(run/'failure.json')
 wanted={'missing':'No such file or directory','no-report':'missing fresh report layout-report.json','failed':'child failed layout.py: 42','optimized':'child failed layout.py: 1'}[name]
 assert wanted in failure['error'],(name,failure)
 rows.append({'name':name,'exitCode':p.returncode,'reason':wanted,'runDirectory':str(run)})
# A successful restoration must actually rerun the proofs, not re-copy a receipt.
p=subprocess.run([sys.executable,'-B',str(v.ROOT/'qualification/controller.py')],capture_output=True,text=True,timeout=120)
(root/'restore.log').write_text(p.stdout+p.stderr);assert p.returncode==0,p.stderr
restored=v.read(receipt);assert restored['runId']!=prior['runId'];v.validate(v.read(restored['input']),v.read(restored['manifest']))
result={'passed':True,'controls':rows,'restoredReceipt':restored,'inputHashes':{str(Path(__file__)):v.sha(__file__)}}
(root/'report.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':True,'controls':len(rows),'report':str(root/'report.json')}))
