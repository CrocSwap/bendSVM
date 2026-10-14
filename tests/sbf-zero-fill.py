"""Fresh model proof, faulty-interpreter controls, process and report refusals."""
from pathlib import Path
import copy,hashlib,json,subprocess,sys,uuid
if not __debug__:raise RuntimeError('assertions required')
repo=Path(__file__).resolve().parents[1];sys.path.insert(0,str(repo/'verification'))
import sbf_zero_fill_report as validator
sha=validator.sha
run=repo/'build/sbf-zero-fill'/str(uuid.uuid4());run.mkdir(parents=True)
latest=repo/'build/sbf-zero-fill-test.json'
if latest.exists():latest.rename(run/'previous.json')
sources=[Path(__file__),repo/'verification/check-sbf-zero-fill.py',repo/'verification/sbf_zero_fill_report.py',repo/'verification/sbf_output.py',repo/'verification/sbf_cfg.py']
bindings={str(p):sha(p) for p in sources};driver=str(sources[1]);controls=[]
def child(name,args):
 p=subprocess.run(args,cwd=repo,capture_output=True,text=True,timeout=120)
 (run/(name+'.log')).write_text(p.stdout+p.stderr)
 return p
p=child('positive',[sys.executable,'-B',driver]);assert p.returncode==0,p.stderr
d=json.loads(p.stdout);validator.validate(d);(run/'proof.json').write_text(json.dumps(d,indent=2)+'\n')
# Execute altered interpreter modules in isolated child processes. Original files
# and the positive report remain unchanged.
original=(repo/'verification/sbf_output.py').read_text()
mutations=[('short-fill','range(0,count,4):put','range(0,max(0,count-4),4):put'),('wrong-fill','put(r[1],k,4,B(0))','put(r[1],k,4,B(1))'),('extra-fill','range(0,count,4):put','range(0,count+4,4):put'),('clobbered-nonvolatile','range(6):r[i]','range(7):r[i]')]
for name,old,new in mutations:
 assert original.count(old)==1
 mutant=run/(name+'.py');mutant.write_text(original.replace(old,new))
 code="import sys,types,runpy;sys.path.insert(0,'verification');m=types.ModuleType('sbf_output');exec(compile(open(sys.argv[1]).read(),sys.argv[1],'exec'),m.__dict__);sys.modules['sbf_output']=m;runpy.run_path(sys.argv[2],run_name='__main__')"
 p=child(name,[sys.executable,'-B','-c',code,str(mutant),driver]);assert p.returncode!=0 and 'AssertionError' in p.stderr and not p.stdout,(name,p.stderr)
 controls.append({'name':name,'reason':'interpreter comparison assertion'})
p=child('optimized',[sys.executable,'-B','-O',driver]);assert p.returncode!=0 and 'assertions required' in p.stderr and not p.stdout
controls.append({'name':'optimized','reason':'assertions required'})
code="import sys,runpy,z3;z3.Solver.check=lambda self,*a:z3.unknown;runpy.run_path(sys.argv[1],run_name='__main__')"
p=child('solver-unknown',[sys.executable,'-B','-c',code,driver]);assert p.returncode!=0 and 'interval-does-not-wrap' in p.stderr and 'unknown' in p.stderr and not p.stdout
controls.append({'name':'solver-unknown','reason':'unknown rejected'})
refusals=[]
def refuse(name,change):
 bad=copy.deepcopy(d);change(bad)
 try:validator.validate(bad)
 except ValueError as e:refusals.append({'name':name,'reason':str(e)})
 else:raise RuntimeError('accepted '+name)
for key in d:refuse('missing-'+key,lambda b,k=key:b.pop(k))
refuse('numeric-success',lambda b:b.update(passed=1))
refuse('omitted-claim',lambda b:b['claims'].pop())
refuse('duplicate-claim',lambda b:b['claims'].__setitem__(1,b['claims'][0]))
refuse('unknown-claim',lambda b:b['claims'][0].update(result='unknown'))
refuse('empty-witness',lambda b:b['controls'][0].update(witness=''))
refuse('wrong-count',lambda b:b.update(interpreterCases=768))
refuse('extra-source',lambda b:b['inputs'].update(extra='0'*64))
refuse('stale-source',lambda b:b['inputs'].update({driver:'0'*64}))
refuse('scope-overclaim',lambda b:b.update(scope='Entire compiler verified'))
assert len(controls)==6 and len(refusals)==16
assert {p:sha(p) for p in bindings}==bindings
report={'passed':True,'endToEndVerified':False,'proof':str(run/'proof.json'),'proofSha256':sha(run/'proof.json'),'controls':controls,'reportRefusals':refusals,'sourceHashes':bindings,'artifacts':{str(p):sha(p) for p in run.iterdir() if p.name!='previous.json'}}
accepted=run/'accepted.json';accepted.write_text(json.dumps(report,indent=2)+'\n');latest.write_bytes(accepted.read_bytes())
print(json.dumps({'passed':True,'claims':6,'interpreterCases':769,'controls':len(controls),'reportRefusals':len(refusals),'report':str(latest)}))
