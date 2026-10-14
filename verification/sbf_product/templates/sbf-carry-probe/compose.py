"""Fresh theorem prerequisites and exact symbolic boundary matching."""
from pathlib import Path
import hashlib,importlib.util,json
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('carry',base/'check.py');carry=importlib.util.module_from_spec(spec);spec.loader.exec_module(carry)
first=carry.c;need=first.need
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
elf=base.parent/'sbf-slice-probe/vesting.so'
files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',elf,base/'check.py',base.parent/'sbf-slice-probe/check.py',Path(__file__)]
bindings={str(p):sha(p) for p in files}
addr,text=first.text_section(elf.read_bytes())
start,cut,end=0x1f38,0x2020,0x21a8
need(addr<=start<cut<end<=addr+len(text),'composition slice bounds')
prefix=text[start-addr:cut-addr];suffix=text[cut-addr:end-addr]
first_result=first.prove(prefix);need(first_result['result']=='unsat','fresh prefix prerequisite')
# Observe the exact symbolic entry passed by the real suffix theorem, avoiding
# a separate handwritten copy of its entry predicate.
captured={};original_execute=carry.execute
def capture(code,regs,mem):
    need(not captured,'exactly one suffix execution')
    captured.update(regs=list(regs),mem=dict(mem),code=code)
    return original_execute(code,regs,mem)
try:
    carry.execute=capture
    second_result=carry.prove(suffix)
finally:carry.execute=original_execute
need(second_result['result']=='unsat' and captured['code']==suffix,'fresh suffix prerequisite')
a0,a1,b0,b1=z.BitVecs('bridge_alo bridge_ahi bridge_blo bridge_bhi',32)
ext=lambda x:z.ZeroExt(32,x)
initial,memory=first.entry_state(a0,a1,b0,b1,'entry_r');memory[-0x188]=z.BitVec('unrelated_stack',64)
actual,actual_mem,writes,_=first.execute(prefix,initial,memory)
products=[ext(a0)*ext(b0),ext(a1)*ext(b0),ext(a0)*ext(b1),ext(a1)*ext(b1)]
sub=list(zip(z.BitVecs('p00 p10 p01 p11',64),products))
expected=[z.substitute(v,*sub) for v in captured['regs']]
expected_mem={k:z.substitute(v,*sub) for k,v in captured['mem'].items()}
properties=[x==y for x,y in zip(actual,expected)]+[actual_mem[k]==v for k,v in expected_mem.items()]
# The suffix's frame can include extra untouched slots. Check both parsers keep them.
_,suffix_mem,suffix_writes,_=original_execute(suffix,actual,actual_mem)
properties += [suffix_mem[k]==memory[k] for k in [-0xb8,-0xc0,-0x188]]
need(writes=={-0x150,-0xe0,-0xa8} and suffix_writes=={-0x148,-0xa8,-0x170,-0x180,-0x178,-0x108},'composed frame inventory')
def solve(ps,pin=False):
    s=z.Solver();s.set(timeout=30000);s.add(z.Not(z.And(*ps)))
    if pin:s.add(a0==3,a1==5,b0==7,b1==11)
    result=s.check();need(result!=z.unknown,'UNKNOWN: '+s.reason_unknown())
    out={'result':str(result)}
    if result==z.sat:
        m=s.model();out['limbs']={str(v):m.eval(v,model_completion=True).as_long() for v in [a0,a1,b0,b1]}
    return out
bridge=solve(properties);need(bridge['result']=='unsat','boundary mismatch')
fault=list(properties);fault[1]=(actual[1]^z.BitVecVal(1,64))==expected[1]
negative=solve(fault,True);need(negative['result']=='sat','boundary mismatch control missed')
need(bindings=={str(p):sha(p) for p in files},'input drift')
out={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bindings,'range':[start,end],'cutpoint':cut,'instructions':len(prefix+suffix)//8,'sliceSha256':hashlib.sha256(prefix+suffix).hexdigest(),'freshPrefix':first_result,'freshSuffix':second_result,'boundary':bridge,'matchedRegisters':11,'matchedRequiredStackSlots':sorted(expected_mem),'extraStackFrameSlots':[-0xb8,-0xc0,-0x188],'boundaryFault':negative,'scope':'Fresh conditional block proofs connected by universal equality of actual prefix outputs and exact captured suffix entry expressions. Establishes distributed partial-product sum under original entry assumptions. Mathematical equivalence to a full source multiplication, original-handler reachability, later top-limb accumulation and final output use are not established.'}
(base/'composition-report.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
