"""Actual native rejection construction under the explicit memset summary."""
from pathlib import Path
import hashlib,json,struct,sys
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'));sys.path.insert(0,str(base))
import z3 as z
import sbf_output as m
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes());W=lambda x:z.BitVecVal(x,32)
sizes={'stack':(-4096,0),'output':(0,360)}
initial={('stack',-0x160):W(1),('stack',-0x15c):W(0)}
def execute(raw,entry,r,memory=initial):
 if entry==0x2450:return m.execute(raw,address,entry,0x2e60,r,memory,sizes,memset_target=0x6890)
 # The acyclic output executor deliberately refuses backward branches. Bind
 # the actual rejection branch and prove it untaken before continuing; do not
 # widen that shared model or replace any emitted instruction bytes.
 prior=m.execute(raw,address,entry,0x2b78,r,memory,sizes,memset_target=0x6890)
 if struct.unpack_from('<BBhi',raw,0x2b78-address)!=(0x57,9,0,1):raise ValueError('rejection flag mask')
 op,ds,off,imm=struct.unpack_from('<BBhi',raw,0x2b80-address)
 if (op,ds,imm)!=(0x15,9,0) or 0x2b80+8*(off+1)!=0x2450:raise ValueError('rejection authorization branch')
 masked=z.simplify(prior['registers'][9]&z.BitVecVal(1,64))
 if not z.is_bv_value(masked) or masked.as_long()!=1:raise ValueError('rejection authorization branch not proved untaken')
 rr=list(prior['registers']);rr[9]=masked
 after=m.execute(raw,address,0x2b88,0x2e60,rr,prior['memory'],sizes,memset_target=0x6890)
 return {**after,'writes':prior['writes']|after['writes'],'calls':prior['calls']+after['calls'],'instructions':prior['instructions']+2+after['instructions']}
rows=[];cases=[]
for name,entry,code in [('unauthorized',0x2450,W(1)),('authorized-arithmetic-rejection',0x2a50,z.BitVec('rejectionCode',32))]:
 r=[z.BitVec('reject_r'+str(i),64) for i in range(10)]+[('stack',0)];r[6]=('output',0);r[1]=z.ZeroExt(32,code);r[9]=z.BitVecVal(1,64)
 state=execute(text,entry,r)
 expected={('output',off):W(0) for off in range(0,360,4)};expected['output',0]=W(1);expected['output',4]=code
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(z.And(*(state['memory'][k]==v for k,v in expected.items()))));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result)))
 if {k for k in state['writes'] if k[0]=='output'}!=set(expected):raise RuntimeError('rejection write footprint')
 rows.append({'name':name+' exact90words','result':str(result)});cases.append({'name':name,'instructions':state['instructions'],'calls':state['calls']})
# Changing the explicit unauthorized code must change the observable result.
bad=bytearray(text);struct.pack_into('<i',bad,0x2480-address+4,2)
r=[z.BitVec('fault_r'+str(i),64) for i in range(10)]+[('stack',0)];r[6]=('output',0)
fault=m.execute(bytes(bad),address,0x2450,0x2e60,r,{}, {'stack':(-4096,0),'output':(0,360)},memset_target=0x6890)
s=z.Solver();s.add(fault['memory']['output',4]!=1);result=s.check()
if result!=z.sat:raise RuntimeError('missed authorization code fault')
controls=[]
for name,offset,value,reason in [('inverted deferred branch',0x2b80-address,0x55,'rejection authorization branch'),('redirected deferred branch',0x2b80-address+2,0,'rejection authorization branch'),('wrong mask',0x2b78-address+4,0,'rejection flag mask')]:
 bad=bytearray(text);bad[offset]=value
 r=[z.BitVec('control_r'+str(i),64) for i in range(10)]+[('stack',0)];r[6]=('output',0);r[1]=z.BitVecVal(5,64);r[9]=z.BitVecVal(1,64)
 try:execute(bytes(bad),0x2a50,r)
 except ValueError as error:
  if str(error)!=reason:raise RuntimeError((name,str(error)))
 else:raise RuntimeError('accepted '+name)
 controls.append({'name':name,'reason':reason})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'cases':cases,'controls':controls,'fault':{'name':'unauthorized code1 to2','result':str(result)},'inputHashes':{str(p):sha(p) for p in [Path(__file__),repo/'verification/sbf_output.py',repo/'verification/sbf_elf.py',repo/'verification/sbf_cfg.py',elf]},'scope':'Exact360byte native unauthorized/arithmetic rejection output, including complete union clearing. Its actual backward rejection authorization branch is checked exactly and proved untaken for the declared authorized input before composing two restricted executor slices. Caller supplies output pointer and prior rejection code/authorization. Valid disjoint regions, instruction interpreter, memset zero-fill/output-only summary and CALL register preservation trusted; no whole-handler/adapter/commit theorem.'}
out=base/'rejection-output-report.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'cases':cases}))
