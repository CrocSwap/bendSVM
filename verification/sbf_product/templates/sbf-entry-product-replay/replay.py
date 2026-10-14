import os
"""Instrumented VM checkpoint replay with every operand-cone instruction intact."""
from pathlib import Path
import hashlib,importlib.util,json,random,struct,subprocess
if not __debug__:raise RuntimeError('assertions required')
base=Path(__file__).resolve().parent;root=base.parents[1]
spec=importlib.util.spec_from_file_location('paths',root/'build/sbf-operand-probe/paths.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
proof=json.loads((root/'build/sbf-operand-probe/paths-report.json').read_text())
for p,h in proof['inputHashes'].items():
 if sha(Path(p))!=h:raise RuntimeError('proof input drift '+p)
m.stop=0x2248
ins,succ,cone=m.graph(m.text);tools=Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin')));clang=tools/'clang';ld=tools/'ld.lld';runner=root/'target/debug/bend-test-runner'
files=[Path(__file__).resolve().parents[2]/'verification/sbf_elf.py',Path(__file__).resolve().parents[2]/'verification/sbf_paths.py',Path(__file__).resolve().parents[2]/'verification/sbf_cfg.py',Path(__file__).resolve().parents[2]/'verification/sbf_machine.py',Path(__file__),root/'build/sbf-operand-probe/paths.py',root/'build/sbf-operand-probe/paths-report.json',m.elf,clang,ld,runner,root/'runtime/sbf.ld'];bindings={str(p):sha(p) for p in files}
I=lambda op,d=0,s=0,off=0,imm=0:struct.pack('<BBhi',op,(s<<4)|d,off,imm)
artifacts={};binaries={}
for name,mutated in [('baseline',False),('wrong-total-limb',True),('subtract-high-product',True),('inverted-denominator',True)]:
 pre=[I(0x7b,10,1,-1024),I(0xbf,2,1),I(0x07,2,imm=16),I(0xbf,3,2),I(0x07,3,imm=56),I(0xbf,4,3),I(0x07,4,imm=128),I(0xbf,1,10),I(0x07,1,imm=-2048),I(0x05)]
 n=len(m.text)//8;code=pre+[I(0x05) for _ in range(n)];offset=len(pre)
 pre_entry=offset+(m.entry-m.address)//8;code[len(pre)-1]=I(0x05,off=pre_entry-len(pre))
 # The entire original address span is retained, but non-cone slots trap.
 for at in cone-{m.stop}:
  index=offset+(at-m.address)//8;body=m.text[at-m.address:at-m.address+8]
  if name=='wrong-total-limb' and at==0x17a0:
   b=bytearray(body);struct.pack_into('<h',b,2,0x58);body=bytes(b)
  if name=='subtract-high-product' and at==0x2218:body=bytes([0x1f])+body[1:]
  if name=='inverted-denominator' and at==0x2200:body=bytes([0x55])+body[1:]
  code[index]=body
 checkpoint=len(code);code += [I(0x7b,10,8,-1040),I(0x7b,10,1,-1048),I(0x79,2,10,-0x180),I(0x67,2,imm=32),I(0x77,2,imm=32),I(0x7b,10,2,-1056),I(0x79,2,10,-1024)];checks=[]
 for index,slot in enumerate([-1040,-1048,-1056,-0x150]):
  code += [I(0x79,0,10,slot),I(0x79,1,2,208+index*8)];checks.append(len(code));code.append(I(0x5d,0,1))
 code += [I(0xb7,0),I(0x95)];failure=len(code);code += [I(0xb7,0,imm=42),I(0x95)]
 for index in checks:code[index]=I(0x5d,0,1,off=failure-index-1)
 for i in range(n):
  at=m.address+8*i;index=offset+i
  if at==m.stop:code[index]=I(0x05,off=checkpoint-index-1)
  elif at not in cone:code[index]=I(0x05,off=failure-index-1)
 raw=b''.join(code);assembly=base/(name+'.s');obj=base/(name+'.o');elf=base/(name+'.so')
 assembly.write_text('.text\n.globl entrypoint\n.type entrypoint,@function\n.p2align 3\nentrypoint:\n'+''.join('.byte '+','.join(str(x) for x in raw[i:i+16])+'\n' for i in range(0,len(raw),16))+'.size entrypoint, .-entrypoint\n')
 commands=[[str(clang),'--target=sbf','-mcpu=generic','-c',str(assembly),'-o',str(obj)],[str(ld),'-z','notext','-shared','--Bdynamic',str(root/'runtime/sbf.ld'),'--entry','entrypoint','-z','max-page-size=4096','--gc-sections',str(obj),'-o',str(elf)]]
 logs=[]
 for command in commands:
  p=subprocess.run(command,capture_output=True,text=True,timeout=30);logs.append(p.stdout+p.stderr)
  if p.returncode:raise RuntimeError(p.stderr)
 log=base/(name+'.build.log');log.write_text(''.join(logs));_,actual=m.m.text_section(elf.read_bytes())
 if actual!=raw:raise RuntimeError('assembled text differs')
 for at in cone-{m.stop}:
  if (name,at) in [('wrong-total-limb',0x17a0),('subtract-high-product',0x2218),('inverted-denominator',0x2200)]:continue
  i=offset*8+at-m.address
  if actual[i:i+8]!=m.text[at-m.address:at-m.address+8]:raise RuntimeError('cone bytes differ')
 artifacts[name]={'commands':commands,'files':{str(p):sha(p) for p in [assembly,obj,elf,log]},'unchangedConeInstructions':len(cone)-1-int(mutated)};binaries[name]=elf
mask=(1<<64)-1

def payload(start,now,end,total,wrong=False,witness=None):
 ctx=bytearray(56);state=bytearray(128);instruction=bytearray(8)
 if witness:
  for key,value in witness.items():
   region,at=key.rsplit('_',1);buf={'context':ctx,'state':state,'instruction':instruction}[region];struct.pack_into('<I',buf,int(at),value)
 else:
  struct.pack_into('<I',state,0,1);struct.pack_into('<I',instruction,0,1)
  struct.pack_into('<I',ctx,40,1)
  for buf,at,val in [(ctx,48,now),(state,84,total),(state,96,start),(state,108,end)]:struct.pack_into('<Q',buf,at,val)
 elapsed=(now-start)&mask
 effective_total=((total>>32)<<32)|(total>>32) if wrong=='wrong-total-limb' else total
 product=elapsed*effective_total
 wanted=[(product>>96)&0xffffffff,(product>>64)&0xffffffff,(product>>32)&0xffffffff,(elapsed&0xffffffff)*(effective_total&0xffffffff)]
 if wrong=='subtract-high-product':wanted[0]=(wanted[0]-2*(((elapsed>>32)*(total>>32))>>32))&mask
 return list(ctx+state+instruction+struct.pack('<4Q',*wanted))
p=subprocess.Popen([str(runner)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
def ask(v):
 p.stdin.write(json.dumps(v)+'\n');p.stdin.flush();line=p.stdout.readline()
 if not line:raise RuntimeError('runner ended')
 r=json.loads(line)
 if not r['success']:raise RuntimeError(r)
 return r['value']
rows=[];addresses={}
try:
 for i,(name,elf) in enumerate(binaries.items()):
  a=ask({'op':'key','seed':47+i});ask({'op':'load','program':a,'elf':str(elf)});addresses[name]=a
 def send(name,data):return ask({'op':'send','instructions':[{'program':addresses[name],'accounts':[],'data':data}]})
 cases=[(0,2**63,mask,mask),(0,1,2,mask),(2**32-1,2**32,2**32+1,2**32+7),(mask-2,mask-1,mask,mask)]
 rng=random.Random(15073)
 for _ in range(64):
  times=sorted(rng.sample(range(0,2**63-1),3));cases.append((times[0],times[1],times[2],rng.getrandbits(64)))
 for a in cases:
  r=send('baseline',payload(*a))
  if not r['ok']:raise RuntimeError((a,r))
  rows.append({'kind':'baseline','values':a,'result':r})
 w=proof['wrongTotalLimb']['witness'];pack=lambda reg,at:w[reg+'_'+str(at)]+(w[reg+'_'+str(at+4)]<<32)
 a=(pack('state',96),pack('context',48),pack('state',108),pack('state',84))
 for name,wrong,ok in [('baseline',False,True),('wrong-total-limb',False,False),('wrong-total-limb','wrong-total-limb',True)]:
  r=send(name,payload(*a,wrong=wrong,witness=w))
  if r['ok']!=ok or not ok and r.get('code')!=42:raise RuntimeError(r)
  rows.append({'kind':'counterexample','program':name,'predictedFaultOutput':wrong,'values':a,'result':r})
 a=(0,2**63,mask,mask)
 for name,wrong,ok in [('baseline',False,True),('subtract-high-product',False,False),('subtract-high-product','subtract-high-product',True),('inverted-denominator',False,False)]:
  r=send(name,payload(*a,wrong=wrong))
  if r['ok']!=ok or not ok and r.get('code')!=42:raise RuntimeError((name,r))
  rows.append({'kind':'tail-fault','program':name,'predictedFaultOutput':wrong,'values':a,'result':r})
 for a in [(10,10,20,100),(10,20,20,100),(10,9,20,100)]:
  r=send('baseline',payload(*a))
  if r['ok'] or r.get('code')!=42:raise RuntimeError(r)
  rows.append({'kind':'outside-cone','values':a,'result':r})
finally:
 p.stdin.close();rc=p.wait(timeout=10);stderr=p.stderr.read()
if rc or stderr:raise RuntimeError((rc,stderr))
if bindings!={str(p):sha(p) for p in files}:raise RuntimeError('input drift')
out={'passed':True,'exploratory':True,'endToEndVerified':False,'inputHashes':bindings,'artifacts':artifacts,'baselineCases':len(cases),'executions':len(rows),'rows':rows,'scope':'Instrumented native-entry to pre-division checkpoint:251 original instructions preserved across operand preparation and98instruction product block. Checks actual high/middle product registers and low partial-product spill against Python full64x64 multiplication. Off-cone routes trap42; native ABI pointers supplied by harness. Not original whole-handler execution or proof of division/result commit.'}
(base/'replay-report.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'passed':True,'baselineCases':len(cases),'executions':len(rows)}))
