import os
import hashlib,json,pathlib,sys
sys.path.insert(0,'verification')
import z3
import adapter_contract as contract
from adapter_contract_sym import Exec,Ref,Ptr,concrete
root=pathlib.Path(os.environ.get('BRIDGE_DIR','build/vault-adapter-bridge'))
data=json.loads((root/'input.json').read_text());f=data['fixture']
def need(ok,message):
    if not ok:raise RuntimeError(message)
bindings={**data['sourceHashes'],**data['artifactHashes']}
def bound():
    for p,h in bindings.items():need(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h,p)
bound()
class Premises(Exec):
    recorded_calls=[]
    def call_decode(self,name,args,st,g):
        src,n,target=args
        # The accepted subset separates addressable local aggregate objects from
        # byte arrays and loader buffers. This is conditional C object separation.
        need(isinstance(target,Ref) and target.path[0]=='var','decode local output')
        need(isinstance(src,(Ref,Ptr)),'decode source region')
        if isinstance(src,Ref):need(src.path[0]=='var' and src.path[1]!=target.path[1],'overlapping local decode')
        result=super().call_decode(name,args,st,g)
        self.recorded_calls.append({'kind':'decode','callee':name,'bytes':concrete(n),'output':target.path[1],'source':str(src.path if isinstance(src,Ref) else src.region)})
        return result
    def call_root(self,name,args,st,g):
        context,before,instruction=args
        self.oblige(st,g,'bridge: root signed input is canonical Bool',z3.ULE(context.f[0][8],1))
        self.oblige(st,g,'bridge: state decoder succeeded before root',before.valid)
        self.oblige(st,g,'bridge: instruction decoder succeeded before root',instruction.valid)
        self.recorded_calls.append({'kind':'root','callee':name})
        return super().call_root(name,args,st,g)
    def call_encode(self,name,args,st,g):
        # Existing summary requires a local byte array and an outcome field;
        # therefore these are distinct objects under the C object model.
        result=super().call_encode(name,args,st,g)
        self.recorded_calls.append({'kind':'encode','callee':name,'bytes':concrete(args[1]),'output':args[0].path[1]})
        return result
contract.Exec=Premises
m=contract.summarize(f['schema'],f['interface'])
positive=contract.attempt(m,f['adapter'],f['files'],full=False)
need(positive['outcome']=='verified',str(positive))
calls=Premises.recorded_calls[:];need({c['kind'] for c in calls}=={'decode','root','encode'},'missing call coverage')
mutations=[]
for name,old,new in [('noncanonical-signer','actor.signer,','2,') ,('undersized-output','u8 encoded[76];','u8 encoded[75];'),('overshoot-state-slice','state.data + 20, 76, &before','state.data + 21, 76, &before')]:
    files=dict(f['files']);need(old in files[f['adapter']],'missing target '+name);files[f['adapter']]=files[f['adapter']].replace(old,new,1)
    result=contract.attempt(m,f['adapter'],files,full=False)
    need(result['outcome']=='rejected',name+' escaped')
    mutations.append({'name':name,'result':result})
bound()
report={'passed':True,'endToEndVerified':False,'inputSha256':hashlib.sha256((root/'input.json').read_bytes()).hexdigest(),'checkerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'positive':positive,'calls':calls,'mutations':mutations,'scope':'Adapter abstract-memory call premises, including decoder success and canonical context Bool. Existing obligations check loader-region and local-buffer bounds. Object nonoverlap depends on valid disjoint C stack objects versus loader regions; real C memory provenance and loader correctness remain trusted.'}
(root/'call-premises-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'passed':True,'obligations':positive['obligations'],'calls':len(calls),'mutations':len(mutations)}))
