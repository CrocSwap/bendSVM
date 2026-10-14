from pathlib import Path
import sys,json,hashlib,types
if not __debug__:raise RuntimeError("collection root requires assertions")
sys.path.insert(0,'verification')
import z3 as z
from acyclic_c import Source,C,mangle,check_artifacts,check_layouts
import collection_caller_syntax as api
from collection_caller_paths import Paths,check_declarations,check_run_arguments
from semantic_binding import references_output
from codec_semantics import Codecs
from collection_root_report import SCOPE,CLAIMS,validate,unchanged
input_path=Path(sys.argv[1]);root=input_path.parent;raw=input_path.read_bytes();data=json.loads(raw);p=data['program'];receipt=data['caller'];files=receipt['artifactPaths'];text=Path(files['collection-store.c']).read_text();schema=json.loads(Path(files['collection-store.schema.json']).read_text());interface=json.loads(Path(files['collection-store.interface.json']).read_text())
assert z.get_version_string()=='5.1.0'
assert data['version']==1 and len(data['runId'])==36
for name,h in {**data['sourceHashes'],**data['artifactHashes']}.items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h,name
for item in data['prerequisites'].values():assert hashlib.sha256(Path(item['artifact']).read_bytes()).hexdigest()==item['sha256']
from ranked_c import check as check_lowering
from ranked_report import validate_proof
lowering=check_lowering(p);assert lowering['passed'];validate_proof(p,lowering)
assert p['artifact']['c']==Path(files['collection-store.h']).read_text();assert p['artifact']['schema']==schema
model=api.assert_schema(schema,interface);model['_interface']=interface;check_declarations(api,text,interface);body=api.function_body(text,'bend_collection_run',set());check_run_arguments(api,body,model)
paths=Paths(api,model);original=paths.simple;bindings=[];records=[]
src=Source(p['source']);check_artifacts([p['artifact']]);check_layouts([p['artifact']]);c=C(src,p['artifact']);f=src.program['functions']['select'];outsort=src.sort(f['result'])
context=z.Const('typed_context',src.sort(f['args'][0]));codecs=Codecs(src,{'name':'collection-store','headerName':'collection-store.h','schema':schema,'native':p['artifact']['c'],'codecs':Path(files['collection-store.wire.h']).read_text()})
byte_inputs=[z.Extract(7,0,paths.input('instruction_byte_'+str(i+1),8)) for i in range(codecs.sizes[f['args'][2]])]
decode_ok,instruction=codecs.decode(f['args'][2],byte_inputs)
state_bytes=[z.Extract(7,0,paths.input('data_'+str(20+i),8)) for i in range(codecs.sizes[f['args'][1]])]
stored_ok,stored_state=codecs.decode(f['args'][1],state_bytes)
initial_ok,initial_state=codecs.decode(f['args'][1],[z.BitVecVal(0,8)]*len(state_bytes))
state=z.If(paths.input('initialize')!=0,initial_state,stored_state)
record_bytes=[[z.Extract(7,0,paths.input('record_'+str(i)+'_byte_'+str(j),8)) for j in range(4)] for i in range(2)]
record_decoded=[codecs.decode('U32',row) for row in record_bytes]

original_call=paths.call
def call(self,name,args):
 if name=='bend_Instruction_decode':
  pc=self.pc;lhs=z.Extract(0,0,self.input('instruction_decode',1));rhs=z.If(decode_ok,z.BitVecVal(1,1),z.BitVecVal(0,1));equation=z.Implies(pc,lhs==rhs)
  self.constraints.append(equation);bindings.append((pc,lhs,rhs,equation))
 if name=='bend_State_decode' or name=='bend_U32_decode':
  a=[''.join(row) for row in args];pc=self.pc
  if name=='bend_State_decode':
   initial=a[0]=='empty';label='state_decode_initial' if initial else 'state_decode_stored';ok=initial_ok if initial else stored_ok
  else:
   index=0 if a[2].endswith('f0') else 1;label='record_decode_'+str(index);ok=record_decoded[index][0]
  lhs=z.Extract(0,0,self.input(label,1));rhs=z.If(ok,z.BitVecVal(1,1),z.BitVecVal(0,1));equation=z.Implies(pc,lhs==rhs)
  self.constraints.append(equation);bindings.append((pc,lhs,rhs,equation))
 if name in ('bend_State_encode','bend_U32_encode'):
  pc=self.pc;a=[''.join(row) for row in args]
  if name=='bend_State_encode':
   label='state_encode';prefix='encoded_state_byte_';kind=f['args'][1];value=self.actual_next_state
  else:
   index=0 if a[0].endswith('+0') else 1;label='record_encode_'+str(index);prefix='encoded_record_'+str(index)+'_byte_';kind='U32';value=self.actual_next_records[index]
  ok,encoded=codecs.encode(kind,value)
  pairs=[(z.Extract(0,0,self.input(label,1)),z.If(ok,z.BitVecVal(1,1),z.BitVecVal(0,1)))]
  pairs.extend((z.Extract(7,0,self.input(prefix+str(i),8)),byte) for i,byte in enumerate(encoded))
  for lhs,rhs in pairs:
   equation=z.Implies(pc,lhs==rhs);self.constraints.append(equation);bindings.append((pc,lhs,rhs,equation))
 return original_call(name,args)
paths.call=types.MethodType(call,paths)
def simple(self,tokens):
 if 'selection=bend_select(' in ''.join(tokens):
  pc=self.pc;metadata=src.sort(f['args'][3]).constructor(0)(self.opened_length,self.opened_capacity)
  result=c.call(mangle('select'),[context,state,instruction,metadata],pc);valid=outsort.recognizer(1)(result);range_value=outsort.accessor(1,0)(result);rs=range_value.sort()
  pairs=[(self.u32('selection_tag'),z.If(valid,z.BitVecVal(1,32),z.BitVecVal(0,32))), (self.u32('range_tag'),z.BitVecVal(0,32)),(self.u32('selector_start'),rs.accessor(0,0)(range_value)),(self.u32('selection_count'),rs.accessor(0,1)(range_value))]
  for index,(lhs,rhs) in enumerate(pairs):
   guard=pc if index==0 else z.And(pc,valid);equation=z.Implies(guard,lhs==rhs);self.constraints.append(equation);bindings.append((guard,lhs,rhs,equation))
  records.append((pc,valid,result))
 if 'result=bend_process(' in ''.join(tokens):
  pc=self.pc;rootf=src.program['functions']['process'];wt=src.sort(rootf['args'][4]);vector_type=src.types[rootf['args'][4]]['variants'][0]['fields'][1]['type'];vt=src.sort(vector_type);pair_type=src.types[vector_type]['variants'][0]['fields'][1]['type'];pt=src.sort(pair_type)
  loaded=z.Extract(31,0,self.variables['value_loaded']);start=z.Extract(31,0,self.variables['value_start'])
  cells=[z.If(z.UGT(loaded,i),record_decoded[i][1],z.BitVecVal(0,32)) for i in range(2)]
  window=wt.constructor(0)(start,vt.constructor(0)(loaded,pt.constructor(0)(*cells)))
  metadata=src.sort(rootf['args'][3]).constructor(0)(self.opened_length,self.opened_capacity)
  result=c.call(mangle('process'),[context,state,instruction,metadata,window],pc);rs=src.sort(rootf['result']);accepted=rs.recognizer(0)(result);after=rs.accessor(0,1)(result);vs=wt.accessor(0,1)(after)
  self.actual_next_state=rs.accessor(0,0)(result);output_storage=vt.accessor(0,1)(vs);self.actual_next_records=[pt.accessor(0,i)(output_storage) for i in range(2)]
  pairs=[(self.u32('result_tag'),z.If(accepted,z.BitVecVal(0,32),z.BitVecVal(1,32)),pc),(self.u32('code'),rs.accessor(1,0)(result),z.And(pc,z.Not(accepted)))]
  success=z.And(pc,accepted)
  pairs.extend((self.u32(name),value,success) for name,value in [('window_tag',z.BitVecVal(0,32)),('vector_tag',z.BitVecVal(0,32)),('pair_tag',z.BitVecVal(0,32)),('after_start',wt.accessor(0,0)(after)),('written',vt.accessor(0,0)(vs)),('next',rs.accessor(0,2)(result))])
  for lhs,rhs,guard in pairs:
   equation=z.Implies(guard,lhs==rhs);self.constraints.append(equation);bindings.append((guard,lhs,rhs,equation))
 return original(tokens)
paths.simple=types.MethodType(simple,paths);proofs=paths.prove(body);assert len(records)==1 and len(bindings)==33
bindings=[tuple(z.simplify(v) for v in row) for row in bindings]
assert all(z.is_const(lhs) and lhs.decl().kind()==z.Z3_OP_UNINTERPRETED for _,lhs,_,_ in bindings)
assert len({lhs.get_id() for _,lhs,_,_ in bindings})==len(bindings)
replacement=[]
for i,(guard,lhs,rhs,_) in enumerate(bindings):
 forbidden={later.get_id() for _,later,_,_ in bindings[i:]}
 assert not references_output(guard,forbidden) and not references_output(rhs,forbidden)
 replacement.append((lhs,z.substitute(rhs,*replacement) if replacement else rhs))
solver=z.Solver();solver.set(timeout=30000);solver.add(z.Not(z.substitute(z.And(*[eq for *_,eq in bindings]),*replacement)));assert solver.check()==z.unsat
pc,valid,result=records[0];solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,paths.events['selector'],z.Not(decode_ok));assert solver.check()==z.unsat
solver=z.Solver();solver.set(timeout=30000);solver.add(z.Or(*c.bad,*src.dead));assert solver.check()==z.unsat
witnesses=[]
for name,event in [('selector',paths.events['selector']),('root',paths.events['root']),('commit',paths.events['commit'])]:
 solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,event);status=solver.check();assert status==z.sat,(name,status);witnesses.append({'name':name,'result':'sat'})
solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,paths.input('initialize')==0,z.Not(stored_ok),paths.events['root']);assert solver.check()==z.unsat
state_sort=src.sort(f['args'][1]);old_calls=state_sort.accessor(0,0)(state)
encoded_calls=z.Concat(*[z.Extract(7,0,paths.input('encoded_state_byte_'+str(i),8)) for i in (4,3,2,1)])
solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,paths.events['state_payload_write'],encoded_calls!=old_calls+1);assert solver.check()==z.unsat
solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,paths.events['state_payload_write'],paths.input('encoded_state_byte_0',8)!=0);assert solver.check()==z.unsat
semantic_claims=[]
isort=src.sort(f['args'][2]);attack=isort.recognizer(2)(instruction);mode=isort.accessor(2,0)(instruction)
for value in (0,1,2):
 condition=z.And(attack,mode==value)
 for label,event,wanted in [('refuses-commit',paths.events['commit'],z.unsat),('root-reachable',paths.events['root'],z.sat)]:
  solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,condition,event);status=solver.check();assert status==wanted,(value,label,status)
  semantic_claims.append({'name':'invalid-window-'+str(value)+'-'+label,'result':str(status)})
for tag,label in [(0,'append'),(1,'replace')]:
 solver=z.Solver();solver.set(timeout=30000);solver.add(*paths.constraints,isort.recognizer(tag)(instruction),paths.events['commit']);status=solver.check();assert status==z.sat,(label,status)
 semantic_claims.append({'name':label+'-commit-reachable','result':'sat'})
for name,h in p['sourceHashes'].items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h
output=Path(sys.argv[2]);assert not output.exists();assert input_path.read_bytes()==raw
for name,h in {**data['sourceHashes'],**data['artifactHashes']}.items():assert hashlib.sha256(Path(name).read_bytes()).hexdigest()==h,name
report={'passed':True,'endToEndVerified':False,'version':1,'z3':z.get_version_string(),'runId':data['runId'],
 'inputSha256':hashlib.sha256(raw).hexdigest(),'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 'sourceHashes':data['sourceHashes'],'lowering':lowering,'callerProofs':proofs,'bindingNames':[str(lhs) for _,lhs,_,_ in bindings],
 'callerClaims':len(proofs),'bindingOutputs':33,'claims':[{'name':name,'result':'unsat'} for name in CLAIMS],
 'witnesses':witnesses,'semanticClaims':semantic_claims,'scope':SCOPE}
validate(report,data,raw);unchanged(data)
with output.open('x') as stream:stream.write(json.dumps(report,indent=2)+'\n')
print('Collection root: 26 function checks, 183 caller obligations, 33 bindings; complete report validated')
