import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as B from '../.deps/bend/bend2/bend.ts';
import { Backend, checkedBook } from '../compiler/backend.ts';
import { writeArtifacts } from '../compiler/artifacts.ts';
import { emitCodecs } from '../compiler/codecs.ts';
import type { RuntimeSchema } from '../compiler/schema.ts';
import { wireCodec, type WireValue } from '../sdk/wire.ts';
import { compileSbf, run } from '../scripts/build.ts';

export async function testCodecs() {
  const book = await checkedBook('tests/codecs.bend');
  const emitted = new Backend(book).emit(['identity', 'flip']);
  writeArtifacts('build/codecs', emitted);
  const codec = wireCodec(emitted.schema);
  const types = new Map(emitted.schema.types.map(t => [t.name, t]));
  const ctor = (constructor: string, fields: Record<string, WireValue> = {}): WireValue => ({ constructor, fields });
  const values: WireValue[] = [ctor('Idle'), ctor('Enabled', { flag: false }), ctor('Enabled', { flag: true })];
  let seed = 0x41ba1234;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const words = [0, 1, 0x80000000, 0xffffffff, ...Array.from({ length: 40 }, random)];
  for (const word of words) {
    values.push(ctor('Number', { value: word }));
    for (const flag of [false, true]) values.push(ctor('Location', { flag, point: ctor('Point', { x: word, y: random() }) }));
  }
  function term(type: string, value: WireValue): B.HTerm {
    const t = types.get(type)!;
    if (t.kind === 'u32') return B.term_higher(B.u32_to_term(value as number));
    if (t.kind === 'bool') return B.Ctr(value ? 'True' : 'False', []);
    const v = value as { constructor: string; fields: Record<string, WireValue> };
    const variant = t.variants.find(c => c.name === v.constructor)!;
    return B.Ctr(v.constructor, variant.fields.map(f => term(f.type, v.fields[f.name])));
  }
  function value(type: string, term: B.HTerm): WireValue {
    const t = types.get(type)!;
    if (t.kind === 'u32') { const n = B.u32_from_term(term); assert.notEqual(n, null); return n!; }
    assert.equal(term.$, 'Ctr'); if (term.$ !== 'Ctr') throw new Error('Expected constructor');
    if (t.kind === 'bool') return term.k === 'True';
    const variant = t.variants.find(v => v.name === term.k)!;
    return ctor(term.k, Object.fromEntries(variant.fields.map((f, i) => [f.name, value(f.type, term.x[i])])));
  }
  type Case = { name: string; input: number[]; expected: number[] | null; capacity?: number };
  const cases: Case[] = [];
  for (const v of values) for (const name of ['identity', 'flip']) {
    const input = codec.call(name, [v]);
    const result = B.term_snf(book, B.App(B.Ref(name), term('Packet', v)));
    const expected = codec.encode('Packet', value('Packet', result));
    assert.deepEqual(codec.encode('Packet', codec.reply(name, expected)), expected);
    cases.push({ name, input: [...input], expected: [...expected] });
  }
  const location = codec.call('identity', [ctor('Location', { flag: true, point: ctor('Point', { x: 1, y: 2 }) })]);
  const malformed = (name: string, input: Uint8Array | number[]) => cases.push({ name, input: [...input], expected: null });
  for (let n = 0; n < location.length; n++) malformed(`truncated-${n}`, location.subarray(0, n));
  malformed('trailing-byte', [...location, 0]);
  malformed('unknown-export', [255, ...location.subarray(1)]);
  const badTag = location.slice(); badTag[1] = 255; malformed('bad-tag', badTag);
  const badBool = location.slice(); badBool[2] = 2; malformed('bad-bool', badBool);
  const nestedTag = location.slice(); nestedTag[3] = 1; malformed('bad-nested-tag', nestedTag);
  const padding = codec.call('identity', [ctor('Idle')]); padding[padding.length - 1] = 1;
  malformed('nonzero-inactive-padding', padding);
  for (const c of cases.filter(c => c.expected === null && c.input[0] === 0)) {
    assert.throws(() => codec.decode('Packet', Uint8Array.from(c.input.slice(1))), undefined, c.name);
  }
  assert.throws(() => codec.encode('U32', -1));
  assert.throws(() => codec.encode('U32', 2 ** 32));
  assert.throws(() => codec.encode('U32', 1.5));
  assert.throws(() => codec.encode('Bool', 1));
  assert.throws(() => codec.encode('Packet', ctor('Enabled', { flag: true, extra: 0 })));
  assert.throws(() => codec.encode('Packet', ctor('Enabled')));
  assert.throws(() => codec.call('identity', []));
  assert.throws(() => codec.call('missing', []));
  const subarray = new Uint8Array(8); subarray.set(codec.encode('U32', 0xffffffff), 2);
  assert.equal(codec.decode('U32', subarray.subarray(2, 6)), 0xffffffff);

  const nativeCases: Case[] = [...cases];
  for (let capacity = 0; capacity < codec.sizes.get('Packet')!; capacity++) {
    nativeCases.push({ name: `short-output-${capacity}`, input: [...location], capacity, expected: null });
  }
  fs.writeFileSync('build/codecs-native.c', `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "codecs.dispatch.h"
int main(void) {
  unsigned length, capacity, byte;
  while (scanf("%u %u", &length, &capacity) == 2) {
    if (length > 1025 || capacity > 1024) return 1;
    unsigned char *input = malloc(length ? length : 1), *output = malloc(capacity ? capacity : 1);
    if (!input || !output) return 2;
    for (unsigned i = 0; i < length; ++i) { if (scanf("%u", &byte) != 1 || byte > 255) return 3; input[i] = byte; }
    memset(output, 0xa5, capacity ? capacity : 1);
    unsigned long long written = 777;
    int ok = bend_wire_dispatch(input, length, output, capacity, &written);
    if (!ok && written != 0) return 4;
    if (ok) {
      bend_Packet_t decoded;
      if (!bend_Packet_decode(output, written, &decoded)) return 5;
      memset(output, 0xa5, capacity);
      if (!bend_Packet_encode(output, written, &decoded)) return 6;
      for (unsigned long long i = written; i < capacity; ++i) if (output[i] != 0xa5) return 7;
    }
    printf("%d", ok);
    if (ok) for (unsigned long long i = 0; i < written; ++i) printf(" %u", output[i]);
    puts(""); free(input); free(output);
  }
  return ferror(stdin) ? 1 : 0;
}\n`);
  run(process.env.CC ?? 'clang', ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all', 'build/codecs-native.c', '-o', 'build/codecs-native']);
  const native = spawnSync(path.resolve('build/codecs-native'), [], { encoding: 'utf8',
    input: nativeCases.map(c => `${c.input.length} ${c.capacity ?? 1024} ${c.input.join(' ')}`).join('\n') + '\n' });
  assert.equal(native.status, 0, native.stderr);
  assert.deepEqual(native.stdout.trim().split('\n'), nativeCases.map(c => c.expected === null ? '0' : `1 ${c.expected.join(' ')}`));

  // A nested inactive constructor has padding inside its parent's active field.
  const nestedSchema: RuntimeSchema = { ...emitted.schema, types: [...emitted.schema.types, {
    kind: 'adt', name: 'Envelope', cType: 'bend_Envelope_t', variants: [
      { name: 'EmptyEnvelope', tag: 0, fields: [], cMaker: 'bend_EmptyEnvelope_make' },
      { name: 'Wrapped', tag: 1, fields: [{ name: 'packet', type: 'Packet' }], cMaker: 'bend_Wrapped_make' },
    ],
  }] };
  fs.writeFileSync('build/codecs-nested.wire.h', emitCodecs(nestedSchema));
  fs.writeFileSync('build/codecs-nested.c', `#include <string.h>
#include "codecs.h"
typedef struct {
  bend_u32 tag;
  union {
    struct { bend_u32 unused; } c0;
    struct { bend_Packet_t f0; } c1;
  } as;
} bend_Envelope_t;
static inline bend_Envelope_t bend_EmptyEnvelope_make(void) {
  return (bend_Envelope_t){ .tag = 0 };
}
static inline bend_Envelope_t bend_Wrapped_make(bend_Packet_t packet) {
  return (bend_Envelope_t){ .tag = 1, .as.c1 = { .f0 = packet } };
}
#include "codecs-nested.wire.h"
int main(void) {
  unsigned char output[bend_Envelope_WIRE_SIZE];
  const unsigned char wrapped_idle[bend_Envelope_WIRE_SIZE] = { 1 };
  const unsigned char wrapped_enabled[bend_Envelope_WIRE_SIZE] = { 1, 1, 1 };
  const unsigned char empty[bend_Envelope_WIRE_SIZE] = { 0 };
  bend_Envelope_t value = bend_Wrapped_make(bend_Idle_make());
  memset(output, 0xa5, sizeof output);
  if (!bend_Envelope_encode(output, sizeof output, &value) || memcmp(output, wrapped_idle, sizeof output)) return 1;
  value = bend_Wrapped_make(bend_Enabled_make(1));
  memset(output, 0xa5, sizeof output);
  if (!bend_Envelope_encode(output, sizeof output, &value) || memcmp(output, wrapped_enabled, sizeof output)) return 2;
  value = bend_EmptyEnvelope_make();
  memset(output, 0xa5, sizeof output);
  if (!bend_Envelope_encode(output, sizeof output, &value) || memcmp(output, empty, sizeof output)) return 3;
  memset(output, 0xa5, sizeof output);
  if (bend_Envelope_encode(output, sizeof output - 1, &value)) return 4;
  for (unsigned i = 0; i < sizeof output; ++i) if (output[i] != 0xa5) return 5;
  value.tag = 255;
  memset(output, 0xa5, sizeof output);
  if (bend_Envelope_encode(output, sizeof output, &value) || memcmp(output, empty, sizeof output)) return 6;
  bend_Packet_t bad_packet = bend_Idle_make();
  bad_packet.tag = 255;
  value = bend_Wrapped_make(bad_packet);
  memset(output, 0xa5, sizeof output);
  if (bend_Envelope_encode(output, sizeof output, &value) || memcmp(output, wrapped_idle, sizeof output)) return 7;
  value = bend_Wrapped_make(bend_Enabled_make(2));
  memset(output, 0xa5, sizeof output);
  const unsigned char invalid_bool[bend_Envelope_WIRE_SIZE] = { 1, 1 };
  if (bend_Envelope_encode(output, sizeof output, &value) || memcmp(output, invalid_bool, sizeof output)) return 8;
  return 0;
}\n`);
  run(process.env.CC ?? 'clang', ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all', 'build/codecs-nested.c', '-o', 'build/codecs-nested']);
  run(path.resolve('build/codecs-nested'), []);
  fs.writeFileSync('build/codecs-sbf.c', '#include "solana_min.h"\n#include "codecs.dispatch.h"\n#include "invoke.h"\n');
  compileSbf('build/codecs-sbf.c', 'build/codecs');
  fs.writeFileSync('build/codecs-vectors.json', JSON.stringify(cases) + '\n');
  console.log(`${nativeCases.length} typed interface cases and nested dirty-output encodes passed (Bend/client/native, ASan/UBSan); SBF module built`);
}
