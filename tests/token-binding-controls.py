import sys,pathlib,json,copy
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

(root/'token-binding-controls.json').unlink(missing_ok=True)
v=Validation({n:pathlib.Path('runtime',n).read_text() for n in ('token.h','cpi_abi.h','solana_min.h')})
slot={(n,):t.bv(0) for n in v.model.fields};slot[('amount',)]=t.bv(0,64)
for n in v.model.native_keys:
 for i in range(32):slot[((n,),i)]=t.bv(0,8)
accounts={n:[t.bv(i,w) for i in range(12)] for n,w in [('keys',256),('size',64),('signer',32),('writable',32),('executable',32)]}
faults=[]
def reject(name,edit,reason):
 s,a,c=copy.copy(slot),copy.deepcopy(accounts),[t.bv(7,64)];edit(s,a,c)
 try:v.bind(s,c[0],a)
 except t.Grammar as e:
  t.need(reason in str(e),'wrong refusal '+str(e));faults.append({'name':name,'reason':str(e)})
 else:raise AssertionError('invalid binding accepted: '+name)
reject('missing-field',lambda s,a,c:s.pop(('active',)),'field inventory')
reject('extra-field',lambda s,a,c:s.__setitem__(('extra',),t.bv(0)),'field inventory')
reject('narrow-amount',lambda s,a,c:s.__setitem__(('amount',),t.bv(0)),'amount must be U64')
reject('wide-key-byte',lambda s,a,c:s.__setitem__((('mint_key',),0),t.bv(0)),'byte must be U8')
reject('missing-account-view',lambda s,a,c:a.pop('keys'),'view inventory')
reject('short-account-array',lambda s,a,c:a['size'].pop(),'twelve account')
reject('narrow-account-key',lambda s,a,c:a['keys'].__setitem__(0,t.bv(0)),'keys must be U256')
reject('boolean-account-flag',lambda s,a,c:a['signer'].__setitem__(0,z.BoolVal(True)),'signer must be U32')
reject('narrow-count',lambda s,a,c:c.__setitem__(0,t.bv(7)),'count must be U64')
_,claims=v.bind(slot,t.bv(2**32+7,64),accounts)
t.need(z.is_false(z.simplify(claims['caller-count'])),'high count bits lost')
_,baseline=v.bind(slot,t.bv(7,64),accounts)
t.need(z.is_true(z.simplify(baseline['caller-count'])),'valid count rejected')
r={'passed':True,'refusals':faults,'highCountRejected':True,'baselineCountAccepted':True,'moduleSha256':t.sha(pathlib.Path('verification/token_semantics.py').read_bytes()),'checkerSha256':t.sha(pathlib.Path(__file__).read_bytes())}
bound()
(root/'token-binding-controls.json').write_text(json.dumps(r,indent=2)+'\n');print('Binding controls passed:',len(faults),'and high-count check')
