"""Source-bound symbolic assurance for ABI-3 collection select and plan.

This module parses the actual helper bodies with the existing restricted-C
lexer/parser, then symbolically executes their statements and expressions over
Z3 bit-vectors using C integer conversions and lazy short-circuit evaluation.
Select and plan are compared to the shared versioned contract AST using
bitvector semantics; their actual checked C bodies remain separately parsed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import sys
import tempfile
from dataclasses import dataclass

import z3

# The module directory contains queue.py, so keep it last to avoid shadowing
# Python's standard queue module if an embedding environment imports this file.
_HERE = pathlib.Path(__file__).resolve().parent
sys.path[:] = [p for p in sys.path if pathlib.Path(p or os.getcwd()).resolve() != _HERE] + [str(_HERE)]
from adapter_contract_c import Grammar, Parser, audited_header_tokens, header_directives, literal, need, strict_tokens  # noqa: E402
import collection_contracts as collection_contracts  # noqa: E402


class AssuranceError(Exception):
    """A failed obligation, unsupported source form, or incomplete solver result."""


class Counterexample(AssuranceError):
    """A satisfiable refinement-failure query found a real semantic mismatch."""


class UndefinedBehavior(AssuranceError):
    """A supported source path can execute C undefined behavior."""


class UndefinedRead(UndefinedBehavior):
    """A supported statement attempts to read an uninitialized C object."""


class ReceiptArchiveError(AssuranceError):
    """A previous receipt was preserved but could not be safely archived."""


WIDTH = {"u8": 8, "int": 32, "u32": 32, "unsigned": 32, "u64": 64}
CTYPE_CANON = {"unsigned": "u32"}
MAX_U32 = (1 << 32) - 1
UNINIT = object()


def canonical_type(t: str) -> str:
    return CTYPE_CANON.get(t, t)


def sha256(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check(status, expected, label, solver=None):
    """Fail closed for SAT, UNKNOWN, and every status other than expected."""
    if status == expected:
        return
    if status == z3.unknown:
        reason = solver.reason_unknown() if solver is not None else "injected unknown status"
        raise AssuranceError(f"UNKNOWN is not a proof ({label}): {reason}")
    model = ""
    if status == z3.sat and solver is not None:
        model = f"; model={solver.model()}"
    error = Counterexample if status == z3.sat and expected == z3.unsat else AssuranceError
    raise error(f"solver returned {status}, expected {expected} ({label}){model}")


def solver_for(formula, timeout_ms=20000):
    solver = z3.SolverFor('QF_BV')
    solver.set(timeout=timeout_ms)
    solver.add(z3.simplify(formula))
    return solver


def prove_unsat(label, formula):
    solver = solver_for(formula)
    status = solver.check()
    check(status, z3.unsat, label, solver)
    return {"label": label, "result": "UNSAT"}


def witness(label, formula, fields):
    solver = solver_for(formula)
    status = solver.check()
    check(status, z3.sat, label, solver)
    model = solver.model()
    return {
        "label": label,
        "result": "SAT",
        "values": {name: value(model.eval(term, model_completion=True)) for name, term in fields.items()},
    }


def value(term):
    if z3.is_bv_value(term):
        return term.as_long()
    if z3.is_true(term):
        return True
    if z3.is_false(term):
        return False
    return str(term)


class RuntimeParser(Parser):
    """Small local extension of the reusable generic parser.

    It adds additive subtraction, C `->`, and the single aggregate assignment
    form present in select. Everything else still goes through Parser and any
    unsupported token or statement is rejected.
    """

    LEVELS = [('||',), ('&&',), ('|',), ('==', '!='), ('<', '>', '<=', '>='), ('<<', '>>'), ('+', '-')]

    def postfix(self):
        token = self.peek()
        if token == '(':
            self.take('(')
            node = self.expr()
            self.take(')')
        elif re.fullmatch(r'(?:0[xX][0-9a-fA-F]+|[0-9]+)[uUlL]*', token):
            self.at += 1
            node = literal(token)
        else:
            node = ('id', self.ident())
        while True:
            token = self.peek()
            if token == '[':
                self.take('[')
                node = ('index', node, self.expr())
                self.take(']')
            elif token in ('.', '->'):
                self.at += 1
                node = ('member' if token == '.' else 'arrow', node, self.ident())
            elif token == '(':
                need(node[0] == 'id', 'expression: call through a non-identifier')
                self.take('(')
                args = []
                if self.peek() != ')':
                    args.append(self.expr())
                    while self.peek() == ',':
                        self.take(',')
                        args.append(self.expr())
                self.take(')')
                node = ('call', node[1], args)
            else:
                return node

    def statement(self):
        if self.peek() != '*':
            return super().statement()
        self.take('*')
        pointer = self.ident()
        self.take('=', '(')
        ctype = self.ident()
        self.take(')', '{')
        values = [self.expr()]
        while self.peek() == ',':
            self.take(',')
            values.append(self.expr())
        self.take('}', ';')
        return ('aggregate_store', pointer, ctype, values)


def extract_functions(root: pathlib.Path):
    header = root / 'runtime/bend_collection_runtime.h'
    text = header.read_text()
    # Existing include and macro checkers reject conditionals and alternate
    # preprocessing spellings. Strict tokenization separately rejects line
    # splices, trigraphs, escapes, non-ASCII text, and unknown lexer input.
    strict_tokens(text)
    macros, includes = header_directives(header.name, text)
    need(macros == ['BEND_COLLECTION_HEADER'], f'unsupported helper macros: {macros}')
    need(includes == ['solana_min.h'], f'unsupported helper includes: {includes}')
    audited = audited_header_tokens(header.name, text)
    all_tokens = strict_tokens(text)

    def expected_tokens(s):
        return strict_tokens(s)

    def require_unique_file_scope(tokens, sequence, label):
        hits = []
        depth = 0
        for i, token in enumerate(tokens):
            if depth == 0 and tokens[i:i + len(sequence)] == sequence:
                hits.append(i)
            if token == '{':
                depth += 1
            elif token == '}':
                depth -= 1
                need(depth >= 0, f'{label}: unmatched closing brace')
        need(depth == 0, f'{label}: unmatched opening brace')
        need(len(hits) == 1, f'{label}: expected one file-scope declaration, found {len(hits)}')
        return hits[0]

    # Bind modeled field types independently of how expressions are evaluated.
    declarations = [
        ('typedef struct { Account *account; u32 length, capacity, stride; } BendCollection;',
         'BendCollection layout'),
        ('typedef struct { u32 start, reserved, loaded; } BendCollectionWindow;',
         'BendCollectionWindow layout'),
    ]
    for source, label in declarations:
        seq = expected_tokens(source)
        require_unique_file_scope(all_tokens, seq, label)
        need(sum(audited[i:i + len(seq)] == seq for i in audited.declarations.get(seq[0], [])) == 1,
             f'{label}: restricted-header scope binding differs')

    primitive_header = root / 'runtime/solana_min.h'
    primitive_text = primitive_header.read_text()
    strict_tokens(primitive_text)
    primitive_macros, primitive_includes = header_directives(primitive_header.name, primitive_text)
    need(not primitive_macros and not primitive_includes,
         'runtime/solana_min.h: unexpected macro or include dependency')
    primitive_tokens = strict_tokens(primitive_text)
    for declaration, label in [
        ('typedef unsigned char u8;', 'u8 primitive type'),
        ('typedef unsigned int u32;', 'u32 primitive type'),
        ('typedef unsigned long long u64;', 'u64 primitive type'),
        ('_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
         'primitive width assertion'),
    ]:
        require_unique_file_scope(primitive_tokens, expected_tokens(declaration), label)

    signatures = {
        'select': 'static inline unsigned bend_collection_select(const BendCollection *c, u32 start, u32 count, u32 maximum, BendCollectionWindow *out) {',
        'plan': 'static inline unsigned bend_collection_plan(const BendCollection *c, const BendCollectionWindow *w, u32 written, u32 next_length) {',
    }
    result = {}
    for name, signature in signatures.items():
        sig = expected_tokens(signature)
        pos = require_unique_file_scope(all_tokens, sig, f'bend_collection_{name} signature')
        open_at = pos + len(sig) - 1
        need(all_tokens[open_at] == '{', f'bend_collection_{name}: definition expected')
        depth, end = 1, open_at + 1
        while end < len(all_tokens) and depth:
            depth += (all_tokens[end] == '{') - (all_tokens[end] == '}')
            end += 1
        need(depth == 0, f'bend_collection_{name}: unmatched body')
        body = all_tokens[open_at + 1:end - 1]
        parser = RuntimeParser(body, {'u8', 'u32', 'u64', 'unsigned', 'BendCollectionWindow'})
        statements = []
        while parser.peek():
            statements.append(parser.statement())
        need(parser.at == len(body), f'bend_collection_{name}: parser did not consume body')
        result[name] = statements
    return result


@dataclass(frozen=True)
class CInt:
    ctype: str
    bits: z3.BitVecRef


@dataclass(frozen=True)
class Pointer:
    target: str


@dataclass(frozen=True)
class ObjectRef:
    target: str


@dataclass
class CStruct:
    ctype: str
    fields: dict

    def clone(self):
        return CStruct(self.ctype, dict(self.fields))


@dataclass
class State:
    pc: z3.BoolRef
    variables: dict
    heap: dict
    arithmetic: list
    returned: CInt | None = None

    def clone(self):
        return State(z3.simplify(self.pc), dict(self.variables),
                     {k: v.clone() for k, v in self.heap.items()},
                     list(self.arithmetic), self.returned)


def cval(ctype, expr):
    ctype = canonical_type(ctype)
    width = WIDTH[ctype]
    if z3.is_bv(expr) and expr.size() == width:
        return CInt(ctype, z3.simplify(expr))
    if z3.is_bv(expr):
        old = expr.size()
        if width < old:
            expr = z3.Extract(width - 1, 0, expr)
        elif width > old:
            expr = z3.SignExt(width - old, expr) if ctype == 'int' else z3.ZeroExt(width - old, expr)
        return CInt(ctype, z3.simplify(expr))
    return CInt(ctype, z3.BitVecVal(int(expr), width))


def convert(v, target):
    need(isinstance(v, CInt), 'C conversion: integer required')
    target = canonical_type(target)
    src_width, dst_width = WIDTH[v.ctype], WIDTH[target]
    expr = v.bits
    if dst_width < src_width:
        expr = z3.Extract(dst_width - 1, 0, expr)
    elif dst_width > src_width:
        expr = z3.SignExt(dst_width - src_width, expr) if v.ctype == 'int' else z3.ZeroExt(dst_width - src_width, expr)
    return CInt(target, z3.simplify(expr))


def truth(v):
    need(isinstance(v, CInt), 'C condition: scalar required')
    return v.bits != 0


def usual_type(left, right):
    """Apply integer promotions, then the supported usual arithmetic conversions.

    u8 promotes to int because every u8 value is representable there. For the
    remaining modeled types, unsigned types have the same width/rank as their
    signed counterpart except u64, which outranks int.
    """
    left, right = integer_promotion(left), integer_promotion(right)
    if left == right:
        return left
    left_unsigned, right_unsigned = left.startswith('u'), right.startswith('u')
    if left_unsigned == right_unsigned:
        return left if WIDTH[left] >= WIDTH[right] else right
    unsigned = left if left_unsigned else right
    signed = right if left_unsigned else left
    if WIDTH[unsigned] >= WIDTH[signed]:
        return unsigned
    # A wider signed int can represent every value of a narrower unsigned type.
    return signed


def integer_promotion(ctype):
    ctype = canonical_type(ctype)
    return 'int' if WIDTH[ctype] < WIDTH['int'] else ctype


def signed_arithmetic_safe(op, left, right):
    """Return the C signed-overflow condition for an int bit-vector operation."""
    need(left.size() == right.size(), 'signed arithmetic: operand width mismatch')
    result = left + right if op == 'add' else left - right
    left_sign, right_sign = z3.Extract(left.size() - 1, left.size() - 1, left), z3.Extract(right.size() - 1, right.size() - 1, right)
    result_sign = z3.Extract(result.size() - 1, result.size() - 1, result)
    if op == 'add':
        return z3.Or(left_sign != right_sign, result_sign == left_sign)
    if op == 'sub':
        return z3.Or(left_sign == right_sign, result_sign == left_sign)
    raise Grammar(f'signed arithmetic: unsupported operation {op!r}')


def bool_int(term):
    return CInt('int', z3.If(term, z3.BitVecVal(1, 32), z3.BitVecVal(0, 32)))


def u32_sum_ext(left, right):
    """Add u32 values in 33 bits to state mathematical range facts without wrap."""
    need(left.size() == right.size() == 32, 'u32 extended addition: operands must be u32')
    return z3.ZeroExt(1, left) + z3.ZeroExt(1, right)


def u32_sum_fits(left, right):
    return z3.ULE(u32_sum_ext(left, right), z3.BitVecVal(MAX_U32, 33))


class SymbolicC:
    """Path interpreter for the reviewed scalar/struct subset only."""

    def __init__(self, functions):
        self.functions = functions
        self.next_object = 0

    def fresh_object(self, stem):
        self.next_object += 1
        return f'{stem}${self.next_object}'

    @staticmethod
    def read(value, label):
        if value is UNINIT:
            raise UndefinedRead(f'undefined behavior: read of uninitialized {label}')
        return value

    def eval(self, expr, st):
        kind = expr[0]
        if kind == 'num':
            _, n, t = expr
            return [(st, cval(t, n))]
        if kind == 'id':
            need(expr[1] in st.variables, f'expression: unknown identifier {expr[1]!r}')
            return [(st, self.read(st.variables[expr[1]], expr[1]))]
        if kind == 'addr':
            child = expr[1]
            need(child[0] == 'id' and child[1] in st.variables, 'address: unsupported lvalue')
            obj = st.variables[child[1]]
            need(isinstance(obj, ObjectRef), 'address: expected a local struct object')
            return [(st, Pointer(obj.target))]
        if kind == 'not':
            return [(s, bool_int(z3.Not(truth(v)))) for s, v in self.eval(expr[1], st)]
        if kind == 'member':
            out = []
            for s, base in self.eval(expr[1], st):
                need(isinstance(base, ObjectRef), 'member: expected struct object')
                need(base.target in s.heap and expr[2] in s.heap[base.target].fields,
                     f'member: unsupported field {expr[2]!r}')
                out.append((s, self.read(s.heap[base.target].fields[expr[2]], expr[2])))
            return out
        if kind == 'arrow':
            out = []
            for s, base in self.eval(expr[1], st):
                need(isinstance(base, Pointer), 'arrow: expected pointer')
                need(base.target in s.heap and expr[2] in s.heap[base.target].fields,
                     f'arrow: unsupported field {expr[2]!r}')
                out.append((s, self.read(s.heap[base.target].fields[expr[2]], expr[2])))
            return out
        if kind in ('land', 'lor'):
            out = []
            for s, left in self.eval(expr[1], st):
                cond = truth(left)
                if kind == 'land':
                    short = s.clone()
                    short.pc = z3.And(short.pc, z3.Not(cond))
                    if self.feasible(short.pc):
                        out.append((short, bool_int(z3.BoolVal(False))))
                    right_state = s.clone()
                    right_state.pc = z3.And(right_state.pc, cond)
                    if self.feasible(right_state.pc):
                        out.extend((rs, bool_int(truth(rv))) for rs, rv in self.eval(expr[2], right_state))
                else:
                    short = s.clone()
                    short.pc = z3.And(short.pc, cond)
                    if self.feasible(short.pc):
                        out.append((short, bool_int(z3.BoolVal(True))))
                    right_state = s.clone()
                    right_state.pc = z3.And(right_state.pc, z3.Not(cond))
                    if self.feasible(right_state.pc):
                        out.extend((rs, bool_int(truth(rv))) for rs, rv in self.eval(expr[2], right_state))
            return out
        if kind == 'cond':
            out = []
            for s, condition in self.eval(expr[1], st):
                cond = truth(condition)
                yes, no = s.clone(), s.clone()
                yes.pc, no.pc = z3.And(yes.pc, cond), z3.And(no.pc, z3.Not(cond))
                yes_values = self.eval(expr[2], yes) if self.feasible(yes.pc) else []
                no_values = self.eval(expr[3], no) if self.feasible(no.pc) else []
                values = yes_values + no_values
                need(values, 'conditional expression: no feasible branch')
                need(all(isinstance(v, CInt) for _, v in values),
                     'conditional expression: integer branches required')
                common = values[0][1].ctype
                for _, branch_value in values[1:]:
                    common = usual_type(common, branch_value.ctype)
                out.extend((branch_state, convert(branch_value, common))
                           for branch_state, branch_value in values)
            return out
        if kind == 'bin':
            out = []
            for left_state, left in self.eval(expr[2], st):
                for right_state, right in self.eval(expr[3], left_state):
                    out.append((right_state, self.binary(expr[1], left, right, right_state)))
            return out
        if kind == 'call':
            name, arg_exprs = expr[1], expr[2]
            need(name == 'bend_collection_select', f'call: unsupported helper {name!r}')
            arg_states = [(st, [])]
            for arg in arg_exprs:
                next_states = []
                for current, values in arg_states:
                    next_states.extend((s, values + [v]) for s, v in self.eval(arg, current))
                arg_states = next_states
            out = []
            for current, values in arg_states:
                out.extend(self.call_select(current, values))
            return out
        raise Grammar(f'expression: unsupported node {kind!r}')

    def binary(self, op, left, right, st):
        need(isinstance(left, CInt) and isinstance(right, CInt), 'binary: integer operands required')
        t = usual_type(left.ctype, right.ctype)
        a, b = convert(left, t).bits, convert(right, t).bits
        if op in ('+', '-'):
            st.arithmetic.append(('add' if op == '+' else 'sub', t, a, b, st.pc))
            return CInt(t, z3.simplify(a + b if op == '+' else a - b))
        if op in ('==', '!='):
            cmp = a == b
            return bool_int(cmp if op == '==' else z3.Not(cmp))
        unsigned = t.startswith('u')
        if op == '<':
            cmp = z3.ULT(a, b) if unsigned else a < b
        elif op == '>':
            cmp = z3.UGT(a, b) if unsigned else a > b
        elif op == '<=':
            cmp = z3.ULE(a, b) if unsigned else a <= b
        elif op == '>=':
            cmp = z3.UGE(a, b) if unsigned else a >= b
        else:
            raise Grammar(f'binary: unsupported operator {op!r}')
        return bool_int(cmp)

    def eval_many(self, expressions, st):
        states = [(st, [])]
        for expression in expressions:
            next_states = []
            for current, values in states:
                next_states.extend((s, values + [v]) for s, v in self.eval(expression, current))
            states = next_states
        return states

    def call_select(self, st, args):
        need(len(args) == 5, 'call: bend_collection_select arity')
        cptr, start, count, maximum, outptr = args
        need(isinstance(cptr, Pointer) and isinstance(outptr, Pointer), 'call: select pointers')
        need(all(isinstance(v, CInt) for v in (start, count, maximum)), 'call: select scalars')
        vars_for_call = {'c': cptr, 'start': convert(start, 'u32'), 'count': convert(count, 'u32'),
                         'maximum': convert(maximum, 'u32'), 'out': outptr}
        return self.run_function('select', st, vars_for_call, 'u32')

    def statement(self, statement, st):
        kind = statement[0]
        if kind == 'block':
            raise Grammar('nested blocks are outside this focused interpreter')
        if kind == 'decl':
            _, ctype, const, pointer, name, size, init = statement
            need(not pointer and size is None and not const, f'declaration: unsupported {name}')
            need(name not in st.variables, f'declaration: duplicate {name}')
            if ctype == 'BendCollectionWindow':
                objid = self.fresh_object(name)
                st.heap[objid] = CStruct(ctype, {'start': UNINIT, 'reserved': UNINIT, 'loaded': UNINIT})
                st.variables[name] = ObjectRef(objid)
                return [st]
            need(canonical_type(ctype) in ('u8', 'u32', 'u64'), f'declaration: unsupported type {ctype}')
            if init is None:
                st.variables[name] = UNINIT
                return [st]
            need(init[0] == 'expr', f'declaration: unsupported initializer for {name}')
            out = []
            for s, val in self.eval(init[1], st):
                s.variables[name] = convert(val, ctype)
                out.append(s)
            return out
        if kind == 'decls':
            states = [st]
            for decl in statement[1]:
                next_states = []
                for current in states:
                    next_states.extend(self.statement(decl, current))
                states = next_states
            return states
        if kind == 'assign':
            raise Grammar('scalar assignments are outside this focused interpreter')
        if kind == 'aggregate_store':
            _, pointer_name, ctype, expressions = statement
            need(ctype == 'BendCollectionWindow' and len(expressions) == 3,
                 'aggregate assignment: expected three BendCollectionWindow fields')
            need(pointer_name in st.variables and isinstance(st.variables[pointer_name], Pointer),
                 'aggregate assignment: expected pointer variable')
            target = st.variables[pointer_name].target
            need(target in st.heap and st.heap[target].ctype == ctype,
                 'aggregate assignment: pointer target type mismatch')
            out = []
            for s, fields in self.eval_many(expressions, st):
                obj = s.heap[target]
                for field, field_value in zip(('start', 'reserved', 'loaded'), fields):
                    need(isinstance(field_value, CInt), 'aggregate assignment: integer field required')
                    obj.fields[field] = convert(field_value, 'u32')
                out.append(s)
            return out
        if kind == 'expr':
            return [s for s, _ in self.eval(statement[1], st)]
        if kind == 'return':
            out = []
            for s, result in self.eval(statement[1], st):
                s.returned = result
                out.append(s)
            return out
        if kind == 'if':
            out = []
            for s, condition in self.eval(statement[1], st):
                cond = truth(condition)
                yes, no = s.clone(), s.clone()
                yes.pc, no.pc = z3.And(yes.pc, cond), z3.And(no.pc, z3.Not(cond))
                if self.feasible(yes.pc):
                    out.extend(self.statement(statement[2], yes))
                if self.feasible(no.pc):
                    if statement[3] is not None:
                        out.extend(self.statement(statement[3], no))
                    else:
                        out.append(no)
            return out
        raise Grammar(f'statement: unsupported form {kind!r}')

    def run_function(self, name, st, variables, result_type):
        # Isolate the per-call return collector. The actual body is parsed once
        # and executed as statements; no formula for the helper is substituted.
        self.return_frames = {}
        self.returns = []
        self._return_marker = 0
        caller_variables = dict(st.variables)
        caller_objects = set(st.heap)
        caller_returned = st.returned
        callee = st.clone()
        callee.variables = variables
        callee.returned = None
        results = self.run_body(name, callee)
        out = []
        for state, result in results:
            state.variables = caller_variables
            state.returned = caller_returned
            for key in list(state.heap):
                if key not in caller_objects:
                    del state.heap[key]
            out.append((state, convert(result, result_type)))
        return out

    @staticmethod
    def feasible(formula):
        simplified = z3.simplify(formula)
        if z3.is_false(simplified):
            return False
        solver = solver_for(simplified, timeout_ms=20000)
        status = solver.check()
        if status == z3.unknown:
            raise AssuranceError(f'UNKNOWN is not a proof (path feasibility): {solver.reason_unknown()}')
        return status == z3.sat

    def run_body(self, name, st):
        states = [st]
        returns = []
        for statement in self.functions[name]:
            next_states = []
            for current in states:
                if current.returned is not None:
                    returns.append((current, current.returned))
                else:
                    next_states.extend(self.statement(statement, current))
            states = next_states
        for current in states:
            if current.returned is None:
                raise Grammar(f'{name}: control reaches end without return')
            returns.append((current, current.returned))
        return returns


def make_world(prefix, kind):
    length, capacity = z3.BitVec(f'{prefix}_length', 32), z3.BitVec(f'{prefix}_capacity', 32)
    c_account = f'{prefix}_collection'
    heap = {c_account: CStruct('BendCollection', {
        'account': Pointer(f'{prefix}_account'), 'length': CInt('u32', length), 'capacity': CInt('u32', capacity),
        'stride': CInt('u32', z3.BitVec(f'{prefix}_stride', 32)),
    })}
    variables = {}
    fields = {'length': length, 'capacity': capacity}
    if kind == 'select':
        start, count, maximum = (z3.BitVec(f'{prefix}_{n}', 32) for n in ('start', 'count', 'maximum'))
        out_id = f'{prefix}_out'
        original = {n: z3.BitVec(f'{prefix}_out_{n}', 32) for n in ('start', 'reserved', 'loaded')}
        heap[out_id] = CStruct('BendCollectionWindow', {n: CInt('u32', v) for n, v in original.items()})
        variables = {'c': Pointer(c_account), 'start': CInt('u32', start), 'count': CInt('u32', count),
                     'maximum': CInt('u32', maximum), 'out': Pointer(out_id)}
        fields.update(start=start, count=count, maximum=maximum)
        fields.update({f'out_{k}': v for k, v in original.items()})
    else:
        start, reserved, loaded, written, next_length = (
            z3.BitVec(f'{prefix}_{n}', 32) for n in ('start', 'reserved', 'loaded', 'written', 'next_length'))
        window_id = f'{prefix}_window'
        heap[window_id] = CStruct('BendCollectionWindow', {
            'start': CInt('u32', start), 'reserved': CInt('u32', reserved), 'loaded': CInt('u32', loaded),
        })
        variables = {'c': Pointer(c_account), 'w': Pointer(window_id), 'written': CInt('u32', written),
                     'next_length': CInt('u32', next_length)}
        fields.update(start=start, reserved=reserved, loaded=loaded, written=written, next_length=next_length)
        fields.update({f'c_{k}': v for k, v in heap[c_account].fields.items() if k in ('length', 'capacity', 'stride')})
        fields.update({f'w_{k}': v for k, v in heap[window_id].fields.items()})
    # Every u32 input is in scope, including malformed collection metadata.
    # select must reject length > capacity itself; plan must inherit that
    # refusal through its real nested select call.
    pre = z3.BoolVal(True)
    return State(z3.BoolVal(True), variables, heap, []), pre, fields, c_account


def mathematical_contract(kind, fields):
    """Instantiate the versioned helper contract AST used by the caller."""
    env = dict(fields)
    if kind == 'select':
        for name in ('start', 'reserved', 'loaded'):
            env[f'old_{name}'] = fields[f'out_{name}']
    instance = collection_contracts.instantiate(kind, env)
    return instance['success'], instance['status'], instance.get('outputs', {}), instance['orderedGuards']


def source_result(interpreter, kind, st, variables):
    result_type = 'unsigned'
    if kind == 'select':
        return interpreter.run_function('select', st, variables, result_type)
    return interpreter.run_function('plan', st, variables, result_type)


def source_vars(kind, state):
    return dict(state.variables)


def prove_function(functions, kind):
    state, pre, fields, c_account = make_world(f'collection_{kind}', kind)
    original_heap = {k: v.clone() for k, v in state.heap.items()}
    outcomes = source_result(SymbolicC(functions), kind, state, source_vars(kind, state))
    need(outcomes, f'{kind}: no symbolic outcomes')

    # Discharge definedness before comparing behavior with the mathematical
    # contract. A wrapped result from a signed-overflow path must be reported as
    # undefined behavior, not hidden behind the downstream value mismatch.
    arithmetic_count = 0
    arithmetic_obligations = []
    unsigned_obligations = []
    for out, _ in outcomes:
        for op, ctype, left, right, at in out.arithmetic:
            arithmetic_count += 1
            if ctype.startswith('u'):
                if op == 'sub':
                    unsigned_obligations.append((
                        f'{kind}: evaluated {ctype} subtraction cannot underflow',
                        z3.And(pre, at, z3.ULT(left, right))))
            elif ctype == 'int':
                safe = signed_arithmetic_safe(op, left, right)
                try:
                    arithmetic_obligations.append(prove_unsat(
                        f'{kind}: evaluated signed int {op} cannot overflow',
                        z3.And(pre, at, z3.Not(safe))))
                except Counterexample as e:
                    raise UndefinedBehavior(f'undefined behavior: {e}') from e
            else:
                raise Grammar(f'{kind}: unsupported arithmetic type {ctype}')

    contract_ok, contract_ret, contract_outputs, guards = mathematical_contract(kind, fields)
    coverage = z3.Or(*[out.pc for out, _ in outcomes])
    obligations = arithmetic_obligations + [
        prove_unsat(f'{kind}: source paths cover all u32 inputs', z3.And(pre, z3.Not(coverage)))
    ]
    mismatch = []
    for i, (out, returned) in enumerate(outcomes):
        mismatch.append(z3.And(pre, out.pc, returned.bits != contract_ret))
        if kind == 'select':
            target = out.heap[f'collection_{kind}_out']
            for field, expected in contract_outputs.items():
                actual = target.fields[field]
                need(isinstance(actual, CInt), f'{kind}: output field {field} not scalar')
                mismatch.append(z3.And(pre, out.pc, actual.bits != expected))
            # c is const input. Check the modeled fields remain unchanged.
            for field in ('length', 'capacity', 'stride', 'account'):
                before = original_heap[c_account].fields[field]
                after = out.heap[c_account].fields[field]
                if isinstance(before, CInt):
                    same = after.bits == before.bits
                else:
                    same = after == before
                mismatch.append(z3.And(pre, out.pc, z3.Not(same)))
        else:
            # Neither the collection nor the supplied window is an output.
            for object_id, original in original_heap.items():
                after = out.heap[object_id]
                for field, before in original.fields.items():
                    actual = after.fields[field]
                    if isinstance(before, CInt):
                        same = actual.bits == before.bits
                    else:
                        same = actual == before
                    mismatch.append(z3.And(pre, out.pc, z3.Not(same)))
    obligations.append(prove_unsat(f'{kind}: exact return and output contract', z3.Or(*mismatch)))
    # Unsigned wrap is defined C behavior. Check contract agreement before the
    # stronger nonwrapping property so semantic mutations expose their actual
    # return/output disagreement, rather than only the extra arithmetic rule.
    obligations.extend(prove_unsat(label, condition) for label, condition in unsigned_obligations)
    if kind == 'select':
        refusal_preservation, success_fields, collection_preservation = [], [], []
        target_id = f'collection_{kind}_out'
        for out, _ in outcomes:
            target = out.heap[target_id]
            for field in ('start', 'reserved', 'loaded'):
                actual = target.fields[field].bits
                original = fields[f'out_{field}']
                expected_success = {
                    'start': fields['start'],
                    'reserved': fields['count'],
                    'loaded': contract_outputs['loaded'],
                }[field]
                refusal_preservation.append(z3.And(pre, out.pc, z3.Not(contract_ok), actual != original))
                success_fields.append(z3.And(pre, out.pc, contract_ok, actual != expected_success))
            for field in ('length', 'capacity', 'stride', 'account'):
                before = original_heap[c_account].fields[field]
                after = out.heap[c_account].fields[field]
                same = after.bits == before.bits if isinstance(before, CInt) else after == before
                collection_preservation.append(z3.And(pre, out.pc, z3.Not(same)))
        obligations.extend([
            prove_unsat('select: output fields do not mutate on refusal', z3.Or(*refusal_preservation)),
            prove_unsat('select: exact start/reserved/loaded outputs on success', z3.Or(*success_fields)),
            prove_unsat('select: collection input is unchanged', z3.Or(*collection_preservation)),
        ])
    else:
        preserved = []
        for out, _ in outcomes:
            for object_id, original in original_heap.items():
                for field, before in original.fields.items():
                    actual = out.heap[object_id].fields[field]
                    same = actual.bits == before.bits if isinstance(before, CInt) else actual == before
                    preserved.append(z3.And(pre, out.pc, z3.Not(same)))
        obligations.append(prove_unsat('plan: collection and window inputs are unchanged', z3.Or(*preserved)))
    return {
        'obligations': obligations,
        'outcomes': len(outcomes),
        'arithmetic_evaluations': arithmetic_count,
        'input_precondition': 'none; collection and scalar fields range over all u32 values',
        'contract_guard_count': len(guards),
        'refusal_return': 0,
        'success_return': 1,
        'refusal_witness_order': 'independently stated contract guards; no source guard order is claimed',
        'contract_success': str(contract_ok),
    }, (state, pre, fields, contract_ok, contract_outputs, guards, outcomes)


def sat_guard_witnesses(kind, proof_context):
    state, pre, fields, ok, _, guards, _ = proof_context
    names = []
    if kind == 'select':
        names = ['length_exceeds_capacity', 'start_exceeds_length', 'count_exceeds_maximum',
                 'start_exceeds_capacity', 'count_exceeds_remaining_capacity']
    else:
        names = ['nested_select_refuses', 'selected_loaded_mismatch', 'written_below_loaded',
                 'written_above_reserved', 'next_length_below_old', 'next_length_above_capacity',
                 'append_window_not_at_tail', 'append_count_differs_from_length_delta']
    found = []
    for i, (name, guard) in enumerate(zip(names, guards)):
        earlier = z3.And(*[guards[j] for j in range(i)]) if i else z3.BoolVal(True)
        formula = z3.And(pre, earlier, z3.Not(guard))
        try:
            found.append(witness(f'{kind} first refusal: {name}', formula,
                                 {k: v for k, v in fields.items() if z3.is_bv(v)}))
        except AssuranceError as e:
            # Record unreachable later refusals instead of inventing an input
            # that contradicts the earlier contract guards.
            if 'expected sat' not in str(e):
                raise
            prove_unsat(f'{kind} refusal guard {i} unreachable after earlier guards', formula)
            found.append({'label': f'{kind} refusal guard {i}: unreachable after earlier guards', 'result': 'UNREACHABLE'})
    return found


def range_and_append_obligations(kind, proof_context):
    state, pre, fields, ok, outputs, guards, outcomes = proof_context
    length, capacity, start = fields['length'], fields['capacity'], fields['start']
    def assumptions(*indices):
        return z3.And(pre, *[guards[i] for i in indices])

    obligations = []
    if kind == 'select':
        count = fields['count']
        available = length - start
        loaded = z3.If(z3.ULT(available, count), available, count)
        obligations.extend([
            prove_unsat('select: start is within old logical length', z3.And(assumptions(1), z3.UGT(start, length))),
            prove_unsat('select: reservation addition does not wrap', z3.And(assumptions(3, 4), z3.Not(u32_sum_fits(start, count)))),
            prove_unsat('select: reserved end is within capacity',
                        z3.And(assumptions(3, 4), z3.UGT(u32_sum_ext(start, count), z3.ZeroExt(1, capacity)))),
            prove_unsat('select: loaded count does not exceed reservation', z3.And(assumptions(1), z3.UGT(loaded, count))),
            prove_unsat('select: loaded end addition does not wrap', z3.And(assumptions(1), z3.Not(u32_sum_fits(start, loaded)))),
            prove_unsat('select: loaded end is within old logical length',
                        z3.And(assumptions(1), z3.UGT(u32_sum_ext(start, loaded), z3.ZeroExt(1, length)))),
        ])
    else:
        reserved, loaded = fields['reserved'], fields['loaded']
        written, next_length = fields['written'], fields['next_length']
        added = written - loaded
        obligations.extend([
            prove_unsat('plan: written record count fits selected reservation', z3.And(assumptions(3), z3.UGT(written, reserved))),
            prove_unsat('plan: written range addition does not wrap', z3.And(assumptions(0, 3), z3.Not(u32_sum_fits(start, written)))),
            prove_unsat('plan: written range fits collection capacity',
                        z3.And(assumptions(0, 3), z3.UGT(u32_sum_ext(start, written), z3.ZeroExt(1, capacity)))),
            prove_unsat('plan: loaded prefix is retained by count', z3.And(assumptions(2), z3.ULT(written, loaded))),
            prove_unsat('plan: next logical length is bounded', z3.And(assumptions(5), z3.UGT(next_length, capacity))),
            prove_unsat('plan: additions equal logical length growth', z3.And(assumptions(7), added != next_length - length)),
            prove_unsat('plan: appends extend exactly from old tail',
                        z3.And(assumptions(0, 6), added != 0, start + loaded != length)),
            prove_unsat('plan: loaded end addition does not wrap', z3.And(assumptions(0, 1), z3.Not(u32_sum_fits(start, loaded)))),
            prove_unsat('plan: old length plus additions does not wrap', z3.And(assumptions(4, 7), z3.Not(u32_sum_fits(length, added)))),
            prove_unsat('plan: old plus appended count equals next length without u32 wrap',
                        z3.And(assumptions(4, 7), u32_sum_ext(length, added) != z3.ZeroExt(1, next_length))),
        ])
    return obligations


def boundary_witnesses(proof_contexts):
    select, plan = proof_contexts['select'], proof_contexts['plan']
    _, sel_pre, sf, sel_ok, sel_out, _, _ = select
    _, plan_pre, pf, plan_ok, _, _, _ = plan
    b32 = lambda n: z3.BitVecVal(n, 32)
    s = [
        witness('select success with empty selection at zero capacity',
                z3.And(sel_pre, sel_ok, sf['capacity'] == b32(0), sf['length'] == b32(0),
                       sf['start'] == b32(0), sf['count'] == b32(0)),
                {k: v for k, v in sf.items() if z3.is_bv(v)}),
        witness('select success at exact u32 maximum capacity boundary',
                z3.And(sel_pre, sel_ok, sf['capacity'] == b32(MAX_U32), sf['length'] == b32(MAX_U32),
                       sf['start'] == b32(MAX_U32), sf['count'] == b32(0)),
                {k: v for k, v in sf.items() if z3.is_bv(v)}),
        witness('select partial load at old tail',
                z3.And(sel_pre, sel_ok, sf['length'] == b32(2), sf['capacity'] == b32(5),
                       sf['start'] == b32(1), sf['count'] == b32(3), sel_out['loaded'] == b32(1)),
                {k: v for k, v in sf.items() if z3.is_bv(v)}),
    ]
    s.append(witness('plan successful append reaches exact capacity boundary',
                     z3.And(plan_pre, plan_ok, pf['length'] == b32(MAX_U32 - 1),
                            pf['capacity'] == b32(MAX_U32), pf['start'] == b32(MAX_U32 - 1),
                            pf['reserved'] == b32(1), pf['loaded'] == b32(0),
                            pf['written'] == b32(1), pf['next_length'] == b32(MAX_U32)),
                     {k: v for k, v in pf.items() if z3.is_bv(v)}))
    s.append(witness('plan successful replacement retains the loaded count',
                     z3.And(plan_pre, plan_ok, pf['length'] == b32(3), pf['capacity'] == b32(5),
                            pf['start'] == b32(1), pf['reserved'] == b32(1), pf['loaded'] == b32(1),
                            pf['written'] == b32(1), pf['next_length'] == b32(3)),
                     {k: v for k, v in pf.items() if z3.is_bv(v)}))
    return s


def c_integer_semantics_self_check():
    """Exercise the promotion and signed-overflow rules used by the interpreter."""
    need(usual_type('u8', 'u8') == 'int', 'u8 operands must undergo integer promotion to int')
    need(usual_type('u8', 'u32') == 'u32', 'u8/u32 operands must convert to u32 after promotion')
    need(usual_type('int', 'u32') == 'u32', 'same-rank int/u32 operands must convert to u32')
    need(usual_type('int', 'u64') == 'u64', 'int/u64 operands must convert to u64')

    interpreter = SymbolicC({})
    byte_a, byte_b = z3.BitVec('selfcheck_u8_a', 8), z3.BitVec('selfcheck_u8_b', 8)
    for operator in ('+', '-'):
        state = State(z3.BoolVal(True), {}, {}, [])
        result = interpreter.binary(operator, CInt('u8', byte_a), CInt('u8', byte_b), state)
        need(result.ctype == 'int', f'u8 {operator} u8 must produce promoted int')
        op, ctype, left, right, at = state.arithmetic[0]
        need(ctype == 'int', f'u8 {operator} u8 arithmetic must be recorded as int')
        prove_unsat(f'interpreter self-check: promoted u8 {operator} u8 cannot overflow int',
                    z3.And(at, z3.Not(signed_arithmetic_safe(op, left, right))))

    plus_state = State(z3.BoolVal(True), {}, {}, [])
    promoted_sum = interpreter.binary('+', CInt('u8', z3.BitVecVal(255, 8)),
                                      CInt('u8', z3.BitVecVal(1, 8)), plus_state)
    need(promoted_sum.ctype == 'int' and z3.simplify(promoted_sum.bits).as_long() == 256,
         'u8 + u8 must compute as promoted signed int without 8-bit wrap')
    need(plus_state.arithmetic[0][0:2] == ('add', 'int'),
         'signed addition must carry an overflow obligation')

    int_max = z3.BitVecVal(0x7fffffff, 32)
    int_min = z3.BitVecVal(0x80000000, 32)
    zero = z3.BitVecVal(0, 32)
    one = z3.BitVecVal(1, 32)
    minus_one = z3.BitVecVal(0xffffffff, 32)
    overflow_examples = [
        ('add', int_max, one, 'signed int addition overflow must be detected'),
        ('sub', int_min, one, 'signed int subtraction underflow must be detected'),
    ]
    for op, left, right, message in overflow_examples:
        need(z3.is_false(z3.simplify(signed_arithmetic_safe(op, left, right))), message)
        try:
            prove_unsat(f'interpreter self-check: signed int {op} overflow is rejected',
                        z3.Not(signed_arithmetic_safe(op, left, right)))
        except Counterexample:
            pass
        else:
            raise AssuranceError(f'interpreter self-check failed to find signed int {op} overflow')
    need(z3.is_true(z3.simplify(signed_arithmetic_safe('add', zero, one))),
         'non-overflowing signed int addition must remain accepted')
    need(z3.is_true(z3.simplify(signed_arithmetic_safe('sub', zero, minus_one))),
         'non-overflowing signed int subtraction must remain accepted')
    return {
        'u8_promoted_to_int': True,
        'all_u8_add_sub_values_fit_int': True,
        'signed_int_overflow_counterexamples_rejected': ['addition', 'subtraction'],
    }


def mutant_check(root):
    header = root / 'runtime/bend_collection_runtime.h'
    source = header.read_text()
    primitives = (root / 'runtime/solana_min.h').read_text()
    mutations = [
        ('missing_length_capacity_guard', 'c->length > c->capacity || ', '', 'select', 'COUNTEREXAMPLE'),
        ('wrong_arithmetic', 'u32 available = c->length - start;', 'u32 available = start - c->length;', 'select', 'COUNTEREXAMPLE'),
        ('missing_start_guard', 'start > c->length || ', '', 'select', 'COUNTEREXAMPLE'),
        ('wrong_inequality', 'count > maximum', 'count >= maximum', 'select', 'COUNTEREXAMPLE'),
        ('wrong_loaded_assignment', 'available < count ? available : count', 'available < count ? count : count', 'select', 'COUNTEREXAMPLE'),
        ('missing_capacity_range_guard', ' || count > c->capacity - start', '', 'select', 'COUNTEREXAMPLE'),
        ('u32_overflow_in_capacity_arithmetic', 'count > c->capacity - start', 'count > c->capacity + start', 'select', 'COUNTEREXAMPLE'),
        ('missing_nested_selection_guard', '!bend_collection_select(c, w->start, w->reserved, w->reserved, &expected) ||', '', 'plan', 'UNDEFINED_BEHAVIOR'),
        ('missing_loaded_consistency_guard', 'expected.loaded != w->loaded || ', '', 'plan', 'COUNTEREXAMPLE'),
        ('wrong_tail_window_arithmetic', 'c->length - w->start != w->loaded', 'c->length + w->start != w->loaded', 'plan', 'COUNTEREXAMPLE'),
        ('wrong_append_delta_guard', 'added == next_length - c->length', 'added != next_length - c->length', 'plan', 'COUNTEREXAMPLE'),
        ('reachable_signed_addition_overflow', 'c->length > c->capacity || ',
         '(start > c->length) + 2147483647 < 0 || c->length > c->capacity || ',
         'select', 'UNDEFINED_BEHAVIOR'),
        ('reachable_signed_subtraction_overflow', 'c->length > c->capacity || ',
         '0 - 2147483647 - 1 - (start > c->length) < 0 || c->length > c->capacity || ',
         'select', 'UNDEFINED_BEHAVIOR'),
        ('boundary_safe_signed_subtraction', 'c->length > c->capacity || ',
         '((0 - 2147483647 - 1 < 0) && 0) || c->length > c->capacity || ',
         'select', 'ACCEPTED'),
        ('unsupported_scalar_assignment', 'u32 available = c->length - start;',
         'u32 available; available = c->length - start;', 'select', 'UNSUPPORTED_SOURCE'),
    ]
    results = []
    for label, old, new, function, expected in mutations:
        need(source.count(old) == 1, f'mutation {label}: expected one C source occurrence')
        candidate = source.replace(old, new, 1)
        try:
            parsed = extract_functions_from_text(candidate, header.name, primitives)
            proof, _ = prove_function(parsed, function)
            del proof
        except UndefinedBehavior as e:
            result = {'mutation': label, 'result': 'UNDEFINED_BEHAVIOR',
                      'rejection_class': 'undefined_behavior', 'reason': str(e).splitlines()[0]}
        except Counterexample as e:
            result = {'mutation': label, 'result': 'COUNTEREXAMPLE',
                      'rejection_class': 'semantic_counterexample', 'reason': str(e).splitlines()[0]}
        except Grammar as e:
            result = {'mutation': label, 'result': 'UNSUPPORTED_SOURCE',
                      'rejection_class': 'grammar_or_unsupported_source',
                      'reason': str(e).splitlines()[0]}
        else:
            result = {'mutation': label, 'result': 'ACCEPTED'}
        need(result['result'] == expected,
             f'mutation {label}: expected {expected}, got {result["result"]}; {result.get("reason", "")}'.rstrip())
        result['expected_result'] = expected
        results.append(result)
    guard_kill = next(result for result in results if result['mutation'] == 'missing_length_capacity_guard')
    need(guard_kill['result'] == 'COUNTEREXAMPLE',
         'missing length<=capacity defensive guard must fail by semantic counterexample')
    # A semantics-preserving rewrite must remain accepted by the same parser
    # and proof, demonstrating that the gate is not token equality.
    equivalent = source.replace('available < count ? available : count',
                                'count > available ? available : count', 1)
    parsed = extract_functions_from_text(equivalent, header.name, primitives)
    prove_function(parsed, 'select')
    results.append({'mutation': 'equivalent_minimum_rewrite', 'result': 'ACCEPTED'})
    return results


def extract_functions_from_text(text, header_name, primitive_text):
    """Same source parser for in-memory mutation candidates."""
    # A temporary root avoids duplicating source extraction and makes candidate
    # bytes pass through all directive, declaration, signature, and body checks.
    with tempfile.TemporaryDirectory(prefix='collection-runtime-mutant-') as tmp:
        root = pathlib.Path(tmp)
        (root / 'runtime').mkdir()
        (root / 'runtime' / header_name).write_text(text)
        (root / 'runtime/solana_min.h').write_text(primitive_text)
        return extract_functions(root)


def unknown_rejection_self_check():
    try:
        check(z3.unknown, z3.unsat, 'unknown-status self-check')
    except AssuranceError as e:
        need('UNKNOWN is not a proof' in str(e), 'UNKNOWN fail-closed self-check reason')
        return 'UNKNOWN rejected'
    raise AssuranceError('UNKNOWN fail-closed self-check unexpectedly passed')


def child_nonzero_claim(parent_probes_complete):
    return ('checked by TypeScript parent failure probes'
            if parent_probes_complete else 'not checked by this Python invocation')


def source_hash_set(root, ts_checker):
    parser_path = pathlib.Path(__import__('adapter_contract_c').__file__).resolve()
    names = [
        'runtime/bend_collection_runtime.h',
        'runtime/solana_min.h',
        'verification/adapter_contract_c.py',
        'verification/collection_contracts.py',
        'verification/collection_runtime.py',
        'verification/check-collection-runtime.ts',
        'tests/collection-runtime.c',
    ]
    paths = {name: root / name for name in names}
    paths['verification/adapter_contract_c.py'] = parser_path
    paths['verification/check-collection-runtime.ts'] = ts_checker
    return {name: sha256(path) for name, path in paths.items()}


def receipt_path(root):
    override = os.environ.get('COLLECTION_RUNTIME_RECEIPT_PATH')
    return pathlib.Path(override).resolve() if override else root / 'build/collection-runtime-refinement.json'


def clear_receipt(root):
    """Clear the conventional success path without archiving its contents."""
    output = receipt_path(root.resolve())
    output.unlink(missing_ok=True)


RECEIPT_HASH_NAMES = {
    'runtime/bend_collection_runtime.h',
    'runtime/solana_min.h',
    'verification/adapter_contract_c.py',
    'verification/collection_contracts.py',
    'verification/collection_runtime.py',
    'verification/check-collection-runtime.ts',
    'tests/collection-runtime.c',
}


def quarantine_receipt(root, disposition='unaccepted'):
    """Atomically clear the success path while retaining its exact bytes nearby."""
    output = receipt_path(root.resolve())
    if not output.exists():
        return None
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f'{output.name}.{disposition}.', suffix='.json', dir=output.parent)
    os.close(fd)
    safe = pathlib.Path(name)
    try:
        os.replace(output, safe)
    except BaseException:
        safe.unlink(missing_ok=True)
        raise
    return safe


def is_archiveable_receipt(raw):
    """Accept only a self-consistent completed proof report for the archive."""
    try:
        report = json.loads(raw)
        if not isinstance(report, dict):
            return False
        if (report.get('schema') != 2 or report.get('status') != 'PASS' or
                report.get('passed') is not True or report.get('source_hash_comparison') != 'MATCH'):
            return False
        start = report.get('source_hashes_at_start')
        if not isinstance(start, dict) or set(start) != RECEIPT_HASH_NAMES:
            return False
        if any(not isinstance(value, str) or re.fullmatch(r'[0-9a-f]{64}', value) is None
               for value in start.values()):
            return False
        if report.get('source_hashes_at_end') != start or report.get('source_hashes_at_publication') != start:
            return False
        if not isinstance(report.get('proofs'), dict) or set(report['proofs']) != {'select', 'plan'}:
            return False
        if not isinstance(report.get('source_body_mutations'), list):
            return False
        return True
    except (TypeError, ValueError, UnicodeDecodeError):
        return False


def archive_previous_receipt(root):
    """Quarantine first, then content-address and verify before removing evidence."""
    root = root.resolve()
    safe = quarantine_receipt(root, 'previous')
    if safe is None:
        return None
    raw = safe.read_bytes()
    if not is_archiveable_receipt(raw):
        return safe
    try:
        directory = root / 'build/refinement-reports'
        directory.mkdir(parents=True, exist_ok=True)
        archive = directory / (hashlib.sha256(raw).hexdigest() + '.json')
        if archive.exists():
            need(archive.read_bytes() == raw, 'corrupt receipt archive')
        else:
            with archive.open('xb') as handle:
                handle.write(raw)
                handle.flush()
                os.fsync(handle.fileno())
        need(archive.read_bytes() == raw, 'receipt archive verification failed')
        dirfd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
        safe.unlink()
        return archive
    except BaseException as e:
        raise ReceiptArchiveError(
            f'could not archive prior receipt; conventional success path is clear and evidence is preserved at {safe}: {e}'
        ) from e


def publish(root, report, initial_hashes, ts_checker):
    output = receipt_path(root)
    output.parent.mkdir(parents=True, exist_ok=True)
    current = source_hash_set(root, ts_checker)
    need(current == initial_hashes, 'source/dependency/checker hash changed before publication; report not published')
    report['source_hashes_at_end'] = current
    report['source_hashes_at_publication'] = current
    report['source_hash_comparison'] = 'MATCH'
    temporary = None
    published = False
    try:
        fd, name = tempfile.mkstemp(prefix='.collection-runtime-', suffix='.tmp', dir=output.parent)
        temporary = pathlib.Path(name)
        with os.fdopen(fd, 'w') as f:
            json.dump(report, f, indent=2, sort_keys=True)
            f.write('\n')
            f.flush()
            os.fsync(f.fileno())
        if output.exists():
            previous = archive_previous_receipt(root)
            if previous is not None and previous.parent.name == 'refinement-reports':
                report['archived_previous_report'] = str(previous.relative_to(root))
            with temporary.open('w') as f:
                json.dump(report, f, indent=2, sort_keys=True)
                f.write('\n')
                f.flush()
                os.fsync(f.fileno())
        need(source_hash_set(root, ts_checker) == initial_hashes,
             'source/dependency/checker hash changed during publication; report not published')
        os.replace(temporary, output)
        temporary = None
        published = True
        if source_hash_set(root, ts_checker) != initial_hashes:
            raise AssuranceError('source/dependency/checker hash changed at end of publication; report is unaccepted')
        dirfd = os.open(output.parent, os.O_RDONLY)
        try:
            os.fsync(dirfd)
        finally:
            os.close(dirfd)
    except BaseException:
        if published:
            quarantine_receipt(root, 'unaccepted')
        raise
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return output


def run(root: pathlib.Path, ts_checker: pathlib.Path, parent_probes_complete=False):
    root = root.resolve()
    ts_checker = ts_checker.resolve()
    initial_hashes = source_hash_set(root, ts_checker)
    # These sources were already hash-captured above. Parsing and symbolic work
    # starts only after this point; publish() compares them before replacement.
    functions = extract_functions(root)
    proofs, contexts = {}, {}
    for kind in ('select', 'plan'):
        proofs[kind], contexts[kind] = prove_function(functions, kind)
        proofs[kind]['range_and_append_obligations'] = range_and_append_obligations(kind, contexts[kind])
        proofs[kind]['first_refusal_witnesses'] = sat_guard_witnesses(kind, contexts[kind])
    witnesses = boundary_witnesses(contexts)
    mutations = mutant_check(root)
    unknown_result = unknown_rejection_self_check()
    integer_semantics_result = c_integer_semantics_self_check()
    report = {
        'schema': 2,
        'status': 'PASS',
        'passed': True,
        'compositionRunId': os.environ.get('COLLECTION_COMPOSITION_RUN_ID'),
        'scope': 'Actual C bodies of bend_collection_select and bend_collection_plan under valid, disjoint pointer assumptions; independently stated mathematical range/append contracts.',
        'generated_at_utc': dt.datetime.now(dt.timezone.utc).isoformat(),
        'source_hashes_at_start': initial_hashes,
        'z3': {'version': z3.get_version_string(), 'timeout_ms': 20000},
        'integer_semantics': [
            'u8/u32/u64 and int use 8/32/64/32-bit widths; conversion truncates low bits, zero-extends unsigned values, and sign-extends int values.',
            'Integer promotions convert u8 operands to int before the supported usual arithmetic conversions; comparisons use signed or unsigned ordering after conversion.',
            'Unsigned arithmetic wraps modulo 2^width; evaluated signed int addition and subtraction carry obligations excluding C undefined overflow.',
            '&&, || and ?: are evaluated lazily with path conditions, so later subtraction expressions are checked only on the paths where C evaluates them.',
            'The unmutated selected source bodies perform only u32 arithmetic; reachable signed int addition/subtraction overflow and an INT_MIN boundary case are exercised through parsed source mutations, alongside the interpreter promotion self-check.',
        ],
        'assumptions': [
            'No range precondition is placed on the modeled u32 collection/window/scalar fields; length > capacity is included and select must refuse it.',
            'Collection, window, and output pointers designate valid, non-null, disjoint objects of the declared types; writable outputs have the required write permission. Pointer validity and bounds are assumed, not proved in this slice.',
            'u8/u32/u64 have widths 8/32/64 as asserted in runtime/solana_min.h; the reusable C parser, this local interpreter and Z3 bridge implement the listed restricted C semantics correctly.',
            'Only normally returning helper control flow is modeled. Clang/LLD/SBF preservation, loader behavior, codecs, roots, open/record/commit, ABI-3 callers and transaction rollback are outside scope.',
        ],
        'not_claimed': [
            'No proof of bend_collection_open, bend_collection_record pointer bounds, bend_collection_commit, or any generated ABI-3 caller.',
            'No derivation of persistent collection invariants from open; this proof checks the select guard against arbitrary u32 length/capacity values.',
            'No proof of codecs, account roots, account/key pointers, LLVM, SBF, Solana rollback, or compiled artifacts.',
            'The selected source bodies contain u32 arithmetic and no u64 arithmetic/conversion. The interpreter defines u32/u64 C conversions and wrap semantics, but this report does not claim a u64 helper obligation.',
        ],
        'proofs': proofs,
        'contractInterface': collection_contracts.CONTRACT_DOCUMENT,
        'contractInterfaceHash': collection_contracts.CONTRACT_INTERFACE_HASH,
        'nonvacuity_and_boundary_witnesses': witnesses,
        'source_body_mutations': mutations,
        'interpreter_semantics_self_checks': integer_semantics_result,
        'fail_closed_checks': {
            'z3_unknown': unknown_result,
            'child_nonzero': child_nonzero_claim(parent_probes_complete),
        },
    }
    path = publish(root, report, initial_hashes, ts_checker)
    return path, report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo-root', type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument('--ts-checker', type=pathlib.Path,
                        default=pathlib.Path(__file__).resolve().parent / 'check-collection-runtime.ts')
    parser.add_argument('--probe-child-failure', action='store_true')
    parser.add_argument('--probe-unknown', action='store_true')
    parser.add_argument('--skip-receipt-archive', action='store_true')
    parser.add_argument('--parent-probes-complete', action='store_true')
    args = parser.parse_args()
    probe = args.probe_child_failure or args.probe_unknown
    try:
        if args.skip_receipt_archive or probe:
            clear_receipt(args.repo_root)
        else:
            archive_previous_receipt(args.repo_root)
    except (AssuranceError, OSError) as e:
        print(f'collection runtime assurance failed while preserving prior receipt: {e}', file=sys.stderr)
        return 1
    if args.probe_child_failure:
        print('intentional child failure probe', file=sys.stderr)
        return 29
    if args.probe_unknown:
        try:
            check(z3.unknown, z3.unsat, 'intentional UNKNOWN parent probe')
        except AssuranceError as e:
            print(f'collection runtime assurance failed: {e}', file=sys.stderr)
            return 1
        raise AssertionError('UNKNOWN probe unexpectedly passed')
    try:
        path, report = run(args.repo_root, args.ts_checker, args.parent_probes_complete)
    except (AssuranceError, Grammar, z3.Z3Exception, OSError, ValueError) as e:
        print(f'collection runtime assurance failed: {e}', file=sys.stderr)
        return 1
    semantic_kills = sum(m['result'] == 'COUNTEREXAMPLE' for m in report['source_body_mutations'])
    ub_rejections = sum(m['result'] == 'UNDEFINED_BEHAVIOR' for m in report['source_body_mutations'])
    grammar_rejections = sum(m['result'] == 'UNSUPPORTED_SOURCE' for m in report['source_body_mutations'])
    print(f"PASS collection select/plan: {report['proofs']['select']['outcomes']} select paths, "
          f"{report['proofs']['plan']['outcomes']} plan paths, "
          f"{semantic_kills} semantic counterexamples, {ub_rejections} UB rejections, "
          f"{grammar_rejections} grammar rejections; equivalent rewrite accepted")
    print(f'report: {path}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
