from pathlib import Path
import os,sys,json,uuid,subprocess,shutil
root=Path('build/collection-entry');home=Path('verification/collection_entry/qualification');run=root/('qualified-'+str(uuid.uuid4()));run.mkdir(parents=True)
canonical=root/'fresh-receipt.json'
if canonical.exists():canonical.replace(run/'previous.json')
if not __debug__:raise RuntimeError('entry controller assertions required')
sys.path.insert(0,str(home))
import bundle_report as b
import fresh_report
sources=b.source_files()
prerequisites={}
for name,p in [('loader','build/loader/fresh-receipt.json'),('collection','build/collection-root/fresh-receipt.json')]:
 r=json.loads(Path(p).read_bytes());prerequisites[name]={k:r[k] for k in ['inputArtifact','inputSha256','reportArtifact','reportSha256']}
compiler=shutil.which(os.environ.get('CC','clang'));b.need(compiler is not None,'native compiler missing')
pre={'nativeCompiler':{'path':compiler,'sha256':b.sha(Path(compiler).read_bytes())},'version':1,'runId':run.name,'runDirectory':str(run),'sources':{str(p):b.sha(p.read_bytes()) for p in sources},'prerequisites':prerequisites}
before=run/'before.json';before.write_text(json.dumps(pre,indent=2)+'\n');before_raw=before.read_bytes()
python=os.environ.get('ENTRY_PYTHON',sys.executable);env=dict(os.environ,ENTRY_BUNDLE_INPUT=str(before))
def child(args,log):
 with (run/log).open('w') as out:
  c=subprocess.run([python,'-B',*args],stdout=out,stderr=subprocess.STDOUT,env=env)
 if c.returncode:raise RuntimeError('entry child failed: '+log+' exit '+str(c.returncode))
child([str(home/'prove-all.py')],'proof.log')
if not all((run/name).is_file() for name in b.NAMES if name!='native.json'):raise RuntimeError('entry child missing fresh reports')
child([str(home/'native_bundle.py')],'native.log')
if not (run/'native.json').is_file():raise RuntimeError('entry child missing fresh native report')
if before.read_bytes()!=before_raw:raise RuntimeError('entry pre-execution input changed')
post=dict(pre,children={n:{'path':str(run/n),'sha256':b.sha((run/n).read_bytes())} for n in b.NAMES})
after=run/'after.json';after.write_text(json.dumps(post,indent=2)+'\n')
child([str(home/'fresh_report.py'),str(before),str(after)],'validator.log')
expected=fresh_report.validate(before,after)
actual=json.loads((run/'validator.log').read_text());b.need(actual==expected,'independent validator result')
result=run/'accepted.json';result.write_text(json.dumps(expected,indent=2)+'\n')
receipt={'passed':True,'runId':run.name,'beforeArtifact':str(before),'beforeSha256':b.sha(before.read_bytes()),'inputArtifact':str(after),'inputSha256':b.sha(after.read_bytes()),'reportArtifact':str(result),'reportSha256':b.sha(result.read_bytes())}
tmp=run/'receipt.tmp';tmp.write_text(json.dumps(receipt,indent=2)+'\n');tmp.replace(canonical);print(run);print('Fresh collection entry bundle accepted')
