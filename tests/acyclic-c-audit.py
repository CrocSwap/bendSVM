import sys,pathlib,json,copy,hashlib,subprocess,os
sys.path.insert(0,'verification')
import acyclic_c as checker
import z3 as z
root=pathlib.Path('build/acyclic-lowering');baseline=json.loads(pathlib.Path(json.loads((root/'fresh-receipt.json').read_text())['inputArtifact']).read_text())
target='return bend_Present_3c_U32_3e__make(a0);'
refusals=[];semantic=[]
for name,replacement,reason in [
 ('signed overflow literal','return bend_Present_3c_U32_3e__make((bend_u32)(2147483647 + 1));','unsupported literal'),
 ('signed comparison shift','return bend_Present_3c_U32_3e__make((a0 == 0u) << 31u);','signed shift'),
 ('recursion','return bend_present(a0);','recursive C call'),
 ('pointer local','bend_u32 *pointer = &a0; '+target,'unsupported declaration'),
 ('shadowing','bend_u32 a0 = 7u; '+target,'unsupported declaration'),
 ('loop','for (;;) {} '+target,'loop outside'),
 ('hidden maker','bend_u32 bend_Present_3c_U32_3e__make = 0u; '+target,'local hides function or type'),
 ('hidden helper','bend_u32 bend_box_7e_0 = 0u; return bend_Present_3c_U32_3e__make((bend_box_7e_0(a0)).as.c0.f0);','local hides function or type'),
 ('hidden typedef','bend_u32 bend_u32 = 0u; bend_u32 temporary = a0; return bend_Present_3c_U32_3e__make(temporary);','local hides function or type'),
 ('escaped block local','{ bend_u32 temporary = a0; } return bend_Present_3c_U32_3e__make(temporary);','unbound C variable'),
 ('const assignment','const bend_u32 temporary = 0u; temporary = a0; return bend_Present_3c_U32_3e__make(temporary);','assignment to const'),
]:
 p=copy.deepcopy(baseline['programs'][1]);a=p['artifact'];assert a['c'].count(target)==1
 a['c']=a['c'].replace(target,replacement);a['cSha256']=hashlib.sha256(a['c'].encode()).hexdigest()
 try:checker.check(p)
 except ValueError as error:assert reason in str(error),(name,str(error));refusals.append({'name':name,'reason':str(error)})
 else:raise AssertionError(name+' accepted')
for name,suffix in [
 ('unmodeled global','\nstatic bend_u32 hidden = 0u;\n'),
 ('assembly declaration','\n__asm__("nop");\n'),
 ('extra static assertion','\n_Static_assert(0, "failure");\n'),
 ('unknown assertion type','\n_Static_assert(sizeof(unknown_type) <= 1536, "unknown");\n'),
 ('wrong aggregate assertion','\n_Static_assert(sizeof(bend_Choice_3c_U32_3e__t) == 4, "wrong");\n'),
 ('extra function','\nstatic inline bend_u32 injected(void) { return 0u; }\n'),
]:
 p=copy.deepcopy(baseline['programs'][1]);a=p['artifact'];a['c']+=suffix;a['cSha256']=hashlib.sha256(a['c'].encode()).hexdigest()
 try:checker.check(p)
 except ValueError as error:
  assert 'translation-unit' in str(error) or 'unexpected/duplicate function' in str(error),(name,str(error))
  refusals.append({'name':name,'reason':str(error)})
 else:raise AssertionError(name+' accepted')
for name,replacement in [
 ('overshift','return bend_Present_3c_U32_3e__make(a0 << 32u);'),
 ('reachable unreachable','__builtin_unreachable();'),
 ('missing return',''),
]:
 p=copy.deepcopy(baseline['programs'][1]);a=p['artifact'];a['c']=a['c'].replace(target,replacement);a['cSha256']=hashlib.sha256(a['c'].encode()).hexdigest()
 claims=checker.check(p);row=next(r for r in claims if r['function']=='present')
 assert row['result']=='sat' and row['CGuardObligations']>0,name
 semantic.append({'name':name,'claim':row})
p=copy.deepcopy(baseline['programs'][0]);a=p['artifact'];needle='return (bend_u32)(!a0);';assert needle in a['c']
a['c']=a['c'].replace(needle,'return 2u;');a['cSha256']=hashlib.sha256(a['c'].encode()).hexdigest()
row=next(r for r in checker.check(p) if r['function']=='normalize');assert row['result']=='sat'
semantic.append({'name':'noncanonical Boolean return','claim':row})
p=copy.deepcopy(baseline['programs'][0]);p['artifact']['schema']['exports'][0]['result']='U32'
try:checker.check(p)
except ValueError as error:assert 'schema mismatch' in str(error);refusals.append({'name':'source/schema mismatch','reason':str(error)})
else:raise AssertionError('schema mismatch accepted')
# Force UNKNOWN on the whole-function query after the actual maker queries.
p=baseline['programs'][0];makers=sum(len(t['variants']) for t in p['artifact']['schema']['types'] if t['kind']=='adt')
original=z.Solver;count=0
class UnknownOnRoot:
 def __init__(self,*args,**kwargs):
  global count
  count+=1;self.number=count;self.inner=original(*args,**kwargs)
 def __getattr__(self,key):return getattr(self.inner,key)
 def check(self,*args):return z.unknown if self.number==makers+1 else self.inner.check(*args)
 def reason_unknown(self):return 'forced whole-function solver control'
z.Solver=UnknownOnRoot
try:
 try:checker.check(p)
 except ValueError as error:
  assert str(error).startswith('UNKNOWN is not proof:') and count==makers+1
  refusals.append({'name':'whole-function UNKNOWN','reason':str(error)})
 else:raise AssertionError('UNKNOWN accepted')
finally:z.Solver=original
equivalents=[]
for name,replacement in [
 ('const read','const bend_u32 temporary = a0; return bend_Present_3c_U32_3e__make(temporary);'),
 ('outer update','bend_u32 temporary = 0u; { temporary = a0; } return bend_Present_3c_U32_3e__make(temporary);'),
 ('sequential scopes','{ const bend_u32 temporary = a0; (void)temporary; } { bend_u32 temporary = 0u; temporary = a0; (void)temporary; } '+target),
]:
 p=copy.deepcopy(baseline['programs'][1]);a=p['artifact'];a['c']=a['c'].replace(target,replacement);a['cSha256']=hashlib.sha256(a['c'].encode()).hexdigest()
 claims=checker.check(p);assert all(r['result']=='unsat' for r in claims),name
 native=root/('scope-equivalent-'+str(len(equivalents))+'.c');binary=native.with_suffix('.out')
 harness='\nint main(void) { bend_u32 values[] = {0u, 7u, 4294967295u}; for (unsigned i=0; i<3; ++i) { bend_Choice_3c_U32_3e__t r=bend_present(values[i]); if (r.tag != 1u || r.as.c1.f0 != values[i]) return 1; } return 0; }\n'
 native.write_text(a['c']+harness)
 compiled=subprocess.run([os.environ.get('CC','clang'),'-std=c11','-O1',str(native),'-o',str(binary)],capture_output=True,text=True,timeout=30)
 assert compiled.returncode==0,compiled.stderr
 executed=subprocess.run([str(binary)],capture_output=True,text=True,timeout=5);assert executed.returncode==0
 equivalents.append({'name':name,'claims':claims,'nativeCases':[0,7,4294967295],'nativeExit':executed.returncode,'nativeSha256':hashlib.sha256(native.read_bytes()).hexdigest()})
report={'passed':True,'equivalents':equivalents,'grammarAndBoundaryRefusals':refusals,'guardCounterexamples':semantic,
 'checkerSha256':hashlib.sha256(pathlib.Path('verification/acyclic_c.py').read_bytes()).hexdigest(),
 'scope':'Guard SAT cases are modeled contract violations, not portable native executions of undefined behavior.'}
(root/'audit-report.json').write_text(json.dumps(report,indent=2)+'\n')
print(f'{len(refusals)} grammar/boundary refusals and {len(semantic)} guard counterexamples passed')
