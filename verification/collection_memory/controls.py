if not __debug__:raise RuntimeError('memory proof assertions required')
import runpy,json
from pathlib import Path
import os
OUT=Path(os.environ.get("MEMORY_RUN_DIR","build/collection-memory"))
import z3 as z
n=(globals().get('qualified_layout') or runpy.run_path('verification/collection_memory/layout-frame.py',run_name='__main__'));rows=[]
for label,premises,extra in [
 ('missing-total-headroom',n['premises'][:2]+n['premises'][3:],[z.ULE(n['end'],n['base'])]),
 ('missing-write-range',n['premises'],[n['write']==n['base'],n['read']==n['base'],z.Select(n['after'],n['read'])!=z.Select(n['wire'],n['read'])])]:
 s=z.Solver();s.set(timeout=60000);s.add(*premises,*extra);status=s.check();assert status==z.sat,(label,status,s.reason_unknown());rows.append({'name':label,'result':'sat','witness':str(s.model())});print(label,status,flush=True)
(OUT/'controls.json').write_text(json.dumps({'passed':True,'controls':rows},indent=2)+'\n')
