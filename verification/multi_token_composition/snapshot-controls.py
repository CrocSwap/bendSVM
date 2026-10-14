"""Check actual managed snapshot construction and byte-binding failures."""
from pathlib import Path
from types import SimpleNamespace
import sys,json,hashlib
sys.path.insert(0,'verification')
import multi_adapter_contract as m
from multi_token_composition.common import begin,finish
z=m.z3
data,binding,out=begin(sys.argv[1],sys.argv[2])
source=Path('verification/multi_token_composition/model.py');raw=source.read_bytes();text=raw.decode()
start=text.index('   tm=validation.model;owners=');end=text.index('   account_pairs=',start)
block='\n'.join(line[3:] for line in text[start:end].splitlines())
assert block.count('account_data=z.Store(')==1
rows=[];v=lambda n:z.BitVecVal(n,64);v32=lambda n:z.BitVecVal(n,32)
for fixture in data['fixtures']:
 summary=m.summarize(fixture['schema'],fixture['interface']);sizes={f['index']:f['stateBytes'] for f in summary['fields']}
 w=SimpleNamespace(OWNER=[z.BitVec('owner'+str(i),256) for i in range(12)],D=[[z.BitVec('D_'+str(i)+'_'+str(j),8) for j in range(sizes.get(i,0))] for i in range(12)],key_encoding=lambda key:key)
 tm=SimpleNamespace(account_owners=z.Array('owners',z.BitVecSort(32),z.BitVecSort(256)),account_data=z.Array('snapshot',z.BitVecSort(32),z.ArraySort(z.BitVecSort(32),z.BitVecSort(8))))
 validation=SimpleNamespace(model=tm);exec(compile(block,str(source),'exec'))
 wire=z.Array('wire',z.BitVecSort(64),z.BitVecSort(8));starts=[z.BitVec('start'+str(i),64) for i in range(12)];cases=[]
 for i in range(12):
  offset=z.BitVec('offset',32);view=z.Lambda(offset,z.Select(wire,starts[i]+z.ZeroExt(32,offset)))
  array_binding=z.Select(tm.account_data,v32(i))==view
  byte_bindings=[b==z.Select(wire,starts[i]+v(j)) for j,b in enumerate(w.D[i])]
  observed=z.Select(z.Select(account_data,v32(i)),v32(0));expected=z.Select(wire,starts[i])
  def check(name,premises,wanted):
   solver=z.Solver();solver.set(timeout=30000);solver.add(*premises,observed!=expected);status=solver.check();assert status==wanted,(fixture['name'],i,name,str(status),solver.reason_unknown())
   row={'account':i,'case':name,'result':str(status)}
   if status==z.sat:
    model=solver.model();row.update(actual=model.eval(observed).as_long(),expected=model.eval(expected).as_long());assert row['actual']!=row['expected']
   cases.append(row)
  check('baseline',[array_binding,*byte_bindings],z.unsat)
  if w.D[i]:
   check('missing-managed-byte',[array_binding,*byte_bindings[1:]],z.sat)
   shifted=w.D[i][0]==z.Select(wire,starts[i]+v(1))
   check('shifted-managed-byte',[array_binding,shifted,*byte_bindings[1:]],z.sat)
  else:check('missing-array-view',[],z.sat)
 rows.append({'fixture':fixture['name'],'cases':cases});print(fixture['name'],len(cases),'local snapshot cases passed',flush=True)
assert source.read_bytes()==raw
finish(data,binding,out,'snapshot-controls',rows)
