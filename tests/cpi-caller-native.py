"""Actual generated ABI2 entrypoint replay with explicit clock/PDA/CPI test doubles."""
from pathlib import Path
import sys,json,hashlib,subprocess,os
sys.path.insert(0,'verification');import multi_adapter_contract as m
assert __debug__
input_path,profile_path,bad_path,root=map(Path,sys.argv[1:]);root.mkdir(parents=True,exist_ok=True);paths=[input_path,profile_path,bad_path,Path(__file__)]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest();inputs={str(p):sha(p) for p in paths}
fixtures=json.loads(paths[0].read_text())['fixtures'];good=json.loads(paths[1].read_text())['rows'];bad=json.loads(paths[2].read_text())['rows'];rows=[]
for f in fixtures:
 summary=m.summarize(f['schema'],f['interface']);folder=root/'full-native'/f['name'];folder.mkdir(parents=True,exist_ok=True)
 for n,s in f['files'].items():assert Path(n).name==n;(folder/n).write_text(s)
 goodbytes=next(x['bytes'] for x in good if x['fixture']==f['name']);badbytes=next(x['bytes'] for x in bad if x['fixture']==f['name'])
 for mutant in (False,True):
  adapter=f['files'][f['adapter']];old='bend_invoke_validate(&transfers[i],accounts,(unsigned)count)';assert adapter.count(old)==1
  if mutant:adapter=adapter.replace(old,'bend_invoke_validate(&transfers[0],accounts,(unsigned)count)')
  code=adapter+'''
static unsigned calls,returned;
u64 sol_try_find_program_address(const BendSeed *s,int n,const u8 *program,u8 *key,u8 *bump) { if(n!=2 || s[0].length!=4 || s[1].length!=32 || program[0]!=100) return 1; for(unsigned j=0;j<32;j++)key[j]=j?0:4;*bump=0;return 0; }
u64 sol_get_clock_sysvar(void *p) { *(BendClock*)p=(BendClock){0}; return 0; }
u64 sol_invoke_signed_c(const BendInstruction *ix,const BendAccountInfo *a,int n,const BendSeeds *s,int ns) { if(n!=12 || ix->count!=1 || ix->length!=1 || ix->program[0]!=3 || ix->accounts[0].key[0]!=12) return 99; calls++;return 0; }
void sol_set_return_data(const u8 *p,u64 n) { returned++; }
static u64 raw[20000],saved[20000];
int main(void) {
'''
  code+='const u8 good[]={'+','.join(map(str,goodbytes))+'};\nconst u8 bad[]={'+','.join(map(str,badbytes))+'};\n'
  code+='for(unsigned mode=0;mode<2;mode++) for(unsigned invalid=0;invalid<2;invalid++) {\n__builtin_memset(raw,0,sizeof(raw)); u8 *buffer=(u8*)raw; write_le(buffer,12,8); u64 offset=8; u8 *data[12]; calls=returned=0;\n'
  for i in range(12):
   field=next((x for x in summary['fields'] if x['index']==i),None);size=field['stateBytes'] if field else 0
   code+=f'buffer[offset]=255;buffer[offset+1]=1;buffer[offset+2]=1;buffer[offset+3]={int(i==2)};buffer[offset+8]={i+1};buffer[offset+40]=100;write_le(buffer+offset+72,1000,8);write_le(buffer+offset+80,{size},8);data[{i}]=buffer+offset+88;\n'
   if field:
    code+='if(mode){const u8 header[]={'+','.join(map(str,field['header']))+'};'
    code+=f'__builtin_memcpy(data[{i}],header,20);'
    if field['bindingBytes']:code+=f'data[{i}][20]=1;'
    code+='}\n'
   code+=f'offset=(offset+88+{size}+10240+7)&~7ULL;offset+=8;\n'
  code+='write_le(buffer+offset,sizeof(good)+1,8);buffer[offset+8]=mode;__builtin_memcpy(buffer+offset+9,invalid?bad:good,sizeof(good));buffer[offset+9+sizeof(good)]=100;__builtin_memcpy(saved,raw,sizeof(raw));\nu64 result=entrypoint(buffer);\n'
  code+=f'if(invalid && {int(not mutant)}) {{ if(result!=20 || calls || returned || __builtin_memcmp(saved,raw,sizeof(raw))) return 30; }} else {{ if(result || calls!=2 || returned!=1) return 31;\n'
  for i,field in enumerate(summary['fields']):code+=f"if(read_le(data[{field['index']}]+{20+field['bindingBytes']+1},4)!={i+1}) return 32;\n"
  code+='}\n}\nreturn 0;\n}\n'
  path=folder/('wrong-slot.c' if mutant else 'baseline.c');exe=path.with_suffix('.out');path.write_text(code)
  command=[os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-I',str(folder),str(path),'-o',str(exe)]
  c=subprocess.run(command,capture_output=True,text=True,timeout=30);assert c.returncode==0,c.stderr
  e=subprocess.run([str(exe)],capture_output=True,text=True,timeout=5);assert e.returncode==0,(f['name'],mutant,e.returncode,e.stderr)
  rows.append({'fixture':f['name'],'wrongSlotMutation':mutant,'scenarios':4,'exitCode':0,'harnessSha256':sha(path),'executableSha256':sha(exe)});print(f['name'],'mutant' if mutant else 'baseline','passed',flush=True)
assert all(sha(Path(p))==h for p,h in inputs.items())
(root/'full-native-caller.json').write_text(json.dumps({'passed':True,'scope':__doc__+' Tests init/update, valid/invalid later slot, failure before mutation, and wrong-slot validation control. Syscall test doubles do not prove real PDA/CPI behavior or runtime rollback.','rows':rows,'inputs':inputs},indent=2)+'\n')
