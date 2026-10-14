"""Strict staged physical evidence inventories; not a semantic proof kernel."""
import json

def need(ok,message):
 if not ok:raise ValueError(message)
def exact(a,b,message):need(json.dumps(a,sort_keys=True)==json.dumps(b,sort_keys=True),message)
def outcomes(rows,names,statuses):
 exact([r['name'] for r in rows],names,'claim inventory')
 exact([r['result'] for r in rows],statuses,'claim result inventory')
 for row,status in zip(rows,statuses):
  if status=='unsat':exact(sorted(row),['name','result'],'positive claim keys')
  else:
   witness='countermodel' if 'countermodel' in row else 'witness'
   exact(sorted(row),sorted(['name','result',witness]),'negative claim keys')
   need(type(row[witness]) is str and bool(row[witness]),'missing negative witness')
def range_names(generic=False):
 if not generic:return [n+str(i) for i in range(12) for n in ('caller-cursor-','caller-decoded-extent-')]+['caller-separated-'+str(i)+'-'+str(j) for i in range(12) for j in range(i+1,12)]
 return ['parsed-record-data-contained-before-next']+['parsed-extent-induction-'+str(i) for i in range(12)]+['active-cursor-input-bound-'+str(i) for i in range(12)]+['active-ordered-disjoint-data-'+str(i)+'-'+str(j) for i in range(12) for j in range(i+1,12)]+['active-managed-prefix-extent-'+str(i) for i in range(12)]+['active-managed-prefix-disjoint-'+str(i)+'-'+str(j) for i in range(12) for j in range(i+1,12)]+['forward-store-preserves-other-record','reverse-store-preserves-other-record']
def ranges(row):
 exact(sorted(row),['claims','scope'],'range keys');outcomes(row['claims'],range_names(),['unsat']*90)
 need(type(row['scope']) is str and bool(row['scope']),'range scope')
def snapshots(row):
 exact(sorted(row),['claims','nonemptyTwelveAccountWitness'],'snapshot keys')
 names=['stage-'+str(k)+'-account-'+str(i) for k in range(12) for i in range(k+1)]+['outside-all-active-data-preserved','omitted-first-snapshot','omitted-separation']
 outcomes(row['claims'],names,['unsat']*79+['sat']*2);exact(row['nonemptyTwelveAccountWitness'],'sat','snapshot nonempty')
def selection(row,n):
 exact(sorted(row),['controls','result','rootBeforeAllWrites','scope','sequences','writePaths'],'selection keys')
 total={2:70,3:148,4:312}[n];count=2**n
 exact(row['result'],'unsat','selection result');exact(row['rootBeforeAllWrites'],True,'root ordering')
 exact(row['sequences'],count,'sequence count');exact(row['writePaths'],list(range(total-count,total)),'writing path inventory')
 exact([c['name'] for c in row['controls']],['omitted-live-sequence','duplicated-live-sequence'],'selection controls')
 for c in row['controls']:
  exact(sorted(c),['countermodel','name','result','selectedSequence'],'selection control keys');exact(c['result'],'sat','selection counterexample')
  need(type(c['selectedSequence']) is int and 0<=c['selectedSequence']<count,'selected sequence bound')
  need(type(c['countermodel']) is str and bool(c['countermodel']),'selection witness')
 exact(row['controls'][0]['selectedSequence'],row['controls'][1]['selectedSequence'],'same reachable sequence')
def bounds(rows,n,managed,lengths):
 total={2:70,3:148,4:312}[n];paths=list(range(total-2**n,total))
 exact([(r['path'],r['account']) for r in rows],[(p,i) for p in paths for i in managed],'managed bound inventory')
 proved=set()
 for r in rows:
  exact(sorted(r),['account','firstProof','managedBytes','path','result'],'managed bound keys')
  exact(r['result'],'unsat','managed bound result');exact(r['managedBytes'],lengths[r['account']],'managed byte width')
  pair=(r['path'],r['account']);ref=tuple(r['firstProof']);need(ref==pair or ref in proved,'forward managed bound reuse');need(len(ref)==2 and ref[1]==r['account'],'cross-account bound reuse');proved.add(pair)
def primitive_ranges(row):
 exact(sorted(row),['claims','controls','witness'],'primitive range keys')
 outcomes(row['claims'],range_names(True),['unsat']*171)
 outcomes(row['controls'],['omitted-data-length-overlaps-next-record','omitted-span-separation'],['sat']*2)
 exact(row['witness'],'sat','range nonempty')

def commit(row,certificate,n):
 exact(sorted(row),['byteSteps','freshStoreTheorems','paths','scope','storeTheoremInstances'],'physical commit keys')
 steps={2:82,3:139,4:196}[n]
 exact(row['byteSteps'],steps,'physical byte count');exact(row['freshStoreTheorems'],2,'fresh store theorem count')
 exact(row['storeTheoremInstances'],steps*n,'store theorem instance count')
 exact([p['path'] for p in row['paths']],list(range(len(certificate['paths']))),'physical path inventory')
 exact(certificate['byteSteps'],steps,'certificate byte count')
 for physical,parsed in zip(row['paths'],certificate['paths']):
  exact(physical['path'],parsed['path'],'physical/parsed path binding')
  if 'reuse' in parsed:
   exact(sorted(physical),['path','reuse'],'physical reuse keys');exact(physical['reuse'],parsed['reuse'],'physical/parsed reuse binding')
  else:
   exact(sorted(physical),['finalProjection','path','physicalStores','steps'],'physical path keys')
   exact(physical['finalProjection'],'exact-byte-ast','physical final projection')
   expected=[{k:s[k] for k in ('event','account','offset')} for s in parsed['steps']]
   exact(physical['steps'],expected,'physical/parsed store binding');exact(physical['physicalStores'],len(expected),'physical store count')
 need(type(row['scope']) is str and bool(row['scope']),'physical commit scope')

def memory_selection(row,physical_commit,n):
 exact(sorted(row),['controls','result','scope','selectedMemorySha256','sequences'],'memory selection keys')
 exact(row['result'],'unsat','memory selection result');exact(row['sequences'],2**n,'memory selection count')
 digest=row['selectedMemorySha256'];need(type(digest) is str and len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'selected memory digest')
 exact(physical_commit.get('precommitMemorySha256'),digest,'selected/commit memory binding')
 exact([c['name'] for c in row['controls']],['missing-selection','missing-selected-projection'],'memory selection controls')
 for c in row['controls']:
  exact(sorted(c),['countermodel','name','result'],'memory selection control keys');exact(c['result'],'sat','memory selection counterexample')
  need(type(c['countermodel']) is str and bool(c['countermodel']),'memory selection witness')

def commit_v2(row,certificate,selected,n):
 # Validate the new handoff field before reusing the exact event validator.
 # A v1 envelope or a missing/null digest must not be accepted as v2.
 need('precommitMemorySha256' in row,'missing physical precommit memory')
 memory_selection(selected,row,n)
 legacy={k:v for k,v in row.items() if k!='precommitMemorySha256'}
 commit(legacy,certificate,n)

def physical(row,n,managed,lengths):
 expected=['commitBounds','commitSuccess','managedDomain','memorySelection','physicalCommit','prefix','ranges','representations','selection','snapshotDomainResult']
 exact(sorted(row),sorted(expected),'physical component inventory')
 total={2:70,3:148,4:312}[n];paths=list(range(total-2**n,total))
 prefix=row['prefix'];exact(sorted(prefix),['activeParses','maximumAccounts','minimumAccounts','result','scope'],'prefix keys')
 exact(prefix['result'],'unsat','prefix result');exact(prefix['minimumAccounts'],n+3,'prefix minimum');exact(prefix['maximumAccounts'],12,'prefix maximum');exact(prefix['activeParses'],list(range(12)),'prefix parse inventory')
 success=row['commitSuccess'];exact(sorted(success),['scope','writePaths'],'commit success keys')
 exact(success['writePaths'],[{'path':p,'result':'unsat'} for p in paths],'commit success paths')
 selection(row['selection'],n);ranges(row['ranges']);exact(row['snapshotDomainResult'],'unsat','snapshot domain result')
 certificate=row['commitBounds'];exact(sorted(certificate),['bounds','byteSteps','paths','scope','uniqueSequences'],'commit certificate keys')
 exact(certificate['uniqueSequences'],2,'commit sequence count');bounds(certificate['bounds'],n,managed,lengths)
 exact([p['path'] for p in certificate['paths']],list(range(total)),'certificate path inventory')
 for p in certificate['paths']:
  if 'reuse' in p:
   exact(sorted(p),['path','reuse'],'certificate reuse keys');need(type(p['reuse']) is int and 0<=p['reuse']<p['path'],'certificate reuse order')
  else:
   exact(sorted(p),['emptyWritesPreserveAllMemory','finalProjection','path','steps'],'certificate sequence keys')
   exact(p['finalProjection'],'exact-ast-equality','certificate final projection');exact(p['emptyWritesPreserveAllMemory'],not bool(p['steps']),'empty write preservation')
   for step in p['steps']:
    exact(sorted(step),['account','event','offset','value'],'certificate step keys')
    need(type(step['account']) is int and step['account'] in managed,'certificate account')
    need(type(step['offset']) is int and 0<=step['offset']<lengths[step['account']],'certificate offset')
    need(type(step['event']) is int and step['event']>=0,'certificate event')
    need(type(step['value']) is str and bool(step['value']),'certificate byte expression')
 domain=row['managedDomain'];exact(sorted(domain),['bounds','managedAccounts','missingWidthBound','prefixShrink','scope'],'managed domain keys')
 exact(domain['managedAccounts'],managed,'managed projection inventory');bounds(domain['bounds'],n,managed,lengths)
 exact(domain['prefixShrink'],'unsat','managed prefix shrink');exact(sorted(domain['missingWidthBound']),['countermodel','result'],'managed domain control keys')
 exact(domain['missingWidthBound']['result'],'sat','managed domain counterexample');need(type(domain['missingWidthBound']['countermodel']) is str and bool(domain['missingWidthBound']['countermodel']),'managed domain witness')
 representations=row['representations'];exact([r['sequence'] for r in representations],list(range(2**n)),'physical representation inventory')
 for r in representations:
  exact(sorted(r),['managedAccounts','outsideData','physicalMemorySha256','sequence'],'representation keys');exact(r['managedAccounts'],managed,'representation managed accounts')
  exact(r['outsideData'],'arbitrary helper-poststate bytes, not a preservation claim','outside-data scope')
  digest=r['physicalMemorySha256'];need(type(digest) is str and len(digest)==64 and all(c in '0123456789abcdef' for c in digest),'representation digest')
 commit_v2(row['physicalCommit'],certificate,row['memorySelection'],n)
