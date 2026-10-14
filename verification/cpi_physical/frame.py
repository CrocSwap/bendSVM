"""Conditional U64 CPI memory frame, including workspace and size refresh.

The runtime may mutate writable serialized accounts and a private helper/syscall
workspace. The exact token-audited helper then copies returned info lengths into
caller descriptors on success. Valid nonwrapping, disjoint allocations, workspace
containment, runtime capabilities and truthful ABI metadata remain premises.
This model does not prove LLVM/SBF semantics, workspace allocation or rollback.
"""
from dataclasses import dataclass

import z3 as z

ACCOUNT_COUNT = 12
ACCOUNT_STRIDE = 64
ACCOUNT_SIZE_OFFSET = 24
INFO_STRIDE = 56
INFO_SIZE_OFFSET = 16
MAX_DATA = 10 * 1024 * 1024
REALLOC_PADDING = 10240
MAX_WORKSPACE = 65536
U64_MAX = (1 << 64) - 1


def u64(value):
    return z.BitVecVal(value, 64)


@dataclass(frozen=True)
class Span:
    start: z.BitVecRef
    size: z.BitVecRef


def inside(address, span):
    return z.And(z.UGE(address, span.start), z.ULT(address, span.start + span.size))


def bounded(span, maximum):
    # The exclusive endpoint is representable; no modular wrap is permitted.
    return z.And(z.ULE(span.size, u64(maximum)),
                 z.ULE(span.start, u64(U64_MAX) - span.size))


def separated(left, right):
    return z.Or(z.ULE(left.start + left.size, right.start),
                z.ULE(right.start + right.size, left.start))


def account_span(data, capacity):
    return Span(data - u64(88), capacity + u64(88))


def account_domain(data, capacity):
    return z.And(z.UGE(data, u64(88)), z.UGE(capacity, u64(REALLOC_PADDING)),
                 z.ULE(capacity, u64(MAX_DATA + REALLOC_PADDING)),
                 z.ULE(data, u64(U64_MAX) - capacity))


def account_permission(address, data, capacity):
    # Owner[32], lamports[8], serialized length[8], allocated data; no keys.
    return z.Or(inside(address, Span(data - u64(48), u64(32))),
                inside(address, Span(data - u64(16), u64(8))),
                inside(address, Span(data - u64(8), u64(8))),
                inside(address, Span(data, capacity)))


def read_u64(memory, address):
    return z.Concat(*[z.Select(memory, address + u64(i)) for i in reversed(range(8))])


def write_u64(memory, address, value):
    for i in range(8):
        memory = z.Store(memory, address + u64(i), z.Extract(8 * i + 7, 8 * i, value))
    return memory


def runtime_step(memory, returned, starts, capacities, capabilities, workspaces, enabled):
    if not len(starts) == len(capacities) == len(capabilities) == ACCOUNT_COUNT:
        raise ValueError('exactly twelve account slots required')
    address = z.BitVec('cpi_physical_address', 64, ctx=memory.ctx)
    permissions = [z.And(cap, account_permission(address, data, size))
                   for data, size, cap in zip(starts, capacities, capabilities)]
    permissions.extend(inside(address, workspace) for workspace in workspaces)
    return z.Lambda(address, z.If(z.And(enabled, z.Or(*permissions)),
                                  z.Select(returned, address), z.Select(memory, address)))


def refresh_descriptors(memory, descriptor_start, info_start, enabled, status, count):
    """Exact successful helper size loop; all other descriptor bytes preserved."""
    returned_lengths = [read_u64(memory, info_start + u64(INFO_STRIDE * i + INFO_SIZE_OFFSET))
                        for i in range(ACCOUNT_COUNT)]
    for i, length in enumerate(returned_lengths):
        address = descriptor_start + u64(ACCOUNT_STRIDE * i + ACCOUNT_SIZE_OFFSET)
        changed = write_u64(memory, address, length)
        memory = z.If(z.And(enabled, status == u64(0), z.ULT(u64(i), count)), changed, memory)
    return memory, returned_lengths


def allocation_domain(starts, capacities, workspaces, descriptor_start, pending):
    if len(starts) != ACCOUNT_COUNT or len(capacities) != ACCOUNT_COUNT:
        raise ValueError('exactly twelve account slots required')
    accounts = [account_span(a, n) for a, n in zip(starts, capacities)]
    descriptor = Span(descriptor_start, u64(ACCOUNT_STRIDE * ACCOUNT_COUNT))
    private = [*workspaces, descriptor, *pending]
    domain = [account_domain(a, n) for a, n in zip(starts, capacities)]
    domain.extend(bounded(span, MAX_WORKSPACE) for span in private)
    spans = [*accounts, *private]
    domain.extend(separated(left, right) for i, left in enumerate(spans)
                  for right in spans[i + 1:])
    return domain


def returned_length_domain(memory, info_start, starts, capacities, count, enabled, status):
    """Explicit truthful runtime metadata/serialized-length/capacity premise."""
    if len(starts) != ACCOUNT_COUNT or len(capacities) != ACCOUNT_COUNT:
        raise ValueError('exactly twelve account slots required')
    constraints = []
    for i, (start, capacity) in enumerate(zip(starts, capacities)):
        length = read_u64(memory, info_start + u64(INFO_STRIDE * i + INFO_SIZE_OFFSET))
        guard = z.And(enabled, status == u64(0), z.ULT(u64(i), count))
        constraints.append(z.Implies(guard, z.And(
            length == read_u64(memory, start - u64(8)),
            z.ULE(length, capacity), z.ULE(length, u64(MAX_DATA)))))
    return constraints


def helper_input_domain(count, info_start, workspaces):
    """The actual infos array lies inside the allocated private workspace."""
    infos = Span(info_start, u64(INFO_STRIDE * ACCOUNT_COUNT))
    contained = [z.And(z.UGE(infos.start, workspace.start),
                        z.ULE(infos.start + infos.size, workspace.start + workspace.size))
                 for workspace in workspaces]
    return [z.ULE(count, u64(ACCOUNT_COUNT)), bounded(infos, MAX_WORKSPACE),
            z.Or(*contained)]
