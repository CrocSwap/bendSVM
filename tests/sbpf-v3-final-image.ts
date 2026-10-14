// Negative controls for the SBPFv3 final-image gate, plus a runtime check that
// its 64-frame bound matches LiteSVM 0.13.0 exactly (64 frames run, 65 fault).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { checkSbpfV3FinalImage, SBPF_V3_SYSCALLS } from '../compiler/sbpf-v3-final-image.ts';
import { startTestProgram } from '../sdk/testing.ts';

export async function testSbpfV3FinalImage(acceptedElf: string) {
  const runDir = `build/sbpf-v3-final-image/${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  fs.mkdirSync(runDir, { recursive: true });
  const base = fs.readFileSync(acceptedElf);
  const accepted = checkSbpfV3FinalImage(base);
  assert.equal(accepted.status, 'accepted', JSON.stringify(accepted.diagnostics));
  const results: Record<string, string> = { accepted: 'accepted' };

  const textOffset = (bytes: Buffer) => {
    // Bytecode is the PF_X program header (second when a read-only header is present).
    const phnum = bytes.readUInt16LE(56);
    for (let index = 0; index < phnum; index++) {
      const header = 64 + 56 * index;
      if (bytes.readUInt32LE(header + 4) === 1) return { offset: Number(bytes.readBigUInt64LE(header + 8)), size: Number(bytes.readBigUInt64LE(header + 32)) };
    }
    throw new Error('No bytecode header');
  };
  const find = (bytes: Buffer, predicate: (opc: number, src: number, imm: number) => boolean) => {
    const { offset, size } = textOffset(bytes);
    for (let at = offset; at < offset + size; at += 8) {
      if (predicate(bytes[at], bytes[at + 1] >> 4, bytes.readInt32LE(at + 4))) return at;
      if (bytes[at] === 0x18) at += 8;
    }
    throw new Error('Instruction not found');
  };
  const refusal = (name: string, mutate: (bytes: Buffer) => void, code: string) => {
    const bytes = Buffer.from(base);
    mutate(bytes);
    const report = checkSbpfV3FinalImage(bytes);
    assert.equal(report.status, 'refused', `${name} must be refused`);
    assert.equal(report.diagnostics[0]?.code, code, `${name}: ${JSON.stringify(report.diagnostics)}`);
    results[name] = code;
  };
  refusal('v0-flags', bytes => bytes.writeUInt32LE(0, 48), 'ELF_FLAGS');
  refusal('sbpf-machine', bytes => bytes.writeUInt16LE(263, 18), 'ELF_MACHINE');
  refusal('relocatable', bytes => bytes.writeUInt16LE(1, 16), 'ELF_TYPE');
  refusal('osabi', bytes => { bytes[7] = 3; }, 'ELF_IDENT');
  refusal('entry-outside', bytes => bytes.writeBigUInt64LE(0n, 24), 'ELF_ENTRY');
  refusal('bytecode-vaddr', bytes => {
    const phnum = bytes.readUInt16LE(56);
    for (let index = 0; index < phnum; index++) {
      const header = 64 + 56 * index;
      if (bytes.readUInt32LE(header + 4) === 1) bytes.writeBigUInt64LE(0x200000000n, header + 16);
    }
  }, 'ELF_PHDR');
  refusal('unknown-syscall', bytes => {
    const at = find(bytes, (opc, src) => opc === 0x85 && src === 0);
    bytes.writeUInt32LE(0x12345678, at + 4);
  }, 'UNKNOWN_SYSCALL');
  refusal('self-call', bytes => {
    const at = find(bytes, (opc, src) => opc === 0x85 && src === 1);
    bytes.writeInt32LE(-1, at + 4);
  }, 'RECURSION');
  refusal('call-outside', bytes => {
    const at = find(bytes, (opc, src) => opc === 0x85 && src === 1);
    bytes.writeInt32LE(0x7fffffff, at + 4);
  }, 'TARGET');
  refusal('call-src-2', bytes => {
    const at = find(bytes, (opc, src) => opc === 0x85 && src === 1);
    bytes[at + 1] = (bytes[at + 1] & 0x0f) | 0x20;
  }, 'CALL_SRC');
  refusal('callx', bytes => {
    const at = find(bytes, (opc, src) => opc === 0x85 && src === 1);
    bytes[at] = 0x8d;
  }, 'INDIRECT_CALL');
  refusal('jump-outside', bytes => {
    const at = find(bytes, opc => opc === 0x05);
    bytes.writeInt16LE(0x7fff, at + 2);
  }, 'TARGET');

  // Synthetic call chains: n nested frames including the entry.
  const chain = (frames: number) => {
    const insns: Buffer[] = [];
    const insn = (opc: number, regs: number, off: number, imm: number) => {
      const bytes = Buffer.alloc(8); bytes[0] = opc; bytes[1] = regs; bytes.writeInt16LE(off, 2); bytes.writeInt32LE(imm, 4);
      insns.push(bytes);
    };
    for (let index = 0; index < frames - 1; index++) { insn(0x85, 0x10, 0, 1); insn(0x95, 0, 0, 0); }
    insn(0xb7, 0, 0, 0); insn(0x95, 0, 0, 0);
    const text = Buffer.concat(insns);
    const header = Buffer.alloc(64 + 56);
    header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
    header.writeUInt16LE(3, 16); header.writeUInt16LE(247, 18); header.writeUInt32LE(1, 20);
    header.writeBigUInt64LE(0x100000000n, 24); header.writeBigUInt64LE(64n, 32);
    header.writeUInt32LE(3, 48); header.writeUInt16LE(64, 52); header.writeUInt16LE(56, 54); header.writeUInt16LE(1, 56);
    header.writeUInt32LE(1, 64); header.writeUInt32LE(1, 68); header.writeBigUInt64LE(120n, 72);
    header.writeBigUInt64LE(0x100000000n, 80); header.writeBigUInt64LE(0x100000000n, 88);
    header.writeBigUInt64LE(BigInt(text.length), 96); header.writeBigUInt64LE(BigInt(text.length), 104);
    return Buffer.concat([header, text]);
  };
  const runtime: Record<string, unknown> = {};
  for (const frames of [64, 65]) {
    const elf = path.join(runDir, `chain-${frames}.so`);
    fs.writeFileSync(elf, chain(frames));
    const report = checkSbpfV3FinalImage(fs.readFileSync(elf));
    assert.equal(report.status, frames <= 64 ? 'accepted' : 'refused', `${frames}-frame chain`);
    if (frames <= 64) assert.equal(report.maxActiveFrames, frames);
    else assert.equal(report.diagnostics[0].code, 'CALL_DEPTH');
    // Execute the same bytes: the runtime must agree with the gate.
    const t = await startTestProgram(elf, 'modern');
    const result = await t.send([{ program: t.program, accounts: [], data: [] }]).catch((error: Error) => ({ ok: false, error: String(error) }));
    await t.close();
    runtime[`chain-${frames}`] = result;
    const succeeded = (result as { ok?: boolean }).ok === true;
    assert.equal(succeeded, frames <= 64, `${frames}-frame chain runtime result: ${JSON.stringify(result).slice(0, 400)}`);
    if (!succeeded) assert.match(JSON.stringify(result), /exceeded max BPF to BPF call depth/);
    results[`chain-${frames}`] = report.status;
  }
  assert.equal(Object.keys(SBPF_V3_SYSCALLS).length, 10);
  fs.writeFileSync(path.join(runDir, 'report.json'), JSON.stringify({ acceptedElf, results, runtime }, null, 2) + '\n');
  console.log(`SBPFv3 final-image gate: ${Object.keys(results).length - 3} refusals; 64-frame chain runs, 65-frame chain refused by gate and runtime; ${runDir}/report.json`);
}

if (import.meta.main) await testSbpfV3FinalImage(process.argv[2] ?? 'build/v3-poc/v3/vault.so');
