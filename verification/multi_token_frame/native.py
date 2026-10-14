from pathlib import Path
import json,hashlib,re,subprocess,shutil,os,uuid
if not __debug__:raise RuntimeError('assertions required')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
base=Path(__file__).resolve().parent;out=Path(os.environ['TOKEN_FRAME_CHILD']);out.mkdir();print(out,flush=True)
source=Path(os.environ['TOKEN_FRAME_INPUT']);original=json.loads(source.read_text())
fixtures=[f for f in original['fixtures'] if f['name'].startswith('token-')]
for p,h in original['immutableInputs'].items():assert sha(p)==h,p
snapshot=out/'input.json';snapshot.write_text(json.dumps({'fixtures':fixtures,'immutableInputs':original['immutableInputs'],'originalSha256':sha(source)},indent=2)+'\n')
template=base/'pending-native.c';text=template.read_text().replace('CHECK(a[i].data==bytes[i]);watch_range(a[i].data,a[i].data_len);','watch_range(a[i].data,a[i].data_len);CHECK(a[i].data==bytes[i]);')
cc=shutil.which(os.environ.get('CC','clang'));assert cc
inputs={str(p.resolve()):sha(p) for p in [Path(__file__),template,snapshot,Path(cc)]}
version=subprocess.run([cc,'--version'],capture_output=True,text=True,check=True);(out/'compiler.log').write_text(version.stdout+version.stderr)
rows=[]
for fixture in fixtures:
 n=int(fixture['name'][-1]);adapter=fixture['files'][fixture['adapter']]
 headers=re.findall(r'const u8 header\d\[20\]=(\{[^}]+\});',adapter);assert len(headers)==n
 anchor='  for(unsigned i=0;i<2;++i) if(bend_transfer_execute(&transfers[i],accounts,(unsigned)count,bump)) return 18;';assert adapter.count(anchor)==1
 watches='  watches=0;'+''.join('watch_add('+p+',sizeof '+p+');' for p in ['reply',*[f'encoded{i}' for i in range(n)],'transfers','outcome','accounts'])+'\n'
 # Outcome is an object; arrays decay, the object needs its address.
 watches=watches.replace('watch_add(outcome,','watch_add(&outcome,')
 instrumented=adapter.replace(anchor,watches+'  for(unsigned i=0;i<2;++i) { u64 error=bend_transfer_execute(&transfers[i],accounts,(unsigned)count,bump); watch_check(); if(error) return 18; }')
 harness=text.replace('ADAPTER',fixture['adapter']).replace('HEADER_SETUP','const u8 headers[N][20]={'+','.join(headers)+'};')
 for variant in ['baseline','exposed-pending','helper-write']:
  run=out/(fixture['name']+'-'+variant);run.mkdir()
  for name,contents in fixture['files'].items():(run/name).write_text(contents)
  (run/fixture['adapter']).write_text(instrumented);(run/'native.c').write_text(harness)
  token=(run/'token.h').read_text();needle='  return sol_invoke_signed_c(&ix,infos,(int)count,&signer,t->authority ? 1 : 0);';assert token.count(needle)==1
  if variant=='exposed-pending':token=token.replace(needle,'  infos[0].data=(u8 *)watched[0];\n'+needle)
  if variant=='helper-write':token=token.replace(needle,'  ((BendTransfer *)t)->amount ^= 1;\n'+needle)
  (run/'token.h').write_text(token)
  binary=run/'native';args=[cc,'-std=c11','-O1','-g','-fsanitize=address,undefined','-fno-sanitize-recover=all','-DN='+str(n),'-I'+str(run),str(run/'native.c'),'-o',str(binary)]
  build=subprocess.run(args,capture_output=True,text=True,timeout=60);(run/'build.log').write_text(build.stdout+build.stderr);assert build.returncode==0,build.stderr
  result=subprocess.run([str(binary.resolve())],capture_output=True,text=True,timeout=30);(run/'run.log').write_text(result.stdout+result.stderr)
  if variant=='baseline':assert result.returncode==0 and result.stdout.count('case ')==12 and '12 native pending sequences passed' in result.stdout,result.stderr
  else:
   reason='pending range exposed' if variant=='exposed-pending' else 'pending bytes changed'
   assert result.returncode==43 and reason in result.stderr,(variant,result.returncode,result.stderr)
  rows.append({'fixture':fixture['name'],'variant':variant,'exitCode':result.returncode,'binarySha256':sha(binary),'logSha256':sha(run/'run.log'),'files':{p.name:sha(p) for p in run.iterdir() if p.is_file()},'command':args})
  print(fixture['name']+' '+variant+' passed',flush=True)
for p,h in inputs.items():assert sha(p)==h,p
report={'passed':True,'cases':36,'controls':6,'runs':rows,'inputHashes':inputs,'scope':'Native ASan/UBSan executions of instrumented emitted ABI2 adapters with actual token validator/executor, codecs and root. Syscalls are stubbed; arbitrary token balance/delegate writes and failures exercise pending buffer isolation and delayed managed-state commit. No SPL semantics, VM frame enforcement or transaction rollback claim.'}
(out/'report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(out/'report.json')}))
