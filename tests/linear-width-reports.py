"""Reject incomplete linear proof chains without modifying accepted artifacts."""
from pathlib import Path
import contextlib,copy,io,json,sys,tempfile
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from linear_width_report import validate,SPECS
from modular_report import sha,snapshot
receipt=json.loads(Path('build/linear-width/fresh-receipt.json').read_text())
root=Path(receipt['inputs'][0]['artifact']).parent
files={p.name:p.read_bytes() for p in root.glob('*.json')}
assert receipt['passed'] is True and receipt['endToEndVerified'] is False
for item in receipt['inputs']+receipt['stages']:
 assert sha(Path(item['artifact']).read_bytes())==item['sha256']
assert snapshot(receipt['sourceHashes'])==receipt['sourceHashes']
validate(root)
rows=[]
with tempfile.TemporaryDirectory(prefix='linear-report-controls-') as directory:
 target=Path(directory)
 def refuse(name,stage,mutation,reason):
  for filename,raw in files.items():(target/filename).write_bytes(raw)
  filename=SPECS[stage]['report'];value=json.loads(files[filename]);mutation(value)
  (target/filename).write_text(json.dumps(value))
  # Preserve downstream hash links so rejection must come from the changed claim.
  for i in range(stage+1,len(SPECS)):
   p=target/SPECS[i]['report'];v=json.loads(p.read_text())
   v['prerequisiteSha256']=sha((target/SPECS[i-1]['report']).read_bytes());p.write_text(json.dumps(v))
  try:
   with contextlib.redirect_stdout(io.StringIO()):validate(target)
  except (ValueError,KeyError,TypeError,IndexError) as error:
   assert reason in str(error),(name,str(error),reason)
   rows.append({'name':name,'reason':reason})
  else:raise AssertionError('accepted '+name)
 for i in range(3):
  def check(name,mutation,reason):refuse(str(i)+' '+name,i,mutation,reason)
  check('false success',lambda r:r.update(passed=False),'stage fields/scope')
  check('stronger scope',lambda r:r.update(scope='end-to-end verified'),'stage fields/scope')
  check('extra field',lambda r:r.update(unchecked=True),'stage fields/scope')
  check('stale input',lambda r:r.update(inputSha256='wrong'),'stage input hash')
  check('wrong checker',lambda r:r.update(checkerSha256='wrong'),'checker binding')
  check('missing claim',lambda r:r['claims'].pop(),'claim inventory')
  check('duplicate claim',lambda r:r['claims'].append(copy.deepcopy(r['claims'][0])),'claim inventory')
  check('reordered claims',lambda r:r['claims'].reverse(),'claim inventory')
  check('solver unknown',lambda r:r['claims'][0].update(result='unknown'),'claim inventory')
  check('boolean time',lambda r:r['claims'][0].update(seconds=True),'timing')
  check('NaN time',lambda r:r['claims'][0].update(seconds=float('nan')),'timing')
  check('negative time',lambda r:r['claims'][0].update(seconds=-1),'timing')
  check('unexpected witness',lambda r:r['claims'][0].update(witness='x'),'claim fields')
  if i:check('stale prerequisite',lambda r:r.update(prerequisiteSha256='wrong'),'stage prerequisite')
  else:check('missing source',lambda r:r.update(sourceHashes={}),'product source binding')
 for i in (0,1):
  refuse(str(i)+' empty counterexample',i,lambda r:next(c for c in r['claims'] if c['result']=='sat').update(witness=''),'missing counterexample')
 refuse('missing fold trace',2,lambda r:r['traces'].pop(),'fold trace inventory')
 refuse('wrong fold length',2,lambda r:r['traces'][0].update(steps=31),'fold trace inventory')
 refuse('missing downstream function',2,lambda r:r['identicalDownstreamFunctions'].pop(),'downstream inventory')
assert snapshot(receipt['sourceHashes'])==receipt['sourceHashes']
for filename,raw in files.items():assert (root/filename).read_bytes()==raw
out=root/'report-controls.json'
out.write_text(json.dumps({'passed':True,'runId':receipt['runId'],'checkerSha256':sha(Path(__file__).read_bytes()),'stages':receipt['stages'],'refusals':rows},indent=2)+'\n')
print(len(rows),'linear proof report corruptions refused')
