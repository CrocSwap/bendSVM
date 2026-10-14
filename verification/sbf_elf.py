"""Strict ELF64 text extraction for pinned SBPFv0 proof artifacts.

This checks the section representation used by the arithmetic/path models. It
is not a Solana loader: program mappings, symbols, relocations, calls, verifier
rules, and JIT/interpreter behavior require separate validation.
"""
import struct

if not __debug__:
    raise RuntimeError('assertions required')


def need(ok, message):
    if not ok:
        raise ValueError(message)


def text_section(raw):
    need(type(raw) in (bytes, bytearray) and len(raw) >= 64, 'ELF header')
    h = struct.unpack_from('<16sHHIQQQIHHHHHH', raw)
    need(h[0][:7] == b'\x7fELF\x02\x01\x01' and h[1] == 3 and h[2] == 263
         and h[3] == 1 and h[7] == 0 and h[8] == 64,
         'expected SBPFv0 ELF64 little endian')
    section_start, section_size, count, names_index = h[6], h[11], h[12], h[13]
    need(section_size == 64 and count > 0 and 0 < names_index < count
         and section_start >= 64 and section_start % 8 == 0
         and section_start + section_size * count <= len(raw), 'section table')
    sections = [struct.unpack_from('<IIQQQQIIQQ', raw, section_start + i * 64)
                for i in range(count)]
    strings = sections[names_index]
    need(strings[1] == 3 and strings[4] >= 64 and strings[5] > 0
         and strings[4] + strings[5] <= len(raw), 'section string table')
    names = raw[strings[4]:strings[4] + strings[5]]
    need(names[0] == 0 and names[-1] == 0, 'section string termination')
    found = []
    for section in sections:
        need(section[0] < len(names), 'section name')
        end = names.find(b'\0', section[0])
        need(end >= 0, 'section name termination')
        if names[section[0]:end] == b'.text':
            found.append(section)
    need(len(found) == 1, 'unique text section')
    text = found[0]
    need(text[1] == 1 and text[2] == 6 and text[8] >= 8
         and text[8] & (text[8] - 1) == 0 and text[9] == 0,
         'executable text section')
    address, offset, size = text[3:6]
    need(offset >= 64 and size > 0 and offset + size <= len(raw)
         and size % 8 == 0 and offset % text[8] == 0
         and address % text[8] == 0 and address + size <= 2**64, 'text bounds')
    # A proof must not interpret metadata bytes as executable instructions.
    for low, high in [(section_start, section_start + 64 * count),
                      (strings[4], strings[4] + strings[5])]:
        need(offset + size <= low or offset >= high, 'text metadata overlap')
    return address, bytes(raw[offset:offset + size])
