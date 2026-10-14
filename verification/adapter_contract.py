"""Implementation-linked ABI 1 adapter contract check.

For each written adapter artifact this gate
  1. accounts for every token of the emitted translation unit in a reviewed,
     fail-closed restricted grammar (adapter_contract_c.py),
  2. executes the parsed control flow symbolically (adapter_contract_sym.py),
  3. compares the resulting guarded events, return value and committed bytes
     with the declarative contract below, which expresses
     docs/adapter-assurance.md plus precedence pinned from compiler/storage.ts.
     The contract never inspects the parsed program.

It is a bounded artifact-level claim about recorded adapters. It is not a
proof of C, Clang/LLD, SBF, the loader, syscalls, helpers or codecs.
"""
import hashlib
import json
import os
import pathlib
import sys
import time

# This directory holds queue.py, which would shadow the standard `queue` module
# that multiprocessing imports. Search the script directory last.
_HERE = os.path.dirname(os.path.realpath(__file__))
sys.path[:] = [p for p in sys.path if os.path.realpath(p or os.getcwd()) != _HERE] + [_HERE]

import multiprocessing  # noqa: E402
from concurrent.futures import ProcessPoolExecutor  # noqa: E402

import z3  # noqa: E402

from adapter_contract_c import (Grammar, IDENT, audited_header_tokens, has_file_scope_tokens, has_tokens, header_directives, header_tokens, need, parse_adapter,
                                strict_tokens, unique_file_scope_name)
from adapter_contract_sym import Exec, Fatal, Semantic, World, pack
from effect_extraction import check_extraction

SCOPE = ('Restricted-syntax conformance and symbolic control-flow refinement of emitted ABI 1 adapter entrypoints '
         'against the adapter contract, with schema-linked effect-extraction checks, for the recorded fixtures only')
ASSUMPTIONS = [
    'The restricted C front end, its integer-conversion rules and the call summaries are trusted and reviewed; '
    'they are a bridge to the emitted text, not a C semantics. C undefined behavior outside the modeled checks '
    '(uninitialized reads, array bounds, shift widths, inactive union members) is not analysed.',
    'unsigned char/unsigned int/unsigned long long are 8/32/64 bits (asserted by runtime/solana_min.h and the '
    'generated native header); Clang, LLD and SBF execution preserve the C semantics.',
    'Loader: the input is a valid aligned invocation buffer with truthful account metadata and lengths; accounts '
    'start at offset 8, the instruction length, instruction bytes and program id follow the last account. '
    'read_account (exact text audited) returns null exactly for a duplicate marker and otherwise fills the account.',
    'equal_key is equality of two 32-byte keys (verify:account-key); read_le is a little-endian load (exact text '
    'audited). Keys are abstract values compared by equality; a 256-bit byte view exists only for keys whose bytes '
    'the adapter reads, and equal keys have equal views.',
    'Canonical decoders/encoders are deterministic functions of exactly the bytes or value passed, return nonzero '
    'only on success and touch only their output; decode success and values, encode '
    'success and bytes are otherwise uninterpreted. No byte-level codec fact or linkage to a codec-proof receipt is established here.',
    'The Bend root is pure. Its Accepted effects value satisfies the extraction subcheck native-value '
    'preconditions (declared tags and initialized fields). Root datatype preservation and business rules are out of scope.',
    'sol_get_clock_sysvar, custody setup, effect validation and effect execution return arbitrary 64-bit values; '
    'their bodies, CPI behavior and the accounts they touch are out of scope. Each is modeled as called with the '
    'recorded arguments and as not writing the state account data, the adapter locals or return data '
    '(noninterference). Extraction frame, initialization and field mapping are checked separately against the '
    'written helper bodies under each fixture extraction report and its preconditions and trusted structural bridge. '
    'The entrypoint model still overapproximates extraction success and slot values with uninterpreted symbols.',
    'An effect executed before a later failure stays executed: undoing it, and any earlier instruction of the '
    'transaction, relies on Solana transaction atomicity. The contract only covers the adapter\'s own commit.',
    'Only normally returning helper calls and explicit adapter returns are modeled. Runtime aborts, including '
    'CU exhaustion during commit, rely on transaction rollback. Compilation introduces no macro definitions '
    'that interfere with adapter identifiers; pointer formation relies on valid loader object bounds.',
    'The schema and interface correspond to the checked Bend program; schema extraction is outside this claim.',
]
NOT_CLAIMED = [
    'C semantics in general, the compiler, linker, SBF binary, stack use or compute budget',
    'memory safety beyond the modeled index, length, initialization, null and union-variant obligations',
    'the bodies of codecs, the Bend root, custody/validation/execution helpers and syscalls',
    'ABI 2 multi-state and ABI 3 collection adapters, or any adapter not listed under fixtures',
    'adapters outside the restricted grammar: they are refused, which is not a finding about their behavior',
    'rollback of external effects or of earlier instructions in the transaction',
]
BRIDGE = ('Exact reviewed text: Clock declaration and entrypoint header, read_le, read_account, Account, integer '
          'typedefs, helper/codec/root/maker signatures and result layouts. Reviewed summaries: every call in '
          'adapter_contract_sym.Exec.call_*. Parsed and symbolically executed: all statements, branches, loops, '
          'guards, casts, integer expressions and returns of the entrypoint body. Extraction uses the separately '
          'reported restricted path-enumeration checker and exact dependency conformance checks.')


# ---- Schema and interface summary (independent of compiler/storage.ts) ----------
def ident(name):
    return 'bend_' + ''.join(c if c.isascii() and c.isalnum() else f'_{ord(c):x}_' for c in name)


def summarize(schema, interface):
    need(schema['version'] == 1 and interface['version'] == 1, 'interface: ABI 1 schema and interface expected')
    need(interface['modes'] == {'initialize': 0, 'transition': 1}, 'interface: modes')
    types = {t['name']: t for t in schema['types']}
    need(len(types) == len(schema['types']), 'schema: duplicate type')
    sizes = {}

    def size(name, busy=()):
        need(name in types and name not in busy, 'schema: unknown or recursive type')
        if name not in sizes:
            t = types[name]
            if t['kind'] == 'adt':
                need(t['cType'] == ident(name) + '_t' and t['variants'], 'schema: ADT C type')
                need([v['tag'] for v in t['variants']] == list(range(len(t['variants']))), 'schema: noncanonical variant tags')
                sizes[name] = 1 + max(sum(size(f['type'], busy + (name,)) for f in v['fields']) for v in t['variants'])
            else:
                need(t['kind'] in ('u32', 'bool') and t['cType'] == 'bend_u32', 'schema: primitive')
                sizes[name] = 4 if t['kind'] == 'u32' else 1
        return sizes[name]

    def record(name, fields):
        t = types.get(name)
        need(t is not None and t['kind'] == 'adt' and len(t['variants']) == 1 and t['variants'][0]['tag'] == 0
             and [f['name'] for f in t['variants'][0]['fields']] == fields, f'schema: record {name}')
        return t['variants'][0]

    last = lambda name: name.split('.')[-1]
    roots = [e for e in schema['exports'] if e['name'] == interface['root']]
    need(len(roots) == 1 and len(roots[0]['args']) == 3 and roots[0]['cName'] == ident(interface['root']), 'schema: root')
    context, state, instruction = roots[0]['args']
    need(state == interface['state'] and instruction == interface['instruction'] and state != instruction,
         'interface: state/instruction types')
    ctx = record(context, ['actor', 'signed', 'slot'])
    key = record(ctx['fields'][0]['type'], list('abcdefgh'))
    slot = record(ctx['fields'][2]['type'], ['lo', 'hi'])
    need(all(types[f['type']]['kind'] == 'u32' for f in key['fields'] + slot['fields'])
         and types[ctx['fields'][1]['type']]['kind'] == 'bool', 'schema: context fields')
    result = types[roots[0]['result']]
    need(result['kind'] == 'adt' and len(result['variants']) == 2, 'schema: root result')
    accepted = [v for v in result['variants'] if last(v['name']) == 'Accepted']
    rejected = [v for v in result['variants'] if last(v['name']) == 'Rejected']
    need(len(accepted) == 1 and len(rejected) == 1, 'schema: Accepted/Rejected')
    accepted, rejected = accepted[0], rejected[0]
    need([v['tag'] for v in result['variants']] == [0, 1], 'schema: result variant tags')
    need([f['name'] for f in accepted['fields']] in (['state'], ['state', 'effects'])
         and accepted['fields'][0]['type'] == state, 'schema: Accepted fields')
    need([f['name'] for f in rejected['fields']] == ['code'] and types[rejected['fields'][0]['type']]['kind'] == 'u32',
         'schema: Rejected fields')
    n, ix = size(state), size(instruction)

    # Storage header: BDS1 plus a hash of the reachable state layout.
    reachable = {}

    def visit(name):
        if name in reachable:
            return
        t = types[name]
        if t['kind'] == 'adt':
            reachable[name] = {'name': name, 'kind': 'adt', 'variants': [
                {'name': v['name'], 'tag': v['tag'], 'fields': v['fields']} for v in t['variants']]}
            for v in t['variants']:
                for f in v['fields']:
                    visit(f['type'])
        else:
            reachable[name] = {'name': name, 'kind': t['kind'], **({'max': t['max']} if 'max' in t else {})}
    visit(state)
    digest = hashlib.sha256(json.dumps(list(reachable.values()), separators=(',', ':'), ensure_ascii=False).encode()).digest()
    header = [66, 68, 83, 49, *digest[:16]]
    need(interface['header'] == header, 'interface: header differs from the state layout hash')
    need(interface['stateBytes'] == 20 + n and interface['instructionBytes'] == ix + 1, 'interface: sizes')

    effects = len(accepted['fields']) == 2
    slots, cpi, effect_type, effects_type, kind = 0, False, None, None, 'none'
    if effects:
        effects_type = accepted['fields'][1]['type']
        fields = record(effects_type, [f['name'] for f in types[effects_type]['variants'][0]['fields']])['fields']
        names = [f['name'] for f in fields]
        if names in (['first', 'second'], ['first', 'second', 'third']):
            need(len({f['type'] for f in fields}) == 1, 'schema: effect types differ')
            effect_type, slots = fields[0]['type'], len(fields)
        else:
            need(names == ['length', 'storage'] and fields[0]['type'] == 'U32', 'schema: effects record')
            leaves = []

            def walk(name, depth):
                t = types[name]
                need(t['kind'] == 'adt' and depth <= 3, 'schema: effect storage')
                if len(t['variants']) > 1:
                    leaves.append(name)
                    return
                pair = t['variants'][0]['fields']
                need([f['name'] for f in pair] == ['left', 'right'] and pair[0]['type'] == pair[1]['type'],
                     'schema: effect storage pair')
                walk(pair[0]['type'], depth + 1)
                walk(pair[1]['type'], depth + 1)
            walk(fields[1]['type'], 0)
            need(len(set(leaves)) == 1 and len(leaves) in (2, 4, 8), 'schema: effect vector capacity')
            effect_type, slots = leaves[0], len(leaves)
        variants = [last(v['name']) for v in types[effect_type]['variants']]
        cpi = 'Invoke' in variants
        kind = 'cpi-v1' if cpi else 'token-v2' if 'Mint' in variants else 'token-v1'
    need(interface['effects'] == kind, 'interface: effect kind')
    need(interface.get('effectSlots') == (slots if slots > 2 else None), 'interface: effect slots')
    need(interface['accounts'] == (['state', 'actor', 'program' if cpi else 'tokenProgram', 'custody', 'remaining...']
                                   if effects else ['state', 'actor']), 'interface: accounts')

    def field_class(f):
        if f['type'] == state:
            return 'state'
        if effects and f['type'] == effects_type:
            return 'effects'
        return 'scalar' if types[f['type']]['kind'] in ('u32', 'bool') else 'other'
    prefix = 'bend_invoke' if cpi else 'bend_transfer'
    return {
        '_schema': schema, '_interface': interface,
        'types': types, 'accounts': 12 if effects else 2, 'n': n, 'ix': ix, 'total': 20 + n, 'header': header,
        'effects': effects, 'cpi': cpi, 'slots': slots, 'kind': kind,
        'accepted': accepted['tag'], 'rejected': rejected['tag'],
        'result': {v['tag']: [field_class(f) for f in v['fields']] for v in result['variants']},
        'result_name': roots[0]['result'], 'result_type': result['cType'], 'root': roots[0]['cName'],
        'context_name': context, 'context_type': types[context]['cType'], 'context_maker': ctx['cMaker'],
        'key_name': ctx['fields'][0]['type'], 'key_type': types[ctx['fields'][0]['type']]['cType'], 'key_maker': key['cMaker'],
        'slot_name': ctx['fields'][2]['type'], 'slot_value_type': types[ctx['fields'][2]['type']]['cType'],
        'slot_maker': slot['cMaker'],
        'state_type': types[state]['cType'], 'ix_type': types[instruction]['cType'],
        'state_decode': ident(state) + '_decode', 'ix_decode': ident(instruction) + '_decode',
        'state_encode': ident(state) + '_encode',
        'slot_type': ('BendInvoke' if cpi else 'BendTransfer') if effects else None,
        'effect_type': types[effect_type]['cType'] if effects else None,
        'effects_type': types[effects_type]['cType'] if effects else None,
        'effect_header': ('bend_cpi.h' if cpi else 'token.h') if effects else None,
        'custody': 'bend_invoke_custody' if cpi else 'bend_custody',
        'validate': prefix + '_validate', 'execute': prefix + '_execute',
    }


# ---- Dependencies: include closure, macros and exact reviewed declarations -------
SOLANA = [
    'typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64; '
    '_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
    'static inline u64 read_le(const u8 *p, unsigned n) { u64 v = 0; '
    'for (unsigned i = 0; i < n; ++i) v |= (u64)p[i] << (8 * i); return v; }',
    'static inline unsigned equal_key(const u8 *a, const u8 *b) { '
    'for (unsigned i = 0; i < 32; i += 8) { u64 left, right; '
    '__builtin_memcpy(&left, a + i, 8); __builtin_memcpy(&right, b + i, 8); '
    'if (left != right) return 0; } return 1; }',
    'typedef struct { const u8 *key; const u8 *owner; u8 *data; u64 size; u64 *lamports; u64 rent_epoch; '
    'unsigned signer, writable, executable; } Account;',
    'static inline const u8 *read_account(const u8 *p, Account *a) { if (p[0] != 255) return (const u8 *)0; '
    'a->signer = p[1] != 0; a->writable = p[2] != 0; a->executable = p[3] != 0; a->key = p + 8; a->owner = p + 40; '
    'a->size = read_le(p + 80, 8); a->lamports = (u64 *)(p + 72); a->data = (u8 *)(p + 88); '
    'u64 next = (u64)(a->data + a->size + 10240); const u8 *rent = (const u8 *)((next + 7) & ~(u64)7); '
    'a->rent_epoch = read_le(rent, 8); return rent + 8; }',
    'extern void sol_set_return_data(const u8 *, u64);',
]
HELPERS = {
    'token.h': [
        'typedef struct { u32 active, source, destination, mint, authority, recipient;',
        'static inline u64 bend_custody(Account *accounts, const u8 *program, u8 *bump) {',
        'static inline u64 bend_transfer_validate(const BendTransfer *t, Account *a, unsigned count) {',
        'static __attribute__((noinline)) u64 bend_transfer_execute(const BendTransfer *t, Account *a, unsigned count, u8 bump) {',
    ],
    'bend_cpi.h': [
        'typedef struct { u32 index, writable, signer; u8 key[32]; } BendInvokeMeta;',
        'typedef struct { u32 active, program, length, count; u8 program_key[32], data[64]; BendInvokeMeta metas[8]; } BendInvoke;',
        'static inline u64 bend_invoke_custody(Account *a, const u8 *program, u8 *bump) {',
        'static inline u64 bend_invoke_validate(const BendInvoke *t, Account *a, unsigned count) {',
        'static __attribute__((noinline)) u64 bend_invoke_execute(const BendInvoke *t, Account *a, unsigned count, u8 bump) {',
    ],
}


def audit_dependencies(m, adapter_name, files):
    need(adapter_name.endswith('.c') and adapter_name in files, 'dependencies: adapter file')
    stem = adapter_name[:-2]
    native, wire = stem + '.h', stem + '.wire.h'
    adapter = files[adapter_name]
    # Include closure from the adapter; every dependency is scanned for macros.
    first = [wire, 'solana_min.h'] + ([m['effect_header']] if m['effects'] else [])
    macros, seen, queue = {}, set(), list(first)
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        need(name in files and name != adapter_name, f'dependencies: include {name!r} was not recorded')
        seen.add(name)
        defined, included = header_directives(name, files[name])
        for macro in defined:
            macros.setdefault(macro, name)
        queue += included
    need(seen | {adapter_name} == set(files), 'dependencies: recorded file is not in the include closure')
    # No macro of any dependency may name a token of the adapter text, so the
    # adapter's tokens are what the compiler sees after preprocessing.
    clash = sorted({t for t in strict_tokens(adapter) if IDENT.match(t)} & set(macros))
    need(not clash, f'preprocessing: dependency macro {clash[0] if clash else ""!r} '
         f'({macros.get(clash[0]) if clash else ""}) could rewrite adapter text')

    def audit(name, snippets):
        tokens = audited_header_tokens(name, files[name])
        for snippet in snippets:
            matched = (has_tokens(header_tokens(files[name]), header_tokens(snippet)) if snippet.startswith('#include')
                       else has_file_scope_tokens(tokens, header_tokens(snippet)))
            need(matched, f'dependencies: {name} differs from the reviewed text near {snippet[:48]!r}')
    audit('solana_min.h', SOLANA)
    if m['effects']:
        audit(m['effect_header'], HELPERS[m['effect_header']])
    types = m['types']
    layouts = ['typedef unsigned int bend_u32;', '_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");',
               f'static __attribute__((noinline)) {m["result_type"]} {m["root"]}({m["context_type"]} a0, {m["state_type"]} a1, {m["ix_type"]} a2) {{']
    for name in (m['result_name'], m['context_name'], m['key_name'], m['slot_name']):
        t = types[name]
        members = []
        for v in t['variants']:
            inner = ' '.join(f'{types[f["type"]]["cType"]} f{i};' for i, f in enumerate(v['fields'])) or 'bend_u32 unused;'
            members.append(f'struct {{ {inner} }} c{v["tag"]};')
        layouts.append('typedef struct { bend_u32 tag; union { ' + ' '.join(members) + f' }} as; }} {t["cType"]};')
    for name in (m['context_name'], m['key_name'], m['slot_name']):
        t, v = types[name], types[name]['variants'][0]
        args = ', '.join(f'{types[f["type"]]["cType"]} a{i}' for i, f in enumerate(v['fields']))
        fields = ', '.join(f'.f{i} = a{i}' for i in range(len(v['fields'])))
        layouts.append(f'static inline {t["cType"]} {v["cMaker"]}({args}) {{ return ({t["cType"]}){{ .tag = 0, .as.c0 = {{ {fields} }} }}; }}')
    audit(native, layouts)
    # Sizes are independently derived by summarize(); primitives are at most four bytes.
    decode_storage = lambda size: 'static __attribute__((noinline)) inline' if size >= 256 else 'static inline'
    audit(wire, [f'#include "{native}"',
                 f'{decode_storage(m["n"])} int {m["state_decode"]}(const unsigned char *p, unsigned long long n, {m["state_type"]} *out) {{',
                 f'{decode_storage(m["ix"])} int {m["ix_decode"]}(const unsigned char *p, unsigned long long n, {m["ix_type"]} *out) {{',
                 f'static inline int {m["state_encode"]}(unsigned char *p, unsigned long long n, const {m["state_type"]} *value) {{'])
    generated = [audited_header_tokens(native, files[native]), audited_header_tokens(wire, files[wire])]
    # Bind every generated helper/root name the ABI 1 adapter calls. ABI 1
    # exposes the context/key/slot makers in its summary, but has no synthesized
    # state_maker field (unlike ABI 2's multi-state adapter summary).
    called = [m['context_maker'], m['key_maker'], m['slot_maker'], m['root'],
              m['state_decode'], m['ix_decode'], m['state_encode']]
    if m.get('state_maker') is not None:
        called.append(m['state_maker'])
    for name in dict.fromkeys(called):
        unique_file_scope_name(generated, name)
    return sorted(seen), wire


# ---- The contract -----------------------------------------------------------------
class Contract:
    """Declarative ABI 1 contract over the invocation inputs (World symbols).

    Built only from the interface/schema summary and docs/adapter-assurance.md.
    `conjuncts` is the success condition; `classes` lists each failure with
    the code it may be reported as; `stages` additionally pins the current
    precedence between simultaneous failures as a regression contract.
    """

    def __init__(self, w, m):
        self.w, self.m = w, m
        bv64 = lambda v: z3.BitVecVal(v, 64)
        n, ix, total, header = m['n'], m['ix'], m['total'], m['header']
        acc, rej, slots = m['accepted'], m['rejected'], m['slots']
        count_ok = z3.And(z3.UGE(w.COUNT, 4), z3.ULE(w.COUNT, 12)) if m['effects'] else w.COUNT == 2
        alias = z3.Or([z3.And(z3.ULT(bv64(i), w.COUNT),
                              z3.Or([z3.Not(w.PARSE_OK[i])] + [w.KEY[i] == w.KEY[j] for j in range(i)]))
                       for i in range(m['accounts'])])
        self.init = init = w.IXB[0] == 0
        zeros = [z3.BitVecVal(0, 8)] * n
        stored = w.D[20:]
        self.before = z3.If(init, w.decoded['state'](pack(zeros)), w.decoded['state'](pack(stored)))
        self.instruction = w.decoded['ix'](pack(w.IXB[1:]))
        self.context = tuple(z3.Extract(32 * i + 31, 32 * i, w.key_bytes(1)) for i in range(8)) + (
            z3.If(w.SIGNER[1], z3.BitVecVal(1, 32), z3.BitVecVal(0, 32)),
            z3.Extract(31, 0, w.SLOT), z3.Extract(63, 32, w.SLOT))
        self.code = code = w.outf(rej, 0)
        self.rejected, self.accepted = w.ROOT_TAG == rej, w.ROOT_TAG == acc
        self.in_range = z3.ULE(code, z3.BitVecVal(0xfffffeff, 32))
        self.reject_return = z3.If(self.in_range, bv64(256) + z3.ZeroExt(32, code), bv64(9))
        self.encoded = w.enc(acc, 0)
        self.expected_data = [z3.BitVecVal(b, 8) for b in header] + self.encoded

        def state_writable(i):  # a CPI slot that passes the state account as writable
            src = (acc, 1)
            return z3.And(w.eff(src, i, 'active') != 0, z3.Or([
                z3.And(z3.ULT(z3.BitVecVal(j, 32), w.eff(src, i, 'count')), w.meta(src, i, j, 'index') == 0,
                       w.meta(src, i, j, 'writable') != 0) for j in range(8)]))
        self.common = [('account-count', count_ok), ('distinct-accounts', z3.Not(alias)),
                       ('instruction-length', w.IXLEN == ix + 1), ('mode-byte', z3.ULE(w.IXB[0], 1))]
        if m['effects']:
            self.common.append(('custody-setup', w.SETUP == 0))
        self.common += [('state-owner', w.OWNER == w.PROGRAM), ('state-not-executable', z3.Not(w.EXECUTABLE[0])),
                        ('state-writable', w.WRITABLE[0]), ('state-size', w.SIZE[0] == total)]
        self.initialize = [('initialize-state-signer', w.SIGNER[0]),
                           ('initialize-zero-allocation', z3.And([b == 0 for b in w.D])),
                           ('initialize-empty-state-decodes', w.decode_ok['state'](pack(zeros)))]
        self.transition = [('stored-header', z3.And([w.D[i] == header[i] for i in range(20)])),
                           ('stored-state-decodes', w.decode_ok['state'](pack(stored)))]
        self.late = [('instruction-decodes', w.decode_ok['ix'](pack(w.IXB[1:]))), ('clock', w.CLOCK_RC == 0)]
        self.post = [('root-accepted', self.accepted), ('state-encodes', w.enc_ok(acc, 0))]
        self.cpi_writable = [state_writable(i) for i in range(slots)] if m['cpi'] else [z3.BoolVal(False)] * slots
        if m['effects']:
            self.post.append(('effects-extract', w.ext_ok(acc, 1)))
            self.post += [(f'validate-slot-{i}', w.VAL[i] == 0) for i in range(slots)]
            if m['cpi']:
                self.post += [(f'cpi-state-not-writable-slot-{i}', z3.Not(self.cpi_writable[i])) for i in range(slots)]
            self.post += [(f'execute-slot-{i}', w.EXE[i] == 0) for i in range(slots)]
        self.names = [name for name, _ in self.common + self.initialize + self.transition + self.late + self.post]
        self.pre = self.precondition()
        self.success = self.succeeds()
        named = dict(self.post)
        self.produced = z3.And(self.pre, self.accepted, named['state-encodes'], named.get('effects-extract', True))
        self.validated = z3.And([self.produced] + [z3.And(w.VAL[i] == 0, z3.Not(self.cpi_writable[i])) for i in range(slots)])

    def precondition(self, drop=None):
        pick = lambda items: [z3.BoolVal(True) if name == drop else f for name, f in items]
        return z3.And(pick(self.common) + [z3.If(self.init, z3.And(pick(self.initialize)), z3.And(pick(self.transition)))]
                      + pick(self.late))

    def succeeds(self, drop=None):
        return z3.And([self.precondition(drop)] + [z3.BoolVal(True) if name == drop else f for name, f in self.post])

    def classes(self):
        """(failure, code): a nonzero return must be the code of a real failure.
        Failures after the root are attributable only once everything they
        depend on has passed; precedence among the rest is left open."""
        w, m, bv64 = self.w, self.m, lambda v: z3.BitVecVal(v, 64)
        named = dict(self.common + self.late)
        init = dict(self.initialize)
        trans = dict(self.transition)
        out = [(z3.Not(named['account-count']), bv64(1)), (z3.Not(named['distinct-accounts']), bv64(6)),
               (z3.Not(z3.And(named['instruction-length'], named['mode-byte'])), bv64(2)),
               (z3.Not(z3.And(named['state-owner'], named['state-not-executable'])), bv64(3)),
               (z3.Not(named['state-writable']), bv64(5)), (z3.Not(named['state-size']), bv64(4)),
               (z3.And(self.init, z3.Not(init['initialize-state-signer'])), bv64(7)),
               (z3.And(self.init, z3.Not(z3.And(init['initialize-zero-allocation'], init['initialize-empty-state-decodes']))), bv64(4)),
               (z3.And(z3.Not(self.init), z3.Not(z3.And(list(trans.values())))), bv64(4)),
               (z3.Not(named['instruction-decodes']), bv64(2)), (z3.Not(named['clock']), bv64(8))]
        if m['effects']:
            out.append((w.SETUP != 0, w.SETUP))
        post = dict(self.post)
        out += [(z3.And(self.pre, self.rejected), self.reject_return),
                (z3.And(self.pre, z3.Not(self.rejected), z3.Not(self.accepted)), bv64(9)),
                (z3.And(self.pre, self.accepted, z3.Not(post['state-encodes'])), bv64(9))]
        if m['effects']:
            out.append((z3.And(self.pre, self.accepted, z3.Not(post['effects-extract'])), bv64(9)))
            for i in range(m['slots']):
                out.append((z3.And(self.produced, self.cpi_writable[i]), bv64(22)))
                out.append((z3.And(self.produced, w.VAL[i] != 0), w.VAL[i]))
                out.append((z3.And([self.validated, w.EXE[i] != 0] + [w.EXE[j] == 0 for j in range(i)]), bv64(18)))
        return out

    def stages(self):
        """Pinned precedence: (name, events emitted before the check, failure, code)."""
        w, m, bv64 = self.w, self.m, lambda v: z3.BitVecVal(v, 64)
        named = dict(self.common + self.late + self.initialize + self.transition + self.post)
        no = z3.Not
        out = [('account-count', [], no(named['account-count']), bv64(1)),
               ('distinct-accounts', [], no(named['distinct-accounts']), bv64(6)),
               ('instruction-length-or-mode', [], no(z3.And(named['instruction-length'], named['mode-byte'])), bv64(2))]
        if m['effects']:
            out.append(('custody-setup', [('custody',)], w.SETUP != 0, w.SETUP))
        out += [('state-owner-or-executable', [], no(z3.And(named['state-owner'], named['state-not-executable'])), bv64(3)),
                ('state-writable', [], no(named['state-writable']), bv64(5)),
                ('state-size', [], no(named['state-size']), bv64(4)),
                ('initialize-state-signer', [], z3.And(self.init, no(named['initialize-state-signer'])), bv64(7)),
                ('initialize-zero-allocation', [], z3.And(self.init, no(named['initialize-zero-allocation'])), bv64(4)),
                ('stored-header', [], z3.And(no(self.init), no(named['stored-header'])), bv64(4)),
                ('state-decodes', [('decode', 'state')], no(z3.If(self.init, named['initialize-empty-state-decodes'],
                                                                   named['stored-state-decodes'])), bv64(4)),
                ('instruction-decodes', [('decode', 'ix')], no(named['instruction-decodes']), bv64(2)),
                ('clock', [('clock',)], no(named['clock']), bv64(8)),
                ('root-rejected-in-range', [('root',)], z3.And(self.rejected, self.in_range), self.reject_return),
                ('root-rejected-out-of-range', [], self.rejected, bv64(9)),
                ('root-unknown-tag', [], no(self.accepted), bv64(9)),
                ('state-encodes', [('encode',)], no(named['state-encodes']), bv64(9))]
        if m['effects']:
            out.append(('effects-extract', [('extract',)], no(named['effects-extract']), bv64(9)))
            for i in range(m['slots']):
                if m['cpi']:
                    out.append((f'cpi-state-writable-slot-{i}', [('validate', i)], self.cpi_writable[i], bv64(22)))
                    out.append((f'validate-slot-{i}', [], w.VAL[i] != 0, w.VAL[i]))
                else:
                    out.append((f'validate-slot-{i}', [('validate', i)], w.VAL[i] != 0, w.VAL[i]))
            for i in range(m['slots']):
                out.append((f'execute-slot-{i}', [('execute', i)], w.EXE[i] != 0, bv64(18)))
        out.append(('commit', [('write', 0), ('write', 1), ('return_data',)], z3.BoolVal(True), bv64(0)))
        return out


# ---- Path properties ----------------------------------------------------------------
FALSE, TRUE = z3.BoolVal(False), z3.BoolVal(True)


def kinds(path):
    return [e.kind for e in path.events]


def final_data(w, path):
    data = list(w.D)
    for e in path.events:
        if e.kind == 'write':
            if e.offset + len(e.data) > len(data):
                return None
            data[e.offset:e.offset + len(e.data)] = list(e.data)
    return data


def prop_commit_only_on_success(w, c, path):
    """Any adapter write or return data implies the call succeeds, and nothing
    but commit steps follows the first of them."""
    k = kinds(path)
    commits = [i for i, x in enumerate(k) if x in ('write', 'return_data')]
    if not commits:
        return TRUE
    if any(x not in ('write', 'return_data') for x in k[commits[0]:]):
        return FALSE
    return z3.And(path.ret == 0, c.success)


def prop_root(w, c, path):
    """The root runs at most once, only when every precondition holds, after
    custody setup, both decodes and Clock, with the contract's arguments."""
    k, m = kinds(path), c.m
    roots = [i for i, x in enumerate(k) if x == 'root']
    if not roots:
        return TRUE
    if len(roots) > 1:
        return FALSE
    before = path.events[:roots[0]]
    expected = sorted((['custody'] if m['effects'] else []) + ['decode', 'decode', 'clock'])
    if sorted(e.kind for e in before) != expected or sorted(e.which for e in before if e.kind == 'decode') != ['ix', 'state']:
        return FALSE
    if any(e.kind == 'custody' and e.fn != m['custody'] for e in before):
        return FALSE
    root = path.events[roots[0]]
    return z3.And([c.pre, root.before == c.before, root.instruction == c.instruction]
                  + [a == b for a, b in zip(root.context, c.context)])


def prop_effects(w, c, path):
    """Slots are validated and executed in order with the contract's
    arguments; the first execution follows successful validation of every
    slot, and each execution follows success of the previous one."""
    m, k = c.m, kinds(path)
    validates = [(i, e) for i, e in enumerate(path.events) if e.kind == 'validate']
    executes = [(i, e) for i, e in enumerate(path.events) if e.kind == 'execute']
    if not validates and not executes:
        return TRUE
    src = (m['accepted'], 1)
    if [e.slot for _, e in validates] != list(range(len(validates))) or [e.slot for _, e in executes] != list(range(len(executes))):
        return FALSE
    if len(validates) > m['slots'] or len(executes) > m['slots']:
        return FALSE
    if any(e.src != src or e.fn != m['validate'] for _, e in validates) or any(e.src != src or e.fn != m['execute'] for _, e in executes):
        return FALSE
    first = min(i for i, _ in validates + executes)
    if k.count('extract') != 1 or k.count('root') != 1 or k.count('encode') != 1:
        return FALSE
    if not (k.index('root') < k.index('extract') < first and k.index('root') < k.index('encode')):
        return FALSE
    if any(e.src != src for e in path.events if e.kind == 'extract'):
        return FALSE
    parts = [z3.And(c.pre, c.accepted, w.ext_ok(*src))]
    parts += [z3.ZeroExt(32, e.count) == w.COUNT for _, e in validates + executes]
    parts += [e.bump == w.BUMP for _, e in executes]
    if executes:
        if len(validates) != m['slots'] or validates[-1][0] > executes[0][0] or k.index('encode') > executes[0][0]:
            return FALSE
        parts.append(c.validated)
        parts += [w.EXE[e.slot] == 0 for _, e in executes[:-1]]
    return z3.And(parts)


def prop_success_iff(w, c, path):
    """The adapter returns zero exactly when every condition of the abstract contract holds."""
    return (path.ret == 0) == c.success


def prop_error_code(w, c, path):
    """A nonzero return is the full-width code of a failure that occurred."""
    return z3.Implies(path.ret != 0, z3.Or([z3.And(failed, path.ret == code) for failed, code in c.classes()]))


def prop_exact_commit(w, c, path):
    """On success the state data is exactly H || encoded(next state), return
    data is exactly encoded(next state), the root ran once and every slot was
    executed once, in order."""
    m, k = c.m, kinds(path)
    data = final_data(w, path)
    returned = [e for e in path.events if e.kind == 'return_data']
    ok = (data is not None and len(returned) == 1 and len(returned[0].data) == m['n'] and k.count('root') == 1
          and [e.slot for e in path.events if e.kind == 'execute'] == list(range(m['slots']))
          and [e.src for e in path.events if e.kind == 'encode'] == [(m['accepted'], 0)])
    if not ok:
        return path.ret != 0
    return z3.Implies(path.ret == 0, z3.And([a == b for a, b in zip(data, c.expected_data)]
                                            + [a == b for a, b in zip(returned[0].data, c.encoded)]))


def prop_rejection_mapping(w, c, path):
    """Root rejections map to 256 + code without wrapping, or to 9."""
    return z3.And(z3.Implies(z3.And(c.pre, c.rejected), path.ret == c.reject_return),
                  z3.Implies(z3.And(c.pre, z3.Not(c.rejected), z3.Not(c.accepted)), path.ret == 9))


def prop_helper_codes(w, c, path):
    """Helper codes are tested and returned in all 64 bits."""
    m = c.m
    if not m['effects']:
        return TRUE
    others = z3.And([f for name, f in c.common + c.late if name != 'custody-setup']
                    + [z3.If(c.init, z3.And([f for _, f in c.initialize]), z3.And([f for _, f in c.transition]))])
    parts = [z3.Implies(z3.And(others, w.SETUP != 0), path.ret == w.SETUP)]
    for i in range(m['slots']):
        earlier = [z3.And(w.VAL[j] == 0, z3.Not(c.cpi_writable[j])) for j in range(i)]
        parts.append(z3.Implies(z3.And([c.produced, w.VAL[i] != 0, z3.Not(c.cpi_writable[i])] + earlier), path.ret == w.VAL[i]))
        if m['cpi']:
            parts.append(z3.Implies(z3.And([c.produced, c.cpi_writable[i]] + earlier), path.ret == 22))
    return z3.And(parts)


def trace_keys(path):
    out, writes = [], 0
    for e in path.events:
        if e.kind == 'decode':
            out.append(('decode', e.which))
        elif e.kind in ('validate', 'execute'):
            out.append((e.kind, e.slot))
        elif e.kind == 'write':
            out.append(('write', writes))
            writes += 1
        else:
            out.append((e.kind,))
    return out


def pinned(c):
    stages, reached, ret, guards = c.stages(), TRUE, None, []
    selected = []
    for name, events, failed, code in stages:
        guards += [(e, reached) for e in events]
        selected.append((name, z3.And(reached, failed), code))
        reached = z3.And(reached, z3.Not(failed))
    for name, chosen, code in reversed(selected):
        ret = code if ret is None else z3.If(chosen, code, ret)
    return ret, guards, selected


CLAIMS = [('commit-only-on-success', prop_commit_only_on_success), ('root-precondition-and-arguments', prop_root),
          ('effect-slot-order-and-validation-before-execution', prop_effects), ('success-iff-contract', prop_success_iff),
          ('error-code-soundness', prop_error_code), ('exact-commit-and-return-data', prop_exact_commit),
          ('rejection-mapping', prop_rejection_mapping), ('helper-code-width', prop_helper_codes)]


class Checker:
    def __init__(self, w, paths):
        self.w, self.paths = w, paths
        self.solver = w.solver()
        self.selectors = [z3.Bool(f'path_{i}_taken') for i in range(len(paths))]
        for s, p in zip(self.selectors, paths):
            self.solver.add(s == p.pc)

    def query(self, what, formulas):
        """Is some path taken with its formula true? Returns a model excerpt or None."""
        self.solver.push()
        self.solver.add(z3.Or([z3.And(s, f) for s, f in zip(self.selectors, formulas)]))
        sat = self.w.check(self.solver, what)
        out = None
        if sat:
            model = self.solver.model()
            out = self.w.describe(model)
            for s, p in zip(self.selectors, self.paths):
                if z3.is_true(model.eval(s, model_completion=True)):
                    out['return'] = hex(model.eval(p.ret, model_completion=True).as_long())
                    out['events'] = [':'.join(str(x) for x in key) for key in trace_keys(p)]
                    break
        self.solver.pop()
        return out


def analyse(m, adapter_name, files, full):
    """Parse, execute and check one adapter. Raises Grammar/Semantic/Fatal."""
    started = time.time()
    dependencies, wire = audit_dependencies(m, adapter_name, files)
    types = {'u8', 'u32', 'u64', 'unsigned', 'Account', 'BendClock'} | {t['cType'] for t in m['types'].values() if t['kind'] == 'adt'}
    effect = None
    if m['effects']:
        types.add(m['slot_type'])
        effect = (m['effect_header'], m['effect_type'], m['effects_type'], m['slot_type'])
    body, extract_slots = parse_adapter(files[adapter_name], wire, effect, types)
    try:
        extraction = check_extraction(m['_schema'], m['_interface'], files[adapter_name], files)
    except Grammar as error:
        raise Grammar(f'extraction conformance: {error}') from error
    need(extraction.get('passed') is True, 'extraction conformance: incomplete result')
    m = dict(m, extract_slots=extract_slots)
    if m['effects']:
        need(extract_slots == m['slots'], 'effects extraction: slot count differs from the schema')
    w = World(m)
    raw = Exec(w).run(body)
    c = Contract(w, m)  # fixes the key byte views used by contract queries
    checker = Checker(w, w.paths)
    # Every input reaches exactly the recorded paths (none was lost).
    solver = w.solver()
    solver.add(z3.Not(z3.Or([p.pc for p in w.paths])))
    if w.check(solver, 'totality'):
        raise Fatal('symbolic execution lost a feasible path')
    solver = w.solver()
    solver.add(z3.Not(z3.AtMost(*[p.pc for p in w.paths], 1)))
    if w.check(solver, 'path disjointness'):
        raise Fatal('symbolic execution produced overlapping paths')
    # Model obligations first: if one fails the symbolic values are unsound.
    labels = []
    for label, _, _ in w.obligations:
        if label not in labels:
            labels.append(label)
    solver = w.solver()
    solver.add(z3.Or([z3.And(pc, z3.Not(f)) for _, pc, f in w.obligations]) if w.obligations else FALSE)
    if w.check(solver, 'obligations'):
        failed, example = [], None
        for label in labels:
            solver = w.solver()
            solver.add(z3.Or([z3.And(pc, z3.Not(f)) for l, pc, f in w.obligations if l == label]))
            if w.check(solver, 'obligation ' + label):
                failed.append('obligation: ' + label)
                example = example or w.describe(solver.model())
        raise Semantic(failed[0], {'failed': failed, 'counterexample': example})
    ret, guards, selected = pinned(c)
    claims = [(name, [z3.Not(prop(w, c, p)) for p in w.paths]) for name, prop in CLAIMS]
    claims.append(('pinned-precedence-return-code', [p.ret != ret for p in w.paths]))
    canonical = [e for e, _ in guards]
    trace = []
    for p in w.paths:
        keys = trace_keys(p)
        if len(set(keys)) != len(keys) or any(k not in canonical for k in keys) \
                or [canonical.index(k) for k in keys] != sorted(canonical.index(k) for k in keys):
            trace.append(TRUE)
        else:
            trace.append(z3.Or([g != z3.BoolVal(e in keys) for e, g in guards]))
    claims.append(('pinned-precedence-event-trace', trace))
    failed, example = [], None
    for name, negated in claims:
        found = checker.query('claim ' + name, negated)
        if found is not None:
            failed.append('claim: ' + name)
            example = example or found
    if failed:
        raise Semantic(failed[0], {'failed': failed, 'counterexample': example})
    report = {'dependencies': dependencies, 'extraction': extraction, 'rawPaths': raw, 'paths': len(w.paths),
              'obligations': len(w.obligations), 'obligationKinds': labels,
              'claims': [{'name': name, 'result': 'unsat'} for name, _ in claims]}
    if not full:
        return report

    # Nonvacuity: every pinned stage and selected boundary values are reachable.
    witnesses = [(f'stage {name} returns its code', [z3.And(chosen, p.ret == code) for p in w.paths]) for name, chosen, code in selected]
    low = lambda e: z3.Extract(31, 0, e)
    witnesses += [('initialize succeeds', [z3.And(p.ret == 0, c.init) for p in w.paths]),
                  ('transition succeeds', [z3.And(p.ret == 0, z3.Not(c.init)) for p in w.paths]),
                  ('largest in-range rejection returns 0xffffffff',
                   [z3.And(c.pre, c.rejected, c.code == 0xfffffeff, p.ret == 0xffffffff) for p in w.paths]),
                  ('out-of-range rejection returns 9', [z3.And(c.pre, c.rejected, c.code == 0xffffffff, p.ret == 9) for p in w.paths])]
    if m['effects']:
        last = m['slots'] - 1
        witnesses += [('success with 4 accounts', [z3.And(p.ret == 0, w.COUNT == 4) for p in w.paths]),
                      ('success with 12 accounts', [z3.And(p.ret == 0, w.COUNT == 12) for p in w.paths]),
                      ('custody code with zero low 32 bits is returned',
                       [z3.And(p.ret == w.SETUP, low(w.SETUP) == 0, w.SETUP != 0) for p in w.paths]),
                      ('last-slot validation code with zero low 32 bits is returned',
                       [z3.And(c.produced, p.ret == w.VAL[last], low(w.VAL[last]) == 0, w.VAL[last] != 0) for p in w.paths]),
                      ('last-slot execution result with zero low 32 bits returns 18',
                       [z3.And(c.validated, p.ret == 18, low(w.EXE[last]) == 0, w.EXE[last] != 0) for p in w.paths])]
    reached = []
    for name, formulas in witnesses:
        if checker.query('witness ' + name, formulas) is None:
            raise Semantic('vacuity: unreachable ' + name)
        reached.append({'name': name, 'result': 'sat'})

    # Negative models: false statements about the emitted adapter must have
    # counterexamples, including each contract condition being load-bearing.
    negatives = [('rejection always returns 256 + code',
                  [z3.And(c.pre, c.rejected, p.ret != 256 + z3.ZeroExt(32, c.code)) for p in w.paths]),
                 ('success requires the actor to sign', [z3.And(p.ret == 0, z3.Not(w.SIGNER[1])) for p in w.paths]),
                 ('success requires the state address to sign', [z3.And(p.ret == 0, z3.Not(w.SIGNER[0])) for p in w.paths]),
                 ('a commit leaves the stored payload unchanged',
                  [z3.And(p.ret == 0, z3.Or([a != b for a, b in zip(w.D[20:], c.encoded)])) for p in w.paths]),
                 ('the root runs whenever the accounts are well formed',
                  [z3.And(z3.And([f for _, f in c.common]), z3.BoolVal('root' not in kinds(p))) for p in w.paths])]
    if m['effects']:
        negatives.append(('every return value fits in 32 bits', [z3.UGE(p.ret, z3.BitVecVal(1 << 32, 64)) for p in w.paths]))
        if m['slots'] > 1:
            negatives.append(('an error return implies no effect was executed (needs transaction rollback)',
                              [z3.And(p.ret != 0, z3.BoolVal(kinds(p).count('execute') > 1)) for p in w.paths]))
    for name in c.names:
        weaker = c.succeeds(drop=name)
        negatives.append((f'contract without {name}', [(p.ret == 0) != weaker for p in w.paths]))
    models = []
    for name, formulas in negatives:
        found = checker.query('negative ' + name, formulas)
        if found is None:
            raise Semantic('vacuity: no counterexample to the false statement: ' + name)
        models.append({'statement': name, 'result': 'sat', 'counterexample': found})
    report.update({'witnesses': reached, 'negativeModels': models, 'solverChecks': w.checks,
                   'seconds': round(time.time() - started, 2)})
    return report


def attempt(m, adapter_name, files, full=False):
    try:
        return {'outcome': 'verified', **analyse(m, adapter_name, files, full)}
    except Grammar as error:
        return {'outcome': 'rejected', 'kind': 'grammar', 'reason': str(error)}
    except Semantic as error:
        return {'outcome': 'rejected', 'kind': 'semantic', 'reason': error.label,
                'failed': error.model.get('failed', [error.label]),
                'counterexample': error.model.get('counterexample', error.model)}


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def work(task):
    """One fixture, mutation or behavior-preserving variant (run in a worker)."""
    role, item, f = task
    m = summarize(f['schema'], f['interface'])
    if role == 'fixture':
        result = attempt(m, f['adapter'], f['files'], full=True)
        if result['outcome'] != 'verified':
            raise Fatal(f'fixture {f["name"]} was not verified: {result}')
        return {'fixture': f['name'], 'effects': m['kind'], 'effectSlots': m['slots'], 'stateBytes': m['total'],
                'instructionBytes': m['ix'] + 1, 'adapterSha256': sha(f['files'][f['adapter']]),
                **{k: v for k, v in result.items() if k != 'outcome'}}
    files = {**f['files'], **item['files']}
    if files == f['files'] or set(files) != set(f['files']):
        raise Fatal(f'variant {item["name"]} does not change exactly the recorded files')
    result = attempt(m, f['adapter'], files)
    changed = {name: sha(text) for name, text in item['files'].items()}
    where = f'{item["fixture"]}/{item["name"]}'
    if role == 'equivalent':
        if result['outcome'] != 'verified':
            raise Fatal(f'behavior-preserving variant rejected: {where}: {result}')
        return {'name': item['name'], 'fixture': item['fixture'], 'paths': result['paths'],
                'claims': len(result['claims']), 'sha256': changed}
    if result['outcome'] != 'rejected':
        raise Fatal(f'mutation escaped: {where}')
    reasons = [result['reason']] + result.get('failed', [])
    if result['kind'] != item['kind'] or not any(item['expected'] in r for r in reasons):
        raise Fatal(f'mutation {where} rejected for the wrong reason: expected {item["kind"]} {item["expected"]!r}, '
                    f'got {result["kind"]} {reasons}')
    if 'exactly' in item and result.get('failed') != item['exactly']:
        raise Fatal(f'mutation {where}: expected exactly {item["exactly"]}, got {result.get("failed")}')
    if result['kind'] == 'semantic' and not result.get('counterexample'):
        raise Fatal(f'mutation {where}: semantic rejection without a counterexample')
    return {'name': item['name'], 'fixture': item['fixture'], 'expected': item['expected'], 'sha256': changed,
            **{k: v for k, v in result.items() if k != 'outcome'}}


def main():
    if z3.get_version_string() != '5.1.0':
        raise Fatal('Expected Z3 5.1.0')
    payload_path, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    output.unlink(missing_ok=True)
    payload = json.loads(payload_path.read_text())
    if not (payload['fixtures'] and payload['mutations'] and payload['equivalents']):
        raise Fatal('empty validation suite')
    by_name = {f['name']: f for f in payload['fixtures']}
    if len(by_name) != len(payload['fixtures']):
        raise Fatal('duplicate fixture')
    tasks = [('fixture', None, f) for f in payload['fixtures']]
    tasks += [('mutation', item, by_name[item['fixture']]) for item in payload['mutations']]
    tasks += [('equivalent', item, by_name[item['fixture']]) for item in payload['equivalents']]
    jobs = int(os.environ.get('ADAPTER_CONTRACT_JOBS', min(8, os.cpu_count() or 1)))
    # A worker exception (including a solver `unknown`) or a dead worker
    # aborts the whole run; no partial report is written.
    if jobs > 1:
        pool = ProcessPoolExecutor(jobs, mp_context=multiprocessing.get_context('spawn'))
        try:
            results = list(pool.map(work, tasks))
        finally:
            pool.shutdown(cancel_futures=True)
    else:
        results = [work(task) for task in tasks]
    a, b = len(payload['fixtures']), len(payload['fixtures']) + len(payload['mutations'])
    fixtures, mutations, equivalents = results[:a], results[a:b], results[b:]
    for f in fixtures:
        print(f'{f["fixture"]}: {f["paths"]} merged paths ({f["rawPaths"]} raw), {f["obligations"]} model obligations, '
              f'{len(f["claims"])} claims, {len(f["witnesses"])} witnesses, {len(f["negativeModels"])} negative models, '
              f'{f["seconds"]}s')
    here = pathlib.Path(__file__).parent
    sources = ['adapter_contract.py', 'adapter_contract_c.py', 'adapter_contract_sym.py']
    sources += sorted(p.name for p in here.glob('effect_extraction*.py'))
    report = {
        'passed': True, 'scope': SCOPE, 'assumptions': ASSUMPTIONS, 'notClaimed': NOT_CLAIMED, 'trustedBridge': BRIDGE,
        'model': {'integers': 'u8/u32/u64 and int bitvectors with C promotions and conversions; signed arithmetic '
                              'only on constants', 'loops': f'unrolled; at most {Exec.LOOP_LIMIT} iterations and '
                  f'{Exec.SYMBOLIC_LOOP_LIMIT} with a symbolic condition, otherwise rejected',
                  'bytes': 'state account data, instruction bytes, header/empty/encoded locals and read key bytes',
                  'symbols': 'account count, flags, sizes and keys, loader alias markers, instruction length, helper and '
                             'syscall results (64-bit), root tag and rejection code (32-bit), codec predicates'},
        'claims': {name: ' '.join(prop.__doc__.split()) for name, prop in CLAIMS} | {
            'pinned-precedence-return-code': 'Regression contract: the return value equals the emitter-pinned decision '
                                             'list, including the current precedence between simultaneous failures.',
            'pinned-precedence-event-trace': 'Regression contract: each boundary event occurs exactly when its '
                                             'decision-list stage is reached, in the emitter-pinned boundary order (commit writes may commute).'},
        'python': sys.version, 'z3': z3.get_version_string(), 'fixtures': fixtures, 'mutations': mutations,
        'equivalentVariants': equivalents,
        'totals': {'fixtures': len(fixtures), 'claims': sum(len(f['claims']) for f in fixtures),
                   'modelObligations': sum(f['obligations'] for f in fixtures),
                   'witnesses': sum(len(f['witnesses']) for f in fixtures),
                   'negativeModels': sum(len(f['negativeModels']) for f in fixtures),
                   'mutations': len(mutations),
                   'grammarRejections': sum(x['kind'] == 'grammar' for x in mutations),
                   'semanticRejections': sum(x['kind'] == 'semantic' for x in mutations),
                   'equivalentVariants': len(equivalents)},
        'inputs': {str(payload_path): hashlib.sha256(payload_path.read_bytes()).hexdigest(),
                   **{f'verification/{name}': hashlib.sha256((here / name).read_bytes()).hexdigest() for name in sources}},
    }
    output.write_text(json.dumps(report, indent=2) + '\n')
    t = report['totals']
    print(f'ABI 1 adapter contract: {t["fixtures"]} emitted adapters, {t["claims"]} claims unsat, {t["modelObligations"]} '
          f'model obligations, {t["witnesses"]} reachability witnesses, {t["negativeModels"]} negative models; '
          f'{t["mutations"]} mutated artifacts rejected ({t["semanticRejections"]} semantic counterexamples, '
          f'{t["grammarRejections"]} outside the grammar); {t["equivalentVariants"]} behavior-preserving variants accepted')


if __name__ == '__main__':
    try:
        main()
    except Fatal as error:
        raise SystemExit(f'adapter contract check failed: {error}')
