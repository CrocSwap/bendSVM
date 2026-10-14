import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mangle } from '../compiler/backend.ts';
import { emitCodecs } from '../compiler/codecs.ts';
import { emitDispatcher } from '../compiler/dispatch.ts';
import { resourceReport } from '../compiler/resources.ts';
import type { RuntimeSchema, TypeSchema } from '../compiler/schema.ts';
import { compileSbf, run } from '../scripts/build.ts';

const marker: TypeSchema = {
  kind: 'adt', name: 'Marker', cType: 'bend_Marker_t', variants: [
    { name: 'MarkerEmpty', tag: 0, fields: [], cMaker: 'bend_MarkerEmpty_make' },
    { name: 'MarkerValue', tag: 1, fields: [{ name: 'value', type: 'U32' }], cMaker: 'bend_MarkerValue_make' },
  ],
};
const payloadFields = [
  ...Array.from({ length: 64 }, (_, i) => ({ name: `word${i}`, type: 'U32' })),
  { name: 'marker', type: 'Marker' },
];
const payload: TypeSchema = {
  kind: 'adt', name: 'Payload', cType: 'bend_Payload_t', variants: [
    { name: 'PayloadEmpty', tag: 0, fields: [], cMaker: 'bend_PayloadEmpty_make' },
    { name: 'PayloadWide', tag: 1, fields: payloadFields, cMaker: 'bend_PayloadWide_make' },
  ],
};
const envelope: TypeSchema = {
  kind: 'adt', name: 'Envelope', cType: 'bend_Envelope_t', variants: [
    { name: 'EnvelopeEmpty', tag: 0, fields: [], cMaker: 'bend_EnvelopeEmpty_make' },
    { name: 'EnvelopePayload', tag: 1, fields: [{ name: 'payload', type: 'Payload' }], cMaker: 'bend_EnvelopePayload_make' },
  ],
};
const boolean: TypeSchema = { kind: 'bool', name: 'Bool', cType: 'bend_u32' };
function boolAggregate(name: string, fieldCount: number): TypeSchema {
  return {
    kind: 'adt', name, cType: `bend_${name}_t`, variants: [{
      name: `${name}Value`, tag: 0,
      fields: Array.from({ length: fieldCount }, (_, i) => ({ name: `bit${i}`, type: 'Bool' })),
      cMaker: `bend_${name}Value_make`,
    }],
  };
}
const boundary255 = boolAggregate('Boundary255', 254);
const boundary256 = boolAggregate('Boundary256', 255);
const deepSmallTypes: TypeSchema[] = [];
let deepSmallLeaf = 'U32';
for (let i = 0; i < 9; i++) {
  const name = `Deep${i}`;
  deepSmallTypes.push({
    kind: 'adt', name, cType: `bend_${name}_t`, variants: [{
      name: `${name}Value`, tag: 0,
      fields: [{ name: 'value', type: deepSmallLeaf }],
      cMaker: `bend_${name}Value_make`,
    }],
  });
  deepSmallLeaf = name;
}
const schema: RuntimeSchema = { version: 1, types: [
  { kind: 'u32', name: 'U32', cType: 'bend_u32' }, boolean, marker, payload, envelope,
  boundary255, boundary256, ...deepSmallTypes,
], exports: [{ name: 'identity', cName: 'bend_identity', args: ['Envelope'], result: 'Envelope' }] };

function cType(t: TypeSchema): string { return t.cType; }

function cDeclaration(t: TypeSchema): string {
  if (t.kind !== 'adt') return '';
  const variants = t.variants.map(v => `    struct { ${v.fields.map((f, i) => `${cType(types.get(f.type)!)} f${i};`).join(' ') || 'bend_u32 unused;'} } c${v.tag};`).join('\n');
  const makers = t.variants.map(v => {
    const args = v.fields.map((f, i) => `${cType(types.get(f.type)!)} a${i}`).join(', ') || 'void';
    const fields = v.fields.map((_, i) => `.f${i} = a${i}`).join(', ') || '.unused = 0';
    return `static inline ${t.cType} ${v.cMaker}(${args}) { return (${t.cType}){ .tag = ${v.tag}, .as.c${v.tag} = { ${fields} } }; }`;
  }).join('\n');
  return `typedef struct { bend_u32 tag; union {\n${variants}\n  } as; } ${t.cType};\n_Static_assert(sizeof(${t.cType}) <= 1536, "fixture value within native bound");\n${makers}`;
}

const types = new Map(schema.types.map(t => [t.name, t]));
const wire = emitCodecs(schema);
const depths = new Map<string, number>();
function decodeDepth(name: string): number {
  const cached = depths.get(name);
  if (cached !== undefined) return cached;
  const t = types.get(name)!;
  const children = t.kind === 'adt' ? t.variants.flatMap(v => v.fields.map(f => decodeDepth(f.type))) : [];
  const depth = 1 + Math.max(0, ...children);
  depths.set(name, depth);
  return depth;
}

assert.match(wire, /static inline int bend_Marker_decode\(/, 'small codecs retain their existing inline declaration');
assert.match(wire, /static __attribute__\(\(noinline\)\) inline int bend_Payload_decode\(/);
assert.match(wire, /static __attribute__\(\(noinline\)\) inline int bend_Envelope_decode\(/);
assert.match(wire, /static inline int bend_Boundary255_decode\(/, '255-byte ADTs remain inline');
assert.match(wire, /static __attribute__\(\(noinline\)\) inline int bend_Boundary256_decode\(/,
  '256-byte ADTs are outlined at the threshold');
assert.match(wire, /static inline int bend_Deep8_decode\(/,
  'deep small ADT decoders remain supported without an arbitrary depth cap');
function codecWireSize(name: string): number {
  const match = wire.match(new RegExp(`#define ${mangle(name)}_WIRE_SIZE ([0-9]+)u`));
  assert.ok(match, `missing wire size for ${name}`);
  return Number(match[1]);
}
assert.equal(codecWireSize('Boundary255'), 255, 'fixture reaches the last byte below the outline threshold');
assert.equal(codecWireSize('Boundary256'), 256, 'fixture reaches the outline threshold exactly');
assert.equal(decodeDepth('Deep8'), 10, 'nine nested small ADTs and their U32 leaf are emitted');

const nativeSize = resourceReport(schema).largestNativeBytes;
const wireSize = Math.max(...schema.types.map(t => {
  const match = wire.match(new RegExp(`#define ${mangle(t.name)}_WIRE_SIZE ([0-9]+)u`));
  assert.ok(match, `missing wire size for ${t.name}`);
  return Number(match[1]);
}));
assert.ok(nativeSize <= 1536, `fixture native value is ${nativeSize} bytes`);
assert.ok(wireSize <= 1024, `fixture wire value is ${wireSize} bytes`);

const declarations = schema.types.map(cDeclaration).filter(Boolean).join('\n\n');
const outputDir = 'build/large-codec';
fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
const stem = `${outputDir}/large-codec`;
const runtimeHeader = path.relative(outputDir, 'runtime/solana_min.h').split(path.sep).join('/');
fs.writeFileSync(`${stem}.wire.h`, `typedef unsigned int bend_u32;\n_Static_assert(sizeof(bend_u32) == 4, "u32 width");\n${declarations}\n${wire}`);
fs.writeFileSync(`${stem}.dispatch.h`, `#include "large-codec.wire.h"\nstatic bend_Envelope_t bend_identity(bend_Envelope_t value);\n${emitDispatcher(schema)}`);
const wireBytes = Number(wire.match(new RegExp(`#define ${mangle(envelope.name)}_WIRE_SIZE ([0-9]+)u`))![1]);
fs.writeFileSync(`${stem}.native.c`, `#include <string.h>
#include "large-codec.dispatch.h"

static bend_Envelope_t bend_identity(bend_Envelope_t value) { return value; }

static int preserves_failure(const unsigned char *input, unsigned long long length) {
  bend_Envelope_t out;
  unsigned char before[sizeof(out)];
  memset(&out, 0xa5, sizeof(out));
  memcpy(before, &out, sizeof(out));
  if (bend_Envelope_decode(input, length, &out)) return 0;
  return memcmp(before, &out, sizeof(out)) == 0;
}

static int dispatch_preserves_failure(const unsigned char *input, unsigned long long length) {
  unsigned char output[${wireBytes}], before[${wireBytes}];
  unsigned long long written = 777;
  memset(output, 0xa5, sizeof(output));
  memcpy(before, output, sizeof(output));
  if (bend_wire_dispatch(input, length, output, sizeof(output), &written)) return 0;
  return written == 0 && memcmp(before, output, sizeof(output)) == 0;
}

int main(void) {
  unsigned char input[${wireBytes}] = {0};
  unsigned char encoded[${wireBytes}] = {0};
  input[0] = 1; /* EnvelopePayload */
  input[1] = 1; /* PayloadWide */
  for (unsigned i = 0; i < 64; ++i) {
    unsigned value = 0x10203040u + i;
    for (unsigned b = 0; b < 4; ++b) input[2 + i * 4 + b] = (unsigned char)(value >> (8 * b));
  }
  const unsigned marker = 2 + 64 * 4;
  input[marker] = 1; /* MarkerValue */
  input[marker + 1] = 0xef; input[marker + 2] = 0xbe;
  input[marker + 3] = 0xad; input[marker + 4] = 0xde;
  bend_Envelope_t decoded;
  if (!bend_Envelope_decode(input, sizeof(input), &decoded)) return 1;
  if (decoded.tag != 1 || decoded.as.c1.f0.tag != 1) return 18;
  if (decoded.as.c1.f0.as.c1.f0 != 0x10203040u || decoded.as.c1.f0.as.c1.f63 != 0x1020307fu) return 19;
  if (decoded.as.c1.f0.as.c1.f64.tag != 1 || decoded.as.c1.f0.as.c1.f64.as.c1.f0 != 0xdeadbeefu) return 20;
  if (!bend_Envelope_encode(encoded, sizeof(encoded), &decoded)) return 2;
  if (memcmp(input, encoded, sizeof(input)) != 0) return 3;

  unsigned char bytes255[255] = {0}, roundtrip255[255] = {0};
  unsigned char bytes256[256] = {0}, roundtrip256[256] = {0};
  for (unsigned i = 1; i < sizeof(bytes255); ++i) bytes255[i] = (unsigned char)(i & 1);
  for (unsigned i = 1; i < sizeof(bytes256); ++i) bytes256[i] = (unsigned char)(i & 1);
  bend_Boundary255_t decoded255;
  bend_Boundary256_t decoded256;
  if (!bend_Boundary255_decode(bytes255, sizeof(bytes255), &decoded255)) return 21;
  if (!bend_Boundary255_encode(roundtrip255, sizeof(roundtrip255), &decoded255) ||
      memcmp(bytes255, roundtrip255, sizeof(bytes255)) != 0) return 22;
  if (!bend_Boundary256_decode(bytes256, sizeof(bytes256), &decoded256)) return 23;
  if (!bend_Boundary256_encode(roundtrip256, sizeof(roundtrip256), &decoded256) ||
      memcmp(bytes256, roundtrip256, sizeof(bytes256)) != 0) return 24;

  unsigned char deepInput[13] = {0}, deepRoundtrip[13] = {0};
  deepInput[9] = 0x78; deepInput[10] = 0x56; deepInput[11] = 0x34; deepInput[12] = 0x12;
  bend_Deep8_t deepDecoded;
  if (!bend_Deep8_decode(deepInput, sizeof(deepInput), &deepDecoded)) return 25;
  if (!bend_Deep8_encode(deepRoundtrip, sizeof(deepRoundtrip), &deepDecoded) ||
      memcmp(deepInput, deepRoundtrip, sizeof(deepInput)) != 0) return 26;

  unsigned char call[sizeof(input) + 1], reply[sizeof(input)];
  call[0] = 0; memcpy(call + 1, input, sizeof(input));
  unsigned long long written = 0;
  if (!bend_wire_dispatch(call, sizeof(call), reply, sizeof(reply), &written)) return 11;
  if (written != sizeof(reply) || memcmp(input, reply, sizeof(reply)) != 0) return 12;
  for (unsigned n = 0; n < sizeof(call); ++n) if (!dispatch_preserves_failure(call, n)) return 13;
  call[0] = 255;
  if (!dispatch_preserves_failure(call, sizeof(call))) return 14;
  call[0] = 0;
  if (bend_wire_dispatch(call, sizeof(call), reply, sizeof(reply) - 1, &written)) return 15;
  if (written != 0) return 16;
  if (memcmp(input, reply, sizeof(reply)) != 0) return 17;

  for (unsigned n = 0; n < sizeof(input); ++n) if (!preserves_failure(input, n)) return 4;
  unsigned char malformed[sizeof(input) + 1];
  memcpy(malformed, input, sizeof(input)); malformed[sizeof(input)] = 0;
  if (!preserves_failure(malformed, sizeof(malformed))) return 5;
  malformed[0] = 255;
  if (!preserves_failure(malformed, sizeof(input))) return 6;
  memcpy(malformed, input, sizeof(input)); malformed[1] = 255;
  if (!preserves_failure(malformed, sizeof(input))) return 7;
  memcpy(malformed, input, sizeof(input)); malformed[marker] = 255;
  if (!preserves_failure(malformed, sizeof(input))) return 8;
  memcpy(malformed, input, sizeof(input)); malformed[marker] = 0; malformed[marker + 1] = 1;
  if (!preserves_failure(malformed, sizeof(input))) return 9;
  memset(malformed, 0, sizeof(input)); malformed[0] = 0; malformed[sizeof(input) - 1] = 1;
  if (!preserves_failure(malformed, sizeof(input))) return 10;
  return 0;
}
`);
run(process.env.CC ?? 'clang', ['-std=c17', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
  '-fsanitize=address,undefined', '-fno-sanitize-recover=all', `${stem}.native.c`, '-o', `${stem}.native`]);
const native = spawnSync(path.resolve(`${stem}.native`), [], { encoding: 'utf8' });
assert.equal(native.status, 0, native.stderr);

fs.writeFileSync(`${stem}.sbf.c`, `#include "${runtimeHeader}"
#include "large-codec.wire.h"
static bend_Envelope_t output;
static bend_Boundary255_t output255;
static bend_Boundary256_t output256;
static const unsigned char bytes255[255];
static const unsigned char bytes256[256];
__attribute__((visibility("default"))) u64 entrypoint(const u8 *input) {
  if (input[0] == 255) {
    if (!bend_Boundary255_decode(bytes255, sizeof(bytes255), &output255)) return 0;
    if (!bend_Boundary256_decode(bytes256, sizeof(bytes256), &output256)) return 0;
  }
  return bend_Envelope_decode(input, ${wireBytes}u, &output);
}
`);
compileSbf(`${stem}.sbf.c`, `${stem}.sbf`);
const stack = JSON.parse(fs.readFileSync(`${stem}.sbf.stack.json`, 'utf8')) as {
  frameLimit: number; maxFrameBytes: number; functions: { location: string; bytes: number }[];
};
assert.ok(stack.functions.some(f => f.location.includes('bend_Payload_decode')), 'large payload decoder appears in the stack report');
assert.ok(stack.functions.some(f => f.location.includes('bend_Envelope_decode')), 'large envelope decoder appears in the stack report');
assert.ok(stack.functions.some(f => f.location.includes('bend_Boundary256_decode')), '256-byte decoder is emitted as its own function');
console.log(`Large canonical codec: native ${nativeSize} bytes, max wire ${wireSize} bytes, exact 255/256-byte boundary and nine nested small-ADT round-trips, max SBF frame ${stack.maxFrameBytes}/${stack.frameLimit}; ASan/UBSan malformed-input rejection and ADT decode/dispatcher output preservation passed`);
