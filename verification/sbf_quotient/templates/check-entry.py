"""Exploratory overflow-router theorem; no complete division or bridge claim."""
from pathlib import Path
import hashlib,importlib.util,json,sys
import z3 as z
repo=Path(__file__).resolve().parents[2];base=Path(__file__).resolve().parent
sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
# Extend a disposable copy only; maintained verification sources remain frozen.
source=(repo/'verification/sbf_paths.py').read_text()
source=source.replace("elif op in (0x25,0x2d):branch=z.UGT(a,b)","elif op in (0x25,0x2d):branch=z.UGT(a,b)\n   elif op in (0x35,0x3d):branch=z.UGE(a,b)")
source=source.replace('elif op in [0x5f,0x1f]:','elif op in [0x5f,0x1f,0x4f]:').replace('r[dst]=a&b if op==0x5f else a-b','r[dst]=a&b if op==0x5f else a|b if op==0x4f else a-b')
model_path=base/'paths-with-router-ops.py';model_path.write_text(source)
spec=importlib.util.spec_from_file_location('router',model_path);model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
hi,mid=z.BitVecs('product_high product_middle',32);dh,dl=z.BitVecs('denominator_high_storage denominator_low_storage',64)
regs=[z.BitVec('entry_r'+str(i),64) for i in range(10)]+[('stack',0)]
regs[8]=z.ZeroExt(32,hi);regs[1]=z.ZeroExt(32,mid);regs[2]=dh;regs[4]=dl
high=z.Concat(hi,mid);denominator=z.Concat(z.Extract(31,0,dh),z.Extract(31,0,dl))
def execute(raw):return model.execute(raw,address,0x2248,0x2490,regs,{},lambda *_:None)
def solve(claim,wanted):
 solver=z.Solver();solver.set(timeout=30000);solver.add(z.Not(claim));result=solver.check()
 if result!=wanted:raise RuntimeError((str(result),solver.reason_unknown()))
 report={'result':str(result)}
 if result==z.sat:report['witness']={str(v):solver.model().eval(v,model_completion=True).as_long() for v in [hi,mid,dh,dl]}
 return report
state=execute(text);positive=solve(state['guard']==z.ULT(high,denominator),z.unsat)
# Changed inclusive low-limb comparison misses the equality boundary.
bad=bytearray(text);bad[0x2280-address]=0x2d
fault=solve(execute(bytes(bad))['guard']==z.ULT(high,denominator),z.sat)
# A stronger real-number lemma implies the integer no-overflow inequality.
t,e,d=z.Reals('total elapsed duration');solver=z.SolverFor('QF_NRA');solver.set(timeout=30000)
solver.add(t>=0,t<2**64,e>=0,e<d,d>0,t*e>=d*2**64)
result=solver.check()
if result!=z.unsat:raise RuntimeError(('no-overflow lemma',str(result),solver.reason_unknown()))
# Both router outcomes are feasible without application timing/amount assumptions.
reach=[]
for guard in [state['guard'],z.Not(state['guard'])]:
 s=z.Solver();s.add(guard);r=s.check()
 if r!=z.sat:raise RuntimeError('vacuous routing')
 reach.append(str(r))
files=[Path(__file__),model_path,repo/'verification/sbf_paths.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',elf]
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':{str(p):sha(p) for p in files},'entry':0x2248,'stop':0x2490,'instructions':state['coneInstructions'],'routing':positive,'wrongInclusiveComparison':fault,'outcomeReachability':reach,'sourceBoundNoOverflow':{'result':str(result),'domain':'real relaxation: 0<=total<2^64, 0<=elapsed<duration, duration>0 => total*elapsed < duration*2^64'},'scope':'Actual overflow-router bytes reach the continuation exactly when the assumed zero-extended product high limbs encode a value below the low32-packed denominator registers. The real arithmetic lemma is separate: product/denominator register correspondence and carry bounds still need explicit connection to prior proofs. Does not prove division helpers, quotient, whole-handler output, memory validity, or commit.'}
(base/'entry-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':state['coneInstructions'],'routing':positive,'fault':fault,'realLemma':str(result)}))
