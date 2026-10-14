"""Exact staged composition report inventory and source binding checks."""
import copy,hashlib,json,pathlib,os
if not __debug__:raise RuntimeError("issuance report validation requires Python assertions")
r=pathlib.Path(os.environ.get('BRIDGE_DIR','build/issuance-adapter'));module=pathlib.Path(__file__).with_name('issuance_adapter_semantic.py')
def sha(p):return hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
def check(value):
 assert value['passed'] is True and value['endToEndVerified'] is False
 assert value['inputSha256']==sha(r/'input.json')
 assert value['checkerSha256']==sha(module)
 data=json.loads((r/'input.json').read_text())
 for path,digest in {**data['sourceHashes'],**data['artifactHashes']}.items():assert sha(path)==digest,path
 assert value['z3']=='5.1.0'
 assert value['sourceHashes']==data['sourceHashes'] and value['artifactHashes']==data['artifactHashes']
 assert len(value['rootEquivalence'])==1 and value['rootEquivalence'][0]['function']=='process' and value['rootEquivalence'][0]['result']=='unsat'
 check_proof(value['positive'])
 assert [m['name'] for m in value['mutations']]==['mint-amount','counter-increment']
 recipes=[('(a2).as.c0.f1, (a2).as.c0.f4)','(a2).as.c0.f3, (a2).as.c0.f4)'),('bend_U32_2e_add((a1).as.c0.f0, 1u)','bend_U32_2e_add((a1).as.c0.f0, 2u)')]
 for mutation,(old,new) in zip(value['mutations'],recipes):
  original=data['program']['artifact']['c'];assert original.count(old)==1
  assert mutation['cSha256']==hashlib.sha256(original.replace(old,new).encode()).hexdigest()
  mismatch=mutation['sourceMismatch'];assert len(mismatch)==1 and mismatch[0]['result']=='sat' and mismatch[0]['function']=='process' and len(mismatch[0]['wireArgs'])==3
  check_proof(mutation['proof'],mutation['name'])
def check_proof(p,mutation=None):
 expected_fault={'mint-amount':'actual-slot-0-matches-instruction','counter-increment':'committed-counter-increments-modulo-u32'}.get(mutation)
 def exact(key,names):
  assert [q['name'] for q in p[key]]==names,key
  for q in p[key]:
   assert q['result']==('sat' if q['name']==expected_fault else 'unsat'),q['name']
   if q['name']==expected_fault:assert len(q['wireArgs'])==3 and len(q['instructionBytes'])==130 and len(q['stateBytes'])==25 and q['successfulCallerWitness'] is True
 sequence=[]
 for i in range(3):
  sequence.extend({'name':f'sequence-call-{i}-'+name,'result':result} for name,result in [('durable-validation','unsat'),('decimals-preserved','unsat'),('executor-premises','unsat'),('reachable','sat')])
 sequence.extend({'name':f'sequence-after-{i}-managed-state-frame','result':'unsat'} for i in range(1,4))
 sequence.extend({'name':'sequence-unframed-'+name+'-detected','result':'sat'} for name in ['state','decimals'])
 assert p['sequence']=={'frameSpec':{'accounts':[4,12],'mint':{'size':82,'spans':[[36,44]]},'token':{'size':165,'spans':[[64,108],[121,129]]},'endExclusive':True},'steps':3,'lemmas':[{'name':f'generic-sequence-{i}-durable-validation','result':'unsat'} for i in range(3)],'claims':sequence}
 exact('claims',['actual-root-C-safety','successful-helper-order-and-active-slots'])
 exact('stateClaims',['committed-state-decodes-to-actual-root-state','committed-state-has-canonical-encoding','committed-counter-increments-modulo-u32'])
 exact('effectClaims',[f'actual-slot-{i}-matches-instruction' for i in range(3)])
 labels=['caller-count','account and data read bounds','exact error/success contract','complete return coverage','executor-mint-index','executor-decimals-read','executor-transfer-indices','executor-transfer-authority','executor-caller-state-key-distinct','executor-opcode-1-metas-exclude-state','executor-opcode-3-metas-exclude-state','executor-opcode-4-metas-exclude-state','executor-issuance-authority-convention']
 # Reviewed fixed fixture call-site inventory; changes require deliberate review.
 sites=[(path,root,slot) for path in range(21,35) for root in range(2) for slot in range((1 if path in (21,24) else 2 if path in (22,25) else 3))]
 exact('validatorClaims',[f'composed-validator-{label}-path{path}-root{root}-slot{slot}' for label in labels for path,root,slot in sites])
 assert p['reservedIndependence']=={'name':'validator-return-independent-of-reserved-data-and-owners','result':'unsat'}
 extraction_names=['typed-effect-path-coverage','typed-effect-never-rejected','typed-effect-path-disjointness']
 for variant,count in [('None',1),('Transfer',3),('CheckMint',1),('Mint',3),('Burn',1),('BoundTransfer',12)]:extraction_names.extend(f'{variant}-mapping-{i}' for i in range(count))
 extraction_names+=['plural-typed-path-coverage','plural-typed-path-disjointness','plural-fixed-record-never-rejected']+[f'plural-slot-{i}-all-fields' for i in range(3)]
 assert p['extractionEvidence']=={'claims':[{'name':n,'result':'unsat'} for n in extraction_names],'singlePaths':55,'pluralPaths':5,'slots':3,'fieldsPerSlot':139}
 assert p['executorBody']=={'conformance':'complete reviewed token body','infosCapacity':12,'metasCapacity':4,'instructionBytes':10,'syscalls':1,'scope':'Exact full-body token conformance, not semantic preservation. Conditional index/read/loop facts are checked separately against the parsed validator.'}
 assert p['adapter']['paths']==35 and p['adapter']['obligations']==415
 assert p['rootCalls']==2
 assert p['bindingAudit']=={'outputs':18,'rows':10,'claims':[{'name':name,'result':'unsat'} for name in ['assignments-to-shared-outputs-have-disjoint-guards','every-base-input-extends-to-output-and-encoding-bindings']]}
 assert [c['name'] for c in p['bindingFaults']]==['missing-output','input-misclassified-as-output','missing-equation','overlapping-assignments','circular-encoding']
 assert all(c['reason'] for c in p['bindingFaults'])
 assert p['witnesses']==[{'name':'actual-issuance-success-reachable','result':'sat'},{'name':'wrong-destination-binding-cannot-succeed','result':'unsat'}]
 names=['commit-only-on-success','root-precondition-and-arguments','effect-slot-order-and-validation-before-execution','success-iff-contract','error-code-soundness','exact-commit-and-return-data','rejection-mapping','helper-code-width','pinned-precedence-return-code','pinned-precedence-event-trace']
 assert p['adapter']['claims']==[{'name':name,'result':'unsat'} for name in names]
if __name__=='__main__':
 check(json.loads((r/'semantic-report.json').read_text()))
 print('Exact issuance composition report inventory and bindings passed')
