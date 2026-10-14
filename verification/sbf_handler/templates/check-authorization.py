"""Actual deferred authorization flag and native rejection discriminants."""
from pathlib import Path
import hashlib,importlib.util,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
from sbf_elf import text_section
model=base/'payout-prefix-model.py';spec=importlib.util.spec_from_file_location('auth_prefix',model);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
regs=[z.BitVec('auth_r'+str(i),64) for i in range(11)];regs[1]=('output',0);regs[2]=('context',0);regs[3]=('state',0);regs[4]=('instruction',0);regs[10]=('stack',0)
inputs={}
def word(region,off):
 key=(region,off)
 if key not in inputs:inputs[key]=z.BitVec('auth_'+region+'_'+str(off),32)
 return inputs[key]
authorized=z.And(word('context',40)!=0,*(word('context',8+4*i)==word('state',12+4*i) for i in range(8)))
rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=30000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 rows.append({'name':name,'result':str(result)})
def entry(raw,stop):return m.execute(raw,address,0x1438,stop,regs,{'output':0,'context':56,'state':128,'instruction':112},word)
for name,stop in [('product',0x1f38),('division-route',0x2490)]:
 state=entry(text,stop)
 prove(name+' exact signer and eight-word equality flag',z.Implies(state['guard'],state['memory'][-0x160]==z.If(authorized,z.BitVecVal(1,64),z.BitVecVal(0,64))))
 for value in [True,False]:
  s=z.Solver();s.set(timeout=30000);s.add(state['guard'],word('state',0)==1,word('instruction',0)==1,authorized==value)
  for region,off,val in [('state',84,100),('state',88,0),('state',96,0),('state',100,0),('state',108,10),('state',112,0),('context',48,5),('context',52,0)]:s.add(word(region,off)==val)
  result=s.check()
  if result!=z.sat:raise RuntimeError(('authorization reachability',name,value,str(result)))
  rows.append({'name':name+' authorized='+str(value)+' witness','result':'sat','witness':str(s.model())})
flag=z.BitVec('deferred_flag',64);scalar_regs=[z.BitVec('deferred_r'+str(i),64) for i in range(10)]+[('stack',0)];scalar_regs[9]=flag
for name,stop,want in [('authorized-output',0x2b88,(flag&1)!=0),('unauthorized-output',0x2a20,(flag&1)==0)]:
 state=m.execute(text,address,0x2a10,stop,scalar_regs,{},lambda *_:None,{-0x160:flag})
 prove(name+' exact deferred guard',state['guard']==want)
 prove(name+' no stack mutation',state['memory'][-0x160]==flag)
# The unauthorized edge jumps backward to the memory-clear suffix. Stop before
# that jump in the acyclic model and bind its real target explicitly, rather
# than widening the interpreter to accept arbitrary backward edges.
op,ds,off,imm=struct.unpack_from('<BBhi',text,0x2a20-address)
if (op,ds,imm)!=(5,0,0) or 0x2a20+8*(off+1)!=0x2450:raise RuntimeError('unauthorized rejection jump')
# Payout rejection materialization has its own deferred low-bit test.
state=m.execute(text,address,0x2b78,0x2b88,scalar_regs,{},lambda *_:None,{-0x160:flag})
prove('rejection authorized-output exact deferred guard',state['guard']==((flag&1)!=0))
prove('rejection deferred branch no stack mutation',state['memory'][-0x160]==flag)
op,ds,off,imm=struct.unpack_from('<BBhi',text,0x2b80-address)
if (op,ds,imm)!=(0x15,9,0) or 0x2b80+8*(off+1)!=0x2450:raise RuntimeError('payout rejection authorization target')
rr=list(scalar_regs);rr[6]=('output',0)
rejection=m.execute(text,address,0x2478,0x2e60,rr,{'output':360},lambda *_:None)
prove('unauthorized native rejection tag and code',z.And(rejection['guard'],rejection['memory'][('output',0)]==1,rejection['memory'][('output',4)]==1))
if set(rejection['memory'])!={('output',0),('output',4)}:raise RuntimeError('unexpected rejection stores')
# Real equality inversion must change the authorization result on a reachable path.
bad=bytearray(text);bad[0x1508-address]=0x5d
fault=entry(bytes(bad),0x1f38);s=z.Solver();s.set(timeout=30000);s.add(word('state',0)==1,word('instruction',0)==1,fault['guard'],(fault['memory'][-0x160]!=0)!=authorized);result=s.check()
if result!=z.sat:raise RuntimeError('missed authorization fault')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'deferredTargets':{'transferUnauthorizedJump':[0x2a20,0x2450],'rejectionUnauthorizedBranch':[0x2b80,0x2450],'authorizedOutput':0x2b88},'fault':{'name':'first key limb equality inverted','result':str(result),'witness':str(s.model())},'inputHashes':{str(p):sha(p) for p in [Path(__file__),model,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',elf]},'scope':'Native entry computes exact signer-nonzero/eight-key-word equality flag and retains it through product/division-route entry. Both transfer and payout-rejection deferred branches test its low bit; real unauthorized edges target the same memory-clear suffix. The post-clear suffix writes native tag1/code1. Division and payout-frame preservation, pointer ABI and source native layouts are separate obligations. Rejection memory clear call and output pointer preservation across it are not modeled here.'}
out=base/'authorization-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'report':str(out)}))
