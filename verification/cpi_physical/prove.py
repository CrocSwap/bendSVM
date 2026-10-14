"""Fresh conditional frame lemmas, precise descriptor refresh and controls.

This is a component gate, not the complete caller-to-commit qualification.
Runtime mutation permissions, valid allocation and truthful returned info/length
metadata remain named premises. Native/source controls bind the actual helper
separately. No unconditional C/SBF, transaction rollback or deployment proof.
"""
if not __debug__:
    raise RuntimeError('assertions required')
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, 'verification')
import z3 as z
from cpi_physical import frame as f
from cpi_physical.dag import SCHEME, fingerprint


def prove(folder):
    assert z.get_version_string() == '5.1.0'
    folder.mkdir(parents=True, exist_ok=False)
    rows = []
    serialization_queries = []
    cache = {}

    def query(name, premises, bad, wanted=z.unsat):
        formula = z.And(*premises, bad)
        signature = fingerprint(formula)
        if wanted == z.unsat and signature in cache:
            original, original_formula = cache[signature]
            assert z.eq(formula, original_formula), 'fingerprint cache AST mismatch'
            row = {'name': name, 'result': 'unsat', 'reuse': original['name'],
                   'sourceFormulaFingerprint': signature,
                   'formulaFingerprint': original['formulaFingerprint']}
        else:
            # Preserve the original assertion while exposing reads through
            # conditional arrays to the existing SMT solver. No added premise.
            solver = z.Then(z.With(z.Tactic('simplify'), expand_select_ite=True),
                            z.Tactic('smt')).solver()
            solver.set(timeout=30000)
            # One assertion retains the exact formula shape across SMT parsing.
            solver.add(formula)
            path = folder / (name + '.smt2')
            path.write_text(solver.sexpr() + '\n(check-sat)\n')
            serialized = z.parse_smt2_string(path.read_text(), ctx=formula.ctx)
            assert len(serialized) == 1
            if z.eq(formula, serialized[0]):
                bridge = 'exact-ast'
            else:
                if z.is_true(z.simplify(formula == serialized[0])):
                    bridge = 'simplifier-true'
                else:
                    equivalence = z.Solver()
                    equivalence.set(timeout=30000)
                    equivalence.add(formula != serialized[0])
                    bridge_path = folder / (name + '-serialization.smt2')
                    bridge_path.write_text(equivalence.sexpr() + '\n(check-sat)\n')
                    answer = equivalence.check()
                    if answer != z.unsat:
                        raise RuntimeError(('SMT serialization equivalence', name, str(answer), equivalence.reason_unknown()))
                    bridge_formula = z.parse_smt2_string(bridge_path.read_text())[0]
                    serialization_queries.append({'name': name + '-serialization', 'result': 'unsat',
                        'query': str(bridge_path), 'querySha256': hashlib.sha256(bridge_path.read_bytes()).hexdigest(),
                        'formulaFingerprint': fingerprint(bridge_formula)})
                    bridge = 'fresh-unsat'
            result = solver.check()
            if result != wanted:
                raise RuntimeError((name, str(result), solver.reason_unknown()))
            row = {'name': name, 'result': str(result), 'query': str(path),
                   'querySha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                   'sourceFormulaFingerprint': signature,
                   'formulaFingerprint': fingerprint(serialized[0]), 'serializationBridge': bridge}
            if result == z.sat:
                row['witness'] = str(solver.model())
            else:
                cache[signature] = (row, formula)
        rows.append(row)
        print(name, row['result'], flush=True)
        return row

    data, capacity, address, offset = z.BitVecs('data capacity address offset', 64)
    point, extent, other, other_extent = z.BitVecs('point extent other other_extent', 64)
    account = f.account_span(data, capacity)
    workspace = f.Span(point, extent)
    pending = f.Span(other, other_extent)
    permitted = f.account_permission(address, data, capacity)
    query('serialized-write-ranges-contained', [f.account_domain(data, capacity)],
          z.And(permitted, z.Not(f.inside(address, account))))
    query('own-key-excluded', [f.account_domain(data, capacity), z.ULT(offset, f.u64(32))],
          f.account_permission(data - f.u64(80) + offset, data, capacity))
    query('pending-excluded-from-account', [f.account_domain(data, capacity),
          f.bounded(pending, f.MAX_WORKSPACE), f.separated(pending, account),
          z.ULT(offset, pending.size)],
          f.account_permission(pending.start + offset, data, capacity))
    query('pending-excluded-from-workspace', [f.bounded(workspace, f.MAX_WORKSPACE),
          f.bounded(pending, f.MAX_WORKSPACE), f.separated(pending, workspace),
          z.ULT(offset, pending.size)], f.inside(pending.start + offset, workspace))

    memory = z.Array('before', z.BitVecSort(64), z.BitVecSort(8))
    returned = z.Array('returned', z.BitVecSort(64), z.BitVecSort(8))
    starts = [z.BitVec('start_' + str(i), 64) for i in range(12)]
    capacities = [z.BitVec('capacity_' + str(i), 64) for i in range(12)]
    capabilities = [z.Bool('writable_' + str(i)) for i in range(12)]
    enabled = z.Bool('enabled')
    post = f.runtime_step(memory, returned, starts, capacities, capabilities, [workspace], enabled)
    actual_permissions = [z.And(cap, f.account_permission(address, start, size))
                          for cap, start, size in zip(capabilities, starts, capacities)]
    actual_permissions.append(f.inside(address, workspace))
    exact_selection = z.If(z.And(enabled, z.Or(*actual_permissions)),
                           z.Select(returned, address), z.Select(memory, address))
    query('actual-runtime-frame-selection', [], z.Select(post, address) != exact_selection)
    query('excluded-permissions-preserve-byte', [z.Not(p) for p in actual_permissions],
          z.Select(post, address) != z.Select(memory, address))
    query('inactive-runtime-preservation', [z.Not(enabled)], post != memory)
    # A private workspace is intentionally writable, including when no
    # serialized account has a writable capability.
    query('private-workspace-write-witness', [enabled, *[z.Not(p) for p in capabilities],
          point == f.u64(1 << 33), extent == f.u64(4096), address == point],
          z.Select(post, address) != z.Select(memory, address), z.sat)

    descriptor, info, status, count = z.BitVecs('descriptor info status count', 64)
    refreshed, lengths = f.refresh_descriptors(memory, descriptor, info, enabled, status, count)
    for i in range(12):
        at = descriptor + f.u64(f.ACCOUNT_STRIDE * i + f.ACCOUNT_SIZE_OFFSET)
        expected = z.If(z.And(enabled, status == 0, z.ULT(f.u64(i), count)),
                        lengths[i], f.read_u64(memory, at))
        query('exact-size-refresh-' + str(i), [], f.read_u64(refreshed, at) != expected)
    query('failed-helper-does-not-refresh', [status != 0], refreshed != memory)
    query('inactive-helper-does-not-refresh', [z.Not(enabled)], refreshed != memory)
    # All 56 non-size bytes per descriptor, including padding and pointers.
    descriptor_byte = descriptor + f.u64(f.ACCOUNT_STRIDE) * point + offset
    write_index, write_byte = z.BitVecs('descriptor_write_index descriptor_write_byte', 64)
    byte = z.BitVec('descriptor_write_value', 8)
    nonsize_domain = [z.ULT(point, f.u64(12)),
          z.ULT(offset, f.u64(f.ACCOUNT_STRIDE)),
          z.Or(z.ULT(offset, f.u64(f.ACCOUNT_SIZE_OFFSET)),
               z.UGE(offset, f.u64(f.ACCOUNT_SIZE_OFFSET + 8))),
          z.ULT(write_index, f.u64(12)), z.ULT(write_byte, f.u64(8))]
    write_address = descriptor + f.u64(64) * write_index + f.u64(24) + write_byte
    nonsize_claim = z.Select(z.Store(memory, write_address, byte), descriptor_byte) == z.Select(memory, descriptor_byte)
    query('descriptor-nonsize-bytes-preserved', nonsize_domain, z.Not(nonsize_claim))
    write_offset = z.BitVec('descriptor_write_offset', 64)
    descriptor_domain = [z.Not(f.inside(address,
          f.Span(descriptor, f.u64(f.ACCOUNT_STRIDE * 12)))),
          f.bounded(f.Span(descriptor, f.u64(f.ACCOUNT_STRIDE * 12)), f.MAX_WORKSPACE),
          z.ULT(write_offset, f.u64(f.ACCOUNT_STRIDE * 12))]
    store = z.Store(memory, descriptor + write_offset, byte)
    store_claim = z.Select(store, address) == z.Select(memory, address)
    query('outside-descriptor-single-store-preservation', descriptor_domain, z.Not(store_claim))
    other_memory = z.Array('other_memory', z.BitVecSort(64), z.BitVecSort(8))
    query('conditional-array-preservation',
          [z.Select(memory, address) == z.Select(other_memory, address)],
          z.Select(z.If(enabled, memory, other_memory), address) != z.Select(memory, address))
    # Finite induction over every Store in the actual refresh AST. No large
    # solver query is replaced by an unproved whole-array equality.
    stores, seen, stack = [], set(), [refreshed]
    while stack:
        node = stack.pop()
        if node.get_id() in seen:
            continue
        seen.add(node.get_id())
        if z.is_app(node) and node.decl().kind() == z.Z3_OP_STORE:
            stores.append(node)
            stack.append(node.arg(0))
        elif z.is_app(node) and node.decl().kind() == z.Z3_OP_ITE:
            stack.extend([node.arg(1), node.arg(2)])
        else:
            assert z.eq(node, memory), 'unexpected descriptor memory operation'
    assert len(stores) == 12 * 8
    store_instances = []
    offsets = set()
    for actual in stores:
        delta = z.simplify(actual.arg(1) - descriptor)
        assert z.is_bv_value(delta)
        off = delta.as_long()
        assert off // 64 < 12 and 24 <= off % 64 < 32
        offsets.add(off)
        pairs = [(memory, actual.arg(0)), (write_offset, f.u64(off)), (byte, actual.arg(2))]
        instantiated = z.substitute(store_claim, *pairs)
        expected = z.Select(actual, address) == z.Select(actual.arg(0), address)
        assert z.is_true(z.simplify(instantiated == expected)), 'exact descriptor store instantiation'
        nonsize_pairs = [(memory, actual.arg(0)), (write_index, f.u64(off // 64)),
                         (write_byte, f.u64(off % 64 - 24)), (byte, actual.arg(2))]
        nonsize_instantiated = z.substitute(nonsize_claim, *nonsize_pairs)
        assert z.is_true(z.simplify(nonsize_instantiated == (
            z.Select(actual, descriptor_byte) == z.Select(actual.arg(0), descriptor_byte))))
        store_instances.append({'offset': off,
             'formulaFingerprint': fingerprint(instantiated),
             'premisesFingerprints': [fingerprint(z.substitute(p, *pairs)) for p in descriptor_domain],
             'nonSizeFormulaFingerprint': fingerprint(nonsize_instantiated),
             'nonSizePremisesFingerprints': [fingerprint(z.substitute(p, *nonsize_pairs)) for p in nonsize_domain]})
    assert offsets == {i * 64 + 24 + k for i in range(12) for k in range(8)}

    # Fully allocated high-address witnesses match the native 128 ->192/32
    # profiles. They include workspace, descriptor and two pending objects.
    concrete_starts = [f.u64((1 << 34) + 88 + i * 32768) for i in range(12)]
    concrete_capacities = [f.u64(128 + f.REALLOC_PADDING) for _ in range(12)]
    concrete_workspace = f.Span(f.u64((1 << 33) + 16384), f.u64(4096))
    concrete_descriptor = f.u64(1 << 33)
    concrete_pending = [f.Span(f.u64((1 << 33) + 4096), f.u64(1024)),
                        f.Span(f.u64((1 << 33) + 8192), f.u64(928))]
    domain = f.allocation_domain(concrete_starts, concrete_capacities,
                                [concrete_workspace], concrete_descriptor, concrete_pending)
    real_caps = [z.BoolVal(i == 11) for i in range(12)]
    real_post = f.runtime_step(memory, returned, concrete_starts, concrete_capacities,
                              real_caps, [concrete_workspace], z.BoolVal(True))
    real_info = concrete_workspace.start
    domain.extend(f.helper_input_domain(f.u64(12), real_info, [concrete_workspace]))
    successful, real_lengths = f.refresh_descriptors(real_post, concrete_descriptor,
                         real_info, z.BoolVal(True), f.u64(0), f.u64(12))
    metadata = f.returned_length_domain(real_post, real_info, concrete_starts,
                                       concrete_capacities, f.u64(12), z.BoolVal(True), f.u64(0))
    initial = [f.read_u64(memory, start - f.u64(8)) == f.u64(128)
               for start in concrete_starts]
    for new_length in [192, 32]:
        pins = [*domain, *initial, *metadata, real_lengths[11] == f.u64(new_length)]
        query('allocated-resize-128-to-' + str(new_length), pins,
              f.read_u64(successful, concrete_descriptor + f.u64(11 * 64 + 24)) == f.u64(new_length), z.sat)
    query('truthful-length-within-capacity', metadata,
          z.UGT(real_lengths[11], concrete_capacities[11]))
    query('readonly-serialized-length-preserved', [*initial, *metadata],
          z.Or(*[real_lengths[i] != f.u64(128) for i in range(11)]))
    # Meaningful omissions: each has an actual allowed write counterexample.
    query('missing-workspace-separation', [enabled, *[z.Not(c) for c in capabilities],
          point == pending.start, extent == f.u64(4096), pending.size == f.u64(928)],
          z.Select(post, pending.start) != z.Select(memory, pending.start), z.sat)
    query('missing-managed-capability-exclusion', [enabled, capabilities[0],
          capacities[0] == f.u64(10368)],
          z.Select(post, starts[0]) != z.Select(memory, starts[0]), z.sat)
    query('missing-returned-capacity-premise', [*domain, *initial],
          z.UGT(real_lengths[11], concrete_capacities[11]), z.sat)
    query('missing-refresh-counterexample', [enabled, status == 0, count == 12,
          lengths[11] != f.read_u64(memory, descriptor + f.u64(11 * 64 + 24))],
          f.read_u64(memory, descriptor + f.u64(11 * 64 + 24)) != lengths[11], z.sat)
    # Exercise exact proof reuse; the independent auditor must bind the
    # identical formula, not infer success from a name or a result string.
    query('reused-own-key-exclusion', [f.account_domain(data, capacity), z.ULT(offset, f.u64(32))],
          f.account_permission(data - f.u64(80) + offset, data, capacity))
    return {'passed': True, 'endToEndVerified': False, 'componentOnly': True,
            'fingerprintScheme': SCHEME, 'queries': rows,
            'serializationQueries': serialization_queries,
            'descriptorStoreInstances': sorted(store_instances, key=lambda row: row['offset']),
            'memoryFrame': ['writable serialized accounts', 'disjoint private workspace',
                            'exact successful descriptor size stores'],
            'scope': __doc__}


if __name__ == '__main__':
    report = prove(Path(sys.argv[1]))
    Path(sys.argv[1], 'report.json').write_text(json.dumps(report, indent=2) + '\n')
