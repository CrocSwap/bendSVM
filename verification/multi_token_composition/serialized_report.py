"""Exact serialized/precommit evidence inventory and saved witness replay."""
from pathlib import Path
import json
import z3 as z
from loader_report import validate as loader_validate,unchanged
from multi_token_composition.common import sha,need,NAMES
from multi_token_composition.pda_witness import rewrite

def validate(rows,fixtures,folder,extra):
 from multi_token_composition.report import exact
 import multi_adapter_contract as m
 receipt=folder/'loader-receipt.json';r=json.loads(receipt.read_text())
 raw=Path(r['inputArtifact']).read_bytes();inp=json.loads(raw)
 exact(sha(r['inputArtifact']),r['inputSha256']);exact(sha(r['reportArtifact']),r['reportSha256'])
 loader_validate(json.loads(Path(r['reportArtifact']).read_text()),inp,raw)
 loader_validate(json.loads((folder/'loader-replay.json').read_text()),inp,raw);unchanged(inp)
 from multi_token_composition.physical_phase_report import validate as validate_physical
 validate_physical(rows,fixtures,folder,extra)
 exact([row['name'] for row in rows],NAMES)
 for row,f in zip(rows,fixtures):
  exact(sorted(row),sorted(['name','fullRootComposition','initialViews','precommit','helperPreservationCuts','activeWitnesses','physical']))
  n=int(row['name'][-1]);summary=m.summarize(f['schema'],f['interface']);sizes={s['index']:s['stateBytes'] for s in summary['fields']}
  exact([(v['sequence'],v['account']) for v in row['initialViews']],[(s,i) for s in range(2**n) for i in range(12)])
  proved=set()
  for v in row['initialViews']:
   exact(sorted(v),['account','result','reusedFrom','sequence']);exact(v['result'],'unsat')
   if v['reusedFrom'] is None:proved.add((v['sequence'],v['account']))
   else:
    need(type(v['reusedFrom']) is list and len(v['reusedFrom'])==2,'invalid view reuse')
    need(tuple(v['reusedFrom']) in proved and v['reusedFrom'][1]==v['account'],'view reuse without prior fresh proof')
  exact(sorted(proved),[(0,i) for i in range(12)])
  exact(row['helperPreservationCuts'],{'token-2':64,'token-3':384,'token-4':2048}[row['name']])
  exact(row['precommit'],[{'sequence':s,'account':i,'result':'unsat','managedBytes':size} for s in range(2**n) for i,size in sizes.items()])
  exact([w['mode'] for w in row['activeWitnesses']],[0,1])
  for w in row['activeWitnesses']:
   exact(sorted(w),sorted(['queryArtifact','querySha256','mode','result','model','scalarPins','pdaApplicationPins']))
   exact(w['result'],'sat');need(type(w['model']) is list and bool(w['model']),'missing serialized witness model')
   need(type(w['scalarPins']) is list and bool(w['scalarPins']),'missing scalar witness pins')
   key=z.BitVec('account0_key_bytes',256);program=z.BitVec('program_id_bytes',256);decls={'account0_key_bytes':key,'program_id_bytes':program}
   for name,width in [('custody_pda_result',64),('custody_pda_key',256),('custody_pda_bump',8)]:decls[name]=z.Function(name,z.BitVecSort(256),z.BitVecSort(256),z.BitVecSort(width))
   equations=[]
   for p in w['pdaApplicationPins']:
    exact(sorted(p),['term','value']);equations.append(z.parse_smt2_string('(assert (= '+p['term']+' '+p['value']+'))',decls=decls)[0])
   exact(len(equations),3);pairs=[(e.arg(0),e.arg(1)) for e in equations]
   exact(sorted(str(a.decl().name()) for a,b in pairs),['custody_pda_bump','custody_pda_key','custody_pda_result'])
   need(all(z.eq(a.arg(0),key) and z.eq(a.arg(1),program) for a,b in pairs),'PDA seed provenance')
   rewrite(equations,pairs)
   pins={p['name']:p['value'] for p in w['scalarPins']};values={str(a.decl().name()):b.as_long() for a,b in pairs}
   exact(values['custody_pda_result'],0);exact(values['custody_pda_key'],int(pins['account3_key_bytes']))
   query=folder/(row['name']+'-mode'+str(w['mode'])+'.smt2');exact(w['queryArtifact'],str(query));exact(w['querySha256'],sha(query))
   solver=z.Solver();solver.set(timeout=120000);solver.add(z.parse_smt2_file(str(query)))
   need(solver.check()==z.sat,'saved serialized witness replay not SAT')
