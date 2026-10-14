"""Canonical Nat literals evaluate; raw constructor terms fail explicitly."""
import sys
if not __debug__:
    raise RuntimeError('assertions required')
sys.path.insert(0, 'verification')
import z3 as z
from prove import Evaluator

model = {'schema': {'types': [{'name': 'Nat', 'kind': 'u32', 'max': 64}]}, 'functions': {}}
evaluator = Evaluator(model)
for value in range(65):
    actual = evaluator.expression({'$': 'Nat', 'value': value}, {}, z.BoolVal(True))
    assert z.simplify(actual).as_long() == value
for term in [
    {'$': 'Ctr', 'k': 'Zero', 'x': []},
    {'$': 'Ctr', 'k': 'Succ', 'x': [{'$': 'Ctr', 'k': 'Zero', 'x': []}]},
    {'$': 'Ctr', 'k': 'Succ', 'x': [{'$': 'Var', 'i': 0}]},
]:
    try:
        evaluator.expression(term, {0: z.BitVec('predecessor', 32)}, z.BoolVal(True))
    except ValueError as exc:
        assert str(exc) == 'Noncanonical model Nat constructor; expected exported Nat literal'
    else:
        raise AssertionError('noncanonical Nat accepted')
print('65 canonical Nat literals and three noncanonical constructor refusals passed')
