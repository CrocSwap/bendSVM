"""Actual vesting call choreography with an explicit trusted div16 summary."""
from pathlib import Path
import hashlib,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
B=lambda x:z.BitVecVal(x,64);lo=lambda x:z.Extract(31,0,x);hi=lambda x:z.Extract(63,32,x);ext=lambda x:z.ZeroExt(32,x)
Q=z.Function('div16_q',*[z.BitVecSort(64)]*4);R=z.Function('div16_r',*[z.BitVecSort(64)]*4)
q,h,d=z.BitVecs('lowDividend highDividend divisor',64);saved=z.BitVec('saved_context',64)
def need(ok,msg):
 if not ok:raise ValueError(msg)
def scalar(v):need(z.is_bv(v) and v.size()==64,'scalar');return v
def ptr(v):need(type(v) is tuple and len(v)==2 and v[0]=='stack','frame pointer');return v[1]
def run(start,raw=text,capture=None):
 regs=[z.BitVec('caller'+str(i),64) for i in range(10)]+[('stack',0)];regs[2]=z.Concat(z.BitVec('raw_dhi_upper',32),hi(d));regs[4]=z.Concat(z.BitVec('raw_dlo_upper',32),lo(d));regs[8]=z.Concat(z.BitVec('raw_hhi_upper',32),hi(h));regs[0]=z.Concat(z.BitVec('raw_hlo_upper',32),lo(h));words={};calls=[];visited=[]
 def store(offset,value,width):
  need(-4096<=offset and offset+width<=0 and offset%4==0,'stack write bounds')
  words[offset]=lo(value)
  if width==8:words[offset+4]=hi(value)
 def load(offset,width):
  need(offset%4==0 and offset in words,'initialized word')
  if width==4:return ext(words[offset])
  need(offset+4 in words,'initialized wide word');return z.Concat(words[offset+4],words[offset])
 for off,v in [(-0x150,z.Concat(z.BitVec('raw_qlo_upper',32),lo(q))),(-0xa8,z.Concat(z.BitVec('raw_qhi_upper',32),hi(q))),(-0xe0,saved),(-0x160,z.BitVec('deferred_flag',64))]:store(off,v,8)
 if capture is not None:capture.update(registers=list(regs),words=dict(words))
 at=start
 while at!=0x2748:
  need(at not in visited and start<=at<0x2748,'acyclic caller range');visited.append(at)
  op,ds,off,imm=struct.unpack_from('<BBhi',raw,at-address);dst=ds&15;src=ds>>4;need(dst<=10 and src<=10,'register index');next_at=at+8
  if op==0xbf:need(dst<10 and off==0 and imm==0,'move');regs[dst]=regs[src]
  elif op==0x07:need(dst<10 and src==0 and off==0,'pointer addition fields');position=ptr(regs[dst])+imm;need(-4096<=position<=0,'pointer addition bounds');regs[dst]=('stack',position)
  elif op in (0x63,0x62,0x7a,0x7b):
   if op in (0x63,0x7b):need(imm==0,'store fields');v=scalar(regs[src])
   else:need(src==0,'immediate store fields');v=B(imm)
   store(ptr(regs[dst])+off,v,8 if op in (0x7a,0x7b) else 4)
  elif op in (0x61,0x79):need(dst<10 and imm==0,'load fields');regs[dst]=load(ptr(regs[src])+off,4 if op==0x61 else 8)
  elif op in (0x67,0x77):
   need(dst<10 and src==0 and off==0 and 0<=imm<64,'shift fields');a=scalar(regs[dst]);regs[dst]=a<<imm if op==0x67 else z.LShR(a,imm)
  elif op==0x4f:need(dst<10 and off==0 and imm==0,'or fields');regs[dst]=scalar(regs[dst])|scalar(regs[src])
  elif op==0x05:need(ds==0 and imm==0,'jump fields');next_at=at+8*(off+1)
  elif op==0x85:
   need(ds==0x10 and off==0 and at+8*(imm+1)==0x46d8,'div16 direct call')
   source,target=ptr(regs[2]),ptr(regs[1]);need(source+40<=target or target+40<=source,'call regions disjoint')
   tags=[load(source+k,4) for k in [0,4,16,28]]
   need(all(z.is_true(z.simplify(t==0)) for t in tags),'canonical input tags')
   args=[load(source+k,8) for k in [8,20,32]];oq,orr=Q(*args),R(*args)
   for k in [0,4,16,28]:store(target+k,B(0),4)
   for k,v in [(8,oq),(20,orr),(32,args[2])]:store(target+k,v,8)
   calls.append({'at':at,'source':source,'target':target,'args':args})
   # ABI preserves r6-r9/r10. Volatile registers are arbitrary after return.
   for k in range(6):regs[k]=z.BitVec('call'+str(at)+'_volatile'+str(k),64)
  else:raise ValueError('unsupported caller instruction '+hex(op))
  at=next_at
 return {'result':load(-0xa8,8),'context':regs[3],'calls':calls,'instructions':len(visited),'words':words,'registers':regs}
def fold(q,r,d,n):
 for _ in range(n):q,r=Q(q,r,d),R(q,r,d)
 return q,r
rows=[];routes=[]
for name,start,initial_q,initial_r,count in [('full',0x2500,q,h,4)]:
 state=run(start);wantq,wantr=fold(initial_q,initial_r,d,count)
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(z.And(state['result']==wantq,state['context']==saved)));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result)))
 if len(state['calls'])!=count:raise RuntimeError('call count')
 rows.append({'name':name+' exact folded quotient and saved context','result':str(result)})
 routes.append({'name':name,'instructions':state['instructions'],'calls':[{k:v for k,v in c.items() if k!='args'} for c in state['calls']]})
# Change final quotient-high load to low word; the expected arithmetic differs.
bad=bytearray(text);struct.pack_into('<h',bad,0x25f8-address+2,-0x98)
fault=run(0x2500,bytes(bad));s=z.Solver();s.set(timeout=10000);s.add(fault['result']!=fold(q,h,d,4)[0]);result=s.check()
if result!=z.sat:raise RuntimeError('missed result word fault')
controls=[]
for name,location,value,reason in [('wrong callee',0x25d0+4,0,'div16 direct call'),('aliased call input',0x2578+1,0x21,'call regions disjoint')]:
 bad=bytearray(text)
 if name=='wrong callee':struct.pack_into('<i',bad,location-address,value)
 else:bad[location-address]=value
 try:run(0x2500,bytes(bad))
 except ValueError as error:
  if str(error)!=reason:raise RuntimeError((name,str(error)))
 else:raise RuntimeError('accepted '+name)
 controls.append({'name':name,'reason':reason})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'refusals':controls,'routes':routes,'fault':{'result':'sat','witness':str(s.model())},'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_elf.py']},'scope':'Actual call-preparation/chaining/result-extraction instructions for four div16 calls. Div16 q/r summary uninterpreted; its functional meaning and SBF callee memory/register preservation are explicit assumptions. Does not establish route selection, source/product entrance bindings, Euclidean quotient or whole handler.'}
(base/'caller-calls-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'routes':routes}))
