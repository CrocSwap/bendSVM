import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as B from '../.deps/bend/bend2/bend.ts';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';
import { compileSbf, prepareBend, run } from './build.ts';

type Vector = { name: string; input: number[]; expected: number[] };
type InvalidVector = { name: string; input: number[] };

const stem = 'build/lowering';
fs.mkdirSync('build', { recursive: true });
prepareBend();

// checkedBook enforces the fixture's declared identity law before any C is
// emitted. The proof function is checked and erased from the runtime closure.
const book = await checkedBook('tests/lowering.bend');
const roots = ['swap', 'select', 'update', 'normalize', 'iterate', 'identity'];
const emitted = new Backend(book).emit(roots);
assert.doesNotMatch(emitted.functions.join('\n'), /identity_preserves/,
  'proof function entered the runtime closure');
assert.doesNotMatch(emitted.c, /identity_preserves/,
  'proof function entered generated C');
writeArtifacts(stem, emitted);

const types = new Map(emitted.schema.types.map(type => [type.name, type]));
const codec = wireCodec(emitted.schema);
function toTerm(type: string, value: WireValue): B.HTerm {
  const schema = types.get(type);
  assert(schema, `missing type ${type}`);
  if (type === 'Nat') {
    let term: B.HTerm = B.Ctr('Zero', []);
    for (let i = 0; i < (value as number); i++) term = B.Ctr('Succ', [term]);
    return term;
  }
  if (schema.kind === 'u32') return B.term_higher(B.u32_to_term(value as number));
  if (schema.kind === 'bool') return B.Ctr(value ? 'True' : 'False', []);
  assert.equal(typeof value, 'object');
  const v = value as { constructor: string; fields: Record<string, WireValue> };
  const variant = schema.variants.find(item => item.name === v.constructor);
  assert(variant, `missing ${type}.${v.constructor}`);
  return B.Ctr(variant.sourceName ?? variant.name,
    variant.fields.map(field => toTerm(field.type, v.fields[field.name])));
}

function fromTerm(type: string, term: B.HTerm): WireValue {
  const schema = types.get(type);
  assert(schema, `missing type ${type}`);
  if (type === 'Nat') {
    let n = 0;
    while (term.$ === 'Ctr' && term.k === 'Succ') { n++; term = term.x[0]; }
    assert(term.$ === 'Ctr' && term.k === 'Zero', 'expected Nat');
    return n;
  }
  if (schema.kind === 'u32') {
    const n = B.u32_from_term(term);
    assert.notEqual(n, null, `expected U32, got ${JSON.stringify(term)}`);
    return n!;
  }
  assert.equal(term.$, 'Ctr');
  if (term.$ !== 'Ctr') throw new Error(`expected ${type} constructor`);
  if (schema.kind === 'bool') return term.k === 'True';
  const variant = schema.variants.find(item => (item.sourceName ?? item.name) === term.k);
  assert(variant, `unexpected ${type} constructor ${term.k}`);
  return {
    constructor: variant.name,
    fields: Object.fromEntries(variant.fields.map((field, i) =>
      [field.name, fromTerm(field.type, term.x[i])])),
  };
}

const vectors: Vector[] = [];
let mutationCase = -1;
function add(name: string, args: WireValue[]) {
  const exported = emitted.schema.exports.find(item => item.name === name);
  assert(exported, `missing export ${name}`);
  assert.equal(args.length, exported.args.length, `${name} argument count`);
  let call: B.HTerm = B.Ref(name);
  args.forEach((arg, i) => { call = B.App(call, toTerm(exported.args[i], arg)); });
  const reference = B.term_snf(book, call);
  const expected = codec.encode(exported.result, fromTerm(exported.result, reference));
  const input = codec.call(name, args);
  if (name === 'select' && args[0] === true) {
    const pair = args[1] as { constructor: string; fields: Record<string, WireValue> };
    if (pair.fields.left !== pair.fields.right && mutationCase < 0) mutationCase = vectors.length;
  }
  vectors.push({ name: `${name}-${vectors.length}`, input: [...input], expected: [...expected] });
}

const boundary = [0, 1, 0x7fffffff, 0x80000000, 0xfffffffe, 0xffffffff];
const pair = (left: number, right: number): WireValue =>
  ({ constructor: 'Sample', fields: { left, right } });
const payload = (constructor: string, fields: Record<string, WireValue> = {}): WireValue =>
  ({ constructor, fields });
const pairs: [number, number][] = boundary.flatMap(left => boundary.map(right => [left, right]));
let seed = 0x2a91c7e5;
const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
for (let i = 0; i < 20; i++) pairs.push([random(), random()]);

for (const [index, [left, right]] of pairs.entries()) {
  const sample = pair(left, right);
  add('swap', [sample]);
  for (const flag of [false, true]) {
    add('select', [flag, sample]);
    add('update', [flag, sample, boundary[index % boundary.length]]);
    add('normalize', [payload('State', { enabled: flag, pair: sample })]);
  }
}
add('normalize', [payload('Empty')]);
for (const word of boundary) add('normalize', [payload('Word', { value: word })]);
for (const fuel of [0, 1, 2, 63, 64]) {
  for (const value of boundary) add('iterate', [fuel, value]);
}
for (let i = 0; i < 20; i++) {
  add('iterate', [i % 2 ? 64 : 0, random()]);
}
assert(mutationCase >= 0, 'no nontrivial select(true, ...) mutation vector generated');

const invalid: InvalidVector[] = [];
const malformed = (name: string, input: Uint8Array | number[]) =>
  invalid.push({ name, input: [...input] });
const stateInput = codec.call('normalize', [payload('State', {
  enabled: true, pair: pair(17, 42),
})]);
malformed('empty-input', []);
malformed('truncated', stateInput.slice(0, -1));
malformed('trailing-byte', [...stateInput, 0]);
const badOpcode = stateInput.slice(); badOpcode[0] = 255;
malformed('unknown-export', badOpcode);
const badTag = stateInput.slice(); badTag[1] = 255;
malformed('unknown-constructor-tag', badTag);
const badBool = stateInput.slice(); badBool[2] = 2;
malformed('noncanonical-bool', badBool);
const nonzeroPadding = codec.call('normalize', [payload('Word', { value: 7 })]);
nonzeroPadding[nonzeroPadding.length - 1] = 1;
malformed('nonzero-inactive-padding', nonzeroPadding);
const excessiveFuel = codec.call('iterate', [64, 9]); excessiveFuel[1] = 65;
malformed('excessive-nat-fuel', excessiveFuel);

const nativeHarness = (dispatcher: string) => `#include <stdio.h>
#include "${dispatcher}"
int main(void) {
  unsigned length, byte;
  unsigned char input[1024], output[1024];
  while (scanf("%u", &length) == 1) {
    if (length > sizeof(input)) return 1;
    for (unsigned i = 0; i < length; ++i) {
      if (scanf("%u", &byte) != 1 || byte > 255) return 2;
      input[i] = (unsigned char)byte;
    }
    unsigned long long written = 777;
    int ok = bend_wire_dispatch(input, length, output, sizeof(output), &written);
    if (!ok && written != 0) return 3;
    if (!ok) { puts("ERR"); continue; }
    printf("OK");
    for (unsigned long long i = 0; i < written; ++i) printf(" %u", output[i]);
    puts("");
  }
  return ferror(stdin) ? 4 : 0;
}
`;
const encodeLines = (inputs: number[][]) => inputs.map(bytes => `${bytes.length} ${bytes.join(' ')}`).join('\n') + '\n';
function nativeResults(executable: string, inputs: number[][]): string[] {
  const result = spawnSync(path.resolve(executable), [], {
    encoding: 'utf8', input: encodeLines(inputs), timeout: 30_000,
  });
  assert.equal(result.error, undefined, `${executable} spawn/timeout failure: ${result.error ?? ''}`);
  assert.equal(result.status, 0, `${executable} failed (${result.status}): ${result.stderr}`);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, inputs.length, `${executable} output count`);
  return lines;
}

function compileNative(stemPath: string, dispatcher: string) {
  fs.writeFileSync(`${stemPath}.c`, nativeHarness(dispatcher));
  run(process.env.CC ?? 'clang', ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all', '-Ibuild',
    `${stemPath}.c`, '-o', stemPath]);
}

compileNative(`${stem}-native`, 'lowering.dispatch.h');
const validExpected = vectors.map(vector => `OK ${vector.expected.join(' ')}`);
const native = nativeResults(`${stem}-native`, [...vectors.map(v => v.input), ...invalid.map(v => v.input)]);
assert.deepEqual(native.slice(0, vectors.length), validExpected, 'Bend reference/native C mismatch');
assert.deepEqual(native.slice(vectors.length), invalid.map(() => 'ERR'), 'native malformed wire accepted');

// Deliberately change a generated pattern-match result while preserving valid C.
// The mutated binary must build and run, then disagree with the Bend oracle on
// the targeted vector. Compile/spawn/timeout failures are hard test failures.
const mutation = 'return (a1).as.c0.f1;';
assert.equal(emitted.c.split(mutation).length - 1, 1, 'expected one select-true field result in C');
const mutated = { ...emitted, c: emitted.c.replace(mutation, 'return (a1).as.c0.f0;') };
writeArtifacts('build/lowering-mutated', mutated);
compileNative('build/lowering-mutated-native', 'lowering-mutated.dispatch.h');
const mutatedOutput = nativeResults('build/lowering-mutated-native', vectors.map(v => v.input));
assert.notEqual(mutatedOutput[mutationCase], validExpected[mutationCase],
  `emitter mutation did not alter ${vectors[mutationCase].name}`);
assert.notDeepEqual(mutatedOutput, validExpected, 'semantic emitter mutation escaped differential checks');

fs.writeFileSync('build/lowering-vectors.json', JSON.stringify(vectors) + '\n');
fs.writeFileSync('build/lowering-invalid-vectors.json', JSON.stringify(invalid) + '\n');
fs.writeFileSync(`${stem}-sbf.c`, '#include "solana_min.h"\n#include "lowering.dispatch.h"\n#include "invoke.h"\n');
compileSbf(`${stem}-sbf.c`, stem);

console.log(`${vectors.length} Bend/reference/native cases and ${invalid.length} native malformed-wire rejections passed`);
console.log(`Emitter field mutation compiled and was caught on ${vectors[mutationCase].name}`);
if (import.meta.main) run('cargo', ['test', '--locked', '--test', 'sbf', 'lowering_', '--', '--nocapture']);
