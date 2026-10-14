from pathlib import Path
import hashlib,json,sys,time,copy,os
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
import z3 as z
from prove import Evaluator as BaseEvaluator
from modular_c import refs
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
root=Path(sys.argv[1]);sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest();input_path=Path(os.environ.get('COMPOSITION_INPUT',str(root/'composition-model.json')));raw=input_path.read_bytes();data=json.loads(raw)
assert z.get_version_string()=='5.1.0'
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
prior=json.loads((root/'candidate-proof.json').read_text());old=json.loads((root/'candidate-model.json').read_text())
assert prior['passed'] and prior['inputSha256']==sha(root/'candidate-model.json') and prior['checkerSha256']==sha(Path('verification/linear_width_step.py'))
assert [x['result'] for x in prior['claims']]==['unsat','unsat','sat','unsat','unsat','unsat','unsat']
for which in ['original','candidate']:
 for n,f in old[which]['functions'].items():assert data[which]['functions'][n]==f,n
rows=[]
def query(name,bad):
 solver=z.Solver();solver.set(timeout=30000);solver.add(bad);start=time.monotonic();result=solver.check();rows.append({'name':name,'result':str(result),'seconds':time.monotonic()-start});print(name,result,flush=True);assert result==z.unsat,solver.reason_unknown()
def word_type(e):return e.program['functions']['product']['result']
def word(e,bits):return e.sort(word_type(e)).constructor(0)(z.Extract(31,0,bits),z.Extract(63,32,bits))
def bits(e,value):
 s=e.sort(word_type(e));return z.Concat(s.accessor(0,1)(value),s.accessor(0,0)(value))
def state(e,index,dot,valid,limit):return e.sort(e.program['functions']['advance']['args'][0]).constructor(0)(index,word(e,dot),valid,limit)
def state_fields(e,value):
 s=e.sort(e.program['functions']['advance']['args'][0]);return [s.accessor(0,i)(value) for i in range(4)]
# Bind identical downstream function bodies before sharing their opaque summary.
normalize=lambda value:json.loads(json.dumps(value).replace('../../sdk/','../sdk/'))
original=data['original']['functions'];candidate={n.replace('../../sdk/','../sdk/'):normalize(f) for n,f in data['candidate']['functions'].items()}
seen=set()
def same(name):
 if name in seen:return
 assert original[name]==candidate[name],name;seen.add(name)
 for callee in refs(original[name].get('body')):same(callee)
same('linear_output')
for name in ['advance','linear']:assert original[name]==candidate[name],name
summary=z.Function('unchanged_linear_output',z.BitVecSort(64),z.BitVecSort(32),z.BitVecSort(32),z.BitVecSort(64))
class Final(Evaluator):
 def call(self,name,args,path):
  if name=='linear_output':return word(self,summary(bits(self,args[0]),args[1],args[2]))
  return super().call(name,args,path)
index,limit,scale,mult=z.BitVecs('index limit scale mult',32);d1,d2=z.BitVecs('dot1 dot2',64);valid=z.Bool('valid')
x=Final(data['original']);y=Final(data['candidate'])
a=x.call('finish_sum',[state(x,index,d1,valid,limit),scale,mult],z.BoolVal(True));b=y.call('finish_sum',[state(y,index,d2,valid,limit),scale,mult],z.BoolVal(True))
def reply(e,value):
 s=e.sort(e.program['functions']['finish_sum']['result']);return s.accessor(0,0)(value),bits(e,s.accessor(0,1)(value))
ae,av=reply(x,a);be,bv=reply(y,b)
query('final-output-respects-validity-relation',z.And(z.Implies(valid,d1==d2),z.Or(ae!=be,av!=bv,*x.dead,*y.dead)))
# A failed validity bit permits unrelated dots; only control fields must agree.
q,w=z.BitVecs('q w',32);active=z.Bool('active')
x=Evaluator(data['original']);y=Evaluator(data['candidate'])
a=x.call('advance_if',[active,index,word(x,d1),z.BoolVal(False),q,w,limit],z.BoolVal(True));b=y.call('advance_if',[active,index,word(y,d2),z.BoolVal(False),q,w,limit],z.BoolVal(True));a=state_fields(x,a);b=state_fields(y,b)
query('invalid-prefix-relation-preserved',z.Or(a[0]!=b[0],a[3]!=b[3],a[2],b[2],*x.dead,*y.dead))
# Raw invalid payloads may change sums, but never index, limit or validity policy.
x=Evaluator(data['original']);y=Evaluator(data['candidate'])
a=x.call('advance_if',[active,index,word(x,d1),valid,q,w,limit],z.BoolVal(True));b=y.call('advance_if',[active,index,word(y,d2),valid,q,w,limit],z.BoolVal(True));a=state_fields(x,a);b=state_fields(y,b)
query('step-control-fields-all-payloads',z.Or(a[0]!=b[0],a[3]!=b[3],a[2]!=b[2],a[0]!=index+1,a[3]!=limit,*x.dead,*y.dead))
n,acc=z.Ints('prefix_length prefix_sum')
query('inactive-prefix-bound-widens',z.And(n>=0,n<32,acc>=-16256*n,acc<=16384*n,z.Or(acc < -16256*(n+1),acc > 16384*(n+1))))
query('all-prefixes-fit-signed32',z.And(n>=0,n<=32,acc>=-16256*n,acc<=16384*n,z.Or(acc < -2147483648,acc > 2147483647)))
query('initial-prefix-is-zero',z.And(acc>=-16256*0,acc<=16384*0,acc!=0))
traces=[]
for which in ['original','candidate']:
 class Trace(Evaluator):
  def call(self,name,args,path):
   if name=='advance':
    assert z.is_true(z.simplify(path))
    output=z.Const(which+'_step_'+str(len(self.calls)),args[0].sort());self.calls.append((args,output));return output
   return super().call(name,args,path)
 e=Trace(data[which]);e.calls=[];qcells=[z.BitVec('q'+str(i),32) for i in range(32)];wcells=[z.BitVec('w'+str(i),32) for i in range(32)]
 def row(type_,cells):
  if type_=='U32':return next(cells)
  t=e.types[type_];assert len(t['variants'])==1
  return e.sort(type_).constructor(0)(*[row(f['type'],cells) for f in t['variants'][0]['fields']])
 signature=e.program['functions']['fold_rows'];qrow=row(signature['args'][0],iter(qcells));wrow=row(signature['args'][1],iter(wcells))
 actual=e.call('fold_rows',[qrow,wrow,limit],z.BoolVal(True));assert len(e.calls)==32
 previous=state(e,z.BitVecVal(0,32),z.BitVecVal(0,64),z.BoolVal(True),limit);bad=list(e.dead)
 for i,(args,output) in enumerate(e.calls):
  bad.extend([args[0]!=previous,args[1]!=qcells[i],args[2]!=wcells[i]]);previous=output
 bad.append(actual!=previous);query(which+'-actual-fold-32-ordered-steps',z.Or(*bad));traces.append({'fixture':data[which]['source'],'steps':32})
for p,h in data['sourceHashes'].items():assert sha(p)==h,p
assert input_path.read_bytes()==raw
Path(os.environ.get('COMPOSITION_REPORT',str(root/'composition-proof.json'))).write_text(json.dumps({'passed':True,'inputSha256':sha(input_path),'prerequisiteSha256':sha(root/'candidate-proof.json'),'checkerSha256':sha(Path(__file__)),'claims':rows,'traces':traces,'identicalDownstreamFunctions':sorted(seen),'scope':'Actual fold traversal and final-output relation, with bound prior helper proofs and structurally identical downstream arithmetic. Prefix bound/invariant composition remains an explicit trusted-driver argument; no emitted C or SBF theorem.'},indent=2)+'\n')
