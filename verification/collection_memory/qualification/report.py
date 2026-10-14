from pathlib import Path
import sys,json,hashlib
if not __debug__:raise RuntimeError('memory report assertions required')
sys.path.insert(0,'verification/collection_entry/qualification')
import fresh_report
import native_bundle as nb
ROOT=Path('verification/collection_memory');SPEC=ROOT/'qualification/contract.json'
PROOFS=['layout-frame.json','controls.json','commit-frame.json','commit-sequence.json','key-stability.json','caller/caller-memory.json','caller/state-writes.json']
NATIVES=['native-commit/report.json','native-state/report.json'];NAMES=PROOFS+NATIVES
SOURCES=[ROOT/n for n in ['layout-frame.py','controls.py','commit-frame.py','commit-sequence.py','key-stability.py','connect-caller.py','state-writes.py','native-commit.py','native-state.py','qualification/prove.py','qualification/report.py','qualification/controller.py','qualification/contract.json']]+[Path('tests/collection-memory-native.h'),Path('verification/check-collection-memory.ts'),Path('runtime/solana_min.h'),Path('runtime/bend_collection_runtime.h'),Path('verification/collection_contracts.py')]
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,why):
 if not ok:raise ValueError(why)
def compact(d):
 d=dict(d)
 for k in ['entryReceipt','headerSha256','contractInterfaceHash']:d.pop(k,None)
 if 'controls' in d:d['controls']=[{k:v for k,v in row.items() if k!='witness'} for row in d['controls']]
 return d

def native_sources(data,kind,name):
 if kind=='native-commit':
  sources={'main.c':Path('tests/collection-memory-native.h').read_text(),'solana_min.h':Path('runtime/solana_min.h').read_text(),'bend_collection_runtime.h':Path('runtime/bend_collection_runtime.h').read_text()}
  mutations={'record-offset':('data[offset + i] = encoded[i]','data[offset + i + 1] = encoded[i]'),'key-source':('data[24 + i] = state_key[i]','data[24 + i] = state_key[(i + 1) % 32]'),'metadata-clobber':('c->length = next_length;','data[-1] ^= 1; c->length = next_length;'),'descriptor-clobber':('c->length = next_length;','c->capacity = 0; c->length = next_length;')}
  if name!='baseline':
   old,new=mutations[name];text=sources['bend_collection_runtime.h'];need(text.count(old)==1,'native mutation occurrence');sources['bend_collection_runtime.h']=text.replace(old,new)
  return sources
 entry=json.loads(Path(data['entryReceipt']['beforeArtifact']).read_bytes())
 mutations={'state-payload-offset':('__builtin_memcpy(state->data+20,encoded_state,5);','__builtin_memcpy(state->data+21,encoded_state,5);'),'state-header-short':('__builtin_memcpy(state->data,state_header,20);','__builtin_memcpy(state->data,state_header,19);')}
 case=(name,None,None,None,'') if name=='baseline' else (name,'collection-store.c',*mutations[name],'state bytes mismatch')
 return nb.texts(entry,case)

def validate(data,manifest):
 need(set(data)=={'version','runId','runDirectory','sources','entryReceipt','compiler'},'memory input fields')
 need(type(data['version']) is int and data['version']==1,'memory input version')
 run=Path(data['runDirectory']);need(run.name==data['runId'],'memory run identity')
 need(set(data['sources'])==set(map(str,SOURCES)),'memory source inventory')
 for p,h in data['sources'].items():need(sha(p)==h,'memory source drift')
 receipt=data['entryReceipt']
 for p,h in [('beforeArtifact','beforeSha256'),('inputArtifact','inputSha256'),('reportArtifact','reportSha256')]:need(sha(receipt[p])==receipt[h],'entry prerequisite hash')
 fresh_report.validate(receipt['beforeArtifact'],receipt['inputArtifact'])
 entry=json.loads(Path(receipt['beforeArtifact']).read_bytes());need(data['compiler']==entry['nativeCompiler'],'memory compiler prerequisite binding')
 need(sha(data['compiler']['path'])==data['compiler']['sha256'],'memory compiler drift')
 need(set(manifest)==set(NAMES),'memory child inventory');spec=json.loads(SPEC.read_bytes());need(set(spec)==set(PROOFS),'memory contract inventory')
 sys.path.insert(0,'verification');import collection_contracts as cc
 for name in NAMES:
  item=manifest[name];need(set(item)=={'path','sha256'},'memory child fields');need(Path(item['path'])==run/name,'memory child run path');need(sha(item['path'])==item['sha256'],'memory child hash');d=json.loads(Path(item['path']).read_bytes());need(d.get('passed') is True,'memory child success')
  if 'entryReceipt' in d:need(d['entryReceipt']==receipt,'memory child entry binding')
  if name in PROOFS:
   if 'headerSha256' in d:need(d['headerSha256']==data['sources']['runtime/solana_min.h' if name=='layout-frame.json' else 'runtime/bend_collection_runtime.h'],'memory header binding')
   if 'contractInterfaceHash' in d:need(d['contractInterfaceHash']==cc.CONTRACT_INTERFACE_HASH,'memory contract binding')
   need(compact(d)==spec[name],'memory claim inventory/results/scope: '+name);continue
  helper=name.startswith('native-commit/')
  fields={'passed','cases','compiler','replays','scope'}|({'compilerSha256','headerHashes'} if helper else {'entryReceipt'})
  need(set(d)==fields,'memory native report fields')
  scopes={'native-commit':'Actual loader and commit helper in a contiguous serialized buffer, sanitizer baseline and four deliberate faults. Enumerated valid small windows plus boundary allocations up to10MiB; not full adapter or SBF execution.','native-state':'Same qualified serialized generated entrypoint and native harness, with two generated-state-copy mutations. Native sanitizer evidence, not SBF preservation.'}
  kind=Path(name).parent.name;need(d['scope']==scopes[kind],'memory native scope')
  if helper:need(d['headerHashes']=={n:data['sources']['runtime/'+n] for n in ['solana_min.h','bend_collection_runtime.h']},'memory native header binding')
  wanted=['baseline','record-offset','key-source','metadata-clobber','descriptor-clobber'] if helper else ['baseline','state-payload-offset','state-header-short']
  need(type(d['cases']) is int and d['cases']==(771 if helper else 171),'memory native cases')
  compiler={'path':d['compiler'],'sha256':d['compilerSha256']} if helper else d['compiler'];need(compiler==data['compiler'],'memory native compiler')
  need(isinstance(d['replays'],list) and [r['name'] for r in d['replays']]==wanted,'memory native replay inventory')
  for row in d['replays']:
   need(set(row)=={'name','exitCode','files'},'memory native replay fields');baseline=row['name']=='baseline';need(type(row['exitCode']) is int and row['exitCode']==(0 if baseline else 42),'memory native status')
   directory=run/Path(name).parent/row['name'];expected_sources=native_sources(data,kind,row['name'])
   need(set(row['files'])=={str(directory/n) for n in list(expected_sources)+['run','compile.log','run.log']},'memory native file inventory')
   for n,text in expected_sources.items():need((directory/n).read_text()==text,'memory native source mismatch')
   for p,h in row['files'].items():need(sha(p)==h,'memory native file drift')
   expected=(str(d['cases'])+(' whole-buffer commit cases passed\n' if helper else ' caller cases passed\n')) if baseline else ('collection descriptor mismatch\n' if row['name']=='descriptor-clobber' else 'whole serialized buffer mismatch\n' if helper else 'state bytes mismatch\n')
   need((directory/'run.log').read_text()==expected,'memory native diagnostic')
 return {'passed':True,'endToEndVerified':False,'runId':data['runId'],'children':len(NAMES),'scope':'Conditional collection memory model and native comparisons; separate C objects, scratch/header, proof machinery, syscalls and SBF remain trusted.'}
if __name__=='__main__':print(json.dumps(validate(json.loads(Path(sys.argv[1]).read_bytes()),json.loads(Path(sys.argv[2]).read_bytes()))))
