from pathlib import Path
import sys,json,hashlib,runpy,uuid
if not __debug__:raise RuntimeError('collection binding assertions required')
sys.path.insert(0,'verification')
import z3 as z
from collection_root_report import unchanged,validate,sha
input_path=Path(sys.argv[1]);report_path=Path(sys.argv[2]);output=Path(sys.argv[3]);assert not output.exists()
raw=input_path.read_bytes();data=json.loads(raw);report_raw=report_path.read_bytes();validate(json.loads(report_raw),data,raw);unchanged(data)
replay=input_path.parent/('binding-replay-'+str(uuid.uuid4())+'.json')
saved=sys.argv
try:
 sys.argv=['verification/collection_root_semantic.py',str(input_path),str(replay)]
 ns=runpy.run_path('verification/collection_root_semantic.py',run_name='__main__')
finally:sys.argv=saved
bindings,paths=ns['bindings'],ns['paths']
ids={eq.get_id() for *_,eq in bindings};base=[q for q in paths.constraints if z.simplify(q).get_id() not in ids]
original=[eq for *_,eq in bindings];controls=[];inactive=[]
def solve(extra,equations=original):
 solver=z.Solver();solver.set(timeout=30000);solver.add(*base,*equations,extra);status=solver.check();assert status!=z.unknown,solver.reason_unknown();return status,solver
for i,(guard,lhs,rhs,eq) in enumerate(bindings):
 status,_=solve(guard)
 if status==z.unsat:
  inactive.append({'output':str(lhs),'guard':'unsat'});continue
 status,solver=solve(z.And(guard,lhs!=rhs),original[:i]+original[i+1:]);assert status==z.sat,(str(lhs),status)
 controls.append({'name':'missing-'+str(lhs),'result':'sat','witness':str(solver.model())})
for field,event in [('encoded_state_byte_1','state_payload_write'),('encoded_state_byte_4','state_payload_write'),('encoded_record_0_byte_0','commit')]:
 i=next(i for i,(_,lhs,_,_) in enumerate(bindings) if str(lhs)==field);guard,lhs,rhs,_=bindings[i]
 wrong=z.Implies(guard,lhs==rhs+1)
 status,solver=solve(z.And(paths.events[event],lhs!=rhs),original[:i]+[wrong]+original[i+1:]);assert status==z.sat,(field,status)
 controls.append({'name':'wrong-'+field,'result':'sat','witness':str(solver.model())})
assert len(controls)==29
assert {r['output'] for r in inactive}=={'record_decode_1','code','record_encode_1',*[f'encoded_record_1_byte_{i}' for i in range(4)]}
unchanged(data);assert input_path.read_bytes()==raw and report_path.read_bytes()==report_raw
with output.open('x') as stream:stream.write(json.dumps({'passed':True,'inputSha256':sha(raw),'reportSha256':sha(report_raw),
 'checkerSha256':sha(Path(__file__).read_bytes()),'replayArtifact':str(replay),'replaySha256':sha(replay.read_bytes()),'outputs':len(bindings),'controls':controls,'inactive':inactive,
 'scope':'Binding sensitivity with exact original caller premises and actual C semantics. Unreachable fields are recorded explicitly, not counted as detected mutations.'},indent=2)+'\n')
print(len(controls),'binding controls;',len(inactive),'inactive outputs')
