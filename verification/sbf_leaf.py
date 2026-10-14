"""Restricted acyclic SBF leaf executor with a write-only output region.

This domain adds typed stack spills, output word stores and dead-register
poison to the immutable-region path executor's instruction subset. All named
regions are caller-assumed valid and disjoint; only the region named "output"
can be written, and it cannot be read. No calls, allocation, pointer arithmetic,
mutable output loads or complete SBF memory semantics are modeled. Incompatible
merged values become poison: moves/spills may carry it, but observable scalar
or pointer uses reject. A caller proving an output contract must check its
complete footprint and the returned reachability guard.

Native register division is opt-in and rejects unless the path guard proves
the divisor nonzero. Solver UNKNOWN rejects. Division semantics use unsigned
64-bit quotient; instruction semantics and Z3 remain trusted. Region bounds do not prove that
an ABI caller supplies valid memory. Keep this distinct domain separate from
sbf_paths, whose stricter pointer-merge refusals protect existing certificates.
"""
import collections,struct
import z3 as z
from sbf_cfg import BRANCHES, acyclic_cone, need

if not __debug__:raise RuntimeError('assertions required')

def execute(text,address,entry,stop,registers,region_sizes,word,stack=None,*,native_division=False):
 need(z.get_version_string()=='5.1.0','solver pin')
 need(type(region_sizes) is dict and all(type(k) is str and k!='stack' and type(v) is int and 0<=v<=1536 and v%4==0 for k,v in region_sizes.items()),'input region sizes')
 def value_ok(v):
  if z.is_bv(v):return v.size()==64
  return type(v) is tuple and len(v)==2 and type(v[0]) is str and type(v[1]) is int and (v==('stack',0) or v[0] in region_sizes and 0<=v[1]<=region_sizes[v[0]])
 need(len(registers)==11 and all(value_ok(v) for v in registers) and type(registers[10]) is tuple and registers[10]==('stack',0),'path register state')
 stack={} if stack is None else stack
 need(type(stack) is dict and all(type(k) is int and -4096<=k<=-8 and k%8==0 and value_ok(v) for k,v in stack.items()),'path stack state')
 # Cache each immutable word: callers cannot supply inconsistent values across paths.
 reader=word;words={}
 def word(region,offset):
  key=(region,offset)
  if key not in words:words[key]=reader(region,offset)
  return words[key]
 ins,succ,cone=acyclic_cone(text,address,entry,stop)
 regs=list(registers);bv=lambda x:z.BitVecVal(x,64)
 need(type(native_division) is bool,'division mode')
 division_checks=0
 poison_merges=0
 incoming=collections.defaultdict(list);incoming[entry]=[(z.BoolVal(True),regs,dict(stack))]
 def merge(values,guards):
  nonlocal poison_merges
  if any(v is None for v in values):poison_merges+=1;return None
  if any(isinstance(v,tuple) for v in values):
   if all(isinstance(v,tuple) and v==values[0] for v in values):return values[0]
   poison_merges+=1;return None
  out=values[-1]
  for g,v in reversed(list(zip(guards[:-1],values[:-1]))):out=z.If(g,v,out)
  return z.simplify(out)
 def scalar(v):need(z.is_bv(v) and v.size()==64,'scalar required');return v
 for at in sorted(cone):
  states=incoming[at];need(bool(states),'missing predecessor state')
  guards=[s[0] for s in states];guard=z.simplify(z.Or(*guards))
  r=[merge([s[1][i] for s in states],guards) for i in range(11)]
  keys=set.intersection(*(set(s[2]) for s in states));mem={k:merge([s[2][k] for s in states],guards) for k in keys}
  if at==stop:break
  op,ds,off,imm=ins[at];dst=ds&15;src=ds>>4;need(dst<=10 and src<=10,'register range')
  branch=None
  if op in BRANCHES:
   if op==5:need(ds==0 and imm==0,'jump reserved fields')
   else:
    need((imm==0 if op&8 else src==0),'branch reserved fields')
    need(off!=0,'coincident branch successors unsupported')
   a=scalar(r[dst]) if op!=5 else bv(0);b=scalar(r[src]) if op&8 else bv(imm)
   if op in (0x15,0x1d):branch=a==b
   elif op in (0x55,0x5d):branch=a!=b
   elif op in (0x25,0x2d):branch=z.UGT(a,b)
   elif op in (0x35,0x3d):branch=z.UGE(a,b)
   elif op in (0xa5,0xad):branch=z.ULT(a,b)
   elif op==5:branch=z.BoolVal(True)
   else:raise ValueError('unsupported branch')
  elif op==0x61:
   need(dst<10 and imm==0 and isinstance(r[src],tuple),'word load base')
   region,offset=r[src];need(region in region_sizes and region!='output','input load region')
   location=offset+off
   need(location%4==0 and location>=0,'input word alignment')
   need(location+4<=region_sizes[region],'input region bounds')
   value=word(region,location)
   need(z.is_bv(value) and value.size()==32,'input word width')
   r[dst]=z.ZeroExt(32,value)
  elif op==0x79:
   need(src==10 and dst<10 and imm==0 and off%8==0 and off in mem,'initialized stack load');r[dst]=mem[off]
  elif op==0x7b:
   need(dst==10 and imm==0 and off%8==0 and -4096<=off<=-8,'stack store');mem[off]=r[src]
  elif op==0x18:
   need(dst<10 and src==0 and off==0,'wide immediate fields')
   high=struct.unpack_from('<i',text,at-address+12)[0]
   r[dst]=bv((imm&0xffffffff)|((high&0xffffffff)<<32))
  elif op==0x47:
   need(dst<10 and src==0 and off==0,'or immediate fields');r[dst]=scalar(r[dst])|bv(imm)
  elif op in [0x63,0x62,0x7a]:
   need(isinstance(r[dst],tuple) and r[dst][0]=='output','output write region')
   region,offset=r[dst];location=offset+off;width=8 if op==0x7a else 4
   need(location%4==0 and 0<=location and location+width<=region_sizes[region],'output write bounds')
   if op==0x63:need(imm==0,'output store fields');value=scalar(r[src])
   else:need(src==0,'output immediate fields');value=bv(imm)
   mem[(region,location)]=z.Extract(31,0,value)
   if width==8:mem[(region,location+4)]=z.Extract(63,32,value)
  elif op==0x3f:
   need(native_division,'native division disabled')
   need(dst<10 and src<10 and off==0 and imm==0,'division fields')
   a=scalar(r[dst]);b=scalar(r[src])
   # Do not inherit Z3's totalized zero-division value as VM behavior. Every
   # reachable division must discharge its own nonzero obligation here.
   solver=z.Solver();solver.set(timeout=10000);solver.add(guard,b==0)
   result=solver.check()
   need(result==z.unsat,'division nonzero obligation: '+str(result))
   division_checks+=1;r[dst]=z.UDiv(a,b)
  elif op==0xbf:need(off==0 and imm==0 and dst<10,'move fields');r[dst]=r[src]
  elif op==0xb7:need(src==0 and off==0 and dst<10,'immediate fields');r[dst]=bv(imm)
  elif op in [0x5f,0x1f,0x4f]:
   need(off==0 and imm==0 and dst<10,'ALU fields');a=scalar(r[dst]);b=scalar(r[src]);r[dst]=a&b if op==0x5f else a|b if op==0x4f else a-b
  elif op==0x57:need(src==0 and off==0 and dst<10,'and fields');r[dst]=scalar(r[dst])&bv(imm)
  elif op in [0x67,0x77]:
   need(src==0 and off==0 and dst<10 and 0<=imm<64,'shift fields');a=scalar(r[dst]);r[dst]=a<<imm if op==0x67 else z.LShR(a,imm)
  else:raise ValueError('unsupported path opcode '+hex(op))
  for dest in succ[at]:
   if dest not in cone:continue
   g=guard
   if branch is not None:g=z.And(g,branch if dest==at+8*(off+1) else z.Not(branch))
   incoming[dest].append((z.simplify(g),list(r),dict(mem)))
 return {**({'divisionChecks':division_checks} if native_division else {}),'registers':r,'memory':mem,'guard':guard,'coneInstructions':len(cone)-1,'mergedNodes':sum(len(v)>1 for v in incoming.values()),'words':words,'poisonMerges':poison_merges}
