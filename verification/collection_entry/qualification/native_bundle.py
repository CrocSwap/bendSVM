"""Fresh native replay of the same generated collection artifact as the proof."""
from pathlib import Path
import json,sys,os,re,shutil,subprocess
import bundle_report as b
if not __debug__:raise RuntimeError('native entry assertions required')
CASES=[('baseline',None,None,None,''),
 ('alias','collection-store.c','if(equal_key(accounts[i].key,accounts[j].key))','if(0&&equal_key(accounts[i].key,accounts[j].key))','entry refusal reached handler'),
 ('mode','collection-store.c','ix[0]>1','ix[0]>2','entry refusal reached handler'),
 ('count','collection-store.c','if(count!=3)','if(count>3)','entry refusal status mismatch'),
 ('record-byte-offset','bend_collection_runtime.h','return c->account->data + BEND_COLLECTION_HEADER +','return c->account->data + 1 + BEND_COLLECTION_HEADER +','collection bytes mismatch'),
 ('record-neighbor-offset','bend_collection_runtime.h','return c->account->data + BEND_COLLECTION_HEADER +','return c->account->data + 4 + BEND_COLLECTION_HEADER +','collection bytes mismatch')]
SCOPE='Native serialized entrypoint under ASan/UBSan: 171 baseline cases and five deliberate faults. Test-only handler-entry counter and clock/return stubs; no SBF or VM mapping theorem.'
def texts(data,case):
 rec=data['prerequisites']['collection'];d=json.loads(Path(rec['inputArtifact']).read_bytes());files=d['caller']['artifactPaths']
 sources=dict(d['caller']['includePaths']);sources.update({n:files[n] for n in ['collection-store.c','collection-store.h','collection-store.wire.h']})
 out={n:Path(p).read_text() for n,p in sources.items()}
 pattern=r'(__attribute__\(\(noinline\)\) static u64 bend_collection_run\([^\n]+\) \{)'
 out['collection-store.c'],count=re.subn(pattern,r'\1run_calls++;',out['collection-store.c']);b.need(count==1,'native instrumentation count')
 name,target,old,new,reason=case
 if target:b.need(out[target].count(old)==1,'native mutation count');out[target]=out[target].replace(old,new)
 out['main.c']=Path('tests/collection-entry-native.h').read_text();return out

def validate(report,data):
 b.need(set(report)=={'passed','scope','cases','compiler','replays','collectionInputSha256'},'native report fields')
 b.need(report['passed'] is True and report['scope']==SCOPE,'native report scope')
 b.need(type(report['cases']) is int and report['cases']==171,'native case count')
 compiler=data['nativeCompiler'];b.need(report['compiler']==compiler,'native compiler binding')
 b.need(b.sha(Path(compiler['path']).read_bytes())==compiler['sha256'],'native compiler drift')
 b.need(report['collectionInputSha256']==data['prerequisites']['collection']['inputSha256'],'native input binding')
 b.need(isinstance(report['replays'],list) and len(report['replays'])==6,'native replay inventory')
 for row,case in zip(report['replays'],CASES):
  name,target,old,new,reason=case;directory=Path(data['runDirectory'])/'native'/name;expected=texts(data,case)
  b.need(set(row)=={'name','compileExit','exitCode','files'},'native replay fields')
  b.need(row['name']==name and type(row['compileExit']) is int and row['compileExit']==0 and type(row['exitCode']) is int and row['exitCode']==(42 if target else 0),'native replay status')
  b.need(set(row['files'])=={str(directory/n) for n in list(expected)+['run','compile.log','run.log']},'native file inventory')
  for n,t in expected.items():b.need((directory/n).read_text()==t,'native source mismatch: '+name+'/'+n)
  for p,h in row['files'].items():b.need(b.sha(Path(p).read_bytes())==h,'native artifact drift')
  b.need((directory/'run.log').read_text()==(reason+'\n' if target else '171 caller cases passed\n'),'native run diagnostic')
if __name__=='__main__':
 data=json.loads(Path(os.environ['ENTRY_BUNDLE_INPUT']).read_bytes());run=Path(data['runDirectory']);rows=[]
 compiler=data['nativeCompiler'];b.need(b.sha(Path(compiler['path']).read_bytes())==compiler['sha256'],'native compiler changed before run')
 for case in CASES:
  name,target,old,new,reason=case;out=run/'native'/name;out.mkdir(parents=True)
  for n,t in texts(data,case).items():(out/n).write_text(t)
  c=subprocess.run([compiler['path'],'-std=c11','-O1','-fsanitize=address,undefined','-fno-sanitize-recover=all',str(out/'main.c'),'-o',str(out/'run')],capture_output=True,text=True,timeout=60)
  (out/'compile.log').write_text(c.stdout+c.stderr);b.need(c.returncode==0,'native compilation failed')
  x=subprocess.run([str(out/'run')],capture_output=True,text=True,timeout=30);(out/'run.log').write_text(x.stdout+x.stderr)
  rows.append({'name':name,'compileExit':c.returncode,'exitCode':x.returncode,'files':{str(p):b.sha(p.read_bytes()) for p in out.iterdir()}})
 report={'passed':True,'scope':SCOPE,'cases':171,'compiler':compiler,'replays':rows,'collectionInputSha256':data['prerequisites']['collection']['inputSha256']}
 validate(report,data);(run/'native.json').write_text(json.dumps(report,indent=2)+'\n');print('Native baseline and five faults passed')
