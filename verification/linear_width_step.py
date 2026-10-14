from pathlib import Path
import hashlib,json,sys,time,copy
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
import z3 as z
from prove import Evaluator as BaseEvaluator
class Evaluator(BaseEvaluator):
 def __init__(self,program):
  program=copy.deepcopy(program);prefix=('original::' if program['source']=='benchmarks/linear-wide.bend' else 'candidate::')
  types={t['name']:prefix+t['name'] for t in program['schema']['types'] if t['kind']=='adt'}
  constructors={v['name']:prefix+v['name'] for t in program['schema']['types'] if t['kind']=='adt' for v in t['variants']}
  for t in program['schema']['types']:
   if t['kind']=='adt':
    t['name']=types[t['name']]
    for v in t['variants']:
     v['name']=constructors[v['name']]
     for f in v['fields']:f['type']=types.get(f['type'],f['type'])
  def rename(term):
   if isinstance(term,dict):
    if term.get('$') in ('Ctr','Mat') and term.get('k') in constructors:term['k']=constructors[term['k']]
    for v in term.values():rename(v)
   elif isinstance(term,list):
    for v in term:rename(v)
  for f in program['functions'].values():
   f['args']=[types.get(t,t) for t in f['args']];f['result']=types.get(f['result'],f['result']);rename(f.get('body'))
  super().__init__(program)
 @staticmethod
 def primitive(name,args):
  if name=='U32.is_le':return z.ULE(*args)
  return BaseEvaluator.primitive(name,args)
root=Path(sys.argv[1]);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();raw=(root/'candidate-model.json').read_bytes();data=json.loads(raw)
assert z.get_version_string()=='5.1.0'
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
prior=json.loads((root/'report.json').read_text());old=json.loads((root/'input.json').read_text())
assert prior['passed'] and prior['inputSha256']==sha(root/'input.json') and prior['checkerSha256']==sha(Path('verification/linear_width_product.py'))
assert [r['result'] for r in prior['claims']]==['unsat']*7+['sat']*2
for n,f in old['source']['functions'].items():assert data['original']['functions'][n]==f,n
for p,h in prior['sourceHashes'].items():assert sha(p)==h,p
rows=[]
def query(name,bad,wanted='unsat'):
 s=z.Solver();s.set(timeout=30000);s.add(bad);start=time.monotonic();status=s.check();r={'name':name,'result':str(status),'seconds':time.monotonic()-start}
 if status==z.sat:r['witness']=str(s.model())
 if status==z.unknown:r['reason']=s.reason_unknown()
 rows.append(r);print(name,status,flush=True);assert str(status)==wanted,r

def word_type(e):return e.program['functions']['product']['result']
def word(e,bits):return e.sort(word_type(e)).constructor(0)(z.Extract(31,0,bits),z.Extract(63,32,bits))
def bits(e,value):
 s=e.sort(word_type(e));return z.Concat(s.accessor(0,1)(value),s.accessor(0,0)(value))
q8,w8=z.BitVecs('q8 w8',8);q=z.ZeroExt(24,q8);w=z.ZeroExt(24,w8)
product=z.SignExt(56,q8)*z.SignExt(56,w8)
e=Evaluator(data['candidate']);actual=e.call('product',[q,w],z.BoolVal(True))
query('candidate-byte-product',z.Or(bits(e,actual)!=product,*e.dead))
a,b=z.BitVecs('acc term',32);a64=z.SignExt(32,a);b64=z.SignExt(32,b)
bounded=z.And(a>=-520192,a<=524288,b>=-16256,b<=16384)
e=Evaluator(data['candidate']);actual=e.call('../sdk/signed.add32_wrap',[word(e,a64),word(e,b64)],z.BoolVal(True))
query('candidate-bounded-add',z.And(bounded,z.Or(bits(e,actual)!=a64+b64,*e.dead)))
query('candidate-add-needs-bound',bits(e,actual)!=a64+b64,'sat')
class CertifiedProduct(Evaluator):
 def call(self,name,args,path):
  if name=='product':
   self.dead.append(z.And(path,z.Or(z.UGT(args[0],255),z.UGT(args[1],255))))
   return word(self,z.SignExt(56,z.Extract(7,0,args[0]))*z.SignExt(56,z.Extract(7,0,args[1])))
  return super().call(name,args,path)
index,limit=z.BitVecs('index limit',32);valid=z.Bool('valid')
def step(e,active,dot,q,w):return e.call('advance_if',[active,index,word(e,dot),valid,q,w,limit],z.BoolVal(True))
def fields(e,result):
 s=e.sort(e.program['functions']['advance_if']['result']);return [s.accessor(0,i)(result) for i in range(4)]
x=CertifiedProduct(data['original']);y=Evaluator(data['candidate']);left=fields(x,step(x,z.BoolVal(True),a64,q,w));right=fields(y,step(y,z.BoolVal(True),a64,q,w))
different=z.Or(left[0]!=right[0],bits(x,left[1])!=bits(y,right[1]),left[2]!=right[2],left[3]!=right[3])
query('active-byte-step-preservation',z.And(a>=-520192,a<=524288,z.Or(different,*x.dead,*y.dead)))
rawq,raww=z.BitVecs('rawq raww',32);dot=z.BitVec('dot',64)
x=Evaluator(data['original']);y=Evaluator(data['candidate']);left=fields(x,step(x,z.BoolVal(False),dot,rawq,raww));right=fields(y,step(y,z.BoolVal(False),dot,rawq,raww))
query('inactive-step-all-payloads',z.Or(left[0]!=right[0],bits(x,left[1])!=bits(y,right[1]),left[2]!=right[2],left[3]!=right[3],*x.dead,*y.dead))
x=Evaluator(data['original']);y=Evaluator(data['candidate']);left=fields(x,step(x,z.BoolVal(True),dot,rawq,raww));right=fields(y,step(y,z.BoolVal(True),dot,rawq,raww))
query('active-invalid-byte-clears-validity',z.And(z.Or(z.UGT(rawq,255),z.UGT(raww,255)),z.Or(left[2],right[2],*x.dead,*y.dead)))
query('failed-validity-cannot-recover',z.And(z.Not(valid),z.Or(left[2],right[2])))
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert (root/'candidate-model.json').read_bytes()==raw
(root/'candidate-proof.json').write_text(json.dumps({'passed':True,'inputSha256':sha(root/'candidate-model.json'),'prerequisiteSha256':sha(root/'report.json'),'checkerSha256':sha(Path(__file__)),'claims':rows,'scope':'Actual candidate helpers and single-step preservation; original-product summary freshly bound to prior universal byte theorem. Explicit accumulation bounds, inactive arbitrary payloads and invalid-byte validity propagation. Whole fold and final rejection composition still pending.'},indent=2)+'\n')
