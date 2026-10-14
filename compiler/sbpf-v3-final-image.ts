// Final-image gate for SBPFv3 programs. It mirrors solana-sbpf 0.14.4's strict
// v3 ELF parser and interpreter call semantics, then proves a static bound on
// active guest frames. It is separate from the SBPFv0 checker
// (compiler/sbf-call-depth.ts), which must not be relabelled for v3.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKER_PATH = fileURLToPath(import.meta.url);

/** Murmur3-32 (seed 0) static syscall keys for the runtime's imports. */
export const SBPF_V3_SYSCALLS: Record<string, number> = {
  sol_set_return_data: 0xa226d3eb,
  sol_get_clock_sysvar: 0xd56b5fe9,
  sol_try_find_program_address: 0x48504a38,
  sol_invoke_signed_c: 0xa22b9c85,
  sol_memcpy_: 0x717cc4a3,
  sol_memmove_: 0x434371f8,
  sol_memset_: 0x3770fb22,
  sol_sha256: 0x11f49d86,
  sol_log_64_: 0x5c2a3178,
  abort: 0xb6fc1a11,
};

export const SBPF_V3_ASSUMPTIONS = {
  runtime: 'solana-sbpf 0.14.4 interpreter / solana-program-runtime 4.0.0 (LiteSVM 0.13.0)',
  maxActiveFramesIncludingEntry: 64,
  frameSizeBytes: 4096,
  stackFrameGaps: false,
  manualStackFrameBump: false,
  syscalls: 'CALL_IMM src=0 dispatches a registered Murmur3 key and adds no guest frame',
  internalCalls: 'CALL_IMM src=1 targets pc+imm+1 and pushes one frame',
  opcodeValidity: 'delegated to the loader verifier at deployment; this gate checks control flow only',
  controlFlow: 'both conditional outcomes followed; syscalls conservatively return',
} as const;

const MM_RODATA_START = 0n;
const MM_REGION_SIZE = 1n << 32n;
const MM_BYTECODE_START = MM_REGION_SIZE;
const PT_LOAD = 1;
const PF_X = 1;
const PF_R = 4;
const EM_BPF = 247;
const ET_DYN = 3;
const MAX_INSTRUCTIONS = 65_536;

export interface SbpfV3Diagnostic { code: string; message: string; pc?: number }
export interface SbpfV3Report {
  schemaVersion: 1;
  profile: 'solana-sbpf-v3';
  status: 'accepted' | 'refused';
  artifact: { sha256: string; byteLength: number };
  checker: { path: string; sha256: string };
  assumptions: typeof SBPF_V3_ASSUMPTIONS;
  text?: { vaddr: string; instructions: number; entryPc: number; rodataBytes: number };
  functions?: number[];
  calls?: { from: number; at: number; to: number }[];
  syscalls?: { at: number; name: string; key: number }[];
  maxActiveFrames?: number;
  longestPath?: number[];
  diagnostics: SbpfV3Diagnostic[];
}

class Refusal extends Error {
  constructor(readonly code: string, message: string, readonly pc?: number) { super(message); }
}
const refuse = (code: string, message: string, pc?: number): never => { throw new Refusal(code, message, pc); };

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function parse(bytes: Uint8Array) {
  if (bytes.length < 64) refuse('ELF_TRUNCATED', 'File is shorter than an ELF64 header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ident = [...bytes.subarray(0, 16)];
  if (ident[0] !== 0x7f || ident[1] !== 0x45 || ident[2] !== 0x4c || ident[3] !== 0x46 ||
      ident[4] !== 2 || ident[5] !== 1 || ident[6] !== 1 || ident[7] !== 0 || ident[8] !== 0 ||
      ident.slice(9).some(byte => byte !== 0)) refuse('ELF_IDENT', 'Expected ELF64 little-endian current version, OSABI 0, zero padding');
  const type = view.getUint16(16, true), machine = view.getUint16(18, true), version = view.getUint32(20, true);
  const entry = view.getBigUint64(24, true), phoff = view.getBigUint64(32, true), flags = view.getUint32(48, true);
  const ehsize = view.getUint16(52, true), phentsize = view.getUint16(54, true), phnum = view.getUint16(56, true);
  if (type !== ET_DYN) refuse('ELF_TYPE', `Expected ET_DYN, found ${type}`);
  if (machine !== EM_BPF || version !== 1) refuse('ELF_MACHINE', `Expected EM_BPF (247) version 1, found ${machine}/${version}`);
  if (flags !== 3) refuse('ELF_FLAGS', `Expected SBPFv3 e_flags 3, found ${flags}`);
  if (phoff !== 64n || ehsize !== 64 || phentsize !== 56 || phnum === 0) refuse('ELF_HEADER', 'Unexpected header sizes or program header offset');
  const tableEnd = 64 + 56 * phnum;
  if (tableEnd > bytes.length) refuse('ELF_PHDR_RANGE', 'Program header table exceeds the file');
  const headers = Array.from({ length: phnum }, (_, index) => {
    const base = 64 + 56 * index;
    return { type: view.getUint32(base, true), flags: view.getUint32(base + 4, true),
      offset: view.getBigUint64(base + 8, true), vaddr: view.getBigUint64(base + 16, true),
      paddr: view.getBigUint64(base + 24, true), filesz: view.getBigUint64(base + 32, true),
      memsz: view.getBigUint64(base + 40, true) };
  });
  const expected: [number, bigint][] = [[PF_R, MM_RODATA_START], [PF_X, MM_BYTECODE_START]];
  const skipRodata = headers[0].flags !== PF_R;
  if (!skipRodata && phnum < 2) refuse('ELF_PHDRS', 'A read-only header requires a following bytecode header');
  const wanted = skipRodata ? expected.slice(1) : expected;
  let expectedOffset = BigInt(tableEnd);
  wanted.forEach(([wantFlags, wantVaddr], index) => {
    const header = headers[index];
    if (!header || header.type !== PT_LOAD || header.flags !== wantFlags || header.offset !== expectedOffset ||
        header.offset >= BigInt(bytes.length) || header.offset % 8n !== 0n || header.vaddr !== wantVaddr ||
        header.paddr !== wantVaddr || header.filesz !== header.memsz ||
        header.filesz > BigInt(bytes.length) - header.offset || header.filesz % 8n !== 0n ||
        header.memsz >= MM_REGION_SIZE) {
      refuse('ELF_PHDR', `Program header ${index} does not match the strict SBPFv3 layout`);
    }
    expectedOffset += header.filesz;
  });
  const bytecode = skipRodata ? headers[0] : headers[1];
  const rodataBytes = skipRodata ? 0 : Number(headers[0].filesz);
  if (entry < bytecode.vaddr || entry + 7n >= bytecode.vaddr + bytecode.memsz || entry % 8n !== 0n) {
    refuse('ELF_ENTRY', 'Entry is outside the bytecode segment or misaligned');
  }
  const count = Number(bytecode.filesz / 8n);
  if (count === 0 || count > MAX_INSTRUCTIONS) refuse('TEXT_SIZE', `Bytecode has ${count} instructions (limit ${MAX_INSTRUCTIONS})`);
  const text = bytes.subarray(Number(bytecode.offset), Number(bytecode.offset + bytecode.filesz));
  return { text, count, entryPc: Number((entry - bytecode.vaddr) / 8n), vaddr: bytecode.vaddr, rodataBytes };
}

type Insn = { opc: number; dst: number; src: number; off: number; imm: number };
function decode(text: Uint8Array, pc: number): Insn {
  const view = new DataView(text.buffer, text.byteOffset + pc * 8, 8);
  const regs = view.getUint8(1);
  return { opc: view.getUint8(0), dst: regs & 0x0f, src: regs >> 4, off: view.getInt16(2, true), imm: view.getInt32(4, true) };
}

const LDDW = 0x18, CALL_IMM = 0x85, CALL_REG = 0x8d, EXIT = 0x95, JA = 0x05;

export function checkSbpfV3FinalImage(input: Uint8Array): SbpfV3Report {
  const bytes = new Uint8Array(input);
  const report: SbpfV3Report = {
    schemaVersion: 1, profile: 'solana-sbpf-v3', status: 'refused',
    artifact: { sha256: sha256(bytes), byteLength: bytes.length },
    checker: { path: path.relative(process.cwd(), CHECKER_PATH), sha256: sha256(fs.readFileSync(CHECKER_PATH)) },
    assumptions: SBPF_V3_ASSUMPTIONS, diagnostics: [],
  };
  try {
    const { text, count, entryPc, vaddr, rodataBytes } = parse(bytes);
    report.text = { vaddr: `0x${vaddr.toString(16)}`, instructions: count, entryPc, rodataBytes };
    // Instruction starts: LDDW occupies two slots; nothing may branch into its second half.
    const starts = new Array<boolean>(count).fill(false);
    for (let pc = 0; pc < count; pc++) {
      starts[pc] = true;
      if (decode(text, pc).opc === LDDW) {
        if (pc + 1 >= count) refuse('LDDW_TRUNCATED', 'LDDW is the last instruction', pc);
        pc++;
      }
    }
    const keyNames = new Map(Object.entries(SBPF_V3_SYSCALLS).map(([name, key]) => [key, name]));
    const calls: NonNullable<SbpfV3Report['calls']> = [];
    const syscalls: NonNullable<SbpfV3Report['syscalls']> = [];
    const callees = new Map<number, Set<number>>();
    const target = (pc: number, delta: number, kind: string) => {
      const next = pc + 1 + delta;
      if (next < 0 || next >= count || !starts[next]) refuse('TARGET', `${kind} target ${next} is outside the bytecode or not an instruction start`, pc);
      return next;
    };
    // Intraprocedural traversal from a function start, recording direct calls.
    const explore = (start: number) => {
      const out = new Set<number>();
      const seen = new Set<number>();
      const work = [start];
      while (work.length) {
        const pc = work.pop()!;
        if (seen.has(pc)) continue;
        seen.add(pc);
        if (pc < 0 || pc >= count || !starts[pc]) refuse('FALLTHROUGH', `Control reaches ${pc} outside the bytecode`, pc);
        const insn = decode(text, pc);
        const cls = insn.opc & 0x07, op = insn.opc & 0xf0;
        const width = insn.opc === LDDW ? 2 : 1;
        if (insn.opc === EXIT) continue;
        if (insn.opc === CALL_REG) refuse('INDIRECT_CALL', 'callx is not supported by this gate', pc);
        if (insn.opc === CALL_IMM) {
          if (insn.src === 1) {
            const callee = target(pc, insn.imm, 'Internal call');
            out.add(callee);
            calls.push({ from: start, at: pc, to: callee });
          } else if (insn.src === 0) {
            const name = keyNames.get(insn.imm >>> 0);
            if (!name) refuse('UNKNOWN_SYSCALL', `Static syscall key 0x${(insn.imm >>> 0).toString(16)} is not an allowed runtime syscall`, pc);
            syscalls.push({ at: pc, name: name!, key: insn.imm >>> 0 });
          } else refuse('CALL_SRC', `CALL_IMM with src=${insn.src} is not a v3 call`, pc);
          work.push(pc + 1);
          continue;
        }
        if (cls === 0x05 || cls === 0x06) {
          if (cls === 0x06 && op === 0x00) refuse('JA32', 'JA is not defined in the JMP32 class', pc);
          if ([0x80, 0x90, 0xe0, 0xf0].includes(op)) refuse('JUMP_OPCODE', `Unexpected jump-class opcode 0x${insn.opc.toString(16)}`, pc);
          const taken = target(pc, insn.off, 'Jump');
          work.push(taken);
          if (insn.opc !== JA) work.push(pc + 1);
          continue;
        }
        work.push(pc + width);
      }
      return out;
    };
    const pending = [entryPc];
    while (pending.length) {
      const start = pending.pop()!;
      if (callees.has(start)) continue;
      const out = explore(start);
      callees.set(start, out);
      pending.push(...out);
    }
    // Longest chain of active frames; any cycle (recursion) is refused.
    const depth = new Map<number, { frames: number; path: number[] }>();
    const active = new Set<number>();
    const visit = (fn: number): { frames: number; path: number[] } => {
      const known = depth.get(fn);
      if (known) return known;
      if (active.has(fn)) refuse('RECURSION', `Call cycle through function at pc ${fn}`, fn);
      active.add(fn);
      let best = { frames: 1, path: [fn] };
      for (const callee of callees.get(fn)!) {
        const below = visit(callee);
        if (below.frames + 1 > best.frames) best = { frames: below.frames + 1, path: [fn, ...below.path] };
      }
      active.delete(fn);
      depth.set(fn, best);
      return best;
    };
    const longest = visit(entryPc);
    report.functions = [...callees.keys()].sort((a, b) => a - b);
    report.calls = calls;
    report.syscalls = syscalls;
    report.maxActiveFrames = longest.frames;
    report.longestPath = longest.path;
    if (longest.frames > SBPF_V3_ASSUMPTIONS.maxActiveFramesIncludingEntry) {
      refuse('CALL_DEPTH', `${longest.frames} active frames exceed ${SBPF_V3_ASSUMPTIONS.maxActiveFramesIncludingEntry}`);
    }
    report.status = 'accepted';
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    report.diagnostics.push({ code: error.code, message: error.message, ...(error.pc === undefined ? {} : { pc: error.pc }) });
  }
  return report;
}

/** Check the exact ELF bytes, write the report, and refuse unless accepted. */
export function acceptSbpfV3FinalImage(elfPath: string, reportPath: string): SbpfV3Report {
  const bytes = fs.readFileSync(elfPath);
  const report = checkSbpfV3FinalImage(bytes);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'accepted') {
    throw new Error(`SBPFV3_FINAL_IMAGE_REFUSED: ${report.diagnostics.map(d => `${d.code}: ${d.message}`).join('; ')}`);
  }
  if (sha256(fs.readFileSync(elfPath)) !== report.artifact.sha256) {
    throw new Error('SBPFV3_FINAL_IMAGE_CHANGED: ELF changed while it was checked');
  }
  return report;
}
