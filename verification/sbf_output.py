"""Restricted scalar/word memory interpreter for output construction.

Memory regions are assumed valid and disjoint. Only stack/output are writable.
No arbitrary calls: one caller-supplied memset wrapper target has a trusted zero-fill and
CALL ABI summary. This is not a formal SBF VM or syscall semantics proof.
"""
import struct
import z3 as z
from sbf_cfg import decode
if not __debug__:raise RuntimeError('assertions required')
def need(ok,msg):
 if not ok:raise ValueError(msg)
def execute(text,address,entry,stop,registers,memory,sizes,memset_target=None):
 need(z.get_version_string()=='5.1.0','solver pin')
 need(memset_target is None or type(memset_target) is int and 0<=memset_target<2**64 and memset_target%8==0,'memory summary target')
 need(type(sizes) is dict and 'stack' in sizes and 'output' in sizes,'region inventory')
 for region,bounds in sizes.items():
  need(type(region) is str and type(bounds) is tuple and len(bounds)==2 and all(type(v) is int for v in bounds),'region shape')
  low,high=bounds
  need(bounds==(-4096,0) if region=='stack' else low==0 and 0<=high<=1536 and high%4==0,'region bounds')
 def valid(v):
  if z.is_bv(v):return v.size()==64
  return type(v) is tuple and len(v)==2 and type(v[0]) is str and v[0] in sizes and type(v[1]) is int and sizes[v[0]][0]<=v[1]<=sizes[v[0]][1]
 need(type(registers) in [list,tuple] and len(registers)==11 and all(valid(v) for v in registers) and type(registers[10]) is tuple and registers[10]==('stack',0),'initial registers')
 need(type(memory) is dict,'initial memory')
 for key,v in memory.items():
  need(type(key) is tuple and len(key)==2 and type(key[0]) is str and key[0] in sizes and type(key[1]) is int,'memory key')
  region,pos=key;low,high=sizes[region];need(pos%4==0 and low<=pos and pos+4<=high and z.is_bv(v) and v.size()==32,'initial memory word')
 instructions,_=decode(text,address)
 need(type(entry) is int and type(stop) is int and entry in instructions and stop in instructions,'instruction cutpoints')
 r=list(registers);mem=dict(memory);at=entry;seen=[];writes=set();reads=set();calls=[];guard=z.BoolVal(True)
 B=lambda v:z.BitVecVal(v,64)
 def scalar(v):need(z.is_bv(v) and v.size()==64,'scalar required');return v
 def pointer(v):need(type(v) is tuple and len(v)==2 and v[0] in sizes and type(v[1]) is int,'pointer required');return v
 def location(v,off,width):
  region,pos=pointer(v);pos+=off;low,high=sizes[region];need(pos%4==0 and low<=pos and pos+width<=high,'memory bounds');return region,pos
 def get(v,off,width):
  region,pos=location(v,off,width);need(region!='output','output read refused');keys=[(region,pos+k) for k in range(0,width,4)]
  need(all(k in mem and z.is_bv(mem[k]) and mem[k].size()==32 for k in keys),'initialized word load')
  reads.update(k for k in keys if k not in writes)
  return z.ZeroExt(32,mem[keys[0]]) if width==4 else z.Concat(mem[keys[1]],mem[keys[0]])
 def put(v,off,width,value):
  region,pos=location(v,off,width);need(region in ['stack','output'],'immutable input store');value=scalar(value)
  for k in range(0,width,4):mem[region,pos+k]=z.Extract(k*8+31,k*8,value);writes.add((region,pos+k))
 while at!=stop:
  need(at not in seen and at in instructions,'instruction boundary');seen.append(at)
  op,ds,off,imm=struct.unpack_from('<BBhi',text,at-address);dst,src=ds&15,ds>>4;need(dst<=10 and src<=10,'register index');nxt=at+8
  if op==0xbf:need(dst<10 and off==imm==0,'move shape');r[dst]=r[src]
  elif op==0xb7:need(dst<10 and src==off==0,'immediate shape');r[dst]=B(imm)
  elif op==0x07:
   need(dst<10 and src==off==0,'pointer add shape');region,pos=pointer(r[dst]);pos+=imm;low,high=sizes[region];need(low<=pos<=high,'pointer addition bounds');r[dst]=(region,pos)
  elif op in [0x61,0x79]:need(dst<10 and imm==0,'load shape');r[dst]=get(r[src],off,4 if op==0x61 else 8)
  elif op in [0x63,0x7b]:need(imm==0,'store shape');put(r[dst],off,4 if op==0x63 else 8,r[src])
  elif op in [0x62,0x7a]:need(src==0,'immediate store shape');put(r[dst],off,4 if op==0x62 else 8,B(imm))
  elif op in [0x67,0x77]:need(dst<10 and src==off==0 and 0<=imm<64,'shift shape');v=scalar(r[dst]);r[dst]=v<<imm if op==0x67 else z.LShR(v,imm)
  elif op==0x4f:need(dst<10 and off==imm==0,'or shape');r[dst]=scalar(r[dst])|scalar(r[src])
  elif op==0x57:need(dst<10 and src==off==0,'and shape');r[dst]=scalar(r[dst])&B(imm)
  elif op==5:need(ds==0 and imm==0 and off>=0,'forward jump');nxt=at+8*(off+1)
  elif op in [0x15,0x55]:
   need(src==0 and off>0,'forward branch');condition=z.simplify(scalar(r[dst])==B(imm));condition=z.simplify(z.Not(condition)) if op==0x55 else condition
   need(z.is_true(condition) or z.is_false(condition),'symbolic output branch');nxt=at+8*(off+1) if z.is_true(condition) else at+8
  elif op==0x85:
   need(memset_target is not None and ds==0x10 and off==0 and at+8*(imm+1)==memset_target,'memset wrapper call')
   value,count=z.simplify(scalar(r[2])),z.simplify(scalar(r[3]));need(z.is_bv_value(value) and value.as_long()==0 and z.is_bv_value(count),'zero fill arguments');count=count.as_long();need(count%4==0,'word fill length');region,pos=location(r[1],0,count);need(region=='output','fill output region')
   for k in range(0,count,4):put(r[1],k,4,B(0))
   calls.append({'address':at,'target':memset_target,'region':region,'offset':pos,'bytes':count})
   for i in range(6):r[i]=z.BitVec('memset_clobber_'+str(at)+'_'+str(i),64)
  else:raise ValueError('unsupported output opcode '+hex(op))
  at=nxt
 return {'registers':r,'memory':mem,'writes':writes,'initialReads':reads,'calls':calls,'instructions':len(seen),'guard':guard}
