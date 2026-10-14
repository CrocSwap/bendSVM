"""Focused probes for verification/effect_extraction.py.

Reads the recorded adapter-contract fixtures read-only and checks that
  * every recorded fixture is accepted (pure adapters: explicit no-extraction),
  * behavior-preserving rewrites inside the grammar are accepted,
  * each deliberately faulty artifact is refused with the expected reason,
  * two- and eight-slot effect vectors are accepted and their faults refused.

The two- and eight-slot vector bundles are SYNTHETIC: no recorded fixture has
those capacities, so the schema is edited from the four-slot fixture, the
native header is regenerated from the checker's own typedef bridge and the
plural function is written here in the emitted style. They exercise the
checker's traversal logic; they are not evidence about emitted artifacts.

usage: effect_extraction_probes.py build/adapter-contract/inputs.json [report.json]
"""
import copy
import json
import pathlib
import re
import sys

from adapter_contract_c import Grammar
from effect_extraction import check_extraction, extraction_metadata, ident, native_typedef, Schema


class Failed(Exception):
    pass


def replace(text, old, new, which=0):
    """Replace one occurrence (`which` counts from 0; -1 is the last)."""
    parts = text.split(old)
    if len(parts) < 2:
        raise Failed(f'probe text not found: {old[:60]!r}')
    at = which if which >= 0 else len(parts) - 1 + which
    return old.join(parts[:at + 1]) + new + old.join(parts[at + 1:])


def line(text, start):
    """The full line beginning with `start`, including its newline."""
    at = text.index(start)
    return text[at:text.index('\n', at) + 1]


T1 = 'value->as.c1.'
NEGATIVE = {
    # fixture: [(name, file or None for the adapter, edit(text), expected reason)]
    'token-2': [
        ('extra declaration', None, lambda t: replace(t, '  if (value->tag == 0) return 1;', '  u32 extra = 0;\n  if (value->tag == 0) return 1;'), 'unsupported statement'),
        ('extra loop', None, lambda t: replace(t, '  if (value->tag == 0) return 1;', '  while (0) {}\n  if (value->tag == 0) return 1;'), 'unsupported statement'),
        ('extra assignment', None, lambda t: replace(t, '  out->authority = value->as.c1.f6.tag;', '  out->authority = value->as.c1.f6.tag; out->initialize = 1;'), 'wrong field mapping'),
        ('write through input', None, lambda t: replace(t, '  out->active = 1;', '  value->tag = 0; out->active = 1;'), 'unsupported statement'),
        ('discarded call', None, lambda t: replace(t, '  out->active = 1;', '  bend_extract_effect(value, out); out->active = 1;'), 'unsupported statement'),
        ('pointer cast', None, lambda t: replace(t, 'write_le(out->mint_key+0,', 'write_le((u8 *)out+24,'), 'unsupported cast'),
        ('fixed address cast', None, lambda t: replace(t, 'write_le(out->mint_key+0,', 'write_le((u8 *)4096,'), 'unsupported cast'),
        ('fixed address', None, lambda t: replace(t, 'write_le(out->mint_key+0,', 'write_le(4096,'), 'write_le target'),
        ('dereference', None, lambda t: replace(t, 'out->active = 2;', '*(out->mint_key+0) = 2;'), "expected 'out'"),
        ('array element write', None, lambda t: replace(t, 'out->active = 2;', 'out->mint_key[0] = 2;'), 'outside the named slot members'),
        ('write_le past array', None, lambda t: replace(t, 'write_le(out->mint_key+28,', 'write_le(out->mint_key+32,'), 'outside mint_key[32]'),
        ('write_le straddles array', None, lambda t: replace(t, 'write_le(out->recipient_key+28,', 'write_le(out->recipient_key+30,'), 'outside recipient_key[32]'),
        ('write_le eight bytes', None, lambda t: replace(t, 'c1.f3.as.c0.f7, 4);', 'c1.f3.as.c0.f7, 8);'), 'four bytes'),
        ('write_le three bytes', None, lambda t: replace(t, 'c1.f3.as.c0.f7, 4);', 'c1.f3.as.c0.f7, 3);'), 'four bytes'),
        ('write_le variable offset', None, lambda t: replace(t, 'write_le(out->mint_key+0,', 'write_le(out->mint_key+value->as.c2.f0,'), 'write_le target'),
        ('write_le scalar target', None, lambda t: replace(t, 'write_le(out->mint_key+0,', 'write_le(out->amount+0,'), 'not a slot byte array'),
        ('missing zeroing', None, lambda t: replace(t, '  *out = (BendTransfer){0};\n', ''), 'missing zeroing'),
        ('zeroing after dispatch', None, lambda t: replace(replace(t, '  *out = (BendTransfer){0};\n', ''), '  if (value->tag != 1) return 0;', '  if (value->tag != 1) return 0;\n  *out = (BendTransfer){0};'), 'missing zeroing'),
        ('nonzero initializer', None, lambda t: replace(t, '*out = (BendTransfer){0};', '*out = (BendTransfer){1};'), 'initializer'),
        ('indexed slot write', None, lambda t: replace(t, '  out->active = 1;', '  out[1] = (BendTransfer){0}; out->active = 1;'), 'indexed slot write'),
        ('neighbor slot member', None, lambda t: replace(t, '  out->active = 1;', '  out[1].active = 1;'), 'outside the named slot members'),
        ('source/destination swapped', None, lambda t: replace(t, 'out->source = value->as.c1.f0; out->destination = value->as.c1.f1;', 'out->source = value->as.c1.f1; out->destination = value->as.c1.f0;'), 'wrong field mapping'),
        ('mint from wrong field', None, lambda t: replace(t, 'out->mint = value->as.c1.f2;', 'out->mint = value->as.c1.f0;'), 'wrong field mapping'),
        ('missing scalar', None, lambda t: replace(t, ' out->mint = value->as.c1.f2;', ''), 'wrong field mapping'),
        ('wrong opcode', None, lambda t: replace(t, 'out->active = 2;', 'out->active = 1;'), 'wrong field mapping'),
        ('transfer opcode missing', None, lambda t: replace(t, '  out->active = 1;\n', ''), 'wrong field mapping'),
        ('key limbs swapped', None, lambda t: replace(replace(t, 'mint_key+0, value->as.c1.f3.as.c0.f0', 'mint_key+0, value->as.c1.f3.as.c0.f1'), 'mint_key+4, value->as.c1.f3.as.c0.f1', 'mint_key+4, value->as.c1.f3.as.c0.f0'), 'wrong field mapping'),
        ('key limb offset shifted', None, lambda t: replace(t, 'write_le(out->mint_key+4, value->as.c1.f3', 'write_le(out->mint_key+3, value->as.c1.f3'), 'wrong field mapping'),
        ('key limb missing', None, lambda t: replace(t, line(t, 'write_le(out->mint_key+12, value->as.c1.f3'), ''), 'wrong field mapping'),
        ('recipient key into mint key', None, lambda t: replace(t, 'write_le(out->recipient_key+0,', 'write_le(out->mint_key+0,'), 'wrong field mapping'),
        ('high limb not widened', None, lambda t: replace(t, '((u64)value->as.c1.f5.as.c0.f1 << 32)', '(value->as.c1.f5.as.c0.f1 << 32)'), 'truncated high limb'),
        ('high limb shifted by 31', None, lambda t: replace(t, 'f1 << 32)', 'f1 << 31)'), 'shift amount'),
        ('high limb dropped', None, lambda t: replace(t, ' | ((u64)value->as.c1.f5.as.c0.f1 << 32)', ''), 'unsupported assigned value'),
        ('amount limbs swapped', None, lambda t: replace(t, '(u64)value->as.c1.f5.as.c0.f0 | ((u64)value->as.c1.f5.as.c0.f1 << 32)', '(u64)value->as.c1.f5.as.c0.f1 | ((u64)value->as.c1.f5.as.c0.f0 << 32)'), 'wrong field mapping'),
        ('amount narrowed', None, lambda t: replace(t, 'out->amount = (u64)value->as.c1.f5.as.c0.f0 |', 'out->amount = (u32)value->as.c1.f5.as.c0.f0 |'), 'unsupported cast'),
        ('amount into u32 member', None, lambda t: replace(t, 'out->amount = (u64)', 'out->mint = (u64)'), 'value width'),
        ('recipient key omitted', None, lambda t: replace(t, t[t.index('  if (out->recipient == 2) {'):t.index('  if (value->as.c1.f5.tag != 0)')], ''), 'wrong field mapping'),
        ('recipient key on wrong tag', None, lambda t: replace(t, 'if (out->recipient == 2)', 'if (out->recipient == 1)'), 'without its tag being established'),
        ('recipient key unconditional', None, lambda t: replace(t, 'if (out->recipient == 2) {', '{'), 'without its tag being established'),
        ('amount tag guard removed', None, lambda t: replace(t, '  if (value->as.c1.f5.tag != 0) return 0;\n', ''), 'without the guard'),
        ('authority guard removed', None, lambda t: replace(t, 'return out->authority <= 1 && out->recipient <= 2;', 'return out->recipient <= 2;'), 'without the guard'),
        ('recipient guard weakened', None, lambda t: replace(t, 'out->recipient <= 2;', 'out->recipient <= 3;'), 'without the guard'),
        ('variant dispatch removed', None, lambda t: replace(t, '  if (value->tag != 1) return 0;\n', ''), 'without its tag being established'),
        ('well-formed value rejected', None, lambda t: replace(t, '  out->active = 1;', '  if (value->as.c1.f0 == 7) return 0;\n  out->active = 1;'), 'conditional omission'),
        ('check-mint dropped', None, lambda t: replace(t, 'if (value->tag == 2) {', 'if (value->tag == 9) {'), 'without its tag being established'),
        ('none rejected', None, lambda t: replace(t, 'if (value->tag == 0) return 1;', 'if (value->tag == 0) return 0;'), 'conditional omission'),
        ('conditional scalar', None, lambda t: replace(t, 'out->mint = value->as.c1.f2;', 'if (value->as.c1.f0 != 0) out->mint = value->as.c1.f2;'), 'wrong field mapping'),
        ('nonboolean return', None, lambda t: replace(t, '    return 1;\n  }', '    return 2;\n  }'), '0/1 result'),
        ('missing return', None, lambda t: replace(t, '  return out->authority <= 1 && out->recipient <= 2;\n', ''), 'without a return'),
        ('ternary', None, lambda t: replace(t, 'out->mint = value->as.c1.f2;', 'out->mint = value->tag == 1 ? value->as.c1.f2 : 0;'), "expected ';'"),
        ('signature not const', None, lambda t: replace(t, 'bend_extract_effect(const ', 'bend_extract_effect('), 'signature differs'),
        ('second slot omitted', None, lambda t: replace(t, ' &&\n    bend_extract_effect(&value->as.c0.f1,&out[1])', ''), 'slot 1 is not extracted'),
        ('slot sources swapped', None, lambda t: replace(replace(t, '&value->as.c0.f0,&out[0]', '&value->as.c0.f1,&out[0]'), '&value->as.c0.f1,&out[1]', '&value->as.c0.f0,&out[1]'), 'wrong traversal'),
        ('same slot twice', None, lambda t: replace(t, '&value->as.c0.f1,&out[1]', '&value->as.c0.f1,&out[0]'), 'slot 0 is not extracted'),
        ('slot index out of bounds', None, lambda t: replace(t, '&value->as.c0.f1,&out[1]', '&value->as.c0.f1,&out[2]'), 'outside the 2 output slots'),
        ('record tag guard removed', None, lambda t: replace(t, 'return value->tag == 0 && bend_extract_effect', 'return bend_extract_effect'), 'without the guard'),
        ('failure ignored', None, lambda t: replace(t, ' &&\n    bend_extract_effect(&value->as.c0.f1', ' ||\n    bend_extract_effect(&value->as.c0.f1'), 'effect extraction:'),
        ('unindexed slot argument', None, lambda t: replace(t, '&out[0])', 'out)'), 'not addresses'),
        ('plural member write', None, lambda t: replace(t, '  return value->tag == 0 && bend', '  out->active = 1;\n  return value->tag == 0 && bend'), 'plural function'),
        ('extraction redeclared', None, lambda t: replace(t, 'typedef struct { u64 slot;', 'static inline int bend_extract_effects(const void *value, BendTransfer *out);\ntypedef struct { u64 slot;'), 'declared again'),
        ('write_le body changed', 'solana_min.h', lambda t: replace(t, 'p[i] = (u8)(v >> (8 * i));', 'p[i] = (u8)(v >> (4 * i));'), 'solana_min.h differs'),
        ('write_le bound changed', 'solana_min.h', lambda t: replace(t, 'for (unsigned i = 0; i < n; ++i) p[i] =', 'for (unsigned i = 0; i <= n; ++i) p[i] ='), 'solana_min.h differs'),
        ('u64 narrowed', 'solana_min.h', lambda t: replace(t, 'typedef unsigned long long u64;', 'typedef unsigned int u64;'), 'solana_min.h differs'),
        ('slot array shortened', 'token.h', lambda t: replace(t, 'u8 mint_key[32], recipient_key[32];', 'u8 mint_key[16], recipient_key[32];'), 'token.h differs'),
        ('slot members reordered', 'token.h', lambda t: replace(t, 'u32 active, source, destination,', 'u32 active, destination, source,'), 'token.h differs'),
        ('macro rewrites output', 'token.h', lambda t: t + '#define out other\n', 'could rewrite the extraction text'),
        ('macro rewrites member', 'cpi_abi.h', lambda t: t + '#define f1 f0\n', 'could rewrite the extraction text'),
        ('native field narrowed', 'token-2.h', lambda t: replace(t, 'struct { bend_u32 f0; bend_u32 f1; } c0;', 'struct { bend_u32 f0; unsigned char f1; } c0;'), 'token-2.h differs'),
    ],
    'token-3': [
        ('third slot omitted', None, lambda t: replace(t, ' &&\n    bend_extract_effect(&value->as.c0.f2,&out[2])', ''), 'slot 2 is not extracted'),
        ('third slot from second', None, lambda t: replace(t, '&value->as.c0.f2,&out[2]', '&value->as.c0.f1,&out[2]'), 'wrong traversal'),
        ('slot index out of bounds', None, lambda t: replace(t, '&out[2]', '&out[3]'), 'outside the 3 output slots'),
    ],
    'issuance-3': [
        ('mint authority actor', None, lambda t: replace(t, 'out->active = 3; out->authority = 1;', 'out->active = 3; out->authority = 0;'), 'wrong field mapping'),
        ('mint/burn opcodes swapped', None, lambda t: replace(replace(t, 'out->active = 3;', 'out->active = 4;'), 'out->active = 4; out->source', 'out->active = 3; out->source'), 'wrong field mapping'),
        ('initialize guard removed', None, lambda t: replace(t, 'return out->initialize <= 1;', 'return 1;'), 'without the guard'),
        ('initialize omitted', None, lambda t: replace(t, '    out->initialize = value->as.c3.f5;\n    return out->initialize <= 1;', '    return 1;'), 'without the guard'),
        ('mint recipient guard removed', None, lambda t: replace(t, '    if (out->recipient > 2) return 0;\n', '', 1), 'without the guard'),
        ('burn amount guard removed', None, lambda t: replace(t, '    if (value->as.c4.f3.tag != 0) return 0;\n', ''), 'without the guard'),
        ('burn source from mint', None, lambda t: replace(t, 'out->source = value->as.c4.f0;', 'out->source = value->as.c4.f1;'), 'wrong field mapping'),
        ('bound details guard removed', None, lambda t: replace(t, '    if (value->as.c5.f0.tag != 0) return 0;\n', ''), 'without the guard'),
        ('bound source key unconditional', None, lambda t: replace(t, 'if (out->source_bound == 1) {', '{'), 'without its tag being established'),
        ('bound keys crossed', None, lambda t: replace(t, 'write_le(out->source_key+0, value->as.c5.f1', 'write_le(out->source_key+0, value->as.c5.f2'), 'without its tag being established'),
        ('bound destination key into source key', None, lambda t: replace(t, 'write_le(out->destination_key+0,', 'write_le(out->source_key+0,'), 'wrong field mapping'),
        ('bound flag guard removed', None, lambda t: replace(t, 'out->source_bound <= 1 && ', ''), 'without the guard'),
        ('fresh guard removed', None, lambda t: replace(t, ' && out->fresh_destination <= 1;', ';'), 'without the guard'),
        ('fresh destination omitted', None, lambda t: replace(replace(t, '    out->fresh_destination = value->as.c5.f3;\n', ''), ' && out->fresh_destination <= 1;', ';'), 'without the guard'),
        ('bound reads plain transfer', None, lambda t: replace(t, 'out->source = value->as.c5.f0.as.c0.f0;', 'out->source = value->as.c1.f0;'), 'without its tag being established'),
        ('key write past slot end', None, lambda t: replace(t, 'write_le(out->destination_key+28,', 'write_le(out->destination_key+29,'), 'outside destination_key[32]'),
        ('native union member retyped', 'issuance-3.h', lambda t: (lambda at: t[:at] + 'unsigned char tag;' + t[at + 13:])(
            t.rindex('bend_u32 tag;', 0, t.index('} bend__2e__2e__2f_sdk_2f_issuance_2e_Effect_t;'))), 'issuance-3.h differs'),
    ],
    'effect-vector-4': [
        ('inactive slot not zeroed', None, lambda t: replace(t, ' else { out[3] = (BendTransfer){0}; }', ''), 'inactive slot 3 is not zeroed'),
        ('inactive slot zeroes neighbor', None, lambda t: replace(t, 'else { out[3] = (BendTransfer){0}; }', 'else { out[2] = (BendTransfer){0}; }'), 'effect extraction:'),
        ('zero past the array', None, lambda t: replace(t, 'else { out[3] = (BendTransfer){0}; }', 'else { out[4] = (BendTransfer){0}; }'), 'outside the 4 output slots'),
        ('length bound weakened', None, lambda t: replace(t, 'value->as.c0.f0 > 4u) return 0;', 'value->as.c0.f0 > 5u) return 0;'), 'length bound'),
        ('length bound removed', None, lambda t: replace(t, ' || value->as.c0.f0 > 4u) return 0;', ') return 0;'), 'length bound'),
        ('length bound too strict', None, lambda t: replace(t, 'value->as.c0.f0 > 4u) return 0;', 'value->as.c0.f0 > 3u) return 0;'), 'conditional omission'),
        ('slot activation off by one', None, lambda t: replace(t, 'if (1u < value->as.c0.f0)', 'if (2u < value->as.c0.f0)'), 'slot 1 is not extracted'),
        ('slot always extracted', None, lambda t: replace(t, 'if (3u < value->as.c0.f0)', 'if (2u < value->as.c0.f0)'), 'inactive slot 3 is not zeroed'),
        ('pair tag guard removed', None, lambda t: replace(t, ' || value->as.c0.f1.as.c0.f1.tag != 0', ''), 'without the guard'),
        ('vector tag guard removed', None, lambda t: replace(t, 'if (value->tag != 0 || value->as.c0.f1.tag', 'if (value->as.c0.f1.tag'), 'without the guard'),
        ('traversal crosses pairs', None, lambda t: replace(t, '&value->as.c0.f1.as.c0.f1.as.c0.f0, &out[2]', '&value->as.c0.f1.as.c0.f0.as.c0.f0, &out[2]'), 'wrong traversal'),
        ('extraction failure ignored', None, lambda t: replace(t, 'if (!bend_extract_effect(&value->as.c0.f1.as.c0.f0.as.c0.f1, &out[1])) return 0;', 'bend_extract_effect(&value->as.c0.f1.as.c0.f0.as.c0.f1, &out[1]);'), 'unsupported statement'),
        ('extraction failure accepted', None, lambda t: replace(t, 'if (!bend_extract_effect(&value->as.c0.f1.as.c0.f0.as.c0.f1, &out[1])) return 0;', 'if (!bend_extract_effect(&value->as.c0.f1.as.c0.f0.as.c0.f1, &out[1])) return 1;'), 'success after a failed slot extraction'),
        ('pair passed as effect', None, lambda t: replace(t, '&value->as.c0.f1.as.c0.f0.as.c0.f0, &out[0]', '&value->as.c0.f1.as.c0.f0, &out[0]'), 'not an effect'),
        ('missing final return', None, lambda t: replace(t, '  return 1;\n}\n\n', '}\n\n'), 'without a return'),
    ],
    'cpi-2': [
        ('meta index out of bounds', None, lambda t: replace(t, 'out->metas[7].index=', 'out->metas[8].index='), 'outside the named slot members'),
        ('meta key out of bounds', None, lambda t: replace(t, 'write_le(out->metas[7].key+28,', 'write_le(out->metas[7].key+32,'), 'outside metas.7.key[32]'),
        ('data limb out of bounds', None, lambda t: replace(t, 'write_le(out->data+60,', 'write_le(out->data+64,'), 'outside data[64]'),
        ('data limb into key', None, lambda t: replace(t, 'write_le(out->data+60,', 'write_le(out->program_key+28,'), 'wrong field mapping'),
        ('data limbs swapped', None, lambda t: replace(replace(t, 'data+56,value->as.c1.f3.as.c0.f14', 'data+56,value->as.c1.f3.as.c0.f15'), 'data+60,value->as.c1.f3.as.c0.f15', 'data+60,value->as.c1.f3.as.c0.f14'), 'wrong field mapping'),
        ('data limb missing', None, lambda t: replace(t, line(t, 'write_le(out->data+32,'), ''), 'wrong field mapping'),
        ('writable/signer swapped', None, lambda t: replace(replace(t, 'out->metas[3].writable=value->as.c1.f5.as.c0.f3.as.c0.f2', 'out->metas[3].writable=value->as.c1.f5.as.c0.f3.as.c0.f3'), 'out->metas[3].signer=value->as.c1.f5.as.c0.f3.as.c0.f3', 'out->metas[3].signer=value->as.c1.f5.as.c0.f3.as.c0.f2'), 'wrong field mapping'),
        ('meta from wrong account', None, lambda t: replace(t, 'out->metas[5].index=value->as.c1.f5.as.c0.f5.as.c0.f0', 'out->metas[5].index=value->as.c1.f5.as.c0.f4.as.c0.f0'), 'wrong field mapping'),
        ('meta key limb missing', None, lambda t: replace(t, line(t, 'write_le(out->metas[6].key+16,'), ''), 'wrong field mapping'),
        ('partial metas', None, lambda t: replace(t, t[t.index('out->metas[7].index='):t.index('  return 1;\n}')], ''), 'wrong field mapping'),
        ('length from count', None, lambda t: replace(t, 'out->length=value->as.c1.f2;', 'out->length=value->as.c1.f4;'), 'wrong field mapping'),
        ('program key limb missing', None, lambda t: replace(t, line(t, 'write_le(out->program_key+8,'), ''), 'wrong field mapping'),
        ('inactive opcode', None, lambda t: replace(t, 'out->active=1;', 'out->active=0;'), 'wrong field mapping'),
        ('missing zeroing', None, lambda t: replace(t, '*out=(BendInvoke){0}; ', ''), 'missing zeroing'),
        ('invoke dispatch removed', None, lambda t: replace(t, ' if(value->tag!=1) return 0;', ''), 'without its tag being established'),
        ('second slot omitted', None, lambda t: replace(t, ' && bend_extract_effect(&value->as.c0.f1,&out[1])', ''), 'slot 1 is not extracted'),
        ('meta struct reordered', 'bend_cpi.h', lambda t: replace(t, 'u32 index, writable, signer; u8 key[32];', 'u32 index, signer, writable; u8 key[32];'), 'bend_cpi.h differs'),
        ('fewer metas', 'bend_cpi.h', lambda t: replace(t, 'BendInvokeMeta metas[8];', 'BendInvokeMeta metas[4];'), 'bend_cpi.h differs'),
        ('quoted include form', None, lambda t: replace(t, '#include <bend_cpi.h>', '#include "bend_cpi.h"'), 'includes'),
    ],
    'pure': [
        ('pure adapter with extraction', None, lambda t: replace(t, 'typedef struct { u64 slot;', 'static inline int bend_extract_effect(const void *value, void *out) { return 1; }\ntypedef struct { u64 slot;'), 'pure adapter mentions'),
    ],
}

# Regression probes from the independent review: decoys must not count as
# live definitions, even when a complete mutated translation unit compiles.
def macro_write_decoy(text):
    match = re.search(r'static inline void write_le\([^}]+}', text)
    assert match is not None
    reviewed = match.group()
    actual = reviewed.replace('p[i]', 'p[n - 1 - i]')
    assert actual != reviewed
    return replace(text, reviewed, '#define BEND_REVIEWED_WRITE_LE ' + ' '.join(reviewed.split()) + '\n' + actual)


def block_slot_decoy(text):
    match = re.search(r'typedef struct \{ u32 active[\s\S]+?} BendTransfer;', text)
    assert match is not None
    reviewed = match.group()
    actual = reviewed.replace('u64 amount;', 'u32 amount; u32 amount_pad;').replace('mint_key[32]', 'mint_key[4]')
    assert actual != reviewed
    return replace(text, reviewed, 'static inline void bend_unused_layout(void) { ' + reviewed + ' }\n' + actual)


def macro_native_decoy(text):
    match = re.search(r'typedef struct \{\s*bend_u32 tag;\s*union \{\s*struct \{ bend_u32 f0; bend_u32 f1; \} c0;\s*\} as;\s*\} \w+U64_t;', text)
    assert match is not None
    reviewed = match.group()
    actual = reviewed.replace('bend_u32 f0;', 'unsigned short f0;')
    return replace(text, reviewed, '#define BEND_REVIEWED_U64 ' + ' '.join(reviewed.split()) + '\n' + actual)


NEGATIVE['token-2'] += [
    ('macro body write_le decoy', 'solana_min.h', macro_write_decoy, 'macro replacement must be a single integer literal'),
    ('block scope slot decoy', 'token.h', block_slot_decoy, 'token.h differs from the reviewed text'),
    ('digraph scope slot decoy', 'token.h', lambda t: block_slot_decoy(t).replace('bend_unused_layout(void) {', 'bend_unused_layout(void) <% ;').replace('BendTransfer; }', 'BendTransfer; %>'), 'digraph'),
    ('macro body native typedef decoy', 'token-2.h', macro_native_decoy, 'macro replacement must be a single integer literal'),
    ('macro hides scope brace', 'token.h', lambda t: '#define BEND_OPEN {\n' + t,
     'macro replacement must be a single integer literal'),
    ('pragma layout control', 'token.h', lambda t: '_Pragma("pack(1)")\n' + t, 'unsupported layout or pragma control'),
    ('attribute layout control', 'token.h', lambda t: t + '\nstruct __attribute__((packed)) unused_layout { u32 x; };\n',
     'unsupported attribute'),
    ('unsequenced extraction calls', None, lambda t: replace(t,
      'bend_extract_effect(&value->as.c0.f0,&out[0]) &&',
      'bend_extract_effect(&value->as.c0.f1,&out[0]) > !bend_extract_effect(&value->as.c0.f0,&out[0]) &&'),
     'calls in unsequenced operands'),
]

EQUIVALENT = {
    'token-2': [
        ('comments and whitespace', lambda t: replace(t, '  out->active = 1;\n', '  /* opcode */ out->active\t=\n 1 ; // transfer\n')),
        ('scalar assignments reordered', lambda t: replace(t, 'out->source = value->as.c1.f0; out->destination = value->as.c1.f1;', 'out->destination = value->as.c1.f1; out->source = value->as.c1.f0;')),
        ('amount operands commuted', lambda t: replace(t, '(u64)value->as.c1.f5.as.c0.f0 | ((u64)value->as.c1.f5.as.c0.f1 << 32)', '((u64)value->as.c1.f5.as.c0.f1 << 32) | (u64)value->as.c1.f5.as.c0.f0')),
        ('guard written as comparison of the input', lambda t: replace(t, 'return out->authority <= 1 && out->recipient <= 2;', 'return value->as.c1.f6.tag < 2 && 3 > out->recipient;')),
        ('early recipient guard', lambda t: replace(t, '  if (out->recipient == 2) {', '  if (out->recipient > 2) return 0;\n  if (out->recipient == 2) {')),
        ('plural as statements', lambda t: replace(t, '  return value->tag == 0 && bend_extract_effect(&value->as.c0.f0,&out[0]) &&\n    bend_extract_effect(&value->as.c0.f1,&out[1]);',
                                                   '  if (value->tag != 0) return 0;\n  if (!bend_extract_effect(&value->as.c0.f1,&out[1])) return 0;\n  return bend_extract_effect(&value->as.c0.f0,&out[0]);')),
    ],
    'effect-vector-4': [
        ('slots handled in reverse order', lambda t: (lambda a, b: replace(replace(t, a, '@@'), b, a).replace('@@', b))(
            t[t.index('  if (0u < value->as.c0.f0) {'):t.index('  if (1u < value->as.c0.f0) {')],
            t[t.index('  if (3u < value->as.c0.f0) {'):t.index('  return 1;\n}\n\n')])),
        ('activation written as length > index', lambda t: replace(t, 'if (2u < value->as.c0.f0)', 'if (value->as.c0.f0 >= 3)')),
    ],
    'cpi-2': [
        ('meta assignments reordered', lambda t: replace(t, 'out->active=1;out->program=value->as.c1.f0;', 'out->program=value->as.c1.f0;out->active=1;')),
    ],
}


def expect_reject(label, schema, interface, adapter, files, expected):
    try:
        check_extraction(schema, interface, adapter, files)
    except Grammar as error:
        if expected not in str(error):
            raise Failed(f'{label}: refused for the wrong reason: expected {expected!r}, got {str(error)!r}')
        return str(error)
    raise Failed(f'{label}: faulty artifact was accepted')


def synthetic_vector(fixture, capacity):
    """A `capacity`-slot effect vector bundle derived from the four-slot fixture."""
    f = copy.deepcopy(fixture)
    schema, stem = f['schema'], f['adapter'][:-2]
    types = {t['name']: t for t in schema['types']}
    vector = next(t for t in schema['types'] if t['kind'] == 'adt'
                  and [x['name'] for x in t['variants'][0]['fields']] == ['length', 'storage'])
    storage = vector['variants'][0]['fields'][1]
    pair4 = types[storage['type']]
    pair2 = types[pair4['variants'][0]['fields'][0]['type']]
    if capacity == 2:
        storage['type'] = pair2['name']
    else:
        name = pair4['name'].replace('Pair<', 'Pair<../sdk/buffer.Pair<', 1) + '>'
        schema['types'].append({'kind': 'adt', 'name': name, 'cType': ident(name) + '_t', 'variants': [
            {'name': name, 'tag': 0, 'cMaker': ident(name) + '_make',
             'fields': [{'name': 'left', 'type': pair4['name']}, {'name': 'right', 'type': pair4['name']}]}]})
        storage['type'] = name
    if capacity > 2:
        f['interface']['effectSlots'] = capacity
    else:
        f['interface'].pop('effectSlots', None)
    s = Schema(schema)
    f['files'][stem + '.h'] = ('#pragma once\ntypedef unsigned int bend_u32;\n'
                               '_Static_assert(sizeof(bend_u32) == 4, "Requires 32-bit unsigned int");\n'
                               + '\n'.join(native_typedef(s, t['name']) for t in schema['types'] if t['kind'] == 'adt') + '\n')
    # The plural function, written here in the emitted style.
    depth = {2: 1, 8: 3}[capacity]
    tags, leaves = ['value->tag'], []

    def walk(path, level):
        if level == depth:
            leaves.append(path)
            return
        tags.append(path + '.tag')
        walk(path + '.as.c0.f0', level + 1)
        walk(path + '.as.c0.f1', level + 1)
    walk('value->as.c0.f1', 0)
    body = ('  if (' + ' || '.join(f'{t} != 0' for t in tags) + f' || value->as.c0.f0 > {capacity}u) return 0;\n'
            + ''.join(f'  if ({i}u < value->as.c0.f0) {{\n    if (!bend_extract_effect(&{leaf}, &out[{i}])) return 0;\n'
                      f'  }} else {{ out[{i}] = (BendTransfer){{0}}; }}\n' for i, leaf in enumerate(leaves)) + '  return 1;\n')
    text = f['files'][f['adapter']]
    start = text.index('{', text.index('bend_extract_effects(')) + 1
    end = text.index('typedef struct { u64 slot;')
    f['files'][f['adapter']] = text[:start] + '\n' + body + '}\n' + text[end:]
    f['name'] = f'synthetic-vector-{capacity}'
    return f


def main():
    payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
    fixtures = {f['name']: f for f in payload['fixtures']}
    report = {'fixtures': [], 'equivalents': [], 'negatives': [], 'synthetic': [], 'recordedMutations': None}
    for name, f in fixtures.items():
        evidence = check_extraction(f['schema'], f['interface'], f['files'][f['adapter']], f['files'])
        json.dumps(evidence)
        meta = extraction_metadata(f['schema'], f['interface'])
        if evidence['kind'] != meta['kind'] or (evidence['extraction'] == 'none') != (meta['kind'] == 'none'):
            raise Failed(f'{name}: metadata disagrees with the evidence')
        report['fixtures'].append({'fixture': name, 'kind': evidence['kind'], 'extraction': evidence['extraction'],
                                   'slots': meta['slots'], 'layout': meta.get('layout'),
                                   'singlePaths': evidence.get('single', {}).get('paths'),
                                   'pluralPaths': evidence.get('plural', {}).get('paths'),
                                   'uncheckedTerms': len(evidence.get('single', {}).get('uncheckedTerms', []))})
    for name, items in EQUIVALENT.items():
        f = fixtures[name]
        for label, edit in items:
            text = edit(f['files'][f['adapter']])
            if text == f['files'][f['adapter']]:
                raise Failed(f'{name}/{label}: variant does not change the adapter')
            try:
                check_extraction(f['schema'], f['interface'], text, {**f['files'], f['adapter']: text})
            except Grammar as error:
                raise Failed(f'{name}/{label}: behavior-preserving variant refused: {error}')
            report['equivalents'].append({'fixture': name, 'name': label})
    for name, items in NEGATIVE.items():
        f = fixtures[name]
        for label, target, edit, expected in items:
            target = target or f['adapter']
            text = edit(f['files'][target])
            if text == f['files'][target]:
                raise Failed(f'{name}/{label}: probe does not change {target}')
            files = {**f['files'], target: text}
            reason = expect_reject(f'{name}/{label}', f['schema'], f['interface'], files[f['adapter']], files, expected)
            report['negatives'].append({'fixture': name, 'name': label, 'file': target, 'reason': reason})
    # Schema/interface disagreement with the artifact.
    f = fixtures['token-2']
    for label, schema, interface, expected in [
            ('interface kind changed', f['schema'], {**f['interface'], 'effects': 'token-v2'}, 'interface: effect kind'),
            ('interface slot count changed', f['schema'], {**f['interface'], 'effectSlots': 3}, 'interface: effect slots'),
            ('schema of another program', fixtures['issuance-3']['schema'], fixtures['issuance-3']['interface'], 'signature differs'),
            ('pure schema for an effectful adapter', fixtures['pure']['schema'], fixtures['pure']['interface'], 'pure adapter mentions')]:
        reason = expect_reject(f'token-2/{label}', schema, interface, f['files'][f['adapter']], f['files'], expected)
        report['negatives'].append({'fixture': 'token-2', 'name': label, 'file': 'schema/interface', 'reason': reason})
    swapped = copy.deepcopy(f['schema'])
    transfer = next(v for t in swapped['types'] if t['kind'] == 'adt' for v in t['variants'] if v['name'].endswith('Transfer'))
    transfer['fields'][0]['name'], transfer['fields'][1]['name'] = 'destination', 'source'
    reason = expect_reject('token-2/schema field names swapped', swapped, f['interface'], f['files'][f['adapter']], f['files'],
                           'schema: transfer fields')
    report['negatives'].append({'fixture': 'token-2', 'name': 'schema field names swapped', 'file': 'schema', 'reason': reason})
    # Synthetic two- and eight-slot vectors.
    for capacity in (2, 8):
        f = synthetic_vector(fixtures['effect-vector-4'], capacity)
        adapter = f['files'][f['adapter']]
        evidence = check_extraction(f['schema'], f['interface'], adapter, f['files'])
        if evidence['plural']['slots'] != capacity or evidence['plural']['activeLengths'] != list(range(capacity + 1)):
            raise Failed(f'synthetic vector {capacity}: unexpected evidence')
        lastslot = capacity - 1
        probes = [
            ('last inactive slot not zeroed', replace(adapter, f' else {{ out[{lastslot}] = (BendTransfer){{0}}; }}', ''), f'inactive slot {lastslot} is not zeroed'),
            ('length bound weakened', replace(adapter, f'value->as.c0.f0 > {capacity}u', f'value->as.c0.f0 > {capacity + 1}u'), 'length bound'),
            ('last slot activation off by one', replace(adapter, f'if ({lastslot}u < value->as.c0.f0)', f'if ({capacity}u < value->as.c0.f0)'), f'slot {lastslot} is not extracted'),
            ('slot past the array', replace(adapter, f'&out[{lastslot}])', f'&out[{capacity}])'), f'outside the {capacity} output slots'),
            ('deepest pair tag guard removed', replace(adapter, ' != 0 || value->as.c0.f0 >', ' != 9 || value->as.c0.f0 >'), 'effect extraction:'),
            ('first two sources swapped', replace(replace(replace(adapter, '.f0, &out[0]', '.fX, &out[0]'), '.f1, &out[1]', '.f0, &out[1]'), '.fX, &out[0]', '.f1, &out[0]'), 'wrong traversal'),
        ]
        rejected = []
        for label, text, expected in probes:
            reason = expect_reject(f'{f["name"]}/{label}', f['schema'], f['interface'], text, {**f['files'], f['adapter']: text}, expected)
            rejected.append({'name': label, 'reason': reason})
        report['synthetic'].append({'name': f['name'], 'slots': capacity, 'pluralPaths': evidence['plural']['paths'],
                                    'slotSources': evidence['plural']['slotSources'], 'rejected': rejected})
    # The host's recorded artifact mutations: never crash; classify each.
    accepted = refused = 0
    for item in payload['mutations'] + payload['equivalents']:
        f = fixtures[item['fixture']]
        files = {**f['files'], **item['files']}
        try:
            check_extraction(f['schema'], f['interface'], files[f['adapter']], files)
            accepted += 1
        except Grammar:
            refused += 1
    report['recordedMutations'] = {'total': accepted + refused, 'extractionAccepted': accepted, 'extractionRefused': refused,
                                   'note': 'host entrypoint mutations; most do not touch extraction, so acceptance here is expected'}
    report['totals'] = {'fixtures': len(report['fixtures']), 'equivalents': len(report['equivalents']),
                        'negatives': len(report['negatives']) + sum(len(s['rejected']) for s in report['synthetic']),
                        'syntheticVectors': len(report['synthetic'])}
    if len(sys.argv) > 2:
        pathlib.Path(sys.argv[2]).write_text(json.dumps(report, indent=2) + '\n')
    t = report['totals']
    print(f'effect extraction probes: {t["fixtures"]} fixtures accepted, {t["equivalents"]} equivalent variants accepted, '
          f'{t["negatives"]} faulty artifacts refused for the expected reason, {t["syntheticVectors"]} synthetic vectors; '
          f'recorded host mutations: {accepted} accepted, {refused} refused by extraction')


if __name__ == '__main__':
    try:
        main()
    except Failed as error:
        raise SystemExit(f'effect extraction probes failed: {error}')
