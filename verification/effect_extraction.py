"""Implementation-linked check of emitted ABI 1 effect extraction.

`check_extraction` reads the ACTUAL `bend_extract_effect` and
`bend_extract_effects` bodies of a written adapter and either returns
evidence that they refine an extraction specification derived from the
recorded schema, or raises `adapter_contract_c.Grammar`. It never returns
success for a partially checked artifact.

Method (a restricted structural bridge, NOT a C semantics and NOT a verified
checker):

  1. Every token of both bodies is parsed by a narrow grammar: whole-slot zero
     initialization, scalar assignment to a named slot member, `write_le` into
     a named slot byte array, `if`, blocks, `return`, and (in the plural
     function only) calls of `bend_extract_effect(&input, &out[i])`. There are
     no declarations, loops, pointer arithmetic other than `array + constant`,
     dereferences other than whole-slot zeroing, or casts other than `(u64)` of a 32-bit value.
  2. The parsed bodies are executed over abstract values. Inputs are named by
     their typed access path in the schema; every comparison is an atom
     `term OP constant`, so execution forks on exact unsigned interval
     constraints and enumerates every path. Output members are tracked
     individually; byte arrays are tracked per byte.
  3. Every path is compared with a specification built here from the schema by
     FIELD NAME (never from the emitter or its text): variant dispatch,
     opcodes, field mapping, key/amount byte order, guards, slot traversal and
     zeroing of inactive slots.

The production emitter is neither called nor imported. Reviewed exact text is
used only for the dependency audit (slot struct, `write_le`, integer typedefs,
native value typedefs): that part is conformance and is a trusted bridge.
"""
import hashlib
import json
import pathlib
import re
import sys

from adapter_contract_c import (Grammar, IDENT, NUMBER, audited_header_tokens, has_file_scope_tokens, header_directives, header_tokens, literal, need,
                                split_includes, strict_tokens)

SCOPE = ('Restricted-grammar path enumeration of the emitted bend_extract_effect/bend_extract_effects bodies against '
         'a schema-derived extraction specification, for the given adapter artifact only')
PRECONDITIONS = [
    'The input is a well-formed checked native value of the schema type: every ADT tag is a declared variant tag, '
    'every Bool is 0 or 1, and the union member of the tagged variant holds initialized fields. Behavior on a '
    'malformed tag or Bool is reported only where the emitted code was found to reject it (guardedTerms); the terms '
    'listed under uncheckedTerms are read without validation and rely on this precondition.',
    '`value` points to a valid readable object of the recorded native type and `out` to a valid writable slot object '
    '(plural function: an array of at least `slots` slot objects). Input and output objects are disjoint.',
    'unsigned char/unsigned int/unsigned long long are 8/32/64 bits (asserted by the audited headers).',
]
LIMITATIONS = [
    'Not a C semantics: the grammar, the abstract interpreter, the integer-conversion rules it admits and the '
    'schema-to-typedef bridge are trusted, reviewed code. The checker itself is not verified.',
    'Clang/LLD/SBF preservation, stack use and compute budget are out of scope.',
    'Only extraction is covered. Custody setup, effect validation/execution, syscalls, CPI and the adapter '
    'entrypoint (including how it calls extraction and whether it reads slots after a failed extraction) are not.',
    'On a FAILED extraction only the single function guarantees an initialized slot; the plural function may leave '
    'later slots unwritten. Callers must not read slots after failure.',
    'Whether the opcode/field conventions match what token.h/bend_cpi.h validation and execution expect is pinned '
    'here by review of those headers (RUNTIME_CONVENTIONS), not proved.',
    'Macro interference is excluded only for macros defined in the recorded include closure; command-line '
    'definitions are assumed absent.',
]
BRIDGE = ('Exact reviewed text (conformance): slot struct typedefs in token.h/bend_cpi.h, write_le and the integer '
          'typedefs in solana_min.h, bend_u32, and one schema-generated typedef per native type reachable from the '
          'effects type. write_le(p, v, n) is summarized from its audited body as p[i] = byte i of v for i < n. '
          'Parsed and interpreted: every token of both extraction bodies.')
RUNTIME_CONVENTIONS = {
    'token': 'active: 0 none, 1 transfer (plain or bound), 2 check-mint, 3 mint, 4 burn; recipient: 0 actor, '
             '1 custody, 2 explicit key; authority: 0 actor, 1 custody (mint is pinned to custody, burn to actor); '
             'source_bound/destination_bound: 0 any, 1 exact key; keys are eight little-endian 32-bit limbs a..h; '
             'amount = lo | hi << 32.',
    'cpi': 'active: 0 none, 1 invoke; program_key and meta keys are eight little-endian 32-bit limbs; data is '
           'sixteen little-endian 32-bit limbs a..p; metas[i] is Metas field i.',
}

M32 = (1 << 32) - 1
FULL = [(0, M32)]
PATH_LIMIT = 4096


# ---- Unsigned interval sets ------------------------------------------------------
def inter(a, b):
    out = []
    for lo, hi in a:
        for lo2, hi2 in b:
            if max(lo, lo2) <= min(hi, hi2):
                out.append((max(lo, lo2), min(hi, hi2)))
    return sorted(out)


def comp(a):
    out, at = [], 0
    for lo, hi in sorted(a):
        if lo > at:
            out.append((at, lo - 1))
        at = hi + 1
    if at <= M32:
        out.append((at, M32))
    return out


def atom(op, c):
    """Values t with `t op c` (unsigned 32-bit)."""
    if op == '==':
        return [(c, c)]
    if op == '!=':
        return comp([(c, c)])
    if op == '<':
        return [(0, c - 1)] if c > 0 else []
    if op == '<=':
        return [(0, c)]
    if op == '>':
        return [(c + 1, M32)] if c < M32 else []
    need(op == '>=', f'effect extraction: unsupported comparison {op!r}')
    return [(c, M32)]


FLIP = {'==': '==', '!=': '!=', '<': '>', '>': '<', '<=': '>=', '>=': '<='}


def within(a, domain):
    return not inter(a, comp(domain))


# ---- Schema-derived specification (independent of compiler/effects.ts) ---------------
def last(name):
    return name.split('.')[-1]


def ident(name):
    return 'bend_' + ''.join(c if c.isascii() and c.isalnum() else f'_{ord(c):x}_' for c in name)


def show(path, tag=False):
    text = 'value'
    for n, (k, i) in enumerate(path):
        text += ('->' if n == 0 else '.') + f'as.c{k}.f{i}'
    return text + (('->' if not path else '.') + 'tag' if tag else '')


def show_term(term):
    if term[0] == 'const':
        return str(term[1])
    if term[0] in ('leaf', 'tag'):
        return show(term[1], term[0] == 'tag')
    if term[0] == 'cat':
        return f'(u64){show_term(term[2])} | (u64){show_term(term[1])} << 32'
    return repr(term)


class Schema:
    def __init__(self, schema):
        need(schema.get('version') == 1, 'schema: version 1 expected')
        self.types = {t['name']: t for t in schema['types']}
        need(len(self.types) == len(schema['types']), 'schema: duplicate type')
        for t in schema['types']:
            if t['kind'] == 'adt':
                need(t['cType'] == ident(t['name']) + '_t' and t['variants'], 'schema: ADT C type')
                need([v['tag'] for v in t['variants']] == list(range(len(t['variants']))), 'schema: variant tags')
            else:
                need(t['kind'] in ('u32', 'bool') and t['cType'] == 'bend_u32', 'schema: primitive')

    def adt(self, name):
        t = self.types.get(name)
        need(t is not None and t['kind'] == 'adt', f'schema: ADT expected: {name}')
        return t

    def kind(self, name):
        need(name in self.types, f'schema: unknown type {name}')
        return self.types[name]['kind']

    def record(self, name, fields=None):
        t = self.adt(name)
        need(len(t['variants']) == 1, f'schema: record expected: {name}')
        names = [f['name'] for f in t['variants'][0]['fields']]
        need(fields is None or names == fields, f'schema: fields of {name}')
        return t['variants'][0]['fields']

    def variant(self, name, which):
        found = [v for v in self.adt(name)['variants'] if last(v['name']) == which]
        need(len(found) == 1, f'schema: variant {which} of {name}')
        return found[0]

    def field(self, variant, name, kind=None):
        found = [(i, f) for i, f in enumerate(variant['fields']) if f['name'] == name]
        need(len(found) == 1, f'schema: field {name} of {variant["name"]}')
        need(kind is None or self.kind(found[0][1]['type']) == kind, f'schema: field {name} is not {kind}')
        return found[0][0], found[0][1]['type']

    def key(self, name):
        fields = self.record(name, list('abcdefgh'))
        need(all(self.kind(f['type']) == 'u32' for f in fields), 'schema: key limbs')

    def enum(self, name, variants):
        t = self.adt(name)
        need([last(v['name']) for v in t['variants']] == variants, f'schema: variants of {name}')
        return t['variants']

    def at(self, root, path):
        name = root
        for k, i in path:
            t = self.adt(name)
            need(k < len(t['variants']) and i < len(t['variants'][k]['fields']), 'schema: path')
            name = t['variants'][k]['fields'][i]['type']
        return name

    def domain(self, root, term):
        """Well-formed values of a tag or scalar term."""
        name = self.at(root, term[1])
        if term[0] == 'tag':
            return [(0, len(self.adt(name)['variants']) - 1)]
        return [(0, 1)] if self.kind(name) == 'bool' else FULL

    def reachable(self, root):
        seen = []

        def visit(name):
            if name in seen or self.kind(name) != 'adt':
                return
            seen.append(name)
            for v in self.types[name]['variants']:
                for f in v['fields']:
                    visit(f['type'])
        visit(root)
        return seen


# Reviewed slot layouts. Parsed below; nothing else about the slot is assumed.
SLOT_TEXT = {
    'token.h': ['typedef struct { u32 active, source, destination, mint, authority, recipient; '
                'u8 mint_key[32], recipient_key[32]; u64 amount; '
                'u32 initialize, source_bound, destination_bound, fresh_destination; '
                'u8 source_key[32], destination_key[32]; } BendTransfer;'],
    'bend_cpi.h': ['typedef struct { u32 index, writable, signer; u8 key[32]; } BendInvokeMeta;',
                   'typedef struct { u32 active, program, length, count; u8 program_key[32], data[64]; '
                   'BendInvokeMeta metas[8]; } BendInvoke;'],
}
SOLANA_TEXT = [
    'typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64; '
    '_Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
    'static inline void write_le(u8 *p, u64 v, unsigned n) { '
    'for (unsigned i = 0; i < n; ++i) p[i] = (u8)(v >> (8 * i)); }',
]
PRIMS = {'u8': 1, 'u32': 4, 'u64': 8}


def slot_layout(header):
    """Member table of the slot struct, from the reviewed typedef text.

    Returns (slot type, {location: (kind, offset)}, size). A location is a
    tuple such as ('mint',) or ('metas', 3, 'key'); kind is 'u32', 'u64' or
    ('bytes', n)."""
    structs = {}
    for text in SLOT_TEXT[header]:
        t = header_tokens(text)
        need(t[:3] == ['typedef', 'struct', '{'] and t[-1] == ';' and t[-3] == '}', 'slot layout: typedef')
        name, at, members = t[-2], 3, []
        while t[at] != '}':
            ctype = t[at]
            need(ctype in PRIMS or ctype in structs, 'slot layout: member type')
            at += 1
            while True:
                member, count = t[at], None
                at += 1
                if t[at] == '[':
                    count = int(t[at + 1])
                    need(t[at + 2] == ']', 'slot layout: array')
                    at += 3
                members.append((member, ctype, count))
                if t[at] == ';':
                    at += 1
                    break
                need(t[at] == ',', 'slot layout: declarator')
                at += 1
        structs[name] = members
    slot = name

    def measure(ctype):
        if ctype in PRIMS:
            return PRIMS[ctype], PRIMS[ctype]
        size, align = place(ctype, 0, (), {})
        return size, align

    def place(struct, base, prefix, out):
        offset, align = 0, 1
        for member, ctype, count in structs[struct]:
            size, a = measure(ctype)
            offset, align = (offset + a - 1) // a * a, max(align, a)
            if ctype == 'u8':
                need(count is not None, 'slot layout: scalar byte member')
                out[prefix + (member,)] = (('bytes', count), base + offset)
            elif ctype in PRIMS:
                need(count is None, 'slot layout: scalar array')
                out[prefix + (member,)] = (ctype, base + offset)
            else:
                need(count is not None, 'slot layout: nested struct must be an array')
                for i in range(count):
                    place(ctype, base + offset + i * size, prefix + (member, i), out)
            offset += size * (count or 1)
        return (offset + align - 1) // align * align, align

    locations = {}
    size, _ = place(slot, 0, (), locations)
    covered = sorted((offset, offset + (kind[1] if isinstance(kind, tuple) else PRIMS[kind]))
                     for kind, offset in locations.values())
    need(all(a[1] == b[0] for a, b in zip(covered, covered[1:])) and covered[0][0] == 0 and covered[-1][1] == size,
         'slot layout: padding or overlap in the reviewed slot struct')
    return slot, locations, size


def zero_slot(locations):
    out = {}
    for loc, (kind, _) in locations.items():
        if isinstance(kind, tuple):
            for j in range(kind[1]):
                out[(loc, j)] = ('const', 0)
        else:
            out[loc] = ('const', 0)
    return out


class Spec:
    """Extraction specification derived from the schema and interface."""

    def __init__(self, schema, interface):
        need(interface.get('version') == 1, 'interface: version 1 expected')
        self.s = s = Schema(schema)
        roots = [e for e in schema['exports'] if e['name'] == interface['root']]
        need(len(roots) == 1, 'schema: root export')
        accepted = s.variant(roots[0]['result'], 'Accepted')
        names = [f['name'] for f in accepted['fields']]
        need(names in (['state'], ['state', 'effects']), 'schema: Accepted fields')
        self.kind, self.slots = 'none', 0
        if names == ['state']:
            need(interface.get('effects') == 'none', 'interface: effect kind')
            return
        self.effects = effects = accepted['fields'][1]['type']
        fields = s.record(effects)
        names = [f['name'] for f in fields]
        self.length, self.guard_tags = None, [()]
        if names in (['first', 'second'], ['first', 'second', 'third']):
            need(len({f['type'] for f in fields}) == 1, 'schema: effect types differ')
            self.effect = fields[0]['type']
            self.slot_paths = [((0, i),) for i in range(len(fields))]
        else:
            need(names == ['length', 'storage'] and s.kind(fields[0]['type']) == 'u32', 'schema: effects record')
            self.length, leaves, self.slot_paths = ((0, 0),), [], []

            def walk(name, path, depth):
                t = s.adt(name)
                need(depth <= 3, 'schema: effect vector exceeds eight slots')
                if len(t['variants']) > 1:
                    leaves.append(name)
                    self.slot_paths.append(path)
                    return
                pair = s.record(name, ['left', 'right'])
                need(pair[0]['type'] == pair[1]['type'], 'schema: effect storage pair')
                self.guard_tags.append(path)
                walk(pair[0]['type'], path + ((0, 0),), depth + 1)
                walk(pair[1]['type'], path + ((0, 1),), depth + 1)
            walk(fields[1]['type'], ((0, 1),), 0)
            need(len(set(leaves)) == 1 and len(leaves) in (2, 4, 8), 'schema: effect vector capacity')
            self.effect = leaves[0]
        self.slots = len(self.slot_paths)
        variants = [last(v['name']) for v in s.adt(self.effect)['variants']]
        self.kind = 'cpi-v1' if 'Invoke' in variants else 'token-v2' if 'Mint' in variants else 'token-v1'
        need(interface.get('effects') == self.kind, 'interface: effect kind')
        need(interface.get('effectSlots') == (self.slots if self.slots > 2 else None), 'interface: effect slots')
        self.cpi = self.kind == 'cpi-v1'
        need(not (self.cpi and self.length), 'schema: CPI effect vectors are not supported')
        self.header = 'bend_cpi.h' if self.cpi else 'token.h'
        self.slot_type, self.locations, self.slot_size = slot_layout(self.header)
        self.effect_ctype, self.effects_ctype = s.adt(self.effect)['cType'], s.adt(effects)['cType']
        # variant tag -> (name, selectors, guards, builder(selected values) -> expected slot)
        self.variants = {}
        (self.cpi_spec if self.cpi else self.token_spec)(variants)
        need(sorted(self.variants) == list(range(len(variants))), 'schema: effect variant without a specification')

    # -- building blocks ---------------------------------------------------------
    def key_bytes(self, out, loc, path, fields=8):
        need(self.locations[loc][0] == ('bytes', 4 * fields), 'spec: key array size')
        for i in range(fields):
            for j in range(4):
                out[(loc, 4 * i + j)] = ('byte', ('leaf', path + ((0, i),)), j)

    def token_spec(self, names):
        s, effect = self.s, self.effect
        v2 = self.kind == 'token-v2'
        need(sorted(names) == sorted(['None', 'Transfer', 'CheckMint'] + (['Mint', 'Burn', 'BoundTransfer'] if v2 else [])),
             'schema: token effect variants')
        none, transfer, check = (s.variant(effect, n) for n in ('None', 'Transfer', 'CheckMint'))
        need(not none['fields'], 'schema: None carries fields')
        self.variants[none['tag']] = ('None', [], [], lambda sel: zero_slot(self.locations))

        def recipient(out, variant, base, sel, selectors, guards, build):
            i, rtype = s.field(variant, 'recipient')
            options = s.enum(rtype, ['ToActor', 'ToCustody', 'ToOwner'])
            need(not options[0]['fields'] and not options[1]['fields']
                 and [f['name'] for f in options[2]['fields']] == ['key'], 'schema: recipient')
            s.key(options[2]['fields'][0]['type'])
            term = ('tag', base + (i,))
            if not build:
                selectors.append(term)
                guards.append((term, [(0, 2)]))
                return
            out[('recipient',)] = term
            if sel[term] == 2:
                self.key_bytes(out, ('recipient_key',), base + (i,) + ((2, 0),))

        def amount(out, variant, base, guards, build):
            i, atype = s.field(variant, 'amount')
            limbs = s.record(atype, ['lo', 'hi'])
            need(all(s.kind(f['type']) == 'u32' for f in limbs), 'schema: amount limbs')
            if not build:
                guards.append((('tag', base + (i,)), [(0, 0)]))
                return
            out[('amount',)] = ('cat', ('leaf', base + (i,) + ((0, 1),)), ('leaf', base + (i,) + ((0, 0),)))

        def scalars(out, variant, base, names, build):
            for name in names:
                i, _ = s.field(variant, name, 'u32')
                if build:
                    out[(name,)] = ('leaf', base + (i,))

        def mint_key(out, variant, base, build):
            i, ktype = s.field(variant, 'mint_key')
            s.key(ktype)
            if build:
                self.key_bytes(out, ('mint_key',), base + (i,))

        def details(out, variant, prefix, sel, selectors, guards, build):
            """Transfer fields; `prefix` is the path of the record holding them."""
            wrap = _Fields(prefix, variant['tag'])
            need([f['name'] for f in variant['fields']] ==
                 ['source', 'destination', 'mint', 'mint_key', 'recipient', 'amount', 'authority'],
                 'schema: transfer fields')
            scalars(out, variant, wrap, ['source', 'destination', 'mint'], build)
            mint_key(out, variant, wrap, build)
            recipient(out, variant, wrap, sel, selectors, guards, build)
            amount(out, variant, wrap, guards, build)
            i, atype = s.field(variant, 'authority')
            options = s.enum(atype, ['Actor', 'Custody'])
            need(not options[0]['fields'] and not options[1]['fields'], 'schema: authority')
            term = ('tag', wrap + (i,))
            if build:
                out[('active',)] = ('const', 1)
                out[('authority',)] = term
            else:
                guards.append((term, [(0, 1)]))

        def declare(variant, name, body):
            selectors, guards = [], []
            body({}, None, selectors, guards, False)

            def build(sel):
                out = zero_slot(self.locations)
                body(out, sel, None, None, True)
                return out
            self.variants[variant['tag']] = (name, selectors, guards, build)

        declare(transfer, 'Transfer', lambda out, sel, selectors, guards, build:
                details(out, transfer, (), sel, selectors, guards, build))

        def check_body(out, sel, selectors, guards, build):
            need([f['name'] for f in check['fields']] == ['mint', 'mint_key'], 'schema: CheckMint fields')
            base = _Fields((), check['tag'])
            scalars(out, check, base, ['mint'], build)
            mint_key(out, check, base, build)
            if build:
                out[('active',)] = ('const', 2)
        declare(check, 'CheckMint', check_body)
        if not v2:
            return
        mint, burn, bound = (s.variant(effect, n) for n in ('Mint', 'Burn', 'BoundTransfer'))

        def mint_body(out, sel, selectors, guards, build):
            need([f['name'] for f in mint['fields']] ==
                 ['destination', 'mint', 'mint_key', 'recipient', 'amount', 'initialize'], 'schema: Mint fields')
            base = _Fields((), mint['tag'])
            scalars(out, mint, base, ['destination', 'mint'], build)
            mint_key(out, mint, base, build)
            recipient(out, mint, base, sel, selectors, guards, build)
            amount(out, mint, base, guards, build)
            i, _ = s.field(mint, 'initialize', 'bool')
            if build:
                out[('active',)], out[('authority',)] = ('const', 3), ('const', 1)
                out[('initialize',)] = ('leaf', base + (i,))
            else:
                guards.append((('leaf', base + (i,)), [(0, 1)]))
        declare(mint, 'Mint', mint_body)

        def burn_body(out, sel, selectors, guards, build):
            need([f['name'] for f in burn['fields']] == ['source', 'mint', 'mint_key', 'amount'], 'schema: Burn fields')
            base = _Fields((), burn['tag'])
            scalars(out, burn, base, ['source', 'mint'], build)
            mint_key(out, burn, base, build)
            amount(out, burn, base, guards, build)
            if build:
                out[('active',)] = ('const', 4)
        declare(burn, 'Burn', burn_body)

        def bound_body(out, sel, selectors, guards, build):
            need([f['name'] for f in bound['fields']] == ['transfer', 'source', 'destination', 'fresh_destination'],
                 'schema: BoundTransfer fields')
            base = _Fields((), bound['tag'])
            inner = s.adt(bound['fields'][0]['type'])
            need(len(inner['variants']) == 1 and inner['variants'][0]['fields'] == transfer['fields'],
                 'schema: bound transfer details')
            need(bound['fields'][1]['type'] == bound['fields'][2]['type'], 'schema: binding types differ')
            if not build:
                guards.append((('tag', base + (0,)), [(0, 0)]))
            details(out, inner['variants'][0], base + (0,), sel, selectors, guards, build)
            for i, (flag, keys) in ((1, ('source_bound', 'source_key')), (2, ('destination_bound', 'destination_key'))):
                options = s.enum(bound['fields'][i]['type'], ['Any', 'Exact'])
                need(not options[0]['fields'] and [f['name'] for f in options[1]['fields']] == ['key'], 'schema: binding')
                s.key(options[1]['fields'][0]['type'])
                term = ('tag', base + (i,))
                if not build:
                    selectors.append(term)
                    guards.append((term, [(0, 1)]))
                    continue
                out[(flag,)] = term
                if sel[term] == 1:
                    self.key_bytes(out, (keys,), base + (i,) + ((1, 0),))
            need(s.kind(bound['fields'][3]['type']) == 'bool', 'schema: fresh_destination')
            if build:
                out[('fresh_destination',)] = ('leaf', base + (3,))
            else:
                guards.append((('leaf', base + (3,)), [(0, 1)]))
        declare(bound, 'BoundTransfer', bound_body)

    def cpi_spec(self, names):
        s = self.s
        need(names == ['None', 'Invoke'], 'schema: CPI effect variants')
        none, invoke = s.variant(self.effect, 'None'), s.variant(self.effect, 'Invoke')
        need(not none['fields'] and [f['name'] for f in invoke['fields']] ==
             ['program', 'program_key', 'length', 'data', 'count', 'accounts'], 'schema: Invoke fields')
        base = _Fields((), invoke['tag'])
        index = {name: s.field(invoke, name)[0] for name in ('program', 'program_key', 'length', 'data', 'count', 'accounts')}
        for name in ('program', 'length', 'count'):
            s.field(invoke, name, 'u32')
        s.key(invoke['fields'][index['program_key']]['type'])
        data = s.record(invoke['fields'][index['data']]['type'], list('abcdefghijklmnop'))
        need(all(s.kind(f['type']) == 'u32' for f in data), 'schema: CPI data limbs')
        metas = s.record(invoke['fields'][index['accounts']]['type'], list('abcdefgh'))
        need(len({f['type'] for f in metas}) == 1, 'schema: CPI meta types differ')
        meta = s.record(metas[0]['type'], ['index', 'key', 'writable', 'signer'])
        need(s.kind(meta[0]['type']) == 'u32' and s.kind(meta[2]['type']) == 'bool' and s.kind(meta[3]['type']) == 'bool',
             'schema: CPI meta fields')
        s.key(meta[1]['type'])

        def build(sel):
            out = zero_slot(self.locations)
            out[('active',)] = ('const', 1)
            for name in ('program', 'length', 'count'):
                out[(name,)] = ('leaf', base + (index[name],))
            self.key_bytes(out, ('program_key',), base + (index['program_key'],))
            self.key_bytes(out, ('data',), base + (index['data'],), 16)
            for i in range(8):
                at = base + (index['accounts'],) + ((0, i),)
                out[('metas', i, 'index')] = ('leaf', at + ((0, 0),))
                self.key_bytes(out, ('metas', i, 'key'), at + ((0, 1),))
                out[('metas', i, 'writable')] = ('leaf', at + ((0, 2),))
                out[('metas', i, 'signer')] = ('leaf', at + ((0, 3),))
            return out
        self.variants[none['tag']] = ('None', [], [], lambda sel: zero_slot(self.locations))
        self.variants[invoke['tag']] = ('Invoke', [], [], build)

    def checkable(self, tag):
        """Every tag and Bool term below effect variant `tag`, with the chain
        of (tag term, variant) choices under which it exists."""
        s, out = self.s, []

        def visit(name, path, under):
            if s.kind(name) == 'bool':
                out.append((('leaf', path), under))
            if s.kind(name) != 'adt':
                return
            t = s.types[name]
            out.append((('tag', path), under))
            for v in t['variants']:
                inner = under + ([(('tag', path), v['tag'])] if len(t['variants']) > 1 else [])
                for i, f in enumerate(v['fields']):
                    visit(f['type'], path + ((v['tag'], i),), inner)
        variant = s.adt(self.effect)['variants'][tag]
        for i, f in enumerate(variant['fields']):
            visit(f['type'], ((tag, i),), [])
        return out


class _Fields(tuple):
    """Path prefix of a variant's fields: `base + (i,)` is field i's path."""

    def __new__(cls, prefix, tag):
        self = super().__new__(cls, prefix)
        self.tag = tag
        return self

    def __add__(self, other):
        if len(other) == 1 and isinstance(other[0], int):
            return tuple(self) + ((self.tag, other[0]),)
        return tuple(self) + tuple(other)


# ---- Restricted parser for the two bodies -------------------------------------------
MEMBER = re.compile(r'[cf](0|[1-9][0-9]*)\Z')


def expression_calls(node):
    return isinstance(node, tuple) and (node[0] == 'call' or any(expression_calls(x) for x in node[1:]))


class Parser:
    LEVELS = [('||',), ('&&',), ('|',), ('==', '!='), ('<', '>', '<=', '>='), ('<<',), ('+',)]

    def __init__(self, tokens, slot_type, calls):
        self.t, self.at, self.slot_type, self.calls = tokens, 0, slot_type, calls

    def peek(self, ahead=0):
        return self.t[self.at + ahead] if self.at + ahead < len(self.t) else ''

    def take(self, *expected):
        for token in expected:
            need(self.peek() == token, f'effect extraction: expected {token!r}, found {self.peek()!r}')
            self.at += 1

    def exact(self, text, what):
        tokens = strict_tokens(text)
        need(self.t[self.at:self.at + len(tokens)] == tokens, f'effect extraction: {what} differs from the schema')
        self.at += len(tokens)

    def body(self):
        out = []
        while self.peek() != '}':
            need(self.peek() != '', 'effect extraction: unterminated body')
            out.append(self.statement())
        self.take('}')
        return out

    def zero(self):
        self.take('(', self.slot_type, ')', '{')
        need(self.peek() == '0', 'effect extraction: slot initializer is not {0}')
        self.take('0', '}', ';')

    def statement(self):
        token = self.peek()
        if token == '{':
            self.take('{')
            return ('block', self.body())
        if token == 'if':
            self.take('if', '(')
            cond = self.expr()
            self.take(')')
            then, other = self.statement(), None
            if self.peek() == 'else':
                self.take('else')
                other = self.statement()
            return ('if', cond, then, other)
        if token == 'return':
            self.take('return')
            value = self.expr()
            self.take(';')
            return ('return', value)
        if token == '*':
            self.take('*', 'out', '=')
            self.zero()
            return ('zero', None)
        need(token in ('out', 'write_le'), f'effect extraction: unsupported statement at {token!r}')
        target = self.postfix()
        if target[0] == 'call':
            need(target[1] == 'write_le', 'effect extraction: call result is discarded')
            self.take(';')
            return ('write', target[2])
        self.take('=')
        if self.peek() == '(' and self.peek(1) == self.slot_type:
            self.zero()
            return ('zero', target)
        value = self.expr()
        self.take(';')
        return ('assign', target, value)

    def expr(self, level=0):
        if level == len(self.LEVELS):
            return self.unary()
        left = self.expr(level + 1)
        while self.peek() in self.LEVELS[level]:
            op = self.peek()
            self.at += 1
            left = ('bin', op, left, self.expr(level + 1))
        return left

    def unary(self):
        token = self.peek()
        if token == '!':
            self.take('!')
            return ('not', self.unary())
        if token == '&':
            self.take('&')
            return ('addr', self.postfix())
        if token == '(' and self.peek(2) in (')', '*') and IDENT.match(self.peek(1)) and self.peek(1) not in ('value', 'out'):
            need(self.peek(1) == 'u64' and self.peek(2) == ')', f'effect extraction: unsupported cast to {self.peek(1)!r}')
            self.at += 3
            return ('cast', self.unary())
        return self.postfix()

    def postfix(self):
        token = self.peek()
        if token == '(':
            self.take('(')
            node = self.expr()
            self.take(')')
            return node
        if NUMBER.match(token):
            self.at += 1
            return literal(token)
        need(token in ('value', 'out') or token in self.calls, f'effect extraction: unexpected identifier or operator {token!r}')
        self.at += 1
        if token in self.calls:
            self.take('(')
            args = [self.expr()]
            while self.peek() == ',':
                self.take(',')
                args.append(self.expr())
            self.take(')')
            return ('call', token, args)
        node = ('id', token)
        while True:
            token = self.peek()
            if token in ('->', '.'):
                self.at += 1
                name = self.peek()
                need(IDENT.match(name) is not None, 'effect extraction: member name')
                self.at += 1
                node = ('arrow' if token == '->' else 'member', node, name)
            elif token == '[':
                self.take('[')
                need(NUMBER.match(self.peek()) is not None, 'effect extraction: non-constant index')
                node = ('index', node, literal(self.peek())[1])
                self.at += 1
                self.take(']')
            else:
                return node


# ---- Abstract execution ------------------------------------------------------------
class Fork(Exception):
    pass


class Run:
    """One execution of a parsed body under a list of branch decisions."""

    def __init__(self, spec, root, plural, decisions):
        self.spec, self.s, self.root, self.plural = spec, spec.s, root, plural
        self.decisions, self.cursor = decisions, 0
        self.cons, self.out, self.slots, self.failed, self.ret = {}, None, {}, False, None
        self.writes = 0

    # input paths ---------------------------------------------------------------
    def chain(self, node):
        steps = []
        while node[0] in ('arrow', 'member'):
            steps.append((node[0], node[2]))
            node = node[1]
        return node, steps[::-1]

    def input(self, steps):
        """Typed access path -> ('tag'|'leaf'|'object', path)."""
        need(steps and steps[0][0] == 'arrow' and all(kind == 'member' for kind, _ in steps[1:]),
             'effect extraction: malformed input access')
        names, path, name = [n for _, n in steps], (), self.root
        at = 0
        while at < len(names):
            t = self.s.adt(name)
            if names[at] == 'tag':
                need(at == len(names) - 1, 'effect extraction: member of a tag')
                return ('tag', path)
            need(names[at] == 'as' and at + 2 < len(names) and MEMBER.match(names[at + 1]) and names[at + 1][0] == 'c'
                 and MEMBER.match(names[at + 2]) and names[at + 2][0] == 'f', 'effect extraction: malformed input access')
            k, i = int(names[at + 1][1:]), int(names[at + 2][1:])
            need(k < len(t['variants']) and i < len(t['variants'][k]['fields']),
                 f'effect extraction: {show(path)} has no member c{k}.f{i}')
            if len(t['variants']) > 1:
                need(self.cons.get(('tag', path)) == [(k, k)],
                     f'effect extraction: reads variant c{k} of {show(path)} without its tag being established')
            path, name = path + ((k, i),), t['variants'][k]['fields'][i]['type']
            at += 3
        return ('object' if self.s.kind(name) == 'adt' else 'leaf', path)

    # output locations ----------------------------------------------------------
    def location(self, node):
        need(not self.plural, 'effect extraction: slot member access in the plural function')
        base, steps = self.chain(node)
        loc = None
        if base == ('id', 'out') and len(steps) == 1 and steps[0][0] == 'arrow':
            loc = (steps[0][1],)
        elif base[0] == 'index' and len(steps) == 1 and steps[0][0] == 'member':
            inner, inner_steps = self.chain(base[1])
            if inner == ('id', 'out') and len(inner_steps) == 1 and inner_steps[0][0] == 'arrow':
                loc = (inner_steps[0][1], base[2], steps[0][1])
        need(loc is not None and loc in self.spec.locations, 'effect extraction: write or read outside the named slot members')
        need(self.out is not None, 'effect extraction: slot used before it is zeroed')
        return loc, self.spec.locations[loc][0]

    # decisions -----------------------------------------------------------------
    def choose(self):
        if self.cursor == len(self.decisions):
            raise Fork()
        self.cursor += 1
        return self.decisions[self.cursor - 1]

    def decide(self, term, truth):
        current = self.cons.get(term, FULL)
        yes, no = inter(current, truth), inter(current, comp(truth))
        if not no or not yes:
            return bool(yes)
        choice = self.choose()
        self.cons[term] = yes if choice else no
        return choice

    # expressions: (term, width) ---------------------------------------------------
    def eval(self, node):
        kind = node[0]
        if kind == 'num':
            return ('const', node[1]), 64 if node[2] == 'u64' else 32
        if kind in ('arrow', 'member'):
            base, steps = self.chain(node)
            if base == ('id', 'value'):
                term = self.input(steps)
                need(term[0] != 'object', 'effect extraction: aggregate used as a value')
                return term, 32
            loc, ctype = self.location(node)
            need(not isinstance(ctype, tuple), 'effect extraction: byte array used as a value')
            return self.out[loc], 64 if ctype == 'u64' else 32
        if kind == 'cast':
            term, width = self.eval(node[1])
            need(width == 32 and term[0] in ('leaf', 'tag', 'const'), 'effect extraction: unsupported cast operand')
            return (term if term[0] == 'const' else ('zext', term)), 64
        if kind == 'not':
            return ('const', 0 if self.truth(node[1]) else 1), 32
        if kind == 'call':
            return ('const', 1 if self.call(node) else 0), 32
        need(kind == 'bin', 'effect extraction: unsupported expression')
        op = node[1]
        if op == '&&':
            return ('const', 1 if self.truth(node[2]) and self.truth(node[3]) else 0), 32
        if op == '||':
            return ('const', 1 if self.truth(node[2]) or self.truth(node[3]) else 0), 32
        need(not expression_calls(node[2]) and not expression_calls(node[3]),
             'effect extraction: calls in unsequenced operands are unsupported')
        (a, wa), (b, wb) = self.eval(node[2]), self.eval(node[3])
        if op == '<<':
            need(wa == 64 and a[0] == 'zext', 'effect extraction: shift of a value that was not widened to 64 bits '
                 '(truncated high limb)')
            need(b == ('const', 32), 'effect extraction: shift amount is not 32')
            return ('high', a[1]), 64
        if op == '|':
            if a[0] == 'high' and b[0] == 'zext':
                a, b = b, a
            need(a[0] == 'zext' and b[0] == 'high' and wa == wb == 64, 'effect extraction: unsupported 64-bit combination')
            return ('cat', b[1], a[1]), 64
        need(op in FLIP, f'effect extraction: unsupported operator {op!r}')
        need(wa == 32 and wb == 32, 'effect extraction: 64-bit comparison')
        if a[0] == 'const' and b[0] == 'const':
            return ('const', 1 if inter([(a[1], a[1])], atom(op, b[1])) else 0), 32
        if a[0] == 'const':
            a, b, op = b, a, FLIP[op]
        need(a[0] in ('leaf', 'tag') and b[0] == 'const', 'effect extraction: comparison is not term-versus-constant')
        return ('const', 1 if self.decide(a, atom(op, b[1])) else 0), 32

    def truth(self, node):
        term, _ = self.eval(node)
        need(term[0] == 'const', 'effect extraction: condition is not a comparison')
        return term[1] != 0

    def call(self, node):
        need(self.plural and node[1] == 'bend_extract_effect' and len(node[2]) == 2,
             'effect extraction: unsupported call')
        source, target = node[2]
        need(source[0] == 'addr' and target[0] == 'addr', 'effect extraction: extraction arguments are not addresses')
        base, steps = self.chain(source[1])
        need(base == ('id', 'value'), 'effect extraction: extraction source is not the input')
        term = self.input(steps)
        need(term[0] == 'object' and self.s.at(self.root, term[1]) == self.spec.effect,
             'effect extraction: extraction source is not an effect')
        slot = self.slot(target[1])
        ok = self.choose()
        self.failed = self.failed or not ok
        self.slots[slot] = ('extracted', term[1], ok)
        return ok

    def slot(self, node):
        need(node[0] == 'index' and node[1] == ('id', 'out'), 'effect extraction: output is not an indexed slot')
        need(node[2] < self.spec.slots, f'effect extraction: slot index {node[2]} is outside the {self.spec.slots} output slots')
        return node[2]

    # statements ----------------------------------------------------------------
    def block(self, statements):
        for statement in statements:
            if self.step(statement):
                return True
        return False

    def step(self, statement):
        kind = statement[0]
        if kind == 'block':
            return self.block(statement[1])
        if kind == 'if':
            branch = statement[2] if self.truth(statement[1]) else statement[3]
            return self.step(branch) if branch is not None else False
        if kind == 'return':
            term, _ = self.eval(statement[1])
            need(term[0] == 'const' and term[1] in (0, 1), 'effect extraction: return value is not a 0/1 result')
            self.ret = term[1]
            return True
        if kind == 'zero':
            if statement[1] is None:
                need(not self.plural, 'effect extraction: unindexed slot write in the plural function')
                self.out = zero_slot(self.spec.locations)
            else:
                need(self.plural, 'effect extraction: indexed slot write in the single function')
                self.slots[self.slot(statement[1])] = ('zero',)
            return False
        if kind == 'assign':
            loc, ctype = self.location(statement[1])
            need(not isinstance(ctype, tuple), 'effect extraction: assignment to a byte array')
            term, width = self.eval(statement[2])
            need(width == (64 if ctype == 'u64' else 32), 'effect extraction: assignment changes the value width')
            need(term[0] in (('cat', 'const') if ctype == 'u64' else ('leaf', 'tag', 'const')),
                 'effect extraction: unsupported assigned value')
            self.out[loc] = term
            self.writes += 1
            return False
        need(kind == 'write' and len(statement[1]) == 3, 'effect extraction: unsupported statement')
        pointer, value, count = statement[1]
        need(pointer[0] == 'bin' and pointer[1] == '+' and pointer[3][0] == 'num' and count[0] == 'num',
             'effect extraction: write_le target is not `slot byte array + constant` with a constant length')
        loc, ctype = self.location(pointer[2])
        need(isinstance(ctype, tuple), 'effect extraction: write_le target is not a slot byte array')
        term, width = self.eval(value)
        need(width == 32 and term[0] == 'leaf', 'effect extraction: write_le source is not a 32-bit input field')
        offset, n = pointer[3][1], count[1]
        need(n == 4, 'effect extraction: write_le length is not the four bytes of the limb')
        need(offset + n <= ctype[1], f'effect extraction: write_le writes bytes {offset}..{offset + n - 1} outside '
             f'{".".join(map(str, loc))}[{ctype[1]}]')
        for j in range(n):
            self.out[(loc, offset + j)] = ('byte', term, j)
        self.writes += 1
        return False


def contains(statements, predicate):
    for statement in statements:
        if predicate(statement):
            return True
        if statement[0] == 'block' and contains(statement[1], predicate):
            return True
        if statement[0] == 'if' and contains([x for x in statement[2:] if x is not None], predicate):
            return True
    return False


def explore(spec, root, plural, body):
    done, pending = [], [[]]
    while pending:
        decisions = pending.pop()
        run = Run(spec, root, plural, decisions)
        try:
            need(run.block(body), 'effect extraction: control reaches the end of the function without a return')
        except Fork:
            pending += [decisions + [False], decisions + [True]]
            need(len(pending) + len(done) <= PATH_LIMIT, 'effect extraction: path limit exceeded')
            continue
        need(run.cursor == len(decisions), 'effect extraction: internal decision mismatch')
        done.append(run)
    return done


def values(constraint, limit=16):
    out = [v for lo, hi in constraint for v in range(lo, min(hi, lo + limit) + 1)]
    need(sum(hi - lo + 1 for lo, hi in constraint) == len(out), 'effect extraction: unbounded selector')
    return out


def check_single(spec, body):
    """bend_extract_effect: every path against the per-variant specification."""
    need(body and body[0] == ('zero', None), 'effect extraction: the slot is not zeroed first (missing zeroing)')
    need(not contains(body[1:], lambda st: st == ('zero', None)), 'effect extraction: repeated slot initialization')
    s, root = spec.s, spec.effect
    runs = explore(spec, root, False, body)
    top = ('tag', ())
    seen, guarded, unguarded, accepted = {}, set(), set(), 0
    for run in runs:
        if run.ret == 0:
            # A rejection must be explained by a term outside its well-formed domain.
            need(any(not inter(c, s.domain(root, term)) for term, c in run.cons.items()),
                 'effect extraction: a well-formed effect is rejected (conditional omission)')
            continue
        accepted += 1
        tag = run.cons.get(top, FULL)
        need(len(tag) == 1 and tag[0][0] == tag[0][1] and tag[0][0] in spec.variants,
             'effect extraction: success without an established effect variant')
        k = tag[0][0]
        name, selectors, guards, build = spec.variants[k]
        for term, domain in guards:
            need(within(run.cons.get(term, FULL), domain),
                 f'effect extraction: {name} succeeds without the guard on {show_term(term)}')
        for term, under in spec.checkable(k):
            if all(run.cons.get(parent) == [(variant, variant)] for parent, variant in under):
                (guarded if within(run.cons.get(term, FULL), s.domain(root, term)) else unguarded).add(term)
        choices = [[]]
        for term in selectors:
            choices = [c + [(term, v)] for c in choices for v in values(run.cons[term])]
        for choice in choices:
            expected = build(dict(choice))
            need(set(expected) == set(run.out), 'effect extraction: internal slot shape mismatch')
            for loc in expected:
                if expected[loc] != run.out[loc]:
                    where = f'{".".join(map(str, loc[0]))}[{loc[1]}]' if isinstance(loc[0], tuple) else '.'.join(map(str, loc))
                    raise Grammar(f'effect extraction: {name} maps slot member {where} to {describe(run.out[loc])}, '
                                  f'expected {describe(expected[loc])} (wrong field mapping)')
            seen.setdefault(k, set()).add(tuple(choice))
    # Coverage: every variant and every selector combination has a success path.
    for k, (name, selectors, guards, build) in spec.variants.items():
        combos = [[]]
        for term in selectors:
            combos = [c + [(term, v)] for c in combos for v in values(s.domain(root, term))]
        need(seen.get(k) == {tuple(c) for c in combos}, f'effect extraction: {name} is not extracted for every well-formed value')
    unchecked = sorted(unguarded)
    return {
        'paths': len(runs), 'successPaths': accepted,
        'variants': [{'tag': k, 'name': spec.variants[k][0], 'selectorCases': len(seen[k]),
                      'mapping': mapping(spec, k)} for k in sorted(spec.variants)],
        'guardedTerms': sorted(show_term(t) for t in guarded - unguarded) + [show_term(top)],
        'uncheckedTerms': [show_term(t) for t in unchecked],
    }


def describe(term):
    if term[0] == 'byte':
        return f'byte {term[2]} of {show_term(term[1])}'
    return show_term(term)


def mapping(spec, k):
    """Readable expected mapping, with every selector at its key-carrying value."""
    name, selectors, guards, build = spec.variants[k]
    expected = build({term: spec.s.domain(spec.effect, term)[0][1] for term in selectors})
    out, arrays = {}, {}
    for loc, term in expected.items():
        if isinstance(loc[0], tuple):
            arrays.setdefault(loc[0], {})[loc[1]] = term
        elif term != ('const', 0):
            out['.'.join(map(str, loc))] = show_term(term)
    for loc, table in arrays.items():
        if all(t == ('const', 0) for t in table.values()):
            continue
        limbs = []
        for at in range(0, len(table), 4):
            need(all(table[at + j] == ('byte', table[at][1], j) for j in range(4)), 'spec: limb layout')
            limbs.append(show_term(table[at][1]))
        out['.'.join(map(str, loc))] = {'littleEndianLimbs': limbs}
    return out


def check_plural(spec, body):
    """bend_extract_effects: traversal, guards and zeroing of inactive slots."""
    s, root, n = spec.s, spec.effects, spec.slots
    runs = explore(spec, root, True, body)
    tags = [('tag', path) for path in spec.guard_tags]
    length = ('leaf', spec.length) if spec.length else None
    lengths = set()
    for run in runs:
        if run.ret == 0:
            need(run.failed or any(not inter(run.cons.get(t, FULL), [(0, 0)]) for t in tags)
                 or (length is not None and not inter(run.cons.get(length, FULL), [(0, n)])),
                 'effect extraction: well-formed effects are rejected (conditional omission)')
            continue
        need(not run.failed, 'effect extraction: success after a failed slot extraction')
        for term in tags:
            need(run.cons.get(term) == [(0, 0)], f'effect extraction: success without the guard on {show_term(term)}')
        counts = [n]
        if length is not None:
            need(within(run.cons.get(length, FULL), [(0, n)]), 'effect extraction: success without the length bound')
            counts = values(run.cons[length])
        for count in counts:
            lengths.add(count)
            for i in range(n):
                got = run.slots.get(i)
                if i < count:
                    need(got == ('extracted', spec.slot_paths[i], True),
                         f'effect extraction: slot {i} is not extracted from {show(spec.slot_paths[i])} '
                         f'(partial slots or wrong traversal)')
                else:
                    need(got == ('zero',), f'effect extraction: inactive slot {i} is not zeroed')
    need(lengths == (set(range(n + 1)) if length is not None else {n}), 'effect extraction: a well-formed length has no success path')
    return {'paths': len(runs), 'slots': n, 'layout': 'vector' if length is not None else 'fixed',
            'slotSources': [show(p) for p in spec.slot_paths],
            'guardedTerms': [show_term(t) for t in tags] + ([f'{show_term(length)} <= {n}'] if length is not None else []),
            'activeLengths': sorted(lengths)}


# ---- Dependency audit -----------------------------------------------------------------
def native_typedef(s, name):
    t = s.types[name]
    members = []
    for v in t['variants']:
        inner = ' '.join(f'{s.types[f["type"]]["cType"]} f{i};' for i, f in enumerate(v['fields'])) or 'bend_u32 unused;'
        members.append(f'struct {{ {inner} }} c{v["tag"]};')
    return 'typedef struct { bend_u32 tag; union { ' + ' '.join(members) + f' }} as; }} {t["cType"]};'


def audit(spec, includes, region, files):
    need(len(includes) == 3 and includes[0][0].endswith('.wire.h') and includes[0][1] == '"'
         and includes[1] == ('solana_min.h', '"') and includes[2] == (spec.header, '<' if spec.cpi else '"'),
         f'preprocessing: includes {includes} differ from the effectful adapter form')
    wire = includes[0][0]
    native = wire[:-len('.wire.h')] + '.h'
    macros, seen, queue = {}, [], [name for name, _ in includes]
    while queue:
        name = queue.pop()
        if name in seen:
            continue
        need(name in files, f'dependencies: include {name!r} was not recorded')
        seen.append(name)
        defined, included = header_directives(name, files[name])
        # Preserve the include search form. The fixture resolver must not
        # substitute a local quoted header for a potentially different <...>.
        ht = header_tokens(files[name])
        forms = [ht[i + 2] for i in range(len(ht) - 2) if ht[i:i + 2] == ['#', 'include']]
        need(forms == [f'"{child}"' for child in included],
             f'preprocessing: dependency {name} includes must use quoted recorded headers')
        for macro in defined:
            macros.setdefault(macro, name)
        queue += included
    need(native in seen, 'dependencies: native header is not in the include closure')
    clash = sorted({t for t in region if IDENT.match(t)} & set(macros))
    need(not clash, f'preprocessing: dependency macro {clash[0] if clash else ""!r} could rewrite the extraction text')

    def exact(name, snippets):
        tokens = audited_header_tokens(name, files[name])
        for snippet in snippets:
            # Macros can rewrite audited typedefs or write_le even when the
            # macro name never occurs in an extraction function body.
            protected = {t for t in header_tokens(snippet) if IDENT.match(t)}
            clash = sorted(protected & set(macros))
            need(not clash, f'preprocessing: dependency macro {clash[0] if clash else ""!r} could rewrite an audited dependency')
            need(has_file_scope_tokens(tokens, header_tokens(snippet)),
                 f'dependencies: {name} differs from the reviewed text near {snippet[:48]!r}')
    exact('solana_min.h', SOLANA_TEXT)
    exact(spec.header, SLOT_TEXT[spec.header])
    reachable = spec.s.reachable(spec.effects)
    exact(native, ['typedef unsigned int bend_u32;', '_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");']
          + [native_typedef(spec.s, name) for name in reachable])
    return {'includeClosure': sorted(seen), 'nativeHeader': native, 'nativeTypedefsAudited': len(reachable),
            'slotStruct': spec.slot_type, 'slotBytes': spec.slot_size, 'slotPaddingBytes': 0,
            'layoutBasis': 'Derived from reviewed declarations under natural alignment of 8/32/64-bit unsigned types',
            'sha256': {name: hashlib.sha256(files[name].encode()).hexdigest() for name in sorted(seen)},
            'slotMembers': {'.'.join(map(str, loc)): {'type': kind if isinstance(kind, str) else f'u8[{kind[1]}]', 'offset': offset}
                            for loc, (kind, offset) in sorted(spec.locations.items(), key=lambda x: x[1][1])},
            'writeLe': 'exact body audited; summarized as p[i] = (u8)(v >> 8*i) for i < n'}


# ---- Public API ------------------------------------------------------------------------
def extraction_metadata(schema, interface):
    """Schema-derived facts a caller needs without reading any adapter text."""
    spec = Spec(schema, interface)
    if spec.kind == 'none':
        return {'kind': 'none', 'slots': 0}
    return {'kind': spec.kind, 'slots': spec.slots, 'layout': 'vector' if spec.length else 'fixed',
            'header': spec.header, 'slotType': spec.slot_type, 'slotBytes': spec.slot_size,
            'effectType': spec.effect_ctype, 'effectsType': spec.effects_ctype,
            'slotSources': [show(p) for p in spec.slot_paths]}


def check_extraction(schema, interface, adapter_text, files):
    """Check the emitted extraction functions of one ABI 1 adapter.

    `schema`/`interface` are the recorded JSON fixtures, `adapter_text` the
    written adapter translation unit and `files` its include closure by file
    name. Returns JSON-serializable evidence, or raises Grammar. A pure adapter
    yields an explicit no-extraction result after confirming that it defines
    and mentions no extraction function.
    """
    spec = Spec(schema, interface)
    includes, tokens = split_includes(adapter_text)
    digest = hashlib.sha256(adapter_text.encode()).hexdigest()
    if spec.kind == 'none':
        need(not any(t.startswith('bend_extract_effect') for t in tokens),
             'effect extraction: a pure adapter mentions effect extraction')
        need([name for name, _ in includes][1:] == ['solana_min.h'], 'preprocessing: includes of a pure adapter')
        return {'passed': True, 'kind': 'none', 'extraction': 'none',
                'reason': 'the schema root accepts a state without effects and the adapter mentions no extraction function',
                'adapterSha256': digest}
    parser = Parser(tokens, spec.slot_type, ('write_le',))
    parser.exact(f'static inline int bend_extract_effect(const {spec.effect_ctype} *value, {spec.slot_type} *out) {{',
                 'single extraction signature')
    single = parser.body()
    parser.calls = ('bend_extract_effect',)
    parser.exact(f'static inline int bend_extract_effects(const {spec.effects_ctype} *value, {spec.slot_type} *out) {{',
                 'plural extraction signature')
    plural = parser.body()
    region, rest = tokens[:parser.at], tokens[parser.at:]
    for name in ('bend_extract_effect', 'bend_extract_effects'):
        need(not any(rest[i] == name and rest[i - 1] == 'int' for i in range(1, len(rest))),
             'effect extraction: extraction function declared again after the checked definitions')
    dependencies = audit(spec, includes, region, files)
    return {
        'passed': True, 'kind': spec.kind, 'extraction': 'checked', 'scope': SCOPE,
        'adapterSha256': digest, 'extractionTokens': len(region),
        'effectType': spec.effect_ctype, 'effectsType': spec.effects_ctype,
        'single': check_single(spec, single), 'plural': check_plural(spec, plural),
        'established': [
            'Both bodies consist only of the accepted statement forms; every token is accounted for.',
            'Single function: the whole slot is zeroed before any other statement, so every slot member is '
            'initialized on every return (success or failure); every later write is an assignment to a named scalar '
            'member or a four-byte write_le inside a named byte array of the same slot object.',
            'Single function: for every well-formed input the function returns 1 and the slot equals the '
            'schema-derived mapping of the input variant (opcode, scalars, key limbs, 64-bit amount, zero elsewhere); '
            'every return of 0 is explained by a tag or Bool outside its declared domain.',
            'Single function: a union member of a multi-variant value is read only after its tag was compared equal.',
            'Plural function: on return 1 every declared slot is either extracted from its schema-derived source by '
            'a successful bend_extract_effect call or, for a vector, zeroed when its index is not below the length; '
            'slot indices are constants below the slot count; record tags and the length bound are guarded.',
        ],
        'runtimeConventions': RUNTIME_CONVENTIONS['cpi' if spec.cpi else 'token'],
        'dependencies': dependencies, 'preconditions': PRECONDITIONS, 'limitations': LIMITATIONS, 'trustedBridge': BRIDGE,
    }


def main():
    payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
    results = {}
    for f in payload['fixtures']:
        evidence = check_extraction(f['schema'], f['interface'], f['files'][f['adapter']], f['files'])
        results[f['name']] = evidence
        if evidence['extraction'] == 'none':
            print(f'{f["name"]}: no extraction (pure adapter)')
        else:
            print(f'{f["name"]}: {evidence["kind"]}, {evidence["plural"]["slots"]} {evidence["plural"]["layout"]} slots, '
                  f'{evidence["single"]["paths"]} single paths ({evidence["single"]["successPaths"]} success), '
                  f'{evidence["plural"]["paths"]} plural paths, {len(evidence["single"]["uncheckedTerms"])} unchecked terms')
    if len(sys.argv) > 2:
        pathlib.Path(sys.argv[2]).write_text(json.dumps(results, indent=2) + '\n')


if __name__ == '__main__':
    try:
        main()
    except Grammar as error:
        raise SystemExit(f'effect extraction check failed: {error}')
