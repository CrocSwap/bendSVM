from pathlib import Path
import sys,json,runpy,hashlib
sys.path.insert(0,'verification')
import z3 as z
from semantic_binding import references_output
ns=globals().get('qualified_entry')
if ns is None:ns=runpy.run_path('verification/collection_entry/connect-summary.py',run_name='__main__')
paths=ns['paths'];wire=ns['wire'];run=ns['run'];bindings=[tuple(z.simplify(e) for e in row) for row in ns['bindings']]
v=lambda x:z.BitVecVal(x,64)
def byte(at):return z.Select(wire,at)
def le(at):return z.Concat(*[byte(at+v(k)) for k in range(7,-1,-1)])
def solve(name,condition,constraints):
 solver=z.Solver();solver.set(timeout=60000);solver.add(*constraints,condition);status=solver.check();print(name,status,flush=True)
 assert status!=z.unknown,(name,solver.reason_unknown());return status,solver
assert len({lhs.get_id() for _,lhs,_,_ in bindings})==9
replacement=[]
for i,(guard,lhs,rhs,_) in enumerate(bindings):
 assert z.is_const(lhs) and lhs.decl().kind()==z.Z3_OP_UNINTERPRETED
 forbidden={later.get_id() for _,later,_,_ in bindings[i:]};assert not references_output(guard,forbidden) and not references_output(rhs,forbidden)
 replacement.append((lhs,z.substitute(rhs,*replacement) if replacement else rhs))
status,_=solve('constructive-binding-extension',z.Not(z.substitute(z.And(*[eq for *_,eq in bindings]),*replacement)),[]);assert status==z.unsat
at=v(8);conditions=[le(v(0))==3];keys=[];starts=[]
for i in range(3):
 starts.append(at);conditions.append(byte(at)==255);key=z.Concat(*[byte(at+v(8+k)) for k in range(32)])
 conditions.extend(key!=other for other in keys);keys.append(key)
 length=le(at+v(80));at=at+v(88)+length+v(10240)+((-length)&v(7))+v(8)
conditions += [le(at)==10,z.ULE(byte(at+v(8)),z.BitVecVal(1,8))]
expected=z.And(*conditions)
status,_=solve('dispatch-matches-independent-byte-spec',paths.events['dispatch']!=expected,paths.constraints);assert status==z.unsat
ids={eq.get_id() for *_,eq in bindings};base=[q for q in paths.constraints if z.simplify(q).get_id() not in ids];equations=[eq for *_,eq in bindings];controls=[]
for i,(guard,lhs,rhs,_) in enumerate(bindings):
 status,solver=solve('missing-'+str(lhs),z.And(guard,lhs!=rhs),base+equations[:i]+equations[i+1:]);assert status==z.sat
 controls.append({'name':'missing-'+str(lhs),'result':'sat','witness':str(solver.model())})
ns['loader_unchanged'](ns['ld']);ns['collection_unchanged'](ns['cd'])
(run/'binding-checks.json').write_text(json.dumps({'passed':True,'extension':'unsat','independentDispatch':'unsat','controls':controls,'loaderInputSha256':ns['lr']['inputSha256'],'collectionInputSha256':ns['cr']['inputSha256'],'checkerSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},indent=2)+'\n');print(run)
