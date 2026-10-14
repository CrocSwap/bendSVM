"""Adversarial regressions for the trusted adapter symbolic interpreter.

These synthetic fragments test path coverage and fail-closed behavior. They
are checker tests, not evidence that an emitted adapter meets its contract.
"""
import pathlib
import sys
import unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'verification'))
import z3
import adapter_contract_c as C
import adapter_contract_sym as S

N, IX = 4, 4
TYPES = {'u8', 'u32', 'u64', 'unsigned', 'Account', 'BendClock', 'St', 'Ixn', 'Ctx', 'Res', 'BendInvoke'}


def meta(effects=False):
    return dict(accounts=12 if effects else 2, total=20 + N, n=N, ix=IX, rejected=1, effects=effects, slots=2,
                slot_type='BendInvoke', cpi=True, result={0: ['state', 'effects'] if effects else ['state'], 1: ['scalar']},
                key_maker='mk_key', slot_maker='mk_slot', context_maker='mk_ctx', state_decode='St_decode',
                ix_decode='Ixn_decode', root='root', state_encode='St_encode', custody='bend_invoke_custody',
                validate='bend_invoke_validate', execute='bend_invoke_execute', extract_slots=2, key_type='Key',
                slot_value_type='Slot', context_type='Ctx', state_type='St', ix_type='Ixn', result_type='Res')

PRE = '''u64 count = read_le(input, 8);
if (count != 2) return 1;
Account accounts[2];
const u8 *p = input + 8;
for (unsigned i = 0; i < count; ++i) { p = read_account(p,&accounts[i]); if (!p) return 6; }
Account state = accounts[0], actor = accounts[1];
u64 length = read_le(p, 8);
const u8 *ix = p + 8;
const u8 *program = ix + length;
'''
COMMIT = '''const u8 header[20] = {66,68,83,49};
__builtin_memcpy(state.data, header, 20);
return 0;
'''


EFFECT_PRE = '''u64 count = read_le(input, 8);
if (count < 4 || count > 12) return 1;
Account accounts[12];
const u8 *p = input + 8;
for (unsigned i = 0; i < count; ++i) { p = read_account(p,&accounts[i]); if (!p) return 6; }
Account state = accounts[0];
St before;
if (!St_decode(accounts[0].data + 20, 4, &before)) return 4;
Ixn instruction;
const u8 *ix = p + 8;
if (!Ixn_decode(ix + 1, 4, &instruction)) return 2;
Ctx context = mk_ctx(mk_key(0,0,0,0,0,0,0,0), 0, mk_slot(0,0));
Res outcome = root(context, before, instruction);
if (outcome.tag != 0) return 9;
'''


def execute(text, effects=False):
    parser = C.Parser(C.strict_tokens(text), TYPES)
    body = []
    while parser.peek():
        body.append(parser.statement())
    world = S.World(meta(effects))
    S.Exec(world).run(body)
    return world


class InterpreterRegression(unittest.TestCase):
    def assert_covered(self, world):
        solver = z3.Solver()
        solver.add(z3.Not(z3.Or([p.pc for p in world.paths])))
        self.assertEqual(solver.check(), z3.unsat, 'symbolic execution lost a feasible path')

    def assert_commit_visible(self, world):
        self.assert_covered(world)
        solver = z3.Solver()
        solver.add(z3.Or([p.pc for p in world.paths if any(e.kind == 'write' for e in p.events)]))
        self.assertEqual(solver.check(), z3.sat, 'reachable commit disappeared')
        violations = []
        for label, pre, formula in world.obligations:
            solver = z3.Solver()
            solver.add(pre, z3.Not(formula))
            if solver.check() == z3.sat:
                violations.append(label)
        self.assertTrue(any('state data write' in label for label in violations), violations)

    def test_unchecked_commit_control(self):
        self.assert_commit_visible(execute(PRE + COMMIT))

    def test_unevaluated_operand_never_erases_feasible_path(self):
        for fragment in (
            'u64 z; if (count != 2 && z) return 7;',
            'if (count != 2 && accounts[5].signer) return 7;',
            'u64 z; u64 y = count == 2 ? 1 : z;',
        ):
            with self.subTest(fragment=fragment):
                try:
                    world = execute(PRE + fragment + COMMIT)
                except C.Grammar:
                    continue  # Explicitly unsupported is a sound outcome.
                self.assert_commit_visible(world)

    def test_infeasible_loop_condition_preserves_other_exits(self):
        fragment = 'const u8 t[3] = {0}; for (unsigned k = 0; k < t[k] + count; ++k) {}'
        self.assert_commit_visible(execute(PRE + fragment + COMMIT))

    def test_post_write_read_observes_committed_bytes(self):
        fragment = PRE + 'if (state.size != 24) return 4;' + COMMIT.replace('return 0;', '')
        world = execute(fragment + 'if (state.data[0] != 66) return 4; return 0;')
        self.assert_covered(world)
        solver = z3.Solver()
        solver.add(z3.Or([z3.And(p.pc, p.ret != 0) for p in world.paths
                          if any(e.kind == 'write' for e in p.events)]))
        self.assertEqual(solver.check(), z3.unsat)

    def test_invalid_integer_suffix(self):
        with self.assertRaises(C.Grammar):
            C.literal('1uLl')
        self.assertEqual(C.literal('1uLL'), ('num', 1, 'u64'))

    def test_declaration_cannot_be_branch_or_loop_body(self):
        for text in ('if (1) u64 a = 1, b = 2;', 'for (unsigned k=0;k<2;++k) u64 a=1,b=2;'):
            with self.subTest(text=text), self.assertRaises(C.Grammar):
                C.Parser(C.strict_tokens(text), TYPES).statement()

    def test_extraction_does_not_initialize_undeclared_output_slots(self):
        text = '''u64 count = read_le(input, 8);
if (count < 4 || count > 12) return 1;
Account accounts[12];
const u8 *p = input + 8;
for (unsigned i = 0; i < count; ++i) { p = read_account(p,&accounts[i]); if (!p) return 6; }
St before;
if (!St_decode(accounts[0].data + 20, 4, &before)) return 4;
Ixn instruction;
const u8 *ix = p + 8;
if (!Ixn_decode(ix + 1, 4, &instruction)) return 2;
Ctx context = mk_ctx(mk_key(0,0,0,0,0,0,0,0), 0, mk_slot(0,0));
Res outcome = root(context, before, instruction);
if (outcome.tag != 0) return 9;
BendInvoke transfers[5];
if (!bend_extract_effects(&outcome.as.c0.f1,transfers)) return 9;
if (transfers[4].active) return 22;
u64 error = bend_invoke_validate(&transfers[4],accounts,(unsigned)count);
return error;
'''
        for fragment in (text, text.replace('if (transfers[4].active) return 22;', '')):
            with self.subTest(fragment=fragment), self.assertRaisesRegex(S.Semantic, 'uninitialized'):
                execute(fragment, effects=True)

    def test_failed_clock_output_is_not_initialized(self):
        for guarded in (False, True):
            text = 'BendClock clock; u64 rc = sol_get_clock_sysvar(&clock);'
            if guarded:
                text += 'if (rc) return rc;'
            world = execute(text + 'return clock.slot;')
            self.assert_covered(world)
            constraints = [z3.And(pre, z3.Not(formula))
                           for label, pre, formula in world.obligations
                           if label.startswith('uninitialized:')]
            self.assertTrue(constraints, 'helper output has no definedness check')
            solver = z3.Solver()
            solver.add(z3.Or(constraints))
            self.assertEqual(solver.check(), z3.unsat if guarded else z3.sat)

    def test_adapter_include_search_form_is_pinned(self):
        text = '#include "x.wire.h"\n#include "solana_min.h"\n' + C.CLOCK + 'return 0;}'
        C.parse_adapter(text, 'x.wire.h', None, TYPES)
        for name in ('x.wire.h', 'solana_min.h'):
            with self.subTest(name=name), self.assertRaisesRegex(C.Grammar, 'includes'):
                C.parse_adapter(text.replace('"' + name + '"', '<' + name + '>'),
                                'x.wire.h', None, TYPES)

    def test_failed_encode_cannot_initialize_tail_bytes(self):
        text = EFFECT_PRE + (
            'u8 buf[8]; St_encode(buf, 8, &outcome.as.c0.f0); '
            'if (!St_encode(buf, 4, &outcome.as.c0.f0)) return 9; return buf[6];')
        with self.assertRaisesRegex(S.Semantic, 'uninitialized'):
            execute(text, effects=True)

    def test_repeated_encode_is_explicitly_unsupported(self):
        text = EFFECT_PRE + (
            'u8 buf[4]; if (!St_encode(buf, 4, &outcome.as.c0.f0)) return 9; '
            'if (!St_encode(buf, 4, &outcome.as.c0.f0)) return 9; return buf[0];')
        with self.assertRaisesRegex(C.Grammar, 'repeated buffer writes'):
            execute(text, effects=True)

    def test_failed_helper_outputs_require_success(self):
        examples = [
            ('bump', EFFECT_PRE +
             'u8 bump; u64 rc = bend_invoke_custody(accounts,ix + read_le(p,8),&bump); return bump;', True),
            ('encode', EFFECT_PRE +
             'u8 buf[4]; St_encode(buf,4,&outcome.as.c0.f0); return buf[0];', True),
            ('decode', PRE +
             'St before; St_decode(state.data + 20,4,&before); Ixn ins; '
             'if (!Ixn_decode(ix+1,4,&ins)) return 2; '
             'Res out = root(mk_ctx(mk_key(0,0,0,0,0,0,0,0),0,mk_slot(0,0)),before,ins); return 0;', False),
        ]
        for name, text, effects in examples:
            with self.subTest(name=name):
                world = execute(text, effects)
                self.assert_covered(world)
                solver = z3.Solver()
                solver.add(z3.Or([z3.And(pre, z3.Not(f)) for label, pre, f in world.obligations
                                  if label.startswith('uninitialized:')]))
                self.assertEqual(solver.check(), z3.sat)

    def test_overlapping_writes_and_subsequent_decode(self):
        text = PRE + (
            'if (state.size != 24) return 4; '
            'const u8 a[4]={1,2,3,4}; const u8 b[2]={9,9}; '
            '__builtin_memcpy(state.data+20,a,4); __builtin_memcpy(state.data+21,b,2); '
            'if (state.data[20]!=1 || state.data[21]!=9 || state.data[22]!=9 || state.data[23]!=4) return 8; '
            'St decoded; St_decode(state.data+20,4,&decoded); return 0;')
        world = execute(text)
        self.assert_covered(world)
        solver = z3.Solver()
        solver.add(z3.Or([z3.And(p.pc, p.ret == 8) for p in world.paths]))
        self.assertEqual(solver.check(), z3.unsat)
        reads = [event for p in world.paths for event in p.events if event.kind == 'decode']
        self.assertTrue(reads)
        for event in reads:
            self.assertEqual([z3.simplify(b).as_long() for b in event.data], [1,9,9,4])


if __name__ == '__main__':
    unittest.main()
