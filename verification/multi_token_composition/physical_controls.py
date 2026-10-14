"""Physical report refusal controls, independently checking exact diagnostics."""
import copy
import multi_adapter_contract as adapter
from multi_token_composition.physical_report import physical as validate
from multi_token_composition.common import need

NAMES=['missing-physical-component', 'missing-precommit-memory', 'different-precommit-memory', 'missing-memory-selection-proof', 'missing-memory-projection-control', 'missing-representation', 'outside-data-overclaim', 'missing-active-parse', 'missing-write-success', 'wrong-root-order', 'unknown-range-result', 'unknown-snapshot-domain', 'missing-managed-bound', 'missing-managed-counterexample', 'shifted-physical-write', 'wrong-physical-account', 'missing-physical-write', 'missing-store-instance']

def check(rows,fixtures):
 need(__debug__,'assertions required');controls=[]
 for row,f in zip(rows,fixtures):
  summary=adapter.summarize(f['schema'],f['interface'])
  managed=[x['index'] for x in summary['fields']]
  lengths={x['index']:x['stateBytes'] for x in summary['fields']}
  validate(row['physical'],int(row['name'][-1]),managed,lengths)
 summary=adapter.summarize(fixtures[0]['schema'],fixtures[0]['interface'])
 managed=[x['index'] for x in summary['fields']]
 lengths={x['index']:x['stateBytes'] for x in summary['fields']}
 original=rows[0]['physical']
 def reject(name,change,reason):
  bad=copy.deepcopy(original);change(bad)
  try:validate(bad,2,managed,lengths)
  except ValueError as error:
   need(str(error)==reason,'unexpected physical refusal: '+name+': '+str(error))
   controls.append({'name':name,'reason':str(error)});return
  raise ValueError('accepted physical mutation: '+name)
 def write(r):return next(p for p in r['physicalCommit']['paths'] if p.get('steps'))
 reject('missing-physical-component',lambda r:r.pop('snapshotDomainResult'),'physical component inventory')
 reject('missing-precommit-memory',lambda r:r['physicalCommit'].pop('precommitMemorySha256'),'missing physical precommit memory')
 reject('different-precommit-memory',lambda r:r['physicalCommit'].update(precommitMemorySha256='0'*64),'selected/commit memory binding')
 reject('missing-memory-selection-proof',lambda r:r['memorySelection'].update(result='unknown'),'memory selection result')
 reject('missing-memory-projection-control',lambda r:r['memorySelection']['controls'].pop(),'memory selection controls')
 reject('missing-representation',lambda r:r['representations'].pop(),'physical representation inventory')
 reject('outside-data-overclaim',lambda r:r['representations'][0].update(outsideData='all helper bytes unchanged'),'outside-data scope')
 reject('missing-active-parse',lambda r:r['prefix']['activeParses'].pop(),'prefix parse inventory')
 reject('missing-write-success',lambda r:r['commitSuccess']['writePaths'].pop(),'commit success paths')
 reject('wrong-root-order',lambda r:r['selection'].update(rootBeforeAllWrites=False),'root ordering')
 reject('unknown-range-result',lambda r:r['ranges']['claims'][-1].update(result='unknown'),'claim result inventory')
 reject('unknown-snapshot-domain',lambda r:r.update(snapshotDomainResult='unknown'),'snapshot domain result')
 reject('missing-managed-bound',lambda r:r['managedDomain']['bounds'].pop(),'managed bound inventory')
 reject('missing-managed-counterexample',lambda r:r['managedDomain']['missingWidthBound'].update(countermodel=''),'managed domain witness')
 reject('shifted-physical-write',lambda r:write(r)['steps'][0].update(offset=999),'physical/parsed store binding')
 reject('wrong-physical-account',lambda r:write(r)['steps'][0].update(account=11),'physical/parsed store binding')
 reject('missing-physical-write',lambda r:write(r)['steps'].pop(),'physical/parsed store binding')
 reject('missing-store-instance',lambda r:r['physicalCommit'].update(storeTheoremInstances=0),'store theorem instance count')
 need([row['name'] for row in controls]==NAMES,'physical control inventory')
 return controls
