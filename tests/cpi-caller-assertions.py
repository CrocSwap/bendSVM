"""Require CPI custody proof/control entrypoints to refuse disabled assertions."""
if not __debug__:raise RuntimeError('assertions required')
from pathlib import Path
import sys,subprocess,json,hashlib
names=['verification/cpi_caller/caller.py','tests/cpi-caller-obligation-controls.py','tests/cpi-caller-custody-controls.py','tests/cpi-caller-custody-binding.py','tests/cpi-caller-custody-native.py','tests/cpi-caller-fallback-controls.py']
output=Path(sys.argv[1]);output.unlink(missing_ok=True)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
inputs={p:sha(p) for p in [__file__,*names]};rows=[]
for name in names:
 result=subprocess.run([sys.executable,'-B','-O',name],capture_output=True,text=True,timeout=10)
 if result.returncode!=1 or 'RuntimeError: assertions required' not in result.stderr:raise RuntimeError(('assertions refusal',name,result.returncode,result.stderr))
 rows.append({'source':name,'exitCode':result.returncode,'reason':'assertions required','stderrSha256':hashlib.sha256(result.stderr.encode()).hexdigest()})
if any(sha(p)!=h for p,h in inputs.items()):raise RuntimeError('source drift')
output.write_text(json.dumps({'passed':True,'scope':__doc__,'cases':rows,'inputs':inputs},indent=2)+'\n')
print('Six disabled-assertion entrypoints refused')
