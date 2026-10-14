import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {generateExternalLayoutC} from '../compiler/external-layout.ts';
import {compileSbf} from '../scripts/build.ts';
import {
  EXTERNAL_MAX_ACCOUNT_BYTES,
  readExternalField,
  readExternalLayout,
  readExternalRecords,
  readExternalWindow,
  validateExternalLayout,
  type ExternalLayoutDescriptor,
} from '../sdk/external-layout.ts';

const layout: ExternalLayoutDescriptor = {
  name: 'synthetic_record',
  fixedSize: 64,
  allocation: {kind: 'prefix', maxLength: EXTERNAL_MAX_ACCOUNT_BYTES},
  fields: [
    {name: 'magic', offset: 0, type: 'bytes', length: 4},
    {name: 'version', offset: 4, type: 'u16', endian: 'big'},
    {name: 'reserved', offset: 6, type: 'bytes', length: 2},
    {name: 'count', offset: 8, type: 'u32', endian: 'little'},
    {name: 'amount', offset: 12, type: 'u64', endian: 'big'},
    {name: 'key', offset: 20, type: 'key32'},
    {name: 'payload_offset', offset: 52, type: 'u64', endian: 'little'},
    {name: 'payload_length', offset: 60, type: 'u16', endian: 'little'},
    {name: 'reserved_tail', offset: 62, type: 'bytes', length: 2},
  ],
  checks: {
    magic: {field: 'magic', bytes: [0x45, 0x58, 0x56, 0x31]},
    version: {field: 'version', equals: 0x0102},
    reservedZero: ['reserved', 'reserved_tail'],
  },
  windows: [{name: 'payload', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: 16}],
};

const exactLayout: ExternalLayoutDescriptor = {
  name: 'exact_word', fixedSize: 4, allocation: {kind: 'exact'},
  fields: [
    {name: 'low', offset: 0, type: 'u16', endian: 'little'},
    {name: 'high', offset: 2, type: 'u16', endian: 'big'},
  ],
};

const prefixLimitLayout: ExternalLayoutDescriptor = {
  name: 'prefix_limit', fixedSize: 1, allocation: {kind: 'prefix', maxLength: 4},
  logicalSize: {base: 1, terms: [{kind: 'multiply', field: 'count', by: 1}]},
  fields: [{name: 'count', offset: 0, type: 'u8', maximum: 4}],
};

// DPA1-shaped: exact 304-byte header followed by capacity * 80-byte outcomes.
const dpa1Layout: ExternalLayoutDescriptor = {
  name: 'dpa1_facts', fixedSize: 304, allocation: {kind: 'exact'},
  logicalSize: {base: 304, terms: [{kind: 'multiply', field: 'capacity', by: 80}]},
  fields: [
    {name: 'magic', offset: 0, type: 'bytes', length: 4},
    {name: 'version', offset: 4, type: 'u16', endian: 'little'},
    {name: 'capacity', offset: 40, type: 'u32', endian: 'little', minimum: 1, maximum: 1024},
  ],
  checks: {magic: {field: 'magic', bytes: [0x44, 0x50, 0x41, 0x31]}, version: {field: 'version', equals: 1}},
  windows: [{kind: 'records', name: 'outcomes', offset: 304, countField: 'capacity', recordSize: 80, maxCount: 1024}],
};

// DCR2-shaped: header + count*width output cells + ceil(count/8) bitmap bytes.
const dcr2Layout: ExternalLayoutDescriptor = {
  name: 'dcr2_results', fixedSize: 424, allocation: {kind: 'prefix', maxLength: EXTERNAL_MAX_ACCOUNT_BYTES},
  logicalSize: {base: 424, terms: [
    {kind: 'multiply', field: 'output_count', byField: 'width'},
    {kind: 'ceil_divide', field: 'output_count', by: 8},
  ]},
  fields: [
    {name: 'magic', offset: 0, type: 'bytes', length: 4},
    {name: 'version', offset: 4, type: 'u16', endian: 'little'},
    {name: 'output_count', offset: 196, type: 'u32', endian: 'little', maximum: 1024},
    {name: 'width', offset: 208, type: 'u8', minimum: 1, maximum: 64},
  ],
  checks: {magic: {field: 'magic', bytes: [0x44, 0x43, 0x52, 0x32]}, version: {field: 'version', equals: 7}},
  windows: [
    {kind: 'records', name: 'cells', offset: 424, countField: 'output_count', recordSize: {field: 'width'}, maxRecordSize: 64, maxCount: 1024, allowPrefix: true},
    {kind: 'bytes', name: 'bitmap', offset: {base: 424, terms: [{kind: 'multiply', field: 'output_count', byField: 'width'}]}, length: {base: 0, terms: [{kind: 'ceil_divide', field: 'output_count', by: 8}]}, maxLength: 128, allowPrefix: true},
  ],
};

const overflowLayout: ExternalLayoutDescriptor = {
  name: 'overflow_formula', fixedSize: 16, allocation: {kind: 'exact'},
  logicalSize: {base: 16, terms: [{kind: 'multiply', field: 'left', byField: 'right'}]},
  fields: [
    {name: 'left', offset: 0, type: 'u64', endian: 'little'},
    {name: 'right', offset: 8, type: 'u64', endian: 'little'},
  ],
};

const overlappingWindowLayout: ExternalLayoutDescriptor = {
  ...layout,
  name: 'overlap_record',
  windows: [
    {kind: 'bytes', name: 'payload', offset: {base: 64, terms: []}, length: {base: 4, terms: []}, maxLength: 16},
    {kind: 'bytes', name: 'alias', offset: {base: 66, terms: []}, length: {base: 3, terms: []}, maxLength: 16},
  ],
};

const dynamicSpanOverlapLayout: ExternalLayoutDescriptor = {
  name: 'dynamic_span_overlap', fixedSize: 18, allocation: {kind: 'prefix', maxLength: 64},
  fields: [
    {name: 'first_offset', offset: 0, type: 'u64', endian: 'little'},
    {name: 'first_length', offset: 8, type: 'u8'},
    {name: 'second_offset', offset: 9, type: 'u64', endian: 'little'},
    {name: 'second_length', offset: 17, type: 'u8'},
  ],
  windows: [
    {name: 'first', offsetField: 'first_offset', lengthField: 'first_length', maxLength: 8},
    {name: 'second', offsetField: 'second_offset', lengthField: 'second_length', maxLength: 8},
  ],
};

// Independent literal-byte fixture builders use fixed protocol offsets and expected values.
const golden = Uint8Array.from([
  0x45, 0x58, 0x56, 0x31, 0x01, 0x02, 0x00, 0x00,
  0x12, 0x34, 0x56, 0x78, 0x01, 0x02, 0x03, 0x04,
  0x05, 0x06, 0x07, 0x08,
  0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
  0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
  0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
  0xb8, 0xb9, 0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf,
  0x44, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xab, 0xcd, 0xef,
]);

function makeDpa1(): Uint8Array {
  const bytes = new Uint8Array(464);
  bytes.set([0x44, 0x50, 0x41, 0x31], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 1, true);
  view.setUint32(40, 2, true);
  view.setBigUint64(304, 0n, true);
  bytes[312] = 2;
  bytes.set([0x11, 0x22, 0x33, 0x44], 384);
  view.setBigUint64(384, 1n, true);
  bytes[392] = 3;
  bytes.set([0xaa, 0xbb, 0xcc, 0xdd], 464 - 4);
  return bytes;
}

function makeDcr2(length = 437): Uint8Array {
  const bytes = new Uint8Array(length);
  bytes.set([0x44, 0x43, 0x52, 0x32], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(4, 7, true);
  view.setUint32(196, 3, true);
  bytes[208] = 4;
  if (length >= 437) {
    bytes.set([0x10, 0x11, 0x12, 0x13, 0x20, 0x21, 0x22, 0x23, 0x30, 0x31, 0x32, 0x33], 424);
    bytes[436] = 0x05;
  } else if (length > 424) {
    for (let i = 424; i < length; i++) bytes[i] = i - 423;
  }
  return bytes;
}

function changed(mutator: (bytes: Uint8Array) => void): Uint8Array {
  const bytes = golden.slice();
  mutator(bytes);
  return bytes;
}
function reject(bytes: Uint8Array, reason: RegExp, descriptor: ExternalLayoutDescriptor = layout): void {
  assert.throws(() => readExternalLayout(bytes, descriptor), reason);
}
function invalidDescriptor(candidate: ExternalLayoutDescriptor, reason: RegExp): void {
  assert.throws(() => validateExternalLayout(candidate), reason);
}

function testTypeScriptReader(): string[] {
  const source = golden.slice();
  const view = readExternalLayout(source, layout);
  assert.equal(view.layout, 'synthetic_record');
  assert.equal(view.byteLength, 71);
  assert.equal(view.logicalSize, 71, 'legacy prefix descriptor treats supplied allocation as its logical prefix');
  assert.equal(view.fields.version, 0x0102);
  assert.equal(view.fields.count, 0x78563412);
  assert.equal(view.fields.amount, 0x0102030405060708n);
  assert.deepEqual(view.fields.magic, Uint8Array.from([0x45, 0x58, 0x56, 0x31]));
  assert.deepEqual(view.fields.key, Uint8Array.from({length: 32}, (_, i) => 0xa0 + i));
  assert.deepEqual(view.windows.payload, Uint8Array.from([0xab, 0xcd, 0xef]));
  source[0] = 0;
  source[20] = 0;
  assert.deepEqual(view.fields.magic, Uint8Array.from([0x45, 0x58, 0x56, 0x31]), 'TS fixed bytes fields are copied values');
  assert.equal((view.fields.key as Uint8Array)[0], 0xa0, 'TS key32 fields are copied values');
  source[0] = 0x45;
  source[20] = 0xa0;
  source[68] = 0;
  assert.equal(view.windows.payload[0], 0, 'bounded windows are borrowed views, not account copies');
  source[68] = 0xab;
  assert.equal(readExternalField(golden, layout, 'count'), 0x78563412);
  assert.deepEqual(readExternalWindow(golden, layout, 'payload'), Uint8Array.from([0xab, 0xcd, 0xef]));
  assert.throws(() => readExternalField(golden, layout, 'absent'), /missing field/);
  assert.throws(() => readExternalWindow(golden, layout, 'absent'), /missing window/);

  reject(changed(b => { b[0] ^= 1; }), /magic mismatch/);
  reject(changed(b => { b[5] = 3; }), /version mismatch/);
  reject(changed(b => { b[6] = 1; }), /reserved field reserved is nonzero/);
  reject(changed(b => { b[62] = 1; }), /reserved field reserved_tail is nonzero/);
  reject(golden.subarray(0, 63), /fixed header/);
  reject(changed(b => { b[60] = 17; }), /exceeds its maximum length/);
  reject(changed(b => { b[52] = 63; }), /starts inside the fixed header/);
  reject(changed(b => { b[52] = 100; }), /outside the logical record/);
  reject(changed(b => { b.fill(0xff, 52, 60); }), /exceeds the account size limit/);
  reject(golden.subarray(0, 68), /outside the logical record/);
  reject(golden, /allocation exceeds its prefix maximum/, {...layout, allocation: {kind: 'prefix', maxLength: 70}});
  assert.throws(() => readExternalLayout(null as any, layout), /input must be a Uint8Array/);
  assert.throws(() => readExternalLayout(new Uint8Array(EXTERNAL_MAX_ACCOUNT_BYTES + 1), layout), /account size limit/);

  const zeroWindow = changed(b => { b.fill(0, 52, 60); b[52] = 64; b[60] = 0; b[61] = 0; });
  const zeroInput = zeroWindow.subarray(0, 64);
  const zeroView = readExternalLayout(zeroInput, layout);
  assert.equal(zeroView.windows.payload.length, 0);
  assert.equal(zeroView.windows.payload.byteOffset, zeroInput.byteOffset + zeroInput.byteLength, 'an empty window at the accessible end stays a non-NULL empty view');
  const overlapBytes = golden.slice();
  assert.throws(() => readExternalLayout(overlapBytes, overlappingWindowLayout), /overlaps window/);
  const overlappingSpans = new Uint8Array(24);
  const overlappingSpanFields = new DataView(overlappingSpans.buffer);
  overlappingSpanFields.setBigUint64(0, 18n, true);
  overlappingSpanFields.setUint8(8, 4);
  overlappingSpanFields.setBigUint64(9, 20n, true);
  overlappingSpanFields.setUint8(17, 2);
  assert.throws(() => readExternalLayout(overlappingSpans, dynamicSpanOverlapLayout), /overlaps window/);

  assert.equal(readExternalLayout(Uint8Array.from([3]), prefixLimitLayout).logicalSize, 4, 'logical size equal to prefix maximum is accepted');
  assert.throws(() => readExternalLayout(Uint8Array.from([4]), prefixLimitLayout), /logical size exceeds its prefix maximum/);

  const exact = validateExternalLayout(exactLayout);
  assert.equal(readExternalLayout(Uint8Array.from([0x34, 0x12, 0xab, 0xcd]), exact).fields.low, 0x1234);
  assert.equal(readExternalLayout(Uint8Array.from([0x34, 0x12, 0xab, 0xcd]), exact).fields.high, 0xabcd);
  assert.throws(() => readExternalLayout(Uint8Array.from([0x34, 0x12, 0xab]), exact), /fixed header/);
  assert.throws(() => readExternalLayout(Uint8Array.from([0x34, 0x12, 0xab, 0xcd, 0]), exact), /logical size/);

  const dpa1 = makeDpa1();
  const dpaView = readExternalLayout(dpa1, dpa1Layout);
  assert.equal(dpaView.logicalSize, 464);
  assert.equal(dpaView.byteLength, 464);
  assert.equal(dpaView.records.outcomes.count, 2);
  assert.equal(dpaView.records.outcomes.logicalCount, 2);
  assert.equal(dpaView.records.outcomes.recordSize, 80);
  assert.equal(new DataView(dpaView.windows.outcomes.buffer, dpaView.windows.outcomes.byteOffset, dpaView.windows.outcomes.byteLength).getBigUint64(80, true), 1n);
  assert.equal(readExternalRecords(dpa1, dpa1Layout, 'outcomes').count, 2);
  assert.throws(() => readExternalLayout(dpa1.subarray(0, 463), dpa1Layout), /logical size/);
  const extraDpa1 = new Uint8Array(465);
  extraDpa1.set(dpa1);
  assert.throws(() => readExternalLayout(extraDpa1, dpa1Layout), /logical size/);
  const tooManyRows = dpa1.slice();
  new DataView(tooManyRows.buffer).setUint32(40, 1025, true);
  assert.throws(() => readExternalLayout(tooManyRows, dpa1Layout), /maximum/);
  const noRows = dpa1.slice();
  new DataView(noRows.buffer).setUint32(40, 0, true);
  assert.throws(() => readExternalLayout(noRows, dpa1Layout), /minimum/);

  const dcr2 = readExternalLayout(makeDcr2(), dcr2Layout);
  assert.equal(dcr2.logicalSize, 437);
  assert.equal(dcr2.windowInfo.cells.logicalLength, 12);
  assert.equal(dcr2.records.cells.count, 3);
  assert.equal(dcr2.windowInfo.bitmap.offset, 436);
  assert.deepEqual(dcr2.windows.bitmap, Uint8Array.from([0x05]));
  const grown = readExternalLayout(makeDcr2(430), dcr2Layout);
  assert.equal(grown.logicalSize, 437);
  assert.equal(grown.byteLength, 430);
  assert.equal(grown.records.cells.logicalCount, 3);
  assert.equal(grown.records.cells.count, 1, 'only a whole record in the accessible prefix is exposed');
  assert.equal(grown.records.cells.data.byteLength, 4);
  assert.equal(grown.windows.bitmap.length, 0, 'bitmap prefix is empty until its logical offset is allocated');
  assert.throws(() => readExternalLayout(makeDcr2(423), dcr2Layout), /fixed header/);
  assert.throws(() => readExternalLayout(makeDcr2(438), dcr2Layout), /exceeds its logical size/);
  assert.throws(() => readExternalLayout(makeDcr2().map((byte, index) => index === 208 ? 0 : byte), dcr2Layout), /minimum/);
  const tooManyOutputs = makeDcr2();
  new DataView(tooManyOutputs.buffer).setUint32(196, 1025, true);
  assert.throws(() => readExternalLayout(tooManyOutputs, dcr2Layout), /maximum/);

  const overflowing = new Uint8Array(16);
  const overflowView = new DataView(overflowing.buffer);
  overflowView.setBigUint64(0, 0xffff_ffff_ffff_ffffn, true);
  overflowView.setBigUint64(8, 2n, true);
  assert.throws(() => readExternalLayout(overflowing, overflowLayout), /overflows u64/);
  const tooLarge = new Uint8Array(16);
  const tooLargeView = new DataView(tooLarge.buffer);
  tooLargeView.setBigUint64(0, 10_000_000n, true);
  tooLargeView.setBigUint64(8, 2n, true);
  assert.throws(() => readExternalLayout(tooLarge, overflowLayout), /account size limit/);

  invalidDescriptor({...layout, fields: [...layout.fields, {...layout.fields[0]!}]}, /duplicate field name/);
  invalidDescriptor({...layout, fields: layout.fields.map(f => f.name === 'count' ? {...f, offset: 6} : f)}, /overlaps another fixed field/);
  invalidDescriptor({...layout, fields: layout.fields.map(f => f.name === 'count' ? {...f, offset: Number.MAX_SAFE_INTEGER + 1} : f)}, /safe integer/);
  invalidDescriptor({name: 'large_bytes', fixedSize: 1600, allocation: {kind: 'exact'}, fields: [
    {name: 'first', offset: 0, type: 'bytes', length: 800},
    {name: 'second', offset: 800, type: 'bytes', length: 800},
  ]}, /bounded byte copies exceed/);
  invalidDescriptor({...layout, fields: layout.fields.map(f => f.name === 'version' ? {...f, endian: undefined} : f)}, /requires explicit little or big endian/);
  invalidDescriptor({...layout, fields: layout.fields.map(f => f.name === 'count' ? {...f, maximum: undefined} : f)}, /maximum must be a nonnegative/);
  invalidDescriptor({...layout, checks: {...layout.checks, magic: {field: 'missing', bytes: [0x45, 0x58, 0x56, 0x31]}}}, /references missing field missing/);
  invalidDescriptor({...layout, checks: {...layout.checks, reservedZero: ['magic']}}, /cannot also be reserved-zero/);
  invalidDescriptor({...layout, windows: [{name: 'payload', offsetField: 'missing', lengthField: 'payload_length', maxLength: 16}]}, /references missing field missing/);
  invalidDescriptor({...layout, windows: [{name: 'count', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: 16}]}, /ambiguous field\/window name count/);
  invalidDescriptor({...layout, windows: [{name: 'payload', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: Number.MAX_SAFE_INTEGER + 1}]}, /safe integer/);
  invalidDescriptor({...layout, windows: [
    {name: 'payload', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: 16},
    {name: 'payload_alias', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: 16},
  ]}, /ambiguous duplicate field pair/);
  assert.throws(() => generateExternalLayoutC({...layout, windows: [
    {name: 'payload', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: 16},
    {name: 'payload_alias', offsetField: 'payload_offset', lengthField: 'payload_length', maxLength: 16},
  ]}), /ambiguous duplicate field pair/);
  invalidDescriptor({...layout, logicalSize: {base: 64, terms: [{kind: 'multiply', field: 'missing', by: 4}]}}, /missing or nonscalar field/);
  invalidDescriptor({...layout, logicalSize: {base: 64, terms: [{kind: 'multiply', field: 'count', by: 2, typo: true} as any]}}, /unknown property/);
  invalidDescriptor({...layout, logicalSize: {base: 64, terms: [{kind: 'multiply', field: 'count', by: 2, byField: undefined} as any]}}, /exactly one of by or byField/);
  invalidDescriptor({...layout, logicalSize: {base: 64, terms: Array(1) as any}}, /holes/);
  invalidDescriptor({...layout, windows: [{kind: 'records', name: 'rows', offset: 64, countField: 'count', recordSize: 8, maxCount: 16}]}, /must declare maximum/);
  for (const checks of [{magic: null}, {version: false}, {reservedZero: null}, {reservedZeros: ['reserved']}, {magic: {field: 'magic', bytes: Array(4)}}]) {
    assert.throws(() => validateExternalLayout({...layout, checks} as any), /external layout:/);
    assert.throws(() => generateExternalLayoutC({...layout, checks} as any), /external layout:/);
  }
  invalidDescriptor({...layout, fields: Array(1)}, /holes/);
  invalidDescriptor({...layout, windows: Array(1)}, /holes/);
  assert.throws(() => validateExternalLayout({...layout, windows: null} as any), /windows must contain/);
  assert.throws(() => validateExternalLayout({...exactLayout, allocation: {kind: 'exact', maxLength: 8}} as any), /must not specify/);
  assert.throws(() => validateExternalLayout({...layout, windows: undefined} as any), /windows must not be undefined/);
  assert.throws(() => validateExternalLayout({...layout, checks: {magic: undefined}} as any), /checks.magic must not be undefined/);
  let accessed = false;
  const accessor = {...layout, get checks() { accessed = true; return {}; }};
  assert.throws(() => validateExternalLayout(accessor), /accessor/);
  assert.equal(accessed, false, 'reject accessors before evaluating them');
  let termAccessed = false;
  const term = {get kind() { termAccessed = true; return 'multiply'; }, field: 'count', by: 2};
  assert.throws(() => validateExternalLayout({...layout, logicalSize: {base: 64, terms: [term] as any}}), /accessor/);
  assert.equal(termAccessed, false, 'reject formula accessors before evaluating them');
  let allocationKindReads = 0;
  const alternatingAllocation = new Proxy({kind: 'exact'}, {
    get(target, key, receiver) {
      if (key === 'kind') return ++allocationKindReads === 1 ? 'exact' : 'prefix';
      return Reflect.get(target, key, receiver);
    },
  });
  assert.throws(() => validateExternalLayout({...dcr2Layout, allocation: alternatingAllocation as any}), /prefix access requires prefix allocation/);
  assert.throws(() => validateExternalLayout({...layout, name: 'bad', extra: true} as any), /unknown property/);

  return [
    'typescript-known-endian-borrowed-windows-and-copied-fixed-byte-fields', 'typescript-magic-version-reserved-rejection',
    'typescript-exact-allocation', 'typescript-dpa1-exact-capacity-rows', 'typescript-dcr2-logical-size-and-prefix-grown-rows-bitmap',
    'typescript-checked-u64-account-size-and-prefix-maximum-boundaries', 'typescript-truncated-header-and-required-window-rejection',
    'typescript-empty-end-window-and-header-driven-overlap-rejection', 'typescript-duplicate-span-pair-and-proxy-allocation-rejection',
    'typescript-null-input-large-allocation-typo-sparse-and-accessor-rejection',
  ];
}

const cHarness = `#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <stdlib.h>
#include "synthetic-generated.c"
#include "exact-generated.c"
#include "overlap-generated.c"
#include "dpa1-generated.c"
#include "dcr2-generated.c"
#include "overflow-generated.c"
#include "prefix-limit-generated.c"
#include "dynamic-span-overlap-generated.c"

static const uint8_t golden_bytes[71] = {
  0x45,0x58,0x56,0x31,0x01,0x02,0x00,0x00,
  0x12,0x34,0x56,0x78,0x01,0x02,0x03,0x04,
  0x05,0x06,0x07,0x08,
  0xa0,0xa1,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,
  0xa8,0xa9,0xaa,0xab,0xac,0xad,0xae,0xaf,
  0xb0,0xb1,0xb2,0xb3,0xb4,0xb5,0xb6,0xb7,
  0xb8,0xb9,0xba,0xbb,0xbc,0xbd,0xbe,0xbf,
  0x44,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0x03,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
  0xab,0xcd,0xef
};

static int rejected_without_mutating(const uint8_t *input, size_t length) {
  struct bend_external_synthetic_record_view output, before;
  memset(&output, 0xa5, sizeof(output)); memcpy(&before, &output, sizeof(output));
  if (bend_external_synthetic_record_read(input, length, &output)) return 1;
  return memcmp(&output, &before, sizeof(output)) == 0 ? 0 : 2;
}

static int dpa1_rejected_without_mutating(const uint8_t *input, size_t length) {
  struct bend_external_dpa1_facts_view output, before;
  memset(&output, 0xa5, sizeof(output)); memcpy(&before, &output, sizeof(output));
  if (bend_external_dpa1_facts_read(input, length, &output)) return 1;
  return memcmp(&output, &before, sizeof(output)) == 0 ? 0 : 2;
}

static int dcr2_rejected_without_mutating(const uint8_t *input, size_t length) {
  struct bend_external_dcr2_results_view output, before;
  memset(&output, 0xa5, sizeof(output)); memcpy(&before, &output, sizeof(output));
  if (bend_external_dcr2_results_read(input, length, &output)) return 1;
  return memcmp(&output, &before, sizeof(output)) == 0 ? 0 : 2;
}

static int overflow_rejected_without_mutating(const uint8_t *input, size_t length) {
  struct bend_external_overflow_formula_view output, before;
  memset(&output, 0xa5, sizeof(output)); memcpy(&before, &output, sizeof(output));
  if (bend_external_overflow_formula_read(input, length, &output)) return 1;
  return memcmp(&output, &before, sizeof(output)) == 0 ? 0 : 2;
}

static int prefix_limit_rejected_without_mutating(const uint8_t *input, size_t length) {
  struct bend_external_prefix_limit_view output, before;
  memset(&output, 0xa5, sizeof(output)); memcpy(&before, &output, sizeof(output));
  if (bend_external_prefix_limit_read(input, length, &output)) return 1;
  return memcmp(&output, &before, sizeof(output)) == 0 ? 0 : 2;
}

static int dynamic_span_overlap_rejected_without_mutating(const uint8_t *input, size_t length) {
  struct bend_external_dynamic_span_overlap_view output, before;
  memset(&output, 0xa5, sizeof(output)); memcpy(&before, &output, sizeof(output));
  if (bend_external_dynamic_span_overlap_read(input, length, &output)) return 1;
  return memcmp(&output, &before, sizeof(output)) == 0 ? 0 : 2;
}

int main(void) {
  _Static_assert(sizeof(struct bend_external_synthetic_record_view) < 4096, "reader view fits the documented SBF stack frame bound");
  _Static_assert(sizeof(struct bend_external_dpa1_facts_view) < 4096, "DPA1 reader view is fixed-size");
  _Static_assert(sizeof(struct bend_external_dcr2_results_view) < 4096, "DCR2 reader view is fixed-size");
  struct bend_external_synthetic_record_view output;
  if (!bend_external_synthetic_record_read(golden_bytes, sizeof(golden_bytes), &output)) return 1;
  if (output.field_version != 0x0102 || output.field_count != UINT32_C(0x78563412)) return 2;
  if (output.field_amount != UINT64_C(0x0102030405060708)) return 3;
  if (output.field_magic.data != golden_bytes || output.field_reserved.data != golden_bytes + 6) return 31;
  if (output.field_key.length != 32 || output.field_key.data != golden_bytes + 20) return 4;
  if (output.window_payload.length != 3 || output.window_payload.data != golden_bytes + 68) return 5;
  if (output.window_payload.data[0] != 0xab || output.window_payload.data[1] != 0xcd || output.window_payload.data[2] != 0xef) return 6;
  uint8_t bad[sizeof(golden_bytes)];
  memcpy(bad, golden_bytes, sizeof(bad)); bad[0] ^= 1;
  if (rejected_without_mutating(bad, sizeof(bad))) return 7;
  memcpy(bad, golden_bytes, sizeof(bad)); bad[4] ^= 1;
  if (rejected_without_mutating(bad, sizeof(bad))) return 71;
  memcpy(bad, golden_bytes, sizeof(bad)); bad[6] = 1;
  if (rejected_without_mutating(bad, sizeof(bad))) return 72;
  memcpy(bad, golden_bytes, sizeof(bad)); bad[62] = 1;
  if (rejected_without_mutating(bad, sizeof(bad))) return 73;
  memcpy(bad, golden_bytes, sizeof(bad)); bad[60] = 17;
  if (rejected_without_mutating(bad, sizeof(bad))) return 8;
  memcpy(bad, golden_bytes, sizeof(bad)); bad[52] = 63;
  if (rejected_without_mutating(bad, sizeof(bad))) return 81;
  memcpy(bad, golden_bytes, sizeof(bad)); bad[52] = 100;
  if (rejected_without_mutating(bad, sizeof(bad))) return 82;
  memcpy(bad, golden_bytes, sizeof(bad)); memset(bad + 52, 0xff, 8);
  if (rejected_without_mutating(bad, sizeof(bad))) return 83;
  if (rejected_without_mutating(golden_bytes, 63)) return 9;
  if (rejected_without_mutating(golden_bytes, 68)) return 92;
  if (rejected_without_mutating(golden_bytes, BEND_EXTERNAL_MAX_ACCOUNT_BYTES + 1)) return 95;
  if (rejected_without_mutating(golden_bytes, SIZE_MAX)) return 96;
  if ((uint64_t)SIZE_MAX >= UINT64_C(9007199254740992) &&
      rejected_without_mutating(golden_bytes, (size_t)UINT64_C(9007199254740992))) return 97;
  struct bend_external_synthetic_record_view untouched, untouched_before;
  memset(&untouched, 0xa5, sizeof(untouched)); memcpy(&untouched_before, &untouched, sizeof(untouched));
  if (bend_external_synthetic_record_read(NULL, sizeof(golden_bytes), &untouched)) return 98;
  if (memcmp(&untouched, &untouched_before, sizeof(untouched))) return 99;
  if (bend_external_synthetic_record_read(golden_bytes, sizeof(golden_bytes), NULL)) return 100;

  /* The fixed byte fields borrow input too; a later write changes what a C view reads. */
  uint8_t mutable_golden[sizeof(golden_bytes)]; memcpy(mutable_golden, golden_bytes, sizeof(mutable_golden));
  struct bend_external_synthetic_record_view mutable_view;
  if (!bend_external_synthetic_record_read(mutable_golden, sizeof(mutable_golden), &mutable_view)) return 101;
  mutable_golden[20] = 0;
  if (mutable_view.field_key.data[0] != 0) return 102;

  /* Adjacent input/output ranges are disjoint and remain accepted. */
  union adjacent_storage { max_align_t alignment; uint8_t bytes[256]; } adjacent = {0};
  uint8_t *adjacent_input = adjacent.bytes + 1;
  struct bend_external_synthetic_record_view *adjacent_output =
    (struct bend_external_synthetic_record_view *)(void *)(adjacent.bytes + 72);
  memcpy(adjacent_input, golden_bytes, sizeof(golden_bytes));
  if (!bend_external_synthetic_record_read(adjacent_input, sizeof(golden_bytes), adjacent_output)) return 103;
  if (adjacent_output->window_payload.data != adjacent_input + 68) return 104;

  /* Empty non-NULL window at the accessible end is a valid one-past-end view. */
  uint8_t empty_end[64]; memcpy(empty_end, golden_bytes, sizeof(empty_end));
  memset(empty_end + 52, 0, 8); empty_end[52] = 64;
  empty_end[60] = 0; empty_end[61] = 0;
  struct bend_external_synthetic_record_view empty_view;
  if (!bend_external_synthetic_record_read(empty_end, sizeof(empty_end), &empty_view)) return 105;
  if (empty_view.window_payload.length != 0 || empty_view.window_payload.data != empty_end + sizeof(empty_end)) return 106;
  union alias_buffer { struct bend_external_synthetic_record_view view; uint8_t bytes[256]; } aliased = {0};
  memcpy(aliased.bytes, golden_bytes, sizeof(golden_bytes));
  union alias_buffer aliased_before = aliased;
  if (bend_external_synthetic_record_read(aliased.bytes, sizeof(golden_bytes), &aliased.view)) return 93;
  if (memcmp(&aliased, &aliased_before, sizeof(aliased))) return 94;
  struct bend_external_overlap_record_view overlap, overlap_before;
  memset(&overlap, 0xa5, sizeof(overlap)); memcpy(&overlap_before, &overlap, sizeof(overlap));
  if (bend_external_overlap_record_read(golden_bytes, sizeof(golden_bytes), &overlap)) return 90;
  if (memcmp(&overlap, &overlap_before, sizeof(overlap))) return 91;
  uint8_t dynamic_overlap[24] = {0};
  dynamic_overlap[0] = 18; dynamic_overlap[8] = 4;
  dynamic_overlap[9] = 20; dynamic_overlap[17] = 2;
  if (dynamic_span_overlap_rejected_without_mutating(dynamic_overlap, sizeof(dynamic_overlap))) return 107;

  uint8_t dpa1[464] = {0};
  dpa1[0] = 0x44; dpa1[1] = 0x50; dpa1[2] = 0x41; dpa1[3] = 0x31;
  dpa1[4] = 1; dpa1[40] = 2;
  dpa1[312] = 2; dpa1[384] = 0x11; dpa1[385] = 0x22; dpa1[386] = 0x33; dpa1[387] = 0x44;
  dpa1[384] = 1; dpa1[392] = 3; dpa1[460] = 0xaa; dpa1[461] = 0xbb; dpa1[462] = 0xcc; dpa1[463] = 0xdd;
  struct bend_external_dpa1_facts_view facts;
  if (!bend_external_dpa1_facts_read(dpa1, sizeof(dpa1), &facts)) return 10;
  if (facts.logical_size != 464 || facts.accessible_size != 464) return 11;
  if (facts.window_outcomes.count != 2 || facts.window_outcomes.logical_count != 2 || facts.window_outcomes.record_size != 80 || facts.window_outcomes.length != 160) return 12;
  if (facts.window_outcomes.data != dpa1 + 304 || facts.window_outcomes.data[88] != 3) return 13;
  if (dpa1_rejected_without_mutating(dpa1, sizeof(dpa1) - 1)) return 14;
  uint8_t wrong_capacity[464]; memcpy(wrong_capacity, dpa1, sizeof(wrong_capacity)); wrong_capacity[40] = 3;
  if (dpa1_rejected_without_mutating(wrong_capacity, sizeof(wrong_capacity))) return 15;
  uint8_t zero_capacity[464]; memcpy(zero_capacity, dpa1, sizeof(zero_capacity)); zero_capacity[40] = 0;
  if (dpa1_rejected_without_mutating(zero_capacity, sizeof(zero_capacity))) return 16;

  uint8_t dcr2[437] = {0};
  dcr2[0] = 0x44; dcr2[1] = 0x43; dcr2[2] = 0x52; dcr2[3] = 0x32; dcr2[4] = 7;
  dcr2[196] = 3; dcr2[208] = 4;
  for (size_t i = 0; i < 12; i++) dcr2[424 + i] = (uint8_t)(0x10 + i);
  dcr2[436] = 0x05;
  struct bend_external_dcr2_results_view result;
  if (!bend_external_dcr2_results_read(dcr2, sizeof(dcr2), &result)) return 20;
  if (result.logical_size != 437 || result.accessible_size != 437 || result.window_cells.count != 3 || result.window_cells.logical_count != 3 || result.window_cells.record_size != 4) return 21;
  if (result.window_bitmap.length != 1 || result.window_bitmap.logical_length != 1 || result.window_bitmap.data != dcr2 + 436 || result.window_bitmap.data[0] != 0x05) return 22;
  if (!bend_external_dcr2_results_read(dcr2, 430, &result)) return 23;
  if (result.logical_size != 437 || result.window_cells.count != 1 || result.window_cells.length != 4 || result.window_cells.logical_count != 3) return 24;
  if (result.window_bitmap.length != 0 || result.window_bitmap.data != NULL) return 25;
  if (dcr2_rejected_without_mutating(dcr2, 423)) return 26;
  if (dcr2_rejected_without_mutating(dcr2, 438)) return 27;
  uint8_t too_wide[437]; memcpy(too_wide, dcr2, sizeof(too_wide)); too_wide[208] = 0;
  if (dcr2_rejected_without_mutating(too_wide, sizeof(too_wide))) return 28;

  uint8_t overflow[16]; memset(overflow, 0xff, sizeof(overflow));
  if (overflow_rejected_without_mutating(overflow, sizeof(overflow))) return 30;
  memset(overflow, 0, sizeof(overflow)); overflow[0] = 0x80; overflow[8] = 0x02;
  if (overflow_rejected_without_mutating(overflow, sizeof(overflow))) return 31;
  memset(overflow, 0, sizeof(overflow)); overflow[0] = 0x80; overflow[0 + 1] = 0x96; overflow[0 + 2] = 0x98; overflow[8] = 0x02;
  if (overflow_rejected_without_mutating(overflow, sizeof(overflow))) return 32;

  uint8_t prefix_limit[1] = {3};
  struct bend_external_prefix_limit_view prefix_view;
  if (!bend_external_prefix_limit_read(prefix_limit, sizeof(prefix_limit), &prefix_view)) return 33;
  if (prefix_view.logical_size != 4 || prefix_view.accessible_size != 1) return 34;
  prefix_limit[0] = 4;
  if (prefix_limit_rejected_without_mutating(prefix_limit, sizeof(prefix_limit))) return 35;

  /* A large account allocation is borrowed; the bounded window stays small. */
  size_t large_length = BEND_EXTERNAL_MAX_ACCOUNT_BYTES;
  uint8_t *large = calloc(large_length, 1);
  if (!large) return 40;
  memcpy(large, golden_bytes, sizeof(golden_bytes));
  if (!bend_external_synthetic_record_read(large, large_length, &output)) return 41;
  if (output.window_payload.data != large + 68 || output.window_payload.length != 3) return 42;
  if (memcmp(large, golden_bytes, sizeof(golden_bytes))) return 43;
  free(large);

  const uint8_t exact_bytes[4] = {0x34,0x12,0xab,0xcd};
  struct bend_external_exact_word_view exact;
  if (!bend_external_exact_word_read(exact_bytes, 4, &exact)) return 50;
  if (exact.field_low != 0x1234 || exact.field_high != 0xabcd) return 51;
  struct bend_external_exact_word_view before;
  memset(&exact, 0xa5, sizeof(exact)); memcpy(&before, &exact, sizeof(exact));
  if (bend_external_exact_word_read(exact_bytes, 3, &exact)) return 52;
  if (memcmp(&exact, &before, sizeof(exact))) return 53;
  if (bend_external_exact_word_read(exact_bytes, 5, &exact)) return 54;
  if (memcmp(&exact, &before, sizeof(exact))) return 55;
  return 0;
}
`;

type ToolInfo = {
  selectedExecutable: string;
  executable: string;
  sha256: string;
  version: string;
};

function executablePath(command: string, env: NodeJS.ProcessEnv = process.env): string {
  const candidates = command.includes(path.sep)
    ? [path.resolve(command)]
    : (env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error(`required executable not found or not executable: ${command}`);
}

function toolVersion(executable: string, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(executable, ['--version'], {encoding: 'utf8', timeout: 30_000, env});
  assert.ifError(result.error);
  assert.equal(result.status, 0, `${executable} --version failed: ${result.stderr}`);
  return (result.stdout || result.stderr).trim();
}

function toolInfo(executable: string, knownVersion?: string, env: NodeJS.ProcessEnv = process.env): ToolInfo {
  const actualExecutable = fs.realpathSync(executable);
  return {
    selectedExecutable: executable,
    executable: actualExecutable,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(actualExecutable)).digest('hex'),
    version: knownVersion ?? toolVersion(executable, env),
  };
}

function rustToolInfo(command: string, tool: 'cargo' | 'rustc', env: NodeJS.ProcessEnv): ToolInfo {
  const selectedExecutable = executablePath(command, env);
  let actualExecutable = fs.realpathSync(selectedExecutable);
  if (path.basename(actualExecutable) === 'rustup') {
    const rustup = executablePath(env.RUSTUP ?? 'rustup', env);
    const result = spawnSync(rustup, ['which', tool], {encoding: 'utf8', timeout: 30_000, env});
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${rustup} which ${tool} failed: ${result.stderr}`);
    const resolved = (result.stdout ?? '').trim();
    assert(resolved.length > 0, `rustup which ${tool} returned no executable`);
    actualExecutable = fs.realpathSync(path.resolve(resolved));
  }
  assert(fs.statSync(actualExecutable).isFile(), `resolved ${tool} binary is not a file: ${actualExecutable}`);
  fs.accessSync(actualExecutable, fs.constants.X_OK);
  return {
    selectedExecutable,
    executable: actualExecutable,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(actualExecutable)).digest('hex'),
    version: toolVersion(actualExecutable, env),
  };
}

function sha256(bytes: Uint8Array): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function hashFile(file: string): string {
  return sha256(fs.readFileSync(file));
}

function hashFiles(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map(file => [file, hashFile(file)]));
}

type EnvironmentReceipt = {
  scope: 'selected-variable-presence-only';
  sha256: string;
  values: Record<string, {redacted: true}>;
};

// Record build-variable presence, never arbitrary environment values or hashes
// of secrets. This digest binds only the sanitized presence map, not the full
// build environment. Tool binaries and artifacts are bound separately.
export function environmentReceipt(env: NodeJS.ProcessEnv): EnvironmentReceipt {
  const names = [
    'CARGO', 'CARGO_HOME', 'CARGO_TARGET_DIR', 'CC', 'RUSTC',
    'RUSTC_WORKSPACE_WRAPPER', 'RUSTC_WRAPPER', 'RUSTFLAGS',
    'CARGO_ENCODED_RUSTFLAGS', 'RUSTUP_HOME', 'RUSTUP_TOOLCHAIN', 'SBF_TOOLS',
  ];
  const values = Object.fromEntries(names.filter(name => env[name] !== undefined)
    .sort().map(name => [name, {redacted: true as const}]));
  return {scope: 'selected-variable-presence-only', sha256: sha256(Buffer.from(JSON.stringify(values))), values};
}

function testGeneratedC(): {cases: string[]; compiler: ToolInfo; command: string[]} {
  fs.mkdirSync('build', {recursive: true});
  fs.writeFileSync('build/synthetic-generated.c', generateExternalLayoutC(layout));
  fs.writeFileSync('build/exact-generated.c', generateExternalLayoutC(exactLayout));
  fs.writeFileSync('build/overlap-generated.c', generateExternalLayoutC(overlappingWindowLayout));
  fs.writeFileSync('build/prefix-limit-generated.c', generateExternalLayoutC(prefixLimitLayout));
  fs.writeFileSync('build/dynamic-span-overlap-generated.c', generateExternalLayoutC(dynamicSpanOverlapLayout));
  fs.writeFileSync('build/dpa1-generated.c', generateExternalLayoutC(dpa1Layout));
  fs.writeFileSync('build/dcr2-generated.c', generateExternalLayoutC(dcr2Layout));
  fs.writeFileSync('build/overflow-generated.c', generateExternalLayoutC(overflowLayout));
  fs.writeFileSync('build/external-layout-harness.c', cHarness);
  const compiler = process.env.CC ?? 'clang';
  const compilerPath = executablePath(compiler);
  const compilerVersion = toolVersion(compilerPath);
  const command = [
    '-std=c17', '-O1', '-Wall', '-Wextra', '-Werror',
    '-fsanitize=address,undefined', '-fno-sanitize-recover=all',
    '-Iruntime', 'build/external-layout-harness.c', '-o', 'build/external-layout-harness',
  ];
  const compile = spawnSync(compilerPath, [
    ...command,
  ], {encoding: 'utf8', timeout: 60_000});
  fs.writeFileSync('build/external-layout-native-compile.log', `${compile.stdout ?? ''}${compile.stderr ?? ''}`);
  assert.ifError(compile.error);
  assert.equal(compile.status, 0, `${compile.stdout}\n${compile.stderr}`);
  const run = spawnSync(path.resolve('build/external-layout-harness'), [], {encoding: 'utf8', timeout: 60_000});
  fs.writeFileSync('build/external-layout-native-run.log', `${run.stdout ?? ''}${run.stderr ?? ''}`);
  assert.ifError(run.error);
  assert.equal(run.status, 0, `generated C sanitizer harness exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  return {
    compiler: toolInfo(compilerPath, compilerVersion), command,
    cases: [
      'c-known-endian-and-fixed-fields', 'c-dpa1-exact-capacity-rows',
      'c-dcr2-logical-size-and-prefix-grown-rows-bitmap', 'c-u64-and-account-size-overflow-rejection-no-output-mutation',
      'c-magic-version-both-reserved-fields-truncated-header-invalid-window-offset-and-0xff-u64-span-rejection-no-output-mutation',
      'c-null-input-output-large-length-2^53-and-size-max-refusal-no-output-mutation',
      'c-input-output-alias-rejection-and-adjacent-range-acceptance',
      'c-nonnull-empty-end-window-and-header-driven-overlap-rejection-no-output-mutation',
      'c-prefix-logical-size-maximum-boundary', 'c-large-account-borrowed-small-window', 'c-exact-allocation',
    ],
  };
}

function testGeneratedSbf(): {cases: string[]; tools: string; version: string} {
  const {tools, version} = compileSbf('tests/external-layout/sbf-entry.c', 'build/external-layout-sbf');
  return {tools, version: version.split('\n')[0]!, cases: ['sbf-reader-compiled-with-pinned-anza-toolchain', 'sbf-stack-frame-report-generated']};
}

type LiteSvmResult = {
  cargo: ToolInfo;
  rustc: ToolInfo;
  command: string[];
  cwd: string;
  environment: EnvironmentReceipt;
  targetDirectory: string;
  exitStatus: number;
  testResult: string;
  testExecutable: {path: string; sha256: string};
  inputElfSha256: string;
  outputElfSha256: string;
  protectedSbfArtifactsBefore: Record<string, string>;
  protectedSbfArtifactsAfter: Record<string, string>;
  tests: string[];
  cargoLogSha256: string;
};

function cargoTestExecutable(stdout: string): string {
  const executables: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try {
      const event = JSON.parse(line) as {reason?: string; target?: {name?: string; test?: boolean}; executable?: string | null};
      if (event.reason === 'compiler-artifact' && event.target?.name === 'external-layout-sbf' && event.target.test && event.executable) {
        executables.push(event.executable);
      }
    } catch {}
  }
  assert.equal(executables.length, 1, `expected exactly one Cargo JSON test executable for external-layout-sbf, got ${executables.length}`);
  return path.resolve(executables[0]!);
}

function testLiteSvm(): LiteSvmResult {
  const cargo = rustToolInfo(process.env.CARGO ?? 'cargo', 'cargo', process.env);
  const rustc = rustToolInfo(process.env.RUSTC ?? 'rustc', 'rustc', process.env);
  const command = ['test', '--locked', '--offline', '--message-format=json-render-diagnostics', '--test', 'external-layout-sbf', '--', '--nocapture'];
  const targetDirectory = path.resolve(process.env.CARGO_TARGET_DIR ?? 'target');
  const cargoEnvironment = {
    ...process.env,
    ...(process.env.CARGO_TARGET_DIR === undefined ? {CARGO_TARGET_DIR: targetDirectory} : {}),
  };
  const environment = environmentReceipt(cargoEnvironment);
  const protectedSbfArtifactNames = [
    'build/external-layout-sbf.o', 'build/external-layout-sbf.memory.o',
    'build/external-layout-sbf.so', 'build/external-layout-sbf.stack.json',
  ];
  const protectedSbfArtifactsBefore = hashFiles(protectedSbfArtifactNames);
  const inputElfSha256 = protectedSbfArtifactsBefore['build/external-layout-sbf.so']!;
  const run = spawnSync(cargo.selectedExecutable, command, {
    encoding: 'utf8', timeout: 1_200_000, maxBuffer: 64 * 1024 * 1024,
    env: cargoEnvironment,
  });
  const output = [
    `cwd: ${process.cwd()}`,
    `command: ${JSON.stringify([cargo.selectedExecutable, ...command])}`,
    `environmentReceiptScope: ${environment.scope}`,
    `sanitizedEnvironmentPresenceSha256: ${environment.sha256}`,
    `environment: ${JSON.stringify(environment.values)}`,
    `selectedCargo: ${JSON.stringify(cargo)}`,
    `selectedRustc: ${JSON.stringify(rustc)}`,
    `targetDirectory: ${targetDirectory}`,
    `inputElfSha256: ${inputElfSha256}`,
    run.error ? `spawn error: ${run.error}` : '',
    run.stdout ?? '', run.stderr ?? '',
  ].filter(Boolean).join('\n');
  fs.writeFileSync('build/external-layout-cargo.log', output);
  assert.ifError(run.error);
  assert.equal(run.status, 0, `focused LiteSVM test failed\n${output}`);
  assert.match(output, /test result: ok\. 1 passed; 0 failed;/, 'focused LiteSVM target must run exactly one passing test');
  const testResult = output.match(/test result: ok\. \d+ passed; \d+ failed; \d+ ignored; \d+ measured; \d+ filtered out/);
  assert(testResult, 'focused LiteSVM test result line is required in the receipt');
  const executablePath = cargoTestExecutable(run.stdout ?? '');
  assert(fs.statSync(executablePath).isFile(), `Cargo test executable is missing: ${executablePath}`);
  const testExecutable = {path: executablePath, sha256: hashFile(executablePath)};
  const protectedSbfArtifactsAfter = hashFiles(protectedSbfArtifactNames);
  assert.deepEqual(protectedSbfArtifactsAfter, protectedSbfArtifactsBefore, 'an SBF object, ELF or stack report changed during LiteSVM execution');
  const outputElfSha256 = protectedSbfArtifactsAfter['build/external-layout-sbf.so']!;
  assert.equal(outputElfSha256, inputElfSha256, 'SBF ELF changed during LiteSVM execution');
  return {
    cargo, rustc, command, cwd: process.cwd(), environment, targetDirectory, exitStatus: run.status!, testResult: testResult[0], testExecutable,
    inputElfSha256, outputElfSha256, protectedSbfArtifactsBefore, protectedSbfArtifactsAfter,
    tests: [
      'synthetic-borrowed-window-1mib', 'dpa1-exact-1024-row-window',
      'dcr2-prefix-430-of-437-whole-records-and-empty-bitmap',
      'reject-dcr2-extra-byte-custom-4-with-account-unchanged',
      'reject-dpa1-truncated-exact-allocation-custom-3-with-account-unchanged',
      'reject-dpa1-capacity-1025-custom-3-with-account-unchanged',
      'synthetic-allocation-10mib-accepted', 'reject-synthetic-70-byte-truncated-window-custom-5-with-account-unchanged',
    ],
    cargoLogSha256: hashFile('build/external-layout-cargo.log'),
  };
}

function inputHashes(files: readonly string[]): Record<string, string> {
  return Object.fromEntries(files.map(file => [file,
    crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
}

function retirePriorReport(reportPath: string): {path: string; sha256: string} | null {
  if (!fs.existsSync(reportPath)) return null;
  const quarantinePath = `${reportPath}.${process.pid}.${crypto.randomUUID()}.quarantine`;
  fs.renameSync(reportPath, quarantinePath);
  try {
    const contents = fs.readFileSync(quarantinePath);
    const digest = sha256(contents);
    const archivePath = path.join(path.dirname(reportPath), 'external-layout-reports', `${digest}.json`);
    fs.mkdirSync(path.dirname(archivePath), {recursive: true});
    if (fs.existsSync(archivePath)) {
      assert.deepEqual(fs.readFileSync(archivePath), contents, `existing evidence archive differs at ${archivePath}`);
    } else {
      fs.writeFileSync(archivePath, contents, {flag: 'wx'});
    }
    assert.deepEqual(fs.readFileSync(archivePath), contents, `archived evidence bytes differ at ${archivePath}`);
    fs.unlinkSync(quarantinePath);
    return {path: archivePath, sha256: digest};
  } catch (error) {
    throw new Error(`failed to archive previous external-layout report; original bytes remain at ${quarantinePath}`, {cause: error});
  }
}

function publishReport(reportPath: string, report: unknown): void {
  const temporaryPath = `${reportPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporaryPath, reportPath);
  } catch (error) {
    fs.rmSync(temporaryPath, {force: true});
    throw error;
  }
}

export function testExternalLayout(): void {
  fs.mkdirSync('build', {recursive: true});
  const reportPath = 'build/external-layout-report.json';
  const priorReport = retirePriorReport(reportPath);
  const sources = [
    'Cargo.toml', 'Cargo.lock', 'docs/external-layout.md', 'scripts/build.ts', 'compiler/diagnostics.ts',
    'compiler/external-layout.ts', 'sdk/external-layout.ts', 'runtime/bend_external_view.h',
    'runtime/solana_min.h', 'runtime/memory.c', 'runtime/sbf.ld',
    'tests/external-layout.ts', 'tests/external-layout-receipt.ts', 'tests/external-layout-sbf.rs', 'tests/external-layout/sbf-entry.c',
  ];
  const inputsBefore = inputHashes(sources);
  const bunExecutable = fs.realpathSync(process.execPath);
  const bun = toolInfo(bunExecutable);
  const typescript = testTypeScriptReader();
  const c = testGeneratedC();
  const sbf = testGeneratedSbf();
  const artifactNames = [
    'build/synthetic-generated.c', 'build/exact-generated.c', 'build/overlap-generated.c',
    'build/prefix-limit-generated.c', 'build/dynamic-span-overlap-generated.c',
    'build/dpa1-generated.c', 'build/dcr2-generated.c', 'build/overflow-generated.c',
    'build/external-layout-harness.c', 'build/external-layout-harness',
    'build/external-layout-native-compile.log', 'build/external-layout-native-run.log',
    'build/external-layout-sbf.o', 'build/external-layout-sbf.memory.o',
    'build/external-layout-sbf.so', 'build/external-layout-sbf.stack.json',
  ];
  const artifactsBeforeRuntime = hashFiles(artifactNames);
  const liteSvm = import.meta.main ? testLiteSvm() : undefined;
  const inputsAfter = inputHashes(sources);
  assert.deepEqual(inputsAfter, inputsBefore, 'an external-layout source, build, runtime, lock, or documentation input changed during checks');
  const artifactsAfterRuntime = hashFiles(artifactNames);
  assert.deepEqual(artifactsAfterRuntime, artifactsBeforeRuntime, 'a generated reader, native harness, SBF artifact or stack report changed during runtime execution');
  const sbfCompiler = toolInfo(executablePath(path.join(sbf.tools, 'clang')), sbf.version);
  const sbfLinker = toolInfo(executablePath(path.join(sbf.tools, 'ld.lld')));
  const sbfReadelf = toolInfo(executablePath(path.join(sbf.tools, 'llvm-readelf')));
  const layouts = [layout, exactLayout, prefixLimitLayout, dpa1Layout, dcr2Layout, overflowLayout, overlappingWindowLayout, dynamicSpanOverlapLayout]
    .map(descriptor => ({name: descriptor.name, descriptor}));
  const report = {
    format: 'bend.external-layout.tests/v4',
    passed: true,
    execution: {
      scope: 'TypeScript, native generated C sanitizer, generated SBF compile checks, and separately recorded runtime execution',
      runtime: liteSvm
        ? {executed: true, deferred: false, engine: 'LiteSVM'}
        : {executed: false, deferred: true, reason: 'imported testExternalLayout defers runtime to the root cargo test --test sbf route through the registered external_layout_sbf module'},
    },
    scope: {
      reader: 'standalone TypeScript/native generated C and generated SBF compile checks; runtime is recorded separately for the focused or imported route',
      bendIntegration: 'not implemented; no external borrowed value or proof-gate changes',
      accountAuthorization: 'not tested; no Solana account handler in this slice',
      handlerLogic: 'not tested; layouts are generic synthetic DCG-shaped fixtures',
      rustBridge: 'not implemented; no generated Rust reader or Rust-to-Bend bridge exists',
    },
    inputs: {before: inputsBefore, after: inputsAfter, unchanged: true},
    priorReport,
    artifacts: {...artifactsAfterRuntime, ...(liteSvm ? {'build/external-layout-cargo.log': hashFile('build/external-layout-cargo.log')} : {})},
    layouts,
    bounds: {maxAccountBytes: EXTERNAL_MAX_ACCOUNT_BYTES, maxCopiedFieldBytes: 1536, borrowedWindows: true},
    typescript: {passed: typescript.length, cases: typescript},
    generatedC: {
      passed: c.cases.length, cases: c.cases,
      command: [c.compiler.executable, ...c.command],
      compiler: c.compiler,
      sanitizers: ['address', 'undefined'],
    },
    generatedSbf: {
      compiled: true,
      compiler: sbfCompiler,
      linker: sbfLinker,
      readelf: sbfReadelf,
      stack: JSON.parse(fs.readFileSync('build/external-layout-sbf.stack.json', 'utf8')),
      compileChecks: sbf.cases,
      runtime: liteSvm ? {
        executed: true,
        deferred: false,
        engine: 'LiteSVM',
        cargo: liteSvm.cargo,
        rustc: liteSvm.rustc,
        command: liteSvm.command,
        commandLine: [liteSvm.cargo.selectedExecutable, ...liteSvm.command],
        cwd: liteSvm.cwd,
        environment: liteSvm.environment,
        targetDirectory: liteSvm.targetDirectory,
        exitStatus: liteSvm.exitStatus,
        testResult: liteSvm.testResult,
        testExecutable: liteSvm.testExecutable,
        inputElfSha256: liteSvm.inputElfSha256,
        outputElfSha256: liteSvm.outputElfSha256,
        protectedSbfArtifactsBefore: liteSvm.protectedSbfArtifactsBefore,
        protectedSbfArtifactsAfter: liteSvm.protectedSbfArtifactsAfter,
        tests: liteSvm.tests,
        log: 'build/external-layout-cargo.log',
        logSha256: liteSvm.cargoLogSha256,
      } : {executed: false, deferred: true, reason: 'imported testExternalLayout defers runtime to the root cargo test --test sbf route through the registered external_layout_sbf module'},
    },
    toolchain: {bun, cc: c.compiler, sbfTarget: 'SBPFv0', rust: liteSvm ? {cargo: liteSvm.cargo, rustc: liteSvm.rustc} : {executed: false, deferred: true}},
    hostRegistration: 'The external_layout_sbf module is registered in tests/sbf.rs; the root `cargo test --test sbf` command runs it after this imported compile-only gate.',
  };
  publishReport(reportPath, report);
  console.log(`External layout slice: ${typescript.length} TypeScript, ${c.cases.length} generated C, ${sbf.cases.length} SBF compile groups, ${liteSvm ? `${liteSvm.tests.length} LiteSVM cases` : 'LiteSVM runtime deferred'}`);
}

if (import.meta.main) testExternalLayout();
