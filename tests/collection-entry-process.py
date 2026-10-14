from pathlib import Path
import sys,subprocess,os,json,uuid,shlex
root=Path('build/collection-entry');home=Path('verification/collection_entry/qualification');controller=home/'controller.py';canonical=root/'fresh-receipt.json';run=root/('process-controls-'+str(uuid.uuid4()));run.mkdir()
assert canonical.exists(),'positive baseline required'
baseline=canonical.read_bytes();rows=[]
exit42=run/'exit42';exit42.write_text('#!/bin/sh\nexit 42\n');exit42.chmod(0o755)
optimized=run/'optimized';optimized.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' -O "$@"\n');optimized.chmod(0o755)
for name,python,reason in [('missing',str(run/'absent'),'No such file or directory'),('no-report','/usr/bin/true','entry child missing fresh reports'),('exit42',str(exit42),'entry child failed: proof.log exit 42'),('optimized',str(optimized),'entry child failed: proof.log exit 1')]:
 if not canonical.exists():canonical.write_bytes(baseline)
 previous=canonical.read_bytes();before=set(root.glob('qualified-*'))
 c=subprocess.run([sys.executable,'-B',str(controller)],env=dict(os.environ,ENTRY_PYTHON=python),capture_output=True,text=True,timeout=120)
 text=c.stdout+c.stderr;(run/(name+'.log')).write_text(text)
 assert c.returncode!=0 and reason in text,(name,c)
 created=set(root.glob('qualified-*'))-before;assert len(created)==1;child=created.pop()
 assert not canonical.exists() and (child/'previous.json').read_bytes()==previous
 assert not (child/'accepted.json').exists()
 if name=='optimized':assert 'assertions required' in (child/'proof.log').read_text()
 rows.append({'name':name,'exitCode':c.returncode,'runDirectory':str(child),'reason':reason})
# Restore only by successful execution, never by publishing an old baseline.
c=subprocess.run([sys.executable,'-B',str(controller)],capture_output=True,text=True,timeout=300)
(run/'restored.log').write_text(c.stdout+c.stderr);assert c.returncode==0,c;assert canonical.exists() and canonical.read_bytes()!=baseline
(run/'report.json').write_text(json.dumps({'passed':True,'controls':rows,'restoredReceipt':json.loads(canonical.read_bytes())},indent=2)+'\n');print(run);print('Four process controls and fresh restoration passed')
