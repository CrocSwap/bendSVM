"""Actual emitted caller custody connection and semantic failure controls.

Pure root/codec summaries remain abstract in this child. The positive child
checks the complete actual-root composition separately.
"""
if not __debug__:raise RuntimeError('assertions required')
import sys,hashlib,json
from pathlib import Path
sys.path.insert(0,'verification')
import multi_adapter_contract as m
from cpi_caller import custody
z=m.z3
api=custody
inp=Path(sys.argv[1]);out=Path(sys.argv[2]);out.unlink(missing_ok=True);data=json.loads(inp.read_text());rows=[]
paths=[inp,Path(__file__),*Path('verification').rglob('*.py')]
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
inputs={str(p):sha(p) for p in paths}
assert __debug__ and z.get_version_string()=='5.1.0'
for f in data['fixtures']:
 s=m.summarize(f['schema'],f['interface']);dependencies,wire=m.audit_dependencies(s,f['adapter'],f['files'])
 accepted=next(t for t in s['_schema']['types'] if t['name']==s['result_name']);av=next(v for v in accepted['variants'] if v['tag']==s['accepted']);effects_name=av['fields'][1]['type']
 tokens=m.extract_entrypoint(f['files'][f['adapter']],wire,s['effect_header'],True,s['types'][s['effect_type']]['cType'],s['types'][effects_name]['cType'],s['slot_type'])
 parser=m.MultiParser(tokens,{'u8','u32','u64','unsigned','Account','BendClock',s['slot_type']} | {t['cType'] for t in s['types'].values() if t['kind']=='adt'});body=[]
 while parser.peek()!='}':body.append(parser.statement())
 parser.take('}');assert parser.at==len(tokens)
 fixture_rows=[]
 for fault in (None,'missing-result','wrong-bump','wrong-seed','wrong-program','wrong-custody'):
  class World(m.MultiWorld):
   def __init__(self,summary):
    super().__init__(summary)
    self.key_sort=z.BitVecSort(256)
    self.KEY=[z.BitVec('key'+str(i),256) for i in range(summary['accounts'])]
    self.OWNER=[z.BitVec('owner'+str(i),256) for i in range(summary['accounts'])]
    self.PROGRAM=z.BitVec('program',256)
    self.key_encoding=lambda key:key
    parsed=api.parse(f['files'])
    actual,bump,expected=api.outputs(parsed,self.KEY,self.PROGRAM)
    self.SETUP=actual;self.BUMP=bump
    if fault=='missing-result':self.SETUP=z.BitVec('unbound_custody_result',64)
    if fault=='wrong-bump':self.BUMP=bump ^ z.BitVecVal(1,8)
    if fault=='wrong-program':self.SETUP=api.outputs(parsed,self.KEY,self.PROGRAM ^ z.BitVecVal(1,256))[0]
    if fault=='wrong-seed':self.SETUP=api.outputs({**parsed,'seedAccount':1},self.KEY,self.PROGRAM)[0]
    if fault=='wrong-custody':self.SETUP=api.outputs({**parsed,'custodyAccount':4},self.KEY,self.PROGRAM)[0]
    self.expected=z.And(expected,self.BUMP==bump)
   def key_bytes(self,i):return self.KEY[i]
  w=World(s);m.MultiExec(w).run(body)
  success=z.Or(*[z.And(p.pc,p.ret==0) for p in w.paths])
  solver=w.solver();solver.set(timeout=30000);solver.add(success,z.Not(w.expected));status=solver.check()
  wanted=z.unsat if fault is None else z.sat
  assert status==wanted,(f['name'],fault,str(status),solver.reason_unknown())
  row={'fault':fault,'result':str(status),'paths':len(w.paths)}
  if fault is not None:row['countermodel']=m.complete_model(solver.model())
  else:
   solver=w.solver();solver.set(timeout=30000);solver.add(success);assert solver.check()==z.sat
   row['successWitness']='sat'
  fixture_rows.append(row);print(f['name'],fault,status,flush=True)
 rows.append({'name':f['name'],'cases':fixture_rows,'adapterSha256':hashlib.sha256(f['files'][f['adapter']].encode()).hexdigest()})
assert all(sha(Path(p))==h for p,h in inputs.items()),'source drift'
out.write_text(json.dumps({'passed':True,'scope':__doc__,'rows':rows,'inputs':inputs},indent=2)+'\n')
