"""Conditional CPI validator/executor bounds and a mathematical loop obligation.

The validator relation is produced by the existing restricted parser and
symbolic executor in cpi_validate.py. The live runtime executor uses an exact,
fail-closed token grammar. A separate mathematical lemma derives the safe
integer loop-index range from active validator success; it does not audit the
compiler template or establish a generated-adapter claim.
"""
from __future__ import annotations

import hashlib
import json
import pathlib
import re

import cpi_validate as cpi
from adapter_contract_c import Grammar, audited_header_tokens, has_file_scope_tokens, header_directives, header_tokens, need, strict_tokens, unique_file_scope_name

z3 = cpi.z3
ROOT = pathlib.Path(__file__).resolve().parent.parent
RUNTIME_FILES = ('bend_cpi.h', 'cpi_abi.h', 'solana_min.h')
EXEC_SIGNATURE = ('static __attribute__((noinline)) u64 bend_invoke_execute('
                  'const BendInvoke *t, Account *a, unsigned count, u8 bump)')
SYSCALL_DECL = ('extern u64 sol_invoke_signed_c(const BendInstruction *, '
                'const BendAccountInfo *, int, const BendSeeds *, int);')

# This token skeleton is the accepted executor grammar, copied from the live
# helper. It covers its complete body, so new reads, writes, branches, loops,
# calls, or array expressions cannot silently escape the audit. Whitespace and
# comments are erased by strict_tokens. The inactive guard has one equivalent
# spelling below. Safety facts are then discharged against the parsed
# validator relation and count domain, rather than inferred from this string.
EXECUTOR_BODY = r'''{
  if(!t->active) return 0;
  BendAccountInfo infos[12];
  for(unsigned i=0;i<count;++i) infos[i]=(BendAccountInfo){a[i].key,a[i].lamports,a[i].size,a[i].data,a[i].owner,a[i].rent_epoch,a[i].signer!=0,a[i].writable!=0,a[i].executable!=0};
  BendAccountMeta metas[8]; unsigned custody=0;
  for(unsigned i=0;i<t->count;++i) {
    const BendInvokeMeta *m=&t->metas[i];metas[i]=(BendAccountMeta){a[m->index].key,m->writable!=0,m->signer!=0};
    if(m->index==3 && m->signer) custody=1;
  }
  BendInstruction ix={a[t->program].key,metas,t->count,(u8 *)t->data,t->length};
  const u8 prefix[4]={'b','e','n','d'}; BendSeed seeds[3]={{prefix,4},{a[0].key,32},{&bump,1}}; BendSeeds signer={seeds,3};
  u64 error=sol_invoke_signed_c(&ix,infos,(int)count,&signer,(int)custody);
  if(error) return error;
  /* CPI can resize external accounts. Keep later calls' account-info lengths
   * synchronized with the syscall's updated C account-info records. */
  for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;
  return 0;
}'''
INACTIVE_GUARD = strict_tokens('if(!t->active) return 0;')
INACTIVE_GUARD_EQUIV = strict_tokens('if(t->active==0u) return 0u;')

def sha(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def c_tokens(text, label):
    """Tokenize the narrow runtime C stream, including its character literals."""
    scanner = re.compile(cpi.TOKEN.pattern + r"|'[^'\n]*'")
    words, at = [], 0
    while at < len(text):
        match = scanner.match(text, at)
        need(match is not None, f'{label}: unsupported source token')
        word = match.group()
        if not (word[0] in ' \t\n' or word.startswith(('/*', '//'))):
            words.append(word)
        at = match.end()
    return words


def load_runtime():
    contents = {name: (ROOT / 'runtime' / name).read_bytes() for name in RUNTIME_FILES}
    return {name: data.decode('utf8') for name, data in contents.items()}, contents


def live_function_body(source, signature, label):
    """Find one tokenized, live file-scope function definition and its body."""
    scanner = re.compile(cpi.TOKEN.pattern + r"|'[^'\n]*'")
    scanned, at = [], 0
    while at < len(source):
        match = scanner.match(source, at)
        need(match is not None, f'{label}: unsupported source token')
        word = match.group()
        if not (word[0] in ' \t\n' or word.startswith(('/*', '//'))):
            scanned.append((word, match.start(), match.end()))
        at = match.end()
    words = [item[0] for item in scanned]
    wanted = strict_tokens(signature)
    starts = [i for i in range(len(words)) if words[i:i + len(wanted)] == wanted]
    need(len(starts) == 1, f'{label}: unique live signature required')
    opening = starts[0] + len(wanted)
    need(opening < len(scanned) and words[opening] == '{', f'{label}: body definition required')
    depth, closing = 0, None
    for i in range(opening, len(words)):
        if words[i] == '{':
            depth += 1
        elif words[i] == '}':
            depth -= 1
            if depth == 0:
                closing = i
                break
    need(closing is not None, f'{label}: unterminated body')
    # Reuse the exact scanner tokens so multi-character C operators such as ==
    # are not split by the looser dependency-header token collector.
    body = [item[0] for item in scanned[opening:closing + 1]]
    need(body and body[0] == '{' and body[-1] == '}', f'{label}: malformed body')
    return body


def header_bundle(files):
    """Reuse the validator dependency checks and extend its unique binding audit."""
    cpi.helper(files)
    expected = {'bend_cpi.h': ['cpi_abi.h'], 'cpi_abi.h': ['solana_min.h'], 'solana_min.h': []}
    headers = {}
    for name, children in expected.items():
        macros, actual_children = header_directives(name, files[name])
        need(not macros and actual_children == children,
             f'dependencies: unexpected or macro-widened closure in {name}')
        headers[name] = audited_header_tokens(name, files[name])
    unique_file_scope_name(list(headers.values()), 'bend_invoke_execute')
    unique_file_scope_name(list(headers.values()), 'sol_invoke_signed_c')
    need(has_file_scope_tokens(headers['bend_cpi.h'], strict_tokens(EXEC_SIGNATURE + ' {')),
         'executor: reviewed live definition signature')
    need(has_file_scope_tokens(headers['cpi_abi.h'], strict_tokens(SYSCALL_DECL)),
         'dependencies: reviewed CPI syscall declaration')
    return headers


def audit_executor(files):
    headers = header_bundle(files)
    actual = live_function_body(files['bend_cpi.h'], EXEC_SIGNATURE, 'executor')
    canonical = c_tokens(EXECUTOR_BODY, 'executor grammar')
    need(canonical[0] == '{' and canonical[1:1 + len(INACTIVE_GUARD)] == INACTIVE_GUARD,
         'internal: executor skeleton guard mismatch')
    need(actual and actual[0] == '{', 'executor grammar: body block required')
    actual_tail = actual[1:]
    suffix = canonical[1 + len(INACTIVE_GUARD):]
    if actual_tail[:len(INACTIVE_GUARD)] == INACTIVE_GUARD:
        guard = 'if(!t->active)'
        normalized = actual
    elif actual_tail[:len(INACTIVE_GUARD_EQUIV)] == INACTIVE_GUARD_EQUIV:
        guard = 'if(t->active==0u)'
        normalized = ['{'] + INACTIVE_GUARD + actual_tail[len(INACTIVE_GUARD_EQUIV):]
    else:
        raise Grammar('executor grammar: inactive execution guard differs')
    need(normalized == ['{'] + INACTIVE_GUARD + suffix,
         'executor grammar: unsupported access/control/syscall skeleton')
    need(actual.count('sol_invoke_signed_c') == 1,
         'executor grammar: syscall binding/call count differs')
    call_at = actual.index('sol_invoke_signed_c')
    need(actual[call_at + 1] == '(', 'executor grammar: syscall call shape differs')
    depth, commas, has_argument = 0, 0, False
    for token in actual[call_at + 1:]:
        if token == '(':
            depth += 1
            if depth == 1:
                continue
        elif token == ')':
            depth -= 1
            if depth == 0:
                break
        elif depth == 1 and token == ',':
            commas += 1
        elif depth == 1:
            has_argument = True
    need(depth == 0 and has_argument and commas == 4,
         'executor grammar: syscall must have exactly five arguments')
    return {
        'result': 'accepted restricted live-body grammar',
        'acceptedGrammar': 'The complete live body token stream must equal the reviewed bend_invoke_execute skeleton after comments/whitespace are erased; only the two listed inactive guards are accepted. Any new statement, access, loop, branch, call, cast, or array extent rejects.',
        'inactiveGuard': guard,
        'localCapacities': {'infos': 12, 'metas': 8},
        'accountCountLoops': 2,
        'metaCountLoops': 1,
        'syscall': {'binding': 'sol_invoke_signed_c', 'argumentCount': 5,
                    'accountInfoCountArgument': '(int)count',
                    'instructionMetaCount': 't->count', 'seedCount': 3,
                    'custodySignerArgument': '(int)custody'},
        'reviewedAccessShape': {
            'expressions': ['infos[i] and a[i] under i<count',
                            't->metas[i] and metas[i] under i<t->count',
                            'a[m->index] under successful active validation',
                            'a[t->program] under successful active validation',
                            'a[0] and a[3] under the caller account-count precondition',
                            'a[i] and infos[i] during post-syscall size sync under i<count'],
            'status': 'descriptive expressions for the exact token-audited body; not standalone semantic claims',
        },
        'allowedLocalRefresh': 'After a successful syscall, the exact body copies infos[i].data_len into local a[i].size for i<count. This adapter-local descriptor refresh is allowed; no general noninterference or caller-state theorem is claimed.',
        'dependencyBindings': ['unique executor definition', 'unique syscall declaration',
                               'unique syscall call', 'no dependency macros'],
    }


def validator_relation(files):
    body = cpi.helper(files)
    model = cpi.Model()
    interpreter = cpi.Execute(model)
    actual, fallthrough = interpreter.run(body)
    existing = {
        'validator guarded reads and loop termination': z3.And(
            *[expr for _, expr in interpreter.reads], *interpreter.loops),
        'validator exact parsed return relation': actual == model.contract(),
        'validator parsed return coverage': z3.And(
            z3.Not(fallthrough), z3.PbEq([(guard, 1) for guard, _ in interpreter.returns], 1)),
    }
    return model, interpreter, actual, existing


def prove_conditional_validator_facts(model, actual):
    f = model.fields
    active_success = z3.And(f['active'] != cpi.bv(0), actual == cpi.bv(0, 64))
    success_facts = {
        'active success bounds instruction length to 64': z3.ULE(f['length'], cpi.bv(64)),
        'active success bounds meta count to 8': z3.ULE(f['meta_count'], cpi.bv(8)),
        'active success bounds program index below account count': z3.ULT(f['program'], model.count),
        'active success excludes reserved program/account indices': z3.UGE(f['program'], cpi.bv(2)),
        'active success validates executable program account': model.at('executable', f['program']) != 0,
        'active success binds target program key': model.at('account_key', f['program']) == model.program_key,
    }
    for i in range(8):
        index = model.at('meta_index', i)
        writable = model.at('meta_writable', i)
        signer = model.at('meta_signer', i)
        guard = z3.ULT(cpi.bv(i), f['meta_count'])
        success_facts[f'active meta {i} index is below account count'] = z3.Implies(
            guard, z3.ULT(index, model.count))
        success_facts[f'active meta {i} writable flag is normalized'] = z3.Implies(
            guard, z3.ULE(writable, cpi.bv(1)))
        success_facts[f'active meta {i} signer flag is normalized'] = z3.Implies(
            guard, z3.ULE(signer, cpi.bv(1)))
    results = []
    for name, fact in success_facts.items():
        cpi.solve(model, z3.And(active_success, z3.Not(fact)), 'unsat')
        results.append({'name': name, 'result': 'unsat'})

    # These live-validator implications supply data bounds used by the exact
    # executor body skeleton, conditional on the host adapter passing the same
    # effect, account array, and count through both helper calls.
    executor_facts = {
        'active validator success provides bounded executor arrays':
            z3.And(z3.ULE(f['meta_count'], cpi.bv(8)), z3.ULE(f['length'], cpi.bv(64))),
        'active validator success bounds every scanned meta index': z3.And(*[
            z3.Implies(z3.ULT(cpi.bv(i), f['meta_count']),
                       z3.ULT(model.at('meta_index', i), model.count)) for i in range(8)]),
    }
    for name, fact in executor_facts.items():
        cpi.solve(model, z3.And(active_success, z3.Not(fact)), 'unsat')
        results.append({'name': name, 'result': 'unsat'})

    # The inactive arm intentionally returns success before validating any
    # effect lengths/counts. This SAT witness prevents overclaiming.
    inactive = cpi.solve(model, z3.And(f['active'] == cpi.bv(0), actual == cpi.bv(0, 64),
        model.count == cpi.bv(4), f['length'] == cpi.bv(65), f['meta_count'] == cpi.bv(9)), 'sat')
    # Active successes at both ends of the account-count range and a fully
    # populated 8-meta/64-byte request are explicit nonvacuity witnesses.
    witnesses = []
    for count in (4, 12):
        witness = cpi.solve(model, z3.And(active_success, model.count == cpi.bv(count),
            f['length'] == cpi.bv(0), f['meta_count'] == cpi.bv(0)), 'sat')
        witnesses.append({'name': f'active success at account_count={count}', **witness})
    full = cpi.solve(model, z3.And(active_success, model.count == cpi.bv(12),
        f['length'] == cpi.bv(64), f['meta_count'] == cpi.bv(8)), 'sat')
    witnesses.append({'name': 'active success at length=64 and meta_count=8', **full})
    witnesses.append({'name': 'inactive success does not imply count or length bounds',
        'return': 0, 'account_count': inactive['account_count'], 'active': inactive['active'],
        'length': inactive['length'], 'meta_count': inactive['meta_count'],
        'counterexample': inactive['smtModel']})
    return active_success, results, witnesses


def prove_mathematical_adapter_loop(model):
    """Prove a natural-number loop bound, without inspecting emitted adapter C."""
    count = z3.Int('mathematical_adapter_meta_count')
    index = z3.Int('mathematical_adapter_loop_index')
    # This is a standalone integer lemma. The separate live-validator fact
    # establishes meta_count <= 8 on active success; the host adapter must bind
    # this mathematical count to that same validated effect.
    violation = z3.And(count >= 0, count <= 8, index >= 0, index < count, index >= 8)
    cpi.solve(model, violation, 'unsat')
    return {
        'result': 'unsat',
        'premise': '0 <= meta_count <= 8; active success of the actual parsed validator establishes the upper bound, provided the host binds this mathematical count to that same effect',
        'validatorImplication': 'active success bounds meta count to 8',
        'obligation': 'for every mathematical integer index j, if 0 <= j < meta_count then j < 8',
        'scope': 'conditional mathematical adapter-loop capacity obligation only; no compiler-template, generated-C, loop-presence, or emitted-adapter claim',
    }


def mutation_witness(model, actual, constraints):
    return cpi.solve(model, z3.And(model.fields['active'] != cpi.bv(0), actual == cpi.bv(0, 64),
        *constraints), 'sat')


def validator_mutations(files):
    mutations = []
    cases = [
        ('remove length check', 't->length>64 || ', '', 'active success bounds instruction length to 64'),
        ('remove count check', ' || t->count>8', '', 'validator guarded reads and loop termination'),
        ('remove meta index check', 'm->index>=count || ', '', 'validator guarded reads and loop termination'),
        ('remove program index check', 't->program>=count || ', '', 'validator guarded reads and loop termination'),
        ('remove normalized writable flag check', 'm->writable>1', 'm->writable>2', 'active meta 0 writable flag is normalized'),
    ]
    for name, old, new, expected_claim in cases:
        changed = {**files, 'bend_cpi.h': cpi.change_validator(files['bend_cpi.h'], old, new)}
        model, interpreter, actual, existing = validator_relation(changed)
        composition = prove_composition_for_mutation(model, actual)
        all_claims = {**existing, **composition}
        # Ask for the mutation's expected semantic failure directly. A SAT
        # model for some unrelated failed claim would be weaker evidence.
        failed = cpi.solve(model, z3.Not(all_claims[expected_claim]), 'sat', all_claims)
        need(expected_claim in failed['violated'], f'{name}: expected semantic claim failure')
        mutations.append({'name': name, 'kind': 'semantic', 'sha256': sha(changed['bend_cpi.h']),
            'violated': failed['violated'], 'counterexample': failed})
    return mutations


def prove_composition_for_mutation(model, actual):
    """Small, side-effect-free subset for diagnosing a faulty parsed helper."""
    f = model.fields
    props = {
        'active success bounds instruction length to 64': z3.ULE(f['length'], cpi.bv(64)),
        'active success bounds meta count to 8': z3.ULE(f['meta_count'], cpi.bv(8)),
    }
    for i in range(8):
        guard = z3.ULT(cpi.bv(i), f['meta_count'])
        props[f'active meta {i} index is below account count'] = z3.Implies(
            guard, z3.ULT(model.at('meta_index', i), model.count))
        props[f'active meta {i} writable flag is normalized'] = z3.Implies(
            guard, z3.ULE(model.at('meta_writable', i), cpi.bv(1)))
    # Keep every composition property conditional on an actual active success;
    # otherwise the early inactive return would create false counterexamples.
    success = z3.And(f['active'] != cpi.bv(0), actual == cpi.bv(0, 64))
    return {name: z3.Implies(success, prop) for name, prop in props.items()}


def replace_once(text, old, new):
    need(text.count(old) == 1, 'mutation target is not unique: ' + old)
    return text.replace(old, new)


def replace_executor_once(source, old, new):
    start = source.find(EXEC_SIGNATURE)
    need(start >= 0, 'executor mutation: live signature missing')
    return source[:start] + replace_once(source[start:], old, new)


def executor_mutations(files, model, actual):
    cases = [
        ('infos loop includes count endpoint', 'for(unsigned i=0;i<count;++i) infos[i]',
         'for(unsigned i=0;i<=count;++i) infos[i]', {'scenario': 'infos-endpoint', 'account_count': 12, 'index': 12, 'capacity': 12}),
        ('meta loop includes count endpoint', 'for(unsigned i=0;i<t->count;++i)',
         'for(unsigned i=0;i<=t->count;++i)', {'scenario': 'meta-endpoint', 'account_count': 12, 'meta_count': 8, 'index': 8, 'capacity': 8}),
        ('program account index incremented', 'a[t->program].key', 'a[t->program+1].key',
         {'scenario': 'program-endpoint', 'account_count': 12, 'index': 12, 'capacity': 12}),
        ('validated meta account index incremented', 'a[m->index].key', 'a[m->index+1].key',
         {'scenario': 'meta-index-endpoint', 'account_count': 12, 'meta_count': 1, 'meta_index': 'account_count-1'}),
        ('local infos capacity reduced', 'BendAccountInfo infos[12]', 'BendAccountInfo infos[11]',
         {'scenario': 'reduced-capacity', 'account_count': 12, 'index': 11, 'capacity': 11}),
        ('post-CPI sync loop includes count endpoint', 'for(unsigned i=0;i<count;++i) a[i].size',
         'for(unsigned i=0;i<=count;++i) a[i].size', {'scenario': 'sync-endpoint', 'account_count': 12, 'index': 12, 'capacity': 12}),
        ('syscall data pointer shifted', '(u8 *)t->data,t->length', '(u8 *)(t->data+1),t->length',
         {'scenario': 'data-endpoint', 'length': 64, 'offset': 1, 'capacity': 64}),
        ('inactive execution guard omitted', 'if(!t->active) return 0;', '',
         {'scenario': 'inactive-scan', 'inactive_meta_count': 9, 'index': 8, 'capacity': 8}),
    ]
    results = []
    for name, old, new, witness_shape in cases:
        changed = {**files, 'bend_cpi.h': replace_executor_once(files['bend_cpi.h'], old, new)}
        try:
            audit_executor(changed)
        except Grammar as error:
            reason = str(error)
        else:
            raise AssertionError('unsafe executor C mutation accepted: ' + name)
        # Attach a model witness from the unmutated, actual parsed validator:
        # the changed source expression has the stated out-of-range access.
        f = model.fields
        scenario = witness_shape['scenario']
        if scenario == 'inactive-scan':
            required = [f['active'] == cpi.bv(0), f['meta_count'] == cpi.bv(9),
                        model.count == cpi.bv(4)]
            witness = cpi.solve(model, z3.And(actual == cpi.bv(0, 64), *required), 'sat')
        else:
            required = [f['length'] == cpi.bv(witness_shape.get('length', 0)),
                        f['meta_count'] == cpi.bv(witness_shape.get('meta_count', 0)),
                        model.count == cpi.bv(witness_shape.get('account_count', 4))]
            if scenario == 'program-endpoint':
                required.append(f['program'] == model.count - cpi.bv(1))
            elif scenario == 'meta-index-endpoint':
                required.append(model.at('meta_index', 0) == model.count - cpi.bv(1))
            witness = mutation_witness(model, actual, required)
        results.append({'name': name, 'kind': 'grammar', 'reason': reason,
            'sourceSha256': sha(changed['bend_cpi.h']),
            'boundaryExample': {'kind': 'input-or-capacity-boundary-example',
                'validatedState': witness,
                'illustrativeAccess': witness_shape,
                'isExecutionOfMutatedC': False,
                'explanation': 'A satisfying boundary value from the unmutated validator relation is shown for context. The changed executor was rejected by the live-body token grammar; this witness is not an execution, semantic counterexample, or proof about the changed C.'}})
    return results


def equivalents(files):
    results = []
    # Semantic equivalent validator rewrites are parsed from changed C and
    # proved against the actual return paths, not compared as text.
    rewritten = files['bend_cpi.h']
    for old, new in [
        ('t->length>64', 't->length>=65'),
        ('m->index>=count', '!(m->index<count)'),
        ('if(!t->active) return 0;', 'if(t->active==0u) { return 0u; }'),
    ]:
        rewritten = cpi.change_validator(rewritten, old, new)
        variant = {**files, 'bend_cpi.h': rewritten}
        model, _, actual, claims = validator_relation(variant)
        comp = prove_composition_for_mutation(model, actual)
        for proposition in [*claims.values(), *comp.values()]:
            cpi.solve(model, z3.Not(proposition), 'unsat')
    results.append({'name': 'three equivalent validator rewrites', 'result': 'unsat',
                    'rewrites': ['length > 64 to >= 65', 'index >= count to !(index < count)',
                                 'inactive return uses == 0u and braces'],
                    'sha256': sha(rewritten)})
    # The live executor body accepts comments/whitespace plus a semantically
    # equivalent inactive guard spelling. This variant is actually audited.
    exec_variant = replace_executor_once(files['bend_cpi.h'], 'if(!t->active) return 0;',
        'if ( t->active == 0u ) return 0u; /* inactive path */')
    audit_executor({**files, 'bend_cpi.h': exec_variant})
    results.append({'name': 'executor inactive guard equivalent with comment/spacing',
                    'result': 'accepted', 'sha256': sha(exec_variant)})
    return results


def input_hashes():
    paths = [ROOT / 'runtime' / n for n in RUNTIME_FILES]
    paths += [ROOT / 'verification/cpi_validate.py',
              ROOT / 'verification/adapter_contract_c.py', ROOT / 'verification/cpi_composition.py',
              ROOT / 'verification/check-cpi-composition.ts']
    return {str(path.relative_to(ROOT)): sha(path.read_bytes()) for path in paths}


def reviewed_header_hashes(hashes):
    """Expose the exact live helper headers and dependency closure explicitly."""
    return {
        'validator': {'path': 'runtime/bend_cpi.h', 'sha256': hashes['runtime/bend_cpi.h']},
        'executor': {'path': 'runtime/bend_cpi.h', 'sha256': hashes['runtime/bend_cpi.h']},
        'dependencies': {
            name: {'path': f'runtime/{name}', 'sha256': hashes[f'runtime/{name}']}
            for name in ('cpi_abi.h', 'solana_min.h')
        },
    }


def unknown_solver_probe(model):
    """Exercise the imported solve helper's fail-closed unknown branch."""
    original = z3.Solver

    class UnknownSolver:
        def set(self, **_kwargs):
            pass

        def add(self, *_expressions):
            pass

        def check(self):
            return z3.unknown

        def reason_unknown(self):
            return 'injected timeout/unknown probe'

    z3.Solver = UnknownSolver
    try:
        try:
            cpi.solve(model, z3.BoolVal(True), 'unsat')
        except RuntimeError as error:
            need('Z3 unknown:' in str(error), 'unknown solver result rejected for the wrong reason')
            return {'forcedUnknownRejected': True, 'reason': str(error),
                    'solverTimeoutMs': 30000, 'hostChildTimeoutMs': 180000}
        raise AssertionError('Z3 unknown solver result was accepted')
    finally:
        z3.Solver = original


def main():
    output = ROOT / 'build/cpi-composition-refinement.json'
    pending = output.with_suffix(output.suffix + '.pending')
    output.parent.mkdir(exist_ok=True)
    output.unlink(missing_ok=True)
    pending.unlink(missing_ok=True)
    need(z3.get_version_string() == '5.1.0', 'Expected Z3 5.1.0')

    hashes = input_hashes()
    files, recorded = load_runtime()
    model, interpreter, actual, validator_claims = validator_relation(files)
    solver_failure = unknown_solver_probe(model)
    for name, claim in validator_claims.items():
        cpi.solve(model, z3.Not(claim), 'unsat')
    executor_report = audit_executor(files)
    _, conditional_facts, witnesses = prove_conditional_validator_facts(model, actual)
    adapter_loop = prove_mathematical_adapter_loop(model)

    semantic = validator_mutations(files)
    c_exec = executor_mutations(files, model, actual)
    eq = equivalents(files)
    for rel, digest in hashes.items():
        need(sha((ROOT / rel).read_bytes()) == digest, 'input changed while checking: ' + rel)
    for name, data in recorded.items():
        need(sha((ROOT / 'runtime' / name).read_bytes()) == sha(data),
             'runtime input changed while checking: ' + name)

    report = {
        'passed': True,
        'z3': z3.get_version_string(),
        'solverFailureBehavior': solver_failure,
        'inputHashes': hashes,
        'runtimeHeaderHashes': reviewed_header_hashes(hashes),
        'inputPreconditions': {
            'accountCount': {
                'min': 4, 'max': 12,
                'status': 'caller-supplied input assumption added by cpi_validate.Model.pre to every SMT query; not derived by the validator',
            },
            'accountArray': 'Caller supplies at least account_count readable, aligned Account objects with the reviewed native layouts and valid pointed-to bytes.',
        },
        'validatorClaims': [{'name': name, 'result': 'unsat'} for name in validator_claims],
        'conditionalValidatorFacts': conditional_facts,
        'mathematicalAdapterLoopObligation': adapter_loop,
        'compositionStatus': {
            'result': 'conditional component obligations; emitted-adapter composition is not established',
            'hostAdapterMustEstablish': [
                'Pass the same effect object, Account array, and input account_count to validation, any managed-state preflight, and execution; preserve relevant effect fields between validation and execution.',
                'Call execution only after the active-effect validation return is zero, and apply that success fact to the same effect object whose count is used by any meta loop.',
                'Establish account_count in 4..12 before accesses to fixed accounts 0 and 3; this gate assumes that input domain and does not inspect the emitted adapter that supplies it.',
                'Pass the intended custody-derived bump to execution; the executor audit checks the live helper body but does not derive or bind the host-supplied bump.',
                'If the emitted adapter has a meta loop, establish that it iterates the validated count for the same effect. The separate mathematical obligation proves only that a natural index satisfying 0 <= j < meta_count is below 8 when active validation succeeds; it does not establish that emitted C contains or follows such a loop.',
            ],
        },
        'validatorReadObligations': len(interpreter.reads),
        'validatorLoopObligations': len(interpreter.loops),
        'executorAudit': executor_report,
        'witnesses': witnesses,
        'mutations': {'validatorSemantic': semantic,
                      'executorCGrammar': c_exec},
        'equivalents': eq,
        'assumptions': [
            'Every SMT query includes the caller input precondition account_count in 4..12 and assumes readable, aligned Account objects with the declared ABI layouts; the validator does not derive this range.',
            'To apply the conditional validator/executor facts to a host adapter, that adapter must pass the same effect object, Account array and count to each relevant stage, call execution only after active validation success, and preserve relevant effect fields until execution. These bridge conditions are not checked here.',
            'The restricted parser/interpreter, this executor token grammar, the reviewed headers, Python and Z3 are trusted; this is not a verified C semantics.',
            'The CPI syscall declaration and runtime obey Solana ABI behavior; sol_invoke_signed_c does not corrupt unrelated stack objects or account metadata. The reviewed executor explicitly refreshes local a[i].size from infos[i].data_len after the call; no general aliasing, caller-state, or transaction rollback theorem is established.',
            'No source-root preservation, Bend extraction/source correspondence, compiler template, emitted-adapter behavior, SBF compilation, loader behavior, or transaction rollback is audited by this gate.',
            'No command-line or translation-unit macro/layout interference widens these exact include bindings.',
        ],
        'trustBoundary': {
            'inputPreconditions': 'Caller account_count is in 4..12 and Account objects, native layouts, alignment and readable pointed-to bytes match reviewed declarations; count is an input assumption, not a validator-derived fact.',
            'hostAdapterBridge': 'Identity of effect/array/count across stages, validate-before-execute ordering, active-success guarding, managed-loop binding, and custody bump derivation must be established by the emitted adapter or a separate gate.',
            'syscallAndRuntime': 'The declared Solana CPI ABI and runtime behavior are trusted. The exact reviewed executor refreshes local a[i].size from infos[i].data_len after syscall; no general aliasing, caller-state, or rollback property is claimed.',
            'compilerAndSBF': 'Compiler-template/generated-C correspondence, emitted-adapter behavior, compilation, loader behavior, stack limits and transaction rollback are outside the gate.',
            'sourceRootPreservation': 'Not claimed; Bend effect extraction and source-root correspondence are outside the gate.',
        },
        'unchecked': [
            'Custody PDA derivation, seeds correctness and external callee behavior.',
            'Syscall pointer validity, SBF stack/resource limits, loader behavior and atomic rollback.',
            'Generated adapter correspondence, validation/preflight/execution dataflow, managed account schema/index derivation, account-count argument binding, and custody bump binding.',
            'Other executor semantics such as business authorization, CPI effects, account alias policy, root/source preservation, and arbitrary executor rewrites.',
        ],
        'scope': 'Actual parsed bend_invoke_validate return paths and the exact live bend_invoke_execute token skeleton, under explicit caller input preconditions, plus a mathematical active-count<=8 loop-index obligation. No compiler-template or emitted-adapter claim.',
    }
    pending.write_text(json.dumps(report, indent=2) + '\n')
    pending.replace(output)
    print(f'CPI composition: {len(conditional_facts)} UNSAT facts, '
          f'{len(witnesses)} nonvacuity/inactive witnesses, '
          f'{len(semantic)} semantic validator mutations, {len(c_exec)} executor C grammar mutations, '
          f'{len(eq)} positive equivalents and 1 mathematical adapter-loop obligation; '
          f'{output.relative_to(ROOT)}')


if __name__ == '__main__':
    try:
        main()
    except (Grammar, AssertionError, RuntimeError) as error:
        raise SystemExit('CPI composition check failed: ' + str(error))
