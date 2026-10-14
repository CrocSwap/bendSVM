from pathlib import Path
import sys,json,runpy,types,hashlib,uuid,os
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
import z3 as z
import collection_caller_syntax as api
from collection_caller_paths import EntryPaths,check_declarations
from collection_root_report import unchanged as collection_unchanged,validate as collection_validate
from loader_report import unchanged as loader_unchanged,validate as loader_validate
root=Path('build/collection-entry');prepath=os.environ.get('ENTRY_BUNDLE_INPUT');pre=json.loads(Path(prepath).read_bytes()) if prepath else None
if pre:
 run=Path(pre['runDirectory']);assert run.is_dir() and run.name==pre['runId'];assert not any((run/n).exists() for n in ['report.json','loader-replay.json','root-replay.json'])
 for name,h in pre['sources'].items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h,name
else:
 run=root/str(uuid.uuid4());run.mkdir()
def receipt(name):
 r=pre['prerequisites']['loader' if 'loader/' in name else 'collection'] if pre else json.loads(Path(name).read_bytes());raw=Path(r['inputArtifact']).read_bytes();p=Path(r['reportArtifact']).read_bytes()
 assert hashlib.sha256(raw).hexdigest()==r['inputSha256'] and hashlib.sha256(p).hexdigest()==r['reportSha256'];return r,raw,json.loads(raw),json.loads(p)
lr,lraw,ld,lp=receipt('build/loader/fresh-receipt.json');cr,craw,cd,cp=receipt('build/collection-root/fresh-receipt.json')
loader_unchanged(ld);loader_validate(lp,ld,lraw);collection_unchanged(cd);collection_validate(cp,cd,craw)
assert Path(ld['headerArtifact']).read_bytes()==Path(cd['caller']['includePaths']['solana_min.h']).read_bytes()
saved=sys.argv
try:
 sys.argv=['verification/loader_model.py',lr['inputArtifact'],str(run/'loader-replay.json')]
 ns=runpy.run_path('verification/loader_model.py',run_name='__main__')
finally:sys.argv=saved
files=cd['caller']['artifactPaths'];text=Path(files['collection-store.c']).read_text();schema=json.loads(Path(files['collection-store.schema.json']).read_bytes());interface=json.loads(Path(files['collection-store.interface.json']).read_bytes())
model=api.assert_schema(schema,interface);model['_interface']=interface;check_declarations(api,text,interface);body=api.function_body(text,'entrypoint',set());paths=EntryPaths(api,model)
wire=z.Array('invocation_bytes',z.BitVecSort(64),z.BitVecSort(8));v=lambda x:z.BitVecVal(x,64);cursor=v(8);records=[];bindings=[];seen=set()
def byte(offset):return z.Select(wire,offset)
def scalar(offset):return z.substitute(ns['le'](offset),(ns['b'],wire))
def bind(name,bits,rhs,guard):
 lhs=paths.input(name,bits);lhs=z.Extract(bits-1,0,lhs) if bits<64 else lhs
 equation=z.Implies(guard,lhs==rhs);paths.constraints.append(equation);bindings.append((guard,lhs,rhs,equation))
def instantiate(expr,at):
 index=z.BitVec('record_byte_index',64);view=z.Lambda(index,byte(at+index))
 return z.simplify(z.substitute(expr,(ns['b'],view),(ns['base'],v(0x100000000)+at)))
original_simple=paths.simple
original_call=paths.call
original_expr=paths.expr
def simple(self,tokens):
 global cursor
 s=''.join(tokens)
 if s=='u64count=read_le(input,8)':bind('account_count',64,scalar(v(0)),self.pc)
 if s=='p=read_account(p,&accounts[i])':
  index=self.loop['i'];at=cursor;reject=instantiate(ns['reject'],at)
  for premise in ns['premises']:self.constraints.append(z.Implies(z.And(self.pc,z.Not(reject)),instantiate(premise,at)))
  bind('load_'+str(index),1,z.If(reject,z.BitVecVal(0,1),z.BitVecVal(1,1)),self.pc)
  records.append({'at':at,'key':at+instantiate(ns['actual']['key'],at),'success':z.And(self.pc,z.Not(reject))})
  # Substitute the qualified next-account-address lemma under the successful-call premises above.
  cursor=at+instantiate(ns['expected_end'],at)
 if s=='u64length=read_le(p,8)':bind('instruction_length',64,scalar(cursor),self.pc)
 return original_simple(tokens)
def call(self,name,args):
 if name=='equal_key' and self.loop['j']<self.loop['i']:
  i,j=self.loop['i'],self.loop['j'];equal=z.And(*[byte(records[i]['key']+v(k))==byte(records[j]['key']+v(k)) for k in range(32)])
  bind(f'alias_{i}_{j}',1,z.If(equal,z.BitVecVal(1,1),z.BitVecVal(0,1)),self.pc)
 return original_call(name,args)
def expr(self,tokens):
 if ''.join(self.api.strip_outer(tokens))=='ix[0]' and 'mode' not in seen:
  seen.add('mode');bind('mode',8,byte(cursor+v(8)),self.pc)
 return original_expr(tokens)
paths.simple=types.MethodType(simple,paths);paths.call=types.MethodType(call,paths);paths.expr=types.MethodType(expr,paths)
proofs=paths.prove(body);print('entry obligations',len(proofs),'bindings',len(bindings),flush=True)
assert len(records)==3 and len(bindings)==9
solver=z.Solver();solver.set(timeout=60000);solver.add(*paths.constraints,paths.events['dispatch']);status=solver.check();print('dispatch witness',status,flush=True);assert status==z.sat
loader_unchanged(ld);collection_unchanged(cd)
(run/'report.json').write_text(json.dumps({'passed':True,'entryClaims':proofs,'bindings':[str(lhs) for _,lhs,_,_ in bindings],'dispatchWitness':str(status),'loaderInputSha256':lr['inputSha256'],'collectionInputSha256':cr['inputSha256'],
 'scope':'Exploratory serialized-byte bindings at parsed collection entrypoint calls using qualified decoder expressions and the proved next-account-address summary. Assumes valid loader allocation/preconditions at successful loads, native object separation and key equality byte semantics. Does not yet connect dispatch Account fields to the run model or establish full memory/SBF preservation.'},indent=2)+'\n');print(run)
