"""Expected named inventories and witness types for connected vault proofs."""
from vault_adapter_inventory import need
SECURITY=['actual-root-C-safety','unsigned-no-success-commit-or-postdecision-effects','wrong-owner-no-success-commit-or-postdecision-effects']
BINDINGS=['assignments-to-shared-outputs-have-disjoint-guards','every-base-input-extends-to-output-and-encoding-bindings']
STATE=['committed-state-decodes-to-actual-root-state','committed-state-has-canonical-encoding','initialized-balance-zero','initial-owner-and-mint-bound','deposit-accounting-without-overflow','withdraw-accounting-without-underflow','successful-state-is-live','owner-and-mint-preserved-on-update']
EFFECTS=['successful-helper-order-and-active-slots','initialize-extracted-mint-check','deposit-extracted-fields','withdraw-extracted-fields']
EXTRACTION=['typed-effect-path-coverage','typed-effect-never-rejected','typed-effect-path-disjointness','None-mapping-0','Transfer-mapping-0','Transfer-mapping-1','Transfer-mapping-2','CheckMint-mapping-0','plural-typed-path-coverage','plural-typed-path-disjointness','plural-fixed-record-never-rejected','plural-slot-0-all-fields','plural-slot-1-all-fields']
FAULTS=[('missing-output','output inventory'),('input-misclassified-as-output','output inventory'),('missing-equation','equation inventory'),('overlapping-assignments','assignments-to-shared-outputs-have-disjoint-guards: sat'),('circular-encoding','circular value')]
def validate_semantics(reports,data,input_hash):
 need(len(reports)==2,'semantic report inventory');codec,linked=reports
 for r in reports:
  need(r.get('passed') is True and r.get('endToEndVerified') is False and r['inputSha256']==input_hash,'semantic receipt identity')
  need(r['sourceHashes']==data['sourceHashes'] and r['artifactHashes']==data['artifactHashes'],'semantic input bindings')
 for report,fields in [(codec,{'checkerSha256':'codec_roundtrips.py','semanticsSha256':'codec_semantics.py'}),(linked,{'checkerSha256':'vault_adapter_semantic.py','codecSemanticsSha256':'codec_semantics.py','bindingAuditSha256':'state_encoding_binding.py','effectSemanticsSha256':'effect_semantics.py','tokenSemanticsSha256':'token_semantics.py','tokenExecutorSha256':'token_executor.py'})]:
  for field,file in fields.items():need(report.get(field)==data['sourceHashes']['verification/'+file],'semantic checker binding')
 expected=[]
 for t in data['fixture']['schema']['types']:
  expected.extend([{'name':t['name']+' value round trip','result':'unsat'},{'name':t['name']+' canonical bytes round trip','result':'unsat'},{'name':t['name']+' accepted bytes reachable','result':'sat'}])
 need(codec['claims']==expected,'codec semantics claim inventory')
 for key,security,witness in [('positive',['unsat']*3,'sat'),('negative',['unsat','sat','sat'],'unsat'),('arithmetic',['unsat']*3,'sat'),('transfer',['unsat']*3,'sat')]:
  result=linked[key]
  need([(c['name'],c['result']) for c in result['claims']]==list(zip(SECURITY,security)),'connected security inventory')
  need(result['rootCalls']==2 and result['CGuards']==100,'connected coverage')
  need(result['bindingAudit']=={'outputs':86,'rows':10,'claims':[{'name':n,'result':'unsat'} for n in BINDINGS]},'binding proof inventory')
  need(result['bindingFaults']==[{'name':n,'reason':r} for n,r in FAULTS],'binding fault inventory')
  need(result['witnesses']==[{'name':'authorized-success-reachable','result':'sat'},{'name':'unsigned-root-rejection-reachable','result':witness}]+[{'name':'committed-'+n+'-reachable','result':'unsat' if key=='transfer' and n=='deposit' else 'sat'} for n in ['initialize','deposit','withdraw']],'connected reachability inventory')
  need([(x['name'],x['result']) for x in result['stateClaims']]==[(n,'sat' if key=='arithmetic' and n=='deposit-accounting-without-overflow' else 'unsat') for n in STATE],'committed state claim inventory')
  need(result['effectSlots']==2,'connected effect slot inventory')
  need(result['extractionEvidence']=={'claims':[{'name':n,'result':'unsat'} for n in EXTRACTION],'singlePaths':10,'pluralPaths':4,'slots':2,'fieldsPerSlot':139},'extraction proof inventory')
  need([(x['name'],x['result']) for x in result['effectClaims']]==[(n,'unsat') for n in EFFECTS],'effect claim inventory')
  need(result['reservedIndependence']=={'name':'validator-return-independent-of-reserved-data-and-owners','result':'unsat'},'reserved input independence inventory')
  names=['caller-count','account and data read bounds','exact error/success contract','complete return coverage','executor-mint-index','executor-decimals-read','executor-transfer-indices','executor-transfer-authority']
  names.extend(['executor-caller-state-key-distinct','executor-opcode-1-metas-exclude-state','executor-opcode-3-metas-exclude-state','executor-opcode-4-metas-exclude-state','executor-issuance-authority-convention'])
  need(result['executorBody']=={'conformance':'complete reviewed token body','infosCapacity':12,'metasCapacity':4,'instructionBytes':10,'syscalls':1,'scope':'Exact full-body token conformance, not semantic preservation. Conditional index/read/loop facts are checked separately against the parsed validator.'},'executor body inventory')
  need(result['validatorClaims']==[{'name':'composed-validator-'+n,'result':'unsat'} for n in names],'validator claim inventory')
  need([(c['name'],c['result']) for c in result['planClaims']]==[('deposit-plan-destination','sat' if key=='transfer' else 'unsat')],'plan claim inventory')
  need(result['adapter']['obligations']==428,'connected adapter obligations')
  names=['commit-only-on-success','root-precondition-and-arguments','effect-slot-order-and-validation-before-execution','success-iff-contract','error-code-soundness','exact-commit-and-return-data','rejection-mapping','helper-code-width','pinned-precedence-return-code','pinned-precedence-event-trace']
  need(result['adapter']['claims']==[{'name':n,'result':'unsat'} for n in names],'connected adapter claim inventory')
 row=linked['negative']['claims'][1];schema=data['program']['source']['schema'];types={t['name']:t for t in schema['types']}
 def typed(name,value,depth=0):
  need(depth<=32,'witness depth');t=types[name]
  if t['kind']=='bool':need(type(value) is bool,'witness Bool');return
  if t['kind']=='u32':need(type(value) is int and 0<=value<=t.get('max',2**32-1),'witness U32');return
  need(type(value) is dict and set(value)=={'constructor','fields'},'witness ADT');variants=[v for v in t['variants'] if v['name']==value['constructor']];need(len(variants)==1,'witness constructor')
  fields=variants[0]['fields'];need(type(value['fields']) is dict and set(value['fields'])=={f['name'] for f in fields},'witness fields')
  for field in fields:typed(field['type'],value['fields'][field['name']],depth+1)
 signature=data['program']['source']['functions']['vault.process']
 for row,signed,extra in [(linked['negative']['claims'][1],False,[]),(linked['arithmetic']['stateClaims'][4],True,[('committedBytes',96)]),(linked['transfer']['planClaims'][0],True,[])]:
  need(type(row) is dict and {'wireArgs','stateBytes','instructionBytes'}<=set(row),'missing witness fields')
  if extra:need('committedBytes' in row,'missing committed bytes')
  args=row['wireArgs'];need(type(args) is list and len(args)==3,'witness arity')
  for name,value in zip(signature['args'],args):typed(name,value)
  need(args[0]['fields']['signed'] is signed,'witness signer')
  for key,size in [('stateBytes',96),('instructionBytes',35)]+extra:
   need(type(row[key]) is list and len(row[key])==size and all(type(b) is int and 0<=b<=255 for b in row[key]),'witness byte inventory')
  need(row['instructionBytes'][0] in (0,1),'witness instruction mode')
  if signed:
   need(args[2]['constructor']=='vault.Deposit','arithmetic witness instruction')
   if extra:need(row['committedBytes'][:20]==data['fixture']['interface']['header'],'committed header')
