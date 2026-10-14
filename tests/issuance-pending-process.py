"""Pending-buffer probe failures retire success and preserve prior evidence."""
from pathlib import Path
import hashlib,json,os,subprocess,sys
if not __debug__:raise RuntimeError('assertions required')
root=Path('build/issuance-pending');latest=root/'fresh-receipt.json';saved=latest.read_bytes();rows=[]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
for name,options,extra,reason in [
 ('assertions-disabled',['-O'],{},'assertions required'),
 ('missing-compiler',[],{'CC':'/no-such-pending-compiler'},'host C compiler'),
 ('empty-compiler',[],{'CC':'/usr/bin/true'},'AssertionError'),
]:
 latest.write_bytes(saved);before=set((root/'runs').iterdir())
 result=subprocess.run([sys.executable,'-B',*options,'tests/issuance-pending.py'],env={**os.environ,**extra},capture_output=True,text=True,timeout=120)
 assert result.returncode>0 and reason in result.stderr,(name,result.returncode,result.stderr)
 assert not latest.exists()
 new=set((root/'runs').iterdir())-before;assert len(new)==1;run=new.pop()
 assert (run/'previous.json').read_bytes()==saved and json.loads((run/'failure.json').read_text())['passed'] is False
 (run/'controller.log').write_text(result.stdout+result.stderr)
 rows.append({'name':name,'exitCode':result.returncode,'artifacts':{str(p):sha(p) for p in run.iterdir() if p.is_file()}})
result=subprocess.run([sys.executable,'-B','tests/issuance-pending.py'],capture_output=True,text=True,timeout=120)
assert result.returncode==0,result.stderr
restored=json.loads(latest.read_text());assert restored['passed'] is True
out={'passed':True,'inputSha256':restored['inputSha256'],'checkerSha256':sha(Path(__file__)),'restoredReceiptSha256':sha(latest),'controls':rows}
(root/'process-controls.json').write_text(json.dumps(out,indent=2)+'\n')
print('Three pending-buffer process failures refused; fresh positive restored')
