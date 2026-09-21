"""Generic specialization laws over the exported checked source, not C lowering."""
import json
import sys
import z3 as z
from prove import Evaluator

program = json.load(open(sys.argv[1]))
e = Evaluator(program)
x, other = z.BitVecs('x other', 32)
b, fallback = z.Bools('b fallback')

def ctor(name, *args):
    sort, index = e.constructors[name]
    return sort.constructor(index)(*args)

def call(name, *args):
    return e.call(name, list(args), z.BoolVal(True))

claims = {
    'word preserves arbitrary U32': call('word', x) == ctor('Box<U32>', x),
    'flag preserves arbitrary Bool': call('flag', b) == ctor('Box<Bool>', b),
    'nested types preserve payload': call('nested', x) == ctor('Box<Box<U32>>', ctor('Box<U32>', x)),
    'nested unwrap': call('unwrap', ctor('Box<Box<U32>>', ctor('Box<U32>', x))) == x,
    'present U32 selection': call('choose_word', ctor('Present<U32>', x), other) == x,
    'absent U32 fallback': call('choose_word', ctor('Absent<U32>'), other) == other,
    'present Bool selection': call('choose_flag', ctor('Present<Bool>', b), fallback) == b,
    'absent Bool fallback': call('choose_flag', ctor('Absent<Bool>'), fallback) == fallback,
    'present construction': call('present', x) == ctor('Present<U32>', x),
    'absent construction': call('absent') == ctor('Absent<Bool>'),
    'exhaustive checked matches': z.Not(z.Or(*e.dead)),
}
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
