"""Current 128/32 slice: actual DIV obligations, limb algebra and controls."""
from pathlib import Path
import hashlib,importlib.util,json,sys
import z3 as z
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
# Keep the shared restricted executor unchanged. This recorded local extension
# models only register MUL with the same reserved-field/scalar checks as ALU.
original=repo/'verification/sbf_leaf.py';source=original.read_text()
old='elif op in [0x5f,0x1f,0x4f]:';assert source.count(old)==1
source=source.replace(old,'elif op in [0x5f,0x1f,0x4f,0x2f]:')
old='a&b if op==0x5f else a|b if op==0x4f else a-b';assert source.count(old)==1
source=source.replace(old,'a&b if op==0x5f else a|b if op==0x4f else a*b if op==0x2f else a-b')
model=base/'small-quotient-model.py';model.write_text(source)
spec=importlib.util.spec_from_file_location('small_quotient_model',model);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
q,saved=z.BitVecs('small_q small_saved',64)
h,start,end,raw_d,raw_q=z.BitVecs('small_h small_start small_end small_raw_d small_raw_q',32)
d=end-start;ext=lambda v:z.ZeroExt(32,v);lo=lambda v:z.Extract(31,0,v)
regs=[z.BitVec('small_r'+str(i),64) for i in range(10)]+[('stack',0)]
regs[5]=ext(d);regs[4]=z.Concat(raw_d,d)
mem={-0x138:ext(start),-0x168:ext(end),-0x178:ext(h)<<32,-0x180:ext(z.Extract(63,32,q)),-0x150:z.Concat(raw_q,lo(q)),-0xe0:saved,-0x160:z.BitVec('small_flag',64)}
rows=[]
def prove(name,claim,want=z.unsat):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));result=s.check()
 assert result==want,(name,str(result),s.reason_unknown())
 row={'name':name,'result':str(result)}
 if result==z.sat:row['witness']=str(s.model())
 rows.append(row)
def run(code):return m.execute(code,address,0x2680,0x2748,regs,{},lambda *_:None,mem,native_division=True)
state=run(text);assert state['divisionChecks']==2
prove('actual small clock guard equals nonzero divisor',state['guard']==(d!=0))
rows.append({'name':'both actual small divisions always nonzero','result':'unsat'})
# Prove the actual arguments and packing using arbitrary quotient placeholders.
# UDiv congruence then instantiates those identities with the actual divisions;
# no quotient relation is assumed in these bitvector identities.
def divisions(expr):
 found={}
 def walk(v):
  if v.get_id() in found:return
  if z.is_app(v) and v.decl().kind() in (z.Z3_OP_BUDIV,z.Z3_OP_BUDIV_I):found[v.get_id()]=v
  for c in v.children():walk(c)
 walk(expr);return sorted(found.values(),key=lambda v:v.num_args() and len(v.sexpr()))
terms=divisions(state['memory'][-0xa8]);assert len(terms)==2
first,second=terms;assert first.decl().kind() in (z.Z3_OP_BUDIV,z.Z3_OP_BUDIV_I) and second.decl().kind() in (z.Z3_OP_BUDIV,z.Z3_OP_BUDIV_I)
n1=(ext(h)<<32)|ext(z.Extract(63,32,q))
prove('actual first division numerator and divisor',z.And(first.arg(0)==n1,first.arg(1)==ext(d)))
qh,ql=z.BitVecs('small_arbitrary_qh small_arbitrary_ql',64)
remainder=n1-qh*ext(d);n2=(remainder<<32)|ext(lo(q))
prove('actual second division numerator and divisor',z.And(z.substitute(second.arg(0),(first,qh))==n2,second.arg(1)==ext(d)))
packed=z.substitute(state['memory'][-0xa8],(second,ql),(first,qh))
prove('actual quotient packing ignores unobserved upper limbs',packed==((qh<<32)|ext(lo(ql))))
prove('actual small context and declared frame preservation',z.And(state['registers'][3]==saved,*[state['memory'][k]==v for k,v in mem.items()]))
# These concrete faults execute the same model and actual mutated instruction
# bytes. They must change a successful quotient, rather than merely time out.
concrete=[(q,z.BitVecVal(0x0123456789abcdef,64)),(h,z.BitVecVal(1,32)),(start,z.BitVecVal(0,32)),(end,z.BitVecVal(2,32)),(raw_d,z.BitVecVal(0x12345678,32)),(raw_q,z.BitVecVal(0x87654321,32))]
for name,pc,old,new in [('first DIV replaced by SUB',0x26b8,0x3f,0x1f),('second DIV replaced by SUB',0x2700,0x3f,0x1f),('remainder MUL replaced by OR',0x26c8,0x2f,0x4f)]:
 bad=bytearray(text);assert bad[pc-address]==old;bad[pc-address]=new;fault=run(bytes(bad))
 prove(name,z.substitute(fault['memory'][-0xa8]==state['memory'][-0xa8],*concrete),z.sat)
bad=bytearray(text);assert bad[0x2690-address]==0x1d;bad[0x2690-address]=0x5d
try:run(bytes(bad))
except ValueError as e:assert str(e)=='division nonzero obligation: sat'
else:raise RuntimeError('inverted clock guard accepted')
rows.append({'name':'inverted clock guard unsafe division detected','result':'refused','reason':'division nonzero obligation: sat'})
for label,byte,value in [('MUL reserved immediate',4,1),('MUL reserved offset',2,1),('MUL frame source',1,0xa1)]:
 bad=bytearray(text);bad[0x26c8-address+byte]=value
 try:run(bytes(bad))
 except ValueError as e:assert str(e) in ['ALU fields','scalar required']
 else:raise RuntimeError('accepted '+label)
 rows.append({'name':label,'result':'refused'})
for pc,dst in [(0x26b8,2),(0x2700,3)]:
 for label,byte,value in [('reserved immediate',4,1),('reserved offset',2,1),('frame source',1,0xa0|dst)]:
  bad=bytearray(text);bad[pc-address+byte]=value
  try:run(bytes(bad))
  except ValueError as e:assert str(e)=='division fields'
  else:raise RuntimeError('accepted malformed small DIV '+label)
  rows.append({'name':hex(pc)+' DIV '+label,'result':'refused'})
files=[Path(__file__),model,original,elf,repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']
report={'passed':True,'exploratory':True,'endToEndVerified':False,'range':[0x2680,0x2748],'divisionChecks':2,'claims':rows,'inputHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files},'scope':'Actual 128/32 instruction slice under declared current caller spill interpretation. Both nonzero-divisor obligations discharge from the emitted clock guard. Universal bitvector argument/packing identities use arbitrary quotient placeholders and UDiv congruence. Integer Euclidean bounds, actual product-entry binding and VM replay are separate prerequisites. MUL/DIV semantics, Z3 and valid disjoint frame memory remain trusted; no whole-handler or end-to-end compiler claim.'}
(base/'small-quotient-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'divisionChecks':2}))
