"""Conditional byte/word zero-fill bridge; syscall behavior remains assumed."""
from pathlib import Path
import sys,json,hashlib
repo=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(repo/'verification'))
import z3 as z
import sbf_output
if not __debug__:raise RuntimeError('assertions required')
assert z.get_version_string()=='5.1.0'
B=lambda n:z.BitVecVal(n,64)
mem=z.Array('before',z.BitVecSort(64),z.BitVecSort(8))
base,start,count,at=[z.BitVec(n,64) for n in ['base','start','count','at']]
# Use an arbitrary aligned base with enough headroom for a full native value.
pre=[base&B(3)==0,z.ULE(base,B(2**64-1-1536)),start&B(3)==0,count&B(3)==0,z.ULE(start,B(1536)),z.ULE(count,B(1536)-start)]
low=base+start;high=low+count
inside=lambda p:z.And(z.UGE(p,low),z.ULT(p,high))
after=z.Lambda(at,z.If(inside(at),z.BitVecVal(0,8),mem[at]))
word=lambda arr,p:z.Concat(*[arr[p+B(k)] for k in [3,2,1,0]])
claims=[]
def prove(name,extra,statement):
 s=z.Solver();s.set(timeout=10000);s.add(*pre,*extra,z.Not(statement));r=s.check()
 if r!=z.unsat:raise RuntimeError((name,str(r),str(s.model()) if r==z.sat else s.reason_unknown()))
 claims.append({'name':name,'result':str(r)})
prove('interval-does-not-wrap',[],z.And(z.UGE(low,base),z.UGE(high,low),z.ULE(high,base+B(1536))))
prove('outside-byte-frame',[z.Not(inside(at))],after[at]==mem[at])
prove('empty-fill-identity',[count==0],after[at]==mem[at])
prove('inside-word-is-zero',[at&B(3)==0,inside(at)],word(after,at)==0)
prove('outside-aligned-word-unchanged',[at&B(3)==0,z.ULE(at,B(2**64-4)),z.Not(inside(at))],word(after,at)==word(mem,at))
# Whole words never straddle an aligned boundary; this justifies interpreter keys.
prove('word-membership-agrees',[at&B(3)==0,z.ULE(at,B(2**64-4))],z.And(*[inside(at)==inside(at+B(k)) for k in range(4)]))
controls=[]
# A one-byte-shifted destination must change the modeled word at the intended start.
bad=z.Lambda(at,z.If(z.And(z.UGE(at,low+B(1)),z.ULT(at,high+B(1))),z.BitVecVal(0,8),mem[at]))
s=z.Solver();s.add(*pre,count==4,word(bad,low)!=0);r=s.check();assert r==z.sat
controls.append({'name':'shifted-destination','result':str(r),'witness':str(s.model())})
# Omitting alignment allows a fill to modify only part of an allegedly outside word.
s=z.Solver();s.add(base==0,start==1,count==4,at==0,word(after,at)!=word(mem,at));r=s.check();assert r==z.sat
controls.append({'name':'missing-alignment','result':str(r),'witness':str(s.model())})
# Exercise the actual interpreter's summary for every supported count, at both
# region edges. These are finite implementation comparisons, not syscall proofs.
import struct
text=struct.pack('<BBhi',0x85,0x10,0,1)+struct.pack('<BBhi',0x95,0,0,0)
values={('output',i):z.BitVec('old_'+str(i),32) for i in range(0,1536,4)}
cases=0
for n in range(0,1537,4):
 for offset in sorted({0,1536-n}):
  regs=[z.BitVec('r'+str(i),64) for i in range(11)]
  regs[1]=('output',offset);regs[2]=B(0);regs[3]=B(n);regs[10]=('stack',0)
  out=sbf_output.execute(text,0,0,8,regs,values,{'stack':(-4096,0),'output':(0,1536)},16)
  wanted={('output',i) for i in range(offset,offset+n,4)}
  assert out['writes']==wanted and not out['initialReads']
  assert out['calls']==[{'address':0,'target':16,'region':'output','offset':offset,'bytes':n}]
  for key,v in out['memory'].items():
   assert z.is_true(z.simplify(v==(z.BitVecVal(0,32) if key in wanted else values[key])))
  assert all(out['registers'][i] is regs[i] for i in range(6,11))
  cases+=1
paths=[Path(__file__),repo/'verification/sbf_output.py',repo/'verification/sbf_cfg.py']
report={'passed':True,'endToEndVerified':False,'claims':claims,'controls':controls,'interpreterCases':cases,'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths},'scope':'Conditional byte-array zero-fill to aligned word-memory correspondence, plus actual interpreter summary comparisons for every supported count at region edges. Trusted syscall byte-fill/frame contract, valid disjoint regions, CALL ABI, solver and proof driver. This model check alone establishes no actual SBF artifact linkage or VM preservation.'}
print(json.dumps(report))
