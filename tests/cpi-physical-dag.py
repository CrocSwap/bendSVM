"""Meaningful structural fingerprint controls and fresh-context roundtrips."""
if not __debug__:
    raise RuntimeError('assertions required')
import json
from pathlib import Path
import sys

sys.path.insert(0, 'verification')
import z3 as z
from cpi_physical.dag import SCHEME, fingerprint

assert z.get_version_string() == '5.1.0'
destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
x, y = z.BitVecs('x y', 64)
a = z.Array('a', z.BitVecSort(64), z.BitVecSort(8))
rows = []


def distinct(name, left, right):
    lh, rh = fingerprint(left), fingerprint(right)
    assert lh != rh, name
    rows.append({'name': name, 'left': lh, 'right': rh})


distinct('operator', x + y, x - y)
distinct('width', x, z.BitVec('x', 32))
distinct('literal', z.BitVecVal(3, 64), z.BitVecVal(4, 64))
distinct('symbol', x, y)
distinct('child-order', x - y, y - x)
distinct('extract-parameters', z.Extract(7, 0, x), z.Extract(15, 8, x))
distinct('extension-parameters', z.ZeroExt(1, x), z.ZeroExt(2, x))
distinct('array-range', a, z.Array('a', z.BitVecSort(64), z.BitVecSort(16)))
distinct('lambda-bound-index', z.Lambda(x, z.Lambda(y, x)), z.Lambda(x, z.Lambda(y, y)))
distinct('lambda-binding-order', z.Lambda(x, z.Lambda(y, x)), z.Lambda(y, z.Lambda(x, x)))
distinct('lambda-body', z.Lambda(x, z.Select(a, x)),
         z.Lambda(x, z.Select(a, x + 1)))
distinct('uninterpreted-signature', z.Function('f', z.BitVecSort(64), z.BitVecSort(8))(x),
         z.Function('f', z.BitVecSort(64), z.BitVecSort(16))(x))

expressions = [x + y == 5, z.Extract(7, 0, x) == 9,
               z.Select(z.Lambda(x, z.Select(a, x + 1)), y) == 7,
               z.Select(z.K(z.BitVecSort(64), z.BitVecVal(0, 8)), x) == 0,
               z.If(x == 0, y == 1, y == 2), z.And(x == 4, y != 2)]
roundtrips = []
for i, expression in enumerate(expressions):
    solver = z.Solver()
    solver.add(expression)
    # to_smt2() rewrites some syntax (including distinct) in the benchmark
    # printer. The declaration/assertion printer retains these actual DAGs.
    text = solver.sexpr() + '(check-sat)\n'
    context = z.Context()
    parsed = z.parse_smt2_string(text, ctx=context)
    assert len(parsed) == 1
    original, fresh = fingerprint(expression), fingerprint(parsed[0])
    assert original == fresh, ('fresh SMT context', i)
    roundtrips.append({'case': i, 'fingerprint': original})

# A linear-size shared DAG has an exponential tree expansion. No sexpr() of
# its expression is needed, and the iterative traversal also avoids recursion.
shared = x
for _ in range(2000):
    shared = shared + shared
shared_hash = fingerprint(shared)
assert shared_hash == fingerprint(shared)

# The printer can flatten nested associative nodes. Preserve that distinction
# rather than treating a syntax fingerprint as an equivalence certificate.
grouped = z.And(z.And(x == 1, y == 2), x + (y + 3) == 4)
printer = z.Solver()
printer.add(grouped)
reparsed = z.parse_smt2_string(printer.sexpr())[0]
assert not z.eq(grouped, reparsed)
assert fingerprint(grouped) != fingerprint(reparsed)
assert z.is_true(z.simplify(grouped == reparsed))

refusals = []
for name, expression in [('integer-sort', z.Int('n')),
                         ('multidimensional-array', z.Const('matrix', z.ArraySort(
                             z.BitVecSort(64), z.BitVecSort(32), z.BitVecSort(8)))),
                         ('forall', z.ForAll(x, x == x)),
                         ('exists', z.Exists(x, x == 1)),
                         ('function-parameter', z.Map(z.Function('g', z.BitVecSort(8),
                                                                 z.BitVecSort(8)), a))]:
    try:
        fingerprint(expression)
    except TypeError as error:
        refusals.append({'name': name, 'reason': str(error)})
    else:
        raise AssertionError('unsupported expression accepted: ' + name)

destination.write_text(json.dumps({'passed': True, 'scheme': SCHEME,
    'distinctions': rows, 'freshContextRoundtrips': roundtrips,
    'serializationRegrouping': {'sourceFingerprint': fingerprint(grouped),
        'rawFingerprint': fingerprint(reparsed), 'equivalence': 'simplifier-true'},
    'sharedDagDepth': 2000, 'sharedDagFingerprint': shared_hash,
    'refusals': refusals}, indent=2) + '\n')
print('DAG distinctions, fresh-context roundtrips, shared traversal and refusals passed')
