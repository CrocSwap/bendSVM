"""Conservative acyclic SBF pointer provenance and memory footprint analysis.

This is trusted verification machinery. It accepts only the documented scalar,
stack, input/output and reviewed nested-call subset; it does not model VM memory.
"""
import struct
if not __debug__:raise RuntimeError("assertions required")
S=("scalar",);U=("unbound",)
def need(ok,why):
 if not ok:raise ValueError(why)
def analyze(raw,address,entry,end,nested=None):
 need(type(raw) is bytes and type(address) is int and type(entry) is int and type(end) is int and address%8==entry%8==end%8==0 and 0<=address<=entry<end<=address+len(raw) and len(raw)%8==0,'instruction extent')
 regs=[S]*10+[('stack',0)];regs[1]=('output',0);regs[2]=('input',0)
 incoming={entry:[(regs,{})]};accesses=[];calls=[];visited=[];exits=0
 def pointer(v):need(type(v) is tuple and len(v)==2 and v[0] in ['stack','input','output'],'pointer provenance');return v
 def scalar(v):need(v==S,'scalar provenance')
 def bounds(region,pos,width):
  lo,hi=(-4096,0) if region=='stack' else (0,40)
  need(pos%4==0 and lo<=pos and pos+width<=hi,'access bounds')
 for at in range(entry,end,8):
  if at not in incoming:continue
  states=incoming[at];r=[v[0][i] if all(w[0][i]==v[0][i] for w in states) else U for i in range(11) for v in states[:1]]
  common=set.intersection(*(set(v[1]) for v in states));mem={k:states[0][1][k] if all(v[1][k]==states[0][1][k] for v in states) else U for k in common}
  op,ds,off,imm=struct.unpack_from('<BBhi',raw,at-address);dst,src=ds&15,ds>>4;need(dst<=10 and src<=10,'register range');visited.append(at);succ=[at+8]
  if op==0x18:
   need(dst<10 and src==off==0,'wide immediate');need(raw[at-address+8:at-address+12]==bytes(4),'wide continuation');r[dst]=S;succ=[at+16]
  elif op==0xbf:need(dst<10 and off==imm==0,'move');r[dst]=r[src]
  elif op==0xb7:need(dst<10 and src==off==0,'immediate');r[dst]=S
  elif op==0x7:
   need(dst<10 and src==off==0,'pointer add');region,pos=pointer(r[dst]);r[dst]=(region,pos+imm)
  elif op in [0x61,0x79,0x63,0x7b,0x62,0x7a]:
   load=op in [0x61,0x79];width=8 if op in [0x79,0x7b,0x7a] else 4
   region,pos=pointer(r[src] if load else r[dst]);pos+=off;bounds(region,pos,width)
   accesses.append({'at':at,'kind':'read' if load else 'write','region':region,'offset':pos,'bytes':width})
   if load:
    need(dst<10 and imm==0 and region!='output','read fields/region')
    if region=='input':r[dst]=S
    else:
     need(all(pos+i in mem for i in range(width)),'initialized stack read')
     cells=[mem[pos+i] for i in range(width)]
     if all(c==S for c in cells):r[dst]=S
     elif width==8 and all(type(c) is tuple and len(c)==3 and c[0]=='pointer-byte' and c[2]==i for i,c in enumerate(cells)) and all(c[1]==cells[0][1] for c in cells):r[dst]=cells[0][1]
     else:r[dst]=U
   else:
    need(region in ['stack','output'],'write region')
    if op in [0x62,0x7a]:need(src==0,'immediate store');v=S
    else:need(imm==0,'register store');v=r[src]
    if region=='output':scalar(v)
    if region=='stack':
     if v!=S and v!=U:need(width==8,'partial pointer spill');pointer(v)
     for i in range(width):mem[pos+i]=v if v in [S,U] else ('pointer-byte',v,i)
  elif op==0x85:
   need(nested is not None and ds==0x10 and off==0 and at+8*(imm+1)==0x5c50,'nested target')
   output=pointer(r[1]);source=pointer(r[2]);bounds(*output,40);bounds(*source,40)
   need(output==('output',0) and source==('stack',-40),'nested pointer binding')
   need(all(mem.get(i)==S for i in range(-40,0)),'nested initialized input')
   calls.append({'at':at,'target':0x5c50,'output':output,'input':source})
   for i in range(6):r[i]=S
  elif op==0x95:need(ds==off==imm==0,'exit');exits+=1;succ=[]
  elif op==0x5:need(ds==imm==0,'jump');succ=[at+8*(off+1)]
  elif op in [0x15,0x1d,0x55,0x5d,0x25,0x2d,0x35,0x3d,0xa5,0xad]:
   scalar(r[dst]);scalar(r[src]) if op&8 else None
   need((imm==0 if op&8 else src==0),'branch shape');succ=[at+8,at+8*(off+1)]
  elif op in [0x67,0x77,0x57,0x47,0x5f,0x1f,0x4f]:
   need(dst<10 and off==0,'scalar ALU');scalar(r[dst]);scalar(r[src]) if op&8 else None
   need((imm==0 if op&8 else src==0),'ALU fields');r[dst]=S
  else:raise ValueError('unsupported '+hex(op)+' at '+hex(at))
  for target in succ:
   need(at<target<end,'forward in-range control flow');incoming.setdefault(target,[]).append((list(r),dict(mem)))
 need(exits==1,'single exit inventory')
 return {'instructions':len(visited),'accesses':accesses,'calls':calls}
