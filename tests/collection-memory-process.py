if not __debug__:raise RuntimeError('memory test assertions required')
from pathlib import Path
import sys,os,json,subprocess,uuid,shlex
root=Path('build/collection-memory');home=Path('verification/collection_memory/qualification');receipt=root/'fresh-receipt.json';run=root/('process-controls-'+str(uuid.uuid4()));run.mkdir();baseline=receipt.read_bytes();controls=[]
failed=run/'exit42';failed.write_text('#!/bin/sh\nexit 42\n');failed.chmod(0o755)
optimized=run/'optimized';optimized.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' -O "$@"\n');optimized.chmod(0o755)
for name,python,reason in [('missing',str(run/'absent'),'No such file or directory'),('no-report','/usr/bin/true','memory missing fresh reports'),('failed',str(failed),'memory proof child failed: 42'),('optimized',str(optimized),'memory proof child failed: 1')]:
 if not receipt.exists():receipt.write_bytes(baseline)
 prior=receipt.read_bytes();before=set(root.glob('qualified-*'))
 c=subprocess.run([sys.executable,'-B',str(home/'controller.py')],env=dict(os.environ,MEMORY_PYTHON=python),capture_output=True,text=True,timeout=60);log=c.stdout+c.stderr;(run/(name+'.log')).write_text(log)
 assert c.returncode!=0 and reason in log,(name,c);created=set(root.glob('qualified-*'))-before;assert len(created)==1;child=created.pop();assert not receipt.exists() and (child/'previous.json').read_bytes()==prior and not (child/'accepted.json').exists()
 if name=='optimized':assert 'memory proof assertions required' in (child/'proof.log').read_text()
 controls.append({'name':name,'reason':reason,'exitCode':c.returncode,'runDirectory':str(child)})
c=subprocess.run([sys.executable,'-B',str(home/'controller.py')],capture_output=True,text=True,timeout=600);(run/'restored.log').write_text(c.stdout+c.stderr);assert c.returncode==0,c;assert receipt.exists() and receipt.read_bytes()!=baseline
(run/'report.json').write_text(json.dumps({'passed':True,'controls':controls,'restoredReceipt':json.loads(receipt.read_bytes())},indent=2)+'\n');print(run);print('Four memory process controls and fresh restoration passed')
