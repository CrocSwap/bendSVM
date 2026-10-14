"""Permanent refusals for missing claims, altered queries and cache aliases."""
if not __debug__:
    raise RuntimeError('assertions required')
import copy
import json
from pathlib import Path
import sys

sys.path.insert(0, 'verification')
from cpi_physical.report import validate

source, destination = map(Path, sys.argv[1:3])
report = json.loads(source.read_bytes())
validate(report)
rows = []


def refuse(name, mutate):
    changed = copy.deepcopy(report)
    mutate(changed)
    try:
        validate(changed)
    except AssertionError:
        rows.append(name)
    else:
        raise AssertionError('altered report accepted: ' + name)


refuse('missing-workspace-lemma', lambda r: r['queries'].pop(3))
refuse('missing-size-refresh', lambda r: r['queries'].pop(8))
refuse('missing-capacity-premise-control', lambda r: r['queries'].pop(-3))
refuse('wrong-query-result', lambda r: r['queries'][0].update(result='sat'))
refuse('raw-query-hash', lambda r: r['queries'][0].update(querySha256='0' * 64))
refuse('raw-formula-fingerprint', lambda r: r['queries'][0].update(formulaFingerprint='0' * 64))
refuse('cache-alias-formula', lambda r: r['queries'][-1].update(formulaFingerprint=r['queries'][0]['formulaFingerprint']))
refuse('cache-alias-target', lambda r: r['queries'][-1].update(reuse='pending-excluded-from-account'))
refuse('cache-source-formula', lambda r: r['queries'][-1].update(sourceFormulaFingerprint='0' * 64))
refuse('missing-serialization-bridge', lambda r: r['serializationQueries'].clear())
refuse('missing-descriptor-store', lambda r: r['descriptorStoreInstances'].pop())
refuse('store-overwrites-pointer', lambda r: r['descriptorStoreInstances'][0].update(offset=0))
refuse('unbounded-store-premises', lambda r: r['descriptorStoreInstances'][0]['premisesFingerprints'].pop())
refuse('end-to-end-overclaim', lambda r: r.update(endToEndVerified=True))
refuse('component-overclaim', lambda r: r.update(componentOnly=False))
refuse('unexpected-field', lambda r: r.update(wholeGoalComplete=True))
destination.write_text(json.dumps({'passed': True, 'refusals': rows}, indent=2) + '\n')
print('16 altered physical-frame reports refused')
