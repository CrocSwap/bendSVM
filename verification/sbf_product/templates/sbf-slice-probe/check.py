"""Exploratory conditional arithmetic proof over bytes of an existing SBF ELF."""
from pathlib import Path
import hashlib,json,struct
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;sha=lambda b:hashlib.sha256(b).hexdigest()
def need(ok,msg):
 if not ok:raise ValueError(msg)
import importlib.util
elf_spec=importlib.util.spec_from_file_location('sbf_elf',base.parents[1]/'verification/sbf_elf.py')
elf_model=importlib.util.module_from_spec(elf_spec);elf_spec.loader.exec_module(elf_model)
text_section=elf_model.text_section
# The reusable scalar model is maintained source; fixture proof remains experimental.
import importlib.util
machine_path=base.parents[1]/'verification/sbf_machine.py'
spec=importlib.util.spec_from_file_location('sbf_machine',machine_path)
machine=importlib.util.module_from_spec(spec);spec.loader.exec_module(machine)
execute=machine.execute
def entry_state(alo,ahi,blo,bhi,register_prefix='r'):
 initial=[z.BitVec(register_prefix+str(i),64) for i in range(11)]
 initial[5]=z.ZeroExt(32,ahi);initial[7]=z.ZeroExt(32,alo)<<32
 memory={-0xb8:z.ZeroExt(32,blo),-0xc0:z.ZeroExt(32,bhi),-0xd8:z.BitVec('incoming_start_high',64),-0x108:z.BitVecVal(1,64)}
 return initial,memory

def prove(code,pin=None):
 need(z.get_version_string()=='5.1.0','solver pin')
 alo,ahi,blo,bhi=z.BitVecs('alo ahi blo bhi',32);ext=lambda v:z.ZeroExt(32,v);low=lambda v:z.ZeroExt(32,z.Extract(31,0,v));high=lambda v:z.LShR(v,32)
 initial,memory=entry_state(alo,ahi,blo,bhi)
 regs,mem,writes,ins=execute(code,initial,memory);need(writes=={-0x150,-0xe0,-0xa8},'unexpected stack frame')
 p00=ext(alo)*ext(blo);p10=ext(ahi)*ext(blo);p01=ext(alo)*ext(bhi);p11=ext(ahi)*ext(bhi)
 expected=list(initial);expected[0]=p00;expected[1]=low(p10)+high(p00);expected[2]=high(p10)+low(p11);expected[4]=p01<<32;expected[5]=low(expected[1]);expected[7]=p01;expected[8]=z.BitVecVal(1,64)
 wanted={**memory,-0x150:p00,-0xe0:p11,-0xa8:expected[5]};bad=z.Or(*[a!=b for a,b in zip(regs,expected)],*[mem[k]!=v for k,v in wanted.items()])
 solver=z.Solver();solver.set(timeout=30000);solver.add(bad)
 if pin is not None:
  for v,n in zip([alo,ahi,blo,bhi],pin):solver.add(v==n)
 result=solver.check();need(result!=z.unknown,'UNKNOWN: '+solver.reason_unknown());row={'result':str(result),'instructions':len(ins),'writes':sorted(writes)}
 if result==z.sat:
  m=solver.model();row['witness']={str(v):m.eval(v,model_completion=True).as_long() for v in [alo,ahi,blo,bhi]};row['actualRegisters']=[m.eval(v,model_completion=True).as_long() for v in regs];row['expectedRegisters']=[m.eval(v,model_completion=True).as_long() for v in expected]
 return row
