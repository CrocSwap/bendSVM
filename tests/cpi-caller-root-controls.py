"""Actual-C CPI root mutations with symbolic counterexamples."""
from pathlib import Path
import sys,json,copy,hashlib
sys.path.insert(0,'verification')
from acyclic_c import check
if not __debug__:raise RuntimeError('assertions required')
p=Path(sys.argv[1]);root=Path(sys.argv[2]);root.mkdir(parents=True,exist_ok=True);payload=json.loads(p.read_text());rows=[]
cases=[('wrong-state-arithmetic','(a0 + a1)','(a0 - a1)'),('second-payload-retained','(a0).as.c1.f2, a1, (a0).as.c1.f4','(a0).as.c1.f2, (a0).as.c1.f3, (a0).as.c1.f4')]
sha=lambda raw:hashlib.sha256(raw).hexdigest()
for f in payload['fixtures']:
 for name,old,new in cases:
  program=copy.deepcopy(f['program']);a=program['artifact'];assert a['c'].count(old)==1,(f['name'],name)
  a['c']=a['c'].replace(old,new);a['cSha256']=sha(a['c'].encode());claims=check(program)
  assert len(claims)==1 and claims[0]['result']=='sat' and claims[0]['wireArgs']
  folder=root/'root-controls'/f['name'];folder.mkdir(parents=True,exist_ok=True);dest=folder/(name+'.h');dest.write_text(a['c'])
  rows.append({'fixture':f['name'],'case':name,'mutatedHeader':str(dest),'sha256':sha(dest.read_bytes()),'claim':claims[0]});print(f['name'],name,'sat',flush=True)
report={'passed':True,'scope':__doc__+' Counterexamples are typed pure-root inputs; account authorization, CPI execution, native and SBF replay are not checked here.','controls':rows,'inputs':{str(x.resolve()):sha(x.read_bytes()) for x in (Path(__file__),p,Path('verification/acyclic_c.py'))}}
(root/'root-controls.json').write_text(json.dumps(report,indent=2)+'\n');print(root/'root-controls.json')
