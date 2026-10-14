"""Independent byte-memory comparisons and refusals for the output model."""
from pathlib import Path
import hashlib,json,random,struct,subprocess,sys
base=Path(__file__).resolve().parent;repo=base.parent;sys.path.insert(0,str(repo/'verification'));sys.path.insert(0,str(base))
import z3 as z
import sbf_output as m
if not __debug__:raise RuntimeError('assertions required')
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
B=lambda v:z.BitVecVal(v,64);W=lambda v:z.BitVecVal(v,32)
sizes={'stack':(-4096,0),'input':(0,32),'output':(0,32)}
def regs():return [B(0),('output',0),('input',0),B(0),B(0),B(0),B(77),B(88),B(99),B(111),('stack',0)]
def run(code,r=None,mem=None,regions=None,address=0):
 code=b''.join(code)+I(0x95)
 return m.execute(code,address,address,address+len(code)-8,regs() if r is None else r,{} if mem is None else mem,sizes if regions is None else regions,memset_target=0x6720)
claims=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result)))
 claims.append({'name':name,'result':str(result)})
a,b=z.BitVecs('wide_a wide_b',64);r=regs();r[0]=a;r[3]=b
x=run([I(0x7b,10,0,-16),I(0x63,10,3,-12),I(0x79,4,10,-16)],r)
prove('wide read sees overlapping high-word store',x['registers'][4]==z.Concat(z.Extract(31,0,b),z.Extract(31,0,a)))
x=run([I(0x7b,10,0,-16),I(0x63,10,3,-16),I(0x79,4,10,-16)],r)
prove('wide read sees overlapping low-word store',x['registers'][4]==z.Concat(z.Extract(63,32,a),z.Extract(31,0,b)))
x=run([I(0x63,10,0,-16),I(0x63,10,3,-12),I(0x79,4,10,-16)],r)
prove('adjacent words pack little endian',x['registers'][4]==z.Concat(z.Extract(31,0,b),z.Extract(31,0,a)))
x=run([I(0x7a,10,off=-16,imm=-1),I(0x79,4,10,-16)])
prove('immediate wide store sign extends',x['registers'][4]==B(-1))
mem={('output',i):z.BitVec('before_'+str(i),32) for i in range(0,32,4)};r=regs();r[1]=('output',8);r[2]=B(0);r[3]=B(16)
x=run([I(0x85,s=1,imm=3)],r,mem,address=0x6700)
prove('memset clears exactly its range',z.And(*(x['memory']['output',i]==(W(0) if 8<=i<24 else mem['output',i]) for i in range(0,32,4))))
prove('call summary preserves nonvolatile scalar registers',z.And(*(x['registers'][i]==r[i] for i in range(6,10))))
assert x['registers'][10]==('stack',0) and x['writes']=={('output',i) for i in range(8,24,4)}
assert all(z.is_const(x['registers'][i]) and not z.is_bv_value(x['registers'][i]) for i in range(6))
# Random whole programs use a bytearray oracle, independent of the model's word map.
rng=random.Random(360);programs=200;operations=40
for case in range(programs):
 r=regs();r[1]=('stack',-128);r[2]=('input',0);wide=rng.getrandbits(64);r[3]=B(wide);memory={('stack',i):W(0) for i in range(-128,0,4)};oracle=bytearray(128);code=[];expected={}
 for _ in range(operations):
  width=rng.choice([4,8]);offset=4*rng.randrange((128-width)//4+1);value=rng.getrandbits(64)
  # Mix full-width entry register values with sign-extended immediates.
  if rng.randrange(2):code.append(I(0xbf,0,3));value=wide
  else:
   imm=rng.randrange(-2**31,2**31);code.append(I(0xb7,0,imm=imm));value=imm&((1<<64)-1)
  code.append(I(0x63 if width==4 else 0x7b,1,0,offset));oracle[offset:offset+width]=value.to_bytes(8,'little')[:width]
  readwidth=rng.choice([4,8]);off=4*rng.randrange((128-readwidth)//4+1);code.append(I(0x61 if readwidth==4 else 0x79,4,1,off));expected[4]=int.from_bytes(oracle[off:off+readwidth],'little')
 actual=run(code,r,memory)
 assert z.simplify(actual['registers'][4]).as_long()==expected[4]
 assert all(z.simplify(actual['memory']['stack',-128+i]).as_long()==int.from_bytes(oracle[i:i+4],'little') for i in range(0,128,4))
refusals=[]
def refuse(name,reason,code,r=None,mem=None,regions=None,address=0):
 try:run(code,r,mem,regions,address)
 except ValueError as e:
  if str(e)!=reason:raise RuntimeError((name,str(e),reason))
 else:raise RuntimeError('accepted '+name)
 refusals.append({'name':name,'reason':reason})
refuse('missing region','region inventory',[],regions={'stack':(-4096,0)})
refuse('oversized input','region bounds',[],regions={**sizes,'input':(0,1540)})
refuse('different frame','region bounds',[],regions={**sizes,'stack':(-8192,0)})
refuse('narrow register','initial registers',[],r=[W(0)]+regs()[1:])
refuse('missing register','initial registers',[],r=regs()[:-1])
r=regs();r[10]=B(0);refuse('forged frame','initial registers',[],r=r)
r=regs();r[1]=('absent',0);refuse('unknown pointer region','initial registers',[],r=r)
refuse('misaligned initial word','initial memory word',[],mem={('stack',-7):W(0)})
refuse('wide initial word','initial memory word',[],mem={('stack',-8):B(0)})
refuse('initial word out of range','initial memory word',[],mem={('input',32):W(0)})
refuse('uninitialized high half','initialized word load',[I(0x79,0,10,-8)],mem={('stack',-8):W(1)})
refuse('output loads','output read refused',[I(0x61,0,1)],mem={('output',0):W(1)})
refuse('input writes','immutable input store',[I(0x63,2,0)])
refuse('misaligned write','memory bounds',[I(0x63,10,0,-7)])
refuse('write past frame','memory bounds',[I(0x7b,10,0,-4)])
refuse('write below frame','memory bounds',[I(0x7b,10,0,-4104)])
refuse('write past output','memory bounds',[I(0x7b,1,0,28)])
refuse('replace frame register','immediate shape',[I(0xb7,10)])
refuse('serialize pointer','scalar required',[I(0x7b,10,1,-8)])
refuse('pointer arithmetic on scalar','pointer required',[I(0x07,0,imm=4)])
refuse('pointer past boundary','pointer addition bounds',[I(0x07,1,imm=36)])
refuse('shift overflow','shift shape',[I(0x67,0,imm=64)])
refuse('reserved move fields','move shape',[I(0xbf,0,1,off=1)])
refuse('unknown operation','unsupported output opcode 0x0',[I(0)])
refuse('wrong helper target','memset wrapper call',[I(0x85,s=1,imm=2)],address=0x6700)
r=regs();r[2]=B(1);r[3]=B(4);refuse('nonzero fill','zero fill arguments',[I(0x85,s=1,imm=3)],r=r,address=0x6700)
r=regs();r[2]=B(0);r[3]=z.BitVec('symbolic_size',64);refuse('symbolic fill length','zero fill arguments',[I(0x85,s=1,imm=3)],r=r,address=0x6700)
r=regs();r[2]=B(0);r[3]=B(3);refuse('partial-word fill','word fill length',[I(0x85,s=1,imm=3)],r=r,address=0x6700)
r=regs();r[1]=('input',0);r[2]=B(0);r[3]=B(4);refuse('fill readonly memory','fill output region',[I(0x85,s=1,imm=3)],r=r,address=0x6700)
r=regs();r[2]=B(0);r[3]=B(36);refuse('fill beyond output','memory bounds',[I(0x85,s=1,imm=3)],r=r,address=0x6700)
r=regs();r[0]=z.BitVec('branch_value',64);refuse('symbolic branch','symbolic output branch',[I(0x15,0,off=1),I(0xb7,0)],r=r)
refuse('backward branch','forward jump',[I(5,off=-1)])
# Decoder must reject a branch into an LDDW continuation word.
refuse('continuation branch','edge target is not an instruction',[I(5,off=1),I(0x18),I(0),I(0xb7,0)])
# Caller objects remain unchanged on both success and failure.
r=regs();mem={('stack',-8):W(7),('stack',-4):W(8)};oldr=list(r);oldmem=dict(mem)
run([I(0x7a,10,off=-8,imm=0)],r,mem);assert r==oldr and mem==oldmem
refuse('after-write failure','output read refused',[I(0x7a,10,off=-8),I(0x61,0,1)],r,mem);assert r==oldr and mem==oldmem
p=subprocess.run([sys.executable,'-O','-c',"import sys;sys.path[:0]="+repr([str(base),str(repo/'verification')])+";import sbf_output"],capture_output=True,text=True,timeout=10)
if p.returncode==0 or 'assertions required' not in p.stderr:raise RuntimeError('optimized model accepted')
for name,args,reason in [
 ('missing call contract',(I(0x85,s=1,imm=3)+I(0x95),0x6700,0x6700,0x6708,regs(),{},sizes),'memset wrapper call'),
 ('invalid call target',(I(0x95),0,0,0,regs(),{},sizes,3),'memory summary target'),
 ('invalid instruction cutpoint',(I(0x95),0,0,4,regs(),{},sizes),'instruction cutpoints'),
]:
 try:m.execute(*args)
 except ValueError as error:
  if str(error)!=reason:raise RuntimeError((name,str(error),reason))
 else:raise RuntimeError('accepted '+name)
 refusals.append({'name':name,'reason':reason})
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report={'passed':True,'endToEndVerified':False,'claims':claims,'integerOraclePrograms':programs,'operationsPerProgram':operations,'refusals':refusals,'optimizedPythonRefused':True,'callerInputsPreserved':True,'inputHashes':{str(p):sha(p) for p in [Path(__file__),repo/'verification/sbf_output.py',repo/'verification/sbf_cfg.py']},'scope':'Output model domain/word-memory/overlap/call-summary tests. The modeled SBF semantics and actual memset/syscall equivalence remain trusted; no verified interpreter claim.'}
print(json.dumps(report))
