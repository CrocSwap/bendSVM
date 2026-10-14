"""Exact evidence inventories for the conditional division qualification."""
from pathlib import Path
import hashlib,json,math
if not __debug__:raise RuntimeError('assertions required')
SCHEMA=json.loads(Path(__file__).with_name('report-schema.json').read_text())
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,message):
 if not ok:raise ValueError(message)
def same(a,b):return json.dumps(a,sort_keys=True,separators=(',',':'))==json.dumps(b,sort_keys=True,separators=(',',':'))
def role(path):
 path=Path(path)
 if path.name!='report.json':return path.name
 if 'div16-faults' in path.parts:return 'faults'
 if 'div16-fault-replays' in path.parts:return 'helper-vm'
 if 'caller-replays' in path.parts:return 'caller-vm'
 raise ValueError('unknown report role')
def context(leaf,tools):
 leaf=Path(leaf);doc=json.loads(leaf.read_text());comp=next(Path(p) for p in doc['reports'] if p.endswith('div4-composition-report.json'));stage=comp.parents[2];scout=comp.parent
 entry=json.loads((scout/'caller-entry-report.json').read_text());bridges=[Path(p) for p in entry['reports'] if p.endswith('/bridge.json')]
 need(len(bridges)==1 and bridges[0].parent.parent==scout/'runs','bridge location')
 return {'stage':stage,'tools':Path(tools),'leaf-report':leaf,'bridge-report':bridges[0]}
def resolve(token,path,ctx):
 if token in ['leaf-report','bridge-report']:return ctx[token]
 anchor,relative=token.split(':',1);base=path.parent if anchor=='run' else ctx[anchor]
 return base/relative
def bindings(values,expected):
 need(type(values) is dict and set(values)==set(map(str,expected)),'binding inventory')
 for p,h in values.items():need(type(h) is str and sha(p)==h,'binding drift')
def validate(data,path,ctx):
 path=Path(path);name=role(path);spec=SCHEMA[name]
 need(type(data) is dict and sorted(data)==spec['keys'],'report fields')
 for k,want in spec['fixed'].items():need(same(data[k],want),'fixed field '+k)
 need(type(data['scope']) is str and bool(data['scope']),'scope')
 for key in ['inputHashes','sourceHashes','reports']:
  if key in spec:bindings(data[key],[resolve(t,path,ctx) for t in spec[key]])
 if 'prerequisite' in spec:
  p=resolve(spec['prerequisite'],path,ctx);need(data['prerequisite']==str(p) and data['prerequisiteSha256']==sha(p),'prerequisite')
 for key in ['claims','loop','shortcut']:
  if key not in spec:continue
  rows=data[key];need(type(rows) is list and len(rows)==len(spec[key]),'claim inventory')
  for row,want in zip(rows,spec[key]):
   need(type(row) is dict,'claim object')
   extras={'seconds'} if key in ['loop','shortcut'] else {'witness'} if want.get('result')=='sat' else set()
   need(set(row)==set(want)|extras,'claim fields')
   need(same({k:v for k,v in row.items() if k not in extras},want),'claim identity or result')
   if 'seconds' in extras:need(type(row['seconds']) in [int,float] and math.isfinite(row['seconds']) and row['seconds']>=0,'claim time')
   if 'witness' in extras:need(type(row['witness']) is str and bool(row['witness']),'claim witness')
 if 'fault' in spec:
  f=data['fault'];need(type(f) is dict and set(f)==set(spec['fault'])|{'witness'} and same({k:v for k,v in f.items() if k!='witness'},spec['fault']),'fault control')
  need(type(f['witness']) is str and bool(f['witness']),'fault witness')
 if 'rows' in spec:
  rows=data['rows'];need(type(rows) is list and len(rows)==len(spec['rows']),'execution inventory')
  for row,want in zip(rows,spec['rows']):
   ignored={'elf','elfSha256','log','logSha256'} if name=='faults' else {'result'}
   need(type(row) is dict and set(row)==set(want)|ignored,'execution fields')
   need(same({k:v for k,v in row.items() if k not in ignored},want),'execution identity')
   if name=='faults':
    case=path.parent/row['name'];elf=case/'build/sbf-slice-probe/vesting.so';log=case/'process.log'
    need(row['elf']==str(elf) and row['elfSha256']==sha(elf) and row['log']==str(log) and row['logSha256']==sha(log),'fault artifact binding')
    text=log.read_text()
    if row['name']=='baseline':need(json.loads(text)['passed'] is True,'fault baseline evidence')
    else:need(row['expectedReason'] in text and "'sat'" in text,'fault semantic evidence')
   else:
    r=row['result'];ok=row['kind'] in ['baseline','mutant-model']
    need(type(r) is dict and r.get('ok') is ok,'VM outcome')
    need(type(r.get('logs')) is list and bool(r['logs']) and all(type(s) is str for s in r['logs']),'VM logs')
    if not ok:need(type(r.get('code')) is int and r['code']==42,'VM refusal code')
    if name=='caller-vm' and row['kind']=='baseline':
     q,h,d=row['input'];need(d>0 and h<d and row['expected']==((h<<64)|q)//d,'independent quotient')
 if 'artifacts' in spec:
  need(type(data['artifacts']) is dict and set(data['artifacts'])==set(spec['artifacts']),'artifact inventory')
  for name,want in spec['artifacts'].items():
   artifact=data['artifacts'][name];files=artifact.get('files',artifact)
   bindings(files,[path.parent/(name+s) for s in ['.s','.o','.so','.log']])
   if want:
    need(set(artifact)==set(want)|{'files','bodySha256'} and same({k:v for k,v in artifact.items() if k not in ['files','bodySha256']},want),'body structure')
    import sys
    sys.path.insert(0,str(ctx['stage']/'verification'))
    from sbf_elf import text_section
    _,text=text_section((path.parent/(name+'.so')).read_bytes());off=artifact['bodyOffset'];count=artifact['bodyBytes']
    need(len(text)==off+count and hashlib.sha256(text[off:]).hexdigest()==artifact['bodySha256'],'body bytes')
