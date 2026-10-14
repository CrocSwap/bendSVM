"""Exact-query cache controls for the maintained physical proof workflow."""
from pathlib import Path
import json,uuid,hashlib,sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'verification'))
import z3 as z
from multi_token_composition import physical_cache

def check(folder):
 if not __debug__:raise RuntimeError('assertions required')
 if z.get_version_string()!='5.1.0':raise RuntimeError('Z3 5.1.0 required')
 run=Path(folder).resolve();run.mkdir()
 module_path=Path(physical_cache.__file__).resolve()
 P=physical_cache.Producer;C=physical_cache.Consumer
 sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
 sources={str(module_path):sha(module_path),str(Path(__file__).resolve()):sha(__file__)};qualification=str(uuid.uuid4());names=['reflexive','store-read']
 x=z.BitVec('cache_x',64);a=z.Array('cache_a',z.BitVecSort(64),z.BitVecSort(8));v=z.BitVec('cache_value',8)
 def queries():
  s=z.Solver();s.add(x!=x)
  t=z.Solver();t.add(z.Select(z.Store(a,x,v),x)!=v)
  return [s,t]
 producer=P(run/'proofs',qualification,sources,names)
 for name,solver in zip(names,queries()):producer.check(name,solver)
 receipt=producer.finish();consumer=C(receipt,qualification,sources,names)
 for name,solver in zip(names,queries()):consumer.check(name,solver)
 positive=consumer.finish();controls=[]
 def reject(name,fn,expected):
  try:fn()
  except ValueError as e:
   assert str(e)==expected,(name,str(e));controls.append({'name':name,'reason':str(e)});return
  raise AssertionError('accepted '+name)
 reject('different-qualification',lambda:C(receipt,'other',sources,names),'qualification mismatch')
 reject('different-sources',lambda:C(receipt,qualification,{'other':'0'*64},names),'source inventory mismatch')
 reject('missing-query',lambda:C(receipt,qualification,sources,names[:-1]),'query inventory')
 reject('wrong-manifest-hash',lambda:C({**receipt,'manifestSha256':'0'*64},qualification,sources,names),'manifest hash')
 reject('unfinished-consumer',lambda:C(receipt,qualification,sources,names).finish(),'incomplete lemma consumer')
 reject('reordered-query',lambda:C(receipt,qualification,sources,names).check(names[1],queries()[1]),'query order')
 bad=z.Solver();bad.add(x==1)
 reject('changed-query-formula',lambda:C(receipt,qualification,sources,names).check(names[0],bad),'query formula mismatch')
 reject('unfinished-producer',lambda:P(run/'unfinished',qualification,sources,names).finish(),'incomplete lemma producer')
 reject('sat-lemma',lambda:P(run/'sat',qualification,sources,['bad']).check('bad',bad),'lemma not UNSAT')
 raw=(run/'proofs/reflexive.smt2').read_bytes();(run/'proofs/reflexive.smt2').write_bytes(raw+b'\n')
 reject('changed-saved-query',lambda:C(receipt,qualification,sources,names),'saved query hash');(run/'proofs/reflexive.smt2').write_bytes(raw)
 consumer=C(receipt,qualification,sources,names)
 for name,solver in zip(names,queries()):consumer.check(name,solver)
 (run/'proofs/reflexive.smt2').write_bytes(raw+b'\n')
 reject('query-changed-after-reuse',consumer.finish,'consumer query drift');(run/'proofs/reflexive.smt2').write_bytes(raw)
 producer=P(run/'producer-drift',qualification,sources,names)
 for name,solver in zip(names,queries()):producer.check(name,solver)
 (run/'producer-drift/reflexive.smt2').write_text('changed')
 reject('query-changed-before-publication',producer.finish,'producer query drift')
 # Deliberate solver-result injection checks UNKNOWN handling without timing races.
 class UnknownSolver:
  def to_smt2(self):return queries()[0].to_smt2()
  def check(self):return z.unknown
  def reason_unknown(self):return 'unit injected unknown'
 unknown=P(run/'unknown',qualification,sources,['unknown'])
 reject('unknown-lemma',lambda:unknown.check('unknown',UnknownSolver()),'lemma not UNSAT')
 assert not (run/'unknown/manifest.json').exists()
 assert json.loads((run/'unknown/failed-unknown.json').read_text())['reasonUnknown']=='unit injected unknown'
 reject('unknown-producer-publication',unknown.finish,'incomplete lemma producer')
 manifest_path=run/'proofs/manifest.json';manifest_raw=manifest_path.read_bytes()
 consumer=C(receipt,qualification,sources,names)
 for name,solver in zip(names,queries()):consumer.check(name,solver)
 manifest_path.write_bytes(manifest_raw+b'\n')
 reject('manifest-changed-after-reuse',consumer.finish,'manifest drift');manifest_path.write_bytes(manifest_raw)
 for key,value in [('passed',1),('queries',[{'name':n,'result':'unknown','sha256':sha(run/'proofs'/(n+'.smt2'))} for n in names])]:
  manifest=json.loads(manifest_raw);manifest[key]=value;manifest_path.write_text(json.dumps(manifest))
  changed={**receipt,'manifestSha256':sha(manifest_path)}
  reject('invalid-manifest-'+key,lambda:C(changed,qualification,sources,names),'manifest shape' if key=='passed' else 'query result')
  manifest_path.write_bytes(manifest_raw)
 assert len(controls)==17
 for p,h in sources.items():assert sha(p)==h,'test source drift'
 report={'passed':True,'positive':positive,'controls':controls,'receipt':receipt,'sources':sources,'scope':'Cache evidence and rejection controls, including injected UNKNOWN; not an independent semantic proof.'}
 (run/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 return report

if __name__=='__main__':
 if not __debug__:raise RuntimeError('assertions required')
 if len(sys.argv)>2:raise ValueError('usage: physical-proof-cache.py [OUTPUT_PARENT]')
 parent=Path(sys.argv[1] if len(sys.argv)==2 else 'build/physical-proof-cache').resolve()
 parent.mkdir(parents=True,exist_ok=True)
 folder=parent/('run-'+str(uuid.uuid4()))
 result=check(folder)
 print(str(folder/'report.json'))
