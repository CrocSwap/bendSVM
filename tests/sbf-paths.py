"""Independent path/state expectations and strict domain controls."""
import struct,subprocess,sys
from pathlib import Path
import z3 as z
import sbf_paths as p
I=lambda op=0xb7,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)

def check():
 regs=[z.BitVec('path_r'+str(i),64) for i in range(10)]+[('stack',0)]
 x=z.BitVec('input_word',32);regions={'data':8,'other':8}
 def run(code,r=None,reader=None,sizes=None,stack=None):
  text=code+I(0x95)
  return p.execute(text,0,0,len(code),regs if r is None else r,regions if sizes is None else sizes,reader or (lambda region,offset:x),stack)
 claims=[];refusals=[]
 def prove(name,claim):
  s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim))
  if s.check()!=z.unsat:raise RuntimeError(name)
  claims.append(name)
 def refuse(name,fn,reason):
  try:fn()
  except ValueError as e:
   if str(e)!=reason:raise RuntimeError((name,str(e),reason))
  else:raise RuntimeError('accepted '+name)
  refusals.append(name)
 # Both arms write a register and the same slot, then load after the join.
 diamond=I(0x15,0,off=3)+I(0xb7,1,imm=11)+I(0x7b,10,1,-8)+I(5,off=2)+I(0xb7,1,imm=22)+I(0x7b,10,1,-8)+I(0x79,2,10,-8)
 out=run(diamond);want=z.If(regs[0]==0,z.BitVecVal(22,64),z.BitVecVal(11,64))
 prove('both-arm merge',z.And(out['guard'],out['registers'][1]==want,out['registers'][2]==want,out['memory'][-8]==want))
 # One arm exits before the cutpoint; the final guard must retain its predicate.
 out=p.execute(I(0x15,0,off=1)+I(0x95)+I(0xb7,1,imm=3)+I(0x95),0,0,24,regs,regions,lambda r,o:x)
 prove('conditional cutpoint guard',out['guard']==(regs[0]==0))
 # Memory read only initialized on one branch is rejected, even for an impossible arm.
 one_arm=I(0x15,0,off=2)+I(0x7b,10,0,-8)+I(5,off=1)+I(0xb7,1)+I(0x79,2,10,-8)
 refuse('one-arm stack initialization',lambda:run(one_arm),'initialized stack load')
 # Stack initialization supplied by caller survives a conditional overwrite.
 out=run(one_arm,stack={-8:z.BitVecVal(7,64)})
 prove('preinitialized conditional overwrite',out['registers'][2]==z.If(regs[0]==0,z.BitVecVal(7,64),regs[0]))
 # Distinct pointer values cannot be silently scalarized/merged.
 rp=list(regs);rp[2]=('data',0);rp[3]=('other',0)
 pointers=I(0x15,0,off=2)+I(0xbf,1,2)+I(5,off=1)+I(0xbf,1,3)
 refuse('different pointer merge',lambda:run(pointers,rp),'pointer merge')
 rp[3]=('data',0);out=run(pointers,rp);assert out['registers'][1]==('data',0)
 # Read each word once even when it is loaded into two registers.
 reads=[];rp=list(regs);rp[1]=('data',0)
 def reader(region,offset):reads.append((region,offset));return x
 out=run(I(0x61,2,1)+I(0x61,3,1),rp,reader)
 assert reads==[('data',0)]
 prove('immutable cached zero extension',z.And(out['registers'][2]==z.ZeroExt(32,x),out['registers'][3]==z.ZeroExt(32,x)))
 out=run(I(0x61,2,1,4),rp)
 prove('last full word in region',out['registers'][2]==z.ZeroExt(32,x))
 for name,fn,reason in [
  ('read beyond region',lambda:run(I(0x61,2,1,8),rp),'input region bounds'),
  ('misaligned word',lambda:run(I(0x61,2,1,1),rp),'input word alignment'),
  ('negative word',lambda:run(I(0x61,2,1,-4),rp),'input word alignment'),
  ('wrong reader width',lambda:run(I(0x61,2,1),rp,lambda r,o:z.BitVecVal(0,64)),'input word width'),
  ('oversized region',lambda:run(b'',sizes={'data':1540}),'input region sizes'),
  ('stack named input region',lambda:run(b'',sizes={'stack':8}),'input region sizes'),
  ('invalid initial stack',lambda:run(b'',stack={0:regs[0]}),'path stack state'),
  ('bad frame pointer',lambda:run(b'',regs[:-1]+[z.BitVecVal(0,64)]),'path register state'),
  ('bad scalar width',lambda:run(b'',[z.BitVecVal(0,32)]+regs[1:]),'path register state'),
  ('write frame pointer',lambda:run(I(0xb7,10)),'immediate fields'),
  ('pointer arithmetic',lambda:run(I(0x1f,1,0),rp),'scalar required'),
  ('pointer comparison',lambda:run(I(0x15,1,off=1)+I(),rp),'scalar required'),
  ('coincident branch',lambda:run(I(0x15,0)),'coincident branch successors unsupported'),
  ('reserved branch immediate',lambda:run(I(0x1d,0,1,1,1)+I()),'branch reserved fields'),
  ('reserved immediate branch source',lambda:run(I(0x15,0,1,1)+I()),'branch reserved fields'),
  ('signed branch',lambda:run(I(0x65,0,off=1)+I()),'unsupported branch'),
  ('store pointer',lambda:run(I(0x7b,10,1,-8),rp),'scalar required'),
 ]:refuse(name,fn,reason)
 # Nested merges: two independent decisions, three-way output, all inputs arbitrary.
 nested=I(0x15,0,off=4)+I(0x15,1,off=1)+I(0xb7,2,imm=9)+I(5,off=2)+I()+I(0xb7,2,imm=5)
 out=run(nested)
 expected=z.If(regs[0]==0,z.BitVecVal(5,64),z.If(regs[1]==0,regs[2],z.BitVecVal(9,64)))
 prove('nested guarded merges',z.And(out['guard'],out['registers'][2]==expected))
 # Scalar operations that extend the straight-line model.
 code=I(0xbf,2,0)+I(0x1f,2,1)+I(0x57,2,imm=-1)+I(0x5f,2,0)
 out=run(code);prove('subtract and sign-extended mask',out['registers'][2]==((regs[0]-regs[1])&regs[0]))
 before=dict(regions);stack={-8:regs[0]};run(I(0x7b,10,1,-8),stack=stack)
 assert regions==before and stack[-8].eq(regs[0]) and regs[10]==('stack',0)
 child=subprocess.run([sys.executable,'-O',str(Path(p.__file__))],capture_output=True,text=True,timeout=10)
 assert child.returncode!=0 and 'assertions required' in child.stderr
 return {'passed':True,'claims':claims,'refusals':refusals,'optimizedPythonRefused':True}
