"""Exploratory emitted div4 leaf check against four restoring-division steps."""
from pathlib import Path
import hashlib,importlib.util,json,struct,sys
import z3 as z
repo=Path(__file__).resolve().parents[2];base=Path(__file__).resolve().parent
sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
source=(repo/'verification/sbf_leaf.py').read_text()
model_path=base/'paths-div4.py';model_path.write_text(source)
spec=importlib.util.spec_from_file_location('div4_model',model_path);model=importlib.util.module_from_spec(spec);spec.loader.exec_module(model)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
q,r,d=z.BitVecs('quotient remainder divisor',64)
words={8:z.Extract(31,0,q),12:z.Extract(63,32,q),20:z.Extract(31,0,r),24:z.Extract(63,32,r),32:z.Extract(31,0,d),36:z.Extract(63,32,d)}
regs=[z.BitVec('entry_r'+str(i),64) for i in range(10)]+[('stack',0)];regs[1]=('output',0);regs[2]=('input',0)
def reader(region,offset):
 if region!='input' or offset not in words:raise ValueError('unexpected leaf input read')
 return words[offset]
def execute(raw):return model.execute(raw,address,0x5c50,0x6390,regs,{'input':40,'output':40},reader)
expected_q,expected_r=q,r
for _ in range(4):
 shift=(expected_r<<1)|z.LShR(expected_q,63)
 reduce=z.Or(z.Extract(63,63,expected_r)==1,z.UGE(shift,d))
 expected_r=z.If(reduce,shift-d,shift)
 expected_q=(expected_q<<1)|z.If(reduce,z.BitVecVal(1,64),z.BitVecVal(0,64))
expected={0:z.BitVecVal(0,32),4:z.BitVecVal(0,32),8:z.Extract(31,0,expected_q),12:z.Extract(63,32,expected_q),16:z.BitVecVal(0,32),20:z.Extract(31,0,expected_r),24:z.Extract(63,32,expected_r),28:z.BitVecVal(0,32),32:z.Extract(31,0,d),36:z.Extract(63,32,d)}
def claim(state):
 output={k[1]:v for k,v in state['memory'].items() if isinstance(k,tuple)}
 if set(output)!=set(expected):raise RuntimeError('incomplete output footprint')
 if set(state['words'])!={('input',k) for k in words}:raise RuntimeError('input footprint')
 return z.And(state['guard'],*[output[k]==v for k,v in expected.items()])
def solve(name,property,wanted):
 s=z.Solver();s.set(timeout=60000);s.add(z.Not(property));result=s.check()
 if result!=wanted:raise RuntimeError((name,str(result),s.reason_unknown()))
 out={'name':name,'result':str(result)}
 if result==z.sat:out['witness']={str(v):s.model().eval(v,model_completion=True).as_long() for v in [q,r,d]}
 return out
# state=execute(text);positive= (definition boundary; no monolithic query)
