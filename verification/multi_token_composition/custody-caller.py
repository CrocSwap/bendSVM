"""Actual emitted caller custody connection and semantic failure controls.

Pure root/codec summaries remain abstract in this child. The positive child
checks the complete actual-root composition separately.
"""
import sys,hashlib
sys.path.insert(0,'verification')
import multi_adapter_contract as m
import token_custody
from multi_token_composition.common import begin,finish
z=m.z3
custody={'parse':token_custody.parse,'outputs':token_custody.outputs}
data,binding,out=begin(sys.argv[1],sys.argv[2]);rows=[]
for f in data['fixtures']:
 s=m.summarize(f['schema'],f['interface']);dependencies,wire=m.audit_dependencies(s,f['adapter'],f['files'])
 accepted=next(t for t in s['_schema']['types'] if t['name']==s['result_name']);av=next(v for v in accepted['variants'] if v['tag']==s['accepted']);effects_name=av['fields'][1]['type']
 tokens=m.extract_entrypoint(f['files'][f['adapter']],wire,s['effect_header'],True,s['types'][s['effect_type']]['cType'],s['types'][effects_name]['cType'],s['slot_type'])
 parser=m.MultiParser(tokens,{'u8','u32','u64','unsigned','Account','BendClock',s['slot_type']} | {t['cType'] for t in s['types'].values() if t['kind']=='adt'});body=[]
 while parser.peek()!='}':body.append(parser.statement())
 parser.take('}');assert parser.at==len(tokens)
 fixture_rows=[]
 for fault in (None,'missing-result','wrong-bump','missing-executable','wrong-program'):
  class World(m.MultiWorld):
   def __init__(self,summary):
    super().__init__(summary)
    self.key_sort=z.BitVecSort(256)
    self.KEY=[z.BitVec('key'+str(i),256) for i in range(summary['accounts'])]
    self.OWNER=[z.BitVec('owner'+str(i),256) for i in range(summary['accounts'])]
    self.PROGRAM=z.BitVec('program',256)
    self.key_encoding=lambda key:key
    parsed=custody['parse'](f['files'])
    actual,bump,expected=custody['outputs'](parsed,self)
    self.SETUP=actual;self.BUMP=bump
    if fault=='missing-result':self.SETUP=z.BitVec('unbound_custody_result',64)
    if fault=='wrong-bump':self.BUMP=bump ^ z.BitVecVal(1,8)
    if fault=='wrong-program':self.SETUP=custody['outputs']({**parsed,'tokenKey':parsed['tokenKey']^1},self)[0]
    if fault=='missing-executable':
     self.SETUP=z.substitute(actual,(self.EXECUTABLE[2],z.BoolVal(True)))
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
finish(data,binding,out,'custody-caller',rows)
