from pathlib import Path
import sys,json,runpy,hashlib
sys.path.insert(0,'verification')
import z3 as z
entry=runpy.run_path('verification/collection_entry/connect-summary.py',run_name='__main__');run=entry['run'];saved=sys.argv
try:
 sys.argv=['verification/collection_root_semantic.py',entry['cr']['inputArtifact'],str(run/'root-replay.json')]
 core=runpy.run_path('verification/collection_root_semantic.py',run_name='__main__')
finally:sys.argv=saved
paths=core['paths'];dispatch=entry['paths'].events['dispatch'];wire=entry['wire'];v=lambda x:z.BitVecVal(x,64);bindings=[]
def byte(at):return z.Select(wire,at)
def field(i,name):return entry['instantiate'](entry['ns']['actual'][name],entry['records'][i]['at'])
def address(i,name):return entry['records'][i]['at']+field(i,name)
def boolv(condition,width):return z.If(condition,z.BitVecVal(1,width),z.BitVecVal(0,width))
def bind(name,bits,value):
 assert name in paths.inputs,('unused input',name)
 lhs=paths.input(name,bits);lhs=z.Extract(bits-1,0,lhs) if bits<64 else lhs;lhs=z.simplify(lhs)
 equation=z.Implies(dispatch,lhs==value);bindings.append((lhs,value,equation))
program=entry['cursor']+v(8)+entry['scalar'](entry['cursor'])
assert z.eq(paths.input('mode',8),entry['paths'].input('mode',8))
bind('initialize',32,boolv(byte(entry['cursor']+v(8))==0,32))
for i,prefix in [(0,''),(2,'collection_')]:
 bind('state_size' if i==0 else 'collection_size',64,field(i,'size'))
 for name in ['signer','writable','executable']:bind(prefix+name,32 if i==0 else 1,boolv(field(i,name),32 if i==0 else 1))
 equal=z.And(*[byte(address(i,'owner')+v(k))==byte(program+v(k)) for k in range(32)])
 bind(prefix+'owner_equal',1,boolv(equal,1))
for i in range(25):bind('data_'+str(i),8,byte(address(0,'data')+v(i)))
for i in range(1,10):bind('instruction_byte_'+str(i),8,byte(entry['cursor']+v(8+i)))
assert len(bindings)==45
constraints=entry['paths'].constraints+[z.Implies(dispatch,q) for q in paths.constraints]+[eq for _,_,eq in bindings]
commits=z.And(dispatch,paths.events['commit']);rows=[]
def prove(name,condition):
 solver=z.Solver();solver.set(timeout=60000);solver.add(*constraints,z.Not(condition));status=solver.check();print(name,status,flush=True);assert status==z.unsat,(name,status,solver.reason_unknown());rows.append({'name':name,'result':str(status)})
# Independent byte-level necessary conditions for a committed handler call.
for i,label in [(0,'state'),(2,'collection')]:
 start=entry['records'][i]['at']
 owned=z.And(*[byte(start+v(40+k))==byte(program+v(k)) for k in range(32)])
 prove(label+'-owner-at-commit',z.Implies(commits,owned))
 prove(label+'-writable-at-commit',z.Implies(commits,byte(start+v(2))!=0))
 prove(label+'-not-executable-at-commit',z.Implies(commits,byte(start+v(3))==0))
 prove(label+'-initializer-signed',z.Implies(z.And(commits,byte(entry['cursor']+v(8))==0),byte(start+v(1))!=0))
# A concrete choice of metadata makes this an existential witness, not an added proof precondition.
solver=z.Solver();solver.set(timeout=60000);solver.add(*constraints,commits)
for i,n in enumerate([25,7,68]):solver.add(field(i,'size')==v(n))
solver.add(byte(entry['cursor']+v(8))==0)
status=solver.check();print('initializing-commit-witness',status,flush=True);assert status==z.sat,(status,solver.reason_unknown())
entry['loader_unchanged'](entry['ld']);entry['collection_unchanged'](entry['cd'])
(run/'metadata.json').write_text(json.dumps({'passed':True,'bindings':[str(lhs) for lhs,_,_ in bindings],'claims':rows,'initializingCommitWitness':'sat','loaderInputSha256':entry['lr']['inputSha256'],'collectionInputSha256':entry['cr']['inputSha256'],
 'scope':'Exploratory serialized entry-to-run metadata, state bytes and instruction bytes. Retains abstract collection content/header/key/zero observations and record payloads; no complete byte-memory or SBF proof.'},indent=2)+'\n');print(run)
