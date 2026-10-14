from pathlib import Path
import os,sys,json,uuid,subprocess
home=Path('verification/collection_memory/qualification');root=Path('build/collection-memory');run=root/('qualified-'+str(uuid.uuid4()));run.mkdir(parents=True);receipt=root/'fresh-receipt.json'
if receipt.exists():receipt.replace(run/'previous.json')
if not __debug__:raise RuntimeError('memory controller assertions required')
sys.path.insert(0,str(home));import report as validation
entry=json.loads(Path('build/collection-entry/fresh-receipt.json').read_bytes());entry_input=json.loads(Path(entry['beforeArtifact']).read_bytes())
data={'version':1,'runId':run.name,'runDirectory':str(run),'sources':{str(p):validation.sha(p) for p in validation.SOURCES},'entryReceipt':entry,'compiler':entry_input['nativeCompiler']}
input_path=run/'input.json';input_path.write_text(json.dumps(data,indent=2)+'\n');input_hash=validation.sha(input_path)
python=os.environ.get('MEMORY_PYTHON',sys.executable);env=dict(os.environ,MEMORY_INPUT=str(input_path),MEMORY_RUN_DIR=str(run))
for script,log,args in [('prove.py','proof.log',[])]:
 with (run/log).open('w') as output:c=subprocess.run([python,'-B',str(home/script),*args],env=env,stdout=output,stderr=subprocess.STDOUT)
 if c.returncode:raise RuntimeError('memory proof child failed: '+str(c.returncode))
if not all((run/n).is_file() for n in validation.NAMES):raise RuntimeError('memory missing fresh reports')
manifest={n:{'path':str(run/n),'sha256':validation.sha(run/n)} for n in validation.NAMES};manifest_path=run/'manifest.json';manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
with (run/'validator.log').open('w') as output:c=subprocess.run([python,'-B',str(home/'report.py'),str(input_path),str(manifest_path)],stdout=output,stderr=subprocess.STDOUT)
if c.returncode:raise RuntimeError('memory report child failed: '+str(c.returncode))
expected=validation.validate(data,manifest);assert json.loads((run/'validator.log').read_bytes())==expected;assert validation.sha(input_path)==input_hash
result=run/'accepted.json';result.write_text(json.dumps(expected,indent=2)+'\n');accepted={'passed':True,'runId':run.name,'inputArtifact':str(input_path),'inputSha256':input_hash,'manifestArtifact':str(manifest_path),'manifestSha256':validation.sha(manifest_path),'reportArtifact':str(result),'reportSha256':validation.sha(result)}
tmp=run/'receipt.tmp';tmp.write_text(json.dumps(accepted,indent=2)+'\n');tmp.replace(receipt);print(run);print('Fresh collection memory bundle accepted')
