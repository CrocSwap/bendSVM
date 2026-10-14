"""Strict inventories for the physical-frame component and its raw queries."""
if not __debug__:
    raise RuntimeError('assertions required')
import hashlib
from pathlib import Path
import re

import z3 as z
from cpi_physical.dag import SCHEME, fingerprint

QUERY_NAMES = [
    'serialized-write-ranges-contained', 'own-key-excluded',
    'pending-excluded-from-account', 'pending-excluded-from-workspace',
    'actual-runtime-frame-selection', 'excluded-permissions-preserve-byte',
    'inactive-runtime-preservation', 'private-workspace-write-witness',
    *['exact-size-refresh-' + str(i) for i in range(12)],
    'failed-helper-does-not-refresh', 'inactive-helper-does-not-refresh',
    'descriptor-nonsize-bytes-preserved', 'outside-descriptor-single-store-preservation',
    'conditional-array-preservation', 'allocated-resize-128-to-192', 'allocated-resize-128-to-32',
    'truthful-length-within-capacity', 'readonly-serialized-length-preserved',
    'missing-workspace-separation', 'missing-managed-capability-exclusion',
    'missing-returned-capacity-premise', 'missing-refresh-counterexample',
    'reused-own-key-exclusion',
]
SAT_NAMES = {'private-workspace-write-witness', 'allocated-resize-128-to-192',
             'allocated-resize-128-to-32', 'missing-workspace-separation',
             'missing-managed-capability-exclusion', 'missing-returned-capacity-premise',
             'missing-refresh-counterexample'}


def is_hash(value):
    return isinstance(value, str) and re.fullmatch('[0-9a-f]{64}', value) is not None


def validate(report, replay=False):
    assert set(report) == {'passed', 'endToEndVerified', 'componentOnly', 'fingerprintScheme',
                           'queries', 'serializationQueries', 'descriptorStoreInstances', 'memoryFrame', 'scope'}
    assert report['passed'] is True and report['endToEndVerified'] is False
    assert report['componentOnly'] is True and report['fingerprintScheme'] == SCHEME
    assert report['memoryFrame'] == ['writable serialized accounts', 'disjoint private workspace',
                                      'exact successful descriptor size stores']
    assert isinstance(report['scope'], str) and 'not the complete caller-to-commit' in report['scope']
    assert [row['name'] for row in report['queries']] == QUERY_NAMES
    seen = {}
    replays = []
    # Reject invalid inventories and metadata before traversing every raw DAG.
    # Each accepted report still reads and fingerprints all queries afresh.
    for row in report['queries']:
        name = row['name']
        wanted = 'sat' if name in SAT_NAMES else 'unsat'
        assert row['result'] == wanted, name
        assert is_hash(row['formulaFingerprint']), name
        assert is_hash(row['sourceFormulaFingerprint']), name
        if name == 'reused-own-key-exclusion':
            assert set(row) == {'name', 'result', 'reuse', 'formulaFingerprint', 'sourceFormulaFingerprint'}
            assert row['reuse'] == 'own-key-excluded'
            original = seen[row['reuse']]
            assert row['formulaFingerprint'] == original['formulaFingerprint'], 'reuse formula differs'
            assert row['sourceFormulaFingerprint'] == original['sourceFormulaFingerprint'], 'reuse source formula differs'
        else:
            assert set(row) == {'name', 'result', 'query', 'querySha256',
                                'formulaFingerprint', 'sourceFormulaFingerprint', 'serializationBridge',
                                *(['witness'] if wanted == 'sat' else [])}
            assert row['serializationBridge'] in ['exact-ast', 'simplifier-true', 'fresh-unsat']
            if row['serializationBridge'] == 'exact-ast':
                assert row['sourceFormulaFingerprint'] == row['formulaFingerprint']
            path = Path(row['query'])
            assert path.name == name + '.smt2'
            if wanted == 'sat':
                assert isinstance(row['witness'], str) and len(row['witness']) > 2
        seen[name] = row
    assert [row['name'] for row in report['serializationQueries']] == [
        row['name'] + '-serialization' for row in report['queries'] if row.get('serializationBridge') == 'fresh-unsat']
    for row in report['serializationQueries']:
        assert set(row) == {'name', 'result', 'query', 'querySha256', 'formulaFingerprint'}
        assert row['result'] == 'unsat'
        assert Path(row['query']).name == row['name'] + '.smt2'
    instances = report['descriptorStoreInstances']
    assert [row['offset'] for row in instances] == [i * 64 + 24 + k for i in range(12) for k in range(8)]
    for row in instances:
        assert set(row) == {'offset', 'formulaFingerprint', 'premisesFingerprints',
                           'nonSizeFormulaFingerprint', 'nonSizePremisesFingerprints'}
        assert is_hash(row['formulaFingerprint'])
        assert len(row['premisesFingerprints']) == 3 and all(is_hash(h) for h in row['premisesFingerprints'])
        assert is_hash(row['nonSizeFormulaFingerprint'])
        assert len(row['nonSizePremisesFingerprints']) == 5 and all(is_hash(h) for h in row['nonSizePremisesFingerprints'])
    for row in report['queries']:
        name = row['name']
        wanted = 'sat' if name in SAT_NAMES else 'unsat'
        if name != 'reused-own-key-exclusion':
            path = Path(row['query'])
            raw = path.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == row['querySha256'], 'raw query hash differs'
            context = z.Context()
            parsed = z.parse_smt2_string(raw.decode(), ctx=context)
            assert len(parsed) == 1, 'exactly one bound formula required'
            assert fingerprint(parsed[0]) == row['formulaFingerprint'], 'raw formula fingerprint differs'
            if replay:
                solver = z.Then(z.With(z.Tactic('simplify', ctx=context), expand_select_ite=True),
                                z.Tactic('smt', ctx=context)).solver()
                solver.set(timeout=30000)
                solver.add(parsed)
                result = solver.check()
                assert str(result) == wanted, (name, str(result), solver.reason_unknown())
                replays.append({'name': name, 'result': str(result), 'querySha256': row['querySha256'],
                                'formulaFingerprint': row['formulaFingerprint']})
                print('replay', name, result, flush=True)
    for row in report['serializationQueries']:
        path = Path(row['query'])
        raw = path.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == row['querySha256']
        context = z.Context()
        parsed = z.parse_smt2_string(raw.decode(), ctx=context)
        assert len(parsed) == 1 and fingerprint(parsed[0]) == row['formulaFingerprint']
        if replay:
            solver = z.Then(z.With(z.Tactic('simplify', ctx=context), expand_select_ite=True),
                                z.Tactic('smt', ctx=context)).solver()
            solver.set(timeout=30000)
            solver.add(parsed)
            answer = solver.check()
            assert answer == z.unsat, (row['name'], str(answer), solver.reason_unknown())
            replays.append({'name': row['name'], 'result': str(answer), 'querySha256': row['querySha256'],
                            'formulaFingerprint': row['formulaFingerprint']})
            print('replay', row['name'], answer, flush=True)
    return replays
