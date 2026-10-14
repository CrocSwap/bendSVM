"""Whole compiled native handler dispatch output, with real memory-clear syscall."""
from pathlib import Path
import hashlib,json,os,random,re,struct,subprocess,sys,uuid
base=Path(__file__).resolve().parent;repo=base.parents[1];sys.path.insert(0,str(repo/'verification'))
from sbf_elf import text_section
elf=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(elf.read_bytes())
run=base/'native-dispatch-replays'/str(uuid.uuid4());run.mkdir(parents=True);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')));clang=tools/'clang';ld=tools/'ld.lld';readelf=tools/'llvm-readelf';runner=repo/'target/debug/bend-test-runner'
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
selected=set(range(0x1438,0x2e68,8))|set(range(0x46d8,0x6398,8))|set(range(0x6890,0x68b8,8))
# Actual native ABI caller owns a separate 360-byte output buffer, initially dirty.
pre=[I(0x7b,10,1,-8)]+[I(0x7a,10,off=-2048+k,imm=-1) for k in range(0,360,8)]
pre += [I(0xbf,2,1),I(0x7,2,imm=16),I(0xbf,3,2),I(0x7,3,imm=56),I(0xbf,4,3),I(0x7,4,imm=128),I(0xbf,1,10),I(0x7,1,imm=-2048)]
call=len(pre);pre += [I(0x85,s=1)]
pre += [I(0x79,2,10,-8)];checks=[]
for k in range(0,360,8):
 pre += [I(0x79,0,10,-2048+k),I(0x79,1,2,312+k)];checks.append(len(pre));pre += [I(0x5d,0,1)]
pre += [I(0xb7,0),I(0x95)];failure=len(pre);pre += [I(0xb7,0,imm=42),I(0x95)]
for i in checks:pre[i]=I(0x5d,0,1,off=failure-i-1)
pre[call]=I(0x85,s=1,imm=len(pre)+(0x1438-address)//8-call-1)
changes={'baseline':None,'wrong-source-role':(0x29d0,4,3),'wrong-recipient-kind':(0x29a0,4,0),'short-memory-clear':(0x2e30,4,104),'wrong-init-recipient':(0x1df8,1,0x6),'wrong-init-authority':(0x1e38,4,1),'small-first-division':(0x26b8,0,0x1f),'small-second-division':(0x2700,0,0x1f),'small-remainder-multiply':(0x26c8,0,0x4f)}
programs={};artifacts={}
for name,change in changes.items():
 code=list(pre)
 for at in range(address,address+len(text),8):
  i=len(code);code.append(text[at-address:at-address+8] if at in selected else I(5,off=failure-i-1))
 if change:
  at,byte,val=change;i=len(pre)+(at-address)//8;b=bytearray(code[i]);b[byte]=val;code[i]=bytes(b)
 raw=b''.join(code);reloc_index=len(pre)+(0x68a0-address)//8
 lines=[]
 for i,ins in enumerate(code):
  lines.append('call sol_memset_\n' if i==reloc_index else '.byte '+','.join(map(str,ins))+'\n')
 asm=run/(name+'.s');obj=run/(name+'.o');out=run/(name+'.so');asm.write_text('.text\n.globl entrypoint\n.type entrypoint,@function\n.p2align 3\nentrypoint:\n'+''.join(lines)+'.size entrypoint,.-entrypoint\n')
 logs=[]
 for command in [[str(clang),'--target=sbf','-mcpu=generic','-c',str(asm),'-o',str(obj)],[str(ld),'-z','notext','-shared','--Bdynamic',str(repo/'runtime/sbf.ld'),'--entry','entrypoint','-z','max-page-size=4096','--gc-sections',str(obj),'-o',str(out)]]:
  p=subprocess.run(command,capture_output=True,text=True,timeout=30);logs.append(p.stdout+p.stderr)
  if p.returncode:raise RuntimeError(p.stderr)
 log=run/(name+'.log');log.write_text(''.join(logs));actual_addr,actual=text_section(out.read_bytes())
 if actual!=raw:raise RuntimeError('assembled bytes differ')
 for at in selected:
  if change and at==change[0]:continue
  off=len(pre)*8+at-address
  if actual[off:off+8]!=text[at-address:at-address+8]:raise RuntimeError('native instruction changed')
 rel=subprocess.check_output([str(readelf),'-r',str(out)],text=True);relfile=run/(name+'.relocations.txt');relfile.write_text(rel)
 rows=re.findall(r'^([0-9a-f]{16})\s+[0-9a-f]+\s+(R_SBF_\S+)\s+[0-9a-f]+\s+(\S+)$',rel,re.M)
 if rows!=[(f'{actual_addr+reloc_index*8:016x}','R_SBF_64_32','sol_memset_')]:raise RuntimeError(('syscall relocation',rows))
 programs[name]=out;artifacts[name]={'files':{str(p):sha(p) for p in [asm,obj,out,log,relfile]},'copiedInstructions':len(selected),'memorySyscallRelocation':rows[0]}
mask=2**64-1;rng=random.Random(3601438);cases=[]
for total in [0,1,2**32-1,2**32,2**32+1,2**63,mask]:
 for a,n,e in [(0,1,2),(2**32-1,2**32,2**32+1),(0,1,mask),(mask-2,mask-1,mask),(10,0,20),(10,10,20),(10,20,20),(10,mask,20)]:
  q=0 if n<=a else total if n>=e else total*(n-a)//(e-a)
  for c in sorted(set([0,q,min(mask,q+1),mask])):cases.append((a,n,e,total,c,1,-1))
for _ in range(64):
 a,n,e=sorted(rng.sample(range(2**63-1),3));cases.append((a,n,e,rng.getrandbits(64),rng.getrandbits(64),1,-1))
for signed in [0,1]:
 for mismatch in range(-1,8):
  for claimed in [0,75]:cases.append((0,1,2,100,claimed,signed,mismatch))
cases=[(*args,1,1) for args in cases]
for total in [0,1,2**32-1,2**32,2**32+1,mask]:
 for a,e in [(0,1),(0,mask),(mask-1,mask),(10,10),(20,10),(mask,0)]:
  for signed in [0,1]:
   for mismatch in [-1,0]:cases.append((a,0,e,total,0,signed,mismatch,0,0))
for state_tag,instruction_tag in [(0,1),(1,0)]:
 for signed in [0,1]:
  for mismatch in [-1,0,7]:cases.append((10,15,20,100,0,signed,mismatch,state_tag,instruction_tag))
# Preserve the entire historical 448-case corpus. Add whole-handler cases that
# actually execute nonzero-high 128/32 division, including low-clock wrap and
# transfer/zero/under-claimed outcomes. The original corpus had none.
assert len(cases)==448
for duration in [3,5,7,65537,2**32-1]:
 for elapsed in sorted(set([2,duration-1])):
  for a in [0,mask-duration]:
   q=mask*elapsed//duration
   for c in [0,q//2,q,q+1]:cases.append((a,a+elapsed,a+duration,mask,c,1,-1,1,1))
small_count=sum(st==it==1 and a<n<e and e-a<2**32 and t*(n-a)>>64!=0 for a,n,e,t,c,signed,mismatch,st,it in cases)
assert len(cases)==520 and small_count==72
benef=[0x1020304*(i+1) for i in range(8)];mint=[0x9080706*(i+1) for i in range(8)]
def buffers(args,mutation=None):
 a,n,e,t,c,signed,mismatch,state_tag,instruction_tag=args;ctx=bytearray(56);state=bytearray(128);instruction=bytearray(112);expected=bytearray(360)
 struct.pack_into('<I',state,0,state_tag);struct.pack_into('<I',instruction,0,instruction_tag);struct.pack_into('<I',ctx,40,signed)
 for i in range(8):
  struct.pack_into('<I',ctx,8+4*i,benef[i]^(1 if mismatch==i else 0));struct.pack_into('<I',state,12+4*i,benef[i]);struct.pack_into('<I',state,48+4*i,mint[i])
 for buf,at,v in [(ctx,48,n),(state,84,t),(state,96,a),(state,108,e),(state,120,c)]:struct.pack_into('<Q',buf,at,v)
 if instruction_tag==0:
  instruction[4:112]=state[8:116]
 if state_tag==0:
  error=2 if instruction_tag==1 else 1 if not signed else 3 if a>=e or t==0 else 0
  q=0
 elif instruction_tag==0:error=7;q=0
 else:
  q=0 if n<=a else t if n>=e else t*(n-a)//(e-a)
  if mutation in ['small-first-division','small-second-division','small-remainder-multiply']:
   B=2**32;product=t*(n-a);h=product>>64;low=product&mask;d=e-a
   assert 0<h<d<B
   x=h*B+(low>>32);qh=x-d if mutation=='small-first-division' else x//d
   rh=(x-(qh|d if mutation=='small-remainder-multiply' else qh*d))&(B-1)
   y=rh*B+(low&(B-1));ql=y-d if mutation=='small-second-division' else y//d
   q=((qh&(B-1))<<32)|(ql&(B-1))
  error=1 if not signed or mismatch!=-1 else 4 if q>t else 5 if q<c else 6 if q==c else 0
 if error:struct.pack_into('<2I',expected,0,1,error)
 else:
  new_state=bytearray(state);struct.pack_into('<I',new_state,0,1)
  expected[4:132]=new_state;struct.pack_into('<Q',expected,124,q)
  struct.pack_into('<4I',expected,136,1,4,5,6);expected[152:188]=state[44:80]
  if instruction_tag==0:
   struct.pack_into('<I',expected,188,1);struct.pack_into('<Q',expected,232,t)
   if mutation=='wrong-init-recipient':struct.pack_into('<I',expected,188,0)
   elif mutation=='wrong-init-authority':struct.pack_into('<I',expected,240,1)
  else:
   struct.pack_into('<I',expected,188,2);expected[192:228]=state[8:44]
   struct.pack_into('<Q',expected,232,q-c);struct.pack_into('<I',expected,240,1)
   if mutation=='wrong-source-role':struct.pack_into('<I',expected,140,3)
   elif mutation=='wrong-recipient-kind':struct.pack_into('<I',expected,188,0)
   elif mutation=='short-memory-clear':expected[352:360]=b'\xff'*8
 return ctx+state+instruction+expected,expected,error
p=subprocess.Popen([str(runner)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def ask(req):
 p.stdin.write(json.dumps(req)+'\n');p.stdin.flush();line=p.stdout.readline()
 if not line:raise RuntimeError('runner ended')
 value=json.loads(line)
 if not value['success']:raise RuntimeError(value)
 return value['value']
rows=[]
try:
 keys={}
 for i,(name,program) in enumerate(programs.items()):
  key=ask({'op':'key','seed':191+i});ask({'op':'load','program':key,'elf':str(program)});keys[name]=key
 def send(name,args,mutation=None):
  data,expected,error=buffers(args,mutation);result=ask({'op':'send','instructions':[{'program':keys[name],'accounts':[],'data':list(data)}]})
  return result,hashlib.sha256(expected).hexdigest(),error
 for args in cases:
  result,expected,error=send('baseline',args)
  if not result['ok']:raise RuntimeError(('baseline',args,error,result))
  rows.append({'kind':'baseline','input':args,'expectedSha256':expected,'error':error,'result':result})
 for name in list(changes)[1:]:
  args=(0,2,3,mask,0,1,-1,1,1) if name.startswith('small-') else (0,1,2,100,0,1,-1,0,0) if name.startswith('wrong-init-') else (0,1,2,100,0,1,-1,1,1)
  for kind,mutation,ok in [('fault',None,False),('mutant-model',name,True)]:
   result,expected,error=send(name,args,mutation)
   if result['ok']!=ok or (not ok and result.get('code')!=42):raise RuntimeError((name,kind,result))
   rows.append({'kind':kind,'name':name,'input':args,'expectedSha256':expected,'error':error,'result':result})
finally:p.stdin.close();rc=p.wait(timeout=10);stderr=p.stderr.read()
if rc or stderr:raise RuntimeError((rc,stderr))
report={'passed':True,'exploratory':True,'endToEndVerified':False,'baselineCases':len(cases),'smallRouteCases':small_count,'executions':len(rows),'rows':rows,'artifacts':artifacts,'inputHashes':{str(p):sha(p) for p in [Path(__file__),elf,repo/'verification/sbf_elf.py',clang,ld,readelf,runner,repo/'runtime/sbf.ld']},'scope':'Whole original native handler for canonical Empty/Live and Initialize/Claim inputs and arithmetic helpers execute with original relative calls and recreated checked sol_memset_ relocation. Full360-byte output compared against independent expected state/effects/rejection bytes, including dirty-buffer clearing. Native ABI and valid input values supplied by wrapper; not original program entry/account adapter/transaction commit or formal whole-handler proof.'}
file=run/'report.json';file.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(file),'baselineCases':len(cases),'smallRouteCases':small_count,'executions':len(rows)}))
