import copy,json,pathlib,subprocess,sys,hashlib
sys.path[:0]=[str(pathlib.Path(__file__).resolve().parent.parent/'verification'),'verification']
from native_handler_report import validate
receipt=json.loads(pathlib.Path('build/native-handler-lowering/fresh-receipt.json').read_text());paths={'input':receipt['inputArtifact'],'output':receipt['reportArtifact']};base=pathlib.Path(paths['output']).parent
need_hash=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert need_hash(paths['input'])==receipt['inputSha256'] and need_hash(paths['output'])==receipt['reportSha256']
raw=pathlib.Path(paths['input']).read_bytes();data=json.loads(raw);original=json.loads(pathlib.Path(paths['output']).read_text());validate(original,data,raw);rows=[]
def first(r):return r['results'][0]['proof']
def native(r):return next(c for c in first(r)['claims'] if c['result']=='certified-native')
for name,edit,reason in [
 ('false-success',lambda r:r.update(passed=False),'success/scope flags'),
 ('SBF-overclaim',lambda r:r.update(endToEndVerified=True),'success/scope flags'),
 ('extra-field',lambda r:r.update(trusted=True),'report fields'),
 ('scope',lambda r:r.update(scope='verified SBF'),'scope'),
 ('wrong-version',lambda r:r.update(version=True),'version'),
 ('wrong-solver',lambda r:r.update(z3='old'),'version'),
 ('stale-run',lambda r:r.update(runId='old'),'run/input binding'),
 ('stale-input',lambda r:r.update(inputSha256='0'*64),'run/input binding'),
 ('missing-source-hashes',lambda r:r.update(sourceHashes={}),'source binding'),
 ('missing-frontend',lambda r:r.update(cSyntax={}),'frontend binding'),
 ('missing-arithmetic-claim',lambda r:r['prerequisite']['positive']['claims'].pop(),'arithmetic claim inventory'),
 ('unknown-arithmetic',lambda r:r['prerequisite']['positive']['claims'][0].update(result='unknown'),'arithmetic claim inventory'),
 ('stale-math-model',lambda r:r['prerequisite']['positive']['models'].update(math='0'*64),'arithmetic model binding'),
 ('missing-proof-source-hashes',lambda r:r['prerequisite'].update(hashes={}),'prerequisite source binding'),
 ('missing-handler',lambda r:r['results'].pop(),'result inventory'),
 ('wrong-C',lambda r:r['results'][0].update(cSha256='0'*64),'C result binding'),
 ('wrong-root',lambda r:first(r).update(roots=['authorize']),'root result'),
 ('false-root-success',lambda r:first(r).update(passed=False),'root result'),
 ('missing-function',lambda r:first(r)['claims'].pop(),'function inventory/order'),
 ('duplicate-function',lambda r:first(r)['claims'].__setitem__(1,first(r)['claims'][0]),'function inventory/order'),
 ('wrong-order',lambda r:first(r)['claims'].reverse(),'function inventory/order'),
 ('unknown',lambda r:first(r)['claims'][0].update(result='unknown'),'unproved claim'),
 ('sat',lambda r:first(r)['claims'][0].update(result='sat'),'unproved claim'),
 ('missing-dependency',lambda r:next(c for c in first(r)['claims'] if c.get('dependencies')).update(dependencies=[]),'dependency inventory'),
 ('negative-guard-count',lambda r:first(r)['claims'][0].update(CGuardObligations=-1),'obligation count'),
 ('boolean-count',lambda r:first(r)['claims'][0].update(sourceDeadPaths=False),'obligation count'),
 ('nan-time',lambda r:first(r)['claims'][0].update(seconds=float('nan')),'timing'),
 ('wrong-elision',lambda r:first(r)['elidedSourceFunctions'].pop(),'elision inventory'),
 ('native-not-certified',lambda r:native(r).update(result='unsat'),'native result'),
 ('native-body-binding',lambda r:native(r)['certificate'].update(nativeBodySha256='0'*64),'native certificate'),
 ('native-missing-source',lambda r:native(r)['certificate']['sourceClosure'].pop(),'native certificate'),
]:
 changed=copy.deepcopy(original);edit(changed)
 try:validate(changed,data,raw)
 except ValueError as e:assert str(e)==reason,(name,str(e));rows.append({'name':name,'reason':str(e)})
 else:raise AssertionError('accepted '+name)
r=subprocess.run([sys.executable,'-O',str(pathlib.Path(__file__).resolve().parent.parent/'verification/native_handler_report.py'),paths['input'],paths['output']],capture_output=True,text=True,timeout=10)
assert r.returncode!=0 and 'requires Python assertions' in r.stderr
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
(base/'report-controls.json').write_text(json.dumps({'passed':True,'reportControls':rows,'optimizedPythonRefused':True,'validatorSha256':sha(pathlib.Path(__file__).resolve().parent.parent/'verification/native_handler_report.py'),'testedInputSha256':sha(paths['input']),'testedReportSha256':sha(paths['output'])},indent=2)+'\n')
print(str(len(rows))+' native-handler report corruptions and optimized Python refused; complete fresh report accepted')
