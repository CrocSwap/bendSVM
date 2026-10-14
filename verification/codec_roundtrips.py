import os,sys,pathlib,json,hashlib
sys.path.insert(0,'verification')
from acyclic_c import Source
from codec_semantics import Codecs,need
import z3 as z
root=pathlib.Path(os.environ['BRIDGE_DIR']);raw=(root/'input.json').read_bytes();data=json.loads(raw);f=data['fixture'];source=Source(data['program']['source'])
bindings={**data['sourceHashes'],**data['artifactHashes']}
def bound():
 for p,h in bindings.items():need(hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()==h,p)
bound();need(z.get_version_string()=='5.1.0','Z3 pin')
codecs=Codecs(source,{'name':'vault','headerName':'vault.h','schema':f['schema'],'native':f['files']['vault.h'],'codecs':f['files']['vault.wire.h']})
claims=[]
def query(name,formula,expected='unsat',canonical_bytes=False):
 # Isolate each obligation from earlier queries while retaining its exact formula.
 context=z.Context();translated=formula.translate(context)
 need(translated.sexpr()==formula.sexpr(),'query translation changed formula')
 # Cofactor the decoder choices in canonical-byte obligations without new premises.
 solver=(z.Then(z.Tactic('simplify',ctx=context),z.Tactic('cofactor-term-ite',ctx=context),z.Tactic('smt',ctx=context)).solver() if canonical_bytes else z.Solver(ctx=context))
 solver.set(timeout=30000);solver.add(translated);result=solver.check();need(result!=z.unknown,name+': UNKNOWN');need(str(result)==expected,name+': '+str(result));claims.append({'name':name,'result':str(result)})
for name in codecs.order:
 value=z.Const('native_'+name,source.sort(name));ok,encoded=codecs.encode(name,value);decoded_ok,decoded=codecs.decode(name,encoded)
 query(name+' value round trip',z.And(ok,z.Or(z.Not(decoded_ok),decoded!=value)))
 bytes_=[z.BitVec('byte_'+name+'_'+str(i),8) for i in range(codecs.sizes[name])];ok,decoded=codecs.decode(name,bytes_);encoded_ok,encoded=codecs.encode(name,decoded)
 query(name+' canonical bytes round trip',z.And(ok,z.Or(z.Not(encoded_ok),*[a!=b for a,b in zip(bytes_,encoded)])),canonical_bytes=True)
 query(name+' accepted bytes reachable',ok,'sat')
bound();report={'passed':True,'endToEndVerified':False,'inputSha256':hashlib.sha256(raw).hexdigest(),'sourceHashes':data['sourceHashes'],'artifactHashes':data['artifactHashes'],'checkerSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'semanticsSha256':hashlib.sha256(pathlib.Path('verification/codec_semantics.py').read_bytes()).hexdigest(),'claims':claims,'codecConformance':codecs.evidence,'scope':'Symbolic value/byte semantics of restricted emitted canonical codecs after C template/layout validation. Typed schema/parser/Z3 trusted; valid disjoint regions assumed; no arbitrary C or SBF memory theorem.'};(root/'codec-semantics-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'types':len(codecs.order),'claims':len(claims)}))
