"""Native CPI custody cases under sanitizers with a checking PDA syscall double."""
if not __debug__:raise RuntimeError('assertions required')
from pathlib import Path
import subprocess,hashlib,json,os,sys
root=Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
headers=['bend_cpi.h','cpi_abi.h','solana_min.h']
inputs={str(Path('runtime',n)):hashlib.sha256(Path('runtime',n).read_bytes()).hexdigest() for n in headers}
inputs[__file__]=hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
for n in headers:(root/n).write_bytes(Path('runtime',n).read_bytes())
source=(root/'bend_cpi.h').read_text()
harness=r'''
#include "bend_cpi.h"
static u8 root_key[32], program_key[32], derived[32];
static u64 pda_result; static unsigned calls,bad_args;
u64 sol_try_find_program_address(const BendSeed *seeds,int n,const u8 *program,u8 *key,u8 *bump) {
 calls++;
 if(n!=2 || seeds[0].length!=4 || seeds[1].length!=32 ||
    __builtin_memcmp(seeds[0].address,"bend",4) ||
    __builtin_memcmp(seeds[1].address,root_key,32) ||
    __builtin_memcmp(program,program_key,32)) {bad_args++;return 99;}
 if(pda_result)return pda_result;
 __builtin_memcpy(key,derived,32);*bump=217;return 0;
}
int main(void) {
 u8 keys[12][32]={{0}};Account a[12]={{0}};
 for(unsigned i=0;i<32;i++){root_key[i]=(u8)(i*3+1);program_key[i]=(u8)(i*7+5);derived[i]=(u8)(i*11+9);}
 for(unsigned i=0;i<12;i++){keys[i][0]=(u8)i;a[i].key=keys[i];}
 __builtin_memcpy(keys[0],root_key,32);
 for(unsigned scenario=0;scenario<5;scenario++) {
  __builtin_memcpy(keys[3],derived,32);calls=bad_args=0;pda_result=0;u8 bump=0;
  if(scenario==1)pda_result=1;
  if(scenario==2)pda_result=1ULL<<63;
  if(scenario==3)keys[3][31]^=1;
  if(scenario==4)keys[3][0]^=1;
  u64 result=bend_invoke_custody(a,program_key,&bump);
  if(calls!=1 || bad_args)return 40;
  if(result!=(scenario?11:0))return 41;
  if(!scenario && bump!=217)return 42;
 }
 return 0;
}
'''
(root/'harness.c').write_text(harness);rows=[]
for name,old,new,expected in [('baseline',None,None,0),('wrong-seed-account','{a[0].key,32}','{a[1].key,32}',40),('truncated-key-equality','equal_key(key,a[3].key)','(key[0]==a[3].key[0])',41)]:
 text=source
 if old:
  start=text.index('static inline u64 bend_invoke_custody(');end=text.index('\n}',start)+2
  body=text[start:end];assert body.count(old)==1
  text=text[:start]+body.replace(old,new)+text[end:]
 (root/'bend_cpi.h').write_text(text)
 exe=root/name
 compile_=subprocess.run([os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-I',str(root),str(root/'harness.c'),'-o',str(exe)],capture_output=True,text=True,timeout=30)
 if compile_.returncode:raise RuntimeError(compile_.stderr)
 result=subprocess.run([str(exe)],capture_output=True,text=True,timeout=5)
 if result.returncode!=expected:raise RuntimeError((name,result.returncode,result.stderr))
 rows.append({'name':name,'exitCode':result.returncode,'expectedExitCode':expected,'executableSha256':hashlib.sha256(exe.read_bytes()).hexdigest(),'headerSha256':hashlib.sha256(text.encode()).hexdigest()})
 (root/(name+'.header')).write_text(text)
(root/'bend_cpi.h').write_text(source)
for path,h in inputs.items():assert hashlib.sha256(Path(path).read_bytes()).hexdigest()==h
report={'passed':True,'scope':__doc__+' Five baseline scenarios plus two faulty-source controls. No real PDA derivation, caller composition, SBF execution or runtime rollback claim.','baselineScenarios':5,'rows':rows,'inputs':inputs,'harnessSha256':hashlib.sha256((root/'harness.c').read_bytes()).hexdigest()}
(root/'report.json').write_text(json.dumps(report,indent=2)+'\n');print('Five native custody scenarios and two faulty-source controls passed')
