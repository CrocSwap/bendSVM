"""Source contracts for collection ranges and global-index reads."""
import json
import sys
import z3 as z
from prove import Evaluator

program = json.load(open(sys.argv[1]))
e = Evaluator(program)
claims = {}

def ctor(t, tag, *fields):
    return e.sort(t).constructor(tag)(*fields)

def field(t, index):
    return e.types[t]['variants'][0]['fields'][index]['type']

def storage(t, values):
    if len(values) == 1:
        return values[0]
    half = len(values)//2
    return ctor(t, 0, storage(field(t, 0), values[:half]), storage(field(t, 1), values[half:]))

length, capacity, start, count, maximum, index = z.BitVecs('length capacity start count maximum index', 32)
wide = lambda v: z.ZeroExt(1, v)
for name in ['read_range', 'reserve_range']:
    f = program['functions'][name]
    range_type = e.types[f['result']]['variants'][1]['fields'][0]['type']
    limit = length if name == 'read_range' else capacity
    # 33-bit mathematical addition cannot wrap when summing two u32 values.
    valid = z.And(z.ULE(length, capacity), z.ULE(count, maximum), z.ULE(start, length),
                  z.ULE(wide(start) + wide(count), wide(limit)))
    expected = z.If(valid, ctor(f['result'], 1, ctor(range_type, 0, start, count)), ctor(f['result'], 0))
    actual = e.call(name, [ctor(f['args'][0], 0, length, capacity), start, count, maximum], z.BoolVal(True))
    claims[name+' exact nonwrapping interval'] = actual == expected

for suffix, size in [('word', 4), ('flag', 2)]:
    f = program['functions']['get_'+suffix]
    wt = f['args'][0]
    vt = field(wt, 1)
    values = [z.BitVec(f'w{i}', 32) if suffix == 'word' else z.Bool(f'b{i}') for i in range(size)]
    window = ctor(wt, 0, start, ctor(vt, 0, length, storage(field(vt, 1), values)))
    local = index - start
    valid = z.And(z.ULE(length, size), z.ULE(start, index), z.ULT(local, length))
    selected = values[-1]
    for i in reversed(range(size-1)):
        selected = z.If(local == i, values[i], selected)
    expected = z.If(valid, ctor(f['result'], 1, selected), ctor(f['result'], 0))
    claims[suffix+' exact global-index read'] = e.call('get_'+suffix, [window, index], z.BoolVal(True)) == expected
    update = program['functions']['set_'+suffix]
    push = program['functions']['push_'+suffix]
    value = z.BitVec('replacement', 32) if suffix == 'word' else z.Bool('replacement_flag')
    make_window = lambda n, xs: ctor(wt, 0, start, ctor(vt, 0, n, storage(field(vt, 1), xs)))
    replaced = [z.If(local == i, value, x) for i, x in enumerate(values)]
    expected = z.If(valid, ctor(update['result'], 1, make_window(length, replaced)), ctor(update['result'], 0))
    claims[suffix+' update preserves origin length and other elements'] = e.call('set_'+suffix, [window, index, value], z.BoolVal(True)) == expected
    appended = [z.If(length == i, value, x) for i, x in enumerate(values)]
    expected = z.If(z.ULT(length, size), ctor(push['result'], 1, make_window(length+1, appended)), ctor(push['result'], 0))
    claims[suffix+' append preserves origin and prefix'] = e.call('push_'+suffix, [window, value], z.BoolVal(True)) == expected

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
