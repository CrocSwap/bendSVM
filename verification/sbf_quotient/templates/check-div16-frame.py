"""Check actual div16 stack-record construction at its nested div4 call."""
from pathlib import Path
import hashlib,importlib.util,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
import z3 as z
from sbf_elf import text_section
source=(repo/'verification/sbf_leaf.py').read_text()
needle='  elif op in [0x63,0x62,0x7a]:'
extra='''  elif op==0x07:
   need(dst<10 and src==0 and off==0 and isinstance(r[dst],tuple) and r[dst][0]=='stack','stack pointer addition')
   location=r[dst][1]+imm
   need(-4096<=location<=0,'stack pointer bounds');r[dst]=('stack',location)
  elif op in [0x63,0x62,0x7a] and isinstance(r[dst],tuple) and r[dst][0]=='stack':
   location=r[dst][1]+off;width=8 if op==0x7a else 4
   need(location%4==0 and -4096<=location and location+width<=0,'stack word write bounds')
   if op==0x63:need(imm==0,'stack word store fields');value=scalar(r[src])
   else:need(src==0,'stack immediate fields');value=bv(imm)
   # Retire any overlapping64bit slot. Partial reconstruction/loads are outside
   # this small domain; a later64bit load cannot observe the old value.
   for key in list(mem):
    if type(key) is int and key<location+width and location<key+8:del mem[key]
   mem[('stack',location)]=z.Extract(31,0,value)
   if width==8:mem[('stack',location+4)]=z.Extract(63,32,value)
'''
assert needle in source;source=source.replace(needle,extra+needle)
# A full-width store must also retire word-view entries it overwrites.
needle="need(dst==10 and imm==0 and off%8==0 and -4096<=off<=-8,'stack store');mem[off]=r[src]"
replace="""need(dst==10 and imm==0 and off%8==0 and -4096<=off<=-8,'stack store')
   for key in list(mem):
    if type(key) is tuple and key[0]=='stack' and off<=key[1]<off+8:del mem[key]
   mem[off]=r[src]"""
assert needle in source;source=source.replace(needle,replace)
path=base/'div16-frame-model.py';path.write_text(source)
spec=importlib.util.spec_from_file_location('div16_frame',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
regs=[z.BitVec('frame_r'+str(i),64) for i in range(10)]+[('stack',0)]
stack={-80:('output',0)}
state=m.execute(text,address,0x5bc0,0x5c40,regs,{'output':40},lambda *_:None,stack)
low=lambda v:z.Extract(31,0,v)
expected={0:z.BitVecVal(0,32),4:z.BitVecVal(0,32),8:low(regs[1]),12:low((regs[4]<<1)|(z.LShR(regs[2],31)&1)),16:z.BitVecVal(0,32),20:low(regs[5]),24:low(regs[7]),28:z.BitVecVal(0,32),32:low(regs[3]),36:low(regs[0])}
actual={k[1]+40:v for k,v in state['memory'].items() if isinstance(k,tuple) and k[0]=='stack'}
if set(actual)!=set(expected):raise RuntimeError('stack record footprint')
claims=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));r=s.check()
 if r!=z.unsat:raise RuntimeError((name,str(r)))
 claims.append({'name':name,'result':str(r)})
prove('complete tagged next-callee input',z.And(*[actual[k]==expected[k] for k in expected]))
prove('unconditional call preparation',state['guard'])
if state['registers'][1]!=('output',0) or state['registers'][2]!=('stack',-40) or state['registers'][10]!=('stack',0) or state['memory'][-80]!=('output',0):raise RuntimeError('call pointer interface')
op,ds,off,imm=struct.unpack_from('<BBhi',text,0x5c40-address)
if (op,ds,off)!=(0x85,0x10,0) or 0x5c40+8*(imm+1)!=0x5c50:raise RuntimeError('wrong nested callee')
if text[0x5c48-address:0x5c50-address]!=struct.pack('<BBhi',0x95,0,0,0):raise RuntimeError('missing return')
# Actual quotient-high store changed to use the low limb yields a counterexample.
bad=bytearray(text);bad[0x5c08-address+1]=0x1a
fault=m.execute(bytes(bad),address,0x5bc0,0x5c40,regs,{'output':40},lambda *_:None,stack)
s=z.Solver();s.set(timeout=10000);s.add(fault['memory'][('stack',-28)]!=expected[12]);r=s.check()
if r!=z.sat:raise RuntimeError('missed word-source fault')
I=lambda op,d=0,src=0,off=0,imm=0:struct.pack('<BBhi',op,(src<<4)|d,off,imm)
controls=[]
for name,code,initial,reason in [
 ('partial write invalidates64slot',I(0x62,10,off=-8)+I(0x79,3,10,off=-8),{-8:z.BitVecVal(55,64)},'initialized stack load'),
 ('word past frame',I(0x62,10,off=0),{},'stack word write bounds'),
 ('pointer past frame',I(0xbf,3,10)+I(0x07,3,imm=1),{},'stack pointer bounds')]:
 try:m.execute(code+I(0x95),0,0,len(code),regs,{'output':40},lambda *_:None,initial)
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((name,str(e)))
 else:raise RuntimeError('accepted '+name)
 controls.append(name)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':claims,'pointerInterface':True,'calleeTarget':0x5c50,'instructions':state['coneInstructions'],'fault':{'result':'sat','witness':str(s.model())},'refusals':controls,'inputHashes':{str(p):sha(p) for p in [Path(__file__),path,repo/'verification/sbf_leaf.py',repo/'verification/sbf_cfg.py',repo/'verification/sbf_elf.py',elf]},'scope':'Actual div16 tail constructs complete tagged40byte input for div4 and retains caller output pointer; next call targets certified leaf address, followed by return. Conditional on stated incoming register interpretation and valid/disjoint frames. Twelve preceding inline steps, full call semantics and caller theorem not proved.'}
(base/'div16-frame-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'instructions':state['coneInstructions'],'claims':len(claims),'refusals':len(controls)}))
