"""Fresh maintained-source qualification of conditional SBF division arithmetic.

This extends the div4 prerequisite through div16/caller/route/entry bridges and
independent VM checkpoints. It does not verify VM semantics or a whole handler.
"""
from pathlib import Path
import hashlib,json,os,subprocess,sys,uuid
repo=Path(__file__).resolve().parents[1];base=repo/'verification/sbf_quotient'
output=Path(os.environ.get('SBF_QUOTIENT_OUTPUT',repo/'build/sbf-quotient')).resolve();run=output/'runs'/str(uuid.uuid4());run.mkdir(parents=True);latest=output/'latest.json'
if latest.exists():os.replace(latest,run/'previous-latest.json')
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
def need(ok,msg):
 if not ok:raise RuntimeError(msg)
def bindings(mapping):
 need(type(mapping) is dict and bool(mapping),'empty bindings')
 for p,h in mapping.items():need(sha(p)==h,'binding drift: '+p)
def command(args,log,cwd,env=None,timeout=900):
 child=subprocess.run(args,cwd=cwd,env=env,capture_output=True,text=True,timeout=timeout);log.write_text(child.stdout+child.stderr)
 need(child.returncode==0,'command failed: '+str(log));return child.stdout
try:
 need(__debug__,'assertions required')
 sys.path.insert(0,str(base))
 import validate as quotient_validator
 templates=json.loads((base/'templates.json').read_text());extra=['division_loop.py','prove.py']
 inputs=[Path(__file__),base/'validate.py',base/'report-schema.json',base/'templates.json',repo/'verification/check-sbf-division.py']+[base/s for s in templates]+[repo/'verification'/n for n in extra];source={str(p):sha(p) for p in inputs}
 leaf_result=json.loads(command([sys.executable,'-B',str(repo/'verification/check-sbf-division.py')],run/'leaf.log',repo,dict(os.environ,SBF_DIVISION_OUTPUT=str(run/'leaf'))))
 leaf_file=Path(leaf_result['runRoot'])/'report.json';need(leaf_result['passed'] is True and sha(leaf_file)==leaf_result['reportSha256'],'leaf result')
 leaf=json.loads(leaf_file.read_text());need(leaf['passed'] is True and leaf['endToEndVerified'] is False,'leaf status')
 for key in ['sourceHashes','stagedSourceHashes','reports','logs']:bindings(leaf[key])
 product_file=next(Path(p) for p in leaf['reports'] if '/product/runs/' in p and p.endswith('/report.json') and '/source/' not in p)
 product=json.loads(product_file.read_text());stage=product_file.parent/'source';scout=stage/'build/sbf-division-scout';staged={}
 need(product['passed'] is True and product['endToEndVerified'] is False,'product prerequisite status')
 for key in ['sourceHashes','stagedSourceHashes','externalHashes','logs']:bindings(product[key])
 for src,dst in templates.items():
  p=stage/dst;need(not p.exists(),'staging collision');p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes((base/src).read_bytes());staged[str(p)]=sha(base/src)
 for name in extra:
  p=stage/'verification'/name;need(not p.exists(),'library collision');p.write_bytes((repo/'verification'/name).read_bytes());staged[str(p)]=sha(p)
 env=dict(os.environ,SBF_DIVISION_LEAF_REPORT=str(leaf_file),SBF_DIVISION_LEAF_SHA256=sha(leaf_file),SBF_PRODUCT_QUALIFICATION=str(Path(product['terminal']).parent))
 phases=[]
 for name in ['compose-div16-frame.py','check-caller-calls.py','check-small-quotient.py','link-caller-entry.py','check-loop-bridge.py','instantiate-caller-summary.py','test-div16-faults.py','replay-div16-faults.py','replay-caller.py','check-native-quotient.py']:
  stdout=command([sys.executable,'-B',str(scout/name)],run/(name+'.log'),stage,env,timeout=300);result=json.loads(stdout);need(result['passed'] is True,'phase status '+name);phases.append({'name':name,'result':result})
 names=['div16-first-two-report.json','div16-steps-three-four-report.json','div16-rest-report.json','div16-frame-report.json','div16-composition-report.json','caller-calls-report.json','call-routes-report.json','caller-entry-report.json','loop-bridge-report.json','caller-summary-instantiation-report.json','native-quotient-report.json','small-quotient-report.json']
 reports=[scout/n for n in names]
 byphase={p['name']:p['result'] for p in phases}
 reports += [Path(byphase['test-div16-faults.py']['report']),Path(byphase['replay-div16-faults.py']['runRoot'])/'report.json',Path(byphase['replay-caller.py']['report'])]
 need(len(reports)==15,'report inventory')
 context=quotient_validator.context(leaf_file,Path(os.environ.get('SBF_TOOLS',str(Path.home()/'.cache/solana/v1.53/platform-tools/llvm/bin'))))
 need(set(map(quotient_validator.role,reports))==set(quotient_validator.SCHEMA),'report role inventory')
 for p in reports:quotient_validator.validate(json.loads(p.read_text()),p,context)
 for key in ['sourceHashes','stagedSourceHashes','reports','logs']:bindings(leaf[key])
 for key in ['sourceHashes','stagedSourceHashes','externalHashes','logs']:bindings(product[key])
 bindings(source);bindings(staged)
 report={'passed':True,'endToEndVerified':False,'sourceHashes':source,'stagedSourceHashes':staged,'leafReport':str(leaf_file),'leafReportSha256':sha(leaf_file),'reports':{str(p):sha(p) for p in reports},'logs':{str(p):sha(p) for p in run.glob('*.log')},'phases':phases,'scope':'Fresh maintained-source conditional product-entry/division-route/div16/caller arithmetic qualification, with explicit restoring-step summary substitution, integer loop obligations and actual VM fault/checkpoint comparisons. Trusted restricted interpreters, solver, valid disjoint ABI memory, CALL/return preservation, source layout and unsigned-to-integer interpretation remain. Strict report validation is applied; independent negative controls run through test:sbf-quotient. No whole-handler/effects/commit/compiler proof.'}
 (run/'report.json').write_text(json.dumps(report,indent=2)+'\n');pointer={'runRoot':str(run),'reportSha256':sha(run/'report.json')};temp=run/'latest.tmp';temp.write_text(json.dumps(pointer,indent=2)+'\n');os.replace(temp,latest);print(json.dumps({'passed':True,**pointer}))
except BaseException as e:
 if latest.exists():os.replace(latest,run/'failed-latest.json')
 (run/'failure.json').write_text(json.dumps({'passed':False,'error':str(e)},indent=2)+'\n');raise
