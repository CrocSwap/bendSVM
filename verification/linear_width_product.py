from pathlib import Path
import hashlib,json,sys,time
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
import z3 as z
from prove import Evaluator
root=Path(sys.argv[1]);raw=(root/'input.json').read_bytes();data=json.loads(raw);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
assert z.get_version_string()=='5.1.0'
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
model=Evaluator(data['source']);q,w=z.BitVecs('q w',8)
word=model.call('product',[z.ZeroExt(24,q),z.ZeroExt(24,w)],z.BoolVal(True))
type_=data['source']['functions']['product']['result'];sort=model.sort(type_)
actual=z.Concat(sort.accessor(0,1)(word),sort.accessor(0,0)(word))
product32=z.SignExt(24,q)*z.SignExt(24,w);candidate=z.SignExt(32,product32)
rows=[]
def query(name,bad,wanted='unsat'):
 s=z.Solver();s.set(timeout=30000);s.add(bad);start=time.monotonic();status=s.check();row={'name':name,'result':str(status),'seconds':time.monotonic()-start}
 if status==z.sat:row['witness']=str(s.model())
 if status==z.unknown:row['reason']=s.reason_unknown()
 rows.append(row);print(name,status,flush=True);assert str(status)==wanted,row
for qsign in range(2):
 for wsign in range(2):
  qlo,wlo=z.BitVecs('qlo wlo',7)
  assignments=[(q,z.Concat(z.BitVecVal(qsign,1),qlo)),(w,z.Concat(z.BitVecVal(wsign,1),wlo))]
  bad=z.simplify(z.substitute(z.Or(actual!=candidate,*model.dead),*assignments))
  query('actual-source-product-signs-'+str(qsign)+str(wsign),bad)
query('signed-byte-product-bound',z.Or(product32 < z.BitVecVal(-16256,32),product32 > z.BitVecVal(16384,32)))
n,acc,term=z.Ints('n acc term')
query('32-term-prefix-range-induction',z.And(n>=0,n<32,acc>=-16256*n,acc<=16384*n,term>=-16256,term<=16384,z.Or(acc+term < -16256*(n+1),acc+term > 16384*(n+1))))
a=z.BitVec('acc',32)
query('bounded-add-signextension-preservation',z.And(a>=z.BitVecVal(-520192,32),a<=z.BitVecVal(524288,32),z.SignExt(32,a+product32)!=z.SignExt(32,a)+candidate))
query('unsigned-byte-mutant',actual!=z.ZeroExt(32,z.ZeroExt(24,q)*z.ZeroExt(24,w)),'sat')
query('missing-accumulator-bound',z.SignExt(32,a+product32)!=z.SignExt(32,a)+candidate,'sat')
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert (root/'input.json').read_bytes()==raw
(root/'report.json').write_text(json.dumps({'passed':True,'inputSha256':sha(root/'input.json'),'checkerSha256':sha(Path(__file__)),'sourceHashes':data['sourceHashes'],'claims':rows,'scope':'Actual exported signed-byte product equivalence on byte inputs; separate bounded accumulation induction and sign-extension theorem. Not whole-linear equivalence, malformed-input behavior, emitted-C proof or measured CU improvement.'},indent=2)+'\n')
