"""Staged obligation callback equivalence and fail-closed controls."""
if not __debug__:raise RuntimeError('assertions required')
from pathlib import Path
import sys,json,hashlib
sys.path.insert(0,'verification')
import multi_adapter_contract as m
assert __debug__
p,out=map(Path,sys.argv[1:]);out.unlink(missing_ok=True)
files=sorted(set([p,Path(__file__),Path(m.__file__),*Path('verification').rglob('*.py')]))
def hashes():return {str(x):hashlib.sha256(x.read_bytes()).hexdigest() for x in files}
before=hashes()
f=json.loads(p.read_text())['fixtures'][0]; summary=m.summarize(f['schema'],f['interface'])
base=m.analyse(summary,f,f['files'],require_witnesses=False)
calls=[]
def delegate(world,label,formula):
 calls.append(label)
 return m.check_unsat(world,label,formula)
actual=m.analyse(summary,f,f['files'],require_witnesses=False,obligation_check=delegate)
assert calls and len(calls)==len(set(calls))
positive_groups=list(calls)
assert {k:v for k,v in base.items() if k!='seconds'}=={k:v for k,v in actual.items() if k!='seconds'}
print('Default and delegated obligation reports equivalent',flush=True)
executor=m.MultiExec
class FalseFinal(executor):
 def run(self,body):
  result=super().run(body)
  self.w.obligations.append(('control:final-false',m.z3.BoolVal(True),m.z3.BoolVal(False)))
  return result
try:
 m.MultiExec=FalseFinal
 try:m.analyse(summary,f,f['files'],require_witnesses=False,obligation_check=delegate)
 except m.SymSemantic as e:assert 'control:final-false' in str(e)
 else:raise AssertionError('false final obligation accepted')
finally:m.MultiExec=executor
print('Delegated false final obligation refused',flush=True)
def unknown(world,label,formula):raise m.Fatal('control: solver unknown')
try:m.analyse(summary,f,f['files'],require_witnesses=False,obligation_check=unknown)
except m.Fatal as e:assert str(e)=='control: solver unknown'
else:raise AssertionError('callback UNKNOWN swallowed')
assert hashes()==before, 'source changed during controls'
out.write_text(json.dumps({'passed':True,'scope':__doc__,'defaultReportEquivalentExceptTime':True,'groups':positive_groups,'controls':['false-final-obligation-refused','callback-unknown-propagates'],'inputs':before},indent=2)+'\n')
print('Obligation callback controls passed',flush=True)
