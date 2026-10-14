"""Model contract tests: independent integer oracle, algebra and refusals."""
from pathlib import Path
import hashlib,json,random,struct,subprocess,sys,runpy
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'verification'))
import sbf_machine as m
import z3 as z
if not __debug__:raise RuntimeError('assertions required')
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
mask=2**64-1
regs=[z.BitVec('r'+str(i),64) for i in range(11)]
mem={-8:z.BitVec('old',64)}
refusals=[]
def refuse(name,call,reason):
 try:call()
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((name,str(e),reason))
 else:raise RuntimeError('accepted '+name)
 refusals.append(name)
for name,code,reason in [
 ('truncated',b'\x00','instruction alignment'),
 ('register range',I(0xbf,11),'register range'),
 ('frame write',I(0xbf,10),'scalar destination/offset'),
 ('frame scalar read',I(0xbf,0,10),'scalar frame pointer read'),
 ('reserved offset',I(0xbf,off=1),'scalar destination/offset'),
 ('reserved immediate',I(0x2f,imm=1),'reserved immediate'),
 ('shift width',I(0x67,imm=64),'shift shape'),
 ('negative shift',I(0x77,imm=-1),'shift shape'),
 ('shift source',I(0x67,s=1),'shift shape'),
 ('immediate source',I(0xb7,s=1),'immediate register'),
 ('branch',I(5),'unsupported opcode 0x5'),
 ('call',I(0x85),'unsupported opcode 0x85'),
 ('unaligned load',I(0x79,0,10,-7),'stack load shape'),
 ('load below frame',I(0x79,0,10,-4104),'stack load shape'),
 ('nonstack load',I(0x79,0,9,-8),'stack load shape'),
 ('uninitialized',I(0x79,0,10,-16),'unbound stack input'),
 ('reserved load',I(0x79,0,10,-8,1),'stack load shape'),
 ('store end',I(0x7b,10,0,0),'stack store shape'),
 ('store below frame',I(0x7b,10,0,-4104),'stack store shape'),
 ('nonstack store',I(0x7b,9,0,-8),'stack store shape'),
 ('pointer store',I(0x7b,10,10,-8),'stack store shape'),
]:refuse(name,lambda code=code:m.execute(code,regs,mem),reason)
refuse('wrong register count',lambda:m.execute(b'',regs[:-1],mem),'register state')
refuse('wrong register width',lambda:m.execute(b'',[z.BitVecVal(0,32)]+regs[1:],mem),'register state')
refuse('wrong memory width',lambda:m.execute(b'',regs,{-8:z.BitVecVal(0,32)}),'stack state')
refuse('bad initial frame offset',lambda:m.execute(b'',regs,{0:regs[0]}),'stack state')
# Universal bitvector properties use different algebraic expressions where possible.
claims=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result)))
 claims.append(name)
r,_,_,_=m.execute(I(0x0f,0,1),regs,mem)
prove('addition integer carry truncation',r[0]==z.Extract(63,0,z.ZeroExt(1,regs[0])+z.ZeroExt(1,regs[1])))
r,_,_,_=m.execute(I(0x2f,0,1),regs,mem)
prove('multiplication widening truncation',r[0]==z.Extract(63,0,z.ZeroExt(64,regs[0])*z.ZeroExt(64,regs[1])))
for shift in (0,1,31,32,63):
 r,_,_,_=m.execute(I(0x77,0,imm=shift),regs,mem)
 expected=regs[0] if not shift else z.ZeroExt(shift,z.Extract(63,shift,regs[0]))
 prove('logical shift '+str(shift),r[0]==expected)
r,mm,w,_=m.execute(I(0x7b,10,0,-4096)+I(0x79,1,10,-4096),regs,mem)
prove('store load and preserved frame',z.And(r[1]==regs[0],r[10]==regs[10],mm[-8]==mem[-8]))
assert w=={-4096}
# Deterministic independently evaluated integer programs, including all shift widths,
# signed immediates, wraparound, self-aliasing and stack overwrite/load order.
rng=random.Random(64053);cases=200
for case in range(cases):
 initial=[rng.getrandbits(64) for _ in range(11)];values=list(initial);memory={-8:rng.getrandbits(64)};initial_memory=dict(memory);code=[];writes=set()
 for step in range(40):
  op=rng.choice(['move','add','mul','left','right','immediate','store','load']);d=rng.randrange(10);s=rng.randrange(10)
  if op=='move':code.append(I(0xbf,d,s));values[d]=values[s]
  elif op=='add':code.append(I(0x0f,d,s));values[d]=(values[d]+values[s])&mask
  elif op=='mul':code.append(I(0x2f,d,s));values[d]=(values[d]*values[s])&mask
  elif op in ('left','right'):
   shift=(case+step)%64;code.append(I(0x67 if op=='left' else 0x77,d,imm=shift));values[d]=((values[d]<<shift)&mask) if op=='left' else values[d]>>shift
  elif op=='immediate':
   imm=rng.choice([-2**31,-1,0,1,2**31-1]);code.append(I(0xb7,d,imm=imm));values[d]=imm&mask
  elif op=='store':
   slot=rng.choice([-8,-16,-4096]);code.append(I(0x7b,10,s,slot));memory[slot]=values[s];writes.add(slot)
  else:
   slot=rng.choice(list(memory));code.append(I(0x79,d,10,slot));values[d]=memory[slot]
 zregs=[z.BitVecVal(v,64) for v in initial];zmem={k:z.BitVecVal(v,64) for k,v in initial_memory.items()}
 result,stack,changed,decoded=m.execute(b''.join(code),zregs,zmem)
 assert [z.simplify(v).as_long() for v in result]==values
 assert {k:z.simplify(v).as_long() for k,v in stack.items()}==memory and changed==writes and len(decoded)==40
 assert [v.as_long() for v in zregs]==initial and {k:v.as_long() for k,v in zmem.items()}==initial_memory
# A concrete arithmetic fault must disagree with the independent expected result.
a=[z.BitVecVal(v,64) for v in [3,5]+[0]*9]
r,_,_,_=m.execute(I(0x0f,0,1),a,{})
assert z.simplify(r[0]).as_long()!=15
# Failed execution must not leak a preceding store into caller-owned state.
refuse('failure preserves input',lambda:m.execute(I(0x7b,10,0,-16)+I(0x85),regs,mem),'unsupported opcode 0x85')
assert set(mem)=={-8}
p=subprocess.run([sys.executable,'-O',str(Path(m.__file__))],capture_output=True,text=True,timeout=10)
assert p.returncode!=0 and 'assertions required' in p.stderr
cfg_test=Path(__file__).with_name('sbf-cfg.py')
cfg_result=runpy.run_path(str(cfg_test))['check']()
paths_test=Path(__file__).with_name('sbf-paths.py')
paths_result=runpy.run_path(str(paths_test))['check']()
elf_test=Path(__file__).with_name('sbf-elf.py')
elf_result=runpy.run_path(str(elf_test))['check']()
leaf_test=Path(__file__).with_name('sbf-leaf.py')
leaf_result=runpy.run_path(str(leaf_test))['check']()
source=[Path(__file__).resolve(),Path(m.__file__).resolve(),cfg_test.resolve(),Path(m.__file__).with_name('sbf_cfg.py').resolve(),paths_test.resolve(),Path(m.__file__).with_name('sbf_paths.py').resolve(),elf_test.resolve(),Path(m.__file__).with_name('sbf_elf.py').resolve(),leaf_test.resolve(),Path(m.__file__).with_name('sbf_leaf.py').resolve()]
print(json.dumps({'passed':True,'endToEndVerified':False,'leaf':leaf_result,'elf':elf_result,'paths':paths_result,'cfg':cfg_result,'claims':claims,'refusals':refusals,'concretePrograms':cases,'instructionsPerProgram':40,'optimizedPythonRefused':True,'sourceHashes':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in source}}))
