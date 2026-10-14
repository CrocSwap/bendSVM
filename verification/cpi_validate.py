"""Restricted symbolic execution of the real bounded CPI validation helper.

The parser/interpreter and exact dependency bridge are trusted, not verified.
Only this helper is interpreted; executor/syscalls/SBF compilation are separate.
"""
import hashlib
import json
import pathlib
import re
import sys
from dataclasses import dataclass

import z3

from adapter_contract_c import (Grammar, IDENT, NUMBER, TOKEN, Parser, audited_header_tokens,
    has_file_scope_tokens, header_directives, header_tokens, literal, need, strict_tokens,
    unique_file_scope_name)

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIGNATURE = 'static inline u64 bend_invoke_validate(const BendInvoke *t, Account *a, unsigned count)'
# These are independent ABI declarations, not definitions copied out of a candidate.
DECLARATIONS = {
    'bend_cpi.h': [
        'typedef struct { u32 index, writable, signer; u8 key[32]; } BendInvokeMeta;',
        'typedef struct { u32 active, program, length, count; u8 program_key[32], data[64]; BendInvokeMeta metas[8]; } BendInvoke;',
    ],
    'solana_min.h': [
        'typedef unsigned char u8;', 'typedef unsigned int u32;', 'typedef unsigned long long u64;',
        '_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
        'typedef struct { const u8 *key; const u8 *owner; u8 *data; u64 size; u64 *lamports; u64 rent_epoch; unsigned signer, writable, executable; } Account;',
        '''static inline unsigned equal_key(const u8 *a, const u8 *b) {
          for (unsigned i = 0; i < 32; i += 8) { u64 left, right;
            __builtin_memcpy(&left, a + i, 8); __builtin_memcpy(&right, b + i, 8);
            if (left != right) return 0;
          } return 1;
        }''',
    ],
}


def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def helper(files):
    """Bind the parsed body to a live file-scope definition in the include closure."""
    includes = {'bend_cpi.h': ['cpi_abi.h'], 'cpi_abi.h': ['solana_min.h'], 'solana_min.h': []}
    headers = []
    for name, expected in includes.items():
        macros, children = header_directives(name, files[name])
        need(not macros, f'dependencies: macros unsupported in {name}')
        need(children == expected, f'dependencies: unexpected include closure in {name}')
        tokens = header_tokens(files[name])
        forms = [tokens[i + 2] for i in range(len(tokens) - 2) if tokens[i:i + 2] == ['#', 'include']]
        need(forms == [f'"{child}"' for child in children], 'dependencies: include search form')
        live = audited_header_tokens(name, files[name])
        headers.append(live)
        for declaration in DECLARATIONS.get(name, []):
            need(has_file_scope_tokens(live, header_tokens(declaration)), f'dependencies: reviewed declaration in {name}')
        if name == 'bend_cpi.h':
            start = header_tokens(SIGNATURE + ' {')
            need(has_file_scope_tokens(live, start), 'dependencies: unique live validator signature')
    unique_file_scope_name(headers, 'equal_key')
    source = files['bend_cpi.h']
    # Find the live signature with a lexer, never a substring search. Comments
    # or string literals containing a decoy function cannot supply its body.
    scanner = re.compile(TOKEN.pattern + r"|'[^'\n]*'")
    scanned, at = [], 0
    while at < len(source):
        match = scanner.match(source, at)
        need(match is not None, 'validator: unsupported header token')
        word = match.group()
        if not (word[0] in ' \t\n' or word.startswith(('/*', '//'))):
            scanned.append((word, match.start(), match.end()))
        at = match.end()
    words, signature = [t[0] for t in scanned], strict_tokens(SIGNATURE)
    starts = [i for i in range(len(words)) if words[i:i + len(signature)] == signature]
    need(len(starts) == 1, 'validator: ambiguous signature')
    begin = starts[0] + len(signature)
    need(words[begin] == '{', 'validator: missing body')
    depth, end = 0, None
    for i in range(begin, len(words)):
        if words[i] == '{':
            depth += 1
        elif words[i] == '}':
            depth -= 1
            if depth == 0:
                end = scanned[i][2]
                break
    need(end is not None, 'validator: unterminated body')
    parser = CpiParser(strict_tokens(source[scanned[begin][1]:end]), {'BendInvokeMeta'})
    body = parser.statement()
    need(body[0] == 'block', 'validator: missing body')
    return body


class CpiParser(Parser):
    def postfix(self):
        token = self.peek()
        if token == '(':
            self.take('(')
            node = self.expr()
            self.take(')')
        elif NUMBER.match(token):
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
                self.take(token)
                node = ('member' if token == '.' else 'arrow', node, self.ident())
            elif token == '(':
                need(node[0] == 'id', 'validator: indirect call')
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


def bv(n, bits=32):
    return z3.BitVecVal(n, bits)


def boolean(value):
    need(z3.is_bv(value) and value.size() == 32, 'validator: condition is not an unsigned scalar')
    return value != bv(0)


def scalar(condition):
    return z3.If(condition, bv(1), bv(0))


@dataclass(frozen=True)
class Object:
    kind: str
    index: object = None


class Model:
    """Independent fixed-capacity input objects; all scalar flags range over U32."""
    def __init__(self):
        self.count = z3.BitVec('account_count', 32)
        self.fields = {n: z3.BitVec(n, 32) for n in ['active', 'program', 'length', 'meta_count']}
        self.program_key = z3.BitVec('program_key', 256)
        self.arrays = {n: z3.Array(n, z3.BitVecSort(32), z3.BitVecSort(bits)) for n, bits in [
            ('account_key', 256), ('executable', 32), ('writable', 32), ('signer', 32),
            ('meta_index', 32), ('meta_writable', 32), ('meta_signer', 32), ('meta_key', 256), ('data', 8)]}
        self.pre = z3.And(z3.UGE(self.count, bv(4)), z3.ULE(self.count, bv(12)))

    def at(self, name, index):
        return z3.Select(self.arrays[name], bv(index) if isinstance(index, int) else index)

    def contract(self):
        """Declarative capability contract, independent of the parsed C control flow."""
        f = self.fields
        target = z3.And(z3.UGE(f['program'], bv(2)), z3.ULT(f['program'], self.count),
                        self.at('executable', f['program']) != 0,
                        self.at('account_key', f['program']) == self.program_key)
        payload = z3.And(z3.ULE(f['length'], bv(64)), z3.ULE(f['meta_count'], bv(8)),
            *[z3.Implies(z3.UGE(bv(i), f['length']), self.at('data', i) == 0) for i in range(64)])
        metas = []
        for i in range(8):
            idx, writable, signer = [self.at(n, i) for n in ('meta_index', 'meta_writable', 'meta_signer')]
            capability = z3.And(z3.ULT(idx, self.count), z3.ULE(writable, bv(1)), z3.ULE(signer, bv(1)),
                self.at('account_key', idx) == self.at('meta_key', i),
                z3.Implies(writable != 0, self.at('writable', idx) != 0),
                z3.Implies(signer != 0, z3.Or(self.at('signer', idx) != 0, idx == 3)),
                *[idx != self.at('meta_index', j) for j in range(i)])
            metas.append(z3.Implies(z3.ULT(bv(i), f['meta_count']), capability))
        return z3.If(f['active'] == 0, bv(0, 64), z3.If(z3.Not(target), bv(19, 64),
            z3.If(z3.Not(payload), bv(20, 64), z3.If(z3.Not(z3.And(*metas)), bv(21, 64), bv(0, 64)))))


class Execute:
    """Read-only bounded C subset. Every return/read/loop obligation is path guarded."""
    def __init__(self, model):
        self.m = model
        self.reads, self.loops, self.returns = [], [], []
        self.steps = 0

    def obligation(self, path, condition, label):
        self.reads.append((label, z3.Implies(path, condition)))

    def expression(self, node, env, path):
        kind = node[0]
        if kind == 'num':
            need(node[2] in ('int', 'u32'), 'validator: only nonnegative 32-bit literals')
            return bv(node[1])
        if kind == 'id':
            need(node[1] in env, 'validator: unknown/uninitialized identifier')
            return env[node[1]]
        if kind == 'not':
            return scalar(z3.Not(boolean(self.expression(node[1], env, path))))
        if kind in ('land', 'lor'):
            left = boolean(self.expression(node[1], env, path))
            right = boolean(self.expression(node[2], env, z3.And(path, left if kind == 'land' else z3.Not(left))))
            return scalar(z3.And(left, right) if kind == 'land' else z3.Or(left, right))
        if kind == 'bin':
            op = node[1]
            left, right = self.expression(node[2], env, path), self.expression(node[3], env, path)
            need(z3.is_bv(left) and z3.is_bv(right) and left.size() == right.size() == 32,
                 'validator: unsupported scalar widths')
            operators = {'==': lambda: left == right, '!=': lambda: left != right,
                '<': lambda: z3.ULT(left, right), '>': lambda: z3.UGT(left, right),
                '<=': lambda: z3.ULE(left, right), '>=': lambda: z3.UGE(left, right)}
            need(op in operators, 'validator: unsupported binary operator')
            return scalar(operators[op]())
        if kind == 'index':
            base, index = self.expression(node[1], env, path), self.expression(node[2], env, path)
            need(isinstance(base, Object) and base.kind in ('accounts', 'metas', 'data'), 'validator: unsupported index base')
            need(z3.is_bv(index) and index.size() == 32, 'validator: non-U32 index')
            bound = self.m.count if base.kind == 'accounts' else bv(8 if base.kind == 'metas' else 64)
            self.obligation(path, z3.ULT(index, bound), base.kind + ' index in bounds')
            if base.kind == 'data':
                return z3.ZeroExt(24, self.m.at('data', index))
            return Object('account' if base.kind == 'accounts' else 'meta', index)
        if kind == 'addr':
            value = self.expression(node[1], env, path)
            need(isinstance(value, Object) and value.kind == 'meta', 'validator: unsupported address formation')
            return Object('meta_pointer', value.index)
        if kind in ('arrow', 'member'):
            base, field = self.expression(node[1], env, path), node[2]
            need(isinstance(base, Object), 'validator: member of a scalar')
            allowed = ('effect', 'meta_pointer') if kind == 'arrow' else ('account', 'meta')
            need(base.kind in allowed, 'validator: pointer/member mismatch')
            if base.kind == 'effect':
                if field in ('data', 'metas'):
                    return Object(field)
                if field == 'program_key':
                    return Object('key', self.m.program_key)
                need(field in ('active', 'program', 'length', 'count'), 'validator: unknown effect field')
                return self.m.fields['meta_count' if field == 'count' else field]
            if base.kind in ('meta', 'meta_pointer'):
                self.obligation(path, z3.ULT(base.index, bv(8)), 'meta pointer readable')
                need(field in ('index', 'writable', 'signer', 'key'), 'validator: unknown meta field')
                value = self.m.at('meta_' + field, base.index)
            else:
                need(field in ('key', 'executable', 'writable', 'signer'), 'validator: unknown account field')
                value = self.m.at('account_key' if field == 'key' else field, base.index)
            return Object('key', value) if field == 'key' else value
        if kind == 'call':
            need(node[1] == 'equal_key' and len(node[2]) == 2, 'validator: unsupported/effectful call')
            args = [self.expression(x, env, path) for x in node[2]]
            need(all(isinstance(a, Object) and a.kind == 'key' for a in args), 'validator: key argument shape')
            return scalar(args[0].index == args[1].index)
        raise Grammar('validator: unsupported expression ' + kind)

    def statement(self, node, env, path, depth=0):
        self.steps += 1
        need(self.steps <= 4000 and depth <= 2, 'validator: execution bound exceeded')
        kind = node[0]
        if kind == 'block':
            local = dict(env)
            for child in node[1]:
                path = self.statement(child, local, path, depth)
            return path
        if kind == 'if':
            condition = boolean(self.expression(node[1], env, path))
            yes = self.statement(node[2], dict(env), z3.And(path, condition), depth)
            no = self.statement(node[3], dict(env), z3.And(path, z3.Not(condition)), depth) if node[3] else z3.And(path, z3.Not(condition))
            return z3.Or(yes, no)
        if kind == 'return':
            result = self.expression(node[1], env, path)
            need(z3.is_bv(result) and result.size() == 32, 'validator: return width')
            self.returns.append((path, z3.ZeroExt(32, result)))
            return z3.BoolVal(False)
        if kind == 'decl':
            _, ctype, const, pointer, name, size, init = node
            need((ctype, const, pointer, size) == ('BendInvokeMeta', True, True, None) and init and init[0] == 'expr',
                 'validator: unsupported declaration')
            need(name not in env, 'validator: shadowing declaration')
            value = self.expression(init[1], env, path)
            need(isinstance(value, Object) and value.kind == 'meta_pointer', 'validator: wrong local pointer type')
            env[name] = value
            return path
        if kind == 'for':
            _, var, init, cond, body = node
            need(var not in env, 'validator: shadowing loop variable')
            # The only supported loop roles have independently fixed capacities.
            # Changing a loop condition is interpreted; changing its traversal
            # role or creating another loop must explicitly reject.
            initial = self.expression(init, env, path)
            if init == ('arrow', ('id', 't'), 'length') and depth == 0:
                limit = 64
            elif init == ('num', 0, 'int'):
                limit = 8
            else:
                raise Grammar('validator: unsupported loop initialization')
            local, exited, live = dict(env), z3.BoolVal(False), path
            local[var] = initial
            for _ in range(limit):
                test = boolean(self.expression(cond, local, live))
                exited = z3.Or(exited, z3.And(live, z3.Not(test)))
                live = self.statement(body, dict(local), z3.And(live, test), depth + 1)
                local[var] = local[var] + bv(1)
            test = boolean(self.expression(cond, local, live))
            self.loops.append(z3.Not(z3.And(live, test)))
            return z3.Or(exited, z3.And(live, z3.Not(test)))
        raise Grammar('validator: write or unsupported statement ' + kind)

    def run(self, body):
        fallthrough = self.statement(body, {'t': Object('effect'), 'a': Object('accounts'), 'count': self.m.count}, z3.BoolVal(True))
        result = bv(0, 64)
        for guard, code in reversed(self.returns):
            result = z3.If(guard, code, result)
        return result, fallthrough


def solve(model, expression, wanted, properties=None):
    solver = z3.Solver()
    solver.set(timeout=30000)
    solver.add(model.pre, expression)
    result = solver.check()
    if result == z3.unknown:
        raise RuntimeError('Z3 unknown: ' + solver.reason_unknown())
    if str(result) != wanted:
        raise AssertionError(f'expected {wanted}, got {result}')
    if result == z3.sat:
        m = solver.model()
        return {**{n: m.eval(x, model_completion=True).as_long() for n, x in model.fields.items()},
            'account_count': m.eval(model.count, model_completion=True).as_long(),
            'smtModel': str(m), **({'violated': [name for name, prop in properties.items()
                if z3.is_false(m.eval(prop, model_completion=True))]} if properties is not None else {})}
    return None


def evaluate(files):
    body = helper(files)
    model, executor = Model(), None
    executor = Execute(model)
    actual, fallthrough = executor.run(body)
    expected = model.contract()
    claims = {
        'read bounds and loop termination': z3.And(*[c for _, c in executor.reads], *executor.loops),
        'exact error/success contract': actual == expected,
        'complete return coverage': z3.And(z3.Not(fallthrough), z3.PbEq([(g, 1) for g, _ in executor.returns], 1)),
    }
    return model, executor, actual, claims


def analyse(files):
    model, executor, actual, claims = evaluate(files)
    results = []
    for name, prop in claims.items():
        solve(model, z3.Not(prop), 'unsat')
        results.append({'name': name, 'result': 'unsat'})
    witnesses = []
    for code in (0, 19, 20, 21):
        witnesses.append({'return': code, 'counterexample': solve(model, z3.And(model.fields['active'] != 0, actual == code), 'sat')})
    # Pin a capability deliberately NOT checked here; the adapter must reject it.
    state_writable = z3.And(model.fields['active'] != 0, model.fields['meta_count'] == 1,
        model.at('meta_index', 0) == 0, model.at('meta_writable', 0) == 1, actual == 0)
    witnesses.append({'statement': 'helper alone accepts writable state meta; adapter guard remains required',
                      'counterexample': solve(model, state_writable, 'sat')})
    return {'claims': results, 'readObligations': len(executor.reads), 'loopObligations': len(executor.loops),
            'returnSitesUnrolled': len(executor.returns), 'witnesses': witnesses}


def replace_once(text, old, new):
    need(text.count(old) == 1, 'mutation target is not unique: ' + old)
    return text.replace(old, new)


def change_validator(source, old, new):
    start = source.index(SIGNATURE)
    end = source.index('static __attribute__', start)
    return source[:start] + replace_once(source[start:end], old, new) + source[end:]


def probes(files):
    # Mutate written source, then parse/execute that source afresh. No faulty
    # abstract model is substituted for the real mutated C artifact.
    semantic = [
        ('inactive guard omitted', 'if(!t->active) return 0;', ''),
        ('only active one executes', 'if(!t->active) return 0;', 'if(t->active!=1) return 0;'),
        ('target lower bound', 't->program<2', 't->program<1'),
        ('target upper bound', 't->program>=count', 't->program>count'),
        ('target executable', '!a[t->program].executable', 'a[t->program].executable'),
        ('target read before bounds', 't->program<2 || t->program>=count || !a[t->program].executable',
         '!a[t->program].executable || t->program<2 || t->program>=count'),
        ('self-validating target key', 'equal_key(a[t->program].key,t->program_key)', 'equal_key(t->program_key,t->program_key)'),
        ('payload length bound', 't->length>64', 't->length>65'),
        ('meta count bound', 't->count>8', 't->count>9'),
        ('payload bytes also zeroed', 'i=t->length', 'i=0'),
        ('last padding byte omitted', 'i<64', 'i<63'),
        ('padding predicate reversed', 'if(t->data[i])', 'if(!t->data[i])'),
        ('meta index bound', 'm->index>=count', 'm->index>count'),
        ('writable enum bound', 'm->writable>1', 'm->writable>2'),
        ('signer enum bound', 'm->signer>1', 'm->signer>2'),
        ('self-validating meta key', 'equal_key(a[m->index].key,m->key)', 'equal_key(m->key,m->key)'),
        ('meta read before bounds', 'm->index>=count || m->writable>1 || m->signer>1 || !equal_key(a[m->index].key,m->key)',
         '!equal_key(a[m->index].key,m->key) || m->index>=count || m->writable>1 || m->signer>1'),
        ('local meta pointer aliases slot zero', 'const BendInvokeMeta *m=&t->metas[i];', 'const BendInvokeMeta *m=&t->metas[0];'),
        ('writable escalation check', 'm->writable && !a[m->index].writable', 'm->writable && a[m->index].writable'),
        ('signer escalation check', 'm->signer && !a[m->index].signer', 'm->signer && a[m->index].signer'),
        ('custody exemption wrong index', 'm->index!=3', 'm->index!=2'),
        ('duplicate loop omitted', 'j<i', 'j<0'),
        ('duplicate predicate reversed', 't->metas[j].index==m->index', 't->metas[j].index!=m->index'),
        ('target error code', 'return 19;', 'return 21;'),
        ('length error code', 'if(t->length>64 || t->count>8) return 20;', 'if(t->length>64 || t->count>8) return 19;'),
        ('signer error code', 'm->index!=3) return 21;', 'm->index!=3) return 20;'),
        ('success before meta checks', 'for(unsigned i=0;i<t->count;++i)', 'return 0; for(unsigned i=0;i<t->count;++i)'),
    ]
    negative = []
    for name, old, new in semantic:
        changed = {**files, 'bend_cpi.h': change_validator(files['bend_cpi.h'], old, new)}
        model, executor, actual, claims = evaluate(changed)
        witness = solve(model, z3.Or(*[z3.Not(prop) for prop in claims.values()]), 'sat', claims)
        need(bool(witness['violated']), 'mutation needs a named failed claim')
        if name in ('target read before bounds', 'meta read before bounds'):
            need(witness['violated'] == ['read bounds and loop termination'], 'expected only a read-safety failure')
        negative.append({'name': name, 'kind': 'semantic', 'sha256': sha(changed['bend_cpi.h']), 'counterexample': witness})
    start = files['bend_cpi.h'].index(SIGNATURE)
    end = files['bend_cpi.h'].index('static __attribute__', start)
    reviewed = files['bend_cpi.h'][start:end].strip()
    actual = change_validator(files['bend_cpi.h'], 't->program>=count', 't->program>count')
    actual = actual.replace(SIGNATURE, SIGNATURE.replace('static inline', 'static  inline'))
    for name, decoy in [('comment definition decoy', '/* ' + reviewed + ' */\n'),
                        ('string definition decoy', 'static const char *bend_reviewed = "' + ' '.join(reviewed.split()) + '";\n')]:
        changed = {**files, 'bend_cpi.h': decoy + actual}
        model, _, _, claims = evaluate(changed)
        witness = solve(model, z3.Or(*[z3.Not(prop) for prop in claims.values()]), 'sat', claims)
        need(bool(witness['violated']), 'mutation needs a named failed claim')
        if name in ('target read before bounds', 'meta read before bounds'):
            need(witness['violated'] == ['read bounds and loop termination'], 'expected only a read-safety failure')
        negative.append({'name': name, 'kind': 'semantic', 'sha256': sha(changed['bend_cpi.h']), 'counterexample': witness})
    grammar = [
        ('write to local account count', 'bend_cpi.h', 'if(!t->active) return 0;', 'count = 0; if(!t->active) return 0;', 'write or unsupported statement'),
        ('write effect field', 'bend_cpi.h', 'if(!t->active) return 0;', 't->active = 0; if(!t->active) return 0;', 'syntax:'),
        ('loop decrement', 'bend_cpi.h', 'i=t->length;i<64;++i', 'i=t->length;i<64;--i', 'syntax:'),
        ('foreign function', 'bend_cpi.h', 'if(!t->active) return 0;', 'if(injected()) return 0; if(!t->active) return 0;', 'unsupported/effectful call'),
        ('key comparison truncated', 'solana_min.h', 'i < 32', 'i < 24', 'reviewed declaration'),
        ('include search changed', 'bend_cpi.h', '#include "cpi_abi.h"', '#include <cpi_abi.h>', 'include search form'),
        ('macro interference', 'bend_cpi.h', '#pragma once', '#pragma once\n#define active program', 'macros unsupported'),
    ]
    for filename in ('bend_cpi.h', 'cpi_abi.h', 'solana_min.h'):
        for spelling in ('__attribute__((overloadable))', '[[clang::overloadable]]'):
            injection = f'static inline {spelling} unsigned equal_key(u8 *a, const u8 *b) {{ (void)a; (void)b; return 1; }}'
            anchor = '#include "cpi_abi.h"' if filename == 'bend_cpi.h' else (
                '#include "solana_min.h"' if filename == 'cpi_abi.h' else 'extern void sol_set_return_data')
            replacement = anchor + '\n' + injection if filename != 'solana_min.h' else injection + '\n' + anchor
            grammar.append((f'overloaded key binding {spelling} in {filename}', filename,
                anchor, replacement, 'unsupported attribute or function overloading'))
    grammar.append(('duplicate key binding', 'cpi_abi.h', '#include "solana_min.h"',
        '#include "solana_min.h"\nstatic inline unsigned equal_key(const u8 *, const u8 *);', 'ambiguous file-scope binding'))
    for name, file, old, new, expected in grammar:
        changed = {**files, file: (change_validator(files[file], old, new)
            if file == 'bend_cpi.h' and not old.startswith('#') else replace_once(files[file], old, new))}
        try:
            evaluate(changed)
        except Grammar as error:
            need(expected in str(error), f'{name}: wrong rejection reason: {error}')
            negative.append({'name': name, 'kind': 'grammar', 'sha256': sha(changed[file]), 'reason': str(error)})
        else:
            raise AssertionError('faulty artifact accepted: ' + name)
    equivalent = []
    for name, old, new in [
        ('unsigned target lower bound', 't->program<2', 't->program<=1'),
        ('negated meta bound', 'm->index>=count', '!(m->index<count)'),
        ('explicit padding comparison', 'if(t->data[i])', 'if(t->data[i]!=0)'),
        ('unsigned length bound', 't->length>64', 't->length>=65'),
        ('unsigned inactive return', 'if(!t->active) return 0;', 'if(t->active==0u) { return 0u; }'),
    ]:
        changed = {**files, 'bend_cpi.h': change_validator(files['bend_cpi.h'], old, new)}
        model, _, _, claims = evaluate(changed)
        solve(model, z3.Or(*[z3.Not(prop) for prop in claims.values()]), 'unsat')
        equivalent.append({'name': name, 'sha256': sha(changed['bend_cpi.h']), 'result': 'unsat'})
    changed = {**files, 'bend_cpi.h': files['bend_cpi.h'].replace(SIGNATURE, SIGNATURE.replace('static inline', 'static  inline'))}
    model, _, _, claims = evaluate(changed)
    solve(model, z3.Or(*[z3.Not(prop) for prop in claims.values()]), 'unsat')
    equivalent.append({'name': 'signature whitespace', 'sha256': sha(changed['bend_cpi.h']), 'result': 'unsat'})
    return negative, equivalent


def main():
    need(z3.get_version_string() == '5.1.0', 'Expected Z3 5.1.0')
    output = ROOT / 'build/cpi-validator-refinement.json'
    output.parent.mkdir(exist_ok=True)
    output.unlink(missing_ok=True)
    recorded = {n: (ROOT / 'runtime' / n).read_bytes() for n in ('bend_cpi.h', 'cpi_abi.h', 'solana_min.h')}
    files = {n: content.decode('utf8') for n, content in recorded.items()}
    inputs = {**{'runtime/' + n: sha(content) for n, content in recorded.items()},
        **{str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in [pathlib.Path(__file__),
            ROOT / 'verification/adapter_contract_c.py', ROOT / 'verification/check-cpi-validator.ts']}}
    report = analyse(files)
    report["mutations"], report["equivalents"] = probes(files)
    report.update({'passed': True, 'z3': z3.get_version_string(), 'inputs': inputs,
        'scope': 'Restricted symbolic execution of runtime/bend_cpi.h bend_invoke_validate for account counts 4..12',
        'assumptions': ['Valid readable, aligned native effect, meta and account objects; keys address 32 readable bytes.',
            'u8/u32/u64 widths 8/32/64; arrays and native layouts match reviewed declarations.',
            'equal_key exact audited body plus exact memcpy semantics is summarized as equality of 32 bytes.',
            'Parser, bounded interpreter, dependency bridge and Z3 are trusted; not a verified C semantics.',
            'No interfering macros/layout controls from the including translation unit, earlier generated headers or compiler command line. '
            'The build resolves bend_cpi.h and its includes to these exact recorded runtime files. Compilation and SBF execution are not proved.'],
        'notClaimed': ['Custody PDA setup, executor or syscall behavior; mutation rollback; root/extraction semantics.',
            'Application authorization or writable managed-state exclusion; both are caller responsibilities.',
            'Safety for account counts outside 4..12 or invalid native pointers.']})
    for name, digest in inputs.items():
        need(sha((ROOT / name).read_bytes()) == digest, 'input changed while checking: ' + name)
    output.write_text(json.dumps(report, indent=2) + '\n')
    print(f'CPI validator: {len(report["claims"])} UNSAT claims, {report["readObligations"]} guarded read obligations, '
          f'{report["loopObligations"]} loop obligations, {len(report["witnesses"])} SAT witnesses, '
          f'{len(report["mutations"])} faulty artifacts rejected and {len(report["equivalents"])} equivalent variants; {output.relative_to(ROOT)}')


if __name__ == '__main__':
    try:
        main()
    except (Grammar, AssertionError, RuntimeError) as error:
        raise SystemExit('CPI validator check failed: ' + str(error))
