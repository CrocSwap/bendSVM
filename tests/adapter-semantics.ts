import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Backend, checkedBook, mangle } from '../compiler/backend.ts';
import { emitCodecs } from '../compiler/codecs.ts';
import { emitStorage } from '../compiler/storage.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';

// Bounded semantic execution of the emitted ABI 1 adapter. The adapter text is
// compiled unchanged for the host under ASan/UBSan together with
// tests/adapter-semantics-harness.h, which scripts the boundary (syscalls,
// custody, effect validation/execution) and wraps the generated codecs and
// Bend root. Every scenario's return code, boundary call trace, state bytes,
// return data and executed-effect count are compared with `contract` below,
// which is written from docs/adapter-assurance.md and never reads emitted C.
//
// This is native execution of the actual C under explicit mocks. It is not a
// proof about C, Clang, SBF or the Solana runtime; the real token/CPI helper
// bodies and the loader are outside it, and rollback of already executed
// external effects is a Solana transaction assumption that is only recorded.
type EffectKind = 'none' | 'token' | 'cpi';
type Value = number | boolean | { c: string; f?: Record<string, Value> };
type Expect = { accept: Value } | { reject: number };
type Case = { name: string; mode: 0 | 1; prior?: Value; ix: Value; actorSigner: boolean; expect: Expect;
  active?: number[]; stateWritable?: boolean[]; guard?: boolean };
type Fixture = { name: string; source: string; effects: EffectKind; cases: Case[] };

const SLOT = { c: 'U64', f: { lo: 0x55667788, hi: 0x11223344 } };
// Mirrors asem_key: byte j is 0x20 + index + 7j, words are little-endian.
const keyByte = (index: number, j: number) => (0x20 + index + 7 * j) & 0xff;
const key = (index: number): Value => ({ c: 'Key', f: Object.fromEntries('abcdefgh'.split('').map((n, w) =>
  [n, [3, 2, 1, 0].reduce((v, b) => v * 256 + keyByte(index, 4 * w + b), 0)])) });
const u64 = (lo: number): Value => ({ c: 'U64', f: { lo, hi: 0 } });
const stored = (owner: number, value: number, slot: Value): Value => ({ c: 'Stored', f: { owner: key(owner), value, slot } });
const count = (n: number): Value => ({ c: 'State', f: { count: n } });
const meta = (index: number, writable: boolean): Value => ({ c: 'Meta', f: { index, key: key(index), writable, signer: false } });
const bytes64 = (first: number): Value =>
  ({ c: 'Bytes64', f: Object.fromEntries('abcdefghijklmnop'.split('').map((n, i) => [n, i ? 0 : first])) });
const invoke = (metas: Value[]): Value => ({ c: 'Invoke', f: { program: 2, program_key: key(2), length: 4,
  data: bytes64(0x04030201),
  count: metas.length,
  accounts: { c: 'Metas', f: Object.fromEntries('abcdefgh'.split('').map((n, i) => [n, metas[i] ?? meta(0, false)])) } } });
const run = (effect: Value): Value => ({ c: 'Run', f: { effect } });
const runPair = (effect: Value): Value => ({ c: 'Run', f: { effect, second_data: bytes64(0x08070605) } });
const roundTrip: Value = { c: 'RoundTrip', f: { mint: key(6), deposit: u64(5), withdrawal: u64(3) } };
const three: Value = { c: 'Run', f: { mint: key(6), first: u64(1), second: u64(2), third: u64(3), last_mint: 6 } };

// Expected root results are stated by hand from each fixture's Bend source.
const fixtures: Fixture[] = [
  { name: 'pure', source: 'tests/storage.bend', effects: 'none', cases: [
    { name: 'initialize', mode: 0, ix: { c: 'Initialize', f: { value: 42 } }, actorSigner: true,
      expect: { accept: stored(1, 42, SLOT) }, guard: true },
    { name: 'initialize-unsigned', mode: 0, ix: { c: 'Initialize', f: { value: 42 } }, actorSigner: false, expect: { reject: 1 } },
    { name: 'initialize-set', mode: 0, ix: { c: 'Set', f: { value: 5 } }, actorSigner: true, expect: { reject: 2 } },
    { name: 'set', mode: 1, prior: stored(1, 7, u64(1)), ix: { c: 'Set', f: { value: 9 } }, actorSigner: true,
      expect: { accept: stored(1, 9, SLOT) }, guard: true },
    { name: 'set-foreign-owner', mode: 1, prior: stored(9, 7, u64(1)), ix: { c: 'Set', f: { value: 9 } }, actorSigner: true,
      expect: { reject: 1 } },
    { name: 'set-reinitialize', mode: 1, prior: stored(1, 7, u64(1)), ix: { c: 'Initialize', f: { value: 9 } }, actorSigner: true,
      expect: { reject: 3 } },
    { name: 'stored-empty-initialize', mode: 1, prior: { c: 'Empty' }, ix: { c: 'Initialize', f: { value: 3 } }, actorSigner: true,
      expect: { accept: stored(1, 3, SLOT) } },
  ] },
  { name: 'token', source: 'tests/settlement.bend', effects: 'token', cases: [
    { name: 'initialize', mode: 0, ix: roundTrip, actorSigner: true, expect: { accept: count(1) }, active: [1, 1], guard: true },
    { name: 'initialize-unsigned', mode: 0, ix: roundTrip, actorSigner: false, expect: { reject: 1 } },
    { name: 'transition', mode: 1, prior: count(41), ix: roundTrip, actorSigner: true, expect: { accept: count(42) },
      active: [1, 1], guard: true },
    // Changes the final payload byte, so a short commit is observable.
    { name: 'transition-carry', mode: 1, prior: count(0xfeffffff), ix: roundTrip, actorSigner: true,
      expect: { accept: count(0xff000000) }, active: [1, 1] },
  ] },
  { name: 'token-three', source: 'tests/token-three.bend', effects: 'token', cases: [
    { name: 'initialize', mode: 0, ix: three, actorSigner: false, expect: { accept: count(1) }, active: [1, 1, 1], guard: true },
    { name: 'transition', mode: 1, prior: count(41), ix: three, actorSigner: true, expect: { accept: count(42) },
      active: [1, 1, 1], guard: true },
    { name: 'transition-carry', mode: 1, prior: count(0xfeffffff), ix: three, actorSigner: true,
      expect: { accept: count(0xff000000) }, active: [1, 1, 1] },
  ] },
  { name: 'cpi', source: 'tests/cpi.bend', effects: 'cpi', cases: [
    { name: 'initialize', mode: 0, ix: run(invoke([meta(5, true)])), actorSigner: true, expect: { accept: count(1) },
      active: [1, 0], guard: true },
    { name: 'transition', mode: 1, prior: count(41), ix: run(invoke([meta(5, true), meta(4, false)])), actorSigner: false,
      expect: { accept: count(42) }, active: [1, 0], guard: true },
    { name: 'transition-carry', mode: 1, prior: count(0xfeffffff), ix: run(invoke([meta(5, true)])), actorSigner: true,
      expect: { accept: count(0xff000000) }, active: [1, 0] },
    { name: 'no-effect', mode: 1, prior: count(41), ix: run({ c: 'None' }), actorSigner: true, expect: { accept: count(42) },
      active: [0, 0] },
    { name: 'state-readonly-meta', mode: 1, prior: count(41), ix: run(invoke([meta(0, false)])), actorSigner: true,
      expect: { accept: count(42) }, active: [1, 0] },
    // A CPI must never receive this adapter's state account as writable.
    { name: 'state-writable-meta', mode: 1, prior: count(41), ix: run(invoke([meta(5, false), meta(0, true)])), actorSigner: true,
      expect: { accept: count(42) }, active: [1, 0], stateWritable: [true, false] },
    { name: 'state-writable-meta-init', mode: 0, ix: run(invoke([meta(0, true)])), actorSigner: true,
      expect: { accept: count(1) }, active: [1, 0], stateWritable: [true, false] },
  ] },
  // The Bend root activates both CPI slots with the same capability.
  { name: 'cpi-pair', source: 'tests/cpi-pair.bend', effects: 'cpi', cases: [
    { name: 'initialize', mode: 0, ix: runPair(invoke([meta(5, true)])), actorSigner: true, expect: { accept: count(1) },
      active: [1, 1], guard: true },
    { name: 'transition-carry', mode: 1, prior: count(0xfeffffff), ix: runPair(invoke([meta(5, true), meta(4, false)])),
      actorSigner: false, expect: { accept: count(0xff000000) }, active: [1, 1], guard: true },
    { name: 'no-effect', mode: 1, prior: count(41), ix: runPair({ c: 'None' }), actorSigner: true, expect: { accept: count(42) },
      active: [0, 0] },
    { name: 'state-writable-meta', mode: 1, prior: count(41), ix: runPair(invoke([meta(5, false), meta(0, true)])),
      actorSigner: true, expect: { accept: count(42) }, active: [1, 1], stateWritable: [true, true] },
  ] },
];

type Scenario = { id: number; label: string; case: Case; count: number; dupMarker: number; dupA: number; dupB: number;
  ownerFault: number; executable: boolean; writable: boolean; stateSigner: boolean; actorSigner: boolean; size: number;
  custody: bigint; stateDecodeFail: boolean; ixDecodeFail: boolean; clockFail: boolean; rootMode: 0 | 1 | 2 | 3 | 4;
  rootCode: number; encodeFail: boolean; validate: bigint[]; execute: bigint[]; data: Uint8Array; ix: Uint8Array };
type Result = { rc: bigint; trace: string; data: string; ret: string; executed: number; outside: number };
type Layout = { header: number[]; payload: number; total: number; ixBytes: number; slots: number; effects: EffectKind;
  state: string; instruction: string; codec: ReturnType<typeof wireCodec>; schema: RuntimeSchema };

const hex = (bytes: Uint8Array | number[]) => Buffer.from(bytes).toString('hex');
const sha = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
// Helper errors must not be truncated to 32 bits. The `high` values have zero
// low 32 bits, so a truncated branch condition is observable, not only a
// truncated return value.
const VALIDATE_ERROR = (slot: number, high = false) => high ? BigInt(slot + 1) << 32n : (1n << 32n) + 40n + BigInt(slot);
const EXECUTE_ERROR = (slot: number, high = false) => high ? 1n << BigInt(40 + slot) : slot % 2 ? (1n << 40n) + 7n : 77n;
const MAX_ACCOUNTS = (effects: EffectKind) => effects === 'none' ? 2 : 12;

function wire(schema: RuntimeSchema, type: string, value: Value): WireValue {
  const t = schema.types.find(t => t.name === type);
  if (!t) throw new Error(`Unknown type: ${type}`);
  if (t.kind !== 'adt') { assert(typeof value !== 'object'); return value; }
  assert(typeof value === 'object', `expected constructor for ${type}`);
  const variant = t.variants.find(v => v.name.split('.').at(-1) === value.c);
  if (!variant) throw new Error(`No constructor ${value.c} in ${type}`);
  return { constructor: variant.name, fields: Object.fromEntries(
    variant.fields.map(f => [f.name, wire(schema, f.type, (value.f ?? {})[f.name])])) };
}

// ---- The contract ----------------------------------------------------------
// Steps follow docs/adapter-assurance.md. The relative order of simultaneous
// precommit faults is pinned as a regression contract; `invariants` below
// states the safety properties without depending on that order.
function contract(l: Layout, s: Scenario): Result {
  const trace: string[] = [];
  const total = l.total, n = l.payload;
  const initial = new Uint8Array(total);
  initial.set(s.data.subarray(0, Math.min(s.data.length, s.size, total)));
  const before = s.count > 0 ? hex(initial) : '-';
  const stop = (rc: bigint | number, executed = 0): Result =>
    ({ rc: BigInt(rc), trace: trace.join(',') || '-', data: before, ret: '-', executed, outside: 0 });
  const decodes = (type: string, bytes: Uint8Array) => {
    try { l.codec.decode(type, bytes); return true; } catch { return false; }
  };
  if (l.effects === 'none' ? s.count !== 2 : s.count < 4 || s.count > 12) return stop(1);
  for (let i = 0; i < s.count; ++i) {
    if (s.dupMarker === i) return stop(6);
    if (s.dupB === i && s.dupA >= 0 && s.dupA < i) return stop(6);
  }
  if (s.ix.length !== l.ixBytes || s.ix[0] > 1) return stop(2);
  if (l.effects !== 'none') {
    trace.push('c1');
    if (s.custody) return stop(s.custody);
  }
  if (s.ownerFault || s.executable) return stop(3);
  if (!s.writable) return stop(5);
  if (s.size !== total) return stop(4);
  if (s.ix[0] === 0) {
    if (!s.stateSigner) return stop(7);
    if (s.data.some(b => b !== 0)) return stop(4);
    trace.push('E1');
    if (s.stateDecodeFail || !decodes(l.state, new Uint8Array(n))) return stop(4);
  } else {
    if (l.header.some((b, i) => s.data[i] !== b)) return stop(4);
    trace.push('A1');
    if (s.stateDecodeFail || !decodes(l.state, s.data.subarray(l.header.length))) return stop(4);
  }
  trace.push('i1');
  if (s.ixDecodeFail || !decodes(l.instruction, s.ix.subarray(1))) return stop(2);
  trace.push('k');
  if (s.clockFail) return stop(8);
  trace.push(`r${Number(s.actorSigner)}:1:1`);
  if (s.rootMode === 2) return stop(9);
  const outcome: Expect = s.rootMode === 1 ? { reject: s.rootCode } : s.case.expect;
  if ('reject' in outcome) return stop(outcome.reject <= 0xfffffeff ? 256n + BigInt(outcome.reject) : 9);
  trace.push('e');
  if (s.encodeFail) return stop(9);
  let executed = 0;
  if (l.effects !== 'none') {
    if (s.rootMode === 3) return stop(9);
    // Root mode 4 exchanges the two CPI slots of the root's result.
    const swap = (i: number) => s.rootMode === 4 ? 1 - i : i;
    // Every slot is validated before the first execution.
    for (let i = 0; i < l.slots; ++i) {
      trace.push(`v${i}:${s.case.active![swap(i)]}:1`);
      if (l.effects === 'cpi' && s.case.active![swap(i)] && s.case.stateWritable?.[swap(i)]) return stop(22);
      if (s.validate[i]) return stop(s.validate[i]);
    }
    for (let i = 0; i < l.slots; ++i) {
      trace.push(`x${i}:1`);
      // Earlier executions stay executed: only the transaction can undo them.
      if (s.execute[i]) return stop(18, executed);
      ++executed;
    }
  }
  const payload = l.codec.encode(l.state, wire(l.schema, l.state, outcome.accept));
  trace.push(`R${n}`);
  return { rc: 0n, trace: trace.join(','), data: hex(l.header) + hex(payload), ret: `1:${hex(payload)}`, executed, outside: 0 };
}

// Safety properties of one observed run, independent of `contract`.
function invariants(l: Layout, s: Scenario, o: Result): string | undefined {
  const events = o.trace === '-' ? [] : o.trace.split(',');
  const at = (prefix: string) => events.findIndex(e => e.startsWith(prefix));
  const counted = (prefix: string) => events.filter(e => e.startsWith(prefix)).length;
  const initial = new Uint8Array(l.total);
  initial.set(s.data.subarray(0, Math.min(s.data.length, s.size, l.total)));
  if (o.outside) return 'wrote outside the state account data';
  if (o.rc !== 0n && s.count > 0 && o.data !== hex(initial)) return 'state bytes changed on an error return';
  if (o.rc !== 0n && o.ret !== '-') return 'return data set on an error return';
  if (counted('r') > 1) return 'root called more than once';
  const root = at('r');
  if (root >= 0) {
    const need = [s.ix[0] === 0 ? 'E1' : 'A1', 'i1', 'k', ...(l.effects === 'none' ? [] : ['c1'])];
    for (const e of need) if (events.indexOf(e) < 0 || events.indexOf(e) > root) return `root called before ${e}`;
    if (l.effects !== 'none' && s.custody) return 'root called after failed custody setup';
    if (s.stateDecodeFail || s.ixDecodeFail || s.clockFail) return 'root called after a failed precondition';
  }
  const firstExecute = at('x');
  if (firstExecute >= 0) {
    for (let i = 0; i < l.slots; ++i) {
      const v = at(`v${i}:`);
      if (v < 0 || v > firstExecute) return `executed before validating slot ${i}`;
      if (s.validate[i]) return `executed although slot ${i} failed validation`;
    }
    if (root < 0 || at('e') < 0 || at('e') > firstExecute) return 'executed before root/encode';
  }
  if (o.rc === 0n) {
    if (events.at(-1) !== `R${l.payload}` || counted('R') !== 1) return 'success without exactly one final return-data write';
    if (o.ret !== `1:${o.data.slice(2 * l.header.length)}` || !o.data.startsWith(hex(l.header))) return 'success without header || payload commit';
    if (root < 0 || at('e') < root) return 'success without root and encode';
    if (l.effects !== 'none') {
      if (events.filter(e => e.startsWith('x')).join(',') !== Array.from({ length: l.slots }, (_, i) => `x${i}:1`).join(','))
        return 'success without executing every slot once, in order';
      if (s.execute.some(Boolean) || o.executed !== l.slots) return 'success although an execution failed';
    }
  }
  return undefined;
}

// ---- Bounded scenario matrix ------------------------------------------------
type Fault = { dim: string; name: string; apply: (s: Scenario, l: Layout) => boolean };
function faults(l: Layout): Fault[] {
  const set = (dim: string, name: string, f: (s: Scenario) => boolean | void): Fault =>
    ({ dim, name, apply: s => f(s) !== false });
  const poke = (s: Scenario, offset: number, f: (b: number) => number) => {
    s.data = Uint8Array.from(s.data); s.data[offset] = f(s.data[offset]);
  };
  const last = (s: Scenario) => s.count - 1;
  return [
    ...(l.effects === 'none' ? [0, 1, 3] : [0, 3, 4, 12, 13]).map(n => set('count', `count=${n}`, s => { s.count = n; })),
    ...[0, 1].map(i => set('marker', `alias-marker@${i}`, s => { s.dupMarker = i; })),
    set('marker', 'alias-marker@last', s => { s.dupMarker = last(s); }),
    set('key', 'actor-key=state-key', s => { s.dupA = 0; s.dupB = 1; }),
    set('key', 'last-key=state-key', s => { if (last(s) < 1) return false; s.dupA = 0; s.dupB = last(s); }),
    set('key', 'last-key=actor-key', s => { if (last(s) < 2) return false; s.dupA = 1; s.dupB = last(s); }),
    // Middle positions; `scenarios` additionally enumerates every position.
    ...(l.effects === 'none' ? [] : [
      set('marker', 'alias-marker@2', s => { if (last(s) < 3) return false; s.dupMarker = 2; }),
      set('key', 'key3=key2', s => { if (last(s) < 3) return false; s.dupA = 2; s.dupB = 3; }),
      set('key', 'last-key=previous-key', s => { if (last(s) < 4) return false; s.dupA = last(s) - 1; s.dupB = last(s); }),
    ]),
    set('length', 'ix-truncated', s => { s.ix = s.ix.slice(0, -1); }),
    set('length', 'ix-extended', s => { s.ix = Uint8Array.from([...s.ix, 0]); }),
    set('length', 'ix-empty', s => { s.ix = new Uint8Array(0); }),
    ...[2, 255].map(m => set('mode', `mode=${m}`, s => { if (!s.ix.length) return false; s.ix = Uint8Array.from(s.ix); s.ix[0] = m; })),
    set('mode', 'mode-flipped', s => { if (!s.ix.length) return false; s.ix = Uint8Array.from(s.ix); s.ix[0] ^= 1; }),
    ...(l.effects === 'none' ? [] : [10n, 11n, (1n << 33n) + 11n, 1n << 32n].map(e => set('custody', `custody=${e}`, s => { s.custody = e; }))),
    // One differing byte in each eight-byte chunk compared by equal_key.
    ...[31, 0, 9, 18].map(b => set('owner', `foreign-owner-byte${b}`, s => { s.ownerFault = b + 1; })),
    set('executable', 'executable-state', s => { s.executable = true; }),
    set('writable', 'readonly-state', s => { s.writable = false; }),
    ...[-1, 1].map(d => set('size', `size${d > 0 ? '+' : ''}${d}`, s => { s.size = l.total + d; })),
    set('size', 'size=0', s => { s.size = 0; }),
    set('signer', 'state-signer-flipped', s => { s.stateSigner = !s.stateSigner; }),
    set('data', 'data[0]^1', s => poke(s, 0, b => b ^ 1)),
    set('data', 'header-end^0x80', s => poke(s, l.header.length - 1, b => b ^ 0x80)),
    set('data', 'payload-tag=0xff', s => poke(s, l.header.length, () => 0xff)),
    set('data', 'data-last^0x40', s => { if (s.case.mode !== 0) return false; poke(s, l.total - 1, b => b ^ 0x40); }),
    set('state-decode', 'state-decode-fails', s => { s.stateDecodeFail = true; }),
    set('ix-decode', 'ix-decode-fails', s => { s.ixDecodeFail = true; }),
    set('ix-payload', 'ix-tag=0xff', s => { if (s.ix.length < 2) return false; s.ix = Uint8Array.from(s.ix); s.ix[1] = 0xff; }),
    set('clock', 'clock-fails', s => { s.clockFail = true; }),
  ];
}

function scenarios(l: Layout, f: Fixture): Scenario[] {
  const out: Scenario[] = [];
  const base = (k: Case): Scenario => {
    const data = new Uint8Array(l.total);
    if (k.mode === 1) {
      data.set(l.header);
      data.set(l.codec.encode(l.state, wire(l.schema, l.state, k.prior!)), l.header.length);
    }
    const ix = Uint8Array.from([k.mode, ...l.codec.encode(l.instruction, wire(l.schema, l.instruction, k.ix))]);
    assert.equal(ix.length, l.ixBytes);
    return { id: 0, label: k.name, case: k, count: l.effects === 'none' ? 2 : 6, dupMarker: -1, dupA: -1, dupB: -1,
      ownerFault: 0, executable: false, writable: true, stateSigner: k.mode === 0, actorSigner: k.actorSigner,
      size: l.total, custody: 0n, stateDecodeFail: false, ixDecodeFail: false, clockFail: false, rootMode: 0, rootCode: 0,
      encodeFail: false, validate: Array(8).fill(0n), execute: Array(8).fill(0n), data, ix };
  };
  const push = (s: Scenario, label: string) => { out.push({ ...s, id: out.length, label: `${s.case.name}: ${label}` }); };
  // Every late-stage combination for every case.
  const roots: [Scenario['rootMode'], number][] = [[0, 0], [1, 0], [1, 1], [1, 0xfffffeff], [1, 0xffffff00], [1, 0xffffffff], [2, 0],
    ...(l.effects === 'none' ? [] : [[3, 0] as [3, number]]), ...(l.effects === 'cpi' ? [[4, 0] as [4, number]] : [])];
  const masks = 1 << l.slots;
  for (const k of f.cases) for (const [rootMode, rootCode] of roots) for (const encodeFail of [false, true])
    for (let v = 0; v < masks; ++v) for (let x = 0; x < masks; ++x) for (const high of v || x ? [false, true] : [false]) {
      const s = { ...base(k), rootMode, rootCode, encodeFail };
      for (let i = 0; i < l.slots; ++i) {
        if (v >> i & 1) s.validate[i] = VALIDATE_ERROR(i, high);
        if (x >> i & 1) s.execute[i] = EXECUTE_ERROR(i, high);
      }
      push(s, `root=${rootMode}/${rootCode} encodeFail=${encodeFail} validate=${v.toString(2)} execute=${x.toString(2)}` +
        (high ? ' high-only-errors' : ''));
    }
  // Every alias-marker position and every pair of equal keys, at each accepted account count.
  for (const k of f.cases.filter(k => k.guard)) for (const n of l.effects === 'none' ? [2] : [4, 6, 12]) {
    for (let i = 0; i < n; ++i) push({ ...base(k), count: n, dupMarker: i }, `count=${n} alias-marker@${i}`);
    for (let b = 1; b < n; ++b) for (let a = 0; a < b; ++a)
      push({ ...base(k), count: n, dupA: a, dupB: b }, `count=${n} key${b}=key${a}`);
  }
  // Every guard fault and every pair of faults from distinct dimensions.
  const all = faults(l);
  for (const k of f.cases.filter(k => k.guard)) for (let a = 0; a < all.length; ++a) for (let b = a; b < all.length; ++b) {
    if (b !== a && all[a].dim === all[b].dim) continue;
    const s = base(k);
    if (!all[a].apply(s, l) || (b !== a && !all[b].apply(s, l))) continue;
    push(s, b === a ? all[a].name : `${all[a].name} + ${all[b].name}`);
  }
  return out;
}

const serialize = (s: Scenario) => [s.id, s.count, s.dupMarker, s.dupA, s.dupB, s.ownerFault, ...[s.executable, s.writable,
  s.stateSigner, s.actorSigner].map(Number), s.size, s.custody, ...[s.stateDecodeFail, s.ixDecodeFail, s.clockFail].map(Number),
  s.rootMode, s.rootCode, Number(s.encodeFail), ...s.validate, ...s.execute, hex(s.data) || '-', hex(s.ix) || '-'].join(' ');

// ---- Mutations of the emitted adapter ---------------------------------------
// Each rewrites the emitted C once; the contract or an invariant must then
// fail on at least one executed scenario. `abort` marks the one mutant whose
// defect is a stack overflow: it must stop in an ASan-reported stack write to
// the first element past `accounts`, exactly at the first scenario with too
// many accounts.
type Mutant = { name: string; effects?: EffectKind[]; fixtures?: string[]; abort?: boolean; apply: (c: string, l: Layout) => string };
const once = (c: string, pattern: RegExp, replacement: string | ((match: string) => string)) => {
  const found = c.match(new RegExp(pattern.source, 'g'));
  assert.equal(found?.length, 1, `mutation target must occur exactly once: ${pattern}`);
  return c.replace(pattern, replacement as string);
};
const withEffects: EffectKind[] = ['token', 'cpi'];
const headerWrite = /__builtin_memcpy\(state\.data, header, \d+\);|for \(unsigned i = 0; i < \d+; \+\+i\) state\.data\[i\] = header\[i\];/;
const payloadWrite = /__builtin_memcpy\(state\.data \+ \d+, encoded, \d+\);|for \(unsigned i = 0; i < \d+; \+\+i\) state\.data\[\d+ \+ i\] = encoded\[i\];/;
const encodeCheck = /if \(!(\w+_encode\(encoded, \d+, &outcome\.as\.c\d+\.f0\))\) return 9;/;
const accountDecode = /if \(!(\w+_decode\(state\.data \+ \d+, \d+, &before\))\) return 4;/;
const ixDecode = /if \(!(\w+_decode\(ix \+ 1, \d+, &instruction\))\) return 2;/;
const mutants: Mutant[] = [
  { name: 'early-commit: header written before the transition', apply: (c, l) =>
    once(c, /(const u8 header\[\d+\] = \{[\d,]+\};)/, `$1\n  __builtin_memcpy(state.data, header, ${l.header.length});`) },
  { name: 'early-commit: state written before effects are validated and executed', effects: withEffects, apply: (c, l) =>
    once(c, encodeCheck, `$&\n  __builtin_memcpy(state.data + ${l.header.length}, encoded, ${l.payload});`) },
  { name: 'early-commit: return data set before effects', effects: withEffects, apply: (c, l) =>
    once(c, encodeCheck, `$&\n  sol_set_return_data(encoded, ${l.payload});`) },
  { name: 'missing-decode: stored state never decoded', apply: c => once(c, accountDecode, '') },
  { name: 'missing-decode: instruction never decoded', apply: c => once(c, ixDecode, '') },
  { name: 'ignored-error: stored state decode', apply: c => once(c, accountDecode, '(void)$1;') },
  { name: 'ignored-error: instruction decode', apply: c => once(c, ixDecode, '(void)$1;') },
  { name: 'ignored-error: empty state decode', apply: c => once(c, /if \(!(\w+_decode\(empty, \d+, &before\))\) return 4;/, '(void)$1;') },
  { name: 'ignored-error: clock', apply: c => once(c, /if \((sol_get_clock_sysvar\(&clock\))\) return 8;/, '(void)$1;') },
  { name: 'ignored-error: custody setup', effects: withEffects, apply: c => once(c, /if \(setup\) return setup;/, '') },
  { name: 'ignored-error: state encode', apply: c => once(c, encodeCheck, '(void)$1;') },
  { name: 'ignored-error: effect extraction', effects: withEffects, apply: c =>
    once(c, /if \(!(bend_extract_effects\([^;]*\))\) return 9;/, '(void)$1;') },
  { name: 'ignored-error: effect validation', effects: withEffects, apply: c => once(c, /if \(error\) return error;/, '') },
  { name: 'ignored-error: effect execution', effects: withEffects, apply: c => once(c, /\) return 18;/, ') {}') },
  { name: 'ignored-error: unknown outcome tag', apply: c => once(c, /if \(outcome\.tag != \d+\) return 9;/, '') },
  { name: 'ignored-error: rejection treated as unknown outcome', apply: c =>
    once(c, /if \(outcome\.tag == \d+\) \{[\s\S]*?\n  \}/, '') },
  { name: 'ignored-error: rejection code range', apply: c => once(c, /code <= 0xfffffeffu \? 256ULL \+ code : 9/, '256ULL + code') },
  { name: 'execution-before-all-validation: slots validated and executed in one loop', effects: withEffects, apply: c =>
    once(c, /if \(error\) return error;\s*\}\s*for \(unsigned i = 0; i < \d+; \+\+i\) \{/, 'if (error) return error;') },
  { name: 'execution-before-all-validation: last slot not validated', effects: withEffects, apply: (c, l) =>
    once(c, /for \(unsigned i = 0; i < \d+; \+\+i\) \{(\s*u64 error = )/, `for (unsigned i = 0; i < ${l.slots - 1}; ++i) {$1`) },
  { name: 'effects never executed', effects: withEffects, apply: c =>
    once(c, /bend_(transfer|invoke)_execute\(&transfers\[i\],accounts,\(unsigned\)count,bump\)/, '0') },
  { name: 'cpi may write the state account', effects: ['cpi'], apply: c => once(c, /return 22;/, '{}') },
  // tests/cpi-pair.bend gives both slots the same metas, so there slot 0 always reports first.
  { name: 'cpi state-writable check only on slot 0', fixtures: ['cpi'], apply: c =>
    once(c, /if \(transfers\[i\]\.active\) for/, 'if (i == 0 && transfers[i].active) for') },
  { name: 'cpi state-writable check only on slot 1', effects: ['cpi'], apply: c =>
    once(c, /if \(transfers\[i\]\.active\) for/, 'if (i == 1 && transfers[i].active) for') },
  { name: 'guard: account count upper bound', abort: true, apply: c =>
    once(c, /if \(count (?:!= 2|< 4 \|\| count > 12)\) return 1;/, m => m.includes('!=') ? 'if (count < 2) return 1;' : 'if (count < 4) return 1;') },
  // One account fewer than required is accepted. (With exactly two accounts
  // there is no such mutant that still has an actor account to read.)
  { name: 'guard: account count lower bound', effects: withEffects, apply: c =>
    once(c, /if \(count < 4 \|\| count > 12\) return 1;/, 'if (count < 3 || count > 12) return 1;') },
  { name: 'guard: duplicate keys', apply: c =>
    once(c, /for \(unsigned j = 0; j < i; \+\+j\) if \(equal_key\(accounts\[i\]\.key,accounts\[j\]\.key\)\) return 6;/, '') },
  { name: 'guard: duplicate keys compared with the first two accounts only', effects: withEffects, apply: c =>
    once(c, /for \(unsigned j = 0; j < i; \+\+j\) if \(equal_key\(accounts\[i\]/, 'for (unsigned j = 0; j < i && j < 2; ++j) if (equal_key(accounts[i]') },
  // read_account's layout is repeated so a marked middle account is parsed instead of rejected.
  { name: 'guard: alias marker ignored on middle accounts', effects: withEffects, apply: c =>
    once(c, /p = read_account\(p,&accounts\[i\]\);\s*if \(!p\) return 6;/, `{ const u8 *q = read_account(p,&accounts[i]);
      if (!q) {
        if (i < 2 || i + 1 == count) return 6;
        accounts[i] = (Account){ .key = p + 8, .owner = p + 40, .data = (u8 *)(p + 88), .size = read_le(p + 80, 8),
          .lamports = (u64 *)(p + 72), .signer = p[1] != 0, .writable = p[2] != 0, .executable = p[3] != 0 };
        q = (const u8 *)(((u64)(p + 88 + accounts[i].size + 10240) + 7) & ~(u64)7) + 8;
      }
      p = q; }`) },
  { name: 'actor key: second word read from offset 0', apply: c => once(c, /read_le\(actor\.key \+ 4, 4\)/, 'read_le(actor.key + 0, 4)') },
  { name: 'actor key: last word read from offset 27', apply: c => once(c, /read_le\(actor\.key \+ 28, 4\)/, 'read_le(actor.key + 27, 4)') },
  { name: 'guard: owner compared in its last eight bytes only', apply: c =>
    once(c, /!equal_key\(state\.owner, program\)/, '__builtin_memcmp(state.owner + 24, program + 24, 8)') },
  { name: 'guard: owner compared in its first eight bytes only', apply: c =>
    once(c, /!equal_key\(state\.owner, program\)/, '__builtin_memcmp(state.owner, program, 8)') },
  { name: 'truncated-error: custody setup tested in 32 bits', effects: withEffects, apply: c =>
    once(c, /if \(setup\) return setup;/, 'if ((u32)setup) return setup;') },
  { name: 'truncated-error: effect validation tested in 32 bits', effects: withEffects, apply: c =>
    once(c, /if \(error\) return error;/, 'if ((u32)error) return error;') },
  { name: 'truncated-error: effect execution tested in 32 bits', effects: withEffects, apply: c =>
    once(c, /if \((bend_(?:transfer|invoke)_execute\([^;]*\))\) return 18;/, 'if ((u32)$1) return 18;') },
  { name: 'guard: instruction length', apply: c => once(c, /length != \d+ \|\| /, '') },
  { name: 'guard: mode byte', apply: c => once(c, / \|\| ix\[0\] > 1/, '') },
  { name: 'guard: owner', apply: c => once(c, /!equal_key\(state\.owner, program\) \|\| /, '') },
  { name: 'guard: executable', apply: c => once(c, / \|\| state\.executable/, '') },
  { name: 'guard: writable', apply: c => once(c, /if \(!state\.writable\) return 5;/, '') },
  { name: 'guard: size', apply: c => once(c, /if \(state\.size != \d+\) return 4;/, '') },
  { name: 'guard: initialization signer', apply: c => once(c, /if \(!state\.signer\) return 7;/, '') },
  { name: 'guard: zero allocation', apply: c =>
    once(c, /for \(unsigned i = 0; i < \d+; \+\+i\) if \(state\.data\[i\]\) return 4;/, '') },
  { name: 'guard: stored header', apply: c =>
    once(c, /for \(unsigned i = 0; i < \d+; \+\+i\) if \(state\.data\[i\] != header\[i\]\) return 4;/, '') },
  { name: 'commit: header omitted', apply: c => once(c, headerWrite, '') },
  { name: 'commit: payload omitted', apply: c => once(c, payloadWrite, '') },
  { name: 'commit: payload one byte short', apply: (c, l) =>
    once(c, payloadWrite, `__builtin_memcpy(state.data + ${l.header.length}, encoded, ${l.payload - 1});`) },
  { name: 'commit: return data omitted', apply: c => once(c, /sol_set_return_data\(encoded, \d+\);/, '') },
  { name: 'commit: return data one byte short', apply: (c, l) =>
    once(c, /sol_set_return_data\(encoded, \d+\);/, `sol_set_return_data(encoded, ${l.payload - 1});`) },
];

// ---- Build and run ----------------------------------------------------------
const FLAGS = ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
  '-fsanitize=address,undefined', '-fno-sanitize-recover=all'];
const run$ = promisify(execFile);
async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}

function parse(stdout: string): { results: Map<number, Result>; done: boolean } {
  const results = new Map<number, Result>(); let done = false;
  for (const line of stdout.split('\n')) {
    if (line === 'done') { done = true; continue; }
    const p = line.split(' ');
    if (p.length !== 7) continue;
    results.set(Number(p[0]), { rc: BigInt(p[1]), trace: p[2], data: p[3], ret: p[4], executed: Number(p[5]), outside: Number(p[6]) });
  }
  return { results, done };
}

// First scenario whose observation differs from the contract or breaks an invariant.
function firstFailure(l: Layout, list: Scenario[], results: Map<number, Result>) {
  for (const s of list) {
    const o = results.get(s.id);
    if (!o) return undefined; // The binary stopped here; the caller decides.
    const e = contract(l, s);
    const field = (Object.keys(e) as (keyof Result)[]).find(k => e[k] !== o[k]);
    const broken = invariants(l, s, o);
    if (field || broken) return { scenario: s.label, field, expected: field && String(e[field]), observed: field && String(o[field]), invariant: broken };
  }
  return undefined;
}

/** -ftrivial-auto-var-init=zero, plus the opt-in flag Clang 14/15 require for it. */
function zeroInitFlags(cc: string): string[] {
  const flag = '-ftrivial-auto-var-init=zero';
  const probe = spawnSync(cc, [flag, '-x', 'c', '-fsyntax-only', '-'], { input: 'int main(void){return 0;}\n', encoding: 'utf8' });
  if (probe.status === 0) return [flag];
  if (/enable-trivial-auto-var-init-zero-knowing-it-will-be-removed-from-clang/.test(probe.stderr))
    return [flag, '-enable-trivial-auto-var-init-zero-knowing-it-will-be-removed-from-clang'];
  throw new Error(`${cc} does not support ${flag}: ${probe.stderr}`);
}

export async function testAdapterSemantics() {
  const cc = process.env.CC ?? 'clang';
  const zeroInit = zeroInitFlags(cc);
  const out = 'build/adapter-semantics';
  fs.rmSync(path.join(out, 'report.json'), {force:true});
  fs.mkdirSync(out, { recursive: true });
  const harness = 'tests/adapter-semantics-harness.h';
  const report = { passed:true, compiler: execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0], flags: FLAGS,
    scope: 'Native execution of emitted ABI 1 adapter C under mocked boundaries; not a C, SBF or Solana runtime proof. ' +
      'Rollback of executed external effects is a Solana transaction assumption. The CPI rule that the state account ' +
      'is never passed writable is reached on the second slot only through a scripted root result that exchanges the ' +
      'two slots of tests/cpi.bend; tests/cpi-pair.bend activates both slots with one capability.',
    inputs: Object.fromEntries([harness, 'tests/adapter-semantics.ts', 'compiler/storage.ts', 'compiler/effects.ts',
      'compiler/cpi-effects.ts', 'compiler/codecs.ts', 'runtime/solana_min.h', 'runtime/token.h', 'runtime/bend_cpi.h',
      'runtime/cpi_abi.h'].map(f => [f, sha(fs.readFileSync(f))])),
    fixtures: [] as unknown[] };
  let totalScenarios = 0, totalMutants = 0;
  for (const f of fixtures) {
    const emitted = new Backend(await checkedBook(f.source)).emit(['process']);
    const schema = emitted.schema;
    const storage = emitStorage(schema, 'process');
    const i = storage.interface;
    assert.equal(i.version, 1);
    assert.equal(i.effects === 'none' ? 'none' : i.effects === 'cpi-v1' ? 'cpi' : 'token', f.effects, `${f.name}: effect kind`);
    assert.notEqual(i.state, i.instruction, 'the codec wrappers need distinct state and instruction types');
    const types = new Map(schema.types.map(t => [t.name, t]));
    const root = schema.exports.find(e => e.name === 'process')!;
    const result = types.get(root.result)!;
    assert(result.kind === 'adt');
    const accepted = result.variants.find(v => v.name.split('.').at(-1) === 'Accepted')!;
    const rejected = result.variants.find(v => v.name.split('.').at(-1) === 'Rejected')!;
    const l: Layout = { header: i.header, payload: i.stateBytes - i.header.length, total: i.stateBytes, ixBytes: i.instructionBytes,
      slots: f.effects === 'none' ? 0 : ('effectSlots' in i ? i.effectSlots as number : 2), effects: f.effects,
      state: i.state, instruction: i.instruction, codec: wireCodec(schema), schema };
    assert.deepEqual(l.header.slice(0, 4), [66, 68, 83, 49], 'ABI 1 header magic');

    const dir = path.join(out, f.name);
    fs.mkdirSync(dir, {recursive:true});
    fs.writeFileSync(path.join(dir, 'types.h'), emitted.c);
    fs.writeFileSync(path.join(dir, 'codecs.h'), emitCodecs(schema));
    const prefix = f.effects === 'cpi' ? 'bend_invoke' : 'bend_transfer';
    const unit = (adapter: string) => `#include "types.h"
#include "codecs.h"
#define ASEM_STATE_T ${types.get(i.state)!.cType}
#define ASEM_IX_T ${types.get(i.instruction)!.cType}
#define ASEM_CTX_T ${types.get(root.args[0])!.cType}
#define ASEM_OUT_T ${result.cType}
#define ASEM_STATE_DECODE ${mangle(i.state)}_decode
#define ASEM_IX_DECODE ${mangle(i.instruction)}_decode
#define ASEM_STATE_ENCODE ${mangle(i.state)}_encode
#define ASEM_ROOT ${root.cName}
#define ASEM_HEADER_BYTES ${l.header.length}
#define ASEM_PAYLOAD_BYTES ${l.payload}
#define ASEM_EFFECTS ${{ none: 0, token: 1, cpi: 2 }[f.effects]}
#define ASEM_SET_REJECT(o, code) ((o).tag = ${rejected.tag}u, (o).as.c${rejected.tag}.f0 = (code))
#define ASEM_BAD_TAG ${result.variants.length + 5}u
#define ASEM_SPOIL_EFFECTS(o) ${f.effects === 'none' ? '((void)(o))' : `((o).as.c${accepted.tag}.f1.tag = 1u)`}
#define ASEM_SWAP_EFFECTS(o) ${f.effects !== 'cpi' ? '((void)(o))' : `do { if ((o).tag == ${accepted.tag}u) { ` +
  `__typeof__((o).as.c${accepted.tag}.f1.as.c0.f0) t = (o).as.c${accepted.tag}.f1.as.c0.f0; ` +
  `(o).as.c${accepted.tag}.f1.as.c0.f0 = (o).as.c${accepted.tag}.f1.as.c0.f1; (o).as.c${accepted.tag}.f1.as.c0.f1 = t; } } while (0)`}
#include "adapter-semantics-harness.h"
/* Redirect only the adapter's boundary calls; its text is included unchanged. */
#define ${root.cName} asem_root
#define ${mangle(i.state)}_decode asem_state_decode
#define ${mangle(i.instruction)}_decode asem_ix_decode
#define ${mangle(i.state)}_encode asem_state_encode
${f.effects === 'none' ? '' : `#define ${f.effects === 'cpi' ? 'bend_invoke_custody' : 'bend_custody'} asem_custody
#define ${prefix}_validate(e, a, n) asem_validate(transfers, (e), (a), (n))
#define ${prefix}_execute(e, a, n, b) asem_execute(transfers, (e), (a), (n), (b))`}
#include "${adapter}"
`;
    const build = async (stem: string, c: string, extra: string[] = []) => {
      fs.writeFileSync(path.join(dir, `${stem}.adapter.c`), c);
      fs.writeFileSync(path.join(dir, `${stem}.unit.c`), unit(`${stem}.adapter.c`));
      await run$(cc, [...FLAGS, ...extra, '-Iruntime', '-Itests', `-I${dir}`, path.join(dir, `${stem}.unit.c`), '-o', path.join(dir, stem)]);
    };
    const list = scenarios(l, f);
    const scenarioText = list.map(serialize).join('\n') + '\n';
    fs.writeFileSync(path.join(dir, 'scenarios.txt'), scenarioText);
    const execute = async (stem: string) => {
      try {
        const r = await run$(path.join(dir, stem), [path.join(dir, 'scenarios.txt')], { maxBuffer: 1 << 28, timeout: 300_000 });
        return { ...parse(r.stdout), exit: 0 as number | string, stderr: r.stderr };
      } catch (e) {
        const x = e as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
        if (x.stdout === undefined) throw e;
        return { ...parse(x.stdout), exit: x.code ?? x.signal ?? 'failed', stderr: x.stderr ?? '' };
      }
    };

    // The emitted adapter, unchanged, must satisfy the contract on every scenario.
    await build('emitted', storage.c);
    assert.equal(sha(fs.readFileSync(path.join(dir, 'emitted.adapter.c'))), sha(storage.c));
    const positive = await execute('emitted');
    assert.equal(positive.exit, 0, `${f.name}: emitted adapter aborted\n${positive.stderr.slice(0, 2000)}`);
    assert(positive.done && positive.results.size === list.length, `${f.name}: incomplete run`);
    assert.deepEqual(firstFailure(l, list, positive.results), undefined, `${f.name}: emitted adapter violates the contract`);
    const codes = new Map<string, number>();
    for (const r of positive.results.values()) codes.set(String(r.rc), (codes.get(String(r.rc)) ?? 0) + 1);
    // The matrix must actually reach the outcomes it claims to cover.
    const need = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '256', '257', String(256 + 0xfffffeff),
      ...(f.effects === 'none' ? [] : ['10', '11', '18', String(VALIDATE_ERROR(0)), String(VALIDATE_ERROR(l.slots - 1)),
        String(VALIDATE_ERROR(0, true)), String(VALIDATE_ERROR(l.slots - 1, true))]),
      ...(f.effects === 'cpi' ? ['22'] : [])];
    for (const code of need) assert(codes.has(code), `${f.name}: no scenario returned ${code}`);
    if (f.effects !== 'none') assert([...positive.results.values()].some(r => r.rc === 18n && r.executed === l.slots - 1),
      `${f.name}: no scenario left earlier effects executed after a later failure`);
    // The writable-state rule must be reached on the second CPI slot, not only on slot 0.
    if (f.effects === 'cpi') assert(f.cases.every(k => !k.stateWritable?.[0] || k.active![1]) ||
      [...positive.results.values()].some(r => r.rc === 22n && r.trace.endsWith(',v0:0:1,v1:1:1')),
      `${f.name}: no scenario returned 22 for the second CPI slot`);

    // Every mutated adapter must be rejected by the same oracle.
    const selected = mutants.filter(m => (!m.effects || m.effects.includes(f.effects)) && (!m.fixtures || m.fixtures.includes(f.name)));
    const killed = await pool(selected.map((m, n) => async () => {
      const c = m.apply(storage.c, l);
      assert.notEqual(c, storage.c, `${f.name}: mutation did not change the adapter: ${m.name}`);
      const stem = `mutant-${String(n).padStart(2, '0')}`;
      // Zero automatic storage so a removed decode is a defined, comparable run.
      await build(stem, c, [...zeroInit, '-Wno-unused-variable', '-Wno-unused-but-set-variable',
        '-Wno-uninitialized', '-Wno-sometimes-uninitialized', '-Wno-unused-parameter']);
      const r = await execute(stem);
      const failure = firstFailure(l, list, r.results);
      if (m.abort) {
        // The overflowing mutant must match the contract up to the first
        // scenario with too many accounts and stop there, in an ASan stack
        // WRITE whose frame offset lies in the element just past `accounts`.
        // read_account's first store is not at element offset 0, so it can
        // skip the redzone into a neighbouring out-of-scope object; ASan then
        // names the same write stack-use-after-scope. Offsets and the object
        // list come from ASan's compiled-in frame description, not a symbolizer.
        const max = MAX_ACCOUNTS(f.effects);
        const stopped = list.findIndex(s => !r.results.has(s.id));
        const kind = r.stderr.match(/ERROR: AddressSanitizer: (stack-buffer-overflow|stack-use-after-scope) /)?.[1];
        const offset = Number(r.stderr.match(/is located in stack of thread T0 at offset (\d+) in frame/)?.[1]);
        const object = r.stderr.match(/\[(\d+), (\d+)\) 'accounts'/);
        const [lo, hi] = object ? [Number(object[1]), Number(object[2])] : [NaN, NaN];
        assert(r.exit !== 0 && [1, 'SIGABRT'].includes(r.exit) && !r.done && !failure && stopped >= 0 &&
          r.results.size === stopped && list[stopped].count > max && list.slice(0, stopped).every(s => s.count <= max) &&
          kind !== undefined && /\nWRITE of size \d+ at /.test(r.stderr) &&
          (hi - lo) % max === 0 && offset >= hi && offset < hi + (hi - lo) / max,
          `${f.name}: mutant did not stop in the expected ASan stack overflow: ${m.name} (${r.exit}, scenario ` +
          `${list[stopped]?.label})\n${r.stderr.slice(0, 2000)}`);
        return { name: m.name, sha256: sha(c), detection: 'sanitizer-abort', exit: r.exit, scenario: list[stopped].label,
          asan: `${kind}: write at frame offset ${offset}, accounts [${lo}, ${hi})` };
      }
      // A timeout, signal, sanitizer abort, harness failure or partial run is
      // not a successful mutation test: every scenario must have completed.
      assert(r.exit === 0 && r.done && r.results.size === list.length,
        `${f.name}: mutant did not complete every scenario: ${m.name} (${r.exit})\n${r.stderr.slice(0, 1000)}`);
      assert(failure, `${f.name}: mutant survived: ${m.name}`);
      return { name: m.name, sha256: sha(c), detection: failure.invariant ? 'contract+invariant' : 'contract', ...failure };
    }), Math.max(1, os.cpus().length - 1));
    totalScenarios += list.length; totalMutants += killed.length;
    report.fixtures.push({ name: f.name, source: f.source, sourceSha256: sha(fs.readFileSync(f.source)),
      adapterSha256: sha(storage.c), typesSha256: sha(emitted.c), codecsSha256: sha(emitCodecs(schema)),
      interface: i, scenarios: list.length, scenariosSha256: sha(scenarioText),
      observedSha256: sha(list.map(s => { const o = positive.results.get(s.id)!;
        return [s.id, o.rc, o.trace, o.data, o.ret, o.executed, o.outside].join(' '); }).join('\n')),
      returnCodes: Object.fromEntries([...codes].sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0])))), mutants: killed });
    console.log(`${f.name}: ${list.length} scenarios matched the contract; ${killed.length} mutated adapters rejected`);
  }
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n');
  console.log(`ABI 1 adapter semantics: ${totalScenarios} native sanitizer executions of emitted C matched the contract across ` +
    `${fixtures.length} fixtures; ${totalMutants} mutants rejected; report ${out}/report.json`);
}

if (import.meta.main) await testAdapterSemantics();
