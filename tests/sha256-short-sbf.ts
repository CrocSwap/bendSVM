import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {Backend, checkedBook} from '../compiler/backend.ts';
import {emitCodecs} from '../compiler/codecs.ts';
import {emitDispatcher} from '../compiler/dispatch.ts';
import {generateSha256Short, type Sha256ShortIdentity} from '../compiler/sha256-short.ts';
import type {RuntimeSchema, TypeSchema, VariantSchema} from '../compiler/schema.ts';
import {wireCodec, type WireValue} from '../sdk/wire.ts';

type ProcessResult = ReturnType<typeof spawnSync>;
type Tool = {path: string; invokedAs: string; version: string; sha256: string};
type RunnerRequest = Record<string, unknown>;
type RunnerResponse = {success: boolean; value?: any; error?: string};
type Case = {
  name: string;
  value: WireValue;
  input: number[];
  expectedBytes: number[];
  disposition: 'hashed' | 'rejected';
  hostDigest?: string;
  messageBytes: number[];
};

const root = path.resolve('.');
const executingScript = fs.realpathSync(import.meta.path);
const workRoot = path.resolve('build/sha256-short-sbf');
fs.mkdirSync(workRoot, {recursive: true});
const work = path.join(workRoot, 'runs', randomUUID());
fs.mkdirSync(path.dirname(work), {recursive: true});
fs.mkdirSync(work);
const workRunId = path.basename(work);

function fail(message: string): never {
  throw new Error(`SHA-256 short SBF execution [${path.relative(root, work)}]: ${message}`);
}

async function main(): Promise<void> {

assert.equal(path.dirname(executingScript), fs.realpathSync(path.join(root, 'tests')),
  'run the SHA gate from the same repository root as its executing test script');

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function invoke(file: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}): ProcessResult {
  return spawnSync(file, args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options});
}

function processText(result: ProcessResult): string {
  return `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`;
}

function requireSuccess(result: ProcessResult, label: string): string {
  if (result.error || result.status !== 0) {
    fail(`${label} failed: status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? 'none'}\n${processText(result).slice(-12000)}`);
  }
  return result.stdout?.toString().trim() ?? '';
}

function toolInfo(command: string, args = ['--version']): Tool {
  const invokedAs = path.resolve(command);
  const real = fs.realpathSync(invokedAs);
  const version = requireSuccess(invoke(invokedAs, args, {timeout: 30_000}), `${command} version`);
  return {path: real, invokedAs, version, sha256: hashFile(real)};
}

function sourceHashes(files: string[]): Record<string, string> {
  return Object.fromEntries([...files].sort().map(file => [file, hashFile(file)]));
}

function checkSourceSnapshot(): {
  manifest: any;
  files: string[];
  hashes: Record<string, string>;
  bend: {commit: string; clean: string; bendTsSha256: string; baseBendSha256: string};
} {
  const manifestPath = 'tests/sha256-short-sbf/prerequisite-hashes.json';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.bend.commit, '7561656155a4285c1e4ccfcb3505ab59524de973');
  const files = [...new Set([
    ...Object.keys(manifest.files),
    '.deps/bend/bend2/bend.ts',
    '.deps/bend/bend2/base.bend',
    manifestPath,
    executingScript,
  ])].sort();
  const hashes = sourceHashes(files);
  for (const [file, expected] of Object.entries(manifest.files) as [string, string][]) {
    assert.equal(hashes[file], expected, `copied current-main prerequisite hash: ${file}`);
  }

  const commit = requireSuccess(invoke('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD']), 'Bend commit check');
  const clean = requireSuccess(invoke('git', ['-C', '.deps/bend', 'status', '--porcelain']), 'Bend cleanliness check');
  const bendTsSha256 = hashFile('.deps/bend/bend2/bend.ts');
  const baseBendSha256 = hashFile('.deps/bend/bend2/base.bend');
  assert.equal(commit, manifest.bend.commit, 'pinned Bend commit');
  assert.equal(clean, '', 'pinned Bend checkout is clean');
  assert.equal(bendTsSha256, manifest.bend.bendTsSha256, 'pinned Bend loader source hash');
  assert.equal(baseBendSha256, manifest.bend.baseBendSha256, 'pinned Bend Base source hash');
  return {manifest, files, hashes, bend: {commit, clean, bendTsSha256, baseBendSha256}};
}

function assertSourceSnapshot(files: string[], before: Record<string, string>): void {
  assert.deepEqual(sourceHashes(files), before, 'source inputs changed during SHA short execution');
}

assert.equal(process.versions.bun, '1.4.2', 'pinned Bun 1.4.2');
const snapshot = checkSourceSnapshot();
const sbfTools = path.resolve(process.env.SBF_TOOLS ??
  path.join(os.homedir(), '.cache/solana/v1.53/platform-tools/llvm/bin'));
const clang = toolInfo(path.join(sbfTools, 'clang'));
const linker = toolInfo(path.join(sbfTools, 'ld.lld'));
const readelf = toolInfo(path.join(sbfTools, 'llvm-readelf'));
assert.match(clang.version, /20\.1\.7/, 'Anza Clang 20.1.7');
assert.match(clang.version, /anza-xyz/i, 'Clang must come from pinned Anza platform-tools');
assert.match(linker.version, /20\.1\.7/, 'Anza LLD 20.1.7');
assert.match(readelf.version, /20\.1\.7/, 'Anza llvm-readelf 20.1.7');

const runnerPath = path.resolve(process.env.SHA256_SHORT_SBF_RUNNER ??
  'scripts/test-runner/target/debug/bend-test-runner');
assert(fs.existsSync(runnerPath), `prebuilt LiteSVM runner exists: ${runnerPath}; this gate never builds Cargo`);
const runnerHash = hashFile(runnerPath);
assert.equal(runnerHash, snapshot.manifest.readOnlySharedTools.litesvmRunnerSha256,
  'read-only shared LiteSVM runner matches the prerequisite snapshot');

const mainRoot = `${work}/generated`;
fs.mkdirSync(mainRoot);
const programStem = 'sha256-reference';
const identity: Sha256ShortIdentity = {
  export: {name: 'hash_short', cName: 'bend_hash_5f_short'},
  u32Type: 'U32',
  message: {
    type: '../../sdk/sha256-reference.Message', constructor: '../../sdk/sha256-reference.Message',
    lengthField: 'length', bytesField: 'bytes',
  },
  bytes: {
    type: '../../sdk/sha256-reference.Bytes64', constructor: '../../sdk/sha256-reference.Bytes64',
    wordsField: 'words',
  },
  pair: {
    types: [
      '../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<U32>>>>>>',
      '../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<U32>>>>>',
      '../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<U32>>>>',
      '../../sdk/buffer.Pair<../../sdk/buffer.Pair<../../sdk/buffer.Pair<U32>>>',
      '../../sdk/buffer.Pair<../../sdk/buffer.Pair<U32>>',
      '../../sdk/buffer.Pair<U32>',
    ],
    constructor: '../../sdk/buffer.Pair', leftField: 'left', rightField: 'right',
  },
  result: {
    type: '../../sdk/sha256-reference.HashResult', rejected: '../../sdk/sha256-reference.Rejected',
    hashed: '../../sdk/sha256-reference.Hashed', digestField: 'digest',
  },
  digest: {
    type: '../../sdk/sha256-reference.Digest256', constructor: '../../sdk/sha256-reference.Digest256',
    fields: ['h0', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'h7'],
  },
};

const book = await checkedBook('tests/sha256-reference/PROOF.bend');
const emitted = new Backend(book, {nativeArithmetic: false}).emit(['hash_short']);
assert.deepEqual(emitted.schema.exports.map(exp => exp.name), ['hash_short'], 'fresh checked export set');
assert.doesNotMatch(emitted.c, /sol_sha256|bend_sha256_hashv/, 'checked source C starts without syscall specialization');
const generated = generateSha256Short(emitted.schema, identity);
assert.equal(generated.slotPaths.length, 64, 'fresh generator used all 64 emitted layout leaves');
assert.match(generated.definition, /bend_sha256_hashv\(&sha256_short_slice, 1u, sha256_short_digest\)/);
assert.match(generated.definition, /__builtin_trap\(\)/, 'fresh output has a nonreturning wrapper failure path');
assert(!emitted.c.includes('sol_sha256'), 'checked-source emission did not include the syscall');
fs.writeFileSync(path.join(mainRoot, `${programStem}.checked.c`), emitted.c, {flag: 'wx'});
fs.writeFileSync(path.join(mainRoot, `${programStem}.schema.json`),
  `${JSON.stringify(emitted.schema, null, 2)}\n`, {flag: 'wx'});
fs.writeFileSync(path.join(mainRoot, `${programStem}.sha256-short.definition.c`),
  `${generated.definition}\n`, {flag: 'wx'});

function schemaType(schema: RuntimeSchema, name: string): TypeSchema {
  const type = schema.types.find(item => item.name === name);
  assert(type, `actual emitted schema contains ${name}`);
  return type;
}

function namedVariant(typeName: string, suffix: string): VariantSchema {
  const type = schemaType(emitted.schema, typeName);
  assert.equal(type.kind, 'adt', `${typeName} is an ADT in emitted schema`);
  const variant = type.variants.find(item => item.name === suffix || item.name.endsWith(`.${suffix}`));
  assert(variant, `${typeName} has ${suffix} in emitted schema`);
  return variant;
}

function make(typeName: string, suffix: string, fields: Record<string, WireValue>): WireValue {
  return {constructor: namedVariant(typeName, suffix).name, fields};
}

const exportSchema = emitted.schema.exports.find(exp => exp.name === 'hash_short')!;
const resultType = exportSchema.result;
const codec = wireCodec(emitted.schema);

function pairTree(typeName: string, leaves: number[]): WireValue {
  if (typeName === identity.u32Type) {
    assert.equal(leaves.length, 1, 'one emitted U32 per leaf');
    return leaves[0];
  }
  const type = schemaType(emitted.schema, typeName);
  assert.equal(type.kind, 'adt', `binary node ${typeName} is an ADT`);
  assert.equal(type.variants.length, 1, `binary node ${typeName} has one emitted constructor`);
  const variant = type.variants[0];
  assert.equal(variant.fields.length, 2, `binary node ${typeName} has two fields`);
  assert.equal(variant.fields[0].name, 'left');
  assert.equal(variant.fields[1].name, 'right');
  assert.equal(leaves.length % 2, 0, 'binary subtree has even leaf count');
  const middle = leaves.length / 2;
  return {
    constructor: variant.name,
    fields: {
      left: pairTree(variant.fields[0].type, leaves.slice(0, middle)),
      right: pairTree(variant.fields[1].type, leaves.slice(middle)),
    },
  };
}

function makeMessage(length: number, active: number[], inactive: number): WireValue {
  assert(Number.isInteger(length) && length >= 0 && length <= 0xffffffff);
  assert(active.length <= 64, 'at most 64 active input words');
  const messageType = exportSchema.args[0];
  const messageVariant = namedVariant(messageType, 'Message');
  const bytesField = messageVariant.fields.find(field => field.name === 'bytes')!;
  const bytesVariant = namedVariant(bytesField.type, 'Bytes64');
  const wordsType = bytesVariant.fields.find(field => field.name === 'words')!.type;
  const slots = Array<number>(64).fill(inactive);
  active.forEach((value, index) => { slots[index] = value; });
  return make(messageType, 'Message', {
    length,
    bytes: make(bytesField.type, 'Bytes64', {words: pairTree(wordsType, slots)}),
  });
}

function resultDigest(value: WireValue): Buffer | undefined {
  const result = value as {constructor: string; fields: Record<string, WireValue>};
  if (result.constructor.endsWith('.Rejected')) return undefined;
  assert(result.constructor.endsWith('.Hashed'), `known SHA result ${result.constructor}`);
  const digest = result.fields.digest as {constructor: string; fields: Record<string, WireValue>};
  assert(digest.constructor.endsWith('.Digest256'), `known digest constructor ${digest.constructor}`);
  const bytes = Buffer.alloc(32);
  for (let i = 0; i < 8; i++) bytes.writeUInt32BE(digest.fields[`h${i}`] as number, i * 4);
  return bytes;
}

function resultBytes(value: WireValue): number[] {
  return [...codec.encode(resultType, value)];
}

function freshnessMarker(instruction: number[]): number {
  let hash = 0x811c9dc5;
  for (const byte of instruction) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  return hash >>> 0;
}

function markerInScratch(data: number[]): number {
  assert(data.length >= 4, 'scratch account has space for its invocation marker');
  const offset = data.length - 4;
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function assertFreshOutput(data: number[], instruction: number[], label: string): number {
  const expected = freshnessMarker(instruction);
  assert.equal(markerInScratch(data), expected, `${label} marker matches this input; output bytes are checked separately`);
  return expected;
}

const caseSpecs: {name: string; length: number; active: number[]; inactive?: number; expectedFixture?: string}[] = [];
for (let length = 0; length <= 55; length++) {
  caseSpecs.push({
    name: `length-${length.toString().padStart(2, '0')}`,
    length,
    active: Array.from({length}, (_, index) => (index * 37 + length * 11) & 255),
    inactive: (0xa5000000 | (length << 8) | length) >>> 0,
  });
}
caseSpecs.push(
  {name: 'length-56', length: 56, active: Array.from({length: 56}, (_, i) => i), inactive: 0xffffffff},
  {name: 'length-64', length: 64, active: Array.from({length: 64}, (_, i) => (255 - i) & 255), inactive: 0xffffffff},
  {name: 'length-u32-max', length: 0xffffffff, active: [], inactive: 0xffffffff},
  {name: 'active-byte-256-first', length: 1, active: [256], inactive: 0xffffffff},
  {name: 'active-byte-256-last', length: 55, active: [...Array.from({length: 54}, (_, i) => i), 256], inactive: 0xffffffff},
  {name: 'active-u32-max-first', length: 1, active: [0xffffffff], inactive: 0xdeadbeef},
  {name: 'active-u32-max-last', length: 55, active: [...Array.from({length: 54}, (_, i) => i), 0xffffffff], inactive: 0xdeadbeef},
  {name: 'byte-boundaries-0-255', length: 2, active: [0, 255], inactive: 0xffffffff},
  {name: 'order-12a5', length: 2, active: [0x12, 0xa5], inactive: 0xdeadbeef},
  {name: 'order-a512', length: 2, active: [0xa5, 0x12], inactive: 0xdeadbeef},
  {name: 'mutation-target', length: 3, active: [0x2a, 0x5b, 0x7c], inactive: 0xdeadbeef},
  {name: 'inactive-u32-max-empty', length: 0, active: [], inactive: 0xffffffff},
  {name: 'inactive-u32-max-middle', length: 17, active: Array.from({length: 17}, (_, i) => i + 1), inactive: 0xffffffff},
  {name: 'inactive-mixed-at-55', length: 55, active: Array.from({length: 55}, (_, i) => (i * 19 + 7) & 255), inactive: 0x7f00ff80},
);

const fixedVectors = JSON.parse(fs.readFileSync('tests/sha256-reference/vectors.json', 'utf8')) as
  {name: string; hex: string; sha256: string}[];
assert.deepEqual(fixedVectors.map(vector => vector.name), [
  'empty', 'abc', 'padding-55', 'random-short-1', 'random-short-17',
  'random-short-31', 'random-short-54',
], 'fixed checked-reference vector inventory');
for (const vector of fixedVectors) {
  const bytes = Buffer.from(vector.hex, 'hex');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), vector.sha256,
    `independent host SHA fixture ${vector.name}`);
  caseSpecs.push({name: `fixture-${vector.name}`, length: bytes.length,
    active: [...bytes], inactive: 0xdeadbeef, expectedFixture: vector.sha256});
}
assert.equal(new Set(caseSpecs.map(item => item.name)).size, caseSpecs.length, 'unique SHA execution case names');
assert(caseSpecs.length <= 80, 'bounded actual-SBF case count');
assert.deepEqual(Array.from({length: 56}, (_, i) => caseSpecs[i].length),
  Array.from({length: 56}, (_, i) => i), 'actual-SBF test covers every short length from 0 through 55');

const cases: Case[] = caseSpecs.map(spec => {
  const value = makeMessage(spec.length, spec.active, spec.inactive ?? 0xdeadbeef);
  const isValidShort = spec.length <= 55 && spec.active.length === spec.length && spec.active.every(byte => byte <= 255);
  if (isValidShort) {
    const host = createHash('sha256').update(Buffer.from(spec.active)).digest();
    if (spec.expectedFixture) assert.equal(host.toString('hex'), spec.expectedFixture, `fixed host vector ${spec.name}`);
    const expected = make(resultType, 'Hashed', {
      digest: make(identity.digest.type, 'Digest256', Object.fromEntries(identity.digest.fields.map((field, index) =>
        [field, host.readUInt32BE(index * 4)]))),
    });
    return {
      name: spec.name, value, input: [...codec.call('hash_short', [value])],
      expectedBytes: resultBytes(expected), disposition: 'hashed', hostDigest: host.toString('hex'),
      messageBytes: [...spec.active],
    };
  }
  const rejected = make(resultType, 'Rejected', {});
  return {
    name: spec.name, value, input: [...codec.call('hash_short', [value])],
    expectedBytes: resultBytes(rejected), disposition: 'rejected', messageBytes: [...spec.active],
  };
});
const mutationTarget = cases.find(item => item.name === 'mutation-target')!;
assert(mutationTarget && mutationTarget.disposition === 'hashed');

const malformedConstructorInput = [...mutationTarget.input];
malformedConstructorInput[1] = 0xff;
const wireErrorCases = [
  {name: 'malformed-constructor-tag', input: malformedConstructorInput},
  {name: 'truncated-canonical-call', input: mutationTarget.input.slice(0, -1)},
  {name: 'trailing-byte-after-canonical-call', input: [...mutationTarget.input, 0]},
];
assert.equal(new Set([...cases.map(item => freshnessMarker(item.input)),
  ...wireErrorCases.map(item => freshnessMarker(item.input))]).size,
cases.length + wireErrorCases.length, 'each canonical and malformed input has a distinct scratch marker');

const faultControlInput = [...codec.call('hash_short', [makeMessage(1, [0x6d], 0xdecafbad)])];
const faultControlDigest = Buffer.from(Array.from({length: 32}, (_, index) => 0xa0 + index));
assert.notEqual(freshnessMarker(faultControlInput), freshnessMarker(mutationTarget.input),
  'successful fault-shim control and trapping input have distinct markers');
assert(!new Set([...cases.map(item => freshnessMarker(item.input)),
  ...wireErrorCases.map(item => freshnessMarker(item.input))]).has(freshnessMarker(faultControlInput)),
'successful shim control marker differs from every canonical and malformed test input');

function hashedResultBytes(digest: Buffer): number[] {
  assert.equal(digest.length, 32, 'SHA digest wire constructor uses 32 bytes');
  return resultBytes(make(resultType, 'Hashed', {
    digest: make(identity.digest.type, 'Digest256', Object.fromEntries(identity.digest.fields.map((field, index) =>
      [field, digest.readUInt32BE(index * 4)]))),
  }));
}

function replaceCDefinition(c: string, cName: string, definition: string): string {
  const lines = c.split('\n');
  const candidates = lines.flatMap((line, lineNumber) =>
    line.includes(`${cName}(`) && line.trimEnd().endsWith('{') ? [lineNumber] : []);
  assert.equal(candidates.length, 1, `one emitted C definition for ${cName}`);
  const start = lines.slice(0, candidates[0]).reduce((sum, line) => sum + line.length + 1, 0);
  const nameOffset = c.indexOf(`${cName}(`, start);
  const open = c.indexOf('{', nameOffset);
  assert(open >= 0, `emitted C body starts for ${cName}`);
  let depth = 0, close = -1;
  for (let i = open; i < c.length; i++) {
    if (c[i] === '{') depth++;
    else if (c[i] === '}' && --depth === 0) { close = i; break; }
  }
  assert(close >= open, `emitted C body closes for ${cName}`);
  return c.slice(0, start) + definition + c.slice(close + 1);
}

const semanticToken = 'sha256_short_compact[0] = (u8)sha256_short_byte_0;';
assert.equal(generated.definition.split(semanticToken).length - 1, 1, 'fresh generated byte-zero copy site');
const semanticDefinition = generated.definition.replace(semanticToken,
  'sha256_short_compact[0] = (u8)(sha256_short_byte_0 + 1u);');
const rejectedMaker = namedVariant(identity.result.type, 'Rejected').cMaker;
const trapToken = '__builtin_trap();';
assert.equal(generated.definition.split(trapToken).length - 1, 1, 'fresh generated wrapper trap site');
const noTrapDefinition = generated.definition.replace(trapToken, `return ${rejectedMaker}();`);

function writeProfile(profile: string, definition?: string): {dir: string; source: string; stem: string} {
  const dir = path.join(work, profile);
  fs.mkdirSync(dir);
  const sourceC = definition === undefined
    ? emitted.c
    : replaceCDefinition(emitted.c, identity.export.cName, definition);
  const header = path.join(dir, `${programStem}.h`);
  const wireHeader = path.join(dir, `${programStem}.wire.h`);
  const dispatchHeader = path.join(dir, `${programStem}.dispatch.h`);
  fs.writeFileSync(header, sourceC, {flag: 'wx'});
  fs.writeFileSync(wireHeader, `#include "${programStem}.h"\n${emitCodecs(emitted.schema)}`, {flag: 'wx'});
  fs.writeFileSync(dispatchHeader, `#include "${programStem}.wire.h"\n${emitDispatcher(emitted.schema)}`, {flag: 'wx'});
  fs.writeFileSync(path.join(dir, `${programStem}.schema.json`),
    `${JSON.stringify(emitted.schema, null, 2)}\n`, {flag: 'wx'});
  const source = path.join(dir, 'entry.c');
  fs.writeFileSync(source, `#include "solana_min.h"
#include "bend_sha256.h"
#include "${programStem}.dispatch.h"
extern u64 sol_log_64_(u64, u64, u64, u64, u64);
/* Volatile readback makes the logged values observations of scratch stores,
 * rather than values the optimizer may forward without reading account data. */
static u64 observed_u32(const volatile u8 *data) {
  u64 result = 0;
  for (u32 i = 0; i < 4u; ++i) result |= (u64)data[i] << (8u * i);
  return result;
}

__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 1u) return 201u;
  Account scratch;
  const u8 *cursor = read_account(input + 8, &scratch);
  if (cursor == (const u8 *)0 || scratch.data == (u8 *)0 || !scratch.writable || scratch.executable) return 202u;
  const u64 instruction_length = read_le(cursor, 8);
  if (instruction_length > 1024u || scratch.size < 64u) return 203u;
  const u8 *instruction = cursor + 8;
  const u8 *program_id = instruction + instruction_length;
  for (u32 i = 0; i < 32u; ++i) if (scratch.owner[i] != program_id[i]) return 204u;
  /* Account creation uses a zero-length no-op; the actual ABI call is a schema-encoded instruction. */
  if (instruction_length == 0u) return 0u;
  /* Poison the result area and persist an input-derived marker before dispatch.
   * A successful call must replace the poison; failed calls roll this write back. */
  u32 freshness = 0x811c9dc5u;
  for (u64 i = 0; i < instruction_length; ++i) {
    freshness = (freshness ^ instruction[i]) * 0x01000193u;
  }
  write_le(scratch.data, 0xffffffffu, 4);
  for (u64 i = 4; i < scratch.size - 4u; ++i) {
    const u32 shift = (u32)(i & 3u) * 8u;
    scratch.data[i] = (u8)((freshness >> shift) ^ (u32)i ^ 0xa5u);
  }
  write_le(scratch.data + scratch.size - 4u, freshness, 4);
  /* Observe account data after the stores and before any dispatch can fail. */
  sol_log_64_(0x534841u, observed_u32(scratch.data + scratch.size - 4u),
    observed_u32(scratch.data), ((volatile u8 *)scratch.data)[4], instruction_length);
  u8 output[1024];
  u64 written = 0;
  if (!bend_wire_dispatch(instruction, instruction_length, output, sizeof(output), &written)) return 205u;
  if (written > scratch.size - 8u) return 206u;
  write_le(scratch.data, written, 4);
  for (u64 i = 0; i < written; ++i) scratch.data[4u + i] = output[i];
  sol_set_return_data(output, written);
  return 0u;
}
`, {flag: 'wx'});
  return {dir, source, stem: path.join(dir, programStem)};
}

const profiles = [
  {name: 'checked-reference', definition: undefined, kind: 'reference' as const},
  {name: 'real-syscall', definition: generated.definition, kind: 'real' as const},
  {name: 'semantic-mutant', definition: semanticDefinition, kind: 'real' as const},
  {name: 'fault-trap', definition: generated.definition, kind: 'fault' as const},
  {name: 'fault-no-trap', definition: noTrapDefinition, kind: 'fault' as const},
].map(profile => ({...profile, ...writeProfile(profile.name, profile.definition)}));

const faultShim = path.join(work, 'fault-sha256.c');
fs.writeFileSync(faultShim, `#include "solana_min.h"
typedef struct { const u8 *data; u64 len; } TestSha256Slice;
u64 sol_sha256(const u8 *values, u64 value_count, u8 *hash_result) {
  for (u32 i = 0; i < 32u; ++i) hash_result[i] = (u8)(0xa0u + i);
  if (value_count == 1u) {
    const TestSha256Slice *parts = (const TestSha256Slice *)values;
    if (parts[0].len == 1u && parts[0].data[0] == 0x6du) return 0u;
  }
  return 0x123456789abcdef0ull;
}
`, {flag: 'wx'});

const realProfile = {
  name: 'sha256-short-test-real-solana-sha-syscall-v1',
  exactImports: ['abort', 'sol_log_64_', 'sol_memcpy_', 'sol_set_return_data', 'sol_sha256'],
  shaImplementation: 'LiteSVM builtin sol_sha256 syscall',
};
const referenceProfile = {
  name: 'sha256-short-test-checked-source-reference-v1',
  exactImports: ['sol_log_64_', 'sol_memcpy_', 'sol_set_return_data'],
  source: 'fresh checked Bend source emitted by Backend with native arithmetic optimization disabled',
};
const faultProfile = {
  name: 'sha256-short-test-local-nonzero-sol-sha256-v1',
  exactImports: ['abort', 'sol_log_64_', 'sol_memcpy_', 'sol_set_return_data'],
  localDefinitions: ['sol_sha256'],
  shaImplementation: 'test-only linked C shim writes a sentinel digest then returns nonzero status 0x123456789abcdef0',
};
const faultNoTrapProfile = {
  name: 'sha256-short-test-local-nonzero-sol-sha256-with-trap-removed-v1',
  exactImports: ['sol_log_64_', 'sol_memcpy_', 'sol_set_return_data'],
  localDefinitions: ['sol_sha256'],
  shaImplementation: 'same test-only linked C shim; generated trap is deliberately replaced by Rejected',
};

const compileFlags = [
  '--target=sbf', '-mcpu=generic', '-O2', '-fPIC', '-ffreestanding', '-fno-builtin',
  '-fno-stack-protector', '-std=c17', '-Wall', '-Wextra', '-Werror',
  '-Wframe-larger-than=4096', '-fstack-usage', '-ffunction-sections', '-fdata-sections',
];
const commonMemoryObject = path.join(work, 'runtime-memory.o');
const commonMemorySource = path.resolve('runtime/memory.c');

function runTool(command: string, args: string[], label: string, timeout = 90_000): string {
  return requireSuccess(invoke(command, args, {cwd: root, timeout}), label);
}

function compileObject(source: string, output: string, includeDirs: string[], label: string): void {
  const args = [...compileFlags, ...includeDirs.flatMap(dir => ['-I', dir]), '-c', source, '-o', output];
  runTool(clang.invokedAs, args, `${label} compile`);
}

function stackUsageFor(object: string): string {
  assert(object.endsWith('.o'), `stack report object suffix ${object}`);
  return `${object.slice(0, -2)}.su`;
}

compileObject(commonMemorySource, commonMemoryObject, [path.resolve('runtime')], 'runtime memory helpers');
const faultObject = path.join(work, 'fault-sha256.o');
compileObject(faultShim, faultObject, [path.resolve('runtime')], 'fault-injected SHA syscall shim');

function readFrames(stackUsageFiles: string[]): {file: string; location: string; bytes: number; kind: string}[] {
  const frames = stackUsageFiles.flatMap(file => {
    const contents = fs.readFileSync(file, 'utf8').trim();
    if (!contents) return [];
    return contents.split('\n').map(line => {
      const [location, bytesText, kind] = line.split('\t');
      assert(location && /^\d+$/.test(bytesText ?? ''), `Clang stack-usage row in ${file}: ${line}`);
      return {file: path.relative(root, file), location, bytes: Number(bytesText), kind: kind ?? 'unknown'};
    });
  });
  assert(frames.length > 0, 'Clang emitted stack-usage rows for test SBF objects');
  for (const frame of frames) assert(frame.bytes <= 4096, `SBF frame limit for ${frame.location}: ${frame.bytes} bytes`);
  return frames;
}

function undefinedSymbols(symbolText: string): string[] {
  return [...new Set(symbolText.split('\n').filter(line => /\bUND\b/.test(line))
    .map(line => line.trim().split(/\s+/).at(-1)!).filter(symbol => symbol !== 'UND'))].sort();
}

function assertLocalDefinition(symbolText: string, symbol: string): void {
  const lines = symbolText.split('\n').filter(line => line.trim().split(/\s+/).at(-1) === symbol);
  assert(lines.some(line => !/\bUND\b/.test(line)), `ELF has local linked definition of ${symbol}`);
}

type BuiltProgram = {
  profile: typeof realProfile | typeof referenceProfile | typeof faultProfile | typeof faultNoTrapProfile;
  profileName: string;
  elf: string;
  stem: string;
  source: string;
  object: string;
  stackUsageFiles: string[];
  imports: string[];
  stack: ReturnType<typeof readFrames>;
  readelfOutput: string;
};

const builtPrograms = new Map<string, BuiltProgram>();
for (const profile of profiles) {
  const object = `${profile.stem}.o`;
  compileObject(profile.source, object, [profile.dir, path.resolve('runtime')], `${profile.name} entrypoint and fresh specialization`);
  const elf = `${profile.stem}.so`;
  const linkObjects = [object, commonMemoryObject, ...(profile.kind === 'fault' ? [faultObject] : [])];
  runTool(linker.invokedAs, [
    '-z', 'notext', '-shared', '--Bdynamic', path.resolve('runtime/sbf.ld'), '--entry', 'entrypoint',
    '-z', 'max-page-size=4096', '--gc-sections', ...linkObjects, '-o', elf,
  ], `${profile.name} final ELF link`);
  const symbolText = runTool(readelf.invokedAs, ['-h', '-S', '-s', elf], `${profile.name} final ELF inspection`);
  const readelfPath = `${profile.stem}.elf.txt`;
  fs.writeFileSync(readelfPath, `${symbolText}\n`, {flag: 'wx'});
  assert.match(symbolText, /Machine:\s+Solana Bytecode Format/, `${profile.name} ELF is SBF`);
  const profileDefinition = profile.kind === 'fault'
    ? profile.name === 'fault-no-trap' ? faultNoTrapProfile : faultProfile
    : profile.kind === 'reference' ? referenceProfile : realProfile;
  const imports = undefinedSymbols(symbolText);
  assert.deepEqual(imports, profileDefinition.exactImports, `${profile.name} exact test-only final import profile`);
  if (profile.kind === 'fault') assertLocalDefinition(symbolText, 'sol_sha256');
  else if (profile.kind === 'real') assert(imports.includes('sol_sha256'), `${profile.name} imports the actual SHA syscall`);
  else assert(!imports.includes('sol_sha256'), 'checked source reference ELF has no SHA syscall import');
  const stackUsageFiles = [
    `${profile.stem}.su`, stackUsageFor(commonMemoryObject),
    ...(profile.kind === 'fault' ? [stackUsageFor(faultObject)] : []),
  ];
  const stack = readFrames(stackUsageFiles);
  const stackReport = {
    version: 1,
    frameLimit: 4096,
    maxFrameBytes: Math.max(...stack.map(frame => frame.bytes)),
    objects: stackUsageFiles.map(file => ({path: path.relative(root, file), sha256: hashFile(file)})),
    frames: stack,
  };
  fs.writeFileSync(`${profile.stem}.stack.json`, `${JSON.stringify(stackReport, null, 2)}\n`, {flag: 'wx'});
  const header = requireSuccess(invoke(readelf.invokedAs, ['-h', elf], {timeout: 30_000}), `${profile.name} ELF header`);
  assert.match(header, /Class:\s+ELF64/, `${profile.name} ELF class`);
  assert.match(header, /Version:\s+0x1/, `${profile.name} SBPFv0 ELF version`);
  assert.match(header, /Flags:\s+0x0/, `${profile.name} SBPFv0 ELF flags`);
  builtPrograms.set(profile.name, {
    profile: profileDefinition, profileName: profile.name, elf, stem: profile.stem, source: profile.source, object,
    stackUsageFiles, imports, stack, readelfOutput: readelfOutputOrPath(readelfPath),
  });
}

function readelfOutputOrPath(file: string): string {
  return path.relative(root, file);
}

const executionCasesPath = path.join(work, 'execution-cases.json');
fs.writeFileSync(executionCasesPath, `${JSON.stringify({
  schemaVersion: 1,
  generatedFrom: {source: 'tests/sha256-reference/PROOF.bend', schemaHash: hashFile(path.join(mainRoot, `${programStem}.schema.json`)),
    generatorSourceSha256: hashFile('compiler/sha256-short.ts')},
  cases: cases.map(item => ({
    name: item.name, message: item.value, instructionData: item.input,
    expectedDisposition: item.disposition, expectedReturnData: item.expectedBytes,
    hostDigest: item.hostDigest ?? null,
  })),
}, null, 2)}\n`, {flag: 'wx'});

const immutableArtifactPaths = new Set<string>([
  path.join(mainRoot, `${programStem}.checked.c`),
  path.join(mainRoot, `${programStem}.schema.json`),
  path.join(mainRoot, `${programStem}.sha256-short.definition.c`),
  executionCasesPath,
  faultShim, faultObject, stackUsageFor(faultObject), commonMemoryObject, stackUsageFor(commonMemoryObject),
]);
for (const profile of profiles) {
  const built = builtPrograms.get(profile.name)!;
  immutableArtifactPaths.add(path.join(profile.dir, `${programStem}.h`));
  immutableArtifactPaths.add(path.join(profile.dir, `${programStem}.wire.h`));
  immutableArtifactPaths.add(path.join(profile.dir, `${programStem}.dispatch.h`));
  immutableArtifactPaths.add(path.join(profile.dir, `${programStem}.schema.json`));
  immutableArtifactPaths.add(built.source);
  immutableArtifactPaths.add(built.object);
  immutableArtifactPaths.add(`${built.stem}.su`);
  immutableArtifactPaths.add(`${built.stem}.stack.json`);
  immutableArtifactPaths.add(`${built.stem}.so`);
  immutableArtifactPaths.add(`${built.stem}.elf.txt`);
}
for (const file of immutableArtifactPaths) assert(fs.existsSync(file), `fresh generated artifact exists: ${file}`);
const artifactsBeforeExecution = sourceHashes([...immutableArtifactPaths]);

const orderedSeeds = [
  ['referenceProgram', 15], ['referenceScratch', 25],
  ['realProgram', 11], ['realScratch', 21],
  ['semanticProgram', 12], ['semanticScratch', 22],
  ['faultProgram', 13], ['faultScratch', 23],
  ['noTrapProgram', 14], ['noTrapScratch', 24],
] as const;

function parseRunnerProcess(requests: RunnerRequest[], stage: string, timeout: number): RunnerResponse[] {
  assert(requests.length > 0 && requests.length <= 384, `${stage} is within bounded runner request count`);
  const input = `${requests.map(request => JSON.stringify(request)).join('\n')}\n`;
  const result = invoke(runnerPath, [], {cwd: root, input, timeout, maxBuffer: 32 * 1024 * 1024});
  if (result.error || result.status !== 0) {
    fail(`${stage} runner failed: status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? 'none'}\n${processText(result).slice(-12000)}`);
  }
  const lines = (result.stdout?.toString() ?? '').trimEnd().split('\n');
  assert.equal(lines.length, requests.length, `${stage} one JSON-lines response per bounded request`);
  return lines.map((line, index) => {
    try { return JSON.parse(line); }
    catch (error) { fail(`${stage} response ${index} is invalid JSON: ${String(error)}\n${line}`); }
  });
}

const keyRequests: RunnerRequest[] = [{op: 'hello'}, ...orderedSeeds.map(([name, seed]) => ({op: 'key', seed, label: name}))];
const keyResponses = parseRunnerProcess(keyRequests, 'deterministic runner key setup', 30_000);
assert.equal(keyResponses[0].success, true, 'LiteSVM runner hello request');
assert.equal(keyResponses[0].value.runtime, 'LiteSVM 0.7.1', 'pinned LiteSVM 0.7.1');
const addresses = Object.fromEntries(orderedSeeds.map(([name], index) => {
  const response = keyResponses[index + 1];
  assert.equal(response.success, true, `runner key generation ${name}`);
  assert.equal(typeof response.value, 'string', `runner key address ${name}`);
  return [name, response.value as string];
})) as Record<(typeof orderedSeeds)[number][0], string>;
assert.equal(new Set(Object.values(addresses)).size, orderedSeeds.length, 'all runner test addresses are unique');

const requests: RunnerRequest[] = [];
const labels: string[] = [];
function addRequest(label: string, request: RunnerRequest): number {
  labels.push(label);
  requests.push(request);
  return requests.length - 1;
}
function programInstruction(program: string, scratch: string, data: number[]): RunnerRequest {
  return {program, accounts: [{address: scratch, signer: false, writable: true}], data};
}

addRequest('runner-hello', {op: 'hello'});
for (const [name, seed] of orderedSeeds) addRequest(`runner-key-${name}`, {op: 'key', seed});
for (const [programName, addressName] of [
  ['checked-reference', 'referenceProgram'],
  ['real-syscall', 'realProgram'], ['semantic-mutant', 'semanticProgram'],
  ['fault-trap', 'faultProgram'], ['fault-no-trap', 'noTrapProgram'],
] as const) {
  const built = builtPrograms.get(programName)!;
  addRequest(`load-${programName}`, {op: 'load', program: addresses[addressName], elf: path.resolve(built.elf)});
}
for (const [programName, programAddressName, scratchAddressName] of [
  ['checked-reference', 'referenceProgram', 'referenceScratch'],
  ['real-syscall', 'realProgram', 'realScratch'], ['semantic-mutant', 'semanticProgram', 'semanticScratch'],
  ['fault-trap', 'faultProgram', 'faultScratch'], ['fault-no-trap', 'noTrapProgram', 'noTrapScratch'],
] as const) {
  addRequest(`setup-account-${programName}`, {
    op: 'create',
    allocations: [{address: addresses[scratchAddressName], bytes: 64, owner: addresses[programAddressName]}],
    instructions: [programInstruction(addresses[programAddressName], addresses[scratchAddressName], [])],
  });
}

const actualCaseRequests = cases.map(testCase => ({
  referenceSend: addRequest(`checked-reference-send-${testCase.name}`, {
    op: 'send', instructions: [programInstruction(addresses.referenceProgram, addresses.referenceScratch, testCase.input)],
  }),
  referenceAccount: addRequest(`checked-reference-account-${testCase.name}`, {op: 'account', address: addresses.referenceScratch}),
  actualSend: addRequest(`real-syscall-send-${testCase.name}`, {
    op: 'send', instructions: [programInstruction(addresses.realProgram, addresses.realScratch, testCase.input)],
  }),
  actualAccount: addRequest(`real-syscall-account-${testCase.name}`, {op: 'account', address: addresses.realScratch}),
}));
const wireErrorRequests = wireErrorCases.map(testCase => ({
  referenceSend: addRequest(`checked-reference-wire-error-send-${testCase.name}`, {
    op: 'send', instructions: [programInstruction(addresses.referenceProgram, addresses.referenceScratch, testCase.input)],
  }),
  referenceAccount: addRequest(`checked-reference-wire-error-account-${testCase.name}`,
    {op: 'account', address: addresses.referenceScratch}),
  actualSend: addRequest(`real-syscall-wire-error-send-${testCase.name}`, {
    op: 'send', instructions: [programInstruction(addresses.realProgram, addresses.realScratch, testCase.input)],
  }),
  actualAccount: addRequest(`real-syscall-wire-error-account-${testCase.name}`,
    {op: 'account', address: addresses.realScratch}),
}));
const semanticSend = addRequest('semantic-mutant-send-mutation-target', {
  op: 'send', instructions: [programInstruction(addresses.semanticProgram, addresses.semanticScratch, mutationTarget.input)],
});
const semanticAccount = addRequest('semantic-mutant-account-mutation-target', {op: 'account', address: addresses.semanticScratch});
const faultControlSend = addRequest('fault-trap-successful-shim-control', {
  op: 'send', instructions: [programInstruction(addresses.faultProgram, addresses.faultScratch, faultControlInput)],
});
const faultControlAccount = addRequest('fault-trap-successful-shim-control-account',
  {op: 'account', address: addresses.faultScratch});
const faultBefore = addRequest('fault-trap-account-before', {op: 'account', address: addresses.faultScratch});
const faultSend = addRequest('fault-trap-send-valid-message', {
  op: 'send', instructions: [programInstruction(addresses.faultProgram, addresses.faultScratch, mutationTarget.input)],
});
const faultAfter = addRequest('fault-trap-account-after', {op: 'account', address: addresses.faultScratch});
const noTrapSend = addRequest('fault-no-trap-send-valid-message', {
  op: 'send', instructions: [programInstruction(addresses.noTrapProgram, addresses.noTrapScratch, mutationTarget.input)],
});
const noTrapAccount = addRequest('fault-no-trap-account-after', {op: 'account', address: addresses.noTrapScratch});
assert(requests.length <= 384, `bounded SBF runner request count ${requests.length} <= 384`);
const runnerResponses = parseRunnerProcess(requests, 'LiteSVM execution', 180_000);
fs.writeFileSync(path.join(work, 'runner-transcript.json'), `${JSON.stringify({
  runner: path.relative(root, runnerPath), runnerSha256: runnerHash, requests: labels.map((label, index) => ({
    label, request: requests[index], response: runnerResponses[index],
  })),
}, null, 2)}\n`, {flag: 'wx'});
const artifactsAfterExecution = sourceHashes([...immutableArtifactPaths]);
assert.deepEqual(artifactsAfterExecution, artifactsBeforeExecution,
  'compiled source and final artifacts did not change during LiteSVM execution');
const postExecutionArtifacts = {
  ...artifactsAfterExecution,
  ...sourceHashes([path.join(work, 'runner-transcript.json')]),
};

function valueAt(index: number, label: string): any {
  const response = runnerResponses[index];
  assert.equal(response.success, true, `${label} runner request: ${response.error ?? 'success'}`);
  return response.value;
}

const runnerVersion = valueAt(0, 'runner hello');
assert.equal(runnerVersion.runtime, 'LiteSVM 0.7.1', 'LiteSVM run uses pinned 0.7.1');
for (let index = 0; index < orderedSeeds.length; index++) {
  assert.equal(valueAt(index + 1, `runner key ${orderedSeeds[index][0]}`), addresses[orderedSeeds[index][0]],
    `deterministic test key ${orderedSeeds[index][0]}`);
}
for (let index = 0; index < 5; index++) {
  const loadValue = valueAt(1 + orderedSeeds.length + index, `ELF load ${index}`);
  assert.equal(loadValue, null, `LiteSVM loaded final ELF ${index}`);
}
for (let index = 0; index < 5; index++) {
  const create = valueAt(1 + orderedSeeds.length + 5 + index, `scratch account setup ${index}`);
  assert.equal(create.ok, true, `LiteSVM scratch account created for program ${index}: ${create.error ?? ''}`);
  assert(Number.isSafeInteger(create.units) && create.units > 0, `scratch setup CU measurement ${index}`);
}

function sendSuccess(index: number, label: string): {units: number; logs: string[]} {
  const result = valueAt(index, label);
  assert.equal(result.ok, true, `${label} SBF transaction success: ${result.error ?? ''}`);
  assert(Number.isSafeInteger(result.units) && result.units > 0, `${label} transaction-level LiteSVM CU`);
  assert(Array.isArray(result.logs), `${label} log array`);
  assert(result.logs.some((line: string) => line.includes(' invoke [1]')), `${label} invoke log`);
  assert(result.logs.some((line: string) => line.endsWith(' success')), `${label} exact successful program status`);
  return {units: result.units, logs: result.logs};
}

type AccountSnapshot = {lamports: number; owner: string; executable: boolean; data: number[]};

function accountSnapshot(index: number, address: string, label: string): AccountSnapshot {
  const account = valueAt(index, label);
  assert(account, `${label} account exists`);
  assert.equal(account.owner, address, `${label} owner`);
  assert.equal(account.executable, false, `${label} is a data account`);
  assert(Number.isSafeInteger(account.lamports) && account.lamports > 0, `${label} lamports are reported`);
  assert.equal(account.data.length, 64, `${label} scratch data length`);
  return {lamports: account.lamports, owner: account.owner, executable: account.executable, data: account.data as number[]};
}

function accountData(index: number, address: string, label: string): number[] {
  return accountSnapshot(index, address, label).data;
}

function storedOutput(data: number[], label: string): number[] {
  assert.equal(data.length, 64, `${label} full account data`);
  const length = data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24);
  assert(length > 0 && length <= data.length - 8, `${label} stored output length leaves marker space: ${length}`);
  return data.slice(4, 4 + length);
}

const executionObservations: any[] = [];
let referenceLastState: AccountSnapshot | undefined;
let actualLastState: AccountSnapshot | undefined;
for (const [index, testCase] of cases.entries()) {
  const referenceResponse = sendSuccess(actualCaseRequests[index].referenceSend, `checked Bend source reference ${testCase.name}`);
  const referenceState = accountSnapshot(actualCaseRequests[index].referenceAccount, addresses.referenceProgram,
    `checked Bend source reference ${testCase.name}`);
  const referenceData = referenceState.data;
  const referenceFreshness = assertFreshOutput(referenceData, testCase.input, `checked Bend source reference ${testCase.name}`);
  referenceLastState = referenceState;
  const referenceOutput = storedOutput(referenceData, `checked Bend source reference ${testCase.name}`);
  assert.deepEqual(referenceOutput, testCase.expectedBytes,
    `fresh checked Bend source SBF reference matches host SHA or canonical rejection: ${testCase.name}`);

  const response = sendSuccess(actualCaseRequests[index].actualSend, `actual syscall ${testCase.name}`);
  const actualState = accountSnapshot(actualCaseRequests[index].actualAccount, addresses.realProgram, `actual syscall ${testCase.name}`);
  const data = actualState.data;
  const actualFreshness = assertFreshOutput(data, testCase.input, `actual syscall ${testCase.name}`);
  actualLastState = actualState;
  const output = storedOutput(data, `actual syscall ${testCase.name}`);
  assert.deepEqual(output, referenceOutput, `actual SBF result matches fresh checked-source SBF reference: ${testCase.name}`);
  assert.deepEqual(output, testCase.expectedBytes, `actual SBF result matches host-derived expected wire: ${testCase.name}`);
  const decoded = codec.decode(resultType, Uint8Array.from(output));
  assert.deepEqual(resultBytes(decoded), testCase.expectedBytes, `actual SBF result decodes canonically: ${testCase.name}`);
  const digest = resultDigest(decoded);
  if (testCase.disposition === 'hashed') {
    assert(digest, `actual SBF successful digest constructor ${testCase.name}`);
    assert.equal(digest.toString('hex'), testCase.hostDigest, `actual Solana SHA syscall matches independent host SHA ${testCase.name}`);
    const referenceDigest = resultDigest(codec.decode(resultType, Uint8Array.from(referenceOutput)));
    assert(referenceDigest, `checked Bend source reference hash constructor ${testCase.name}`);
    assert.equal(digest.toString('hex'), referenceDigest.toString('hex'),
      `actual SBF digest matches checked Bend source reference ${testCase.name}`);
  } else {
    assert.equal(digest, undefined, `actual SBF returns Rejected without a partial digest ${testCase.name}`);
    assert.deepEqual(output, testCase.expectedBytes, `actual SBF rejection is canonical and complete ${testCase.name}`);
  }
  executionObservations.push({
    name: testCase.name,
    disposition: testCase.disposition,
    messageBytes: testCase.messageBytes.length,
    inputInstructionBytes: testCase.input.length,
    expectedReturnHex: Buffer.from(testCase.expectedBytes).toString('hex'),
    observedReturnHex: Buffer.from(output).toString('hex'),
    referenceFreshnessMarker: `0x${referenceFreshness.toString(16).padStart(8, '0')}`,
    actualFreshnessMarker: `0x${actualFreshness.toString(16).padStart(8, '0')}`,
    outputWasPoisonedBeforeDispatch: true,
    digestHex: digest?.toString('hex') ?? null,
    referenceDigestHex: resultDigest(codec.decode(resultType, Uint8Array.from(referenceOutput)))?.toString('hex') ?? null,
    computeUnits: response.units,
    checkedReferenceComputeUnits: referenceResponse.units,
  });
}

assert(referenceLastState && actualLastState, '77 canonical executions leave rollback snapshots');

function assertPreDispatchObservation(logs: string[], input: number[], label: string): string {
  const marker = freshnessMarker(input);
  const sample = (marker ^ 4 ^ 0xa5) & 0xff;
  const line = 'Program log: ' + [0x534841, marker, 0xffffffff, sample, input.length]
    .map(value => '0x' + value.toString(16)).join(', ');
  assert.equal(logs.filter(value => value === line).length, 1,
    `${label} must log scratch marker and poison readback before failure`);
  return line;
}

function sendWireRefusal(index: number, label: string): {units: number; logs: string[]} {
  const result = valueAt(index, label);
  assert.equal(result.ok, false, `${label} is rejected by the wire adapter`);
  assert.equal(result.code, 205, `${label} returns the entrypoint dispatch-refusal code 205`);
  assert.equal(result.error, 'InstructionError(0, Custom(205))', `${label} exact LiteSVM adapter error`);
  assert(Number.isSafeInteger(result.units) && result.units > 0, `${label} failed transaction CU`);
  assert(Array.isArray(result.logs), `${label} failed transaction logs`);
  assert(result.logs.some((line: string) => /failed: custom program error: 0x0*cd$/i.test(line)),
    `${label} exact custom-error log for adapter refusal 205`);
  return {units: result.units, logs: result.logs};
}

const wireRefusalObservations: any[] = [];
for (const [index, testCase] of wireErrorCases.entries()) {
  const requestsForCase = wireErrorRequests[index];
  const referenceFailure = sendWireRefusal(requestsForCase.referenceSend,
    `checked-source ${testCase.name}`);
  const referencePreDispatchLog = assertPreDispatchObservation(referenceFailure.logs, testCase.input, `checked-source ${testCase.name}`);
  const referenceAfter = accountSnapshot(requestsForCase.referenceAccount, addresses.referenceProgram,
    `checked-source ${testCase.name} post-refusal`);
  assert.deepEqual(referenceAfter, referenceLastState,
    `checked-source ${testCase.name} adapter refusal rolls back pre-dispatch sentinel write`);

  const actualFailure = sendWireRefusal(requestsForCase.actualSend, `actual SBF ${testCase.name}`);
  const actualPreDispatchLog = assertPreDispatchObservation(actualFailure.logs, testCase.input, `actual SBF ${testCase.name}`);
  const actualAfter = accountSnapshot(requestsForCase.actualAccount, addresses.realProgram,
    `actual SBF ${testCase.name} post-refusal`);
  assert.deepEqual(actualAfter, actualLastState,
    `actual SBF ${testCase.name} adapter refusal rolls back pre-dispatch sentinel write`);
  wireRefusalObservations.push({
    name: testCase.name,
    instructionBytes: testCase.input.length,
    refusalCode: 205,
    transactionError: 'InstructionError(0, Custom(205))',
    semanticRejectedValueReturned: false,
    checkedSourceDataRolledBack: true,
    actualSbfDataRolledBack: true,
    checkedSourcePreDispatchLog: referencePreDispatchLog,
    actualSbfPreDispatchLog: actualPreDispatchLog,
    unchangedFields: ['owner', 'lamports', 'executable'],
    checkedSourceComputeUnits: referenceFailure.units,
    actualSbfComputeUnits: actualFailure.units,
    checkedSourceLogs: referenceFailure.logs,
    actualSbfLogs: actualFailure.logs,
  });
}

const semanticResult = sendSuccess(semanticSend, 'compiled semantic mutation');
const semanticData = accountSnapshot(semanticAccount, addresses.semanticProgram, 'compiled semantic mutation').data;
const semanticFreshness = assertFreshOutput(semanticData, mutationTarget.input, 'compiled semantic mutation');
const semanticOutput = storedOutput(semanticData, 'compiled semantic mutation');
const semanticDecoded = codec.decode(resultType, Uint8Array.from(semanticOutput));
const semanticDigest = resultDigest(semanticDecoded);
assert(semanticDigest, 'semantic mutant still returns Hashed after successful compile/load');
assert.notEqual(semanticDigest.toString('hex'), mutationTarget.hostDigest,
  'semantic mutation compiles and loads but produces a detected wrong digest');
assert.notDeepEqual(semanticOutput, mutationTarget.expectedBytes,
  'semantic mutation output differs from checked Bend and host SHA result');

const faultControlResponse = sendSuccess(faultControlSend, 'injected SHA syscall successful control');
const faultControlPreDispatchLog = assertPreDispatchObservation(faultControlResponse.logs, faultControlInput, 'successful shim control');
const faultControlState = accountSnapshot(faultControlAccount, addresses.faultProgram,
  'injected SHA syscall successful control');
const faultControlFreshness = assertFreshOutput(faultControlState.data, faultControlInput,
  'injected SHA syscall successful control');
const faultControlOutput = storedOutput(faultControlState.data, 'injected SHA syscall successful control');
assert.deepEqual(faultControlOutput, hashedResultBytes(faultControlDigest),
  'zero-status test shim control stores the shim digest as a Hashed result');
assert.notDeepEqual(faultControlState.data, Array<number>(64).fill(0),
  'successful control proves the test adapter scratch write persists without a trap');
const faultBeforeState = accountSnapshot(faultBefore, addresses.faultProgram,
  'fault profile immediately before injected syscall failure');
assert.deepEqual(faultBeforeState, faultControlState,
  'fault snapshot begins from the successful control transaction state');
const faultResponse = valueAt(faultSend, 'fault-injected syscall status');
assert.equal(faultResponse.ok, false, 'nonzero injected sol_sha256 status traps the SBF invocation');
assert.equal(faultResponse.error, 'InstructionError(0, ProgramFailedToComplete)',
  'trap has the exact LiteSVM failure outcome');
assert(Number.isSafeInteger(faultResponse.units) && faultResponse.units > 0, 'fault-path transaction CU measurement');
assert(Array.isArray(faultResponse.logs), 'fault-path log array');
assert(faultResponse.logs.some((line: string) => line.endsWith('failed: SBF program panicked')),
  'generated __builtin_trap is observed in actual SBF logs');
const faultPreDispatchLog = assertPreDispatchObservation(faultResponse.logs, mutationTarget.input, 'injected syscall failure');
const faultAfterState = accountSnapshot(faultAfter, addresses.faultProgram,
  'fault profile after injected syscall failure');
assert.deepEqual(faultAfterState, faultBeforeState,
  'trap rolls back scratch data; owner, lamports and executable flag remain unchanged');

const noTrapResponse = sendSuccess(noTrapSend, 'failure-path trap-removal mutation');
const noTrapData = accountSnapshot(noTrapAccount, addresses.noTrapProgram, 'failure-path trap-removal mutation').data;
const noTrapFreshness = assertFreshOutput(noTrapData, mutationTarget.input, 'failure-path trap-removal mutation');
const noTrapOutput = storedOutput(noTrapData, 'failure-path trap-removal mutation');
const noTrapDecoded = codec.decode(resultType, Uint8Array.from(noTrapOutput));
assert.equal(resultDigest(noTrapDecoded), undefined,
  'removing the generated trap leaks Rejected on nonzero syscall status');
assert.deepEqual(noTrapOutput, resultBytes(make(resultType, 'Rejected', {})),
  'trap-removal mutation returns the exact failure-path Rejected wire result');
assert.equal(mutationTarget.disposition, 'hashed', 'trap-removal control input is valid under checked Bend');
assert(noTrapResponse.units > 0);

const frameSummaries = Object.fromEntries([...builtPrograms].map(([name, program]) => [name, {
  maxFrameBytes: Math.max(...program.stack.map(frame => frame.bytes)),
  frameCount: program.stack.length,
  frameLimit: 4096,
}]));
for (const summary of Object.values(frameSummaries) as {maxFrameBytes: number; frameCount: number; frameLimit: number}[]) {
  assert(summary.frameCount > 0 && summary.maxFrameBytes <= summary.frameLimit,
    'all compiled program, runtime helper, and injected-shim frames stay within 4096 bytes');
}

assertSourceSnapshot(snapshot.files, snapshot.hashes);
assert.equal(requireSuccess(invoke('git', ['-C', '.deps/bend', 'status', '--porcelain']),
  'Bend post-run cleanliness check'), '', 'pinned Bend dependency stayed clean during the run');
assert.equal(hashFile(runnerPath), runnerHash, 'read-only LiteSVM runner hash unchanged after execution');
assert.deepEqual(toolInfo(path.join(sbfTools, 'clang')), clang, 'pinned Clang unchanged through the run');
assert.deepEqual(toolInfo(path.join(sbfTools, 'ld.lld')), linker, 'pinned LLD unchanged through the run');
assert.deepEqual(toolInfo(path.join(sbfTools, 'llvm-readelf')), readelf, 'pinned readelf unchanged through the run');

const report = {
  schemaVersion: 1,
  passed: true,
  completedAtUtc: new Date().toISOString(),
  scope: 'fresh checked Bend source/schema; checked-source reference ELF and explicit test-time generateSha256Short replacement ELF; pinned Anza SBF; actual LiteSVM execution',
  productionStatus: 'production SHA specialization remains disabled; source qualification is incomplete',
  generatedInputs: {
    checkedProof: 'tests/sha256-reference/PROOF.bend',
    explicitGeneratorCall: 'generateSha256Short(emitted.schema, identity)',
    emittedSchemaSha256: hashFile(path.join(mainRoot, `${programStem}.schema.json`)),
    emittedLayoutSlotPaths: generated.slotPaths,
    generatorDefinitionSha256: createHash('sha256').update(generated.definition).digest('hex'),
  },
  sourceInputs: {executingScript: {path: executingScript, sha256: snapshot.hashes[executingScript]}, hashes: snapshot.hashes, bend: snapshot.bend, prerequisiteManifest: snapshot.manifest},
  toolchain: {
    bun: process.versions.bun,
    target: 'SBPFv0',
    clang, linker, readelf,
    compileFlags,
    linkerFlags: ['-z', 'notext', '-shared', '--Bdynamic', 'runtime/sbf.ld', '--entry', 'entrypoint', '-z', 'max-page-size=4096', '--gc-sections'],
    litesvm: '0.7.1',
    runner: {
      path: runnerPath, sha256: runnerHash, cargoRebuild: false,
      requestCount: keyRequests.length + requests.length, requestLimitPerProcess: 384,
      keySetupTimeoutMs: 30_000, executionTimeoutMs: 180_000,
    },
  },
  testOnlyImportProfiles: {
    checkedSourceReference: referenceProfile,
    realSyscall: realProfile,
    instrumentedFault: faultProfile,
    trapRemovalMutation: faultNoTrapProfile,
  },
  finalPrograms: Object.fromEntries([...builtPrograms].map(([name, program]) => [name, {
    elfSha256: hashFile(program.elf), elfBytes: fs.statSync(program.elf).size,
    imports: program.imports,
    readelfOutput: program.readelfOutput,
    stack: frameSummaries[name],
  }])),
  execution: {
    actualSyscallCases: executionObservations,
    wireAdapterRefusals: wireRefusalObservations,
    outputFreshness: {
      method: 'each successful non-noop dispatch poisons the scratch output region before dispatch and stores an FNV-1a marker derived from the instruction bytes; every successful result checks its own marker and exact wire output',
      malformedInputs: wireRefusalObservations.map(row => row.name),
      rejectedResultsWerePoisonedBeforeDispatch: true,
    },
    counts: {
      actualSyscallCases: executionObservations.length,
      checkedSourceSbfReferenceCases: executionObservations.length,
      hashed: executionObservations.filter(row => row.disposition === 'hashed').length,
      rejected: executionObservations.filter(row => row.disposition === 'rejected').length,
      malformedWireAdapterRefusals: wireRefusalObservations.length,
      shortLengths: Array.from({length: 56}, (_, i) => i),
      maxTransactionComputeUnits: Math.max(...executionObservations.map(row => row.computeUnits)),
      maxCheckedReferenceTransactionComputeUnits: Math.max(...executionObservations.map(row => row.checkedReferenceComputeUnits)),
    },
    semanticMutation: {
      changed: 'first compact byte = active byte + 1 before sol_sha256',
      compiledAndLoaded: true,
      transactionSucceeded: true,
      expectedDigest: mutationTarget.hostDigest,
      observedDigest: semanticDigest.toString('hex'),
      detectedWrongDigest: true,
      outputFreshnessMarker: `0x${semanticFreshness.toString(16).padStart(8, '0')}`,
      computeUnits: semanticResult.units,
    },
    successfulInjectedShimControl: {
      inputBytes: faultControlInput.length,
      transactionSucceeded: true,
      outputDisposition: 'hashed',
      outputMatchesShimDigest: true,
      scratchWritePersisted: true,
      preDispatchLog: faultControlPreDispatchLog,
      outputFreshnessMarker: `0x${faultControlFreshness.toString(16).padStart(8, '0')}`,
      computeUnits: faultControlResponse.units,
    },
    injectedFailure: {
      nonzeroStatus: '0x123456789abcdef0',
      transactionError: faultResponse.error,
      logs: faultResponse.logs,
      computeUnits: faultResponse.units,
      scratchDataRestored: true,
      restoredFields: ['data'],
      unchangedFields: ['owner', 'lamports', 'executable'],
      preDispatchLog: faultPreDispatchLog,
      rollbackComparedWithSuccessfulControl: true,
      preTrapScratchWrite: 'volatile account readback of marker, poison length and sample byte logged before dispatch',
      returnedHashedOrRejected: false,
    },
    trapRemovalMutation: {
      changed: '__builtin_trap replaced with return Rejected()',
      transactionSucceeded: true,
      outputDisposition: 'rejected',
      exactRejectedOutput: true,
      detected: true,
      computeUnits: noTrapResponse.units,
    },
    computeUnitMeaning: 'LiteSVM transaction-level harness measurements include entrypoint parsing, generated dispatch, scratch poisoning/readback logging, account result storage and return-data syscall; they are not isolated handler costs or universal bounds.',
  },
  artifacts: Object.fromEntries(Object.keys(postExecutionArtifacts).sort().map(file => [
    path.relative(root, file), {sha256: postExecutionArtifacts[file], bytes: fs.statSync(file).size},
  ])),
  limits: [
    'Finite vectors and mutations establish tested-case conformance only.',
    'The fault ELF links a local test shim and is not the real syscall ELF.',
    'LiteSVM observations establish rollback only for these test-shell account writes and transactions; they are not a theorem about arbitrary runtime or program writes.',
    'This test does not qualify the checked source for production specialization or prove compiler/LLVM/runtime correctness.',
    'No deployment or full regression suite was run by this test.',
  ],
};
const reportPath = path.join(work, 'evidence.json');
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
console.log(`SHA-256 short actual-SBF execution passed: ${path.relative(root, reportPath)}`);
console.log(`cases=${executionObservations.length} hashed=${report.execution.counts.hashed} rejected=${report.execution.counts.rejected} maxFrame=${Math.max(...Object.values(frameSummaries).map((item: any) => item.maxFrameBytes))} bytes; transactionCUmax=${report.execution.counts.maxTransactionComputeUnits}; checkedReferenceCUmax=${report.execution.counts.maxCheckedReferenceTransactionComputeUnits}; realELF=${hashFile(builtPrograms.get('real-syscall')!.elf)}`);
}

void main().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const marker = {
    schemaVersion: 1,
    passed: false,
    failedAtUtc: new Date().toISOString(),
    runId: workRunId,
    executingScript,
    testSourceSha256: fs.existsSync(executingScript)
      ? createHash('sha256').update(fs.readFileSync(executingScript)).digest('hex') : null,
    error: message,
    stack: error instanceof Error ? error.stack ?? null : null,
  };
  try {
    fs.writeFileSync(path.join(work, 'failure.json'), `${JSON.stringify(marker, null, 2)}\n`, {flag: 'wx'});
  } catch (markerError) {
    console.error(`Could not write SHA short failure marker: ${String(markerError)}`);
  }
  console.error(error);
  process.exitCode = 1;
});
