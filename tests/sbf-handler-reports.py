"""Reject corrupted copies of handler reports without changing positive evidence."""
from pathlib import Path
import copy,importlib.util,json,os
if not __debug__:raise RuntimeError('assertions required')
repo=Path(__file__).resolve().parents[1];module=repo/'verification/sbf_handler/validate.py';s=importlib.util.spec_from_file_location('handler_validator',module);v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
latest=Path(os.environ['SBF_HANDLER_TEST_LATEST']);ptr=json.loads(latest.read_text());root=Path(ptr['runRoot'])/'report.json';assert v.sha(root)==ptr['reportSha256'];top=json.loads(root.read_text());ctx=v.context(top['quotientReport'],Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin'))));rows=[]
protected={str(p):v.sha(p) for p in [latest,root,*map(Path,top['reports'])]}
def refuse(name,data,path,change):
 bad=copy.deepcopy(data);change(bad)
 try:v.validate(bad,path,ctx)
 except ValueError as error:rows.append({'name':name,'reason':str(error)})
 else:raise RuntimeError('accepted '+name)
for file in top['reports']:
 path=Path(file);data=json.loads(path.read_text());label=v.role(path);v.validate(data,path,ctx)
 for key in data:refuse(label+' missing '+key,data,path,lambda d,k=key:d.pop(k))
 refuse(label+' false success',data,path,lambda d:d.update(passed=False))
 for key in ['inputHashes','reports','evidenceHashes']:
  if key not in data:continue
  refuse(label+' missing '+key+' inventory',data,path,lambda d,k=key:d.update({k:{}}))
  refuse(label+' stale '+key,data,path,lambda d,k=key:d[k].update({next(iter(d[k])):'0'*64}))
 for key in ['claims','faults','controls','fields','rows','calls']:
  if key not in data or not data[key]:continue
  refuse(label+' omitted '+key,data,path,lambda d,k=key:d[k].pop())
  if len(data[key])>1:refuse(label+' duplicated '+key,data,path,lambda d,k=key:d[k].__setitem__(1,d[k][0]))
 if 'claims' in data:refuse(label+' unknown solver result',data,path,lambda d:d['claims'][0].update(result='unknown'))
 if 'fault' in data:
  refuse(label+' undetected fault',data,path,lambda d:d['fault'].update(result='unsat'))
  if 'witness' in data['fault']:refuse(label+' empty fault witness',data,path,lambda d:d['fault'].update(witness=''))
 if 'artifacts' in data:
  refuse(label+' missing artifact',data,path,lambda d:d['artifacts'].pop(next(iter(d['artifacts']))))
  for name in data['artifacts']:
   refuse(label+' missing files '+name,data,path,lambda d,n=name:d['artifacts'][n].update(files={}))
   refuse(label+' wrong syscall '+name,data,path,lambda d,n=name:d['artifacts'][n]['memorySyscallRelocation'].__setitem__(2,'sol_memcpy_'))
  for index in [0,next(i for i,r in enumerate(data['rows']) if r['kind']=='fault')]:
   refuse(label+' reversed outcome '+str(index),data,path,lambda d,i=index:d['rows'][i]['result'].update(ok=not d['rows'][i]['result']['ok']))
  refuse(label+' missing VM logs',data,path,lambda d:d['rows'][0]['result'].update(logs=[]))
  refuse(label+' wrong expected record',data,path,lambda d:d['rows'][0].update(expectedSha256='0'*64))
# Copy all VM artifacts, then change instruction bytes and update their file hash.
# A self-consistent file hash must not substitute for the reviewed replay body.
vmfile=next(Path(p) for p in top['reports'] if v.role(Path(p))=='native-vm')
vm=json.loads(vmfile.read_text());cloned=copy.deepcopy(vm)
clone_dir=Path(os.environ['SBF_HANDLER_TEST_DIR'])/'native-dispatch-replays'/'byte-control';clone_dir.mkdir(parents=True)
clone_report=clone_dir/'report.json'
for name,artifact in cloned['artifacts'].items():
 fresh={}
 for file in artifact['files']:
  source=Path(file);dest=clone_dir/source.name;dest.write_bytes(source.read_bytes());fresh[str(dest)]=v.sha(dest)
 artifact['files']=fresh
v.validate(cloned,clone_report,ctx)
image=clone_dir/'baseline.so';blob=image.read_bytes();_,body=v.text_section(blob);offset=blob.find(body)
assert offset>=0 and blob.find(body,offset+1)==-1
bad=bytearray(blob);bad[offset]^=1;image.write_bytes(bad)
cloned['artifacts']['baseline']['files'][str(image)]=v.sha(image)
try:v.validate(cloned,clone_report,ctx)
except ValueError as error:
 if str(error)!='native replay bytes':raise RuntimeError(('wrong replay refusal',str(error)))
 rows.append({'name':'native-vm rehashed changed instruction body','reason':str(error)})
else:raise RuntimeError('accepted changed native replay body')
for p,h in protected.items():assert v.sha(p)==h
report={'passed':True,'refusals':rows,'protectedHashes':protected,'sourceHashes':{str(p):v.sha(p) for p in [Path(__file__).resolve(),module,module.with_name('report-schema.json'),repo/'verification/sbf_elf.py']}}
p=Path(os.environ['SBF_HANDLER_TEST_DIR'])/'report-controls.json';p.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'refusals':len(rows),'report':str(p),'sha256':v.sha(p)}))
