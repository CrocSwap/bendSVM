"""Actual exported source mutations must produce the intended counterexample."""
from pathlib import Path
import json,hashlib,copy,subprocess,os,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from linear_width_report import validate
receipt=json.loads(Path('build/linear-width/fresh-receipt.json').read_text())
root=Path(receipt['inputs'][0]['artifact']).parent
validate(root)
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
full=json.loads((root/'composition-model.json').read_text())
rows=[]
for name,wanted in [('accept-invalid','final-output-respects-validity-relation sat'),('duplicate-input-row','candidate-actual-fold-32-ordered-steps sat'),('bad-initial-validity','candidate-actual-fold-32-ordered-steps sat')]:
 d=copy.deepcopy(full);f=d['candidate']['functions']
 if name=='accept-invalid':f['finish_allowed']['body']['h']['f']['f']['f']['x'][0]['value']=0
 else:
  body=f['fold_rows']['body']['h']['f']['h']['f']['f']
  if name=='bad-initial-validity':body['x']['x'][2]['k']='False'
  else:assert body['f']['x']=={'$':'Var','i':1};body['f']['x']['i']=0
 path=root/(name+'.json');path.write_text(json.dumps(d)+'\n')
 result=subprocess.run([sys.executable,'-B','verification/linear_width_composition.py',str(root)],env={**os.environ,'COMPOSITION_INPUT':str(path),'COMPOSITION_REPORT':str(root/(name+'-unexpected.json'))},capture_output=True,text=True,timeout=120)
 assert not (root/(name+'-unexpected.json')).exists()
 log=root/(name+'.log');log.write_text(result.stdout+result.stderr);assert result.returncode==1 and wanted in result.stdout,(name,result.stderr)
 rows.append({'name':name,'exitCode':result.returncode,'counterexample':wanted,'inputSha256':sha(path),'logSha256':sha(log)})
(root/'source-controls.json').write_text(json.dumps({'passed':True,'runId':receipt['runId'],'inputSha256':sha(root/'composition-model.json'),'checkerSha256':sha(__file__),'controls':rows},indent=2)+'\n')
validate(root)
print('Three linear source mutations detected at intended claims')
