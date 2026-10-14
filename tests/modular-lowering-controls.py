"""Report corruption, dependency refusal and solver failure controls."""
import copy,json,pathlib,sys,subprocess
sys.path.insert(0,'verification')
from modular_report import validate,need,sha,snapshot
import modular_c as engine
from adapter_contract_c import Grammar
from acyclic_c import C as BaseC
receipt=json.loads(pathlib.Path('build/modular-lowering/fresh-receipt.json').read_text())
raw=pathlib.Path(receipt['inputArtifact']).read_bytes();need(sha(raw)==receipt['inputSha256'],'stale input');data=json.loads(raw)
rpath=pathlib.Path(receipt['reportArtifact']);need(sha(rpath.read_bytes())==receipt['reportSha256'],'stale report');report=json.loads(rpath.read_text());validate(report,data,raw)
rows=[]
def corrupt(name,edit,reason):
 changed=copy.deepcopy(report);edit(changed)
 try:validate(changed,data,raw)
 except (ValueError,KeyError,TypeError) as e:need(reason in str(e),'unexpected refusal '+str(e));rows.append({'name':name,'reason':str(e)})
 else:raise AssertionError('accepted '+name)
corrupt('false-success',lambda r:r.update(passed=False),'success/scope flag')
corrupt('overclaimed-SBF',lambda r:r.update(endToEndVerified=True),'success/scope flag')
corrupt('extra-report-field',lambda r:r.update(trustMe=True),'report fields')
corrupt('wrong-version',lambda r:r.update(version=2),'version')
corrupt('wrong-solver',lambda r:r.update(z3='0'),'version')
corrupt('stale-run',lambda r:r.update(runId='old'),'run/input binding')
corrupt('stale-input',lambda r:r.update(inputSha256='0'*64),'run/input binding')
corrupt('missing-source',lambda r:r.update(sourceHashes={}),'source binding')
corrupt('wrong-scope',lambda r:r.update(scope='verified assembly'),'scope')
corrupt('missing-program',lambda r:r['results'].pop(),'program inventory')
corrupt('wrong-C',lambda r:r['results'][0].update(cSha256='0'*64),'result identity')
corrupt('missing-root',lambda r:r['results'][0]['proof']['roots'].pop(),'root result')
corrupt('dropped-function',lambda r:r['results'][0]['proof']['claims'].pop(),'function inventory/order')
corrupt('duplicate-function',lambda r:r['results'][0]['proof']['claims'].__setitem__(1,r['results'][0]['proof']['claims'][0]),'function inventory/order')
corrupt('wrong-order',lambda r:r['results'][0]['proof']['claims'].reverse(),'function inventory/order')
corrupt('UNKNOWN-positive',lambda r:r['results'][0]['proof']['claims'][0].update(result='unknown'),'unproved claim')
corrupt('SAT-positive',lambda r:r['results'][0]['proof']['claims'][0].update(result='sat'),'unproved claim')
corrupt('missing-dependency',lambda r:next(x for x in r['results'][0]['proof']['claims'] if x['dependencies']).update(dependencies=[]),'dependency inventory')
corrupt('invalid-guard-count',lambda r:r['results'][0]['proof']['claims'][0].update(CGuardObligations=-1),'obligation count')
corrupt('boolean-count',lambda r:r['results'][0]['proof']['claims'][0].update(sourceDeadPaths=True),'obligation count')
corrupt('NaN-time',lambda r:r['results'][0]['proof']['claims'][0].update(seconds=float('nan')),'timing')
corrupt('missing-mutation',lambda r:r['mutations'].pop(),'mutation inventory')
corrupt('wrong-mutant-C',lambda r:r['mutations'][0].update(cSha256='0'*64),'mutation artifact')
corrupt('fault-not-detected',lambda r:r['mutations'][0]['proof'].update(passed=True),'mutation passed')
corrupt('missing-witness',lambda r:r['mutations'][0]['proof']['claims'][-1].pop('wireArgs'),'claim fields')
corrupt('short-witness',lambda r:r['mutations'][0]['proof']['claims'][-1]['wireArgs'].pop(),'witness arity')
corrupt('missing-frontend',lambda r:r.update(cSyntax={}),'frontend binding')
engine_controls=[];p=data['programs'][0]
for name,edit,reason in [
 ('source-cycle',lambda q:q['source']['functions']['step32'].update(body={'$':'Ref','k':'step32'}),'recursive source closure'),
 ('unknown-source-call',lambda q:q['source']['functions']['step32'].update(body={'$':'Ref','k':'absent'}),'unknown source call'),
 ('unproved-C-self-call',lambda q:q['artifact'].update(c=q['artifact']['c'].replace('return bend_step16(bend_step16(a0));','return bend_step32(a0);')),'unproved C callee step32'),
 ('unbound-C-bytes',lambda q:q['artifact'].update(c=q['artifact']['c']+'\n'),'artifact hash mismatch'),
]:
 q=copy.deepcopy(p);edit(q)
 if name=='unproved-C-self-call':q['artifact']['cSha256']=sha(q['artifact']['c'].encode())
 try:engine.check(q)
 except ValueError as e:need(reason in str(e),'unexpected dependency refusal');engine_controls.append({'name':name,'reason':str(e)})
 else:raise AssertionError('accepted '+name)
# Existing acyclic entrypoints keep their strict grammar.
try:BaseC(engine.Source(p['source']),p['artifact']).call(engine.mangle('U32.div'),[engine.z.BitVec('a',32),engine.z.BitVec('b',32)],engine.z.BoolVal(True))
except Grammar as e:need("found '/'" in str(e),'wrong base grammar refusal')
else:raise AssertionError('base grammar widened')
real=engine.z.Solver;old_artifacts=engine.check_artifacts;old_layouts=engine.check_layouts
old_artifacts([p['artifact']]);old_layouts([p['artifact']])
class Unknown:
 def set(self,**kwargs):pass
 def add(self,*args):pass
 def check(self):return engine.z.unknown
 def reason_unknown(self):return 'injected solver UNKNOWN'
try:
 engine.check_artifacts=lambda a:None;engine.check_layouts=lambda a:None;engine.z.Solver=Unknown
 result=engine.check(p);need(result['passed'] is False and result['claims'][0]['result']=='unknown' and result['claims'][0]['reason']=='injected solver UNKNOWN','solver UNKNOWN accepted')
finally:engine.z.Solver=real;engine.check_artifacts=old_artifacts;engine.check_layouts=old_layouts
run=rpath.parent;out=run/'optimized-must-not-exist.json'
optimized=subprocess.run([sys.executable,'-O','verification/modular_lowering.py',receipt['inputArtifact'],str(out)],capture_output=True,text=True,timeout=10)
need(optimized.returncode!=0 and 'requires Python assertions' in optimized.stderr and not out.exists(),'optimized mode accepted')
need(snapshot(data['sourceHashes'])==data['sourceHashes'],'source drift')
(run/'controls.json').write_text(json.dumps({'passed':True,'reportSha256':receipt['reportSha256'],'reportControls':rows,'dependencyControls':engine_controls,'baseGrammarPreserved':True,'solverUnknownRefused':True,'optimizedPythonRefused':True},indent=2)+'\n')
print(str(len(rows))+' report controls and dependency/solver/grammar controls passed')
