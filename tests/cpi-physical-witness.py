"""Concrete grounding preserves equations; inconsistent inputs cannot pass."""
if not __debug__:
    raise RuntimeError('assertions required')
import json
from pathlib import Path
import sys
sys.path.insert(0, 'verification')
import z3 as z
from cpi_physical.witness import specialize

ctx = z.Context()
x, y = z.BitVecs('input output', 8, ctx=ctx)
enabled = z.Bool('enabled', ctx=ctx)
memory = z.Array('memory', z.BitVecSort(8, ctx), z.BitVecSort(8, ctx))
premises = [y == x + 1, z.Select(memory, x) == y]
cases = [
    ('positive', z.And(y == 8, enabled), [x == 7, enabled], z.sat),
    ('remaining-equation-refuses', y == 9, [x == 7, enabled], z.unsat),
    ('array-pin-refuses', y == 8, [x == 7, enabled, z.Select(memory, x) == 9], z.unsat),
    ('reversed-and-negative', z.And(y == 8, z.Not(enabled)), [z.BitVecVal(7, 8, ctx) == x, z.Not(enabled)], z.sat),
    ('duplicate-assignment', y == 8, [x == 7, x == 7], z.sat),
    ('non-assignment-retained', y == 8, [x == 7, x + y == 0], z.unsat),
    ('empty-inputs', y == x + 1, [], z.sat),
]
results = []
for name, claim, pins, wanted in cases:
    grounded, inputs = specialize(claim, premises, pins)
    solver = z.Solver(ctx=ctx);solver.set(timeout=10000)
    solver.add(grounded);assert solver.check() == wanted, name
    # Under the explicit pins, both directions of the complete conjunction
    # must agree; this checks retained semantic predicates, not text equality.
    solver = z.Solver(ctx=ctx);solver.set(timeout=10000)
    solver.add(*pins, z.Xor(z.And(*premises, *pins, claim), grounded))
    assert solver.check() == z.unsat, name + ' equivalence'
    assert len({(p['name'], p['sort']) for p in inputs}) == len(inputs)
    results.append({'name': name, 'result': str(wanted), 'fixedInputEquivalence': 'unsat'})
for pins in [[x == 7, x == 8], [enabled, z.Not(enabled)]]:
    try:
        specialize(y == 8, premises, pins)
    except ValueError as error:
        assert str(error) == 'conflicting concrete witness inputs'
    else:
        raise AssertionError('conflicting assignments accepted')
Path(sys.argv[1]).write_text(json.dumps({'passed': True, 'cases': results,
    'conflictingAssignmentsRefused': 2}, indent=2) + '\n')
print('Concrete witness grounding, retained predicates and conflicting assignments checked')
