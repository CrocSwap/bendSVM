if not __debug__:raise RuntimeError('assertions required')
from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
from cpi_caller import custody
z=custody.z
if not __debug__ or z.get_version_string()!='5.1.0':raise RuntimeError('assertions and pinned Z3 required')
files={n:Path('runtime',n).read_text() for n in ('bend_cpi.h','cpi_abi.h','solana_min.h')}
paths=[Path(__file__),Path(custody.__file__),*Path('verification').rglob('*.py'),*[Path('runtime',n) for n in files]]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
inputs={str(p):sha(p) for p in paths}
parsed=custody.parse(files);keys=[z.BitVec('key'+str(i),256) for i in range(12)];program=z.BitVec('program',256)
status,bump,expected=custody.outputs(parsed,keys,program)
solver=z.Solver();solver.set(timeout=30000);solver.add((status==0)!=expected);assert solver.check()==z.unsat
solver=z.Solver();solver.set(timeout=30000);solver.add(status==0);assert solver.check()==z.sat
controls=[]
for name,old,new in [('wrong-seed-account','a[0].key','a[1].key'),('wrong-custody-account','a[3].key','a[4].key'),('wrong-prefix',"'b','e','n','d'","'b','e','n','x'"),('wrong-seed-length','a[0].key,32','a[0].key,31'),('ignored-syscall-failure',')) return 11;', ')) return 0;')]:
 text=files['bend_cpi.h'];assert text.count(old)>=1
 # Restrict each mutation to the custody body, leaving validator/executor intact.
 start=text.index(custody.SIGNATURE);end=text.index('\n}',start)+2
 body=text[start:end];assert body.count(old)==1;changed={**files,'bend_cpi.h':text[:start]+body.replace(old,new)+text[end:]}
 try:custody.parse(changed)
 except custody.Grammar as e:controls.append({'name':name,'result':'refused','reason':str(e)})
 else:raise AssertionError(name)
# A changed binding to another account must admit a success disagreement.
wrong,_,_=custody.outputs({**parsed,'custodyAccount':4},keys,program)
solver=z.Solver();solver.set(timeout=30000);solver.add((wrong==0)!=expected);assert solver.check()==z.sat
controls.append({'name':'wrong-model-custody-binding','result':'sat','countermodel':str(solver.model())})
assert all(sha(Path(p))==h for p,h in inputs.items()),'source drift'
report={'passed':True,'scope':'Reviewed-template component only, not interpreted C or complete caller proof. Valid native pointers and deterministic PDA syscall are assumptions.','successEquivalence':'unsat','successWitness':'sat','controls':controls,'inputs':inputs}
Path(sys.argv[1]).write_text(json.dumps(report,indent=2)+'\n');print('CPI custody template positive, success equivalence, five source refusals and binding counterexample passed')
