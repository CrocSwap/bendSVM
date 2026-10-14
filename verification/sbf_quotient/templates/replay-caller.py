"""Exact emitted division router/calls/helpers, quotient checked against Python."""
from pathlib import Path
import hashlib,json,os,random,struct,subprocess,sys,uuid
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes());start,end,stop=0x2248,0x6398,0x2748
run=base/'caller-replays'/str(uuid.uuid4());run.mkdir(parents=True);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')));clang=tools/'clang';ld=tools/'ld.lld';runner=repo/'target/debug/bend-test-runner'
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
# Wrapper supplies declared quotient/divisor/product limbs, clock difference,
# saved context and deferred flag. The original overflow/router/caller bytes
# then run without replacing any successful-path instruction before checkpoint.
pre=[I(0x7b,10,1,-1024),I(0xbf,6,1),
 I(0x61,9,6,16),I(0x7b,10,9,-0x150),
 I(0x61,9,6,20),I(0x7b,10,9,-0xa8),I(0x7b,10,9,-0x180),I(0x67,9,imm=32),I(0x7b,10,9,-0x170),
 I(0x61,1,6,24),I(0xbf,0,1),I(0xbf,9,1),I(0x67,9,imm=32),I(0x7b,10,9,-0x178),I(0x61,8,6,28),
 I(0x61,4,6,32),I(0x61,2,6,36),I(0x7a,10,off=-0x138),I(0x7b,10,4,-0x168),
 I(0x7a,10,off=-0x160,imm=0x55),I(0xb7,3,imm=0x13579)]

artifacts={};programs={}
for name in ['baseline','wrong-route','wrong-result-word','wrong-inline-bit','small-first-division','small-second-division','small-remainder-multiply']:
 code=list(pre)+[I(5)]*((end-start)//8);checkpoint=len(code)
 code += [I(0x79,2,10,-1024),I(0x79,0,10,-0xa8),I(0x79,1,2,40),I(0x5d,0,1,off=4),I(0x55,3,imm=0x13579,off=3),I(0x55,9,imm=0x55,off=2),I(0xb7,0),I(0x95)]
 failure=len(code);code += [I(0xb7,0,imm=42),I(0x95)]
 for at in range(start,end,8):
  index=len(pre)+(at-start)//8
  if at==stop:code[index]=I(5,off=checkpoint-index-1)
  elif start<=at<0x2308 or 0x2490<=at<stop or 0x46d8<=at<end:code[index]=text[at-address:at-address+8]
  else:code[index]=I(5,off=failure-index-1)
 changes=[]
 if name=='wrong-route':changes=[(0x24e8,0,0x55)]
 elif name=='wrong-inline-bit':changes=[(0x4878,0,0x57)]
 elif name=='wrong-result-word':changes=[(0x25f8,2,0x68)]
 elif name=='small-first-division':changes=[(0x26b8,0,0x1f)]
 elif name=='small-second-division':changes=[(0x2700,0,0x1f)]
 elif name=='small-remainder-multiply':changes=[(0x26c8,0,0x4f)]
 for at,byte,val in changes:
  index=len(pre)+(at-start)//8;body=bytearray(code[index]);body[byte]=val;code[index]=bytes(body)
 raw=b''.join(code);asm=run/(name+'.s');obj=run/(name+'.o');out=run/(name+'.so')
 asm.write_text('.text\n.globl entrypoint\n.type entrypoint,@function\n.p2align 3\nentrypoint:\n'+''.join('.byte '+','.join(map(str,raw[i:i+16]))+'\n' for i in range(0,len(raw),16))+'.size entrypoint,.-entrypoint\n')
 logs=[]
 for command in [[str(clang),'--target=sbf','-mcpu=generic','-c',str(asm),'-o',str(obj)],[str(ld),'-z','notext','-shared','--Bdynamic',str(repo/'runtime/sbf.ld'),'--entry','entrypoint','-z','max-page-size=4096','--gc-sections',str(obj),'-o',str(out)]]:
  p=subprocess.run(command,capture_output=True,text=True,timeout=30);logs.append(p.stdout+p.stderr)
  if p.returncode:raise RuntimeError(p.stderr)
 log=run/(name+'.log');log.write_text(''.join(logs));_,actual=text_section(out.read_bytes())
 if actual!=raw:raise RuntimeError('assembled byte mismatch')
 for at in [*range(start,0x2308,8),*range(0x2490,stop,8),*range(0x46d8,end,8)]:
  if at in [c[0] for c in changes]:continue
  off=len(pre)*8+at-start
  if actual[off:off+8]!=text[at-address:at-address+8]:raise RuntimeError('original instruction changed')
 programs[name]=out;artifacts[name]={str(p):sha(p) for p in [asm,obj,out,log]}
p=subprocess.Popen([str(runner)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def ask(req):
 p.stdin.write(json.dumps(req)+'\n');p.stdin.flush();value=json.loads(p.stdout.readline())
 if not value['success']:raise RuntimeError(value)
 return value['value']
mask=2**64-1;rows=[];rng=random.Random(3264)
cases=[(0,0,1),(mask,0,1),(mask,0,2),(mask,0,2**32),(0,mask-1,mask),(mask,mask-1,mask)]
for _ in range(64):
 d=rng.randrange(2,2**64);cases.append((rng.getrandbits(64),rng.randrange(d),d))
for _ in range(16):cases.append((rng.getrandbits(64),0,rng.randrange(2**32,2**64)))
for _ in range(16):cases.append((rng.randrange(2**32),0,rng.randrange(2,2**32)))
# Maintain the former full/native corpus and add nonzero-high small divisors,
# including quotient/remainder/limb boundaries and deterministic fresh cases.
for d in [2,3,5,7,2**16,2**32-1]:
 for h in [1,d-1]:
  for q in [0,1,0x0123456789abcdef,mask]:cases.append((q,h,d))
for _ in range(32):
 d=rng.randrange(2,2**32);cases.append((rng.getrandbits(64),rng.randrange(1,d),d))
def route(q,h,d):return 'direct' if d==1 else 'native' if h==0 else 'small' if d<2**32 else 'full'
try:
 keys={}
 for i,(name,program) in enumerate(programs.items()):
  key=ask({'op':'key','seed':151+i});ask({'op':'load','program':key,'elf':str(program)});keys[name]=key
 def send(name,q,h,d,want):return ask({'op':'send','instructions':[{'program':keys[name],'accounts':[],'data':list(struct.pack('<4Q',q,h,d,want))}]})
 for q,h,d in cases:
  want=((h<<64)|q)//d;result=send('baseline',q,h,d,want)
  if not result['ok']:raise RuntimeError(('baseline',q,h,d,result))
  rows.append({'kind':'baseline','route':route(q,h,d),'input':[q,h,d],'expected':want,'result':result})
 # Incorrect route must be observed on a valid full-path input.
 for name,args in [('wrong-route',(mask,1,2**32+1)),('wrong-result-word',(0x0123456789abcdef,1,2**32+1)),('wrong-inline-bit',(mask,1,2**32+1)),('small-first-division',(0x0123456789abcdef,1,2)),('small-second-division',(0x0123456789abcdef,1,2)),('small-remainder-multiply',(0x0123456789abcdef,1,2))]:
  q,h,d=args;result=send(name,q,h,d,((h<<64)|q)//d)
  if result['ok'] or result.get('code')!=42:raise RuntimeError((name,result))
  rows.append({'kind':'fault','name':name,'input':args,'result':result})
 for q,h,d in [(0,1,1),(0,0,0),(0,2,2)]:
  result=send('baseline',q,h,d,0)
  if result['ok'] or result.get('code')!=42:raise RuntimeError('overflow/domain accepted')
  rows.append({'kind':'outside-domain','input':[q,h,d],'result':result})
finally:p.stdin.close();rc=p.wait(timeout=10);stderr=p.stderr.read()
if rc or stderr:raise RuntimeError((rc,stderr))
report={'passed':True,'exploratory':True,'endToEndVerified':False,'baselineCases':len(cases),'executions':len(rows),'rows':rows,'artifacts':artifacts,'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_elf.py',clang,ld,runner,repo/'runtime/sbf.ld']},'scope':'Instrumented actual overflow/route/caller/div16/div4 sequence; quotient compared with independent Python128by64division. Entry limbs supplied by wrapper; checkpoint replaces instruction2748 and checks saved context/deferred flag, unselected regions trap. No original application entrance, whole handler or production binary claim.'}
file=run/'report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(file),'baselineCases':len(cases),'executions':len(rows)}))
