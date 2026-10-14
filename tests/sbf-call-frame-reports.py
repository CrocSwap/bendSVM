from pathlib import Path
import copy,json,uuid
import sys
sys.path.insert(0,'verification/sbf_call_frame/qualification')
import report as v
if not __debug__:raise RuntimeError('assertions required')
receipt=v.read(v.OUT/'fresh-receipt.json');data=v.read(receipt['input']);manifest=v.read(receipt['manifest']);v.validate(data,manifest)
protected={p:v.sha(p) for p in [receipt['input'],receipt['manifest'],receipt['accepted'],*[m['path'] for m in manifest.values()]]}
root=v.OUT/('report-controls-'+str(uuid.uuid4()));root.mkdir();rows=[]
def clone(name):
 run=root/name;run.mkdir();d=copy.deepcopy(data);d['runId']=run.name;d['runDirectory']=str(run);m={}
 for n in v.NAMES:
  obj=v.read(manifest[n]['path']);key='inputs' if 'inputs' in obj else 'inputHashes'
  bindings={}
  for p,h in obj[key].items():
   prior=Path(p)
   target=run/prior.name if str(prior.parent)==data['runDirectory'] else prior
   bindings[str(target)]=v.sha(target)
  obj[key]=bindings;(run/n).write_text(json.dumps(obj,indent=2)+'\n');m[n]={'path':str(run/n),'sha256':v.sha(run/n)}
 v.validate(d,m);return run,d,m
def attempt(label,target,change,wanted=None):
 run,d,m=clone(str(len(rows)))
 if target=='input':change(d)
 elif target=='manifest':change(m)
 else:
  obj=v.read(m[target]['path']);change(obj);Path(m[target]['path']).write_text(json.dumps(obj,indent=2)+'\n');m[target]['sha256']=v.sha(m[target]['path'])
  # Rebind dependent report hashes so a claim refusal cannot be attributed
  # merely to an obsolete prerequisite digest.
  if target!=v.NAMES[2]:
   p=run/v.NAMES[2];obj=v.read(p)
   obj['inputs'][str(run/target)]=v.sha(run/target);p.write_text(json.dumps(obj,indent=2)+'\n');m[v.NAMES[2]]['sha256']=v.sha(p)
 (run/'input.json').write_text(json.dumps(d,indent=2)+'\n');(run/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
 try:v.validate(d,m)
 except ValueError as error:
  if wanted is not None:assert str(error)==wanted,(label,str(error))
  rows.append({'name':label,'reason':str(error),'directory':str(run)})
 else:raise RuntimeError('accepted '+label)
for n in v.NAMES:
 attempt(n+' numeric-success',n,lambda d:d.update(passed=1))
 attempt(n+' scope-overclaim',n,lambda d:d.update(scope='verified VM'))
 attempt(n+' missing-source',n,lambda d:d['inputs' if 'inputs' in d else 'inputHashes'].pop(next(iter(d['inputs' if 'inputs' in d else 'inputHashes']))))
 attempt(n+' omitted-control',n,lambda d:d['controls'].pop() if 'controls' in d else d.pop('control'))
 if n!='footprint-report.json':
  attempt(n+' unknown-claim',n,lambda d:d['claims'][0].update(result='unknown'))
  attempt(n+' empty-witness',n,lambda d:(d['controls'][0] if 'controls' in d else d['control']).update(witness=''))
 else:
  attempt(n+' omitted-access',n,lambda d:d['parent']['accesses'].pop())
  attempt(n+' shifted-access',n,lambda d:d['leaf']['accesses'][0].update(offset=4096))
  attempt(n+' float-instruction-count',n,lambda d:d['parent'].update(instructions=float(d['parent']['instructions'])))
  attempt(n+' omitted-nested-call',n,lambda d:d['parent']['calls'].pop())
attempt('missing-child','manifest',lambda d:d.pop(v.NAMES[0]))
attempt('wrong-child-path','manifest',lambda d:d[v.NAMES[0]].update(path=manifest[v.NAMES[0]]['path']))
attempt('missing-source-inventory','input',lambda d:d['sources'].pop(next(iter(d['sources']))))
attempt('wrong-handler-binding','input',lambda d:d['qualification'].update(sha256='0'*64))
for role,offset in [('output',-0x158),('payout',-0x128),('authorization',-0x160)]:
 attempt('omitted-'+role+'-pending-word','connection-report.json',
  lambda d,off=offset:d['protectedOffsets'].remove(off),
  'claim/footprint/scope inventory connection-report.json')
for role in ['claim-output','payout','authorization']:
 attempt('missing-'+role+'-frame-binding','connection-report.json',
  lambda d,r=role:d['inputs'].pop(next(p for p in d['inputs'] if p.endswith('/'+r+'-frame-report.json'))),
  'child source inventory')
assert len(rows)==30,len(rows)
for p,h in protected.items():assert v.sha(p)==h
result={'passed':True,'controls':rows,'positiveReceipt':receipt}
(root/'report.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({'passed':True,'controls':len(rows),'report':str(root/'report.json')}))
