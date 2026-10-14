"""Typed symbolic semantics for audited fixed-record token effect extraction.

The existing restricted extraction parser, native layout bridge and Z3 remain
trusted. This module neither models token execution nor verifies SBF lowering.
"""
import z3 as z
import effect_extraction as e
from acyclic_c import need

class Calls(e.Run):
    def __init__(self, *args):
        super().__init__(*args)
        self.calls = []

    def call(self, node):
        answer = super().call(node)
        slot = self.slot(node[2][1][1])
        self.calls.append((self.slots[slot][1], answer))
        return answer

class Extraction:
    def __init__(self, source, fixture):
        self.source = source
        self.spec = spec = e.Spec(fixture['schema'], fixture['interface'])
        need(spec.kind in ('token-v1', 'token-v2', 'cpi-v1') and spec.length is None,
             'typed extraction: only fixed token effect records are supported')
        adapter = fixture['files'][fixture['adapter']]
        self.conformance = e.check_extraction(fixture['schema'], fixture['interface'], adapter, fixture['files'])
        _, tokens = e.split_includes(adapter)
        parser = e.Parser(tokens, spec.slot_type, ('write_le',))
        parser.exact(f'static inline int bend_extract_effect(const {spec.effect_ctype} *value, {spec.slot_type} *out) {{', 'single')
        self.single_runs = e.explore(spec, spec.effect, False, parser.body())
        self.value = z.Const('extraction_single_value', source.sort(spec.effect))
        self.guards = [self.condition(spec.effect, self.value, run.cons) for run in self.single_runs]
        self.single_ok = z.Or([g for g, run in zip(self.guards, self.single_runs) if run.ret == 1])
        self.outputs = {}
        for loc in e.zero_slot(spec.locations):
            width = 8 if isinstance(loc[0], tuple) else 64 if spec.locations[loc][0] == 'u64' else 32
            out = z.BitVecVal(0, width)
            for guard, run in zip(self.guards, self.single_runs):
                out = z.If(guard, self.term(spec.effect, self.value, run.out[loc], width), out)
            self.outputs[loc] = out
        parser.calls = ('bend_extract_effect',)
        parser.exact(f'static inline int bend_extract_effects(const {spec.effects_ctype} *value, {spec.slot_type} *out) {{', 'plural')
        body = parser.body()
        self.paths, pending = [], [[]]
        while pending:
            decisions = pending.pop()
            run = Calls(spec, spec.effects, True, decisions)
            try:
                need(run.block(body), 'plural fallthrough')
            except e.Fork:
                pending.extend([decisions + [False], decisions + [True]])
                need(len(pending) + len(self.paths) <= e.PATH_LIMIT, 'plural path limit')
                continue
            need(run.cursor == len(decisions), 'plural decisions')
            self.paths.append(run)
        self.plural_value = z.Const('extraction_plural_value', source.sort(spec.effects))
        self.plural_guards = []
        for run in self.paths:
            calls = [z.substitute(self.single_ok, (self.value, self.single_at(path))) == answer for path, answer in run.calls]
            self.plural_guards.append(z.And(self.condition(spec.effects, self.plural_value, run.cons), *calls))
        self.ok = z.Or([g for g, run in zip(self.plural_guards, self.paths) if run.ret == 1])
        self.slots = []
        for i in range(spec.slots):
            slot = {}
            for loc, value in self.outputs.items():
                out = z.BitVecVal(0, value.size())
                for guard, run in zip(self.plural_guards, self.paths):
                    if run.ret != 1:
                        continue
                    got = run.slots[i]
                    if got[0] == 'zero':
                        actual = z.BitVecVal(0, value.size())
                    else:
                        need(got[0] == 'extracted' and got[2], 'successful plural slot')
                        actual = z.substitute(value, (self.value, self.single_at(got[1])))
                    out = z.If(guard, actual, out)
                slot[loc] = out
            self.slots.append(slot)

    def access(self, root, value, path):
        name = root
        for k, j in path:
            value = self.source.sort(name).accessor(k, j)(value)
            name = self.source.types[name]['variants'][k]['fields'][j]['type']
        return name, value

    def term(self, root, value, term, bits=32):
        kind = term[0]
        if kind == 'const':
            return z.BitVecVal(term[1], bits)
        if kind == 'cat':
            return z.Concat(self.term(root, value, term[1]), self.term(root, value, term[2]))
        if kind == 'byte':
            return z.Extract(8 * term[2] + 7, 8 * term[2], self.term(root, value, term[1]))
        need(kind in ('tag', 'leaf'), 'unsupported extraction term')
        name, val = self.access(root, value, term[1])
        if kind == 'tag':
            sort = self.source.sort(name)
            out = z.BitVecVal(sort.num_constructors() - 1, 32)
            for k in reversed(range(sort.num_constructors() - 1)):
                out = z.If(sort.recognizer(k)(val), z.BitVecVal(k, 32), out)
            return out
        if z.is_bool(val):
            return z.If(val, z.BitVecVal(1, 32), z.BitVecVal(0, 32))
        need(z.is_bv(val) and val.size() == 32, 'extraction leaf width')
        return val

    def condition(self, root, value, constraints):
        return z.And([z.Or([z.And(z.UGE(self.term(root, value, term), lo), z.ULE(self.term(root, value, term), hi))
                           for lo, hi in intervals]) for term, intervals in constraints.items()])

    def single_at(self, path):
        name, value = self.access(self.spec.effects, self.plural_value, path)
        need(name == self.spec.effect, 'plural source type')
        return value

    def extract(self, value):
        need(value.sort() == self.plural_value.sort(), 'extraction input sort')
        pair = (self.plural_value, value)
        return z.simplify(z.substitute(self.ok, pair)), [
            {loc: z.simplify(z.substitute(expr, pair)) for loc, expr in slot.items()} for slot in self.slots]

    def verify(self):
        claims = []
        def prove(name, bad):
            solver = z.Solver()
            solver.set(timeout=30000)
            solver.add(bad)
            result = solver.check()
            need(result == z.unsat, name + ': ' + str(result))
            claims.append({'name': name, 'result': str(result)})
        prove('typed-effect-path-coverage', z.Not(z.Or(self.guards)))
        prove('typed-effect-never-rejected', z.Or([g for g, run in zip(self.guards, self.single_runs) if run.ret == 0]))
        prove('typed-effect-path-disjointness', z.Or([z.And(self.guards[i], self.guards[j])
                                                    for i in range(len(self.guards)) for j in range(i)]))
        for k, (name, selectors, _, build) in self.spec.variants.items():
            choices = [[]]
            for term in selectors:
                choices = [choice + [(term, val)] for choice in choices for val in e.values(self.spec.s.domain(self.spec.effect, term))]
            for index, choice in enumerate(choices):
                expected = build(dict(choice))
                guard = z.And(self.source.sort(self.spec.effect).recognizer(k)(self.value),
                              *[self.term(self.spec.effect, self.value, term) == val for term, val in choice])
                prove(name + '-mapping-' + str(index), z.And(guard, z.Or([
                    self.outputs[loc] != self.term(self.spec.effect, self.value, term, self.outputs[loc].size())
                    for loc, term in expected.items()])))
        prove('plural-typed-path-coverage', z.Not(z.Or(self.plural_guards)))
        prove('plural-typed-path-disjointness', z.Or([z.And(self.plural_guards[i], self.plural_guards[j])
                                                   for i in range(len(self.plural_guards)) for j in range(i)]))
        prove('plural-fixed-record-never-rejected', z.Not(self.ok))
        for i, path in enumerate(self.spec.slot_paths):
            expected = {loc: z.substitute(val, (self.value, self.single_at(path))) for loc, val in self.outputs.items()}
            prove('plural-slot-' + str(i) + '-all-fields', z.Or([self.slots[i][loc] != val for loc, val in expected.items()]))
        return {'claims': claims, 'singlePaths': len(self.single_runs), 'pluralPaths': len(self.paths),
                'slots': len(self.slots), 'fieldsPerSlot': len(self.outputs)}
