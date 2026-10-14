"""Exercise wide proof process failures in an isolated source copy."""
from pathlib import Path
import hashlib,json,os,shutil,subprocess,sys,uuid
if not __debug__:raise RuntimeError('wide controls require Python assertions')
root=Path.cwd();sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
receipt=root/'build/wide-refinement.json';positive=json.loads(receipt.read_text())
assert len(positive['mutations'])==15 and all(c['result']=='unsat' for c in positive['positive']['claims'])
assert len(positive['positive']['smallDivision'])==15 and all(c['result']=='unsat' for c in positive['positive']['smallDivision'])
for name,digest in positive['hashes'].items():assert sha(root/name)==digest,name
base=root/'build/wide-process-controls'/str(uuid.uuid4());private=base/'source';private.mkdir(parents=True)
inputs={}
for directory in ['compiler','runtime','sdk','scripts','verification']:
 for source in (root/directory).rglob('*'):
  if not source.is_file() or '__pycache__' in source.parts or source.suffix=='.pyc':continue
  name=source.relative_to(root);dest=private/name;dest.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,dest);inputs[str(name)]=sha(source)
for name in ['package.json','package-lock.json']:
 shutil.copyfile(root/name,private/name);inputs[name]=sha(root/name)
(private/'node_modules').symlink_to((root/'node_modules').resolve(),target_is_directory=True)
(private/'.deps').mkdir();(private/'.deps/bend').symlink_to((root/'.deps/bend').resolve(),target_is_directory=True)
(private/'build').mkdir();prior=receipt.read_bytes();(base/'prior.json').write_bytes(prior)
# Run the real prover before changing a captured compiler input. All proof
# obligations still execute; publication must refuse the changed source hash.
shim=base/'drift-python';marker=base/'drift-marker'
shim.write_text('#!'+sys.executable+'\n'+
 'import pathlib,subprocess,sys\n'+
 'r=subprocess.run(['+repr(sys.executable)+',*sys.argv[1:]])\n'+
 'p=pathlib.Path('+repr(str(marker))+')\n'+
 'if not p.exists():\n'+
 ' q=pathlib.Path("compiler/primitives.ts");q.write_bytes(q.read_bytes()+b"\\n// injected source drift control\\n");p.write_text("injected")\n'+
 'raise SystemExit(r.returncode)\n')
shim.chmod(0o700)
rows=[];bun=str(root/'node_modules/.bin/bun')
for name,overrides,reason in [
 ('assertions-disabled',{'PYTHON':sys.executable,'PYTHONOPTIMIZE':'1'},'requires Python assertions enabled'),
 ('missing-python',{'PYTHON':str(base/'missing-python')},'ENOENT'),
 ('empty-output',{'PYTHON':'/usr/bin/true'},'JSON'),
 ('source-drift',{'PYTHON':str(shim)},'Wide proof inputs changed during qualification'),
]:
 report=private/'build/wide-refinement.json';report.write_bytes(prior)
 attempts=private/'build/wide-refinement-attempts';before=set(attempts.glob('*'))
 env={**os.environ,'PYTHONOPTIMIZE':'',**overrides}
 run=subprocess.run([bun,'verification/check-wide.ts'],cwd=private,env=env,capture_output=True,text=True,timeout=1200)
 text=run.stdout+run.stderr;log=base/(name+'.log');log.write_text(text)
 assert run.returncode!=0 and reason in text,(name,run.returncode,text[-5000:])
 assert not report.exists(),name
 added=set(attempts.glob('*'))-before;assert len(added)==1
 archive=added.pop()/'previous.json';assert archive.read_bytes()==prior
 rows.append({'name':name,'exitCode':run.returncode,'log':str(log),'logSha256':sha(log),'archive':str(archive),'archiveSha256':sha(archive)})
for name,digest in inputs.items():assert sha(root/name)==digest,name
assert receipt.read_bytes()==prior,'public receipt changed during isolated controls'
assert marker.read_text()=='injected'
report={'passed':True,'controls':rows,'sourceHashes':{str(root/name):digest for name,digest in inputs.items()},'publicReceipt':str(receipt),'publicReceiptSha256':sha(receipt),'testSha256':sha(__file__),'scope':'Four isolated actual-driver failure controls; public sources and receipt unchanged. Fresh positive qualification is a separate gate.'}
output=base/'report.json';output.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'report':str(output),'sha256':sha(output)}))
