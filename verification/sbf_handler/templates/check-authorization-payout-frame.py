"""Conservative memory-write footprint from quotient exit to authorization use."""
from pathlib import Path
import hashlib,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
from sbf_cfg import acyclic_cone,BRANCHES
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
# This classifier proves only absence of writes to one protected stack word.
# Every accepted non-store opcode has no memory-write effect in SBPFv0.
def check(raw,stop):
 ins,succ,cone=acyclic_cone(raw,address,0x2748,stop);stores=[]
 for at in sorted(cone-{stop}):
  op,ds,off,imm=ins[at];dst,src=ds&15,ds>>4
  if op in [0x63,0x62,0x7b,0x7a]:
   width=8 if op in [0x7b,0x7a] else 4
   if dst!=10 or not -4096<=off or off+width>0 or off%4:raise ValueError('non-frame store')
   if (op in [0x63,0x7b] and (src>=10 or imm!=0)) or (op in [0x62,0x7a] and src!=0):raise ValueError('store shape')
   if not (off+width<=-0x160 or -0x158<=off):raise ValueError('authorization word overwritten')
   stores.append({'address':at,'offset':off,'width':width})
  elif op in BRANCHES:
   if op not in [5,0x15,0x55,0x1d,0x5d,0x2d,0x3d,0xad]:raise ValueError('unknown branch')
   if dst>10 or src>10:raise ValueError('branch registers')
  elif op in [0x61,0x79,0xbf,0xb7,0x07,0x67,0x77,0x4f,0x5f,0x1f,0x57]:
   if dst>=10 or src>10:raise ValueError('frame register assignment')
   if dst==9:raise ValueError('authorization register overwritten')
  else:raise ValueError('unknown memory effect')
 return {'instructions':len(cone)-1,'stores':stores}
positive={name:check(text,stop) for name,stop in [('transfer',0x2a10),('rejection',0x2b78)]};controls=[]
for name,at,change,reason in [('write flag',0x28e8,('offset',-0x160),'authorization word overwritten'),('write non-frame',0x28e8,('register',0x19),'non-frame store'),('unknown helper',0x28d8,('opcode',0x85),'unsupported path opcode 0x85'),('overwrite live flag',0x2750,('register',0x09),'authorization register overwritten')]:
 bad=bytearray(text)
 if change[0]=='offset':struct.pack_into('<h',bad,at-address+2,change[1])
 else:bad[at-address+(1 if change[0]=='register' else 0)]=change[1]
 try:check(bytes(bad),0x2a10)
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((name,str(e),reason))
 else:raise RuntimeError('missed '+name)
 controls.append({'name':name,'reason':reason})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'footprints':positive,'controls':controls,'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py']},'scope':'Every accepted instruction in both transfer/rejection quotient-to-authorization acyclic cones is an explicit stack store disjoint from auth word or an enumerated no-memory-write opcode; neither r9 nor r10 is assigned. Establishes retained memory and live-register flag only, not data values, source meaning, global memory safety, or output/commit correctness.'}
out=base/'authorization-payout-frame-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':{k:v['instructions'] for k,v in positive.items()},'stores':{k:len(v['stores']) for k,v in positive.items()},'controls':len(controls)}))
