"""Strict acceptance for the bounded collection fixture's connected C report."""
import hashlib,json
from pathlib import Path
if not __debug__:raise RuntimeError('collection root validation requires assertions')
from acyclic_c import need
from ranked_report import validate_proof
import collection_caller_syntax as api
from collection_caller_paths import Paths,check_declarations,check_run_arguments,check_local_scopes
SCOPE=('Conditional checked-source/C and decoder/root/encoder composition for tests/collection-store.bend. '
       'Validated codec templates, symbolic payload bytes and parsed caller control flow; '
       'assumes context, helper contracts, loader byte provenance and valid disjoint memory. '
       'No general memory-write, LLVM, SBF or transaction-rollback theorem.')
BINDINGS=['state_decode_initial','state_decode_stored','instruction_decode','selection_tag','range_tag','selector_start','selection_count',
          'record_decode_0','record_decode_1','result_tag','code','window_tag','vector_tag','pair_tag','after_start','written','next',
          'state_encode']+[f'encoded_state_byte_{i}' for i in range(5)]
for i in range(2):BINDINGS += [f'record_encode_{i}']+[f'encoded_record_{i}_byte_{j}' for j in range(4)]
CLAIMS=['binding-extension','pure-calls-safety','malformed-instruction-refused','malformed-stored-state-refused',
        'canonical-state-tag','call-counter-increments-modulo-u32']
sha=lambda raw:hashlib.sha256(raw).hexdigest()
def caller_inventory(data):
 files=data['caller']['artifactPaths'];text=Path(files['collection-store.c']).read_text()
 schema=json.loads(Path(files['collection-store.schema.json']).read_text());interface=json.loads(Path(files['collection-store.interface.json']).read_text())
 model=api.assert_schema(schema,interface);model['_interface']=interface
 check_declarations(api,text,interface);body=api.function_body(text,'bend_collection_run',set())
 check_run_arguments(api,body,model);check_local_scopes(api,body)
 paths=Paths(api,model);paths.statements(body);events,_=paths.reference()
 return ['all caller paths return']+['reachability: '+name for name in sorted(set(events)|set(paths.events))]+['ordered refusal and success result']+[
  name for name,_ in paths.checks if not name.startswith('codec input outside abstract call contract: ')]
def validate(report,data,raw):
 need(set(report)=={'passed','endToEndVerified','version','z3','runId','inputSha256','checkerSha256','sourceHashes','lowering',
  'callerProofs','bindingNames','callerClaims','bindingOutputs','claims','witnesses','semanticClaims','scope'},'report fields')
 need(report['passed'] is True and report['endToEndVerified'] is False and report['scope']==SCOPE,'report scope')
 need(type(report['version']) is int and report['version']==1 and report['z3']=='5.1.0','report version')
 need(report['runId']==data['runId'] and report['inputSha256']==sha(raw),'run/input binding')
 need(report['sourceHashes']==data['sourceHashes'],'source binding')
 need(report['checkerSha256']==data['sourceHashes']['verification/collection_root_semantic.py'],'checker binding')
 required={'verification/'+name for name in ['collection_root_semantic.py','collection_root_report.py','export-collection-root.ts','check-collection-root.ts',
  'collection_caller_paths.py','collection_caller_syntax.py','codec_semantics.py','ranked_c.py','ranked_report.py','semantic_binding.py']}
 need(required<=set(data['sourceHashes']),'checker inventory')
 p=data['program']
 need(p['source']['source']=='tests/collection-store.bend' and p['source']['roots']==['process','select'],'fixture identity')
 need(p['defaultProductionCMatches'] is True and p['artifact']['schema']==p['source']['schema'],'production/schema binding')
 need(p['artifact']['cSha256']==sha(p['artifact']['c'].encode()),'C binding')
 validate_proof(p,report['lowering'])
 names=caller_inventory(data)
 need(len(names)==183,'caller inventory size')
 need(report['callerProofs']==[{'name':n,'result':'unsat'} for n in names],'caller obligation inventory/results')
 need(type(report['callerClaims']) is int and report['callerClaims']==len(names),'caller count')
 need(report['bindingNames']==BINDINGS and type(report['bindingOutputs']) is int and report['bindingOutputs']==len(BINDINGS),'binding inventory')
 need(report['claims']==[{'name':n,'result':'unsat'} for n in CLAIMS],'connected obligation inventory/results')
 need(report['witnesses']==[{'name':n,'result':'sat'} for n in ['selector','root','commit']],'reachability witnesses')
 expected=[]
 for value in (0,1,2):
  expected += [{'name':f'invalid-window-{value}-refuses-commit','result':'unsat'},
               {'name':f'invalid-window-{value}-root-reachable','result':'sat'}]
 expected += [{'name':n+'-commit-reachable','result':'sat'} for n in ['append','replace']]
 need(report['semanticClaims']==expected,'semantic claim inventory/results')
def unchanged(data):
 for name,h in {**data['sourceHashes'],**data['artifactHashes'],**data['program']['sourceHashes']}.items():
  need(sha(Path(name).read_bytes())==h,'source/artifact drift: '+name)
 for item in data['prerequisites'].values():need(sha(Path(item['artifact']).read_bytes())==item['sha256'],'prerequisite drift')
if __name__=='__main__':
 import sys
 raw=Path(sys.argv[1]).read_bytes();data=json.loads(raw);unchanged(data)
 validate(json.loads(Path(sys.argv[2]).read_text()),data,raw);unchanged(data)
 print('Collection root report inventory and artifact bindings passed')
