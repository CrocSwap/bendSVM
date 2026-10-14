import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { Backend, checkedProgram } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { prepareBend } from '../scripts/build.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';

// Native differential test of the emitted effect extraction helpers.
//
// For each fixture a generic checked Bend program is generated, compiled by
// the ordinary pipeline and written with writeArtifacts. The text of
// bend_extract_effect and bend_extract_effects is then cut byte-for-byte out
// of the written program.c and compiled unchanged for the host under
// ASan/UBSan with tests/effect-extraction-harness.h. Inputs are built with the
// generated *_make constructors of the written program.h, so no decoder is
// trusted. Every output byte, the return code, the input bytes and guard
// elements around the output are compared with `expectToken`/`expectCpi`
// below, which map the abstract effect directly to runtime/token.h and
// runtime/bend_cpi.h fields and never read emitted C.
//
// This is native execution of the actual helper text on finitely many
// generated values. It is not a proof about C, Clang, SBF or all inputs, and
// it says nothing about effect validation or execution. Malformed inputs
// (outer/nested tags, vector lengths, enum codes) are used only to check that
// the helpers reject; their output after a rejection is not specified, and no
// claim is made about malformed native keys or about malformed CPI records
// beyond the two tags the helper inspects.
const OUT = 'build/effect-extraction-native';
const HARNESS = 'tests/effect-extraction-harness.h';
const FLAGS = ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
  '-fsanitize=address,undefined', '-fno-sanitize-recover=all'];

// ---- Abstract effects -------------------------------------------------------
type Key = number[];
type Recipient = { to: 'actor' | 'custody' } | { to: 'owner'; key: Key };
type TransferFields = { source: number; destination: number; mint: number; mintKey: Key; recipient: Recipient;
  amount: bigint; custody: boolean };
type TokenEffect = { kind: 'None' }
  | ({ kind: 'Transfer' } & TransferFields)
  | { kind: 'CheckMint'; mint: number; mintKey: Key }
  | { kind: 'Mint'; destination: number; mint: number; mintKey: Key; recipient: Recipient; amount: bigint; initialize: boolean }
  | { kind: 'Burn'; source: number; mint: number; mintKey: Key; amount: bigint }
  | ({ kind: 'BoundTransfer'; sourceKey?: Key; destinationKey?: Key; fresh: boolean } & TransferFields);
type Meta = { index: number; key: Key; writable: boolean; signer: boolean };
type CpiEffect = { kind: 'None' }
  | { kind: 'Invoke'; program: number; programKey: Key; length: number; data: number[]; count: number; metas: Meta[] };
type Effect = TokenEffect | CpiEffect;

// ---- Oracle: abstract effect -> runtime header fields -----------------------
// Written from docs/interfaces.md, docs/cpi.md and the field meanings that
// runtime/token.h and runtime/bend_cpi.h validate and execute: active 1
// TransferChecked, 2 mint check only, 3 MintToChecked, 4 BurnChecked;
// authority 0 actor / 1 custody; recipient 0 actor / 1 custody / 2 owner key.
const hex = (bytes: number[] | Uint8Array) => Buffer.from(bytes).toString('hex');
const ZERO_KEY: Key = Array(32).fill(0);
const TOKEN_FIELDS = ['active', 'source', 'destination', 'mint', 'authority', 'recipient', 'mint_key', 'recipient_key', 'amount',
  'initialize', 'source_bound', 'destination_bound', 'fresh_destination', 'source_key', 'destination_key'];
const CPI_FIELDS = ['active', 'program', 'length', 'count', 'program_key', 'data',
  ...Array.from({ length: 8 }, (_, i) => ['index', 'writable', 'signer', 'key'].map(n => `metas[${i}].${n}`)).flat()];

function expectToken(e: TokenEffect): string {
  const o = { active: 0, source: 0, destination: 0, mint: 0, authority: 0, recipient: 0, mint_key: ZERO_KEY,
    recipient_key: ZERO_KEY, amount: 0n, initialize: 0, source_bound: 0, destination_bound: 0, fresh_destination: 0,
    source_key: ZERO_KEY, destination_key: ZERO_KEY };
  const recipient = (r: Recipient) => {
    o.recipient = { actor: 0, custody: 1, owner: 2 }[r.to];
    if (r.to === 'owner') o.recipient_key = r.key;
  };
  if (e.kind === 'Transfer' || e.kind === 'BoundTransfer') {
    o.active = 1; o.source = e.source; o.destination = e.destination; o.mint = e.mint; o.mint_key = e.mintKey;
    recipient(e.recipient); o.amount = e.amount; o.authority = Number(e.custody);
    if (e.kind === 'BoundTransfer') {
      if (e.sourceKey) { o.source_bound = 1; o.source_key = e.sourceKey; }
      if (e.destinationKey) { o.destination_bound = 1; o.destination_key = e.destinationKey; }
      o.fresh_destination = Number(e.fresh);
    }
  } else if (e.kind === 'CheckMint') {
    o.active = 2; o.mint = e.mint; o.mint_key = e.mintKey;
  } else if (e.kind === 'Mint') {
    // Issuance is always signed by custody.
    o.active = 3; o.authority = 1; o.destination = e.destination; o.mint = e.mint; o.mint_key = e.mintKey;
    recipient(e.recipient); o.amount = e.amount; o.initialize = Number(e.initialize);
  } else if (e.kind === 'Burn') {
    o.active = 4; o.source = e.source; o.mint = e.mint; o.mint_key = e.mintKey; o.amount = e.amount;
  }
  return [o.active, o.source, o.destination, o.mint, o.authority, o.recipient, hex(o.mint_key), hex(o.recipient_key), o.amount,
    o.initialize, o.source_bound, o.destination_bound, o.fresh_destination, hex(o.source_key), hex(o.destination_key)].join(',');
}

// All eight metas and all 64 data bytes are carried regardless of count and
// length; bounding those is bend_invoke_validate's job, not the extractor's.
function expectCpi(e: CpiEffect): string {
  if (e.kind === 'None') return [0, 0, 0, 0, hex(ZERO_KEY), hex(Array(64).fill(0)),
    ...Array.from({ length: 8 }, () => [0, 0, 0, hex(ZERO_KEY)]).flat()].join(',');
  return [1, e.program, e.length, e.count, hex(e.programKey), hex(e.data),
    ...e.metas.flatMap(m => [m.index, Number(m.writable), Number(m.signer), hex(m.key)])].join(',');
}

// ---- Input builder: abstract effect -> Bend constructor value ---------------
// Field and constructor names are those of sdk/*.bend; the schema written by
// the compiler resolves them to generated constructors.
type BendValue = number | boolean | { c: string; f?: Record<string, BendValue> };
const word = (k: Key, w: number) => (k[4 * w] | k[4 * w + 1] << 8 | k[4 * w + 2] << 16 | k[4 * w + 3] << 24) >>> 0;
const keyValue = (k: Key): BendValue => ({ c: 'Key', f: Object.fromEntries('abcdefgh'.split('').map((n, w) => [n, word(k, w)])) });
const u64Value = (a: bigint): BendValue => ({ c: 'U64', f: { lo: Number(a & 0xffffffffn), hi: Number(a >> 32n) } });
const recipientValue = (r: Recipient): BendValue =>
  r.to === 'owner' ? { c: 'ToOwner', f: { key: keyValue(r.key) } } : { c: r.to === 'actor' ? 'ToActor' : 'ToCustody' };
const transferValue = (e: TransferFields): Record<string, BendValue> => ({ source: e.source, destination: e.destination,
  mint: e.mint, mint_key: keyValue(e.mintKey), recipient: recipientValue(e.recipient), amount: u64Value(e.amount),
  authority: { c: e.custody ? 'Custody' : 'Actor' } });
const bindingValue = (k?: Key): BendValue => k ? { c: 'Exact', f: { key: keyValue(k) } } : { c: 'Any' };
function effectValue(e: Effect): BendValue {
  switch (e.kind) {
    case 'None': return { c: 'None' };
    case 'Transfer': return { c: 'Transfer', f: transferValue(e) };
    case 'CheckMint': return { c: 'CheckMint', f: { mint: e.mint, mint_key: keyValue(e.mintKey) } };
    case 'Mint': return { c: 'Mint', f: { destination: e.destination, mint: e.mint, mint_key: keyValue(e.mintKey),
      recipient: recipientValue(e.recipient), amount: u64Value(e.amount), initialize: e.initialize } };
    case 'Burn': return { c: 'Burn', f: { source: e.source, mint: e.mint, mint_key: keyValue(e.mintKey), amount: u64Value(e.amount) } };
    case 'BoundTransfer': return { c: 'BoundTransfer', f: { transfer: { c: 'TransferDetails', f: transferValue(e) },
      source: bindingValue(e.sourceKey), destination: bindingValue(e.destinationKey), fresh_destination: e.fresh } };
    case 'Invoke': return { c: 'Invoke', f: { program: e.program, program_key: keyValue(e.programKey), length: e.length,
      data: { c: 'Bytes64', f: Object.fromEntries('abcdefghijklmnop'.split('').map((n, w) => [n, word(e.data, w)])) },
      count: e.count, accounts: { c: 'Metas', f: Object.fromEntries('abcdefgh'.split('').map((n, i) => [n,
        { c: 'Meta', f: { index: e.metas[i].index, key: keyValue(e.metas[i].key), writable: e.metas[i].writable,
          signer: e.metas[i].signer } }])) } } };
  }
}

// ---- Deterministic values ---------------------------------------------------
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  };
  const below = (n: number) => next() % n;
  const pick = <T>(list: T[]) => list[below(list.length)];
  return { next, below, pick };
}
type Rng = ReturnType<typeof rng>;
const seedOf = (name: string) => crypto.createHash('sha256').update(`effect-extraction:${name}`).digest().readUInt32LE(0);
const EDGE_U32 = [0, 1, 4, 11, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const EDGE_U64 = [0n, 1n, 0xffffffffn, 0x100000000n, 0xffffffff00000000n, 0x8000000000000000n, 0x7fffffffffffffffn,
  0xffffffffffffffffn, 0x0123456789abcdefn, 0x00000001ffffffffn];
const EDGE_KEYS: Key[] = [Array(32).fill(0), Array(32).fill(0xff), Array.from({ length: 32 }, (_, i) => i),
  Array.from({ length: 32 }, (_, i) => 0x80 | (31 - i)), Array.from({ length: 32 }, (_, i) => Number(i % 4 === 3) * 0xff)];
const u32 = (r: Rng) => r.below(5) === 0 ? r.pick(EDGE_U32) : r.next();
const u64 = (r: Rng) => r.below(3) === 0 ? r.pick(EDGE_U64) : BigInt(r.next()) << 32n | BigInt(r.next());
const key = (r: Rng): Key => r.below(8) === 0 ? r.pick(EDGE_KEYS) : Array.from({ length: 32 }, () => r.below(256));

type Shape = { name: string; make: (r: Rng) => Effect };
const RECIPIENTS = ['actor', 'custody', 'owner'] as const;
const recipient = (r: Rng, to: typeof RECIPIENTS[number]): Recipient => to === 'owner' ? { to, key: key(r) } : { to };
const transfer = (r: Rng, to: typeof RECIPIENTS[number], custody: boolean): TransferFields =>
  ({ source: u32(r), destination: u32(r), mint: u32(r), mintKey: key(r), recipient: recipient(r, to), amount: u64(r), custody });
const NONE: Shape = { name: 'None', make: () => ({ kind: 'None' }) };
const V1_SHAPES: Shape[] = [NONE,
  ...RECIPIENTS.flatMap(to => [false, true].map(custody => ({ name: `Transfer/${to}/${custody ? 'custody' : 'actor'}`,
    make: (r: Rng): Effect => ({ kind: 'Transfer', ...transfer(r, to, custody) }) }))),
  { name: 'CheckMint', make: r => ({ kind: 'CheckMint', mint: u32(r), mintKey: key(r) }) }];
const V2_SHAPES: Shape[] = [...V1_SHAPES,
  ...RECIPIENTS.flatMap(to => [false, true].map(initialize => ({ name: `Mint/${to}/${initialize ? 'initialize' : 'issue'}`,
    make: (r: Rng): Effect => ({ kind: 'Mint', destination: u32(r), mint: u32(r), mintKey: key(r), recipient: recipient(r, to),
      amount: u64(r), initialize }) }))),
  { name: 'Burn', make: r => ({ kind: 'Burn', source: u32(r), mint: u32(r), mintKey: key(r), amount: u64(r) }) },
  ...Array.from({ length: 8 }, (_, i) => ({ name: `BoundTransfer/${RECIPIENTS[i % 3]}/${i & 1 ? 'custody' : 'actor'}/source-` +
    `${i & 1 ? 'exact' : 'any'}/destination-${i & 2 ? 'exact' : 'any'}/${i & 4 ? 'fresh' : 'existing'}`,
    make: (r: Rng): Effect => ({ kind: 'BoundTransfer', ...transfer(r, RECIPIENTS[i % 3], Boolean(i & 1)),
      ...(i & 1 ? { sourceKey: key(r) } : {}), ...(i & 2 ? { destinationKey: key(r) } : {}), fresh: Boolean(i & 4) }) }))];
// Every data byte and every meta of an Invoke is distinct within the effect.
function invoke(r: Rng, fixed: { length?: number; count?: number; data?: number[]; flags?: (m: number) => number } = {}): CpiEffect {
  const base = r.below(256), step = 2 * r.below(128) + 1;
  const indices = new Set<number>();
  while (indices.size < 8) indices.add(u32(r));
  return { kind: 'Invoke', program: u32(r), programKey: key(r), length: fixed.length ?? r.below(65),
    data: fixed.data ?? Array.from({ length: 64 }, (_, i) => (base + i * step) & 0xff), count: fixed.count ?? r.below(9),
    metas: [...indices].map((index, m) => {
      const flags = fixed.flags ? fixed.flags(m) : r.below(4);
      return { index, key: Array.from({ length: 32 }, () => r.below(256)), writable: Boolean(flags & 1), signer: Boolean(flags & 2) };
    }) };
}
const CPI_SHAPES: Shape[] = [NONE, { name: 'Invoke', make: r => invoke(r) }];

// ---- Fixtures ---------------------------------------------------------------
type Family = 'token-v1' | 'token-v2' | 'cpi-v1';
type Fixture = { name: string; family: Family; slots: number; vector: boolean; imports: string[]; effects: string };
type Rejected = { name: string; imports: string[]; effects: string; stage: 'emit' | 'artifacts'; error: RegExp; why: string };
const IMPORTS: Record<string, string> = { Fx: 'effects', Batch: 'effects3', Token: 'issuance', Cpi: 'cpi', B: 'buffer' };
const vectorType = (effect: string, slots: number) => {
  let storage = effect;
  for (let n = slots; n > 1; n /= 2) storage = `B.Pair<${storage}>`;
  return `B.Vector<${effect}, ${storage}>`;
};
const fixtures: Fixture[] = [
  { name: 'token-v1-fixed2', family: 'token-v1', slots: 2, vector: false, imports: ['Fx'], effects: 'Fx.Effects' },
  { name: 'token-v1-fixed3', family: 'token-v1', slots: 3, vector: false, imports: ['Fx', 'Batch'], effects: 'Batch.Effects' },
  { name: 'token-v2-fixed3', family: 'token-v2', slots: 3, vector: false, imports: ['Token'], effects: 'Token.Effects' },
  { name: 'cpi-fixed2', family: 'cpi-v1', slots: 2, vector: false, imports: ['Cpi'], effects: 'Cpi.Effects' },
  ...[2, 4, 8].map(n => ({ name: `token-v1-vector${n}`, family: 'token-v1' as const, slots: n, vector: true,
    imports: ['B', 'Fx'], effects: vectorType('Fx.Effect', n) })),
  ...[2, 4].map(n => ({ name: `token-v2-vector${n}`, family: 'token-v2' as const, slots: n, vector: true,
    imports: ['B', 'Token'], effects: vectorType('Token.Effect', n) })),
];
// Shapes the ordinary compiler must refuse. The extractor is never reached, so
// an eight-slot token-v2 vector is deliberately not tested by bypassing a guard.
const rejected: Rejected[] = [
  { name: 'token-v2-vector8', imports: ['B', 'Token'], effects: vectorType('Token.Effect', 8), stage: 'emit',
    error: /\[BEND-SBF202\] Bend value exceeds SBF subset size limit/, why: 'native value above 1,536 bytes' },
  { name: 'token-v1-vector16', imports: ['B', 'Fx'], effects: vectorType('Fx.Effect', 16), stage: 'emit',
    error: /\[BEND-SBF202\] Bend value exceeds SBF subset size limit/, why: 'native value above 1,536 bytes' },
  { name: 'cpi-vector2', imports: ['B', 'Cpi'], effects: vectorType('Cpi.Effect', 2), stage: 'artifacts',
    error: /CPI vectors are not supported/, why: 'CPI effects have exactly two fixed slots' },
];
// A generic pass-through root: the effects value is supplied by the caller.
// It is an extraction fixture, not an application or an authorization policy.
const fixtureSource = (f: { imports: string[]; effects: string }) => `import ../../../sdk/context.bend as Sol
${f.imports.map(i => `import ../../../sdk/${IMPORTS[i]}.bend as ${i}`).join('\n')}

type State is Data:
  State{count: U32}

type Instruction is Data:
  Run{effects: ${f.effects}}

type Outcome is Data:
  Accepted{state: State, effects: ${f.effects}}
  Rejected{code: U32}

def process(context: Sol.Context, state: State, instruction: Instruction) -> Outcome:
  match state instruction:
    case State{count} Run{effects}:
      Accepted{State{U32.add(count, 1)}, effects}
`;

// ---- Native layout of the generated types -----------------------------------
// Generated types are `{ tag; union { struct { f0; f1; ... } cN; } as; }`.
type Layout = { schema: RuntimeSchema; value: string; effect: string; valueC: string; effectC: string };
const short = (v: { name: string; sourceName?: string }) => (v.sourceName ?? v.name).split('.').at(-1)!;
function adt(schema: RuntimeSchema, name: string) {
  const t = schema.types.find(t => t.name === name);
  assert(t?.kind === 'adt', `expected a data type: ${name}`);
  return t;
}
function cexpr(schema: RuntimeSchema, type: string, value: BendValue, alias: (maker: string) => string): string {
  const t = schema.types.find(t => t.name === type);
  assert(t, `unknown type ${type}`);
  if (t.kind !== 'adt') {
    assert(typeof value !== 'object', `expected a scalar for ${type}`);
    assert(t.kind === 'bool' ? typeof value === 'boolean' : Number.isInteger(value) && value >= 0 && value <= 0xffffffff);
    return `${Number(value)}u`;
  }
  assert(typeof value === 'object', `expected a constructor for ${type}`);
  const variant = t.variants.find(v => short(v) === value.c);
  assert(variant, `no constructor ${value.c} in ${type}`);
  assert.deepEqual(Object.keys(value.f ?? {}).sort(), variant.fields.map(f => f.name).sort(), `fields of ${value.c}`);
  return `${alias(variant.cMaker)}(${variant.fields.map(f => cexpr(schema, f.type, value.f![f.name], alias)).join(', ')})`;
}
// Member path of a field reached through alternating constructor and field names.
function member(schema: RuntimeSchema, type: string, steps: string[]): string {
  if (!steps.length) return '';
  const variant = adt(schema, type).variants.find(v => short(v) === steps[0]);
  assert(variant, `no constructor ${steps[0]} in ${type}`);
  const index = variant.fields.findIndex(f => f.name === steps[1]);
  assert(index >= 0, `no field ${steps[1]} in ${steps[0]}`);
  return `.as.c${variant.tag}.f${index}${member(schema, variant.fields[index].type, steps.slice(2))}`;
}
const bits = (f: Fixture, i: number) => Array.from({ length: Math.log2(f.slots) }, (_, d) => i >> (Math.log2(f.slots) - 1 - d) & 1);
const slotPath = (f: Fixture, i: number) =>
  f.vector ? `as.c0.f1${bits(f, i).map(b => `.as.c0.f${b}`).join('')}` : `as.c0.f${i}`;
// The vector record and every Pair node above the effects.
function tagPaths(f: Fixture): string[] {
  if (!f.vector) return ['tag'];
  const out = ['tag'];
  const walk = (path: string, depth: number) => {
    out.push(`${path}.tag`);
    if (depth + 1 < Math.log2(f.slots)) for (const b of [0, 1]) walk(`${path}.as.c0.f${b}`, depth + 1);
  };
  walk('as.c0.f1', 0);
  return out;
}

// ---- Cases -------------------------------------------------------------------
// `bad` and `outer` are C assignments applied after construction. They exist
// only to check rejection.
type Slot = { effect: Effect; bad?: { label: string; poke: string } };
type Case = { label: string; slots: Slot[]; length?: number; outer?: { label: string; poke: string } };
type Bad = { label: string; shape: string; poke: string };

function badEffects(f: Fixture, l: Layout): Bad[] {
  const at = (steps: string[]) => member(l.schema, l.effect, steps);
  const variants = adt(l.schema, l.effect).variants.length;
  if (f.family === 'cpi-v1') return [
    { label: 'effect tag past the last constructor', shape: 'Invoke', poke: `.tag = ${variants}u;` },
    { label: 'effect tag 0xffffffff', shape: 'Invoke', poke: '.tag = 0xffffffffu;' },
    { label: 'effect tag past the last constructor on None', shape: 'None', poke: `.tag = ${variants}u;` }];
  const v1: Bad[] = [
    { label: 'effect tag past the last constructor', shape: 'Transfer/actor/actor', poke: `.tag = ${variants}u;` },
    { label: 'effect tag 0xffffffff', shape: 'Transfer/owner/custody', poke: '.tag = 0xffffffffu;' },
    { label: 'Transfer amount tag 1', shape: 'Transfer/custody/actor', poke: `${at(['Transfer', 'amount'])}.tag = 1u;` },
    { label: 'Transfer recipient tag 3', shape: 'Transfer/actor/custody', poke: `${at(['Transfer', 'recipient'])}.tag = 3u;` },
    { label: 'Transfer authority tag 2', shape: 'Transfer/custody/custody', poke: `${at(['Transfer', 'authority'])}.tag = 2u;` }];
  if (f.family === 'token-v1') return v1;
  const details = ['BoundTransfer', 'transfer', 'TransferDetails'];
  const bound = 'BoundTransfer/actor/actor/source-any/destination-any/existing';
  return [...v1,
    { label: 'Mint amount tag 1', shape: 'Mint/actor/issue', poke: `${at(['Mint', 'amount'])}.tag = 1u;` },
    { label: 'Mint recipient tag 3', shape: 'Mint/custody/issue', poke: `${at(['Mint', 'recipient'])}.tag = 3u;` },
    { label: 'Mint initialize 2', shape: 'Mint/actor/initialize', poke: `${at(['Mint', 'initialize'])} = 2u;` },
    { label: 'Burn amount tag 1', shape: 'Burn', poke: `${at(['Burn', 'amount'])}.tag = 1u;` },
    { label: 'BoundTransfer details tag 1', shape: bound, poke: `${at(['BoundTransfer', 'transfer'])}.tag = 1u;` },
    { label: 'BoundTransfer amount tag 1', shape: bound, poke: `${at([...details, 'amount'])}.tag = 1u;` },
    { label: 'BoundTransfer recipient tag 3', shape: bound, poke: `${at([...details, 'recipient'])}.tag = 3u;` },
    { label: 'BoundTransfer authority tag 2', shape: bound, poke: `${at([...details, 'authority'])}.tag = 2u;` },
    { label: 'BoundTransfer source binding tag 2', shape: bound, poke: `${at(['BoundTransfer', 'source'])}.tag = 2u;` },
    { label: 'BoundTransfer destination binding tag 2', shape: bound, poke: `${at(['BoundTransfer', 'destination'])}.tag = 2u;` },
    { label: 'BoundTransfer fresh_destination 2', shape: bound, poke: `${at(['BoundTransfer', 'fresh_destination'])} = 2u;` }];
}

function cases(f: Fixture, l: Layout): Case[] {
  const r = rng(seedOf(f.name));
  const shapes = f.family === 'cpi-v1' ? CPI_SHAPES : f.family === 'token-v2' ? V2_SHAPES : V1_SHAPES;
  const live = shapes.filter(s => s !== NONE);
  const named = (name: string) => { const s = shapes.find(s => s.name === name); assert(s, name); return s; };
  const n = f.slots, full = f.vector ? { length: n } : {};
  const out: Case[] = [];
  const fill = (make: (i: number) => Effect): Slot[] => Array.from({ length: n }, (_, i) => ({ effect: make(i) }));
  const any = () => r.pick(shapes).make(r), some = () => r.pick(live).make(r);

  out.push({ label: 'every slot None', slots: fill(() => ({ kind: 'None' })), ...(f.vector ? { length: 0 } : {}) });
  if (f.vector) out.push({ label: 'every slot None, full length', slots: fill(() => ({ kind: 'None' })), ...full });
  // Every constructor shape: at every slot of a fixed record, at a rotating slot of a full vector.
  shapes.forEach((s, k) => {
    for (const at of f.vector ? [k % n] : Array.from({ length: n }, (_, i) => i))
      out.push({ label: `${s.name} in slot ${at}`, slots: fill(i => i === at ? s.make(r) : any()), ...full });
  });
  if (f.family === 'cpi-v1') {
    const lengths = [0, 1, 63, 64, 65, 0xffffffff], counts = [8, 7, 1, 0, 9, 0xffffffff];
    lengths.forEach((length, k) => out.push({ label: `Invoke length ${length}, count ${counts[k]} in slot ${k % n}`,
      slots: fill(i => i === k % n ? invoke(r, { length, count: counts[k] }) : any()) }));
    for (let j = 0; j < 4; ++j) out.push({ label: `Invoke meta flags rotated by ${j}`,
      slots: fill(() => invoke(r, { flags: m => (m + j) % 4 })) });
    [Array(64).fill(0), Array(64).fill(0xff), Array.from({ length: 64 }, (_, i) => i), Array.from({ length: 64 }, (_, i) => 255 - i)]
      .forEach((data, k) => out.push({ label: `Invoke data pattern ${k}`, slots: fill(i => i === k % n ? invoke(r, { data }) : any()) }));
    for (const program of [0, 0xffffffff]) out.push({ label: `Invoke program ${program}`,
      slots: fill(() => ({ ...invoke(r), program } as CpiEffect)) });
  } else {
    const amounts = live.filter(s => !s.name.startsWith('CheckMint'));
    EDGE_U64.forEach((amount, k) => out.push({ label: `amount ${amount} in slot ${k % n}`,
      slots: fill(i => i === k % n ? { ...amounts[k * 5 % amounts.length].make(r), amount } as Effect : any()), ...full }));
    for (const [value, k] of [[0xffffffff, 1], [0, 0]] as const) for (const s of live) out.push({
      label: `${s.name} with every word ${value}`, ...full, slots: fill(() => {
        const e = s.make(r) as unknown as Record<string, unknown>;
        for (const name of ['source', 'destination', 'mint']) if (name in e) e[name] = value;
        for (const name of ['mintKey', 'sourceKey', 'destinationKey']) if (name in e) e[name] = EDGE_KEYS[k];
        if ((e.recipient as Recipient | undefined)?.to === 'owner') e.recipient = { to: 'owner', key: EDGE_KEYS[k] };
        if ('amount' in e) e.amount = k ? 0xffffffffffffffffn : 0n;
        return e as unknown as Effect;
      }) });
  }
  // Every length, with every slot holding a live effect so that inactive slots must be cleared.
  if (f.vector) for (let length = 0; length <= n; ++length) for (let j = 0; j < 3; ++j)
    out.push({ label: `length ${length}, live effects in every slot (${j})`, slots: fill(some), length });
  for (let j = 0; j < 32; ++j) out.push({ label: `random ${j}`, slots: fill(j % 4 ? any : some),
    ...(f.vector ? { length: r.below(n + 1) } : {}) });

  // Rejections only.
  const paths = tagPaths(f);
  paths.forEach((p, k) => {
    for (const tag of k < 2 ? ['1u', '0xffffffffu'] : ['1u'])
      out.push({ label: `reject: ${p} = ${tag}`, slots: fill(some), ...full, outer: { label: `${p} = ${tag}`, poke: `v->${p} = ${tag};` } });
  });
  if (f.vector) for (const length of [n + 1, 2 * n + 1, 0x80000000, 0xffffffff])
    out.push({ label: `reject: length ${length}`, slots: fill(some), length });
  badEffects(f, l).forEach((b, k) => {
    const at = k % n;
    const slots = fill(i => i === at ? named(b.shape).make(r) : any());
    slots[at].bad = { label: b.label, poke: `v->${slotPath(f, at)}${b.poke}` };
    out.push({ label: `reject: ${b.label} in slot ${at}`, slots, ...(f.vector ? { length: k % 2 ? at + 1 : n } : {}) });
  });
  return out;
}

// Expected harness lines for one case: bend_extract_effects, then bend_extract_effect per slot.
function expected(f: Fixture, c: Case, id: number): string[] {
  const one = (e: Effect) => f.family === 'cpi-v1' ? expectCpi(e as CpiEffect) : expectToken(e as TokenEffect);
  const active = (i: number) => c.length === undefined || i < c.length;
  assert(c.slots.every((s, i) => !s.bad || active(i)), 'malformed effects are only placed in active slots');
  const rejects = Boolean(c.outer) || (c.length !== undefined && c.length > f.slots) || c.slots.some(s => s.bad);
  const line = (head: string, dump?: string) => `${head} ${dump === undefined ? '0 1 1 1 -' : `1 1 1 1 ${dump}`}`;
  return [line(`E ${id}`, rejects ? undefined : c.slots.map((s, i) => one(active(i) ? s.effect : { kind: 'None' })).join(';')),
    ...c.slots.map((s, i) => line(`S ${id} ${i}`, s.bad ? undefined : one(s.effect)))];
}

// ---- The helper text of the written artifact --------------------------------
type Helper = { head: string; single: string; gap: string; multi: string };
function cutHelper(c: string): Helper {
  const include = c.match(/#include (?:"token\.h"|<bend_cpi\.h>)\n/);
  assert(include?.index !== undefined, 'written adapter has no effect helper include');
  const body = (name: string) => {
    const start = c.indexOf(`static inline int ${name}(const `);
    assert(start >= 0 && c.indexOf(`static inline int ${name}(const `, start + 1) < 0, `exactly one definition of ${name}`);
    let depth = 0, i = c.indexOf('{', start);
    do { if (c[i] === '{') ++depth; else if (c[i] === '}') --depth; ++i; } while (depth);
    return { start, end: i };
  };
  const single = body('bend_extract_effect'), multi = body('bend_extract_effects');
  assert.equal(single.start, include.index + include[0].length, 'bend_extract_effect follows its include');
  assert(single.end <= multi.start && /^\s*$/.test(c.slice(single.end, multi.start)), 'helpers are adjacent');
  return { head: include[0], single: c.slice(single.start, single.end), gap: c.slice(single.end, multi.start),
    multi: c.slice(multi.start, multi.end) };
}
const helperText = (h: Helper) => h.head + h.single + h.gap + h.multi + '\n';

// ---- Mutations of the extracted helper text ---------------------------------
// Each rewrites one mapping of the emitted text. `abort` marks a write one
// element past the output array: guard mode must report the clobbered guard
// and exact mode must stop in an ASan heap-buffer-overflow write.
type Mutant = { name: string; scope: 'effect' | 'effects'; text: string; abort?: boolean };
type Edit = { index: number; length: number; text: string };
const splice = (s: string, edits: Edit[]) =>
  [...edits].sort((a, b) => b.index - a.index).reduce((t, e) => t.slice(0, e.index) + e.text + t.slice(e.index + e.length), s);
const whole = (m: RegExpMatchArray, text: string): Edit => ({ index: m.index!, length: m[0].length, text });

function mutants(f: Fixture, h: Helper): Mutant[] {
  const out: Mutant[] = [];
  const add = (scope: Mutant['scope'], name: string, edits: Edit[], abort = false) => {
    const part = scope === 'effect' ? h.single : h.multi, changed = splice(part, edits);
    assert.notEqual(changed, part, `mutation changes nothing: ${name}`);
    out.push({ name, scope, abort, text: helperText(scope === 'effect' ? { ...h, single: changed } : { ...h, multi: changed }) });
  };
  // One mutant per occurrence; at least `min` occurrences must exist.
  const each = (scope: Mutant['scope'], name: string, re: RegExp, to: (m: RegExpMatchArray) => string, min = 1) => {
    const found = [...(scope === 'effect' ? h.single : h.multi).matchAll(re)];
    assert(found.length >= min, `${f.name}: mutation target missing: ${name}`);
    found.forEach((m, k) => add(scope, found.length > 1 ? `${name} (occurrence ${k + 1} of ${found.length})` : name, [whole(m, to(m))]));
  };
  const token = f.family !== 'cpi-v1', v2 = f.family === 'token-v2';
  const PATH = String.raw`value->[\w.>-]+`;

  // Zeroing, None, unknown constructors and active codes.
  each('effect', 'zeroing: output not cleared', /\*out\s?=\s?\(Bend(?:Transfer|Invoke)\)\{0\};/g, () => '');
  each('effect', 'None not recognised', /if\s?\(value->tag\s?==\s?0\) return 1;/g, () => '');
  each('effect', 'guard: unknown constructor tag', /if\s?\(value->tag\s?!=\s?\d+\) return 0;/g, () => '');
  each('effect', 'active code changed', /out->active\s?=\s?(\d);/g, m => `out->active = ${Number(m[1]) % 4 + 1};`, token ? 2 : 1);

  // Scalars read from the wrong source field. Assignments from one constructor
  // are rotated; a lone assignment reads the constructor tag instead.
  const scalars = [...h.single.matchAll(new RegExp(String.raw`out->([\w\[\].]+?)\s?=\s?(${PATH})\.f(\d+);`, 'g'))];
  const groups = new Map<string, RegExpMatchArray[]>();
  for (const m of scalars) groups.set(m[2], [...(groups.get(m[2]) ?? []), m]);
  assert(groups.size >= (v2 ? 6 : token ? 2 : 9), `${f.name}: scalar assignments not found`);
  for (const [prefix, list] of groups) {
    const names = list.map(m => m[1]).join(',');
    if (list.length === 1) add('effect', `wrong source field: ${names} of ${prefix} read from the constructor tag`,
      [whole(list[0], `out->${list[0][1]} = value->tag;`)]);
    else add('effect', `wrong source field: ${names} of ${prefix} rotated`,
      list.map((m, j) => whole(m, `out->${m[1]} = ${prefix}.f${list[(j + 1) % list.length][3]};`)));
    // A CPI meta also reads its index from the neighbouring meta.
    const meta = prefix.match(/^(.*\.f)(\d)(\.as\.c0)$/);
    if (!token && meta && list[0][1].startsWith('metas[')) add('effect', `wrong source field: ${list[0][1]} read from the neighbouring meta`,
      [whole(list[0], `out->${list[0][1]} = ${meta[1]}${Number(meta[2]) ^ 1}${meta[3]}.f${list[0][3]};`)]);
  }

  // Key and data bytes. Consecutive write_le calls to one target are one group.
  const writes = [...h.single.matchAll(/write_le\(([^,;()]+?)\+(\d+),\s*([^,;()]+?),\s*4\);/g)];
  const runs: RegExpMatchArray[][] = [];
  for (const m of writes) {
    const last = runs.at(-1);
    if (last && last[0][1] === m[1] && Number(m[2]) === 4 * last.length) last.push(m); else runs.push([m]);
  }
  assert.equal(runs.length, v2 ? 10 : token ? 3 : 10, `${f.name}: key groups`);
  runs.forEach((run, g) => {
    const target = run[0][1], label = `${target} (group ${g + 1})`;
    assert(run.length === (target === 'out->data' ? 16 : 8) && run.every((m, j) => Number(m[2]) === 4 * j), `${f.name}: ${label}`);
    const write = (j: number, source: string, bytes = 4, to = target) => whole(run[j], `write_le(${to}+${4 * j}, ${source}, ${bytes});`);
    const lastWord = run.length - 1;
    add('effect', `key bytes: ${label} word 0 read from word 1`, [write(0, run[1][3])]);
    add('effect', `key bytes: ${label} last word written as three bytes`, [write(lastWord, run[lastWord][3], 3)]);
    add('effect', `key bytes: ${label} last word written one byte early`,
      [whole(run[lastWord], `write_le(${target}+${4 * lastWord - 1}, ${run[lastWord][3]}, 4);`)]);
    if (run.length === 16) {
      add('effect', `key bytes: ${label} word 7 read from word 8`, [write(7, run[8][3])]);
      add('effect', `key bytes: ${label} words 14 and 15 exchanged`, [write(14, run[15][3]), write(15, run[14][3])]);
    }
    const other = token ? (target === 'out->mint_key' ? undefined : 'out->mint_key')
      : target.replace(/metas\[(\d)\]/, (_, d) => `metas[${Number(d) ^ 1}]`);
    if (other && other !== target) add('effect', `key bytes: ${label} written to ${other}`, run.map((m, j) => write(j, m[3], 4, other)));
  });

  if (token) {
    // Amount limbs.
    each('effect', 'amount: high limb dropped', / \| \(\(u64\)[^;]+? << 32\)/g, () => '', v2 ? 4 : 1);
    each('effect', 'amount: limbs exchanged', /\(u64\)(\S+)\.f0 \| \(\(u64\)\1\.f1 << 32\)/g,
      m => `(u64)${m[1]}.f1 | ((u64)${m[1]}.f0 << 32)`, v2 ? 4 : 1);
    each('effect', 'amount: high limb shifted by 31', /\.f1 << 32\)/g, () => '.f1 << 31)', v2 ? 4 : 1);
    // Recipient, authority and bindings.
    each('effect', 'recipient: code forced to ToActor', new RegExp(String.raw`out->recipient = ${PATH}\.tag;`, 'g'),
      () => 'out->recipient = 0;', v2 ? 3 : 1);
    each('effect', 'recipient: owner key copied for ToCustody', /if \(out->recipient == 2\)/g, () => 'if (out->recipient == 1)', v2 ? 3 : 1);
    each('effect', 'authority: read from the recipient tag', new RegExp(String.raw`out->authority = (${PATH})\.f6\.tag;`, 'g'),
      m => `out->authority = ${m[1]}.f4.tag;`, v2 ? 2 : 1);
    each('effect', 'guard: nested record tag', /if \([^()]+\.tag != 0\) return 0;/g, () => '', v2 ? 5 : 1);
    for (const m of h.single.matchAll(/return (out->[^;]*<= \d[^;]*);/g)) {
      const terms = m[1].split(' && ');
      terms.forEach((t, j) => add('effect', `guard: ${t} (return at offset ${m.index})`,
        [whole(m, `return ${terms.filter((_, k) => k !== j).join(' && ') || '1'};`)]));
    }
    if (v2) {
      each('effect', 'guard: recipient code range', /if \(out->recipient > 2\) return 0;/g, () => '', 2);
      each('effect', 'authority: issuance not signed by custody', /out->authority = 1;/g, () => 'out->authority = 0;');
      each('effect', 'bindings: source and destination tags exchanged',
        new RegExp(String.raw`out->source_bound = (${PATH})\.f1\.tag;(\s*)out->destination_bound = \1\.f2\.tag;`, 'g'),
        m => `out->source_bound = ${m[1]}.f2.tag;${m[2]}out->destination_bound = ${m[1]}.f1.tag;`);
      each('effect', 'bindings: key copied for Any', /if \(out->(?:source|destination)_bound == 1\)/g, m => m[0].replace('== 1', '== 0'), 2);
    }
  }

  // bend_extract_effects: slots, lengths and tags.
  const n = f.slots;
  const calls = [...h.multi.matchAll(new RegExp(String.raw`bend_extract_effect\(&(${PATH}),\s?&out\[(\d+)\]\)`, 'g'))];
  assert(calls.length === n && calls.every((m, i) => Number(m[2]) === i), `${f.name}: one extraction per slot`);
  const call = (m: RegExpMatchArray, source: string, slot: number) => whole(m, `bend_extract_effect(&${source}, &out[${slot}])`);
  calls.forEach((m, i) => {
    const j = f.vector ? i ^ 1 : (i + 1) % n;
    add('effects', `slot ${i}: read from slot ${j}`, [call(m, calls[j][1], i)]);
    add('effects', `slot ${i}: written to output slot ${j}`, [call(m, m[1], j)]);
    if (!f.vector) add('effects', `slot ${i}: never extracted`, [whole(m, '1')]);
  });
  add('effects', `slot ${n - 1}: written one element past the output`, [call(calls[n - 1], calls[n - 1][1], n)], true);
  if (!f.vector) each('effects', 'guard: record tag', /value->tag\s?==\s?0 && /g, () => '');
  else {
    each('effects', 'guard: tag', new RegExp(String.raw`(value->[\w.>-]*tag) != 0`, 'g'), () => '0', tagPaths(f).length);
    each('effects', 'vector length: bound one too large', / > (\d+)u\) return 0;/g, m => ` > ${Number(m[1]) + 1}u) return 0;`);
    each('effects', 'vector length: slot active at its own index', new RegExp(String.raw`if \((\d+)u < (${PATH})\)`, 'g'),
      m => `if (${m[1]}u <= ${m[2]})`, n);
    each('effects', 'zeroing: inactive slot left untouched', /else \{ out\[\d+\] = \(BendTransfer\)\{0\}; \}/g, () => 'else { }', n);
    each('effects', 'vector length: compared with the vector tag', new RegExp(String.raw`if \(0u < (${PATH})\)`, 'g'),
      () => 'if (0u < value->tag)');
    const zero = [...h.multi.matchAll(/else \{ out\[(\d+)\] = \(BendTransfer\)\{0\}; \}/g)].at(-1)!;
    add('effects', `zeroing: inactive slot ${n - 1} cleared one element past the output`,
      [whole(zero, `else { out[${n}] = (BendTransfer){0}; }`)], true);
  }
  return out;
}

// ---- Build and run ----------------------------------------------------------
const sha = (data: string | Uint8Array) => crypto.createHash('sha256').update(data).digest('hex');
const run$ = promisify(execFile);
async function pool<T>(jobs: (() => Promise<T>)[], width: number): Promise<T[]> {
  const out: T[] = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, jobs.length) }, async () => {
    while (next < jobs.length) { const i = next++; out[i] = await jobs[i](); }
  }));
  return out;
}
type Run = { lines: string[]; done: boolean; exit: number | string; stderr: string };
async function execute(binary: string, mode: 'guard' | 'exact'): Promise<Run> {
  const parse = (stdout: string) => {
    const lines = stdout.split('\n').filter(Boolean);
    const done = lines.at(-1) === 'done';
    return { lines: done ? lines.slice(0, -1) : lines, done };
  };
  try {
    const r = await run$(binary, [mode], { maxBuffer: 1 << 28, timeout: 300_000 });
    return { ...parse(r.stdout), exit: 0, stderr: r.stderr };
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string; code?: number | string; signal?: string };
    if (x.stdout === undefined) throw e;
    return { ...parse(x.stdout), exit: x.code ?? x.signal ?? 'failed', stderr: x.stderr ?? '' };
  }
}

// First line that differs from the oracle, described by case and field.
function firstFailure(f: Fixture, list: Case[], want: string[], got: string[]) {
  const index = got.findIndex((line, i) => line !== want[i]);
  if (index < 0) return undefined;
  const parts = (line: string | undefined) => {
    const p = (line ?? '').split(' ');
    return { call: p.slice(0, p[0] === 'E' ? 2 : 3).join(' '), rest: p.slice(p[0] === 'E' ? 2 : 3) };
  };
  const e = parts(want[index]), o = parts(got[index]);
  const label = `${e.call.startsWith('E') ? 'bend_extract_effects' : `bend_extract_effect slot ${e.call.split(' ')[2]}`}: ` +
    list[Number(e.call.split(' ')[1])].label;
  if (e.call !== o.call || o.rest.length !== 5) return { case: label, detection: 'malformed-line', expected: want[index], observed: got[index] };
  const names = ['return-code', 'input-unchanged', 'pre-guard', 'post-guard'];
  for (let i = 0; i < 4; ++i) if (e.rest[i] !== o.rest[i])
    return { case: label, detection: i === 0 ? 'return-code' : i === 1 ? 'input-modified' : 'guard', field: names[i],
      expected: e.rest[i], observed: o.rest[i] };
  const fields = f.family === 'cpi-v1' ? CPI_FIELDS : TOKEN_FIELDS;
  const es = e.rest[4].split(';').map(s => s.split(',')), os_ = o.rest[4].split(';').map(s => s.split(','));
  for (let s = 0; s < es.length; ++s) for (let k = 0; k < fields.length; ++k) if (es[s][k] !== os_[s]?.[k])
    return { case: label, detection: 'output', field: `${e.call.startsWith('E') ? `out[${s}].` : ''}${fields[k]}`,
      expected: es[s][k], observed: os_[s]?.[k] };
  return { case: label, detection: 'malformed-line', expected: want[index], observed: got[index] };
}

const OUT_BYTES = { 'token-v1': 176, 'token-v2': 176, 'cpi-v1': 464 };

export async function testEffectExtraction() {
  const cc = process.env.CC ?? 'clang';
  const reportPath = path.join(OUT, 'report.json');
  fs.rmSync(reportPath, { force: true });
  fs.mkdirSync(path.join(OUT, 'fixtures'), { recursive: true });
  prepareBend();
  const width = Math.max(1, os.cpus().length - 1);
  const report = { passed: true, compiler: execFileSync(cc, ['--version'], { encoding: 'utf8' }).split('\n')[0], flags: FLAGS,
    bun: process.versions.bun,
    scope: 'Native ASan/UBSan execution of the bend_extract_effect and bend_extract_effects text cut from written adapters, ' +
      'on generated values built with the generated constructors, compared with an independent value-level oracle. ' +
      'Finite differential testing: not a proof about C, Clang, SBF or all inputs, and nothing about effect validation or ' +
      'execution. Malformed tags, enum codes and vector lengths are tested for rejection only; malformed native keys and ' +
      'malformed CPI records beyond the record and effect tags are not covered.',
    inputs: Object.fromEntries(['tests/effect-extraction.ts', HARNESS, 'compiler/effects.ts', 'compiler/cpi-effects.ts',
      'compiler/storage.ts', 'compiler/backend.ts', 'compiler/tagged-sum-ir.ts', 'compiler/artifacts.ts', 'runtime/solana_min.h', 'runtime/cpi_abi.h',
      'runtime/token.h', 'runtime/bend_cpi.h', ...Object.values(IMPORTS).map(n => `sdk/${n}.bend`), 'sdk/context.bend',
      'sdk/math.bend'].map(file => [file, sha(fs.readFileSync(file))])),
    fixtures: [] as unknown[], rejectedFixtures: [] as unknown[],
    totals: { fixtures: 0, cases: 0, calls: 0, rejectedCalls: 0, nativeRuns: 0, mutants: 0, sanitizerAborts: 0 } };

  // Shapes the ordinary bounds refuse: no adapter may be written for them.
  for (const x of rejected) {
    const source = path.join(OUT, 'fixtures', `${x.name}.bend`), stem = path.join(OUT, x.name, 'program');
    fs.rmSync(path.join(OUT, x.name), { recursive: true, force: true });
    fs.writeFileSync(source, fixtureSource(x));
    const checked = await checkedProgram(source);
    let stage = 'none', message = '';
    try {
      stage = 'emit';
      const emitted = new Backend(checked.book).emit(['process']);
      stage = 'artifacts';
      writeArtifacts(stem, emitted, 'process');
      stage = 'none';
    } catch (e) { message = e instanceof Error ? e.message : String(e); }
    assert.equal(stage, x.stage, `${x.name}: expected the compiler to refuse at ${x.stage}: ${message}`);
    assert.match(message, x.error, `${x.name}: refused for another reason`);
    assert(!fs.existsSync(`${stem}.c`), `${x.name}: an adapter was written`);
    report.rejectedFixtures.push({ name: x.name, effects: x.effects, sourceSha256: sha(fs.readFileSync(source)), stage: x.stage,
      reason: x.why, diagnostic: message.split('\n')[0] });
    console.log(`${x.name}: refused by the compiler (${x.why})`);
  }

  const mutated = new Map<string, string>(); // bend_extract_effect text hash -> fixture that ran its mutants
  for (const f of fixtures) {
    const dir = path.join(OUT, f.name), stem = path.join(dir, 'program');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const source = path.join(OUT, 'fixtures', `${f.name}.bend`);
    fs.writeFileSync(source, fixtureSource(f));
    writeArtifacts(stem, new Backend((await checkedProgram(source)).book).emit(['process']), 'process');

    // Everything below reads the written artifacts.
    const written = fs.readFileSync(`${stem}.c`, 'utf8');
    const schema = JSON.parse(fs.readFileSync(`${stem}.schema.json`, 'utf8')) as RuntimeSchema;
    const descriptor = JSON.parse(fs.readFileSync(`${stem}.interface.json`, 'utf8'));
    assert.equal(descriptor.effects, f.family, `${f.name}: effect interface`);
    assert.equal(descriptor.effectSlots ?? 2, f.slots, `${f.name}: effect slots`);
    const helper = cutHelper(written);
    const text = helperText(helper);
    assert(written.includes(text), `${f.name}: helper text is a contiguous part of the written adapter`);
    const outType = f.family === 'cpi-v1' ? 'BendInvoke' : 'BendTransfer';
    // The adapter's own call: its buffer has exactly the tested number of slots.
    const use = written.match(/(Bend(?:Transfer|Invoke)) transfers\[(\d+)\];\s*if \(!bend_extract_effects\(&outcome\.as\.c\d+\.f1,transfers\)\) return 9;/);
    assert(use && use[1] === outType && Number(use[2]) === f.slots, `${f.name}: adapter extraction call`);
    const outcome = adt(schema, schema.exports.find(e => e.name === 'process')!.result);
    const value = outcome.variants.find(v => short(v) === 'Accepted')!.fields[1].type;
    const record = adt(schema, value).variants[0];
    const effect = f.vector ? (() => {
      let t = record.fields[1].type;
      for (let n = f.slots; n > 1; n /= 2) t = adt(schema, t).variants[0].fields[0].type;
      return t;
    })() : record.fields[0].type;
    const l: Layout = { schema, value, effect, valueC: adt(schema, value).cType, effectC: adt(schema, effect).cType };
    const signature = (name: string, type: string) => `static inline int ${name}(const ${type} *value`;
    assert(helper.single.startsWith(signature('bend_extract_effect', l.effectC)) &&
      helper.multi.startsWith(signature('bend_extract_effects', l.valueC)), `${f.name}: helper argument types`);

    // Inputs: one generated-constructor expression per case, compiled once.
    const list = cases(f, l);
    const aliases = new Map<string, string>();
    const alias = (maker: string) => aliases.get(maker) ?? aliases.set(maker, `M${aliases.size}`).get(maker)!;
    const container = (c: Case): BendValue => {
      const values = c.slots.map(s => effectValue(s.effect));
      if (!f.vector) return { c: 'Effects', f: Object.fromEntries(['first', 'second', 'third'].slice(0, f.slots).map((n, i) => [n, values[i]])) };
      const pack = (xs: BendValue[]): BendValue =>
        xs.length === 1 ? xs[0] : { c: 'Pair', f: { left: pack(xs.slice(0, xs.length / 2)), right: pack(xs.slice(xs.length / 2)) } };
      return { c: 'Vector', f: { length: c.length!, storage: pack(values) } };
    };
    const builders = list.map((c, id) => `static void b${id}(efx_value_t *v) {\n  *v = ${cexpr(schema, value, container(c), alias)};\n` +
      [c.outer?.poke, ...c.slots.map(s => s.bad?.poke)].filter(Boolean).map(p => `  ${p}\n`).join('') + '}');
    const casesC = `/* Generated by tests/effect-extraction.ts: well-formed inputs from the generated constructors. */
#include "program.h"
typedef ${l.valueC} efx_value_t;
${[...aliases].map(([maker, name]) => `#define ${name} ${maker}`).join('\n')}
${builders.join('\n')}
const unsigned efx_case_count = ${list.length}u;
const unsigned efx_value_bytes = sizeof(efx_value_t);
void efx_build(unsigned id, void *value) {
  static void (*const table[])(efx_value_t *) = {${list.map((_, id) => `b${id}`).join(',')}};
  table[id](value);
}
`;
    fs.writeFileSync(path.join(dir, 'cases.c'), casesC);
    await run$(cc, [...FLAGS, `-I${dir}`, '-c', path.join(dir, 'cases.c'), '-o', path.join(dir, 'cases.o')], { maxBuffer: 1 << 26 });
    const unit = (helperFile: string) => `#include <stdlib.h>
#include "program.h"
#include "solana_min.h"
#include "${helperFile}"
#define EFX_KIND ${f.family === 'cpi-v1' ? 2 : 1}
#define EFX_VALUE_T ${l.valueC}
#define EFX_SLOTS ${f.slots}
static const ${l.effectC} *efx_slot(const EFX_VALUE_T *v, unsigned i) {
  switch (i) {
${Array.from({ length: f.slots }, (_, i) => `    case ${i}: return &v->${slotPath(f, i)};`).join('\n')}
    default: abort();
  }
}
#include "effect-extraction-harness.h"
`;
    const build = async (name: string, helperC: string) => {
      fs.writeFileSync(path.join(dir, `${name}.helper.h`), helperC);
      fs.writeFileSync(path.join(dir, `${name}.unit.c`), unit(`${name}.helper.h`));
      await run$(cc, [...FLAGS, '-Iruntime', '-Itests', `-I${dir}`, path.join(dir, `${name}.unit.c`), path.join(dir, 'cases.o'),
        '-o', path.join(dir, name)], { maxBuffer: 1 << 26 });
      return path.join(dir, name);
    };

    // The written helper text, unchanged, must match the oracle on every call in both modes.
    const want = list.flatMap((c, id) => expected(f, c, id));
    const binary = await build('emitted', text);
    assert.equal(sha(fs.readFileSync(path.join(dir, 'emitted.helper.h'))), sha(text));
    let observed = '';
    for (const mode of ['guard', 'exact'] as const) {
      const r = await execute(binary, mode);
      assert.equal(r.exit, 0, `${f.name}: emitted helpers aborted in ${mode} mode\n${r.stderr.slice(0, 3000)}`);
      assert(r.done && r.lines.length === want.length, `${f.name}: incomplete ${mode} run`);
      assert.deepEqual(firstFailure(f, list, want, r.lines), undefined, `${f.name}: emitted helpers differ from the oracle (${mode})`);
      assert.equal(r.stderr, '', `${f.name}: sanitizer output in ${mode} mode`);
      observed = r.lines.join('\n');
    }
    assert.equal(observed, want.join('\n'));
    const rejections = want.filter(line => line.endsWith(' 0 1 1 1 -')).length;
    assert(rejections > 0 && rejections < want.length, `${f.name}: both accepted and rejected calls are exercised`);

    // Mutated helper text must be rejected by the same oracle, after a complete run.
    const singleSha = sha(helper.single);
    const owner = mutated.get(singleSha) ?? mutated.set(singleSha, f.name).get(singleSha)!;
    const selected = mutants(f, helper).filter(m => m.scope === 'effects' || owner === f.name);
    assert.equal(new Set(selected.map(m => m.name)).size, selected.length, `${f.name}: mutant names are unique`);
    assert.equal(new Set(selected.map(m => sha(m.text))).size, selected.length, `${f.name}: mutants are distinct`);
    const killed = await pool(selected.map((m, k) => async () => {
      assert.notEqual(m.text, text, `${f.name}: mutation did not change the helper: ${m.name}`);
      // A compiler error is a test failure, not a rejected mutant.
      const bin = await build(`mutant-${String(k).padStart(3, '0')}`, m.text);
      const r = await execute(bin, 'guard');
      // A timeout, signal, sanitizer abort or partial run is not a rejected mutant.
      assert(r.exit === 0 && r.done && r.lines.length === want.length,
        `${f.name}: mutant did not complete every call: ${m.name} (${r.exit})\n${r.stderr.slice(0, 1500)}`);
      const failure = firstFailure(f, list, want, r.lines);
      assert(failure, `${f.name}: mutant survived: ${m.name}`);
      assert.notEqual(failure.detection, 'malformed-line', `${f.name}: unreadable mutant output: ${m.name}`);
      // Mutant sources are kept; their binaries are not.
      const discard = () => { for (const file of [bin, `${bin}.dSYM`]) fs.rmSync(file, { recursive: true, force: true }); };
      if (!m.abort) { discard(); return { name: m.name, scope: m.scope, sha256: sha(m.text), ...failure }; }
      // The out-of-bounds mutant clobbers the guard element, and with an exact
      // allocation it must stop in an ASan heap write just past the output
      // array, with every earlier call still matching the oracle.
      assert(failure.detection === 'guard' && failure.field === 'post-guard', `${f.name}: ${m.name}: expected a clobbered post guard`);
      const x = await execute(bin, 'exact');
      const region = x.stderr.match(/is located (\d+) bytes (?:after|to the right of) (\d+)-byte region/);
      assert(x.exit !== 0 && [1, 'SIGABRT'].includes(x.exit) && !x.done && x.lines.length < want.length &&
        x.lines.every((line, i) => line === want[i]) && /ERROR: AddressSanitizer: heap-buffer-overflow /.test(x.stderr) &&
        /\nWRITE of size \d+ at /.test(x.stderr) && region !== null && Number(region[2]) === f.slots * OUT_BYTES[f.family] &&
        Number(region[1]) < OUT_BYTES[f.family],
        `${f.name}: mutant did not stop in the expected ASan heap overflow: ${m.name} (${x.exit})\n${x.stderr.slice(0, 2000)}`);
      discard();
      return { name: m.name, scope: m.scope, sha256: sha(m.text), ...failure, sanitizer: { exit: x.exit, callsBeforeAbort: x.lines.length,
        report: `heap-buffer-overflow: write ${region![1]} bytes after the ${region![2]}-byte output array` } };
    }), width);

    const aborts = killed.filter(k => 'sanitizer' in k).length;
    const detections: Record<string, number> = {};
    for (const k of killed) detections[k.detection] = (detections[k.detection] ?? 0) + 1;
    report.fixtures.push({ name: f.name, family: f.family, slots: f.slots, container: f.vector ? 'vector' : 'fixed',
      effects: f.effects, sourceSha256: sha(fs.readFileSync(source)), adapterSha256: sha(written),
      typesSha256: sha(fs.readFileSync(`${stem}.h`)), schemaSha256: sha(fs.readFileSync(`${stem}.schema.json`)),
      helperSha256: sha(text), extractEffectSha256: singleSha, extractEffectsSha256: sha(helper.multi),
      extractEffectMutantsRunIn: owner,
      cases: list.length, calls: want.length, rejectedCalls: rejections, casesSha256: sha(casesC),
      expectedSha256: sha(want.join('\n')), observedSha256: sha(observed), modes: ['guard', 'exact'],
      mutants: killed.length, mutantDetections: detections, sanitizerAborts: aborts, mutantResults: killed });
    const t = report.totals;
    t.fixtures += 1; t.cases += list.length; t.calls += want.length; t.rejectedCalls += rejections;
    t.nativeRuns += 2 + killed.length + aborts; t.mutants += killed.length; t.sanitizerAborts += aborts;
    console.log(`${f.name}: ${list.length} cases, ${want.length} extraction calls matched the oracle in guard and exact modes ` +
      `(${rejections} rejections); ${killed.length} mutated helpers rejected (${aborts} also by ASan)`);
  }
  // Every distinct bend_extract_effect text had its own mutants run.
  assert.equal(new Set(mutated.values()).size, mutated.size);
  assert.equal(mutated.size, 3, 'token-v1, token-v2 and CPI single-effect helpers');

  fs.writeFileSync(`${reportPath}.tmp`, JSON.stringify(report, null, 2) + '\n');
  fs.renameSync(`${reportPath}.tmp`, reportPath);
  const t = report.totals;
  console.log(`Effect extraction: ${t.calls} native sanitizer calls of emitted helpers matched the value-level oracle across ` +
    `${t.fixtures} fixtures (${t.cases} cases, ${t.rejectedCalls} rejections); ${t.mutants} mutated helpers rejected, ` +
    `${t.sanitizerAborts} also by an ASan abort; ${rejected.length} oversized or unsupported shapes refused by the compiler; ` +
    `report ${reportPath}`);
}

if (import.meta.main) await testEffectExtraction();
