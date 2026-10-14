"""Report corruption controls; complete input used only to test report validation."""
from pathlib import Path
from copy import deepcopy
import json,hashlib,sys
sys.path.insert(0,'verification')
from cpi_caller.report import validate,InvalidReport
p,f,output=map(Path,sys.argv[1:]);output.unlink(missing_ok=True)
report=json.loads(p.read_text());fixtures=json.loads(f.read_text())['fixtures']
validate(report,fixtures);cases=[]
def control(name,mutate):
 bad=deepcopy(report);mutate(bad)
 try:validate(bad,fixtures)
 except (InvalidReport,KeyError,TypeError,IndexError,ValueError):cases.append(name)
 else:raise RuntimeError('Accepted '+name)
control('false pass',lambda r:r.update(passed=False))
control('missing fixture',lambda r:r['rows'].pop())
control('duplicate fixture',lambda r:r['rows'].__setitem__(1,deepcopy(r['rows'][0])))
for i in range(3):
 def row(r):return r['rows'][i]
 for field in ('paths','rawPaths','modelObligations'):
  control(f'{i} wrong {field}',lambda r,k=field:row(r)['adapter'].__setitem__(k,0))
 for field in ('rootCalls','bridgeEqualities'):
  control(f'{i} wrong {field}',lambda r,k=field:row(r).__setitem__(k,0))
 control(f'{i} missing caller claim',lambda r:row(r)['adapter']['claims'].popitem())
 control(f'{i} unknown root',lambda r:row(r).__setitem__('actualRootSafety','unknown'))
 control(f'{i} missing custody',lambda r:row(r).pop('custodySuccessContract'))
 control(f'{i} unknown custody',lambda r:row(r).update(custodySuccessContract='unknown'))
 control(f'{i} missing obligation group',lambda r:row(r)['obligationProofs'].pop())
 control(f'{i} duplicate obligation group',lambda r:row(r)['obligationProofs'].__setitem__(1,deepcopy(row(r)['obligationProofs'][0])))
 control(f'{i} unknown obligation group',lambda r:row(r)['obligationProofs'][0].update(result='unknown'))
 control(f'{i} unrecognized obligation method',lambda r:row(r)['obligationProofs'][0].update(method='assumed'))
 control(f'{i} wrong obligation lemma count',lambda r:row(r)['obligationProofs'][0].update(lemmas=0))
 control(f'{i} invalid obligation fallback',lambda r:row(r)['obligationProofs'][0].update(method='full binding query',reducedResult='unsat'))
 control(f'{i} missing root correspondence',lambda r:row(r).__setitem__('rootCorrespondence',[]))
 control(f'{i} unknown root correspondence',lambda r:row(r)['rootCorrespondence'][0].update(result='unknown'))
 control(f'{i} wrong root guard count',lambda r:row(r)['rootCorrespondence'][0].update(CGuardObligations=0))
 control(f'{i} wrong adapter',lambda r:row(r)['adapter'].__setitem__('adapterSha256','0'*64))
 control(f'{i} missing include',lambda r:row(r)['adapter']['files'].popitem())
 control(f'{i} missing partition',lambda r:row(r)['composedPathPartitions'].pop())
 control(f'{i} duplicated partition',lambda r:row(r)['composedPathPartitions'][1].update(query=0))
 control(f'{i} unknown partition',lambda r:row(r)['composedPathPartitions'][0].update(result='unknown'))
 control(f'{i} missing semantic claim',lambda r:row(r)['semanticProofs'].pop())
 control(f'{i} missing extraction claim',lambda r:row(r)['typedExtraction']['claims'].pop())
 control(f'{i} wrong effect width',lambda r:row(r)['typedExtraction'].update(fieldsPerSlot=379))
 control(f'{i} missing domain output',lambda r:row(r)['domainBinding']['instances'].pop())
 control(f'{i} duplicate domain output',lambda r:row(r)['domainBinding']['instances'].__setitem__(1,deepcopy(row(r)['domainBinding']['instances'][0])))
 control(f'{i} unknown domain lemma',lambda r:row(r)['domainBinding']['genericLemmas'][0].update(result='unknown'))
 control(f'{i} renamed domain claim',lambda r:row(r)['domainBinding']['claims'][0].update(name='unrelated'))
 control(f'{i} missing referenced lemma',lambda r:row(r)['domainBinding']['genericLemmas'].pop())
 control(f'{i} duplicate generic lemma',lambda r:row(r)['domainBinding']['genericLemmas'].append(deepcopy(row(r)['domainBinding']['genericLemmas'][0])))
 control(f'{i} wrong instance reference',lambda r:row(r)['domainBinding']['instances'][0].update(lemma='unproved'))
 control(f'{i} empty assignment',lambda r:row(r)['domainBinding']['instances'][0].update(assignments=0))
 control(f'{i} missing pruning proof',lambda r:row(r)['prunedBranchQueries'].pop())
 control(f'{i} unknown pruning proof',lambda r:row(r)['prunedBranchQueries'][0].update(result='unknown'))
 control(f'{i} invalid pruning hash',lambda r:row(r)['prunedBranchQueries'][0].update(formulaSha256='z'*64))
 control(f'{i} missing success mode',lambda r:row(r)['completeCallerWitnesses'].pop())
 control(f'{i} duplicate success mode',lambda r:row(r)['completeCallerWitnesses'][1].update(mode=0))
 control(f'{i} unknown success',lambda r:row(r)['completeCallerWitnesses'][0].update(result='unknown'))
 control(f'{i} no witness model',lambda r:row(r)['completeCallerWitnesses'][0].update(model={}))
 control(f'{i} invalid witness byte',lambda r:row(r)['completeCallerWitnesses'][0]['instructionBytes'].__setitem__(1,256))
paths=[p,f,Path(__file__),Path('verification/cpi_caller/report.py')]
out={'passed':True,'scope':__doc__,'refusals':cases,'inputs':{str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
output.write_text(json.dumps(out,indent=2)+'\n')
print(len(cases),'report corruption controls refused')
