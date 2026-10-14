"""Exact evidence inventories for conditional native handler qualification."""
from pathlib import Path
import hashlib,json,sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from sbf_elf import text_section
if not __debug__:raise RuntimeError('assertions required')
SCHEMA=json.loads(Path(__file__).with_name('report-schema.json').read_text())
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,msg):
 if not ok:raise ValueError(msg)
def role(p):
 p=Path(p)
 if p.name=='layout-report.json':return p.parent.name
 if p.name=='report.json' and 'native-dispatch-replays' in p.parts:return 'native-vm'
 return p.name
def resolve(token,path,ctx):
 anchor,relative=token.split(':',1);return (path.parent if anchor=='run' else ctx[anchor])/relative
def context(quotient,tools):
 q=json.loads(Path(quotient).read_text());leaf=json.loads(Path(q['leafReport']).read_text());pf=next(Path(p) for p in leaf['reports'] if '/product/runs/' in p and p.endswith('/report.json') and '/source/' not in p)
 return {'stage':pf.parent/'source','tools':Path(tools)}
def validate(data,path,ctx):
 path=Path(path);name=role(path);need(name in SCHEMA,'report role')
 def walk(value,spec):
  if isinstance(spec,dict) and '$kind' in spec:
   kind=spec['$kind']
   if kind=='bindings':
    expected={str(resolve(t,path,ctx)) for t in spec['paths']};need(type(value) is dict and set(value)==expected,'binding inventory')
    for p,h in value.items():need(type(h) is str and sha(p)==h,'binding drift')
    if 'nativeTextSha256' in spec:
     images=[Path(p) for p in value if p.endswith('.so')];need(len(images)==1,'native image inventory');_,body=text_section(images[0].read_bytes());need(hashlib.sha256(body).hexdigest()==spec['nativeTextSha256'],'native replay bytes')
   elif kind=='path':need(value==str(resolve(spec['path'],path,ctx)),'evidence path')
   elif kind=='fileHash':need(value==sha(resolve(spec['path'],path,ctx)),'evidence hash')
   elif kind in ['witness','integerWitness']:
    if kind=='witness' and spec['type']=='str':need(type(value) is str and bool(value),'witness')
    else:need(type(value) is dict and sorted(value)==spec['keys'] and bool(value) and all(type(v) is int and 0<=v<2**64 for v in value.values()),'integer witness')
   elif kind=='vmResult':
    need(type(value) is dict and sorted(value)==spec['keys'],'VM fields');need(value['ok'] is spec['ok'],'VM outcome')
    need(type(value['logs']) is list and bool(value['logs']) and all(type(s) is str for s in value['logs']),'VM logs')
    need(type(value['units']) is int and value['units']>=0,'VM units')
    if not value['ok']:need(type(value['code']) is int and value['code']==42 and type(value['error']) is str and bool(value['error']),'VM refusal')
   else:raise ValueError('unknown schema kind')
  elif isinstance(spec,dict):
   need(type(value) is dict and set(value)==set(spec),'object inventory')
   for k,v in spec.items():walk(value[k],v)
  elif isinstance(spec,list):
   need(type(value) is list and len(value)==len(spec),'list inventory')
   for a,b in zip(value,spec):walk(a,b)
  else:need(type(value) is type(spec) and value==spec,'fixed evidence')
 walk(data,SCHEMA[name])
 if name=='native-vm':
  for row in data['rows']:
   a,n,e,t,c,signed,mismatch,st,it=row['input']
   if st==0:error=2 if it==1 else 1 if not signed else 3 if a>=e or t==0 else 0
   elif it==0:error=7
   else:
    q=0 if n<=a else t if n>=e else t*(n-a)//(e-a);error=1 if not signed or mismatch!=-1 else 4 if q>t else 5 if q<c else 6 if q==c else 0
   need(row['error']==error,'independent dispatch oracle')
