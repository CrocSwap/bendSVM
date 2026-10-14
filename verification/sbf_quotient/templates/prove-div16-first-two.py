"""First two inline div16 steps, generalized second entry and checked interface."""
from pathlib import Path
import hashlib,json,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
import sbf_leaf as m
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes());low=lambda x:z.Extract(31,0,x);ext=lambda x:z.ZeroExt(32,x)
def next_step(q,r,d):
 shifted=(r<<1)|z.LShR(q,63);take=z.Or(z.Extract(63,63,r)==1,z.UGE(shifted,d))
 return (q<<1)|z.If(take,z.BitVecVal(1,64),z.BitVecVal(0,64)),z.If(take,shifted-d,shifted)
claims=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 claims.append({'name':name,'result':str(result)})
q,r,d=z.BitVecs('q r d',64);words={8:low(q),12:z.Extract(63,32,q),20:low(r),24:z.Extract(63,32,r),32:low(d),36:z.Extract(63,32,d)}
regs=[z.BitVec('entry'+str(i),64) for i in range(10)]+[('stack',0)];regs[1]=('output',0);regs[2]=('input',0)
first=m.execute(text,address,0x46d8,0x4898,regs,{'input':40,'output':40},lambda region,off:words[off])
f=first['registers'];fm=first['memory'];q1,r1=next_step(q,r,d)
first_q=z.Concat(low((f[4]<<1)|(z.LShR(f[6],31)&1)),low(fm[-64]));first_r=z.Concat(low(f[8]),low(f[5]))
prove('first inline step quotient/remainder',z.And(first_q==q1,first_r==r1,first['guard']))
prove('first inline step retained divisor',z.And(f[3]==ext(z.Extract(63,32,d)),fm[-48]==f[3],fm[-56]==ext(low(d))))
if fm[-80]!=('output',0):raise RuntimeError('lost output pointer')
# Abstract every scalar that can enter the second step. Divisor limbs and the
# retained original low quotient limb are U32; other temporaries allow upper bits.
rawlo,rawhi,oldhi,qlo=z.BitVecs('rawlo rawhi oldhi qlo',64);dh,dl,oldlo32=z.BitVecs('dh dl oldlo32',32);oldlo=ext(oldlo32)
rr=[z.BitVec('cut'+str(i),64) for i in range(10)]+[('stack',0)];rr[3]=ext(dh);rr[4]=oldhi;rr[5]=rawlo;rr[6]=oldlo;rr[8]=rawhi
mm={-48:ext(dh),-56:ext(dl),-64:qlo,-80:('output',0)}
qin=z.Concat(low((oldhi<<1)|(z.LShR(oldlo,31)&1)),low(qlo));rin=z.Concat(low(rawhi),low(rawlo));din=z.Concat(dh,dl)
second=m.execute(text,address,0x4898,0x4a30,rr,{'output':40},lambda *_:None,mm)
o=second['registers'];om=second['memory'];wantq,wantr=next_step(qin,rin,din)
qout=z.Concat(low((((o[4]<<1)|o[6])<<1)|(z.LShR(om[-64],31)&1)),low(o[7]));rout=z.Concat(low(o[9]),low(o[5]))
prove('second inline step quotient/remainder',z.And(qout==wantq,rout==wantr,second['guard']))
prove('second inline step preserved divisor and previous quotient',z.And(o[2]==ext(dh),om[-48]==ext(dh),om[-56]==ext(dl),om[-64]==qlo))
if om[-80]!=('output',0):raise RuntimeError('lost output frame')
# Explicit live inputs from actual instruction reads before overwrite, not all
# dead machine registers. Verify independently with backward CFG liveness.
import sbf_cfg as cfg
ins,succ,cone=cfg.acyclic_cone(text,address,0x4898,0x4a30);live={0x4a30:set()};slots=set()
for at in sorted(cone-{0x4a30},reverse=True):
 op,ds,off,imm=ins[at];dst=ds&15;src=ds>>4;reads=set();writes=set()
 if op in cfg.BRANCHES:
  if op!=5:reads.add(dst)
  if op&8:reads.add(src)
 elif op==0x79:reads.add(src);writes.add(dst);slots.add(off)
 elif op in (0xbf,):reads.add(src);writes.add(dst)
 elif op in (0xb7,0x18):writes.add(dst)
 elif op in (0x67,0x77,0x57,0x47):reads.add(dst);writes.add(dst)
 elif op in (0x1f,0x5f,0x4f):reads.update([dst,src]);writes.add(dst)
 else:raise RuntimeError('unreviewed opcode '+hex(op))
 after=set().union(*(live[t] for t in succ[at] if t in cone));live[at]=(after-writes)|reads
pairs=[(rawlo,f[5]),(rawhi,f[8]),(oldhi,f[4]),(oldlo32,low(f[6])),(qlo,fm[-64]),(dh,z.Extract(63,32,d)),(dl,low(d))]
def sub(v):return z.substitute(v,*pairs) if z.is_bv(v) else v
def eq(a,b):return z.BoolVal(a==b) if isinstance(a,tuple) else a==b
prove('actual first exit supplies every live second input',z.And(*[eq(f[i],sub(rr[i])) for i in live[0x4898]],*[eq(fm[k],sub(mm[k])) for k in mm]))
prove('second input mathematical state matches first output',z.And(sub(qin)==first_q,sub(rin)==first_r,sub(din)==d))
# Alter the first quotient-bit insertion and require a semantic counterexample.
bad=bytearray(text);bad[0x4878-address]=0x57;fault=m.execute(bytes(bad),address,0x46d8,0x4898,regs,{'input':40,'output':40},lambda region,off:words[off])
s=z.Solver();s.set(timeout=10000);s.add(low(fault['memory'][-64])!=low(q1));result=s.check()
if result!=z.sat:raise RuntimeError('missed quotient-bit fault')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':claims,'instructions':[first['coneInstructions'],second['coneInstructions']],'interfaceLiveRegisters':sorted(live[0x4898]),'interfaceStackReads':sorted(slots),'fault':{'result':'sat','witness':str(s.model())},'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']},'scope':'First two actual inlined div16 restoring steps with generalized second entry, live machine interface and quotient/remainder composition. Remaining ten inline steps and full div16 call composition unfinished.'}
(base/'div16-first-two-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'claims':len(claims),'instructions':report['instructions']}))
