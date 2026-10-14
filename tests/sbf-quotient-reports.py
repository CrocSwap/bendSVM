"""Corrupt copies of each qualification report; preserve positive evidence."""
from pathlib import Path
import copy,hashlib,importlib.util,json,os,sys
repo=Path(__file__).resolve().parents[1];module=repo/'verification/sbf_quotient/validate.py';s=importlib.util.spec_from_file_location('quotient_validator',module);v=importlib.util.module_from_spec(s);s.loader.exec_module(v)
latest=Path(os.environ['SBF_QUOTIENT_TEST_LATEST']);ptr=json.loads(latest.read_text());top_file=Path(ptr['runRoot'])/'report.json';need=lambda b:None if b else (_ for _ in ()).throw(RuntimeError('evidence binding'))
need(v.sha(top_file)==ptr['reportSha256']);top=json.loads(top_file.read_text());ctx=v.context(top['leafReport'],Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin'))))
protected={str(p):v.sha(p) for p in [latest,top_file,*map(Path,top['reports'])]};rows=[]
def refuse(name,data,path,mutate,reason):
 bad=copy.deepcopy(data);mutate(bad)
 try:v.validate(bad,path,ctx)
 except ValueError as error:
  if str(error)!=reason:raise RuntimeError((name,str(error),reason))
 else:raise RuntimeError('accepted '+name)
 rows.append({'name':name,'reason':reason})
for file in top['reports']:
 path=Path(file);data=json.loads(path.read_text());role=v.role(path);v.validate(data,path,ctx)
 for key in data:refuse(role+' missing '+key,data,path,lambda d,k=key:d.pop(k),'report fields')
 refuse(role+' false success',data,path,lambda d:d.update(passed=False),'fixed field passed')
 for key in ['inputHashes','sourceHashes','reports']:
  if key not in data:continue
  refuse(role+' empty '+key,data,path,lambda d,k=key:d.update({k:{}}),'binding inventory')
  refuse(role+' stale '+key,data,path,lambda d,k=key:d[k].update({next(iter(d[k])):'0'*64}),'binding drift')
 for key in ['claims','loop','shortcut']:
  if key not in data:continue
  refuse(role+' omitted '+key,data,path,lambda d,k=key:d[k].pop(),'claim inventory')
  refuse(role+' unknown '+key,data,path,lambda d,k=key:d[k][0].update(result='unknown'),'claim identity or result')
  if len(data[key])>1:refuse(role+' duplicate '+key,data,path,lambda d,k=key:d[k].__setitem__(1,d[k][0]),'claim fields' if set(data[key][0])!=set(data[key][1]) else 'claim identity or result')
 # Fault/nonvacuity claims may carry witnesses inside the claims array.
 # Check each one, not only the first (usually UNSAT) positive claim.
 for index,claim in enumerate(data.get('claims',[])):
  if claim.get('result')!='sat':continue
  refuse(role+' empty claim witness '+str(index),data,path,lambda d,i=index:d['claims'][i].update(witness=''),'claim witness')
  refuse(role+' absent claim witness '+str(index),data,path,lambda d,i=index:d['claims'][i].pop('witness'),'claim fields')
  refuse(role+' undetected claim fault '+str(index),data,path,lambda d,i=index:d['claims'][i].update(result='unsat'),'claim identity or result')
 if 'fault' in data:
  refuse(role+' undetected fault',data,path,lambda d:d['fault'].update(result='unsat'),'fault control')
  refuse(role+' missing witness',data,path,lambda d:d['fault'].update(witness=''),'fault witness')
 if 'prerequisite' in data:refuse(role+' stale prerequisite',data,path,lambda d:d.update(prerequisiteSha256='0'*64),'prerequisite')
 if 'rows' in data:
  refuse(role+' missing execution',data,path,lambda d:d['rows'].pop(),'execution inventory')
  refuse(role+' duplicate execution',data,path,lambda d:d['rows'].__setitem__(1,d['rows'][0]),'execution identity')
  if role=='faults':
   refuse(role+' stale fault ELF',data,path,lambda d:d['rows'][1].update(elfSha256='0'*64),'fault artifact binding')
   refuse(role+' wrong failure reason',data,path,lambda d:d['rows'][1].update(expectedReason='wrong'),'execution identity')
  else:
   for index in [0,len(data['rows'])-1]:
    refuse(role+' reversed VM outcome '+str(index),data,path,lambda d,i=index:d['rows'][i]['result'].update(ok=not d['rows'][i]['result']['ok']),'VM outcome')
   badindex=next(i for i,r in enumerate(data['rows']) if not r['result']['ok'])
   refuse(role+' wrong refusal code',data,path,lambda d,i=badindex:d['rows'][i]['result'].update(code=0),'VM refusal code')
   refuse(role+' absent VM logs',data,path,lambda d:d['rows'][0]['result'].update(logs=[]),'VM logs')
 if 'artifacts' in data:
  refuse(role+' missing artifact',data,path,lambda d:d['artifacts'].pop(next(iter(d['artifacts']))),'artifact inventory')
  for name,a in data['artifacts'].items():
   if 'files' in a:
    refuse(role+' missing files '+name,data,path,lambda d,n=name:d['artifacts'][n].update(files={}),'binding inventory')
    refuse(role+' stale body '+name,data,path,lambda d,n=name:d['artifacts'][n].update(bodySha256='0'*64),'body bytes')
   else:refuse(role+' missing files '+name,data,path,lambda d,n=name:d['artifacts'].update({n:{}}),'binding inventory')
for p,h in protected.items():need(v.sha(p)==h)
report={'passed':True,'refusals':rows,'protectedHashes':protected,'sourceHashes':{str(p):v.sha(p) for p in [Path(__file__).resolve(),module,module.with_name('report-schema.json')]}}
out=Path(os.environ['SBF_QUOTIENT_TEST_DIR'])/'report-controls.json';out.write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'refusals':len(rows),'report':str(out),'sha256':v.sha(out)}))
