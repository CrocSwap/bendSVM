"""Structural SBPFv0 graph projection for restricted acyclic translation checks.

Not a loader or execution model. Branch conditions are not evaluated. Calls have
no modeled callee/return edges and must be rejected inside the selected cone.
Other instructions receive a sequential edge; their semantics must be checked
by the consumer. A cone excludes paths that cannot reach its cutpoint, so it
establishes neither termination nor that every entry execution reaches the stop.
"""
import collections
import struct

if not __debug__:
    raise RuntimeError('assertions required')

BRANCHES = frozenset((0x05, 0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d,
                      0x45, 0x4d, 0x55, 0x5d, 0x65, 0x6d, 0x75, 0x7d,
                      0xa5, 0xad, 0xb5, 0xbd, 0xc5, 0xcd, 0xd5, 0xdd))


def need(ok, message):
    if not ok:
        raise ValueError(message)


def decode(text, address):
    """Return instruction starts and syntactic successors, retaining edge order.

    For a conditional branch, the first edge is taken and the second fallthrough,
    even when they coincide. LDDW continuation words are never instruction starts.
    Every explicit branch target and fallthrough must name a real instruction.
    Calls are provisionally represented as fallthrough, solely for cone discovery.
    """
    need(type(text) is bytes and len(text) > 0 and len(text) % 8 == 0,
         'text instruction alignment')
    need(type(address) is int and 0 <= address < 2**64 and address % 8 == 0
         and address + len(text) <= 2**64, 'text address')
    instructions, successors = {}, {}
    pc = 0
    while pc < len(text):
        at = address + pc
        op, ds, off, imm = struct.unpack_from('<BBhi', text, pc)
        size = 16 if op == 0x18 else 8
        if op == 0x18:
            need(pc + 16 <= len(text), 'truncated double instruction')
            next_op, next_ds, next_off, _ = struct.unpack_from('<BBhi', text, pc + 8)
            need(next_op == next_ds == next_off == 0, 'double continuation fields')
        instructions[at] = (op, ds, off, imm)
        if op == 0x95:
            successors[at] = []
        elif op in BRANCHES:
            successors[at] = [at + 8 * (off + 1)]
            if op != 0x05:
                successors[at].append(at + 8)
        else:
            successors[at] = [at + size]
        pc += size
    for at, edges in successors.items():
        for target in edges:
            need(target in instructions, 'edge target is not an instruction')
    return instructions, successors


def acyclic_cone(text, address, entry, stop):
    """Select entry-reachable instructions that can reach an exclusive cutpoint.

    Only monotonically increasing edges are accepted within the selected cone.
    This is more restrictive than general acyclicity: backward edges are refused
    even when a topological ordering could exist. The stop itself is included,
    with its outgoing edges suppressed and its opcode left unexecuted.
    """
    instructions, successors = decode(text, address)
    need(type(entry) is int and type(stop) is int and entry in instructions
         and stop in instructions, 'instruction cutpoints')
    successors[stop] = []
    predecessors = collections.defaultdict(list)
    for source, targets in successors.items():
        for target in targets:
            predecessors[target].append(source)
    backward, pending = {stop}, [stop]
    while pending:
        for source in predecessors[pending.pop()]:
            if source not in backward:
                backward.add(source)
                pending.append(source)
    cone, pending = set(), [entry]
    while pending:
        at = pending.pop()
        if at in cone or at not in backward:
            continue
        cone.add(at)
        pending.extend(successors[at])
    need(stop in cone, 'no graph route')
    need(all(target > source for source in cone for target in successors[source]
             if target in cone), 'cyclic cone')
    for at in cone - {stop}:
        op = instructions[at][0]
        need(op not in (0x85, 0x8d), 'unsupported path opcode ' + hex(op))
    return instructions, successors, cone
