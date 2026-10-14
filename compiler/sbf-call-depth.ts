import { createHash } from 'node:crypto';

/**
 * Conservative call-depth analysis for a final, linked SBFv0 ELF.
 *
 * This is an artifact checker, not an ELF loader or general eBPF verifier. It
 * follows the pinned Solana SBFv0 call/relocation convention and refuses any
 * reachable control-flow feature that it cannot bound soundly.
 */

export interface SbfCallDepthDiagnostic {
  code: string;
  message: string;
  instructionIndex?: number;
}

export interface SbfCallEdge {
  callerEntry: number;
  callInstruction: number;
  targetEntry: number;
  targetSymbols: string[];
  kind: 'guest';
  countsFrame: true;
}

export interface SbfSyscallEdge {
  callerEntry: number;
  callInstruction: number;
  symbol: string;
  kind: 'syscall';
  countsFrame: false;
  returnsToGuest: boolean;
}

export interface SbfCallDepthReport {
  schemaVersion: 1;
  status: 'accepted' | 'refused';
  artifact: { sha256: string; byteLength: number };
  target: {
    elfType: 'ET_DYN' | 'unsupported' | null;
    machine: 'EM_BPF' | 'EM_SBPF' | 'unsupported' | null;
    sbpfVersion: 'v0' | null;
    entryInstruction: number | null;
    textAddress: string | null;
  };
  assumptions: {
    solanaSbpf: '0.11.1';
    solanaProgramRuntime: '2.3.13';
    maxActiveFramesIncludingEntry: 64;
    frameSizeBytes: 4096;
    checkerMaxTextInstructions: 65_536;
    callx: 'reachable instances refused';
    importKeyCollisions: 'refused when an import hash matches a registered guest-function key';
    loaderFunctionKeys: 'numeric target-PC keys use 64-bit host usize bytes; entrypoint and imports use symbol-name bytes';
    loaderEntryPointRemap: 'defined entrypoint relocations resolve to e_entry; colliding numeric PC keys refused';
    loaderRelocationLookup: 'first program header of any type containing DT_REL in p_memsz, else first exact sh_addr section; mismatched SHT_REL bytes refused';
    loaderDynamicTable: 'first PT_DYNAMIC must be an aligned valid slice; invalid PT_DYNAMIC fallback is refused; aligned SHT_DYNAMIC-only files are supported';
    loaderDynamicSymbols: 'first section at DT_SYMTAB and unique literal .dynstr; 64-byte name limit applies only to referenced R_BPF_64_32 symbols';
    relocationTextWrites: 'all loader write ranges checked; outside-to-text writes refused';
    loaderConfiguration: 'reject_broken_elfs=false and enable_symbol_and_section_labels=false; e_flags=0 selects SBPFv0';
    hostUsizeBytes: 8;
    executionEngine: 'interpreter modeled and exercised; JIT equivalence assumed, not verified';
    syscallScope: 'registry is external; imports are checked for guest-key collisions; syscalls are assumed to add no guest frame';
    cpiScope: 'CPI and nested-program call depth are out of scope';
    syscallFrames: 0;
    terminalSyscalls: 'resolved abort import halts under pinned Solana runtime; other syscalls conservatively return';
    controlFlow: 'both conditional outcomes; direct jumps and fallthrough followed';
    maximumActivationInstructionStates: 1_000_000;
  };
  analysis: {
    reachableInstructionCount: number;
    reachableActivationEntries: number[];
    reachableCallEdges: SbfCallEdge[];
    reachableSyscallEdges: SbfSyscallEdge[];
    reachableCallxInstructions: number[];
    unreachableCallxInstructionCount: number;
    longestFrameCount: number | null;
    longestFramePath: number[] | null;
    recursiveCycle: number[] | null;
  };
  diagnostics: SbfCallDepthDiagnostic[];
}

const ELF_HEADER_SIZE = 64;
const PROGRAM_HEADER_SIZE = 56;
const SECTION_HEADER_SIZE = 64;
const SYMBOL_SIZE = 24;
const REL_SIZE = 16;
const DYNAMIC_SIZE = 16;
const MAX_U64 = 0xffff_ffff_ffff_ffffn;
const SHN_UNDEF = 0;
const SHN_ABS = 0xfff1;
const SHN_XINDEX = 0xffff;
const SHT_PROGBITS = 1;
const SHT_SYMTAB = 2;
const SHT_STRTAB = 3;
const SHT_RELA = 4;
const SHT_DYNAMIC = 6;
const SHT_NOBITS = 8;
const SHT_REL = 9;
const SHT_DYNSYM = 11;
const SHF_ALLOC = 2n;
const SHF_EXECINSTR = 4n;
const EM_BPF = 247;
const EM_SBPF = 263;
const ET_DYN = 3;
const ET_REL = 1;
const PT_LOAD = 1;
const PT_DYNAMIC = 2;
const MAX_LOADER_SYMBOL_NAME_BYTES = 64;
const DT_NULL = 0n;
const DT_STRTAB = 5n;
const DT_SYMTAB = 6n;
const DT_STRSZ = 10n;
const DT_SYMENT = 11n;
const DT_REL = 17n;
const DT_RELSZ = 18n;
const DT_RELENT = 19n;
const R_BPF_64_64 = 1;
const R_BPF_64_RELATIVE = 8;
const R_BPF_64_32 = 10;
const MAX_SBF_INSTRUCTIONS = 65_536;
const MAX_ANALYSIS_STATES = 1_000_000;
const CALL_IMM = 0x85;
const CALL_REG = 0x8d;
const EXIT = 0x95;
const LDDW = 0x18;
const JA = 0x05;

interface Section {
  index: number;
  name: string;
  type: number;
  flags: bigint;
  address: bigint;
  offset: bigint;
  size: bigint;
  link: number;
  info: number;
  alignment: bigint;
  entrySize: bigint;
  fileOffset: number | null;
  fileSize: number;
}

interface ProgramHeader {
  type: number;
  offset: bigint;
  virtualAddress: bigint;
  fileSize: bigint;
  memorySize: bigint;
  fileOffset: number;
  fileLength: number;
}

interface SymbolEntry {
  index: number;
  name: string;
  loaderNameOffset?: number;
  loaderNameBytes?: Uint8Array;
  binding: number;
  type: number;
  sectionIndex: number;
  value: bigint;
  size: bigint;
}

interface SymbolTable {
  section: Section;
  symbols: SymbolEntry[];
}

interface Relocation {
  sectionIndex: number;
  fileOffset: number;
  virtualAddress: bigint;
  symbolIndex: number;
  type: number;
}

interface ParsedElf {
  bytes: Uint8Array;
  view: DataView;
  machine: number;
  text: Section;
  textBytesOffset: number;
  instructionCount: number;
  starts: boolean[];
  sections: Section[];
  symbolsBySection: Map<number, SymbolTable>;
  dynamicSymbols: SymbolEntry[] | null;
  dynamicRelocations: Relocation[];
  relocationsByInstruction: Map<number, Relocation>;
  symbolLabels: Map<number, string[]>;
  guestFunctionKeys: Set<number>;
  entryInstruction: number;
}

class Refusal extends Error {
  constructor(readonly code: string, message: string, readonly instructionIndex?: number) {
    super(message);
  }
}

function fail(code: string, message: string, instructionIndex?: number): never {
  throw new Refusal(code, message, instructionIndex);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function rangeToNumbers(offset: bigint, size: bigint, limit: number, description: string): [number, number] {
  if (offset < 0n || size < 0n || offset > MAX_U64 || size > MAX_U64 || offset + size > MAX_U64) {
    fail('elf_arithmetic_overflow', `${description} range overflows ELF64 arithmetic`);
  }
  if (offset > BigInt(Number.MAX_SAFE_INTEGER) || size > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail('elf_range_too_large', `${description} range cannot be represented safely`);
  }
  const start = Number(offset);
  const length = Number(size);
  const end = start + length;
  if (!Number.isSafeInteger(end) || end < start || end > limit) {
    fail('elf_range_out_of_bounds', `${description} extends outside the ELF byte array`);
  }
  return [start, end];
}

function checkedAddressEnd(address: bigint, size: bigint, description: string): bigint {
  if (address + size > MAX_U64) fail('elf_arithmetic_overflow', `${description} address range overflows ELF64`);
  return address + size;
}

function readString(bytes: Uint8Array, start: number, size: number, offset: number, description: string): string {
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) {
    fail('malformed_string_table', `${description} string offset ${offset} is outside its table`);
  }
  const end = start + size;
  let nul = start + offset;
  while (nul < end && bytes[nul] !== 0) nul++;
  if (nul === end) fail('malformed_string_table', `${description} string is not NUL-terminated`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start + offset, nul));
  } catch {
    fail('malformed_string_table', `${description} string is not valid UTF-8`);
  }
}

/** Symbol names are display labels here; the loader validates dynamic names only when a relocation uses them. */
function readSymbolDisplayName(bytes: Uint8Array, start: number, size: number, offset: number): string {
  if (!Number.isInteger(offset) || offset < 0 || offset >= size) return '';
  const end = start + size;
  let nul = start + offset;
  while (nul < end && bytes[nul] !== 0) nul++;
  if (nul === end) return '';
  return new TextDecoder().decode(bytes.subarray(start + offset, nul));
}

function readLoaderSymbolNameBytes(
  bytes: Uint8Array,
  strings: Section,
  offset: number,
  description: string,
): Uint8Array {
  if (strings.type !== SHT_STRTAB || strings.fileOffset === null) {
    fail('malformed_dynamic_symbols', 'The loader-selected .dynstr section is not a file-backed SHT_STRTAB');
  }
  if (!Number.isInteger(offset) || offset < 0 || offset >= strings.fileSize) {
    fail('malformed_string_table', `${description} string offset ${offset} is outside loader-selected .dynstr`);
  }
  const start = strings.fileOffset + offset;
  const end = Math.min(strings.fileOffset + strings.fileSize, start + MAX_LOADER_SYMBOL_NAME_BYTES);
  let nul = start;
  while (nul < end && bytes[nul] !== 0) nul++;
  if (nul === end) fail('malformed_string_table', `${description} is not NUL-terminated within the loader's 64-byte name limit`);
  return bytes.slice(start, nul);
}

function parseLoaderSymbolTable(
  bytes: Uint8Array,
  view: DataView,
  section: Section,
  sections: Section[],
): SymbolEntry[] {
  if (section.type !== SHT_SYMTAB && section.type !== SHT_DYNSYM) {
    fail('malformed_dynamic_symbols', `The first DT_SYMTAB section match has unsupported type ${section.type}`);
  }
  if (section.fileOffset === null || section.size % BigInt(SYMBOL_SIZE) !== 0n) {
    fail('malformed_dynamic_symbols', 'The loader-selected DT_SYMTAB section has an invalid byte range');
  }
  const count = Number(section.size / BigInt(SYMBOL_SIZE));
  const symbols: SymbolEntry[] = [];
  for (let index = 0; index < count; index++) {
    const at = section.fileOffset + index * SYMBOL_SIZE;
    const nameOffset = view.getUint32(at, true);
    const info = bytes[at + 4];
    const sectionIndex = view.getUint16(at + 6, true);
    const value = view.getBigUint64(at + 8, true);
    const size = view.getBigUint64(at + 16, true);
    if (value + size > MAX_U64) fail('elf_arithmetic_overflow', `DT_SYMTAB symbol ${index} value + size overflows`);
    if (sectionIndex === SHN_XINDEX) fail('unsupported_extended_symbol_index', `DT_SYMTAB symbol ${index} uses SHN_XINDEX`);
    if (sectionIndex !== SHN_UNDEF && sectionIndex < SHN_ABS && sectionIndex >= sections.length) {
      fail('malformed_dynamic_symbols', `DT_SYMTAB symbol ${index} has an invalid section index`);
    }
    symbols.push({
      index,
      name: '',
      loaderNameOffset: nameOffset,
      binding: info >> 4,
      type: info & 0x0f,
      sectionIndex,
      value,
      size,
    });
  }
  return symbols;
}

function signed16(view: DataView, offset: number): number {
  return view.getInt16(offset, true);
}

function signed32(view: DataView, offset: number): number {
  return view.getInt32(offset, true);
}

function rotateLeft32(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

/** Mirrors hash32 0.3.1's Murmur3Hasher used by the pinned SBFv0 loader. */
function murmur3SymbolKey(bytes: Uint8Array): number {
  let state = 0;
  let at = 0;
  while (at + 4 <= bytes.length) {
    let block = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
    block = Math.imul(block, 0xcc9e2d51) >>> 0;
    block = rotateLeft32(block, 15);
    block = Math.imul(block, 0x1b873593) >>> 0;
    state ^= block;
    state = rotateLeft32(state, 13);
    state = (Math.imul(state, 5) + 0xe6546b64) >>> 0;
    at += 4;
  }
  const tailLength = bytes.length - at;
  if (tailLength > 0) {
    let tail = 0;
    if (tailLength >= 3) tail ^= bytes[at + 2] << 16;
    if (tailLength >= 2) tail ^= bytes[at + 1] << 8;
    tail ^= bytes[at];
    tail = Math.imul(tail, 0xcc9e2d51) >>> 0;
    tail = rotateLeft32(tail, 15);
    tail = Math.imul(tail, 0x1b873593) >>> 0;
    state ^= tail;
  }
  state ^= bytes.length;
  state ^= state >>> 16;
  state = Math.imul(state, 0x85ebca6b) >>> 0;
  state ^= state >>> 13;
  state = Math.imul(state, 0xc2b2ae35) >>> 0;
  state ^= state >>> 16;
  return state >>> 0;
}

function legacyFunctionKey(pc: number): number {
  const targetPc = new Uint8Array(8);
  new DataView(targetPc.buffer).setBigUint64(0, BigInt(pc), true);
  return murmur3SymbolKey(targetPc);
}

function pcForAddress(address: bigint, text: Section, count: number, starts: boolean[], description: string): number {
  const end = checkedAddressEnd(text.address, text.size, '.text');
  if (address < text.address || address >= end) fail('call_target_out_of_text', `${description} is outside .text`);
  const byteOffset = address - text.address;
  if (byteOffset % 8n !== 0n) fail('call_target_unaligned', `${description} is not instruction-aligned`);
  const pcBig = byteOffset / 8n;
  if (pcBig >= BigInt(count)) fail('call_target_out_of_text', `${description} is outside .text`);
  const pc = Number(pcBig);
  if (!starts[pc]) fail('target_is_lddw_continuation', `${description} targets an lddw continuation`, pc);
  return pc;
}

function parseDynamicEntries(
  view: DataView,
  offset: number,
  size: number,
  description: string,
): Map<bigint, bigint> {
  if (size % DYNAMIC_SIZE !== 0) fail('malformed_dynamic_table', `${description} size is not a multiple of 16`);
  const tags = new Map<bigint, bigint>();
  let foundNull = false;
  for (let at = offset; at < offset + size; at += DYNAMIC_SIZE) {
    const tag = view.getBigInt64(at, true);
    const value = view.getBigUint64(at + 8, true);
    if (foundNull) {
      if (tag !== DT_NULL || value !== 0n) fail('malformed_dynamic_table', `${description} has non-null entries after DT_NULL`);
      continue;
    }
    if (tag === DT_NULL) {
      if (value !== 0n) fail('malformed_dynamic_table', `${description} has a nonzero DT_NULL value`);
      foundNull = true;
      continue;
    }
    if ([DT_REL, DT_RELSZ, DT_RELENT, DT_SYMTAB, DT_SYMENT, DT_STRTAB, DT_STRSZ].includes(tag)) {
      if (tags.has(tag)) fail('ambiguous_dynamic_tag', `${description} repeats a relevant dynamic tag ${tag}`);
      tags.set(tag, value);
    }
  }
  if (!foundNull) fail('malformed_dynamic_table', `${description} has no DT_NULL terminator`);
  return tags;
}

function parseElf(bytes: Uint8Array, report: SbfCallDepthReport): ParsedElf {
  if (bytes.byteLength < ELF_HEADER_SIZE) fail('truncated_elf_header', 'ELF header is truncated');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = [0x7f, 0x45, 0x4c, 0x46];
  if (magic.some((byte, index) => bytes[index] !== byte)) fail('invalid_elf_magic', 'Input is not an ELF file');
  if (bytes[4] !== 2) fail('unsupported_elf_class', 'Only ELF64 final programs are supported');
  if (bytes[5] !== 1) fail('unsupported_elf_endianness', 'Only little-endian ELF is supported');
  if (bytes[6] !== 1) fail('unsupported_elf_version', 'ELF identification version is not current');
  if (bytes[7] !== 0 || bytes[8] !== 0 || bytes.slice(9, 16).some((byte) => byte !== 0)) {
    fail('unsupported_elf_abi', 'Only System V ELF ABI with zero ABI padding is supported');
  }

  const type = view.getUint16(16, true);
  const machine = view.getUint16(18, true);
  const elfVersion = view.getUint32(20, true);
  const entry = view.getBigUint64(24, true);
  const programOffset = view.getBigUint64(32, true);
  const sectionOffset = view.getBigUint64(40, true);
  const flags = view.getUint32(48, true);
  const headerSize = view.getUint16(52, true);
  const programEntrySize = view.getUint16(54, true);
  const programCount = view.getUint16(56, true);
  const sectionEntrySize = view.getUint16(58, true);
  const sectionCount = view.getUint16(60, true);
  const sectionNamesIndex = view.getUint16(62, true);

  if (sectionNamesIndex === 0xffff || sectionCount === 0xffff) {
    fail('unsupported_extended_numbering', 'Extended ELF section numbering is not supported');
  }
  if (type === ET_REL) {
    report.target.elfType = 'unsupported';
    fail('not_a_final_program', 'ET_REL object or library is not a final linked SBF program; no entrypoint bound is available');
  }
  if (type !== ET_DYN) {
    report.target.elfType = 'unsupported';
    fail('unsupported_elf_type', `Expected ET_DYN final program, found ELF type ${type}`);
  }
  report.target.elfType = 'ET_DYN';
  if (machine === EM_BPF) report.target.machine = 'EM_BPF';
  else if (machine === EM_SBPF) report.target.machine = 'EM_SBPF';
  else {
    report.target.machine = 'unsupported';
    fail('unsupported_elf_machine', `Expected EM_BPF or EM_SBPF, found machine ${machine}`);
  }
  if (elfVersion !== 1) fail('unsupported_elf_version', `ELF header version is ${elfVersion}, expected current version 1`);
  if (flags !== 0) fail('unsupported_sbpf_version', `SBFv0 requires e_flags 0; found 0x${flags.toString(16)}`);
  report.target.sbpfVersion = 'v0';
  if (headerSize !== ELF_HEADER_SIZE) fail('malformed_elf_header', `ELF header size is ${headerSize}, expected ${ELF_HEADER_SIZE}`);
  if (programCount > 0 && programEntrySize !== PROGRAM_HEADER_SIZE) {
    fail('malformed_program_headers', `Program header entry size is ${programEntrySize}, expected ${PROGRAM_HEADER_SIZE}`);
  }
  if (programCount === 0 && programOffset !== 0n && programOffset !== BigInt(ELF_HEADER_SIZE)) {
    fail('malformed_program_headers', 'Program-header offset is nonzero while the table is empty');
  }
  if (sectionEntrySize !== SECTION_HEADER_SIZE || sectionCount === 0 || sectionNamesIndex >= sectionCount) {
    fail('malformed_section_headers', 'Section-header size, count, or string-table index is invalid');
  }
  const [programStart, programEnd] = rangeToNumbers(
    programOffset,
    BigInt(programEntrySize) * BigInt(programCount),
    bytes.byteLength,
    'program-header table',
  );
  if (programCount > 0 && programStart < ELF_HEADER_SIZE) fail('malformed_program_headers', 'Program-header table overlaps the ELF header');
  const [sectionStart, sectionEnd] = rangeToNumbers(
    sectionOffset,
    BigInt(sectionEntrySize) * BigInt(sectionCount),
    bytes.byteLength,
    'section-header table',
  );
  if (sectionStart < ELF_HEADER_SIZE) fail('malformed_section_headers', 'Section-header table overlaps the ELF header');

  const programHeaders: ProgramHeader[] = [];
  for (let index = 0; index < programCount; index++) {
    const at = programStart + index * PROGRAM_HEADER_SIZE;
    const pType = view.getUint32(at, true);
    const offset = view.getBigUint64(at + 8, true);
    const virtualAddress = view.getBigUint64(at + 16, true);
    const fileSize = view.getBigUint64(at + 32, true);
    const memorySize = view.getBigUint64(at + 40, true);
    checkedAddressEnd(virtualAddress, memorySize, `program header ${index}`);
    if (fileSize > memorySize && pType === PT_LOAD) fail('malformed_program_headers', `PT_LOAD ${index} has p_filesz greater than p_memsz`);
    const [fileOffset, fileEnd] = rangeToNumbers(offset, fileSize, bytes.byteLength, `program header ${index} file range`);
    programHeaders.push({ type: pType, offset, virtualAddress, fileSize, memorySize, fileOffset, fileLength: fileEnd - fileOffset });
  }
  if (programEnd > bytes.byteLength || sectionEnd > bytes.byteLength) fail('elf_range_out_of_bounds', 'ELF table extends outside the file');

  const rawSections: Array<Omit<Section, 'name'>> = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = sectionStart + index * SECTION_HEADER_SIZE;
    const nameOffset = view.getUint32(at, true);
    const sectionType = view.getUint32(at + 4, true);
    const sectionFlags = view.getBigUint64(at + 8, true);
    const address = view.getBigUint64(at + 16, true);
    const fileOffset = view.getBigUint64(at + 24, true);
    const size = view.getBigUint64(at + 32, true);
    const link = view.getUint32(at + 40, true);
    const info = view.getUint32(at + 44, true);
    const alignment = view.getBigUint64(at + 48, true);
    const entrySize = view.getBigUint64(at + 56, true);
    checkedAddressEnd(address, size, `section ${index}`);
    if (alignment > 1n && (alignment & (alignment - 1n)) !== 0n) {
      fail('malformed_section_headers', `Section ${index} has non-power-of-two alignment`);
    }
    let sectionFileOffset: number | null = null;
    let sectionFileSize = 0;
    if (sectionType === SHT_NOBITS) {
      if (fileOffset + size > MAX_U64) fail('elf_arithmetic_overflow', `NOBITS section ${index} file range overflows ELF64`);
    } else {
      const [start, end] = rangeToNumbers(fileOffset, size, bytes.byteLength, `section ${index}`);
      sectionFileOffset = start;
      sectionFileSize = end - start;
    }
    rawSections.push({
      index,
      type: sectionType,
      flags: sectionFlags,
      address,
      offset: fileOffset,
      size,
      link,
      info,
      alignment,
      entrySize,
      fileOffset: sectionFileOffset,
      fileSize: sectionFileSize,
    });
  }
  const fileBackedSections = rawSections
    .filter((section) => section.fileOffset !== null && section.fileSize > 0)
    .sort((left, right) => left.fileOffset! - right.fileOffset!);
  for (let index = 0; index < fileBackedSections.length; index++) {
    const section = fileBackedSections[index];
    const start = section.fileOffset!;
    const end = start + section.fileSize;
    if (start < ELF_HEADER_SIZE) fail('ambiguous_section_overlap', `Section ${section.index} overlaps the ELF header`);
    if (programCount > 0 && start < programEnd && end > programStart) {
      fail('ambiguous_section_overlap', `Section ${section.index} overlaps the program-header table`);
    }
    if (start < sectionEnd && end > sectionStart) {
      fail('ambiguous_section_overlap', `Section ${section.index} overlaps the section-header table`);
    }
    const next = fileBackedSections[index + 1];
    if (next && end > next.fileOffset!) {
      fail('ambiguous_section_overlap', `Sections ${section.index} and ${next.index} overlap in the file`);
    }
  }
  const rawNameSection = rawSections[sectionNamesIndex];
  if (!rawNameSection || rawNameSection.type !== SHT_STRTAB) fail('malformed_section_headers', 'Section-name table is not SHT_STRTAB');
  const nameStart = rawNameSection.fileOffset;
  const nameSize = rawNameSection.fileSize;
  if (nameStart === null || nameStart === undefined) fail('malformed_section_headers', 'Section-name string table has no file bytes');
  const sections: Section[] = rawSections.map((raw, index) => ({
    ...raw,
    name: readString(bytes, nameStart, nameSize, view.getUint32(sectionStart + index * SECTION_HEADER_SIZE, true), `section ${index} name`),
    fileOffset: raw.fileOffset,
    fileSize: raw.fileSize,
  }));
  if (sections[0].type !== 0 || sections[0].size !== 0n) fail('malformed_section_headers', 'Section zero is not the required null section');

  for (const name of ['.dynstr', '.symtab', '.strtab']) {
    if (sections.filter((section) => section.name === name).length > 1) {
      fail('duplicate_loader_section_name', `The pinned loader rejects duplicate ${name} sections`);
    }
  }

  const textSections = sections.filter((section) => section.name === '.text');
  if (textSections.length !== 1) fail('unsupported_text_sections', `Expected exactly one .text section, found ${textSections.length}`);
  const text = textSections[0];
  if (text.type !== SHT_PROGBITS || (text.flags & (SHF_ALLOC | SHF_EXECINSTR)) !== (SHF_ALLOC | SHF_EXECINSTR)) {
    fail('malformed_text_section', '.text must be an allocated executable SHT_PROGBITS section');
  }
  if (text.fileOffset === null || text.size === 0n || text.size % 8n !== 0n) {
    fail('malformed_text_section', '.text must contain a nonempty whole number of 8-byte instructions');
  }
  if (text.address !== text.offset) {
    fail('unsupported_v0_address_layout', 'Pinned SBFv0 relocation handling requires .text sh_addr == sh_offset');
  }
  if (text.alignment < 8n || text.address % 8n !== 0n || text.offset % 8n !== 0n) {
    fail('malformed_text_section', '.text address, file offset, and alignment must be 8-byte aligned');
  }
  const instructionCount = Number(text.size / 8n);
  if (!Number.isSafeInteger(instructionCount)) fail('elf_range_too_large', '.text instruction count is not safely representable');
  if (instructionCount > MAX_SBF_INSTRUCTIONS) {
    fail('text_too_large', `.text has ${instructionCount} instructions; checker resource cap is ${MAX_SBF_INSTRUCTIONS}`);
  }
  const textBytesOffset = text.fileOffset;
  const starts = Array.from({ length: instructionCount }, () => true);
  for (let pc = 0; pc < instructionCount; pc++) {
    const opcode = bytes[textBytesOffset + pc * 8];
    if (starts[pc] && opcode === LDDW) {
      if (pc + 1 >= instructionCount) fail('truncated_lddw', `lddw at instruction ${pc} has no continuation`, pc);
      const continuation = pc + 1;
      if (bytes[textBytesOffset + continuation * 8] !== 0) {
        fail('malformed_lddw_continuation', `lddw at instruction ${pc} has a nonzero continuation opcode`, pc);
      }
      starts[continuation] = false;
      pc++;
    }
  }
  const entryInstruction = pcForAddress(entry, text, instructionCount, starts, 'e_entry');
  report.target.entryInstruction = entryInstruction;
  report.target.textAddress = `0x${text.address.toString(16)}`;

  const tables = new Map<number, SymbolTable>();
  for (const section of sections.filter((candidate) => candidate.type === SHT_SYMTAB || candidate.type === SHT_DYNSYM)) {
    if (section.entrySize !== BigInt(SYMBOL_SIZE) || section.size % BigInt(SYMBOL_SIZE) !== 0n) {
      fail('malformed_symbol_table', `${section.name || 'symbol table'} has an invalid entry size`);
    }
    if (section.link >= sections.length || sections[section.link].type !== SHT_STRTAB) {
      fail('malformed_symbol_table', `${section.name || 'symbol table'} links to an invalid string table`);
    }
    const strings = sections[section.link];
    if (strings.fileOffset === null) fail('malformed_symbol_table', `${section.name || 'symbol table'} string table has no file bytes`);
    const stringStart = strings.fileOffset;
    const stringSize = strings.fileSize;
    const entryCount = Number(section.size / BigInt(SYMBOL_SIZE));
    if (section.info > entryCount) fail('malformed_symbol_table', `${section.name || 'symbol table'} sh_info is out of bounds`);
    const symbols: SymbolEntry[] = [];
    for (let index = 0; index < entryCount; index++) {
      const at = section.fileOffset! + index * SYMBOL_SIZE;
      const nameOffset = view.getUint32(at, true);
      const info = bytes[at + 4];
      const other = bytes[at + 5];
      const sectionIndex = view.getUint16(at + 6, true);
      const value = view.getBigUint64(at + 8, true);
      const size = view.getBigUint64(at + 16, true);
      if (value + size > MAX_U64) fail('elf_arithmetic_overflow', `${section.name || 'symbol table'} symbol ${index} value + size overflows`);
      if (sectionIndex === SHN_XINDEX) fail('unsupported_extended_symbol_index', `${section.name || 'symbol table'} symbol ${index} uses SHN_XINDEX`);
      if (sectionIndex !== SHN_UNDEF && sectionIndex < SHN_ABS && sectionIndex >= sections.length) {
        fail('malformed_symbol_table', `${section.name || 'symbol table'} symbol ${index} section index is out of bounds`);
      }
      if (index < section.info && (info >> 4) !== 0) fail('malformed_symbol_table', `${section.name || 'symbol table'} local symbol ordering is invalid`);
      if (index >= section.info && index !== 0 && (info >> 4) === 0) fail('malformed_symbol_table', `${section.name || 'symbol table'} global symbol ordering is invalid at index ${index} (sh_info ${section.info}, bind ${info >> 4})`);
      const name = readSymbolDisplayName(bytes, stringStart, stringSize, nameOffset);
      const symbol: SymbolEntry = {
        index,
        name,
        binding: info >> 4,
        type: info & 0x0f,
        sectionIndex,
        value,
        size,
      };
      if (symbol.type === 2 && symbol.sectionIndex !== SHN_UNDEF) {
        if (symbol.sectionIndex !== text.index) fail('unsupported_function_section', `Function symbol ${name || `<symbol ${index}>`} is not defined in .text`);
        const symbolPc = pcForAddress(value, text, instructionCount, starts, `function symbol ${name || index}`);
        if (size > 0n && value + size > text.address + text.size) {
          fail('malformed_function_symbol', `Function symbol ${name || index} size extends beyond .text`, symbolPc);
        }
      }
      symbols.push(symbol);
    }
    tables.set(section.index, { section, symbols });
  }

  const dynamicSections = sections.filter((section) => section.type === SHT_DYNAMIC);
  if (dynamicSections.length > 1) fail('ambiguous_dynamic_table', 'Multiple SHT_DYNAMIC sections are unsupported');
  const dynamicPrograms = programHeaders.filter((header) => header.type === PT_DYNAMIC);
  if (dynamicPrograms.length > 1) fail('ambiguous_dynamic_table', 'Multiple PT_DYNAMIC program headers are unsupported');
  const sectionDynamic = dynamicSections[0];
  const programDynamic = dynamicPrograms[0];
  if (sectionDynamic && sectionDynamic.entrySize !== BigInt(DYNAMIC_SIZE)) {
    fail('malformed_dynamic_table', 'SHT_DYNAMIC has an invalid entry size');
  }
  if (programDynamic && programDynamic.offset % 8n !== 0n) {
    fail(
      'unsupported_dynamic_table_fallback',
      'The first PT_DYNAMIC file offset is not 8-byte aligned; the pinned loader would fall back to SHT_DYNAMIC or treat the file as static',
    );
  }
  if (programDynamic && programDynamic.fileLength % DYNAMIC_SIZE !== 0) {
    fail(
      'unsupported_dynamic_table_fallback',
      'The first PT_DYNAMIC size is not a multiple of 16; the pinned loader would fall back to SHT_DYNAMIC or treat the file as static',
    );
  }
  if (!programDynamic && sectionDynamic && sectionDynamic.offset % 8n !== 0n) {
    fail('invalid_dynamic_table_alignment', 'The pinned loader cannot read the SHT_DYNAMIC section at an unaligned file offset');
  }
  if (sectionDynamic && programDynamic) {
    if (sectionDynamic.fileOffset !== programDynamic.fileOffset || sectionDynamic.fileSize !== programDynamic.fileLength) {
      fail('ambiguous_dynamic_table', 'PT_DYNAMIC and SHT_DYNAMIC describe different bytes');
    }
  }
  let dynamicTags = new Map<bigint, bigint>();
  if (programDynamic) dynamicTags = parseDynamicEntries(view, programDynamic.fileOffset, programDynamic.fileLength, 'PT_DYNAMIC');
  else if (sectionDynamic) dynamicTags = parseDynamicEntries(view, sectionDynamic.fileOffset!, sectionDynamic.fileSize, 'SHT_DYNAMIC');

  const hasAnyRelTag = [DT_REL, DT_RELSZ, DT_RELENT].some((tag) => dynamicTags.has(tag));
  const hasRelAddress = (dynamicTags.get(DT_REL) ?? 0n) !== 0n;
  let dynamicRelocationSection: Section | null = null;
  let dynamicRelocationFileOffset: number | null = null;
  let dynamicSymbols: SymbolEntry[] | null = null;
  let loaderDynamicStringSection: Section | null = null;
  if (hasAnyRelTag || hasRelAddress) {
    const relAddress = dynamicTags.get(DT_REL) ?? 0n;
    const relSize = dynamicTags.get(DT_RELSZ);
    const relEntry = dynamicTags.get(DT_RELENT);
    if (relAddress === 0n || relSize === undefined || relEntry !== BigInt(REL_SIZE) || relSize === 0n || relSize % BigInt(REL_SIZE) !== 0n) {
      fail('malformed_dynamic_relocations', 'DT_REL, DT_RELSZ, and DT_RELENT do not describe a nonempty SBFv0 REL table');
    }
    // solana-sbpf 0.11.1 checks program headers in file order, of every type,
    // and uses p_memsz (not p_filesz) to select the first segment containing
    // DT_REL. Only when no segment contains it does it use the first section
    // of any type with sh_addr == DT_REL. Match that selection before trusting
    // section metadata to describe the bytes being analyzed.
    const containingHeader = programHeaders.find((header) => {
      const end = checkedAddressEnd(header.virtualAddress, header.memorySize, 'DT_REL program-header range');
      return relAddress >= header.virtualAddress && relAddress < end;
    });
    let loaderRelOffset: bigint;
    if (containingHeader) {
      loaderRelOffset = containingHeader.offset + (relAddress - containingHeader.virtualAddress);
      if (loaderRelOffset > MAX_U64) fail('elf_arithmetic_overflow', 'Loader DT_REL file offset overflows ELF64');
    } else {
      const firstMatchingSection = sections.find((section) => section.address === relAddress);
      if (!firstMatchingSection) fail('malformed_dynamic_relocations', 'Loader cannot find a section matching DT_REL');
      loaderRelOffset = firstMatchingSection.offset;
    }
    const [loaderRelStart, loaderRelEnd] = rangeToNumbers(loaderRelOffset, relSize, bytes.byteLength, 'loader-selected DT_REL table');
    dynamicRelocationFileOffset = loaderRelStart;

    const matches = sections.filter((section) => section.type === SHT_REL && section.address === relAddress);
    if (matches.length !== 1) fail('ambiguous_dynamic_relocations', `DT_REL address resolves to ${matches.length} SHT_REL sections`);
    dynamicRelocationSection = matches[0];
    if (
      dynamicRelocationSection.size !== relSize ||
      dynamicRelocationSection.entrySize !== BigInt(REL_SIZE) ||
      dynamicRelocationSection.fileOffset !== loaderRelStart ||
      dynamicRelocationSection.fileSize !== loaderRelEnd - loaderRelStart
    ) {
      fail('loader_relocation_bytes_mismatch', 'The loader-selected DT_REL bytes are not exactly the linked SHT_REL section bytes');
    }
    const dynamicSymbolAddress = dynamicTags.get(DT_SYMTAB);
    const dynamicSymbolEntry = dynamicTags.get(DT_SYMENT);
    const dynamicStringAddress = dynamicTags.get(DT_STRTAB);
    const dynamicStringSize = dynamicTags.get(DT_STRSZ);
    if (dynamicSymbolAddress === undefined || dynamicSymbolEntry !== BigInt(SYMBOL_SIZE) || dynamicStringAddress === undefined || dynamicStringSize === undefined) {
      fail('malformed_dynamic_symbols', 'Relocations require valid DT_SYMTAB, DT_SYMENT, DT_STRTAB, and DT_STRSZ tags');
    }
    const loaderSymbolSection = sections.find((section) => section.address === dynamicSymbolAddress);
    if (!loaderSymbolSection) fail('malformed_dynamic_symbols', 'Loader cannot find a section matching DT_SYMTAB');
    loaderDynamicStringSection = sections.find((section) => section.name === '.dynstr') ?? null;
    if (loaderSymbolSection.type !== SHT_DYNSYM && loaderSymbolSection.type !== SHT_SYMTAB) {
      fail('loader_symbol_table_mismatch', `The first loader DT_SYMTAB section match has unsupported type ${loaderSymbolSection.type}`);
    }
    // The loader reads symbol records as a table but resolves names only for
    // R_BPF_64_32 relocations. Keep offsets here and validate referenced names
    // after the relocation entries have been decoded.
    dynamicSymbols = parseLoaderSymbolTable(bytes, view, loaderSymbolSection, sections);
  } else if (dynamicTags.has(DT_RELSZ) || dynamicTags.has(DT_RELENT)) {
    fail('malformed_dynamic_relocations', 'DT_RELSZ/DT_RELENT are present without DT_REL');
  }

  for (const section of sections.filter((candidate) => candidate.type === SHT_REL || candidate.type === SHT_RELA)) {
    if (section.type === SHT_RELA && section.size > 0n) fail('unsupported_rela_relocations', 'Pinned SBFv0 loader supports REL, not RELA relocations');
    if (section.size > 0n && section !== dynamicRelocationSection) {
      fail('unsupported_non_dynamic_relocations', 'Relocation sections outside the loader-selected DT_REL table are unsupported in a final ELF');
    }
  }

  const activeRelocations: Relocation[] = [];
  if (dynamicRelocationSection && dynamicRelocationFileOffset !== null) {
    const count = Number(dynamicRelocationSection.size / BigInt(REL_SIZE));
    for (let index = 0; index < count; index++) {
      const at = dynamicRelocationFileOffset + index * REL_SIZE;
      const virtualAddress = view.getBigUint64(at, true);
      const info = view.getBigUint64(at + 8, true);
      const typeValue = Number(info & 0xffff_ffffn);
      const symbolIndex = Number(info >> 32n);
      if (![R_BPF_64_64, R_BPF_64_RELATIVE, R_BPF_64_32].includes(typeValue)) {
        fail('unsupported_relocation_type', `Loader-selected DT_REL entry ${index} uses unsupported type ${typeValue}`);
      }
      if (symbolIndex >= (dynamicSymbols?.length ?? 0)) fail('relocation_symbol_out_of_bounds', `Loader-selected relocation ${index} references symbol ${symbolIndex} outside DT_SYMTAB`);
      activeRelocations.push({
        sectionIndex: dynamicRelocationSection.index,
        fileOffset: at,
        virtualAddress,
        symbolIndex,
        type: typeValue,
      });
    }
  }
  for (const relocation of activeRelocations) {
    if (relocation.type !== R_BPF_64_32) continue;
    const symbol = dynamicSymbols?.[relocation.symbolIndex];
    if (!symbol) fail('relocation_symbol_out_of_bounds', `R_BPF_64_32 references missing dynamic symbol ${relocation.symbolIndex}`);
    const strings = loaderDynamicStringSection;
    if (!strings || strings.type !== SHT_STRTAB || strings.fileOffset === null) {
      fail('malformed_dynamic_symbols', 'A loader-selected R_BPF_64_32 relocation requires a literal .dynstr SHT_STRTAB');
    }
    const nameOffset = symbol.loaderNameOffset;
    if (nameOffset === undefined) fail('malformed_dynamic_symbols', `Dynamic symbol ${symbol.index} has no loader name offset`);
    symbol.loaderNameBytes = readLoaderSymbolNameBytes(
      bytes,
      strings,
      nameOffset,
      `DT_SYMTAB symbol ${symbol.index} name`,
    );
    symbol.name = new TextDecoder().decode(symbol.loaderNameBytes);
  }

  const relocationsByInstruction = new Map<number, Relocation>();
  const relocationOffsets = new Set<string>();
  for (const relocation of activeRelocations) {
    const offsetKey = relocation.virtualAddress.toString();
    if (relocationOffsets.has(offsetKey)) fail('ambiguous_relocation', `Multiple relocations target ELF address 0x${relocation.virtualAddress.toString(16)}`);
    relocationOffsets.add(offsetKey);
    if (relocation.virtualAddress > BigInt(Number.MAX_SAFE_INTEGER)) fail('relocation_offset_out_of_bounds', 'Relocation offset is not safely representable');
    const fileOffset = Number(relocation.virtualAddress);
    if (fileOffset < 0 || fileOffset >= bytes.byteLength) fail('relocation_offset_out_of_bounds', `Relocation offset 0x${relocation.virtualAddress.toString(16)} is outside the ELF`);
    // The pinned SBFv0 loader has enable_elf_vaddr=false and consumes r_offset
    // as an ELF byte offset, so overlap is measured against .text's file range.
    const targetsText = relocation.virtualAddress >= text.offset && relocation.virtualAddress < text.offset + text.size;
    const writeRanges: Array<[bigint, bigint]> = relocation.type === R_BPF_64_64
      ? [[relocation.virtualAddress + 4n, relocation.virtualAddress + 8n], [relocation.virtualAddress + 12n, relocation.virtualAddress + 16n]]
      : relocation.type === R_BPF_64_RELATIVE && targetsText
        ? [[relocation.virtualAddress + 4n, relocation.virtualAddress + 8n], [relocation.virtualAddress + 12n, relocation.virtualAddress + 16n]]
        : relocation.type === R_BPF_64_RELATIVE
          ? [[relocation.virtualAddress, relocation.virtualAddress + 8n]]
          : [[relocation.virtualAddress + 4n, relocation.virtualAddress + 8n]];
    for (const [writeStart, writeEnd] of writeRanges) {
      const [rangeStart, rangeEnd] = rangeToNumbers(writeStart, writeEnd - writeStart, bytes.byteLength, `relocation type ${relocation.type} write`);
      const textStart = Number(text.offset);
      const textEnd = textStart + Number(text.size);
      if (rangeStart < textEnd && rangeEnd > textStart && !targetsText) {
        fail('relocation_write_overlaps_text', `Relocation type ${relocation.type} at 0x${relocation.virtualAddress.toString(16)} writes into .text from outside a recognized text slot`);
      }
    }
    if (targetsText) {
      const byteOffset = relocation.virtualAddress - text.offset;
      if (byteOffset % 8n !== 0n) fail('relocation_unaligned', `Text relocation at 0x${relocation.virtualAddress.toString(16)} is not instruction-aligned`);
      const pc = Number(byteOffset / 8n);
      if (!starts[pc]) fail('relocation_on_lddw_continuation', `Relocation at 0x${relocation.virtualAddress.toString(16)} targets an lddw continuation`, pc);
      const opcode = bytes[textBytesOffset + pc * 8];
      if (relocation.type === R_BPF_64_32) {
        if (opcode !== CALL_IMM) fail('call_relocation_on_non_call', `R_BPF_64_32 at instruction ${pc} does not target CALL_IMM`, pc);
        relocationsByInstruction.set(pc, relocation);
      } else if (relocation.type === R_BPF_64_64 || relocation.type === R_BPF_64_RELATIVE) {
        if (opcode !== LDDW || pc + 1 >= instructionCount || starts[pc + 1]) {
          fail('address_relocation_on_non_lddw', `Address relocation at instruction ${pc} does not target an lddw pair`, pc);
        }
      } else {
        fail('unsupported_relocation_type', `Unsupported text relocation type ${relocation.type}`, pc);
      }
    } else if (relocation.type === R_BPF_64_64) {
      // The loader treats R_BPF_64_64 as an lddw immediate even for SBFv0.
      rangeToNumbers(BigInt(fileOffset), 16n, bytes.byteLength, 'R_BPF_64_64 target');
    } else if (relocation.type === R_BPF_64_RELATIVE) {
      rangeToNumbers(BigInt(fileOffset), 8n, bytes.byteLength, 'R_BPF_64_RELATIVE target');
    } else if (relocation.type === R_BPF_64_32) {
      fail('call_relocation_outside_text', `R_BPF_64_32 at 0x${relocation.virtualAddress.toString(16)} is outside .text`);
    }
  }

  // Validate relocation arithmetic the same way the pinned loader consumes it.
  for (const relocation of activeRelocations) {
    const offset = Number(relocation.virtualAddress);
    if (relocation.type === R_BPF_64_64) {
      const symbol = dynamicSymbols?.[relocation.symbolIndex];
      if (!symbol) fail('relocation_symbol_out_of_bounds', `R_BPF_64_64 references missing dynamic symbol ${relocation.symbolIndex}`);
      const low = BigInt(view.getUint32(offset + 4, true));
      let address = symbol.value + low;
      if (address > MAX_U64) fail('elf_arithmetic_overflow', 'R_BPF_64_64 symbol + addend overflows');
      if (address < 0x1_0000_0000n) address += 0x1_0000_0000n;
      if (address > MAX_U64) fail('elf_arithmetic_overflow', 'R_BPF_64_64 rodata address overflows');
    } else if (relocation.type === R_BPF_64_RELATIVE) {
      if (relocation.symbolIndex !== 0) fail('malformed_relative_relocation', 'R_BPF_64_RELATIVE must use symbol index zero');
      const isText = relocation.virtualAddress >= text.offset && relocation.virtualAddress < text.offset + text.size;
      if (isText) {
        const low = BigInt(view.getUint32(offset + 4, true));
        const high = BigInt(view.getUint32(offset + 12, true));
        let address = (high << 32n) | low;
        if (address === 0n) fail('invalid_relative_address', 'R_BPF_64_RELATIVE contains a null text address');
        if (address < 0x1_0000_0000n) address += 0x1_0000_0000n;
        if (address > MAX_U64) fail('elf_arithmetic_overflow', 'R_BPF_64_RELATIVE rodata address overflows');
      } else {
        const low = BigInt(view.getUint32(offset + 4, true));
        const address = low + 0x1_0000_0000n;
        if (address > MAX_U64) fail('elf_arithmetic_overflow', 'R_BPF_64_RELATIVE data address overflows');
      }
    }
  }

  const symbolLabels = new Map<number, string[]>();
  for (const table of tables.values()) {
    for (const symbol of table.symbols) {
      if (symbol.type !== 2 || symbol.sectionIndex !== text.index) continue;
      const pc = pcForAddress(symbol.value, text, instructionCount, starts, `function symbol ${symbol.name || symbol.index}`);
      const labels = symbolLabels.get(pc) ?? [];
      if (symbol.name && !labels.includes(symbol.name)) labels.push(symbol.name);
      symbolLabels.set(pc, labels);
    }
  }

  // The SBFv0 loader's executable-function registry is keyed by the hash of
  // each target PC's native usize bytes. Include every statically registered
  // function, even symbols hidden by size/range metadata or only used in dead
  // code, because an import hash collision could otherwise dispatch as BPF.
  const guestFunctionKeys = new Set<number>([
    murmur3SymbolKey(new TextEncoder().encode('entrypoint')),
    ...[...symbolLabels.keys()].map(legacyFunctionKey),
  ]);
  // Defined relocated functions use their target-PC key. Their names matter
  // only for the special entrypoint remap and undefined import hashes.
  const entrypointKey = murmur3SymbolKey(new TextEncoder().encode('entrypoint'));
  for (let pc = 0; pc < instructionCount; pc++) {
    if (!starts[pc] || bytes[textBytesOffset + pc * 8] !== CALL_IMM) continue;
    const imm = signed32(view, textBytesOffset + pc * 8 + 4);
    if (imm === -1) continue;
    const target = pc + 1 + imm;
    if (target >= 0 && target < instructionCount && starts[target]) {
      const targetKey = legacyFunctionKey(target);
      if (target !== entryInstruction && targetKey === entrypointKey) {
        fail('numeric_pc_entrypoint_key_collision', `Numeric call target ${target} hashes to the loader's remapped entrypoint key`, pc);
      }
      guestFunctionKeys.add(targetKey);
    }
  }

  // The v0 loader first treats every non--1 CALL_IMM immediate as a relative
  // text offset, even when a later dynamic relocation overwrites that immediate.
  // Validate this pass over all slots to match loader rejection behavior.
  for (let pc = 0; pc < instructionCount; pc++) {
    if (!starts[pc]) continue;
    const opcode = bytes[textBytesOffset + pc * 8];
    if (opcode === CALL_IMM) {
      const imm = signed32(view, textBytesOffset + pc * 8 + 4);
      if (imm !== -1) {
        const target = pc + 1 + imm;
        if (target < 0 || target >= instructionCount) fail('call_target_out_of_text', `CALL_IMM at instruction ${pc} has relative target ${target} outside .text`, pc);
        if (!starts[target]) fail('target_is_lddw_continuation', `CALL_IMM at instruction ${pc} targets an lddw continuation`, pc);
      }
    }
    if (opcode === JA || isConditionalJump(opcode)) {
      const off = signed16(view, textBytesOffset + pc * 8 + 2);
      const target = pc + 1 + off;
      if (target < 0 || target >= instructionCount) fail('branch_target_out_of_text', `Branch at instruction ${pc} has target ${target} outside .text`, pc);
      if (!starts[target]) fail('target_is_lddw_continuation', `Branch at instruction ${pc} targets an lddw continuation`, pc);
    }
  }

  const textEnd = checkedAddressEnd(text.address, text.size, '.text');
  if (entry < text.address || entry >= textEnd) fail('entrypoint_out_of_text', 'e_entry is outside .text');
  return {
    bytes,
    view,
    machine,
    text,
    textBytesOffset,
    instructionCount,
    starts,
    sections,
    symbolsBySection: tables,
    dynamicSymbols,
    dynamicRelocations: activeRelocations,
    relocationsByInstruction,
    symbolLabels,
    guestFunctionKeys,
    entryInstruction,
  };
}

const CONDITIONAL_JUMPS = new Set([
  0x15, 0x1d, 0x25, 0x2d, 0x35, 0x3d, 0x45, 0x4d,
  0x55, 0x5d, 0x65, 0x6d, 0x75, 0x7d, 0xa5, 0xad,
  0xb5, 0xbd, 0xc5, 0xcd, 0xd5, 0xdd,
]);

function isConditionalJump(opcode: number): boolean {
  return CONDITIONAL_JUMPS.has(opcode);
}

const NON_CONTROL_OPCODES = new Set([
  // LDX, immediate stores, and register stores supported by pinned SBPFv0.
  0x61, 0x69, 0x71, 0x79,
  0x62, 0x6a, 0x72, 0x7a,
  0x63, 0x6b, 0x73, 0x7b,
  // ALU32/ALU64 arithmetic, shifts, moves, endianness, and stores.
  0x04, 0x0c, 0x14, 0x1c, 0x24, 0x2c, 0x34, 0x3c,
  0x44, 0x4c, 0x54, 0x5c, 0x64, 0x6c, 0x74, 0x7c,
  0x84, 0x94, 0x9c, 0xa4, 0xac, 0xb4, 0xbc, 0xc4,
  0xcc, 0xd4, 0xdc,
  0x07, 0x0f, 0x17, 0x1f, 0x27, 0x2f, 0x37, 0x3f,
  0x47, 0x4f, 0x57, 0x5f, 0x67, 0x6f, 0x77, 0x7f,
  0x87, 0x8f, 0x97, 0x9f, 0xa7, 0xaf, 0xb7, 0xbf,
  0xc7, 0xcf,
]);

function textInstruction(parsed: ParsedElf, pc: number): { opcode: number; off: number; imm: number } {
  const at = parsed.textBytesOffset + pc * 8;
  return {
    opcode: parsed.bytes[at],
    off: signed16(parsed.view, at + 2),
    imm: signed32(parsed.view, at + 4),
  };
}

function resolveCall(parsed: ParsedElf, pc: number, imm: number): { kind: 'guest'; target: number } | { kind: 'syscall'; symbol: string; returnsToGuest: boolean } | { kind: 'unresolved' } {
  const relocation = parsed.relocationsByInstruction.get(pc);
  if (relocation) {
    const symbol = parsed.dynamicSymbols?.[relocation.symbolIndex];
    if (!symbol) fail('relocation_symbol_out_of_bounds', `CALL_IMM at instruction ${pc} references a missing dynamic symbol`, pc);
    const nameBytes = symbol.loaderNameBytes;
    if (!nameBytes) fail('malformed_dynamic_symbols', `CALL_IMM at instruction ${pc} has no loader-decoded symbol name`, pc);
    if (symbol.type === 2 && symbol.sectionIndex !== SHN_UNDEF && symbol.value !== 0n) {
      if (symbol.sectionIndex !== parsed.text.index) {
        fail('call_symbol_outside_text', `CALL_IMM at instruction ${pc} references function ${symbol.name} outside .text`, pc);
      }
      const symbolTarget = pcForAddress(symbol.value, parsed.text, parsed.instructionCount, parsed.starts, `call symbol ${symbol.name}`);
      // The loader initially registers a dynamic function named "entrypoint"
      // at st_value, then removes that key and installs e_entry after all REL
      // entries are applied. Such a call always dispatches to e_entry.
      const entrypointName = new TextEncoder().encode('entrypoint');
      return { kind: 'guest', target: bytesEqual(nameBytes, entrypointName) ? parsed.entryInstruction : symbolTarget };
    }
    if (
      symbol.sectionIndex === SHN_UNDEF &&
      symbol.value === 0n &&
      (symbol.type === 0 || symbol.type === 2) &&
      (symbol.binding === 1 || symbol.binding === 2) &&
      symbol.name.length > 0
    ) {
      const importKey = murmur3SymbolKey(nameBytes);
      if (parsed.guestFunctionKeys.has(importKey)) {
        fail('ambiguous_import_guest_key_collision', `Import ${symbol.name} hashes to a registered SBFv0 guest-function key`, pc);
      }
      return { kind: 'syscall', symbol: symbol.name, returnsToGuest: !bytesEqual(nameBytes, new TextEncoder().encode('abort')) };
    }
    fail('invalid_call_relocation_symbol', `CALL_IMM at instruction ${pc} has an ambiguous import/function symbol (${symbol.name || `symbol ${symbol.index}`})`, pc);
  }
  if (imm === -1) return { kind: 'unresolved' };
  const target = pc + 1 + imm;
  if (target < 0 || target >= parsed.instructionCount || !parsed.starts[target]) {
    fail('call_target_out_of_text', `CALL_IMM at instruction ${pc} has invalid target ${target}`, pc);
  }
  return { kind: 'guest', target };
}

function addDiagnostic(report: SbfCallDepthReport, code: string, message: string, instructionIndex?: number): void {
  const key = `${code}:${instructionIndex ?? ''}:${message}`;
  if (!report.diagnostics.some((item) => `${item.code}:${item.instructionIndex ?? ''}:${item.message}` === key)) {
    report.diagnostics.push({ code, message, ...(instructionIndex === undefined ? {} : { instructionIndex }) });
  }
}

function analyzeGraph(parsed: ParsedElf, report: SbfCallDepthReport): void {
  const activationStates = new Map<number, { visited: Set<number> }>();
  const pending: Array<{ activationEntry: number; pc: number }> = [];
  const scheduled = new Set<string>();
  const returningActivations = new Set<number>();
  const waitingReturns = new Map<number, Array<{ callerEntry: number; continuation: number }>>();
  const waiterKeys = new Set<string>();
  const ensureActivation = (entry: number) => {
    if (!activationStates.has(entry)) activationStates.set(entry, { visited: new Set() });
  };
  const schedule = (activationEntry: number, pc: number) => {
    const key = `${activationEntry}:${pc}`;
    if (!activationStates.get(activationEntry)!.visited.has(pc) && !scheduled.has(key)) {
      scheduled.add(key);
      pending.push({ activationEntry, pc });
    }
  };
  const markReturning = (entry: number) => {
    if (returningActivations.has(entry)) return;
    returningActivations.add(entry);
    for (const waiter of waitingReturns.get(entry) ?? []) schedule(waiter.callerEntry, waiter.continuation);
  };
  ensureActivation(parsed.entryInstruction);
  schedule(parsed.entryInstruction, parsed.entryInstruction);

  const globalReachableInstructions = new Set<number>();
  const edgesByKey = new Map<string, SbfCallEdge>();
  const syscallsByKey = new Map<string, SbfSyscallEdge>();
  const reachableCallx = new Set<number>();
  const enqueueNext = (activationEntry: number, pc: number, delta: number) => {
    const target = pc + delta;
    if (target < 0 || target >= parsed.instructionCount || !parsed.starts[target]) {
      addDiagnostic(report, 'reachable_fallthrough_out_of_text', `Instruction ${pc} falls through to invalid instruction ${target}`, pc);
    } else schedule(activationEntry, target);
  };

  let processedStateCount = 0;
  while (pending.length > 0) {
    const { activationEntry, pc } = pending.pop()!;
    scheduled.delete(`${activationEntry}:${pc}`);
    const state = activationStates.get(activationEntry)!;
    if (state.visited.has(pc)) continue;
    if (processedStateCount >= MAX_ANALYSIS_STATES) {
      addDiagnostic(
        report,
        'analysis_state_limit',
        `Reachability exceeded ${MAX_ANALYSIS_STATES} activation/instruction states; no complete bound was established`,
      );
      break;
    }
    processedStateCount++;
    state.visited.add(pc);
    globalReachableInstructions.add(pc);
    if (pc < 0 || pc >= parsed.instructionCount || !parsed.starts[pc]) {
      addDiagnostic(report, 'invalid_reachable_instruction_target', `Reachability reached invalid instruction ${pc}`, pc);
      continue;
    }
    const { opcode, off, imm } = textInstruction(parsed, pc);

    if (opcode === EXIT) {
      markReturning(activationEntry);
      continue;
    }
    if (opcode === CALL_REG) {
      reachableCallx.add(pc);
      addDiagnostic(report, 'reachable_callx', `Reachable CALL_REG/callx at instruction ${pc} has no statically bounded target`, pc);
      enqueueNext(activationEntry, pc, 1);
      continue;
    }
    if (opcode === CALL_IMM) {
      try {
        const resolved = resolveCall(parsed, pc, imm);
        if (resolved.kind === 'guest') {
          const edgeKey = `${activationEntry}:${pc}:${resolved.target}`;
          edgesByKey.set(edgeKey, {
            callerEntry: activationEntry,
            callInstruction: pc,
            targetEntry: resolved.target,
            targetSymbols: parsed.symbolLabels.get(resolved.target) ?? [],
            kind: 'guest',
            countsFrame: true,
          });
          ensureActivation(resolved.target);
          schedule(resolved.target, resolved.target);
          const waiterKey = `${activationEntry}:${pc}:${resolved.target}`;
          if (!waiterKeys.has(waiterKey)) {
            waiterKeys.add(waiterKey);
            const waiters = waitingReturns.get(resolved.target) ?? [];
            waiters.push({ callerEntry: activationEntry, continuation: pc + 1 });
            waitingReturns.set(resolved.target, waiters);
          }
          if (returningActivations.has(resolved.target)) enqueueNext(activationEntry, pc, 1);
        } else if (resolved.kind === 'syscall') {
          const key = `${activationEntry}:${pc}:${resolved.symbol}`;
          syscallsByKey.set(key, {
            callerEntry: activationEntry,
            callInstruction: pc,
            symbol: resolved.symbol,
            kind: 'syscall',
            countsFrame: false,
            returnsToGuest: resolved.returnsToGuest,
          });
          if (resolved.returnsToGuest) enqueueNext(activationEntry, pc, 1);
        } else {
          addDiagnostic(report, 'reachable_unresolved_call', `Reachable CALL_IMM at instruction ${pc} has no loader-resolved target or import`, pc);
          enqueueNext(activationEntry, pc, 1);
        }
      } catch (error) {
        if (error instanceof Refusal) addDiagnostic(report, error.code, error.message, error.instructionIndex ?? pc);
        else throw error;
        enqueueNext(activationEntry, pc, 1);
      }
      continue;
    }
    if (opcode === JA) {
      const target = pc + 1 + off;
      if (target < 0 || target >= parsed.instructionCount || !parsed.starts[target]) {
        addDiagnostic(report, 'reachable_branch_target_invalid', `JA at instruction ${pc} targets invalid instruction ${target}`, pc);
      } else schedule(activationEntry, target);
      continue;
    }
    if (isConditionalJump(opcode)) {
      const target = pc + 1 + off;
      if (target < 0 || target >= parsed.instructionCount || !parsed.starts[target]) {
        addDiagnostic(report, 'reachable_branch_target_invalid', `Conditional branch at instruction ${pc} targets invalid instruction ${target}`, pc);
      } else schedule(activationEntry, target);
      enqueueNext(activationEntry, pc, 1);
      continue;
    }
    if (opcode === LDDW) {
      enqueueNext(activationEntry, pc, 2);
      continue;
    }
    if (!NON_CONTROL_OPCODES.has(opcode)) {
      addDiagnostic(report, 'unsupported_reachable_opcode', `Reachable instruction ${pc} uses unsupported SBFv0 opcode 0x${opcode.toString(16).padStart(2, '0')}`, pc);
      continue;
    }
    enqueueNext(activationEntry, pc, 1);
  }

  const edges = [...edgesByKey.values()].sort((a, b) => a.callerEntry - b.callerEntry || a.callInstruction - b.callInstruction || a.targetEntry - b.targetEntry);
  const syscallEdges = [...syscallsByKey.values()].sort((a, b) => a.callerEntry - b.callerEntry || a.callInstruction - b.callInstruction || a.symbol.localeCompare(b.symbol));
  const graph = new Map<number, number[]>();
  for (const activation of activationStates.keys()) graph.set(activation, []);
  for (const edge of edges) {
    const targets = graph.get(edge.callerEntry) ?? [];
    if (!targets.includes(edge.targetEntry)) targets.push(edge.targetEntry);
    graph.set(edge.callerEntry, targets);
  }
  for (const targets of graph.values()) targets.sort((a, b) => a - b);

  report.analysis.reachableInstructionCount = globalReachableInstructions.size;
  report.analysis.reachableActivationEntries = [...activationStates.keys()].sort((a, b) => a - b);
  report.analysis.reachableCallEdges = edges;
  report.analysis.reachableSyscallEdges = syscallEdges;
  report.analysis.reachableCallxInstructions = [...reachableCallx].sort((a, b) => a - b);
  report.analysis.unreachableCallxInstructionCount = Math.max(
    0,
    countOpcode(parsed, CALL_REG) - reachableCallx.size,
  );

  if (report.diagnostics.length > 0) return;

  const color = new Map<number, 0 | 1 | 2>();
  const pathStack: number[] = [];
  const pathIndex = new Map<number, number>();
  const dfs: Array<{ node: number; nextChild: number }> = [];
  const longestLength = new Map<number, number>();
  const bestChild = new Map<number, number | null>();
  let cycle: number[] | null = null;
  color.set(parsed.entryInstruction, 1);
  pathIndex.set(parsed.entryInstruction, 0);
  pathStack.push(parsed.entryInstruction);
  dfs.push({ node: parsed.entryInstruction, nextChild: 0 });
  while (dfs.length > 0) {
    const frame = dfs[dfs.length - 1];
    const children = graph.get(frame.node) ?? [];
    if (frame.nextChild < children.length) {
      const child = children[frame.nextChild++];
      const childColor = color.get(child) ?? 0;
      if (childColor === 1) {
        const start = pathIndex.get(child)!;
        cycle = [...pathStack.slice(start), child];
        break;
      }
      if (childColor === 0) {
        color.set(child, 1);
        pathIndex.set(child, pathStack.length);
        pathStack.push(child);
        dfs.push({ node: child, nextChild: 0 });
      }
      continue;
    }

    let childWithLongestPath: number | null = null;
    let suffixLength = 0;
    for (const child of children) {
      const length = longestLength.get(child) ?? 0;
      if (length > suffixLength) {
        suffixLength = length;
        childWithLongestPath = child;
      }
    }
    longestLength.set(frame.node, suffixLength + 1);
    bestChild.set(frame.node, childWithLongestPath);
    color.set(frame.node, 2);
    dfs.pop();
    pathIndex.delete(frame.node);
    pathStack.pop();
  }
  if (cycle) {
    report.analysis.recursiveCycle = cycle;
    addDiagnostic(report, 'recursive_call_graph', `Reachable direct-call cycle prevents a finite call-depth bound: ${cycle.join(' -> ')}`);
    return;
  }
  const path: number[] = [];
  let cursor: number | null = parsed.entryInstruction;
  while (cursor !== null) {
    path.push(cursor);
    cursor = bestChild.get(cursor) ?? null;
  }
  report.analysis.longestFramePath = path;
  report.analysis.longestFrameCount = path.length;
  if (path.length > report.assumptions.maxActiveFramesIncludingEntry) {
    addDiagnostic(
      report,
      'call_depth_exceeded',
      `Longest reachable path has ${path.length} active guest frames including entry; pinned runtime limit is ${report.assumptions.maxActiveFramesIncludingEntry}`,
    );
  }
}

function countOpcode(parsed: ParsedElf, opcode: number): number {
  let count = 0;
  for (let pc = 0; pc < parsed.instructionCount; pc++) {
    if (parsed.starts[pc] && parsed.bytes[parsed.textBytesOffset + pc * 8] === opcode) count++;
  }
  return count;
}

/** Analyze final linked ELF bytes and return a SHA-256-bound result or refusal. */
export function checkSbfCallDepth(elfBytes: Uint8Array): SbfCallDepthReport {
  const bytes = new Uint8Array(elfBytes);
  const report: SbfCallDepthReport = {
    schemaVersion: 1,
    status: 'refused',
    artifact: { sha256: sha256(bytes), byteLength: bytes.byteLength },
    target: {
      elfType: null,
      machine: null,
      sbpfVersion: null,
      entryInstruction: null,
      textAddress: null,
    },
    assumptions: {
      solanaSbpf: '0.11.1',
      solanaProgramRuntime: '2.3.13',
      maxActiveFramesIncludingEntry: 64,
      frameSizeBytes: 4096,
      checkerMaxTextInstructions: MAX_SBF_INSTRUCTIONS,
      callx: 'reachable instances refused',
      importKeyCollisions: 'refused when an import hash matches a registered guest-function key',
      loaderFunctionKeys: 'numeric target-PC keys use 64-bit host usize bytes; entrypoint and imports use symbol-name bytes',
      loaderEntryPointRemap: 'defined entrypoint relocations resolve to e_entry; colliding numeric PC keys refused',
      loaderRelocationLookup: 'first program header of any type containing DT_REL in p_memsz, else first exact sh_addr section; mismatched SHT_REL bytes refused',
      loaderDynamicTable: 'first PT_DYNAMIC must be an aligned valid slice; invalid PT_DYNAMIC fallback is refused; aligned SHT_DYNAMIC-only files are supported',
      loaderDynamicSymbols: 'first section at DT_SYMTAB and unique literal .dynstr; 64-byte name limit applies only to referenced R_BPF_64_32 symbols',
      relocationTextWrites: 'all loader write ranges checked; outside-to-text writes refused',
      loaderConfiguration: 'reject_broken_elfs=false and enable_symbol_and_section_labels=false; e_flags=0 selects SBPFv0',
      hostUsizeBytes: 8,
      executionEngine: 'interpreter modeled and exercised; JIT equivalence assumed, not verified',
      syscallScope: 'registry is external; imports are checked for guest-key collisions; syscalls are assumed to add no guest frame',
      cpiScope: 'CPI and nested-program call depth are out of scope',
      syscallFrames: 0,
      terminalSyscalls: 'resolved abort import halts under pinned Solana runtime; other syscalls conservatively return',
      controlFlow: 'both conditional outcomes; direct jumps and fallthrough followed',
      maximumActivationInstructionStates: MAX_ANALYSIS_STATES,
    },
    analysis: {
      reachableInstructionCount: 0,
      reachableActivationEntries: [],
      reachableCallEdges: [],
      reachableSyscallEdges: [],
      reachableCallxInstructions: [],
      unreachableCallxInstructionCount: 0,
      longestFrameCount: null,
      longestFramePath: null,
      recursiveCycle: null,
    },
    diagnostics: [],
  };
  try {
    const parsed = parseElf(bytes, report);
    analyzeGraph(parsed, report);
    report.status = report.diagnostics.length === 0 ? 'accepted' : 'refused';
  } catch (error) {
    if (error instanceof Refusal) {
      addDiagnostic(report, error.code, error.message, error.instructionIndex);
      report.status = 'refused';
    } else {
      addDiagnostic(report, 'checker_internal_error', error instanceof Error ? error.message : String(error));
      report.status = 'refused';
    }
  }
  return report;
}
