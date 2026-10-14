"""Replay frame queries, reconstruct descriptor Stores and rerun native controls."""
if not __debug__:
    raise RuntimeError('assertions required')
import hashlib
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, 'verification')
import z3 as z
from cpi_physical import frame as f
from cpi_physical.dag import fingerprint
from cpi_physical.report import validate

assert z.get_version_string() == '5.1.0'
proof_path, native_path, output = map(Path, sys.argv[1:4])
proof, native = json.loads(proof_path.read_bytes()), json.loads(native_path.read_bytes())
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()
replays = validate(proof, replay=True)
bindings = {str(proof_path): sha(proof_path), str(native_path): sha(native_path)}
for row in [*proof['queries'], *proof['serializationQueries']]:
    if 'query' in row:
        bindings[row['query']] = row['querySha256']

# Reconstruct the exact helper size loop independently of the producer's AST
# traversal. Every recorded byte-store lemma must match this concrete loop.
memory = z.Array('before', z.BitVecSort(64), z.BitVecSort(8))
descriptor, info, status, count, address = z.BitVecs('descriptor info status count address', 64)
enabled = z.Bool('enabled')
point, offset = z.BitVecs('point offset', 64)
descriptor_byte = descriptor + f.u64(64) * point + offset
current = memory
reconstructed = {}
for i in range(12):
    length = f.read_u64(memory, info + f.u64(56 * i + 16))
    previous = current
    for k in range(8):
        off = i * 64 + 24 + k
        byte = z.Extract(8 * k + 7, 8 * k, length)
        canonical = z.Store(current, descriptor + f.u64(off), byte)
        formula = z.Select(canonical, address) == z.Select(current, address)
        premises = [z.Not(f.inside(address, f.Span(descriptor, f.u64(768)))),
                    f.bounded(f.Span(descriptor, f.u64(768)), f.MAX_WORKSPACE),
                    z.ULT(f.u64(off), f.u64(768))]
        nonsize_store = z.Store(current, descriptor + f.u64(64) * f.u64(i) + f.u64(24) + f.u64(k), byte)
        nonsize_formula = z.Select(nonsize_store, descriptor_byte) == z.Select(current, descriptor_byte)
        nonsize_premises = [z.ULT(point, f.u64(12)), z.ULT(offset, f.u64(64)),
                           z.Or(z.ULT(offset, f.u64(24)), z.UGE(offset, f.u64(32))),
                           z.ULT(f.u64(i), f.u64(12)), z.ULT(f.u64(k), f.u64(8))]
        reconstructed[off] = {'offset': off, 'formulaFingerprint': fingerprint(formula),
                             'premisesFingerprints': [fingerprint(p) for p in premises],
                             'nonSizeFormulaFingerprint': fingerprint(nonsize_formula),
                             'nonSizePremisesFingerprints': [fingerprint(p) for p in nonsize_premises]}
        # Preserve the actual nested address expression in the loop AST.
        current = z.Store(current, (descriptor + f.u64(i * 64 + 24)) + f.u64(k), byte)
    current = z.If(z.And(enabled, status == f.u64(0), z.ULT(f.u64(i), count)), current, previous)
assert proof['descriptorStoreInstances'] == [reconstructed[k] for k in sorted(reconstructed)], \
    'descriptor Store instantiation differs from reconstructed exact size loop'

expected = [('baseline', 0, None), ('missing-refresh', 45, 'descriptor length refresh differs'),
            ('wrong-refresh-index', 45, 'descriptor length refresh differs'),
            ('descriptor-pointer-write', 46, 'descriptor pointer or privilege changed'),
            ('pending-effect-write', 47, 'pending effect bytes changed'),
            ('ignored-error', 44, 'helper result differs')]
assert native['passed'] is True and native['baselineScenarios'] == 24
assert [(row['name'], row['exitCode'], row['reason']) for row in native['rows']] == expected
assert 'syscall doubles' in native['scope']
for path, expected_hash in native['inputs'].items():
    assert sha(path) == expected_hash, ('native source drift', path)
    bindings[path] = expected_hash
native_replays = []
original_header = Path('runtime/bend_cpi.h').read_text()
header_mutations = {
    'baseline': (None, None),
    'missing-refresh': ('a[i].size=infos[i].data_len;', '(void)infos[i].data_len;'),
    'wrong-refresh-index': ('a[i].size=infos[i].data_len;', 'a[i].size=infos[0].data_len;'),
    'descriptor-pointer-write': ('if(error) return error;', 'if(error) return error; a[0].data=a[1].data;'),
    'pending-effect-write': ('if(error) return error;', 'if(error) return error; ((BendInvoke *)t)->data[0]^=1;'),
    'ignored-error': ('if(error) return error;', '(void)error;'),
}
native_folder = native_path.parent
assert sha(native_folder / 'harness.c') == native['harnessSha256'] == sha('tests/cpi-physical-native.c')
bindings[str(native_folder / 'harness.c')] = native['harnessSha256']
for row in native['rows']:
    old, new = header_mutations[row['name']]
    expected_header = original_header
    if old:
        assert expected_header.count(old) == 1
        expected_header = expected_header.replace(old, new)
        assert row['helperGrammarRefusal'] == 'executor grammar: unsupported access/control/syscall skeleton'
    else:
        assert row['helperGrammarRefusal'] is None
    assert Path(row['header']).read_text() == expected_header
    assert row['command'][1:] == ['-std=c11', '-O1', '-fsanitize=address,undefined',
        '-fno-sanitize-recover=all', '-I', str(native_folder), str(native_folder / 'harness.c'),
        '-o', row['executable']]
    for key in ['executable', 'header', 'log']:
        assert sha(row[key]) == row[key + 'Sha256'], (row['name'], key)
        bindings[row[key]] = row[key + 'Sha256']
    result = subprocess.run([row['executable']], capture_output=True, text=True, timeout=10)
    assert result.returncode == row['exitCode'], (row['name'], result.returncode)
    assert result.stderr == (row['reason'] + '\n' if row['reason'] else '')
    assert not result.stdout
    native_replays.append({'name': row['name'], 'exitCode': result.returncode})
layout = native['sbfLayout']
assert '20.1.7' in layout['version']
for key in ['compiler', 'object']:
    assert sha(layout[key]) == layout[key + 'Sha256']
    bindings[layout[key]] = layout[key + 'Sha256']
output.write_text(json.dumps({'passed': True, 'componentOnly': True, 'endToEndVerified': False,
    'queryReplays': replays, 'descriptorStoreInstances': len(reconstructed),
    'nativeReplays': native_replays, 'bindings': bindings,
    'scope': __doc__ + ' Allocation/runtime/ABI premises remain; actual full caller composition pending.'}, indent=2) + '\n')
print('Frame raw queries, exact descriptor store reconstruction and native replay audit passed')
