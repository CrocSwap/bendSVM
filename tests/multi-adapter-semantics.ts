import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Backend, checkedBook, mangle } from '../compiler/backend.ts';
import { emitCodecs } from '../compiler/codecs.ts';
import { emitStorage } from '../compiler/storage.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';

// Independent ABI 2 value-level semantic checks over the actual emitted C.
// The C loader, field validation, canonical generated codecs, Bend root, effect
// extraction, state commit and reply encoding execute under native ASan/UBSan.
// The TypeScript oracle below states account bytes, decoded root inputs, return
// values and effect ordering without interpreting emitted C. Only syscalls and
// token/CPI validate/execute helper boundaries are mocked. Root/codec failure
// scripts are explicit and every ordinary mutant must finish its full matrix.
// This does not establish source-to-C/LLVM/SBF behavior or Solana rollback.

type Effect = 'none' | 'token' | 'cpi';
type Value = number | boolean | { c: string; f?: Record<string, Value> };
type Expect = { accept: number[] } | { reject: number };
type TokenPlan = { transfers: Array<{ source: number; destination: number; mint: number;
  amount: 'deposit' | 'withdrawal'; recipient: 'actor' | 'custody'; authority: 'actor' | 'custody' }> };
type Case = { name: string; mode: 0 | 1; prior?: number[]; ix: Value; actorSigner: boolean;
  expect: Expect; active: number[]; metas?: Array<Array<{ index: number; writable: boolean }>> };
type Fixture = { name: string; source: string; config: string; effects: Effect; cases: Case[]; tokenPlan?: TokenPlan };
type Scenario = {
  id: number; label: string; case: Case; count: number; alias: number; dupA: number; dupB: number;
  actorSigner: boolean; ownerField: number; ownerByte: number; executableField: number; writableField: number;
  signerField: number; sizeField: number; sizeDelta: number; dataFaultField: number; dataFaultOffset: number;
  dataFaultXor: number; bindingField: number; bindingChunk: number; decodeField: number;
  ixDecodeFail: boolean; clockFail: boolean; custody: bigint; rootMode: number; rootCode: number;
  custodyBump: number;
  encodeField: number; validateSlot: number; validateError: bigint; executeSlot: number; executeError: bigint;
  ixLength: number; data: Uint8Array[]; ix: Uint8Array;
};
type Result = { rc: bigint; trace: string; data: string[]; ret: string; executed: number; outside: number;
  custodyCalls: number; validateCalls: number; executeCalls: number; returnCalls: number };
type Layout = { fields: Array<{ field: string; type: string; index: number; bindingBytes: number; header: number[]; stateBytes: number }>;
  min: number; max: number; ixBytes: number; state: string; instruction: string; slots: number; effects: Effect;
  codec: ReturnType<typeof wireCodec>; schema: RuntimeSchema; interface: any; fixture: Fixture };
type BuiltFixture = { fixture: Fixture; schema: RuntimeSchema; emitted: { c: string }; storage: any; layout: Layout;
  root: any; stateType: any; accepted: any; rejected: any; acceptedTag: number; rejectedTag: number; dir: string };

const SLOT = 0x1122334455667788n;
const MAS_PROGRAM_FILL = 0xEE;
const HEX = (b: Uint8Array | number[]) => Buffer.from(b).toString('hex');
const sha = (b: string | Uint8Array) => crypto.createHash('sha256').update(b).digest('hex');
const keyByte = (index: number, j: number) => (0x20 + index + 7 * j) & 0xff;
const keyBytes = (index: number) => Uint8Array.from({ length: 32 }, (_, j) => keyByte(index, j));
const keyWire = (index: number): Value => ({ c: 'Key', f: Object.fromEntries('abcdefgh'.split('').map((n, w) => {
  let value = 0; for (let j = 3; j >= 0; --j) value = value * 256 + keyByte(index, 4 * w + j);
  return [n, value];
})) });
const u64 = (n: number): Value => ({ c: 'U64', f: { lo: n, hi: 0 } });
const bytes64 = (first: number): Value => ({ c: 'Bytes64', f: Object.fromEntries('abcdefghijklmnop'.split('').map((n, i) => [n, i ? 0 : first])) });
const meta = (index: number, writable: boolean): Value => ({ c: 'Meta', f: { index, key: keyWire(index), writable, signer: false } });
const invoke = (metas: Array<{ index: number; writable: boolean }>): Value => ({ c: 'Invoke', f: {
  program: 2, program_key: keyWire(2), length: 4, data: bytes64(0x04030201), count: metas.length,
  accounts: { c: 'Metas', f: Object.fromEntries('abcdefgh'.split('').map((n, i) =>
    [n, metas[i] ? meta(metas[i].index, metas[i].writable) : meta(0, false)])) }
} });
const runPair = (effect: Value): Value => ({ c: 'Run', f: { effect, second_data: bytes64(0x08070605) } });

const pureSet = (fields: string[], values: number[]): Value => ({ c: 'Set', f: Object.fromEntries(fields.map((n, i) => [n, values[i]])) });
const fixtures: Fixture[] = [
  { name: 'pure-2', source: 'tests/multi-storage.bend', config: 'tests/multi-storage.layout.json', effects: 'none', cases: [
    { name: 'initialize-set', mode: 0, ix: pureSet(['left', 'right'], [11, 22]), actorSigner: true, expect: { accept: [11, 22] }, active: [] },
    { name: 'transition-set', mode: 1, prior: [3, 4], ix: pureSet(['left', 'right'], [21, 22]), actorSigner: false, expect: { accept: [21, 22] }, active: [] },
    { name: 'root-rejection', mode: 1, prior: [3, 4], ix: { c: 'AbortRequest' }, actorSigner: true, expect: { reject: 42 }, active: [] },
  ] },
  { name: 'token-3', source: 'tests/multi-token-3.bend', config: 'tests/multi-token-3.layout.json', effects: 'token', cases: [
    { name: 'initialize-two-slots', mode: 0,
      ix: { c: 'RoundTrip', f: { mint: keyWire(6), deposit: u64(5), withdrawal: u64(3) } }, actorSigner: true,
      expect: { accept: [1, 1, 1] }, active: [1, 1] },
    { name: 'transition-two-slots', mode: 1, prior: [9, 19, 29],
      ix: { c: 'RoundTrip', f: { mint: keyWire(6), deposit: u64(5), withdrawal: u64(3) } }, actorSigner: true,
      expect: { accept: [10, 20, 30] }, active: [1, 1] },
    { name: 'unsigned-root-rejection', mode: 1, prior: [9, 19, 29],
      ix: { c: 'RoundTrip', f: { mint: keyWire(6), deposit: u64(5), withdrawal: u64(3) } }, actorSigner: false,
      expect: { reject: 1 }, active: [0, 0] },
  ], tokenPlan: { transfers: [
    { source: 6, destination: 7, mint: 8, amount: 'deposit', recipient: 'custody', authority: 'actor' },
    { source: 7, destination: 6, mint: 8, amount: 'withdrawal', recipient: 'actor', authority: 'custody' },
  ] } },
  { name: 'cpi-4', source: 'tests/cpi-multi-4.bend', config: 'tests/cpi-multi-4.layout.json', effects: 'cpi', cases: [
    { name: 'initialize-two-slots', mode: 0, ix: runPair(invoke([{ index: 6, writable: false }])), actorSigner: true,
      expect: { accept: [1, 2, 3, 4] }, active: [1, 1], metas: [[{ index: 6, writable: false }], [{ index: 6, writable: false }]] },
    { name: 'transition-two-slots', mode: 1, prior: [9, 19, 29, 39],
      ix: runPair(invoke([{ index: 6, writable: false }])), actorSigner: false,
      expect: { accept: [10, 21, 32, 43] }, active: [1, 1], metas: [[{ index: 6, writable: false }], [{ index: 6, writable: false }]] },
  ] },
];

function wire(schema: RuntimeSchema, type: string, value: Value): WireValue {
  const t = schema.types.find(x => x.name === type);
  if (!t) throw new Error(`Unknown wire type ${type}`);
  if (t.kind !== 'adt') { assert(typeof value !== 'object'); return value; }
  assert(typeof value === 'object' && value !== null, `expected ${type} constructor`);
  const v = t.variants.find(x => x.name.split('.').at(-1) === value.c);
  if (!v) throw new Error(`No ${value.c} constructor in ${type}`);
  return { constructor: v.name, fields: Object.fromEntries(v.fields.map(f => [f.name, wire(schema, f.type, (value.f ?? {})[f.name])])) };
}
function typeBy(schema: RuntimeSchema, name: string) {
  const t = schema.types.find(x => x.name === name); assert(t, `missing schema type ${name}`); return t;
}
function fieldNumber(schema: RuntimeSchema, type: string, n: number): Value {
  const t = typeBy(schema, type); assert.equal(t.kind, 'adt');
  const v = t.variants[0]; assert.equal(v.fields.length, 1);
  return { c: v.name.split('.').at(-1)!, f: { [v.fields[0].name]: n } };
}
function stateWire(l: Layout, values: number[]): WireValue {
  const st = typeBy(l.schema, l.state); assert.equal(st.kind, 'adt');
  const variant = st.variants[0];
  return wire(l.schema, l.state, { c: variant.name.split('.').at(-1)!, f: Object.fromEntries(l.fields.map((f, i) =>
    [f.field, fieldNumber(l.schema, f.type, values[i])])) });
}
function fieldPayload(l: Layout, values: number[]): Uint8Array[] {
  return l.fields.map((f, i) => l.codec.encode(f.type, wire(l.schema, f.type, fieldNumber(l.schema, f.type, values[i]))));
}
function accountBytes(l: Layout, values: number[], mode: 0 | 1): Uint8Array[] {
  const payloads = fieldPayload(l, values);
  return l.fields.map((f, i) => {
    const out = new Uint8Array(f.stateBytes);
    if (mode === 1) {
      out.set(f.header);
      if (i > 0) out.set(keyBytes(0), 20);
      out.set(payloads[i], 20 + f.bindingBytes);
    }
    return out;
  });
}
function independentParentHeader(schema: RuntimeSchema, state: string): number[] {
  const types = new Map(schema.types.map(t => [t.name, t]));
  const reachable = new Map<string, unknown>();
  const visit = (name: string) => {
    if (reachable.has(name)) return;
    const t = types.get(name); assert(t, `missing reachable type ${name}`);
    reachable.set(name, t.kind === 'adt' ? { name, kind: t.kind,
      variants: t.variants.map(v => ({ name: v.name, tag: v.tag, fields: v.fields })) }
      : { name, kind: t.kind, ...(t.max === undefined ? {} : { max: t.max }) });
    if (t.kind === 'adt') t.variants.forEach(v => v.fields.forEach(f => visit(f.type)));
  };
  visit(state);
  const digest = crypto.createHash('sha256').update(JSON.stringify([...reachable.values()])).digest();
  return [66, 68, 83, 49, ...digest.subarray(0, 16)];
}
function independentFieldHeader(parent: number[], field: string, type: string, index: number): number[] {
  const digest = crypto.createHash('sha256').update(JSON.stringify({ parent, field, type, index })).digest();
  return [66, 68, 77, 50, ...digest.subarray(0, 16)];
}
function expectedLayout(schema: RuntimeSchema, codec: ReturnType<typeof wireCodec>, fixture: Fixture, options: any) {
  const root = schema.exports.find(x => x.name === 'process'); assert(root);
  const state = root.args[1], instruction = root.args[2];
  const st = typeBy(schema, state); assert.equal(st.kind, 'adt'); assert.equal(st.variants.length, 1);
  const declared = st.variants[0].fields;
  assert.deepEqual(options.stateAccounts, declared.map(f => f.name), `${fixture.name}: fixture layout follows source field declaration`);
  const parent = independentParentHeader(schema, state);
  const fields = declared.map((f, i) => {
    const bindingBytes = i === 0 ? 0 : 32;
    const payloadBytes = codec.encode(f.type, wire(schema, f.type, fieldNumber(schema, f.type, 0))).length;
    return { field: f.name, type: f.type, index: i === 0 ? 0 : i + (fixture.effects === 'none' ? 1 : 3),
      bindingBytes, header: independentFieldHeader(parent, f.name, f.type, i), stateBytes: 20 + bindingBytes + payloadBytes };
  });
  assert.equal(new Set(fields.map(f => JSON.stringify(f.header))).size, fields.length,
    `${fixture.name}: independently derived BDM2 headers must be pairwise distinct`);
  const instructionLengths = fixture.cases.map(c => codec.encode(instruction, wire(schema, instruction, c.ix)).length + 1);
  assert(instructionLengths.every(n => n === instructionLengths[0]), `${fixture.name}: fixed instruction wire size`);
  const min = fields.length + (fixture.effects === 'none' ? 1 : 3);
  return { fields, min, max: fixture.effects === 'none' ? min : 12, ixBytes: instructionLengths[0], state, instruction,
    slots: fixture.effects === 'none' ? 0 : 2, effects: fixture.effects,
    interfaceEffects: fixture.effects === 'none' ? 'none' : fixture.effects === 'token' ? 'token-v1' : 'cpi-v1' };
}
function layoutMismatch(candidate: any, expected: ReturnType<typeof expectedLayout>): string | undefined {
  if (candidate.version !== 2) return 'version';
  for (const k of ['state', 'instruction', 'minimumAccounts', 'maximumAccounts', 'instructionBytes'] as const) {
    const v = k === 'minimumAccounts' ? expected.min : k === 'maximumAccounts' ? expected.max :
      k === 'instructionBytes' ? expected.ixBytes : expected[k];
    if (candidate[k] !== v) return k;
  }
  if (candidate.effects !== expected.interfaceEffects || (candidate.effectSlots ?? (candidate.effects === 'none' ? 0 : 2)) !== expected.slots)
    return 'effects/effectSlots';
  if (!Array.isArray(candidate.stateAccounts) || candidate.stateAccounts.length !== expected.fields.length) return 'stateAccounts.length';
  for (let i = 0; i < expected.fields.length; ++i) for (const k of ['field', 'type', 'index', 'bindingBytes', 'header', 'stateBytes'] as const) {
    if (JSON.stringify(candidate.stateAccounts[i][k]) !== JSON.stringify(expected.fields[i][k])) return `stateAccounts[${i}].${k}`;
  }
  if (new Set(candidate.stateAccounts.map((f: any) => JSON.stringify(f.header))).size !== expected.fields.length)
    return 'stateAccounts.headers.notDistinct';
  return undefined;
}
function swappedFieldData(l: Layout, values: number[]): Uint8Array[] {
  const data = accountBytes(l, values, 1), a = 0, b = 1;
  const headerA = data[a].slice(0, 20), headerB = data[b].slice(0, 20);
  data[a].set(headerB, 0); data[b].set(headerA, 0);
  const offsetA = 20 + l.fields[a].bindingBytes, offsetB = 20 + l.fields[b].bindingBytes;
  const lengthA = l.fields[a].stateBytes - offsetA, lengthB = l.fields[b].stateBytes - offsetB;
  assert.equal(lengthA, lengthB, 'fixture pair must have equal payload sizes for an isolated field swap');
  const payloadA = data[a].slice(offsetA, offsetA + lengthA), payloadB = data[b].slice(offsetB, offsetB + lengthB);
  data[a].set(payloadB, offsetA); data[b].set(payloadA, offsetB);
  return data;
}
function decodeOk(l: Layout, field: number, bytes: Uint8Array) {
  try { l.codec.decode(l.fields[field].type, bytes); return true; } catch { return false; }
}

function makeScenario(l: Layout, c: Case, id: number, label: string, changes: Partial<Scenario> = {}): Scenario {
  const before = accountBytes(l, c.prior ?? Array(l.fields.length).fill(0), c.mode);
  return {
    id, label, case: c, count: l.min, alias: -1, dupA: -1, dupB: -1, actorSigner: c.actorSigner,
    ownerField: -1, ownerByte: -1, executableField: -1, writableField: -1, signerField: -1,
    sizeField: -1, sizeDelta: 0, dataFaultField: -1, dataFaultOffset: -1, dataFaultXor: 0,
    bindingField: -1, bindingChunk: -1, decodeField: -1, ixDecodeFail: false, clockFail: false,
    custody: 0n, custodyBump: (0xA7 + id * 17) & 0xff, rootMode: 0, rootCode: 0, encodeField: -1, validateSlot: -1, validateError: 0n,
    executeSlot: -1, executeError: 0n,
    ixLength: l.ixBytes, data: before, ix: Uint8Array.from([c.mode, ...l.codec.encode(l.instruction, wire(l.schema, l.instruction, c.ix))]),
    ...changes,
  };
}
function scenarios(l: Layout, fixture: Fixture): Scenario[] {
  const out: Scenario[] = []; let id = 0;
  const add = (c: Case, label: string, p: Partial<Scenario> = {}) => out.push(makeScenario(l, c, id++, label, p));
  for (const c of fixture.cases) add(c, c.name);
  const transition = fixture.cases.find(c => c.mode === 1 && 'accept' in c.expect)!;
  const initialize = fixture.cases.find(c => c.mode === 0)!;
  for (const n of [0, 1, l.min - 1, l.min, l.max, l.max + 1]) add(transition, `count-${n}`, { count: n });
  for (let i = 0; i < l.max; ++i) add(transition, `loader-alias@${i}`, { alias: i });
  for (let i = 0; i < l.fields.length; ++i) {
    const account = l.fields[i].index;
    for (let priorIndex = 0; priorIndex < account; ++priorIndex)
      add(transition, `duplicate-account${priorIndex}-state${i}`, { dupA: priorIndex, dupB: account });
    for (const byte of [0, 8, 16, 24]) add(transition, `owner-field${i}-chunk${byte / 8}`, { ownerField: i, ownerByte: byte });
    add(transition, `executable-field${i}`, { executableField: i });
    add(transition, `readonly-field${i}`, { writableField: i });
    for (const delta of [-1, 1]) add(transition, `size-field${i}-${delta}`, { sizeField: i, sizeDelta: delta });
    add(transition, `header-field${i}-first-byte`, { data: transitionData(l, transition, i, 0) });
    add(transition, `header-field${i}-last-byte`, { data: transitionData(l, transition, i, 19) });
    add(transition, `scripted-decode-field${i}`, { decodeField: i });
    add(initialize, `init-scripted-decode-field${i}`, { decodeField: i });
    const badTag = accountBytes(l, transition.prior!, 1);
    badTag[i][20 + l.fields[i].bindingBytes] = 0xff;
    add(transition, `malformed-codec-field${i}`, { data: badTag });
    add(initialize, `init-signer-field${i}`, { signerField: i });
    const nonzero = accountBytes(l, Array(l.fields.length).fill(0), 0);
    nonzero[i][l.fields[i].stateBytes - 1] = 1;
    add(initialize, `init-nonzero-field${i}`, { data: nonzero });
  }
  for (let i = 1; i < l.fields.length; ++i) for (let chunk = 0; chunk < 4; ++chunk) {
    const data = accountBytes(l, transition.prior!, 1);
    data[i][20 + 8 * chunk] ^= 0x80;
    add(transition, `binding-field${i}-key-chunk${chunk}`, { data });
  }
  add(transition, 'field-data-swap-0-1', { data: swappedFieldData(l, transition.prior!) });
  add(transition, 'owner-before-readonly-and-size-field0', { ownerField: 0, ownerByte: 0, writableField: 0, sizeField: 0 });
  add(transition, 'readonly-before-size-field0', { writableField: 0, sizeField: 0 });
  const initNonzero = accountBytes(l, Array(l.fields.length).fill(0), 0);
  initNonzero[0][l.fields[0].stateBytes - 1] = 1;
  add(initialize, 'init-signer-before-nonzero-data-field0', { signerField: 0, data: initNonzero });
  add(transition, 'instruction-codec-scripted-failure', { ixDecodeFail: true });
  for (const [name, mode, code] of [
    ['root-reject-zero', 1, 0], ['root-reject-normal', 1, 42], ['root-reject-last-accepted', 1, 0xfffffeff],
    ['root-reject-first-overflow', 1, 0xffffff00], ['root-reject-max-u32', 1, 0xffffffff], ['root-invalid-tag', 2, 0],
    ...(fixture.effects === 'none' ? [] : [['root-unextractable-effects', 3, 0] as [string, number, number]]),
  ] as Array<[string, number, number]>) add(transition, name, { rootMode: mode, rootCode: code });
  add(transition, 'reply-state-encode-failure', { encodeField: -2 });
  add(transition, 'root-reject-before-reply-encode-failure', { rootMode: 1, rootCode: 42, encodeField: -2 });
  for (let i = 0; i < l.fields.length; ++i) add(transition, `field-encode-failure-${i}`, { encodeField: i });
  add(transition, 'clock-syscall-failure', { clockFail: true });
  const badModeIx = Uint8Array.from([transition.mode, ...l.codec.encode(l.instruction, wire(l.schema, l.instruction, transition.ix))]);
  badModeIx[0] = 2;
  add(transition, 'instruction-before-custody-error', { ix: badModeIx, custody: 10n });
  if (fixture.effects !== 'none') {
    for (const e of [10n, (1n << 32n) + 11n]) add(transition, `custody-error-${e}`, { custody: e });
    add(transition, 'custody-before-owner-failure', { custody: 10n, ownerField: 0, ownerByte: 0 });
    for (let slot = 0; slot < l.slots; ++slot) {
      add(transition, `validate-error-slot${slot}`, { validateSlot: slot, validateError: (1n << 32n) + 40n + BigInt(slot) });
      add(transition, `validate-high-error-slot${slot}`, { validateSlot: slot, validateError: BigInt(slot + 1) << 32n });
      add(transition, `execute-failure-slot${slot}`, { executeSlot: slot, executeError: slot % 2 ? (1n << 40n) + 7n : 77n });
    }
  }
  if (fixture.effects === 'cpi') {
    const activeCase = fixture.cases.find(c => c.mode === 1)!;
    for (let slot = 0; slot < l.slots; ++slot) for (let f = 0; f < l.fields.length; ++f) {
      const target = l.fields[f].index;
      const c = withCpiMeta(activeCase, [{ index: target, writable: true }]);
      add(c, `cpi-writable-field${f}-slot${slot}`, { rootMode: slot === 1 ? 4 : 0 });
      add(c, `cpi-validation-precedes-22-field${f}-slot${slot}`, {
        rootMode: slot === 1 ? 4 : 0, validateSlot: slot, validateError: 0x100000000n + 91n,
      });
    }
    const readonlyManaged = withCpiMeta(activeCase, [{ index: l.fields[1].index, writable: false }]);
    add(readonlyManaged, 'cpi-readonly-managed-meta-success');
    const writableExternal = withCpiMeta(activeCase, [{ index: 10, writable: true }]);
    add(writableExternal, 'cpi-writable-external-meta-success', { count: 11 });
    const managedSecond = withCpiMeta(activeCase, [
      { index: 2, writable: false }, { index: l.fields[1].index, writable: true },
    ]);
    add(managedSecond, 'cpi-nonfirst-writable-managed-meta-denied');
    const lateWritableAlias = withCpiMeta(activeCase, [{ index: l.max - 1, writable: true }]);
    add(lateWritableAlias, 'late-equal-key-alias-with-writable-meta', {
      count: l.max, dupA: 0, dupB: l.max - 1,
    });
    const outOfCount = withCpiMeta(activeCase, [{ index: l.max - 1, writable: true }]);
    add(outOfCount, 'cpi-out-of-count-meta-rejected', { count: l.max - 1 });
  }
  add(transition, 'instruction-length-short', { ixLength: l.ixBytes - 1 });
  add(transition, 'instruction-length-long', { ixLength: l.ixBytes + 1 });
  const badMode = Uint8Array.from([transition.mode, ...l.codec.encode(l.instruction, wire(l.schema, l.instruction, transition.ix))]);
  badMode[0] = 2;
  add(transition, 'instruction-mode-invalid', { ix: badMode });
  if (out.length > 1) {
    const max = out.find(x => x.label === `count-${l.max}`)!;
    add(max.case, 'valid-maximum-account-count', { count: l.max });
  }
  return out;
}
function transitionData(l: Layout, c: Case, field: number, offset: number): Uint8Array[] {
  const data = accountBytes(l, c.prior!, 1); data[field][offset] ^= 0x80; return data;
}
function withCpiMeta(c: Case, metas: Array<{ index: number; writable: boolean }>): Case {
  const effect = invoke(metas);
  return { ...c, ix: runPair(effect), metas: [metas, metas] };
}

function parts(value: Value): { c: string; f: Record<string, Value> } {
  assert(typeof value === 'object' && value !== null, 'expected abstract fixture constructor');
  return value as { c: string; f: Record<string, Value> };
}
function numberValue(value: Value): number { assert.equal(typeof value, 'number'); return value as number; }
function boolValue(value: Value): boolean { assert.equal(typeof value, 'boolean'); return value as boolean; }
function keyValueBytes(value: Value): Uint8Array {
  const key = parts(value); assert.equal(key.c, 'Key');
  const out = new Uint8Array(32), view = new DataView(out.buffer);
  'abcdefgh'.split('').forEach((n, i) => view.setUint32(i * 4, numberValue(key.f[n]), true));
  return out;
}
function u64ValueBigInt(value: Value): bigint {
  const n = parts(value); assert.equal(n.c, 'U64');
  return BigInt(numberValue(n.f.lo)) | (BigInt(numberValue(n.f.hi)) << 32n);
}
function bytes64Value(value: Value): Uint8Array {
  const words = parts(value); assert.equal(words.c, 'Bytes64');
  const out = new Uint8Array(64), view = new DataView(out.buffer);
  'abcdefghijklmnop'.split('').forEach((n, i) => view.setUint32(i * 4, numberValue(words.f[n]), true));
  return out;
}
const ZERO_KEY = '00'.repeat(32);
function zeroEffectText(kind: 'token' | 'cpi'): string {
  return kind === 'token'
    ? [0, 0, 0, 0, 0, 0, ZERO_KEY, ZERO_KEY, 0, 0, 0, 0, 0, ZERO_KEY, ZERO_KEY].join(';')
    : [0, 0, 0, 0, ZERO_KEY, '00'.repeat(64),
      ...Array.from({ length: 8 }, () => [0, 0, 0, ZERO_KEY]).flat()].join(';');
}
function abstractEffectText(l: Layout, s: Scenario, slot: number, active: number): string {
  if (l.effects === 'token') {
    if (!active) return zeroEffectText('token');
    const plan = l.fixture.tokenPlan; assert(plan, `${l.fixture.name}: missing abstract token effect plan`);
    const transfer = plan.transfers[slot]; assert(transfer, `${l.fixture.name}: missing abstract transfer slot ${slot}`);
    const root = parts(s.case.ix), mint = keyValueBytes(root.f.mint);
    const amount = u64ValueBigInt(root.f[transfer.amount]);
    return [1, transfer.source, transfer.destination, transfer.mint,
      transfer.authority === 'actor' ? 0 : 1, transfer.recipient === 'actor' ? 0 : 1,
      HEX(mint), ZERO_KEY, amount, 0, 0, 0, 0, ZERO_KEY, ZERO_KEY].join(';');
  }
  assert.equal(l.effects, 'cpi');
  if (!active) return zeroEffectText('cpi');
  const run = parts(s.case.ix); assert.equal(run.c, 'Run');
  const effect = parts(run.f.effect);
  if (effect.c === 'None') return zeroEffectText('cpi');
  assert.equal(effect.c, 'Invoke');
  const f = effect.f, accounts = parts(f.accounts);
  const data = bytes64Value(slot === 0 ? f.data : run.f.second_data);
  const metas = 'abcdefgh'.split('').flatMap(n => {
    const m = parts(accounts.f[n]);
    return [numberValue(m.f.index), Number(boolValue(m.f.writable)), Number(boolValue(m.f.signer)), HEX(keyValueBytes(m.f.key))];
  });
  return [1, numberValue(f.program), numberValue(f.length), numberValue(f.count), HEX(keyValueBytes(f.program_key)), HEX(data), ...metas].join(';');
}
function codecId(l: Layout, type: string): number {
  return [...new Set(l.fields.map(f => f.type))].indexOf(type);
}

function helperAccountsText(l: Layout, s: Scenario): string {
  const stateAt = new Map(l.fields.map((f, i) => [f.index, i]));
  let loaderOffset = 8;
  return Array.from({ length: s.count }, (_, i) => {
    const key = keyBytes(i === s.dupB && s.dupA >= 0 ? s.dupA : i);
    const field = stateAt.get(i);
    const owner = new Uint8Array(32).fill(field === undefined ? 0x55 : MAS_PROGRAM_FILL);
    if (field !== undefined) {
      owner[31] = 1;
      if (s.ownerField === field && s.ownerByte >= 0 && s.ownerByte < 32)
        owner[s.ownerByte] ^= 1 << (field % 7);
    }
    const signer = field === undefined ? Number(i === 1 && s.actorSigner) : Number(s.signerField !== field);
    const writable = Number(field === undefined || s.writableField !== field);
    const executable = Number(field !== undefined && s.executableField === field);
    const base = field === undefined ? 8 : l.fields[field].stateBytes;
    const size = field === s.sizeField ? Math.max(0, base + s.sizeDelta) : base;
    const dataOffset = loaderOffset + 88, lamportsOffset = loaderOffset + 72;
    const rentEpoch = 0x6d61730000000000n + BigInt(i) * 0x101n;
    const row = `${i}~${HEX(key)}~${HEX(owner)}~${signer}~${writable}~${executable}~${size}~` +
      `${dataOffset}~${lamportsOffset}~${rentEpoch}`;
    loaderOffset += Math.ceil((88 + size + 10240) / 8) * 8 + 8;
    return row;
  }).join(';');
}

function scenarioContract(l: Layout, s: Scenario): Result {
  const events: string[] = []; let executed = 0, ret = '-', retCalls = 0;
  let custodyCalls = 0, validateCalls = 0, executeCalls = 0;
  const stopped = (code: bigint | number): Result => ({ rc: BigInt(code), trace: events.join(',') || '-',
    data: l.fields.map((f, i) => s.count > f.index ? HEX(s.data[i]) : '-'), ret, executed, outside: 0,
    custodyCalls, validateCalls, executeCalls, returnCalls: retCalls });
  const ixMode = s.ix[0] ?? 0xee;
  if (s.count < l.min || s.count > l.max) return stopped(1);
  for (let i = 0; i < s.count; ++i) if (s.alias === i || (s.dupA >= 0 && s.dupB === i && s.dupA < i)) return stopped(6);
  if (s.ixLength !== l.ixBytes || ixMode > 1) return stopped(2);
  if (l.effects !== 'none') { events.push(`c:1:${s.custodyBump}`); custodyCalls++; if (s.custody) return stopped(s.custody); }
  const init = ixMode === 0;
  for (let i = 0; i < l.fields.length; ++i) {
    const f = l.fields[i], data = s.data[i];
    if (s.ownerField === i || s.executableField === i) return stopped(3);
    if (s.writableField === i) return stopped(5);
    if (s.sizeField === i) return stopped(4);
    if (init) {
      if (s.signerField === i) return stopped(7);
      if (data.some(b => b !== 0)) return stopped(4);
      events.push(`d${i}:c${codecId(l, f.type)}:1:${f.stateBytes - 20 - f.bindingBytes}`);
      if (s.decodeField === i || !decodeOk(l, i, new Uint8Array(f.stateBytes - 20 - f.bindingBytes))) return stopped(4);
    } else {
      if (!f.header.every((b, j) => data[j] === b)) return stopped(4);
      if (i > 0 && !keyBytes(0).every((b, j) => data[20 + j] === b)) return stopped(4);
      const payload = data.subarray(20 + f.bindingBytes);
      events.push(`d${i}:c${codecId(l, f.type)}:1:${payload.length}`);
      if (s.decodeField === i || !decodeOk(l, i, payload)) return stopped(4);
    }
  }
  const encodedIx = s.ix.subarray(1, 1 + l.ixBytes - 1);
  events.push(`i:1:${l.ixBytes - 1}`);
  if (s.ixDecodeFail || (() => { try { l.codec.decode(l.instruction, encodedIx); return false; } catch { return true; } })()) return stopped(2);
  events.push('k'); if (s.clockFail) return stopped(8);
  const prior = init ? Array(l.fields.length).fill(0) : valuesFromData(l, s.data);
  events.push(`u:${HEX(l.codec.encode(l.instruction, wire(l.schema, l.instruction, s.case.ix)))}`);
  const rootFieldBytes = fieldPayload(l, prior).map(HEX);
  events.push(`r${Number(s.actorSigner)}:${HEX(keyBytes(1))}:${SLOT}:${rootFieldBytes[0]}`);
  for (let i = 1; i < rootFieldBytes.length; ++i) events.push(`f${i}:${rootFieldBytes[i]}`);
  let outcome: Expect = s.case.expect;
  if (s.rootMode === 1) outcome = { reject: s.rootCode };
  if (s.rootMode === 2) return stopped(9);
  if ('reject' in outcome) return stopped(outcome.reject <= 0xfffffeff ? 256n + BigInt(outcome.reject) : 9);
  events.push(`q:${l.codec.encode(l.state, stateWire(l, outcome.accept)).length}`);
  if (s.encodeField === -2) return stopped(9);
  for (let i = 0; i < l.fields.length; ++i) {
    const len = fieldPayload(l, outcome.accept)[i].length;
    events.push(`o${i}:c${codecId(l, l.fields[i].type)}:${len}`);
    if (s.encodeField === i) return stopped(9);
  }
  if (s.rootMode === 3) return stopped(9);
  if (l.effects !== 'none') {
    for (let slot = 0; slot < l.slots; ++slot) {
      const active = s.rootMode === 4 && slot === 0 ? 0 : (s.case.active[slot] ?? 0);
      const effect = abstractEffectText(l, s, slot, active);
      events.push(`v${slot}:${active}:${s.count}:1:${effect}:${helperAccountsText(l, s)}`); validateCalls++;
      const cpiMeta = l.effects === 'cpi' && active
        ? (s.case.metas?.[slot] ?? []).find(m => m.index < 0 || m.index >= s.count) : undefined;
      // This bound is supplied by the local helper mock, not emitted adapter C.
      if (cpiMeta) return stopped(21);
      if (s.validateSlot === slot && s.validateError) return stopped(s.validateError);
      if (l.effects === 'cpi' && active && (s.case.metas?.[slot] ?? []).some(m => m.writable && l.fields.some(f => f.index === m.index))) return stopped(22);
    }
    for (let slot = 0; slot < l.slots; ++slot) {
      const active = s.rootMode === 4 && slot === 0 ? 0 : (s.case.active[slot] ?? 0);
      const effect = abstractEffectText(l, s, slot, active);
      events.push(`x${slot}:${active}:${s.count}:${s.custodyBump}:${effect}:${helperAccountsText(l, s)}`); executeCalls++;
      if (s.executeSlot === slot && s.executeError) return stopped(18);
      executed++;
    }
  }
  const payloads = fieldPayload(l, outcome.accept);
  const committed = l.fields.map((f, i) => {
    const data = new Uint8Array(f.stateBytes); data.set(f.header);
    if (i > 0) data.set(keyBytes(0), 20);
    data.set(payloads[i], 20 + f.bindingBytes); return data;
  });
  const reply = l.codec.encode(l.state, stateWire(l, outcome.accept));
  events.push(`R:${reply.length}`); retCalls = 1; ret = `1:${HEX(reply)}`;
  return { rc: 0n, trace: events.join(','), data: l.fields.map((_, i) => s.count > l.fields[i].index ? HEX(committed[i]) : '-'),
    ret, executed, outside: 0, custodyCalls, validateCalls, executeCalls, returnCalls: retCalls };
}
function valuesFromData(l: Layout, data: Uint8Array[]): number[] {
  return l.fields.map((f, i) => {
    const v = l.codec.decode(f.type, data[i].subarray(20 + f.bindingBytes));
    const t = typeBy(l.schema, f.type); assert.equal(t.kind, 'adt');
    return Number((v as any).fields[t.variants[0].fields[0].name]);
  });
}
function compare(l: Layout, scenarios: Scenario[], observed: Map<number, Result>) {
  for (const s of scenarios) {
    const o = observed.get(s.id); if (!o) return { scenario: s.label, missing: true };
    const e = scenarioContract(l, s);
    for (const k of Object.keys(e) as Array<keyof Result>) if (e[k] !== o[k] &&
        (typeof e[k] === 'bigint' || typeof o[k] === 'bigint' || JSON.stringify(e[k]) !== JSON.stringify(o[k])))
      return { scenario: s.label, field: k, expected: e[k], observed: o[k] };
    if (o.outside !== 0) return { scenario: s.label, invariant: 'write escaped all declared state data regions' };
    if (o.rc !== 0n && o.data.some((v, i) => s.count > l.fields[i].index && v !== HEX(s.data[i])))
      return { scenario: s.label, invariant: 'a failure return changed a managed account' };
    if (o.rc !== 0n && o.ret !== '-') return { scenario: s.label, invariant: 'return data was set on failure' };
    const events = o.trace === '-' ? [] : o.trace.split(',');
    const root = events.findIndex(x => x.startsWith('r'));
    const firstExec = events.findIndex(x => x.startsWith('x'));
    if (firstExec >= 0) {
      for (let slot = 0; slot < l.slots; ++slot) {
        const v = events.findIndex(x => x.startsWith(`v${slot}:`));
        if (v < 0 || v >= firstExec) return { scenario: s.label, invariant: `slot ${slot} executed before all validations` };
      }
    }
    if (root >= 0 && (events.filter(x => x.startsWith('r')).length !== 1 || events.indexOf('k') > root))
      return { scenario: s.label, invariant: 'root call missing clock or repeated' };
    if (o.rc !== 0n && firstExec >= 0 && o.executeCalls === 0) return { scenario: s.label, invariant: 'failure ordering observation inconsistent' };
  }
  return undefined;
}

function serialize(s: Scenario): string {
  const nums = [s.count, s.alias, s.dupA, s.dupB, Number(s.actorSigner), s.ownerField, s.ownerByte,
    s.executableField, s.writableField, s.signerField, s.sizeField, s.sizeDelta, s.dataFaultField,
    s.dataFaultOffset, s.dataFaultXor, s.bindingField, s.bindingChunk, s.decodeField, Number(s.ixDecodeFail),
    Number(s.clockFail), s.rootMode, String(s.custody), s.custodyBump, s.rootCode, s.encodeField, s.validateSlot,
    String(s.validateError), s.executeSlot, String(s.executeError), s.ixLength];
  return `${s.id} ${nums.join(' ')} ${s.data.map(HEX).join(' ')} ${HEX(s.ix)}`;
}
const FLAGS = ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function', '-Wno-unused-variable',
  '-fsanitize=address,undefined', '-fno-sanitize-recover=all'];
const run$ = promisify(execFile);
function parse(stdout: string, fields: number) {
  const results = new Map<number, Result>(); let done = false;
  for (const line of stdout.split('\n')) {
    if (line === 'done') { done = true; continue; }
    const p = line.trim().split(' '); if (p.length !== 10 + fields) continue;
    const id = Number(p[0]);
    results.set(id, { rc: BigInt(p[1]), trace: p[2], data: p.slice(3, 3 + fields), ret: p[3 + fields],
      executed: Number(p[4 + fields]), outside: Number(p[5 + fields]), custodyCalls: Number(p[6 + fields]),
      validateCalls: Number(p[7 + fields]), executeCalls: Number(p[8 + fields]), returnCalls: Number(p[9 + fields]) });
  }
  return { results, done };
}
async function execute(binary: string, scenarioFile: string, fields: number) {
  try {
    const r = await run$(binary, [scenarioFile], { maxBuffer: 1 << 27, timeout: 300_000 });
    return { ...parse(r.stdout, fields), exit: 0 as number | string, stderr: r.stderr };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
    if (x.stdout === undefined) throw e;
    return { ...parse(x.stdout, fields), exit: x.code ?? x.signal ?? 'failed', stderr: x.stderr ?? '' };
  }
}
function cUnit(b: BuiltFixture, adapterFile: string): string {
  const { schema, layout, root, stateType, acceptedTag, rejectedTag, accepted, rejected } = b;
  const get = layout.fields.map((f, i) => {
    const st = stateType.variants[0]; return `#define MAS_FIELD_TYPE_${i} ${typeBy(schema, f.type).cType}\n#define MAS_FIELD_BYTES_${i} ${f.stateBytes - 20 - f.bindingBytes}\n#define MAS_RAW_DECODE_${i} ${mangle(f.type)}_decode\n#define MAS_RAW_ENCODE_${i} ${mangle(f.type)}_encode\n#define MAS_GET_FIELD_${i}(s) ((s).as.c${st.tag}.f${i})`;
  }).join('\n');
  const uniqueTypes = [...new Set(layout.fields.map(f => f.type))];
  const codecMacros = uniqueTypes.map((t, i) => `#define MAS_CODEC_TYPE_${i} ${typeBy(schema, t).cType}\n` +
    `#define MAS_CODEC_DECODE_${i} ${mangle(t)}_decode\n#define MAS_CODEC_ENCODE_${i} ${mangle(t)}_encode`).join('\n');
  const redirect = uniqueTypes.map((t, i) => `#define ${mangle(t)}_decode(p,n,out) mas_decode_field(${i}u,(p),(n),(out))\n` +
    `#define ${mangle(t)}_encode(p,n,value) mas_encode_field(${i}u,(p),(n),(value))`).join('\n');
  const contextType = typeBy(schema, root.args[0]); assert.equal(contextType.kind, 'adt');
  const ctx = contextType.variants[0];
  const keyType = typeBy(schema, ctx.fields[0].type); assert.equal(keyType.kind, 'adt');
  const actorBytes = keyType.variants[0].fields.flatMap((_, i) => {
    const x = `(c).as.c${ctx.tag}.f0.as.c${keyType.variants[0].tag}.f${i}`;
    return [`(u8)(${x})`, `(u8)((${x}) >> 8)`, `(u8)((${x}) >> 16)`, `(u8)((${x}) >> 24)`];
  }).join(', ');
  const outcomeF = accepted.fields[1];
  let spoil = '((void)(o))', cpiNone = '((void)(o))';
  if (outcomeF) {
    const effectsType = typeBy(schema, outcomeF.type); assert.equal(effectsType.kind, 'adt');
    spoil = `((o).as.c${acceptedTag}.f1.tag = 99u)`;
    if (layout.effects === 'cpi') {
      const effectTypeName = effectsType.variants[0].fields[0].type;
      const effectType = typeBy(schema, effectTypeName); assert.equal(effectType.kind, 'adt');
      const none = effectType.variants.find(v => v.name.split('.').at(-1) === 'None'); assert(none);
      cpiNone = `((o).as.c${acceptedTag}.f1.as.c${effectsType.variants[0].tag}.f0.tag = ${none.tag}u)`;
    }
  }
  const stateVariant = stateType.variants[0];
  const min = layout.min;
  return `#include "types.h"\n#include "codecs.h"\n${get}
#define MAS_FIELDS ${layout.fields.length}
#define MAS_CODEC_COUNT ${uniqueTypes.length}
${codecMacros}
#define MAS_EFFECTS ${{ none: 0, token: 1, cpi: 2 }[layout.effects]}
#define MAS_MIN_ACCOUNTS ${min}
#define MAS_FIELD_BYTES(i) (${layout.fields.map((_, i) => `(i)==${i}?MAS_FIELD_BYTES_${i}:`).join('')}0)
#define MAS_INDEX_0 ${layout.fields[0].index}
${layout.fields.slice(1).map((f, i) => `#define MAS_INDEX_${i + 1} ${f.index}`).join('\n')}
#define MAS_STATE_TYPE ${stateType.cType}
#define MAS_IX_TYPE ${typeBy(schema, layout.instruction).cType}
#define MAS_CONTEXT_TYPE ${contextType.cType}
#define MAS_OUT_TYPE ${typeBy(schema, root.result).cType}
#define MAS_RAW_IX_DECODE ${mangle(layout.instruction)}_decode
#define MAS_RAW_IX_ENCODE ${mangle(layout.instruction)}_encode
#define MAS_RAW_STATE_ENCODE ${mangle(layout.state)}_encode
#define MAS_IX_PAYLOAD_BYTES ${layout.ixBytes - 1}
#define MAS_REAL_ROOT ${root.cName}
#define MAS_SET_REJECT(o, code) ((o).tag = ${rejectedTag}u, (o).as.c${rejectedTag}.f0 = (code))
#define MAS_BAD_TAG ${typeBy(schema, root.result).variants.length + 7}u
#define MAS_SPOIL_EFFECTS(o) ${spoil}
#define MAS_FIRST_CPI_SLOT_NONE(o) ${cpiNone}
#define MAS_CONTEXT_SIGNED(c) ((c).as.c${ctx.tag}.f1)
#define MAS_CONTEXT_SLOT(c) ((u64)(c).as.c${ctx.tag}.f2.as.c${typeBy(schema, ctx.fields[2].type).variants[0].tag}.f0 | ((u64)(c).as.c${ctx.tag}.f2.as.c${typeBy(schema, ctx.fields[2].type).variants[0].tag}.f1 << 32))
#define MAS_CONTEXT_ACTOR_BYTES(c) ((const u8[]){${actorBytes}})
${layout.fields.map(f => `#define MAS_STATE_BYTES_${layout.fields.indexOf(f)} ${f.stateBytes}`).join('\n')}
#define MAS_STATE_INDEX_VALUES {${layout.fields.map(f => f.index).join(',')}}
#define MAS_STATE_BYTE_VALUES {${layout.fields.map(f => f.stateBytes).join(',')}}
#include "multi-adapter-semantics-harness.h"
${redirect}
#define ${root.cName} mas_root
#define ${mangle(layout.instruction)}_decode mas_decode_ix
#define ${mangle(layout.state)}_encode mas_encode_state
${layout.effects === 'none' ? '' : `#define ${layout.effects === 'cpi' ? 'bend_invoke_custody' : 'bend_custody'} mas_custody
#define ${layout.effects === 'cpi' ? 'bend_invoke' : 'bend_transfer'}_validate(e,a,n) mas_validate(transfers,(e),(a),(n))
#define ${layout.effects === 'cpi' ? 'bend_invoke' : 'bend_transfer'}_execute(e,a,n,b) mas_execute(transfers,(e),(a),(n),(b))`}
#include "${adapterFile}"
`;
}

const mutants: Array<{ name: string; fixture: string[]; apply: (c: string, b: BuiltFixture) => string }> = [
  { name: 'helper data pointers for accounts 4 and 5 swapped', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const loop = `for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`;
    return replaceOnce(c, loop, `u8 *pointer_swap=accounts[4].data; accounts[4].data=accounts[5].data; ` +
      `accounts[5].data=pointer_swap;\n  ${loop}`);
  } },
  { name: 'helper lamports pointers for accounts 4 and 5 swapped', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const loop = `for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`;
    return replaceOnce(c, loop, `u64 *pointer_swap=accounts[4].lamports; accounts[4].lamports=accounts[5].lamports; ` +
      `accounts[5].lamports=pointer_swap;\n  ${loop}`);
  } },
  { name: 'token slot 0 amount doubled', fixture: ['token-3'], apply: (c, b) => {
    const start = `return 9;\n  for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`;
    return replaceOnce(c, start, `return 9;\n  transfers[0].amount*=2;\n  for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`);
  } },
  { name: 'token effect slots swapped', fixture: ['token-3'], apply: (c, b) => replaceOnce(c,
    `return 9;\n  for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`,
    `return 9;\n  { BendTransfer tmp=transfers[0]; transfers[0]=transfers[1]; transfers[1]=tmp; }\n  for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`) },
  { name: 'CPI slot 1 data byte corrupted', fixture: ['cpi-4'], apply: (c, b) => replaceOnce(c,
    `return 9;\n  for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`,
    `return 9;\n  transfers[1].data[0]^=1;\n  for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`) },
  { name: 'CPI managed meta check only examines first meta', fixture: ['cpi-4'], apply: c => replaceOnce(c,
    'for(unsigned j=0;j<transfers[i].count;++j)', 'for(unsigned j=0;j<transfers[i].count && j<1;++j)') },
  { name: 'CPI managed meta check ignores writable flag', fixture: ['cpi-4'], apply: c => replaceOnce(c,
    'if(transfers[i].metas[j].writable && (', 'if((') },
  { name: 'wrong secondary account binding omitted', fixture: ['pure-2', 'token-3', 'cpi-4'], apply: (c, b) => replaceOnce(c,
    `if(!equal_key(state1.data+20,state0.key)) return 4;`, '') },
  { name: 'last field header check omitted', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const i = b.layout.fields.length - 1; return replaceOnce(c, `for(unsigned j=0;j<20;++j) if(state${i}.data[j]!=header${i}[j]) return 4;`, '');
  } },
  { name: 'primary owner compares only one chunk', fixture: ['pure-2', 'token-3', 'cpi-4'], apply: c =>
    replaceOnce(c, `!equal_key(state0.owner,program)`, `!__builtin_memcmp(state0.owner,program,8)`) },
  { name: 'last field writable check omitted', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const i = b.layout.fields.length - 1; return replaceOnce(c, `if (!state${i}.writable) return 5;`, '');
  } },
  { name: 'last field decoder replaced with defined zero state', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const i = b.layout.fields.length - 1, type = b.layout.fields[i].type;
    // A bare decode omission leaves the automatic local indeterminate and only
    // demonstrates undefined behavior. Replace it with a defined wrong value
    // so this mutation remains eligible for a semantic-oracle comparison.
    return replaceOnce(c, `if(!${mangle(type)}_decode(state${i}.data+${20 + b.layout.fields[i].bindingBytes},${b.layout.fields[i].stateBytes - 20 - b.layout.fields[i].bindingBytes},&before${i})) return 4;`,
      `memset(&before${i},0,sizeof(before${i}));`);
  } },
  { name: 'last field payload commit omitted', fixture: ['pure-2', 'token-3', 'cpi-4'], apply: (c, b) => {
    const i = b.layout.fields.length - 1, f = b.layout.fields[i];
    return replaceOnce(c, `__builtin_memcpy(state${i}.data+${20 + f.bindingBytes},encoded${i},${f.stateBytes - 20 - f.bindingBytes});`, '');
  } },
  { name: 'high rejection code accepted', fixture: ['pure-2', 'token-3', 'cpi-4'], apply: c =>
    replaceOnce(c, `code<=0xfffffeffu?256ULL+code:9`, `code<=0xffffffffu?256ULL+code:9`) },
  { name: 'second effect validation omitted', fixture: ['token-3', 'cpi-4'], apply: (c, b) =>
    replaceOnce(c, `for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`, `for(unsigned i=0;i<${b.layout.slots - 1};++i) { u64 error=`) },
  { name: 'second effect execution omitted', fixture: ['token-3', 'cpi-4'], apply: (c, b) =>
    replaceOnce(c, `for(unsigned i=0;i<${b.layout.slots};++i) if(`, `for(unsigned i=0;i<${b.layout.slots - 1};++i) if(`) },
  { name: 'CPI writable managed-account denial omitted', fixture: ['cpi-4'], apply: c => replaceOnce(c, 'return 22;', '{ (void)j; }') },
  { name: 'token program and custody accounts swapped before helpers', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const loop = `for(unsigned i=0;i<${b.layout.slots};++i) { u64 error=`;
    return replaceOnce(c, loop, `Account account_swap=accounts[2]; accounts[2]=accounts[3]; accounts[3]=account_swap;\n  ${loop}`);
  } },
  { name: 'executor receives truncated account count', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const helper = b.layout.effects === 'cpi' ? 'bend_invoke_execute' : 'bend_transfer_execute';
    return replaceOnce(c, `${helper}(&transfers[i],accounts,(unsigned)count,bump)`,
      `${helper}(&transfers[i],accounts,(unsigned)MAS_MIN_ACCOUNTS,bump)`);
  } },
  { name: 'executor receives constant custody bump', fixture: ['token-3', 'cpi-4'], apply: (c, b) => {
    const helper = b.layout.effects === 'cpi' ? 'bend_invoke_execute' : 'bend_transfer_execute';
    return replaceOnce(c, `${helper}(&transfers[i],accounts,(unsigned)count,bump)`,
      `${helper}(&transfers[i],accounts,(unsigned)count,0xA7)`);
  } },
  { name: 'late duplicate-key comparison omitted', fixture: ['cpi-4'], apply: (c, b) => {
    const boundary = b.layout.fields.at(-1)!.index + 1;
    return replaceOnce(c, 'for (unsigned j=0;j<i;++j) if (equal_key(accounts[i].key,accounts[j].key)) return 6;',
      `if(i<${boundary}) for (unsigned j=0;j<i;++j) if (equal_key(accounts[i].key,accounts[j].key)) return 6;`);
  } },
  { name: 'CPI effect validation omitted', fixture: ['cpi-4'], apply: c => replaceOnce(c,
    'u64 error=bend_invoke_validate(&transfers[i],accounts,(unsigned)count);', 'u64 error=0;') },
  { name: 'reply account commit omitted', fixture: ['pure-2', 'token-3', 'cpi-4'], apply: (c, b) =>
    replaceOnce(c, `sol_set_return_data(reply,${b.layout.codec.encode(b.layout.state, stateWire(b.layout, Array(b.layout.fields.length).fill(0))).length});`, '') },
];
function replaceOnce(c: string, from: string, to: string): string {
  const i = c.indexOf(from); assert(i >= 0, `mutation anchor missing: ${from}`);
  assert.equal(c.indexOf(from, i + from.length), -1, `mutation anchor ambiguous: ${from}`);
  return c.slice(0, i) + to + c.slice(i + from.length);
}

async function pool<T>(jobs: Array<() => Promise<T>>, width: number): Promise<T[]> {
  const out: T[] = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  })); return out;
}
async function compile(cc: string, dir: string, stem: string, unit: string, adapter: string, extra: string[] = []) {
  fs.writeFileSync(path.join(dir, `${stem}.adapter.c`), adapter);
  fs.writeFileSync(path.join(dir, `${stem}.unit.c`), unit.replace('__ADAPTER_FILE__', `${stem}.adapter.c`));
  await run$(cc, [...FLAGS, ...extra, '-Iruntime', '-Itests', `-I${dir}`, path.join(dir, `${stem}.unit.c`), '-o', path.join(dir, stem)]);
}

function executionClassification(result: { exit: number | string; stderr: string }): string {
  if (/AddressSanitizer|UndefinedBehaviorSanitizer|runtime error:|LeakSanitizer|MemorySanitizer/i.test(result.stderr))
    return 'sanitizer/UB evidence';
  if (result.exit !== 0) return 'abnormal execution';
  if (result.stderr) return 'unexpected stderr';
  return 'clean execution';
}

export async function testMultiAdapterSemantics() {
  const out = 'build/multi-adapter-semantics'; fs.mkdirSync(out, { recursive: true });
  const reportPath = path.join(out, 'report.json'); fs.rmSync(reportPath, { force: true }); fs.rmSync(`${reportPath}.tmp`, { force: true });
  assert.equal(fs.existsSync(reportPath), false, 'a previous success report must not survive a new run');
  assert.equal(fs.existsSync(`${reportPath}.tmp`), false, 'a previous partial report must not survive a new run');
  const cc = process.env.CC ?? 'clang';
  const compiler = execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0];
  const bendRevision = execFileSync('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bendStatus = execFileSync('git', ['-C', '.deps/bend', 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
  assert.equal(bendRevision, '7561656155a4285c1e4ccfcb3505ab59524de973', 'native assurance requires the pinned Bend checkout');
  assert.equal(bendStatus, '', 'native assurance requires a clean Bend checkout');
  const sourceInputs = [...new Set([
    'tests/multi-adapter-semantics.ts', 'tests/multi-adapter-semantics-harness.h',
    ...fixtures.flatMap(f => [f.source, f.config]),
    ...fs.readdirSync('compiler').filter(f => f.endsWith('.ts')).map(f => path.join('compiler', f)),
    '.deps/bend/bend2/bend.ts',
    'compiler/storage.ts', 'compiler/multi-storage.ts', 'compiler/effects.ts', 'compiler/cpi-effects.ts',
    'tests/cpi-pair.bend', 'sdk/context.bend', 'sdk/math.bend', 'sdk/effects.bend', 'sdk/cpi.bend',
    'runtime/solana_min.h', 'runtime/token.h', 'runtime/bend_cpi.h', 'runtime/cpi_abi.h', 'sdk/wire.ts',
  ])].sort();
  const inputHashes = Object.fromEntries(sourceInputs.map(f => [f, sha(fs.readFileSync(f))]));
  const report: any = { passed: true, compiler, bunVersion: Bun.version,
    bendDependency: { revision: bendRevision, workingTreeClean: true }, flags: FLAGS, scope:
    'Native ASan/UBSan semantic execution of actual emitted ABI2 multi-state adapter C for 2/3/4 fields. Actual loader, generated codecs, Bend roots, effect extraction, state account checks, commit and reply encoding run. Every token/CPI effect field, exact execute account count, every passed account key/owner/signer/writable/executable/size identity, data/lamports pointer offset and rent_epoch value, and the scenario custody bump are observed at validate and execute boundaries; those helpers and custody are mocked. The out-of-count CPI meta rejection is implemented by the mas_validate mock and is not an execution of runtime/bend_cpi.h. Layout headers, account counts and sizes are independently derived from the checked fixture schema. Root rejection/tag/effect and codec failures are explicit scripts. Token/CPI program semantics, source-to-C/LLVM/SBF, Solana transaction rollback and end-to-end verification are not proved.',
    mockedBoundaryChecks: ['custody derivation', 'token/CPI validation and execution',
      'out-of-count CPI meta rejection (mas_validate mock)'],
    inputs: inputHashes, fixtures: [] };
  const built: BuiltFixture[] = [];
  for (const fixture of fixtures) {
    const schema = new Backend(await checkedBook(fixture.source)).emit(['process']).schema;
    const options = JSON.parse(fs.readFileSync(fixture.config, 'utf8'));
    const emitted = new Backend(await checkedBook(fixture.source)).emit(['process']);
    const storage = emitStorage(schema, 'process', options);
    const codec = wireCodec(schema);
    const independent = expectedLayout(schema, codec, fixture, options);
    const mismatch = layoutMismatch(storage.interface, independent);
    assert.equal(mismatch, undefined, `${fixture.name}: generated interface differs from independent ABI2 layout at ${mismatch}`);
    if (fixture.name === 'pure-2') {
      const collision = structuredClone(storage.interface);
      collision.stateAccounts[1].header = [...collision.stateAccounts[0].header];
      assert.equal(layoutMismatch(collision, independent), 'stateAccounts[1].header',
        'the independent layout oracle rejects a same-type field-header collision');
    }
    const root = schema.exports.find(x => x.name === 'process')!;
    const resultType = typeBy(schema, root.result); assert.equal(resultType.kind, 'adt');
    const accepted = resultType.variants.find(x => x.name.split('.').at(-1) === 'Accepted')!;
    const rejected = resultType.variants.find(x => x.name.split('.').at(-1) === 'Rejected')!;
    const stateType = typeBy(schema, storage.interface.state); assert.equal(stateType.kind, 'adt');
    const intf = storage.interface;
    const layout: Layout = { ...independent, codec, schema, interface: intf, fixture };
    assert.equal(layout.fields.length, Number(fixture.name.at(-1)), `${fixture.name}: fixture field count`);
    assert.deepEqual(layout.fields.map(f => f.index), fixture.effects === 'none' ? [0, ...layout.fields.slice(1).map((_, i) => i + 2)] :
      [0, ...layout.fields.slice(1).map((_, i) => i + 4)]);
    const dir = path.join(out, fixture.name); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'types.h'), emitted.c);
    fs.writeFileSync(path.join(dir, 'codecs.h'), emitCodecs(schema));
    built.push({ fixture, schema, emitted, storage, layout, root, stateType, accepted, rejected,
      acceptedTag: accepted.tag, rejectedTag: rejected.tag, dir });
  }
  const artifacts: Record<string, string> = {}, unitArtifacts: Record<string, string> = {};
  let totalCases = 0, totalMutants = 0;
  for (const b of built) {
    const { fixture, layout, dir } = b;
    const list = scenarios(layout, fixture); totalCases += list.length;
    const scenarioFile = path.join(dir, 'scenarios.txt');
    const scenarioText = `${list.map(serialize).join('\n')}\n`; fs.writeFileSync(scenarioFile, scenarioText);
    const adapterFile = 'emitted.adapter.c';
    const unit = cUnit(b, adapterFile).replace(adapterFile, '__ADAPTER_FILE__');
    await compile(cc, dir, 'emitted', unit, b.storage.c);
    unitArtifacts[fixture.name] = sha(fs.readFileSync(path.join(dir, 'emitted.unit.c')));
    assert.equal(sha(fs.readFileSync(path.join(dir, 'emitted.adapter.c'))), sha(b.storage.c), 'adapter included unchanged');
    const positive = await execute(path.join(dir, 'emitted'), scenarioFile, layout.fields.length);
    assert.equal(positive.exit, 0, `${fixture.name}: emitted C ${executionClassification(positive)}\n${positive.stderr.slice(0, 2500)}`);
    assert.equal(positive.stderr, '', `${fixture.name}: emitted C ${executionClassification(positive)}\n${positive.stderr.slice(0, 2500)}`);
    assert(positive.done && positive.results.size === list.length, `${fixture.name}: incomplete emitted matrix`);
    const mismatch = compare(layout, list, positive.results);
    assert.equal(mismatch, undefined, `${fixture.name}: actual ABI2 adapter disagrees with independent contract: ${JSON.stringify(mismatch, (_, v) => typeof v === 'bigint' ? String(v) : v)}`);
    const returnCodes = new Map<string, number>();
    for (const r of positive.results.values()) returnCodes.set(String(r.rc), (returnCodes.get(String(r.rc)) ?? 0) + 1);
    const needed = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '256', '298', String(256 + 0xfffffeff),
      ...(fixture.effects === 'none' ? [] : ['10', String((1n << 32n) + 11n), '18', String((1n << 32n) + 40n),
        String(1n << 32n)]), ...(fixture.effects === 'cpi' ? ['21', '22'] : [])];
    for (const code of needed) assert(returnCodes.has(code), `${fixture.name}: return code ${code} not exercised`);
    if (fixture.effects !== 'none') for (let slot = 0; slot < layout.slots; ++slot) {
      assert(list.some(s => s.executeSlot === slot && positive.results.get(s.id)?.rc === 18n), `${fixture.name}: execution failure slot ${slot} absent`);
      assert(list.some(s => s.validateSlot === slot && positive.results.get(s.id)?.rc === s.validateError), `${fixture.name}: validation failure slot ${slot} absent`);
    }
    if (fixture.effects === 'cpi') for (let slot = 0; slot < layout.slots; ++slot) for (let f = 0; f < layout.fields.length; ++f) {
      const s = list.find(x => x.label === `cpi-writable-field${f}-slot${slot}`)!;
      const o = positive.results.get(s.id)!;
      assert.equal(o.rc, 22n, `${fixture.name}: writable state field ${f}, slot ${slot} was not denied`);
      if (slot === 1) {
        const validation = o.trace.split(',').filter(x => x.startsWith('v'));
        assert(validation[0].startsWith('v0:0:7:1:') && validation[1].startsWith('v1:1:7:1:'),
          'second CPI slot must be active after slot 0 is explicitly inactive');
      }
    }
    if (fixture.effects === 'cpi') for (const [label, rc] of [
      ['cpi-readonly-managed-meta-success', 0n], ['cpi-writable-external-meta-success', 0n],
      ['cpi-nonfirst-writable-managed-meta-denied', 22n],
    ] as Array<[string, bigint]>) {
      const s = list.find(x => x.label === label); assert(s, `${fixture.name}: missing CPI meta scenario ${label}`);
      assert.equal(positive.results.get(s.id)?.rc, rc, `${fixture.name}: CPI meta scenario ${label}`);
    }
    if (fixture.effects === 'cpi') {
      const lateAlias = list.find(x => x.label === 'late-equal-key-alias-with-writable-meta')!;
      const lateAliasResult = positive.results.get(lateAlias.id)!;
      assert.equal(lateAliasResult.rc, 6n, `${fixture.name}: duplicate key at final passed account must reject`);
      assert.equal(lateAliasResult.validateCalls, 0, `${fixture.name}: late duplicate must reject before validation`);
      assert.equal(lateAliasResult.executeCalls, 0, `${fixture.name}: late duplicate must reject before execution`);
      const outOfCount = list.find(x => x.label === 'cpi-out-of-count-meta-rejected')!;
      const outOfCountResult = positive.results.get(outOfCount.id)!;
      assert.equal(outOfCountResult.rc, 21n, `${fixture.name}: CPI meta outside execute account count must reject`);
      assert.equal(outOfCountResult.executeCalls, 0, `${fixture.name}: out-of-count CPI meta must reject before execution`);
    }
    const selected = mutants.filter(m => m.fixture.includes(fixture.name));
    const killed = await pool(selected.map((m, n) => async () => {
      const changed = m.apply(b.storage.c, b); assert.notEqual(changed, b.storage.c, `${m.name}: no adapter mutation`);
      const stem = `mutant-${String(n).padStart(2, '0')}`;
      await compile(cc, dir, stem, cUnit(b, `${stem}.adapter.c`), changed);
      const r = await execute(path.join(dir, stem), scenarioFile, layout.fields.length);
      assert.equal(r.exit, 0, `${fixture.name}/${m.name}: mutant is not a semantic mismatch; ` +
        `${executionClassification(r)} (${r.exit})\n${r.stderr.slice(0, 1200)}`);
      assert.equal(r.stderr, '', `${fixture.name}/${m.name}: mutant emitted ${executionClassification(r)}\n${r.stderr.slice(0, 1200)}`);
      assert(r.done && r.results.size === list.length, `${fixture.name}/${m.name}: mutant matrix incomplete`);
      const failure = compare(layout, list, r.results);
      assert(failure, `${fixture.name}: mutant survived completed matrix: ${m.name}`);
      return { name: m.name, classification: 'semantic-mismatch', completedScenarios: r.results.size,
        sourceSha256: sha(changed), binarySha256: sha(fs.readFileSync(path.join(dir, stem))), failure };
    }), Math.max(1, Math.min(4, os.cpus().length - 1)));
    totalMutants += killed.length;
    const obs = list.map(s => { const o = positive.results.get(s.id)!; return [s.id, String(o.rc), o.trace, ...o.data, o.ret,
      o.executed, o.outside, o.custodyCalls, o.validateCalls, o.executeCalls, o.returnCalls].join(' '); }).join('\n');
    const observationsText = `${obs}\n`, observationsBytes = Buffer.from(observationsText);
    const observationsFile = path.join(dir, 'observations.txt'); fs.writeFileSync(observationsFile, observationsBytes);
    report.fixtures.push({ name: fixture.name, source: fixture.source, sourceSha256: sha(fs.readFileSync(fixture.source)),
      config: fixture.config, configSha256: sha(fs.readFileSync(fixture.config)), interface: layout.interface,
      adapterSha256: sha(b.storage.c), typesSha256: sha(b.emitted.c), codecsSha256: sha(emitCodecs(b.schema)),
      independentLayout: { fields: layout.fields, minimumAccounts: layout.min, maximumAccounts: layout.max,
        instructionBytes: layout.ixBytes, effects: layout.effects, effectSlots: layout.slots },
      codecObservability: { uniqueTypes: [...new Set(layout.fields.map(f => f.type))],
        sameTypeFieldsShareCodecIdentity: true },
      stateFields: layout.fields.map(f => ({ field: f.field, index: f.index, header: f.header, bindingBytes: f.bindingBytes,
        stateBytes: f.stateBytes, type: f.type })), scenarioFile, scenarios: list.length,
      scenarioLabels: list.map(s => s.label), layoutOracleNegativeChecks: fixture.name === 'pure-2'
        ? ['same-type field-header collision rejected'] : [],
      scenariosSha256: sha(Buffer.from(scenarioText)), observationsFile,
      observationsSha256: sha(observationsBytes), returnCodes: Object.fromEntries([...returnCodes].sort((a, b) => Number(BigInt(a[0]) - BigInt(b[0])))),
      mutations: killed });
    artifacts[fixture.name] = sha(fs.readFileSync(path.join(dir, 'emitted')));
    console.log(`${fixture.name}: ${list.length} full-matrix scenarios matched; ${killed.length} emitted-C mutants rejected`);
  }
  const finalInputs = Object.fromEntries(sourceInputs.map(f => [f, sha(fs.readFileSync(f))]));
  assert.deepEqual(finalInputs, inputHashes, 'input source changed while native semantic assurance ran; refusing success publication');
  assert.equal(execFileSync('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), bendRevision,
    'Bend revision changed during the run; refusing success publication');
  assert.equal(execFileSync('git', ['-C', '.deps/bend', 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim(), '',
    'Bend working tree changed during the run; refusing success publication');
  assert.equal(totalMutants, mutants.reduce((n, m) => n + m.fixture.length, 0),
    'every configured normal mutant must complete a full matrix and be rejected');
  report.artifacts = { binariesSha256: artifacts, translationUnitsSha256: unitArtifacts };
  report.totalScenarios = totalCases; report.totalMutants = totalMutants;
  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, (_, v) => typeof v === 'bigint' ? String(v) : v, 2) + '\n');
  fs.renameSync(`${reportPath}.tmp`, reportPath);
  const published = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(published.passed, true, 'only a completed run may publish passed=true');
  assert.deepEqual(published.inputs, inputHashes, 'published report input hashes must match this run');
  for (const fixture of published.fixtures) {
    assert.equal(sha(fs.readFileSync(fixture.scenarioFile)), fixture.scenariosSha256,
      `${fixture.name}: scenario hash must cover exact written bytes`);
    assert.equal(sha(fs.readFileSync(fixture.observationsFile)), fixture.observationsSha256,
      `${fixture.name}: observation hash must cover exact written bytes, including newline`);
  }
  assert.equal(fs.existsSync(`${reportPath}.tmp`), false, 'no unpublished success report may remain');
  console.log(`ABI2 multi-state native semantics: ${totalCases} scenarios, ${totalMutants} complete-matrix mutants, report ${reportPath}`);
}

if (import.meta.main) await testMultiAdapterSemantics();
