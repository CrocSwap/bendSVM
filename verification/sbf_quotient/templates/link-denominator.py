"""Fresh isolated product/tail/router connection; no division-helper theorem."""
from pathlib import Path
import contextlib,hashlib,importlib.util,json,os,subprocess,sys,uuid
import z3 as z
repo=Path(__file__).resolve().parents[2];base=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
qualified=Path(os.environ['SBF_PRODUCT_QUALIFICATION'])
run=base/'runs'/str(uuid.uuid4());run.mkdir(parents=True)
files=['verification/sbf_machine.py','verification/sbf_cfg.py','verification/sbf_paths.py','verification/sbf_elf.py','build/sbf-slice-probe/check.py','build/sbf-slice-probe/vesting.so','build/sbf-carry-probe/check.py','build/sbf-carry-probe/compose.py','build/sbf-carry-probe/product.py','build/sbf-operand-probe/paths.py','build/sbf-operand-probe/link-product.py','build/sbf-product-tail/check.py']
inputs={}
for rel in files:
 src=qualified/rel;dst=run/rel;dst.parent.mkdir(parents=True,exist_ok=True);dst.write_bytes(src.read_bytes());inputs[str(src)]=sha(src)
router=run/'build/sbf-division-scout/check-entry.py';router.parent.mkdir(parents=True);router.write_bytes((base/'check-entry.py').read_bytes());inputs[str(base/'check-entry.py')]=sha(base/'check-entry.py')
snapshots={str(p):sha(p) for p in run.rglob('*.py')};snapshots[str(run/'build/sbf-slice-probe/vesting.so')]=sha(run/'build/sbf-slice-probe/vesting.so')
log=run/'fresh-product.log'
with log.open('w') as f:
 result=subprocess.run([sys.executable,str(run/'build/sbf-operand-probe/link-product.py')],stdout=f,stderr=subprocess.STDOUT,timeout=180)
if result.returncode:raise RuntimeError('fresh product chain failed '+str(log))
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
with (run/'fresh-tail-router.log').open('w') as f,contextlib.redirect_stdout(f):
 tail=load('tail_bridge',run/'build/sbf-product-tail/check.py')
 route=load('router_bridge',router)
# These pending words originate in the freshly checked entry path. The complete
# product/carry/tail interval has no call and writes only fixed stack addresses;
# check exclusion before lifting the three words through that interval.
import struct
pending_offsets=[-0x160,-0x138,-0x168]
for at in range(0x1f38,tail.end,8):
 op,ds,off,imm=struct.unpack_from('<BBhi',tail.text,at-tail.address)
 if op==0x85:raise RuntimeError('unexpected product call before pending transport')
 if op in (0x63,0x62,0x7a,0x7b):
  if ds&15!=10:raise RuntimeError('nonstack product write before pending transport')
  width=8 if op in (0x7a,0x7b) else 4
  if any(off<slot+8 and slot<off+width for slot in pending_offsets):raise RuntimeError('product overwrites pending division word')
# Bind the transported words to the same declared clock variables used by the
# certified denominator tail. Keeping unrelated state_96/startlo symbols would
# silently leave the small-route zero guard disconnected from its divisor.
wi=tail.world['inputs'];we=lambda at:z.ZeroExt(32,wi[('state',at)])
origin=z.And(tail.world['memory'][-0x138]==we(96),tail.world['memory'][-0x168]==we(108))
solver=z.Solver();solver.set(timeout=30000);solver.add(*tail.world['assumptions'],tail.world['guard'],z.Not(origin));origin_result=solver.check()
if origin_result!=z.unsat:raise RuntimeError(('pending clock origin',str(origin_result),solver.reason_unknown()))
clock_pairs=[(wi[('state',96)],tail.startlo),(wi[('state',100)],tail.starthi),(wi[('state',108)],tail.endlo),(wi[('state',112)],tail.endhi)]
for off in pending_offsets:tail.memory[off]=z.substitute(tail.world['memory'][off],*clock_pairs)
r,mem,zero=tail.execute(tail.code)
duration=z.Concat(tail.endhi,tail.endlo)-z.Concat(tail.starthi,tail.startlo)
packed=lambda regs:z.Concat(z.Extract(31,0,regs[2]),z.Extract(31,0,regs[4]))
rows=[{'name':'pending clock words originate in actual checked entry','result':'unsat'}]
def prove(name,claim,assumptions=(),wanted=z.unsat):
 s=z.Solver();s.set(timeout=30000);s.add(*assumptions,z.Not(claim));v=s.check()
 if v!=wanted:raise RuntimeError((name,str(v),s.reason_unknown()))
 row={'name':name,'result':str(v)}
 if v==z.sat:row['witness']=str(s.model())
 rows.append(row)
prove('actual denominator registers equal end minus start',packed(r)==duration)
prove('actual carry middle register is U32',z.LShR(r[1],32)==0)
prove('nonzero duration gate',z.And(duration!=0,z.Not(zero)),tail.positive_assumptions)
# The router masks r5 before comparison, so full-width carry accumulation is valid.
route_regs=list(r);route_regs[10]=('stack',0)
state=route.model.execute(route.text,route.address,0x2248,0x2490,route_regs,{},lambda *_:None,mem)
upper=z.Concat(z.Extract(31,0,tail.expected_top),z.Extract(31,0,r[1]))
prove('composed continuation equals product upper64 below duration',state['guard']==z.ULT(upper,duration))
# Fault the actual borrow subtraction; use a schedule with low-word borrow.
bad=bytearray(tail.code);bad[0x21c0-tail.start]=0x4f
wrong,_,_=tail.execute(bytes(bad))
prove('wrong denominator borrow is detected',packed(wrong)==duration,tail.positive_assumptions,z.sat)
if snapshots!={p:sha(p) for p in snapshots} or inputs!={p:sha(p) for p in inputs}:raise RuntimeError('input drift')
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':inputs,'snapshotHashes':snapshots,'controllerSha256':sha(Path(__file__)),'claims':rows,'prerequisiteHashes':{str(p):sha(p) for p in run.rglob('*report.json')},'logs':{str(p):sha(p) for p in run.glob('*.log')},'scope':'Fresh product correspondence, tail and router checks; actual packed denominator=end-start, carry middle bound, and router continuation equals distributed-product upper64<duration. ABI/valid memory and source layout premises remain conditional. The separate real no-overflow lemma still needs explicit numeric-interpretation connection; no division-helper or quotient, whole-handler, or VM-replay claim for this extension.'}
(run/'bridge.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'runRoot':str(run),'claims':rows}))
