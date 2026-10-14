"""Replay parsed-validator interference snapshots through the real C helper."""
import pathlib,json,subprocess,os,hashlib,uuid
if not __debug__:raise RuntimeError("assertions required")
base=pathlib.Path('build/token-sequence-native');base.mkdir(parents=True,exist_ok=True)
run_id=str(uuid.uuid4());root=base/'runs'/run_id;root.mkdir(parents=True)
output=base/'fresh-receipt.json'
if output.exists():output.rename(root/'previous.json')
rp=pathlib.Path('build/token-frame-refinement.json');raw=rp.read_bytes();report=json.loads(raw)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
checker_sha=sha(pathlib.Path(__file__))
for name,h in report['inputs'].items():assert sha(pathlib.Path(name))==h
blocks=[];expected=[]
for n,row in enumerate(report['mutablePredicates']):
 w=row['witness'];expected.extend([0,0,0,0]);lines=[f'static void case_{n}(void) {{','Account a[7]={0}; BendTransfer t={0}; u8 keys[7][32]={0},owners[7][32]={0},data[7][165]={0};']
 for i,account in enumerate(w['accounts']):
  assert account['size']<=165,('native backing size',i,account['size'])
  lines.append(f'a[{i}].key=keys[{i}];a[{i}].owner=owners[{i}];a[{i}].data=data[{i}];')
  for key in ['size','signer','writable','executable']:lines.append(f'a[{i}].{key}={account[key]}ULL;')
  for key,cname,values in [('key','keys',int(account['key']).to_bytes(32,'little')),('owner','owners',int(account['owner']).to_bytes(32,'little')),('data','data',account['data'])]:
   for j,value in enumerate(values):
    if value:lines.append(f'{cname}[{i}][{j}]={value};')
 for name,value in {**w['native'],'amount':w['amount']}.items():lines.append(f't.{name}={value}ULL;')
 for name,value in w['keys'].items():
  for j,byte in enumerate(int(value).to_bytes(32,'little')):
   if byte:lines.append(f't.{name}[{j}]={byte};')
 lines.append('printf("%llu\\n",bend_transfer_validate(&t,a,7));')
 # The original success may depend on a pre-batch zero-supply/balance flag.
 # Preserve that first check, then verify durable checks after three rounds.
 lines.append('t.initialize=0;t.fresh_destination=0;')
 for step in range(3):
  for i,account in enumerate(w['accounts']):
   if i<4:continue
   spans=[(36,44)] if account['size']==82 else [(64,108),(121,129)] if account['size']==165 else []
   for start,end in spans:
    for j in range(start,end):lines.append(f'data[{i}][{j}]={(step*79+i*31+j*17+1)%256};')
  lines.append('printf("%llu\\n",bend_transfer_validate(&t,a,7));')
 lines.append('}')
 blocks.extend(lines)
source=root/'native.c';source.write_text('#include <stdio.h>\n#include "token.h"\n'+'\n'.join(blocks)+'\nint main(void){'+''.join(f'case_{i}();' for i in range(len(report['mutablePredicates'])))+'return 0;}\n')
command=[os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all','-Iruntime',str(source),'-o',str(root/'native')]
r=subprocess.run(command,capture_output=True,text=True,timeout=120);(root/'native-compile.log').write_text(r.stdout+r.stderr);assert r.returncode==0,r.stderr
r=subprocess.run([str(root/'native')],capture_output=True,text=True,timeout=30,env={**os.environ,'ASAN_OPTIONS':'detect_leaks=0:abort_on_error=1','UBSAN_OPTIONS':'halt_on_error=1'});(root/'native-run.log').write_text(r.stdout+r.stderr);assert r.returncode==0 and not r.stderr,r.stderr
values=[int(x) for x in r.stdout.splitlines()];assert values==expected,(values,expected)
assert rp.read_bytes()==raw
assert sha(pathlib.Path(__file__))==checker_sha
for name,h in report['inputs'].items():assert sha(pathlib.Path(name))==h
receipt={'passed':True,'runId':run_id,'expected':expected,'actual':values,'proofReportSha256':hashlib.sha256(raw).hexdigest(),'checkerSha256':checker_sha,'sourceSha256':sha(source),'binarySha256':sha(root/'native'),'command':command,'scope':'Two enabled-prebatch-predicate fixtures and three successive framed byte changes each through actual host C under ASan/UBSan. Only durable validation rerun after changes; not actual token-program execution or a transaction theorem.'}
(root/'report.json').write_text(json.dumps(receipt,indent=2)+'\n');pending=root/'publish.json';pending.write_text(json.dumps(receipt,indent=2)+'\n');pending.replace(output)
print('Native initial and three framed durable-validation results:',values)
