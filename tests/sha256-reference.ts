import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import * as B from '../.deps/bend/bend2/bend.ts';
import {Backend, checkedBook} from '../compiler/backend.ts';
import {writeArtifacts} from '../compiler/artifacts.ts';
import {wireCodec, type WireValue} from '../sdk/wire.ts';
import {compileSbf} from '../scripts/build.ts';

type Vector = {name: string; hex: string; sha256: string};
type FailureKind = 'spawn-failure' | 'compiler-failure' | 'vector-disagreement';
type ProcessResult = ReturnType<typeof spawnSync>;
type ToolInfo = {path: string; invokedAs: string; version: string; sha256: string};

const reportPath = path.resolve('build/sha256-reference/report.json');
fs.mkdirSync(path.dirname(reportPath), {recursive: true});
if (fs.existsSync(reportPath)) {
  const quarantine = `${reportPath}.${randomUUID()}.quarantine`;
  fs.renameSync(reportPath, quarantine);
  const bytes = fs.readFileSync(quarantine);
  const archive = path.resolve('build/sha256-reference/reports');
  fs.mkdirSync(archive, {recursive: true});
  const saved = path.join(archive, `${createHash('sha256').update(bytes).digest('hex')}.json`);
  if (!fs.existsSync(saved)) fs.writeFileSync(saved, bytes, {flag: 'wx'});
  assert.deepEqual(fs.readFileSync(saved), bytes, 'prior SHA reference receipt archive conflict');
  fs.rmSync(quarantine);
}
const work = path.resolve('build/sha256-reference/runs', randomUUID());
const stem = path.join(work, 'sha256-reference');
fs.mkdirSync(work, {recursive: true});

function fail(message: string): never {
  throw new Error(`SHA-256 checked reference: ${message}`);
}

function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function invoke(file: string, args: string[], options: Parameters<typeof spawnSync>[2] = {}): ProcessResult {
  return spawnSync(file, args, {encoding: 'utf8', ...options});
}

function processFailure(result: ProcessResult): FailureKind | undefined {
  if (result.error) return 'spawn-failure';
  if (result.status !== 0) return 'compiler-failure';
  return undefined;
}

function requireSuccess(result: ProcessResult, label: string): string {
  const kind = processFailure(result);
  if (kind) fail(`${label} ${kind}: status=${result.status}; ${result.error ?? result.stderr ?? ''}`);
  return result.stdout?.toString().trim() ?? '';
}

function checkInputs(): {files: Record<string, string>; commit: string; dirty: string} {
  assert.equal(process.versions.bun, '1.4.2', 'pinned Bun runtime');
  const commit = requireSuccess(invoke('git', ['-C', '.deps/bend', 'rev-parse', 'HEAD']), 'Bend pin check');
  const dirty = requireSuccess(invoke('git', ['-C', '.deps/bend', 'status', '--porcelain']), 'Bend cleanliness check');
  assert.equal(commit, '7561656155a4285c1e4ccfcb3505ab59524de973', 'pinned Bend source commit');
  assert.equal(dirty, '', 'pinned Bend checkout is clean');

  const checked = [
    ...fs.readdirSync('compiler').filter(f => f.endsWith('.ts')).map(f => `compiler/${f}`),
    ...fs.readdirSync('runtime').filter(f => /\.(?:h|c|ld)$/.test(f)).map(f => `runtime/${f}`),
    'scripts/build.ts', 'sdk/buffer.bend', 'sdk/iteration.bend', 'sdk/wire.ts',
    'tests/sha256-reference-sbf.rs', 'tests/sha256-reference/Cargo.toml',
    'tests/sha256-reference/Cargo.lock',
    '.deps/bend/bend2/base.bend', 'package.json', 'package-lock.json',
  ];
  const actual = Object.fromEntries(checked.sort().map(file => [file, hashFile(file)]));
  return {files: actual, commit, dirty};
}

function toolVersion(command: string): {path: string; invokedAs: string; version: string; sha256: string} {
  const resolved = command.includes(path.sep)
    ? path.resolve(command)
    : requireSuccess(invoke('which', [command]), `resolve ${command}`);
  const real = fs.realpathSync(resolved);
  const version = requireSuccess(invoke(resolved, ['--version']), `${command} version`);
  return {path: real, invokedAs: resolved, version: version.split('\n')[0], sha256: hashFile(real)};
}

function selectedRustTool(command: string, args: string[], label: string): ToolInfo {
  const resolved = path.resolve(command);
  const real = fs.realpathSync(resolved);
  const version = requireSuccess(invoke(real, args, {
    env: {...process.env, RUSTUP_TOOLCHAIN: '1.92.0'},
  }), `${label} version`);
  return {path: real, invokedAs: resolved, version: version.split('\n')[0], sha256: hashFile(real)};
}

const vectorFile = 'tests/sha256-reference/vectors.json';
const vectors = JSON.parse(fs.readFileSync(vectorFile, 'utf8')) as Vector[];
assert.deepEqual(vectors.map(v => v.name), [
  'empty', 'abc', 'padding-55', 'random-short-1', 'random-short-17',
  'random-short-31', 'random-short-54',
], 'expected fixed vector set');

const {files: compilerInputs, commit: bendCommit, dirty: bendDirty} = checkInputs();
const sourceFiles = [...new Set([
  'sdk/sha256-reference.bend', 'tests/sha256-reference.ts',
  'docs/sha256-reference.md',
  'tests/sha256-reference/LAWS.bend', 'tests/sha256-reference/PROOF.bend',
  vectorFile, ...Object.keys(compilerInputs),
])].sort();
const inputHashes = Object.fromEntries(sourceFiles.map(file => [file, hashFile(file)]));
// Require the actual compilation tools before expensive source evaluation.
const cc = process.env.CC ?? 'clang';
const nativeTool = toolVersion(cc);
const sbfTools = process.env.SBF_TOOLS ?? path.join(os.homedir(), '.cache/solana/v1.53/platform-tools/llvm/bin');
const sbfToolchain = Object.fromEntries(['clang', 'ld.lld', 'llvm-readelf'].map(name => [name, toolVersion(path.join(sbfTools, name))]));
const rustup = requireSuccess(invoke('which', ['rustup']), 'resolve rustup');
const cargoPath = requireSuccess(invoke(rustup, ['which', 'cargo', '--toolchain', '1.92.0']), 'resolve Rust 1.92 Cargo');
const rustcPath = requireSuccess(invoke(rustup, ['which', 'rustc', '--toolchain', '1.92.0']), 'resolve Rust 1.92 rustc');
const cargoTool = selectedRustTool(cargoPath, ['--version'], 'Rust 1.92 Cargo');
const rustcTool = selectedRustTool(rustcPath, ['--version'], 'Rust 1.92 rustc');
assert.match(cargoTool.version, /^cargo 1\.92\.0\b/, 'pinned Cargo 1.92.0');
assert.match(rustcTool.version, /^rustc 1\.92\.0\b/, 'pinned rustc 1.92.0');

const book = await checkedBook('tests/sha256-reference/PROOF.bend');
const emitted = new Backend(book).emit(['hash_short']);
assert.deepEqual(emitted.schema.exports.map(e => e.name), ['hash_short']);
assert.doesNotMatch(emitted.c, /sol_sha256|bend_sha256_hashv/, 'source lowering has no SHA runtime binding');
writeArtifacts(stem, emitted);

const codec = wireCodec(emitted.schema);
const typeMap = new Map(emitted.schema.types.map(t => [t.name, t]));
const exportSchema = emitted.schema.exports.find(e => e.name === 'hash_short')!;
const resultType = exportSchema.result;

function typeSchema(type: string) {
  const schema = typeMap.get(type);
  assert(schema, `missing emitted type ${type}`);
  return schema;
}

function variantNamed(type: string, suffix: string) {
  const schema = typeSchema(type);
  assert.equal(schema.kind, 'adt');
  const variant = schema.variants.find(v => v.name === suffix || v.name.endsWith(`.${suffix}`));
  assert(variant, `missing ${suffix} constructor in ${type}`);
  return variant;
}

function make(type: string, name: string, fields: Record<string, WireValue>): WireValue {
  return {constructor: variantNamed(type, name).name, fields};
}

function pairTree(type: string, leaves: number[]): WireValue {
  if (type === 'U32') {
    assert.equal(leaves.length, 1);
    return leaves[0];
  }
  const pair = typeSchema(type);
  assert.equal(pair.kind, 'adt');
  const variant = pair.variants[0];
  assert.equal(variant.fields.length, 2, `pair node shape ${type}`);
  assert.equal(variant.fields[0].name, 'left');
  assert.equal(variant.fields[1].name, 'right');
  assert.equal(leaves.length % 2, 0);
  const middle = leaves.length / 2;
  return {
    constructor: variant.name,
    fields: {
      left: pairTree(variant.fields[0].type, leaves.slice(0, middle)),
      right: pairTree(variant.fields[1].type, leaves.slice(middle)),
    },
  };
}

function makeMessage(length: number, active: Iterable<number>, inactive = 0xdeadbeef): WireValue {
  const message = typeSchema(exportSchema.args[0]);
  assert.equal(message.kind, 'adt');
  const messageVariant = variantNamed(exportSchema.args[0], 'Message');
  const byteField = messageVariant.fields.find(f => f.name === 'bytes')!;
  const bytesVariant = variantNamed(byteField.type, 'Bytes64');
  const wordField = bytesVariant.fields.find(f => f.name === 'words')!;
  const slots = Array<number>(64).fill(inactive);
  Array.from(active).forEach((byte, i) => { slots[i] = byte; });
  const bytesValue = make(byteField.type, 'Bytes64', {
    words: pairTree(wordField.type, slots),
  });
  return make(exportSchema.args[0], 'Message', {length, bytes: bytesValue});
}

function toTerm(type: string, value: WireValue): B.HTerm {
  const schema = typeSchema(type);
  if (type === 'Nat') {
    let term: B.HTerm = B.Ctr('Zero', []);
    for (let i = 0; i < (value as number); ++i) term = B.Ctr('Succ', [term]);
    return term;
  }
  if (schema.kind === 'u32') return B.term_higher(B.u32_to_term(value as number));
  if (schema.kind === 'bool') return B.Ctr(value ? 'True' : 'False', []);
  assert.equal(typeof value, 'object');
  const v = value as {constructor: string; fields: Record<string, WireValue>};
  const variant = schema.variants.find(item => item.name === v.constructor)!;
  assert(variant, `missing input constructor ${v.constructor} for ${type}`);
  return B.Ctr(variant.sourceName ?? variant.name,
    variant.fields.map(f => toTerm(f.type, v.fields[f.name])));
}

function fromTerm(type: string, term: B.HTerm): WireValue {
  const schema = typeSchema(type);
  if (type === 'Nat') {
    let n = 0;
    while (term.$ === 'Ctr' && term.k === 'Succ') { ++n; term = term.x[0]; }
    assert(term.$ === 'Ctr' && term.k === 'Zero', 'expected Nat result');
    return n;
  }
  if (schema.kind === 'u32') {
    const n = B.u32_from_term(term);
    assert.notEqual(n, null, `expected U32 result, got ${JSON.stringify(term)}`);
    return n!;
  }
  assert.equal(term.$, 'Ctr');
  if (term.$ !== 'Ctr') fail(`expected constructor result for ${type}`);
  if (schema.kind === 'bool') return term.k === 'True';
  const variant = schema.variants.find(v => (v.sourceName ?? v.name) === term.k);
  assert(variant, `unexpected result constructor ${term.k} for ${type}`);
  return {
    constructor: variant.name,
    fields: Object.fromEntries(variant.fields.map((field, i) =>
      [field.name, fromTerm(field.type, term.x[i])])),
  };
}

function evaluate(sourceBook: B.Book, value: WireValue): WireValue {
  let call: B.HTerm = B.Ref('hash_short');
  call = B.App(call, toTerm(exportSchema.args[0], value));
  return fromTerm(resultType, B.term_snf(sourceBook, call));
}

function digestFromResult(value: WireValue): Buffer | undefined {
  assert.equal(typeof value, 'object');
  const result = value as {constructor: string; fields: Record<string, WireValue>};
  if (result.constructor.endsWith('.Rejected')) return undefined;
  assert(result.constructor.endsWith('.Hashed'), `unexpected hash result ${result.constructor}`);
  const digest = result.fields.digest as {constructor: string; fields: Record<string, WireValue>};
  const out = Buffer.alloc(32);
  for (let i = 0; i < 8; ++i) out.writeUInt32BE(digest.fields[`h${i}`] as number, i * 4);
  return out;
}

function expectedResult(digest: Buffer | undefined): WireValue {
  if (!digest) return make(resultType, 'Rejected', {});
  const digestType = variantNamed(resultType, 'Hashed').fields[0].type;
  const fields: Record<string, WireValue> = {};
  for (let i = 0; i < 8; ++i) fields[`h${i}`] = digest.readUInt32BE(i * 4);
  return make(resultType, 'Hashed', {digest: make(digestType, 'Digest256', fields)});
}

function encodeResult(value: WireValue): number[] {
  return [...codec.encode(resultType, value)];
}

const cases: {name: string; value: WireValue; expected: WireValue; input: number[]; inputBytes: number}[] = [];
for (const vector of vectors) {
  const message = Buffer.from(vector.hex, 'hex');
  const nodeDigest = createHash('sha256').update(message).digest();
  assert.equal(nodeDigest.toString('hex'), vector.sha256, `fixed Node crypto vector ${vector.name}`);
  const value = makeMessage(message.length, message);
  const actual = evaluate(book, value);
  const actualDigest = digestFromResult(actual);
  if (!actualDigest) fail(`${vector.name} unexpectedly rejected by checked Bend source`);
  if (actualDigest.toString('hex') !== vector.sha256) {
    fail(`Bend oracle vector disagreement for ${vector.name}: expected ${vector.sha256}, got ${actualDigest.toString('hex')}`);
  }
  const expected = expectedResult(nodeDigest);
  assert.deepEqual(encodeResult(actual), encodeResult(expected), `Bend source result wire ${vector.name}`);
  cases.push({name: vector.name, value, expected, input: [...codec.call('hash_short', [value])], inputBytes: message.length});
  console.log(`checked Bend SHA oracle: ${vector.name} (${message.length} bytes)`);
}

// Different garbage in inactive slots must not change a valid short message.
const ignoredMessage = Buffer.from('inactive-storage-is-ignored');
for (const [label, poison] of [['all-ones', 0xffffffff], ['mixed', 0x7f00ff80]] as const) {
  const value = makeMessage(ignoredMessage.length, [...ignoredMessage], poison);
  const actual = evaluate(book, value);
  assert.equal(digestFromResult(actual)?.toString('hex'),
    createHash('sha256').update(ignoredMessage).digest('hex'), `inactive slot poison ${label}`);
  cases.push({name: `inactive-${label}`, value,
    expected: expectedResult(createHash('sha256').update(ignoredMessage).digest()),
    input: [...codec.call('hash_short', [value])], inputBytes: ignoredMessage.length});
}

const invalid: {name: string; value: WireValue}[] = [
  {name: 'length-56', value: makeMessage(56, Array<number>(56).fill(0), 0xffffffff)},
  {name: 'length-u32-max', value: makeMessage(0xffffffff, [], 0xffffffff)},
  {name: 'active-byte-256-at-start', value: makeMessage(1, [256])},
  {name: 'active-byte-256-at-end', value: makeMessage(55,
    Array.from({length: 55}, (_, i) => i === 54 ? 256 : i))},
];
for (const item of invalid) {
  const actual = evaluate(book, item.value);
  assert.equal(digestFromResult(actual), undefined, `checked Bend rejection ${item.name}`);
  cases.push({name: item.name, value: item.value, expected: expectedResult(undefined),
    input: [...codec.call('hash_short', [item.value])],
    inputBytes: item.name === 'length-56' ? 56 :
      item.name === 'active-byte-256-at-start' ? 1 :
      item.name === 'active-byte-256-at-end' ? 55 : 0});
}

const harness = `#include <stdio.h>
#include "sha256-reference.dispatch.h"
int main(void) {
  unsigned n, byte;
  unsigned char input[1024], output[1024];
  while (scanf("%u", &n) == 1) {
    if (n > sizeof(input)) return 2;
    for (unsigned i = 0; i < n; ++i) {
      if (scanf("%u", &byte) != 1 || byte > 255) return 3;
      input[i] = (unsigned char)byte;
    }
    unsigned long long written = 0;
    if (!bend_wire_dispatch(input, n, output, sizeof(output), &written)) {
      puts("DISPATCH_ERROR");
      continue;
    }
    printf("OK %llu", written);
    for (unsigned long long i = 0; i < written; ++i) printf(" %u", output[i]);
    puts("");
  }
  return ferror(stdin) ? 4 : 0;
}
`;
const nativeHarness = `${work}/native.c`;
const nativeBinary = `${work}/native`;
fs.writeFileSync(nativeHarness, harness);
const nativeCompile = invoke(cc, ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
  '-fno-omit-frame-pointer', '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
  '-Ibuild', nativeHarness, '-o', nativeBinary]);
requireSuccess(nativeCompile, `native C compile (${nativeTool.version})`);
const nativeInput = cases.map(testCase => `${testCase.input.length} ${testCase.input.join(' ')}`).join('\n') + '\n';
const nativeRun = invoke(nativeBinary, [], {input: nativeInput, timeout: 180_000,
  env: {...process.env, ASAN_OPTIONS: 'halt_on_error=1', UBSAN_OPTIONS: 'halt_on_error=1:print_stacktrace=1'}});
requireSuccess(nativeRun, 'native C execution');
const nativeLines = (nativeRun.stdout?.toString().trimEnd() ?? '').split('\n');
assert.equal(nativeLines.length, cases.length, 'native output row count');
for (const [i, testCase] of cases.entries()) {
  const parts = nativeLines[i].split(/\s+/);
  assert.equal(parts[0], 'OK', `native dispatcher ${testCase.name}`);
  const written = Number(parts[1]);
  const output = parts.slice(2).map(Number);
  assert.equal(output.length, written, `native output length ${testCase.name}`);
  assert.deepEqual(output, encodeResult(testCase.expected),
    `emitted native C disagrees with the independently checked expected digest for ${testCase.name}`);
  assert.deepEqual(codec.decode(resultType, Uint8Array.from(output)),
    codec.decode(resultType, Uint8Array.from(encodeResult(testCase.expected))),
    `native decoded result ${testCase.name}`);
}

// A source mutation must be reported as a digest/vector mismatch, while a
// failed process launch has a separate classification and cannot masquerade
// as a semantic SHA disagreement.
const mutationRoot = `${work}/mutation`;
fs.mkdirSync(`${mutationRoot}/sdk`, {recursive: true});
fs.mkdirSync(`${mutationRoot}/tests/sha256-reference`, {recursive: true});
for (const file of ['buffer.bend', 'iteration.bend'])
  fs.copyFileSync(`sdk/${file}`, `${mutationRoot}/sdk/${file}`);
const library = fs.readFileSync('sdk/sha256-reference.bend', 'utf8');
assert.equal(library.split('1116352408').length - 1, 1, 'single first-round-constant mutation site');
fs.writeFileSync(`${mutationRoot}/sdk/sha256-reference.bend`,
  library.replace('1116352408', '1116352409'));
for (const file of ['LAWS.bend', 'PROOF.bend'])
  fs.copyFileSync(`tests/sha256-reference/${file}`, `${mutationRoot}/tests/sha256-reference/${file}`);
const mutatedBook = await checkedBook(`${mutationRoot}/tests/sha256-reference/PROOF.bend`).catch(error =>
  fail(`mutation compiler-failure (not a semantic kill): ${String(error)}`));
const mutationValue = makeMessage(0, new Uint8Array());
const mutatedDigest = digestFromResult(evaluate(mutatedBook, mutationValue));
assert(mutatedDigest, 'mutated source still returns a digest');
const emptyExpected = vectors.find(v => v.name === 'empty')!.sha256;
const mutationKind: FailureKind | 'agreement' =
  mutatedDigest.toString('hex') === emptyExpected ? 'agreement' : 'vector-disagreement';
assert.equal(mutationKind, 'vector-disagreement', 'wrong SHA constant is caught as vector disagreement');
const missingCommand = invoke(`${work}/missing-compiler`, ['--version']);
assert.equal(processFailure(missingCommand), 'spawn-failure', 'spawn failure remains distinct from vector mismatch');

  const sbfHarness = `${work}/entry.c`;
  fs.writeFileSync(sbfHarness, `#include "solana_min.h"
#include "sha256-reference.dispatch.h"
__attribute__((visibility("default")))
u64 entrypoint(const u8 *input) {
  if (read_le(input, 8) != 0) return 1;
  u64 instruction_length = read_le(input + 8, 8);
  if (instruction_length > 1024) return 2;
  /* Keep the return buffer in this frame; a static output buffer is rejected
   * by LiteSVM's SBF loader as invalid account data. */
  u8 output[1024];
  u64 written = 0;
  if (!bend_wire_dispatch(input + 16, instruction_length, output, sizeof(output), &written)) return 3;
  sol_set_return_data(output, written);
  return 0;
}
`);
const adapterFailures = [
  {name: 'account-count-nonzero', input: [], accountCount: 1, expectedError: 'InstructionError(1, Custom(1))'},
  {name: 'instruction-over-1024', input: Array<number>(1025).fill(0), expectedError: 'InstructionError(1, Custom(2))'},
  {name: 'malformed-wire-empty', input: [], expectedError: 'InstructionError(1, Custom(3))'},
];
const executionCasesPath = path.join(work, 'execution-cases.json');
fs.writeFileSync(executionCasesPath, `${JSON.stringify({
  schemaVersion: 1,
  cases: cases.map(testCase => ({
    name: testCase.name,
    instructionData: testCase.input,
    expectedReturnData: encodeResult(testCase.expected),
    expectedDisposition: digestFromResult(testCase.expected) ? 'hashed' : 'rejected',
  })),
  adapterFailures,
}, null, 2)}\n`, {flag: 'wx'});
// The local quoted header fixes include resolution even if build/ contains a
// shadow header. Bind the exact copied bytes in the artifact receipt.
const localRuntimeHeader = path.join(work, 'solana_min.h');
fs.copyFileSync('runtime/solana_min.h', localRuntimeHeader);
assert.equal(hashFile(localRuntimeHeader), inputHashes['runtime/solana_min.h']);
const sbfStem = `${work}/sha256-reference-sbf`;
compileSbf(sbfHarness, sbfStem);
const stack = JSON.parse(fs.readFileSync(`${sbfStem}.stack.json`, 'utf8'));
const entryFrame = stack.functions.find((frame: {location: string}) => /:entrypoint$/.test(frame.location));
assert(entryFrame, 'compiled SBF stack report includes the actual entrypoint frame');
assert(entryFrame.bytes <= stack.frameLimit, 'compiled SBF entrypoint frame is within its limit');
const sbf = {status: 'compiled', frameLimit: stack.frameLimit, entryFrameBytes: entryFrame.bytes,
  maxFrameBytes: stack.maxFrameBytes, tools: sbfToolchain};
assert.equal(hashFile(localRuntimeHeader), inputHashes['runtime/solana_min.h']);

const artifactFiles = [
  `${stem}.h`, `${stem}.wire.h`, `${stem}.dispatch.h`, `${stem}.schema.json`,
  `${stem}.resources.json`, nativeHarness, nativeBinary,
];
artifactFiles.push(localRuntimeHeader, sbfHarness, executionCasesPath,
  `${sbfStem}.so`, `${sbfStem}.o`, `${sbfStem}.memory.o`, `${sbfStem}.stack.json`,
  `${sbfStem}.su`, `${sbfStem}.memory.su`);
const artifactHashesBefore = Object.fromEntries(artifactFiles.map(file => [file, hashFile(file)]));

const cargoTarget = path.resolve('target/sha256-reference-sbf-gate');
const cargoArgs = [
  'test', '--locked', '--offline', '--manifest-path', 'tests/sha256-reference/Cargo.toml',
  '--target-dir', cargoTarget, '--test', 'sha256_reference_sbf_gate', '--', '--nocapture',
];
const cargoRun = invoke(cargoTool.path, cargoArgs, {
  timeout: 900_000,
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    RUSTUP_TOOLCHAIN: '1.92.0',
    RUSTC: rustcTool.path,
    CARGO_TARGET_DIR: cargoTarget,
    SHA256_REFERENCE_RUN_DIR: work,
  },
});
const cargoStdout = cargoRun.stdout?.toString() ?? '';
const cargoStderr = cargoRun.stderr?.toString() ?? '';
const cargoLog = path.join(work, 'cargo.log');
const cargoStderrLog = path.join(work, 'cargo.stderr.log');
fs.writeFileSync(cargoLog, cargoStdout);
fs.writeFileSync(cargoStderrLog, cargoStderr);
if (cargoRun.error) fail(`LiteSVM Cargo child spawn-failure: ${cargoRun.error.message}; evidence=${cargoLog}`);
if (cargoRun.status !== 0) {
  fail(`LiteSVM Cargo child-failure: status=${cargoRun.status}; evidence=${cargoLog}; ${cargoStderr.trim()}`);
}

const executionPath = path.join(work, 'execution.json');
assert(fs.existsSync(executionPath), 'LiteSVM probe must write a fresh execution report');
const execution = JSON.parse(fs.readFileSync(executionPath, 'utf8'));
assert.equal(execution.passed, true, 'LiteSVM probe reports a completed pass');
assert.equal(execution.observations.length, cases.length, 'LiteSVM ran all 13 checked-Bend cases');
assert.deepEqual(execution.observations.map((item: {name: string}) => item.name), cases.map(item => item.name));
assert.equal(execution.adapterFailures.length, adapterFailures.length, 'LiteSVM ran adapter rejection probes');
assert.deepEqual(execution.adapterFailures.map((item: {name: string}) => item.name), adapterFailures.map(item => item.name));
for (const [index, observed] of execution.observations.entries()) {
  const expected = encodeResult(cases[index].expected);
  assert.equal(observed.status, 'success', `SBF success status ${cases[index].name}`);
  assert.equal(observed.returnDataHex, Buffer.from(expected).toString('hex'), `exact SBF return bytes ${cases[index].name}`);
  assert.equal(observed.programId, execution.programId, `SBF return program ID ${cases[index].name}`);
  assert.equal(observed.disposition, digestFromResult(cases[index].expected) ? 'hashed' : 'rejected');
}
for (const [index, observed] of execution.adapterFailures.entries()) {
  assert.equal(observed.status, 'error', `adapter error status ${adapterFailures[index].name}`);
  assert.equal(observed.error, adapterFailures[index].expectedError, `adapter error ${adapterFailures[index].name}`);
}
const executableMatch = `${cargoStdout}\n${cargoStderr}`.match(/^\s*Running .+ \((.+)\)$/m);
assert(executableMatch, 'Cargo output identifies the actual test executable');
const testExecutable = path.resolve(executableMatch[1]);
assert(fs.existsSync(testExecutable), 'Cargo test executable exists after the successful run');
const artifactHashesAfter = Object.fromEntries(artifactFiles.map(file => [file, hashFile(file)]));
assert.deepEqual(artifactHashesAfter, artifactHashesBefore, 'SBF and generated probe artifacts did not drift during LiteSVM execution');
const sourceInputsAfter = Object.fromEntries(sourceFiles.map(file => [file, hashFile(file)]));
assert.deepEqual(sourceInputsAfter, inputHashes, 'source inputs did not drift during LiteSVM execution');
assert.deepEqual(checkInputs().files, compilerInputs, 'compiler inputs changed');
assert.deepEqual(toolVersion(cc), nativeTool, 'native compiler changed');
for (const [name, before] of Object.entries(sbfToolchain))
  assert.deepEqual(toolVersion(path.join(sbfTools, name)), before, `SBF tool changed: ${name}`);
assert.deepEqual(selectedRustTool(cargoPath, ['--version'], 'Rust 1.92 Cargo'), cargoTool, 'selected Cargo binary changed');
assert.deepEqual(selectedRustTool(rustcPath, ['--version'], 'Rust 1.92 rustc'), rustcTool, 'selected rustc binary changed');

const runObservations = execution.observations as {computeUnits: number}[];
const maxMeasuredCu = Math.max(...runObservations.map(item => item.computeUnits));
const cargoEvidence = {
  command: [cargoTool.path, ...cargoArgs],
  toolchain: {cargo: cargoTool, rustc: rustcTool, requiredRustVersion: '1.92.0'},
  targetDirectory: cargoTarget,
  stdout: {path: path.relative('.', cargoLog), sha256: hashFile(cargoLog)},
  stderr: {path: path.relative('.', cargoStderrLog), sha256: hashFile(cargoStderrLog)},
  testExecutable: {path: path.relative('.', testExecutable), sha256: hashFile(testExecutable)},
  programId: execution.programId,
  execution: {
    path: path.relative('.', executionPath), sha256: hashFile(executionPath),
    observations: execution.observations,
    adapterFailures: execution.adapterFailures,
    maxMeasuredCu,
  },
};
const inputHashesAfter = Object.fromEntries(sourceFiles.map(file => [file, hashFile(file)]));
assert.deepEqual(inputHashesAfter, inputHashes, 'source drift during SHA reference gate');
const report = {
  schemaVersion: 1,
  status: 'checked-bend-native-and-sbf-execution-passed',
  scope: 'safe checked Bend SHA-256 single-block reference for messages of 0..55 bytes',
  limits: {maxMessageBytes: 55, byteSlots: 64, activeByteValueMax: 255,
    digestWords: 8, digestWordOrder: 'big-endian'},
  vectors: cases.map(testCase => ({name: testCase.name,
    inputBytes: testCase.inputBytes,
    inputWireSha256: createHash('sha256').update(Uint8Array.from(testCase.input)).digest('hex'),
    expectedResultWireSha256: createHash('sha256').update(Uint8Array.from(encodeResult(testCase.expected))).digest('hex')})),
  invalidCases: invalid.map(item => item.name),
  sourceMutation: {kind: mutationKind, changed: 'first FIPS round constant +1'},
  failureClassification: {missingCompiler: processFailure(missingCommand), vectorMutation: mutationKind},
  sourceInputs: inputHashes,
  sourceInputsAfter: inputHashesAfter,
  compilerInputs,
  bend: {commit: bendCommit, clean: bendDirty === '', bun: process.versions.bun},
  nativeCompiler: nativeTool,
  sbf,
  sbfExecution: cargoEvidence,
  artifactsBeforeExecution: Object.fromEntries(Object.entries(artifactHashesBefore).map(([file, sha256]) => [
    path.relative('.', file), {sha256, bytes: fs.statSync(file).size},
  ])),
  artifactsAfterExecution: Object.fromEntries(Object.entries(artifactHashesAfter).map(([file, sha256]) => [
    path.relative('.', file), {sha256, bytes: fs.statSync(file).size},
  ])),
  artifacts: Object.fromEntries(artifactFiles.map(file => [file, {
    sha256: hashFile(file), bytes: fs.statSync(file).size,
  }])),
  limitations: [
    'The source API accepts fixed 64-slot U32 storage and hashes one padded block only.',
    'Messages of 56..1,024 bytes, multi-block processing, borrowed account views, and runtime/syscall specialization are not implemented.',
    'Laws cover length and byte validation boundaries, not universal cryptographic correctness or security properties.',
    'Finite source/native/SBF vectors do not establish a universal SHA-256 theorem or deployment behavior; selected tool hashes identify local files without attesting their provenance.',
  ],
};
const pendingReport = path.join(work, 'report.pending.json');
fs.writeFileSync(pendingReport, `${JSON.stringify(report, null, 2)}\n`, {flag: 'wx'});
fs.renameSync(pendingReport, reportPath);
console.log(`SHA-256 checked Bend reference, native C, and LiteSVM SBF execution passed: ${reportPath}`);
console.log(`vectors=${vectors.length}; checked/native/SBF cases=${cases.length}; adapter errors=${adapterFailures.length}; max CU=${maxMeasuredCu}; entry frame=${sbf.entryFrameBytes}`);
