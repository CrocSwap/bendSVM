"""Connect the twelve inline steps to actual nested-call record construction."""
from pathlib import Path
import contextlib,hashlib,json,os
base=Path(__file__).resolve().parent;repo=base.parents[1]
def fresh(name,log):
 p=base/name;ns={'__file__':str(p.resolve())}
 with (base/log).open('w') as out,contextlib.redirect_stdout(out):exec(compile(p.read_text(),str(p),'exec'),ns)
 return ns
inline=fresh('prove-div16-rest.py','div16-inline-prerequisite.log');frame=fresh('check-div16-frame.py','div16-frame-prerequisite.log');z=inline['z'];sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
last=inline['contexts'][12];rr=last['state']['registers'];mm=last['state']['memory'];pairs=[(a,b) for a,b in zip(frame['regs'],rr) if z.is_bv(a) and z.is_bv(b)];sub=lambda v:z.substitute(v,*pairs) if z.is_bv(v) else v
rows=[]
def prove(name,claim):
 s=z.Solver();s.set(timeout=10000);s.add(z.Not(claim));result=s.check()
 if result!=z.unsat:raise RuntimeError((name,str(result),s.reason_unknown()))
 rows.append({'name':name,'result':str(result)})
# Frame starts with a single initialized opaque pointer; all other caller memory
# is disjoint from [-40,0) and unused. Exact byte writes construct that record.
if mm[-80]!=frame['stack'][-80] or rr[10]!=frame['regs'][10]:raise RuntimeError('frame pointer precondition')
expected=frame['expected'];actual=frame['actual'];q,r,d=last['q'],last['r'],last['d']
word=z.Extract
want={0:z.BitVecVal(0,32),4:z.BitVecVal(0,32),8:word(31,0,q),12:word(63,32,q),16:z.BitVecVal(0,32),20:word(31,0,r),24:word(63,32,r),28:z.BitVecVal(0,32),32:word(31,0,d),36:word(63,32,d)}
prove('actual nested input equals twelve-step tagged state',z.And(*[sub(actual[k])==want[k] for k in want]))
# The after-call continuation is EXIT; no caller instruction can overwrite the
# callee result. CALL/frame allocation itself remains a VM ABI assumption.
top=Path(os.environ['SBF_DIVISION_LEAF_REPORT'])
if sha(top)!=os.environ['SBF_DIVISION_LEAF_SHA256']:raise RuntimeError('division qualification pointer')
doc=json.loads(top.read_text());cert=next(Path(p) for p in doc['reports'] if p.endswith('div4-composition-report.json'))
if sha(cert)!=doc['reports'][str(cert)]:raise RuntimeError('leaf report hash')
leaf=json.loads(cert.read_text())
if leaf['passed'] is not True or leaf['modeledInstructions']!=229 or len(leaf['claims'])!=9 or any(c['result']!='unsat' for c in leaf['claims']):raise RuntimeError('leaf certificate status')
for p,h in leaf['inputHashes'].items():
 if sha(p)!=h:raise RuntimeError('leaf input drift')
for p,h in leaf['prerequisites'].items():
 if sha(p)!=h:raise RuntimeError('leaf prerequisite drift')
 dep=json.loads(Path(p).read_text())
 for f,digest in dep['inputHashes'].items():
  if sha(f)!=digest:raise RuntimeError('leaf prerequisite input drift')
fresh_elf=cert.parents[2]/'build/sbf-slice-probe/vesting.so'
if sha(fresh_elf)!=sha(frame['elf']):raise RuntimeError('different inline and leaf artifact')
# Native input loads zero-extend all six limbs. Pack/unpack correspondence
# instantiates the universal div4 input without constraining q/r/d.
packedq=z.Concat(sub(actual[12]),sub(actual[8]));packedr=z.Concat(sub(actual[24]),sub(actual[20]));packedd=z.Concat(sub(actual[36]),sub(actual[32]))
prove('nested leaf arguments preserve full q/r/d',z.And(packedq==q,packedr==r,packedd==d))
reports=[base/'div16-rest-report.json',base/'div16-steps-three-four-report.json',base/'div16-first-two-report.json',base/'div16-frame-report.json',cert,top]
for p in reports[:4]:
 obj=json.loads(p.read_text())
 for f,h in obj['inputHashes'].items():
  if sha(f)!=h:raise RuntimeError('inline/frame input drift')
report={'passed':True,'exploratory':True,'endToEndVerified':False,'claims':rows,'inlineInstructions':658,'frameInstructions':16,'nestedLeafInstructions':229,'reports':{str(p):sha(p) for p in reports},'inputHashes':{str(p):sha(p) for p in [Path(__file__),base/'prove-div16-rest.py',base/'check-div16-frame.py',frame['elf']]},'scope':'Composed twelve inline restoring steps and actual tagged40byte nested-call input, bound to the same ELF universal four-step div4 certificate. Conditional sixteen-step arithmetic result uses trusted SBF CALL/return with valid disjoint callee frame/input/output and no post-call writes (caller continuation is EXIT). Does not prove VM call semantics, source extraction, complete division quotient or original handler.'}
(base/'div16-composition-report.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'passed':True,'bridgeClaims':len(rows),'inlineInstructions':658,'frameInstructions':16,'leafInstructions':229}))
