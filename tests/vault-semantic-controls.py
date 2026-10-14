import copy,json,pathlib,sys,hashlib,gc
sys.path.insert(0,'verification')
import z3 as z
from vault_semantic_inventory import validate_semantics
from codec_semantics import Codecs,PackedDecoder
from acyclic_c import Source
r=pathlib.Path('build/vault-adapter-bridge');fresh=json.loads((r/'fresh-receipt.json').read_text());ip=pathlib.Path(fresh['input']);root=ip.parent;data=json.loads(ip.read_text());reports=[json.loads((root/name).read_text()) for name in ['codec-semantics-report.json','semantic-report.json']]
controls=[('missing-connected-adapter-claim',lambda a:a[1]['positive']['adapter']['claims'].pop()),('missing-roundtrip',lambda a:a[0]['claims'].pop()),('duplicate-roundtrip',lambda a:a[0]['claims'].__setitem__(1,a[0]['claims'][0])),('roundtrip-unknown',lambda a:a[0]['claims'][0].update(result='unknown')),('security-sat',lambda a:a[1]['positive']['claims'][1].update(result='sat')),('missing-binding-proof',lambda a:a[1]['positive']['bindingAudit']['claims'].pop()),('missing-encoded-output',lambda a:a[1]['positive']['bindingAudit'].update(outputs=78)),('missing-binding-fault',lambda a:a[1]['positive']['bindingFaults'].pop()),('vacuous-success',lambda a:a[1]['positive']['witnesses'][0].update(result='unsat')),('missing-root-call',lambda a:a[1]['positive'].update(rootCalls=1)),('signed-witness',lambda a:a[1]['negative']['claims'][1]['wireArgs'][0]['fields'].update(signed=True)),('missing-state-byte',lambda a:a[1]['negative']['claims'][1]['stateBytes'].pop()),('out-of-range-byte',lambda a:a[1]['negative']['claims'][1]['instructionBytes'].__setitem__(1,256))]
controls.extend([
 ('missing-state-claim',lambda a:a[1]['positive']['stateClaims'].pop()),
 ('duplicate-state-claim',lambda a:a[1]['positive']['stateClaims'].__setitem__(1,a[1]['positive']['stateClaims'][0])),
 ('accounting-unknown',lambda a:a[1]['positive']['stateClaims'][4].update(result='unknown')),
 ('lost-arithmetic-counterexample',lambda a:a[1]['arithmetic']['stateClaims'][4].update(result='unsat')),
 ('missing-commit-reachability',lambda a:a[1]['positive']['witnesses'].pop()),
 ('missing-arithmetic-witness',lambda a:a[1]['arithmetic']['stateClaims'][4].pop('wireArgs')),
 ('short-committed-bytes',lambda a:a[1]['arithmetic']['stateClaims'][4]['committedBytes'].pop()),
 ('wrong-committed-header',lambda a:a[1]['arithmetic']['stateClaims'][4]['committedBytes'].__setitem__(0,0)),
 ('missing-arithmetic-binding-fault',lambda a:a[1]['arithmetic']['bindingFaults'].pop()),
])
controls.extend([
 ('missing-extraction-claim',lambda a:a[1]['positive']['extractionEvidence']['claims'].pop()),
 ('duplicate-extraction-claim',lambda a:a[1]['positive']['extractionEvidence']['claims'].__setitem__(1,a[1]['positive']['extractionEvidence']['claims'][0])),
 ('extraction-unknown',lambda a:a[1]['positive']['extractionEvidence']['claims'][0].update(result='unknown')),
 ('missing-extraction-field',lambda a:a[1]['positive']['extractionEvidence'].update(fieldsPerSlot=138)),
 ('missing-effect-claim',lambda a:a[1]['positive']['effectClaims'].pop()),
 ('lost-transfer-counterexample',lambda a:a[1]['transfer']['planClaims'][0].update(result='unsat')),
 ('missing-transfer-witness',lambda a:a[1]['transfer']['planClaims'][0].pop('wireArgs')),
 ('wrong-effect-slot-count',lambda a:a[1]['positive'].update(effectSlots=1)),
 ('wrong-semantic-checker',lambda a:a[1].update(checkerSha256='0'*64)),
 ('wrong-effect-model',lambda a:a[1].update(effectSemanticsSha256='0'*64)),
])
controls.extend([
 ('missing-validator-claim',lambda a:a[1]['positive']['validatorClaims'].pop()),
 ('duplicate-validator-claim',lambda a:a[1]['positive']['validatorClaims'].__setitem__(1,a[1]['positive']['validatorClaims'][0])),
 ('validator-unknown',lambda a:a[1]['positive']['validatorClaims'][0].update(result='unknown')),
 ('missing-reserved-independence',lambda a:a[1]['positive'].pop('reservedIndependence')),
 ('wrong-token-model',lambda a:a[1].update(tokenSemanticsSha256='0'*64)),
 ('transfer-deposit-reachable',lambda a:a[1]['transfer']['witnesses'][3].update(result='sat')),
 ('lost-plan-claim',lambda a:a[1]['positive']['planClaims'].pop()),
])
controls.extend([
 ('wrong-executor-model',lambda a:a[1].update(tokenExecutorSha256='0'*64)),
 ('missing-executor-body',lambda a:a[1]['positive'].pop('executorBody')),
 ('wrong-executor-capacity',lambda a:a[1]['positive']['executorBody'].update(infosCapacity=13)),
 ('missing-executor-binding',lambda a:a[1]['positive']['bindingAudit'].update(outputs=84,rows=8)),
 ('missing-executor-frame-claim',lambda a:a[1]['positive']['validatorClaims'].pop()),
])
results=[]
for name,mutate in controls:
 bad=copy.deepcopy(reports);mutate(bad)
 try:validate_semantics(bad,data,fresh['inputSha256'])
 except (ValueError,RuntimeError,KeyError) as e:results.append({'name':name,'rejection':str(e)})
 else:raise RuntimeError('escaped '+name)
validate_semantics(reports,data,fresh['inputSha256'])
f=data['fixture'];source=Source(data['program']['source']);codec=Codecs(source,{'headerName':'vault.h','schema':f['schema'],'native':f['files']['vault.h'],'codecs':f['files']['vault.wire.h']});decoder=PackedDecoder(codec,'U32')
# Inputs go out of scope between calls; expected integers are computed without
# the symbolic codec implementation or its packing helper.
for i in range(256):
 raw=0x10203040+i;ok,value=decoder.pair(z.BitVecVal(raw,32));expected=int.from_bytes(raw.to_bytes(4,'big'),'little')
 if not z.is_true(z.simplify(ok)) or z.simplify(value).as_long()!=expected:raise RuntimeError('decoder cache reused an unrelated input')
 if i%16==0:gc.collect()
try:decoder.pair(z.BitVecVal(0,24))
except ValueError as e:
 if str(e)!='packed decoder width':raise
else:raise RuntimeError('wrong-width decoder input accepted')
from effect_semantics import Extraction
extraction=Extraction(source,f);faults=[]
amount=extraction.outputs[('amount',)]
formulas=[('swapped-amount-limbs',amount!=z.Concat(z.Extract(31,0,amount),z.Extract(63,32,amount))),('wrong-active-opcode',extraction.outputs[('active',)]!=0),('omitted-success-path',z.Not(z.Or([g for g,r in zip(extraction.guards,extraction.single_runs) if r.ret==1][1:]))),('swapped-plural-slots',z.Or([extraction.slots[0][loc]!=extraction.slots[1][loc] for loc in extraction.outputs]))]
for name,formula in formulas:
 solver=z.Solver();solver.set(timeout=30000);solver.add(formula);result=solver.check()
 if result!=z.sat:raise RuntimeError(name+': '+str(result))
 faults.append({'name':name,'result':str(result)})
try:extraction.extract(z.BitVec('wrong_effect_sort',32))
except ValueError as e:
 if str(e)!='extraction input sort':raise
else:raise RuntimeError('wrong effect sort accepted')
(root/'semantic-tests.json').write_text(json.dumps({'passed':True,'reportRefusals':results,'extractionFaults':faults,'wrongEffectSortRefused':True,'cacheInputs':256,'wrongWidthRefused':True,'receiptSha256':hashlib.sha256((r/'fresh-receipt.json').read_bytes()).hexdigest()},indent=2)+'\n');print('44 semantic report refusals; 256 temporary decoder inputs and wrong-width refusal passed')
