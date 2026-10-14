from pathlib import Path
import sys,json,copy,hashlib
sys.path.insert(0,'verification')
from cpi_caller.binding import Validation
import z3 as z
assert __debug__
p=Path(sys.argv[1]);root=Path(sys.argv[2]);root.mkdir(parents=True,exist_ok=True);f=json.loads(p.read_text())['fixtures'][0]
v=Validation(f['files']);b=lambda n,w=32:z.BitVecVal(n,w)
slot={(n,):b(x) for n,x in [('active',1),('program',2),('length',1),('count',1)]}
for prefix,size,value in [(('program_key',),32,3),(('data',),64,42)]+[(('metas',i,'key'),32,5 if i==0 else 0) for i in range(8)]:
 for j in range(size):slot[(prefix,j)]=b(value if j==0 else 0,8)
for i in range(8):
 for n,x in [('index',4 if i==0 else 0),('writable',1 if i==0 else 0),('signer',1 if i==0 else 0)]:slot[('metas',i,n)]=b(x)
accounts={'account_key':[b(i+1,256) for i in range(12)],**{n:[b(1) for _ in range(12)] for n in ['executable','writable','signer']}}
rows=[]
def check(name,s,a,count,expected):
 actual,claims,_=v.bind(s,count,a);assert z.is_bv_value(actual),(name,actual)
 assert actual.as_long()==expected,(name,actual,expected)
 assert all(z.is_true(z.simplify(x)) for x in claims.values()),name
 rows.append({'name':name,'return':actual.as_long()})
check('valid-active',slot,accounts,b(5,64),0)
for name,loc,value,error in [('wrong-program',('program',),3,19),('wrong-program-key',(('program_key',),0),8,19),('payload-padding',('length',),0,20),('oversize-length',('length',),65,20),('oversize-meta-count',('count',),9,20),('wrong-meta-index',('metas',0,'index'),12,21),('wrong-meta-key',(('metas',0,'key'),0),9,21),('nonboolean-writable',('metas',0,'writable'),2,21),('nonboolean-signer',('metas',0,'signer'),2,21)]:
 s=dict(slot);s[loc]=b(value,s[loc].size());check(name,s,accounts,b(5,64),error)
for name,index,error in [('executable',2,19),('writable',4,21),('signer',4,21)]:
 a={k:list(vals) for k,vals in accounts.items()};a[name][index]=b(0);check('account-'+name,slot,a,b(5,64),error)
refusals=[]
for name in ['missing-field','extra-field','wrong-field-width','missing-account','short-account','wrong-account-width','wrong-count-width']:
 s=dict(slot);a={k:list(vals) for k,vals in accounts.items()};count=b(5,64)
 if name=='missing-field':del s[('count',)]
 if name=='extra-field':s[('invented',)]=b(0)
 if name=='wrong-field-width':s[('count',)]=b(1,64)
 if name=='missing-account':del a['signer']
 if name=='short-account':a['signer'].pop()
 if name=='wrong-account-width':a['signer'][0]=b(1,8)
 if name=='wrong-count-width':count=b(5)
 try:v.bind(s,count,a)
 except ValueError as e:refusals.append({'name':name,'reason':str(e)})
 else:raise RuntimeError('accepted '+name)
_,claims,_=v.bind(slot,b((1<<32)+5,64),accounts);assert z.is_false(z.simplify(claims['caller-count']))
files=[Path(__file__),Path('verification/cpi_caller/binding.py'),p]
(root/'binding-controls.json').write_text(json.dumps({'passed':True,'scope':'Concrete parsed validator return checks and strict binding inventory controls; no root/caller/VM composition.','returns':rows,'refusals':refusals,'fullWidthCountRejected':True,'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}},indent=2)+'\n')
print('13 concrete returns, 7 binding refusals, full-width count refusal passed')
