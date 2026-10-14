"""Actual read origins through runtime frames and exact descriptor size stores.

Initial byte mapping, valid disjoint allocations and workspace containment are
premises. Fresh range/Store lemmas and checked finite instantiations derive
preservation; serialized external lengths are conditional on readonly capability.
"""
if not __debug__:
    raise RuntimeError('assertions required')
import hashlib
from pathlib import Path

import z3 as z
from cpi_physical import frame as f
from cpi_physical.typed_dag import Fingerprints, SCHEME


def connect(w, starts, capacities, memories, runtime_memories, returned,
            capabilities, enabled, statuses, workspace, descriptor, info, folder):
    assert len(starts) == len(capacities) == 12 and len(memories) == 3
    digest = Fingerprints()
    queries, instances, selections, refresh_instances = [], [], [], []
    cache = {}
    named = {}

    def prove(name, premises, claim):
        formula = z.And(*premises, z.Not(claim))
        signature = digest(formula)
        if name in named:
            assert named[name]['sourceFormulaFingerprint'] == signature, 'projection proof name reused for different formula'
            return named[name]
        if signature in cache:
            original, expression = cache[signature]
            assert z.eq(formula, expression), 'projection cache AST mismatch'
            row = {'name': name, 'result': 'unsat', 'reuse': original,
                   'sourceFormulaFingerprint': signature}
        else:
            solver = z.Solver()
            solver.set(timeout=30000)
            solver.add(formula)
            path = folder / (name + '.smt2')
            path.write_text(solver.to_smt2())
            answer = solver.check()
            assert answer == z.unsat, (name, str(answer), solver.reason_unknown())
            row = {'name': name, 'result': 'unsat', 'sourceFormulaFingerprint': signature,
                   'query': str(path), 'querySha256': hashlib.sha256(path.read_bytes()).hexdigest()}
            cache[signature] = (name, formula)
        queries.append(row)
        named[name] = row
        return row

    s, n, t, tn, off = z.BitVecs('projection_s projection_n projection_t projection_tn projection_off', 64)
    left, right = f.Span(s, n), f.Span(t, tn)
    local_claim = z.Not(f.account_permission(t + off, s, n))
    local_domain = [f.account_domain(s, n), f.bounded(right, f.MAX_WORKSPACE),
                    f.separated(right, f.account_span(s, n)), z.ULT(off, tn)]
    arena_claim = z.Not(f.account_permission(t - f.u64(88) + off, s, n))
    arena_domain = [f.account_domain(s, n), f.account_domain(t, tn),
                    f.separated(f.account_span(s, n), f.account_span(t, tn)),
                    z.ULT(off, tn + f.u64(88))]
    key_claim = z.Not(f.account_permission(s - f.u64(80) + off, s, n))
    key_domain = [f.account_domain(s, n), z.ULT(off, f.u64(32))]
    workspace_claim = z.Not(f.inside(t + off, left))
    workspace_domain = [f.bounded(left, f.MAX_WORKSPACE), f.bounded(right, f.MAX_WORKSPACE),
                        f.separated(left, right), z.ULT(off, tn)]
    # Whole serialized arenas can exceed the private-workspace bound.
    arena_workspace_claim = z.Not(f.inside(t - f.u64(88) + off, left))
    arena_workspace_domain = [f.bounded(left, f.MAX_WORKSPACE), f.account_domain(t, tn),
                             f.separated(left, f.account_span(t, tn)), z.ULT(off, tn + f.u64(88))]
    for name, domain, claim in [('local-account', local_domain, local_claim),
                              ('other-account', arena_domain, arena_claim),
                              ('own-key', key_domain, key_claim),
                              ('local-workspace', workspace_domain, workspace_claim),
                              ('account-workspace', arena_workspace_domain, arena_workspace_claim)]:
        prove(name, domain, claim)
    permits = [z.Bool('projection_permit_' + str(i)) for i in range(13)]
    active = z.Bool('projection_active')
    before, fresh = z.BitVecs('projection_before projection_fresh', 8)
    scalar = z.If(z.And(active, z.Or(*permits)), fresh, before)
    prove('excluded-selection', [z.Not(p) for p in permits], scalar == before)

    memory = z.Array('projection_store_memory', z.BitVecSort(64), z.BitVecSort(8))
    read, base, write_off = z.BitVecs('projection_store_read projection_store_base projection_store_offset', 64)
    byte = z.BitVec('projection_store_byte', 8)
    outside_domain = [f.bounded(f.Span(base, f.u64(768)), f.MAX_WORKSPACE),
                      z.Not(f.inside(read, f.Span(base, f.u64(768)))), z.ULT(write_off, f.u64(768))]
    outside_claim = z.Select(z.Store(memory, base + write_off, byte), read) == z.Select(memory, read)
    prove('descriptor-store-exterior', outside_domain, outside_claim)
    index, offset, write_index, write_byte = z.BitVecs('projection_descriptor_index projection_descriptor_offset projection_write_index projection_write_byte', 64)
    descriptor_read = base + f.u64(64) * index + offset
    nonsize_domain = [z.ULT(index, f.u64(12)), z.ULT(offset, f.u64(64)),
                      z.Or(z.ULT(offset, f.u64(24)), z.UGE(offset, f.u64(32))),
                      z.ULT(write_index, f.u64(12)), z.ULT(write_byte, f.u64(8))]
    nonsize_claim = z.Select(z.Store(memory, base + f.u64(64) * write_index + f.u64(24) + write_byte, byte), descriptor_read) == z.Select(memory, descriptor_read)
    prove('descriptor-store-nonsize', nonsize_domain, nonsize_claim)

    writing = [(i, p) for i, p in enumerate(w.paths) if any(e.kind == 'write' for e in p.events)]
    sources = {}
    for _, path in writing:
        for event in path.events:
            if event.kind == 'write' and event.physicalSourceKind == 'local':
                existing = sources.setdefault(event.physicalSourceName, event.data)
                assert len(existing) == len(event.data) and all(z.eq(a, b) for a, b in zip(existing, event.data))
    sources['reply'] = w.RPLY
    sources['transfers'] = [z.BitVec('projection_transfer_' + str(i), 8) for i in range(928)]
    pending = {name: z.BitVec('projection_local_' + name, 64) for name in sorted(sources)}
    pending_spans = [f.Span(address, f.u64(len(sources[name]))) for name, address in pending.items()]
    allocations = f.allocation_domain(starts, capacities, [workspace], descriptor, pending_spans)
    allocations.extend(f.helper_input_domain(w.COUNT, info, [workspace]))
    initial = []
    for i in range(12):
        initial.extend(z.Select(memories[0], starts[i] - f.u64(80) + f.u64(k)) == z.Extract(8 * k + 7, 8 * k, w.KEY[i]) for k in range(32))
        initial.extend(z.Select(memories[0], starts[i] - f.u64(48) + f.u64(k)) == z.Extract(8 * k + 7, 8 * k, w.OWNER[i]) for k in range(32))
        initial.append(f.read_u64(memories[0], starts[i] - f.u64(8)) == w.SIZE[i])
        initial.append(f.read_u64(memories[0], descriptor + f.u64(64 * i + 24)) == w.SIZE[i])
        for at, value in [(0, starts[i] - f.u64(80)), (8, starts[i] - f.u64(48)),
                          (16, starts[i]), (32, starts[i] - f.u64(16))]:
            initial.append(f.read_u64(memories[0], descriptor + f.u64(64 * i + at)) == value)
        for at, flag in [(48, w.SIGNER[i]), (52, w.WRITABLE[i]), (56, w.EXECUTABLE[i])]:
            for k in range(4):
                value = z.If(flag, z.BitVecVal(1, 8), z.BitVecVal(0, 8)) if k == 0 else z.BitVecVal(0, 8)
                initial.append(z.Select(memories[0], descriptor + f.u64(64 * i + at + k)) == value)
    for i, values in enumerate(w.D):
        initial.extend(z.Select(memories[0], starts[i] + f.u64(k)) == value for k, value in enumerate(values))
        if values:
            allocations.append(z.ULE(f.u64(len(values)), capacities[i]))
    for name, address in pending.items():
        initial.extend(z.Select(memories[0], address + f.u64(k)) == value for k, value in enumerate(sources[name]))

    origins = [('key' + str(i), starts[i] - f.u64(80), f.u64(32), i, 'key', None) for i in range(12)]
    origins += [('length' + str(i), starts[i] - f.u64(8), f.u64(8), i, 'length', None) for i in range(12)]
    origins += [('managed' + str(field['index']), starts[field['index']], f.u64(len(w.D[field['index']])), field['index'], 'managed', None) for field in w.m['fields']]
    origins += [(name, address, f.u64(len(sources[name])), None, 'local', None) for name, address in pending.items()]
    for i in range(12):
        origins += [('descriptor' + str(i) + '-head', descriptor + f.u64(64 * i), f.u64(24), None, 'descriptor', (i, 0)),
                    ('descriptor' + str(i) + '-tail', descriptor + f.u64(64 * i + 32), f.u64(32), None, 'descriptor', (i, 32))]
    actual_offset = z.BitVec('projection_actual_offset', 64)

    def instantiate(name, claim, domain, pairs, expected):
        formula = z.substitute(claim, *pairs)
        assert z.eq(formula, expected) or z.is_true(z.simplify(formula == expected)), (name, 'range instantiation')
        instances.append({'name': name, 'formulaFingerprint': digest(formula),
                          'premisesFingerprints': [digest(z.substitute(p, *pairs)) for p in domain]})

    for name, origin, size, account, kind, descriptor_part in origins:
        at = origin + actual_offset
        for slot in range(2):
            actual_permits = [z.And(capabilities[slot][i], f.account_permission(at, starts[i], capacities[i])) for i in range(12)]
            actual_permits.append(f.inside(at, workspace))
            for i in range(12):
                if kind in ('local', 'descriptor'):
                    # The descriptor's entire arena is disjoint; the subspan
                    # origins remain bounded within that containing arena.
                    local_start = descriptor if kind == 'descriptor' else origin
                    local_extent = f.u64(768) if kind == 'descriptor' else size
                    translated = f.u64(64 * descriptor_part[0] + descriptor_part[1]) + actual_offset if kind == 'descriptor' else actual_offset
                    pairs = [(s, starts[i]), (n, capacities[i]), (t, local_start), (tn, local_extent), (off, translated)]
                    expected = z.Not(f.account_permission(local_start + translated, starts[i], capacities[i]))
                    instantiate(f'{name}-slot{slot}-arena{i}', local_claim, local_domain, pairs, expected)
                elif account == i:
                    if kind == 'key':
                        pairs = [(s, starts[i]), (n, capacities[i]), (off, actual_offset)]
                        instantiate(f'{name}-slot{slot}-own-key', key_claim, key_domain, pairs, z.Not(f.account_permission(at, starts[i], capacities[i])))
                    else:
                        instances.append({'name': f'{name}-slot{slot}-own-arena', 'requiresCapabilityExclusion': True,
                                          'conditionalReadonly': kind == 'length', 'excludedCapabilityFingerprint': digest(z.Not(capabilities[slot][i]))})
                else:
                    translated = actual_offset + f.u64({'key': 8, 'length': 80, 'managed': 88}[kind])
                    pairs = [(s, starts[i]), (n, capacities[i]), (t, starts[account]), (tn, capacities[account]), (off, translated)]
                    expected = z.Not(f.account_permission(starts[account] - f.u64(88) + translated, starts[i], capacities[i]))
                    instantiate(f'{name}-slot{slot}-arena{i}', arena_claim, arena_domain, pairs, expected)
                # Each translated offset has a fresh bounded-index bridge.
                if kind == 'descriptor':
                    prove(f'{name}-offset-bound', [z.ULT(actual_offset, size)], z.ULT(f.u64(64 * descriptor_part[0] + descriptor_part[1]) + actual_offset, f.u64(768)))
            if kind in ('local', 'descriptor'):
                local_start = descriptor if kind == 'descriptor' else origin
                local_extent = f.u64(768) if kind == 'descriptor' else size
                translated = f.u64(64 * descriptor_part[0] + descriptor_part[1]) + actual_offset if kind == 'descriptor' else actual_offset
                pairs = [(s, workspace.start), (n, workspace.size), (t, local_start), (tn, local_extent), (off, translated)]
                instantiate(f'{name}-slot{slot}-workspace', workspace_claim, workspace_domain, pairs, z.Not(f.inside(local_start + translated, workspace)))
            else:
                translated = actual_offset + f.u64({'key': 8, 'length': 80, 'managed': 88}[kind])
                pairs = [(s, workspace.start), (n, workspace.size), (t, starts[account]), (tn, capacities[account]), (off, translated)]
                instantiate(f'{name}-slot{slot}-workspace', arena_workspace_claim, arena_workspace_domain, pairs, z.Not(f.inside(starts[account] - f.u64(88) + translated, workspace)))
                prove(f'{name}-translated-bound', [f.account_domain(starts[account], capacities[account]), z.ULT(actual_offset, size), z.ULE(size, capacities[account])], z.ULT(translated, capacities[account] + f.u64(88)))
                prove(f'{name}-translated-address', [], at == starts[account] - f.u64(88) + translated)
            actual_scalar = z.substitute(scalar, *zip(permits, actual_permits),
                    (active, enabled[slot]), (before, z.Select(memories[slot], at)),
                    (fresh, z.Select(returned[slot], at)))
            actual_body = z.substitute_vars(runtime_memories[slot].body(), at)
            assert z.eq(actual_body, actual_scalar) or z.is_true(z.simplify(actual_body == actual_scalar)), 'exact runtime Lambda selection'
            if kind == 'descriptor':
                number, begin = descriptor_part
                translated = f.u64(begin) + actual_offset
                prove(name + '-nonsize-read-bound', [z.ULT(actual_offset, size)],
                      z.And(z.ULT(translated, f.u64(64)), z.Or(z.ULT(translated, f.u64(24)), z.UGE(translated, f.u64(32)))))
                refresh_read = {'kind': 'nonsize', 'index': number,
                    'offsetFingerprint': digest(translated), 'domainFingerprint': digest(z.ULT(actual_offset, size))}
            elif kind == 'local':
                pairs = [(s, descriptor), (n, f.u64(768)), (t, origin), (tn, size), (off, actual_offset)]
                expected = z.Not(f.inside(at, f.Span(descriptor, f.u64(768))))
                instantiate(f'{name}-slot{slot}-descriptor-exterior', workspace_claim, workspace_domain, pairs, expected)
                refresh_read = {'kind': 'exterior', 'formulaFingerprint': digest(expected)}
            else:
                translated = actual_offset + f.u64({'key': 8, 'length': 80, 'managed': 88}[kind])
                pairs = [(s, descriptor), (n, f.u64(768)), (t, starts[account]), (tn, capacities[account]), (off, translated)]
                expected = z.Not(f.inside(starts[account] - f.u64(88) + translated, f.Span(descriptor, f.u64(768))))
                instantiate(f'{name}-slot{slot}-descriptor-exterior', arena_workspace_claim, arena_workspace_domain, pairs, expected)
                refresh_read = {'kind': 'exterior', 'formulaFingerprint': digest(expected)}
            selections.append({'origin': name, 'slot': slot, 'kind': kind,
                'conditionalReadonly': kind == 'length', 'readBoundFingerprint': digest(z.ULT(actual_offset, size)),
                'selectionFingerprint': digest(actual_scalar), 'permissionExclusionsFingerprints': [digest(z.Not(p)) for p in actual_permits],
                'preservedReadFingerprint': digest(z.Select(memories[slot + 1], at) == z.Select(memories[slot], at)),
                'refreshReadExclusion': refresh_read})

    # Exact fresh finite induction for all descriptor stores at both calls.
    for slot in range(2):
        stores, seen, stack = [], set(), [memories[slot + 1]]
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
                assert z.eq(node, runtime_memories[slot]), 'refresh memory must originate at actual runtime frame'
        assert len(stores) == 96
        for actual in stores:
            delta = z.simplify(actual.arg(1) - descriptor)
            assert z.is_bv_value(delta)
            offset_value = delta.as_long()
            i, k = divmod(offset_value, 64)
            assert i < 12 and 24 <= k < 32
            expected_byte = z.Extract(8 * (k - 24) + 7, 8 * (k - 24), f.read_u64(runtime_memories[slot], info + f.u64(56 * i + 16)))
            assert z.eq(actual.arg(2), expected_byte)
            pairs = [(memory, actual.arg(0)), (base, descriptor), (write_off, f.u64(offset_value)), (byte, actual.arg(2))]
            theorem = z.substitute(outside_claim, *pairs)
            expected = z.Select(actual, read) == z.Select(actual.arg(0), read)
            assert z.is_true(z.simplify(theorem == expected))
            nonsize_pairs = [(memory, actual.arg(0)), (base, descriptor), (write_index, f.u64(i)), (write_byte, f.u64(k - 24)), (byte, actual.arg(2))]
            refresh_instances.append({'slot': slot, 'offset': offset_value,
                'exteriorFormulaFingerprint': digest(theorem), 'exteriorPremisesFingerprints': [digest(z.substitute(p, *pairs)) for p in outside_domain],
                'nonSizeFormulaFingerprint': digest(z.substitute(nonsize_claim, *nonsize_pairs)),
                'nonSizePremisesFingerprints': [digest(z.substitute(p, *nonsize_pairs)) for p in nonsize_domain]})
    commit_sources = []
    for pathno, path in writing:
        for eventno, event in enumerate(path.events):
            if event.kind != 'write':
                continue
            source = pending[event.physicalSourceName] if event.physicalSourceKind == 'local' else starts[int(event.physicalSourceName)] - f.u64(80)
            commit_sources.append({'path': pathno, 'event': eventno, 'kind': event.physicalSourceKind,
                'source': event.physicalSourceName, 'bytes': len(event.data),
                'derivedSourceEqualityFingerprints': [digest(z.Select(memories[-1], source + f.u64(k)) == value) for k, value in enumerate(event.data)]})
    path = folder / 'physical-initial-and-allocation-premises.smt2'
    solver = z.Solver()
    solver.add(*allocations, *initial)
    path.write_text(solver.to_smt2())
    # Concrete layout includes the actual initial external128-byte length;
    # no 20,000-byte capacity standing in for a different profile.
    pins = [start == f.u64((1 << 34) + 88 + i * 32768) for i, start in enumerate(starts)]
    pins += [workspace.start == f.u64(1 << 32), workspace.size == f.u64(4096),
             descriptor == f.u64(1 << 33), info == workspace.start]
    pins += [address == f.u64((1 << 33) + 4096 + i * 8192) for i, address in enumerate(pending.values())]
    managed = {field['index']: field['stateBytes'] for field in w.m['fields']}
    pins += [w.SIZE[i] == f.u64(managed.get(i, 128 if i == 11 else 0)) for i in range(12)]
    layout = z.Solver()
    layout.set(timeout=30000)
    layout.add(*allocations, *pins)
    assert layout.check() == z.sat, ('actual allocation witness', layout.reason_unknown())
    report = {'passed': True, 'initialProjectionIsPremise': True, 'physicalAllocationIsPremise': True,
        'fingerprintScheme': SCHEME, 'origins': [{'name': name, 'kind': kind, 'account': account} for name, _, _, account, kind, _ in origins],
        'freshProofs': queries, 'rangeLemmaInstances': instances, 'frameSelections': selections,
        'descriptorStoreInstances': sorted(refresh_instances, key=lambda row: (row['slot'], row['offset'])),
        'actualMemcpySourceOrigins': commit_sources, 'allocationWitness': 'sat',
        'premises': str(path), 'premisesSha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'scope': __doc__}
    return report, {'allocations': allocations, 'initial': initial, 'pins': pins,
                    'pending': pending, 'sources': sources, 'origins': origins}
