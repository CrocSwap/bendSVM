"""Actual high-word accumulation and nonzero-denominator branch at division entry."""
from pathlib import Path
import hashlib,importlib.util,json,struct
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;root=base.parents[1]
def module(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
carry=module('carry',root/'build/sbf-carry-probe/check.py');paths=module('paths',root/'build/sbf-operand-probe/paths.py');need=carry.c.need
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',Path(__file__),root/'build/sbf-carry-probe/check.py',root/'build/sbf-slice-probe/check.py',root/'build/sbf-operand-probe/paths.py',paths.elf]
bindings={str(p):sha(p) for p in files}
address,text=carry.c.text_section(paths.elf.read_bytes());start,end=0x21a8,0x2248;code=text[start-address:end-address]
world={};path_result=paths.analyze(paths.text,world);need(path_result['result']=='unsat','path prerequisite')
# Capture fresh carry theorem's actual exit expressions, including all spill slots.
captured={};original=carry.execute
def observe(code,regs,mem):
 result=original(code,regs,mem);captured.update(regs=result[0],memory=result[1]);return result
try:
 carry.execute=observe
 prerequisite=carry.prove(text[0x2020-address:start-address])
finally:carry.execute=original
need(prerequisite['result']=='unsat','carry prerequisite')
startlo,starthi,endlo,endhi=z.BitVecs('startlo starthi endlo endhi',32)
ext=lambda x:z.ZeroExt(32,x)
borrow=z.If(z.ULT(endlo,startlo),z.BitVecVal(1,64),z.BitVecVal(0,64))
sub=(z.BitVec('incoming_start_high',64),ext(starthi))
initial=[z.substitute(v,sub) for v in captured['regs']]
memory={k:z.substitute(v,sub) for k,v in captured['memory'].items()}
memory.update({-0xc8:ext(endhi),-0xd0:ext(endlo),-0xb0:ext(startlo),-0x140:borrow})
expected_top=initial[8]+z.LShR(memory[-0xe0],32)+memory[-0x148]+initial[7]+memory[-0x108]

def execute(code):
 r=list(initial);mem=dict(memory);condition=None
 for i in range(0,len(code),8):
  op,ds,off,imm=struct.unpack_from('<BBhi',code,i);dst=ds&15;src=ds>>4
  if op in [0x1f,0x4f]:
   need(dst<10 and src<=10 and off==0 and imm==0,'tail scalar shape');r[dst]=r[dst]-r[src] if op==0x1f else r[dst]|r[src]
  elif op in [0x15,0x55]:
   need(condition is None and start+i==0x2200 and dst==9 and src==0 and off==0x20 and imm==0,'tail branch shape')
   condition=r[9]==0 if op==0x15 else r[9]!=0
  else:r,mem,_,_=carry.c.execute(code[i:i+8],r,mem)
 need(condition is not None,'missing denominator branch')
 return r,mem,condition

def solve(claim,assumptions,want):
 s=z.Solver();s.set(timeout=30000);s.add(*assumptions,z.Not(claim));r=s.check();need(r==want,'unexpected solver result '+str(r)+(' '+s.reason_unknown() if r==z.unknown else ''))
 row={'result':str(r)}
 if r==z.sat:row['witness']=str(s.model())
 return row
# Bind additional stack premises to the real path state, rather than assume their meanings.
wi=world['inputs'];we=lambda at:z.ZeroExt(32,wi[('state',at)])
expected={-0xc8:we(112),-0xd0:we(108),-0xb0:we(96),-0xd8:we(100),-0x140:z.If(z.ULT(wi[('state',108)],wi[('state',96)]),z.BitVecVal(1,64),z.BitVecVal(0,64))}
bridge=solve(z.And(*[world['memory'][k]==v for k,v in expected.items()]),world['assumptions']+[world['guard']],z.unsat)
positive_assumptions=[z.ULT(z.Concat(starthi,startlo),z.Concat(endhi,endlo))]
def property(code):
 r,mem,taken=execute(code)
 return z.And(z.Not(taken),r[8]==expected_top,r[1]==initial[1],*[mem[k]==v for k,v in memory.items()])
positive=solve(property(code),positive_assumptions,z.unsat)
faults=[]
for name,at,opcode in [('subtract-upper-carry',0x2218,0x1f),('inverted-denominator-test',0x2200,0x55)]:
 bad=bytearray(code);bad[at-start]=opcode;row=solve(property(bytes(bad)),positive_assumptions,z.sat);faults.append({'name':name,**row})
need(bindings=={str(p):sha(p) for p in files},'input drift')
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bindings,'range':[start,end],'sliceSha256':hashlib.sha256(code).hexdigest(),'instructions':len(code)//8,'freshPath':path_result,'freshCarry':prerequisite,'extraStackBoundary':bridge,'tail':positive,'faults':faults,'scope':'Actual20instruction suffix computes the reconstructed top word in r8, preserves lower product limbs and memory, and cannot take the zero-denominator branch when end>start. Five extra stack premises proved from native-entry path state. Still needs integrated product-chain report and VM replay; division/final output/commit remain unproved.'}
(base/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':report['instructions'],'extraStackBoundary':bridge,'tail':positive,'faults':len(faults)}))
