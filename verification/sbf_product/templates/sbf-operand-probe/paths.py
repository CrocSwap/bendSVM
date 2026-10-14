"""Restricted acyclic path model from native handler entry to multiplication."""
from pathlib import Path
import collections,hashlib,importlib.util,json,struct,sys
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;root=base.parents[1]
spec=importlib.util.spec_from_file_location('slice',root/'build/sbf-slice-probe/check.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
need=m.need;sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
elf=root/'build/sbf-slice-probe/vesting.so';address,text=m.text_section(elf.read_bytes());entry,stop=0x1438,0x1f38
cfg_spec=importlib.util.spec_from_file_location('sbf_cfg',root/'verification/sbf_cfg.py')
cfg=importlib.util.module_from_spec(cfg_spec);cfg_spec.loader.exec_module(cfg)
sys.path.insert(0,str(root/'verification'))
import sbf_paths as path_model
BRANCHES=cfg.BRANCHES
def graph(text):return cfg.acyclic_cone(text,address,entry,stop)

def analyze(text, capture=None):
 need(z.get_version_string()=='5.1.0','solver pin')
 ins,succ,cone=graph(text);inputs={}
 def word(region,off):
  need(off%4==0 and off>=0,'input word alignment')
  key=(region,off)
  if key not in inputs:inputs[key]=z.BitVec(region+'_'+str(off),32)
  return inputs[key]
 bv=lambda x:z.BitVecVal(x,64)
 regs=[z.BitVec('initial_r'+str(i),64) for i in range(11)]
 regs[1]=('output',0);regs[2]=('context',0);regs[3]=('state',0);regs[4]=('instruction',0);regs[10]=('stack',0)
 state=path_model.execute(text,address,entry,stop,regs,{'output':0,'context':56,'state':128,'instruction':112},word)
 r=state['registers'];mem=state['memory'];guard=state['guard']
 # Native valid-value assumptions; all payload words remain arbitrary U32.
 assumptions=[word('state',0)==1,word('instruction',0)==1]
 pack=lambda region,low:z.Concat(word(region,low+4),word(region,low))
 now=pack('context',0x30);start=pack('state',0x60);end=pack('state',0x6c);elapsed=now-start
 properties=[r[5]==z.ZeroExt(32,z.Extract(63,32,elapsed)),r[7]==(z.ZeroExt(32,z.Extract(31,0,elapsed))<<32),mem[-0xb8]==z.ZeroExt(32,word('state',0x54)),mem[-0xc0]==z.ZeroExt(32,word('state',0x58)),z.ULT(start,now),z.ULT(now,end)]
 def query(claim):
  s=z.Solver();s.set(timeout=30000);s.add(*assumptions,guard,claim);v=s.check();need(v!=z.unknown,'UNKNOWN: '+s.reason_unknown());return s,v
 s,v=query(z.Not(z.And(*properties)));out={'result':str(v),'coneInstructions':len(cone)-1,'mergedNodes':state['mergedNodes'],'inputs':len(inputs),'properties':len(properties)}
 if v==z.sat:out['witness']={region+'_'+str(off):s.model().eval(val,model_completion=True).as_long() for (region,off),val in inputs.items()}
 _,reach=query(z.BoolVal(True));out['reachability']=str(reach)
 if capture is not None:
  capture.update(registers=list(r),memory=dict(mem),guard=guard,assumptions=list(assumptions),inputs=dict(inputs),now=now,start=start,end=end,elapsed=elapsed)
 return out
if __name__=='__main__':
 files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',Path(__file__),elf,root/'build/sbf-slice-probe/check.py',base/'layout-report.json'];bindings={str(p):sha(p) for p in files}
 baseline=analyze(text);need(baseline['result']=='unsat' and baseline['reachability']=='sat','operand path theorem failed: '+json.dumps(baseline))
 bad=bytearray(text);struct.pack_into('<h',bad,0x17a0-address+2,0x58)
 fault=analyze(bytes(bad));need(fault['result']=='sat','wrong total limb not detected')
 need(bindings=={str(p):sha(p) for p in files},'input drift')
 out={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bindings,'entry':entry,'stop':stop,'baseline':baseline,'wrongTotalLimb':fault,'scope':'All acyclic CFG routes from native handler entry to product cutpoint, with modeled immutable context/state/instruction regions and distinct stack. Establishes elapsed-time and total operand mapping and strict middle-time predicates. Native ABI pointer assignment and C-layout correspondence are assumed; full memory safety, source-law connection, suffix output use and whole-handler equivalence are not proved.'}
 (base/'paths-report.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
