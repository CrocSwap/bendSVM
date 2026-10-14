from pathlib import Path
import json,hashlib,subprocess,shutil,uuid
import os,sys
if not __debug__:raise RuntimeError('collection byte assertions required')
sys.path.insert(0,'verification')
from collection_root_report import unchanged,validate
input_path=Path(sys.argv[1]);report_path=Path(sys.argv[2]);output_path=Path(sys.argv[3]);assert not output_path.exists()
raw=input_path.read_bytes();data=json.loads(raw);report_raw=report_path.read_bytes();validate(json.loads(report_raw),data,raw);unchanged(data)
files=data['caller']['artifactPaths'];header=Path(files['collection-store.h']).read_text();wire=Path(files['collection-store.wire.h']).read_text()
p=data['program'];schema=p['artifact']['schema'];assert header==p['artifact']['c']

types={t['name']:t for t in schema['types']};sig=next(e for e in schema['exports'] if e['name']=='select');context,state,ix,meta=[types[n] for n in sig['args']];output=types[sig['result']]
harness=r'''
#include <stdint.h>
#include <stdio.h>
int main(void){
 unsigned checked=0; const uint32_t words[]={0,1,2,0xffffffffu,0x11223344u};
 const uint32_t bounds[][2]={{0,0},{0,2},{1,2},{2,2},{2,3},{3,2},{0xffffffffu,0xffffffffu},{0xfffffffeu,0xffffffffu}};
 for(unsigned tag=0;tag<256;tag++)for(unsigned w=0;w<5;w++)for(unsigned padding=0;padding<2;padding++)for(unsigned n=8;n<=10;n++)for(unsigned b=0;b<8;b++){
  unsigned char bytes[9]={0};bytes[0]=(unsigned char)tag;
  for(unsigned k=0;k<4;k++)bytes[1+k]=(unsigned char)(words[w]>>(8*k));
  bytes[5]=padding?0x80:0;
  bend_Instruction_t instruction={0};int decoded=bend_Instruction_decode(bytes,n,&instruction);
  int wanted=n==9 && tag<3 && (tag==1 || padding==0);
  if((decoded!=0)!=wanted){fprintf(stderr,"decode mismatch\n");return 42;}
  if(decoded){
   CONTEXT context={0};STATE state={0};
   uint32_t length=bounds[b][0],capacity=bounds[b][1];
   uint64_t start=tag==0?length:tag==1?words[w]:0,limit=tag==0?capacity:length;
   int accepted=length<=capacity && start+1<=limit;
   OUTPUT result=bend_select(context,state,instruction,META(length,capacity));
   if((result.tag==1)!=accepted){fprintf(stderr,"selection mismatch\n");return 42;}
   if(accepted&&(result.as.c1.f0.tag!=0||result.as.c1.f0.as.c0.f0!=start||result.as.c1.f0.as.c0.f1!=1)){fprintf(stderr,"range mismatch\n");return 42;}
  }
  checked++;
 }
 printf("%u byte/selector cases passed\n",checked);return 0;
}
'''
for old,new in [('CONTEXT',context['cType']),('STATE',state['cType']),('OUTPUT',output['cType']),('META',meta['variants'][0]['cMaker'])]:harness=harness.replace(old,new)
start=wire.index('static inline int bend_Instruction_decode(');end=wire.index('/* Internal writer:',start);part=wire[start:end];needle='for (unsigned i = 5; i < 9; ++i) if (p[i] != 0) return 0;';assert part.count(needle)==2
at=header.index(' bend_select(');function_start=header.rfind('static ',0,at);function_end=header.index('\n}',at)+2
function=header[function_start:function_end];old=', (a2).as.c1.f0, 1u, 2u)';assert function.count(old)==1
wrong_index=header[:function_start]+function.replace(old,', 0u, 1u, 2u)')+header[function_end:]
variants=[('baseline',header,wire,0,''),('ignored-padding',header,wire[:start]+part.replace(needle,'')+wire[end:],42,'decode mismatch'),('wrong-byte',header,wire.replace('p[3] << 24','p[2] << 24'),42,'range mismatch'),('wrong-index',wrong_index,wire,42,'selection mismatch')]
assert variants[2][2]!=wire
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();rows=[]
compiler=shutil.which(os.environ.get('CC','clang'));assert compiler
run_root=input_path.parent/'native-byte-runs'/str(uuid.uuid4());run_root.mkdir(parents=True)
for label,h,w,code,reason in variants:
 d=run_root/label;d.mkdir(exist_ok=False);(d/'collection-store.h').write_text(h);(d/'collection-store.wire.h').write_text(w);source=d/'main.c';source.write_text('#include "collection-store.wire.h"\n'+harness);exe=d/'run'
 compile=subprocess.run([compiler,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(source),'-o',str(exe)],capture_output=True,text=True,timeout=60);(d/'compile.log').write_text(compile.stdout+compile.stderr);assert compile.returncode==0,compile.stderr
 run=subprocess.run([str(exe)],capture_output=True,text=True,timeout=30);(d/'run.log').write_text(run.stdout+run.stderr);assert run.returncode==code and (reason in run.stderr if reason else run.stderr==''),(label,run)
 if label=='baseline':assert run.stdout=='61440 byte/selector cases passed\n',run.stdout
 rows.append({'label':label,'exitCode':run.returncode,'files':{str(q):sha(q) for q in d.iterdir() if q.is_file()}})
for name,h in p['sourceHashes'].items():assert sha(name)==h
unchanged(data);assert input_path.read_bytes()==raw and report_path.read_bytes()==report_raw
with output_path.open('x') as stream:stream.write(json.dumps({'passed':True,'cases':61440,'compiler':compiler,'compilerSha256':sha(compiler),
 'inputSha256':hashlib.sha256(raw).hexdigest(),'reportSha256':hashlib.sha256(report_raw).hexdigest(),'checkerSha256':sha(__file__),'replays':rows,
 'scope':'Actual native decoder then selector, independent canonical-byte and nonwrapping range oracle; no adapter memory or SBF claim.'},indent=2)+'\n')
print('61440 native byte/selector cases and three faults passed')
