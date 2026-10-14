import runpy,os,json,hashlib
from pathlib import Path
if not __debug__:raise RuntimeError('memory proof assertions required')
data=json.loads(Path(os.environ['MEMORY_INPUT']).read_bytes());run=Path(data['runDirectory'])
for p,h in data['sources'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
root='verification/collection_memory/'
def replay(name,**bindings):return runpy.run_path(root+name,run_name='__main__',init_globals=bindings)
layout=replay('layout-frame.py')
replay('controls.py',qualified_layout=layout)
commit=replay('commit-frame.py',qualified_layout=layout)
replay('commit-sequence.py',qualified_commit=commit)
replay('key-stability.py',qualified_commit=commit)
caller=replay('connect-caller.py',qualified_layout=layout)
replay('state-writes.py',qualified_caller=caller)
replay('native-commit.py')
replay('native-state.py')
for p,h in data['sources'].items():assert hashlib.sha256(Path(p).read_bytes()).hexdigest()==h,p
print('Memory proof/native bundle completed')
