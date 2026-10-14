"""Compare bound symbolic helper returns to real local C, under UBSan."""
import sys,pathlib,copy,json,subprocess,os
sys.path.insert(0,'verification')
import token_validate as t
from token_semantics import Validation
z=t.z3
fresh_path=pathlib.Path('build/vault-adapter-bridge/fresh-receipt.json')
fresh_bytes=fresh_path.read_bytes();fresh=json.loads(fresh_bytes);input_path=pathlib.Path(fresh['input']);input_bytes=input_path.read_bytes();input_data=json.loads(input_bytes)
t.need(t.sha(input_bytes)==fresh['inputSha256'],'token tests: input binding')
def bound():
 t.need(fresh_path.read_bytes()==fresh_bytes,'token tests: receipt changed')
 t.need(input_path.read_bytes()==input_bytes,'token tests: input changed')
 for path,digest in {**input_data['sourceHashes'],**input_data['artifactHashes']}.items():t.need(t.sha(pathlib.Path(path).read_bytes())==digest,'token tests: source/artifact drift '+path)
bound()
root=input_path.parent
negative=sys.argv[1:]==['--reverse-keys']
t.need(not sys.argv[1:] or negative,'native test arguments')
out=root/('validator-native-byte-control' if negative else 'validator-native');out.mkdir(exist_ok=True)
report_path=root/('token-native-byte-control-report.json' if negative else 'token-native-report.json');report_path.unlink(missing_ok=True)
files={n:pathlib.Path('runtime',n).read_text() for n in ('token.h','cpi_abi.h','solana_min.h')};v=Validation(files)
def base():
 a=[{'key':[(17*(i+1)+j)%256 for j in range(32)],'owner':[0]*32,'data':[0]*165,'size':165,'signer':1,'writable':1,'executable':0} for i in range(12)]
 for account in a:account['owner']=a[2]['key'][:]
 a[6]['size']=82;a[6]['data'][45]=1
 for i in (4,5):a[i]['data'][:32]=a[6]['key'];a[i]['data'][32:64]=a[1 if i==4 else 3]['key'];a[i]['data'][108]=1
 f={name:0 for name in v.model.fields};f.update(active=1,source=4,destination=5,mint=6,authority=0,recipient=1,amount=7)
 for name in v.model.native_keys:f[name]=a[6]['key'][:] if name=='mint_key' else [0]*32
 return {'name':'valid-transfer','count':7,'accounts':a,'effect':f}
cases=[base()]
def add(name,edit):
 c=base();c['name']=name;edit(c);cases.append(c)
for name,value in [('active',0),('active',2),('active',9),('mint',7),('mint',3),('destination',4),('source',7),('authority',2),('recipient',3),('source_bound',2),('destination_bound',2),('fresh_destination',2),('source_bound',1),('destination_bound',1)]:
 add(name+'-'+str(value),lambda c,n=name,x=value:c['effect'].__setitem__(n,x))
for index,name,value in [(6,'size',44),(4,'size',164),(5,'size',164),(6,'executable',1),(4,'writable',0),(5,'writable',0),(1,'signer',0)]:
 add('account-'+str(index)+'-'+name,lambda c,i=index,n=name,x=value:c['accounts'][i].__setitem__(n,x))
for index,offset,value in [(6,45,0),(4,108,0),(5,108,0),(4,109,1),(5,109,1),(4,0,0),(5,0,0),(4,32,0),(5,32,0)]:
 add('byte-'+str(index)+'-'+str(offset),lambda c,i=index,o=offset,x=value:c['accounts'][i]['data'].__setitem__(o,x))
add('mint-key-mismatch',lambda c:c['effect']['mint_key'].__setitem__(31,0))
add('mint-owner-mismatch',lambda c:c['accounts'][6]['owner'].__setitem__(0,0))
add('fresh-empty',lambda c:c['effect'].__setitem__('fresh_destination',1))
add('fresh-funded',lambda c:(c['effect'].__setitem__('fresh_destination',1),c['accounts'][5]['data'].__setitem__(64,1)))
if negative:cases=cases[:1]
expected=[];blocks=[]
for case_index,case in enumerate(cases):
 a=case['accounts'];f=case['effect'];slot={(name,):t.bv(f[name]) for name in v.model.fields};slot[('amount',)]=t.bv(f['amount'],64)
 for name in v.model.native_keys:
  for i,b in enumerate(f[name]):slot[((name,),i)]=t.bv(b,8)
 accounts={name:[t.bv(int.from_bytes(x['key'],'little'),256) if name=='keys' else t.bv(x[name],64 if name=='size' else 32) for x in a] for name in ['keys','size','signer','writable','executable']}
 if negative:
  original=dict(slot)
  for name in v.model.native_keys:
   for i in range(32):slot[((name,),i)]=original[((name,),31-i)]
 result,_=v.bind(slot,t.bv(case['count'],64),accounts)
 owners=z.K(z.BitVecSort(32),t.bv(0,256));data=z.K(z.BitVecSort(32),z.K(z.BitVecSort(32),t.bv(0,8)))
 for i,account in enumerate(a):
  owners=z.Store(owners,t.bv(i),t.bv(int.from_bytes(account['owner'],'little'),256));bs=z.K(z.BitVecSort(32),t.bv(0,8))
  for j,b in enumerate(account['data']):
   if b:bs=z.Store(bs,t.bv(j),t.bv(b,8))
  data=z.Store(data,t.bv(i),bs)
 result=z.simplify(z.substitute(result,(v.model.account_owners,owners),(v.model.account_data,data)))
 t.need(z.is_bv_value(result),'concrete validator result');expected.append(result.as_long())
 lines=[f'static __attribute__((noinline)) void case_{case_index}(void) {{','Account a[12]={0}; u8 keys[12][32]={0},owners[12][32]={0},bytes[12][165]={0}; BendTransfer t={0};']
 for i,account in enumerate(a):
  lines.append(f'a[{i}].key=keys[{i}];a[{i}].owner=owners[{i}];a[{i}].data=bytes[{i}];')
  for name in ['size','signer','writable','executable']:lines.append(f'a[{i}].{name}={account[name]};')
  for cname,name in [('keys','key'),('owners','owner'),('bytes','data')]:
   for j,b in enumerate(account[name]):
    if b:lines.append(f'{cname}[{i}][{j}]={b};')
 for name in list(v.model.fields)+['amount']:lines.append(f't.{name}={f[name]}ULL;')
 for name in v.model.native_keys:
  for j,b in enumerate(f[name]):
   if b:lines.append(f't.{name}[{j}]={b};')
 lines.append(f'printf("%llu\\n",bend_transfer_validate(&t,a,{case["count"]}));}}');blocks.extend(lines)
source=out/'harness.c';source.write_text('#include <stdio.h>\n#include "token.h"\n'+'\n'.join(blocks)+'\nint main(void){'+''.join(f'case_{i}();' for i in range(len(cases)))+'return 0;}\n')
command=[os.environ.get('CC','clang'),'-std=c11','-O1','-fsanitize=undefined','-fno-sanitize-recover=all','-Iruntime',str(source),'-o',str(out/'harness')]
compile=subprocess.run(command,capture_output=True,text=True,timeout=120);(out/'compile.log').write_text(compile.stdout+compile.stderr);t.need(compile.returncode==0,'native compile')
run=subprocess.run([str(out/'harness')],capture_output=True,text=True,timeout=10);(out/'run.log').write_text(run.stdout+run.stderr);t.need(run.returncode==0,'native validator process');actual=[int(n) for n in run.stdout.splitlines()];t.need(actual==expected,'native validator mismatch')
t.need(not negative,'byte-order control escaped')
control=subprocess.run([sys.executable,'-B',__file__,'--reverse-keys'],capture_output=True,text=True,timeout=150)
(out/'byte-control.log').write_text(control.stdout+control.stderr)
t.need(control.returncode!=0 and 'native validator mismatch' in control.stderr,'byte-order control must fail for native mismatch')
t.need((root/'validator-native-byte-control/run.log').read_text().strip()=='0','control real native result')
t.need(not (root/'token-native-byte-control-report.json').exists(),'failed control published success')
bound()
report={'passed':True,'byteOrderFaultDetected':True,'inputSha256':t.sha(input_bytes),'cases':[{'name':c['name'],'result':r} for c,r in zip(cases,actual)],'runtimeHashes':v.runtime_hashes,'moduleSha256':t.sha(pathlib.Path('verification/token_semantics.py').read_bytes()),'checkerSha256':t.sha(pathlib.Path(__file__).read_bytes()),'harnessSha256':t.sha(source.read_bytes()),'command':command,'scope':'Finite real host-C comparison with the bound parsed validator under UBSan. Not an SBF, syscall or complete memory proof.'}
report_path.write_text(json.dumps(report,indent=2)+'\n');print('Native validator comparisons passed:',len(cases))
