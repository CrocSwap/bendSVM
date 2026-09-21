"""Bounded vector contracts over checked source with arbitrary lengths and values."""
import json
import sys
import z3 as z
from prove import Evaluator

program = json.load(open(sys.argv[1]))
e = Evaluator(program)
claims = {}

def ctor(type_name, tag, *fields):
    return e.sort(type_name).constructor(tag)(*fields)

def storage(type_name, values):
    if len(values) == 1:
        return values[0]
    fields = e.types[type_name]['variants'][0]['fields']
    half = len(values)//2
    return ctor(type_name, 0, storage(fields[0]['type'], values[:half]),
                storage(fields[1]['type'], values[half:]))

for suffix, capacity in [('word', 4), ('flag', 2)]:
    get = program['functions']['get_'+suffix]
    update = program['functions']['set_'+suffix]
    vt = get['args'][0]
    st = e.types[vt]['variants'][0]['fields'][1]['type']
    length, index = z.BitVecs(suffix+'_length '+suffix+'_index', 32)
    values = [z.BitVec(f'w{i}', 32) if suffix == 'word' else z.Bool(f'b{i}') for i in range(capacity)]
    value = z.BitVec('value', 32) if suffix == 'word' else z.Bool('value')
    vector = lambda n, xs: ctor(vt, 0, n, storage(st, xs))
    call = lambda name, *args: e.call(name+'_'+suffix, list(args), z.BoolVal(True))
    valid = z.And(z.ULE(length, capacity), z.ULT(index, length))
    selected = values[-1]
    for i in reversed(range(capacity-1)):
        selected = z.If(index == i, values[i], selected)
    expected = z.If(valid, ctor(get['result'], 1, selected), ctor(get['result'], 0))
    claims[suffix+' checked access'] = call('get', vector(length, values), index) == expected
    replaced = [z.If(index == i, value, x) for i, x in enumerate(values)]
    expected = z.If(valid, ctor(update['result'], 1, vector(length, replaced)), ctor(update['result'], 0))
    claims[suffix+' update preserves length and other elements'] = call('set', vector(length, values), index, value) == expected
    appended = [z.If(length == i, value, x) for i, x in enumerate(values)]
    expected = z.If(z.ULT(length, capacity), ctor(update['result'], 1, vector(length+1, appended)), ctor(update['result'], 0))
    claims[suffix+' push preserves prefix and rejects overflow'] = call('push', vector(length, values), value) == expected
claims['exhaustive checked matches'] = z.Not(z.Or(*e.dead))
reports = []
for name, law in claims.items():
    solver = z.Solver()
    solver.set(timeout=10000)
    solver.add(z.Not(law))
    result = solver.check()
    reports.append({'name': name, 'result': str(result),
                    **({'counterexample': str(solver.model())} if result == z.sat else {})})
print(json.dumps({'claims': reports}))
sys.exit(0 if all(r['result'] == 'unsat' for r in reports) else 1)
