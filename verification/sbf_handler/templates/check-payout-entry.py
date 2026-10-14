"""Discharge retained payout-limb bindings from actual native handler entry."""
from pathlib import Path
import hashlib,importlib.util,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
from sbf_elf import text_section
if not __debug__:raise RuntimeError('assertions required')
# Disposable model extension uses the same ADD/MUL wrapping semantics as sbf_machine.
source=repo/'verification/sbf_leaf.py';model_path=base/'payout-prefix-model.py';src=source.read_text()
needle='  elif op in [0x5f,0x1f,0x4f]:'
replacement="""  elif op in [0x0f,0x2f]:
   need(off==0 and imm==0 and dst<10 and src<10,'arithmetic fields');a=scalar(r[dst]);b=scalar(r[src]);r[dst]=a+b if op==0x0f else a*b
"""+needle
if src.count(needle)!=1:raise RuntimeError('model extension location')
model_path.write_text(src.replace(needle,replacement));spec=importlib.util.spec_from_file_location('payout_prefix_model',model_path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
regs=[z.BitVec('payout_entry_r'+str(i),64) for i in range(11)];regs[1]=('output',0);regs[2]=('context',0);regs[3]=('state',0);regs[4]=('instruction',0);regs[10]=('stack',0)
inputs={}
def word(region,offset):
 key=(region,offset)
 if key not in inputs:inputs[key]=z.BitVec(region+'_'+str(offset),32)
 return inputs[key]
expected={-0xb8:0x54,-0xc0:0x58,-0x128:0x78,-0x130:0x7c}
def execute(raw,stop):return m.execute(raw,address,0x1438,stop,regs,{'output':0,'context':56,'state':128,'instruction':112},word)
rows=[]
def prove(name,claim,assumptions=()):
 s=z.Solver();s.set(timeout=30000);s.add(*assumptions,z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 rows.append({'name':name,'result':str(result)})
states={}
for name,stop in [('product',0x1f38),('division-route',0x2490)]:
 state=execute(text,stop);states[name]=state
 for off,at in expected.items():
  prove(name+' native state limb '+hex(at),z.Implies(state['guard'],state['memory'][off]==z.ZeroExt(32,word('state',at))))
 prove(name+' retained limbs are U32',z.Implies(state['guard'],z.And(*(z.LShR(state['memory'][off],32)==0 for off in expected))))
 # Concrete valid payload permits native Live/Claim and strict-middle-time route.
 s=z.Solver();s.set(timeout=30000);s.add(state['guard'],word('state',0)==1,word('instruction',0)==1)
 for at,value in [(0x54,100),(0x58,0),(0x60,0),(0x64,0),(0x6c,10),(0x70,0),(0x78,0),(0x7c,0)]:s.add(word('state',at)==value)
 s.add(word('context',0x30)==5,word('context',0x34)==0)
 result=s.check()
 if result!=z.sat:raise RuntimeError(('reachability',name,str(result),s.reason_unknown()))
 rows.append({'name':name+' middle-time witness','result':'sat','witness':{region+'_'+str(off):s.model().eval(v,model_completion=True).as_long() for (region,off),v in inputs.items()}})
# An actual load of total's low limb in place of claimed's low limb must be noticed.
bad=bytearray(text);struct.pack_into('<h',bad,0x1760-address+2,0x54)
fault=execute(bytes(bad),0x1f38);s=z.Solver();s.set(timeout=30000);s.add(word('state',0)==1,word('instruction',0)==1,fault['guard'],fault['memory'][-0x128]!=z.ZeroExt(32,word('state',0x78)));result=s.check()
if result!=z.sat:raise RuntimeError(('missed claimed load fault',str(result)))
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'fault':{'name':'claimed load uses total limb','result':str(result),'witness':str(s.model())},'instructions':{k:v['coneInstructions'] for k,v in states.items()},'inputHashes':{str(p):sha(p) for p in [Path(__file__),source,model_path,repo/'verification/sbf_machine.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',elf]},'scope':'Actual native entry through division-route entry binds four retained total/claimed stack values to zero-extended state fields54/58/78/7c, discharging U32 stack premises of payout guards through separate frame-preservation proof. Native state C layout/pointer ABI, valid immutable disjoint regions, restricted interpreter and solver remain trusted. Does not prove full source extraction, output effects or commit.'}
out=base/'payout-entry-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'instructions':report['instructions'],'report':str(out)}))
