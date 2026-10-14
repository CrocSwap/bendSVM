"""Restricted symbolic execution of runtime/token.h's transfer validator.

This is a standalone check of the written helper and its two read-only byte/key
dependencies. It is not a composed adapter, executor, compiler, or SBF proof.
"""
import hashlib
import json
import pathlib
import re
from collections import Counter
from dataclasses import dataclass

import z3

from adapter_contract_c import (Grammar, IDENT, NUMBER, Parser, audited_header_tokens,
    has_file_scope_tokens, header_directives, header_tokens, literal, need, strict_tokens, TOKEN,
    unique_file_scope_name)

ROOT = pathlib.Path(__file__).resolve().parent.parent
SIGNATURE = 'static inline u64 bend_transfer_validate(const BendTransfer *t, Account *a, unsigned count)'
TRANSFER_DECL = '''typedef struct { u32 active, source, destination, mint, authority, recipient;
  u8 mint_key[32], recipient_key[32]; u64 amount;
  u32 initialize, source_bound, destination_bound, fresh_destination;
  u8 source_key[32], destination_key[32]; } BendTransfer;'''
ACCOUNT_DECL = '''typedef struct {
  const u8 *key;
  const u8 *owner;
  u8 *data;
  u64 size;
  u64 *lamports;
  u64 rent_epoch;
  unsigned signer, writable, executable;
} Account;'''
READ_LE_BODY = '''static inline u64 read_le(const u8 *p, unsigned n) {
  u64 v = 0;
  for (unsigned i = 0; i < n; ++i) v |= (u64)p[i] << (8 * i);
  return v;
}'''
EQUAL_KEY_BODY = '''static inline unsigned equal_key(const u8 *a, const u8 *b) {
  /* Account keys are public. Copy into scalars so unaligned pointers and
   * strict aliasing are safe; stop at the first differing eight-byte chunk. */
  for (unsigned i = 0; i < 32; i += 8) {
    u64 left, right;
    __builtin_memcpy(&left, a + i, 8);
    __builtin_memcpy(&right, b + i, 8);
    if (left != right) return 0;
  }
  return 1;
}'''
WIDTH_DECLS = [
    'typedef unsigned char u8;', 'typedef unsigned int u32;',
    'typedef unsigned long long u64;',
    '_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
]


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


def bv(value, bits=32):
    return z3.BitVecVal(value, bits)


def need_bv(value, bits, what):
    need(z3.is_bv(value) and value.size() == bits, f'validator: {what} must be U{bits}')


def as_bool(value):
    need(z3.is_bv(value), 'validator: condition is not an integer scalar')
    return value != bv(0, value.size())


def scalar(condition):
    return z3.If(condition, bv(1), bv(0))


def widen_pair(left, right):
    need(z3.is_bv(left) and z3.is_bv(right), 'validator: scalar comparison expected')
    width = max(left.size(), right.size())
    if left.size() < width:
        left = z3.ZeroExt(width - left.size(), left)
    if right.size() < width:
        right = z3.ZeroExt(width - right.size(), right)
    return left, right


def file_scope_definition(files, filename, declaration, what):
    live = audited_header_tokens(filename, files[filename])
    need(has_file_scope_tokens(live, header_tokens(declaration)),
         f'dependencies: live {what} definition in {filename}')


def scan_offsets(text):
    """Tokenize a header with source offsets; strings/comments stay opaque."""
    need(text.isascii() and '\r' not in text and '\\' not in text,
         'validator: unsupported source preprocessing characters')
    token_re = re.compile(TOKEN.pattern + r"|'[^'\\\n]*'")
    result, at = [], 0
    while at < len(text):
        match = token_re.match(text, at)
        need(match is not None, f'validator: unsupported header token near {text[at:at + 40]!r}')
        value = match.group()
        if value[0] not in ' \t\n' and not value.startswith(('/*', '//')):
            result.append((value, match.start(), match.end()))
        at = match.end()
    return result


def body_region(source):
    scanned = scan_offsets(source)
    words = [t[0] for t in scanned]
    signature = strict_tokens(SIGNATURE)
    starts = [i for i in range(len(words) - len(signature) + 1)
              if words[i:i + len(signature)] == signature]
    need(len(starts) == 1, 'validator: ambiguous or missing live signature')
    start = starts[0]
    opening = start + len(signature)
    need(opening < len(words) and words[opening] == '{', 'validator: missing function body')
    depth = 0
    close = None
    for i in range(opening, len(words)):
        if words[i] == '{':
            depth += 1
        elif words[i] == '}':
            depth -= 1
            if depth == 0:
                close = i
                break
    need(close is not None, 'validator: unterminated function body')
    return scanned[opening][1], scanned[close][2]


def helper(files):
    """Audit the exact live include closure, helper definitions and C body."""
    includes = {'token.h': ['cpi_abi.h'], 'cpi_abi.h': ['solana_min.h'], 'solana_min.h': []}
    headers = []
    for name, expected in includes.items():
        macros, children = header_directives(name, files[name])
        need(not macros, f'dependencies: macros unsupported in {name}')
        need(children == expected, f'dependencies: unexpected include closure in {name}')
        live = audited_header_tokens(name, files[name])
        headers.append(live)
        need(not any(token in live for token in ('_Alignas', 'alignas', '__alignas', '__alignas__')),
             f'dependencies: unsupported layout control in {name}')
        # `header_tokens` retains directive operands, and their exact quoted
        # spellings are checked in sequence after directive validation above.
        tokens = header_tokens(files[name])
        spellings = [tokens[i + 2] for i in range(len(tokens) - 2)
                     if tokens[i:i + 2] == ['#', 'include']]
        need(spellings == [f'"{child}"' for child in children],
             'dependencies: include search form')

    for name in ('equal_key', 'read_le'):
        unique_file_scope_name(headers, name)
    for declaration in WIDTH_DECLS:
        file_scope_definition(files, 'solana_min.h', declaration, 'width')
    file_scope_definition(files, 'solana_min.h', ACCOUNT_DECL, 'Account')
    file_scope_definition(files, 'solana_min.h', READ_LE_BODY, 'read_le')
    file_scope_definition(files, 'solana_min.h', EQUAL_KEY_BODY, 'equal_key')
    file_scope_definition(files, 'token.h', TRANSFER_DECL, 'BendTransfer')
    live = audited_header_tokens('token.h', files['token.h'])
    need(has_file_scope_tokens(live, header_tokens(SIGNATURE + ' {')),
         'validator: unique live file-scope signature')
    source = files['token.h']
    begin, end = body_region(source)
    parser = TokenParser(strict_tokens(source[begin:end]),
                         {'Account', 'BendTransfer', 'u8', 'u32', 'u64', 'unsigned'})
    body = parser.statement()
    need(body[0] == 'block' and parser.at == len(parser.t), 'validator: incomplete parsed body')
    return body


class TokenParser(Parser):
    """Shared restricted parser plus the C pointer-member token used here."""
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


@dataclass(frozen=True)
class Accounts:
    pass


@dataclass(frozen=True)
class Effect:
    pass


@dataclass(frozen=True)
class AccountRef:
    index: object
    pointer: bool = False


@dataclass(frozen=True)
class DataPtr:
    index: object
    offset: object


@dataclass(frozen=True)
class KeyValue:
    value: object


class Model:
    """Unconstrained native U32/U64 scalars and full account/data/key bytes."""
    U32_FIELDS = ['active', 'source', 'destination', 'mint', 'authority', 'recipient',
                  'initialize', 'source_bound', 'destination_bound', 'fresh_destination']

    def __init__(self):
        self.count = z3.BitVec('token_account_count', 32)
        self.fields = {name: z3.BitVec('transfer_' + name, 32) for name in self.U32_FIELDS}
        self.amount = z3.BitVec('transfer_amount', 64)
        self.native_keys = {name: z3.BitVec('transfer_' + name, 256)
                            for name in ('mint_key', 'recipient_key', 'source_key', 'destination_key')}
        self.account_keys = z3.Array('token_account_key', z3.BitVecSort(32), z3.BitVecSort(256))
        self.account_owners = z3.Array('token_account_owner', z3.BitVecSort(32), z3.BitVecSort(256))
        self.account_signer = z3.Array('token_account_signer', z3.BitVecSort(32), z3.BitVecSort(32))
        self.account_writable = z3.Array('token_account_writable', z3.BitVecSort(32), z3.BitVecSort(32))
        self.account_executable = z3.Array('token_account_executable', z3.BitVecSort(32), z3.BitVecSort(32))
        self.account_size = z3.Array('token_account_size', z3.BitVecSort(32), z3.BitVecSort(64))
        nested_bytes = z3.ArraySort(z3.BitVecSort(32), z3.BitVecSort(8))
        self.account_data = z3.Array('token_account_data', z3.BitVecSort(32), nested_bytes)
        self.pre = z3.And(z3.UGE(self.count, bv(4)), z3.ULE(self.count, bv(12)))

    def field(self, name):
        return self.fields[name]

    def data_byte(self, index, offset):
        return z3.Select(z3.Select(self.account_data, index), offset)

    def data_u(self, index, offset, n):
        # read_le's audited loop is a little-endian byte accumulator.
        bytes_ = [self.data_byte(index, offset + bv(i)) for i in range(n)]
        packed = z3.ZeroExt(56, bytes_[0]) if n == 1 else z3.Concat(*bytes_[::-1])
        return z3.ZeroExt(64 - 8 * n, packed) if packed.size() < 64 else packed

    def data_key(self, index, offset):
        return z3.Concat(*(self.data_byte(index, offset + bv(i)) for i in reversed(range(32))))

    def key(self, index):
        return z3.Select(self.account_keys, index)

    def owner(self, index):
        return z3.Select(self.account_owners, index)

    def writable(self, index):
        return z3.Select(self.account_writable, index)

    def signer(self, index):
        return z3.Select(self.account_signer, index)

    def executable(self, index):
        return z3.Select(self.account_executable, index)

    def size(self, index):
        return z3.Select(self.account_size, index)

    def contract(self):
        """Independent, ordered error/success contract for the actual helper."""
        f, count = self.fields, self.count
        active, mint_i = f['active'], f['mint']
        mint_owner = z3.Or(self.owner(mint_i) != self.key(bv(2)),
                           self.executable(mint_i) != bv(0))
        mint_bytes = z3.Or(self.size(mint_i) != bv(82, 64),
                           self.data_byte(mint_i, bv(45)) != bv(1, 8))
        mint_key = self.key(mint_i) != self.native_keys['mint_key']

        issue = z3.Or(active == bv(3), active == bv(4))
        issue_i = z3.If(active == bv(3), f['destination'], f['source'])
        issue_mint_policy = z3.Or(
            self.data_u(mint_i, bv(0), 4) != bv(1, 64),
            self.data_key(mint_i, bv(4)) != self.key(bv(3)),
            self.data_u(mint_i, bv(46), 4) != bv(0, 64))
        issue_supply = z3.And(active == bv(3), f['initialize'] != bv(0),
                              self.data_u(mint_i, bv(36), 8) != bv(0, 64))
        issue_index = z3.Or(z3.ULT(issue_i, bv(4)), z3.UGE(issue_i, count), issue_i == mint_i)
        issue_token_owner = z3.Or(self.owner(issue_i) != self.key(bv(2)),
                                  self.executable(issue_i) != bv(0))
        issue_token_bytes = z3.Or(
            self.size(issue_i) != bv(165, 64),
            z3.And(self.data_byte(issue_i, bv(108)) != bv(1, 8),
                   self.data_byte(issue_i, bv(108)) != bv(2, 8)),
            self.data_u(issue_i, bv(109), 4) != bv(0, 64))
        issue_token_mint = self.data_key(issue_i, bv(0)) != self.key(mint_i)
        burn_signer_or_authority = z3.Or(
            self.signer(bv(1)) == bv(0),
            self.data_key(issue_i, bv(32)) != self.key(bv(1)))
        issue_recipient_bad = z3.Or(z3.UGT(f['recipient'], bv(2)), z3.UGT(f['initialize'], bv(1)))
        issue_recipient = z3.If(f['recipient'] == bv(2), self.native_keys['recipient_key'],
                                self.key(z3.If(f['recipient'] != bv(0), bv(3), bv(1))))
        issue_recipient_mismatch = self.data_key(issue_i, bv(32)) != issue_recipient
        issue_return = self.first_error([
            (z3.Not(self.writable(mint_i) != bv(0)), 5),
            (issue_mint_policy, 23),
            (issue_supply, 24),
            (issue_index, 12),
            (self.writable(issue_i) == bv(0), 5),
            (issue_token_owner, 13),
            (issue_token_bytes, 14),
            (issue_token_mint, 15),
            (z3.And(active == bv(4), burn_signer_or_authority), 16),
            (z3.And(active == bv(3), issue_recipient_bad), 9),
            (z3.And(active == bv(3), issue_recipient_mismatch), 17),
        ])

        src_i, dst_i = f['source'], f['destination']
        transfer_index = z3.Or(z3.ULT(src_i, bv(4)), z3.ULT(dst_i, bv(4)),
            z3.UGE(src_i, count), z3.UGE(dst_i, count), src_i == dst_i,
            src_i == mint_i, dst_i == mint_i)
        transfer_policy = z3.Or(self.owner(src_i) != self.key(bv(2)),
            self.owner(dst_i) != self.key(bv(2)), self.owner(mint_i) != self.key(bv(2)),
            self.executable(src_i) != bv(0), self.executable(dst_i) != bv(0),
            self.executable(mint_i) != bv(0))
        transfer_bytes = z3.Or(self.size(src_i) != bv(165, 64),
            self.size(dst_i) != bv(165, 64), self.size(mint_i) != bv(82, 64),
            self.data_byte(mint_i, bv(45)) != bv(1, 8),
            z3.And(self.data_byte(src_i, bv(108)) != bv(1, 8), self.data_byte(src_i, bv(108)) != bv(2, 8)),
            z3.And(self.data_byte(dst_i, bv(108)) != bv(1, 8), self.data_byte(dst_i, bv(108)) != bv(2, 8)),
            self.data_u(src_i, bv(109), 4) != bv(0, 64),
            self.data_u(dst_i, bv(109), 4) != bv(0, 64))
        transfer_mint_keys = z3.Or(self.key(mint_i) != self.native_keys['mint_key'],
            self.data_key(src_i, bv(0)) != self.key(mint_i),
            self.data_key(dst_i, bv(0)) != self.key(mint_i))
        transfer_bound_flags = z3.Or(z3.UGT(f['source_bound'], bv(1)),
            z3.UGT(f['destination_bound'], bv(1)), z3.UGT(f['fresh_destination'], bv(1)))
        transfer_bound_keys = z3.Or(
            z3.And(f['source_bound'] != bv(0), self.key(src_i) != self.native_keys['source_key']),
            z3.And(f['destination_bound'] != bv(0), self.key(dst_i) != self.native_keys['destination_key']))
        transfer_fresh = z3.And(f['fresh_destination'] != bv(0), z3.Or(
            self.data_u(dst_i, bv(64), 8) != bv(0, 64),
            self.data_u(dst_i, bv(72), 4) != bv(0, 64),
            self.data_u(dst_i, bv(129), 4) != bv(0, 64),
            self.data_key(dst_i, bv(32)) != self.key(bv(3))))
        transfer_auth_bad = z3.Or(z3.UGT(f['authority'], bv(1)), z3.UGT(f['recipient'], bv(2)))
        authority_key = self.key(z3.If(f['authority'] != bv(0), bv(3), bv(1)))
        transfer_authority = z3.Or(
            z3.And(f['authority'] == bv(0), self.signer(bv(1)) == bv(0)),
            self.data_key(src_i, bv(32)) != authority_key)
        transfer_recipient = z3.If(f['recipient'] == bv(2), self.native_keys['recipient_key'],
                                   self.key(z3.If(f['recipient'] != bv(0), bv(3), bv(1))))
        transfer_recipient_bad = self.data_key(dst_i, bv(32)) != transfer_recipient
        transfer_return = self.first_error([
            (transfer_index, 12),
            (z3.Or(self.writable(src_i) == bv(0), self.writable(dst_i) == bv(0)), 5),
            (transfer_policy, 13),
            (transfer_bytes, 14),
            (transfer_mint_keys, 15),
            (transfer_bound_flags, 9),
            (transfer_bound_keys, 25),
            (transfer_fresh, 26),
            (transfer_auth_bad, 9),
            (transfer_authority, 16),
            (transfer_recipient_bad, 17),
        ])

        mint_result = z3.If(active == bv(2), bv(0, 64),
            z3.If(issue, issue_return,
                z3.If(active == bv(1), transfer_return, bv(9, 64))))
        return z3.If(active == bv(0), bv(0, 64),
            self.first_error([
                (z3.Or(z3.ULT(mint_i, bv(4)), z3.UGE(mint_i, count)), 12),
                (mint_owner, 13),
                (mint_bytes, 14),
                (mint_key, 15),
            ], default=mint_result))

    @staticmethod
    def first_error(cases, default=0):
        result = default if z3.is_bv(default) else bv(default, 64)
        need_bv(result, 64, 'contract return width')
        for condition, code in reversed(cases):
            result = z3.If(condition, bv(code, 64), result)
        return result


class Execute:
    """Fail-closed read-only interpreter for the validator's bounded C subset."""
    def __init__(self, model):
        self.m = model
        self.reads, self.returns = [], []
        self.helper_calls, self.read_le_lengths = Counter(), set()
        self.steps = 0

    def obligation(self, path, condition, label):
        self.reads.append((label, z3.Implies(path, condition)))

    def data_span(self, ptr, length, path, label):
        need_bv(ptr.offset, 32, 'data pointer offset')
        offset64 = z3.ZeroExt(32, ptr.offset)
        self.obligation(path, z3.ULE(offset64 + bv(length, 64), self.m.size(ptr.index)),
                        f'{label}: data span {length} within account size')

    def expression(self, node, env, path):
        kind = node[0]
        if kind == 'num':
            need(node[2] in ('int', 'u32', 'u64'), 'validator: unsupported integer literal')
            return bv(node[1], 64 if node[2] == 'u64' else 32)
        if kind == 'id':
            need(node[1] in env, 'validator: unknown or uninitialized identifier')
            return env[node[1]]
        if kind == 'not':
            return scalar(z3.Not(as_bool(self.expression(node[1], env, path))))
        if kind in ('land', 'lor'):
            left = as_bool(self.expression(node[1], env, path))
            right_path = z3.And(path, left if kind == 'land' else z3.Not(left))
            right = as_bool(self.expression(node[2], env, right_path))
            return scalar(z3.And(left, right) if kind == 'land' else z3.Or(left, right))
        if kind == 'cond':
            condition = as_bool(self.expression(node[1], env, path))
            yes = self.expression(node[2], env, z3.And(path, condition))
            no = self.expression(node[3], env, z3.And(path, z3.Not(condition)))
            return self.select_value(condition, yes, no)
        if kind == 'bin':
            op = node[1]
            left = self.expression(node[2], env, path)
            right = self.expression(node[3], env, path)
            if op == '+' and isinstance(left, DataPtr):
                need_bv(right, 32, 'pointer increment')
                new_offset = left.offset + right
                no_wrap = z3.And(z3.ULE(left.offset, new_offset), z3.ULE(right, new_offset))
                self.obligation(path, no_wrap, 'data pointer addition does not wrap')
                return DataPtr(left.index, new_offset)
            need(z3.is_bv(left) and z3.is_bv(right), 'validator: unsupported pointer/scalar operation')
            left, right = widen_pair(left, right)
            operators = {'==': lambda: left == right, '!=': lambda: left != right,
                '<': lambda: z3.ULT(left, right), '>': lambda: z3.UGT(left, right),
                '<=': lambda: z3.ULE(left, right), '>=': lambda: z3.UGE(left, right)}
            need(op in operators, 'validator: unsupported scalar binary operator')
            return scalar(operators[op]())
        if kind == 'index':
            base = self.expression(node[1], env, path)
            index = self.expression(node[2], env, path)
            if isinstance(base, Accounts):
                need_bv(index, 32, 'account array index')
                self.obligation(path, z3.ULT(index, self.m.count), 'account index within caller count')
                return AccountRef(index)
            if isinstance(base, DataPtr):
                need_bv(index, 32, 'data array index')
                offset = base.offset + index
                no_wrap = z3.And(z3.ULE(base.offset, offset), z3.ULE(index, offset))
                self.obligation(path, no_wrap, 'data index addition does not wrap')
                ptr = DataPtr(base.index, offset)
                self.data_span(ptr, 1, path, 'byte load')
                return z3.ZeroExt(24, self.m.data_byte(ptr.index, ptr.offset))
            raise Grammar('validator: unsupported indexed object')
        if kind == 'addr':
            value = self.expression(node[1], env, path)
            need(isinstance(value, AccountRef) and not value.pointer,
                 'validator: unsupported address formation')
            return AccountRef(value.index, True)
        if kind in ('arrow', 'member'):
            base = self.expression(node[1], env, path)
            field = node[2]
            if kind == 'arrow' and isinstance(base, Effect):
                if field in self.m.fields:
                    return self.m.field(field)
                if field == 'amount':
                    return self.m.amount
                if field in self.m.native_keys:
                    return KeyValue(self.m.native_keys[field])
                need(False, 'validator: unknown BendTransfer member')
            need(isinstance(base, AccountRef) and base.pointer == (kind == 'arrow'),
                 'validator: member/pointer mismatch')
            self.obligation(path, z3.ULT(base.index, self.m.count), 'account field read within caller count')
            if field == 'data':
                return DataPtr(base.index, bv(0))
            if field == 'size':
                return self.m.size(base.index)
            if field == 'key':
                return KeyValue(self.m.key(base.index))
            if field == 'owner':
                return KeyValue(self.m.owner(base.index))
            if field == 'signer':
                return self.m.signer(base.index)
            if field == 'writable':
                return self.m.writable(base.index)
            if field == 'executable':
                return self.m.executable(base.index)
            raise Grammar('validator: unknown Account member ' + field)
        if kind == 'call':
            name = node[1]
            args = [self.expression(x, env, path) for x in node[2]]
            if name == 'read_le' and len(args) == 2:
                ptr, length = args
                need(isinstance(ptr, DataPtr), 'validator: read_le pointer is not account data')
                need_bv(length, 32, 'read_le length')
                need(z3.is_bv_value(length) and 1 <= length.as_long() <= 8,
                     'validator: read_le requires a constant length in 1..8')
                n = length.as_long()
                self.helper_calls['read_le'] += 1
                self.read_le_lengths.add(n)
                self.data_span(ptr, n, path, 'read_le')
                return self.m.data_u(ptr.index, ptr.offset, n)
            if name == 'equal_key' and len(args) == 2:
                self.helper_calls['equal_key'] += 1
                values = []
                for arg in args:
                    if isinstance(arg, DataPtr):
                        self.data_span(arg, 32, path, 'equal_key')
                        values.append(self.m.data_key(arg.index, arg.offset))
                    elif isinstance(arg, KeyValue):
                        values.append(arg.value)
                    else:
                        raise Grammar('validator: equal_key argument is not a reviewed key span')
                need_bv(values[0], 256, 'key width')
                need_bv(values[1], 256, 'key width')
                return scalar(values[0] == values[1])
            raise Grammar('validator: unsupported or effectful call ' + name)
        raise Grammar('validator: unsupported expression ' + kind)

    @staticmethod
    def select_value(condition, yes, no):
        if z3.is_bv(yes) and z3.is_bv(no):
            yes, no = widen_pair(yes, no)
            return z3.If(condition, yes, no)
        if isinstance(yes, KeyValue) and isinstance(no, KeyValue):
            return KeyValue(z3.If(condition, yes.value, no.value))
        if isinstance(yes, AccountRef) and isinstance(no, AccountRef):
            need(yes.pointer and no.pointer, 'validator: conditional account values unsupported')
            return AccountRef(z3.If(condition, yes.index, no.index), True)
        if isinstance(yes, DataPtr) and isinstance(no, DataPtr):
            need(z3.eq(yes.index, no.index), 'validator: conditional data pointers have different accounts')
            return DataPtr(yes.index, z3.If(condition, yes.offset, no.offset))
        raise Grammar('validator: incompatible conditional expression values')

    def statement(self, node, env, path, depth=0):
        self.steps += 1
        need(self.steps <= 5000 and depth <= 8, 'validator: execution bound exceeded')
        kind = node[0]
        if kind == 'block':
            local, live = dict(env), path
            for child in node[1]:
                live = self.statement(child, local, live, depth)
            return live
        if kind == 'if':
            condition = as_bool(self.expression(node[1], env, path))
            yes = self.statement(node[2], dict(env), z3.And(path, condition), depth + 1)
            no = (self.statement(node[3], dict(env), z3.And(path, z3.Not(condition)), depth + 1)
                  if node[3] else z3.And(path, z3.Not(condition)))
            return z3.Or(yes, no)
        if kind == 'return':
            value = self.expression(node[1], env, path)
            need(z3.is_bv(value) and value.size() in (32, 64), 'validator: unsupported return value')
            self.returns.append((path, z3.ZeroExt(64 - value.size(), value)))
            return z3.BoolVal(False)
        if kind in ('decl', 'decls'):
            declarations = [node] if kind == 'decl' else node[1]
            for _, ctype, const, pointer, name, size, init in declarations:
                need(size is None and init is not None and init[0] == 'expr',
                     'validator: declaration must have one initialized scalar/pointer')
                need((ctype, pointer) in (('Account', True), ('u8', True), ('unsigned', False)),
                     'validator: unsupported local declaration type')
                need(name not in env, 'validator: shadowing/uninitialized declaration')
                value = self.expression(init[1], env, path)
                if ctype == 'Account':
                    need(isinstance(value, AccountRef) and value.pointer,
                         'validator: Account pointer initializer mismatch')
                elif ctype == 'unsigned':
                    need(not const and z3.is_bv(value) and value.size() == 32,
                         'validator: U32 scalar initializer mismatch')
                else:
                    need(const and isinstance(value, KeyValue), 'validator: u8 pointer initializer mismatch')
                env[name] = value
            return path
        if kind == 'expr':
            # No effectful calls are permitted by expression(); the real helper
            # has no standalone call statements, so reject even a pure one.
            raise Grammar('validator: unsupported expression statement')
        if kind == 'assign':
            raise Grammar('validator: write or unsupported statement assign')
        if kind == 'for':
            raise Grammar('validator: unsupported loop statement')
        raise Grammar('validator: unsupported statement ' + kind)

    def run(self, body):
        fallthrough = self.statement(body,
            {'t': Effect(), 'a': Accounts(), 'count': self.m.count}, z3.BoolVal(True))
        result = bv(0, 64)
        for guard, code in reversed(self.returns):
            result = z3.If(guard, code, result)
        return result, fallthrough


def evaluate(files):
    body = helper(files)
    model = Model()
    executor = Execute(model)
    actual, fallthrough = executor.run(body)
    expected = model.contract()
    claims = {
        'account and data read bounds': z3.And(*[claim for _, claim in executor.reads]),
        'exact error/success contract': actual == expected,
        'complete return coverage': z3.And(z3.Not(fallthrough),
            z3.PbEq([(guard, 1) for guard, _ in executor.returns], 1)),
    }
    return model, executor, actual, claims


def solve(model, expression, wanted, project=None):
    solver = z3.Solver()
    solver.set(timeout=30000)
    solver.add(model.pre, expression)
    result = solver.check()
    if result == z3.unknown:
        raise RuntimeError('Z3 unknown: ' + solver.reason_unknown())
    if str(result) != wanted:
        raise AssertionError(f'expected {wanted}, got {result}')
    if result != z3.sat:
        return None
    sm = solver.model()
    witness = {
        'account_count': sm.eval(model.count, model_completion=True).as_long(),
        'native': {name: sm.eval(value, model_completion=True).as_long()
                   for name, value in model.fields.items()},
        'amount': sm.eval(model.amount, model_completion=True).as_long(),
        'smtModel': str(sm),
    }
    if project:
        witness.update(project(sm))
    return witness


def analyse(files):
    model, executor, actual, claims = evaluate(files)
    results = []
    for name, proposition in claims.items():
        solve(model, z3.Not(proposition), 'unsat')
        results.append({'name': name, 'result': 'unsat'})
    witnesses = []
    for active in (0, 1, 2, 3, 4):
        witness = solve(model, z3.And(model.field('active') == bv(active), actual == bv(0, 64)), 'sat')
        need(witness is not None, f'missing SAT success witness for active kind {active}')
        witnesses.append({'scenario': f'active {active} success', 'return': 0, 'counterexample': witness})
    for code in (5, 9, 12, 13, 14, 15, 16, 17, 23, 24, 25, 26):
        active = z3.And(model.field('active') != bv(0), actual == bv(code, 64))
        witness = solve(model, active, 'sat')
        need(witness is not None, f'missing SAT witness for error {code}')
        witnesses.append({'scenario': f'active effect returns error {code}', 'return': code,
                          'counterexample': witness})
    # Active mint and burn validation ignores the native authority selector;
    # the extraction/executor path is responsible for selecting the signer.
    for active in (3, 4):
        witness = solve(model, z3.And(model.field('active') == bv(active),
            model.field('authority') == bv(0xffffffff), actual == bv(0, 64)), 'sat')
        need(witness is not None, f'active {active} did not accept noncanonical authority')
        witnesses.append({'scenario': f'active {active} accepts U32_MAX authority; executor relies on extraction',
                          'return': 0, 'counterexample': witness})
    return {'claims': results, 'readObligations': len(executor.reads),
            'readObligationsByKind': dict(sorted(Counter(label.split(':')[0]
                for label, _ in executor.reads).items())),
            'helperCallSites': dict(sorted(executor.helper_calls.items())),
            'readLeLengths': sorted(executor.read_le_lengths), 'loopObligations': 0,
            'helperLoopBounds': {'read_le': 'audited loop reads indices 0..n-1; actual call lengths are recorded above',
                                 'equal_key': 'audited loop reads four 8-byte chunks at offsets 0, 8, 16, 24'},
            'returnSites': len(executor.returns), 'witnesses': witnesses}


def replace_once(text, old, new):
    need(text.count(old) == 1, 'mutation target is not unique: ' + old)
    return text.replace(old, new)


def change_validator(source, old, new):
    begin, end = body_region(source)
    changed = replace_once(source[begin:end], old, new)
    return source[:begin] + changed + source[end:]


def semantic_probe(files, name, changed_source, expected_claim=None, exact_only=False):
    changed = {**files, 'token.h': changed_source}
    model, _, _, claims = evaluate(changed)  # parse and re-execute changed C, always
    failed = z3.Or(*[z3.Not(value) for value in claims.values()])
    witness = solve(model, failed, 'sat', project=lambda sm: {
        'violated': [claim for claim, proposition in claims.items()
                     if z3.is_false(sm.eval(proposition, model_completion=True))]})
    need(witness and witness['violated'], 'semantic mutation has no named counterexample: ' + name)
    if expected_claim:
        need(expected_claim in witness['violated'],
             f'{name}: expected failed claim {expected_claim}, got {witness["violated"]}')
    if exact_only:
        solve(model, z3.Not(claims['exact error/success contract']), 'unsat')
        need(witness['violated'] == ['account and data read bounds'],
             f'{name}: read-only mutation also changed the return/completeness claims')
    return {'name': name, 'kind': 'semantic', 'sha256': sha(changed_source), 'counterexample': witness}


def probes(files):
    source = files['token.h']
    semantic = [
        ('inactive guard omitted', 'if (!t->active) return 0;', ''),
        ('active 2 early success omitted', 'if (t->active == 2) return 0;', ''),
        ('mint lower bound', 't->mint < 4', 't->mint < 3'),
        ('mint upper bound', 't->mint >= count', 't->mint > count'),
        ('mint owner restriction', 'if (!equal_key(mint->owner,a[2].key) || mint->executable) return 13;',
         'if (equal_key(mint->owner,a[2].key) || mint->executable) return 13;'),
        ('mint executable restriction',
         'if (!equal_key(mint->owner,a[2].key) || mint->executable) return 13;',
         'if (!equal_key(mint->owner,a[2].key)) return 13;'),
        ('mint size check', 'if (mint->size != 82 || mint->data[45] != 1) return 14;',
         'if (mint->size != 81 || mint->data[45] != 1) return 14;'),
        ('mint initialized flag', 'if (mint->size != 82 || mint->data[45] != 1) return 14;',
         'if (mint->size != 82 || mint->data[45] != 2) return 14;'),
        ('mint key binding', 'if (!equal_key(mint->key,t->mint_key)) return 15;',
         'if (equal_key(mint->key,t->mint_key)) return 15;'),
        ('active kind validation', 'if (t->active != 1) return 9;', 'if (t->active == 1) return 9;'),
        ('mint authority tag', 'read_le(mint->data,4) != 1', 'read_le(mint->data,4) != 0'),
        ('mint authority key', '!equal_key(mint->data+4,a[3].key)', 'equal_key(mint->data+4,a[3].key)'),
        ('freeze authority tag', 'read_le(mint->data+46,4) != 0', 'read_le(mint->data+46,4) != 1'),
        ('initialize supply restriction', 'read_le(mint->data+36,8) != 0', 'read_le(mint->data+36,8) == 0'),
        ('issue token index excludes mint', 'index == t->mint', 'index != t->mint'),
        ('token writable guard', 'if (!token->writable) return 5;', ''),
        ('token owner restriction', '!equal_key(token->owner,a[2].key)', 'equal_key(token->owner,a[2].key)'),
        ('token state initialized or frozen', 'token->data[108] != 1 && token->data[108] != 2', 'token->data[108] != 1'),
        ('token native-option tag', 'read_le(token->data+109,4) != 0', 'read_le(token->data+109,4) != 1'),
        ('token mint binding', '!equal_key(token->data,mint->key)', 'equal_key(token->data,mint->key)'),
        ('burn actor signer',
         'if (!a[1].signer || !equal_key(token->data+32,a[1].key)) return 16;',
         'if (!equal_key(token->data+32,a[1].key)) return 16;'),
        ('mint recipient bounds', 't->recipient > 2 || t->initialize > 1', 't->recipient > 2'),
        ('transfer source destination alias', 't->source == t->destination', 't->source != t->destination'),
        ('transfer writable guard', 'if (!src->writable || !dst->writable) return 5;', ''),
        ('transfer source key bound', 't->source_bound && !equal_key(src->key,t->source_key)', 't->source_bound && equal_key(src->key,t->source_key)'),
        ('fresh destination balance', 'read_le(dst->data+64,8) != 0', 'read_le(dst->data+64,8) == 0'),
        ('authority selector bound', 't->authority > 1 || t->recipient > 2', 't->authority > 1'),
        ('recipient key binding', '!equal_key(dst->data+32,recipient)', 'equal_key(dst->data+32,recipient)'),
        ('error precedence code', 'if (!mint->writable) return 5;', 'if (!mint->writable) return 15;'),
    ]
    negative = []
    for name, old, new in semantic:
        mutated = change_validator(source, old, new)
        negative.append(semantic_probe(files, name, mutated,
            expected_claim='exact error/success contract'))

    # These two source mutations preserve the return expression over all
    # abstract inputs but move a read before its size guard. They must fail the
    # independent memory claim alone, proving the gate does not infer safety
    # from return-code equivalence.
    byte_reorder = change_validator(source,
        'if (mint->size != 82 || mint->data[45] != 1) return 14;',
        'if (mint->data[45] != 1 || mint->size != 82) return 14;')
    negative.append(semantic_probe(files, 'mint data byte before size guard', byte_reorder,
        expected_claim='account and data read bounds', exact_only=True))
    readle_old = ('token->size != 165 || (token->data[108] != 1 && token->data[108] != 2) ||\n'
                  '        read_le(token->data+109,4) != 0')
    readle_new = ('read_le(token->data+109,4) != 0 || token->size != 165 || '
                  '(token->data[108] != 1 && token->data[108] != 2)')
    readle_reorder = change_validator(source, readle_old, readle_new)
    negative.append(semantic_probe(files, 'read_le before token size guard', readle_reorder,
        expected_claim='account and data read bounds', exact_only=True))
    equal_key_oob = change_validator(source,
        '!equal_key(token->data,mint->key)', '!equal_key(token->data+134,mint->key)')
    negative.append(semantic_probe(files, 'equal_key 32-byte data span exceeds account size', equal_key_oob,
        expected_claim='account and data read bounds'))

    # Comment and string decoys carry a faulty body; lexical binding must still
    # select and execute the live definition below them.
    begin, end = body_region(source)
    start_sig = source.index(SIGNATURE)
    live_definition = source[start_sig:end].strip()
    decoy_mutation = change_validator(source, 't->mint >= count', 't->mint > count')
    for name, prefix in [
        ('comment definition decoy', '/* ' + re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', '', live_definition) + ' */\n'),
        ('string definition decoy', 'static const char *bend_decoy = "' +
            ' '.join(live_definition.split()) + '";\n'),
    ]:
        negative.append(semantic_probe({**files, 'token.h': prefix + source}, name,
            prefix + decoy_mutation, expected_claim='exact error/success contract'))

    grammar_probes = [
        ('validator write', 'token.h', 'if (!t->active) return 0;',
         'count = 0; if (!t->active) return 0;', 'write or unsupported statement'),
        ('foreign call', 'token.h', 'if (!t->active) return 0;',
         'if (injected()) return 0; if (!t->active) return 0;', 'unsupported or effectful call'),
        ('read_le dependency mutation', 'solana_min.h', 'v |= (u64)p[i] << (8 * i);',
         'v |= (u32)p[i] << (8 * i);', 'live read_le definition'),
        ('equal_key dependency mutation', 'solana_min.h', 'i < 32', 'i < 24', 'live equal_key definition'),
        ('standard alignment control', 'token.h', 'u32 active, source, destination, mint, authority, recipient;',
         '_Alignas(16) u32 active, source, destination, mint, authority, recipient;', 'unsupported layout control'),
        ('include search form', 'token.h', '#include "cpi_abi.h"',
         '#include <cpi_abi.h>', 'include search form'),
        ('macro interference', 'token.h', '#pragma once', '#pragma once\n#define active mint',
         'macros unsupported'),
    ]
    for filename in ('token.h', 'cpi_abi.h', 'solana_min.h'):
        for spelling in ('__attribute__((overloadable))', '[[clang::overloadable]]'):
            for function, declaration in (
                ('equal_key', 'unsigned equal_key(u8 *a, const u8 *b) { (void)a; (void)b; return 1; }'),
                ('read_le', 'u64 read_le(u8 *p, unsigned n) { (void)p; (void)n; return 0; }')):
                injection = f'static inline {spelling} {declaration}'
                # Append after the dependency include, so the reproduction is valid C.
                anchor = '#include "cpi_abi.h"' if filename == 'token.h' else (
                    '#include "solana_min.h"' if filename == 'cpi_abi.h' else 'extern void sol_set_return_data')
                replacement = anchor + '\n' + injection if filename != 'solana_min.h' else injection + '\n' + anchor
                grammar_probes.append((f'{function} overload {spelling} in {filename}', filename,
                    anchor, replacement, 'unsupported attribute or function overloading'))
    for function, prototype in (('equal_key', 'static inline unsigned equal_key(const u8 *, const u8 *);'),
                                 ('read_le', 'static inline u64 read_le(const u8 *, unsigned);')):
        grammar_probes.append((function + ' duplicate binding', 'cpi_abi.h', '#include "solana_min.h"',
            '#include "solana_min.h"\n' + prototype, 'ambiguous file-scope binding'))
    for name, old, new, reason in [
        ('struct as pointer', 'Account *mint = &a[t->mint];', 'Account *mint = a[t->mint];', 'initializer mismatch'),
        ('arrow on struct', 'if (!equal_key(mint->key,t->mint_key)) return 15;', 'if (!equal_key(a[t->mint]->key,t->mint_key)) return 15;', 'member/pointer mismatch'),
        ('dot on pointer', 'if (!equal_key(mint->key,t->mint_key)) return 15;', 'if (!equal_key(mint.key,t->mint_key)) return 15;', 'member/pointer mismatch'),
        ('address of pointer', 'Account *token = &a[index];', 'Account *token = &a[index]; Account *alias = &token;', 'address formation'),
        ('address of address', 'Account *mint = &a[t->mint];', 'Account *mint = &(&a[t->mint]);', 'address formation'),
    ]:
        grammar_probes.append((name, 'token.h', old, new, reason))
    for name, filename, old, new, expected in grammar_probes:
        changed_files = dict(files)
        changed_files[filename] = replace_once(changed_files[filename], old, new)
        try:
            evaluate(changed_files)
        except Grammar as error:
            need(expected in str(error), f'{name}: wrong fail-closed reason: {error}')
            negative.append({'name': name, 'kind': 'grammar', 'sha256': sha(changed_files[filename]),
                             'reason': str(error)})
        else:
            raise AssertionError('faulty artifact accepted: ' + name)

    equivalents = []
    for name, old, new in [
        ('unsigned mint lower bound', 't->mint < 4', 't->mint <= 3'),
        ('negated unsigned mint upper bound', 't->mint >= count', '!(t->mint < count)'),
        ('explicit inactive comparison', 'if (!t->active) return 0;', 'if (t->active == 0u) return 0u;'),
        ('explicit byte status comparison', 'token->data[108] != 1', '!(token->data[108] == 1)'),
        ('unsigned exact size spelling', 'if (mint->size != 82 || mint->data[45] != 1) return 14;',
         'if (mint->size >= 83 || mint->size <= 81 || mint->data[45] != 1) return 14;'),
    ]:
        mutated = change_validator(source, old, new)
        model, _, _, claims = evaluate({**files, 'token.h': mutated})
        solve(model, z3.Or(*[z3.Not(value) for value in claims.values()]), 'unsat')
        equivalents.append({'name': name, 'sha256': sha(mutated), 'result': 'unsat'})
    return negative, equivalents


def main():
    output = ROOT / 'build/token-validator-refinement.json'
    pending = output.with_suffix(output.suffix + '.pending')
    output.parent.mkdir(exist_ok=True)
    output.unlink(missing_ok=True)
    pending.unlink(missing_ok=True)
    try:
        need(z3.get_version_string() == '5.1.0', 'Expected Z3 5.1.0')
        names = ('token.h', 'cpi_abi.h', 'solana_min.h')
        recorded = {name: (ROOT / 'runtime' / name).read_bytes() for name in names}
        files = {name: value.decode('utf8') for name, value in recorded.items()}
        checker_files = [pathlib.Path(__file__), ROOT / 'verification/adapter_contract_c.py',
                         ROOT / 'verification/check-token-validator.ts']
        input_bytes = {str((ROOT / 'runtime' / name).relative_to(ROOT)): content
                       for name, content in recorded.items()}
        input_bytes.update({str(p.relative_to(ROOT)): p.read_bytes() for p in checker_files})
        inputs = {name: sha(content) for name, content in input_bytes.items()}

        report = analyse(files)
        report['mutations'], report['equivalents'] = probes(files)
        report.update({
            'passed': True,
            'z3': z3.get_version_string(),
            'inputs': inputs,
            'scope': 'Restricted symbolic execution of runtime/token.h bend_transfer_validate for count 4..12',
            'assumptions': [
                'Caller supplies 4..12 valid, naturally aligned BendTransfer and Account native objects; key pointers address 32 readable bytes; Account data pointers address each declared size. All BendTransfer U32 fields, Account U32 flags/indexes, U64 amounts/sizes and data/key bytes are otherwise unconstrained.',
                'Audited declarations provide u8/u32/u64 widths 8/32/64, BendTransfer fields and Account fields. Natural C layout and valid native pointer formation are assumed; this check does not derive compiler offsets or loader provenance.',
                'The live read_le definition is the audited unsigned little-endian loop; the live equal_key definition checks four 8-byte chunks and returns equality iff all 32 bytes match. memcpy copies exactly eight bytes. Their loop and memcpy semantics are summarized, not compiled or interpreted as machine code.',
                'No interfering macros/layout controls come from the including translation unit, earlier headers or compiler command line. Include resolution selects these exact recorded runtime headers.',
                'The restricted parser/interpreter, independent contract, Z3 5.1.0 and this dependency audit are trusted; unknown solver results reject. Mutations are finite adversarial evidence, not a proof of the checker.',
            ],
            'notClaimed': [
                'Identities of account 2 as the executable original token program and account 3 as custody require successful bend_custody; validator equivalence alone proves neither identity nor application policy.',
                'No composed ABI, extraction, adapter, executor, CPI/syscall, rollback, compiler, LLVM, SBF or deployed-program guarantee.',
                'No proof for count outside 4..12, invalid native objects, invalid pointers or bytes beyond the caller-declared readable data size.',
                'Mint/burn U32 authority extraction and executor signer selection remain outside this helper contract; SAT witnesses show the helper accepts U32_MAX in both branches.',
            ],
        })
        # Compare exact bytes analyzed and checker/dependency code before and
        # after all solver/probe work. Write a pending file, check again, then
        # atomically publish only the completed report.
        for name, digest in inputs.items():
            need(sha((ROOT / name).read_bytes()) == digest,
                 'input changed while checking: ' + name)
        pending.write_text(json.dumps(report, indent=2) + '\n')
        for name, digest in inputs.items():
            need(sha((ROOT / name).read_bytes()) == digest,
                 'input changed before report publication: ' + name)
        pending.replace(output)
        print(f'Token validator: {len(report["claims"])} UNSAT claims, '
              f'{report["readObligations"]} guarded read obligations, '
              f'{len(report["witnesses"])} SAT witnesses, '
              f'{len(report["mutations"])} faulty artifacts rejected and '
              f'{len(report["equivalents"])} equivalent variants; {output.relative_to(ROOT)}')
    except BaseException:
        output.unlink(missing_ok=True)
        raise
    finally:
        pending.unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except (Grammar, AssertionError, RuntimeError) as error:
        raise SystemExit('Token validator check failed: ' + str(error))
