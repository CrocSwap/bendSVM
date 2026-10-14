"""Real SBF calls to exact div4 bytes, checked against independent integer steps."""
from pathlib import Path
import hashlib,json,os,random,re,struct,subprocess,sys,uuid
repo=Path(__file__).resolve().parents[2];base=Path(__file__).resolve().parent;run=base/'div4-replays'/str(uuid.uuid4());run.mkdir(parents=True)
sys.path.insert(0,str(repo/'verification'));from sbf_elf import text_section
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
source=repo/'build/sbf-slice-probe/vesting.so';address,text=text_section(source.read_bytes());original=text[0x5c50-address:0x6398-address]
tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')));clang=tools/'clang';ld=tools/'ld.lld';runner=repo/'target/debug/bend-test-runner'
header=repo/'build/vesting.h';ctype=re.search(r'} (\w+DivState_t);',header.read_text()).group(1)
fields=[('tag',0)]
for i in range(3):fields += [(f'as.c0.f{i}.tag',4+12*i),(f'as.c0.f{i}.as.c0.f0',8+12*i),(f'as.c0.f{i}.as.c0.f1',12+12*i)]
c=run/'layout.c';c.write_text('#include "vesting.h"\n'+f'_Static_assert(sizeof({ctype})==40,"size");\n'+''.join(f'_Static_assert(__builtin_offsetof({ctype},{field})=={offset},"{field}");\n' for field,offset in fields))
p=subprocess.run([str(clang),'--target=sbf','-mcpu=generic','-I'+str(repo/'build'),'-fsyntax-only',str(c)],capture_output=True,text=True,timeout=30);(run/'layout.log').write_text(p.stdout+p.stderr)
if p.returncode:raise RuntimeError(p.stderr)
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
artifacts={};programs={}
for name in ['baseline','clear-last-quotient-bit']:
 body=bytearray(original)
 if name!='baseline':body[0x6300-0x5c50]=0x57
 code=[I(0x7b,10,1,-256),I(0xbf,2,1),I(0x07,2,imm=16),I(0xbf,1,10),I(0x07,1,imm=-128),I(0x85,s=1),I(0x79,6,10,-256)]
 branches=[]
 for k in range(10):
  code.extend([I(0x61,0,10,-128+4*k),I(0x61,1,6,56+4*k)]);branches.append(len(code));code.append(I(0x5d,0,1))
 code += [I(0xb7,0),I(0x95)];failure=len(code);code += [I(0xb7,0,imm=42),I(0x95)]
 for k in branches:code[k]=I(0x5d,0,1,off=failure-k-1)
 code[5]=I(0x85,s=1,imm=len(code)-6);prefix=b''.join(code);program=prefix+bytes(body)
 asm=run/(name+'.s');obj=run/(name+'.o');elf=run/(name+'.so')
 byte_lines=lambda data:''.join('.byte '+','.join(map(str,data[i:i+16]))+'\n' for i in range(0,len(data),16))
 asm.write_text('.text\n.globl entrypoint\n.type entrypoint,@function\n.p2align 3\nentrypoint:\n'+byte_lines(prefix)+'.size entrypoint,.-entrypoint\n.type leaf4,@function\nleaf4:\n'+byte_lines(body)+'.size leaf4,.-leaf4\n')
 logs=[]
 for command in [[str(clang),'--target=sbf','-mcpu=generic','-c',str(asm),'-o',str(obj)],[str(ld),'-z','notext','-shared','--Bdynamic',str(repo/'runtime/sbf.ld'),'--entry','entrypoint','-z','max-page-size=4096','--gc-sections',str(obj),'-o',str(elf)]]:
  p=subprocess.run(command,capture_output=True,text=True,timeout=30);logs.append(p.stdout+p.stderr)
  if p.returncode:raise RuntimeError(p.stderr)
 log=run/(name+'.log');log.write_text(''.join(logs));_,actual=text_section(elf.read_bytes())
 if actual!=program or actual[len(prefix):]!=bytes(body):raise RuntimeError('assembled body mismatch')
 programs[name]=elf;artifacts[name]={'bodyOffset':len(prefix),'bodyBytes':len(body),'bodySha256':hashlib.sha256(body).hexdigest(),'files':{str(p):sha(p) for p in [asm,obj,elf,log]}}
mask=2**64-1
def reference(q,r,d,fault=False):
 for i in range(4):
  carry=r>>63;shift=((r<<1)|(q>>63))&mask;take=bool(carry or shift>=d)
  q=(q<<1)&mask
  if take:
   r=(shift-d)&mask;q|=1
   if fault and i==3:q &= 0xffffffff00000000
  else:r=shift
 return q,r,d
pack=lambda q,r,d:struct.pack('<10I',0,0,q&0xffffffff,q>>32,0,r&0xffffffff,r>>32,0,d&0xffffffff,d>>32)
p=subprocess.Popen([str(runner)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def ask(request):
 p.stdin.write(json.dumps(request)+'\n');p.stdin.flush();line=p.stdout.readline()
 if not line:raise RuntimeError('runner ended')
 value=json.loads(line)
 if not value['success']:raise RuntimeError(value)
 return value['value']
rows=[]
try:
 addresses={}
 for i,(name,elf) in enumerate(programs.items()):
  key=ask({'op':'key','seed':91+i});ask({'op':'load','program':key,'elf':str(elf)});addresses[name]=key
 def send(name,args,want):return ask({'op':'send','instructions':[{'program':addresses[name],'accounts':[],'data':list(pack(*args)+pack(*want))}]})
 cases=[(0,0,0),(mask,mask,mask),(mask,0,1),(1,1,0),(0,1<<63,mask),(1<<63,0,1<<32)]
 rng=random.Random(4040);cases += [tuple(rng.getrandbits(64) for _ in range(3)) for _ in range(64)]
 for args in cases:
  result=send('baseline',args,reference(*args))
  if not result['ok']:raise RuntimeError((args,result))
  rows.append({'kind':'baseline','input':args,'result':result})
 args=(mask,0,1)
 for fault,ok in [(False,False),(True,True)]:
  result=send('clear-last-quotient-bit',args,reference(*args,fault=fault))
  if result['ok']!=ok or not ok and result.get('code')!=42:raise RuntimeError(result)
  rows.append({'kind':'mutant-model' if fault else 'mutant-spec','input':args,'result':result})
 wrong=list(reference(*args));wrong[1]^=1;result=send('baseline',args,wrong)
 if result['ok'] or result.get('code')!=42:raise RuntimeError('bad oracle accepted')
 rows.append({'kind':'wrong-expected','result':result})
finally:
 p.stdin.close();rc=p.wait(timeout=10);stderr=p.stderr.read()
if rc or stderr:raise RuntimeError((rc,stderr))
files=[Path(__file__),source,header,repo/'verification/sbf_elf.py',clang,ld,runner,repo/'runtime/sbf.ld',c,run/'layout.log']
report={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':{str(p):sha(p) for p in files},'artifacts':artifacts,'baselineCases':len(cases),'executions':len(rows),'rows':rows,'scope':'Actual SBF call/return to copied div4 leaf bytes including final EXIT; complete40byte result compared with independent Python four-step arithmetic. Target C field layout checked. One actual opcode fault refuses specification and accepts independent mutant prediction. Not original whole-handler execution or source/caller/div16 equivalence.'}
(run/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'runRoot':str(run),'baselineCases':len(cases),'executions':len(rows)}))
