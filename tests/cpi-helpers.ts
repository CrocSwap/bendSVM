import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT = path.join(ROOT, 'build/cpi-helpers-native');
const RUNTIME = path.join(OUT, 'runtime');
const HARNESS = 'tests/cpi-helpers-harness.c';
const U32_MAX = 0xffff_ffff;
const U64_MAX = (1n << 64n) - 1n;
const PREFIX = Buffer.from([0x62, 0x65, 0x6e, 0x64]);
const FLAGS = ['-std=c11', '-O1', '-g', '-fsanitize=address,undefined', '-fno-omit-frame-pointer',
  '-fno-sanitize-recover=all', '-Wall', '-Wextra'];

type Mode = 'custody' | 'validate' | 'execute';
type Meta = { index: number; writable: number; signer: number; key: Buffer };
type Acct = { key: Buffer; owner: Buffer; data: Buffer; lamports: bigint; size: bigint; rentEpoch: bigint;
  signer: number; writable: number; executable: number };
type Input = {
  id: number; name: string; mode: Mode; count: number; active: number; program: number; length: number; metaCount: number;
  rounds: number; initialBump: number; pdaError: bigint; pdaKey: Buffer; pdaBump: number; pdaProgram: Buffer;
  invokeError: [bigint, bigint]; resizeMask: [number, number]; resizeLength: [bigint[], bigint[]];
  programKey: Buffer; data: Buffer; metas: Meta[]; accounts: Acct[];
};

const sha = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const hex = (b: Buffer) => b.toString('hex');
const key = (tag: number) => Buffer.from(Array.from({ length: 32 }, (_, i) => (tag * 43 + i * 17 + Math.floor(i / 8) * 29) & 255));
const equal = (a: Buffer, b: Buffer) => a.equals(b);
const dec = (n: bigint) => n.toString(10);

function accounts(): Acct[] {
  return Array.from({ length: 12 }, (_, i) => ({
    key: key(i + 1), owner: key(60 + i),
    data: Buffer.from(Array.from({ length: 80 }, (_, j) => (i * 37 + j * 13 + 9) & 255)),
    lamports: 1000n + BigInt(i) * 1009n, size: BigInt(5 + i * 3), rentEpoch: 700n + BigInt(i) * 31n,
    signer: i === 1 ? 1 : 0, writable: i === 1 || i === 2 ? 0 : 1, executable: i >= 2 ? 1 : 0,
  }));
}

function fresh(name: string, mode: Mode, count = 4): Input {
  const as = accounts();
  return { id: -1, name, mode, count, active: 1, program: 2, length: 0, metaCount: 0, rounds: mode === 'execute' ? 1 : 0,
    initialBump: 0xe1, pdaError: 0n, pdaKey: Buffer.from(as[3].key), pdaBump: 0x7d, pdaProgram: key(200),
    invokeError: [0n, 0n], resizeMask: [0, 0],
    resizeLength: [as.map(a => a.size), as.map(a => a.size)], programKey: Buffer.from(as[2].key),
    data: Buffer.alloc(64), metas: Array.from({ length: 8 }, (_, i) => ({ index: i, writable: 0, signer: 0, key: key(180 + i) })), accounts: as };
}

function setPayload(x: Input, length: number, tailAt?: number) {
  x.length = length; x.data.fill(0);
  for (let i = 0; i < Math.min(length, 64); ++i) x.data[i] = (i * 23 + 7) & 255;
  if (tailAt !== undefined) x.data[tailAt] = 0xa7;
}
function setMetas(x: Input, values: Array<{ index: number; writable?: number; signer?: number; key?: Buffer }>) {
  x.metaCount = values.length;
  values.forEach((m, i) => { x.metas[i] = { index: m.index, writable: m.writable ?? 0, signer: m.signer ?? 0,
    key: Buffer.from(m.key ?? x.accounts[m.index]?.key ?? key(240 + i)) }; });
}
function validInvoke(name: string, count = 8): Input {
  const x = fresh(name, 'execute', count);
  x.program = Math.min(2 + Math.floor((count - 4) / 2), count - 1);
  x.programKey = Buffer.from(x.accounts[x.program].key); setPayload(x, 5);
  return x;
}

const cases: Input[] = [];
function add(x: Input) { x.id = cases.length; cases.push(x); }

// Custody address derivation, exact u64 errors, returned key comparison and bump propagation.
{
  const x = fresh('custody-correct-seeds-key-bump', 'custody'); x.initialBump = 3; x.pdaBump = 0xc9; add(x);
  for (let chunk = 0; chunk < 4; ++chunk) {
    const y = fresh(`custody-wrong-pda-key-chunk-${chunk}`, 'custody'); y.pdaKey[chunk * 8 + 3] ^= 0x80; add(y);
  }
  const wrongTarget = fresh('custody-result-matches-wrong-account', 'custody'); wrongTarget.pdaKey = Buffer.from(wrongTarget.accounts[2].key); add(wrongTarget);
  for (const rc of [1n, 0x1_0000_0000n, 0x1_0000_0000_019n, U64_MAX]) {
    const y = fresh(`custody-pda-error-${rc}`, 'custody'); y.pdaError = rc; add(y);
  }
  const y = fresh('custody-error-still-reports-mock-bump', 'custody'); y.pdaError = 0x1_0000_0000n; y.initialBump = 0x11; y.pdaBump = 0x92; add(y);
}

// Validator: every supported outer count, boundary, field, precedence class and ignored slot.
for (let n = 4; n <= 12; ++n) {
  const x = fresh(`validate-empty-count-${n}`, 'validate', n); setPayload(x, n % 2 ? 64 : 0); add(x);
}
for (let count = 0; count <= 8; ++count) {
  const x = fresh(`validate-meta-count-${count}`, 'validate', 12);
  setMetas(x, Array.from({ length: count }, (_, i) => ({ index: i, writable: i === 0 ? 1 : 0,
    signer: i === 1 || i === 3 ? 1 : 0 }))); add(x);
}
for (const metaCount of [9, U32_MAX]) {
  const x = fresh(`validate-invalid-meta-count-${metaCount}`, 'validate'); x.metaCount = metaCount; add(x);
}
for (const active of [0, 2, U32_MAX]) {
  const x = fresh(`validate-nonzero-active-${active}`, 'validate'); x.active = active;
  x.program = U32_MAX; x.length = U32_MAX; x.metaCount = U32_MAX; x.data.fill(0xff);
  x.metas.forEach((m, i) => { m.index = U32_MAX - i; m.writable = U32_MAX; m.signer = 2; m.key.fill(0xdd); }); add(x);
}
for (const program of [0, 1, 4, U32_MAX]) {
  const x = fresh(`validate-program-index-${program}`, 'validate'); x.program = program; add(x);
}
{
  const lower = fresh('validate-program-index-one-executable-helper-only', 'validate');
  lower.program = 1; lower.accounts[1].executable = 1; lower.programKey = Buffer.from(lower.accounts[1].key); add(lower);
  const x = fresh('validate-program-equal-outer-count-safe-guard', 'validate', 4); x.program = 4; x.programKey = Buffer.from(x.accounts[4].key); add(x);
  const y = fresh('validate-program-equal-twelve-safe-guard', 'validate', 12); y.program = 12;
  y.programKey = Buffer.alloc(32, 0x5c); add(y);
}
{
  const x = fresh('validate-program-key-mismatch', 'validate'); x.programKey[31] ^= 0x51; add(x);
  const y = fresh('validate-program-non-executable', 'validate'); y.accounts[2].executable = 0; add(y);
  const z = fresh('validate-program-key-last-chunk', 'validate'); z.programKey[30] ^= 0x10; add(z);
}
for (const length of [0, 1, 63, 64]) { const x = fresh(`validate-length-${length}`, 'validate'); setPayload(x, length); add(x); }
for (const length of [65, U32_MAX]) { const x = fresh(`validate-invalid-length-${length}`, 'validate'); x.length = length; add(x); }
for (const badAt of [0, 7, 31, 63]) {
  const x = fresh(`validate-nonzero-tail-at-${badAt}`, 'validate'); setPayload(x, badAt, badAt); add(x);
}
{
  const x = fresh('validate-count-eight-all-meta-slots-and-custody-signer', 'validate', 12);
  setPayload(x, 64); setMetas(x, Array.from({ length: 8 }, (_, i) => ({ index: i, writable: i === 0 ? 1 : 0,
    signer: i === 1 || i === 3 ? 1 : 0 }))); add(x);
  const y = fresh('validate-zero-metas-ignores-all-unused-garbage', 'validate');
  y.metas.forEach((m, i) => { m.index = U32_MAX - i; m.writable = U32_MAX; m.signer = 2; m.key.fill(0xab); }); add(y);
  const z = fresh('validate-one-meta-ignores-seven-unused-garbage', 'validate'); setMetas(z, [{ index: 3 }]);
  z.metas.slice(1).forEach((m, i) => { m.index = U32_MAX - i; m.writable = U32_MAX; m.signer = 2; m.key.fill(0x9d); }); add(z);
}
for (const index of [12, U32_MAX]) {
  const x = fresh(`validate-meta-index-${index}`, 'validate'); setMetas(x, [{ index }]); add(x);
}
{
  const x = fresh('validate-meta-equal-outer-count-safe-guard', 'validate', 4);
  setMetas(x, [{ index: 4, key: x.accounts[4].key }]); add(x);
  const y = fresh('validate-meta-equal-twelve-safe-guard', 'validate', 12);
  setMetas(y, [{ index: 12, key: Buffer.alloc(32, 0x5c) }]); add(y);
}
for (const field of ['writable', 'signer'] as const) for (const v of [2, U32_MAX]) {
  const x = fresh(`validate-meta-${field}-malformed-${v}`, 'validate'); setMetas(x, [{ index: field === 'writable' ? 0 : 1, [field]: v }]); add(x);
}
{
  const x = fresh('validate-writable-escalation', 'validate'); setMetas(x, [{ index: 1, writable: 1 }]); add(x);
  const y = fresh('validate-signer-escalation', 'validate', 8); setMetas(y, [{ index: 4, signer: 1 }]); add(y);
  const z = fresh('validate-actor-signature-forwarding', 'validate'); setMetas(z, [{ index: 1, signer: 1 }]); add(z);
  const c = fresh('validate-custody-signature-exemption', 'validate'); setMetas(c, [{ index: 3, signer: 1 }]); add(c);
  const s = fresh('validate-state-zero-writable-helper-acceptance-only', 'validate'); setMetas(s, [{ index: 0, writable: 1 }]); add(s);
  const d = fresh('validate-duplicate-active-index', 'validate', 8); setMetas(d, [{ index: 4 }, { index: 4 }]); add(d);
}
for (let chunk = 0; chunk < 4; ++chunk) {
  const x = fresh(`validate-meta-key-mismatch-chunk-${chunk}`, 'validate', 8);
  const wrong = Buffer.from(x.accounts[4].key); wrong[chunk * 8 + 5] ^= 0x44; setMetas(x, [{ index: 4, key: wrong }]); add(x);
}
{
  const x = fresh('validate-program-error-precedes-payload-error', 'validate'); x.program = 1; x.length = 65; add(x);
  const y = fresh('validate-payload-error-precedes-meta-error', 'validate'); y.length = 65; setMetas(y, [{ index: U32_MAX }]); add(y);
  const z = fresh('validate-meta-error-order-before-later-duplicate', 'validate');
  setMetas(z, [{ index: 4, writable: 2 }, { index: 4 }]); add(z);
}

// Execute only receives valid effects after the preceding custody and validator calls succeed.
for (let n = 4; n <= 12; ++n) {
  const x = validInvoke(`execute-valid-outer-count-${n}`, n);
  if (n >= 5) setMetas(x, [{ index: 1, signer: 1 }, { index: 3, signer: 1 }, { index: n - 1, writable: 1 }]);
  x.data[0] = n; add(x);
}
{
  const x = validInvoke('execute-all-eight-meta-order-and-full-payload', 12); setPayload(x, 64);
  setMetas(x, Array.from({ length: 8 }, (_, i) => ({ index: i, writable: i === 0 || i === 3 ? 1 : 0,
    signer: i === 1 || i === 3 ? 1 : 0 }))); add(x);
  const y = validInvoke('execute-no-metas-no-custody-signer', 4); y.length = 0; y.data.fill(0); add(y);
  const noCustodySig = validInvoke('execute-custody-meta-without-requested-signature', 8);
  setMetas(noCustodySig, [{ index: 3, signer: 0 }]); add(noCustodySig);
  const z = validInvoke('execute-active-two-native-malformed-source-tag', 4); z.active = 2; setMetas(z, [{ index: 3, signer: 1 }]); add(z);
  const q = validInvoke('execute-active-max-native-malformed-source-tag', 4); q.active = U32_MAX; setMetas(q, [{ index: 3, signer: 1 }]); add(q);
}
{
  const x = validInvoke('execute-syscall-error-exact-small', 8); x.invokeError[0] = 29n;
  x.resizeMask[0] = (1 << 0) | (1 << 7); x.resizeLength[0][0] = 0n; x.resizeLength[0][7] = 71n; add(x);
  for (const rc of [0x1_0000_0000n, 0x1_0000_0000_003n, 0x1_0000_0000_0000_001n, U64_MAX]) {
    const y = validInvoke(`execute-syscall-error-exact-${rc}`, 8);
    y.invokeError[0] = rc; y.resizeMask[0] = (1 << 0) | (1 << 3) | (1 << 7);
    y.resizeLength[0][0] = 0n; y.resizeLength[0][3] = 79n; y.resizeLength[0][7] = 2n; add(y);
  }
  const chain = validInvoke('execute-success-resize-then-second-forwards-new-lengths', 12); chain.rounds = 2;
  setMetas(chain, [{ index: 3, signer: 1 }, { index: 11, writable: 1 }]);
  chain.resizeMask[0] = (1 << 0) | (1 << 3) | (1 << 11);
  chain.resizeLength[0][0] = 0n; chain.resizeLength[0][3] = 79n; chain.resizeLength[0][11] = 1n;
  chain.resizeMask[1] = (1 << 2) | (1 << 7); chain.resizeLength[1][2] = 64n; chain.resizeLength[1][7] = 0n; add(chain);
  const shrink = validInvoke('execute-success-shrink-and-reuse-size', 7); shrink.rounds = 2;
  shrink.resizeMask[0] = 1 << 6; shrink.resizeLength[0][6] = 0n; add(shrink);
}
{
  const x = fresh('execute-inactive-arbitrary-garbage-no-calls-no-changes', 'execute', 12); x.active = 0;
  // Garbage violates effect semantics while keeping any guard-omission mutant memory-safe.
  x.program = 2; x.length = 65; x.metaCount = 8; x.rounds = 2;
  x.data.fill(0xfc); x.invokeError = [U64_MAX, 0x1_0000_0000n]; x.resizeMask = [U32_MAX, U32_MAX];
  x.metas.forEach((m, i) => { m.index = i; m.writable = U32_MAX; m.signer = U32_MAX; m.key.fill(i + 1); }); add(x);
}

{
  const x = validInvoke('execute-normalizes-noncanonical-outer-flags', 12);
  for (const a of x.accounts) {
    if (a.signer) a.signer = 0x80000000;
    if (a.writable) a.writable = 0x80000001;
    if (a.executable) a.executable = U32_MAX;
  }
  add(x);
}

function writer() {
  const chunks: Buffer[] = [];
  return {
    u8(n: number) { const b = Buffer.alloc(1); b.writeUInt8(n); chunks.push(b); },
    u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); chunks.push(b); },
    u64(n: bigint) { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); chunks.push(b); },
    bytes(b: Buffer) { chunks.push(Buffer.from(b)); },
    done() { return Buffer.concat(chunks); },
  };
}
function encodeInput(x: Input): Buffer {
  const w = writer();
  w.u32(x.id); w.u32(({ custody: 1, validate: 2, execute: 3 } as const)[x.mode]); w.u32(x.count);
  w.u32(x.active); w.u32(x.program); w.u32(x.length); w.u32(x.metaCount); w.u32(x.rounds);
  w.u8(x.initialBump); w.bytes(Buffer.alloc(3)); w.u64(x.pdaError); w.bytes(x.pdaKey); w.u8(x.pdaBump); w.bytes(Buffer.alloc(7));
  w.bytes(x.pdaProgram); x.invokeError.forEach(v => w.u64(v)); x.resizeMask.forEach(v => w.u32(v));
  x.resizeLength.forEach(a => a.forEach(v => w.u64(v)));
  w.bytes(x.programKey); w.bytes(x.data);
  x.metas.forEach(m => { w.u32(m.index); w.u32(m.writable); w.u32(m.signer); w.bytes(m.key); });
  x.accounts.forEach(a => { w.bytes(a.key); w.bytes(a.owner); w.bytes(a.data); w.u64(a.lamports); w.u64(a.size);
    w.u64(a.rentEpoch); w.u32(a.signer); w.u32(a.writable); w.u32(a.executable); });
  const b = w.done(); assert.equal(b.length, 2940, `${x.name}: wire size`); return b;
}

function validator(x: Input): bigint {
  if (!x.active) return 0n;
  if (x.program < 2 || x.program >= x.count || !x.accounts[x.program].executable || !equal(x.accounts[x.program].key, x.programKey)) return 19n;
  if (x.length > 64 || x.metaCount > 8) return 20n;
  for (let i = x.length; i < 64; ++i) if (x.data[i]) return 20n;
  const seen = new Set<number>();
  for (let i = 0; i < x.metaCount; ++i) {
    const m = x.metas[i];
    if (m.index >= x.count || m.writable > 1 || m.signer > 1 || !equal(x.accounts[m.index].key, m.key)) return 21n;
    const a = x.accounts[m.index];
    if (m.writable && !a.writable) return 21n;
    if (m.signer && !a.signer && m.index !== 3) return 21n;
    if (seen.has(m.index)) return 21n;
    seen.add(m.index);
  }
  return 0n;
}
function custody(x: Input): bigint { return x.pdaError !== 0n || !equal(x.pdaKey, x.accounts[3].key) ? 11n : 0n; }

function expected(x: Input) {
  const active = x.active !== 0;
  const pdaPresent = x.mode === 'custody' || (x.mode === 'execute' && active);
  const preCustody = pdaPresent ? custody(x) : 0n;
  const preValidate = x.mode === 'execute' && active ? validator(x) : 0n;
  if (x.mode === 'execute' && active) { assert.equal(preCustody, 0n, `${x.name}: valid custody precondition`); assert.equal(preValidate, 0n, `${x.name}: valid validate precondition`); }
  const pda = pdaPresent ? {
    program: hex(x.pdaProgram), seedCount: 2,
    seeds: [{ length: '4', data: hex(PREFIX) }, { length: '32', data: hex(x.accounts[0].key) }],
    returnedKey: hex(x.pdaKey), returnedBump: x.pdaBump, outBump: x.pdaBump,
  } : null;
  const calls: unknown[] = [];
  const sizes = x.accounts.map(a => a.size);
  if (x.mode === 'execute' && active) for (let r = 0; r < x.rounds; ++r) {
    const custodySigner = x.metas.slice(0, x.metaCount).some(m => m.index === 3 && m.signer === 1);
    const resized = sizes.slice();
    for (let i = 0; i < x.count; ++i) if (x.resizeMask[r] & (1 << i)) resized[i] = x.resizeLength[r][i];
    const metas = x.metas.slice(0, x.metaCount).map(m => ({ index: m.index, writable: Number(m.writable !== 0),
      signer: Number(m.signer !== 0), keyPointerOk: 1, key: hex(m.key) }));
    const infos = x.accounts.slice(0, x.count).map((a, i) => ({ key: hex(a.key), owner: hex(a.owner), lamports: dec(a.lamports),
      dataLength: dec(sizes[i]), rentEpoch: dec(a.rentEpoch), signer: Number(a.signer !== 0), writable: Number(a.writable !== 0),
      executable: Number(a.executable !== 0), keyPointerOk: 1, lamportsPointerOk: 1, dataPointerOk: 1, ownerPointerOk: 1 }));
    calls.push({ rawInfoCount: x.count, rawMetaCount: dec(BigInt(x.metaCount)), rawSignerCount: Number(custodySigner),
      infoCount: x.count, metaCount: x.metaCount, programPointerOk: 1, accountsPointerPresent: 1, dataPointerOk: 1,
      signerCount: Number(custodySigner), signerSeedCount: 3,
      signerSeeds: [{ length: '4', data: hex(PREFIX) }, { length: '32', data: hex(x.accounts[0].key) },
        { length: '1', data: hex(Buffer.from([x.pdaBump])) }],
      instructionLength: dec(BigInt(x.length)), syscallError: dec(x.invokeError[r]), program: hex(x.accounts[x.program].key),
      data: hex(x.data), metas, infos, sizesAfterSyscall: resized.slice(0, x.count).map(dec) });
    if (x.invokeError[r] === 0n) for (let i = 0; i < x.count; ++i) sizes[i] = resized[i];
  }
  const result0 = x.mode === 'custody' ? preCustody : x.mode === 'validate' ? validator(x) : (active && x.rounds ? x.invokeError[0] : 0n);
  const result1 = x.mode === 'execute' && active && x.rounds > 1 ? x.invokeError[1] : 0n;
  const effect = { active: x.active, program: x.program, length: x.length, count: x.metaCount, programKey: hex(x.programKey),
    data: hex(x.data), metas: x.metas.map(m => ({ index: m.index, writable: m.writable, signer: m.signer, key: hex(m.key) })) };
  const finalAccounts = x.accounts.map((a, i) => ({ key: hex(a.key), owner: hex(a.owner), data: hex(a.data), lamports: dec(a.lamports),
    size: dec(sizes[i]), rentEpoch: dec(a.rentEpoch), signer: a.signer, writable: a.writable, executable: a.executable }));
  return { id: x.id, preCustody: dec(preCustody), preValidate: dec(preValidate), result0: dec(result0), result1: dec(result1),
    pdaCalls: dec(pdaPresent ? 1n : 0n), invokeCalls: dec(BigInt(calls.length)), pda, calls, effect, accounts: finalAccounts };
}

type Mutant = { name: string; file: 'bend_cpi.h' | 'solana_min.h'; from: string; to: string; occurrence?: number };
const mutants: Mutant[] = [
  { name: 'raw-account-count-above-twelve', file: 'bend_cpi.h', from: 'infos,(int)count,&signer', to: 'infos,count==12 ? 13 : (int)count,&signer' },
  { name: 'raw-meta-count-above-eight', file: 'bend_cpi.h', from: 'metas,t->count,(u8 *)t->data', to: 'metas,t->count==8 ? 9 : t->count,(u8 *)t->data' },
  { name: 'raw-negative-signer-count', file: 'bend_cpi.h', from: '&signer,(int)custody', to: '&signer,custody ? 1 : -1' },
  { name: 'omit-validator-inactive-guard', file: 'bend_cpi.h', from: 'if(!t->active) return 0;', to: '(void)t->active;', occurrence: 1 },
  { name: 'omit-executor-inactive-guard', file: 'bend_cpi.h', from: 'if(!t->active) return 0;', to: '(void)t->active;', occurrence: 2 },
  { name: 'program-lower-bound', file: 'bend_cpi.h', from: 't->program<2', to: 't->program<1' },
  { name: 'program-count-bound', file: 'bend_cpi.h', from: 't->program>=count', to: 't->program>count' },
  { name: 'program-executable-check', file: 'bend_cpi.h', from: '!a[t->program].executable || ', to: '' },
  { name: 'program-key-check', file: 'bend_cpi.h', from: '!equal_key(a[t->program].key,t->program_key)', to: '0' },
  { name: 'payload-length-bound', file: 'bend_cpi.h', from: 't->length>64', to: 't->length>=64' },
  { name: 'meta-count-bound', file: 'bend_cpi.h', from: 't->count>8', to: 't->count>=8' },
  { name: 'tail-start-off-by-one', file: 'bend_cpi.h', from: 'for(unsigned i=t->length;i<64;++i)', to: 'for(unsigned i=t->length+1;i<64;++i)' },
  { name: 'tail-zero-check-omitted', file: 'bend_cpi.h', from: 'if(t->data[i]) return 20;', to: 'if(0) return 20;' },
  { name: 'meta-index-bound', file: 'bend_cpi.h', from: 'm->index>=count', to: 'm->index>count' },
  { name: 'writable-flag-width', file: 'bend_cpi.h', from: 'm->writable>1', to: 'm->writable>2' },
  { name: 'signer-flag-width', file: 'bend_cpi.h', from: 'm->signer>1', to: 'm->signer>2' },
  { name: 'meta-key-equality-check', file: 'bend_cpi.h', from: '!equal_key(a[m->index].key,m->key)', to: '0' },
  { name: 'writable-escalation-check', file: 'bend_cpi.h', from: 'if(m->writable && !a[m->index].writable) return 21;', to: 'if(0) return 21;' },
  { name: 'signer-escalation-check', file: 'bend_cpi.h', from: 'if(m->signer && !a[m->index].signer && m->index!=3) return 21;', to: 'if(0) return 21;' },
  { name: 'custody-signer-exemption-index', file: 'bend_cpi.h', from: 'm->index!=3', to: 'm->index!=2' },
  { name: 'duplicate-meta-check', file: 'bend_cpi.h', from: 'for(unsigned j=0;j<i;++j) if(t->metas[j].index==m->index) return 21;', to: '(void)m;' },
  { name: 'wrong-execution-meta-key-mapping', file: 'bend_cpi.h', from: 'a[m->index].key,m->writable!=0,m->signer!=0', to: 'a[t->program].key,m->writable!=0,m->signer!=0' },
  { name: 'custody-wrong-prefix', file: 'bend_cpi.h', from: "const u8 prefix[4]={'b','e','n','d'};", to: "const u8 prefix[4]={'b','e','n','x'};", occurrence: 1 },
  { name: 'custody-wrong-primary-state-seed', file: 'bend_cpi.h', from: '{a[0].key,32}', to: '{a[1].key,32}', occurrence: 1 },
  { name: 'custody-wrong-pda-result-key', file: 'bend_cpi.h', from: 'equal_key(key,a[3].key)', to: 'equal_key(key,a[2].key)' },
  { name: 'invoke-wrong-prefix', file: 'bend_cpi.h', from: "const u8 prefix[4]={'b','e','n','d'};", to: "const u8 prefix[4]={'b','e','n','x'};", occurrence: 2 },
  { name: 'invoke-wrong-primary-state-seed', file: 'bend_cpi.h', from: '{a[0].key,32}', to: '{a[1].key,32}', occurrence: 2 },
  { name: 'invoke-wrong-bump-seed', file: 'bend_cpi.h', from: '{&bump,1}', to: '{a[3].key,1}' },
  { name: 'custody-signer-even-when-unrequested', file: 'bend_cpi.h', from: 'if(m->index==3 && m->signer) custody=1;', to: 'if(m->index==3) custody=1;' },
  { name: 'custody-signer-never-forwarded', file: 'bend_cpi.h', from: 'if(m->index==3 && m->signer) custody=1;', to: 'if(0) custody=1;' },
  { name: 'instruction-meta-order-reversed', file: 'bend_cpi.h', from: 'const BendInvokeMeta *m=&t->metas[i];metas[i]=', to: 'const BendInvokeMeta *m=&t->metas[t->count-1-i];metas[i]=' },
  { name: 'instruction-meta-count', file: 'bend_cpi.h', from: 'metas,t->count,(u8 *)t->data', to: 'metas,t->count ? t->count-1 : 0,(u8 *)t->data' },
  { name: 'instruction-data-length', file: 'bend_cpi.h', from: '(u8 *)t->data,t->length};', to: '(u8 *)t->data,t->length+1};' },
  { name: 'account-info-count', file: 'bend_cpi.h', from: 'infos,(int)count,&signer', to: 'infos,(int)count-1,&signer' },
  { name: 'info-executable-flag', file: 'bend_cpi.h', from: 'a[i].executable!=0};', to: 'a[i].executable==0};' },
  { name: 'info-writable-flag', file: 'bend_cpi.h', from: 'a[i].writable!=0,a[i].executable', to: '!a[i].writable,a[i].executable' },
  { name: 'info-length-off-by-one', file: 'bend_cpi.h', from: 'a[i].lamports,a[i].size,a[i].data', to: 'a[i].lamports,a[i].size+1,a[i].data' },
  { name: 'syscall-error-truncated-to-u32', file: 'bend_cpi.h', from: 'if(error) return error;', to: 'if(error) return (u32)error;' },
  { name: 'size-refresh-omitted', file: 'bend_cpi.h', from: 'for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;', to: 'for(unsigned i=0;i<count;++i) (void)infos[i].data_len;' },
  { name: 'size-refresh-off-by-one', file: 'bend_cpi.h', from: 'a[i].size=infos[i].data_len;', to: 'a[i].size=infos[i].data_len+1;' },
  { name: 'size-refresh-only-first-n-minus-one', file: 'bend_cpi.h', from: 'for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;', to: 'for(unsigned i=0;i+1<count;++i) a[i].size=infos[i].data_len;' },
  { name: 'size-refresh-despite-syscall-error', file: 'bend_cpi.h',
    from: 'if(error) return error;\n  /* CPI can resize external accounts. Keep later calls\' account-info lengths\n   * synchronized with the syscall\'s updated C account-info records. */\n  for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;\n  return 0;',
    to: '/* CPI can resize external accounts. Keep later calls\' account-info lengths\n   * synchronized with the syscall\'s updated C account-info records. */\n  for(unsigned i=0;i<count;++i) a[i].size=infos[i].data_len;\n  return error;' },
  { name: 'equality-width-three-of-four-key-chunks', file: 'solana_min.h', from: 'i < 32; i += 8', to: 'i < 24; i += 8' },
];

function mutate(source: string, m: Mutant): string {
  let start = -1, from = m.from;
  const occurrence = m.occurrence ?? 1;
  for (let i = 0, pos = 0; i < occurrence; ++i) { start = source.indexOf(from, pos); assert(start >= 0, `${m.name}: mutation anchor missing`); pos = start + from.length; }
  const result = source.slice(0, start) + m.to + source.slice(start + from.length);
  assert.notEqual(result, source, `${m.name}: mutation was a no-op`); return result;
}

function firstDifference(want: unknown, got: unknown, at = '$'): { path: string; expected: unknown; observed: unknown } | undefined {
  if (want === got) return undefined;
  if (typeof want !== typeof got || want === null || got === null || typeof want !== 'object') return { path: at, expected: want, observed: got };
  if (Array.isArray(want) !== Array.isArray(got)) return { path: at, expected: want, observed: got };
  const wk = Object.keys(want as object), gk = Object.keys(got as object);
  if (wk.length !== gk.length || wk.some(k => !gk.includes(k))) return { path: `${at}.$keys`, expected: wk, observed: gk };
  for (const k of wk) { const d = firstDifference((want as Record<string, unknown>)[k], (got as Record<string, unknown>)[k], `${at}.${k}`); if (d) return d; }
  return undefined;
}

const ASAN_ENV = { ...process.env, ASAN_OPTIONS: 'detect_leaks=0:abort_on_error=1:allocator_may_return_null=0',
  UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1' };
function compile(cc: string, harness: string, runtime: string, binary: string) {
  const p = spawnSync(cc, [...FLAGS, `-I${runtime}`, path.join(ROOT, harness), '-o', binary], { encoding: 'utf8', timeout: 90_000 });
  assert(!p.error && p.status === 0, `native compile failed (${p.error?.message ?? p.status})\n${p.stderr ?? ''}`);
  return { stdout: p.stdout ?? '', stderr: p.stderr ?? '' };
}
function execute(binary: string, encoded: Buffer) {
  const p = spawnSync(binary, [], { input: encoded, encoding: 'utf8', env: ASAN_ENV, timeout: 180_000, maxBuffer: 256 << 20 });
  assert(!p.error && p.status === 0, `native run incomplete (${p.error?.message ?? p.status}, signal=${p.signal ?? '-'})\n${(p.stderr ?? '').slice(0, 3000)}`);
  assert.equal(p.stderr, '', `sanitizer/compiler diagnostic during native run\n${p.stderr}`);
  const lines = p.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, cases.length, `partial native output: ${lines.length}/${cases.length} rows`);
  return lines.map((line, i) => {
    try { return JSON.parse(line); } catch (e) { throw new Error(`malformed output row ${i} (${cases[i].name}): ${String(e)}\n${line.slice(0, 500)}`); }
  }) as unknown[];
}

const inputs = ['tests/cpi-helpers.ts', HARNESS, 'runtime/bend_cpi.h', 'runtime/cpi_abi.h', 'runtime/solana_min.h'];
function inputHashes() { return Object.fromEntries(inputs.map(f => [f, sha(fs.readFileSync(path.join(ROOT, f)))])); }

export async function testCpiHelpers() {
  fs.rmSync(path.join(OUT, 'report.json'), { force: true });
  const sourceHashesAtStart = inputHashes();
  fs.mkdirSync(RUNTIME, { recursive: true });
  for (const f of ['bend_cpi.h', 'cpi_abi.h', 'solana_min.h']) {
    fs.copyFileSync(path.join(ROOT, 'runtime', f), path.join(RUNTIME, f));
    assert.equal(sha(fs.readFileSync(path.join(RUNTIME, f))), sourceHashesAtStart[`runtime/${f}`], `${f}: include copy changed`);
  }
  const cc = process.env.CC ?? 'clang';
  const compiler = spawnSync(cc, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  assert(!compiler.error && compiler.status === 0, `cannot query native compiler: ${compiler.error?.message ?? compiler.status}`);
  const encoded = Buffer.concat(cases.map(encodeInput));
  const want = cases.map(expected);
  const binary = path.join(OUT, 'cpi-helpers-native');
  const compileResult = compile(cc, HARNESS, RUNTIME, binary);
  const actual = execute(binary, encoded);
  for (let i = 0; i < want.length; ++i) {
    const d = firstDifference(want[i], actual[i]);
    assert(!d, `actual runtime helper differs from independent oracle: ${cases[i].name} ${d?.path}\nexpected=${JSON.stringify(d?.expected)} observed=${JSON.stringify(d?.observed)}`);
  }
  fs.rmSync(binary, { force: true });
  fs.rmSync(`${binary}.dSYM`, { recursive: true, force: true });

  const bendSource = fs.readFileSync(path.join(RUNTIME, 'bend_cpi.h'), 'utf8');
  const solanaSource = fs.readFileSync(path.join(RUNTIME, 'solana_min.h'), 'utf8');
  const mutationResults: Array<{ name: string; file: string; sha256: string; completedCases: number;
    killedBy: { case: string; path: string } }> = [];
  const work = path.join(OUT, '.mutants'); fs.rmSync(work, { recursive: true, force: true }); fs.mkdirSync(work, { recursive: true });
  for (let i = 0; i < mutants.length; ++i) {
    const m = mutants[i], mutated = mutate(m.file === 'bend_cpi.h' ? bendSource : solanaSource, m);
    const dir = path.join(work, String(i).padStart(2, '0'));
    fs.rmSync(dir, { recursive: true, force: true });
    const runtime = path.join(dir, 'runtime'); fs.mkdirSync(runtime, { recursive: true });
    fs.copyFileSync(path.join(RUNTIME, 'cpi_abi.h'), path.join(runtime, 'cpi_abi.h'));
    fs.copyFileSync(path.join(RUNTIME, 'bend_cpi.h'), path.join(runtime, 'bend_cpi.h'));
    fs.copyFileSync(path.join(RUNTIME, 'solana_min.h'), path.join(runtime, 'solana_min.h'));
    fs.writeFileSync(path.join(runtime, m.file), mutated);
    const mutantBin = path.join(dir, 'mutant');
    compile(cc, HARNESS, runtime, mutantBin);
    const run = execute(mutantBin, encoded);
    let killed: { case: string; path: string } | undefined;
    for (let j = 0; j < want.length; ++j) {
      const d = firstDifference(want[j], run[j]);
      if (d) { killed = { case: cases[j].name, path: d.path }; break; }
    }
    assert(killed, `compiled mutant survived the complete ${cases.length}-case matrix: ${m.name}`);
    mutationResults.push({ name: m.name, file: m.file, sha256: sha(mutated), completedCases: cases.length, killedBy: killed });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });

  const unchanged = inputHashes();
  assert.deepEqual(unchanged, sourceHashesAtStart, 'a tested source input changed during the run; refusing to publish evidence');
  const copiedRuntimeHashes = Object.fromEntries(['bend_cpi.h', 'cpi_abi.h', 'solana_min.h'].map(f =>
    [f, sha(fs.readFileSync(path.join(RUNTIME, f)))]));
  const report = {
    version: 1, passed: true, compiler: compiler.stdout.split('\n')[0], flags: FLAGS, bun: process.versions.bun,
    scope: 'Focused host ASan/UBSan differential execution of the intact runtime/bend_cpi.h custody, validation and execution helper bodies, with only PDA derivation and invoke_signed syscall boundaries mocked. Inputs satisfy valid outer count 4..12 and disjoint valid buffers; active executor cases first pass custody and validation. The independent TypeScript oracle specifies values and syscall observations. This finite native matrix does not prove adapter state-write exclusion, SBF/Clang preservation, or Solana runtime/rollback behavior.',
    assumptions: ['valid outer account count 4..12 and disjoint account buffers', 'active executor calls follow successful custody and validation',
      'executor indices, flags and buffers are unchanged between validation and execution',
      'executor is not used as a validator for invalid indices', 'mocked external changes are limited to AccountInfo.data_len'],
    inputs: sourceHashesAtStart, copiedRuntime: copiedRuntimeHashes,
    matrix: { cases: cases.length, byMode: Object.fromEntries((['custody', 'validate', 'execute'] as const).map(mode =>
      [mode, cases.filter(c => c.mode === mode).length])), namesSha256: sha(cases.map(c => c.name).join('\n')),
      encodedInputSha256: sha(encoded), expectedSha256: sha(JSON.stringify(want)), observedSha256: sha(JSON.stringify(actual)),
      completedRows: actual.length, executeSyscalls: cases.reduce((n, x) => n + (x.mode === 'execute' && x.active ? x.rounds : 0), 0),
      validatorMutableDataPoisoned: true, rawSyscallCountsRecorded: true },
    mutations: mutationResults.length, mutationResults, compilerStdout: compileResult.stdout, compilerStderr: compileResult.stderr,
  };
  const reportPath = path.join(OUT, 'report.json');
  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${reportPath}.tmp`, reportPath);
  console.log(`CPI helpers: ${cases.length} differential cases passed; ${mutationResults.length} compiled mutants killed after complete matrices; report ${reportPath}`);
}

if (import.meta.main) await testCpiHelpers();
