"""Fresh fixture and source bindings shared by composition children."""
from pathlib import Path
import hashlib,json,re,subprocess,sys,uuid
import z3

NAMES=['token-2','token-3','token-4']
SCOPE=('Conditional actual emitted ABI2 codec/root/effect/validator/commit composition. '
       'Serialized initial views and guarded helper precommit preservation are connected; '
       'selected helper memory is connected to finite physical-store commit projection. '
       'Outside-data bytes describe arbitrary helper post-state, not preservation. '
       'The Python proof driver, C parser, finite induction and Z3 remain trusted. '
       'Custody result/bump use the parsed reviewed helper and trusted PDA syscall outputs. '
       'Executor semantics use exact reviewed-body conformance. Key identities and byte views '
       'use the same 256-bit values. Program/token identity separation, stable metadata, '
       'valid disjoint native objects, local-buffer isolation and '
       'runtime enforcement of writable-key/token-byte frames remain assumptions. '
       'No end-to-end compiler, SBF, SPL accounting or transaction rollback theorem.')

def need(ok,reason):
 if not ok:raise ValueError(reason)

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def snapshot():
 inventory=subprocess.run(['git','ls-files','--cached','--others','--exclude-standard','-z'],check=True,capture_output=True).stdout.decode().split('\0')
 paths=sorted({p for p in inventory if p and Path(p).is_file() and (p.startswith(('compiler/','runtime/','verification/','sdk/')) or p in ('package.json','package-lock.json','tests/multi-token-composition.ts')) and Path(p).suffix in ('.ts','.py','.c','.h','.json','.bend') and not re.fullmatch(r'\.sqrt-negative-[0-9]+\.bend',Path(p).name)})
 need(paths,'empty source inventory')
 return {str(Path(p).resolve()):sha(p) for p in paths}

def begin(input_path,output_path):
 need(__debug__,'assertions required')
 need(z3.get_version_string()=='5.1.0','Z3 5.1.0 required')
 inp=Path(input_path).resolve();out=Path(output_path).resolve();out.parent.mkdir(parents=True,exist_ok=True)
 need(inp!=out,'input/output paths must differ')
 if out.exists():out.rename(out.with_name(out.name+'.previous-'+str(uuid.uuid4())))
 source_hashes=snapshot();input_hash=sha(inp);data=json.loads(inp.read_text())
 need(isinstance(data.get('immutableInputs'),dict) and data['immutableInputs'],'missing immutable inputs')
 for p,h in data['immutableInputs'].items():need(sha(p)==h,'changed fixture input: '+p)
 need([f['name'] for f in data['fixtures']]==NAMES,'exact fixture inventory')
 for f in data['fixtures']:
  header=f['name']+'.h';program=f['program'];artifact=program['artifact']
  need(f['interface']['version']==2,'ABI2 required')
  need(program['source']['roots']==[f['root']],'source root binding')
  need(program['source']['schema']==f['schema']==artifact['schema'],'source/native schema binding')
  need(artifact['c']==f['files'][header],'included native header binding')
  need(artifact['cSha256']==hashlib.sha256(artifact['c'].encode()).hexdigest(),'native header digest')
  need(set(f['files'])==set(f['artifactPaths']),'exact artifact path inventory')
  for name,text in f['files'].items():
   path=f['artifactPaths'][name]
   need(Path(path).read_text()==text,'recorded artifact differs: '+name)
   need(data['immutableInputs'].get(path)==sha(path),'unbound artifact: '+name)
  for path,h in f['sourceDependencies'].items():need(data['immutableInputs'].get(path)==h==sha(path),'source dependency binding: '+path)
 return data,{'input':str(inp),'inputSha256':input_hash,'sourceHashes':source_hashes},out

def finish(data,binding,out,kind,rows,extra_inputs=None):
 need(snapshot()==binding['sourceHashes'],'composition source drift')
 need(sha(binding['input'])==binding['inputSha256'],'fixture payload drift')
 for p,h in data['immutableInputs'].items():need(sha(p)==h,'fixture drift: '+p)
 for p,h in (extra_inputs or {}).items():need(sha(p)==h,'extra input drift: '+p)
 report={'passed':True,'kind':kind,'scope':SCOPE,'binding':binding,'extraInputs':extra_inputs or {},'fixtures':rows}
 pending=out.with_name(out.name+'.pending');pending.write_text(json.dumps(report,indent=2)+'\n');pending.replace(out)
 print(str(out),flush=True)
