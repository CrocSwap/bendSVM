"""A green flag is insufficient without all signed semantic and C claims."""
from pathlib import Path
import copy,json,sys
if not __debug__:raise RuntimeError('assertions required')
sys.path.insert(0,'verification')
from signed_report import validate,sha,snapshot
receipt=json.loads(Path('build/signed-lowering/fresh-receipt.json').read_text());raw=Path(receipt['inputArtifact']).read_bytes();data=json.loads(raw);report_raw=Path(receipt['reportArtifact']).read_bytes();report=json.loads(report_raw)
assert receipt['passed'] and sha(raw)==receipt['inputSha256'] and sha(report_raw)==receipt['reportSha256'];validate(report,data,raw);assert snapshot(data['sourceHashes'])==data['sourceHashes']
rows=[]
def refuse(name,mutate):
 r=copy.deepcopy(report);mutate(r)
 try:validate(r,data,raw)
 except (ValueError,KeyError,TypeError,IndexError):rows.append(name)
 else:raise AssertionError('accepted '+name)
for field,value in [('passed',False),('endToEndVerified',True),('version',True),('runId','stale'),('inputSha256','wrong'),('scope','stronger')]:refuse(field,lambda r,k=field,v=value:r.update({k:v}))
refuse('missing source',lambda r:r['sourceHashes'].pop('verification/signed_semantics.py'))
refuse('frontend missing',lambda r:r['cSyntax']['units'].clear())
refuse('missing semantic',lambda r:r['semantics']['claims'].pop())
refuse('reordered semantics',lambda r:r['semantics']['claims'].reverse())
refuse('wrong solver',lambda r:r['semantics'].update(z3='wrong'))
refuse('unknown semantic',lambda r:r['semantics']['claims'][0].update(result='unknown'))
refuse('sat semantic',lambda r:r['semantics']['claims'][0].update(result='sat'))
refuse('NaN semantic',lambda r:r['semantics']['claims'][0].update(seconds=float('nan')))
refuse('boolean timing',lambda r:r['semantics']['claims'][0].update(seconds=True))
refuse('extra semantic',lambda r:r['semantics']['claims'][0].update(witness=[]))
refuse('missing C function',lambda r:r['lowering']['claims'].pop())
refuse('duplicate C function',lambda r:r['lowering']['claims'].append(r['lowering']['claims'][0]))
refuse('C root mismatch',lambda r:r['lowering'].update(roots=[]))
refuse('C counterexample',lambda r:r['lowering']['claims'][0].update(result='sat'))
refuse('C dependency mismatch',lambda r:r['lowering']['claims'][-1].update(dependencies=[]))
refuse('boolean C count',lambda r:r['lowering']['claims'][0].update(CGuardObligations=False))
refuse('extra report field',lambda r:r.update(unchecked=True))
assert snapshot(data['sourceHashes'])==data['sourceHashes'] and Path(receipt['inputArtifact']).read_bytes()==raw and Path(receipt['reportArtifact']).read_bytes()==report_raw
out=Path(receipt['inputArtifact']).parent/'report-controls.json';out.write_text(json.dumps({'passed':True,'inputSha256':sha(raw),'reportSha256':sha(report_raw),'checkerSha256':sha(Path(__file__).read_bytes()),'refusals':rows},indent=2)+'\n');print(len(rows),'signed report corruptions refused')
