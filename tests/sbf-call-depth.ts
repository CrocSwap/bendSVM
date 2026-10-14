import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'bun:test';
import { checkSbfCallDepth, type SbfCallDepthReport } from '../compiler/sbf-call-depth.ts';

interface Insn {
  opcode: number;
  off?: number;
  imm?: number;
  registers?: number;
}

interface FixtureSymbol {
  name: string;
  pc: number;
  size?: number;
  binding?: number;
  type?: number;
}

interface DynamicSymbol {
  name: string;
  type?: number;
  binding?: number;
  sectionIndex?: number;
  pc?: number;
  size?: number;
}

interface FixtureRelocation {
  instructionIndex?: number;
  offset?: number;
  symbolName?: string;
  symbolIndex?: number;
  type?: number;
}

interface ElfFixtureOptions {
  instructions: Insn[];
  symbols?: FixtureSymbol[];
  dynamicSymbols?: DynamicSymbol[];
  relocations?: FixtureRelocation[];
  type?: number;
}

interface BuiltFixture {
  bytes: Uint8Array;
  textOffset: number;
  relocationOffset: number;
  dynamicOffset: number;
  sectionHeaderOffset: number;
  sections: Map<string, { index: number; headerOffset: number; fileOffset: number; size: number }>;
}

const align = (value: number, alignment: number): number => Math.ceil(value / alignment) * alignment;

function instruction(opcode: number, options: Omit<Insn, 'opcode'> = {}): Insn {
  return { opcode, ...options };
}

function call(pc: number, target: number): Insn {
  return instruction(0x85, { registers: 0x10, imm: target - pc - 1 });
}

function branch(opcode: number, pc: number, target: number): Insn {
  return instruction(opcode, { off: target - pc - 1 });
}

function encodeInstructions(instructions: Insn[]): Uint8Array {
  const bytes = new Uint8Array(instructions.length * 8);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < instructions.length; index++) {
    const insn = instructions[index];
    const at = index * 8;
    bytes[at] = insn.opcode;
    bytes[at + 1] = insn.registers ?? 0;
    view.setInt16(at + 2, insn.off ?? 0, true);
    view.setInt32(at + 4, insn.imm ?? 0, true);
  }
  return bytes;
}

function buildElf(options: ElfFixtureOptions): BuiltFixture {
  const text = encodeInstructions(options.instructions);
  const symbolInputs = options.symbols ?? [];
  const dynamicInputs = options.dynamicSymbols ?? [];
  const relocInputs = options.relocations ?? [];
  const textOffset = 0x100;
  const dynNames = ['entrypoint', ...dynamicInputs.map((symbol) => symbol.name)];
  const dynstrParts: number[] = [0];
  const dynNameOffsets: number[] = [];
  for (const name of dynNames) {
    dynNameOffsets.push(dynstrParts.length);
    dynstrParts.push(...new TextEncoder().encode(name), 0);
  }
  const dynstr = new Uint8Array(dynstrParts);
  const dynsymCount = 1 + dynNames.length;
  const dynsym = new Uint8Array(dynsymCount * 24);
  const dynsymView = new DataView(dynsym.buffer);
  const dynRecords: DynamicSymbol[] = [
    { name: '', binding: 0, type: 0, sectionIndex: 0, pc: 0, size: 0 },
    { name: 'entrypoint', binding: 1, type: 2, sectionIndex: 1, pc: 0, size: text.length },
    ...dynamicInputs,
  ];
  const dynstrOffset = align(textOffset + text.length, 8);
  const dynsymOffset = align(dynstrOffset + dynstr.length, 8);
  const relocOffset = align(dynsymOffset + dynsym.length, 8);
  const relBytes = new Uint8Array(relocInputs.length * 16);
  const relView = new DataView(relBytes.buffer);
  const dynamicOffset = align(relocOffset + relBytes.length, 8);
  const dynamicTags: Array<[bigint, bigint]> = [];
  if (relocInputs.length > 0) {
    dynamicTags.push(
      [5n, BigInt(dynstrOffset)],
      [10n, BigInt(dynstr.length)],
      [6n, BigInt(dynsymOffset)],
      [11n, 24n],
      [17n, BigInt(relocOffset)],
      [18n, BigInt(relBytes.length)],
      [19n, 16n],
    );
  }
  const dynamicBytes = new Uint8Array((dynamicTags.length + 2) * 16);
  const dynamicView = new DataView(dynamicBytes.buffer);
  dynamicTags.forEach(([tag, value], index) => {
    dynamicView.setBigInt64(index * 16, tag, true);
    dynamicView.setBigUint64(index * 16 + 8, value, true);
  });
  // Keep a second null entry so tests can mutate it into a duplicate DT_* tag.

  const localSymbols = symbolInputs.filter((symbol) => (symbol.binding ?? 0) === 0);
  const globalSymbols = symbolInputs.filter((symbol) => (symbol.binding ?? 0) !== 0);
  const symRecords: FixtureSymbol[] = [
    ...localSymbols,
    { name: 'entrypoint', pc: 0, size: 8, binding: 1, type: 2 },
    ...globalSymbols,
  ];
  const strNames = symRecords.map((symbol) => symbol.name);
  const strParts: number[] = [0];
  const strNameOffsets: number[] = [];
  for (const name of strNames) {
    strNameOffsets.push(strParts.length);
    strParts.push(...new TextEncoder().encode(name), 0);
  }
  const strtab = new Uint8Array(strParts);
  const symtabCount = 1 + strNames.length;
  const symtab = new Uint8Array(symtabCount * 24);
  const symtabView = new DataView(symtab.buffer);
  const strtabOffset = align(dynamicOffset + dynamicBytes.length, 8);
  const symtabOffset = align(strtabOffset + strtab.length, 8);
  const shstrParts: number[] = [0];
  const sectionNames = ['', '.text', '.dynstr', '.dynsym', '.rel.dyn', '.dynamic', '.strtab', '.symtab', '.shstrtab'];
  const sectionNameOffsets: number[] = [];
  for (const name of sectionNames) {
    sectionNameOffsets.push(shstrParts.length);
    shstrParts.push(...new TextEncoder().encode(name), 0);
  }
  const shstrtab = new Uint8Array(shstrParts);
  const shstrtabOffset = align(symtabOffset + symtab.length, 8);
  const sectionHeaderOffset = align(shstrtabOffset + shstrtab.length, 8);
  const sectionCount = sectionNames.length;
  const file = new Uint8Array(sectionHeaderOffset + sectionCount * 64);
  file.set(text, textOffset);
  file.set(dynstr, dynstrOffset);
  file.set(dynsym, dynsymOffset);
  file.set(relBytes, relocOffset);
  file.set(dynamicBytes, dynamicOffset);
  file.set(strtab, strtabOffset);
  file.set(symtab, symtabOffset);
  file.set(shstrtab, shstrtabOffset);

  const allDynRecords = [dynRecords[0], dynRecords[1], ...dynamicInputs];
  const dynOffsets = [0, ...dynNameOffsets];
  for (let index = 0; index < allDynRecords.length; index++) {
    const sym = allDynRecords[index];
    const at = index * 24;
    dynsymView.setUint32(at, dynOffsets[index], true);
    dynsym[index * 24 + 4] = ((sym.binding ?? 0) << 4) | (sym.type ?? 0);
    dynsymView.setUint16(index * 24 + 6, sym.sectionIndex ?? 0, true);
    const symbolValue = index === 0 || (sym.sectionIndex ?? 0) === 0 ? 0n : BigInt(textOffset + (sym.pc ?? 0) * 8);
    dynsymView.setBigUint64(index * 24 + 8, symbolValue, true);
    dynsymView.setBigUint64(index * 24 + 16, BigInt(sym.size ?? 0), true);
  }
  file.set(dynsym, dynsymOffset);

  for (let index = 0; index < relocInputs.length; index++) {
    const rel = relocInputs[index];
    let symbolIndex = rel.symbolIndex;
    if (symbolIndex === undefined && rel.symbolName !== undefined) {
      symbolIndex = dynamicInputs.findIndex((symbol) => symbol.name === rel.symbolName) + 2;
    }
    if (symbolIndex === undefined) symbolIndex = 0;
    const at = index * 16;
    relView.setBigUint64(at, BigInt(rel.offset ?? textOffset + (rel.instructionIndex ?? 0) * 8), true);
    relView.setBigUint64(at + 8, (BigInt(symbolIndex) << 32n) | BigInt(rel.type ?? 10), true);
  }
  file.set(relBytes, relocOffset);

  const symNameOffsets = strNameOffsets;
  for (let index = 0; index < symRecords.length; index++) {
    const sym = symRecords[index];
    const at = (index + 1) * 24;
    symtabView.setUint32(at, symNameOffsets[index], true);
    symtabView.setUint8(at + 4, ((sym.binding ?? (sym.name === 'entrypoint' ? 1 : 0)) << 4) | (sym.type ?? 2));
    symtabView.setUint16(at + 6, 1, true);
    symtabView.setBigUint64(at + 8, BigInt(textOffset + sym.pc * 8), true);
    symtabView.setBigUint64(at + 16, BigInt(sym.size ?? 8), true);
  }
  file.set(symtab, symtabOffset);

  const view = new DataView(file.buffer);
  file.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  view.setUint16(16, options.type ?? 3, true);
  view.setUint16(18, 247, true);
  view.setUint32(20, 1, true);
  view.setBigUint64(24, BigInt(textOffset), true);
  view.setBigUint64(32, 0n, true);
  view.setBigUint64(40, BigInt(sectionHeaderOffset), true);
  view.setUint32(48, 0, true);
  view.setUint16(52, 64, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, 0, true);
  view.setUint16(58, 64, true);
  view.setUint16(60, sectionCount, true);
  view.setUint16(62, sectionCount - 1, true);

  const sections = [
    { name: '', type: 0, flags: 0n, address: 0n, offset: 0, size: 0, link: 0, info: 0, alignment: 0n, entrySize: 0n },
    { name: '.text', type: 1, flags: 6n, address: BigInt(textOffset), offset: textOffset, size: text.length, link: 0, info: 0, alignment: 8n, entrySize: 0n },
    { name: '.dynstr', type: 3, flags: 2n, address: BigInt(dynstrOffset), offset: dynstrOffset, size: dynstr.length, link: 0, info: 0, alignment: 1n, entrySize: 0n },
    { name: '.dynsym', type: 11, flags: 2n, address: BigInt(dynsymOffset), offset: dynsymOffset, size: dynsym.length, link: 2, info: 1, alignment: 8n, entrySize: 24n },
    { name: '.rel.dyn', type: 9, flags: 2n, address: BigInt(relocOffset), offset: relocOffset, size: relBytes.length, link: 3, info: 0, alignment: 8n, entrySize: 16n },
    { name: '.dynamic', type: 6, flags: 3n, address: BigInt(dynamicOffset), offset: dynamicOffset, size: dynamicBytes.length, link: 2, info: 0, alignment: 8n, entrySize: 16n },
    { name: '.strtab', type: 3, flags: 0n, address: 0n, offset: strtabOffset, size: strtab.length, link: 0, info: 0, alignment: 1n, entrySize: 0n },
    { name: '.symtab', type: 2, flags: 0n, address: 0n, offset: symtabOffset, size: symtab.length, link: 6, info: localSymbols.length + 1, alignment: 8n, entrySize: 24n },
    { name: '.shstrtab', type: 3, flags: 0n, address: 0n, offset: shstrtabOffset, size: shstrtab.length, link: 0, info: 0, alignment: 1n, entrySize: 0n },
  ];
  const sectionsInfo = new Map<string, { index: number; headerOffset: number; fileOffset: number; size: number }>();
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    const at = sectionHeaderOffset + index * 64;
    view.setUint32(at, sectionNameOffsets[index], true);
    view.setUint32(at + 4, section.type, true);
    view.setBigUint64(at + 8, section.flags, true);
    view.setBigUint64(at + 16, section.address, true);
    view.setBigUint64(at + 24, BigInt(section.offset), true);
    view.setBigUint64(at + 32, BigInt(section.size), true);
    view.setUint32(at + 40, section.link, true);
    view.setUint32(at + 44, section.info, true);
    view.setBigUint64(at + 48, section.alignment, true);
    view.setBigUint64(at + 56, section.entrySize, true);
    sectionsInfo.set(section.name, { index, headerOffset: at, fileOffset: section.offset, size: section.size });
  }
  return { bytes: file, textOffset, relocationOffset: relocOffset, dynamicOffset, sectionHeaderOffset, sections: sectionsInfo };
}

function writeRelocation(bytes: Uint8Array, at: number, offset: number, symbolIndex: number, type: number): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  view.setBigUint64(at, BigInt(offset), true);
  view.setBigUint64(at + 8, (BigInt(symbolIndex) << 32n) | BigInt(type), true);
}

function addProgramHeaderRelocationAlias(fixture: BuiltFixture, symbolIndex: number): void {
  const originalLength = fixture.bytes.length;
  const bytes = new Uint8Array(originalLength + 16);
  bytes.set(fixture.bytes);
  writeRelocation(bytes, originalLength, fixture.textOffset, symbolIndex, 10);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(32, 64n, true);
  view.setUint16(56, 2, true);
  // The first matching header is PT_NOTE, has no file bytes, but its memory
  // range contains DT_REL. The loader translates through it before considering
  // the later PT_LOAD header; the previous checker skipped it.
  const first = 64;
  view.setUint32(first, 4, true);
  view.setBigUint64(first + 8, BigInt(originalLength), true);
  view.setBigUint64(first + 16, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(first + 24, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(first + 32, 0n, true);
  view.setBigUint64(first + 40, 16n, true);
  view.setBigUint64(first + 48, 8n, true);
  const second = first + 56;
  view.setUint32(second, 1, true);
  view.setBigUint64(second + 8, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(second + 16, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(second + 24, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(second + 32, 16n, true);
  view.setBigUint64(second + 40, 16n, true);
  view.setBigUint64(second + 48, 8n, true);
  fixture.bytes = bytes;
}

function aliasDynstrToAlternateRelocation(fixture: BuiltFixture, symbolIndex: number, symbolName: string): void {
  const view = new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset, fixture.bytes.byteLength);
  const dynstr = fixture.sections.get('.dynstr')!;
  const dynsym = fixture.sections.get('.dynsym')!;
  if (dynsym.fileOffset - dynstr.fileOffset < 23) throw new Error('Fixture .dynstr has no room for relocation alias bytes');
  writeRelocation(fixture.bytes, dynstr.fileOffset, fixture.textOffset, symbolIndex, 10);
  fixture.bytes.set(new TextEncoder().encode(`${symbolName}\0`), dynstr.fileOffset + 16);
  view.setUint32(dynsym.fileOffset + symbolIndex * 24, 16, true);
  view.setBigUint64(dynstr.headerOffset + 16, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(dynstr.headerOffset + 32, 23n, true);
  // The loader ignores DT_STRTAB for name lookup, but the old checker compared
  // this tag to the symbol table's linked .dynstr and therefore needs the same
  // address in the undercount reproduction.
  view.setBigUint64(fixture.dynamicOffset + 8, BigInt(fixture.relocationOffset), true);
  view.setBigUint64(fixture.dynamicOffset + 24, 23n, true);
}

function aliasDynstrAsFirstSymtabSection(fixture: BuiltFixture): void {
  const view = new DataView(fixture.bytes.buffer, fixture.bytes.byteOffset, fixture.bytes.byteLength);
  const dynstr = fixture.sections.get('.dynstr')!;
  const dynsym = fixture.sections.get('.dynsym')!;
  view.setBigUint64(dynstr.headerOffset + 16, BigInt(dynsym.fileOffset), true);
  view.setBigUint64(fixture.dynamicOffset + 8, BigInt(dynsym.fileOffset), true);
}

function accepted(report: SbfCallDepthReport): SbfCallDepthReport {
  assert.equal(report.status, 'accepted', JSON.stringify(report.diagnostics));
  assert.deepEqual(report.diagnostics, []);
  return report;
}

function refused(report: SbfCallDepthReport, code: string): SbfCallDepthReport {
  assert.equal(report.status, 'refused');
  assert.ok(report.diagnostics.some((item) => item.code === code), JSON.stringify(report.diagnostics));
  return report;
}

function matchesCommittedFixture(name: string, bytes: Uint8Array): void {
  const committed = readFileSync(new URL(`./sbf-call-depth-fixtures/${name}`, import.meta.url));
  assert.equal(Buffer.compare(Buffer.from(bytes), committed), 0, `${name} must match its committed loader-probe bytes`);
}

function chainElf(frameCount: number): Uint8Array {
  const instructions: Insn[] = [];
  for (let frame = 0; frame < frameCount; frame++) {
    const entry = frame * 2;
    if (frame + 1 < frameCount) {
      instructions.push(call(entry, entry + 2), instruction(0x95));
    } else {
      instructions.push(instruction(0x95), instruction(0x95));
    }
  }
  return buildElf({ instructions }).bytes;
}

function withPtDynamic(fixture: BuiltFixture, offsetAdjustment: number, keepSectionDynamic = false): Uint8Array {
  const dynamic = fixture.sections.get('.dynamic')!;
  const dynamicBytes = fixture.bytes.slice(dynamic.fileOffset, dynamic.fileOffset + dynamic.size);
  const dynamicOffset = fixture.bytes.length + offsetAdjustment;
  const programHeaderOffset = align(dynamicOffset + dynamic.size, 8);
  const bytes = new Uint8Array(programHeaderOffset + 56);
  bytes.set(fixture.bytes);
  bytes.set(dynamicBytes, dynamicOffset);
  const view = new DataView(bytes.buffer);
  if (!keepSectionDynamic) view.setUint32(dynamic.headerOffset + 4, 1, true); // .dynamic -> SHT_PROGBITS
  view.setBigUint64(32, BigInt(programHeaderOffset), true);
  view.setUint16(56, 1, true);
  view.setUint32(programHeaderOffset, 2, true); // PT_DYNAMIC
  view.setBigUint64(programHeaderOffset + 8, BigInt(dynamicOffset), true);
  view.setBigUint64(programHeaderOffset + 16, BigInt(dynamicOffset), true);
  view.setBigUint64(programHeaderOffset + 32, BigInt(dynamic.size), true);
  view.setBigUint64(programHeaderOffset + 40, BigInt(dynamic.size), true);
  view.setBigUint64(programHeaderOffset + 48, 8n, true);
  return bytes;
}

function withUnalignedSectionDynamic(fixture: BuiltFixture): Uint8Array {
  const dynamic = fixture.sections.get('.dynamic')!;
  const dynamicOffset = fixture.bytes.length + 4;
  const bytes = new Uint8Array(dynamicOffset + dynamic.size);
  bytes.set(fixture.bytes);
  bytes.set(fixture.bytes.subarray(dynamic.fileOffset, dynamic.fileOffset + dynamic.size), dynamicOffset);
  new DataView(bytes.buffer).setBigUint64(dynamic.headerOffset + 24, BigInt(dynamicOffset), true);
  return bytes;
}

describe('final linked SBFv0 call-depth checker', () => {
  it('checks the frozen real codec ELF and distinguishes guest wrappers from syscalls', () => {
    const bytes = readFileSync(new URL('./sbf-call-depth-fixtures/dcg-tag172-identity.frame.so', import.meta.url));
    const report = accepted(checkSbfCallDepth(bytes));
    assert.equal(report.artifact.sha256, '350711998b62f79e866236f2360614f41c5cc7c197c0c2d740fa25cd3876bfaf');
    assert.equal(report.analysis.longestFrameCount, 4);
    assert.deepEqual(report.analysis.longestFramePath, [0, 448, 1431, 2157]);
    assert.ok(report.analysis.reachableCallEdges.some((edge) => edge.targetSymbols.includes('memcpy') && edge.countsFrame), JSON.stringify(report.analysis.reachableCallEdges));
    assert.ok(report.analysis.reachableCallEdges.some((edge) => edge.targetSymbols.includes('memset') && edge.countsFrame));
    assert.ok(report.analysis.reachableSyscallEdges.some((edge) => edge.symbol === 'sol_memcpy_' && !edge.countsFrame));
    assert.ok(report.analysis.reachableSyscallEdges.some((edge) => edge.symbol === 'sol_memset_' && !edge.countsFrame));
    assert.equal(report.analysis.reachableCallxInstructions.length, 0);
    assert.equal(report.assumptions.maxActiveFramesIncludingEntry, 64);
    assert.equal(report.assumptions.hostUsizeBytes, 8);
    assert.match(report.assumptions.executionEngine, /JIT equivalence assumed/);
    assert.match(report.assumptions.syscallScope, /assumed to add no guest frame/);
    assert.match(report.assumptions.cpiScope, /out of scope/);
    assert.match(report.assumptions.loaderFunctionKeys, /target-PC keys/);
    assert.ok(report.assumptions.loaderEntryPointRemap.length > 0);
    assert.ok(report.assumptions.loaderRelocationLookup.length > 0);
    assert.match(report.assumptions.loaderDynamicTable, /invalid PT_DYNAMIC fallback is refused/);
    assert.ok(report.assumptions.loaderDynamicSymbols.includes('unique literal .dynstr'));
    assert.ok(report.assumptions.relocationTextWrites.length > 0);
    assert.match(report.assumptions.loaderConfiguration, /reject_broken_elfs=false/);
    assert.deepEqual(Object.keys(report.assumptions).sort(), [
      'callx',
      'checkerMaxTextInstructions',
      'cpiScope',
      'controlFlow',
      'executionEngine',
      'frameSizeBytes',
      'hostUsizeBytes',
      'importKeyCollisions',
      'loaderConfiguration',
      'loaderDynamicSymbols',
      'loaderDynamicTable',
      'loaderEntryPointRemap',
      'loaderFunctionKeys',
      'loaderRelocationLookup',
      'maximumActivationInstructionStates',
      'maxActiveFramesIncludingEntry',
      'relocationTextWrites',
      'solanaProgramRuntime',
      'solanaSbpf',
      'syscallFrames',
      'syscallScope',
      'terminalSyscalls',
    ].sort());
  });

  it('accepts aligned dynamic tables and refuses PT_DYNAMIC loader-fallback cases', () => {
    const base = buildElf({
      instructions: [instruction(0x85, { imm: 1 }), instruction(0x95), instruction(0x85, { imm: -3 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_log_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_log_' }],
    });
    matchesCommittedFixture('sht-dynamic-aligned.so', base.bytes);
    const sectionReport = accepted(checkSbfCallDepth(base.bytes));
    assert.equal(sectionReport.analysis.longestFrameCount, 1);
    assert.deepEqual(sectionReport.analysis.reachableSyscallEdges.map((edge) => edge.symbol), ['sol_log_']);

    const alignedProgram = withPtDynamic(base, 0);
    matchesCommittedFixture('pt-dynamic-aligned.so', alignedProgram);
    const alignedView = new DataView(alignedProgram.buffer);
    assert.equal(alignedView.getBigUint64(Number(alignedView.getBigUint64(32, true)) + 8, true) % 8n, 0n);
    const programReport = accepted(checkSbfCallDepth(alignedProgram));
    assert.deepEqual(programReport.analysis.reachableSyscallEdges.map((edge) => edge.symbol), ['sol_log_']);

    const unalignedProgram = withPtDynamic(base, 4);
    matchesCommittedFixture('pt-dynamic-unaligned.so', unalignedProgram);
    const unalignedView = new DataView(unalignedProgram.buffer);
    assert.equal(unalignedView.getBigUint64(Number(unalignedView.getBigUint64(32, true)) + 8, true) % 8n, 4n);
    refused(checkSbfCallDepth(unalignedProgram), 'unsupported_dynamic_table_fallback');

    const invalidSize = withPtDynamic(base, 0);
    const invalidSizeView = new DataView(invalidSize.buffer);
    const invalidSizeProgramHeader = Number(invalidSizeView.getBigUint64(32, true));
    invalidSizeView.setBigUint64(invalidSizeProgramHeader + 32, invalidSizeView.getBigUint64(invalidSizeProgramHeader + 32, true) - 1n, true);
    refused(checkSbfCallDepth(invalidSize), 'unsupported_dynamic_table_fallback');

    // These generic range/empty checks are safety-critical: the actual loader
    // silently drops PT_DYNAMIC on slice failure, leaving relative recursive
    // calls where a naive checker might apply syscall relocations.
    for (const [label, offset, size, code] of [
      ['out-of-range', BigInt(alignedProgram.length + 8), 16n, 'elf_range_out_of_bounds'],
      ['overflow', 0xfffffffffffffff8n, 16n, 'elf_arithmetic_overflow'],
      ['empty', 0n, 0n, 'malformed_dynamic_table'],
    ] as const) {
      const bytes = withPtDynamic(base, 0);
      const view = new DataView(bytes.buffer);
      const ph = Number(view.getBigUint64(32, true));
      view.setBigUint64(ph + 8, offset, true);
      view.setBigUint64(ph + 32, size, true);
      const report = checkSbfCallDepth(bytes);
      assert.equal(report.status, 'refused', `${label}: loader fallback must refuse`);
      refused(report, code);
    }

    // When the loader falls back to an aligned SHT_DYNAMIC after the bad first
    // PT_DYNAMIC, the checker still refuses that fallback instead of parsing
    // bytes different from the first program header.
    refused(checkSbfCallDepth(withPtDynamic(base, 4, true)), 'unsupported_dynamic_table_fallback');
    const invalidSizeWithFallback = withPtDynamic(base, 0, true);
    const fallbackView = new DataView(invalidSizeWithFallback.buffer);
    const fallbackProgramHeader = Number(fallbackView.getBigUint64(32, true));
    fallbackView.setBigUint64(fallbackProgramHeader + 32, fallbackView.getBigUint64(fallbackProgramHeader + 32, true) - 1n, true);
    refused(checkSbfCallDepth(invalidSizeWithFallback), 'unsupported_dynamic_table_fallback');
    refused(checkSbfCallDepth(withUnalignedSectionDynamic(base)), 'invalid_dynamic_table_alignment');
  });

  it('checks the frozen mixed Rust/Bend final ELF from entry and leaves unreachable formatting callx out', () => {
    const bytes = readFileSync(new URL('./sbf-call-depth-fixtures/mixed-library.so', import.meta.url));
    const report = accepted(checkSbfCallDepth(bytes));
    assert.equal(report.artifact.sha256, '0aed619c33223d7f3e816b5e800a340fe9107a023e47216ae4a4dc52a0c4aadc');
    assert.equal(report.analysis.longestFrameCount, 4);
    assert.deepEqual(report.analysis.longestFramePath, [1, 304, 298, 0]);
    assert.equal(report.analysis.unreachableCallxInstructionCount, 8);
    assert.deepEqual(report.analysis.reachableCallxInstructions, []);
    assert.ok(report.analysis.reachableCallEdges.some((edge) => edge.targetSymbols.some((name) => name.startsWith('bend_library_v1_call_'))));
  });

  it('accepts 64 active frames including entry and refuses 65', () => {
    const atLimit = accepted(checkSbfCallDepth(chainElf(64)));
    assert.equal(atLimit.analysis.longestFrameCount, 64);
    assert.equal(atLimit.analysis.longestFramePath?.length, 64);
    const over = refused(checkSbfCallDepth(chainElf(65)), 'call_depth_exceeded');
    assert.equal(over.analysis.longestFrameCount, 65);
    assert.equal(over.analysis.longestFramePath?.length, 65);
  });

  it('refuses reachable callx but accepts and reports an unreachable callx', () => {
    const reachable = buildElf({ instructions: [instruction(0x8d, { registers: 0x10 }), instruction(0x95)] });
    const reachableReport = refused(checkSbfCallDepth(reachable.bytes), 'reachable_callx');
    assert.deepEqual(reachableReport.analysis.reachableCallxInstructions, [0]);
    const unreachable = buildElf({ instructions: [instruction(0x95), instruction(0x8d, { registers: 0x10 }), instruction(0x95)] });
    const unreachableReport = accepted(checkSbfCallDepth(unreachable.bytes));
    assert.deepEqual(unreachableReport.analysis.reachableCallxInstructions, []);
    assert.equal(unreachableReport.analysis.unreachableCallxInstructionCount, 1);
    assert.equal(unreachableReport.analysis.longestFrameCount, 1);
  });

  it('refuses direct recursion without treating a repeated instruction loop as recursive calls', () => {
    const recursive = buildElf({
      instructions: [instruction(0xb7), call(1, 0), instruction(0x95)],
    });
    const recursiveReport = refused(checkSbfCallDepth(recursive.bytes), 'recursive_call_graph');
    assert.deepEqual(recursiveReport.analysis.recursiveCycle, [0, 0]);

    const loop = buildElf({
      instructions: [call(0, 2), branch(0x05, 1, 0), instruction(0x95)],
    });
    const loopReport = accepted(checkSbfCallDepth(loop.bytes));
    assert.equal(loopReport.analysis.longestFrameCount, 2);
    assert.equal(loopReport.analysis.reachableCallEdges.length, 1);
  });

  it('follows conditional branches, tail jumps, and fallthrough across misleading symbol sizes', () => {
    const conditional = buildElf({
      instructions: [
        branch(0x15, 0, 3),
        instruction(0x95),
        instruction(0x95),
        call(3, 5),
        instruction(0x95),
        instruction(0x95),
      ],
      symbols: [
        { name: 'entrypoint', pc: 0, size: 8, binding: 1 },
        { name: 'not_really_the_end', pc: 3, size: 8, binding: 0 },
      ],
    });
    const conditionalReport = accepted(checkSbfCallDepth(conditional.bytes));
    assert.ok(conditionalReport.analysis.reachableCallEdges.some((edge) => edge.callerEntry === 0 && edge.callInstruction === 3 && edge.targetEntry === 5));
    assert.equal(conditionalReport.analysis.longestFrameCount, 2);

    const tailJump = buildElf({
      instructions: [
        branch(0x05, 0, 3),
        instruction(0x95),
        instruction(0x95),
        call(3, 5),
        instruction(0x95),
        instruction(0x95),
      ],
      symbols: [
        { name: 'entrypoint', pc: 0, size: 8, binding: 1 },
        { name: 'next_label', pc: 3, size: 8 },
      ],
    });
    const tailReport = accepted(checkSbfCallDepth(tailJump.bytes));
    assert.equal(tailReport.analysis.longestFrameCount, 2);
    assert.equal(tailReport.analysis.reachableCallEdges.length, 1);

    const fallthrough = buildElf({
      instructions: [instruction(0xb7), call(1, 3), instruction(0x95), instruction(0x95)],
      symbols: [
        { name: 'entrypoint', pc: 0, size: 8, binding: 1 },
        { name: 'apparent_second_function', pc: 1, size: 8 },
      ],
    });
    const fallthroughReport = accepted(checkSbfCallDepth(fallthrough.bytes));
    assert.ok(fallthroughReport.analysis.reachableCallEdges.some((edge) => edge.callerEntry === 0 && edge.callInstruction === 1));
    assert.equal(fallthroughReport.analysis.longestFrameCount, 2);
  });

  it('counts a relocated local helper frame and classifies its undefined syscall import without a frame', () => {
    const fixture = buildElf({
      instructions: [call(0, 3), instruction(0x95), instruction(0x95), instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [
        { name: 'memcpy', type: 2, binding: 1, sectionIndex: 1, pc: 3, size: 16 },
        { name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0, pc: 0, size: 0 },
      ],
      relocations: [
        { instructionIndex: 0, symbolName: 'memcpy' },
        { instructionIndex: 3, symbolName: 'sol_memcpy_' },
      ],
      symbols: [{ name: 'memcpy', pc: 3, size: 16, binding: 0 }],
    });
    const report = accepted(checkSbfCallDepth(fixture.bytes));
    assert.equal(report.analysis.longestFrameCount, 2);
    assert.ok(report.analysis.reachableCallEdges.some((edge) => edge.targetSymbols.includes('memcpy') && edge.countsFrame), JSON.stringify(report.analysis.reachableCallEdges));
    assert.deepEqual(report.analysis.reachableSyscallEdges.map((edge) => [edge.symbol, edge.countsFrame]), [['sol_memcpy_', false]]);
  });

  it('maps a relocated function named entrypoint to e_entry after the loader remap', () => {
    const fixture = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95), instruction(0x95)],
      dynamicSymbols: [{ name: 'entrypoint', type: 2, binding: 1, sectionIndex: 1, pc: 2, size: 8 }],
      relocations: [{ instructionIndex: 0, symbolName: 'entrypoint' }],
    });
    matchesCommittedFixture('entrypoint-remap.so', fixture.bytes);
    const report = refused(checkSbfCallDepth(fixture.bytes), 'recursive_call_graph');
    assert.deepEqual(report.analysis.recursiveCycle, [0, 0]);
  });

  it('refuses DT_REL mappings that disagree with the loader first-match memory lookup', () => {
    const fixture = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95), instruction(0x95)],
      dynamicSymbols: [
        { name: 'helper', type: 2, binding: 1, sectionIndex: 1, pc: 2, size: 8 },
        { name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 },
      ],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    addProgramHeaderRelocationAlias(fixture, 2);
    matchesCommittedFixture('dt-rel-phdr-first.so', fixture.bytes);

    // The previous checker skipped PT_NOTE and selected the later PT_LOAD,
    // whose file offset agrees with .rel.dyn; its depth-one result missed the
    // helper relocation selected first by the loader's p_memsz-based scan.
    refused(checkSbfCallDepth(fixture.bytes), 'loader_relocation_bytes_mismatch');
  });

  it('uses the first section-address match for DT_REL, regardless of section type', () => {
    const fixture = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95), instruction(0x95)],
      dynamicSymbols: [
        { name: 'helper', type: 2, binding: 1, sectionIndex: 1, pc: 2, size: 8 },
        { name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 },
      ],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    aliasDynstrToAlternateRelocation(fixture, 2, 'helper');
    matchesCommittedFixture('dt-rel-section-first.so', fixture.bytes);
    refused(checkSbfCallDepth(fixture.bytes), 'loader_relocation_bytes_mismatch');
  });

  it('follows the first DT_SYMTAB section match and the unique literal .dynstr name', () => {
    const badFirstSymtab = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    aliasDynstrAsFirstSymtabSection(badFirstSymtab);
    matchesCommittedFixture('dt-symtab-first-invalid.so', badFirstSymtab.bytes);
    refused(checkSbfCallDepth(badFirstSymtab.bytes), 'loader_symbol_table_mismatch');

    const literalDynstr = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95), instruction(0x95)],
      dynamicSymbols: [{ name: 'helper', type: 2, binding: 1, sectionIndex: 1, pc: 2, size: 8 }],
      relocations: [{ instructionIndex: 0, symbolName: 'helper' }],
    });
    // The section-linked table says "helper"; the pinned loader's last literal
    // .dynstr instead names this defined function "entrypoint", which is then
    // redirected to e_entry. The old checker reports a finite two-frame path.
    const view = new DataView(literalDynstr.bytes.buffer);
    const dynsym = literalDynstr.sections.get('.dynsym')!;
    const strtab = literalDynstr.sections.get('.strtab')!;
    view.setUint32(dynsym.headerOffset + 40, strtab.index, true);
    view.setUint32(dynsym.fileOffset + 2 * 24, 1, true);
    literalDynstr.bytes.set(new TextEncoder().encode('\0helper\0'), strtab.fileOffset);
    // Keep the old checker satisfied by its linked .strtab while making the
    // loader's independent literal .dynstr provide "entrypoint" at st_name=1.
    view.setBigUint64(literalDynstr.dynamicOffset + 8, 0n, true);
    view.setBigUint64(literalDynstr.dynamicOffset + 24, BigInt(strtab.size), true);

    matchesCommittedFixture('dynstr-literal-entrypoint.so', literalDynstr.bytes);
    const literalReport = refused(checkSbfCallDepth(literalDynstr.bytes), 'recursive_call_graph');
    assert.deepEqual(literalReport.analysis.recursiveCycle, [0, 0]);
  });

  it('validates only referenced dynamic symbol names with the pinned 64-byte raw-byte bound', () => {
    const longName = 'x'.repeat(64);
    const fixture = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: longName, type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: longName }],
    });
    refused(checkSbfCallDepth(fixture.bytes), 'malformed_string_table');

    const unusedLongName = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [
        { name: 'sol_log_', type: 0, binding: 1, sectionIndex: 0 },
        { name: 'x'.repeat(64), type: 0, binding: 1, sectionIndex: 0 },
      ],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_log_' }],
    });
    const unusedLongReport = accepted(checkSbfCallDepth(unusedLongName.bytes));
    assert.deepEqual(unusedLongReport.analysis.reachableSyscallEdges.map((edge) => edge.symbol), ['sol_log_']);

    const unusedInvalidUtf8 = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [
        { name: 'sol_log_', type: 0, binding: 1, sectionIndex: 0 },
        { name: 'unreferenced', type: 0, binding: 1, sectionIndex: 0 },
      ],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_log_' }],
    });
    const invalidUtf8View = new DataView(unusedInvalidUtf8.bytes.buffer);
    const dynsym = unusedInvalidUtf8.sections.get('.dynsym')!;
    const dynstr = unusedInvalidUtf8.sections.get('.dynstr')!;
    const unusedNameOffset = invalidUtf8View.getUint32(dynsym.fileOffset + 3 * 24, true);
    unusedInvalidUtf8.bytes[dynstr.fileOffset + unusedNameOffset] = 0xff;
    accepted(checkSbfCallDepth(unusedInvalidUtf8.bytes));

    const referencedInvalidUtf8 = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'invalid', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'invalid' }],
    });
    const referencedView = new DataView(referencedInvalidUtf8.bytes.buffer);
    const referencedDynsym = referencedInvalidUtf8.sections.get('.dynsym')!;
    const referencedDynstr = referencedInvalidUtf8.sections.get('.dynstr')!;
    const referencedNameOffset = referencedView.getUint32(referencedDynsym.fileOffset + 2 * 24, true);
    referencedInvalidUtf8.bytes[referencedDynstr.fileOffset + referencedNameOffset] = 0xff;
    const invalidNameReport = accepted(checkSbfCallDepth(referencedInvalidUtf8.bytes));
    assert.deepEqual(invalidNameReport.analysis.reachableSyscallEdges.map((edge) => edge.symbol), ['�nvalid']);
  });

  it('refuses every relocation write that reaches .text from outside its instruction slot', () => {
    const outside64 = buildElf({
      instructions: [instruction(0x95), instruction(0x95), call(2, 4), instruction(0x95), instruction(0x95)],
      dynamicSymbols: [{ name: 'absolute', type: 0, binding: 1, sectionIndex: 0xfff1 }],
      relocations: [{ offset: 0xf4, symbolName: 'absolute', type: 1 }],
    });
    const outside64View = new DataView(outside64.bytes.buffer);
    outside64View.setBigUint64(outside64.sections.get('.dynsym')!.fileOffset + 2 * 24 + 8, 0x0001_0005_0000_0000n, true);
    matchesCommittedFixture('relocation-write-overlap.so', outside64.bytes);
    refused(checkSbfCallDepth(outside64.bytes), 'relocation_write_overlaps_text');

    const outsideRelative = buildElf({
      instructions: [instruction(0x95)],
      relocations: [{ offset: 0xfc, symbolIndex: 0, type: 8 }],
    });
    refused(checkSbfCallDepth(outsideRelative.bytes), 'relocation_write_overlaps_text');

    const outsideCall = buildElf({
      instructions: [instruction(0x95)],
      relocations: [{ offset: 0xfc, symbolIndex: 0, type: 10 }],
    });
    refused(checkSbfCallDepth(outsideCall.bytes), 'relocation_write_overlaps_text');
  });

  it('rejects relocatable libraries instead of reporting a final-program bound', () => {
    const object = buildElf({ instructions: [instruction(0x95)], type: 1 });
    const report = refused(checkSbfCallDepth(object.bytes), 'not_a_final_program');
    assert.equal(report.target.elfType, 'unsupported');
    assert.equal(report.analysis.longestFrameCount, null);
  });

  it('refuses bad direct and branch targets, including lddw continuations', () => {
    const badCall = buildElf({ instructions: [instruction(0x85, { imm: 200 }), instruction(0x95)] });
    refused(checkSbfCallDepth(badCall.bytes), 'call_target_out_of_text');

    const badBranch = buildElf({ instructions: [branch(0x05, 0, 30), instruction(0x95)] });
    refused(checkSbfCallDepth(badBranch.bytes), 'branch_target_out_of_text');

    const branchIntoWideImmediate = buildElf({
      instructions: [branch(0x05, 0, 2), instruction(0x18), instruction(0), instruction(0x95)],
    });
    refused(checkSbfCallDepth(branchIntoWideImmediate.bytes), 'target_is_lddw_continuation');

    const callIntoWideImmediate = buildElf({
      instructions: [call(0, 2), instruction(0x18), instruction(0), instruction(0x95)],
    });
    refused(checkSbfCallDepth(callIntoWideImmediate.bytes), 'target_is_lddw_continuation');

    const truncatedLddw = buildElf({ instructions: [instruction(0x18)] });
    refused(checkSbfCallDepth(truncatedLddw.bytes), 'truncated_lddw');
  });

  it('refuses malformed, overflowing, ambiguous, and misclassified ELF relocation data', () => {
    refused(checkSbfCallDepth(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])), 'truncated_elf_header');

    const overflowSections = buildElf({ instructions: [instruction(0x95)] });
    new DataView(overflowSections.bytes.buffer).setBigUint64(40, 0xffff_ffff_ffff_ffffn, true);
    refused(checkSbfCallDepth(overflowSections.bytes), 'elf_arithmetic_overflow');

    const duplicatedText = buildElf({ instructions: [instruction(0x95)] });
    const sectionView = new DataView(duplicatedText.bytes.buffer);
    const textNameOffset = sectionView.getUint32(duplicatedText.sectionHeaderOffset + 64, true);
    const dynstrHeader = duplicatedText.sections.get('.dynstr')!.headerOffset;
    sectionView.setUint32(dynstrHeader, textNameOffset, true);
    refused(checkSbfCallDepth(duplicatedText.bytes), 'unsupported_text_sections');

    const overlappingSections = buildElf({ instructions: [instruction(0x95)] });
    const overlappingView = new DataView(overlappingSections.bytes.buffer);
    overlappingView.setBigUint64(overlappingSections.sections.get('.dynstr')!.headerOffset + 24, BigInt(overlappingSections.textOffset), true);
    refused(checkSbfCallDepth(overlappingSections.bytes), 'ambiguous_section_overlap');

    const duplicateDynstr = buildElf({ instructions: [instruction(0x95)] });
    const duplicateDynstrView = new DataView(duplicateDynstr.bytes.buffer);
    const duplicateDynstrHeader = duplicateDynstr.sections.get('.dynstr')!.headerOffset;
    const strtabHeader = duplicateDynstr.sections.get('.strtab')!.headerOffset;
    duplicateDynstrView.setUint32(strtabHeader, duplicateDynstrView.getUint32(duplicateDynstrHeader, true), true);
    refused(checkSbfCallDepth(duplicateDynstr.bytes), 'duplicate_loader_section_name');

    const malformedRel = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    const malformedRelView = new DataView(malformedRel.bytes.buffer);
    malformedRelView.setBigUint64(malformedRel.sections.get('.rel.dyn')!.headerOffset + 32, 1n, true);
    refused(checkSbfCallDepth(malformedRel.bytes), 'loader_relocation_bytes_mismatch');

    const truncatedRel = buildElf({
      instructions: [instruction(0x85, { registers: 0x10, imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    const chopped = truncatedRel.bytes.subarray(0, truncatedRel.relocationOffset + 8);
    refused(checkSbfCallDepth(chopped), 'elf_range_out_of_bounds');

    const overflowReloc = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    new DataView(overflowReloc.bytes.buffer).setBigUint64(overflowReloc.relocationOffset, 0xffff_ffff_ffff_ffffn, true);
    refused(checkSbfCallDepth(overflowReloc.bytes), 'relocation_offset_out_of_bounds');

    const duplicateRelocation = buildElf({
      instructions: [instruction(0x85, { registers: 0x10, imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [
        { instructionIndex: 0, symbolName: 'sol_memcpy_' },
        { instructionIndex: 0, symbolName: 'sol_memcpy_' },
      ],
    });
    refused(checkSbfCallDepth(duplicateRelocation.bytes), 'ambiguous_relocation');

    const badRelocationSymbolIndex = buildElf({
      instructions: [instruction(0x85, { registers: 0x10, imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    new DataView(badRelocationSymbolIndex.bytes.buffer).setBigUint64(
      badRelocationSymbolIndex.relocationOffset + 8,
      (0xffff_ffffn << 32n) | 10n,
      true,
    );
    refused(checkSbfCallDepth(badRelocationSymbolIndex.bytes), 'relocation_symbol_out_of_bounds');

    const unsupportedNoneRelocation = buildElf({
      instructions: [instruction(0x85, { registers: 0x10, imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_', type: 0 }],
    });
    refused(checkSbfCallDepth(unsupportedNoneRelocation.bytes), 'unsupported_relocation_type');

    const wrongImport = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 1, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    const wrongImportReport = refused(checkSbfCallDepth(wrongImport.bytes), 'invalid_call_relocation_symbol');
    assert.match(wrongImportReport.diagnostics[0].message, /ambiguous import\/function symbol/);

    const ambiguousImport = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [
        { name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 },
        { name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 },
      ],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    const duplicateImportReport = accepted(checkSbfCallDepth(ambiguousImport.bytes));
    assert.deepEqual(duplicateImportReport.analysis.reachableSyscallEdges.map((edge) => edge.symbol), ['sol_memcpy_']);

    const guestKeyCollision = buildElf({
      instructions: [instruction(0x85, { registers: 0x10, imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'entrypoint', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'entrypoint' }],
    });
    refused(checkSbfCallDepth(guestKeyCollision.bytes), 'ambiguous_import_guest_key_collision');

    const dynamicFunctionNameCollision = buildElf({
      instructions: [
        instruction(0x85, { registers: 0x10, imm: -1 }),
        instruction(0x95),
        instruction(0x85, { registers: 0x10, imm: -1 }),
        instruction(0x95),
      ],
      dynamicSymbols: [
        { name: 'helper', type: 0, binding: 1, sectionIndex: 0 },
        { name: 'helper', type: 2, binding: 1, sectionIndex: 1, pc: 2, size: 8 },
      ],
      relocations: [
        { instructionIndex: 0, symbolIndex: 2 },
        { instructionIndex: 2, symbolIndex: 3 },
      ],
    });
    const dynamicNameKeyReport = accepted(checkSbfCallDepth(dynamicFunctionNameCollision.bytes));
    assert.equal(dynamicNameKeyReport.analysis.longestFrameCount, 1);
    assert.deepEqual(dynamicNameKeyReport.analysis.reachableSyscallEdges.map((edge) => edge.symbol), ['helper']);

    // murmur3("guest_collision_8338") equals the loader key for numeric target PC 12670.
    const numericGuestKeyCollision = buildElf({
      instructions: [
        instruction(0x85, { registers: 0x10, imm: -1 }),
        instruction(0x95),
        call(2, 12_670),
        ...Array.from({ length: 12_668 }, () => instruction(0x95)),
      ],
      dynamicSymbols: [{ name: 'guest_collision_8338', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'guest_collision_8338' }],
    });
    const numericCollisionReport = refused(checkSbfCallDepth(numericGuestKeyCollision.bytes), 'ambiguous_import_guest_key_collision');
    assert.match(numericCollisionReport.diagnostics[0].message, /guest_collision_8338 hashes to a registered SBFv0 guest-function key/);

    const duplicateTag = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_memcpy_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_memcpy_' }],
    });
    const dynamicView = new DataView(duplicateTag.bytes.buffer);
    const nullTag = duplicateTag.dynamicOffset + 7 * 16;
    dynamicView.setBigInt64(nullTag, 17n, true);
    dynamicView.setBigUint64(nullTag + 8, BigInt(duplicateTag.relocationOffset), true);
    refused(checkSbfCallDepth(duplicateTag.bytes), 'ambiguous_dynamic_tag');
  });
});

describe('terminal abort profile', () => {
  it('stops only after a loader-resolved abort import', () => {
    const f = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x8d, { imm: 1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'abort', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'abort' }],
    });
    const r = accepted(checkSbfCallDepth(f.bytes));
    assert.equal(r.analysis.reachableInstructionCount, 1);
    assert.equal(r.analysis.unreachableCallxInstructionCount, 1);
    assert.equal(r.analysis.reachableSyscallEdges[0].returnsToGuest, false);
  });
  it('does not resume a caller after a nonreturning guest wrapper', () => {
    const f = buildElf({
      instructions: [call(0,3), instruction(0x8d, { imm: 1 }), instruction(0x95), instruction(0x85, { imm: -1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'abort', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 3, symbolName: 'abort' }],
    });
    const r = accepted(checkSbfCallDepth(f.bytes));
    assert.equal(r.analysis.longestFrameCount, 2);
    assert.equal(r.analysis.reachableInstructionCount, 2);
  });
  it('preserves a returning syscall continuation', () => {
    const f = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x8d, { imm: 1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'sol_log_', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: 'sol_log_' }],
    });
    const r = refused(checkSbfCallDepth(f.bytes), 'reachable_callx');
    assert.equal(r.analysis.reachableSyscallEdges[0].returnsToGuest, true);
  });
  it('does not make a returning guest function named abort terminal', () => {
    const f = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x8d, { imm: 1 }), instruction(0x95), instruction(0x95)],
      dynamicSymbols: [{ name: 'abort', type: 2, binding: 1, sectionIndex: 1, pc: 3, size: 8 }],
      relocations: [{ instructionIndex: 0, symbolName: 'abort' }],
    });
    const r = refused(checkSbfCallDepth(f.bytes), 'reachable_callx');
    assert.equal(r.analysis.reachableSyscallEdges.length, 0);
  });
  it('keeps both conditional outcomes before abort', () => {
    const f = buildElf({
      instructions: [branch(0x15,0,2), instruction(0x85, { imm: -1 }), instruction(0x8d, { imm: 1 }), instruction(0x95)],
      dynamicSymbols: [{ name: 'abort', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 1, symbolName: 'abort' }],
    });
    refused(checkSbfCallDepth(f.bytes), 'reachable_callx');
  });
  it('does not treat unresolved calls as terminal', () => {
    const f = buildElf({instructions: [instruction(0x85, { imm: -1 }), instruction(0x8d, { imm: 1 }), instruction(0x95)]});
    const r = refused(checkSbfCallDepth(f.bytes), 'reachable_unresolved_call');
    assert.deepEqual(r.analysis.reachableCallxInstructions,[1]);
  });
  it('uses raw loader bytes rather than the decoded edge label', () => {
    // TextDecoder strips a UTF-8 BOM, so this import is displayed as abort,
    // but has a different loader key and must conservatively return.
    const f = buildElf({
      instructions: [instruction(0x85, { imm: -1 }), instruction(0x8d, { imm: 1 }), instruction(0x95)],
      dynamicSymbols: [{ name: '\ufeffabort', type: 0, binding: 1, sectionIndex: 0 }],
      relocations: [{ instructionIndex: 0, symbolName: '\ufeffabort' }],
    });
    const r = refused(checkSbfCallDepth(f.bytes), 'reachable_callx');
    assert.equal(r.analysis.reachableSyscallEdges[0].symbol, 'abort');
    assert.equal(r.analysis.reachableSyscallEdges[0].returnsToGuest, true);
  });
});

describe('terminal abort continuation boundaries', () => {
 it('retains a caller continuation when another callee branch returns', () => {
  const f=buildElf({
   instructions:[call(0,3),instruction(0x8d,{imm:1}),instruction(0x95),branch(0x15,3,6),instruction(0x85,{imm:-1}),instruction(0x8d,{imm:1}),instruction(0x95)],
   dynamicSymbols:[{name:'abort',type:0,binding:1,sectionIndex:0}],
   relocations:[{instructionIndex:4,symbolName:'abort'}],
  });
  const r=refused(checkSbfCallDepth(f.bytes),'reachable_callx');
  assert.deepEqual(r.analysis.reachableCallxInstructions,[1]);
  assert.equal(r.analysis.unreachableCallxInstructionCount,1);
 });
 it('still refuses a recursive alternative to an abort branch', () => {
  const f=buildElf({
   instructions:[call(0,3),instruction(0x95),instruction(0x95),branch(0x15,3,6),instruction(0x85,{imm:-1}),instruction(0x95),call(6,3),instruction(0x95)],
   dynamicSymbols:[{name:'abort',type:0,binding:1,sectionIndex:0}],
   relocations:[{instructionIndex:4,symbolName:'abort'}],
  });
  const r=refused(checkSbfCallDepth(f.bytes),'recursive_call_graph');
  assert.deepEqual(r.analysis.recursiveCycle,[3,3]);
 });
});
