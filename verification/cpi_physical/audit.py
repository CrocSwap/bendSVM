"""Strict inventory, input binding and raw-query replay for maintained CPI connection evidence."""
import copy,hashlib,json,pathlib,sys,uuid
import z3 as z
assert __debug__ and z.get_version_string()=='5.1.0'
sys.path.insert(0,'verification')
from cpi_caller.report import validate as validate_caller
import multi_adapter_contract as m
root=pathlib.Path.cwd();run=pathlib.Path(sys.argv[1])
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
pointer=json.loads((run/'connection-report.json').read_bytes())
report_path=pathlib.Path(pointer['report']);assert sha(report_path)==pointer['sha256']
report=json.loads(report_path.read_bytes());data=json.loads((run/'fixtures/input.json').read_bytes())
profiles=json.loads((run/'native-profiles.json').read_bytes())
def require(condition,message):
 if not condition:raise ValueError(message)
def validate(value):
 require(value['passed'] is True and value['sourcePromoted'] is True and value['endToEndVerified'] is False and value['fingerprintScheme']=='z3-typed-dag-sha256-v1','scope flags')
 require([r['fixture'] for r in value['rows']]==['cpi-2','cpi-3','cpi-4'],'fixture inventory')
 validate_caller({'passed':True,'rows':[{**r['caller'],'rootCorrespondence':r['rootCorrespondence']} for r in value['rows']]},data['fixtures'])
 for row,fixture in zip(value['rows'],data['fixtures']):
  size=int(fixture['name'][-1]);summary=m.summarize(fixture['schema'],fixture['interface'])
  count=row['parsedValidatorCountBridge'];require(count['passed'] is True,'count bridge not passed')
  require(len(count['instances'])==2*row['caller']['rootCalls'],'count bridge instance inventory')
  require({x['slot'] for x in count['instances']}=={0,1},'count bridge slots')
  require(all(len(x['exactDefiningEquationsFingerprints'])==3 for x in count['instances']),'three exact count bindings')
  require([x['name'] for x in count['claims'][:2]]==['parsed-active-success-count','scalar-bound-transport'],'parsed count theorem inventory')
  require(all(x['result']=='unsat' for x in count['claims']),'count theorem unproved')
  require({x['name'] for x in count['claims'] if x['name'].startswith('root-count-domain-')}=={'root-count-domain-'+str(i) for i in range(len(count['instances']))},'count domain inventory')
  for key,name in [('laterHelperPriorSuccess','later-helper-requires-prior-success'),('readonlyLengthTransport','truthful-readonly-length-transport')]:
   require(row[key]['name']==name and row[key]['result']=='unsat','helper length bridge '+key)
  metadata=row['metadataBridge']
  require(metadata['infosContainmentIsPremise'] is True and metadata['truthfulSerializedLengthsIsPremise'] is True,'metadata premise scope')
  require(len(metadata['returnedLengthBindingsFingerprints'])==24 and len(metadata['runtimeMetadataPremisesFingerprints'])==24,'metadata bridge inventory')
  require([(x['slot'],x['account']) for x in metadata['readonlyTransportInstances']]==[(slot,i) for slot in range(2) for i in range(12)],'readonly transport instance inventory')
  for key,name in [('managedExclusion','actual-caller-managed-key-exclusion'),('managedLengthPreservation','post-helper-managed-commit-lengths'),('commitBounds','actual-commit-writes-fit-refreshed-lengths')]:
   require(row[key]['name']==name and row[key]['result']=='unsat','connection claim '+key)
  require(row['pendingSources']==sorted([f'header{i}' for i in range(size)]+[f'encoded{i}' for i in range(size)]),'actual pending sources')
  require('parsedExecutionGates' in row,'missing actual execution gates')
  if 'parsedExecutionGates' in row:
   require(row['parsedExecutionGates']['name']=='actual-parsed-execution-gates' and row['parsedExecutionGates']['result']=='unsat','actual execution gates')
   require(row['executingPaths']>0 and row['failurePathsWithoutAdapterCommit']>0,'executing/failure path inventory')
  require([x['slot'] for x in row['physicalFrameInstances']]==[0,1] and all(x['exactByteFrameInstantiation'] is True for x in row['physicalFrameInstances']),'frame step inventory')
  projection=row['derivedPhysicalProjections'];origins=50+3*size
  require(projection['passed'] is True and projection['initialProjectionIsPremise'] is True and projection['physicalAllocationIsPremise'] is True,'projection premise scope')
  require(len(projection['frameSelections'])==2*origins,'frame selection inventory')
  require(len(projection['rangeLemmaInstances'])==28*origins-48,'range instance inventory')
  require(len(projection['actualMemcpySourceOrigins'])==(3*size-1)*(2**size),'actual memcpy origin inventory')
  require(projection['allocationWitness']=='sat','nonempty allocation witness')
  require(len(projection['descriptorStoreInstances'])==192,'descriptor store inventory')
  require([(x['slot'],x['offset']) for x in projection['descriptorStoreInstances']]==[(slot,i*64+24+k) for slot in range(2) for i in range(12) for k in range(8)],'exact size store offsets')
  require(len(projection['origins'])==origins,'physical origin inventory')
  require(sum(x['kind']=='descriptor' for x in projection['origins'])==24,'descriptor pointer origins')
  require(sum(x['kind']=='length' for x in projection['origins'])==12,'serialized length origins')
  require(all(x['conditionalReadonly'] is (x['kind']=='length') for x in projection['frameSelections']),'conditional readonly lengths')
  require(all(len(x['permissionExclusionsFingerprints'])==13 for x in projection['frameSelections']),'workspace permission inventory')
  names=[];proved={}

  for proof in projection['freshProofs']:
   require(proof['result']=='unsat' and proof['name'] not in names,'projection proof result/unique name')
   if 'reuse' in proof:
    require(proof['reuse'] in names,'projection reuse must refer to earlier fresh proof')
    require(proof['sourceFormulaFingerprint']==proved[proof['reuse']]['sourceFormulaFingerprint'],'projection reuse formula differs')
   proved[proof['name']]=proof
   names.append(proof['name'])
  require(set(names)=={'local-account','other-account','own-key','local-workspace','account-workspace','excluded-selection','descriptor-store-exterior','descriptor-store-nonsize'} | {x['name']+'-'+suffix for x in projection['origins'] for suffix in (['offset-bound','nonsize-read-bound'] if x['kind']=='descriptor' else ['translated-bound','translated-address'] if x['kind'] in ('key','length','managed') else [])},'projection fresh lemma inventory')
  byte_steps=sum(f['stateBytes'] for f in summary['fields'])
  commit=row['physicalCommit'];require(commit['byteSteps']==byte_steps and commit['freshStoreTheorems']==2,'actual finite store inventory')
  require(commit['storeTheoremInstances']==byte_steps*size,'physical store instances')
  require(commit['precommitMemoryFingerprint']==row['physicalFrameInstances'][-1]['refreshedMemoryFingerprint'],'actual helper memory feeds commit')
  require([x['name'] for x in commit['storeProofs']]==['physical-store-theorem-0','physical-store-theorem-1'] and all(x['result']=='unsat' for x in commit['storeProofs']),'fresh physical Store queries')
  require(len(commit['paths'])==row['caller']['adapter']['paths'],'physical path inventory')
  require([x['name'] for x in row['resizeWitnesses']]==['successful-external-resize-mode-'+str(mode)+'-to-'+str(length) for mode in [0,1] for length in [192,32]],'resize modes')
  require(all(x['result']=='sat' and x['witness'] for x in row['resizeWitnesses']),'resize witnesses')
  profile=next(p for p in profiles['rows'] if p['fixture']==fixture['name'])
  for witness in row['resizeWitnesses']:
   require(witness.get('specialization')=='exact concrete input assignments; all remaining equations retained','resize specialization scope')
   mode=int(witness['name'].split('-')[4]);resize=int(witness['name'].split('-')[-1])
   expected={}
   def scalar(name,value,width=64):expected[name]=(str(value),'BitVec('+str(width)+')')
   def boolean(name,value):expected[name]=(str(value),'Bool')
   wire=[mode,*profile['bytes']]
   scalar('account_count',12);scalar('instruction_length',len(wire))
   for i,byte in enumerate(wire):scalar('instruction'+str(i),byte,8)
   scalar('program_id_bytes',100,256)
   for i in range(12):
    scalar('cpi_data_start_'+str(i),(1<<34)+88+i*32768)
    scalar('account'+str(i)+'_key_bytes',i+1,256);scalar('account'+str(i)+'_owner_bytes',100,256)
    for suffix in ['not_alias_marker','signer','writable']:boolean('account'+str(i)+'_'+suffix,True)
    boolean('account'+str(i)+'_executable',i==2)
    field=next((f for f in summary['fields'] if f['index']==i),None)
    scalar('account'+str(i)+'_size',field['stateBytes'] if field else 128 if i==11 else 0)
    if field:
     initial=[0]*field['stateBytes']
     if mode==1:
      initial[:20]=field['header']
      if field['bindingBytes']:initial[20:52]=list((1).to_bytes(32,'little'))
     for j,byte in enumerate(initial):scalar('account'+str(i)+'_data'+str(j),byte,8)
   for slot in range(2):
    scalar('cpi_runtime_status_'+str(slot),0);scalar('cpi_returned_length_'+str(slot)+'_11',resize)
   scalar('cpi_workspace_start',1<<32);scalar('cpi_workspace_size',4096);scalar('cpi_descriptor_start',1<<33)
   locals=sorted([f'header{i}' for i in range(size)]+[f'encoded{i}' for i in range(size)]+['reply','transfers'])
   for i,name in enumerate(locals):scalar('projection_local_'+name,(1<<33)+4096+i*8192)
   actual=witness.get('groundedInputs',[])
   require(all(set(p)=={'name','value','sort'} for p in actual),'resize grounding fields')
   require(len(actual)==len(expected) and len({p['name'] for p in actual})==len(actual),'resize grounding inventory')
   require({p['name']:(p['value'],p['sort']) for p in actual}==expected,'resize grounding assignments')
 return True
validate(report)
bindings=dict(report['inputs']);bindings[str(report_path)]=sha(report_path);bindings[str(pathlib.Path(__file__).resolve())]=sha(pathlib.Path(__file__))
for p,h in data['immutableInputs'].items():require(bindings.get(p)==h,'immutable fixture binding '+p)
for p,h in bindings.items():require(sha(p)==h,'input drift '+p)
output=run/'connection-audits'/str(uuid.uuid4());output.mkdir(parents=True)
queries={}
def visit(value):
 if isinstance(value,dict):
  if 'query' in value and 'querySha256' in value:
   path=value['query'];entry=(value['querySha256'],value['result'])
   require(path not in queries or queries[path]==entry,'conflicting query evidence')
   queries[path]=entry
  for item in value.values():visit(item)
 elif isinstance(value,list):
  for item in value:visit(item)
visit(report)
replays=[]
for path,(digest,wanted) in queries.items():
 require(sha(path)==digest,'query drift '+path)
 solver=z.Solver();solver.set(timeout=120000);solver.add(z.parse_smt2_file(path));answer=solver.check()
 require(str(answer)==wanted,'raw query replay '+path+': '+str(answer)+' '+solver.reason_unknown())
 replays.append({'query':path,'querySha256':digest,'result':str(answer)})
 bindings[path]=digest
for row in report['rows']:
 projection=row['derivedPhysicalProjections'];require(sha(projection['premises'])==projection['premisesSha256'],'physical premise drift')
 bindings[projection['premises']]=projection['premisesSha256']
# Report mutations must refuse for their intended inventory/result reason.
controls=[]
mutations=[('unproved connection claim',lambda x:x['rows'][0]['managedExclusion'].update(result='unknown'),'connection claim managedExclusion'),
 ('missing count binding',lambda x:x['rows'][0]['parsedValidatorCountBridge']['instances'][0]['exactDefiningEquationsFingerprints'].pop(),'three exact count bindings'),
 ('missing pending origin',lambda x:x['rows'][1]['pendingSources'].pop(),'actual pending sources'),
 ('missing frame selection',lambda x:x['rows'][2]['derivedPhysicalProjections']['frameSelections'].pop(),'frame selection inventory'),
 ('missing memcpy source',lambda x:x['rows'][0]['derivedPhysicalProjections']['actualMemcpySourceOrigins'].pop(),'actual memcpy origin inventory'),
 ('false end-to-end claim',lambda x:x.update(endToEndVerified=True),'scope flags'),
 ('missing resize witness',lambda x:x['rows'][1]['resizeWitnesses'].pop(),'resize modes')]
mutations.append(('missing execution gate proof',lambda x:x['rows'][0].pop('parsedExecutionGates'),'missing actual execution gates'))
for name,mutate,expected in mutations:
 changed=copy.deepcopy(report);mutate(changed)
 try:validate(changed)
 except ValueError as error:require(str(error)==expected,'unexpected report refusal');controls.append({'name':name,'reason':str(error)})
 else:raise AssertionError('bad report accepted: '+name)
extra=[('missing private workspace permission',lambda x:x['rows'][0]['derivedPhysicalProjections']['frameSelections'][0]['permissionExclusionsFingerprints'].pop(),'workspace permission inventory'),
 ('missing descriptor store',lambda x:x['rows'][0]['derivedPhysicalProjections']['descriptorStoreInstances'].pop(),'descriptor store inventory'),
 ('descriptor pointer overwrite',lambda x:x['rows'][0]['derivedPhysicalProjections']['descriptorStoreInstances'][0].update(offset=0),'exact size store offsets'),
 ('wrong precommit memory',lambda x:x['rows'][0]['physicalCommit'].update(precommitMemoryFingerprint='0'*64),'actual helper memory feeds commit'),
 ('missing metadata binding',lambda x:x['rows'][0]['metadataBridge']['returnedLengthBindingsFingerprints'].pop(),'metadata bridge inventory'),
 ('unconditional external length preservation',lambda x:next(r for r in x['rows'][0]['derivedPhysicalProjections']['frameSelections'] if r['kind']=='length').update(conditionalReadonly=False),'conditional readonly lengths'),
 ('missing grounded input',lambda x:x['rows'][0]['resizeWitnesses'][0]['groundedInputs'].pop(),'resize grounding inventory'),
 ('wrong grounded resize',lambda x:next(p for p in x['rows'][0]['resizeWitnesses'][0]['groundedInputs'] if p['name']=='cpi_returned_length_0_11').update(value='193'),'resize grounding assignments'),
 ('unscoped witness specialization',lambda x:x['rows'][0]['resizeWitnesses'][0].update(specialization='dropped remaining equations'),'resize specialization scope')]
for name,mutate,expected in extra:
 changed=copy.deepcopy(report);mutate(changed)
 try:validate(changed)
 except ValueError as error:require(str(error)==expected,'unexpected report refusal');controls.append({'name':name,'reason':str(error)})
 else:raise AssertionError('bad report accepted: '+name)
for p,h in bindings.items():require(sha(p)==h,'end input drift '+p)
result={'passed':True,'sourcePromoted':True,'endToEndVerified':False,'fixtures':3,'bindings':bindings,'queryReplays':replays,'reportControls':controls,
 'scope':'Strict maintained caller inventory plus maintained parsed count, actual source origins, range/frame/finite-Store and resize inventories; source/include/query byte bindings and fresh raw SMT replay. Does not rederive the complete interpreter trace or replace the conditional allocation/runtime premises; conditional maintained qualification; no production or unconditional failure-path physical theorem.'}
(output/'report.json').write_text(json.dumps(result,indent=2)+'\n');(run/'connection-audit.json').write_text(json.dumps({'report':str(output/'report.json'),'sha256':sha(output/'report.json')},indent=2)+'\n');print(json.dumps({'passed':True,'report':str(output/'report.json'),'queries':len(replays),'bindings':len(bindings)}))
