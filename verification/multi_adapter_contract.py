"""Standalone emitted-C symbolic contract for the ABI 2 multi-state adapter.

This module imports only the reviewed restricted C expression/interpreter
machinery used by the ABI 1 gate. ABI 2 storage semantics, schema/interface
validation and the contract below are independent. Every adapter entrypoint is
parsed from its written C and symbolically executed; this is not a template or
pattern-order checker.
"""
import hashlib
import json
import pathlib
import re
import sys
import time

# Load multiprocessing before putting verification/ on sys.path: this directory
# contains queue.py in some revisions and must not shadow stdlib queue.
import multiprocessing  # noqa: F401

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import z3
from adapter_contract_c import (Grammar, IDENT, Parser, audited_header_tokens, header_directives,
                                header_tokens, has_file_scope_tokens, need, split_includes,
                                strict_tokens, unique_file_scope_name)
from adapter_contract_sym import (Dead, Event, Exec, Fatal, Int, Obj, Path, Ptr, Ref, Semantic as SymSemantic,
                                  State, Uninit, World, boolean, concrete, convert, pack, truth, vkey)
from effect_extraction import check_extraction

SCOPE = ('Restricted-grammar symbolic execution of the complete emitted ABI 2 multi-state entrypoint and its '
         'recorded include closure, against an independently validated schema/interface contract, for exactly the '
         'nine listed pure/token/CPI fixtures.')
ASSUMPTIONS = [
    'The restricted lexer/parser, C conversion semantics and reviewed helper-call summaries are trusted bridges, not a C semantics.',
    'u8/u32/u64 are 8/32/64 bits; Clang/LLD/SBF preserve the modeled C behavior.',
    'The loader provides aligned, valid invocation bytes and truthful account flags, lengths, owners, keys and data bounds; read_account returns null exactly for duplicate markers.',
    'read_le and equal_key have their exact audited runtime/solana_min.h meanings; Clock syscall result and slot are unconstrained.',
    'Generated codecs are deterministic uninterpreted functions of exactly the passed bytes/value. Decode and each encode can fail independently; successful encoded bytes are unconstrained. No codec theorem is composed.',
    'The checked Bend root is pure and has an arbitrary tagged result. Context/state/instruction native values are well formed. Root business rules and datatype preservation are not proved.',
    'Custody setup, token/CPI extraction/validation/execution helpers, syscall behavior, loader/rollback and transaction atomicity are trusted summaries. A successful CPI validation summary implies its count is at most eight, as the reviewed helper contract requires; the adapter reads metas only after helper success. Their noninterference with managed-state bytes and saved state/codec buffers is assumed; CPI execution may refresh local accounts[i].size metadata. The CPI meta-count postcondition is an explicit assumption, not a proved adapter obligation.',
    'A failed explicit adapter return performs no adapter commit; runtime aborts during commit rely on Solana transaction rollback.',
    'The including translation unit is the recorded file set and no command-line macro or compiler option rewrites adapter tokens. Include-closure macros and summarized file-scope helper bindings are audited.',
]
NOT_CLAIMED = [
    'ABI 2 proof composition with token/CPI helper, codec, Bend root, loader, rollback, Clang/LLVM or SBF assurance.',
    'General C semantics, memory safety outside modeled reads/writes, runtime abort rollback, compute budget or stack bounds.',
    'Any ABI 2 fixture beyond the exact fixtures recorded in the final report; ABI 1, ABI 3 and unsupported helper forms.',
]


def ident(name):
    return 'bend_' + ''.join(c if c.isascii() and c.isalnum() else f'_{ord(c):x}_' for c in name)


def wire_sizes(schema):
    types = {t['name']: t for t in schema['types']}
    need(len(types) == len(schema['types']), 'schema: duplicate type')
    sizes, active = {}, set()
    def size(name):
        if name in sizes: return sizes[name]
        need(name in types and name not in active, 'schema: unknown or recursive type')
        active.add(name); t = types[name]
        if t['kind'] == 'u32':
            need(t['cType'] == 'bend_u32', 'schema: U32 C type'); n = 4
        elif t['kind'] == 'bool':
            need(t['cType'] == 'bend_u32', 'schema: Bool C type'); n = 1
        else:
            need(t['kind'] == 'adt' and t['variants'] and t['cType'] == ident(name) + '_t', 'schema: ADT type')
            need([v['tag'] for v in t['variants']] == list(range(len(t['variants']))), 'schema: noncanonical tags')
            for variant in t['variants']:
                need(len({f['name'] for f in variant['fields']}) == len(variant['fields']), 'schema: duplicate field name')
            n = 1 + max(sum(size(f['type']) for f in v['fields']) for v in t['variants'])
        active.remove(name); sizes[name] = n; return n
    for t in schema['types']: size(t['name'])
    return types, sizes


def summarize(schema, interface):
    """Validate ABI2 schema and interface independently; derive all contract facts."""
    need(schema.get('version') == 1 and interface.get('version') == 2, 'interface: ABI 2 expected')
    types, sizes = wire_sizes(schema)
    need(interface.get('modes') == {'initialize': 0, 'transition': 1}, 'interface: modes')
    exports = [f for f in schema['exports'] if f['name'] == interface.get('root')]
    need(len(exports) == 1 and len(exports[0]['args']) == 3, 'schema: root signature')
    root = exports[0]; context, state, instruction = root['args']
    need(state == interface.get('state') and instruction == interface.get('instruction'), 'interface: root types')
    def record(name, expected=None):
        t = types.get(name)
        need(t is not None and t['kind'] == 'adt' and len(t['variants']) == 1 and t['variants'][0]['tag'] == 0,
             f'schema: record {name}')
        fields = t['variants'][0]['fields']
        if expected is not None: need([f['name'] for f in fields] == expected, f'schema: field order {name}')
        return fields
    ctx = record(context, ['actor', 'signed', 'slot'])
    key = record(ctx[0]['type'], list('abcdefgh'))
    slot = record(ctx[2]['type'], ['lo', 'hi'])
    need(all(types[f['type']]['kind'] == 'u32' for f in key + slot) and types[ctx[1]['type']]['kind'] == 'bool', 'schema: context fields')
    state_fields = record(state)
    need(2 <= len(state_fields) <= 4 and len({f['name'] for f in state_fields}) == len(state_fields), 'schema: ABI2 state record')
    result = types.get(root['result']); need(result and result['kind'] == 'adt' and len(result['variants']) == 2, 'schema: root result')
    accepted = [v for v in result['variants'] if v['name'].split('.')[-1] == 'Accepted']
    rejected = [v for v in result['variants'] if v['name'].split('.')[-1] == 'Rejected']
    need(len(accepted) == len(rejected) == 1 and [v['tag'] for v in result['variants']] == [0, 1], 'schema: result variants')
    accepted, rejected = accepted[0], rejected[0]
    need(len(accepted['fields']) in (1, 2) and accepted['fields'][0]['name'] == 'state' and accepted['fields'][0]['type'] == state,
         'schema: Accepted state')
    need([f['name'] for f in rejected['fields']] == ['code'] and types[rejected['fields'][0]['type']]['kind'] == 'u32', 'schema: Rejected code')
    effect_type = accepted['fields'][1]['type'] if len(accepted['fields']) == 2 else None
    effects = effect_type is not None
    slots, kind = 0, 'none'
    if effects:
        ef = record(effect_type)
        names = [f['name'] for f in ef]
        if names in (['first', 'second'], ['first', 'second', 'third']):
            need(len({f['type'] for f in ef}) == 1, 'schema: effect slot types')
            effect = types[ef[0]['type']]; slots = len(ef)
        else:
            need(names == ['length', 'storage'], 'schema: unsupported effects layout')
            raise Grammar('schema: ABI2 assurance supports fixed effect records, not vectors')
        variants = [v['name'].split('.')[-1] for v in effect['variants']]
        kind = 'cpi-v1' if 'Invoke' in variants else 'token-v2' if 'Mint' in variants else 'token-v1'
        # Fixed two/three effect records are supported; bounded CPI vectors are
        # rejected by the unsupported-layout branch above.
    fields = state_fields
    account_specs = []
    # BDS1 parent digest follows storageHeader's independently implemented
    # reachable-type traversal and canonical JSON serialization.
    reachable = {}
    def visit(name):
        if name in reachable: return
        t = types[name]
        if t['kind'] == 'adt':
            reachable[name] = {'name': name, 'kind': 'adt', 'variants': [
                {'name': v['name'], 'tag': v['tag'], 'fields': v['fields']} for v in t['variants']]}
            for v in t['variants']:
                for f in v['fields']: visit(f['type'])
        else: reachable[name] = {'name': name, 'kind': t['kind'], **({'max': t['max']} if 'max' in t else {})}
    visit(state)
    parent_digest = hashlib.sha256(json.dumps(list(reachable.values()), separators=(',', ':'), ensure_ascii=False).encode()).digest()
    parent = [66, 68, 83, 49, *parent_digest[:16]]
    for i, field in enumerate(fields):
        binding = 0 if i == 0 else 32
        account_index = 0 if i == 0 else i + (3 if effects else 1)
        digest = hashlib.sha256(json.dumps({'parent': parent, 'field': field['name'], 'type': field['type'], 'index': i},
                                           separators=(',', ':'), ensure_ascii=False).encode()).digest()
        header = [66, 68, 77, 50, *digest[:16]]
        account_specs.append({'field': field['name'], 'type': field['type'], 'index': account_index,
                              'bindingBytes': binding, 'header': header, 'stateBytes': 20 + binding + sizes[field['type']]})
    need(interface.get('stateAccounts') == account_specs, 'interface: stateAccounts field order/index/size/header/binding')
    minimum = len(fields) + (3 if effects else 1); maximum = 12 if effects else minimum
    need(interface.get('minimumAccounts') == minimum and interface.get('maximumAccounts') == maximum, 'interface: account bounds')
    expected_accounts = ([fields[0]['name'], 'actor', 'program' if kind == 'cpi-v1' else 'tokenProgram', 'custody'] +
                        [f['name'] for f in fields[1:]] + ['remaining...']) if effects else [fields[0]['name'], 'actor'] + [f['name'] for f in fields[1:]]
    need(interface.get('accounts') == expected_accounts, 'interface: account order')
    need(interface.get('effects') == kind and interface.get('effectSlots') == None, 'interface: effect kind/slot count')
    need(interface.get('instructionBytes') == sizes[instruction] + 1, 'interface: instruction byte count')
    need(interface.get('state') == state and interface.get('root') == root['name'], 'interface: primary type binding')
    return {'_schema': schema, '_interface': interface, 'types': types, 'sizes': sizes,
            'state': state, 'state_type': types[state]['cType'], 'state_maker': types[state]['variants'][0]['cMaker'],
            'fields': account_specs, 'field_types': [f['type'] for f in state_fields],
            'field_names': [f['name'] for f in state_fields], 'field_sizes': [sizes[f['type']] for f in state_fields],
            'accounts': maximum, 'minimum': minimum, 'maximum': maximum,
            'state_bytes': max(a['stateBytes'] for a in account_specs), 'total': sizes[state], 'n': sizes[state],
            'ix': sizes[instruction], 'instruction': instruction, 'instruction_type': types[instruction]['cType'], 'ix_decode': ident(instruction) + '_decode',
            'ix_type': types[instruction]['cType'], 'effects': effects, 'cpi': kind == 'cpi-v1', 'kind': kind, 'slots': slots,
            'accepted': accepted['tag'], 'rejected': rejected['tag'], 'result_type': result['cType'],
            'result_name': root['result'], 'result': {v['tag']: ['state' if f['type'] == state else 'effects' if effects and f['type'] == effect_type else 'scalar'
                for f in v['fields']] for v in result['variants']},
            'context_name': context, 'context_type': types[context]['cType'], 'context_maker': types[context]['cType'] and types[context]['variants'][0]['cMaker'],
            'key_name': ctx[0]['type'], 'key_type': types[ctx[0]['type']]['cType'], 'key_maker': types[ctx[0]['type']]['variants'][0]['cMaker'],
            'slot_name': ctx[2]['type'], 'slot_value_type': types[ctx[2]['type']]['cType'], 'slot_maker': types[ctx[2]['type']]['variants'][0]['cMaker'],
            'state_decoders': [ident(t) + '_decode' for t in [f['type'] for f in state_fields]],
            'state_encoders': [ident(t) + '_encode' for t in [f['type'] for f in state_fields]],
            'state_encode': ident(state) + '_encode',
            'state_decode': ident(state) + '_decode', 'root': root['cName'],
            'slot_type': 'BendInvoke' if kind == 'cpi-v1' else 'BendTransfer' if effects else None,
            'custody': 'bend_invoke_custody' if kind == 'cpi-v1' else 'bend_custody',
            'validate': 'bend_invoke_validate' if kind == 'cpi-v1' else 'bend_transfer_validate',
            'execute': 'bend_invoke_execute' if kind == 'cpi-v1' else 'bend_transfer_execute',
            'effect_type': types[accepted['fields'][1]['type']]['variants'][0]['fields'][0]['type'] if effects else None,
            'effect_header': 'bend_cpi.h' if kind == 'cpi-v1' else 'token.h' if effects else None,
            'extract_slots': slots,
            'state_header': parent}


class MultiWorld(World):
    def __init__(self, m, include_cpi_validation_assumptions=True,
                 proven_cpi_validation_premises=()):
        super().__init__(m)
        # Existing callers retain the historical trusted-summary behavior.
        # Composition checks can turn this off and discharge the exact helper
        # premises against a separately parsed runtime definition.
        self.include_cpi_validation_assumptions = include_cpi_validation_assumptions
        self.proven_cpi_validation_premises = tuple(proven_cpi_validation_premises)
        self.OWNER = [z3.Const(f'account{i}_owner', self.key_sort) for i in range(m['accounts'])]
        account_sizes = {f['index']: f['stateBytes'] for f in m['fields']}
        self.D = [[z3.BitVec(f'account{i}_data{j}', 8) for j in range(account_sizes.get(i, 0))]
                  for i in range(m['accounts'])]
        self.FIELD_DECODE_OK = [z3.Function(f'field{i}_decodes', z3.BitVecSort(8*m['field_sizes'][i]), z3.BoolSort())
                                for i in range(len(m['fields']))]
        self.FIELD_VALUE = [z3.Function(f'field{i}_decoded', z3.BitVecSort(8*m['field_sizes'][i]), z3.DeclareSort(f'Field{i}'))
                            for i in range(len(m['fields']))]
        self.RPLY = [self.word(f'reply_byte{i}', 8) for i in range(m['total'])]
        self.enc_values = {}
        self.reply_ok = self.flag('reply_encode_ok')
        self.field_ok = [self.flag(f'field_encode{i}_ok') for i in range(len(m['fields']))]
        self.field_bytes = [[self.word(f'field_encoded{i}_byte{j}', 8) for j in range(m['field_sizes'][i])]
                            for i in range(len(m['fields']))]
        self.decode_ix_ok = self.flag('instruction_decode_ok')
        self.decoded_ix = z3.Const('decoded_instruction', z3.DeclareSort('InstructionValue'))
        self.ROOT_TAG = z3.BitVec('root_tag', 32)
        self.VALUE_ROOT = z3.BitVec('root_reject_code', 32)
        self.SETUP = self.word('custody_result', 64); self.BUMP = self.word('custody_bump', 8)
        self.CLOCK_RC = self.word('clock_result', 64); self.SLOT = self.word('clock_slot', 64)
        self.VAL = [self.word(f'validate{i}_result', 64) for i in range(m['slots'])]
        self.EXE = [self.word(f'execute{i}_result', 64) for i in range(m['slots'])]
        self.META_INDEX = [[self.word(f'cpi{i}_meta{j}_index', 32) for j in range(8)] for i in range(m['slots'])]
        self.META_WRITE = [[self.word(f'cpi{i}_meta{j}_writable', 32) for j in range(8)] for i in range(m['slots'])]
        self.ACTIVE = [self.word(f'effect{i}_active', 32) for i in range(m['slots'])]
        self.META_COUNT = [self.word(f'cpi{i}_count', 32) for i in range(m['slots'])]
        self.EXT_OK = self.flag('effects_extract_ok')
        self.decode_ok = {'state': None, 'ix': z3.Function('instruction_decodes', z3.BitVecSort(8*m['ix']), z3.BoolSort())}
        self.decoded = {'state': None, 'ix': z3.Function('decoded_instruction_value', z3.BitVecSort(8*m['ix']), self.decoded_ix.sort())}

    def enc(self, k, j):
        if j == 0: return self.RPLY
        idx = j - 16
        need(0 <= idx < len(self.field_bytes), 'encode: unknown state field source')
        return self.field_bytes[idx]
    def enc_ok(self, k, j): return self.reply_ok if j == 0 else self.field_ok[j-16]
    def outf(self, k, j): return self.VALUE_ROOT if j == 0 else super().outf(k, j)
    def describe(self, model, extra=()):
        def val(e):
            v = model.eval(e, model_completion=True)
            return hex(v.as_long()) if z3.is_bv_value(v) else str(v)
        out = {'account_count': val(self.COUNT), 'instruction_length': val(self.IXLEN), 'mode_byte': val(self.IXB[0]),
               'root_tag': val(self.ROOT_TAG), 'owner_matches_program': [val(x == self.PROGRAM) for x in self.OWNER[:len(self.m['fields'])]],
               'managed_writable': [val(self.WRITABLE[a['index']]) for a in self.m['fields']],
               'managed_sizes': [val(self.SIZE[a['index']]) for a in self.m['fields']]}
        for name, e in extra: out[name] = val(e)
        return out

    def key_bytes(self, i):
        return super().key_bytes(i)
    def cpi_validation_assumptions(self):
        """Return the exact per-slot CPI success/count assumptions separately."""
        if not self.m['cpi']:
            return []
        src = (self.m['accepted'], 1)
        return [z3.Implies(
            z3.And(self.VAL[i] == z3.BitVecVal(0, 64),
                   self.eff(src, i, 'active') != z3.BitVecVal(0, 32)),
            z3.ULE(self.eff(src, i, 'count'), z3.BitVecVal(8, 32)))
            for i in range(self.m['slots'])]

    def axioms(self):
        # Existing key-byte/equality relation, plus the historical trusted CPI
        # summary for callers that request the default behavior.
        out = list(super().axioms())
        if self.include_cpi_validation_assumptions:
            out += self.cpi_validation_assumptions()
        out += list(self.proven_cpi_validation_premises)
        return out


class MultiParser(Parser):
    """Same expression grammar; ABI2 -> member access is normalized after lexing."""


class MultiExec(Exec):
    def fail(self, st, g, label):
        sat, solver = self.w.feasible(z3.And(st.pc, g))
        if sat: raise SymSemantic(label, self.w.describe(solver.model()))
        if self.w.feasible(st.pc)[0]: raise Grammar(f'unsupported unevaluated operand: {label}')
        raise Dead()

    def calls(self):
        table = super().calls()
        m = self.m
        table[m['state_maker']] = (True, len(m['fields']), self.call_state)
        for i, name in enumerate(m['state_decoders']): table[name] = (False, 3, self.call_decode)
        for i, name in enumerate(m['state_encoders']): table[name] = (False, 3, self.call_encode)
        return table

    def call_equal_key(self, name, args, st, g):
        left,right=args
        if isinstance(left,Ptr) and isinstance(right,Ptr) and {left.region[0],right.region[0]} == {'data','key'}:
            data_ptr, key_ptr = (left,right) if left.region[0]=='data' else (right,left)
            need(concrete(Int('u64',key_ptr.off)) == 0, 'equal_key: key offset')
            data = self.bytes(data_ptr,0,32,st,g)
            key = self.bytes(key_ptr,0,32,st,g)
            eq = z3.And([a == b for a,b in zip(data,key)])
            return Int('u32',z3.If(eq,z3.BitVecVal(1,32),z3.BitVecVal(0,32)),eq)
        return super().call_equal_key(name,args,st,g)

    def declare(self, s, st):
        _, ctype, const, pointer, name, size, init = s
        if pointer and ctype == self.m['state_type'] and name == 'after':
            need(const and size is None and init is not None and init[0] == 'expr', 'syntax: unsupported state output pointer')
            base = self.ev(init[1], st, top=True)
            need(isinstance(base, Obj) and base.kind == 'outcome-state-pointer', 'syntax: after pointer is not Accepted.state')
            st.scopes[-1][name] = (Obj('outcome-state-pointer'), (ctype, const, pointer, size, False)); return
        super().declare(s, st)

    def member(self, base, name, st, g):
        if isinstance(base, Obj) and base.kind in ('outcome-state-pointer', 'stateout.as', 'stateout.variant'):
            if base.kind == 'outcome-state-pointer':
                need(name == 'as', 'expression: unsupported state result member')
                self.oblige(st, g, 'union: state result field read while Accepted is inactive', self.w.ROOT_TAG == self.m['accepted'])
                return Obj('stateout.as')
            if base.kind == 'stateout.as':
                need(name == 'c0', 'expression: unknown state result variant')
                return Obj('stateout.variant', 0)
            need(name.startswith('f') and name[1:].isdigit(), 'expression: unknown state result field')
            idx = int(name[1:]); need(idx < len(self.m['fields']), 'expression: state field index')
            self.oblige(st, g, f'union: state field {idx} read while Accepted is inactive', self.w.ROOT_TAG == self.m['accepted'])
            return Obj('stateout.field', idx)
        if isinstance(base, Obj) and base.kind == 'account' and name == 'owner':
            return Ptr(('owner', base.f[0]), z3.BitVecVal(0, 64), z3.BoolVal(False))
        return super().member(base, name, st, g)

    def address(self, e, st, g):
        # `&after->as.c0.fN` identifies a subvalue of Accepted.state;
        # `&outcome.as.c0.f0` identifies the complete record for the reply.
        if e[0] == 'member' and e[2].startswith('f') and e[2][1:].isdigit():
            try:
                b = self.ev(e[1], st, g)
                if isinstance(b, Obj) and b.kind == 'stateout.variant': return Ref('stateout', int(e[2][1:]))
                if isinstance(b, Obj) and b.kind == 'outcome.variant' and b.f[0] == self.m['accepted'] and int(e[2][1:]) == 0:
                    self.oblige(st, g, 'union: Accepted.state address while another outcome variant is active', self.w.ROOT_TAG == self.m['accepted'])
                    return Obj('outcome-state-pointer')
            except (Grammar, AttributeError, IndexError):
                pass
        if e[0] == 'id' and e[1] == 'after': return Ref('stateout', -1)
        return super().address(e, st, g)

    def call_state(self, name, args, st, g):
        fields = []
        for i, arg in enumerate(args):
            need(isinstance(arg, Obj) and arg.kind == 'decoded-field', 'root: state field is not a decoded field')
            fields.append(arg.f[1])
        return Obj('state-record', tuple(fields), ctype=self.m['state_type'])

    def call_decode(self, name, args, st, g):
        if name == self.m['ix_decode']:
            src, n, target = args; expected = self.m['ix']; which = 'ix'
            need(isinstance(target, Ref) and target.path[0] == 'var', 'decode: instruction target')
            scope = st.find(target.path[1]); need(scope is not None and scope[target.path[1]][1][0] == self.m['ix_type'], 'decode: instruction type')
            data = self.bytes(src, 0, concrete(n), st, g)
            ok = self.w.decode_ok['ix'](pack(data)) if concrete(n) == expected else z3.BoolVal(False)
            scope[target.path[1]] = (Obj('decoded', 'ix', z3.If(ok, self.w.decoded['ix'](pack(data)), z3.Const('bad_ix', self.w.decoded['ix'].range())), ctype=self.m['ix_type'], valid=ok), scope[target.path[1]][1])
            st.events.append(Event('decode', which='ix', data=tuple(data))); return Int('int', None, ok)
        src, n, target = args; n = concrete(n)
        need(isinstance(target, Ref) and target.path[0] == 'var', 'decode: state field output')
        i = int(target.path[1].replace('before', ''))
        need(0 <= i < len(self.m['fields']) and name == self.m['state_decoders'][i], 'decode: state field binding')
        scope = st.find(target.path[1]); info = scope[target.path[1]][1]
        need(info[0] == ident(self.m['field_types'][i]) + '_t' or info[0] == self.m['types'][self.m['field_types'][i]]['cType'], 'decode: state field type')
        data = self.bytes(src, 0, n, st, g)
        ok = self.w.FIELD_DECODE_OK[i](pack(data)) if n == self.m['field_sizes'][i] else z3.BoolVal(False)
        val = self.w.FIELD_VALUE[i](pack(data)) if n == self.m['field_sizes'][i] else z3.Const(f'bad_field{i}', self.w.FIELD_VALUE[i].range())
        scope[target.path[1]] = (Obj('decoded-field', i, val, ctype=info[0], valid=ok), info)
        st.events.append(Event('decode', which=f'state{i}', data=tuple(data))); return Int('int', None, ok)

    def call_root(self, name, args, st, g):
        context, before, instruction = args
        need(isinstance(context, Obj) and context.kind == 'context' and isinstance(before, Obj) and before.kind == 'state-record', 'root: context/state arguments')
        need(isinstance(instruction, Obj) and instruction.kind == 'decoded' and instruction.f[0] == 'ix', 'root: instruction argument')
        st.events.append(Event('root', context=context.f[0], before=before.f[0], instruction=instruction.f[1]))
        return Obj('outcome', ctype=self.m['result_type'])

    def call_encode(self, name, args, st, g):
        scope, arr, info, array = self.local_bytes(args[0], st, 'encode')
        n = concrete(args[1]); src = args[2]
        if name == self.m['state_encode']:
            if isinstance(src, Ref) and src.path == ('var', 'after') or isinstance(src, Obj) and src.kind == 'outcome-state-pointer':
                source = ('state', 'complete')
            elif isinstance(src, Ref) and src.path == ('var', 'before'):
                source = ('state', 'before')
            else:
                need(False, 'encode: complete state reply source')
            idx = -1; expected = self.m['total']; ok = self.w.reply_ok; out = self.w.RPLY
            st.events.append(Event('encode', src=source, encoder='complete', target=array))
        else:
            need(isinstance(args[0], Ref) and args[0].path[0] == 'var', 'encode: output is not a local buffer')
            target_name = args[0].path[1]
            match = re.fullmatch(r'encoded([0-9]+)', target_name)
            need(match is not None, 'encode: output buffer is not a state slot')
            i = int(match.group(1))
            need(i < len(self.m['fields']) and name == self.m['state_encoders'][i], 'encode: encoder does not match output field')
            need(isinstance(src, Ref) and src.path[0] == 'stateout' and 0 <= src.path[1] < len(self.m['fields']), 'encode: source is not an Accepted.state field')
            source_i = src.path[1]
            self.oblige(st, g, f'union: state field {source_i} encoded while Accepted is inactive', self.w.ROOT_TAG == self.m['accepted'])
            idx = i; expected = self.m['field_sizes'][i]; ok = self.w.field_ok[i]; out = self.w.field_bytes[i]
            st.events.append(Event('encode', src=('state-field', source_i), encoder=i, target=array))
        if n != expected: return Int('int', None, z3.BoolVal(False))
        if n > info[3]: self.fail(st, g, f'bounds: {n} bytes encoded into {array}[{info[3]}]')
        need(arr.valid is None, 'encode: reused output array')
        data = list(arr.f[0])
        for j in range(n): data[j] = z3.If(ok, out[j], self.w.word(f'unspecified_encode_{idx}_{j}', 8))
        scope[array] = (Obj('bytes', tuple(data), valid=ok), info)
        return Int('int', None, ok)

    def call_extract(self, name, args, st, g):
        src, target = args
        need(isinstance(src, Ref) and src.path == ('outf', self.m['accepted'], 1), 'extract: source is not Accepted.effects')
        scope, arr, info = self.array(st, target.path[1])
        need(arr.kind == 'effects' and info[3] >= self.m['slots'], 'extract: effect output capacity')
        scope[target.path[1]] = (Obj('effects', info[3], (self.m['accepted'], 1), self.w.EXT_OK), info)
        st.events.append(Event('extract', src=(self.m['accepted'], 1))); return Int('int', None, self.w.EXT_OK)

    def effect_slot(self, value, st, g):
        need(isinstance(value, Ref) and value.path[0] == 'elem', 'effect helper: slot argument')
        _, arr, info = self.array(st, value.path[1]); i = value.path[2]
        need(arr.kind == 'effects' and i < self.m['slots'] and i < info[3], 'effect helper: slot bounds')
        if arr.f[1] is None: self.fail(st, g, f'uninitialized: read of {value.path[1]}[{i}]')
        if i >= self.m['extract_slots']: self.fail(st, g, f'uninitialized: extracted slot {i}')
        self.oblige(st, g, 'effects: slot read without successful extraction', arr.f[2])
        return (self.m['accepted'], 1), i

    def call_validate(self, name, args, st, g):
        src, i = self.effect_slot(args[0], st, g); count = convert(args[2], 'u32').e
        self.accounts_arg(args[1], st, g, count)
        self.oblige(st, g, 'helper: validator account count differs from loader', count == z3.Extract(31, 0, self.w.COUNT))
        st.events.append(Event('validate', fn=name, slot=i, src=src, count=count))
        return Int('u64', self.w.VAL[i])

    def call_execute(self, name, args, st, g):
        src, i = self.effect_slot(args[0], st, g); count = convert(args[2], 'u32').e
        self.accounts_arg(args[1], st, g, count)
        self.oblige(st, g, 'helper: executor account count differs from loader', count == z3.Extract(31, 0, self.w.COUNT))
        self.oblige(st, g, 'helper: executor bump differs from custody output', convert(args[3], 'u8').e == self.w.BUMP)
        st.events.append(Event('execute', fn=name, slot=i, src=src, count=count, bump=convert(args[3], 'u8').e))
        return Int('u64', self.w.EXE[i])

    def state_target(self, p, n, st, g, what):
        need(isinstance(p, Ptr) and p.region[0] == 'data', f'{what}: destination is not managed account data')
        account = p.region[1]; off = concrete(Int('u64', p.off)); need(off is not None, f'{what}: symbolic offset')
        self.oblige(st, g, 'bounds: managed data write within account size', z3.UGE(self.w.SIZE[account], off+n))
        return account, off

    def call_memcpy(self, name, args, st, g):
        n = concrete(args[2]); need(n is not None and n > 0, 'memcpy: unsupported length')
        account, off = self.state_target(args[0], n, st, g, 'memcpy')
        data = self.bytes(args[1], 0, n, st, g)
        st.events.append(Event('write', account=account, offset=off, data=tuple(data)))
        return Obj('void')

    def bytes(self, src, start, n, st, g):
        if isinstance(src, Ptr) and src.region[0] == 'key':
            if not z3.is_false(src.null): self.oblige(st, g, 'pointer: key read is nonnull', z3.Not(src.null))
            off = concrete(Int('u64', src.off)); need(off is not None, 'key bytes: symbolic offset')
            if off + start + n > 32: self.fail(st, g, 'bounds: key byte range')
            key = self.w.key_bytes(src.region[1])
            return [z3.Extract(8*(off+start+i)+7, 8*(off+start+i), key) for i in range(n)]
        if isinstance(src, Ptr) and src.region[0] == 'data':
            account = src.region[1]; off = concrete(Int('u64', src.off)); need(off is not None, 'data bytes: symbolic offset')
            lo, hi = off+start, off+start+n
            self.oblige(st, g, 'bounds: managed data read within account size', z3.UGE(self.w.SIZE[account], hi))
            if account >= len(self.w.D) or hi > len(self.w.D[account]):
                self.fail(st,g,f'bounds: account {account} data read outside modeled allocation')
            data = list(self.w.D[account])
            for event in st.events:
                if event.kind == 'write' and event.account == account: data[event.offset:event.offset+len(event.data)] = list(event.data)
            return data[lo:hi]
        return super().bytes(src, start, n, st, g)

    def key_value(self, p, st, g):
        need(isinstance(p, Ptr), 'equal_key: argument pointer')
        if not z3.is_false(p.null): self.oblige(st, g, 'pointer: key comparison is nonnull', z3.Not(p.null))
        if p.region[0] == 'ix':
            self.cursor(p.at, st, g); self.oblige(st, g, 'loader: program id follows instruction', p.off == self.w.IXLEN); return self.w.PROGRAM
        need(concrete(Int('u64', p.off)) == 0, 'equal_key: key offset')
        if p.region[0] == 'key': return self.w.KEY[p.region[1]]
        if p.region[0] == 'owner': return self.w.OWNER[p.region[1]]
        raise Grammar('equal_key: unsupported pointer region')


def audit_dependencies(m, adapter_name, files):
    need(adapter_name in files and adapter_name.endswith('.c'), 'dependencies: adapter missing')
    stem = adapter_name[:-2]; wire = stem + '.wire.h'; native = stem + '.h'
    first = [wire, 'solana_min.h'] + ([m['effect_header']] if m['effects'] else [])
    macros, seen, pending = {}, set(), list(first)
    while pending:
        name = pending.pop()
        if name in seen: continue
        need(name in files and name != adapter_name, f'dependencies: unresolved include {name}')
        seen.add(name); defs, includes = header_directives(name, files[name])
        for macro in defs: macros.setdefault(macro, name)
        pending.extend(includes)
    need(seen | {adapter_name} == set(files), 'dependencies: non-closure file supplied')
    clash = sorted({t for t in strict_tokens(files[adapter_name]) if IDENT.fullmatch(t)} & set(macros))
    need(not clash, f'dependencies: macro {clash[0] if clash else ""!r} rewrites adapter')
    # ABI2-only signatures plus the ABI-width/loader bindings are checked at
    # file scope and uniquely bound across the complete closure.
    htokens = {n: audited_header_tokens(n, files[n]) for n in seen}
    for name in ('solana_min.h', 'token.h', 'bend_cpi.h'):
        if name in seen:
            audited_header_tokens(name, files[name])
    runtime = htokens['solana_min.h']
    snippets = [
        'typedef unsigned char u8; typedef unsigned int u32; typedef unsigned long long u64; _Static_assert(sizeof(u8) == 1 && sizeof(u32) == 4 && sizeof(u64) == 8, "ABI widths");',
        'static inline u64 read_le(const u8 *p, unsigned n) { u64 v = 0; for (unsigned i = 0; i < n; ++i) v |= (u64)p[i] << (8 * i); return v; }',
        'static inline unsigned equal_key(const u8 *a, const u8 *b) { for (unsigned i = 0; i < 32; i += 8) { u64 left, right; __builtin_memcpy(&left, a + i, 8); __builtin_memcpy(&right, b + i, 8); if (left != right) return 0; } return 1; }',
        'typedef struct { const u8 *key; const u8 *owner; u8 *data; u64 size; u64 *lamports; u64 rent_epoch; unsigned signer, writable, executable; } Account;',
        'static inline const u8 *read_account(const u8 *p, Account *a) { if (p[0] != 255) return (const u8 *)0; a->signer = p[1] != 0; a->writable = p[2] != 0; a->executable = p[3] != 0; a->key = p + 8; a->owner = p + 40; a->size = read_le(p + 80, 8); a->lamports = (u64 *)(p + 72); a->data = (u8 *)(p + 88); u64 next = (u64)(a->data + a->size + 10240); const u8 *rent = (const u8 *)((next + 7) & ~(u64)7); a->rent_epoch = read_le(rent, 8); return rent + 8; }',
        'extern void sol_set_return_data(const u8 *, u64);',
    ]
    for snippet in snippets: need(has_file_scope_tokens(runtime, header_tokens(snippet)), 'dependencies: runtime declaration mismatch')
    for name in ('read_le', 'equal_key', 'read_account'):
        unique_file_scope_name([htokens[n] for n in seen], name)
    # Every called generated function is uniquely bound; duplicate/overload
    # bodies, including same-signature decoys, reject before execution.
    generated = [htokens[wire], htokens[native]]
    called = [m['state_maker'], m['key_maker'], m['slot_maker'], m['context_maker'], m['root'], m['ix_decode'], m['state_encode']]
    called += m['state_decoders'] + m['state_encoders']
    for name in dict.fromkeys(called): unique_file_scope_name(generated, name)
    # Independently bind the native record field order/types and key function
    # signatures to the checked schema, plus the root's full ABI signature.
    def type_signature(type_name):
        t = m['types'][type_name]
        need(t['kind'] == 'adt', f'schema bridge: ADT expected: {type_name}')
        variants=[]
        for v in t['variants']:
            inner=' '.join(f'{m["types"][f["type"]]["cType"]} f{i};' for i,f in enumerate(v['fields'])) or 'bend_u32 unused;'
            variants.append(f'struct {{ {inner} }} c{v["tag"]};')
        return f'typedef struct {{ bend_u32 tag; union {{ {" ".join(variants)} }} as; }} {t["cType"]};'
    type_names = [m['state']] + m['field_types'] + [m['context_name'],m['key_name'],m['slot_name'],m['result_name'],m['instruction']]
    for type_name in dict.fromkeys(type_names):
        if m['types'][type_name]['kind'] == 'adt':
            need(has_file_scope_tokens(htokens[native], header_tokens(type_signature(type_name))),
                 f'dependencies: native field layout differs from schema for {type_name}')
    root_sig = (f'static __attribute__((noinline)) {m["result_type"]} {m["root"]}('
                f'{m["context_type"]} a0, {m["state_type"]} a1, {m["ix_type"]} a2) {{')
    need(has_file_scope_tokens(htokens[native], header_tokens(root_sig)), 'dependencies: root C signature differs from schema')
    def maker_sig(type_name):
        t = m['types'][type_name]; variant = t['variants'][0]
        args = ', '.join(f'{m["types"][f["type"]]["cType"]} a{i}' for i,f in enumerate(variant['fields']))
        return f'static inline {t["cType"]} {variant["cMaker"]}({args}) {{'
    for type_name in (m['context_name'],m['key_name'],m['slot_name'],m['state']):
        need(has_file_scope_tokens(htokens[native], header_tokens(maker_sig(type_name))),
             f'dependencies: record constructor differs from schema for {type_name}')
    # Independently schema-derived wire widths select the exact emitter annotation.
    decode_storage = lambda size: 'static __attribute__((noinline)) inline' if size >= 256 else 'static inline'
    for index, type_name in enumerate(m['field_types']):
        ctype = m['types'][type_name]['cType']
        decoder = f'{decode_storage(m["field_sizes"][index])} int {m["state_decoders"][index]}(const unsigned char *p, unsigned long long n, {ctype} *out) {{'
        encoder = f'static inline int {m["state_encoders"][index]}(unsigned char *p, unsigned long long n, const {ctype} *value) {{'
        need(has_file_scope_tokens(htokens[wire], header_tokens(decoder)), f'dependencies: field {index} decoder signature')
        need(has_file_scope_tokens(htokens[wire], header_tokens(encoder)), f'dependencies: field {index} encoder signature')
    for name,ctype,direction in ((m['ix_decode'],m['ix_type'],'decode'),(m['state_encode'],m['state_type'],'encode')):
        signature = (f'{decode_storage(m["ix"])} int {name}(const unsigned char *p, unsigned long long n, {ctype} *out) {{' if direction=='decode'
                     else f'static inline int {name}(unsigned char *p, unsigned long long n, const {ctype} *value) {{')
        need(has_file_scope_tokens(htokens[wire], header_tokens(signature)), f'dependencies: {name} signature')
    if m['effects']:
        helpers = htokens[m['effect_header']]
        if m['cpi']:
            helper_signatures = [
                'static inline u64 bend_invoke_custody(Account *a, const u8 *program, u8 *bump) {',
                'static inline u64 bend_invoke_validate(const BendInvoke *t, Account *a, unsigned count) {',
                'static __attribute__((noinline)) u64 bend_invoke_execute(const BendInvoke *t, Account *a, unsigned count, u8 bump) {']
        else:
            helper_signatures = [
                'static inline u64 bend_custody(Account *accounts, const u8 *program, u8 *bump) {',
                'static inline u64 bend_transfer_validate(const BendTransfer *t, Account *a, unsigned count) {',
                'static __attribute__((noinline)) u64 bend_transfer_execute(const BendTransfer *t, Account *a, unsigned count, u8 bump) {']
        for name,sig in zip((m['custody'],m['validate'],m['execute']),helper_signatures):
            unique_file_scope_name([helpers], name)
            need(has_file_scope_tokens(helpers,header_tokens(sig)),f'dependencies: summarized helper signature {name}')
    return sorted(seen), wire


def extract_entrypoint(text, wire, effect_header, effects, effect_type=None, effects_type=None, slot_type=None):
    includes, tokens = split_includes(text)
    expected = [(wire, '"'), ('solana_min.h', '"')] + ([(effect_header, '<' if effect_header == 'bend_cpi.h' else '"')] if effects else [])
    need(includes == expected, f'preprocessing: ABI2 includes {includes} differ from {expected}')
    # The effect helper bodies are independently parsed and path-enumerated by
    # effect_extraction.py. Find the unique reviewed Clock/entrypoint binding
    # only after lexing the entire translation unit (comments/strings removed).
    prefix = strict_tokens('typedef struct { u64 slot; long long epoch_start_timestamp; u64 epoch; u64 leader_schedule_epoch; long long unix_timestamp; } BendClock; _Static_assert(sizeof(BendClock) == 40, "Clock ABI"); extern u64 sol_get_clock_sysvar(void *); __attribute__((visibility("default"))) u64 entrypoint(const u8 *input) {')
    positions = [i for i in range(len(tokens)-len(prefix)+1) if tokens[i:i+len(prefix)] == prefix]
    need(len(positions) == 1, 'syntax: entrypoint/Clock binding is missing or duplicated')
    at = positions[0]
    if effects:
        at_helpers = 0
        for signature in (
            f'static inline int bend_extract_effect(const {effect_type} *value, {slot_type} *out) {{',
            f'static inline int bend_extract_effects(const {effects_type} *value, {slot_type} *out) {{'):
            sig = strict_tokens(signature)
            need(tokens[at_helpers:at_helpers+len(sig)] == sig, 'syntax: extraction helper binding')
            at_helpers += len(sig)
            depth, end = 1, None
            for i in range(at_helpers, len(tokens)):
                if tokens[i] == '{': depth += 1
                elif tokens[i] == '}':
                    depth -= 1
                    if depth == 0: end = i; break
            need(end is not None, 'syntax: unterminated extraction helper')
            at_helpers = end + 1
        need(at_helpers == at, 'syntax: unreviewed token before Clock/entrypoint')
    else:
        need(at == 0, 'syntax: unreviewed token before Clock/entrypoint')
    # No unparsed non-comment tokens may occur between include directives and
    # the entrypoint except the exact helper prefix that extraction audited.
    body_tokens = tokens[at+len(prefix):]
    need(body_tokens, 'syntax: empty entrypoint')
    # Matching final brace is token-based, so braces in comments/strings cannot
    # bind another function or truncate the executed body.
    depth, end = 1, None
    for i, token in enumerate(body_tokens):
        if token == '{': depth += 1
        elif token == '}':
            depth -= 1
            if depth == 0: end = i; break
    need(end is not None and end == len(body_tokens)-1, 'syntax: text after entrypoint or unbalanced body')
    # The generated state pointer uses ->; Parser models member access and the
    # interpreter verifies the declaration/source role separately.
    body_tokens = ['.' if t == '->' else t for t in body_tokens]
    return body_tokens


def mk_contract(w, m):
    """Ordered ABI2 contract; stages are based only on validated schema/layout facts."""
    bv64 = lambda x: z3.BitVecVal(x, 64)
    fields = m['fields']; init = w.IXB[0] == 0
    alias = z3.Or([z3.And(z3.ULT(z3.BitVecVal(i, 64), w.COUNT),
                          z3.Or([z3.Not(w.PARSE_OK[i])] + [w.KEY[i] == w.KEY[j] for j in range(i)]))
                   for i in range(m['accounts'])])
    common = [
        ('account-count', z3.And(z3.UGE(w.COUNT, bv64(m['minimum'])), z3.ULE(w.COUNT, bv64(m['maximum']))), bv64(1)),
        ('distinct-accounts', z3.Not(alias), bv64(6)),
        ('instruction-length-and-mode', z3.And(w.IXLEN == m['ix'] + 1, z3.ULE(w.IXB[0], 1)), bv64(2)),
    ]
    if m['effects']: common.append(('custody-setup', w.SETUP == 0, w.SETUP))
    stages = list(common)
    for i, spec in enumerate(fields):
        account = spec['index']
        stages += [(f'field-{i}-owner-executable', z3.And(w.OWNER[account] == w.PROGRAM, z3.Not(w.EXECUTABLE[account])), bv64(3)),
                   (f'field-{i}-writable', w.WRITABLE[account], bv64(5)),
                   (f'field-{i}-size', w.SIZE[account] == spec['stateBytes'], bv64(4))]
        stages.append((f'field-{i}-initialize-signer', z3.If(init, w.SIGNER[account], z3.BoolVal(True)), bv64(7)))
        zero = z3.And([b == 0 for b in w.D[account]])
        stages.append((f'field-{i}-initialize-zero-allocation', z3.If(init, zero, z3.BoolVal(True)), bv64(4)))
        header_ok = z3.And([w.D[account][j] == spec['header'][j] for j in range(20)])
        stages.append((f'field-{i}-stored-header', z3.If(init, z3.BoolVal(True), header_ok), bv64(4)))
        if i:
            bind = z3.And([w.D[account][20+j] == z3.Extract(8*j+7, 8*j, w.key_bytes(0)) for j in range(32)])
            stages.append((f'field-{i}-primary-binding', z3.If(init, z3.BoolVal(True), bind), bv64(4)))
        payload_at = 20 + spec['bindingBytes']
        stored_payload = w.D[account][payload_at:payload_at+m['field_sizes'][i]]
        payload = [z3.If(init, z3.BitVecVal(0, 8), b) for b in stored_payload]
        decode_ok = w.FIELD_DECODE_OK[i](pack(payload))
        stages.append((f'field-{i}-state-decode', decode_ok, bv64(4)))
    ix_ok = w.decode_ok['ix'](pack(w.IXB[1:]))
    stages.append(('instruction-decode', ix_ok, bv64(2)))
    stages.append(('clock', w.CLOCK_RC == 0, bv64(8)))
    outcome_reject = w.ROOT_TAG == m['rejected']; outcome_accept = w.ROOT_TAG == m['accepted']
    code = w.VALUE_ROOT
    mapped = z3.If(z3.ULE(code, z3.BitVecVal(0xfffffeff, 32)), bv64(256) + z3.ZeroExt(32, code), bv64(9))
    stages.append(('root-rejection', z3.Not(outcome_reject), mapped))
    stages.append(('root-tag', outcome_accept, bv64(9)))
    stages.append(('complete-state-encode', w.reply_ok, bv64(9)))
    for i in range(len(fields)): stages.append((f'field-{i}-encode', w.field_ok[i], bv64(9)))
    if m['effects']:
        stages.append(('effect-extraction', w.EXT_OK, bv64(9)))
        for i in range(m['slots']):
            src = (m['accepted'], 1)
            if m['cpi']:
                count = w.eff(src, i, 'count'); active = w.eff(src, i, 'active')
                writable_managed = z3.Or([z3.And(z3.ULT(z3.BitVecVal(j,32), count),
                    w.meta(src,i,j,'writable') != 0,
                    z3.Or([w.meta(src,i,j,'index') == spec['index'] for spec in fields])) for j in range(8)])
                stages.append((f'validate-slot-{i}', w.VAL[i] == 0, w.VAL[i]))
                stages.append((f'cpi-no-writable-managed-slot-{i}', z3.Not(z3.And(active != 0, writable_managed)), bv64(22)))
            else:
                stages.append((f'validate-slot-{i}', w.VAL[i] == 0, w.VAL[i]))
        for i in range(m['slots']): stages.append((f'execute-slot-{i}', w.EXE[i] == 0, bv64(18)))
    expected = bv64(0)
    for _, ok, failure in reversed(stages): expected = z3.If(z3.Not(ok), failure, expected)
    pre_root = z3.And([ok for _, ok, _ in stages[:len(common) + 3*len(fields) + len(fields) + (sum(1+(i>0) for i in range(len(fields))))]])
    # Compute root precondition directly: loader/instruction/setup; all field
    # guards and decoders; instruction decoder; Clock. This is independent of
    # the C event list.
    root_pre_terms = [ok for _, ok, _ in common]
    for i, spec in enumerate(fields):
        a = spec['index']; root_pre_terms += [w.OWNER[a] == w.PROGRAM, z3.Not(w.EXECUTABLE[a]), w.WRITABLE[a], w.SIZE[a] == spec['stateBytes']]
        root_pre_terms += [z3.If(init, w.SIGNER[a], z3.BoolVal(True)),
                           z3.If(init, z3.And([b == 0 for b in w.D[a]]), z3.BoolVal(True))]
        header = z3.And([w.D[a][j] == spec['header'][j] for j in range(20)])
        binding = z3.And([w.D[a][20+j] == z3.Extract(8*j+7,8*j,w.key_bytes(0)) for j in range(32)]) if i else z3.BoolVal(True)
        stored_payload = w.D[a][20+spec['bindingBytes']:20+spec['bindingBytes']+m['field_sizes'][i]]
        payload = [z3.If(init,z3.BitVecVal(0,8),b) for b in stored_payload]
        root_pre_terms += [z3.If(init, z3.BoolVal(True), header), z3.If(init, z3.BoolVal(True), binding),
                           w.FIELD_DECODE_OK[i](pack(payload))]
    root_pre_terms += [ix_ok, w.CLOCK_RC == 0]
    pre_root = z3.And(root_pre_terms)
    cpi_guard = {}
    if m['cpi']:
        for i in range(m['slots']):
            src = (m['accepted'], 1)
            cpi_guard[i] = z3.And(w.eff(src,i,'active') != 0, z3.Or([
                z3.And(z3.ULT(z3.BitVecVal(j,32), w.eff(src,i,'count')),
                       w.meta(src,i,j,'writable') != 0,
                       z3.Or([w.meta(src,i,j,'index') == spec['index'] for spec in fields])) for j in range(8)]))
    success = z3.And(pre_root, outcome_accept, w.reply_ok, *w.field_ok,
                     *([w.EXT_OK] if m['effects'] else []),
                     *([w.VAL[i] == 0 for i in range(m['slots'])] if m['effects'] else []),
                     *([z3.Not(cpi_guard[i]) for i in range(m['slots'])] if m['cpi'] else []),
                     *([w.EXE[i] == 0 for i in range(m['slots'])] if m['effects'] else []))
    return {'stages': stages, 'expected': expected, 'pre_root': pre_root, 'success': success,
            'cpi_guard': cpi_guard, 'init': init, 'ix_ok': ix_ok}


FALSE = z3.BoolVal(False)


def final_data(w, path, account):
    data = list(w.D[account])
    for event in path.events:
        if event.kind == 'write' and event.account == account:
            if event.offset + len(event.data) > len(data): return None
            data[event.offset:event.offset+len(event.data)] = list(event.data)
    return data


def complete_model(model):
    return [{'name': str(decl), 'value': str(model[decl])} for decl in sorted(model.decls(), key=lambda d: str(d))]


def event_claims(w, m, c, path):
    events = path.events; roots = [i for i,e in enumerate(events) if e.kind == 'root']
    root_presence = z3.BoolVal(len(roots) == 1) == c['pre_root']
    root_presence = z3.And(root_presence, z3.BoolVal(len(roots) <= 1))
    root_args = z3.BoolVal(True)
    if roots:
        root = events[roots[0]]
        expected_context = tuple(z3.Extract(32*i+31,32*i,w.key_bytes(1)) for i in range(8)) + (
            z3.If(w.SIGNER[1], z3.BitVecVal(1,32), z3.BitVecVal(0,32)),
            z3.Extract(31,0,w.SLOT), z3.Extract(63,32,w.SLOT))
        expected_fields = []
        for i,spec in enumerate(m['fields']):
            data = w.D[spec['index']][20+spec['bindingBytes']:20+spec['bindingBytes']+m['field_sizes'][i]]
            data = [z3.If(c['init'], z3.BitVecVal(0,8), b) for b in data]
            expected_fields.append(w.FIELD_VALUE[i](pack(data)))
        expected_ix = w.decoded['ix'](pack(w.IXB[1:]))
        def typed_eq(actual, expected):
            # Mutants can pass a value of the wrong Bend type to the root.
            # Treat different symbolic sorts as a false contract clause rather
            # than letting Z3 raise while constructing the counterexample.
            return actual == expected if actual.sort() == expected.sort() else z3.BoolVal(False)
        root_args = z3.And(
            [typed_eq(a,b) for a,b in zip(root.context, expected_context)] +
            [typed_eq(a,b) for a,b in zip(root.before, expected_fields)] +
            [typed_eq(root.instruction, expected_ix),
             z3.BoolVal(len(root.context) == len(expected_context)),
             z3.BoolVal(len(root.before) == len(expected_fields))])
        prior = [e.kind for e in events[:roots[0]]]
        expected_prior = (['custody'] if m['effects'] else []) + ['decode']*(len(m['fields'])+1) + ['clock']
        root_presence = z3.And(root_presence, z3.BoolVal(prior == expected_prior))
    positions = {kind: [i for i,e in enumerate(events) if e.kind == kind]
                 for kind in ('encode','extract','validate','execute','write','return_data')}
    order_ok = True; rootpos = roots[0] if roots else -1
    if positions['encode'] and (rootpos < 0 or min(positions['encode']) <= rootpos): order_ok = False
    if positions['extract'] and (len(positions['encode']) == 0 or max(positions['encode']) >= min(positions['extract'])): order_ok = False
    if positions['validate'] and (not positions['extract'] or max(positions['extract']) >= min(positions['validate'])): order_ok = False
    if positions['execute'] and (not positions['validate'] or max(positions['validate']) >= min(positions['execute'])): order_ok = False
    if positions['write'] and (rootpos < 0 or max([rootpos] + positions['encode'] + positions['validate'] + positions['execute'] + positions['extract']) >= min(positions['write'])): order_ok = False
    if positions['return_data'] and (not positions['write'] or max(positions['write']) >= min(positions['return_data'])): order_ok = False
    # Build exact success obligations on EVERY path; ret == 0 is a symbolic
    # condition, not a syntactic test for the literal zero expression.
    expected_kinds = (['custody'] if m['effects'] else []) + ['decode']*(len(m['fields'])+1) + ['clock','root'] + ['encode']*(1+len(m['fields']))
    if m['effects']: expected_kinds += ['extract'] + ['validate']*m['slots'] + ['execute']*m['slots']
    for i in range(len(m['fields'])): expected_kinds += ['write']*(2 if i == 0 else 3)
    expected_kinds += ['return_data']
    order_ok = order_ok and [e.kind for e in events] == expected_kinds
    order_ok = order_ok and [e.slot for e in events if e.kind in ('validate','execute')] == list(range(m['slots'])) * (2 if m['effects'] else 0)
    no_failure_write = z3.Implies(path.ret != 0, z3.BoolVal(not positions['write'] and not positions['return_data']))
    writes = [e for e in events if e.kind == 'write']
    exact_write = z3.BoolVal(True)
    expected_count = sum(2 if i == 0 else 3 for i in range(len(m['fields'])))
    exact_write = z3.BoolVal(len(writes) == expected_count)
    if len(writes) == expected_count:
        at = 0
        for i,spec in enumerate(m['fields']):
            expected = [(spec['index'],0,[z3.BitVecVal(x,8) for x in spec['header']])]
            if i: expected.append((spec['index'],20,[z3.Extract(8*j+7,8*j,w.key_bytes(0)) for j in range(32)]))
            expected.append((spec['index'],20+spec['bindingBytes'],w.field_bytes[i]))
            for account,offset,data in expected:
                actual = writes[at]; at += 1
                exact_write = z3.And(exact_write, z3.BoolVal(actual.account == account and actual.offset == offset and len(actual.data) == len(data)))
                if len(actual.data) == len(data): exact_write = z3.And(exact_write, *[a == b for a,b in zip(actual.data,data)])
        reply = [e for e in events if e.kind == 'return_data']
        exact_write = z3.And(exact_write, z3.BoolVal(len(reply) == 1))
        if len(reply) == 1:
            exact_write = z3.And(exact_write, z3.BoolVal(len(reply[0].data) == len(w.RPLY)),
                                z3.And(*[a == b for a,b in zip(reply[0].data,w.RPLY)]))
    encs = [e for e in events if e.kind == 'encode']
    source_ok = z3.BoolVal(all((e.encoder == 'complete' and e.src == ('state','complete') and e.target == 'reply')
                               if e.encoder == 'complete' else
                               (e.src == ('state-field', e.encoder) and e.target == f'encoded{e.encoder}') for e in encs))
    exact_commit = z3.Implies(path.ret == 0, z3.And(z3.BoolVal(order_ok), exact_write))
    all_claim = z3.And(root_presence, root_args, z3.Implies(path.ret == 0, z3.BoolVal(order_ok)), no_failure_write, exact_commit, source_ok)
    return {'root': z3.And(root_presence, root_args), 'ordered': z3.Implies(path.ret == 0, z3.BoolVal(order_ok)),
            'no-failure-write': no_failure_write, 'exact-commit-reply': exact_commit,
            'encode-sources': source_ok, 'all': all_claim}


def check_unsat(w, what, formula):
    solver = w.solver(); solver.add(formula)
    result = solver.check()
    if result == z3.unknown: raise Fatal(f'{what}: solver unknown ({solver.reason_unknown()})')
    return result == z3.unsat, solver


def analyse(m, fixture, files, require_witnesses=True, only_claim=None,
            include_cpi_validation_assumptions=True,
            proven_cpi_validation_premises=(), *, partition_check=None,
            claim_check=None, obligation_check=None):
    started = time.time(); adapter = fixture['adapter']
    dependencies, wire = audit_dependencies(m, adapter, files)
    compat = dict(m['_interface']); compat['version'] = 1
    extraction = check_extraction(m['_schema'], compat, files[adapter], files)
    need(extraction.get('passed') is True, 'extraction: incomplete analysis')
    # Effect type names are recovered from Accepted.effects; effects record and
    # per-effect record are independently held in the checked schema.
    accepted = next(v for v in m['_schema']['types'] if v['name'] == m['result_name'])
    av = next(v for v in accepted['variants'] if v['tag'] == m['accepted'])
    effects_type_name = av['fields'][1]['type'] if m['effects'] else None
    effect_c = m['types'][m['effect_type']]['cType'] if m['effects'] else None
    effects_c = m['types'][effects_type_name]['cType'] if m['effects'] else None
    body_tokens = extract_entrypoint(files[adapter], wire, m['effect_header'], m['effects'], effect_c, effects_c, m['slot_type'])
    parser_types = {'u8','u32','u64','unsigned','Account','BendClock'} | {t['cType'] for t in m['types'].values() if t['kind']=='adt'}
    if m['effects']: parser_types.add(m['slot_type'])
    parser = MultiParser(body_tokens, parser_types)
    body = []
    while parser.peek() != '}':
        need(parser.peek() != '', 'syntax: unterminated entrypoint')
        body.append(parser.statement())
    parser.take('}')
    need(parser.at == len(body_tokens), 'syntax: unparsed entrypoint token')
    w = MultiWorld(m, include_cpi_validation_assumptions,
                   proven_cpi_validation_premises)
    raw = MultiExec(w).run(body)
    c = mk_contract(w,m)
    # Totality/disjointness and every undefined-read/pointer/bounds obligation.
    for what,formula in (
        ('path totality', z3.Not(z3.Or([p.pc for p in w.paths]))),
        ('path disjointness', z3.Not(z3.AtMost(*[p.pc for p in w.paths],1)))):
        sat, solver = w.feasible(formula) if partition_check is None else partition_check(w, what, formula)
        if sat: raise Fatal(f'{what}: symbolic paths incomplete or overlapping: {w.describe(solver.model())}')
    if obligation_check is None and w.obligations:
        solver = w.solver(); solver.add(z3.Or([z3.And(pc,z3.Not(f)) for _,pc,f in w.obligations]))
        result = solver.check()
        if result == z3.unknown: raise Fatal(f'obligations: solver unknown ({solver.reason_unknown()})')
        if result == z3.sat:
            model = solver.model(); failed = sorted({label for label,pc,f in w.obligations if z3.is_true(model.eval(z3.And(pc,z3.Not(f)),model_completion=True))})
            raise SymSemantic(f'obligation: {failed[0]}', {'model': w.describe(model), 'completeModel': complete_model(model), 'failed': failed})
    elif obligation_check is not None:
        groups = {}
        for label,pc,claim in w.obligations:
            groups.setdefault(label,[]).append((pc,claim))
        need(sum(len(group) for group in groups.values()) == len(w.obligations), 'obligation group inventory')
        for label,group in groups.items():
            formula = z3.Or([z3.And(pc,z3.Not(claim)) for pc,claim in group])
            ok, solver = obligation_check(w,label,formula)
            if not ok:
                model = solver.model()
                raise SymSemantic(f'obligation: {label}', {'model':w.describe(model),'completeModel':complete_model(model),'failed':[label]})
    claims = {'ordered-return-contract': [], 'root-context-before-instruction': [],
              'all-encodes-validation-execution-before-commit': [], 'no-adapter-writes-on-explicit-failure': [],
              'exact-per-account-header-binding-payload-and-reply': [], 'encode-source-field-binding': []}
    witnesses = {}; negative_models = []
    for path in w.paths:
        trace = event_claims(w,m,c,path)
        claims['ordered-return-contract'].append(path.ret != c['expected'])
        claims['root-context-before-instruction'].append(z3.Not(trace['root']))
        claims['all-encodes-validation-execution-before-commit'].append(z3.Not(trace['ordered']))
        claims['no-adapter-writes-on-explicit-failure'].append(z3.Not(trace['no-failure-write']))
        claims['exact-per-account-header-binding-payload-and-reply'].append(z3.Not(trace['exact-commit-reply']))
        claims['encode-source-field-binding'].append(z3.Not(trace['encode-sources']))
    claim_results = {}
    for name, bads in claims.items():
        if only_claim is not None and name != only_claim: continue
        checker = check_unsat if claim_check is None else claim_check
        ok, solver = checker(w, name, z3.Or([z3.And(p.pc,b) for p,b in zip(w.paths,bads)]))
        if not ok:
            model = solver.model(); raise SymSemantic(name, {'model':w.describe(model),'completeModel':complete_model(model)})
        # Reachability witness: a normal fully accepted path demonstrates the
        # successful trace that this claim constrains.
        claim_results[name] = {'result':'unsat','counterexamples':0}
        if require_witnesses:
            solver = w.solver(); solver.add(z3.Or([z3.And(p.pc,c['success'],trace['all']) for p in w.paths for trace in [event_claims(w,m,c,p)]]))
            result = solver.check()
            if result == z3.unknown: raise Fatal(f'{name} witness: solver unknown ({solver.reason_unknown()})')
            if result != z3.sat: raise Fatal(f'{fixture["name"]} {name}: no complete successful reachability witness (solver {result})')
            claim_results[name]['reachabilityWitness'] = complete_model(solver.model())
    if require_witnesses:
      for index,(name,bad,code) in enumerate(c['stages']):
        prior = z3.And([ok for _,ok,_ in c['stages'][:index]])
        solver = w.solver(); solver.add(prior, z3.Not(bad))
        result = solver.check()
        if result == z3.unknown: raise Fatal(f'{name} witness: solver unknown ({solver.reason_unknown()})')
        if result == z3.sat:
            model = solver.model(); witnesses[name] = {'model':w.describe(model), 'completeModel':complete_model(model)}
    if require_witnesses and len(witnesses) != len(c['stages']):
        missing = sorted(set(name for name,_,_ in c['stages']) - set(witnesses))
        raise Fatal(f'{fixture["name"]}: unreachable contract stages without witnesses: {missing}')
    return {'fixture':fixture['name'],'adapterSha256':hashlib.sha256(files[adapter].encode()).hexdigest(),
            'files':{name:hashlib.sha256(value.encode()).hexdigest() for name,value in sorted(files.items())},
            'paths':len(w.paths),'rawPaths':raw,'modelObligations':len(w.obligations),'claims':claim_results,
            'witnesses':witnesses,'negativeModels':negative_models,'dependencies':dependencies,
            'extraction':extraction,'seconds':round(time.time()-started,3)}


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()


def main():
    if z3.get_version_string() != '5.1.0': raise Fatal(f'Expected Z3 5.1.0, found {z3.get_version_string()}')
    need(len(sys.argv) == 3, 'usage: multi_adapter_contract.py INPUT.json RESULT.json')
    payload_path, output_path = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
    output_path.unlink(missing_ok=True)
    payload = json.loads(payload_path.read_text())
    payload_digest = sha(payload_path)
    checker_files = ['multi_adapter_contract.py','adapter_contract_c.py','adapter_contract_sym.py','effect_extraction.py']
    checker_at_start = {f'verification/{name}':sha(HERE/name) for name in checker_files}
    required = {'pure-2','pure-3','pure-4','token-2','token-3','token-4','cpi-2','cpi-3','cpi-4'}
    fixture_names = {f['name'] for f in payload.get('fixtures',[])}
    need(fixture_names == required, f'fixture coverage mismatch: expected {sorted(required)}, found {sorted(fixture_names)}')
    need(payload.get('coverage') == sorted(required), 'coverage declaration mismatch')
    need(payload.get('fixtures') and payload.get('mutations') and payload.get('equivalents'), 'suite must have positive, mutation and equivalent cases')
    immutable = payload.get('immutableInputs',{})
    need(immutable, 'missing source-immutability manifest')
    for name,digest in immutable.items(): need(pathlib.Path(name).is_file() and sha(name)==digest, f'input changed before check: {name}')
    by_name = {f['name']:f for f in payload['fixtures']}
    positive, mutation_results, equivalent_results = [], [], []
    for item in payload['fixtures']:
        need(item['adapter'] in item['files'] and item['interface'].get('version') == 2, f'{item["name"]}: written ABI2 fixture incomplete')
        m = summarize(item['schema'],item['interface'])
        result = analyse(m,item,item['files'])
        result['schemaSha256'] = item['schemaFileSha256']
        result['interfaceSha256'] = item['interfaceFileSha256']
        result['artifactPaths'] = item['artifactPaths']
        result['sourceDependencies'] = item['sourceDependencies']
        positive.append(result)
        print(f'{item["name"]}: {result["paths"]} symbolic paths, {result["modelObligations"]} guarded obligations, '
              f'{len(result["claims"])} UNSAT claims, {len(result["witnesses"])} stage witnesses', flush=True)
    for case in payload['mutations']:
        print(f"mutation: {case['name']}", flush=True)
        base = by_name[case['fixture']]; files = dict(base['files']); files.update(case['files'])
        m = summarize(base['schema'],base['interface'])
        try:
            expected = case.get('expected','')
            only_claim = expected if expected in {
                'ordered-return-contract','root-context-before-instruction',
                'all-encodes-validation-execution-before-commit','no-adapter-writes-on-explicit-failure',
                'exact-per-account-header-binding-payload-and-reply','encode-source-field-binding'} else None
            report = analyse(m,base,files,require_witnesses=False,only_claim=only_claim)
        except SymSemantic as error:
            if case['kind'] != 'semantic': raise Fatal(f'{case["name"]}: semantic counterexample, expected {case["kind"]}: {error.label}') from error
            expected = case.get('expected')
            if expected and expected not in error.label: raise Fatal(f'{case["name"]}: expected semantic reason {expected!r}, got {error.label!r}') from error
            mutation_results.append({'name':case['name'],'fixture':case['fixture'],'result':'rejected',
                'kind':'semantic','reason':error.label,'mutatedFiles':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in case['files'].items()},
                'completeCounterexample':error.model})
        except Grammar as error:
            if case['kind'] != 'grammar': raise Fatal(f'{case["name"]}: grammar rejection, expected semantic: {error}') from error
            expected = case.get('expected')
            if expected and expected not in str(error): raise Fatal(f'{case["name"]}: expected grammar reason {expected!r}, got {str(error)!r}') from error
            mutation_results.append({'name':case['name'],'fixture':case['fixture'],'result':'rejected',
                'kind':'grammar','reason':str(error),'mutatedFiles':{k:hashlib.sha256(v.encode()).hexdigest() for k,v in case['files'].items()}})
        else:
            raise Fatal(f'{case["name"]}: mutated written C was accepted')
    for case in payload['equivalents']:
        base = by_name[case['fixture']]; files = dict(base['files']); files.update(case['files'])
        m = summarize(base['schema'],base['interface'])
        result = analyse(m,base,files)
        equivalent_results.append({'name':case['name'],'fixture':case['fixture'],'result':'accepted',
                                   'adapterSha256':result['adapterSha256'],'claims':len(result['claims'])})
    for name,digest in immutable.items():
        need(pathlib.Path(name).is_file() and sha(name)==digest, f'input changed during symbolic assurance: {name}')
    need(sha(payload_path) == payload_digest, 'payload changed during symbolic assurance')
    checker_at_end = {f'verification/{name}':sha(HERE/name) for name in checker_files}
    need(checker_at_end == checker_at_start,'checker inputs changed during symbolic assurance')
    report = {'passed':True,'scope':SCOPE,'coverage':sorted(required),'assumptions':ASSUMPTIONS,
        'notClaimed':NOT_CLAIMED,
        'contract':{'claims':{
            'ordered-return-contract':'Every written-C path returns the first failure code in the schema-derived ordered ABI2 stage list.',
            'root-context-before-instruction':'The root runs exactly once after field/instruction decodes and Clock; its context, before-field order and instruction equal the independently constructed inputs.',
            'all-encodes-validation-execution-before-commit':'The full reply and every per-field encode, all validations, and all executions finish before the first managed-account write.',
            'no-adapter-writes-on-explicit-failure':'Every nonzero explicit return path has no adapter write and no return-data syscall.',
            'exact-per-account-header-binding-payload-and-reply':'Success writes each exact ABI2 header, primary-key binding and corresponding encoded field to its specified account/offset, and returns the complete encoded record.',
            'encode-source-field-binding':'The complete record and each field encoder receive their schema-selected source and output buffer.'},
            'cpiPrecedence':'For each CPI effect slot, bend_invoke_validate nonzero return is observed before the writable-managed-state guard returns 22; every managed account index is guarded.'},
        'fixtures':positive,'mutations':mutation_results,'equivalentVariants':equivalent_results,
        'totals':{'fixtures':len(positive),'claims':sum(len(x['claims']) for x in positive),
          'unsatClaims':sum(sum(c['result']=='unsat' for c in x['claims'].values()) for x in positive),
          'modelObligations':sum(x['modelObligations'] for x in positive),
          'stageWitnesses':sum(len(x['witnesses']) for x in positive),
          'mutations':len(mutation_results),'semanticRejections':sum(x['kind']=='semantic' for x in mutation_results),
          'grammarRejections':sum(x['kind']=='grammar' for x in mutation_results),'equivalentVariants':len(equivalent_results)},
        'inputs':{'payloadSha256':payload_digest,
          'immutableSourceAndArtifactInputs':immutable,
          'checkerSha256':checker_at_start}}
    output_path.parent.mkdir(parents=True,exist_ok=True)
    output_path.write_text(json.dumps(report,indent=2)+'\n')
    t=report['totals']
    print(f'ABI2 multi-state contract: {t["fixtures"]} written adapters; {t["unsatClaims"]} UNSAT claims and '
          f'{t["stageWitnesses"]} reachability witnesses; {t["mutations"]} C mutations rejected '
          f'({t["semanticRejections"]} semantic, {t["grammarRejections"]} grammar); '
          f'{t["equivalentVariants"]} equivalent C variants accepted')


if __name__ == '__main__':
    try: main()
    except (Fatal, Grammar) as error: raise SystemExit(f'multi-state adapter contract failed: {error}')
