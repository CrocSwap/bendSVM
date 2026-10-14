"""Symbolic semantics of the parsed ABI 1 entrypoint.

The parsed control flow (branches, bounded loops, returns) is executed over Z3
bitvectors with C integer conversion rules. Calls are interpreted by the
reviewed summaries in `Exec.call_*`: each names the boundary it abstracts.
Helper results, the Bend root result, Clock, loader metadata and account bytes
are unconstrained symbols, so every path condition ranges over arbitrary
values. Byte contents are modeled only for the state account data, instruction
bytes, key bytes the adapter reads and the three local byte arrays; everything
else is an uninterpreted value or predicate.
"""
import z3

from adapter_contract_c import Grammar, need

WIDTH = {'u8': 8, 'int': 32, 'u32': 32, 'u64': 64}


class Semantic(Exception):
    """A modeled property fails for some input; carries a counterexample."""

    def __init__(self, label, model=None):
        super().__init__(label)
        self.label, self.model = label, model or {}


class Fatal(Exception):
    """Solver unknown/timeout or an internal inconsistency: never a result."""


class Dead(Exception):
    """The current path is infeasible and is dropped."""


# ---- Values -------------------------------------------------------------------
class Int:
    def __init__(self, t, e=None, b=None, valid=None):
        self.t, self._e, self.b, self.valid = t, e, b, valid

    @property
    def e(self):
        if self._e is None:
            self._e = z3.If(self.b, z3.BitVecVal(1, 32), z3.BitVecVal(0, 32))
        return self._e

    def key(self):
        return (self.t, self.b, self._e, self.valid)


class Ptr:
    """`at` is the number of account records before a loader cursor or the
    instruction ('cursor'/'ix' regions); other regions name an account."""

    def __init__(self, region, off, null, at=None):
        self.region, self.off, self.null, self.at = region, off, null, at

    def key(self):
        return (self.region, self.off, self.null, self.at)

    def shape(self):
        return (self.region, self.off)

    def join(self, cond, other):
        return Ptr(self.region, self.off, z3.simplify(z3.If(cond, other.null, self.null)),
                   None if self.at is None else z3.simplify(z3.If(cond, other.at, self.at)))


class Ref:  # address of a local object
    def __init__(self, *path):
        self.path = path

    def key(self):
        return self.path


class Obj:  # abstract non-scalar value
    def __init__(self, kind, *fields, ctype=None, valid=None):
        self.kind, self.f, self.ctype, self.valid = kind, fields, ctype, valid

    def key(self):
        return (self.kind, self.ctype, self.f, self.valid)

    def shape(self):  # the account array differs between loop exits only in what was filled
        return (self.kind, self.ctype, len(self.f[0])) if self.kind == 'accounts' else vkey(self)

    def join(self, cond, other):
        filled = lambda x: z3.BoolVal(False) if x is None else x
        return Obj('accounts', tuple(z3.simplify(z3.If(cond, filled(b), filled(a))) for a, b in zip(self.f[0], other.f[0])),
                   ctype=self.ctype)


class Uninit:
    def key(self):
        return ()


def vkey(v):
    if isinstance(v, z3.ExprRef):
        return v.get_id()
    if isinstance(v, (list, tuple)):
        return tuple(vkey(x) for x in v)
    if hasattr(v, 'key'):
        # Values and events are immutable once built, so their keys are cached.
        cached = getattr(v, '_cached', None)
        if cached is None:
            cached = v._cached = (type(v).__name__, vkey(v.key()))
        return cached
    return v


def boolean(b):
    return Int('int', None, z3.simplify(b))


def truth(v):
    if isinstance(v, Ptr):
        return z3.simplify(z3.Not(v.null))
    need(isinstance(v, Int), 'expression: scalar expected in a condition')
    return v.b if v.b is not None else z3.simplify(v.e != 0)


def convert(v, t):
    need(isinstance(v, Int), 'expression: integer value expected')
    e, w, tw = v.e, WIDTH[v.t], WIDTH[t]
    if tw < w:
        e = z3.Extract(tw - 1, 0, e)
    elif tw > w:
        e = z3.SignExt(tw - w, e) if v.t == 'int' else z3.ZeroExt(tw - w, e)
    return Int(t, z3.simplify(e))


def concrete(v):
    if isinstance(v, Int):
        e = z3.simplify(v.e)
        if z3.is_bv_value(e):
            return e.as_long()
    return None


def pack(items):
    return items[0] if len(items) == 1 else z3.Concat(*items)


class Event:
    def __init__(self, kind, **fields):
        self.kind, self.f = kind, fields

    def __getattr__(self, name):
        try:
            return self.__dict__['f'][name]
        except KeyError:
            raise AttributeError(name)

    def key(self):
        return (self.kind, tuple((k, vkey(v)) for k, v in sorted(self.f.items())))


class Path:
    def __init__(self, pc, ret, events):
        self.pc, self.ret, self.events = pc, ret, events


class State:
    def __init__(self, pc, scopes, events):
        self.pc, self.scopes, self.events = pc, scopes, events

    def fork(self, cond):
        return State(z3.simplify(z3.And(self.pc, cond)), [dict(s) for s in self.scopes], list(self.events))

    def find(self, name):
        for scope in reversed(self.scopes):
            if name in scope:
                return scope
        return None

    def key(self):
        return (tuple(tuple((n, vkey(v), info) for n, (v, info) in s.items()) for s in self.scopes),
                tuple(vkey(e) for e in self.events))

    def shape(self):
        """Key that ignores what differs between exits of the account loop."""
        return (tuple(tuple((n, v.shape() if hasattr(v, 'shape') else vkey(v), info) for n, (v, info) in s.items())
                      for s in self.scopes), tuple(vkey(e) for e in self.events))


# ---- Symbols shared by the program semantics and the contract -----------------
class World:
    """Inputs of one adapter invocation. `m` is the schema/interface summary."""

    def __init__(self, m):
        self.m = m
        bv, accounts = z3.BitVec, m['accounts']
        self.COUNT = bv('account_count', 64)
        self.PARSE_OK = [z3.Bool(f'account{i}_not_alias_marker') for i in range(accounts)]
        # A key is an abstract 32-byte value: equal_key is equality of the
        # sort. Byte views exist only for keys whose bytes are read, tied to
        # equality by `axioms`, which keeps wide bitvectors out of the alias checks.
        self.key_sort = z3.DeclareSort('Key32')
        self.KEY = [z3.Const(f'account{i}_key', self.key_sort) for i in range(accounts)]
        self.OWNER = z3.Const('state_owner', self.key_sort)
        self.PROGRAM = z3.Const('program_id', self.key_sort)
        self.viewed = {}
        self.SIGNER = [z3.Bool(f'account{i}_signer') for i in range(accounts)]
        self.WRITABLE = [z3.Bool(f'account{i}_writable') for i in range(accounts)]
        self.EXECUTABLE = [z3.Bool(f'account{i}_executable') for i in range(accounts)]
        self.SIZE = [bv(f'account{i}_size', 64) for i in range(accounts)]
        self.D = [bv(f'state_data{i}', 8) for i in range(m['total'])]
        self.IXLEN = bv('instruction_length', 64)
        self.IXB = [bv(f'instruction{i}', 8) for i in range(m['ix'] + 1)]
        self.SETUP = bv('custody_result', 64)
        self.BUMP = bv('custody_bump', 8)
        self.CLOCK_RC = bv('clock_result', 64)
        self.SLOT = bv('clock_slot', 64)
        self.ROOT_TAG = bv('root_tag', 32)
        self.VAL = [bv(f'validate{i}_result', 64) for i in range(8)]
        self.EXE = [bv(f'execute{i}_result', 64) for i in range(8)]
        self.state_sort = z3.DeclareSort('StateValue')
        self.ix_sort = z3.DeclareSort('InstructionValue')
        self.decode_ok = {'state': z3.Function('state_decodes', z3.BitVecSort(8 * m['n']), z3.BoolSort()),
                          'ix': z3.Function('instruction_decodes', z3.BitVecSort(8 * m['ix']), z3.BoolSort())}
        self.decoded = {'state': z3.Function('decoded_state', z3.BitVecSort(8 * m['n']), self.state_sort),
                        'ix': z3.Function('decoded_instruction', z3.BitVecSort(8 * m['ix']), self.ix_sort)}
        self.cache, self.obligations, self.paths, self.checks = {}, [], [], 0

    def sym(self, name, sort):
        if name not in self.cache:
            self.cache[name] = z3.Const(name, sort)
        return self.cache[name]

    def word(self, name, bits=32):
        return self.cache[name] if name in self.cache else self.sym(name, z3.BitVecSort(bits))

    def flag(self, name):
        return self.cache[name] if name in self.cache else self.sym(name, z3.BoolSort())

    def outf(self, k, j):
        return self.word(f'root_c{k}_f{j}')

    def enc_ok(self, k, j):
        return self.flag(f'encode_c{k}_f{j}_ok')

    def enc(self, k, j):
        name = f'encoded_c{k}_f{j}'
        if name not in self.cache:
            self.cache[name] = [self.word(f'{name}_byte{i}', 8) for i in range(self.m['n'])]
        return self.cache[name]

    def ext_ok(self, k, j):
        return self.flag(f'extract_c{k}_f{j}_ok')

    def eff(self, src, i, field):
        return self.word(f'effect_c{src[0]}_f{src[1]}_slot{i}_{field}')

    def meta(self, src, i, j, field):
        return self.word(f'effect_c{src[0]}_f{src[1]}_slot{i}_meta{j}_{field}')

    def key_bytes(self, i):
        if i not in self.viewed:
            self.viewed[i] = z3.BitVec(f'account{i}_key_bytes', 256)
        return self.viewed[i]

    def axioms(self):
        seen = sorted(self.viewed)
        return [(self.KEY[i] == self.KEY[j]) == (self.viewed[i] == self.viewed[j])
                for a, i in enumerate(seen) for j in seen[a + 1:]]

    def solver(self):
        s = z3.Solver()
        s.set(timeout=120000)
        s.add(self.axioms())
        return s

    def check(self, solver, what):
        self.checks += 1
        result = solver.check()
        if result == z3.unknown:
            raise Fatal(f'{what}: solver returned unknown ({solver.reason_unknown()})')
        return result == z3.sat

    def feasible(self, formula):
        s = self.solver()
        s.add(formula)
        return self.check(s, 'path feasibility'), s

    def describe(self, model, extra=()):
        """A compact, readable excerpt of a counterexample model."""
        def value(e):
            v = model.eval(e, model_completion=True)
            return hex(v.as_long()) if z3.is_bv_value(v) else str(v)
        out = {'account_count': value(self.COUNT), 'instruction_length': value(self.IXLEN),
               'mode_byte': value(self.IXB[0]), 'state_size': value(self.SIZE[0]),
               'state_signer': value(self.SIGNER[0]), 'state_writable': value(self.WRITABLE[0]),
               'state_executable': value(self.EXECUTABLE[0]), 'owner_is_program': value(self.OWNER == self.PROGRAM),
               'actor_signer': value(self.SIGNER[1]), 'clock_result': value(self.CLOCK_RC),
               'clock_slot': value(self.SLOT), 'root_tag': value(self.ROOT_TAG),
               'root_reject_code': value(self.outf(self.m['rejected'], 0))}
        if self.m['effects']:
            out['custody_result'] = value(self.SETUP)
            out['validate_results'] = [value(self.VAL[i]) for i in range(self.m['slots'])]
            out['execute_results'] = [value(self.EXE[i]) for i in range(self.m['slots'])]
        for name, e in extra:
            out[name] = value(e)
        return out


# ---- Symbolic execution -------------------------------------------------------
class Exec:
    SYMBOLIC_LOOP_LIMIT = 16
    LOOP_LIMIT = 2048

    def __init__(self, world):
        self.w, self.m = world, world.m

    # bookkeeping ---------------------------------------------------------------
    def oblige(self, st, g, label, formula):
        self.w.obligations.append((label, z3.And(st.pc, g), formula))

    def fail(self, st, g, label):
        """Reject reachable undefined operations. Only an infeasible enclosing
        state is dead; an unevaluated unsupported operand is a grammar reject."""
        sat, s = self.w.feasible(z3.And(st.pc, g))
        if sat:
            raise Semantic(label, self.w.describe(s.model()))
        # An unevaluated operand is not a dead enclosing path. Until lazy
        # values are modeled, reject that syntax instead of losing coverage.
        if self.w.feasible(st.pc)[0]:
            raise Grammar(f'unsupported unevaluated operand: {label}')
        raise Dead()

    def merge(self, states):
        merged = {}
        for st in states:
            k = st.key()
            if k in merged:
                merged[k].pc = z3.simplify(z3.Or(merged[k].pc, st.pc))
            else:
                merged[k] = st
        return list(merged.values())

    def run(self, body):
        st = State(z3.BoolVal(True), [{'input': (Ptr(('input',), z3.BitVecVal(0, 64), z3.BoolVal(False)),
                                                  ('u8', True, True, None, False))}], [])
        left = self.block(body, [st])
        need(not left, 'syntax: control reaches the end of the entrypoint without a return')
        merged = {}
        for p in self.w.paths:
            k = (p.ret.get_id(), tuple(vkey(e) for e in p.events))
            if k in merged:
                merged[k].pc = z3.Or(merged[k].pc, p.pc)
            else:
                merged[k] = p
        raw, self.w.paths = len(self.w.paths), list(merged.values())
        return raw

    def block(self, stmts, states):
        for s in stmts:
            out = []
            for st in states:
                try:
                    out += self.stmt(s, st)
                except Dead:
                    pass
            states = self.merge(out)
        return states

    # statements ----------------------------------------------------------------
    def stmt(self, s, st):
        kind = s[0]
        if kind == 'block':
            st.scopes.append({})
            out = self.block(s[1], [st])
            for o in out:
                o.scopes.pop()
            return out
        if kind == 'decls':
            for item in s[1]:
                self.declare(item, st)
            return [st]
        if kind == 'decl':
            self.declare(s, st)
            return [st]
        if kind == 'assign':
            scope = st.find(s[1])
            need(scope is not None, f'syntax: assignment to undeclared {s[1]!r}')
            old, info = scope[s[1]]
            ctype, const, pointer, size, loop = info
            need(size is None and not loop and (pointer or not const), f'syntax: unsupported assignment target {s[1]!r}')
            scope[s[1]] = (self.fit(self.ev(s[2], st, top=True), info, s[1]), info)
            return [st]
        if kind == 'expr':
            self.ev(s[1], st, top=True)
            return [st]
        if kind == 'return':
            value = convert(self.ev(s[1], st), 'u64')
            self.w.paths.append(Path(st.pc, value.e, st.events))
            return []
        if kind == 'if':
            cond = truth(self.ev(s[1], st, top=True))
            if z3.is_true(cond):
                return self.stmt(s[2], st)
            if z3.is_false(cond):
                return self.stmt(s[3], st) if s[3] else [st]
            yes, no = st.fork(cond), st.fork(z3.Not(cond))
            out = self.guarded(s[2], yes)
            return out + (self.guarded(s[3], no) if s[3] else [no])
        if kind == 'for':
            return self.loop(s, st)
        raise Grammar(f'syntax: unsupported statement {kind}')

    def guarded(self, s, st):
        try:
            return self.stmt(s, st)
        except Dead:
            return []

    def loop(self, s, st):
        _, var, init, cond, body = s
        start = concrete(convert(self.ev(init, st), 'u32'))
        need(start is not None, 'loop: symbolic initial value')
        need(st.find(var) is None, f'syntax: redeclared {var!r}')
        st.scopes.append({var: (Int('u32', z3.BitVecVal(start, 32)), ('u32', False, False, None, True))})
        depth = len(st.scopes) - 1
        active, exits, symbolic, rounds = [st], [], False, 0
        while active:
            rounds += 1
            need(rounds <= self.LOOP_LIMIT, 'loop: iteration limit of the restricted model')
            entering = []
            for a in active:
                try:
                    c = truth(self.ev(cond, a))
                except Dead:
                    continue
                if z3.is_false(c):
                    exits.append(a)
                elif z3.is_true(c):
                    entering.append(a)
                else:
                    symbolic = True
                    exits.append(a.fork(z3.Not(c)))
                    b = a.fork(c)
                    if rounds > self.SYMBOLIC_LOOP_LIMIT:
                        sat, solver = self.w.feasible(b.pc)
                        if sat:
                            raise Semantic('loop-bound: symbolic loop exceeds the modeled bound',
                                           self.w.describe(solver.model()))
                        continue
                    entering.append(b)
            after = []
            for a in entering:
                after += self.guarded(body, a)
            for a in after:
                value, info = a.scopes[depth][var]
                a.scopes[depth][var] = (Int('u32', z3.simplify(value.e + 1)), info)
            active = self.merge(after)
        for e in exits:
            e.scopes.pop()
        exits = self.merge(exits)
        if symbolic and len(exits) > 1:
            exits = self.join([e for e in exits if self.w.feasible(e.pc)[0]])
        return exits

    def join(self, states):
        """Exits of one loop at different iterations have disjoint path
        conditions. States that differ only in the loader cursor and in which
        accounts were filled become one state with guarded values."""
        joined = {}
        for st in states:
            k = st.shape()
            if k not in joined:
                joined[k] = st
                continue
            base = joined[k]
            for scope, other in zip(base.scopes, st.scopes):
                for name, (value, info) in scope.items():
                    if vkey(value) != vkey(other[name][0]):
                        scope[name] = (value.join(st.pc, other[name][0]), info)
            base.pc = z3.simplify(z3.Or(base.pc, st.pc))
        return list(joined.values())

    def declare(self, s, st):
        _, ctype, const, pointer, name, size, init = s
        need(st.find(name) is None, f'syntax: redeclared {name!r}')
        info = (ctype, const, pointer, size, False)
        if size is not None:
            need(not pointer and size > 0, 'syntax: unsupported array declarator')
            if ctype == 'u8':
                if init is None:
                    value = Obj('bytes', tuple([None] * size))
                else:
                    need(init[0] == 'list' and len(init[1]) <= size and all(x < 256 for x in init[1]),
                         'syntax: unsupported byte array initializer')
                    value = Obj('bytes', tuple(z3.BitVecVal(x, 8) for x in init[1] + [0] * (size - len(init[1]))))
            elif ctype == 'Account':
                need(init is None, 'syntax: initialized account array')
                value = Obj('accounts', tuple([None] * size))
            elif ctype == self.m['slot_type']:
                need(init is None, 'syntax: initialized effect array')
                value = Obj('effects', size, None, None)
            else:
                raise Grammar(f'syntax: unsupported array of {ctype}')
        elif init is None:
            need(not pointer, 'syntax: uninitialized pointer')
            value = Uninit()
        else:
            need(init[0] == 'expr', 'syntax: brace initializer for a non-array')
            value = self.fit(self.ev(init[1], st, top=True), info, name)
        st.scopes[-1][name] = (value, info)

    def fit(self, value, info, name):
        ctype, const, pointer, size, _ = info
        if pointer:
            need(ctype == 'u8' and const and isinstance(value, Ptr), f'syntax: {name!r} is not a const byte pointer')
            return value
        if ctype in WIDTH or ctype == 'unsigned':
            return convert(value, 'u32' if ctype == 'unsigned' else ctype)
        need(isinstance(value, Obj) and value.ctype == ctype, f'syntax: {name!r} initialized from a different type')
        return value

    # expressions ---------------------------------------------------------------
    def ev(self, e, st, g=True, top=False):
        g = z3.BoolVal(True) if g is True else g
        kind = e[0]
        if kind == 'num':
            return Int(e[2], z3.BitVecVal(e[1], WIDTH[e[2]]))
        if kind == 'id':
            scope = st.find(e[1])
            need(scope is not None, f'expression: unknown identifier {e[1]!r}')
            value, info = scope[e[1]]
            if info[3] is not None:
                return Ref('var', e[1])
            if isinstance(value, Uninit):
                self.fail(st, g, f'uninitialized: read of {e[1]}')
            self.defined(value, st, g)
            return value
        if kind == 'cast':
            return convert(self.ev(e[2], st, g, top), e[1])
        if kind == 'not':
            return boolean(z3.Not(truth(self.ev(e[1], st, g, top))))
        if kind == 'addr':
            return self.address(e[1], st, g)
        if kind in ('land', 'lor'):
            a = truth(self.ev(e[1], st, g))
            b = truth(self.ev(e[2], st, z3.And(g, a if kind == 'land' else z3.Not(a))))
            return boolean(z3.And(a, b) if kind == 'land' else z3.Or(a, b))
        if kind == 'cond':
            c = truth(self.ev(e[1], st, g))
            a, b = self.ev(e[2], st, z3.And(g, c)), self.ev(e[3], st, z3.And(g, z3.Not(c)))
            t = self.common(a, b)
            return Int(t, z3.simplify(z3.If(c, convert(a, t).e, convert(b, t).e)))
        if kind == 'bin':
            a, b = self.ev(e[2], st, g), self.ev(e[3], st, g)
            if isinstance(a, Ptr):
                need(e[1] == '+', 'expression: unsupported pointer operator')
                return self.pointer_add(a, b, st, g)
            return self.binary(e[1], a, b, st, g)
        if kind == 'index':
            base, index = self.ev(e[1], st, g), concrete(self.ev(e[2], st, g))
            need(index is not None, 'expression: symbolic index')
            return self.index(base, index, st, g)
        if kind == 'member':
            return self.member(self.ev(e[1], st, g), e[2], st, g)
        if kind == 'call':
            handler = self.calls().get(e[1])
            need(handler is not None, f'expression: call to unreviewed function {e[1]!r}')
            pure, arity, function = handler
            need(len(e[2]) == arity, f'expression: {e[1]} called with {len(e[2])} arguments')
            need(pure or top, f'expression: effectful call {e[1]} in an unsupported position')
            return function(e[1], [self.ev(a, st, g) for a in e[2]], st, g)
        raise Grammar(f'expression: unsupported node {kind}')

    def common(self, a, b):
        need(isinstance(a, Int) and isinstance(b, Int), 'expression: integer operands expected')
        ta, tb = ('int' if a.t == 'u8' else a.t), ('int' if b.t == 'u8' else b.t)
        return 'u64' if 'u64' in (ta, tb) else 'u32' if 'u32' in (ta, tb) else 'int'

    def binary(self, op, a, b, st, g):
        if op in ('<<', '>>'):
            need(isinstance(a, Int) and isinstance(b, Int), 'expression: integer operands expected')
            t = 'int' if a.t == 'u8' else a.t
            amount = concrete(b)
            need(amount is not None, 'expression: symbolic shift amount')
            if amount >= WIDTH[t]:
                self.fail(st, g, f'undefined: shift of a {WIDTH[t]}-bit value by {amount}')
            x = convert(a, t).e
            if t == 'int':
                value = concrete(a)
                need(value is not None and value < 1 << 31 and (op == '>>' or value << amount < 1 << 31),
                     'expression: signed shift outside the restricted model')
            return Int(t, z3.simplify(x << amount if op == '<<' else z3.LShR(x, amount)))
        t = self.common(a, b)
        x, y = convert(a, t).e, convert(b, t).e
        if op == '+':
            if t == 'int':
                need(concrete(a) is not None and concrete(b) is not None and concrete(a) + concrete(b) < 1 << 31
                     and concrete(a) < 1 << 31 and concrete(b) < 1 << 31, 'expression: signed addition outside the restricted model')
            return Int(t, z3.simplify(x + y))
        if op == '|':
            return Int(t, z3.simplify(x | y))
        signed = t == 'int'
        compare = {'==': lambda: x == y, '!=': lambda: x != y,
                   '<': lambda: x < y if signed else z3.ULT(x, y), '>': lambda: x > y if signed else z3.UGT(x, y),
                   '<=': lambda: x <= y if signed else z3.ULE(x, y), '>=': lambda: x >= y if signed else z3.UGE(x, y)}
        need(op in compare, f'expression: unsupported operator {op!r}')
        return boolean(compare[op]())

    def pointer_add(self, p, n, st, g):
        if not z3.is_false(p.null):
            self.oblige(st, g, 'pointer: arithmetic on a possibly null pointer', z3.Not(p.null))
        offset = convert(n, 'u64')
        kind = p.region[0]
        if kind == 'input':
            # Loader ABI: the first account record starts after the 8-byte count.
            need(concrete(Int('u64', p.off)) == 0 and concrete(offset) == 8, 'pointer: unmodeled offset into the loader buffer')
            return Ptr(('cursor',), z3.BitVecVal(0, 64), z3.BoolVal(False), z3.BitVecVal(0, 64))
        if kind == 'cursor':
            # Loader ABI: instruction bytes follow the 8-byte instruction length.
            need(concrete(offset) == 8, 'pointer: unmodeled offset from the account cursor')
            need(concrete(Int('u64', p.off)) == 0, 'pointer: unmodeled offset from the account cursor')
            return Ptr(('ix',), z3.BitVecVal(0, 64), z3.BoolVal(False), p.at)
        need(kind in ('ix', 'key', 'owner', 'data'), 'pointer: arithmetic on an unmodeled region')
        return Ptr(p.region, z3.simplify(p.off + offset.e), z3.BoolVal(False), p.at)

    def array(self, st, name):
        scope = st.find(name)
        need(scope is not None and scope[name][1][3] is not None, f'expression: {name!r} is not a local array')
        return scope, scope[name][0], scope[name][1]

    def defined(self, value, st, g):
        valid = getattr(value, 'valid', None)
        if valid is not None:
            self.oblige(st, g, 'uninitialized: helper output read without success', valid)

    def index(self, base, i, st, g):
        if isinstance(base, Ref) and base.path[0] == 'var':
            _, arr, info = self.array(st, base.path[1])
            if i >= info[3]:
                self.fail(st, g, f'bounds: {base.path[1]}[{i}] outside {info[3]} elements')
            if arr.kind == 'bytes':
                self.defined(arr, st, g)
                if arr.f[0][i] is None:
                    self.fail(st, g, f'uninitialized: read of {base.path[1]}[{i}]')
                return Int('u8', arr.f[0][i])
            if arr.kind == 'accounts':
                if arr.f[0][i] is None or z3.is_false(arr.f[0][i]):
                    self.fail(st, g, f'uninitialized: read of {base.path[1]}[{i}]')
                self.oblige(st, g, 'account: read of an account the loader parser did not fill', arr.f[0][i])
                return Obj('account', i, ctype='Account')
            size, src, valid = arr.f
            if i >= self.m['extract_slots']:
                self.fail(st, g, f'uninitialized: extracted slot {i}')
            if src is None:
                self.fail(st, g, f'uninitialized: read of {base.path[1]}[{i}]')
            self.oblige(st, g, 'effects: slot read without successful extraction', valid)
            return Obj('effect', src, i)
        if isinstance(base, Obj) and base.kind == 'metas':
            if i >= 8:
                self.fail(st, g, f'bounds: metas[{i}] outside 8 elements')
            return Obj('meta', base.f[0], base.f[1], i)
        need(isinstance(base, Ptr), 'expression: indexing an unmodeled value')
        off = concrete(Int('u64', base.off))
        need(off is not None, 'expression: symbolic byte offset')
        return Int('u8', self.bytes(base, i, 1, st, g)[0])

    def bytes(self, src, start, n, st, g):
        """n bytes read through a pointer or from a local byte array."""
        w = self.w
        if isinstance(src, Ref) and src.path[0] == 'var':
            _, arr, info = self.array(st, src.path[1])
            need(arr.kind == 'bytes', 'expression: byte source is not a byte array')
            self.defined(arr, st, g)
            if start + n > info[3]:
                self.fail(st, g, f'bounds: {n} bytes read from {src.path[1]}[{info[3]}]')
            out = list(arr.f[0][start:start + n])
            if any(b is None for b in out):
                self.fail(st, g, f'uninitialized: read of {src.path[1]}')
            return out
        need(isinstance(src, Ptr), 'expression: byte source is not a pointer or byte array')
        if not z3.is_false(src.null):
            self.oblige(st, g, 'pointer: read through a possibly null pointer', z3.Not(src.null))
        off = concrete(Int('u64', src.off))
        need(off is not None, 'expression: symbolic byte offset')
        lo, hi = off + start, off + start + n
        if src.region == ('data', 0):
            self.oblige(st, g, 'bounds: state data read within the account size', z3.UGE(w.SIZE[0], hi))
            if hi > len(w.D):
                self.fail(st, g, f'bounds: state data byte {hi - 1} is beyond the {len(w.D)} modeled bytes')
            data = list(w.D)
            for event in st.events:
                if event.kind == 'write':
                    data[event.offset:event.offset + len(event.data)] = list(event.data)
            return data[lo:hi]
        if src.region[0] == 'ix':
            self.cursor(src.at, st, g)
            self.oblige(st, g, 'bounds: instruction read within the instruction length', z3.UGE(w.IXLEN, hi))
            if hi > len(w.IXB):
                self.fail(st, g, f'bounds: instruction byte {hi - 1} is beyond the {len(w.IXB)} modeled bytes')
            return w.IXB[lo:hi]
        raise Grammar('expression: byte read from an unmodeled region')

    def cursor(self, k, st, g):
        self.oblige(st, g, 'loader: instruction located after exactly `count` accounts', self.w.COUNT == k)

    def member(self, base, name, st, g):
        w = self.w
        need(isinstance(base, Obj), f'expression: member {name!r} of an unmodeled value')
        false = z3.BoolVal(False)
        if base.kind == 'account':
            i = base.f[0]
            if name in ('key', 'owner', 'data'):
                need(name != 'owner' or i == 0, 'expression: owner of a non-state account is not modeled')
                return Ptr((name, i), z3.BitVecVal(0, 64), false)  # `at` is unused for account regions
            if name == 'size':
                return Int('u64', w.SIZE[i])
            flags = {'signer': w.SIGNER, 'writable': w.WRITABLE, 'executable': w.EXECUTABLE}
            need(name in flags, f'expression: unmodeled account member {name!r}')
            # read_account stores `p[k] != 0`, so each flag is exactly 0 or 1.
            return Int('u32', z3.If(flags[name][i], z3.BitVecVal(1, 32), z3.BitVecVal(0, 32)), flags[name][i])
        if base.kind == 'clock':
            need(name == 'slot', f'expression: unmodeled Clock member {name!r}')
            return Int('u64', z3.If(base.f[0], w.SLOT, w.word('unspecified_clock_slot', 64)))
        if base.kind == 'outcome':
            if name == 'tag':
                return Int('u32', w.ROOT_TAG)
            need(name == 'as', f'expression: unmodeled outcome member {name!r}')
            return Obj('outcome.as')
        if base.kind == 'outcome.as':
            need(name[0] == 'c' and name[1:].isdigit() and int(name[1:]) in self.m['result'], 'expression: unknown outcome variant')
            return Obj('outcome.variant', int(name[1:]))
        if base.kind == 'outcome.variant':
            k = base.f[0]
            need(name[0] == 'f' and name[1:].isdigit() and int(name[1:]) < len(self.m['result'][k]),
                 'expression: unknown outcome field')
            j = int(name[1:])
            need(self.m['result'][k][j] == 'scalar', 'expression: non-scalar outcome field used as a value')
            self.oblige(st, g, 'union: outcome field read while another variant is active', w.ROOT_TAG == k)
            return Int('u32', w.outf(k, j))
        if base.kind == 'effect':
            src, i = base.f
            if name == 'metas':
                need(self.m['cpi'], 'expression: metas of a token effect')
                return Obj('metas', src, i)
            need(name in (('active', 'count') if self.m['cpi'] else ('active',)), f'expression: unmodeled effect member {name!r}')
            return Int('u32', w.eff(src, i, name))
        if base.kind == 'meta':
            need(name in ('index', 'writable'), f'expression: unmodeled meta member {name!r}')
            return Int('u32', w.meta(base.f[0], base.f[1], base.f[2], name))
        raise Grammar(f'expression: member {name!r} of {base.kind}')

    def address(self, e, st, g):
        if e[0] == 'id':
            need(st.find(e[1]) is not None, f'expression: address of unknown {e[1]!r}')
            return Ref('var', e[1])
        if e[0] == 'index' and e[1][0] == 'id':
            i = concrete(self.ev(e[2], st, g))
            need(i is not None, 'expression: symbolic index')
            self.array(st, e[1][1])
            return Ref('elem', e[1][1], i)
        if (e[0] == 'member' and e[1][0] == 'member' and e[1][1][0] == 'member' and e[1][1][2] == 'as'
                and e[1][1][1][0] == 'id'):
            variant = self.member(self.member(self.ev(e[1][1][1], st, g), 'as', st, g), e[1][2], st, g)
            k, name = variant.f[0], e[2]
            need(name[0] == 'f' and name[1:].isdigit() and int(name[1:]) < len(self.m['result'][k]),
                 'expression: unknown outcome field')
            self.oblige(st, g, 'union: outcome field read while another variant is active', self.w.ROOT_TAG == k)
            return Ref('outf', k, int(name[1:]))
        raise Grammar('expression: unsupported address-of operand')

    # reviewed call summaries -----------------------------------------------------
    def calls(self):
        m = self.m
        table = {
            'read_le': (True, 2, self.call_read_le),
            'equal_key': (True, 2, self.call_equal_key),
            m['key_maker']: (True, 8, self.call_key),
            m['slot_maker']: (True, 2, self.call_slot),
            m['context_maker']: (True, 3, self.call_context),
            'read_account': (False, 2, self.call_read_account),
            m['state_decode']: (False, 3, self.call_decode),
            m['ix_decode']: (False, 3, self.call_decode),
            'sol_get_clock_sysvar': (False, 1, self.call_clock),
            m['root']: (False, 3, self.call_root),
            m['state_encode']: (False, 3, self.call_encode),
            '__builtin_memcpy': (False, 3, self.call_memcpy),
            'sol_set_return_data': (False, 2, self.call_return_data),
        }
        if m['effects']:
            table.update({m['custody']: (False, 3, self.call_custody),
                          'bend_extract_effects': (False, 2, self.call_extract),
                          m['validate']: (False, 3, self.call_validate),
                          m['execute']: (False, 4, self.call_execute)})
        return table

    def call_read_le(self, name, args, st, g):
        """runtime/solana_min.h read_le (exact text audited): little-endian load."""
        p, n = args[0], concrete(args[1])
        need(isinstance(p, Ptr) and n is not None and 1 <= n <= 8, 'read_le: unsupported arguments')
        if not z3.is_false(p.null):
            self.oblige(st, g, 'pointer: read through a possibly null pointer', z3.Not(p.null))
        off = concrete(Int('u64', p.off))
        need(off is not None, 'read_le: symbolic offset')
        w = self.w
        if p.region == ('input',):
            need(off == 0 and n == 8, 'read_le: unmodeled loader field')
            return Int('u64', w.COUNT)
        if p.region[0] == 'cursor':
            need(off == 0 and n == 8, 'read_le: unmodeled loader field')
            self.cursor(p.at, st, g)
            return Int('u64', w.IXLEN)
        need(p.region[0] == 'key', 'read_le: unmodeled region')
        if off + n > 32:
            self.fail(st, g, f'bounds: read_le of key bytes {off}..{off + n - 1}')
        value = z3.Extract(8 * (off + n) - 1, 8 * off, w.key_bytes(p.region[1]))
        return Int('u64', z3.simplify(z3.ZeroExt(64 - 8 * n, value) if n < 8 else value))

    def key_value(self, p, st, g):
        need(isinstance(p, Ptr), 'equal_key: argument is not a pointer')
        if not z3.is_false(p.null):
            self.oblige(st, g, 'pointer: read through a possibly null pointer', z3.Not(p.null))
        w = self.w
        if p.region[0] == 'ix':
            # Loader ABI: the program id follows the instruction bytes.
            self.cursor(p.at, st, g)
            self.oblige(st, g, 'loader: program id read at the end of the instruction', p.off == w.IXLEN)
            return w.PROGRAM
        need(concrete(Int('u64', p.off)) == 0, 'equal_key: offset into a key')
        if p.region[0] == 'key':
            return w.KEY[p.region[1]]
        need(p.region == ('owner', 0), 'equal_key: unmodeled region')
        return w.OWNER

    def call_equal_key(self, name, args, st, g):
        """equal_key is 32-byte equality (verify:account-key); result is 0 or 1."""
        eq = z3.simplify(self.key_value(args[0], st, g) == self.key_value(args[1], st, g))
        return Int('u32', z3.If(eq, z3.BitVecVal(1, 32), z3.BitVecVal(0, 32)), eq)

    def call_key(self, name, args, st, g):
        return Obj('key', tuple(convert(a, 'u32').e for a in args), ctype=self.m['key_type'])

    def call_slot(self, name, args, st, g):
        return Obj('u64', tuple(convert(a, 'u32').e for a in args), ctype=self.m['slot_value_type'])

    def call_context(self, name, args, st, g):
        key, signed, slot = args
        need(isinstance(key, Obj) and key.kind == 'key' and isinstance(slot, Obj) and slot.kind == 'u64',
             'context: unexpected constructor arguments')
        return Obj('context', key.f[0] + (convert(signed, 'u32').e,) + slot.f[0], ctype=self.m['context_type'])

    def call_read_account(self, name, args, st, g):
        """read_account (exact text audited): null iff the loader marks account
        i as a duplicate; otherwise fills accounts[i] and returns the cursor of
        the next record. Loader-provided lengths are trusted."""
        p, target = args
        need(isinstance(p, Ptr) and p.region[0] == 'cursor' and isinstance(target, Ref) and target.path[0] == 'elem',
             'read_account: unsupported arguments')
        if not z3.is_false(p.null):
            self.oblige(st, g, 'pointer: read through a possibly null pointer', z3.Not(p.null))
        k, (_, array, i) = concrete(Int('u64', p.at)), target.path
        need(k is not None and concrete(Int('u64', p.off)) == 0, 'read_account: symbolic loader cursor')
        scope, arr, info = self.array(st, array)
        need(arr.kind == 'accounts', 'read_account: target is not the account array')
        if i >= info[3]:
            self.fail(st, g, f'bounds: {array}[{i}] outside {info[3]} elements')
        if i != k or i >= len(self.w.PARSE_OK):
            self.fail(st, g, f'loader: account record {k} parsed into {array}[{i}]')
        filled = list(arr.f[0])
        filled[i] = self.w.PARSE_OK[i]
        scope[array] = (Obj('accounts', tuple(filled)), info)
        return Ptr(('cursor',), z3.BitVecVal(0, 64), z3.Not(self.w.PARSE_OK[i]), z3.BitVecVal(k + 1, 64))

    def accounts_arg(self, value, st, g, n):
        """`accounts` passed to a helper that reads the first n parsed accounts."""
        need(isinstance(value, Ref) and value.path[0] == 'var', 'helper: accounts argument')
        _, arr, info = self.array(st, value.path[1])
        need(arr.kind == 'accounts', 'helper: accounts argument')
        for i, filled in enumerate(arr.f[0]):
            inside = z3.BoolVal(True) if isinstance(n, int) and i < n else z3.BoolVal(False) if isinstance(n, int) \
                else z3.ULT(z3.BitVecVal(i, 32), n)
            self.oblige(st, g, 'helper: receives an account the loader parser did not fill',
                        z3.Implies(inside, filled if filled is not None else z3.BoolVal(False)))
        if not isinstance(n, int):
            self.oblige(st, g, 'helper: account count exceeds the account array', z3.ULE(n, info[3]))

    def call_custody(self, name, args, st, g):
        """Custody setup helper: result and bump are unconstrained."""
        accounts, program, bump = args
        self.accounts_arg(accounts, st, g, 4)
        need(isinstance(program, Ptr) and program.region[0] == 'ix', 'custody: program argument')
        self.cursor(program.at, st, g)
        self.oblige(st, g, 'loader: program id read at the end of the instruction', program.off == self.w.IXLEN)
        need(isinstance(bump, Ref) and bump.path[0] == 'var', 'custody: bump argument')
        scope = st.find(bump.path[1])
        info = scope[bump.path[1]][1]
        need(info[:4] == ('u8', False, False, None), 'custody: bump is not a u8 local')
        w = self.w
        scope[bump.path[1]] = (Int('u8', z3.If(w.SETUP == 0, w.BUMP, w.word('unspecified_bump', 8)), valid=w.SETUP == 0), info)
        st.events.append(Event('custody', fn=name))
        return Int('u64', w.SETUP)

    def call_decode(self, name, args, st, g):
        """Generated canonical decoder (verify:codec-structures): an
        uninterpreted predicate and value of exactly the bytes passed."""
        which = 'state' if name == self.m['state_decode'] else 'ix'
        size = self.m['n'] if which == 'state' else self.m['ix']
        src, n, target = args[0], concrete(args[1]), args[2]
        need(n is not None, 'decode: symbolic length')
        need(isinstance(target, Ref) and target.path[0] == 'var', 'decode: output argument')
        scope = st.find(target.path[1])
        info = scope[target.path[1]][1]
        need(info[0] == self.m[which + '_type'] and not info[1] and not info[2] and info[3] is None,
             'decode: output has a different type')
        w = self.w
        data = self.bytes(src, 0, n, st, g)
        junk = w.sym(f'unspecified_{which}_value', w.decoded[which].range())
        if n == size:
            ok = z3.simplify(w.decode_ok[which](pack(data)))
            value = z3.If(ok, w.decoded[which](pack(data)), junk)
        else:
            ok, value = z3.BoolVal(False), junk  # the generated decoder rejects any other length
        scope[target.path[1]] = (Obj('decoded', which, value, ctype=info[0], valid=ok), info)
        st.events.append(Event('decode', which=which, data=tuple(data)))
        return Int('int', None, ok)

    def call_clock(self, name, args, st, g):
        """Clock sysvar syscall: result and slot are unconstrained."""
        target = args[0]
        need(isinstance(target, Ref) and target.path[0] == 'var', 'clock: output argument')
        scope = st.find(target.path[1])
        info = scope[target.path[1]][1]
        need(info[:4] == ('BendClock', False, False, None), 'clock: output is not a BendClock local')
        scope[target.path[1]] = (Obj('clock', z3.simplify(self.w.CLOCK_RC == 0), ctype='BendClock', valid=self.w.CLOCK_RC == 0), info)
        st.events.append(Event('clock'))
        return Int('u64', self.w.CLOCK_RC)

    def call_root(self, name, args, st, g):
        """The checked Bend root: an arbitrary result, recorded with its arguments."""
        context, before, instruction = args
        need(isinstance(context, Obj) and context.kind == 'context', 'root: context argument')
        need(isinstance(before, Obj) and before.kind == 'decoded' and before.f[0] == 'state', 'root: state argument')
        need(isinstance(instruction, Obj) and instruction.kind == 'decoded' and instruction.f[0] == 'ix',
             'root: instruction argument')
        st.events.append(Event('root', context=context.f[0], before=before.f[1], instruction=instruction.f[1]))
        return Obj('outcome', ctype=self.m['result_type'])

    def local_bytes(self, value, st, what):
        need(isinstance(value, Ref) and value.path[0] == 'var', f'{what}: byte array argument')
        scope, arr, info = self.array(st, value.path[1])
        need(arr.kind == 'bytes', f'{what}: byte array argument')
        return scope, arr, info, value.path[1]

    def call_encode(self, name, args, st, g):
        """Generated canonical encoder: success flag and bytes are unconstrained
        per encoded field; on failure the buffer is unspecified."""
        scope, arr, info, array = self.local_bytes(args[0], st, 'encode')
        n, src = concrete(args[1]), args[2]
        need(n is not None and not info[1], 'encode: unsupported arguments')
        need(isinstance(src, Ref) and src.path[0] == 'outf' and self.m['result'][src.path[1]][src.path[2]] == 'state',
             'encode: source is not a state field of the root result')
        k, j = src.path[1:]
        st.events.append(Event('encode', src=(k, j)))
        # Generated codecs reject a wrong length before touching the buffer.
        if n != self.m['n']:
            return Int('int', None, z3.BoolVal(False))
        if n > info[3]:
            self.fail(st, g, f'bounds: {n} bytes encoded into {array}[{info[3]}]')
        # A whole-array validity flag cannot model partial reinitialization.
        need(arr.valid is None, 'encode: repeated buffer writes are outside the model')
        w = self.w
        ok = w.enc_ok(k, j)
        out, encoded = list(arr.f[0]), w.enc(k, j)
        for i in range(n):
            out[i] = z3.If(ok, encoded[i], w.word(f'unspecified_encoded{i}', 8))
        scope[array] = (Obj('bytes', tuple(out), valid=ok), info)
        return Int('int', None, ok)

    def call_extract(self, name, args, st, g):
        """Emitted bend_extract_effects: writes every slot of `out`; only its
        success flag and the slot fields read by the adapter are modeled."""
        src, target = args
        need(isinstance(src, Ref) and src.path[0] == 'outf' and self.m['result'][src.path[1]][src.path[2]] == 'effects',
             'extract: source is not the effects field of the root result')
        need(isinstance(target, Ref) and target.path[0] == 'var', 'extract: output argument')
        scope, arr, info = self.array(st, target.path[1])
        need(arr.kind == 'effects', 'extract: output argument')
        if self.m['extract_slots'] > info[3]:
            self.fail(st, g, f'bounds: {self.m["extract_slots"]} effect slots written into {target.path[1]}[{info[3]}]')
        k, j = src.path[1:]
        scope[target.path[1]] = (Obj('effects', info[3], (k, j), self.w.ext_ok(k, j)), info)
        st.events.append(Event('extract', src=(k, j)))
        return Int('int', None, self.w.ext_ok(k, j))

    def effect_slot(self, value, st, g):
        need(isinstance(value, Ref) and value.path[0] == 'elem', 'effect helper: slot argument')
        _, arr, info = self.array(st, value.path[1])
        need(arr.kind == 'effects', 'effect helper: slot argument')
        i = value.path[2]
        if i >= info[3] or i >= 8:
            self.fail(st, g, f'bounds: {value.path[1]}[{i}] outside {info[3]} elements')
        if i >= self.m['extract_slots']:
            self.fail(st, g, f'uninitialized: extracted slot {i}')
        if arr.f[1] is None:
            self.fail(st, g, f'uninitialized: read of {value.path[1]}[{i}]')
        self.oblige(st, g, 'effects: slot read without successful extraction', arr.f[2])
        return arr.f[1], i

    def call_validate(self, name, args, st, g):
        """Effect validation helper: an unconstrained 64-bit result per slot."""
        src, i = self.effect_slot(args[0], st, g)
        n = convert(args[2], 'u32').e
        self.accounts_arg(args[1], st, g, n)
        st.events.append(Event('validate', fn=name, slot=i, src=src, count=n))
        return Int('u64', self.w.VAL[i])

    def call_execute(self, name, args, st, g):
        """Effect execution helper (CPI): an unconstrained 64-bit result per slot."""
        src, i = self.effect_slot(args[0], st, g)
        n = convert(args[2], 'u32').e
        self.accounts_arg(args[1], st, g, n)
        st.events.append(Event('execute', fn=name, slot=i, src=src, count=n, bump=convert(args[3], 'u8').e))
        return Int('u64', self.w.EXE[i])

    def state_target(self, p, n, st, g, what):
        need(isinstance(p, Ptr) and p.region == ('data', 0), f'{what}: destination is not the state account data')
        off = concrete(Int('u64', p.off))
        need(off is not None, f'{what}: symbolic destination offset')
        self.oblige(st, g, 'bounds: state data write within the account size', z3.UGE(self.w.SIZE[0], off + n))
        return off

    def call_memcpy(self, name, args, st, g):
        """__builtin_memcpy from a local byte array into the state account data."""
        n = concrete(args[2])
        need(n is not None and n > 0, 'memcpy: unsupported length')
        off = self.state_target(args[0], n, st, g, 'memcpy')
        need(isinstance(args[1], Ref), 'memcpy: source is not a local byte array')
        data = self.bytes(args[1], 0, n, st, g)
        st.events.append(Event('write', offset=off, data=tuple(data)))
        return Obj('void')

    def call_return_data(self, name, args, st, g):
        """sol_set_return_data syscall with bytes of a local byte array."""
        n = concrete(args[1])
        need(n is not None and isinstance(args[0], Ref), 'return data: unsupported arguments')
        st.events.append(Event('return_data', data=tuple(self.bytes(args[0], 0, n, st, g))))
        return Obj('void')
