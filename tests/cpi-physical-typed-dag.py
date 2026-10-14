"""Typed DAG declaration identity, context isolation and cache lifetime controls."""
if not __debug__:
    raise RuntimeError('assertions required')
import json
from pathlib import Path
import sys
sys.path.insert(0, 'verification')
import z3 as z
from cpi_physical.typed_dag import fingerprint, Fingerprints, SCHEME

def declaration(context, width=8, field='payload', constructor='Some'):
    value = z.Datatype('TypedValue', ctx=context)
    value.declare(constructor, (field, z.BitVecSort(width, ctx=context)))
    value.declare('None')
    return value.create()

context = z.Context()
value = declaration(context)
term = z.Const('value', value)
baseline = value.recognizer(0)(term)
fresh_context = z.Context()
fresh = declaration(fresh_context)
assert fingerprint(baseline) == fingerprint(fresh.recognizer(0)(z.Const('value', fresh)))
controls = []
for name, width, field, constructor in [('field-width', 16, 'payload', 'Some'),
    ('field-name', 8, 'other', 'Some'), ('constructor-name', 8, 'payload', 'Other')]:
    ctx = z.Context()
    changed = declaration(ctx, width, field, constructor)
    altered = changed.recognizer(0)(z.Const('value', changed))
    assert fingerprint(altered) != fingerprint(baseline), name
    controls.append(name)
cache = Fingerprints()
assert cache(baseline) == fingerprint(baseline)
assert cache(value.payload(term)) == fingerprint(value.payload(term))
for i in range(1000):
    ephemeral = value.payload(term) + z.BitVecVal(i, 8, ctx=context)
    assert cache(ephemeral) == fingerprint(ephemeral)
try:
    cache(fresh.recognizer(0)(z.Const('value', fresh)))
except ValueError as error:
    assert str(error) == 'fingerprint session context differs'
    controls.append('cross-context-session')
else:
    raise AssertionError('cross-context session accepted')
recursive = z.Datatype('Recursive')
recursive.declare('End')
recursive.declare('Link', ('next', recursive))
recursive = recursive.create()
try:
    fingerprint(z.Const('recursive', recursive))
except TypeError as error:
    assert 'recursive datatype' in str(error)
    controls.append('recursive-declaration')
else:
    raise AssertionError('recursive datatype accepted')
Path(sys.argv[1]).write_text(json.dumps({'passed': True, 'scheme': SCHEME,
    'controls': controls, 'freshDeclarationContext': True,
    'retainedCacheComparisons': 1000}, indent=2) + '\n')
print('Typed declarations, fresh contexts and retained AST cache controls passed')
