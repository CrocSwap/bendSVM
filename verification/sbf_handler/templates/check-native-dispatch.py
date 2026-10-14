"""Actual native state/instruction dispatch and initialization validity guards."""
from pathlib import Path
import hashlib,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
import sbf_leaf as m
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
regs=[z.BitVec('dispatch_r'+str(i),64) for i in range(11)];regs[1]=('output',0);regs[2]=('context',0);regs[3]=('state',0);regs[4]=('instruction',0);regs[10]=('stack',0)
inputs={}
def word(region,off):
 key=(region,off)
 if key not in inputs:inputs[key]=z.BitVec('dispatch_'+region+'_'+str(off),32)
 return inputs[key]
def run(raw,stop):return m.execute(raw,address,0x1438,stop,regs,{'output':0,'context':56,'state':128,'instruction':112},word)
st,it=word('state',0),word('instruction',0);domain=z.And(z.Or(st==0,st==1),z.Or(it==0,it==1));rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(domain,z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 rows.append({'name':name,'result':str(result)})
for name,stop,want in [('live-claim',0x1460,z.And(st==1,it==1)),('live-initialize',0x1b30,z.And(st==1,it==0)),('empty-claim',0x1878,z.And(st==0,it==1)),('empty-initialize',0x18c0,z.And(st==0,it==0))]:
 state=run(text,stop);prove(name+' exact dispatch',state['guard']==want)
 s=z.Solver();s.add(domain,state['guard']);result=s.check()
 if result!=z.sat:raise RuntimeError('unreachable '+name)
 rows.append({'name':name+' witness','result':'sat','witness':str(s.model())})
pack=lambda off:z.Concat(word('instruction',off+4),word('instruction',off))
total,start,end=pack(80),pack(92),pack(104);valid=z.And(total!=0,z.ULT(start,end));init=z.And(st==0,it==0)
for name,stop,want in [('valid-initialize',0x19d0,z.And(init,valid)),('invalid-initialize',0x1b78,z.And(init,z.Not(valid)))]:
 state=run(text,stop);prove(name+' exact validity guard',state['guard']==want)
 prove(name+' captured signer word',z.Implies(state['guard'],state['memory'][-0xb8]==z.ZeroExt(32,word('context',40))))
 s=z.Solver();s.add(domain,state['guard']);result=s.check()
 if result!=z.sat:raise RuntimeError('unreachable '+name)
 rows.append({'name':name+' witness','result':'sat','witness':str(s.model())})
flag=z.BitVec('initialize_signed',64);rr=[z.BitVec('init_auth_r'+str(i),64) for i in range(10)]+[('stack',0)]
for name,stop,want in [('signed',0x1c78,flag!=0),('unsigned',0x2450,flag==0)]:
 state=m.execute(text,address,0x1c68,stop,rr,{},lambda *_:None,{-0xb8:flag});prove('initialize '+name+' deferred branch',state['guard']==want)
# Two real branch changes must break universal dispatch or validity.
faults=[]
for name,at,opcode,stop,want in [('live-tag-branch',0x1448,0x15,0x1878,z.And(st==0,it==1)),('time-equality',0x1960,0x2d,0x19d0,z.And(init,valid))]:
 bad=bytearray(text);bad[at-address]=opcode;state=run(bytes(bad),stop);s=z.Solver();s.set(timeout=10000);s.add(domain,state['guard']!=want);result=s.check()
 if result!=z.sat:raise RuntimeError(('missed mutation',name,str(result)))
 faults.append({'name':name,'result':str(result),'witness':str(s.model())})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'faults':faults,'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']},'scope':'Actual native dispatch matches canonical0/1 state/instruction tags, Initialize validity is total!=0 and start<end, original context signer is captured and deferred branch tests nonzero. Tag validity/native layout/pointer ABI/immutable disjoint input memory assumed. Does not prove output records, syscall behavior, account adapter or commit.'}
out=base/'native-dispatch-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(rows),'faults':len(faults),'report':str(out)}))
