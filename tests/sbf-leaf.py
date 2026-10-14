"""Domain and algebra checks for the restricted writable leaf executor."""
from pathlib import Path
import struct,subprocess,sys
import sbf_leaf as m
z=m.z

def check():
 I=lambda op,d=0,src=0,off=0,imm=0:struct.pack('<BBhi',op,(src<<4)|d,off,imm)
 regs=[z.BitVec('r'+str(i),64) for i in range(10)]+[('stack',0)];regs[1]=('output',0);regs[2]=('input',0)
 reads=[]
 def reader(region,offset):reads.append((region,offset));return z.BitVecVal(0x12345678,32)
 def run(code,stack=None):return m.execute(code+I(0x95),0,0,len(code),regs,{'input':40,'output':40},reader,stack)
 claims=[]
 def prove(name,expr):
  sol=z.Solver();sol.set(timeout=10000);sol.add(z.Not(expr));result=sol.check()
  if result!=z.unsat:raise RuntimeError((name,str(result)))
  claims.append(name)
 # Signed immediate extends to64; a following32bit write replaces only one word.
 state=run(I(0x7a,1,off=0,imm=-1)+I(0x62,1,off=4,imm=7))
 prove('overlapping word stores preserve untouched half',z.And(state['memory'][('output',0)]==0xffffffff,state['memory'][('output',4)]==7))
 state=run(I(0x7b,10,1,off=-8)+I(0x79,3,10,off=-8)+I(0x62,3,off=36,imm=9))
 prove('pointer spill reload and final in-bounds word',state['memory'][('output',36)]==9)
 state=run(I(0x79,3,10,off=-8)+I(0x62,3,imm=11),{-8:('output',0)})
 prove('typed pointer entry frame',state['memory'][('output',0)]==11)
 state=run(I(0x18,3,imm=-1985229329)+I(0,imm=-19088744))
 prove('LDDW preserves both unsigned words',state['registers'][3]==0xfedcba9889abcdef)
 state=run(I(0x47,3,imm=-1))
 prove('OR immediate sign extends',state['registers'][3]==0xffffffffffffffff)
 rows=[]
 cases=[
  ('read mutable output',I(0x62,1,imm=99)+I(0x61,3,1),'input load region'),
  ('read output before write',I(0x61,3,1),'input load region'),
  ('write input',I(0x62,2),'output write region'),
  ('negative output offset',I(0x62,1,off=-4),'output write bounds'),
  ('unaligned output offset',I(0x62,1,off=2),'output write bounds'),
  ('word past output',I(0x62,1,off=40),'output write bounds'),
  ('wide past output',I(0x7a,1,off=36),'output write bounds'),
  ('pointer stored as scalar word',I(0x63,1,2),'scalar required'),
  ('store register reserved immediate',I(0x63,1,3,imm=1),'output store fields'),
  ('store immediate reserved source',I(0x62,1,3),'output immediate fields'),
  ('wide store reserved source',I(0x7a,1,3),'output immediate fields'),
  ('wide immediate reserved source',I(0x18,3,1)+I(0),'wide immediate fields'),
  ('wide immediate writes frame',I(0x18,10)+I(0),'wide immediate fields'),
  ('OR reserved offset',I(0x47,3,off=1),'or immediate fields'),
  ('OR pointer',I(0x47,1,imm=1),'scalar required'),
 ]
 for name,code,reason in cases:
  before=len(reads)
  try:run(code)
  except ValueError as e:
   if str(e)!=reason:raise RuntimeError((name,str(e),reason))
  else:raise RuntimeError('accepted '+name)
  if 'output' in name and 'read' in name and len(reads)!=before:raise RuntimeError('mutable reader called')
  rows.append({'name':name,'reason':reason})

 # Incompatible pointer/scalar merges may be discarded, but not observed.
 head=I(0x15,0,off=2)+I(0xbf,3,2)+I(5,off=1)+I(0xbf,3,4)
 state=run(head+I(0xb7,3))
 prove('dead incompatible merge may be overwritten',z.And(state['guard'],state['registers'][3]==0))
 if state['poisonMerges']==0:raise RuntimeError('missing poison merge')
 for name,tail,reason in [
  ('poison scalar use',I(0x1f,3,4),'scalar required'),
  ('poison pointer use',I(0x61,4,3),'word load base'),
  ('poison spilled then observed',I(0x7b,10,3,off=-8)+I(0x79,4,10,off=-8)+I(0x47,4,imm=1),'scalar required'),
  ('poison output store',I(0x63,1,3),'scalar required')]:
  try:run(head+tail)
  except ValueError as e:
   if str(e)!=reason:raise RuntimeError((name,str(e),reason))
  else:raise RuntimeError('accepted '+name)
  rows.append({'name':name,'reason':reason})
 # Output joins are32bit, distinct from register/stack64 joins.
 code=I(0x15,0,off=2)+I(0x62,1,imm=11)+I(5,off=1)+I(0x62,1,imm=22)
 state=run(code)
 prove('output branch merge',state['memory'][('output',0)]==z.If(regs[0]==0,z.BitVecVal(22,32),z.BitVecVal(11,32)))
 state=run(I(0x15,0,off=1)+I(0x62,1,imm=22))
 if ('output',0) in state['memory']:raise RuntimeError('partially initialized output presented as definite')
 # Unsigned >= boundary and sign-extended immediate are explicit.
 for op,src,imm,right in [(0x3d,4,0,regs[4]),(0x35,0,-1,z.BitVecVal(2**64-1,64))]:
  code=I(op,3,src,off=2,imm=imm)+I(0x62,1,imm=11)+I(5,off=1)+I(0x62,1,imm=22)
  state=run(code)
  prove('unsigned greater equal '+hex(op),state['memory'][('output',0)]==z.If(z.UGE(regs[3],right),z.BitVecVal(22,32),z.BitVecVal(11,32)))
 # Opt-in native division discharges nonzero at every actual instruction.
 def divide(code,enabled=True):
  return m.execute(code+I(0x95),0,0,len(code),regs,{'input':40,'output':40},reader,native_division=enabled)
 state=divide(I(0xb7,3,imm=123)+I(0xb7,4,imm=7)+I(0x3f,3,4))
 prove('native unsigned quotient',z.And(state['registers'][3]==17,z.BoolVal(state['divisionChecks']==1)))
 state=divide(I(0x15,4,off=1)+I(0x3f,3,4))
 prove('branch guards native division',state['registers'][3]==z.If(regs[4]==0,regs[3],z.UDiv(regs[3],regs[4])))
 state=divide(I(0x15,3,off=1)+I(0x3f,3,3))
 prove('aliased dividend divisor reads before write',state['registers'][3]==z.If(regs[3]==0,regs[3],z.BitVecVal(1,64)))
 for name,code,enabled,reason in [
  ('division opt-in required',I(0x3f,3,4),False,'native division disabled'),
  ('unguarded symbolic divisor',I(0x3f,3,4),True,'division nonzero obligation: sat'),
  ('literal zero divisor',I(0xb7,4)+I(0x3f,3,4),True,'division nonzero obligation: sat'),
  ('division pointer operand',I(0x3f,3,2),True,'scalar required'),
  ('division frame operand',I(0x3f,3,10),True,'division fields'),
  ('division reserved offset',I(0x3f,3,4,off=1),True,'division fields'),
  ('division reserved immediate',I(0x3f,3,4,imm=1),True,'division fields')]:
  try:divide(code,enabled)
  except ValueError as e:
   if str(e)!=reason:raise RuntimeError((name,str(e),reason))
  else:raise RuntimeError('accepted '+name)
  rows.append({'name':name,'reason':reason})
 original_solver=m.z.Solver
 class Unknown:
  def set(self,**kwargs):pass
  def add(self,*args):pass
  def check(self):return z.unknown
 try:
  m.z.Solver=Unknown
  try:divide(I(0xb7,4,imm=7)+I(0x3f,3,4))
  except ValueError as e:
   if str(e)!='division nonzero obligation: unknown':raise
  else:raise RuntimeError('accepted division UNKNOWN')
 finally:m.z.Solver=original_solver
 rows.append({'name':'division UNKNOWN','reason':'division nonzero obligation: unknown'})
 original=list(regs);stack={-8:('output',0)}
 run(I(0x79,3,10,off=-8)+I(0x62,3,imm=33),stack)
 if stack!={-8:('output',0)} or any(a is not b for a,b in zip(regs,original)):raise RuntimeError('mutated caller inputs')
 child=subprocess.run([sys.executable,'-O',str(Path(m.__file__))],capture_output=True,text=True,timeout=10)
 if child.returncode==0 or 'assertions required' not in child.stderr:raise RuntimeError('optimized Python accepted')
 return {'passed':True,'claims':claims,'refusals':rows,'optimizedPythonRefused':True}
