from pathlib import Path
import hashlib,json,re,subprocess,shutil,os,uuid
base=Path('build/issuance-pending');root=base/'runs'/str(uuid.uuid4());root.mkdir(parents=True)
latest=base/'fresh-receipt.json'
if latest.exists():latest.rename(root/'previous.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def main():
 if not __debug__:raise RuntimeError('assertions required')
 explicit=os.environ.get('ISSUANCE_NATIVE_INPUT')
 if explicit:input_file=Path(explicit)
 else:
  receipt=json.loads(Path('build/issuance-adapter/fresh-receipt.json').read_text())
  assert receipt['passed'] is True
  input_file=Path(receipt['inputArtifact']);assert sha(input_file)==receipt['inputSha256']
 fixture=input_file.parent;raw=input_file.read_bytes();data=json.loads(raw)
 for p,h in {**data['sourceHashes'],**data['artifactHashes']}.items():assert sha(p)==h,p
 own_before=sha(Path(__file__));template_before=sha('tests/issuance-adapter-sequence.c')
 assert (fixture/'issuance.c').read_text()==data['fixture']['files']['issuance.c'],'adapter binding'
 adapter=(fixture/'issuance.c').read_text();template=Path('tests/issuance-adapter-sequence.c').read_text();header=re.findall(r'const u8 header\[20\] = (\{[^}]+\});',adapter);assert len(header)==1
 pre=r'''
 #include <stdint.h>
 #include <stddef.h>
 static const unsigned char *watched[4];
 static size_t watched_size[4];
 static unsigned char saved[4][4096];
 static void watch_begin(const void *,size_t,const void *,size_t,const void *,size_t,const void *,size_t);
 static void watch_check(void);
 static void watch_range(const void *,size_t);
 '''
 post=r'''
 static void watch_check(void){
  for(unsigned i=0;i<4;i++)if(memcmp(watched[i],saved[i],watched_size[i])){fputs("pending bytes changed\n",stderr);exit(43);}
 }
 static void watch_range(const void *p,size_t n){
  uintptr_t a=(uintptr_t)p;
  if(n>UINTPTR_MAX-a){fputs("range overflow\n",stderr);exit(43);}
  for(unsigned i=0;i<4;i++){
   uintptr_t b=(uintptr_t)watched[i];
   if(n && watched_size[i] && a<b+watched_size[i] && b<a+n){fputs("pending range exposed\n",stderr);exit(43);}
  }
 }
 static void watch_begin(const void *a,size_t an,const void *b,size_t bn,const void *c,size_t cn,const void *d,size_t dn){
  const void *p[4]={a,b,c,d};size_t n[4]={an,bn,cn,dn};
  for(unsigned i=0;i<4;i++){REQUIRE(n[i]&&n[i]<=4096);watched[i]=p[i];watched_size[i]=n[i];memcpy(saved[i],p[i],n[i]);}
  for(unsigned i=0;i<4;i++)for(unsigned j=i+1;j<4;j++){
   uintptr_t x=(uintptr_t)watched[i],y=(uintptr_t)watched[j];REQUIRE(x+watched_size[i]<=y||y+watched_size[j]<=x);
  }
 }
 '''
 harness=template.replace('#include "issuance.c"',pre+'\n#include "issuance.c"').replace('HEADER_SETUP','const u8 expected_header[20] = '+header[0]+';')
 anchor=' static const unsigned tags[3]';assert harness.count(anchor)==1
 checks=''' watch_check();
  for(int i=0;i<count;i++){watch_range(a[i].data,a[i].data_len);watch_range(a[i].lamports,8);watch_range(a[i].key,32);watch_range(a[i].owner,32);}
  watch_range(ix,sizeof(*ix));watch_range(ix->data,ix->length);watch_range(ix->accounts,ix->count*sizeof(*ix->accounts));watch_range(a,count*sizeof(*a));
  watch_range(ix->program,32);
  for(unsigned i=0;i<ix->count;i++)watch_range(ix->accounts[i].key,32);
  if(signer_count){watch_range(seeds,signer_count*sizeof(*seeds));for(int i=0;i<signer_count;i++){watch_range(seeds[i].seeds,seeds[i].count*sizeof(*seeds[i].seeds));for(unsigned j=0;j<seeds[i].count;j++)watch_range(seeds[i].seeds[j].address,seeds[i].seeds[j].length);}}
 '''
 harness=harness.replace(anchor,checks+anchor).replace(' if(corrupt_frame&&calls==1)', ' watch_check();\n if(corrupt_frame&&calls==1)')+post
 anchor='  for (unsigned i = 0; i < 3; ++i) {\n    if (bend_transfer_execute';assert adapter.count(anchor)==1
 instrumented=adapter.replace(anchor,'  watch_begin(encoded,sizeof encoded,transfers,sizeof transfers,&outcome,sizeof outcome,accounts,sizeof accounts);\n'+anchor)
 cc=shutil.which(os.environ.get('CC','clang'));assert cc is not None,'host C compiler'
 cc_before=sha(cc)
 version=subprocess.run([cc,'--version'],capture_output=True,text=True,timeout=10);assert version.returncode==0 and version.stdout.strip()
 (root/'compiler.log').write_text(version.stdout+version.stderr)
 rows=[]
 for label in ['baseline','exposed-pending','helper-write']:
  run=root/label;run.mkdir(exist_ok=True)
  for name,contents in data['fixture']['files'].items():(run/name).write_text(contents)
  (run/'issuance.c').write_text(instrumented);(run/'native.c').write_text(harness)
  token=(run/'token.h').read_text();needle='  return sol_invoke_signed_c(&ix,infos,(int)count,&signer,t->authority ? 1 : 0);';assert token.count(needle)==1
  if label=='exposed-pending':token=token.replace(needle,'  infos[4].data=(u8 *)watched[0];\n'+needle)
  if label=='helper-write':token=token.replace(needle,'  ((BendTransfer *)t)->amount ^= 1;\n'+needle)
  (run/'token.h').write_text(token)
  args=[cc,'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-I'+str(run),str(run/'native.c'),'-o',str(run/'native')]
  p=subprocess.run(args,capture_output=True,text=True,timeout=120);(run/'compile.log').write_text(p.stdout+p.stderr);assert p.returncode==0,p.stderr
  p=subprocess.run([str(run/'native')],capture_output=True,text=True,timeout=20);(run/'run.log').write_text(p.stdout+p.stderr)
  assert p.returncode==(0 if label=='baseline' else 43),(label,p.returncode,p.stderr)
  if label=='baseline':
   assert len(p.stdout.splitlines())==17 and p.stdout.splitlines()[-1]=='16 adapter sequences passed' and not p.stderr
   cases=[json.loads(line) for line in p.stdout.splitlines()[:-1]]
   expected=[{'initialize':i,'wide':w,'failAt':f,'calls':f or 3,'result':18 if f else 0,'returns':0 if f else 1,'counter':(0 if i else 0xffffffff) if f else (1 if i else 0)} for i in range(2) for w in range(2) for f in range(4)]
   assert cases==expected,'case oracle'
  else:assert p.stderr==('pending range exposed\n' if label=='exposed-pending' else 'pending bytes changed\n')
  rows.append({'name':label,'exitCode':p.returncode,'files':{str(p):sha(p) for p in run.iterdir() if p.is_file()}})
 for p,h in {**data['sourceHashes'],**data['artifactHashes']}.items():assert sha(p)==h,p
 assert input_file.read_bytes()==raw
 assert sha(Path(__file__))==own_before and sha('tests/issuance-adapter-sequence.c')==template_before
 assert sha(cc)==cc_before,'compiler drift'
 report={'passed':True,'endToEndVerified':False,'input':str(input_file),'sourceHashes':{**data['sourceHashes'],**data['artifactHashes']},'compiler':{'path':cc,'sha256':cc_before,'version':version.stdout},'cases':cases,'inputSha256':sha(input_file),'checkerSha256':sha(Path(__file__)),'templateSha256':sha('tests/issuance-adapter-sequence.c'),'runs':rows,'scope':'Instrumented host-C observer checks encoded state, extracted effects, outcome and account descriptors remain disjoint from exposed syscall pointers and unchanged across framed stubs in16cases. Instrumentation changes layout; not uninstrumented/SBF memory isolation or runtime frame proof.'}
 (root/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 pending=root/'publish.json';pending.write_bytes((root/'report.json').read_bytes());pending.replace(latest)
 print('16 pending-buffer sequences and two precise faults passed')

try:main()
except BaseException as error:
 (root/'failure.json').write_text(json.dumps({'passed':False,'error':str(error)},indent=2)+'\n');raise
