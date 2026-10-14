"""Restricted SBPFv0 straight-line scalar semantics for translation checks.

This is a trusted model, not a verified VM. It deliberately rejects control flow,
non-stack memory, pointer arithmetic and every unlisted instruction. Registers
0..9 contain 64-bit bitvectors; r10 is an opaque frame pointer that is preserved.
Stack keys are aligned byte offsets in one assumed valid, disjoint 4096-byte
frame. Stack validity, loader rules and correspondence to actual VM memory are
obligations of the caller. Arithmetic wraps modulo 2**64.
"""
import struct
import z3 as z

if not __debug__:
    raise RuntimeError('assertions required')


def need(ok, message):
    if not ok:
        raise ValueError(message)


def scalar(value):
    return z.is_bv(value) and value.size() == 64


def stack_offset(offset):
    return type(offset) is int and -4096 <= offset <= -8 and offset % 8 == 0


def execute(code, registers, stack):
    """Return copied (registers, stack, written offsets, decoded instructions).

    All entry values must be supplied explicitly. No initial value is invented
    for a load, and neither caller-owned container is changed on success/failure.
    Only MOV64, ADD64, MUL64, immediate LSH64/RSH64, and aligned stack LDXDW/STXDW
    are supported. MOV64 immediates sign-extend the encoded signed 32-bit value.
    Reads/writes of r10 as scalar data are outside this model's domain.
    """
    need(z.get_version_string() == '5.1.0', 'solver pin')
    need(type(code) is bytes and len(code) % 8 == 0, 'instruction alignment')
    need(len(registers) == 11 and all(scalar(v) for v in registers), 'register state')
    need(type(stack) is dict and all(stack_offset(k) and scalar(v) for k, v in stack.items()), 'stack state')
    regs, memory, writes, instructions = list(registers), dict(stack), set(), []
    for i in range(0, len(code), 8):
        op, ds, off, imm = struct.unpack_from('<BBhi', code, i)
        dst, src = ds & 15, ds >> 4
        need(dst <= 10 and src <= 10, 'register range')
        instructions.append({'offset': i, 'opcode': op, 'dst': dst, 'src': src,
                             'offsetField': off, 'immediate': imm})
        if op == 0x79:
            need(src == 10 and dst < 10 and imm == 0 and stack_offset(off), 'stack load shape')
            need(off in memory, 'unbound stack input')
            regs[dst] = memory[off]
        elif op == 0x7b:
            need(dst == 10 and src < 10 and imm == 0 and stack_offset(off), 'stack store shape')
            memory[off] = regs[src]
            writes.add(off)
        else:
            need(dst < 10 and off == 0, 'scalar destination/offset')
            if op in (0xbf, 0x2f, 0x0f):
                need(imm == 0, 'reserved immediate')
                need(src < 10, 'scalar frame pointer read')
                if op == 0xbf:
                    regs[dst] = regs[src]
                elif op == 0x2f:
                    regs[dst] = regs[dst] * regs[src]
                else:
                    regs[dst] = regs[dst] + regs[src]
            elif op in (0x67, 0x77):
                need(src == 0 and 0 <= imm < 64, 'shift shape')
                regs[dst] = regs[dst] << imm if op == 0x67 else z.LShR(regs[dst], imm)
            elif op == 0xb7:
                need(src == 0, 'immediate register')
                regs[dst] = z.BitVecVal(imm, 64)
            else:
                raise ValueError('unsupported opcode ' + hex(op))
    return regs, memory, writes, instructions
